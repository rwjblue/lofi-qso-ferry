import { InventoryIngestion } from "./inventory-ingestion.ts";
import {
  type InventoryScanPlan,
  inventoryRunQuery,
  planInventoryRun,
} from "./inventory-run-plans.ts";
import { InventoryRuns } from "./inventory-runs.ts";
import {
  bindInventoryScopeRuntime,
  type InventoryRuntime,
} from "./inventory-runtime.ts";
import { splitLotwQuery } from "./lotw.ts";
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
        ? {
            provider: plan.provider,
            book: plan.book,
            between: plan.between,
            ...(plan.repeatSelectionCatchup && {
              repeatSelectionCatchup: true,
            }),
          }
        : "kind" in plan.selection
          ? {
              provider: plan.provider,
              selection: { kind: plan.selection.kind },
            }
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
        : "kind" in plan.selection
          ? 7_200_000
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

/** Enroll bounded unfiltered LoTW months discovered by managed source scans. */
export async function registerSourceCalendarSelections(
  store: Store,
  runtime: InventoryRuntime,
  limit = 16,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32)
    throw new Error("invalid_inventory_schedule_limit");
  const progress = await store
    .statement(
      "SELECT last_tenant,last_connection,last_month FROM inventory_calendar_registration_progress WHERE id=1",
    )
    .first<{
      last_tenant: string;
      last_connection: string;
      last_month: string;
    }>();
  if (!progress) throw new Error("inventory_calendar_registration_unavailable");
  // The exact canonical plan is the durable acknowledgement. A filtered or
  // partial read of the same month does not satisfy this unfiltered selection.
  const candidates = (
    await store
      .statement(
        `WITH months AS (
          SELECT c.*,m.month_start,coalesce(date(m.month_start,'+1 month','-1 day'),'9999-12-31') AS month_end
          FROM connections c JOIN accounts a ON a.id=c.tenant
          JOIN private_data credential ON credential.tenant=c.tenant AND credential.connection=c.id AND credential.id=c.credential_version AND credential.kind='credential'
          JOIN inventory_source_calendar_months m ON m.tenant=c.tenant
          JOIN inventory_scopes source ON source.tenant=m.tenant AND source.scope_id=m.scope_id
          JOIN connections lofi ON lofi.tenant=source.tenant AND lofi.id=source.connection_id
          WHERE (c.tenant,c.id,m.month_start)>(?,?,?) AND a.status='active'
            AND c.kind='lotw' AND c.status='active'
            AND credential.revoked_at IS NULL AND (credential.expires_at IS NULL OR credential.expires_at>unixepoch('subsec')*1000)
            AND json_extract(c.config,'$.readAccess')=1
            AND source.provider='lofi' AND source.state='observing' AND source.runtime_version=?
            AND lofi.kind='lofi' AND lofi.status='active' AND lofi.remote_identity=source.logical_identity
        )
        SELECT months.* FROM months WHERE NOT EXISTS(
          SELECT 1 FROM inventory_scopes target
          JOIN inventory_scheduled_selections p ON p.tenant=target.tenant AND p.scope_id=target.scope_id
          WHERE target.tenant=months.tenant AND target.provider='lotw' AND target.logical_identity=months.remote_identity
            AND target.connection_id=months.id AND target.state='observing'
            AND target.runtime_version=? AND p.runtime_version=target.runtime_version AND p.config_version=target.config_version
            AND json_extract(p.plan,'$.provider')='lotw'
            AND p.plan=json_object('provider','lotw','selection',json_object('endDate',months.month_end,'startDate',months.month_start))
        )
        GROUP BY tenant,id,month_start ORDER BY tenant,id,month_start LIMIT ?`,
        progress.last_tenant,
        progress.last_connection,
        progress.last_month,
        runtime.version,
        runtime.version,
        limit,
      )
      .all<Connection & { month_start: string; month_end: string }>()
  ).results;
  const report = { registered: 0, failed: 0 };
  for (const { month_start, month_end, ...connection } of candidates) {
    try {
      await registerInventorySelection(store, runtime, connection, {
        provider: "lotw",
        selection: { startDate: month_start, endDate: month_end },
      });
      report.registered++;
    } catch {
      report.failed++;
    }
  }
  const last = candidates.length === limit ? candidates.at(-1) : undefined;
  await store
    .statement(
      "UPDATE inventory_calendar_registration_progress SET last_tenant=?,last_connection=?,last_month=? WHERE id=1 AND (last_tenant,last_connection,last_month)=(?,?,?)",
      last?.tenant ?? "",
      last?.id ?? "",
      last?.month_start ?? "",
      progress.last_tenant,
      progress.last_connection,
      progress.last_month,
    )
    .run();
  return report;
}

/** Recover committed overflow holds without retrying their parent reports. */
export async function registerOverflowSelections(
  store: Store,
  runtime: InventoryRuntime,
  limit = 8,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16)
    throw new Error("invalid_inventory_schedule_limit");
  const rows = (
    await store
      .statement(
        `SELECT c.*,r.run_id,r.fixed_query,r.scope_id,r.stream_id,r.config_version,j.work_version,
                 p.poll_period_ms,p.verification_period_ms
         FROM inventory_stream_jobs j
         JOIN inventory_scopes s ON s.tenant=j.tenant AND s.scope_id=j.scope_id
         JOIN inventory_runs r ON r.tenant=j.tenant AND r.run_id=j.active_run_id
         JOIN inventory_scheduled_selections p ON p.tenant=j.tenant AND p.scope_id=j.scope_id AND p.stream_id=j.stream_id
         JOIN connections c ON c.tenant=s.tenant AND c.id=s.connection_id
         JOIN accounts a ON a.id=c.tenant
         JOIN private_data credential ON credential.tenant=c.tenant AND credential.connection=c.id AND credential.id=c.credential_version AND credential.kind='credential'
         WHERE j.state='held' AND j.reason='overflow' AND r.phase='held' AND r.reason='overflow'
           AND s.provider='lotw' AND s.state='observing' AND s.runtime_version=? AND p.runtime_version=s.runtime_version
           AND r.config_version=s.config_version AND p.config_version=s.config_version
           AND c.kind='lotw' AND c.status='active' AND c.remote_identity=s.logical_identity AND a.status='active'
           AND credential.revoked_at IS NULL AND (credential.expires_at IS NULL OR credential.expires_at>unixepoch('subsec')*1000)
           AND json_extract(c.config,'$.readAccess')=1
           AND json_extract(r.fixed_query,'$.query.startDate')<json_extract(r.fixed_query,'$.query.endDate')
         ORDER BY j.tenant,j.scope_id,j.stream_id LIMIT ?`,
        runtime.version,
        limit,
      )
      .all<
        Connection & {
          run_id: string;
          fixed_query: string;
          scope_id: string;
          stream_id: string;
          config_version: number;
          work_version: number;
          poll_period_ms: number;
          verification_period_ms: number;
        }
      >()
  ).results;
  const report = { split: 0, failed: 0 };
  for (const row of rows) {
    try {
      const query = inventoryRunQuery(JSON.parse(row.fixed_query));
      if (query.provider !== "lotw" || "kind" in query.query)
        throw new Error("invalid_lotw_split");
      const { receivedSince: _lower, ...selection } = query.query;
      const children = splitLotwQuery(selection);
      if (!children) throw new Error("invalid_lotw_split");
      const policy = {
        pollPeriodMs: row.poll_period_ms,
        verificationPeriodMs: row.verification_period_ms,
      };
      const left = await registerInventorySelection(
        store,
        runtime,
        row,
        { provider: "lotw", selection: children[0] },
        policy,
      );
      const right = await registerInventorySelection(
        store,
        runtime,
        row,
        { provider: "lotw", selection: children[1] },
        policy,
      );
      if (left.scope !== row.scope_id || right.scope !== row.scope_id)
        throw new Error("invalid_lotw_split");
      // A crash between registrations leaves the parent eligible. A competing
      // cron or a scope change cannot acknowledge it with stale children.
      const finished = await store
        .statement(
          `UPDATE inventory_stream_jobs AS j SET work_version=work_version+1,reason='overflow_split'
           WHERE (j.tenant,j.scope_id,j.stream_id,j.active_run_id,j.work_version)=(?,?,?,?,?)
             AND j.state='held' AND j.reason='overflow'
             AND EXISTS(SELECT 1 FROM inventory_scopes s
               JOIN inventory_runtime v ON v.mode='inventory_read_only' AND v.version=s.runtime_version
               JOIN inventory_scheduled_selections l ON l.tenant=s.tenant AND l.scope_id=s.scope_id AND l.stream_id=? AND l.config_version=s.config_version AND l.runtime_version=s.runtime_version
               JOIN inventory_scheduled_selections r ON r.tenant=s.tenant AND r.scope_id=s.scope_id AND r.stream_id=? AND r.config_version=s.config_version AND r.runtime_version=s.runtime_version
               WHERE s.tenant=j.tenant AND s.scope_id=j.scope_id AND s.state='observing' AND s.config_version=?)`,
          row.tenant,
          row.scope_id,
          row.stream_id,
          row.run_id,
          row.work_version,
          left.stream,
          right.stream,
          row.config_version,
        )
        .run();
      report.split += finished.meta.changes;
    } catch {
      report.failed++;
    }
  }
  return report;
}

/** Recover ordinary dated polling when a registered account feed goes stale. */
export async function restoreLotwDatedPolls(store: Store, tenant?: string) {
  const restored = await store
    .statement(
      `WITH due AS MATERIALIZED (
        SELECT * FROM inventory_lotw_dated_fallback_due
        WHERE (?1 IS NULL OR tenant=?1)
        ORDER BY due_at,tenant,scope_id,stream_id LIMIT 16
       )
       INSERT INTO inventory_wakeups(tenant,wakeup_id,scope_id,stream_id,run_id,work_version,not_before)
       SELECT tenant,'lotw-dated-fallback:'||run_id||':'||(work_version+1),scope_id,stream_id,run_id,work_version+1,due_at
       FROM due RETURNING 1 AS restored`,
      tenant ?? null,
    )
    .all<{ restored: number }>();
  return restored.results.length;
}

/** Start initial/reconfigured selections; normal recurrence belongs to the runner. */
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
