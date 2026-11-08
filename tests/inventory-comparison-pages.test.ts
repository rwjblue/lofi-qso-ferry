import assert from "node:assert/strict";
import test from "node:test";
import { InventoryComparisonGenerations } from "../src/inventory-comparison-generations.ts";
import { inventoryComparisonLookup } from "../src/inventory-comparison-keys.ts";
import {
  inventoryComparisonHint,
  InventoryComparisonPages,
} from "../src/inventory-comparison-pages.ts";
import {
  InventoryIngestion,
  type InventoryObservation,
  type InventoryPageInput,
} from "../src/inventory-ingestion.ts";
import { applyMigration, database, seed } from "./helpers.ts";

const at = Date.parse("2026-11-08T12:30:00Z");
function qso(
  key: string,
  order = 1,
  fields: Record<string, unknown> = {},
): InventoryObservation {
  return {
    family: "qso",
    key,
    subtype: "qso",
    parentKey: "op",
    status: "active",
    revision: String(order),
    order,
    body: { uuid: key, their: { call: "W1AW" }, startAtMillis: at, ...fields },
  };
}
async function fixture(begin = true) {
  const f = await database();
  await seed(f.store);
  for (const name of [
    "0039_inventory_ingestion.sql",
    "0044_inventory_comparison_generations.sql",
    "0045_inventory_comparison_ingestion.sql",
  ])
    await applyMigration(f.db, name);
  const generations = new InventoryComparisonGenerations(f.store);
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
  if (begin) await generations.begin("a");
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
    async page(
      observations: InventoryObservation[],
      options: Partial<InventoryPageInput> = {},
      ingestor = inventory,
    ) {
      const stream = await inventory.snapshot("a", "source", "sync");
      assert.ok(stream);
      return ingestor.prepare({
        pageId: crypto.randomUUID(),
        stream,
        lease,
        requestStartedAt: Date.now(),
        facet: "source",
        origin: "historical",
        nextResume: { after: stream.version + 1 },
        observations,
        ...options,
      });
    },
  };
}
async function scratchEmpty(f: Awaited<ReturnType<typeof fixture>>) {
  for (const table of [
    "comparison_page_state",
    "comparison_page_rows",
    "comparison_page_buckets",
    "ingestion_page_rows",
    "ingestion_page_guards",
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

test("a thousand source hints publish atomically with one invalidation per distinct bucket", async (t) => {
  const f = await fixture();
  try {
    const page = await f.page(
      Array.from({ length: 1000 }, (_, i) => qso(`q${i}`)),
    );
    const receipt = await f.inventory.publish(page);
    t.diagnostic(
      `${receipt.statements} statements, ${receipt.rowsRead} rows read, ${receipt.rowsWritten} rows written for 1,000 same-bucket source records`,
    );
    assert.ok(receipt.statements < 40, `${receipt.statements} statements`);
    const counts = await f.db
      .prepare(
        "SELECT (SELECT count(*) FROM comparison_index WHERE state='pending') AS hints,(SELECT count(*) FROM comparison_work WHERE work_version=1 AND completed_version=0) AS work,(SELECT count(*) FROM bucket_versions WHERE version=1) AS buckets",
      )
      .first();
    assert.deepEqual(counts, { hints: 1000, work: 1000, buckets: 1 });
    assert.equal(
      (await f.inventory.snapshot("a", "source", "sync"))?.version,
      1,
    );
    assert.deepEqual((await f.inventory.recover(page))?.recovered, true);
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

test("native guards reject omitted bucket staging or omitted invalidation despite valid hints", async () => {
  const f = await fixture();
  try {
    class MissingBucketManifest extends InventoryComparisonPages {
      override prelude(
        ...args: Parameters<InventoryComparisonPages["prelude"]>
      ) {
        return super.prelude(...args).slice(0, -1);
      }
    }
    class MissingInvalidation extends InventoryComparisonPages {
      override effects(
        ...args: Parameters<InventoryComparisonPages["effects"]>
      ) {
        return super.effects(...args).slice(1);
      }
    }
    for (const [hook, error] of [
      [new MissingBucketManifest(f.store), /bucket manifest incomplete/],
      [new MissingInvalidation(f.store), /bucket publication incomplete/],
    ] as const) {
      const ingestor = new InventoryIngestion(f.store, hook);
      await assert.rejects(
        ingestor.publish(await f.page([qso("q")], {}, ingestor)),
        error,
      );
      assert.equal(
        (
          await f.db
            .prepare("SELECT count(*) AS n FROM comparison_index")
            .first<{ n: number }>()
        )?.n,
        0,
      );
      await scratchEmpty(f);
    }
  } finally {
    await f.mf.dispose();
  }
});

test("distinct old/new buckets use indexed page checks as the inventory grows", async (t) => {
  const f = await fixture();
  try {
    const rows = Array.from({ length: 1000 }, (_, i) =>
      qso(`q${i}`, 1, { their: { call: `K${i}ABC` } }),
    );
    const first = await f.inventory.publish(await f.page(rows));
    const second = await f.inventory.publish(
      await f.page(
        rows.map((row, i) => ({
          ...qso(row.key, 2, { their: { call: `W${i}ABC` } }),
        })),
      ),
    );
    t.diagnostic(
      `distinct buckets: ${first.rowsRead} initial / ${second.rowsRead} update rows read; ${second.statements} update statements`,
    );
    assert.ok(first.rowsRead < 120_000, `${first.rowsRead} initial rows read`);
    assert.ok(second.rowsRead < 160_000, `${second.rowsRead} update rows read`);
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM bucket_versions")
          .first<{ n: number }>()
      )?.n,
      2000,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("receipt facets use the same index generation without acquiring source or delivery authority", async () => {
  const f = await fixture();
  try {
    const stream = await f.inventory.initialize(
      {
        tenant: "a",
        scope: "destination",
        connection: "destination",
        provider: "qrz",
        logicalIdentity: "destination",
        adapterBinding: "test-v1",
        ordering: "serialized",
      },
      "receipt",
      "book-v1",
    );
    const lease = await f.store.claim(
      "a",
      "inventory:destination",
      Date.now(),
      60_000,
    );
    assert.ok(lease);
    await f.inventory.publish(
      await f.inventory.prepare({
        pageId: crypto.randomUUID(),
        stream,
        lease,
        requestStartedAt: Date.now(),
        facet: "receipt",
        origin: "historical",
        nextResume: {},
        observations: [
          {
            family: "qso",
            key: "1",
            subtype: "qso",
            status: "active",
            order: null,
            revision: "receipt-v1",
            body: { CALL: "W1AW", QSO_DATE: "20261108", TIME_ON: "1230" },
          },
        ],
      }),
    );
    const row = await f.db
      .prepare("SELECT facet,state,key_class FROM comparison_index")
      .first();
    assert.deepEqual(row, {
      facet: "receipt",
      state: "pending",
      key_class: "call_and_time",
    });
    for (const table of ["ledger", "attempts"])
      assert.equal(
        (
          await f.db
            .prepare(`SELECT count(*) AS n FROM ${table}`)
            .first<{ n: number }>()
        )?.n,
        0,
      );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM inventory_record_facets WHERE facet='source'",
          )
          .first<{ n: number }>()
      )?.n,
      0,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("stable observations and metadata-only changes do not invalidate matching buckets", async () => {
  const f = await fixture();
  try {
    const row = qso("q");
    row.semantic = { their: { call: "W1AW" }, startAtMillis: at };
    await f.inventory.publish(await f.page([row]));
    const before = await f.db.prepare("SELECT * FROM comparison_index").first();
    await f.inventory.publish(await f.page([row]));
    await f.inventory.publish(
      await f.page([
        {
          ...row,
          order: 2,
          revision: "2",
          body: { ...(row.body as object), updatedAtMillis: at + 10 },
        },
      ]),
    );
    await f.inventory.publish(await f.page([row])); // stale after order 2
    assert.deepEqual(
      await f.db.prepare("SELECT * FROM comparison_index").first(),
      before,
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT version FROM bucket_versions")
          .first<{ version: number }>()
      )?.version,
      1,
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT work_version FROM comparison_work")
          .first<{ work_version: number }>()
      )?.work_version,
      1,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("semantic edits invalidate both buckets, while event/deleted transitions retain versions and retire the old hint", async () => {
  const f = await fixture();
  try {
    await f.inventory.publish(await f.page([qso("q")]));
    await f.inventory.publish(
      await f.page([qso("q", 2, { their: { call: "K1ABC" } })]),
    );
    assert.deepEqual(
      (
        await f.db
          .prepare("SELECT version FROM bucket_versions ORDER BY version")
          .all()
      ).results,
      [{ version: 1 }, { version: 2 }],
    );
    await f.inventory.publish(
      await f.page([
        { ...qso("q", 3), subtype: "event", body: { event: "start" } },
      ]),
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT state FROM comparison_index")
          .first<{ state: string }>()
      )?.state,
      "retired",
    );
    assert.deepEqual(
      await f.db
        .prepare("SELECT work_version,completed_version FROM comparison_work")
        .first(),
      { work_version: 3, completed_version: 3 },
    );
    assert.deepEqual(
      (
        await f.db
          .prepare("SELECT version FROM bucket_versions ORDER BY version")
          .all()
      ).results,
      [{ version: 2 }, { version: 2 }],
    );
    await f.inventory.publish(await f.page([qso("q", 4)]));
    assert.deepEqual(
      await f.db
        .prepare("SELECT work_version,completed_version FROM comparison_work")
        .first(),
      { work_version: 4, completed_version: 3 },
    );
    await f.inventory.publish(
      await f.page([{ ...qso("q", 5), status: "deleted" }]),
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT state FROM comparison_index")
          .first<{ state: string }>()
      )?.state,
      "retired",
    );
    await assert.rejects(
      f.db.prepare("DELETE FROM bucket_versions").run(),
      /retained/,
    );
    await scratchEmpty(f);
  } finally {
    await f.mf.dispose();
  }
});

test("all partial candidates remain discoverable while operation context is unavailable", async () => {
  const f = await fixture();
  try {
    await f.inventory.publish(
      await f.page([
        qso("complete"),
        qso("call", 1, { startAtMillis: "bad" }),
        qso("time", 1, { their: { call: "?" } }),
        qso("unknown", 1, { their: {}, startAtMillis: null }),
      ]),
    );
    const writers = await f.generations.writers("a");
    assert.ok(writers);
    const lookup = await inventoryComparisonLookup(
      writers.contexts[0],
      inventoryComparisonHint("lofi", qso("selected").body),
    );
    const hashes = new Set(lookup.map((value) => value.hash));
    const rows = await f.db
      .prepare(
        "SELECT record_key,key_class,bucket_hash,state FROM comparison_index",
      )
      .all<{
        record_key: string;
        key_class: string;
        bucket_hash: string;
        state: string;
      }>();
    assert.equal(rows.results.length, 4);
    assert.equal(new Set(rows.results.map((r) => r.key_class)).size, 4);
    for (const row of rows.results) {
      assert.ok(hashes.has(row.bucket_hash));
      assert.equal(row.state, "pending");
    }
    assert.deepEqual(
      inventoryComparisonHint("lofi", {
        their: { call: " w1aw " },
        startAtMillis: String(at + 123),
      }),
      { CALL: "W1AW", QSO_DATE: "20261108", TIME_ON: "123000" },
    );
  } finally {
    await f.mf.dispose();
  }
});

test("generation/source-roster races and callers without the hook roll back the entire observation page", async () => {
  const f = await fixture(false);
  try {
    const beforeGeneration = await f.page([qso("q")]);
    await f.generations.begin("a");
    await assert.rejects(
      f.inventory.publish(beforeGeneration),
      /comparison page generation changed/,
    );
    const page = await f.page([qso("q")]);
    await f.db
      .prepare(
        "UPDATE comparison_domains SET version=version+1,source_set_version=source_set_version+1 WHERE tenant='a'",
      )
      .run();
    await assert.rejects(
      f.inventory.publish(page),
      /comparison page generation changed/,
    );
    const unconfigured = new InventoryIngestion(f.store);
    await assert.rejects(
      unconfigured.publish(await f.page([qso("q")], {}, unconfigured)),
      /comparison page generation changed/,
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM inventory_records")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    assert.equal(
      (await f.inventory.snapshot("a", "source", "sync"))?.version,
      0,
    );
    await scratchEmpty(f);
  } finally {
    await f.mf.dispose();
  }
});

test("a late publication failure rolls back encrypted bodies, hints, bucket changes and cursor together", async () => {
  const f = await fixture();
  try {
    const page = await f.page([qso("q")]);
    await f.db
      .prepare(
        "CREATE TRIGGER fail_comparison_publication BEFORE UPDATE ON ingestion_pages WHEN NEW.state='committed' BEGIN SELECT RAISE(ABORT,'injected failure'); END;",
      )
      .run();
    await assert.rejects(f.inventory.publish(page), /injected failure/);
    for (const table of [
      "inventory_records",
      "inventory_payloads",
      "comparison_index",
      "comparison_work",
      "bucket_versions",
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
    await scratchEmpty(f);
    await f.db.prepare("DROP TRIGGER fail_comparison_publication").run();
    await f.inventory.publish(page);
    assert.equal(
      (
        await f.db
          .prepare("SELECT version FROM bucket_versions")
          .first<{ version: number }>()
      )?.version,
      1,
    );
  } finally {
    await f.mf.dispose();
  }
});
