import { InventoryMatchingPairs } from "../src/inventory-matching-pairs.ts";
import { applyMigration } from "./helpers.ts";
import { pairFixture } from "./inventory-matching-pair-metadata-fixtures.ts";

export async function pairPagesFixture(
  options: Parameters<typeof pairFixture>[0] = {},
  existing?: Parameters<typeof pairFixture>[1],
) {
  const f = await pairFixture(options, existing);
  try {
    await applyMigration(f.db, "0063_inventory_matching_pair_pages.sql");
    return { ...f, pairs: new InventoryMatchingPairs(f.store) };
  } catch (error) {
    await f.mf.dispose();
    throw error;
  }
}
