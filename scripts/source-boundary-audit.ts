/**
 * Read-only, single-scope metadata audit. No credentials, ciphertext, UUIDs,
 * cursor tokens or source records are returned. This module has no network or
 * database runner: the operator supplies this SELECT to an approved reader.
 * Passing every local check cannot establish the vendor's replay contract.
 */
export const sourceBoundaryAuditSql = `
WITH scope AS (
  SELECT s.*,a.status AS account_status FROM connections s
  JOIN accounts a ON a.id=s.tenant
  WHERE s.tenant=?1 AND s.id=?2 AND s.kind='lofi'
), sync AS (
  SELECT c.* FROM cursors c JOIN scope s ON s.tenant=c.tenant AND s.id=c.connection
  WHERE c.stream='sync'
), context AS (
  SELECT c.* FROM cursors c JOIN scope s ON s.tenant=c.tenant AND s.id=c.connection
  WHERE c.stream='context'
), inventory AS (
  SELECT e.* FROM source_inventory_epochs e JOIN scope s ON s.tenant=e.tenant AND s.id=e.source
), work AS (
  SELECT w.*,
    p.id IS NULL AS payload_missing,
    p.revoked_at IS NOT NULL AS payload_revoked,
    w.expires_at<=?3 OR (p.expires_at IS NOT NULL AND p.expires_at<=?3) AS payload_expired,
    w.expires_at>?3 AND p.id IS NOT NULL AND p.revoked_at IS NULL
      AND (p.expires_at IS NULL OR p.expires_at>?3) AS payload_available
  FROM source_work w JOIN scope s ON s.tenant=w.tenant AND s.id=w.source
  LEFT JOIN private_data p ON p.tenant=w.tenant AND p.connection=w.source
    AND p.id=w.private_id AND p.kind='source'
), births AS (
  SELECT b.* FROM source_births b JOIN scope s ON s.tenant=b.tenant AND s.id=b.source
), destinations AS (
  SELECT d.* FROM connections d JOIN scope s ON s.tenant=d.tenant
  WHERE d.kind IN('qrz','lotw') AND d.status='active'
), rescans AS (
  SELECT c.* FROM cursors c JOIN scope s ON s.tenant=c.tenant AND s.id=c.connection
  WHERE c.stream LIKE 'rescan:%'
)
SELECT
  (SELECT COUNT(*) FROM scope) AS source_present,
  (SELECT COUNT(*) FROM scope WHERE status='active' AND account_status='active') AS source_active,
  (SELECT COUNT(*) FROM scope s JOIN private_data p ON p.tenant=s.tenant AND p.connection=s.id
    AND p.id=s.credential_version AND p.kind='credential'
    WHERE p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?3)) AS credential_available,
  (SELECT COUNT(*) FROM sync) AS sync_present,
  (SELECT COUNT(*) FROM sync WHERE json_extract(cursor,'$.mode')='forward') AS sync_forward,
  COALESCE((SELECT generation FROM sync),0) AS sync_generation,
  COALESCE((SELECT updated_at FROM sync),0) AS sync_updated_at,
  (SELECT COUNT(*) FROM sync WHERE COALESCE(json_extract(cursor,'$.operations.cursor'),'')!='') AS operation_cursor_present,
  (SELECT COUNT(*) FROM sync WHERE COALESCE(json_extract(cursor,'$.qsos.cursor'),'')!='') AS qso_cursor_present,
  (SELECT COUNT(*) FROM context) AS context_present,
  COALESCE((SELECT generation FROM context),0) AS context_generation,
  (SELECT COUNT(*) FROM context WHERE json_extract(cursor,'$.complete')=1) AS context_complete,
  (SELECT COUNT(*) FROM context WHERE json_extract(cursor,'$.syncComplete')=1) AS context_sync_complete,
  (SELECT COUNT(*) FROM inventory) AS inventory_epochs,
  (SELECT COUNT(*) FROM destinations) AS active_destinations,
  (SELECT COUNT(*) FROM destinations d WHERE NOT EXISTS(SELECT 1 FROM inventory e WHERE d.created_at<=e.started_at)
    AND NOT EXISTS(SELECT 1 FROM rescans c WHERE c.stream='rescan:'||d.id AND json_extract(c.cursor,'$.rescanComplete')=1)) AS destinations_requiring_rescan,
  (SELECT COUNT(*) FROM rescans) AS rescan_streams,
  (SELECT COUNT(*) FROM rescans WHERE json_extract(cursor,'$.rescanComplete')=1) AS completed_rescan_streams,
  (SELECT COUNT(*) FROM cursors c JOIN scope s ON s.tenant=c.tenant AND s.id=c.connection WHERE c.stream LIKE 'gap:%') AS retained_gap_markers,
  (SELECT COUNT(*) FROM source_cutovers c JOIN scope s ON s.tenant=c.tenant AND s.id=c.source) AS cutovers,
  (SELECT COUNT(*) FROM work WHERE kind='operation') AS operation_rows,
  (SELECT COUNT(*) FROM work WHERE kind='operation' AND deleted=1) AS deleted_operations,
  (SELECT COUNT(*) FROM work WHERE kind='operation' AND deleted=0 AND state='context') AS context_operations,
  (SELECT COUNT(*) FROM work WHERE kind='operation' AND deleted=0 AND state='pending') AS pending_nondeleted_operations,
  (SELECT COUNT(*) FROM work WHERE kind='operation' AND deleted=0 AND state='pending' AND expires_at>?3) AS reread_eligible_metadata_operations,
  (SELECT COUNT(*) FROM work WHERE kind='operation' AND deleted=0 AND reason='event_absence_requires_reconciliation') AS event_absence_holds,
  (SELECT COUNT(*) FROM work WHERE kind='qso' AND is_event=0) AS contact_rows,
  (SELECT COUNT(*) FROM work WHERE kind='qso' AND is_event=0 AND deleted=1) AS deleted_contacts,
  (SELECT COUNT(*) FROM work WHERE kind='qso' AND is_event=0 AND deleted=0 AND operation_id IS NULL) AS general_log_contacts,
  (SELECT COUNT(*) FROM work WHERE kind='qso' AND is_event=1) AS event_rows,
  (SELECT COUNT(*) FROM work WHERE kind='qso' AND is_event=1 AND deleted=1) AS deleted_events,
  (SELECT COUNT(*) FROM work w WHERE w.kind='qso' AND NOT EXISTS(SELECT 1 FROM births b WHERE b.qso=w.id)) AS missing_qso_births,
  (SELECT COUNT(*) FROM births WHERE phase='forward_new') AS forward_new_births,
  (SELECT COUNT(*) FROM births b WHERE b.first_stream='sync' AND
    (b.first_cursor_generation<1 OR NOT EXISTS(SELECT 1 FROM sync c WHERE c.generation>=b.first_cursor_generation))) AS invalid_sync_birth_generations,
  (SELECT COUNT(*) FROM work WHERE deleted=0 AND payload_missing) AS nondeleted_missing_payloads,
  (SELECT COUNT(*) FROM work WHERE deleted=0 AND payload_revoked) AS nondeleted_revoked_payloads,
  (SELECT COUNT(*) FROM work WHERE deleted=0 AND payload_expired) AS nondeleted_expired_payloads,
  (SELECT COUNT(*) FROM work WHERE kind='qso' AND is_event=0 AND deleted=0 AND state!='test' AND NOT payload_available) AS unavailable_contact_payloads,
  (SELECT COUNT(*) FROM work q WHERE q.kind='qso' AND q.is_event=0 AND q.deleted=0 AND q.state!='test' AND q.operation_id IS NOT NULL AND
    (NOT EXISTS(SELECT 1 FROM work o WHERE o.kind='operation' AND o.id=q.operation_id AND o.deleted=0 AND o.state='context' AND o.payload_available)
    OR EXISTS(SELECT 1 FROM work e WHERE e.kind='qso' AND e.is_event=1 AND e.operation_id=q.operation_id AND e.deleted=0 AND NOT e.payload_available))) AS unavailable_contact_dependencies
`;

const metrics = [
  "source_present",
  "source_active",
  "credential_available",
  "sync_present",
  "sync_forward",
  "sync_generation",
  "sync_updated_at",
  "operation_cursor_present",
  "qso_cursor_present",
  "context_present",
  "context_generation",
  "context_complete",
  "context_sync_complete",
  "inventory_epochs",
  "active_destinations",
  "destinations_requiring_rescan",
  "rescan_streams",
  "completed_rescan_streams",
  "retained_gap_markers",
  "cutovers",
  "operation_rows",
  "deleted_operations",
  "context_operations",
  "pending_nondeleted_operations",
  "reread_eligible_metadata_operations",
  "event_absence_holds",
  "contact_rows",
  "deleted_contacts",
  "general_log_contacts",
  "event_rows",
  "deleted_events",
  "missing_qso_births",
  "forward_new_births",
  "invalid_sync_birth_generations",
  "nondeleted_missing_payloads",
  "nondeleted_revoked_payloads",
  "nondeleted_expired_payloads",
  "unavailable_contact_payloads",
  "unavailable_contact_dependencies",
] as const;
export type SourceBoundaryAuditCounts = Record<
  (typeof metrics)[number],
  number
>;

export function sourceBoundaryAuditQuery(
  tenant: string,
  source: string,
  now: number,
) {
  if (
    !tenant ||
    tenant.length > 256 ||
    !source ||
    source.length > 256 ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    throw new Error("Invalid source audit scope");
  return {
    sql: sourceBoundaryAuditSql,
    params: [tenant, source, now] as const,
  };
}

/** Copy only known numeric fields, even if the reader returns extra columns. */
export function sourceBoundaryAuditReport(row: unknown) {
  if (!row || typeof row !== "object" || Array.isArray(row))
    throw new Error("Invalid source audit result");
  const counts = {} as SourceBoundaryAuditCounts;
  for (const metric of metrics) {
    const value = (row as Record<string, unknown>)[metric];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new Error("Invalid source audit result");
    counts[metric] = value;
  }
  return {
    evidence: "local-metadata-only" as const,
    sourceBoundaryVerified: false as const,
    counts,
  };
}
