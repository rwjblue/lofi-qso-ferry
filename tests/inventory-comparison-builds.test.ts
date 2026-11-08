import assert from "node:assert/strict";
import test from "node:test";
import { InventoryComparisonBuilds } from "../src/inventory-comparison-builds.ts";
import { InventoryComparisonGenerations } from "../src/inventory-comparison-generations.ts";
import { InventoryComparisonLookup } from "../src/inventory-comparison-lookup.ts";
import { InventoryComparisonPages } from "../src/inventory-comparison-pages.ts";
import {
  InventoryIngestion,
  type InventoryObservation,
} from "../src/inventory-ingestion.ts";
import { Store } from "../src/store.ts";
import { canonical, sha256 } from "../src/security.ts";
import { applyMigration, database, seed } from "./helpers.ts";

const at = Date.parse("2026-11-08T12:30:00Z");
function qso(key: string, order = 1): InventoryObservation {
  return {
    family: "qso",
    key,
    subtype: "qso",
    status: "active",
    revision: String(order),
    order,
    body: {
      uuid: key,
      their: { call: "W1AW" },
      startAtMillis: at,
      note: String(order),
    },
  };
}
async function fixture(count = 0) {
  const f = await database();
  await seed(f.store);
  for (const name of [
    "0039_inventory_ingestion.sql",
    "0044_inventory_comparison_generations.sql",
    "0045_inventory_comparison_ingestion.sql",
    "0046_inventory_comparison_builds.sql",
  ])
    await applyMigration(f.db, name);
  const inventory = new InventoryIngestion(
    f.store,
    new InventoryComparisonPages(f.store),
  );
  await inventory.initialize(
    {
      tenant: "a",
      scope: "source",
      connection: "source",
      provider: "lofi",
      logicalIdentity: "source",
      adapterBinding: "test-v1",
      ordering: "numeric",
    },
    "sync",
    "all-v1",
  );
  const claimed = await f.store.claim(
    "a",
    "inventory:source",
    Date.now(),
    90_000,
  );
  assert.ok(claimed);
  const lease = claimed;
  async function publish(observations: InventoryObservation[]) {
    const stream = await inventory.snapshot("a", "source", "sync");
    assert.ok(stream);
    return inventory.publish(
      await inventory.prepare({
        stream,
        lease,
        pageId: crypto.randomUUID(),
        observations,
        facet: "source",
        origin: "historical",
        requestStartedAt: Date.now(),
        nextResume: {},
      }),
    );
  }
  if (count)
    await publish(
      Array.from({ length: count }, (_, i) =>
        qso(`q${String(i).padStart(4, "0")}`),
      ),
    );
  const generations = new InventoryComparisonGenerations(f.store);
  const domain = await generations.begin("a");
  assert.ok(domain.pending_generation);
  return {
    ...f,
    inventory,
    publish,
    generations,
    generation: domain.pending_generation,
    builds: new InventoryComparisonBuilds(f.store),
  };
}
async function scratchEmpty(f: Awaited<ReturnType<typeof fixture>>) {
  for (const table of [
    "comparison_build_rows",
    "comparison_build_buckets",
    "comparison_build_guards",
  ])
    assert.equal(
      (
        await f.db
          .prepare(`SELECT count(*) AS n FROM ${table}`)
          .first<{ n: number }>()
      )?.n,
      0,
      table,
    );
}

test("bounded backfill resumes across instances and publishes a generation without changing observation freshness", async (t) => {
  const f = await fixture(450);
  try {
    const before = await f.inventory.snapshot("a", "source", "sync");
    const witness = await f.db
      .prepare(
        "SELECT first_observed_at,last_observed_at FROM inventory_record_facets WHERE record_key='q0000'",
      )
      .first();
    await assert.rejects(f.builds.activate("a", f.generation), /incomplete/);
    const first = await f.builds.step("a", f.generation, "source");
    assert.ok("records" in first);
    assert.equal(first.records, 200);
    assert.equal(first.complete, false);
    t.diagnostic(
      `200 backfill records: ${first.statements} statements, ${first.rowsRead} rows read, ${first.rowsWritten} rows written`,
    );
    const resumed = new InventoryComparisonBuilds(f.store);
    const second = await resumed.step("a", f.generation, "source");
    assert.ok("records" in second);
    assert.equal(second.records, 200);
    const third = await resumed.step("a", f.generation, "source");
    assert.ok("records" in third);
    assert.equal(third.records, 50);
    assert.equal(third.complete, true);
    await resumed.activate("a", f.generation);
    assert.equal(
      (await f.generations.domain("a"))?.active_generation,
      f.generation,
    );
    assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), before);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT first_observed_at,last_observed_at FROM inventory_record_facets WHERE record_key='q0000'",
        )
        .first(),
      witness,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM comparison_index WHERE state='pending'",
          )
          .first<{ n: number }>()
      )?.n,
      450,
    );
    await scratchEmpty(f);
  } finally {
    await f.mf.dispose();
  }
});

test("ingestion behind the build frontier is indexed immediately and a new generation replaces the active pointer atomically", async () => {
  const f = await fixture(3);
  try {
    await f.builds.step("a", f.generation, "source", 1);
    await f.publish([qso("a-new")]);
    await f.builds.step("a", f.generation, "source");
    const firstDomain = await f.builds.activate("a", f.generation);
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM comparison_index WHERE generation_id=?",
          )
          .bind(f.generation)
          .first<{ n: number }>()
      )?.n,
      4,
    );
    const secondDomain = await f.generations.begin("a");
    assert.ok(secondDomain.pending_generation);
    const secondGeneration = secondDomain.pending_generation;
    await f.publish([qso("new-both")]);
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM comparison_index WHERE record_key='new-both'",
          )
          .first<{ n: number }>()
      )?.n,
      2,
    );
    await f.builds.step("a", secondGeneration, "source");
    const activated = await f.builds.activate("a", secondGeneration);
    assert.equal(activated.active_generation, secondGeneration);
    assert.equal(activated.pending_generation, null);
    assert.ok(activated.version > firstDomain.version);
    const states = (
      await f.db
        .prepare("SELECT state FROM index_generations ORDER BY state")
        .all()
    ).results;
    assert.deepEqual(states, [{ state: "active" }, { state: "retired" }]);
    await f.publish([qso("new-active-only")]);
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM comparison_index WHERE record_key='new-active-only'",
          )
          .first<{ n: number }>()
      )?.n,
      1,
    );
    const hashes = (
      await f.db
        .prepare(
          "SELECT bucket_hash FROM comparison_index WHERE record_key='new-both'",
        )
        .all<{ bucket_hash: string }>()
    ).results;
    assert.notEqual(hashes[0].bucket_hash, hashes[1].bucket_hash);
  } finally {
    await f.mf.dispose();
  }
});

test("native backfill rejects a raced inventory page and direct completion or skipped ranges", async () => {
  const f = await fixture(3);
  try {
    await assert.rejects(
      f.db
        .prepare(
          "UPDATE comparison_builds SET version=version+1,complete=1 WHERE tenant='a'",
        )
        .run(),
      /publication required/,
    );
    const lease = await f.store.claim(
      "a",
      `comparison:${f.generation}:source`,
      Date.now(),
      60_000,
    );
    assert.ok(lease);
    const page = await f.builds.prepare("a", f.generation, "source", lease, 1);
    assert.ok(page);
    await f.publish([qso("q0000", 2)]);
    await assert.rejects(f.builds.publish(page), /authority changed/);
    assert.equal(
      (
        await f.db
          .prepare("SELECT version FROM comparison_builds")
          .first<{ version: number }>()
      )?.version,
      1,
    );
    await scratchEmpty(f);
    const fresh = await f.builds.prepare("a", f.generation, "source", lease, 1);
    assert.ok(fresh);
    fresh.nextCursor = "q0002";
    await assert.rejects(f.builds.publish(fresh), /build_changed/);
    const { digest: _digest, ...invalidRange } = fresh;
    fresh.digest = await sha256(
      canonical(["comparison-build-v1", invalidRange]),
    );
    await assert.rejects(f.builds.publish(fresh), /range incomplete/);
    await f.store.release(lease);
    await f.builds.step("a", f.generation, "source");
    await f.builds.activate("a", f.generation);
  } finally {
    await f.mf.dispose();
  }
});

test("current hints retain ready projections and work versions during a generation's initial census", async () => {
  const f = await fixture();
  try {
    await f.publish([qso("q")]);
    await f.db
      .prepare("UPDATE comparison_index SET state='ready',projection_version=1")
      .run();
    const index = await f.db.prepare("SELECT * FROM comparison_index").first();
    const work = await f.db.prepare("SELECT * FROM comparison_work").first();
    const result = await f.builds.step("a", f.generation, "source");
    assert.ok("changed" in result);
    assert.equal(result.changed, 0);
    assert.deepEqual(
      await f.db.prepare("SELECT * FROM comparison_index").first(),
      index,
    );
    assert.deepEqual(
      await f.db.prepare("SELECT * FROM comparison_work").first(),
      work,
    );
    await f.builds.activate("a", f.generation);
    const probe = await new InventoryComparisonLookup(f.store).probe("a", [
      {
        id: "selected",
        scope: "source",
        record: { CALL: "W1AW", QSO_DATE: "20261108", TIME_ON: "123000" },
      },
    ]);
    assert.equal(probe.observations[0].indexReady, true);
    assert.equal(probe.observations[0].state, "observed");
  } finally {
    await f.mf.dispose();
  }
});

test("empty scopes finish natively, receipt replay is idempotent, and an expired lease cannot advance the build", async () => {
  const f = await fixture();
  try {
    const lease = await f.store.claim(
      "a",
      `comparison:${f.generation}:source`,
      Date.now(),
      60_000,
    );
    assert.ok(lease);
    const page = await f.builds.prepare("a", f.generation, "source", lease);
    assert.ok(page);
    assert.equal(page.complete, true);
    await f.db
      .prepare("UPDATE leases SET expires_at=0 WHERE scope=?")
      .bind(lease.scope)
      .run();
    await assert.rejects(f.builds.publish(page), /authority changed/);
    const replacement = await f.store.claim(
      "a",
      lease.scope,
      Date.now(),
      60_000,
    );
    assert.ok(replacement);
    const fresh = await f.builds.prepare(
      "a",
      f.generation,
      "source",
      replacement,
    );
    assert.ok(fresh);
    await f.builds.publish(fresh);
    assert.equal((await f.builds.publish(fresh)).recovered, true);
    await f.builds.activate("a", f.generation);
    await scratchEmpty(f);
  } finally {
    await f.mf.dispose();
  }
});

test("a held scope can rebuild retained hints while its matching readiness stays blocked", async () => {
  const f = await fixture(1);
  try {
    await f.db
      .prepare("UPDATE inventory_scopes SET state='held' WHERE tenant='a'")
      .run();
    await f.db
      .prepare(
        "UPDATE connections SET status='disabled' WHERE tenant='a' AND id='source'",
      )
      .run();
    const result = await f.builds.step("a", f.generation, "source");
    assert.ok("complete" in result);
    assert.equal(result.complete, true);
    await f.builds.activate("a", f.generation);
    const probe = await new InventoryComparisonLookup(f.store).probe("a", [
      {
        id: "selected",
        scope: "source",
        record: { CALL: "W1AW", QSO_DATE: "20261108", TIME_ON: "123000" },
      },
    ]);
    assert.equal(probe.observations[0].indexReady, false);
    assert.equal(probe.observations[0].state, "indexing");
    assert.equal(probe.observations[0].candidates.length, 1);
  } finally {
    await f.mf.dispose();
  }
});

test("lost acknowledgements recover the exact build receipt, and late failure leaves no partial index", async () => {
  const f = await fixture(3);
  try {
    const lease = await f.store.claim(
      "a",
      `comparison:${f.generation}:source`,
      Date.now(),
      60_000,
    );
    assert.ok(lease);
    const page = await f.builds.prepare("a", f.generation, "source", lease);
    assert.ok(page);
    await f.db
      .prepare(
        "CREATE TRIGGER fail_build BEFORE UPDATE ON comparison_build_pages WHEN NEW.state='committed' BEGIN SELECT RAISE(ABORT,'injected build failure'); END;",
      )
      .run();
    await assert.rejects(f.builds.publish(page), /injected build failure/);
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM comparison_index")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT version FROM comparison_builds")
          .first<{ version: number }>()
      )?.version,
      1,
    );
    await scratchEmpty(f);
    await f.db.prepare("DROP TRIGGER fail_build").run();
    const uncertain = new InventoryComparisonBuilds(
      new Store(
        new Proxy(f.db, {
          get(target, property) {
            if (property === "batch")
              return async (statements: D1PreparedStatement[]) => {
                await target.batch(statements);
                throw new Error("lost acknowledgement");
              };
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
        f.store.keys,
      ),
    );
    const result = await uncertain.publish(page);
    assert.equal(result.recovered, true);
    assert.equal(result.changed, 3);
    assert.equal((await f.builds.publish(page)).recovered, true);
    assert.equal(
      (
        await f.db
          .prepare("SELECT version FROM bucket_versions")
          .first<{ version: number }>()
      )?.version,
      1,
    );
    await scratchEmpty(f);
  } finally {
    await f.mf.dispose();
  }
});
