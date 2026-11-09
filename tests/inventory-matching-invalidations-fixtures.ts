import { InventoryMatchingInvalidations } from "../src/inventory-matching-invalidations.ts";
import { applyMigration } from "./helpers.ts";
import { matchingWorkFixture } from "./inventory-matching-work-fixtures.ts";

export async function invalidationFixture(
  options: Parameters<typeof matchingWorkFixture>[0] = {},
  existing?: Parameters<typeof matchingWorkFixture>[1],
) {
  const f = await matchingWorkFixture(options, existing);
  try {
    await applyMigration(f.db, "0059_inventory_live_bucket_dependencies.sql");
    await applyMigration(f.db, "0060_inventory_matching_bucket_pages.sql");
    await applyMigration(
      f.db,
      "0124_inventory_match_dependency_probe_order.sql",
    );
    return { ...f, invalidations: new InventoryMatchingInvalidations(f.store) };
  } catch (error) {
    await f.mf.dispose();
    throw error;
  }
}
