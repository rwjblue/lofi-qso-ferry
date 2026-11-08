import { InventoryMatchingResults } from "../src/inventory-matching-results.ts";
import { InventoryMatchingWork } from "../src/inventory-matching-work.ts";
import { applyMigration, database } from "./helpers.ts";
import { matchingFixture } from "./inventory-matching-fixtures.ts";

export async function matchingWorkFixture(
  options: Parameters<typeof matchingFixture>[0] = {},
  existing?: Awaited<ReturnType<typeof database>>,
) {
  const base = existing ?? (await database());
  try {
    const f = await matchingFixture(options, base);
    for (const name of [
      "0052_inventory_projection_jobs.sql",
      "0053_inventory_projection_coverage_jobs.sql",
      "0054_inventory_bounded_generation_setup.sql",
      "0055_inventory_comparison_coordinator.sql",
      "0056_inventory_current_work_selection.sql",
      "0057_inventory_scoped_activation_debt.sql",
      "0058_inventory_matching_work.sql",
      "0066_inventory_projection_coverage_holds.sql",
    ])
      await applyMigration(f.db, name);
    return {
      ...f,
      work: new InventoryMatchingWork(f.store),
      matches: new InventoryMatchingResults(f.store),
      selected: f.sources.map((row) => ({ scope: "source", key: row.key })),
    };
  } catch (error) {
    await base.mf.dispose();
    throw error;
  }
}
