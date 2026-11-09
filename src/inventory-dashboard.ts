import {
  type InventoryDashboardActivity,
  type InventoryDashboardProvider,
  type InventoryDashboardWindow,
  type InventoryProviderDashboard,
  type InventoryStatusCount,
  inventoryDashboardProviders,
} from "./inventory-dashboard-types.ts";
import { inventoryLotwActivity } from "./inventory-lotw-activity.ts";
import type { Store } from "./store.ts";

type SummarySection =
  | "coverage"
  | "scans"
  | "matches"
  | "matching"
  | "review"
  | "deliveries";
type SummaryRow = InventoryStatusCount & {
  provider: InventoryDashboardProvider;
  section: SummarySection;
};

// Reasons are controlled state-machine codes. Never display a raw provider
// response or a connection configuration through either dashboard.
function reasonCode(reason: string | null) {
  return reason && /^[a-z0-9_]{1,96}$/.test(reason) ? reason : null;
}

function deliveries(tenant: string | undefined) {
  const filter = tenant === undefined ? "" : "AND a.tenant=?1";
  const lotwFilter = tenant === undefined ? "" : "AND m.tenant=?1";
  return `
    SELECT 'qrz' AS provider,a.tenant,a.record_key AS qso,h.destination_connection AS destination,
      CASE WHEN r.kind IS NOT NULL THEN r.kind
           WHEN a.cancelled_at IS NOT NULL THEN 'cancelled'
           WHEN d.attempt_id IS NOT NULL THEN
             CASE WHEN back.turns=6 THEN 'readback_held' ELSE 'awaiting_readback' END
           WHEN ms.sync_scope_version IS NOT coalesce(policy.version,0) THEN 'send_held'
           WHEN j.hold_reason IS NOT NULL THEN 'send_held'
           WHEN j.due_at IS NOT NULL THEN 'queued'
           ELSE 'prepared' END AS state,
      CASE WHEN d.attempt_id IS NULL AND a.cancelled_at IS NULL AND ms.sync_scope_version IS NOT coalesce(policy.version,0)
        THEN 'sync_scope_changed' ELSE j.hold_reason END AS reason,
      coalesce(r.received_at,a.cancelled_at,d.claimed_at,h.committed_at) AS updated_at,
      coalesce(back.due_at,j.due_at) AS dueAt,0 AS confirmed
    FROM inventory_qrz_attempts a JOIN inventory_qrz_preparations h USING(tenant,stage_id)
    LEFT JOIN inventory_qrz_dispatches d USING(tenant,attempt_id)
    LEFT JOIN inventory_qrz_dispatch_receipts r USING(tenant,attempt_id)
    LEFT JOIN inventory_qrz_send_jobs j USING(tenant,attempt_id)
    LEFT JOIN inventory_qrz_recovery_jobs back USING(tenant,attempt_id)
    LEFT JOIN inventory_match_sets ms ON (ms.tenant,ms.set_id)=(a.tenant,a.result_set)
    LEFT JOIN inventory_sync_scopes policy ON (policy.tenant,policy.destination)=(h.tenant,h.destination_connection)
    WHERE h.committed_at IS NOT NULL ${filter}
    UNION ALL
    SELECT 'lotw',m.tenant,m.record_key,h.destination_connection,
      CASE WHEN r.attempt_id IS NOT NULL THEN 'observed'
           WHEN m.cancelled_at IS NOT NULL THEN 'cancelled'
           WHEN u.state='rejected' THEN 'rejected'
           WHEN d.batch_id IS NOT NULL THEN
             CASE WHEN back.turns=6 THEN 'readback_held'
                  WHEN u.state='submitted' THEN 'submitted'
                  ELSE 'awaiting_readback' END
           WHEN ms.sync_scope_version IS NOT coalesce(policy.version,0) THEN 'send_held'
           WHEN j.hold_reason IS NOT NULL THEN 'send_held'
           WHEN j.due_at IS NOT NULL THEN 'queued'
           ELSE 'prepared' END,
      CASE WHEN d.batch_id IS NULL AND m.cancelled_at IS NULL AND ms.sync_scope_version IS NOT coalesce(policy.version,0)
        THEN 'sync_scope_changed' ELSE j.hold_reason END,
      coalesce(r.received_at,m.cancelled_at,u.received_at,d.claimed_at,h.committed_at),
      coalesce(back.due_at,j.due_at),coalesce(r.confirmed,0)
    FROM inventory_lotw_batch_members m JOIN inventory_lotw_batches h USING(tenant,batch_id)
    LEFT JOIN inventory_lotw_member_receipts r ON r.tenant=m.tenant AND r.attempt_id=m.attempt_id
    LEFT JOIN inventory_lotw_dispatches d ON d.tenant=h.tenant AND d.batch_id=h.batch_id
    LEFT JOIN inventory_lotw_upload_receipts u ON u.tenant=h.tenant AND u.batch_id=h.batch_id
    LEFT JOIN inventory_lotw_send_jobs j ON j.tenant=h.tenant AND j.batch_id=h.batch_id
    LEFT JOIN inventory_lotw_recovery_jobs back ON back.tenant=h.tenant AND back.batch_id=h.batch_id
    LEFT JOIN inventory_match_sets ms ON (ms.tenant,ms.set_id)=(m.tenant,m.result_set)
    LEFT JOIN inventory_sync_scopes policy ON (policy.tenant,policy.destination)=(h.tenant,h.destination_connection)
    WHERE h.committed_at IS NOT NULL ${lotwFilter}`;
}

async function loadInventoryDashboard(
  db: D1Database,
  tenant: string | undefined,
  includeActivity = false,
) {
  const args = tenant === undefined ? [] : [tenant];
  const filter = (alias: string) =>
    tenant === undefined ? "" : `AND ${alias}.tenant=?1`;
  const [inventory, comparison, queues, adopted] = await db.batch([
    db
      .prepare(
        `SELECT s.provider,count(*) AS contacts,max(r.last_observed_at) AS lastProgressAt
       FROM inventory_records r JOIN inventory_scopes s USING(tenant,scope_id)
       JOIN connections c ON c.tenant=s.tenant AND c.id=s.connection_id AND c.remote_identity=s.logical_identity
       WHERE r.entity_family='qso' AND r.subtype='qso' AND r.status='active' AND s.state='observing' ${filter("s")}
       GROUP BY s.provider`,
      )
      .bind(...args),
    db
      .prepare(
        `WITH valid AS MATERIALIZED (
         SELECT h.tenant,h.set_id FROM inventory_match_live_sets l
         JOIN inventory_match_sets h USING(tenant,set_id)
         WHERE h.state='committed' ${filter("h")}
           AND NOT EXISTS (SELECT 1 FROM inventory_match_stale_sets x WHERE x.tenant=h.tenant AND x.set_id=h.set_id)
       ), compared AS MATERIALIZED (
         SELECT s.provider,r.tenant,r.destination,r.source_scope,r.record_key,r.version,r.set_id,
           CASE WHEN r.state='excluded' AND EXISTS(
             SELECT 1 FROM inventory_match_rows q WHERE (q.tenant,q.set_id,q.source_scope,q.record_key)=
               (r.tenant,r.set_id,r.source_scope,r.record_key) AND q.scope_excluded=1
           ) THEN 'out_of_scope'
           WHEN r.state='absent_at_inventory' AND p.mode='forward' THEN 'forward_check'
           ELSE r.state END AS state,r.reason,r.derived_at,r.next_eligible_at
         FROM valid v CROSS JOIN match_results r INDEXED BY match_result_set
         JOIN inventory_scopes s ON s.tenant=r.tenant AND s.scope_id=r.destination
         LEFT JOIN inventory_sync_scopes p ON (p.tenant,p.destination)=(s.tenant,s.connection_id)
         WHERE (r.tenant,r.set_id)=(v.tenant,v.set_id)
       ), review_basis AS MATERIALIZED (
         SELECT b.tenant,b.destination,b.source_scope,b.record_key,b.result_set,b.result_version,
           b.decision,b.ownership_version,b.current_ownership_version,b.source_credential,b.current_source_credential,
           b.destination_credential,b.current_destination_credential,b.blocker,b.due_at
         FROM inventory_delivery_review_basis b WHERE 1 ${filter("b")}
       ), review AS (
         SELECT c.provider,CASE
           WHEN b.decision IS NOT NULL AND b.decision!='comparison_changed'
             AND b.ownership_version=b.current_ownership_version
             AND b.source_credential IS b.current_source_credential
             AND b.destination_credential IS b.current_destination_credential
             AND (b.decision=b.blocker OR (b.blocker IS NULL AND b.decision IN('source_proof_required','ownership_conflict','ownership_bound','projection_unavailable')))
           THEN b.decision ELSE 'awaiting_review' END AS state,
           c.derived_at,c.next_eligible_at,b.due_at
         FROM compared c
         LEFT JOIN review_basis b ON
           (b.tenant,b.destination,b.source_scope,b.record_key,b.result_set,b.result_version)=
           (c.tenant,c.destination,c.source_scope,c.record_key,c.set_id,c.version)
         WHERE c.state IN('absent_at_inventory','forward_check')
       )
       SELECT provider,'matches' AS section,state,reason,count(*) AS count,max(derived_at) AS since,NULL AS dueAt
         FROM compared GROUP BY provider,state,reason
       UNION ALL SELECT provider,'review',state,NULL,count(*),min(derived_at),
         min(CASE WHEN state='source_proof_required' THEN next_eligible_at ELSE due_at END)
         FROM review GROUP BY provider,state
       ORDER BY provider,section,state,reason`,
      )
      .bind(...args),
    db
      .prepare(
        `WITH coverage AS (
         SELECT s.provider,CASE WHEN c.state='ready' AND c.published_config_version IS NOT s.config_version
           THEN 'stale' ELSE c.state END AS state,c.completed_at
         FROM inventory_coverage c JOIN inventory_scopes s USING(tenant,scope_id)
         WHERE s.state='observing' ${filter("s")}
         AND (NOT EXISTS(SELECT 1 FROM inventory_sync_scopes p WHERE (p.tenant,p.destination)=(s.tenant,s.connection_id) AND p.mode!='all')
           OR EXISTS(SELECT 1 FROM inventory_scoped_schedule p WHERE (p.tenant,p.scope_id,p.stream_id)=(c.tenant,c.scope_id,c.stream_id)))
       ), scans AS (
         SELECT s.provider,coalesce(r.phase,'waiting') AS state,j.reason,
           r.phase_started_at AS since,nullif(j.next_due_at,0) AS dueAt
         FROM inventory_stream_jobs j JOIN inventory_scopes s USING(tenant,scope_id)
         LEFT JOIN inventory_runs r ON r.tenant=j.tenant AND r.run_id=j.active_run_id
         WHERE j.state!='idle' AND s.state='observing' ${filter("s")}
         AND (NOT EXISTS(SELECT 1 FROM inventory_sync_scopes p WHERE (p.tenant,p.destination)=(s.tenant,s.connection_id) AND p.mode!='all')
           OR EXISTS(SELECT 1 FROM inventory_scoped_schedule p WHERE (p.tenant,p.scope_id,p.stream_id)=(j.tenant,j.scope_id,j.stream_id)))
       ), delivery AS ${includeActivity ? "MATERIALIZED " : ""}(${deliveries(tenant)}), summary AS (
       SELECT provider,'coverage' AS section,state,NULL AS reason,count(*) AS count,max(completed_at) AS since,NULL AS dueAt
         FROM coverage GROUP BY provider,state
       UNION ALL SELECT provider,'scans',state,reason,count(*),min(since),min(dueAt)
         FROM scans GROUP BY provider,state,reason
       UNION ALL SELECT s.provider,'matching',CASE WHEN w.hold_reason IS NULL THEN 'queued' ELSE 'held' END,w.hold_reason,
         count(*),NULL,min(nullif(w.due_at,0))
         FROM matching_work w JOIN inventory_scopes s ON s.tenant=w.tenant AND s.scope_id=w.destination
         JOIN comparison_domains d ON d.tenant=w.tenant AND d.active_generation=w.generation_id
         JOIN inventory_scopes src ON src.tenant=w.tenant AND src.scope_id=w.source_scope
         WHERE w.completed_version<w.work_version AND s.state='observing' AND src.state='observing'
           AND w.destination_config_version=s.config_version AND w.source_config_version=src.config_version ${filter("w")}
         GROUP BY s.provider,w.hold_reason
       UNION ALL SELECT provider,'deliveries',state,reason,count(*),min(updated_at),min(dueAt)
         FROM delivery GROUP BY provider,state,reason
       UNION ALL SELECT 'lotw','deliveries','lotw_grid_update_'||u.state,u.reason,
         count(*),min(coalesce(u.checked_at,u.claimed_at)),
         min(CASE WHEN u.state IN('uncertain','submitted','deferred') THEN u.due_at END)
         FROM inventory_lotw_grid_updates u WHERE 1 ${filter("u")}
         GROUP BY u.state,u.reason
       )
       SELECT *,NULL AS activity FROM summary
       ${
         includeActivity
           ? `UNION ALL SELECT NULL,'recent',NULL,NULL,NULL,NULL,NULL,
         json_group_array(json_object('provider',provider,'qso',qso,'destination',destination,
           'state',state,'reason',reason,'confirmed',confirmed,'updated_at',updated_at))
       FROM (
         SELECT provider,qso,destination,state,reason,confirmed,updated_at FROM delivery
           WHERE provider!='lotw' OR state!='observed'
         UNION ALL SELECT 'qrz',h.record_key,c.id,'adopted_existing',NULL,0,h.created_at
           FROM inventory_historical_associations h
           JOIN connections c ON c.tenant=h.tenant AND c.kind='qrz' AND c.remote_identity=h.book_identity
           WHERE h.tenant=?1 AND h.provider='qrz'
         ORDER BY updated_at DESC,provider,destination,qso LIMIT 50
       )`
           : ""
       }
       ORDER BY provider,section,state,reason`,
      )
      .bind(...args),
    db
      .prepare(
        `SELECT h.provider,count(*) AS count FROM inventory_historical_associations h
       WHERE 1 ${filter("h")} GROUP BY h.provider`,
      )
      .bind(...args),
  ]);
  const counts = inventory.results as Pick<
    InventoryProviderDashboard,
    "contacts" | "lastProgressAt" | "provider"
  >[];
  const queueRows = queues.results as (
    | SummaryRow
    | { section: "recent"; activity: string }
  )[];
  const recent = queueRows.find((row) => row.section === "recent");
  const rows = [
    ...(comparison.results as SummaryRow[]),
    ...queueRows.filter((row) => row.section !== "recent"),
  ];
  const adoption = adopted.results as {
    provider: InventoryDashboardProvider;
    count: number;
  }[];
  const providers = inventoryDashboardProviders.map((provider) => {
    const source = counts.find((row) => row.provider === provider);
    const select = (name: SummarySection) =>
      rows.flatMap(
        ({ provider: from, section, reason, state, count, since, dueAt }) =>
          from === provider && section === name
            ? [{ state, count, since, dueAt, reason: reasonCode(reason) }]
            : [],
      );
    const coverage = select("coverage");
    return {
      provider,
      contacts: source?.contacts ?? 0,
      lastProgressAt:
        Math.max(
          source?.lastProgressAt ?? 0,
          ...coverage.map((row) => row.since ?? 0),
        ) || null,
      coverage,
      scans: select("scans"),
      matches: select("matches"),
      matching: select("matching"),
      review: select("review"),
      deliveries: select("deliveries"),
      adopted: adoption.find((row) => row.provider === provider)?.count ?? 0,
    };
  });
  return {
    providers,
    nativeActivity: recent
      ? (JSON.parse(recent.activity) as InventoryDashboardActivity[])
      : [],
  };
}

/** Account and operator summaries share the same native tables and labels. */
export async function inventoryDashboardSummary(
  db: D1Database,
  tenant?: string,
): Promise<InventoryProviderDashboard[]> {
  return (await loadInventoryDashboard(db, tenant)).providers;
}

export async function inventoryDashboardWindows(
  db: D1Database,
  tenant: string,
) {
  const rows = await db
    .prepare(
      `SELECT s.provider,
       CASE WHEN c.state='ready' AND c.published_config_version IS NOT s.config_version THEN 'stale'
         ELSE coalesce(c.state,'waiting') END AS state,
       running.phase AS phase,j.reason,
       coalesce(json_extract(r.fixed_query,'$.selection.between[0]'),json_extract(r.fixed_query,'$.query.startDate'),
         json_extract(p.plan,'$.between[0]'),json_extract(p.plan,'$.selection.startDate')) AS "from",
       coalesce(json_extract(r.fixed_query,'$.selection.between[1]'),json_extract(r.fixed_query,'$.query.endDate'),
         json_extract(p.plan,'$.between[1]'),json_extract(p.plan,'$.selection.endDate')) AS through,
       c.completed_at AS completedAt,nullif(j.next_due_at,0) AS nextDueAt
     FROM inventory_streams t JOIN inventory_scopes s USING(tenant,scope_id)
     JOIN connections link ON link.tenant=s.tenant AND link.id=s.connection_id AND link.remote_identity=s.logical_identity
     LEFT JOIN inventory_scheduled_selections p ON (p.tenant,p.scope_id,p.stream_id)=(t.tenant,t.scope_id,t.stream_id)
     LEFT JOIN inventory_stream_jobs j ON (j.tenant,j.scope_id,j.stream_id)=(t.tenant,t.scope_id,t.stream_id)
     LEFT JOIN inventory_runs running ON running.tenant=j.tenant AND running.run_id=j.active_run_id
     LEFT JOIN inventory_coverage c ON (c.tenant,c.scope_id,c.stream_id)=(t.tenant,t.scope_id,t.stream_id)
     LEFT JOIN inventory_runs r ON r.tenant=c.tenant AND r.run_id=coalesce(c.building_run_id,c.published_run_id)
     WHERE t.tenant=?1 AND s.state='observing' AND (p.stream_id IS NOT NULL OR j.stream_id IS NOT NULL OR c.stream_id IS NOT NULL)
       AND (NOT EXISTS(SELECT 1 FROM inventory_sync_scopes policy WHERE (policy.tenant,policy.destination)=(s.tenant,s.connection_id) AND policy.mode!='all')
         OR EXISTS(SELECT 1 FROM inventory_scoped_schedule allowed WHERE (allowed.tenant,allowed.scope_id,allowed.stream_id)=(t.tenant,t.scope_id,t.stream_id)))
     ORDER BY case WHEN running.run_id IS NULL THEN 1 ELSE 0 END,
       coalesce(running.phase_started_at,c.completed_at,p.created_at,0) DESC,s.provider,t.stream_id,c.partition_id LIMIT 48`,
    )
    .bind(tenant)
    .all<InventoryDashboardWindow>();
  return rows.results.map((row) => ({
    ...row,
    reason: reasonCode(row.reason),
  }));
}

export async function inventoryAccountDashboard(store: Store, tenant: string) {
  const [{ providers, nativeActivity }, lotw] = await Promise.all([
    loadInventoryDashboard(store.db, tenant, true),
    inventoryLotwActivity(store, tenant),
  ]);
  const activity = [
    ...nativeActivity.map((row) => ({
      ...row,
      reason: reasonCode(row.reason),
    })),
    ...lotw.activity.map((row) => ({ ...row, provider: "lotw" as const })),
  ]
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 50);
  return { providers, activity };
}
