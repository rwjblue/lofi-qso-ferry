import { applyMigration } from "./helpers.ts";

export async function installMatchingCoordinator(db: D1Database) {
  for (const name of [
    "0059_inventory_live_bucket_dependencies.sql",
    "0060_inventory_matching_bucket_pages.sql",
    "0062_inventory_matching_pair_jobs.sql",
    "0063_inventory_matching_pair_pages.sql",
    "0067_inventory_matching_coverage_dispatch.sql",
    "0068_inventory_matching_coverage_pages.sql",
    "0069_inventory_matching_coordinator.sql",
  ])
    await applyMigration(db, name);
}
