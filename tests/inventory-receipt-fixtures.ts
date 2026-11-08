import assert from "node:assert/strict";
import { InventoryComparisonBuilds } from "../src/inventory-comparison-builds.ts";
import { InventoryComparisonGenerations } from "../src/inventory-comparison-generations.ts";
import { InventoryComparisonPages } from "../src/inventory-comparison-pages.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import { InventoryProjectionWorkspace } from "../src/inventory-projection-workspace.ts";
import { applyMigration, database, seed } from "./helpers.ts";

export async function receiptFixture(provider: "qrz" | "lotw" = "qrz") {
  const f = await database();
  await seed(f.store);
  for (const name of [
    "0039_inventory_ingestion.sql",
    "0040_inventory_runs.sql",
    "0044_inventory_comparison_generations.sql",
    "0045_inventory_comparison_ingestion.sql",
    "0046_inventory_comparison_builds.sql",
    "0047_inventory_context_membership.sql",
    "0048_inventory_projection_publication.sql",
  ])
    await applyMigration(f.db, name);
  if (provider === "lotw")
    await f.db
      .prepare(
        "UPDATE connections SET kind='lotw' WHERE tenant='a' AND id='destination'",
      )
      .run();
  const inventory = new InventoryIngestion(
    f.store,
    new InventoryComparisonPages(f.store),
  );
  const stream = await inventory.initialize(
    {
      tenant: "a",
      scope: "destination",
      connection: "destination",
      provider,
      logicalIdentity: "destination",
      adapterBinding: "test-v1",
      ordering: "serialized",
    },
    "receipt",
    "book-v1",
  );
  const lease = await f.store.claim(
    "a",
    "inventory:destination",
    Date.now(),
    60_000,
  );
  assert.ok(lease);
  const domain = await new InventoryComparisonGenerations(f.store).begin("a");
  assert.ok(domain.pending_generation);
  const generation = domain.pending_generation;
  const base = {
    CALL: "W1AW",
    STATION_CALLSIGN: "N1RWJ",
    QSO_DATE: "20261108",
    TIME_ON: "1230",
    BAND: "20m",
    MODE: provider === "qrz" ? "CW" : "DATA",
    ...(provider === "lotw"
      ? { APP_LOTW_MODE: "FT8", APP_LOTW_MODEGROUP: "DATA" }
      : {}),
    NAME: "Private remote name",
    NOTES: "Private remote narrative",
  };
  await inventory.publish(
    await inventory.prepare({
      pageId: crypto.randomUUID(),
      stream,
      lease,
      facet: "receipt",
      requestStartedAt: Date.now(),
      origin: "historical",
      nextResume: {},
      observations: [
        {
          family: "qso",
          key: "1",
          subtype: "qso",
          status: "active",
          order: null,
          revision: "r1",
          body: base,
        },
        {
          family: "qso",
          key: "2",
          subtype: "qso",
          status: "active",
          order: null,
          revision: "r1",
          body: { ...base, MODE: "ALIEN" },
        },
      ],
    }),
  );
  await new InventoryComparisonBuilds(f.store).step(
    "a",
    generation,
    "destination",
  );
  return {
    ...f,
    generation,
    workspace: new InventoryProjectionWorkspace(f.store),
  };
}
