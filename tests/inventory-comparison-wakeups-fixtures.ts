import { InventoryComparisonWakeups } from "../src/inventory-comparison-wakeups.ts";
import { readdir } from "node:fs/promises";
import { applyMigration, database } from "./helpers.ts";
import { installMatchingCoordinator } from "./inventory-matching-coordinator-fixtures.ts";
import { matchingWorkFixture } from "./inventory-matching-work-fixtures.ts";

export async function comparisonWakeupsFixture() {
  const base = await database();
  let f: Awaited<ReturnType<typeof matchingWorkFixture>>;
  try {
    for (const name of (
      await readdir(new URL("../migrations/", import.meta.url))
    )
      .filter(
        (name) =>
          name.endsWith(".sql") &&
          name > "0001_" &&
          !name.startsWith("0001_") &&
          name < "0039_",
      )
      .sort())
      await applyMigration(base.db, name);
    f = await matchingWorkFixture({ receipts: [] }, base);
  } catch (error) {
    await base.mf.dispose();
    throw error;
  }
  try {
    await installMatchingCoordinator(f.db);
    await applyMigration(f.db, "0041_inventory_vendor_admission.sql");
    await applyMigration(f.db, "0042_inventory_runtime.sql");
    await applyMigration(f.db, "0043_inventory_scheduling.sql");
    await applyMigration(f.db, "0073_inventory_comparison_wakeups.sql");
    return { ...f, wakeups: new InventoryComparisonWakeups(f.store) };
  } catch (error) {
    await f.mf.dispose();
    throw error;
  }
}
