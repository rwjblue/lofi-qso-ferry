import assert from "node:assert/strict";
import test from "node:test";
import { InventoryComparisonGenerations } from "../src/inventory-comparison-generations.ts";
import { InventoryComparisonLookup } from "../src/inventory-comparison-lookup.ts";
import { InventoryComparisonPages } from "../src/inventory-comparison-pages.ts";
import {
  InventoryIngestion,
  type InventoryObservation,
} from "../src/inventory-ingestion.ts";
import { applyMigration, database, seed } from "./helpers.ts";

const at = Date.parse("2026-11-08T12:30:00Z");
function record(call: string) {
  return { CALL: call, QSO_DATE: "20261108", TIME_ON: "123000" };
}
function qso(
  key: string,
  call: string,
  fields: Record<string, unknown> = {},
): InventoryObservation {
  return {
    family: "qso",
    key,
    subtype: "qso",
    parentKey: "op",
    status: "active",
    order: 1,
    revision: "1",
    body: { their: { call }, startAtMillis: at, ...fields },
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
    "0048_inventory_projection_publication.sql",
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
  const generations = new InventoryComparisonGenerations(f.store);
  const domain = await generations.begin("a");
  assert.ok(domain.pending_generation);
  const generation = domain.pending_generation;
  const lease = await f.store.claim(
    "a",
    "inventory:source",
    Date.now(),
    90_000,
  );
  assert.ok(lease);
  return {
    ...f,
    inventory,
    generations,
    generation,
    lookup: new InventoryComparisonLookup(f.store),
    async publish(observations: InventoryObservation[]) {
      const stream = await inventory.snapshot("a", "source", "sync");
      assert.ok(stream);
      return inventory.publish(
        await inventory.prepare({
          pageId: crypto.randomUUID(),
          stream,
          lease,
          observations,
          facet: "source",
          origin: "historical",
          requestStartedAt: Date.now(),
          nextResume: {},
        }),
      );
    },
  };
}

test("bulk equality probes preserve partial candidates and zero-hit dependencies without scanning unrelated contacts", async (t) => {
  const f = await fixture();
  try {
    await f.publish([
      ...Array.from({ length: 1000 }, (_, i) => qso(`q${i}`, `K${i}ABC`)),
      qso("call", "K1ABC", { startAtMillis: null }),
      qso("time", "?"),
      qso("unknown", "?", { startAtMillis: null }),
    ]);
    await assert.rejects(
      f.lookup.probe("a", [
        { id: "selected", scope: "source", record: record("K1ABC") },
      ]),
      /generation_unavailable/,
    );
    const requests = Array.from({ length: 20 }, (_, i) => ({
      id: `input-${i}`,
      scope: "source",
      record: record(`K${i}ABC`),
    }));
    const result = await f.lookup.probe("a", requests, {
      generation: f.generation,
    });
    t.diagnostic(
      `20 inputs against 1,003 retained rows: ${result.rowsRead} lookup rows read`,
    );
    assert.equal(result.observations.length, 20);
    assert.equal(result.active, false);
    assert.equal(result.observations[1].state, "indexing");
    assert.deepEqual(
      new Set(result.observations[1].candidates.map((r) => r.key)),
      new Set(["q1", "call", "time", "unknown"]),
    );
    assert.equal(result.observations[1].buckets.length, 8);
    assert.ok(
      result.observations[1].buckets.some((bucket) => bucket.version === 0),
    );
    assert.ok(result.rowsRead < 4000, `${result.rowsRead} rows read`);
    const missing = await f.lookup.probe(
      "a",
      [{ id: "missing-scope", scope: "absent", record: record("W1AW") }],
      { generation: f.generation },
    );
    assert.equal(missing.observations[0].indexReady, false);
    assert.equal(missing.observations[0].state, "indexing");
    assert.deepEqual(missing.observations[0].candidates, []);
    assert.equal(
      missing.observations[0].buckets.filter((bucket) => bucket.version === 0)
        .length,
      8,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("overflow is a bounded hold and never exposes a truncated candidate set", async (t) => {
  const f = await fixture();
  try {
    await f.publish(
      Array.from({ length: 1000 }, (_, i) => qso(`q${i}`, "W1AW")),
    );
    const result = await f.lookup.probe(
      "a",
      [{ id: "selected", scope: "source", record: record("W1AW") }],
      { generation: f.generation },
    );
    t.diagnostic(
      `1,000 same-bucket candidates: ${result.rowsRead} rows read before overflow`,
    );
    assert.equal(result.candidateLimit, 512);
    assert.equal(result.observations[0].state, "overflow");
    assert.deepEqual(result.observations[0].candidates, []);
    assert.equal(result.observations[0].buckets.length, 8);
    assert.ok(result.rowsRead < 8000, `${result.rowsRead} rows read`);
    const grouped = await f.lookup.probe(
      "a",
      Array.from({ length: 20 }, (_, i) => ({
        id: String(i),
        scope: "source",
        record: record("W1AW"),
      })),
      { generation: f.generation },
    );
    assert.equal(grouped.candidateLimit, 51);
    assert.ok(
      grouped.observations.every(
        (observation) =>
          observation.state === "overflow" &&
          observation.candidates.length === 0,
      ),
    );
  } finally {
    await f.mf.dispose();
  }
});

test("operation edits expose stale projection dependencies without hiding their candidate", async () => {
  const f = await fixture();
  try {
    await f.publish([qso("q", "W1AW")]);
    await f.db
      .prepare("UPDATE comparison_index SET state='ready',projection_version=1")
      .run();
    await f.publish([
      {
        family: "operation",
        key: "op",
        subtype: "operation",
        status: "active",
        order: 1,
        revision: "1",
        body: { uuid: "op", station: "N1RWJ" },
      },
    ]);
    const result = await f.lookup.probe(
      "a",
      [{ id: "selected", scope: "source", record: record("W1AW") }],
      { generation: f.generation },
    );
    const candidate = result.observations[0].candidates[0];
    assert.equal(candidate.key, "q");
    assert.equal(candidate.state, "pending");
    assert.equal(candidate.currentProjectionVersion, null);
    assert.equal(candidate.topologyVersion, 0);
    assert.equal(candidate.currentTopologyVersion, 1);
  } finally {
    await f.mf.dispose();
  }
});

test("a generation/source-roster change while signing probes rejects the read snapshot", async () => {
  const f = await fixture();
  try {
    const original = f.store.statement.bind(f.store);
    f.store.statement = (sql, ...params) => {
      const statement = original(sql, ...params);
      if (sql.startsWith("SELECT CAST(j.key")) {
        return new Proxy(statement, {
          get(target, property) {
            if (property === "all")
              return async <T>() => {
                await original(
                  "UPDATE comparison_domains SET version=version+1,source_set_version=source_set_version+1 WHERE tenant='a'",
                ).run();
                return target.all<T>();
              };
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }
      return statement;
    };
    await assert.rejects(
      f.lookup.probe(
        "a",
        [{ id: "selected", scope: "source", record: record("W1AW") }],
        { generation: f.generation },
      ),
      /generation_changed/,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("probe input bounds and tenant/generation isolation fail closed", async () => {
  const f = await fixture();
  try {
    const request = { id: "selected", scope: "source", record: record("W1AW") };
    await assert.rejects(f.lookup.probe("a", []), /invalid/);
    await assert.rejects(f.lookup.probe("a", [request, request]), /invalid/);
    await assert.rejects(
      f.lookup.probe(
        "a",
        Array.from({ length: 21 }, (_, i) => ({ ...request, id: String(i) })),
      ),
      /invalid/,
    );
    await assert.rejects(
      f.lookup.probe("a", [{ ...request, record: { CALL: "W1AW" } }], {
        generation: f.generation,
      }),
      /input_incomplete/,
    );
    await assert.rejects(
      f.lookup.probe("b", [request], { generation: f.generation }),
      /generation_unavailable/,
    );
    await assert.rejects(
      f.lookup.probe("a", [request], { generation: "unknown" }),
      /generation_unavailable/,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("a request-local lookup session reuses its key and rejects later domain changes", async () => {
  const f = await fixture();
  try {
    let keyReads = 0;
    const original = f.store.statement.bind(f.store);
    f.store.statement = (sql, ...params) => {
      if (/\b(?:FROM|JOIN) inventory_comparison_keys\b/.test(sql)) keyReads++;
      return original(sql, ...params);
    };
    const session = await f.lookup.open("a", { generation: f.generation });
    for (let pass = 0; pass < 2; pass++) {
      const result = await session.probe([
        { id: "selected", scope: "source", record: record("W1AW") },
      ]);
      assert.equal(result.domainVersion, session.domainVersion);
      assert.equal(result.sourceSetVersion, session.sourceSetVersion);
    }
    assert.equal(keyReads, 1);
    await original(
      "UPDATE comparison_domains SET version=version+1,source_set_version=source_set_version+1 WHERE tenant='a'",
    ).run();
    await assert.rejects(
      session.probe([
        { id: "selected", scope: "source", record: record("W1AW") },
      ]),
      /generation_changed/,
    );
  } finally {
    await f.mf.dispose();
  }
});
