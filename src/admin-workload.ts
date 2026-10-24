import type {
  AdminPriority,
  AdminWorkCounts,
  AdminWorkload,
} from "./admin-types.ts";
import { deliveryGates, exportsEffective } from "./service.ts";

const hour = 3_600_000;
const day = 24 * hour;
const labels: Record<string, string> = {
  operation_context_unavailable:
    "Operation context unavailable — reread needed",
  operation_context_expired: "Operation context expired — reread needed",
  operation_context_incomplete: "Operation context incomplete — reread needed",
  source_payload_expired: "Source input unavailable — reread needed",
  source_context: "Waiting for complete source context",
  source_validation: "Waiting for current source verification",
  source_boundary: "Waiting for verified source replay boundary",
  reread_required: "Missing from operation reread — review needed",
  no_destination: "No active destination connected",
  destination_unavailable: "Destination credential or connection unavailable",
  routing: "Station or date routing needs review",
  history_review: "Destination history needs review",
  in_flight: "Delivery or readback already in progress",
  exports_disabled: "Export safety gates closed",
  rollout_scope: "Outside the authorized export scope",
  quiet: "Waiting for edit quiet time",
  delivery_review: "Delivery preparation needs review",
  resolved: "Already resolved — awaiting source cleanup",
  missing_or_ambiguous_station_call:
    "Missing or invalid worked/station callsign",
  missing_mode: "Missing mode",
  unsupported_mode_mapping: "Unsupported mode mapping",
  invalid_qso_time: "Invalid contact time",
  invalid_frequency_khz: "Invalid frequency",
  missing_or_invalid_band: "Missing or invalid band",
  frequency_band_mismatch: "Frequency does not match band",
  invalid_grid: "Invalid grid locator",
  invalid_coordinate_pair: "Invalid coordinate pair",
  invalid_operation_id: "Invalid operation reference",
  missing_qso_uuid: "Missing contact identifier",
  invalid_segment_boundary: "Invalid operation segment boundary",
  ambiguous_segment_boundary: "Ambiguous operation segment boundary",
  invalid_references: "Invalid operation references",
  invalid_tombstone_flag: "Invalid deletion flag",
  source_projection_requires_review: "Source contact needs review",
};
const contextReasons = [
  "operation_context_unavailable",
  "operation_context_expired",
  "operation_context_incomplete",
  "source_payload_expired",
];
const quoted = (values: string[]) =>
  values.map((value) => `'${value}'`).join(",");

function gateParameters(env: Env): [number, string, string] {
  try {
    const gates = deliveryGates(env);
    return [
      exportsEffective(gates) ? 1 : 0,
      JSON.stringify(gates.allowedQsoIds),
      JSON.stringify(gates.allowedDestinationIds),
    ];
  } catch {
    return [0, "[]", "[]"];
  }
}

interface SourceGroup {
  priority: AdminPriority;
  classification: "ready" | "held" | "blocked" | "expired";
  reason: string;
  count: number;
  oldestRetainedAt: number | null;
}

/** No payload decryption: known metadata holds are conservative, not send permission. */
export function workloadSourceStatement(env: Env, now: number) {
  const [enabled, scope, destinations] = gateParameters(env);
  return env.DB.prepare(`
    WITH destination_work AS (
      SELECT l.tenant,l.source,l.qso,
        CASE
          WHEN l.provenance='adoption_conflict' THEN 'history_review'
          WHEN l.state IN('source_deleted','retained_old_route') OR
            (l.state IN('adopted_existing','delivered','observed') AND l.source_hash IS l.baseline_hash) THEN 'resolved'
          WHEN EXISTS(SELECT 1 FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id
            WHERE a.tenant=l.tenant AND a.source=l.source AND a.qso=l.qso AND a.destination=l.destination
            AND s.state NOT IN('delivered','observed','rejected','cancelled')) THEN 'in_flight'
          WHEN d.status!='active' OR d.credential_version IS NULL OR NOT EXISTS(
            SELECT 1 FROM private_data p WHERE p.tenant=d.tenant AND p.connection=d.id
            AND p.id=d.credential_version AND p.kind='credential' AND p.revoked_at IS NULL
            AND (p.expires_at IS NULL OR p.expires_at>?1)) THEN 'destination_unavailable'
          WHEN l.reason IN('Multiple connections match this station; resolve routing','No connection matches this station and date',
            'qrz_station_or_date_route_mismatch','lotw_station_route_mismatch') THEN 'routing'
          WHEN l.state IN('history_mismatch','history_ambiguous','historical_unverified') THEN 'history_review'
          WHEN l.reason='Source replay/cutover evidence is not yet verified; absence cannot authorize backfill' THEN 'source_boundary'
          WHEN l.state IN('missing_current_identity','changed','live_new') THEN CASE
            WHEN ?2=0 THEN 'exports_disabled'
            WHEN ?3!='null' AND NOT EXISTS(SELECT 1 FROM json_each(?3) WHERE value=l.qso) THEN 'rollout_scope'
            WHEN ?4!='null' AND NOT EXISTS(SELECT 1 FROM json_each(?4) WHERE value=l.destination) THEN 'rollout_scope'
            WHEN l.due_at>?1 THEN 'quiet'
            WHEN l.reason GLOB 'source_export_proof_*' THEN 'source_validation'
            WHEN l.reason IN('mapped_qrz_record_missing','qrz_replacement_contract_unverified','qrz_collision_ambiguous',
              'qrz_changed_identity_collision','qrz_fresh_absence_check_found_candidate','lotw_subsecond_precision_unverified',
              'subsecond_export_requires_identity_claim','remote_identity_claim_conflict',
              'lotw_fresh_absence_check_found_candidate','lotw_correction_readback_ambiguous','lotw_historical_readback_unavailable',
              'lotw_certificate_selection_ambiguous_or_missing','lotw_certificate_not_currently_valid',
              'lotw_certificate_revoked','lotw_certificate_unknown','source_replay_boundary_unverified') THEN 'delivery_review'
            ELSE 'ready' END
          WHEN l.state='inventory_pending' THEN 'ready'
          ELSE 'delivery_review' END AS reason
      FROM ledger l JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination
      JOIN source_work pending ON pending.tenant=l.tenant AND pending.source=l.source AND pending.id=l.qso
        AND pending.kind='qso' AND pending.is_event=0 AND pending.deleted=0 AND pending.expires_at>?1
        AND pending.state IN('pending','waiting','blocked','missing_from_reread')
      JOIN connections source ON source.tenant=pending.tenant AND source.id=pending.source AND source.status='active'
    ), destination_summary AS (
      SELECT tenant,source,qso,COUNT(*) AS total,SUM(reason='ready') AS ready,
        COALESCE(MIN(CASE WHEN reason!='resolved' THEN reason END),'resolved') AS reason
      FROM destination_work GROUP BY tenant,source,qso
    ), source_rows AS (
      SELECT w.*,
        CASE WHEN w.priority='live' OR EXISTS(SELECT 1 FROM source_births b WHERE b.tenant=w.tenant AND b.source=w.source AND b.qso=w.id AND b.phase='forward_new')
          OR EXISTS(SELECT 1 FROM ledger l WHERE l.tenant=w.tenant AND l.source=w.source AND l.qso=w.id AND l.state='changed') THEN 'live' ELSE 'background' END AS effective_priority,
        CASE WHEN p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?1) THEN p.created_at END AS retained_at,
        CASE
          WHEN w.expires_at<=?1 THEN 'expired'
          WHEN w.state='blocked' THEN CASE WHEN w.reason IN(${quoted(Object.keys(labels))}) THEN w.reason ELSE 'source_projection_requires_review' END
          WHEN w.state='missing_from_reread' THEN 'reread_required'
          WHEN p.id IS NULL OR p.revoked_at IS NOT NULL OR p.expires_at<=?1 THEN 'source_payload_expired'
          WHEN COALESCE(json_extract(x.cursor,'$.complete'),0)!=1 THEN 'source_context'
          WHEN w.operation_id IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM source_work o WHERE o.tenant=w.tenant AND o.source=w.source
            AND o.id=w.operation_id AND o.kind='operation' AND o.state='context' AND o.deleted=0 AND o.expires_at>?1)
            OR EXISTS(SELECT 1 FROM source_work o LEFT JOIN private_data op ON op.tenant=o.tenant AND op.connection=o.source AND op.id=o.private_id AND op.kind='source'
              WHERE o.tenant=w.tenant AND o.source=w.source AND o.operation_id=w.operation_id AND (o.kind='operation' OR o.is_event=1)
              AND NOT(o.kind='qso' AND o.deleted=1) AND (o.expires_at<=?1 OR op.id IS NULL OR op.revoked_at IS NOT NULL OR op.expires_at<=?1))) THEN 'operation_context_unavailable'
          WHEN NOT EXISTS(SELECT 1 FROM connections d WHERE d.tenant=w.tenant AND d.kind IN('qrz','lotw') AND d.status='active') THEN 'no_destination'
          WHEN NOT EXISTS(SELECT 1 FROM connections d JOIN private_data credential ON credential.tenant=d.tenant AND credential.connection=d.id
            AND credential.id=d.credential_version AND credential.kind='credential' AND credential.revoked_at IS NULL
            AND (credential.expires_at IS NULL OR credential.expires_at>?1)
            WHERE d.tenant=w.tenant AND d.kind IN('qrz','lotw') AND d.status='active') THEN 'destination_unavailable'
          WHEN w.state='pending' OR d.ready>0 THEN 'ready'
          WHEN EXISTS(SELECT 1 FROM connections fresh JOIN private_data credential ON credential.tenant=fresh.tenant
            AND credential.connection=fresh.id AND credential.id=fresh.credential_version AND credential.kind='credential'
            AND credential.revoked_at IS NULL AND (credential.expires_at IS NULL OR credential.expires_at>?1)
            WHERE fresh.tenant=w.tenant AND fresh.kind IN('qrz','lotw') AND fresh.status='active' AND fresh.created_at>w.processed_at
            AND NOT EXISTS(SELECT 1 FROM ledger known WHERE known.tenant=w.tenant AND known.source=w.source AND known.qso=w.id AND known.destination=fresh.id)) THEN 'ready'
          WHEN w.reason LIKE 'No QRZ route matches%' OR w.reason LIKE 'No LOTW route matches%'
            OR w.reason LIKE 'Multiple QRZ routes match%' OR w.reason LIKE 'Multiple LOTW routes match%' THEN 'routing'
          WHEN d.total IS NULL OR EXISTS(SELECT 1 FROM connections fresh WHERE fresh.tenant=w.tenant AND fresh.kind IN('qrz','lotw')
            AND fresh.status='active' AND NOT EXISTS(SELECT 1 FROM ledger known WHERE known.tenant=w.tenant AND known.source=w.source AND known.qso=w.id AND known.destination=fresh.id)
            AND EXISTS(SELECT 1 FROM private_data credential WHERE credential.tenant=fresh.tenant AND credential.connection=fresh.id
              AND credential.id=fresh.credential_version AND credential.kind='credential' AND credential.revoked_at IS NULL
              AND (credential.expires_at IS NULL OR credential.expires_at>?1))) THEN 'ready'
          ELSE d.reason END AS work_reason
      FROM source_work w JOIN connections c ON c.tenant=w.tenant AND c.id=w.source AND c.status='active'
      LEFT JOIN private_data p ON p.tenant=w.tenant AND p.connection=w.source AND p.id=w.private_id AND p.kind='source'
      LEFT JOIN cursors x ON x.tenant=w.tenant AND x.connection=w.source AND x.stream='context'
      LEFT JOIN destination_summary d ON d.tenant=w.tenant AND d.source=w.source AND d.qso=w.id
      WHERE w.kind='qso' AND w.is_event=0 AND w.deleted=0 AND w.state IN('pending','waiting','blocked','expired','missing_from_reread')
    )
    SELECT effective_priority AS priority,
      CASE WHEN work_reason IN('ready','expired') THEN work_reason
        WHEN state='blocked' AND work_reason NOT IN(${quoted(contextReasons)}) THEN 'blocked' ELSE 'held' END AS classification,
      work_reason AS reason,COUNT(*) AS count,MIN(retained_at) AS oldestRetainedAt
    FROM source_rows GROUP BY effective_priority,classification,work_reason
  `).bind(now, enabled, scope, destinations);
}

export function sourceWorkSummary(groups: SourceGroup[]) {
  return (["live", "background"] as const).map((priority) => {
    const rows = groups.filter((row) => row.priority === priority);
    const count = (kind: SourceGroup["classification"]) =>
      rows
        .filter((row) => row.classification === kind)
        .reduce((n, row) => n + row.count, 0);
    const ages = rows
      .filter((row) => row.classification !== "expired")
      .flatMap((row) =>
        row.oldestRetainedAt === null ? [] : [row.oldestRetainedAt],
      );
    return {
      priority,
      ready: count("ready"),
      held: count("held"),
      blocked: count("blocked"),
      expired: count("expired"),
      oldestRetainedAt: ages.length ? Math.min(...ages) : null,
    };
  });
}

interface TrendRow {
  finished_at: number;
  work_live_ready: number | null;
  work_live_held: number | null;
  work_live_blocked: number | null;
  work_background_ready: number | null;
  work_background_held: number | null;
  work_background_blocked: number | null;
}

export function workCounts(
  row: Omit<TrendRow, "finished_at">,
  priority: AdminPriority,
): AdminWorkCounts | null {
  const ready = row[`work_${priority}_ready`];
  const held = row[`work_${priority}_held`];
  const blocked = row[`work_${priority}_blocked`];
  return ready === null || held === null || blocked === null
    ? null
    : { ready, held, blocked };
}

export async function getAdminWorkload(
  env: Env,
  now: number,
): Promise<AdminWorkload> {
  const [source, samples, completed, pending, adopted] = await env.DB.batch([
    workloadSourceStatement(env, now),
    env.DB.prepare(
      "SELECT finished_at,work_live_ready,work_live_held,work_live_blocked,work_background_ready,work_background_held,work_background_blocked FROM scheduler_runs WHERE status='completed' AND finished_at>? AND finished_at<=? ORDER BY finished_at DESC,id DESC LIMIT 2001",
    ).bind(now - day, now),
    // An attempt is one source contact version for one destination. The first
    // delivered/observed event wins, including across repeated readback events.
    env.DB.prepare(`WITH completed AS (
      SELECT e.tenant,e.attempt,MIN(e.at) AS at FROM attempt_events e
      WHERE e.state IN('delivered','observed') AND e.at>?1 AND e.at<=?3
        AND NOT EXISTS(SELECT 1 FROM attempt_events old WHERE old.tenant=e.tenant AND old.attempt=e.attempt AND old.state IN('delivered','observed') AND old.at<=?1)
      GROUP BY e.tenant,e.attempt
    ) SELECT CAST((completed.at-?1-1)/?2 AS INTEGER) AS bucket,c.kind AS vendor,COUNT(*) AS count,MAX(completed.at) AS lastAt
      FROM completed JOIN attempts a ON a.tenant=completed.tenant AND a.id=completed.attempt
      JOIN connections c ON c.tenant=a.tenant AND c.id=a.destination
      WHERE completed.at>?1 AND completed.at<=?3 AND c.kind IN('qrz','lotw') GROUP BY bucket,c.kind`).bind(
      now - day,
      hour,
      now,
    ),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM attempt_state WHERE state='submitted'",
    ),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM ledger WHERE provenance='adopted' AND state='adopted_existing'",
    ),
  ]);
  const groups = source.results as SourceGroup[];
  const reasons = (classification: SourceGroup["classification"]) =>
    groups
      .filter((row) => row.classification === classification)
      .map(({ priority, reason, count }) => ({
        priority,
        reason,
        count,
        label: labels[reason] ?? labels.source_projection_requires_review,
      }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  const rows = (samples.results as TrendRow[]).slice(0, 2000).reverse();
  const known = rows.filter(
    (row) =>
      workCounts(row, "live") !== null &&
      workCounts(row, "background") !== null,
  );
  const points: AdminWorkload["trend"]["points"] = [];
  const buckets: AdminWorkload["deliveries"]["buckets"] = [];
  const deliveries = completed.results as {
    bucket: number;
    vendor: "qrz" | "lotw";
    count: number;
    lastAt: number;
  }[];
  for (let bucket = 0; bucket < 24; bucket++) {
    const at = now - day + (bucket + 1) * hour;
    const row = rows
      .filter((row) => row.finished_at > at - hour && row.finished_at <= at)
      .at(-1);
    points.push({
      at: row?.finished_at ?? at,
      live: row ? workCounts(row, "live") : null,
      background: row ? workCounts(row, "background") : null,
    });
    const qrz =
      deliveries.find(
        (entry) => entry.bucket === bucket && entry.vendor === "qrz",
      )?.count ?? 0;
    const lotw =
      deliveries.find(
        (entry) => entry.bucket === bucket && entry.vendor === "lotw",
      )?.count ?? 0;
    buckets.push({ at, total: qrz + lotw, qrz, lotw });
  }
  const firstAt = known.at(0)?.finished_at ?? null;
  const lastAt = known.at(-1)?.finished_at ?? null;
  const times = [now - day, ...known.map((row) => row.finished_at), now];
  const qrz = buckets.reduce((n, row) => n + row.qrz, 0);
  const lotw = buckets.reduce((n, row) => n + row.lotw, 0);
  return {
    source: sourceWorkSummary(groups),
    heldReasons: reasons("held"),
    blockedReasons: reasons("blocked"),
    trend: {
      windowMs: day,
      firstAt,
      lastAt,
      sampleCount: known.length,
      truncated: samples.results.length > 2000,
      expectedSamples: day / 300_000,
      stale: lastAt === null || lastAt < now - 900_000,
      maxGapMs: known.length
        ? Math.max(...times.slice(1).map((at, i) => at - (times[i] ?? at)))
        : null,
      points,
    },
    deliveries: {
      windowMs: day,
      total: qrz + lotw,
      qrz,
      lotw,
      lastCompletedAt: deliveries.length
        ? Math.max(...deliveries.map((row) => row.lastAt))
        : null,
      buckets,
      submittedOutstanding: (pending.results[0] as { count: number }).count,
      adoptedExisting: (adopted.results[0] as { count: number }).count,
    },
  };
}
