import { InventoryIngestion } from "./inventory-ingestion.ts";
import {
  type InventoryScanPlan,
  planInventoryRun,
} from "./inventory-run-plans.ts";
import { InventoryRuns } from "./inventory-runs.ts";
import {
  bindInventoryScopeRuntime,
  type InventoryRuntime,
} from "./inventory-runtime.ts";
import { canonical, sha256 } from "./security.ts";
import type { Connection, Store } from "./store.ts";

const DAY = 86_400_000;
export interface InventorySchedulePolicy {
  pollPeriodMs?: number;
  verificationPeriodMs?: number;
}

/** Register a static selection; a different selection always gets a new stream. */
export async function registerInventorySelection(
  store: Store,
  runtime: InventoryRuntime,
  connection: Connection,
  plan: InventoryScanPlan,
  policy: InventorySchedulePolicy = {},
) {
  connection = structuredClone(connection);
  plan = structuredClone(plan);
  if (
    runtime.mode !== "inventory_read_only" ||
    connection.kind !== plan.provider ||
    connection.status !== "active"
  )
    throw new Error("inventory_schedule_unavailable");
  const scope = await sha256(
    canonical([
      "inventory-scope-v1",
      connection.tenant,
      connection.kind,
      connection.remote_identity,
    ]),
  );
  const selection =
    plan.provider === "lofi"
      ? { provider: plan.provider }
      : plan.provider === "qrz"
        ? { provider: plan.provider, book: plan.book, between: plan.between }
        : plan;
  const queryBinding = await sha256(
    canonical(["inventory-selection-v1", selection]),
  );
  const streamId = queryBinding;
  const inventory = new InventoryIngestion(store);
  await inventory.initialize(
    {
      tenant: connection.tenant,
      scope,
      connection: connection.id,
      provider: connection.kind,
      logicalIdentity: connection.remote_identity,
      adapterBinding: "inventory-adapters-v1",
      ordering: connection.kind === "lofi" ? "numeric" : "serialized",
    },
    streamId,
    queryBinding,
  );
  await bindInventoryScopeRuntime(
    store,
    connection.tenant,
    scope,
    runtime.version,
  );
  const runs = new InventoryRuns(inventory);
  // Query/client changes retain the logical account but require a new full run.
  await runs.resumeHeldScope(
    connection.tenant,
    scope,
    connection.remote_identity,
  );
  const stream = await inventory.snapshot(connection.tenant, scope, streamId);
  if (!stream) throw new Error("inventory_stream_unavailable");
  await planInventoryRun(stream, plan); // Validate finite bounds before scheduling.
  const pollPeriodMs =
    policy.pollPeriodMs ??
    (plan.provider === "lofi"
      ? 300_000
      : plan.provider === "qrz"
        ? 900_000
        : Date.parse(plan.selection.endDate) >= Date.now() - 32 * DAY
          ? 900_000
          : DAY);
  const verificationPeriodMs =
    policy.verificationPeriodMs ??
    (plan.provider === "qrz" ? 30 * DAY : 7 * DAY);
  if (
    !Number.isSafeInteger(pollPeriodMs) ||
    pollPeriodMs < 300_000 ||
    pollPeriodMs > 7 * DAY ||
    !Number.isSafeInteger(verificationPeriodMs) ||
    verificationPeriodMs < DAY ||
    verificationPeriodMs > 90 * DAY
  )
    throw new Error("invalid_inventory_schedule_policy");
  await store
    .statement(
      `INSERT INTO inventory_scheduled_selections(tenant,scope_id,stream_id,runtime_version,config_version,plan,created_at,poll_period_ms,verification_period_ms) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant,scope_id,stream_id) DO UPDATE SET version=inventory_scheduled_selections.version+1,config_version=excluded.config_version,poll_period_ms=excluded.poll_period_ms,verification_period_ms=excluded.verification_period_ms WHERE inventory_scheduled_selections.plan=excluded.plan AND (inventory_scheduled_selections.config_version!=excluded.config_version OR inventory_scheduled_selections.poll_period_ms!=excluded.poll_period_ms OR inventory_scheduled_selections.verification_period_ms!=excluded.verification_period_ms)`,
      connection.tenant,
      scope,
      streamId,
      runtime.version,
      stream.configVersion,
      canonical(plan),
      Date.now(),
      pollPeriodMs,
      verificationPeriodMs,
    )
    .run();
  const saved = await store
    .statement(
      "SELECT plan,config_version FROM inventory_scheduled_selections WHERE tenant=? AND scope_id=? AND stream_id=?",
      connection.tenant,
      scope,
      streamId,
    )
    .first<{ plan: string; config_version: number }>();
  if (
    saved?.plan !== canonical(plan) ||
    saved.config_version !== stream.configVersion
  )
    throw new Error("inventory_schedule_binding_changed");
  return { tenant: connection.tenant, scope, stream: streamId };
}

/** Produce disjoint inclusive date selections without reading any service. */
export function lotwInventorySelections(selection: {
  startDate: string;
  endDate: string;
  stationCallsign?: string;
  workedCallsign?: string;
}): InventoryScanPlan[] {
  const start = Date.parse(`${selection.startDate}T00:00:00Z`);
  const end = Date.parse(`${selection.endDate}T00:00:00Z`);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start > end ||
    new Date(start).toISOString().slice(0, 10) !== selection.startDate ||
    new Date(end).toISOString().slice(0, 10) !== selection.endDate ||
    end - start > 100 * 366 * DAY
  )
    throw new Error("invalid_inventory_date_range");
  const plans: InventoryScanPlan[] = [];
  for (let at = start; at <= end; at += 32 * DAY)
    plans.push({
      provider: "lotw",
      selection: {
        ...selection,
        startDate: new Date(at).toISOString().slice(0, 10),
        endDate: new Date(Math.min(end, at + 31 * DAY))
          .toISOString()
          .slice(0, 10),
      },
    });
  return plans;
}

/** Known account/book bounds can bootstrap independently from source matching. */
export async function registerKnownInventoryConnections(
  store: Store,
  runtime: InventoryRuntime,
  limit = 16,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32)
    throw new Error("invalid_inventory_schedule_limit");
  const progress = await store
    .statement(
      "SELECT last_tenant,last_connection FROM inventory_registration_progress WHERE id=1",
    )
    .first<{ last_tenant: string; last_connection: string }>();
  if (!progress) throw new Error("inventory_registration_unavailable");
  const connections = (
    await store
      .statement(
        `SELECT c.* FROM connections c JOIN accounts a ON a.id=c.tenant WHERE (c.tenant,c.id)>(?,?) AND c.status='active' AND a.status='active' AND c.kind IN('lofi','qrz') AND json_valid(c.config) AND (c.kind='qrz' OR json_extract(c.config,'$.accountId')=c.remote_identity) AND NOT EXISTS(SELECT 1 FROM inventory_scopes s JOIN inventory_scheduled_selections p ON p.tenant=s.tenant AND p.scope_id=s.scope_id WHERE s.tenant=c.tenant AND s.connection_id=c.id AND s.logical_identity=c.remote_identity AND s.runtime_version=? AND s.state='observing' AND p.config_version=s.config_version) ORDER BY c.tenant,c.id LIMIT ?`,
        progress.last_tenant,
        progress.last_connection,
        runtime.version,
        limit,
      )
      .all<Connection>()
  ).results;
  const report = { registered: 0, failed: 0 };
  for (const connection of connections) {
    try {
      const config = JSON.parse(connection.config) as Record<string, unknown>;
      const plan: InventoryScanPlan =
        connection.kind === "lofi"
          ? { provider: "lofi", pageSize: 1000 }
          : {
              provider: "qrz",
              book: {
                bookId: String(config.bookId ?? ""),
                stationCallsign: String(config.stationCallsign ?? ""),
                startDate: String(config.startDate ?? ""),
                endDate: String(config.endDate ?? ""),
              },
              between: [
                String(config.startDate ?? ""),
                String(config.endDate ?? ""),
              ],
              pageSize: 250,
            };
      await registerInventorySelection(store, runtime, connection, plan);
      report.registered++;
    } catch {
      report.failed++;
    }
  }
  const last = connections.at(-1);
  await store
    .statement(
      "UPDATE inventory_registration_progress SET last_tenant=?,last_connection=? WHERE id=1",
      last?.tenant ?? "",
      last?.id ?? "",
    )
    .run();
  return report;
}

/** Start initial/reconfigured full runs; normal recurrence belongs to the runner. */
export async function startInventorySelections(store: Store, limit = 16) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32)
    throw new Error("invalid_inventory_schedule_limit");
  const rows = (
    await store
      .statement(
        `SELECT p.*,j.work_version,j.state AS job_state FROM inventory_scheduled_selections p JOIN inventory_scopes s ON s.tenant=p.tenant AND s.scope_id=p.scope_id JOIN inventory_runtime runtime ON runtime.mode='inventory_read_only' AND runtime.version=p.runtime_version LEFT JOIN inventory_stream_jobs j ON j.tenant=p.tenant AND j.scope_id=p.scope_id AND j.stream_id=p.stream_id WHERE s.state='observing' AND s.config_version=p.config_version AND (j.tenant IS NULL OR j.state='held' AND j.reason='scope_changed') ORDER BY p.created_at,p.tenant,p.scope_id,p.stream_id LIMIT ?`,
        limit,
      )
      .all<{
        tenant: string;
        scope_id: string;
        stream_id: string;
        version: number;
        config_version: number;
        plan: string;
        created_at: number;
        work_version: number | null;
        job_state: string | null;
      }>()
  ).results;
  const runs = new InventoryRuns(new InventoryIngestion(store));
  const report = { started: 0, deferred: 0, failed: 0 };
  for (const row of rows) {
    const lease = await store.claim(
      row.tenant,
      `inventory:${row.scope_id}`,
      Date.now(),
      90_000,
    );
    if (!lease) {
      report.deferred++;
      continue;
    }
    try {
      const stream = await runs.inventory.snapshot(
        row.tenant,
        row.scope_id,
        row.stream_id,
      );
      if (!stream) throw new Error("inventory_stream_unavailable");
      const definition = await planInventoryRun(
        stream,
        JSON.parse(row.plan) as InventoryScanPlan,
        {
          id: await sha256(
            canonical([
              "inventory-scheduled-full-v1",
              row.tenant,
              row.scope_id,
              row.stream_id,
              row.version,
              row.config_version,
            ]),
          ),
          now: Date.now(),
        },
      );
      await runs.begin({
        stream,
        lease,
        definition,
        expectedJobVersion: row.work_version ?? 0,
        replaceHeld: row.job_state === "held",
      });
      report.started++;
    } catch {
      report.failed++;
    } finally {
      await store.release(lease);
    }
  }
  return report;
}
