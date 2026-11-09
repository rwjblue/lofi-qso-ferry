import assert from "node:assert/strict";
import test from "node:test";
import { measureD1 } from "../scripts/inventory-benchmark-metrics.ts";
import { activateInventoryRuntime } from "../src/inventory-runtime.ts";
import {
  registerInventorySelection,
  registerInventorySources,
  registerLotwAccountFeeds,
  registerSourceCalendarSelections,
} from "../src/inventory-scheduler.ts";
import { Store } from "../src/store.ts";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

test("settled calendar skips gap discovery until an input changes", async (t) => {
  const { db, mf, store } = await database();
  t.after(() => mf.dispose());
  await applyAdditionalMigrations(db);
  await seed(store);
  const book = {
    bookId: "7",
    stationCallsign: "N1RWJ",
    startDate: "2025-01-01",
    endDate: "2025-12-31",
  };
  await db.batch([
    db
      .prepare("UPDATE connections SET config=? WHERE id='source'")
      .bind('{"accountId":"source"}'),
    db
      .prepare("UPDATE connections SET config=? WHERE id='destination'")
      .bind(JSON.stringify(book)),
  ]);
  const runtime = await activateInventoryRuntime(store);
  assert.equal((await registerInventorySources(store, runtime)).registered, 1);

  async function addMonth(month: string) {
    await db
      .prepare(
        `INSERT INTO inventory_source_calendar_months(tenant,scope_id,month_start,first_sequence,first_observed_at)
         SELECT tenant,scope_id,?,1,1 FROM inventory_scopes WHERE provider='lofi'`,
      )
      .bind(month)
      .run();
  }

  const discover = (limit?: number) =>
    registerSourceCalendarSelections(store, runtime, limit);
  const empty = { registered: 0, failed: 0 };
  const registered = { registered: 1, failed: 0 };
  assert.deepEqual(await discover(), empty);

  await addMonth("2025-02-01");
  await addMonth("2025-03-01");
  assert.deepEqual(await discover(1), registered);
  // The next page starts after February. An earlier month still gets a turn.
  await addMonth("2025-01-01");
  assert.deepEqual(await discover(1), registered);
  assert.deepEqual(await discover(1), empty);
  assert.deepEqual(await discover(1), registered);
  assert.deepEqual(await discover(1), empty);
  assert.deepEqual(await discover(1), empty);

  const destination = await store.connection("a", "destination");
  assert.ok(destination);
  await registerInventorySelection(store, runtime, destination, {
    provider: "qrz",
    book,
    between: ["2025-04-10", "2025-04-20"],
  });
  await addMonth("2025-04-01");
  // Filling the first gap doesn't settle the other side of the same month.
  assert.deepEqual(await discover(), registered);
  assert.deepEqual(await discover(), registered);
  assert.deepEqual(await discover(), empty);
  const windows = await db
    .prepare(
      `SELECT json_extract(plan,'$.between') AS dates FROM inventory_scheduled_selections
       WHERE json_extract(plan,'$.provider')='qrz' ORDER BY dates`,
    )
    .all();
  assert.deepEqual(windows.results, [
    { dates: '["2025-01-01","2025-01-31"]' },
    { dates: '["2025-02-01","2025-02-28"]' },
    { dates: '["2025-03-01","2025-03-31"]' },
    { dates: '["2025-04-01","2025-04-09"]' },
    { dates: '["2025-04-10","2025-04-20"]' },
    { dates: '["2025-04-21","2025-04-30"]' },
  ]);

  // Poll telemetry should not invalidate the settled generation.
  await db
    .prepare(
      "UPDATE connections SET config=json_set(config,'$.lastSuccessfulPollAt',100) WHERE id='destination'",
    )
    .run();
  assert.deepEqual(await registerInventorySources(store, runtime), empty);
  const meter = measureD1(db);
  const measured = new Store(meter.database, store.keys);
  assert.deepEqual(await registerInventorySources(measured, runtime), empty);
  assert.deepEqual(
    await registerSourceCalendarSelections(measured, runtime),
    empty,
  );
  assert.deepEqual(await registerLotwAccountFeeds(measured, runtime), empty);
  assert.equal(meter.totals.rowsWritten, 0);
  assert.ok(meter.totals.rowsRead < 30, JSON.stringify(meter.totals));
  assert.ok(meter.totals.statements <= 10, JSON.stringify(meter.totals));

  await db
    .prepare(
      "DELETE FROM inventory_scheduled_selections WHERE json_extract(plan,'$.between[0]')='2025-04-10'",
    )
    .run();
  assert.deepEqual(await discover(), registered);
});
