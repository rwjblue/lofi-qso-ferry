import assert from "node:assert/strict";
import test from "node:test";
import {
  InventoryIngestion,
  type InventoryObservation,
} from "../src/inventory-ingestion.ts";
import { canonical, sha256 } from "../src/security.ts";
import { applyMigration, database, seed } from "./helpers.ts";

const calendarMigration = "0080_inventory_source_calendar.sql";
async function fixture(provider: "lofi" | "qrz" = "lofi", calendar = true) {
  const f = await database();
  try {
    await seed(f.store);
    await applyMigration(f.db, "0039_inventory_ingestion.sql");
    if (calendar) await applyMigration(f.db, calendarMigration);
    const inventory = new InventoryIngestion(f.store);
    const scope = provider === "lofi" ? "source" : "destination";
    await inventory.initialize(
      {
        tenant: "a",
        scope,
        connection: scope,
        provider,
        logicalIdentity: scope,
        adapterBinding: "calendar-fixture",
        ordering: provider === "lofi" ? "numeric" : "serialized",
      },
      "sync",
      "calendar-selection",
    );
    const lease = await f.store.claim(
      "a",
      `inventory:${scope}`,
      Date.now(),
      60000,
    );
    assert.ok(lease);
    const stream = () => inventory.snapshot("a", scope, "sync");
    const prepare = async (
      pageId: string,
      observations: InventoryObservation[],
    ) => {
      const current = await stream();
      assert.ok(current);
      return inventory.prepare({
        pageId,
        stream: current,
        lease,
        facet: provider === "lofi" ? "source" : "receipt",
        requestStartedAt: Date.now(),
        origin: "historical",
        observations,
        nextResume: { pageId },
      });
    };
    const months = async () =>
      (
        await f.db
          .prepare(
            "SELECT month_start,first_sequence,first_observed_at FROM inventory_source_calendar_months ORDER BY month_start",
          )
          .all<{
            month_start: string;
            first_sequence: number;
            first_observed_at: number;
          }>()
      ).results;
    return { ...f, inventory, prepare, stream, months };
  } catch (error) {
    await f.mf.dispose();
    throw error;
  }
}
function qso(key: string, order: number, date: string): InventoryObservation {
  return {
    family: "qso",
    subtype: "qso",
    key,
    order,
    revision: String(order),
    status: "active",
    body: { startAtMillis: Date.parse(date), their: { call: "W1AW" } },
  };
}

test("accepted source pages commit distinct month hints across a matching boundary", async () => {
  const f = await fixture();
  try {
    const first = qso("q1", 2, "2026-02-01T00:05:00Z");
    const page = await f.prepare("first", [
      first,
      qso("q2", 1, "2026-02-02T13:00:00Z"),
      { ...qso("event", 1, "2026-04-01T00:05:00Z"), subtype: "event" },
      { ...qso("deleted", 1, "2026-06-10T13:00:00Z"), status: "deleted" },
    ]);
    assert.deepEqual(page.calendarMonths, ["2026-01-01", "2026-02-01"]);
    const published = await f.inventory.publish(page);
    assert.equal(published.accepted, 4);
    const original = await f.months();
    assert.deepEqual(
      original,
      page.calendarMonths.map((month_start) => ({
        month_start,
        first_sequence: 1,
        first_observed_at: page.input.requestStartedAt,
      })),
    );
    assert.ok((await f.inventory.publish(page)).recovered);
    const overlap = await f.prepare("overlap", [
      first,
      qso("q2", 0, "2026-12-01T13:00:00Z"),
    ]);
    assert.deepEqual(overlap.calendarMonths, ["2026-01-01", "2026-02-01"]);
    assert.equal((await f.inventory.publish(overlap)).accepted, 1);
    assert.deepEqual(await f.months(), original);
    const replaced = await f.prepare("distinct", [
      qso("q1", 3, "2026-07-15T12:00:00Z"),
      qso("q1", 4, "2026-03-15T12:00:00Z"),
    ]);
    await f.inventory.publish(replaced);
    assert.deepEqual(
      (await f.months()).map((row) => row.month_start),
      ["2026-01-01", "2026-02-01", "2026-03-01"],
    );
  } finally {
    await f.mf.dispose();
  }
});

test("late month failure rolls back the source body, receipt and checkpoint", async () => {
  const f = await fixture();
  try {
    const before = await f.stream();
    const page = await f.prepare("late", [
      qso("q1", 1, "2026-02-10T13:00:00Z"),
    ]);
    await f.db
      .prepare(
        "CREATE TRIGGER fail_month BEFORE INSERT ON inventory_source_calendar_months BEGIN SELECT RAISE(ABORT,'late source month failure'); END;",
      )
      .run();
    await assert.rejects(
      f.inventory.publish(page),
      /late source month failure/,
    );
    assert.deepEqual(await f.stream(), before);
    assert.equal(await f.inventory.recover(page), null);
    assert.deepEqual(await f.months(), []);
    assert.deepEqual(
      await f.db
        .prepare("SELECT count(*) AS n FROM inventory_payloads")
        .first(),
      { n: 0 },
    );
    await f.db.prepare("DROP TRIGGER fail_month").run();
    assert.equal((await f.inventory.publish(page)).accepted, 1);
    assert.equal((await f.months()).length, 1);
  } finally {
    await f.mf.dispose();
  }
});

test("native publication rejects a non-month date even with a recomputed manifest", async () => {
  const f = await fixture();
  try {
    const valid = await f.prepare("invalid", [
      qso("q1", 1, "2026-02-10T13:00:00Z"),
    ]);
    const calendarMonths = ["2026-02-02"];
    const forged = {
      ...valid,
      calendarMonths,
      manifest: await sha256(
        canonical([
          "inventory-page-v1",
          valid.digest,
          valid.rows,
          valid.payloads,
          valid.comparison ?? null,
          calendarMonths,
        ]),
      ),
    };
    await assert.rejects(
      f.inventory.publish(forged),
      /inventory source calendar hints invalid/,
    );
    assert.deepEqual(await f.months(), []);
    assert.equal(await f.inventory.recover(valid), null);
  } finally {
    await f.mf.dispose();
  }
});

test("receipt pages cannot enroll source months", async () => {
  const f = await fixture("qrz");
  try {
    const page = await f.prepare("receipt", [
      { ...qso("9", 1, "2026-01-01T00:00:00Z"), order: null },
    ]);
    assert.equal(page.calendarMonths, undefined);
    assert.equal((await f.inventory.publish(page)).accepted, 1);
    assert.deepEqual(await f.months(), []);
  } finally {
    await f.mf.dispose();
  }
});

test("adding the calendar format retains committed receipts without re-observing old data", async () => {
  const f = await fixture("lofi", false);
  try {
    const page = await f.prepare("old", [qso("q1", 1, "2026-01-01T00:00:00Z")]);
    const before = await f.inventory.publish(page);
    await applyMigration(f.db, calendarMigration);
    assert.equal((await f.stream())?.sourceCalendarFormat, 1);
    const recovered = await f.inventory.publish(page);
    assert.ok(recovered.recovered);
    assert.equal(recovered.committedVersion, before.committedVersion);
    assert.deepEqual(await f.months(), []);
  } finally {
    await f.mf.dispose();
  }
});
