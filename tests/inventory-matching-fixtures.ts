import assert from "node:assert/strict";
import type { AdifRecord } from "../src/adif.ts";
import { InventoryComparisonBuilds } from "../src/inventory-comparison-builds.ts";
import type { InventoryObservation } from "../src/inventory-ingestion.ts";
import { InventoryMatchingWorkspace } from "../src/inventory-matching-workspace.ts";
import { InventoryProjections } from "../src/inventory-projections.ts";
import {
  type InventoryScanPlan,
  planInventoryRun,
} from "../src/inventory-run-plans.ts";
import { applyMigration, type database } from "./helpers.ts";
import { fixture, observation } from "./inventory-context-fixtures.ts";

export function sourceContact(key: string, time = "13:00:00", call = "W1AW") {
  const row = observation(key);
  row.body = {
    ...(row.body as object),
    startAtMillis: Date.parse(`2026-11-08T${time}Z`),
    their: { call },
    our: { grid: "FN31" },
    notes: "Private matching source narrative",
  };
  return row;
}
export function receipt(
  key = "1",
  time = "130000",
  call = "W1AW",
): InventoryObservation {
  return {
    family: "qso",
    key,
    subtype: "qso",
    status: "active",
    order: null,
    revision: "r1",
    body: {
      CALL: call,
      STATION_CALLSIGN: "N1RWJ",
      QSO_DATE: "20261108",
      TIME_ON: time,
      BAND: "20m",
      MODE: "CW",
      MY_GRIDSQUARE: "FN31",
      NAME: "Private matching remote name",
    } satisfies AdifRecord,
  };
}
export async function matchingFixture(
  options: {
    provider?: "qrz" | "lotw";
    sources?: InventoryObservation[];
    receipts?: InventoryObservation[];
    range?: [string, string];
    lotwReadAccess?: true;
  } = {},
  existing?: Awaited<ReturnType<typeof database>>,
  schema: "minimal" | "current" = "minimal",
) {
  const f = await fixture(existing, schema);
  if (schema === "minimal")
    for (const name of [
      "0049_inventory_matching_read_indexes.sql",
      "0050_inventory_match_results.sql",
      "0127_inventory_sync_scopes.sql",
      "0132_inventory_match_scope_binding.sql",
      "0064_inventory_matching_result_update.sql",
      "0061_inventory_matching_coverage_clocks.sql",
      "0065_inventory_matching_coverage_recovery.sql",
      "0051_inventory_historical_ownership.sql",
      "0140_inventory_lotw_grid_updates.sql",
    ])
      await applyMigration(f.db, name);
  const provider = options.provider ?? "qrz";
  if (provider === "lotw")
    await f.db
      .prepare(
        "UPDATE connections SET kind='lotw',config=? WHERE tenant='a' AND id='destination'",
      )
      .bind(options.lotwReadAccess ? '{"readAccess":true}' : "{}")
      .run();
  const destinationStream = await f.inventory.initialize(
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
    "selection-v1",
  );
  const claimedDestinationLease = await f.store.claim(
    "a",
    "inventory:destination",
    Date.now(),
    90_000,
  );
  assert.ok(claimedDestinationLease);
  const destinationLease = claimedDestinationLease;
  const projections = new InventoryProjections(f.store);
  const builds = new InventoryComparisonBuilds(f.store);
  async function fullReceipt(
    records: InventoryObservation[],
    range: [string, string] = options.range ?? ["2026-11-08", "2026-11-08"],
    selectionOptions: {
      stationCallsign?: string;
      workedCallsign?: string;
      replaceHeld?: boolean;
    } = {},
  ) {
    const { replaceHeld, ...filters } = selectionOptions;
    const stream = await f.inventory.snapshot("a", "destination", "receipt");
    assert.ok(stream);
    const plan: InventoryScanPlan =
      provider === "qrz"
        ? {
            provider,
            book: {
              bookId: "destination",
              stationCallsign: "N1RWJ",
              startDate: "1930-01-01",
              endDate: "2099-12-31",
            },
            between: range,
          }
        : {
            provider,
            selection: { startDate: range[0], endDate: range[1], ...filters },
          };
    const definition = await planInventoryRun(stream, plan);
    await f.runs.begin({
      stream,
      lease: destinationLease,
      definition,
      replaceHeld,
    });
    for (let pass = 0; pass < 10; pass++) {
      const context = await f.runs.context("a", definition.id);
      if (
        context.run.phase === "collecting" ||
        context.run.phase === "catchup"
      ) {
        await f.inventory.publish(
          await f.runs.preparePage(context, destinationLease, {
            observations: context.run.phase === "collecting" ? records : [],
            requestStartedAt: Date.now(),
            requestBinding:
              context.run.phase === "collecting"
                ? definition.collectionBinding
                : (definition.catchupBinding ?? definition.collectionBinding),
            nextResume: {},
            observedComplete: true,
            completedStreams: ["selection"],
            proposedCheckpoint: { done: true },
            nextDueAt: Date.now(),
          }),
        );
      } else if (context.run.phase === "quarantining")
        await f.inventory.publish(
          await f.runs.prepareQuarantine(context, destinationLease, {
            limit: 200,
          }),
        );
      else if (context.run.phase === "publishing") {
        await f.inventory.publish(
          await f.runs.prepareComplete(context, destinationLease),
        );
        return;
      } else
        throw new Error(
          `unexpected matching fixture phase ${context.run.phase}`,
        );
    }
    throw new Error("matching fixture run limit");
  }
  async function project(scope: string) {
    for (let pass = 0; pass < 1000; pass++) {
      const result = await builds.step("a", f.generation, scope);
      assert.ok(!("deferred" in result));
      if (result.complete) break;
      assert.ok(pass < 999, "matching fixture build limit");
    }
    const rows = (
      await f.db
        .prepare(
          "SELECT record_key FROM comparison_index WHERE tenant='a' AND generation_id=? AND scope_id=? AND state!='retired' ORDER BY record_key",
        )
        .bind(f.generation, scope)
        .all<{ record_key: string }>()
    ).results;
    for (let offset = 0; offset < rows.length; offset += 20) {
      const result = await projections.project(
        "a",
        f.generation,
        scope,
        rows.slice(offset, offset + 20).map((row) => row.record_key),
      );
      assert.ok("records" in result);
    }
  }
  const sources = options.sources ?? [sourceContact("q0")];
  await f.full([observation("op", "operation"), ...sources]);
  await fullReceipt(options.receipts ?? [receipt()]);
  await project("source");
  await project("destination");
  await builds.activate("a", f.generation);
  return {
    ...f,
    sources,
    destinationStream,
    destinationLease,
    fullReceipt,
    project,
    projections,
    workspace: new InventoryMatchingWorkspace(f.store),
  };
}
