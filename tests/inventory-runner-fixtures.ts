import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { AdifRecord } from "../src/adif.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import {
  type InventoryScanPlan,
  planInventoryRun,
} from "../src/inventory-run-plans.ts";
import type {
  InventoryRunner,
  InventoryRunWakeup,
} from "../src/inventory-runner.ts";
import { InventoryRuns } from "../src/inventory-runs.ts";
import type { LoFiCredentials } from "../src/lofi.ts";
import { applyMigration, database, seed } from "./helpers.ts";

export const book = {
  bookId: "7",
  stationCallsign: "N1RWJ",
  startDate: "2026-01-01",
  endDate: "2026-12-31",
};
const credentials: LoFiCredentials = {
  key: "browser:runner",
  secret: "synthetic-secret",
  token: "synthetic-token",
};
export const contact: AdifRecord = {
  APP_QRZLOG_LOGID: "1",
  STATION_CALLSIGN: "N1RWJ",
  CALL: "W1AW",
  QSO_DATE: "20261107",
  TIME_ON: "130500",
  BAND: "20m",
  MODE: "CW",
  QSL_RCVD: "N",
};

export async function inventoryRunnerFixture(
  t: TestContext,
  provider: "lofi" | "qrz" | "lotw" = "lofi",
) {
  const f = await database();
  t.after(() => f.mf.dispose());
  await seed(f.store);
  for (const name of [
    "0009_vendor_requests.sql",
    "0039_inventory_ingestion.sql",
    "0040_inventory_runs.sql",
    "0041_inventory_vendor_admission.sql",
  ])
    await applyMigration(f.db, name);
  const connection = provider === "lofi" ? "source" : "destination";
  const config =
    provider === "lofi"
      ? { accountId: "source" }
      : provider === "qrz"
        ? book
        : { readAccess: true };
  await f.store
    .statement(
      "UPDATE connections SET kind=?,config=? WHERE tenant='a' AND id=?",
      provider,
      JSON.stringify(config),
      connection,
    )
    .run();
  await f.store
    .statement(
      "DELETE FROM private_data WHERE tenant='a' AND connection=?",
      connection,
    )
    .run();
  const credential =
    provider === "lofi"
      ? credentials
      : provider === "qrz"
        ? { apiKey: "synthetic-key" }
        : {
            query: {
              username: "synthetic-user",
              password: "synthetic-password",
            },
          };
  await (
    await f.store.putPrivate("a", connection, "v1", "credential", credential)
  ).run();
  const inventory = new InventoryIngestion(f.store);
  const runs = new InventoryRuns(inventory);
  const scope = `scope-${provider}`;
  await inventory.initialize(
    {
      tenant: "a",
      scope,
      connection,
      provider,
      logicalIdentity: connection,
      adapterBinding: "inventory-reader-v1",
      ordering: provider === "lofi" ? "numeric" : "serialized",
    },
    "scan",
    "selection-v1",
  );
  const plan: InventoryScanPlan =
    provider === "lofi"
      ? { provider, pageSize: 1000 }
      : provider === "qrz"
        ? { provider, book, between: ["2026-11-01", "2026-11-14"], pageSize: 2 }
        : {
            provider,
            selection: {
              startDate: "2026-11-01",
              endDate: "2026-11-14",
              stationCallsign: "N1RWJ",
            },
          };
  async function begin(mode: "full" | "delta" = "full") {
    const stream = await inventory.snapshot("a", scope, "scan");
    assert.ok(stream);
    const lease = await f.store.claim(
      "a",
      `inventory:${scope}`,
      Date.now(),
      90_000,
    );
    assert.ok(lease);
    try {
      return await runs.begin({
        stream,
        lease,
        definition: await planInventoryRun(stream, plan, { mode }),
      });
    } finally {
      await f.store.release(lease);
    }
  }
  async function wakeup(runId: string): Promise<InventoryRunWakeup> {
    const run = await runs.load("a", runId);
    assert.ok(run);
    return {
      version: 1,
      tenant: "a",
      scope,
      stream: "scan",
      run: runId,
      workVersion: run.jobVersion,
    };
  }
  async function due(runId: string) {
    // Simulate delayed delivery without sleeping. Production never clears pacers.
    await f.store
      .statement(
        "UPDATE inventory_stream_jobs SET work_version=work_version+1,next_due_at=? WHERE tenant='a' AND scope_id=?",
        Date.now() - 1,
        scope,
      )
      .run();
    await f.store
      .statement(
        "INSERT INTO inventory_wakeups(tenant,wakeup_id,scope_id,stream_id,run_id,work_version,not_before) SELECT tenant,?,scope_id,stream_id,?,work_version,next_due_at FROM inventory_stream_jobs WHERE tenant='a' AND scope_id=?",
        crypto.randomUUID(),
        runId,
        scope,
      )
      .run();
    const hints = (
      await f.db
        .prepare(
          "SELECT tenant,source,loop_delay_ms,check_period_ms,hints_observed_at FROM inventory_read_pacing",
        )
        .all<{
          tenant: string;
          source: string;
          loop_delay_ms: number | null;
          check_period_ms: number | null;
          hints_observed_at: number | null;
        }>()
    ).results;
    await f.store.statement("DELETE FROM inventory_read_pacing").run();
    for (const hint of hints)
      await f.store
        .statement(
          "INSERT INTO inventory_read_pacing(vendor,tenant,source,last_requested_at,next_allowed_at,loop_delay_ms,check_period_ms,hints_observed_at) VALUES('lofi',?,?,0,0,?,?,?)",
          hint.tenant,
          hint.source,
          hint.loop_delay_ms,
          hint.check_period_ms,
          hint.hints_observed_at,
        )
        .run();
    return wakeup(runId);
  }
  async function finish(runner: InventoryRunner, runId: string) {
    for (let i = 0; i < 10; i++) {
      const result = await runner.step(await due(runId));
      if (result.kind === "complete") return result;
      assert.equal(result.kind, "advanced");
    }
    assert.fail("bounded fixture did not finish");
  }
  return { ...f, inventory, runs, scope, plan, begin, wakeup, due, finish };
}
