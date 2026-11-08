import assert from "node:assert/strict";
import { InventoryMatchingCoverage } from "../src/inventory-matching-coverage.ts";
import { InventoryMatchingCoverageEvents } from "../src/inventory-matching-coverage-events.ts";
import type { database } from "./helpers.ts";
import { applyMigration } from "./helpers.ts";
import { sourceContact } from "./inventory-matching-fixtures.ts";
import { matchingWorkFixture } from "./inventory-matching-work-fixtures.ts";

export async function coverageFixture(
  count = 3,
  existing?: Awaited<ReturnType<typeof database>>,
  options: {
    stationCallsign?: string;
    enroll?: number;
    earlierDay?: string;
  } = {},
) {
  const f = await matchingWorkFixture(
    {
      provider: "lotw",
      receipts: [],
      range: ["2026-11-09", "2026-11-09"],
      sources: Array.from({ length: count }, (_, i) => {
        const row = sourceContact(`q${String(i).padStart(4, "0")}`);
        if (options.earlierDay && i === count - 1)
          row.body = {
            ...(row.body as object),
            startAtMillis: Date.parse(`${options.earlierDay}T13:00:00Z`),
          };
        return row;
      }),
    },
    existing,
  );
  try {
    for (const migration of [
      "0059_inventory_live_bucket_dependencies.sql",
      "0060_inventory_matching_bucket_pages.sql",
      "0062_inventory_matching_pair_jobs.sql",
      "0063_inventory_matching_pair_pages.sql",
      "0067_inventory_matching_coverage_dispatch.sql",
      "0068_inventory_matching_coverage_pages.sql",
    ])
      await applyMigration(f.db, migration);
    const selected = f.selected.slice(0, options.enroll ?? count);
    const lease = await f.store.claim(
      "a",
      "matching:destination",
      Date.now(),
      60000,
    );
    assert.ok(lease);
    try {
      for (let i = 0; i < selected.length; i += 20) {
        const result = await f.matches.publish(
          await f.workspace.prepare(
            "a",
            "destination",
            selected.slice(i, i + 20),
          ),
          lease,
          `baseline-${String(i).padStart(6, "0")}`,
        );
        assert.equal(result.records, Math.min(20, selected.length - i));
      }
    } finally {
      await f.store.release(lease);
    }
    await f.fullReceipt(
      [],
      [options.earlierDay ?? "2026-11-08", "2026-11-08"],
      {
        stationCallsign: options.stationCallsign,
      },
    );
    const events = new InventoryMatchingCoverageEvents(f.store);
    const event = await events.step("a");
    assert.ok("jobs" in event);
    assert.equal(event.jobs, options.earlierDay ? 2 : 1);
    return {
      ...f,
      events,
      event,
      coverage: new InventoryMatchingCoverage(f.store),
    };
  } catch (error) {
    await f.mf.dispose();
    throw error;
  }
}
