import type { AdifRecord } from "./adif.ts";
import {
  canonicalLotwIdentity,
  destinationAdapter,
} from "./destination-adapters.ts";
import { type DestinationKind, isDestinationKind } from "./providers.ts";
import { canonical, sha256 } from "./security.ts";
import type { LedgerKey, Store } from "./store.ts";

export {
  canonicalLotwIdentity,
  lotwRemoteIdentity,
} from "./destination-adapters.ts";

export interface ReconciliationEvidence {
  destination: DestinationKind;
  capturedGeneration: string;
  currentGeneration: string;
  readAccess: boolean;
  inventoryComplete: boolean;
  catchupComplete: boolean;
  freshCheckComplete: boolean;
  /** Server-intake cutover, never device-authored contact time. */
  provenNewAfterCutover?: boolean;
}
export type ReconciliationState =
  | "inventory_pending"
  | "adopted_existing"
  | "missing_current_identity"
  | "history_mismatch"
  | "history_ambiguous"
  | "historical_unverified"
  | "live_new";
export interface ReconciliationOutcome {
  state: ReconciliationState;
  reason: string | null;
  evidence: ReconciliationEvidence;
  remote?: AdifRecord;
}
/** Pure read-only classification. Partial evidence is never transformed into absence. */
export function classifyHistory(
  source: AdifRecord,
  remote: AdifRecord[],
  evidence: ReconciliationEvidence,
): ReconciliationOutcome {
  const result = (
    state: ReconciliationState,
    reason: string | null = null,
  ): ReconciliationOutcome => ({ state, reason, evidence });
  if (
    !evidence.capturedGeneration ||
    evidence.capturedGeneration !== evidence.currentGeneration
  )
    return result(
      "inventory_pending",
      "Source changed during inventory; recheck the current generation",
    );
  if (!evidence.readAccess)
    return destinationAdapter(evidence.destination).capabilities
      .submissionOnly && evidence.provenNewAfterCutover
      ? result(
          "live_new",
          "Submission-only coverage; historical records remain unverified",
        )
      : result(
          "historical_unverified",
          "Destination read access is unavailable",
        );
  if (
    !evidence.inventoryComplete ||
    !evidence.catchupComplete ||
    !evidence.freshCheckComplete
  )
    return result(
      "inventory_pending",
      "Inventory, catch-up or fresh identity coverage is incomplete",
    );
  const match = destinationAdapter(evidence.destination).matchHistory(
    source,
    remote,
  );
  if (match.state === "adopted_existing")
    return { ...result("adopted_existing"), remote: match.record };
  return result(match.state, "reason" in match ? match.reason : null);
}
const COMPARABLE = [
  "STATION_CALLSIGN",
  "CALL",
  "QSO_DATE",
  "TIME_ON",
  "BAND",
  "MODE",
  "SUBMODE",
  "PROP_MODE",
  "SAT_NAME",
  "MY_GRIDSQUARE",
  "MY_STATE",
  "MY_CNTY",
  "MY_DXCC",
  "MY_LAT",
  "MY_LON",
  "MY_CQ_ZONE",
  "MY_ITU_ZONE",
  "MY_IOTA",
  "FREQ",
  "FREQ_RX",
  "BAND_RX",
];
export function comparableRemote(record: AdifRecord): AdifRecord {
  return Object.fromEntries(
    COMPARABLE.filter((field) => Object.hasOwn(record, field)).map((field) => [
      field,
      record[field].toUpperCase(),
    ]),
  );
}
/**
 * Adopt only durable metadata without invoking destination read/write APIs.
 * A single guarded UPDATE performs generation CAS and remote-claim exclusion.
 * Trusted delivery/template provenance wins over a fresh inventory classification.
 */
export async function adoptHistory(
  store: Store,
  key: LedgerKey,
  generation: string,
  outcome: ReconciliationOutcome,
  now = Date.now(),
  adoptedSourceHash?: string,
): Promise<{ applied: boolean; reason?: string }> {
  const ledger = await store.ledger(key);
  const destination = await store.connection(key.tenant, key.destination);
  if (
    !ledger ||
    !destination ||
    destination.kind !== outcome.evidence.destination
  )
    return { applied: false, reason: "tenant_or_destination_missing" };
  if (
    outcome.evidence.capturedGeneration !== generation ||
    outcome.evidence.currentGeneration !== generation ||
    ledger.generation !== generation
  )
    return { applied: false, reason: "source_generation_changed" };
  if (ledger.remote_id)
    return { applied: false, reason: "trusted_mapping_preserved" };
  if (
    outcome.state === "missing_current_identity" ||
    outcome.state === "adopted_existing"
  ) {
    const evidence = outcome.evidence;
    if (
      !evidence.readAccess ||
      !evidence.inventoryComplete ||
      !evidence.catchupComplete ||
      !evidence.freshCheckComplete
    )
      return { applied: false, reason: "incomplete_evidence" };
  }
  if (
    outcome.state === "live_new" &&
    (!destinationAdapter(outcome.evidence.destination).capabilities
      .submissionOnly ||
      !outcome.evidence.provenNewAfterCutover)
  )
    return { applied: false, reason: "cutover_unproven" };
  const remote = outcome.remote;
  if (outcome.state === "adopted_existing" && !remote)
    return { applied: false, reason: "remote_evidence_missing" };
  const remoteHash = remote
    ? await sha256(canonical(comparableRemote(remote)))
    : null;
  const remoteId =
    remote && isDestinationKind(destination.kind)
      ? await destinationAdapter(destination.kind).remoteIdentity(remote)
      : null;
  if (outcome.state === "adopted_existing" && !remoteId)
    return { applied: false, reason: "remote_identity_missing" };
  const reservationId = remote
    ? await destinationAdapter(
        outcome.evidence.destination,
      ).reservationIdentity?.(remote)
    : null;
  const retainedClaim =
    destination.kind === "lotw" && remoteId
      ? await store.lotwIdentityClaimGuard(key, remoteId)
      : reservationId && remoteId
        ? await store.remoteIdentityClaimGuard(key, remoteId)
        : { sql: "1", params: [] };
  if (reservationId && reservationId !== remoteId) {
    const claim = await store.remoteIdentityClaimGuard(key, reservationId);
    retainedClaim.sql += ` AND ${claim.sql}`;
    retainedClaim.params.push(...claim.params);
  }
  const adoption = store.statement(
    `UPDATE ledger SET confirmed=COALESCE(?,confirmed),state=?,reason=?,baseline_hash=COALESCE(?,source_hash),source_hash=COALESCE(?,source_hash),remote_hash=?,remote_id=?,provenance=CASE WHEN ?='adopted_existing' THEN 'adopted' ELSE provenance END,narrative=CASE WHEN ?='adopted_existing' AND ?='qrz' THEN 'remote_preserved' ELSE narrative END,updated_at=? WHERE tenant=? AND source=? AND qso=? AND destination=? AND generation=? AND source_hash=? AND state NOT IN('source_deleted','retained_old_route') AND sent_hash IS NULL AND template_version IS NULL AND provenance!='ferry_created' AND NOT EXISTS(SELECT 1 FROM ledger other WHERE other.tenant=? AND other.destination=? AND other.remote_id=? AND (other.source!=? OR other.qso!=?)) AND NOT EXISTS(SELECT 1 FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE a.tenant=? AND a.source=? AND a.qso=? AND a.destination=? AND s.state NOT IN('delivered','observed','rejected','cancelled')) AND ${retainedClaim.sql}`,
    outcome.state === "adopted_existing" && destination.kind === "lotw"
      ? outcome.remote?.QSL_RCVD === "Y"
        ? 1
        : 0
      : null,
    outcome.state,
    outcome.reason,
    outcome.state === "adopted_existing" ? (adoptedSourceHash ?? null) : null,
    outcome.state === "adopted_existing" ? (adoptedSourceHash ?? null) : null,
    remoteHash,
    remoteId,
    outcome.state,
    outcome.state,
    destination.kind,
    now,
    key.tenant,
    key.source,
    key.qso,
    key.destination,
    generation,
    ledger.source_hash,
    key.tenant,
    key.destination,
    remoteId,
    key.source,
    key.qso,
    key.tenant,
    key.source,
    key.qso,
    key.destination,
    ...retainedClaim.params,
  );
  const identity =
    destination.kind === "lotw" && remote && remoteId
      ? await store.lotwIdentityStatement(
          key,
          { remoteId, identity: canonicalLotwIdentity(remote) },
          "adopted",
          now,
          {
            sql: "EXISTS(SELECT 1 FROM ledger WHERE tenant=? AND source=? AND qso=? AND destination=? AND generation=? AND state='adopted_existing' AND remote_id=? AND provenance='adopted')",
            params: [
              key.tenant,
              key.source,
              key.qso,
              key.destination,
              generation,
              remoteId,
            ],
          },
        )
      : null;
  const [result] = await store.db.batch([
    adoption,
    ...(identity ? [identity] : []),
  ]);
  if (result.meta.changes !== 1)
    return { applied: false, reason: "generation_mapping_or_attempt_conflict" };
  return { applied: true };
}
/** Uncertain absence never authorizes resubmission; only exact revision observation settles it. */
export function reconcileQrzAttempt(
  payload: AdifRecord,
  candidates: AdifRecord[],
): { state: "observed" | "unresolved"; remoteId?: string; reason?: string } {
  const exact = candidates.filter((record) =>
    Object.entries(payload).every(([field, value]) => record[field] === value),
  );
  if (exact.length !== 1 || !/^\d+$/.test(exact[0]?.APP_QRZLOG_LOGID ?? ""))
    return {
      state: "unresolved",
      reason:
        "No unique observation of the exact transmitted revision; do not resend blindly",
    };
  return { state: "observed", remoteId: exact[0].APP_QRZLOG_LOGID };
}
