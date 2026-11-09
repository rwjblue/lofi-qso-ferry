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
const LOTW_ACCOUNT_INITIAL_LOOKBACK_MS = 3_600_000;
export interface InventorySchedulePolicy {
  pollPeriodMs?: number;
  verificationPeriodMs?: number;
}

function managedScopeId(connection: Connection) {
  return sha256(
    canonical([
      "inventory-scope-v1",
      connection.tenant,
      connection.kind,
      connection.remote_identity,
    ]),
  );
}

async function openManagedInventoryScope(
  store: Store,
  runtime: InventoryRuntime,
  connection: Connection,
  scope: string,
  stream: string,
  binding: string,
) {
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
    stream,
    binding,
  );
  await bindInventoryScopeRuntime(
    store,
    connection.tenant,
    scope,
    runtime.version,
  );
  await new InventoryRuns(inventory).resumeHeldScope(
    connection.tenant,
    scope,
    connection.remote_identity,
  );
  return inventory;
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
  const scope = await managedScopeId(connection);
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
  // Query/client changes retain the logical account but require a new full run.
  const inventory = await openManagedInventoryScope(
    store,
    runtime,
    connection,
    scope,
    streamId,
    queryBinding,
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

/** Forward destinations need an index scope, but get no history scan stream. */
async function registerForwardInventoryDestinations(
  store: Store,
  runtime: InventoryRuntime,
  limit: number,
) {
  const cursor = await store
    .statement(
      "SELECT last_tenant,last_connection FROM inventory_forward_registration_progress WHERE id=1",
    )
    .first<{ last_tenant: string; last_connection: string }>();
  if (!cursor) throw new Error("inventory_forward_registration_unavailable");
  const { results } = await store
    .statement(
      `SELECT c.* FROM inventory_sync_scopes p
     JOIN connections c ON (c.tenant,c.id)=(p.tenant,p.destination)
     JOIN accounts a ON a.id=c.tenant AND a.status='active'
     JOIN private_data k ON (k.tenant,k.connection,k.id,k.kind)=(c.tenant,c.id,c.credential_version,'credential')
     WHERE (c.tenant,c.id)>(?,?) AND c.kind IN('qrz','lotw') AND c.status='active'
       AND p.mode='forward' AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>unixepoch('subsec')*1000)
       AND (c.kind='qrz' OR json_extract(c.config,'$.readAccess')=1)
       AND NOT EXISTS(SELECT 1 FROM inventory_scopes s WHERE
         (s.tenant,s.connection_id,s.provider,s.logical_identity)=(c.tenant,c.id,c.kind,c.remote_identity)
         AND s.runtime_version=? AND s.state='observing')
     ORDER BY c.tenant,c.id LIMIT ?`,
      cursor.last_tenant,
      cursor.last_connection,
      runtime.version,
      limit,
    )
    .all<Connection>();
  const report = { registered: 0, failed: 0 };
  for (const connection of results) {
    try {
      await openManagedInventoryScope(
        store,
        runtime,
        connection,
        await managedScopeId(connection),
        "forward-target",
        "forward-target-v1",
      );
      report.registered++;
    } catch {
      report.failed++;
    }
  }
  const last = results.length === limit ? results.at(-1) : undefined;
  await store
    .statement(
      "UPDATE inventory_forward_registration_progress SET last_tenant=?,last_connection=? WHERE id=1 AND (last_tenant,last_connection)=(?,?)",
      last?.tenant ?? "",
      last?.id ?? "",
      cursor.last_tenant,
      cursor.last_connection,
    )
    .run();
  return report;
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

/** Source enrollment runs before any destination windows are known. */
export async function registerInventorySources(
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
        `SELECT c.* FROM connections c JOIN accounts a ON a.id=c.tenant WHERE (c.tenant,c.id)>(?,?) AND c.status='active' AND a.status='active' AND c.kind='lofi' AND json_valid(c.config) AND json_extract(c.config,'$.accountId')=c.remote_identity AND NOT EXISTS(SELECT 1 FROM inventory_scopes s JOIN inventory_scheduled_selections p ON p.tenant=s.tenant AND p.scope_id=s.scope_id WHERE s.tenant=c.tenant AND s.connection_id=c.id AND s.logical_identity=c.remote_identity AND s.runtime_version=? AND s.state='observing' AND p.config_version=s.config_version) ORDER BY c.tenant,c.id LIMIT ?`,
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
      await registerInventorySelection(store, runtime, connection, {
        provider: "lofi",
        pageSize: 1000,
      });
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

/** Enroll bounded receipt windows discovered by managed source scans. */
export async function registerSourceCalendarSelections(
  store: Store,
  runtime: InventoryRuntime,
  limit = 16,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32)
    throw new Error("invalid_inventory_schedule_limit");
  const report = await registerForwardInventoryDestinations(
    store,
    runtime,
    Math.ceil(limit / 2),
  );
  const remaining = limit - report.registered - report.failed;
  if (!remaining) return report;
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
  const candidates = (
    await store
      .statement(
        `WITH months AS (
          SELECT c.*,m.month_start,coalesce(date(m.month_start,'+1 month','-1 day'),'9999-12-31') AS month_end,
            json_extract(c.config,'$.startDate') AS book_start,json_extract(c.config,'$.endDate') AS book_end,
            coalesce(date(policy.since,'-1 day'),m.month_start) AS scope_floor
          FROM connections c JOIN accounts a ON a.id=c.tenant
          JOIN private_data credential ON credential.tenant=c.tenant AND credential.connection=c.id AND credential.id=c.credential_version AND credential.kind='credential'
          LEFT JOIN inventory_sync_scopes policy ON (policy.tenant,policy.destination)=(c.tenant,c.id)
          JOIN inventory_source_calendar_months m ON m.tenant=c.tenant
          JOIN inventory_scopes source ON source.tenant=m.tenant AND source.scope_id=m.scope_id
          JOIN connections lofi ON lofi.tenant=source.tenant AND lofi.id=source.connection_id
          WHERE (c.tenant,c.id,m.month_start)>(?,?,?) AND a.status='active'
            AND c.kind IN('qrz','lotw') AND c.status='active' AND json_valid(c.config)
            AND coalesce(policy.mode,'all')!='forward'
            AND credential.revoked_at IS NULL AND (credential.expires_at IS NULL OR credential.expires_at>unixepoch('subsec')*1000)
            AND (c.kind='qrz' OR json_extract(c.config,'$.readAccess')=1)
            AND source.provider='lofi' AND source.state='observing' AND source.runtime_version=?
            AND lofi.kind='lofi' AND lofi.status='active' AND lofi.remote_identity=source.logical_identity
          GROUP BY c.tenant,c.id,m.month_start
        ), windows AS (
          SELECT months.*,CASE kind WHEN 'qrz' THEN max(month_start,book_start,scope_floor)
            ELSE max(month_start,scope_floor) END AS first_date,
            CASE kind WHEN 'qrz' THEN min(month_end,book_end) ELSE month_end END AS last_date
          FROM months WHERE kind='lotw' OR (book_start=date(book_start) AND book_end=date(book_end) AND book_start<=month_end AND book_end>=month_start)
        ), scheduled AS MATERIALIZED (
          SELECT p.tenant,target.connection_id AS id,p.from_date,p.through_date
          FROM inventory_scoped_schedule p JOIN inventory_scopes target USING(tenant,scope_id)
          WHERE target.state='observing' AND target.runtime_version=?
            AND p.from_date IS NOT NULL AND p.through_date IS NOT NULL
            AND (target.provider='qrz' OR (target.provider='lotw'
              AND json_type(p.plan,'$.selection.stationCallsign') IS NULL
              AND json_type(p.plan,'$.selection.workedCallsign') IS NULL))
        ), gaps AS MATERIALIZED (
          SELECT w.*,(SELECT min(day) FROM (
            SELECT w.first_date AS day
            UNION ALL
            SELECT date(p.through_date,'+1 day') FROM scheduled p
            WHERE (p.tenant,p.id)=(w.tenant,w.id) AND p.through_date>=w.first_date AND p.from_date<=w.last_date
          ) possible
          WHERE day BETWEEN w.first_date AND w.last_date AND NOT EXISTS(
            SELECT 1 FROM scheduled p WHERE (p.tenant,p.id)=(w.tenant,w.id) AND day BETWEEN p.from_date AND p.through_date
          )) AS period_start
          FROM windows w WHERE w.first_date<=w.last_date
        )
        SELECT g.*,coalesce((SELECT min(date(p.from_date,'-1 day')) FROM scheduled p
          WHERE (p.tenant,p.id)=(g.tenant,g.id) AND p.from_date>g.period_start AND p.from_date<=g.last_date),g.last_date) AS period_end
        FROM gaps g WHERE g.period_start IS NOT NULL
        ORDER BY tenant,id,month_start LIMIT ?`,
        progress.last_tenant,
        progress.last_connection,
        progress.last_month,
        runtime.version,
        runtime.version,
        remaining,
      )
      .all<
        Connection & {
          month_start: string;
          period_start: string;
          period_end: string;
        }
      >()
  ).results;
  for (const { period_start, period_end, ...connection } of candidates) {
    try {
      const book = JSON.parse(connection.config);
      const plan: InventoryScanPlan =
        connection.kind === "qrz"
          ? {
              provider: "qrz",
              book: {
                bookId: book.bookId,
                stationCallsign: book.stationCallsign,
                startDate: book.startDate,
                endDate: book.endDate,
              },
              between: [period_start, period_end],
              pageSize: 250,
            }
          : {
              provider: "lotw",
              selection: { startDate: period_start, endDate: period_end },
            };
      await registerInventorySelection(store, runtime, connection, plan);
      report.registered++;
    } catch {
      report.failed++;
    }
  }
  const last = candidates.length === remaining ? candidates.at(-1) : undefined;
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

/** Add one positive-only receipt feed to each eligible LoTW calendar. */
export async function registerLotwAccountFeeds(
  store: Store,
  runtime: InventoryRuntime,
  limit = 8,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16)
    throw new Error("invalid_inventory_schedule_limit");
  const progress = await store
    .statement(
      "SELECT last_tenant,last_connection FROM inventory_lotw_account_registration_progress WHERE id=1",
    )
    .first<{ last_tenant: string; last_connection: string }>();
  if (!progress)
    throw new Error("inventory_lotw_account_registration_unavailable");
  const candidates = (
    await store
      .statement(
        `SELECT c.*,min(p.created_at) AS calendar_started,
         json_extract(f.plan,'$.selection.initialReceivedSince') AS initial_received_since,
         f.poll_period_ms AS account_poll_period_ms,f.verification_period_ms AS account_verification_period_ms
         FROM connections c JOIN accounts a ON a.id=c.tenant AND a.status='active'
         JOIN private_data k ON (k.tenant,k.connection,k.id,k.kind)=(c.tenant,c.id,c.credential_version,'credential')
         JOIN inventory_scopes s ON (s.tenant,s.connection_id,s.logical_identity,s.provider)=(c.tenant,c.id,c.remote_identity,c.kind)
         JOIN inventory_scheduled_selections p
          ON (p.tenant,p.scope_id,p.config_version,p.runtime_version)=(s.tenant,s.scope_id,s.config_version,s.runtime_version)
         LEFT JOIN inventory_scheduled_selections f ON (f.tenant,f.scope_id)=(s.tenant,s.scope_id)
          AND json_extract(f.plan,'$.provider')='lotw' AND json_extract(f.plan,'$.selection.kind')='account_received'
         WHERE (c.tenant,c.id)>(?1,?2) AND c.kind='lotw' AND c.status='active'
          AND json_extract(c.config,'$.readAccess')=1 AND k.revoked_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM inventory_sync_scopes policy WHERE (policy.tenant,policy.destination)=(c.tenant,c.id) AND policy.mode!='all')
          AND (k.expires_at IS NULL OR k.expires_at>unixepoch('subsec')*1000)
          AND s.state='observing' AND s.runtime_version=?3
          AND json_extract(p.plan,'$.provider')='lotw' AND json_type(p.plan,'$.selection.startDate')='text'
          AND json_type(p.plan,'$.selection.stationCallsign') IS NULL
          AND json_type(p.plan,'$.selection.workedCallsign') IS NULL
          AND (f.stream_id IS NULL OR f.config_version!=s.config_version)
         GROUP BY c.tenant,c.id ORDER BY c.tenant,c.id LIMIT ?4`,
        progress.last_tenant,
        progress.last_connection,
        runtime.version,
        limit,
      )
      .all<
        Connection & {
          calendar_started: number;
          initial_received_since: string | null;
          account_poll_period_ms: number | null;
          account_verification_period_ms: number | null;
        }
      >()
  ).results;
  const report = { registered: 0, failed: 0 };
  const now = Date.now();
  for (const {
    calendar_started,
    initial_received_since,
    account_poll_period_ms,
    account_verification_period_ms,
    ...connection
  } of candidates) {
    try {
      const initial = Math.min(
        now,
        Math.max(calendar_started, now - LOTW_ACCOUNT_INITIAL_LOOKBACK_MS),
      );
      await registerInventorySelection(
        store,
        runtime,
        connection,
        {
          provider: "lotw",
          selection: {
            kind: "account_received",
            initialReceivedSince:
              initial_received_since ??
              new Date(initial).toISOString().slice(0, 19).replace("T", " "),
          },
        },
        {
          pollPeriodMs: account_poll_period_ms ?? undefined,
          verificationPeriodMs: account_verification_period_ms ?? undefined,
        },
      );
      report.registered++;
    } catch {
      report.failed++;
    }
  }
  const last = candidates.length === limit ? candidates.at(-1) : undefined;
  await store
    .statement(
      "UPDATE inventory_lotw_account_registration_progress SET last_tenant=?,last_connection=? WHERE id=1 AND (last_tenant,last_connection)=(?,?)",
      last?.tenant ?? "",
      last?.id ?? "",
      progress.last_tenant,
      progress.last_connection,
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
         JOIN inventory_scoped_schedule p ON p.tenant=j.tenant AND p.scope_id=j.scope_id AND p.stream_id=j.stream_id
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
          AND EXISTS(SELECT 1 FROM inventory_scoped_schedule p WHERE (p.tenant,p.scope_id,p.stream_id)=(inventory_lotw_dated_fallback_due.tenant,inventory_lotw_dated_fallback_due.scope_id,inventory_lotw_dated_fallback_due.stream_id))
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
        `SELECT p.*,j.work_version,j.state AS job_state FROM inventory_scoped_schedule p JOIN inventory_scopes s ON s.tenant=p.tenant AND s.scope_id=p.scope_id JOIN inventory_runtime runtime ON runtime.mode='inventory_read_only' AND runtime.version=p.runtime_version LEFT JOIN inventory_stream_jobs j ON j.tenant=p.tenant AND j.scope_id=p.scope_id AND j.stream_id=p.stream_id WHERE s.state='observing' AND s.config_version=p.config_version AND (j.tenant IS NULL OR j.state='held' AND j.reason='scope_changed') ORDER BY p.created_at,p.tenant,p.scope_id,p.stream_id LIMIT ?`,
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
