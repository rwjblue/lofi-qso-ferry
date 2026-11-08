import { applyMigration } from "./helpers.ts";
import { invalidationFixture } from "./inventory-matching-invalidations-fixtures.ts";

export async function pairFixture(
  options: Parameters<typeof invalidationFixture>[0] = {},
  existing?: Parameters<typeof invalidationFixture>[1],
) {
  const f = await invalidationFixture(options, existing);
  try {
    await applyMigration(f.db, "0062_inventory_matching_pair_jobs.sql");
    return f;
  } catch (error) {
    await f.mf.dispose();
    throw error;
  }
}
