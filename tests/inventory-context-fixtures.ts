import assert from "node:assert/strict";
import { InventoryComparisonGenerations } from "../src/inventory-comparison-generations.ts";
import { InventoryComparisonPages } from "../src/inventory-comparison-pages.ts";
import {
  InventoryIngestion,
  type InventoryObservation,
} from "../src/inventory-ingestion.ts";
import { InventoryRuns } from "../src/inventory-runs.ts";
import { applyMigration, database, seed } from "./helpers.ts";

export function observation(
  key: string,
  subtype: "operation" | "event" | "qso" = "qso",
  order = 1,
): InventoryObservation {
  return {
    family: subtype === "operation" ? "operation" : "qso",
    key,
    subtype,
    ...(subtype === "operation" ? {} : { parentKey: "op" }),
    status: "active",
    order,
    revision: String(order),
    body: {
      uuid: key,
      ...(subtype === "operation"
        ? { stationCall: "N1RWJ" }
        : {
            operation: "op",
            their: { call: "W1AW" },
            startAtMillis: Date.parse("2026-11-08T12:30:00Z"),
            band: subtype === "event" ? "event" : "20m",
            mode: "CW",
            ...(subtype === "event"
              ? {
                  event: {
                    event: "start",
                    operation: { stationCall: "K1ABC" },
                  },
                }
              : {}),
          }),
    },
  };
}
export async function fixture(existing?: Awaited<ReturnType<typeof database>>) {
  const f = existing ?? (await database());
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
  const hook = new InventoryComparisonPages(f.store);
  const inventory = new InventoryIngestion(f.store, hook);
  await inventory.initialize(
    {
      tenant: "a",
      scope: "source",
      connection: "source",
      provider: "lofi",
      logicalIdentity: "source",
      adapterBinding: "test-v1",
      ordering: "numeric",
    },
    "sync",
    "all-clients-v1",
  );
  const domain = await new InventoryComparisonGenerations(f.store).begin("a");
  assert.ok(domain.pending_generation);
  const generation = domain.pending_generation;
  const claimed = await f.store.claim(
    "a",
    "inventory:source",
    Date.now(),
    90_000,
  );
  assert.ok(claimed);
  const lease = claimed;
  const runs = new InventoryRuns(inventory);
  async function begin() {
    const stream = await inventory.snapshot("a", "source", "sync");
    assert.ok(stream);
    return runs.begin({
      stream,
      lease,
      definition: {
        id: crypto.randomUUID(),
        mode: "full",
        facet: "source",
        partition: "all",
        partitionBinding: "all-v1",
        collectionBinding: "collect-v1",
        catchupBinding: "catchup-v1",
        requiredStreams: ["operations", "qsos"],
        fixedQuery: { upper: Date.now() },
        initialResume: {},
      },
    });
  }
  async function observed(id: string, observations: InventoryObservation[]) {
    const context = await runs.context("a", id);
    return inventory.publish(
      await runs.preparePage(context, lease, {
        observations,
        requestStartedAt: Date.now(),
        requestBinding:
          context.run.phase === "catchup" ? "catchup-v1" : "collect-v1",
        nextResume: {},
        observedComplete: true,
        completedStreams: ["operations", "qsos"],
        proposedCheckpoint: { watermark: 1 },
        nextDueAt: Date.now(),
      }),
    );
  }
  async function finish(id: string) {
    const receipts = [];
    for (let pass = 0; pass < 10; pass++) {
      const context = await runs.context("a", id);
      if (context.run.phase === "quarantining")
        receipts.push(
          await inventory.publish(
            await runs.prepareQuarantine(context, lease, { limit: 200 }),
          ),
        );
      else if (context.run.phase === "publishing") {
        await inventory.publish(await runs.prepareComplete(context, lease));
        return receipts;
      } else
        throw new Error(
          `unexpected context fixture phase ${context.run.phase}`,
        );
    }
    throw new Error("fixture did not finish");
  }
  async function full(rows: InventoryObservation[]) {
    const run = await begin();
    await observed(run.id, rows);
    await observed(run.id, []);
    return finish(run.id);
  }
  return {
    ...f,
    hook,
    inventory,
    runs,
    lease,
    begin,
    observed,
    finish,
    full,
    generation,
  };
}
export async function topology(f: Awaited<ReturnType<typeof fixture>>) {
  return (
    await f.db
      .prepare(
        "SELECT topology_version FROM projection_domains WHERE operation_key='op'",
      )
      .first<{ topology_version: number }>()
  )?.topology_version;
}
export async function membership(
  f: Awaited<ReturnType<typeof fixture>>,
  key: string,
) {
  return f.db
    .prepare(
      "SELECT m.state,v.version FROM inventory_partition_membership m JOIN inventory_membership_versions v ON v.tenant=m.tenant AND v.scope_id=m.scope_id AND v.entity_family=m.entity_family AND v.record_key=m.record_key AND v.facet=m.facet WHERE m.tenant='a' AND m.record_key=?",
    )
    .bind(key)
    .first();
}
export async function scratchEmpty(f: Awaited<ReturnType<typeof fixture>>) {
  for (const table of [
    "ingestion_context_pages",
    "ingestion_page_domains",
    "ingestion_membership_effects",
  ])
    assert.equal(
      (
        await f.db
          .prepare(`SELECT count(*) AS n FROM ${table}`)
          .first<{ n: number }>()
      )?.n,
      0,
      table,
    );
}
