import assert from "node:assert/strict";
import test from "node:test";
import { InventoryComparisonGenerations } from "../src/inventory-comparison-generations.ts";
import { InventoryComparisonLookup } from "../src/inventory-comparison-lookup.ts";
import { InventoryComparisonPages } from "../src/inventory-comparison-pages.ts";
import {
  InventoryIngestion,
  type InventoryObservation,
} from "../src/inventory-ingestion.ts";
import { InventoryRuns } from "../src/inventory-runs.ts";
import { applyMigration, database, seed } from "./helpers.ts";

function observation(
  key: string,
  subtype: "operation" | "event" | "qso" = "qso",
  order = 1,
): InventoryObservation {
  return {
    family: subtype === "operation" ? "operation" : "qso",
    key,
    subtype,
    ...(subtype === "operation" ? {} : { parentKey: "op" }),
    status: "active",
    order,
    revision: String(order),
    body: {
      uuid: key,
      ...(subtype === "operation"
        ? { stationCall: "N1RWJ" }
        : {
            operation: "op",
            their: { call: "W1AW" },
            startAtMillis: Date.parse("2026-11-08T12:30:00Z"),
            band: subtype === "event" ? "event" : "20m",
            mode: "CW",
            ...(subtype === "event"
              ? {
                  event: {
                    event: "start",
                    operation: { stationCall: "K1ABC" },
                  },
                }
              : {}),
          }),
    },
  };
}
async function fixture() {
  const f = await database();
  await seed(f.store);
  for (const name of [
    "0039_inventory_ingestion.sql",
    "0040_inventory_runs.sql",
    "0044_inventory_comparison_generations.sql",
    "0045_inventory_comparison_ingestion.sql",
    "0047_inventory_context_membership.sql",
  ])
    await applyMigration(f.db, name);
  const hook = new InventoryComparisonPages(f.store);
  const inventory = new InventoryIngestion(f.store, hook);
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
    "all-clients-v1",
  );
  const domain = await new InventoryComparisonGenerations(f.store).begin("a");
  assert.ok(domain.pending_generation);
  const generation = domain.pending_generation;
  const claimed = await f.store.claim(
    "a",
    "inventory:source",
    Date.now(),
    90_000,
  );
  assert.ok(claimed);
  const lease = claimed;
  const runs = new InventoryRuns(inventory);
  async function begin() {
    const stream = await inventory.snapshot("a", "source", "sync");
    assert.ok(stream);
    return runs.begin({
      stream,
      lease,
      definition: {
        id: crypto.randomUUID(),
        mode: "full",
        facet: "source",
        partition: "all",
        partitionBinding: "all-v1",
        collectionBinding: "collect-v1",
        catchupBinding: "catchup-v1",
        requiredStreams: ["operations", "qsos"],
        fixedQuery: { upper: Date.now() },
        initialResume: {},
      },
    });
  }
  async function observed(id: string, observations: InventoryObservation[]) {
    const context = await runs.context("a", id);
    return inventory.publish(
      await runs.preparePage(context, lease, {
        observations,
        requestStartedAt: Date.now(),
        requestBinding:
          context.run.phase === "catchup" ? "catchup-v1" : "collect-v1",
        nextResume: {},
        observedComplete: true,
        completedStreams: ["operations", "qsos"],
        proposedCheckpoint: { watermark: 1 },
        nextDueAt: Date.now(),
      }),
    );
  }
  async function finish(id: string) {
    const receipts = [];
    for (let pass = 0; pass < 10; pass++) {
      const context = await runs.context("a", id);
      if (context.run.phase === "quarantining")
        receipts.push(
          await inventory.publish(
            await runs.prepareQuarantine(context, lease, { limit: 200 }),
          ),
        );
      else if (context.run.phase === "publishing") {
        await inventory.publish(await runs.prepareComplete(context, lease));
        return receipts;
      } else
        throw new Error(
          `unexpected context fixture phase ${context.run.phase}`,
        );
    }
    throw new Error("fixture did not finish");
  }
  async function full(rows: InventoryObservation[]) {
    const run = await begin();
    await observed(run.id, rows);
    await observed(run.id, []);
    return finish(run.id);
  }
  return {
    ...f,
    hook,
    inventory,
    runs,
    lease,
    begin,
    observed,
    finish,
    full,
    generation,
  };
}
async function topology(f: Awaited<ReturnType<typeof fixture>>) {
  return (
    await f.db
      .prepare(
        "SELECT topology_version FROM projection_domains WHERE operation_key='op'",
      )
      .first<{ topology_version: number }>()
  )?.topology_version;
}
async function membership(f: Awaited<ReturnType<typeof fixture>>, key: string) {
  return f.db
    .prepare(
      "SELECT m.state,v.version FROM inventory_partition_membership m JOIN inventory_membership_versions v ON v.tenant=m.tenant AND v.scope_id=m.scope_id AND v.entity_family=m.entity_family AND v.record_key=m.record_key AND v.facet=m.facet WHERE m.tenant='a' AND m.record_key=?",
    )
    .bind(key)
    .first();
}
async function scratchEmpty(f: Awaited<ReturnType<typeof fixture>>) {
  for (const table of [
    "ingestion_context_pages",
    "ingestion_page_domains",
    "ingestion_membership_effects",
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

test("semantic and membership edits coalesce once per operation; unchanged full scans retain work and versions", async () => {
  const f = await fixture();
  try {
    const rows = [
      observation("op", "operation"),
      observation("event1", "event"),
      observation("event2", "event"),
      observation("q"),
    ];
    await f.full(rows);
    assert.equal(await topology(f), 1);
    assert.deepEqual(await membership(f, "event1"), {
      state: "present",
      version: 1,
    });
    const work = await f.db
      .prepare(
        "SELECT work_version,completed_version FROM comparison_work WHERE record_key='q'",
      )
      .first();
    assert.deepEqual(work, { work_version: 1, completed_version: 0 });
    await f.full(rows);
    assert.equal(await topology(f), 1);
    assert.deepEqual(await membership(f, "event1"), {
      state: "present",
      version: 1,
    });
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT work_version,completed_version FROM comparison_work WHERE record_key='q'",
        )
        .first(),
      work,
    );
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

test("unseen events dirty only their operation without child fanout; unchanged reappearance restores a new version", async (t) => {
  const f = await fixture();
  try {
    const rows = [
      observation("op", "operation"),
      observation("event1", "event"),
      observation("event2", "event"),
      observation("q"),
    ];
    await f.full(rows);
    const work = await f.db
      .prepare("SELECT * FROM comparison_work WHERE record_key='q'")
      .first();
    const receipts = await f.full([rows[0], rows[3]]);
    assert.equal(await topology(f), 2);
    assert.deepEqual(await membership(f, "event1"), {
      state: "unresolved",
      version: 2,
    });
    assert.deepEqual(await membership(f, "event2"), {
      state: "unresolved",
      version: 2,
    });
    assert.deepEqual(
      await f.db
        .prepare("SELECT * FROM comparison_work WHERE record_key='q'")
        .first(),
      work,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT semantic_version FROM inventory_record_facets WHERE record_key='event1'",
          )
          .first<{ semantic_version: number }>()
      )?.semantic_version,
      1,
    );
    t.diagnostic(
      `quarantine: ${receipts.reduce((sum, r) => sum + r.statements, 0)} statements, ${receipts.reduce((sum, r) => sum + r.rowsRead, 0)} rows read`,
    );
    await f.full(rows);
    assert.equal(await topology(f), 3);
    assert.deepEqual(await membership(f, "event1"), {
      state: "present",
      version: 3,
    });
    await scratchEmpty(f);
  } finally {
    await f.mf.dispose();
  }
});

test("unseen ordinary contacts invalidate their own work and membership without dirtying every sibling", async () => {
  const f = await fixture();
  try {
    const rows = [
      observation("op", "operation"),
      observation("event", "event"),
      observation("q0"),
      observation("q1"),
    ];
    await f.full(rows);
    await f.db
      .prepare(
        "UPDATE comparison_index SET state='ready' WHERE record_key IN ('q0','q1')",
      )
      .run();
    await f.db
      .prepare(
        "UPDATE comparison_work SET completed_version=work_version WHERE record_key IN ('q0','q1')",
      )
      .run();
    await f.full(rows.filter((row) => row.key !== "q0"));
    assert.equal(await topology(f), 1);
    assert.deepEqual(await membership(f, "q0"), {
      state: "unresolved",
      version: 2,
    });
    assert.deepEqual(
      (
        await f.db
          .prepare(
            "SELECT record_key,state FROM comparison_index WHERE record_key IN ('q0','q1') ORDER BY record_key",
          )
          .all()
      ).results,
      [
        { record_key: "q0", state: "pending" },
        { record_key: "q1", state: "ready" },
      ],
    );
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT work_version,completed_version FROM comparison_work WHERE record_key='q0'",
        )
        .first(),
      { work_version: 2, completed_version: 1 },
    );
    const probes = await new InventoryComparisonLookup(f.store).probe(
      "a",
      [
        {
          id: "selected",
          scope: "source",
          record: { CALL: "W1AW", QSO_DATE: "20261108", TIME_ON: "123000" },
        },
      ],
      { generation: f.generation },
    );
    assert.equal(
      probes.observations[0].candidates.find((row) => row.key === "q0")
        ?.membershipVersion,
      2,
    );
    assert.equal(
      probes.observations[0].candidates.find((row) => row.key === "q1")
        ?.membershipVersion,
      1,
    );
    await f.full(rows);
    assert.deepEqual(await membership(f, "q0"), {
      state: "present",
      version: 3,
    });
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT work_version,completed_version FROM comparison_work WHERE record_key='q0'",
        )
        .first(),
      { work_version: 3, completed_version: 1 },
    );
    assert.equal(await topology(f), 1);
    assert.equal(
      (
        await f.db
          .prepare("SELECT version FROM bucket_versions")
          .first<{ version: number }>()
      )?.version,
      1,
      "candidate keys did not change",
    );
    await scratchEmpty(f);
  } finally {
    await f.mf.dispose();
  }
});

test("native guards reject missing context publication and roll back quarantine; receipt replay never increments twice", async () => {
  const f = await fixture();
  try {
    await f.full([
      observation("op", "operation"),
      observation("event", "event"),
      observation("q"),
    ]);
    const run = await f.begin();
    await f.observed(run.id, [
      observation("op", "operation"),
      observation("q"),
    ]);
    await f.observed(run.id, []);
    const page = await f.runs.prepareQuarantine(
      await f.runs.context("a", run.id),
      f.lease,
      { limit: 200 },
    );
    await assert.rejects(
      new InventoryIngestion(f.store).publish(page),
      /context membership changed/,
    );
    const incomplete = new InventoryComparisonPages(f.store);
    const context = incomplete.context.bind(incomplete);
    incomplete.context = (...args) => {
      const effects = context(...args);
      if (effects) effects.domainEffects = () => [];
      return effects;
    };
    await assert.rejects(
      new InventoryIngestion(f.store, incomplete).publish(page),
      /context publication incomplete/,
    );
    assert.equal(await topology(f), 1);
    assert.deepEqual(await membership(f, "event"), {
      state: "present",
      version: 1,
    });
    await scratchEmpty(f);
    await f.inventory.publish(page);
    assert.equal(await topology(f), 2);
    assert.equal((await f.inventory.publish(page)).recovered, true);
    assert.equal(await topology(f), 2);
    await f.finish(run.id);
    await scratchEmpty(f);
    await assert.rejects(
      f.db.prepare("DELETE FROM inventory_membership_versions").run(),
      /retained/,
    );
  } finally {
    await f.mf.dispose();
  }
});
