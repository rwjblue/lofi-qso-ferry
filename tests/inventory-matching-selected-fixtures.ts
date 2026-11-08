import { applyMigration } from "./helpers.ts";
import { installMatchingCoordinator } from "./inventory-matching-coordinator-fixtures.ts";
import { matchingWorkFixture } from "./inventory-matching-work-fixtures.ts";
import { InventoryMatchingSelected } from "../src/inventory-matching-selected.ts";

export async function selectedFixture(
  options: Parameters<typeof matchingWorkFixture>[0] = {},
) {
  const f = await matchingWorkFixture(options);
  try {
    await installMatchingCoordinator(f.db);
    await applyMigration(f.db, "0070_inventory_matching_selected_inputs.sql");
    return f;
  } catch (error) {
    await f.mf.dispose();
    throw error;
  }
}

export async function selectedPagesFixture(
  options: Parameters<typeof matchingWorkFixture>[0] = {},
) {
  const f = await selectedFixture(options);
  try {
    await applyMigration(f.db, "0071_inventory_matching_selected_pages.sql");
    return { ...f, selectedInputs: new InventoryMatchingSelected(f.store) };
  } catch (error) {
    await f.mf.dispose();
    throw error;
  }
}
