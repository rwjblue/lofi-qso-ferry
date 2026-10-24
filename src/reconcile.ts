import type { AdifRecord } from "./adif.ts";
import {
  clearHistoricalAssociationLegacyReservation,
  historicalAssociationAvailable,
  historicalAssociationStatements,
  historicalQrzLogId,
} from "./historical-associations.ts";
import { historicalGridsCompatible } from "./historical-location.ts";
import { historicalCandidates } from "./historical-matching.ts";
import {
  availableIdentityClaim,
  destinationIdentityClaim,
  reserveIdentityClaim,
} from "./identity-claims.ts";
import { adoptLotwHistoricalBatch } from "./lotw-historical-adoption.ts";
import { classifyLotwHistoricalAssociation } from "./lotw-historical-classification.ts";
import {
  type LotwOwnershipWrite,
  prepareLotwOwnershipBatch,
} from "./lotw-ownership-bridge.ts";
import { matchQrzHistory, sameQrzIdentity } from "./qrz.ts";
import type { ReconciliationLedger } from "./reconciliation-work.ts";
import { canonical, randomToken, sha256 } from "./security.ts";
import { lotwMode } from "./signing.ts";
import type { Connection, LedgerKey, Store } from "./store.ts";

export interface AdoptionResult {
  applied: boolean;
  reason?: string;
}
export interface HistoryCommitGuard {
  sql: string;
  params: (string | number | null)[];
}
export interface HistoryAdoptionInput {
  key: LedgerKey;
  generation: string;
  outcome: ReconciliationOutcome;
  ledger: ReconciliationLedger;
  adoptedSourceHash?: string;
  commitGuard: (now: number) => HistoryCommitGuard;
}
interface AdoptionPlan {
  statements: D1PreparedStatement[];
  adoptionIndex: number;
  quarantineIndex?: number;
  ownership?: LotwOwnershipWrite;
  ownershipCurrent?: HistoryCommitGuard;
  ownershipHold?: AdoptionPlan;
  failureReason?: string;
}

function adoptionResult(plan: AdoptionPlan, rows: D1Result[]): AdoptionResult {
  if (rows[plan.adoptionIndex]?.results.length === 1) return { applied: true };
  return {
    applied: false,
    reason:
      plan.quarantineIndex !== undefined &&
      rows[plan.quarantineIndex]?.results.length === 1
        ? "remote_identity_claim_conflict"
        : (plan.failureReason ?? "generation_mapping_or_attempt_conflict"),
  };
}

/** Bounded commits retain each contact's proof and collision handling in one transaction. */
export async function adoptHistoryBatch(
  store: Store,
  source: Pick<Connection, "tenant" | "id">,
  items: readonly HistoryAdoptionInput[],
  now: () => number = Date.now,
): Promise<AdoptionResult[]> {
  if (items.length > 40) throw new Error("reconciliation_batch_too_large");
  const seen = new Set<string>();
  for (const item of items) {
    if (item.key.tenant !== source.tenant || item.key.source !== source.id)
      throw new Error("invalid_reconciliation_scope");
    const key = JSON.stringify([item.key.qso, item.key.destination]);
    if (seen.has(key)) throw new Error("duplicate_reconciliation_route");
    seen.add(key);
  }
  if (
    items.some(
      (item) =>
        item.outcome.associationOnly &&
        item.outcome.evidence.destination === "lotw",
    )
  ) {
    const results: AdoptionResult[] = [];
    for (let offset = 0; offset < items.length; offset += 8) {
      const chunk = items.slice(offset, offset + 8);
      const historical = chunk.filter(
        (item) =>
          item.outcome.associationOnly &&
          item.outcome.evidence.destination === "lotw",
      );
      const ordinary = chunk.filter((item) => !historical.includes(item));
      const historicalResults = await adoptLotwHistoricalBatch(
        store,
        source,
        historical,
        now,
      );
      const ordinaryResults = await adoptHistoryBatch(
        store,
        source,
        ordinary,
        now,
      );
      let historicalIndex = 0;
      let ordinaryIndex = 0;
      for (const item of chunk)
        results.push(
          historical.includes(item)
            ? historicalResults[historicalIndex++]
            : ordinaryResults[ordinaryIndex++],
        );
    }
    return results;
  }
  const results: AdoptionResult[] = [];
  // Eight exact LoTW mappings use at most 90 native statements, including
  // ownership reservations, accounting and collision quarantine.
  for (let offset = 0; offset < items.length; offset += 8) {
    const commitTime = now();
    const plans = await Promise.all(
      items
        .slice(offset, offset + 8)
        .map((item) =>
          prepareHistoryAdoption(
            store,
            item.key,
            item.generation,
            item.outcome,
            item.ledger,
            commitTime,
            item.adoptedSourceHash,
            item.commitGuard(commitTime),
          ),
        ),
    );
    // Skip already-stale mappings before reserving a common ownership plan.
    // Every original guard and mapping CAS is still checked atomically below;
    // a later race rolls back every provisional reservation in that chunk.
    const guarded = plans.flatMap((plan, index) =>
      "statements" in plan && plan.ownership && plan.ownershipCurrent
        ? [{ index, guard: plan.ownershipCurrent }]
        : [],
    );
    if (guarded.length) {
      const current = await store.db.batch(
        guarded.map(({ guard }) =>
          store.statement(
            `SELECT 1 AS current WHERE ${guard.sql}`,
            ...guard.params,
          ),
        ),
      );
      for (const [index, item] of guarded.entries())
        if (!current[index]?.results.length)
          plans[item.index] = {
            applied: false,
            reason: "source_generation_changed",
          };
    }
    const ownershipInputs = plans.flatMap((plan) =>
      "statements" in plan && plan.ownership ? [plan.ownership] : [],
    );
    let ownership:
      | Awaited<ReturnType<typeof prepareLotwOwnershipBatch>>
      | undefined;
    if (ownershipInputs.length)
      try {
        ownership = await prepareLotwOwnershipBatch(
          store,
          "mapping",
          ownershipInputs,
          commitTime,
          undefined,
          { partialMappings: true },
        );
        let ownershipIndex = 0;
        for (const [n, plan] of plans.entries()) {
          if (!("statements" in plan) || !plan.ownership) continue;
          if (ownership.excluded.includes(ownershipIndex++))
            plans[n] = plan.ownershipHold ?? {
              applied: false,
              reason: "lotw_ownership_unavailable",
            };
        }
      } catch {
        for (const [n, plan] of plans.entries())
          if ("statements" in plan && plan.ownership)
            plans[n] = plan.ownershipHold ?? {
              applied: false,
              reason: "lotw_ownership_unavailable",
            };
      }
    const statements = plans.flatMap((plan) =>
      "statements" in plan ? plan.statements : [],
    );
    let rows: D1Result[];
    try {
      const all = statements.length
        ? await store.db.batch([
            ...(ownership?.begin ?? []),
            ...statements,
            ...(ownership?.finish ?? []),
          ])
        : [];
      rows = all.slice(ownership?.begin.length ?? 0);
    } finally {
      await ownership?.release();
    }
    let index = 0;
    for (const plan of plans) {
      if (!("statements" in plan)) results.push(plan);
      else {
        results.push(
          adoptionResult(
            plan,
            rows.slice(index, index + plan.statements.length),
          ),
        );
        index += plan.statements.length;
      }
    }
  }
  return results;
}

export interface ReconciliationEvidence {
  destination: "qrz" | "lotw";
  capturedGeneration: string;
  currentGeneration: string;
  readAccess: boolean;
  inventoryComplete: boolean;
  catchupComplete: boolean;
  freshCheckComplete: boolean;
  /** Complete retained inventory may establish a positive association, never absence. */
  inventoryPositiveOnly?: boolean;
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
  /** Historical recognition cannot grant upload or correction authority. */
  associationOnly?: true;
  /** Added only after the complete reverse-source comparison succeeds. */
  associationProof?: {
    bookIdentity: string;
    commitGuard: (now: number) => HistoryCommitGuard;
  };
}
export const ADOPTION_CONFLICT_REASON =
  "Multiple source contacts claim one destination identity; review associations before exporting";
/** Included in scheduling policy fingerprints so changed matching rules revisit held work. */
export const HISTORICAL_MATCHING_VERSION = 5;
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
    (!evidence.freshCheckComplete && !evidence.inventoryPositiveOnly)
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
  let match = matchQrzHistory(matchingSource, matchingRemote);
  if (match.state === "history_mismatch") {
    const exact = matchingRemote.filter((record) =>
      sameQrzIdentity(matchingSource, record),
    );
    const candidate = exact.length === 1 ? exact[0] : undefined;
    const remoteGrid = candidate?.MY_GRIDSQUARE;
    if (
      candidate &&
      /^([01]\d|2[0-3])[0-5]\d[0-5]\d$/.test(candidate.TIME_ON ?? "") &&
      candidate.TIME_ON.length === 6 &&
      remoteGrid &&
      historicalGridsCompatible(matchingSource.MY_GRIDSQUARE, remoteGrid) &&
      // A nested Maidenhead region is compatible historical location evidence,
      // not proof that the full transmitted station projection is identical.
      // Every other comparison must agree; neither original record is changed.
      matchQrzHistory({ ...matchingSource, MY_GRIDSQUARE: remoteGrid }, [
        candidate,
      ]).state === "adopted_existing"
    )
      match = {
        state: "adopted_existing",
        record: remote[matchingRemote.indexOf(candidate)],
      };
  }
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
  if (
    match.state === "missing_current_identity" &&
    !evidence.freshCheckComplete
  )
    return result(
      "inventory_pending",
      "Shared history has no matching identity; a fresh targeted check is required before exporting",
    );
  return result(match.state, "reason" in match ? match.reason : null);
}

/**
 * Published vendor matching rules discover historical presence, never absence or an
 * upload identity. A positive result still needs reverse-source uniqueness and
 * durable association-only ownership before prepareHistoryAdoption accepts it.
 */
export function classifyHistoricalAssociation(
  source: AdifRecord,
  remote: AdifRecord[],
  evidence: ReconciliationEvidence,
): ReconciliationOutcome {
  const previous = classifyHistory(source, remote, evidence);
  if (evidence.destination === "lotw")
    return classifyLotwHistoricalAssociation(
      source,
      remote,
      evidence,
      previous,
    );
  if (
    evidence.destination !== "qrz" ||
    !evidence.capturedGeneration ||
    evidence.capturedGeneration !== evidence.currentGeneration ||
    !evidence.readAccess ||
    !evidence.inventoryComplete ||
    !evidence.catchupComplete ||
    (!evidence.freshCheckComplete && !evidence.inventoryPositiveOnly)
  )
    return previous;
  const held = (reason: string): ReconciliationOutcome => ({
    state: "history_ambiguous",
    reason,
    evidence,
  });
  const candidates = historicalCandidates("qrz", source, remote);
  if (candidates.state === "none")
    // Wider candidate discovery never expands existing absence authority.
    return previous.state === "adopted_existing"
      ? held("Historical candidate evidence cannot establish this association")
      : previous;
  if (candidates.state !== "unique")
    return held(
      candidates.issues.length
        ? "Historical candidate evidence is incomplete or unsupported"
        : "Multiple historical candidates fall within the matching window",
    );
  const candidate = candidates.candidates[0];
  if (!candidate.time.entireIntervalWithinWindow)
    return held(
      "Recorded time precision crosses the historical matching window",
    );
  if (!/^[0-9]{1,64}$/.test(candidate.record.APP_QRZLOG_LOGID ?? ""))
    return held("Matched QRZ record has no verified LOGID");

  // Identity has already been compared by the vendor policy. Align only a
  // temporary comparison view so the existing operating-detail checks can run
  // independently; original records and receipt comparisons remain untouched.
  const operating = { ...source };
  for (const field of [
    "QSO_DATE",
    "TIME_ON",
    "MODE",
    "SUBMODE",
    "PROP_MODE",
    "SAT_NAME",
  ]) {
    delete operating[field];
    if (candidate.record[field] !== undefined)
      operating[field] = candidate.record[field];
  }
  if (
    historicalGridsCompatible(
      source.MY_GRIDSQUARE,
      candidate.record.MY_GRIDSQUARE,
    )
  )
    operating.MY_GRIDSQUARE = candidate.record.MY_GRIDSQUARE;
  const match = matchQrzHistory(operating, [candidate.record]);
  if (match.state !== "adopted_existing")
    return {
      state: match.state,
      reason: "reason" in match ? match.reason : null,
      evidence,
    };
  return {
    state: "adopted_existing",
    reason: null,
    evidence,
    remote: candidate.record,
    associationOnly: true,
  };
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
      record[field].toUpperCase(),
    ]),
  );
}
/**
 * Adopt only durable metadata: no destination client/signing primitive is available
 * here. A guarded UPDATE performs generation CAS and remote-claim exclusion.
 * Trusted delivery/template provenance wins over a fresh inventory classification.
 */
export async function adoptHistory(
  store: Store,
  key: LedgerKey,
  generation: string,
  outcome: ReconciliationOutcome,
  now = Date.now(),
  adoptedSourceHash?: string,
  inventoryGuard?: { sql: string; params: (string | number | null)[] },
): Promise<AdoptionResult> {
  const ledger = await store
    .statement(
      "SELECT l.*,d.kind AS destination_kind FROM ledger l JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination WHERE l.tenant=? AND l.source=? AND l.qso=? AND l.destination=?",
      key.tenant,
      key.source,
      key.qso,
      key.destination,
    )
    .first<ReconciliationLedger>();
  if (outcome.associationOnly && outcome.evidence.destination === "lotw") {
    if (!ledger || !inventoryGuard)
      return { applied: false, reason: "historical_comparison_proof_required" };
    const [result] = await adoptLotwHistoricalBatch(
      store,
      { tenant: key.tenant, id: key.source },
      [
        {
          key,
          generation,
          outcome,
          ledger,
          adoptedSourceHash,
          commitGuard: () => inventoryGuard,
        },
      ],
      () => now,
    );
    return result;
  }
  let plan = await prepareHistoryAdoption(
    store,
    key,
    generation,
    outcome,
    ledger,
    now,
    adoptedSourceHash,
    inventoryGuard,
  );
  if (!("statements" in plan)) return plan;
  if (
    plan.ownership &&
    plan.ownershipCurrent &&
    !(await store
      .statement(
        `SELECT 1 AS current WHERE ${plan.ownershipCurrent.sql}`,
        ...plan.ownershipCurrent.params,
      )
      .first())
  )
    return { applied: false, reason: "source_generation_changed" };
  let ownership:
    | Awaited<ReturnType<typeof prepareLotwOwnershipBatch>>
    | undefined;
  if (plan.ownership)
    try {
      ownership = await prepareLotwOwnershipBatch(
        store,
        "mapping",
        [plan.ownership],
        now,
      );
    } catch {
      if (!plan.ownershipHold)
        return { applied: false, reason: "lotw_ownership_unavailable" };
      plan = plan.ownershipHold;
    }
  try {
    const rows = await store.db.batch([
      ...(ownership?.begin ?? []),
      ...plan.statements,
      ...(ownership?.finish ?? []),
    ]);
    return adoptionResult(plan, rows.slice(ownership?.begin.length ?? 0));
  } finally {
    await ownership?.release();
  }
}

async function prepareHistoryAdoption(
  store: Store,
  key: LedgerKey,
  generation: string,
  outcome: ReconciliationOutcome,
  ledger: ReconciliationLedger | null,
  now: number,
  adoptedSourceHash?: string,
  inventoryGuard?: HistoryCommitGuard,
): Promise<AdoptionPlan | AdoptionResult> {
  if (
    !ledger ||
    ledger.tenant !== key.tenant ||
    ledger.source !== key.source ||
    ledger.qso !== key.qso ||
    ledger.destination !== key.destination ||
    ledger.destination_kind !== outcome.evidence.destination
  )
    return { applied: false, reason: "tenant_or_destination_missing" };
  if (
    outcome.evidence.capturedGeneration !== generation ||
    outcome.evidence.currentGeneration !== generation ||
    ledger.generation !== generation
  )
    return { applied: false, reason: "source_generation_changed" };
  if (ledger.provenance === "adoption_conflict")
    return { applied: false, reason: "remote_identity_claim_conflict" };
  if (ledger.remote_id || ledger.lotw_historical_association_id)
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
      (!evidence.freshCheckComplete &&
        !(
          outcome.state === "adopted_existing" && evidence.inventoryPositiveOnly
        ))
    )
      return { applied: false, reason: "incomplete_evidence" };
  }
  if (
    outcome.state === "live_new" &&
    (outcome.evidence.destination !== "lotw" ||
      !outcome.evidence.provenNewAfterCutover)
  )
    return { applied: false, reason: "cutover_unproven" };
  if (
    outcome.state === "adopted_existing" &&
    outcome.evidence.inventoryPositiveOnly &&
    !inventoryGuard
  )
    return { applied: false, reason: "inventory_commit_guard_required" };
  if (outcome.associationOnly) {
    if (
      outcome.state !== "adopted_existing" ||
      ledger.destination_kind !== "qrz" ||
      !inventoryGuard ||
      !outcome.associationProof?.bookIdentity
    )
      return { applied: false, reason: "historical_comparison_proof_required" };
    const comparison = outcome.associationProof.commitGuard(now);
    inventoryGuard = {
      sql: `(${inventoryGuard.sql}) AND (${comparison.sql})`,
      params: [...inventoryGuard.params, ...comparison.params],
    };
  }
  const guardId = inventoryGuard ? randomToken() : null;
  const guardStart =
    inventoryGuard && guardId
      ? store.statement(
          `INSERT INTO history_adoption_guards(id) SELECT ? WHERE ${inventoryGuard.sql}`,
          guardId,
          ...inventoryGuard.params,
        )
      : null;
  const guardEnd = guardId
    ? store.statement("DELETE FROM history_adoption_guards WHERE id=?", guardId)
    : null;
  const currentInventory = guardId
    ? {
        sql: "EXISTS(SELECT 1 FROM history_adoption_guards WHERE id=?)",
        params: [guardId],
      }
    : { sql: "1", params: [] };
  const remote = outcome.remote;
  if (outcome.state === "adopted_existing" && !remote)
    return { applied: false, reason: "remote_evidence_missing" };
  const remoteHash = remote
    ? await sha256(canonical(comparableRemote(remote)))
    : null;
  const remoteId = remote
    ? ledger.destination_kind === "qrz"
      ? (remote.APP_QRZLOG_LOGID ?? null)
      : await lotwRemoteIdentity(remote)
    : null;
  if (outcome.state === "adopted_existing" && !remoteId)
    return { applied: false, reason: "remote_identity_missing" };
  const priorClaim =
    ledger.destination_kind === "lotw" && remoteId
      ? await store.lotwIdentityClaimGuard(key, remoteId)
      : { sql: "1", params: [] };
  const outboundIdentity =
    remote && !outcome.associationOnly
      ? await destinationIdentityClaim(
          ledger.destination_kind === "qrz" ? "qrz" : "lotw",
          remote,
        )
      : null;
  const outboundAvailable = outboundIdentity
    ? availableIdentityClaim(key, outboundIdentity)
    : { sql: "1", params: [] };
  const historicalIdentity =
    outcome.associationOnly && outcome.associationProof && remoteId
      ? {
          vendor: "qrz" as const,
          bookIdentity: outcome.associationProof.bookIdentity,
          remoteId,
        }
      : null;
  const historicalAvailable =
    ledger.destination_kind === "qrz" && remoteId
      ? historicalAssociationAvailable(
          key,
          remoteId,
          historicalIdentity?.bookIdentity,
        )
      : { sql: "1", params: [] };
  const retainedClaim = {
    sql: `(${priorClaim.sql}) AND (${outboundAvailable.sql}) AND (${historicalAvailable.sql})`,
    params: [
      ...priorClaim.params,
      ...outboundAvailable.params,
      ...historicalAvailable.params,
    ],
  };
  const adoption = store.statement(
    `UPDATE ledger SET confirmed=COALESCE(?,confirmed),state=?,reason=?,baseline_hash=COALESCE(?,source_hash),source_hash=COALESCE(?,source_hash),remote_hash=?,remote_id=?,provenance=CASE WHEN ?='adopted_existing' THEN 'adopted' ELSE provenance END,narrative=CASE WHEN ?='adopted_existing' AND ?='qrz' THEN 'remote_preserved' ELSE narrative END,updated_at=? WHERE tenant=? AND source=? AND qso=? AND destination=? AND generation=? AND source_hash=? AND remote_id IS NULL AND lotw_historical_association_id IS NULL AND state!='changed' AND sent_hash IS NULL AND template_version IS NULL AND provenance NOT IN('ferry_created','adoption_conflict') AND NOT EXISTS(SELECT 1 FROM ledger other WHERE other.tenant=? AND other.destination=? AND other.remote_id=? AND (other.source!=? OR other.qso!=?)) AND NOT EXISTS(SELECT 1 FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE a.tenant=? AND a.source=? AND a.qso=? AND a.destination=? AND s.state NOT IN('delivered','observed','rejected','cancelled')) AND EXISTS(SELECT 1 FROM connections d WHERE d.tenant=ledger.tenant AND d.id=ledger.destination AND d.kind=?) AND ${retainedClaim.sql} AND (${currentInventory.sql}) RETURNING qso`,
    outcome.state === "adopted_existing" && ledger.destination_kind === "lotw"
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
    ledger.destination_kind,
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
    ledger.destination_kind,
    ...retainedClaim.params,
    ...currentInventory.params,
  );
  let privateEnvelope: string | undefined;
  const identity =
    ledger.destination_kind === "lotw" && remote && remoteId
      ? await store.lotwIdentityStatement(
          key,
          { remoteId, identity: canonicalLotwIdentity(remote) },
          "adopted",
          now,
          {
            sql: `EXISTS(SELECT 1 FROM ledger WHERE tenant=? AND source=? AND qso=? AND destination=? AND generation=? AND state='adopted_existing' AND remote_id=? AND provenance='adopted') AND (${currentInventory.sql})`,
            params: [
              key.tenant,
              key.source,
              key.qso,
              key.destination,
              generation,
              remoteId,
              ...currentInventory.params,
            ],
          },
          (value) => {
            privateEnvelope = value;
          },
        )
      : null;
  const statements = [
    ...(guardStart ? [guardStart] : []),
    adoption,
    ...(historicalIdentity
      ? (() => {
          const guard = {
            sql: `EXISTS(SELECT 1 FROM ledger WHERE tenant=? AND source=? AND qso=? AND destination=? AND generation=? AND state='adopted_existing' AND remote_id=? AND provenance='adopted') AND (${currentInventory.sql})`,
            params: [
              key.tenant,
              key.source,
              key.qso,
              key.destination,
              generation,
              remoteId,
              ...currentInventory.params,
            ],
          };
          return [
            ...historicalAssociationStatements(
              store,
              key,
              historicalIdentity,
              now,
              guard,
            ),
            clearHistoricalAssociationLegacyReservation(
              store,
              key,
              historicalIdentity,
              guard,
            ),
          ];
        })()
      : []),
    ...(identity ? [identity] : []),
    ...(outboundIdentity
      ? [
          reserveIdentityClaim(store, key, outboundIdentity, now, {
            sql: `EXISTS(SELECT 1 FROM ledger WHERE tenant=? AND source=? AND qso=? AND destination=? AND generation=? AND state='adopted_existing' AND remote_id=? AND provenance='adopted') AND (${currentInventory.sql})`,
            params: [
              key.tenant,
              key.source,
              key.qso,
              key.destination,
              generation,
              remoteId,
              ...currentInventory.params,
            ],
          }),
        ]
      : []),
    ...(outboundIdentity?.vendor === "qrz"
      ? [
          store.statement(
            `DELETE FROM legacy_qrz_identity_reservations WHERE tenant=? AND destination=? AND source=? AND qso=? AND remote_id=? AND EXISTS(SELECT 1 FROM ledger l JOIN destination_identity_claims c ON c.tenant=l.tenant AND c.destination=l.destination AND c.source=l.source AND c.qso=l.qso AND c.vendor='qrz' AND c.identity_hash=? WHERE l.tenant=? AND l.source=? AND l.qso=? AND l.destination=? AND l.generation=? AND l.state='adopted_existing' AND l.remote_id=? AND l.provenance='adopted') AND (${currentInventory.sql})`,
            key.tenant,
            key.destination,
            key.source,
            key.qso,
            remoteId,
            outboundIdentity.hash,
            key.tenant,
            key.source,
            key.qso,
            key.destination,
            generation,
            remoteId,
            ...currentInventory.params,
          ),
        ]
      : []),
  ];
  const adoptionIndex = guardStart ? 1 : 0;
  let quarantineIndex: number | undefined;
  if (outcome.state === "adopted_existing" && remoteId) {
    // A failed CAS alone is not an identity conflict. Fence this diagnosis to
    // the same unbound source revision and an actual competing remote claim.
    // The proof row keeps nested collision checks below D1's expression
    // depth limit; insertion, checks and deletion share one transaction.
    const contenderWhere = `contender.tenant=? AND contender.source=? AND contender.qso=? AND contender.destination=? AND contender.generation=? AND contender.source_hash=? AND contender.remote_id IS NULL AND contender.sent_hash IS NULL AND contender.template_version IS NULL AND contender.provenance!='ferry_created' AND NOT EXISTS(SELECT 1 FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE a.tenant=contender.tenant AND a.source=contender.source AND a.qso=contender.qso AND a.destination=contender.destination AND s.state NOT IN('delivered','observed','rejected','cancelled')) AND (EXISTS(SELECT 1 FROM ledger other WHERE other.tenant=contender.tenant AND other.destination=contender.destination AND other.remote_id=? AND (other.source!=contender.source OR other.qso!=contender.qso)) OR NOT (${retainedClaim.sql})) AND (${currentInventory.sql})`;
    const contenderParams = [
      key.tenant,
      key.source,
      key.qso,
      key.destination,
      generation,
      ledger.source_hash,
      remoteId,
      ...retainedClaim.params,
      ...currentInventory.params,
    ];
    const conflictExists = `EXISTS(SELECT 1 FROM ledger contender WHERE ${contenderWhere} AND contender.provenance='adoption_conflict')`;
    const retainedOwner = {
      sql:
        ledger.destination_kind === "qrz"
          ? "EXISTS(SELECT 1 FROM historical_remote_owners h JOIN connections target ON target.tenant=h.tenant AND target.id=? AND target.kind='qrz' AND target.remote_identity=h.book_identity WHERE h.tenant=owner.tenant AND h.vendor='qrz' AND h.source=owner.source AND h.qso=owner.qso AND h.remote_id=? AND (h.destination=owner.destination OR EXISTS(SELECT 1 FROM connections d WHERE d.tenant=owner.tenant AND d.id=owner.destination AND d.kind='qrz' AND d.remote_identity=h.book_identity)))"
          : "0",
      params:
        ledger.destination_kind === "qrz"
          ? [key.destination, historicalQrzLogId(remoteId)]
          : [],
    };
    const ownerScope = `owner.tenant=? AND (owner.destination=? OR ${retainedOwner.sql})`;
    const ownerIdentity = `(owner.remote_id=? OR EXISTS(SELECT 1 FROM destination_identity_claims claimed WHERE claimed.tenant=owner.tenant AND claimed.destination=owner.destination AND claimed.source=owner.source AND claimed.qso=owner.qso AND claimed.vendor=? AND claimed.identity_hash=?) OR ${retainedOwner.sql})`;
    const ownerWhere = `${ownerScope} AND ${ownerIdentity} AND owner.provenance='adoption_conflict' AND ${conflictExists}`;
    const ownerParams = [
      key.tenant,
      key.destination,
      ...retainedOwner.params,
      remoteId,
      outboundIdentity?.vendor ?? ledger.destination_kind,
      outboundIdentity?.hash ?? "",
      ...retainedOwner.params,
      ...contenderParams,
    ];
    quarantineIndex = statements.length;
    statements.push(
      store.statement(
        `UPDATE ledger AS contender SET state='history_ambiguous',provenance='adoption_conflict',reason=?,updated_at=? WHERE ${contenderWhere} RETURNING qso`,
        ADOPTION_CONFLICT_REASON,
        now,
        ...contenderParams,
      ),
      store.statement(
        `UPDATE ledger AS owner SET state='history_ambiguous',provenance='adoption_conflict',reason=?,updated_at=? WHERE ${ownerScope} AND ${ownerIdentity} AND owner.provenance='adopted' AND owner.sent_hash IS NULL AND owner.template_version IS NULL AND NOT EXISTS(SELECT 1 FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE a.tenant=owner.tenant AND a.source=owner.source AND a.qso=owner.qso AND a.destination=owner.destination AND s.state NOT IN('prepared','rejected','cancelled')) AND ${conflictExists}`,
        ADOPTION_CONFLICT_REASON,
        now,
        ...ownerParams,
      ),
      store.statement(
        `INSERT INTO attempt_events(tenant,attempt,state,at,reason) SELECT s.tenant,s.attempt,'cancelled',?,? FROM attempt_state s JOIN attempts a ON a.tenant=s.tenant AND a.id=s.attempt JOIN ledger owner ON owner.tenant=a.tenant AND owner.source=a.source AND owner.qso=a.qso AND owner.destination=a.destination WHERE s.state='prepared' AND ${ownerWhere}`,
        now,
        ADOPTION_CONFLICT_REASON,
        ...ownerParams,
      ),
      store.statement(
        `UPDATE attempt_state SET state='cancelled',reason=?,updated_at=? WHERE state='prepared' AND EXISTS(SELECT 1 FROM attempts a JOIN ledger owner ON owner.tenant=a.tenant AND owner.source=a.source AND owner.qso=a.qso AND owner.destination=a.destination WHERE a.tenant=attempt_state.tenant AND a.id=attempt_state.attempt AND ${ownerWhere})`,
        ADOPTION_CONFLICT_REASON,
        now,
        ...ownerParams,
      ),
    );
  }
  if (guardEnd) statements.push(guardEnd);
  return {
    statements,
    adoptionIndex,
    quarantineIndex,
    ...(ledger.destination_kind === "lotw" &&
    outcome.state === "adopted_existing" &&
    remote &&
    remoteId
      ? {
          ownershipCurrent: inventoryGuard,
          // Ownership failure cannot map or reserve, but the preexisting exact
          // claim collision diagnosis remains useful and independently fenced.
          ownershipHold: {
            statements: [
              ...(guardStart ? [guardStart] : []),
              ...(quarantineIndex === undefined
                ? []
                : statements.slice(quarantineIndex, quarantineIndex + 4)),
              ...(guardEnd ? [guardEnd] : []),
            ],
            adoptionIndex: -1,
            quarantineIndex:
              quarantineIndex === undefined ? undefined : guardStart ? 1 : 0,
            failureReason: "lotw_ownership_unavailable",
          },
          ownership: {
            ...key,
            generation,
            sourceHash: ledger.source_hash,
            identity: { identity: canonicalLotwIdentity(remote), remoteId },
            privateEnvelope,
          },
        }
      : {}),
  };
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
