import assert from "node:assert/strict";
import { InventoryComparisonPages } from "../src/inventory-comparison-pages.ts";
import {
  InventoryIngestion,
  type InventoryObservation,
} from "../src/inventory-ingestion.ts";
import type { InventoryRunDefinition } from "../src/inventory-run-publication.ts";
import { type InventoryRunPage, InventoryRuns } from "../src/inventory-runs.ts";
import { applyMigration, database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

export async function inventoryRunFixture(
  provider: "lofi" | "qrz" = "lofi",
  schema: "minimal" | "current" = "minimal",
) {
  const fixture = await database();
  await seed(fixture.store);
  if (schema === "current") await applyAdditionalMigrations(fixture.db);
  else {
    await applyMigration(fixture.db, "0039_inventory_ingestion.sql");
    await applyMigration(fixture.db, "0040_inventory_runs.sql");
    await applyMigration(fixture.db, "0143_inventory_wakeup_delivery.sql");
  }
  const inventory = new InventoryIngestion(
    fixture.store,
    schema === "current"
      ? new InventoryComparisonPages(fixture.store)
      : undefined,
  );
  const runs = new InventoryRuns(inventory);
  const connection = provider === "lofi" ? "source" : "destination";
  const scope = `inventory-${provider}`;
  const initial = await inventory.initialize(
    {
      tenant: "a",
      scope,
      connection,
      provider,
      logicalIdentity: connection,
      adapterBinding: "run-test-v1",
      ordering: provider === "lofi" ? "numeric" : "serialized",
    },
    "sync",
    "run-query-v1",
  );
  const lease = await fixture.store.claim(
    "a",
    `inventory:${scope}`,
    Date.now(),
    90_000,
  );
  assert.ok(lease);
  const required = provider === "lofi" ? ["operations", "qsos"] : ["selection"];
  return {
    ...fixture,
    inventory,
    runs,
    scope,
    lease,
    initial,
    qso(key: string, order = 1): InventoryObservation {
      return {
        family: "qso",
        key,
        subtype: "qso",
        status: "active",
        revision: `r${order}`,
        order: provider === "lofi" ? order : null,
        body: { key, order, call: "W1AW" },
      };
    },
    async begin(
      overrides: Partial<InventoryRunDefinition> = {},
      replaceHeld = false,
    ) {
      const stream = await inventory.snapshot("a", scope, "sync");
      assert.ok(stream);
      return runs.begin({
        stream,
        lease,
        replaceHeld,
        definition: {
          id: crypto.randomUUID(),
          mode: "full",
          facet: provider === "lofi" ? "source" : "receipt",
          partition: "all",
          partitionBinding: "all-records-v1",
          collectionBinding: "collect-v1",
          ...(provider === "lofi" ? { catchupBinding: "catchup-v1" } : {}),
          requiredStreams: required,
          fixedQuery: { upper: Date.now() },
          initialResume: {},
          ...overrides,
        },
      });
    },
    async page(
      runId: string,
      observations: InventoryObservation[],
      options: Partial<InventoryRunPage> = {},
    ) {
      const context = await runs.context("a", runId);
      return runs.preparePage(context, lease, {
        observations,
        requestStartedAt: Date.now(),
        requestBinding:
          context.run.phase === "catchup" ? "catchup-v1" : "collect-v1",
        nextResume: { next: context.run.version },
        observedComplete: false,
        completedStreams: [],
        nextDueAt: Date.now(),
        ...options,
      });
    },
    async observed(
      runId: string,
      observations: InventoryObservation[] = [],
      checkpoint: unknown = { watermark: 100 },
    ) {
      const context = await runs.context("a", runId);
      return inventory.publish(
        await runs.preparePage(context, lease, {
          observations,
          requestStartedAt: Date.now(),
          requestBinding:
            context.run.phase === "catchup" ? "catchup-v1" : "collect-v1",
          nextResume: { next: context.run.version },
          observedComplete: true,
          completedStreams: required,
          proposedCheckpoint: checkpoint,
          nextDueAt: Date.now(),
        }),
      );
    },
    async finish(runId: string) {
      for (let pass = 0; pass < 100; pass++) {
        const context = await runs.context("a", runId);
        if (context.run.phase === "quarantining")
          await inventory.publish(
            await runs.prepareQuarantine(context, lease, { limit: 2 }),
          );
        else if (context.run.phase === "publishing") {
          await inventory.publish(await runs.prepareComplete(context, lease));
          return;
        } else throw new Error(`unexpected fixture phase ${context.run.phase}`);
      }
      throw new Error("fixture quarantine did not finish");
    },
  };
}
