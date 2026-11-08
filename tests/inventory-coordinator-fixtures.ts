import { InventoryComparisonBuilds } from "../src/inventory-comparison-builds.ts";
import { InventoryComparisonCoordinator } from "../src/inventory-comparison-coordinator.ts";
import { InventoryComparisonGenerations } from "../src/inventory-comparison-generations.ts";
import { InventoryProjectionCoverageJobs } from "../src/inventory-projection-coverage-jobs.ts";
import { InventoryProjectionJobs } from "../src/inventory-projection-jobs.ts";
import { InventoryProjections } from "../src/inventory-projections.ts";
import { applyMigration, database } from "./helpers.ts";
import {
  fixture as contextFixture,
  observation,
} from "./inventory-context-fixtures.ts";
import { sourceContact } from "./inventory-matching-fixtures.ts";

export async function coordinatorFixture(
  count = 3,
  existing?: Awaited<ReturnType<typeof database>>,
) {
  const runtime = existing ?? (await database());
  try {
    const f = await contextFixture(runtime);
    for (const name of [
      "0049_inventory_matching_read_indexes.sql",
      "0050_inventory_match_results.sql",
      "0051_inventory_historical_ownership.sql",
      "0052_inventory_projection_jobs.sql",
      "0053_inventory_projection_coverage_jobs.sql",
      "0054_inventory_bounded_generation_setup.sql",
      "0055_inventory_comparison_coordinator.sql",
      "0056_inventory_current_work_selection.sql",
      "0057_inventory_scoped_activation_debt.sql",
      "0066_inventory_projection_coverage_holds.sql",
    ])
      await applyMigration(f.db, name);
    const operation = observation("op", "operation");
    const sources = Array.from({ length: count }, (_, i) =>
      sourceContact(`q${String(i).padStart(4, "0")}`, "13:00:00", `W${i}AW`),
    );
    await f.full([operation, ...sources]);
    return {
      ...f,
      operation,
      sources,
      coordinator: new InventoryComparisonCoordinator(f.store),
      builds: new InventoryComparisonBuilds(f.store),
      generations: new InventoryComparisonGenerations(f.store),
      projections: new InventoryProjections(f.store),
    };
  } catch (error) {
    await runtime.mf.dispose();
    throw error;
  }
}
export async function activationFixture(
  count = 3,
  beforeRebuild?: (
    fixture: Awaited<ReturnType<typeof coordinatorFixture>>,
  ) => Promise<void>,
) {
  const f = await coordinatorFixture(count);
  try {
    const prepareGeneration = async (generation: string) => {
      for (let page = 0; page < 1000; page++) {
        const result = await f.builds.step("a", generation, "source");
        if ("complete" in result && result.complete) break;
        if (page === 999) throw new Error("coordinator fixture build limit");
      }
      for (let offset = 0; offset < f.sources.length; offset += 20)
        await f.projections.project(
          "a",
          generation,
          "source",
          f.sources.slice(offset, offset + 20).map((row) => row.key),
        );
    };
    await prepareGeneration(f.generation);
    for (let page = 0; page < 1000; page++)
      if (
        (await new InventoryProjectionJobs(f.store).expandNext("a")).kind !==
        "expanded"
      )
        break;
    await new InventoryProjectionCoverageJobs(f.store).step("a");
    await f.builds.activate("a", f.generation);
    await beforeRebuild?.(f);
    const domain = await f.generations.begin("a");
    if (!domain.pending_generation)
      throw new Error("coordinator fixture generation missing");
    const pending = domain.pending_generation;
    await prepareGeneration(pending);
    await new InventoryProjectionCoverageJobs(f.store).step("a");
    const lease = await f.store.claim(
      "a",
      "inventory-comparison",
      Date.now(),
      60000,
    );
    if (!lease) throw new Error("coordinator fixture lease missing");
    return { ...f, pending, lease };
  } catch (error) {
    await f.mf.dispose();
    throw error;
  }
}
