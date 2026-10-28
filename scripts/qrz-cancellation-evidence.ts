/** Operator metadata evidence only. This never grants export or retry authority. */
const reasons = new Set([
  "source_export_proof_unavailable",
  "outbound_identity_evidence_changed",
  "source changed before dispatch",
  "source routing changed before dispatch",
  "source membership unavailable",
  "source tombstone",
  "test_operation_not_exported",
]);
type Row = Record<string, unknown>;
const object = (value: unknown): value is Row =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const stamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 1_577_836_800_000;
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

/** The complete native event history must be exactly prepared -> cancelled. */
export function knownUnsentQrzCancellation(attempt: Row): boolean {
  if (
    attempt.state !== "cancelled" ||
    attempt.vendor !== "qrz" ||
    attempt.authorization_mode !== "qrz_fresh_insert" ||
    attempt.dispatched_at !== null ||
    attempt.remote_id !== null ||
    attempt.artifactRetained !== 1 ||
    typeof attempt.proof_id !== "string" ||
    !attempt.proof_id ||
    !stamp(attempt.created_at) ||
    !stamp(attempt.updated_at) ||
    attempt.updated_at < attempt.created_at
  )
    return false;
  let evidence: unknown = attempt.cancellationEvidence;
  if (typeof evidence === "string") {
    try {
      evidence = JSON.parse(evidence);
    } catch {
      return false;
    }
  }
  if (
    !object(evidence) ||
    evidence.eventCount !== 2 ||
    evidence.proofPinCount !== 1 ||
    evidence.linkedClaimCount !== 1 ||
    !Array.isArray(evidence.events) ||
    evidence.events.length !== 2
  )
    return false;
  const [prepared, cancelled] = evidence.events;
  return (
    object(prepared) &&
    object(cancelled) &&
    positive(prepared.id) &&
    positive(cancelled.id) &&
    prepared.id < cancelled.id &&
    prepared.state === "prepared" &&
    prepared.at === attempt.created_at &&
    prepared.reason === null &&
    cancelled.state === "cancelled" &&
    cancelled.at === attempt.updated_at &&
    typeof cancelled.reason === "string" &&
    reasons.has(cancelled.reason) &&
    (evidence.stateReason === null || evidence.stateReason === cancelled.reason)
  );
}

/** Wrap the monitor's complete attempt SELECT as alias a; no input interpolation. */
export const cancellationEvidenceSql = `CASE WHEN a.state='cancelled' THEN json_object(
 'stateReason',(SELECT s.reason FROM attempt_state s WHERE s.tenant=a.tenant AND s.attempt=a.attempt),
 'eventCount',(SELECT COUNT(*) FROM attempt_events e WHERE e.tenant=a.tenant AND e.attempt=a.attempt),
 'events',json((SELECT json_group_array(json_object('id',e.id,'state',e.state,'at',e.at,'reason',e.reason)) FROM
   (SELECT id,state,at,reason FROM attempt_events WHERE tenant=a.tenant AND attempt=a.attempt ORDER BY id LIMIT 3) e)),
 'proofPinCount',(SELECT COUNT(*) FROM attempt_source_export_proofs pin JOIN source_export_proofs p
   ON p.tenant=pin.tenant AND p.id=pin.proof_id WHERE pin.tenant=a.tenant AND pin.attempt=a.attempt
   AND pin.proof_id=a.proof_id AND pin.authorization_mode='qrz_fresh_insert'
   AND p.source=a.source AND p.qso=a.qso AND json_extract(p.proof,'$.generation')=a.generation),
 'linkedClaimCount',(SELECT COUNT(*) FROM attempt_identity_claims i JOIN destination_identity_claims d
   ON d.tenant=i.tenant AND d.destination=i.destination AND d.vendor=i.vendor AND d.identity_hash=i.identity_hash
   WHERE i.tenant=a.tenant AND i.attempt=a.attempt AND i.destination=a.destination AND i.vendor='qrz'
   AND i.source=a.source AND i.qso=a.qso AND d.source=a.source AND d.qso=a.qso)
) ELSE NULL END`;
