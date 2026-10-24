import type { AdifRecord } from "./adif.ts";
import { historicalCandidates } from "./historical-matching.ts";
import {
  LotwHistoricalUnavailable,
  prepareLotwHistoricalAssociations,
} from "./lotw-historical-associations.ts";
import {
  type AdoptionResult,
  comparableRemote,
  type HistoryAdoptionInput,
  type HistoryCommitGuard,
} from "./reconcile.ts";
import { canonical, sha256 } from "./security.ts";
import type { Connection, Store } from "./store.ts";

const encoder = new TextEncoder();
const eligibleLedger = `tenant=? AND source=? AND qso=? AND destination=? AND generation=? AND source_hash=?
 AND remote_id IS NULL AND remote_hash IS NULL AND confirmed=0 AND state!='changed' AND sent_hash IS NULL AND template_version IS NULL AND provenance='unknown'
 AND EXISTS(SELECT 1 FROM accounts WHERE id=ledger.tenant AND status='active')
 AND EXISTS(SELECT 1 FROM connections WHERE tenant=ledger.tenant AND id=ledger.source AND kind='lofi' AND status='active')
 AND EXISTS(SELECT 1 FROM connections WHERE tenant=ledger.tenant AND id=ledger.destination AND kind='lotw' AND status='active')
 AND NOT EXISTS(SELECT 1 FROM lotw_ownership_unsafe_attempts a WHERE a.tenant=ledger.tenant AND a.source=ledger.source AND a.qso=ledger.qso)`;
const rejected = (reason: string): AdoptionResult => ({
  applied: false,
  reason,
});
function comparisonRecord(record: AdifRecord) {
  return Object.fromEntries(
    Object.entries(record).filter(
      ([key, value]) =>
        value !== "" || (key !== "PROP_MODE" && key !== "SAT_NAME"),
    ),
  );
}
function captureGuard(guard: HistoryCommitGuard): HistoryCommitGuard {
  if (
    !guard?.sql?.trim() ||
    !Array.isArray(guard.params) ||
    guard.params.some(
      (value) =>
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "number",
    )
  )
    throw new Error("invalid_lotw_historical_commit_guard");
  return { sql: guard.sql, params: [...guard.params] };
}

/** Positive historical recognition only. One native transaction publishes raw
 * evidence, permanent write blocks and all ledger winners. No exact receipt ID,
 * source hash or upload authority is synthesized. A thrown/unknown batch outcome
 * is never retried here; callers must reload durable state before further work.
 */
export async function adoptLotwHistoricalBatch(
  store: Store,
  source: Pick<Connection, "tenant" | "id">,
  items: readonly HistoryAdoptionInput[],
  now: () => number = Date.now,
): Promise<AdoptionResult[]> {
  if (items.length > 8)
    throw new Error("lotw_historical_adoption_batch_too_large");
  const tenant = source.tenant,
    sourceId = source.id,
    owners = new Set<string>();
  for (const item of items) {
    if (item.key.tenant !== tenant || item.key.source !== sourceId)
      throw new Error("invalid_reconciliation_scope");
    // One owner cannot acquire duplicate raw evidence through route aliases.
    if (owners.has(item.key.qso))
      throw new Error("duplicate_reconciliation_owner");
    owners.add(item.key.qso);
  }
  if (!items.length) return [];
  const at = now();
  if (!Number.isSafeInteger(at) || at <= 0)
    throw new Error("invalid_reconciliation_time");
  // Capture primitives, report bytes and both guards before the first await.
  const captured = items.map((item) => ({
    key: { ...item.key },
    generation: item.generation,
    ledger: { ...item.ledger },
    adoptedSourceHash: item.adoptedSourceHash,
    outcome: {
      ...item.outcome,
      evidence: { ...item.outcome.evidence },
      remote: item.outcome.remote ? { ...item.outcome.remote } : undefined,
      associationProof: item.outcome.associationProof
        ? { ...item.outcome.associationProof }
        : undefined,
    },
    inventory: item.commitGuard,
  }));
  const results: AdoptionResult[] = captured.map(() =>
    rejected("historical_comparison_proof_required"),
  );
  const members: {
    index: number;
    item: (typeof captured)[number];
    record: AdifRecord;
    guard: HistoryCommitGuard;
  }[] = [];
  for (const [index, item] of captured.entries()) {
    const { key, ledger, outcome, generation } = item,
      evidence = outcome.evidence,
      proof = outcome.associationProof,
      record = outcome.remote;
    let reason: string | null = null;
    if (
      ledger.tenant !== key.tenant ||
      ledger.source !== key.source ||
      ledger.qso !== key.qso ||
      ledger.destination !== key.destination ||
      ledger.destination_kind !== "lotw" ||
      evidence.destination !== "lotw"
    )
      reason = "tenant_or_destination_missing";
    else if (
      !generation ||
      ledger.generation !== generation ||
      evidence.capturedGeneration !== generation ||
      evidence.currentGeneration !== generation
    )
      reason = "source_generation_changed";
    else if (ledger.provenance === "adoption_conflict")
      reason = "remote_identity_claim_conflict";
    else if (ledger.remote_id !== null || ledger.lotw_historical_association_id)
      reason = "trusted_mapping_preserved";
    else if (
      ledger.state === "changed" ||
      ledger.sent_hash !== null ||
      ledger.template_version !== null ||
      ledger.provenance !== "unknown" ||
      ledger.remote_hash !== null ||
      ledger.confirmed !== 0 ||
      !ledger.source_hash ||
      (item.adoptedSourceHash !== undefined &&
        item.adoptedSourceHash !== ledger.source_hash)
    )
      reason = "generation_mapping_or_attempt_conflict";
    else if (
      !evidence.readAccess ||
      !evidence.inventoryComplete ||
      !evidence.catchupComplete ||
      (!evidence.freshCheckComplete && !evidence.inventoryPositiveOnly)
    )
      reason = "incomplete_evidence";
    else if (
      outcome.state !== "adopted_existing" ||
      outcome.associationOnly !== true ||
      !proof?.bookIdentity ||
      typeof proof.commitGuard !== "function" ||
      typeof item.inventory !== "function"
    )
      reason = "historical_comparison_proof_required";
    else if (
      !record ||
      Object.values(record).some((value) => typeof value !== "string") ||
      encoder.encode(canonical(record)).byteLength > 65536 ||
      historicalCandidates("lotw", comparisonRecord(record), [
        comparisonRecord(record),
      ]).state !== "unique"
    )
      reason = "invalid_historical_record";
    if (reason || !proof || !record) {
      results[index] = rejected(
        reason ?? "historical_comparison_proof_required",
      );
      continue;
    }
    const inventory = captureGuard(item.inventory(at)),
      reverse = captureGuard(proof.commitGuard(at));
    if (inventory.params.length + reverse.params.length + 3 > 72)
      throw new Error("lotw_historical_commit_guard_bound");
    members.push({
      index,
      item,
      record,
      guard: {
        sql: `(${inventory.sql}) AND (${reverse.sql}) AND EXISTS(SELECT 1 FROM connections WHERE tenant=? AND id=? AND kind='lotw' AND status='active' AND remote_identity=?)`,
        params: [
          ...inventory.params,
          ...reverse.params,
          tenant,
          key.destination,
          proof.bookIdentity,
        ],
      },
    });
  }
  const conflicts = new Set<number>();
  for (let i = 0; i < members.length; i++)
    for (let j = i + 1; j < members.length; j++) {
      const match = historicalCandidates(
        "lotw",
        comparisonRecord(members[i].record),
        [comparisonRecord(members[j].record)],
      );
      if (match.state !== "none") {
        conflicts.add(i);
        conflicts.add(j);
      }
    }
  let eligible = members.filter((m, index) => {
    if (!conflicts.has(index)) return true;
    results[m.index] = rejected("remote_identity_claim_conflict");
    return false;
  });
  if (!eligible.length) return results;
  const current = await store.db.batch(
    eligible.map((m) =>
      store.statement(
        `SELECT EXISTS(SELECT 1 FROM ledger WHERE ${eligibleLedger} AND lotw_historical_association_id IS NULL AND (${m.guard.sql})) AS valid`,
        tenant,
        m.item.key.source,
        m.item.key.qso,
        m.item.key.destination,
        m.item.generation,
        m.item.ledger.source_hash,
        ...m.guard.params,
      ),
    ),
  );
  eligible = eligible.filter((m, index) => {
    if (
      (current[index]?.results[0] as { valid?: number } | undefined)?.valid ===
      1
    )
      return true;
    results[m.index] = rejected("generation_mapping_or_attempt_conflict");
    return false;
  });
  if (!eligible.length) return results;
  const hashes = await Promise.all(
    eligible.map((m) => sha256(canonical(comparableRemote(m.record)))),
  );
  let plan: Awaited<ReturnType<typeof prepareLotwHistoricalAssociations>>;
  try {
    plan = await prepareLotwHistoricalAssociations(
      store,
      eligible.map((m) => ({
        key: m.item.key,
        record: m.record,
        generation: m.item.generation,
        sourceHash: m.item.ledger.source_hash,
        guard: m.guard,
      })),
      { now: at },
    );
  } catch (error) {
    if (!(error instanceof LotwHistoricalUnavailable)) throw error;
    for (const member of eligible)
      results[member.index] = rejected(error.reason);
    return results;
  }
  try {
    const updates = eligible.map((m, index) => {
      const { key, generation, ledger } = m.item;
      return store.statement(
        `UPDATE ledger SET state='adopted_existing',reason=NULL,provenance='adopted',remote_hash=?,baseline_hash=source_hash,confirmed=?,updated_at=?
         WHERE ${eligibleLedger} AND lotw_historical_association_id=?
         RETURNING qso`,
        hashes[index],
        m.record.QSL_RCVD === "Y" ? 1 : 0,
        at,
        tenant,
        key.source,
        key.qso,
        key.destination,
        generation,
        ledger.source_hash,
        plan.associationIds[index],
      );
    });
    const checkIds = eligible.map(() => crypto.randomUUID()),
      checks = eligible.map((m, index) =>
        store.statement(
          `INSERT INTO lotw_historical_commit_checks(id,valid) SELECT ?,EXISTS(SELECT 1 FROM ledger WHERE tenant=? AND source=? AND qso=? AND destination=? AND generation=? AND source_hash=? AND lotw_historical_association_id=? AND state='adopted_existing' AND reason IS NULL AND provenance='adopted' AND remote_id IS NULL AND remote_hash=? AND baseline_hash=source_hash AND sent_hash IS NULL AND template_version IS NULL AND confirmed=? AND updated_at=?)`,
          checkIds[index],
          tenant,
          m.item.key.source,
          m.item.key.qso,
          m.item.key.destination,
          m.item.generation,
          m.item.ledger.source_hash,
          plan.associationIds[index],
          hashes[index],
          m.record.QSL_RCVD === "Y" ? 1 : 0,
          at,
        ),
      );
    const offset = plan.begin.length + plan.publications.length;
    const rows = await store.db.batch([
      ...plan.begin,
      ...plan.publications,
      ...updates,
      ...checks,
      store.statement(
        "DELETE FROM lotw_historical_commit_checks WHERE id IN(SELECT value FROM json_each(?))",
        JSON.stringify(checkIds),
      ),
      ...plan.finish,
    ]);
    for (const [index, member] of eligible.entries()) {
      if (rows[offset + index]?.results.length !== 1)
        throw new Error("lotw_historical_adoption_result_unavailable");
      results[member.index] = { applied: true };
    }
    return results;
  } finally {
    await plan.release();
  }
}
