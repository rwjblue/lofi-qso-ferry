import type {
  AdminBacklogSample,
  AdminOverview,
  AdminPriority,
  AdminSchedulerRun,
} from "./admin-types.ts";
import { deliveryGates, exportsEffective } from "./service.ts";
import { VENDOR_POLICIES } from "./vendor-requests.ts";

export type { AdminOverview } from "./admin-types.ts";

const day = 86_400_000;
const listLimit = 100;
const sourceFilter =
  "w.kind='qso' AND w.is_event=0 AND w.deleted=0 AND w.state IN('pending','waiting','blocked','expired','missing_from_reread')";
const attemptFilter =
  "s.state IN('prepared','dispatching','uncertain','submitted','reconciliation_required','rejected')";

/** Small indexed snapshot used by the scheduler to show backlog direction. */
export async function sampleAdminBacklog(
  db: D1Database,
  now: number,
): Promise<AdminBacklogSample> {
  const [sources, attempts] = await db.batch<{
    priority: AdminPriority;
    count: number;
  }>([
    db
      .prepare(
        `SELECT w.priority,COUNT(*) AS count FROM source_work w JOIN connections c ON c.tenant=w.tenant AND c.id=w.source WHERE ${sourceFilter} AND w.state IN('pending','waiting') AND w.expires_at>? AND c.status='active' GROUP BY w.priority`,
      )
      .bind(now),
    db
      .prepare(
        `SELECT s.priority,COUNT(*) AS count FROM attempt_state s WHERE ${attemptFilter} AND s.state IN('prepared','uncertain','submitted') AND s.due_at<=? GROUP BY s.priority`,
      )
      .bind(now),
  ]);
  const count = (
    rows: { priority: AdminPriority; count: number }[],
    priority: AdminPriority,
  ) => rows.find((row) => row.priority === priority)?.count ?? 0;
  return {
    sourceLive: count(sources.results, "live"),
    sourceBackground: count(sources.results, "background"),
    attemptsDueLive: count(attempts.results, "live"),
    attemptsDueBackground: count(attempts.results, "background"),
  };
}

interface RunRow {
  id: string;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  status: AdminSchedulerRun["status"];
  rounds: number | null;
  stop_reason: AdminSchedulerRun["stopReason"];
  source_pages: number;
  contact_turns: number;
  attempt_turns: number;
  errors: number;
  deferred: number;
  failure: AdminSchedulerRun["failure"];
  source_live: number | null;
  source_background: number | null;
  attempts_due_live: number | null;
  attempts_due_background: number | null;
}

function runSummary(row: RunRow): AdminSchedulerRun {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    status: row.status,
    rounds: row.rounds,
    stopReason: row.stop_reason,
    sourcePages: row.source_pages,
    contactTurns: row.contact_turns,
    attemptTurns: row.attempt_turns,
    errors: row.errors,
    deferred: row.deferred,
    failure: row.failure,
    backlog:
      row.source_live === null ||
      row.source_background === null ||
      row.attempts_due_live === null ||
      row.attempts_due_background === null
        ? null
        : {
            sourceLive: row.source_live,
            sourceBackground: row.source_background,
            attemptsDueLive: row.attempts_due_live,
            attemptsDueBackground: row.attempts_due_background,
          },
  };
}

function gatesSummary(env: Env): AdminOverview["gates"] {
  const base = {
    exportsEnabled: String(env.EXPORTS_ENABLED) === "true",
    rolloutChecksPassed: String(env.ROLLOUT_CHECKS_PASSED) === "true",
    liveWriteAuthorized:
      String(env.LIVE_WRITE_AUTHORIZATION) === "I_AUTHORIZE_LIVE_VENDOR_WRITES",
    sourceBoundaryVerified: String(env.SOURCE_BOUNDARY_VERIFIED) === "true",
  };
  try {
    const gates = deliveryGates(env);
    const configured =
      gates.allowedQsoIds === null || (gates.allowedQsoIds?.length ?? 0) > 0;
    return {
      ...base,
      rolloutScopeConfigured: configured,
      rolloutScope:
        gates.allowedQsoIds === null ? "all" : configured ? "limited" : "none",
      effective: exportsEffective(gates),
      configurationValid: true,
    };
  } catch {
    return {
      ...base,
      rolloutScopeConfigured: false,
      rolloutScope: "none",
      effective: false,
      configurationValid: false,
    };
  }
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** Global operational metadata. The caller must authorize the administrator. */
export async function getAdminOverview(
  env: Env,
  now = Date.now(),
): Promise<AdminOverview> {
  const db = env.DB;
  // One read-only batch keeps the overview coherent and reduces D1 round trips.
  const results = await db.batch([
    db
      .prepare(
        "SELECT * FROM scheduler_runs WHERE started_at>=? ORDER BY started_at DESC,id LIMIT 36",
      )
      .bind(now - 7 * day),
    db
      .prepare(
        "SELECT MAX(started_at) AS last_started,MAX(CASE WHEN status='completed' THEN finished_at END) AS last_completed,SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running FROM scheduler_runs WHERE started_at>=?",
      )
      .bind(now - 7 * day),
    db
      .prepare(
        "SELECT COUNT(*) AS runs,SUM(status='failed') AS failed,COALESCE(SUM(stop_reason='deadline'),0) AS deadline_runs,COALESCE(SUM(source_pages),0) AS source_pages,COALESCE(SUM(contact_turns),0) AS contact_turns,COALESCE(SUM(attempt_turns),0) AS attempt_turns,COALESCE(SUM(errors),0) AS errors,COALESCE(SUM(deferred),0) AS deferred FROM scheduler_runs WHERE started_at>=?",
      )
      .bind(now - day),
    db
      .prepare(
        `SELECT w.priority,SUM(w.state IN('pending','waiting') AND w.expires_at>?1) AS pending,SUM(w.state='blocked' AND w.expires_at>?1) AS blocked,SUM(w.expires_at<=?1) AS expired,SUM(w.expires_at>?1 AND w.expires_at<=?2) AS expiring24h,MIN(CASE WHEN w.state IN('pending','waiting') AND w.expires_at>?1 AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?1) THEN p.created_at END) AS oldestRetainedAt FROM source_work w JOIN connections c ON c.tenant=w.tenant AND c.id=w.source LEFT JOIN private_data p ON p.tenant=w.tenant AND p.connection=w.source AND p.id=w.private_id AND p.kind='source' WHERE ${sourceFilter} AND c.status='active' GROUP BY w.priority`,
      )
      .bind(now, now + day),
    db
      .prepare(
        `SELECT s.priority,s.state,COUNT(*) AS count,SUM(s.state IN('prepared','uncertain','submitted') AND s.due_at<=?1) AS due,MIN(a.created_at) AS oldestCreatedAt,MIN(CASE WHEN s.state IN('prepared','uncertain','submitted') AND s.due_at<=?1 THEN s.due_at END) AS oldestDueAt FROM attempt_state s JOIN attempts a ON a.tenant=s.tenant AND a.id=s.attempt WHERE ${attemptFilter} AND s.state!='rejected' GROUP BY s.priority,s.state`,
      )
      .bind(now),
    db
      .prepare(
        "SELECT COALESCE(SUM(due_at<=?1),0) AS due,COALESCE(SUM(due_at>?1),0) AS quiet,MIN(CASE WHEN due_at<=?1 THEN due_at END) AS oldestDueAt FROM ledger WHERE state IN('missing_current_identity','changed','live_new')",
      )
      .bind(now),
    db.prepare(
      `SELECT 'source' AS area,w.state,COUNT(*) AS count FROM source_work w WHERE ${sourceFilter} AND w.state IN('blocked','expired','missing_from_reread') GROUP BY w.state UNION ALL SELECT 'attempt' AS area,s.state,COUNT(*) AS count FROM attempt_state s WHERE ${attemptFilter} AND s.state IN('uncertain','reconciliation_required','rejected') GROUP BY s.state UNION ALL SELECT 'history' AS area,state,COUNT(*) AS count FROM ledger WHERE state IN('history_mismatch','history_ambiguous','historical_unverified') GROUP BY state`,
    ),
    db.prepare(
      "SELECT vendor,window_start,requests,background_requests,cooldown_until FROM vendor_requests",
    ),
    db.prepare("SELECT COUNT(*) AS total FROM accounts"),
    db
      .prepare(
        "SELECT a.id,a.email,a.status,a.verified_at AS verifiedAt,(SELECT COUNT(*) FROM passkeys p WHERE p.tenant=a.id AND p.revoked_at IS NULL) AS passkeys,(SELECT COUNT(*) FROM connections c WHERE c.tenant=a.id) AS connections FROM accounts a ORDER BY a.verified_at DESC,a.id LIMIT ?",
      )
      .bind(listLimit),
    db.prepare("SELECT COUNT(*) AS total FROM connections"),
    db
      .prepare(
        "SELECT c.tenant,a.email AS accountEmail,c.id,c.kind,c.label,c.status,c.last_poll_at AS lastAttemptAt,json_extract(c.config,'$.lastSuccessfulPollAt') AS lastSuccessfulPollAt,json_extract(c.config,'$.lastSyncSuccessAt') AS lastSyncSuccessAt,json_extract(c.config,'$.lastSyncFailureAt') AS lastFailureAt,json_extract(c.config,'$.lastError') IS NOT NULL AS hasError,json_extract(s.cursor,'$.mode') AS syncMode,COALESCE(json_extract(x.cursor,'$.complete'),0) AS contextComplete FROM connections c JOIN accounts a ON a.id=c.tenant LEFT JOIN cursors s ON s.tenant=c.tenant AND s.connection=c.id AND s.stream='sync' LEFT JOIN cursors x ON x.tenant=c.tenant AND x.connection=c.id AND x.stream='context' ORDER BY c.created_at DESC,c.tenant,c.id LIMIT ?",
      )
      .bind(listLimit),
  ]);
  const runs = results[0].results as RunRow[];
  const health = results[1].results[0] as {
    last_started: number | null;
    last_completed: number | null;
    running: number | null;
  };
  const totals = results[2].results[0] as {
    runs: number;
    failed: number | null;
    deadline_runs: number;
    source_pages: number;
    contact_turns: number;
    attempt_turns: number;
    errors: number;
    deferred: number;
  };
  const sourceRows = results[3].results as AdminOverview["backlog"]["source"];
  const vendors = results[7].results as {
    vendor: string;
    window_start: number;
    requests: number;
    background_requests: number;
    cooldown_until: number;
  }[];
  const accountTotal = (results[8].results[0] as { total: number }).total;
  const connectionTotal = (results[10].results[0] as { total: number }).total;
  const connectionRows = results[11].results as (Omit<
    AdminOverview["connections"]["items"][number],
    "lastSuccessAt" | "hasError" | "contextComplete"
  > & {
    lastSuccessfulPollAt: unknown;
    lastSyncSuccessAt: unknown;
    hasError: number;
    contextComplete: number;
  })[];
  return {
    generatedAt: now,
    scheduler: {
      intervalMs: 300_000,
      staleAfterMs: 900_000,
      retentionDays: 7,
      lastStartedAt: health.last_started,
      lastCompletedAt: health.last_completed,
      stale:
        health.last_completed === null || health.last_completed < now - 900_000,
      running: health.running ?? 0,
      totals24h: {
        runs: totals.runs,
        failed: totals.failed ?? 0,
        deadlineRuns: totals.deadline_runs,
        sourcePages: totals.source_pages,
        contactTurns: totals.contact_turns,
        attemptTurns: totals.attempt_turns,
        errors: totals.errors,
        deferred: totals.deferred,
      },
      recentRuns: runs.map(runSummary),
    },
    backlog: {
      source: (["live", "background"] as const).map(
        (priority) =>
          sourceRows.find((row) => row.priority === priority) ?? {
            priority,
            pending: 0,
            blocked: 0,
            expired: 0,
            expiring24h: 0,
            oldestRetainedAt: null,
          },
      ),
      attempts: results[4].results as AdminOverview["backlog"]["attempts"],
      deliveryCandidates: results[5]
        .results[0] as AdminOverview["backlog"]["deliveryCandidates"],
    },
    attention: results[6].results as AdminOverview["attention"],
    vendors: (["lofi", "qrz", "lotw"] as const).map((vendor) => {
      const policy = VENDOR_POLICIES[vendor];
      const row = vendors.find((entry) => entry.vendor === vendor);
      const window = Math.floor(now / policy.windowMs) * policy.windowMs;
      const current = row && row.window_start >= window;
      return {
        vendor,
        requests: current ? row.requests : 0,
        backgroundRequests: current ? row.background_requests : 0,
        totalLimit: policy.total,
        backgroundLimit: policy.background,
        windowEndsAt:
          Math.max(window, row?.window_start ?? window) + policy.windowMs,
        cooldownUntil:
          row && row.cooldown_until > now ? row.cooldown_until : null,
      };
    }),
    gates: gatesSummary(env),
    accounts: {
      total: accountTotal,
      truncated: accountTotal > listLimit,
      items: results[9].results as AdminOverview["accounts"]["items"],
    },
    connections: {
      total: connectionTotal,
      truncated: connectionTotal > listLimit,
      items: connectionRows.map(
        ({ lastSuccessfulPollAt, lastSyncSuccessAt, ...row }) => ({
          ...row,
          lastAttemptAt: timestamp(row.lastAttemptAt),
          lastSuccessAt:
            timestamp(lastSuccessfulPollAt) ?? timestamp(lastSyncSuccessAt),
          lastFailureAt: timestamp(row.lastFailureAt),
          hasError: row.hasError === 1,
          syncMode:
            row.syncMode === "forward" || row.syncMode === "backfill"
              ? row.syncMode
              : "unknown",
          contextComplete: row.contextComplete === 1,
        }),
      ),
    },
  };
}
