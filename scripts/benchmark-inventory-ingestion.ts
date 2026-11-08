import assert from "node:assert/strict";
import {
  InventoryIngestion,
  type InventoryObservation,
} from "../src/inventory-ingestion.ts";
import { Store } from "../src/store.ts";
import { applyMigration, database, seed } from "../tests/helpers.ts";
import {
  difference,
  measureD1 as measured,
} from "./inventory-benchmark-metrics.ts";

// Synthetic QSOs and isolated local D1/workerd only. No credentials are loaded
// and no vendor transport is constructed. Timings are not production capacity.
const DEFAULT_SIZES = [200, 500, 1000, 2000, 5000];
const IMPORT_PAGE_SIZE = 1000;
function observations(offset: number, count: number, edit = -1) {
  return Array.from({ length: count }, (_, position): InventoryObservation => {
    const index = offset + position;
    const revision = index === edit ? 2 : 1;
    const key = `q${String(index).padStart(6, "0")}`;
    const contact = {
      uuid: key,
      operation: `operation-${Math.floor(index / 100)}`,
      their: { call: `K${index % 10}BENCH`, name: "Synthetic operator" },
      our: { call: "W1AW", grid: "FN31AA", dxccCode: 291 },
      startAtMillis: Date.UTC(2026, 0, 1) + index * 60_000,
      band: "20m",
      mode: "CW",
      freq: 14025,
      rstSent: "599",
      rstReceived: "599",
      notes:
        revision === 2 ? "One edited synthetic contact" : "Synthetic contact",
      refs: [{ type: "pota", ref: "US-0001" }],
    };
    const order = Date.UTC(2026, 0, 2) + index + revision;
    return {
      family: "qso",
      key,
      subtype: "qso",
      parentKey: contact.operation,
      status: "active",
      revision: `r${revision}`,
      order,
      body: { ...contact, syncedAtMillis: order },
      semantic: contact,
    };
  });
}
async function storage(db: D1Database) {
  const result = await db
    .prepare(
      `SELECT (SELECT count(*) FROM inventory_records) AS records,
        (SELECT count(*) FROM inventory_payloads) AS payloads,
        (SELECT coalesce(sum(length(CAST(envelope AS BLOB))),0) FROM inventory_payloads) AS encryptedPayloadBytes`,
    )
    .all<{
      records: number;
      payloads: number;
      encryptedPayloadBytes: number;
    }>();
  assert.ok(result.results[0]);
  return { ...result.results[0], sqliteBytes: result.meta.size_after };
}
async function fixture() {
  const result = await database();
  try {
    await seed(result.store);
    await applyMigration(result.db, "0039_inventory_ingestion.sql");
    const setup = new InventoryIngestion(result.store);
    await setup.initialize(
      {
        tenant: "a",
        scope: "source",
        connection: "source",
        provider: "lofi",
        logicalIdentity: "source",
        adapterBinding: "synthetic-benchmark-v1",
        ordering: "numeric",
      },
      "sync",
      "all-clients-v1",
    );
    // Long local-only lease avoids turning a slow 200k benchmark into a retry.
    const lease = await result.store.claim(
      "a",
      "inventory:source",
      Date.now(),
      3_600_000,
    );
    assert.ok(lease);
    const meter = measured(result.db);
    return {
      ...result,
      lease,
      meter,
      inventory: new InventoryIngestion(
        new Store(meter.database, result.store.keys),
      ),
    };
  } catch (error) {
    await result.mf.dispose();
    throw error;
  }
}
async function ingest(
  f: Awaited<ReturnType<typeof fixture>>,
  rows: InventoryObservation[],
  origin: "historical" | "forward",
) {
  const before = { ...f.meter.totals };
  const started = performance.now();
  const stream = await f.inventory.snapshot("a", "source", "sync");
  assert.ok(stream);
  const page = await f.inventory.prepare({
    pageId: crypto.randomUUID(),
    stream,
    lease: f.lease,
    facet: "source",
    origin,
    requestStartedAt: Date.now(),
    observations: rows,
    nextResume: { page: stream.version + 1 },
    nextCheckpoint: { page: stream.version + 1 },
  });
  const publicationStarted = performance.now();
  const receipt = await f.inventory.publish(page);
  return {
    records: receipt.records,
    accepted: receipt.accepted,
    changed: receipt.changed,
    preparationMs: page.preparationMs,
    publicationMs: performance.now() - publicationStarted,
    publicationBatchMs: receipt.publicationMs,
    endToEndMs: performance.now() - started,
    plaintextBytes: page.plaintextBytes,
    encryptedBytes: page.encryptedBytes,
    database: difference(f.meter.totals, before),
    publication: {
      statements: receipt.statements,
      rowsRead: receipt.rowsRead,
      rowsWritten: receipt.rowsWritten,
    },
  };
}
async function profiles(size: number) {
  const f = await fixture();
  try {
    const initialStorage = await storage(f.db);
    for (const profile of ["new", "stable", "one-edit"] as const) {
      const rows = observations(
        0,
        size,
        profile === "one-edit" ? Math.floor(size / 2) : -1,
      );
      const result = await ingest(
        f,
        rows,
        profile === "new" ? "historical" : "forward",
      );
      assert.equal(
        result.changed,
        profile === "new" ? size : profile === "stable" ? 0 : 1,
      );
      assert.equal(result.accepted, size);
      console.log(
        JSON.stringify({
          scenario: "inventory-ingestion",
          profile,
          size,
          ...result,
          storage: { initial: initialStorage, current: await storage(f.db) },
          boundary: "snapshot_prepare_publish",
          firstQueriesUseAllForMetadata: true,
          vendorRequests: 0,
          operationContextIncluded: false,
        }),
      );
    }
  } finally {
    await f.mf.dispose();
  }
}
async function totalImport(total: number) {
  const f = await fixture();
  try {
    const initialStorage = await storage(f.db);
    const started = performance.now();
    const pageReadCounts: number[] = [];
    const sum = {
      records: 0,
      accepted: 0,
      changed: 0,
      preparationMs: 0,
      publicationMs: 0,
      publicationBatchMs: 0,
      endToEndMs: 0,
      plaintextBytes: 0,
      encryptedBytes: 0,
      publication: { statements: 0, rowsRead: 0, rowsWritten: 0 },
    };
    for (let offset = 0; offset < total; offset += IMPORT_PAGE_SIZE) {
      const result = await ingest(
        f,
        observations(offset, Math.min(IMPORT_PAGE_SIZE, total - offset)),
        "historical",
      );
      pageReadCounts.push(result.database.rowsRead);
      for (const key of Object.keys(sum) as (keyof typeof sum)[])
        if (key !== "publication") sum[key] += result[key];
      for (const key of Object.keys(
        sum.publication,
      ) as (keyof typeof sum.publication)[])
        sum.publication[key] += result.publication[key];
    }
    assert.equal(sum.changed, total);
    const currentStorage = await storage(f.db);
    assert.equal(currentStorage.records, total);
    assert.equal(currentStorage.payloads, total);
    console.log(
      JSON.stringify({
        scenario: "inventory-import",
        total,
        pageSize: IMPORT_PAGE_SIZE,
        pages: Math.ceil(total / IMPORT_PAGE_SIZE),
        ...sum,
        totalElapsedMs: performance.now() - started,
        database: f.meter.totals,
        pageRowsRead: {
          first: pageReadCounts[0],
          last: pageReadCounts.at(-1),
          min: Math.min(...pageReadCounts),
          max: Math.max(...pageReadCounts),
        },
        storage: { initial: initialStorage, current: currentStorage },
        boundary: "snapshot_prepare_publish_per_page",
        firstQueriesUseAllForMetadata: true,
        vendorRequests: 0,
        operationContextIncluded: false,
      }),
    );
  } finally {
    await f.mf.dispose();
  }
}
function bounded(value: string, maximum: number) {
  const number = Number(value);
  assert.ok(
    Number.isSafeInteger(number) && number >= 1 && number <= maximum,
    `Counts must be integers between 1 and ${maximum}`,
  );
  return number;
}
let sizes = DEFAULT_SIZES;
let total: number | undefined;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const option = args[index];
  const value = args[++index];
  assert.ok(value, "Expected --sizes CSV and/or --total COUNT");
  if (option === "--sizes") {
    sizes = [...new Set(value.split(",").map((size) => bounded(size, 5000)))];
    assert.ok(sizes.length <= 10, "At most ten profile sizes are allowed");
  } else if (option === "--total") total = bounded(value, 200_000);
  else throw new Error("Expected --sizes CSV and/or --total COUNT");
}
for (const size of sizes) await profiles(size);
if (total !== undefined) await totalImport(total);
