import type { AdifRecord } from "./adif.ts";
import { matchQrzHistory } from "./qrz.ts";
import { canonical, sha256 } from "./security.ts";
import type { LedgerKey, Store } from "./store.ts";
import { lotwMode } from "./signing.ts";

export interface ReconciliationEvidence {
  destination: "qrz" | "lotw";
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
    return evidence.destination === "lotw" && evidence.provenNewAfterCutover
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
  const normalizeLotw = (record: AdifRecord): AdifRecord => {
    const mode = lotwMode(
      record.MODE ?? "",
      record.SUBMODE || record.APP_LOTW_MODE,
    );
    const {
      SUBMODE: _submode,
      APP_LOTW_MODE: _lotwMode,
      APP_LOTW_MODEGROUP: _group,
      ...fields
    } = record;
    const supported = new Set([
      "STATION_CALLSIGN",
      "CALL",
      "QSO_DATE",
      "TIME_ON",
      "BAND",
      "FREQ",
      "FREQ_RX",
      "BAND_RX",
      "MODE",
      "PROP_MODE",
      "SAT_NAME",
      "MY_DXCC",
      "MY_GRIDSQUARE",
      "MY_STATE",
      "MY_CNTY",
      "MY_CQ_ZONE",
      "MY_ITU_ZONE",
      "MY_IOTA",
      "QSL_RCVD",
    ]);
    return {
      ...Object.fromEntries(
        Object.entries(fields).filter(([field]) => supported.has(field)),
      ),
      MODE: mode,
    };
  };
  let matchingSource = source;
  let matchingRemote = remote;
  if (evidence.destination === "lotw") {
    try {
      matchingSource = normalizeLotw(source);
      matchingRemote = remote.map(normalizeLotw);
    } catch {
      return result(
        "history_ambiguous",
        "LoTW individual mode mapping is unsupported",
      );
    }
  }
  if (evidence.destination === "lotw")
    for (const field of ["FREQ", "FREQ_RX"]) {
      const frequency = matchingSource[field];
      if (
        frequency &&
        (!/^\d+(?:\.\d+)?$/.test(frequency) ||
          (frequency.split(".")[1] ?? "").replace(/0+$/, "").length > 5)
      )
        return result(
          "history_ambiguous",
          `LoTW query cannot establish the transmitted precision of ${field}`,
        );
    }
  const match = matchQrzHistory(matchingSource, matchingRemote);
  if (match.state === "adopted_existing") {
    if (
      evidence.destination === "qrz" &&
      !/^\d+$/.test(match.record.APP_QRZLOG_LOGID ?? "")
    )
      return result(
        "history_ambiguous",
        "Matched QRZ record has no verified LOGID",
      );
    return { ...result("adopted_existing"), remote: match.record };
  }
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
/** Minimal identity tuple; no source narrative, station location or raw vendor data. */
export function canonicalLotwIdentity(record: AdifRecord): AdifRecord {
  const mode = lotwMode(
    record.MODE ?? "",
    record.SUBMODE || record.APP_LOTW_MODE,
  );
  return Object.fromEntries(
    [
      "STATION_CALLSIGN",
      "CALL",
      "QSO_DATE",
      "TIME_ON",
      "BAND",
      "MODE",
      "PROP_MODE",
      "SAT_NAME",
    ].map((field) => [
      field,
      (field === "MODE" ? mode : (record[field] ?? "")).toUpperCase(),
    ]),
  );
}
/** One stable association key for both adopted and Ferry-observed LoTW records. */
export async function lotwRemoteIdentity(record: AdifRecord): Promise<string> {
  return sha256(canonical(canonicalLotwIdentity(record)));
}
export function comparableRemote(record: AdifRecord): AdifRecord {
  return Object.fromEntries(
    COMPARABLE.filter((field) => Object.hasOwn(record, field)).map((field) => [
      field,
      record[field]!.toUpperCase(),
    ]),
  );
}
/**
 * Adopt only durable metadata: no destination client/signing primitive is available
 * here. A single guarded UPDATE performs generation CAS and remote-claim exclusion.
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
    (outcome.evidence.destination !== "lotw" ||
      !outcome.evidence.provenNewAfterCutover)
  )
    return { applied: false, reason: "cutover_unproven" };
  const remote = outcome.remote;
  if (outcome.state === "adopted_existing" && !remote)
    return { applied: false, reason: "remote_evidence_missing" };
  const remoteHash = remote
    ? await sha256(canonical(comparableRemote(remote)))
    : null;
  const remoteId = remote
    ? destination.kind === "qrz"
      ? (remote.APP_QRZLOG_LOGID ?? null)
      : await lotwRemoteIdentity(remote)
    : null;
  if (outcome.state === "adopted_existing" && !remoteId)
    return { applied: false, reason: "remote_identity_missing" };
  const retainedClaim =
    destination.kind === "lotw" && remoteId
      ? await store.lotwIdentityClaimGuard(key, remoteId)
      : { sql: "1", params: [] };
  const adoption = store.statement(
    `UPDATE ledger SET confirmed=COALESCE(?,confirmed),state=?,reason=?,baseline_hash=COALESCE(?,source_hash),source_hash=COALESCE(?,source_hash),remote_hash=?,remote_id=?,provenance=CASE WHEN ?='adopted_existing' THEN 'adopted' ELSE provenance END,narrative=CASE WHEN ?='adopted_existing' AND ?='qrz' THEN 'remote_preserved' ELSE narrative END,updated_at=? WHERE tenant=? AND source=? AND qso=? AND destination=? AND generation=? AND source_hash=? AND sent_hash IS NULL AND template_version IS NULL AND provenance!='ferry_created' AND NOT EXISTS(SELECT 1 FROM ledger other WHERE other.tenant=? AND other.destination=? AND other.remote_id=? AND (other.source!=? OR other.qso!=?)) AND NOT EXISTS(SELECT 1 FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE a.tenant=? AND a.source=? AND a.qso=? AND a.destination=? AND s.state NOT IN('delivered','observed','rejected','cancelled')) AND ${retainedClaim.sql}`,
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
  return { state: "observed", remoteId: exact[0]!.APP_QRZLOG_LOGID };
}
