import type { AdifRecord } from "./adif.ts";
import { historicalCandidates } from "./historical-matching.ts";
import { historicalOperatingDetails } from "./historical-operating-details.ts";
import type {
  ReconciliationEvidence,
  ReconciliationOutcome,
} from "./reconcile.ts";

/** Pure candidate classification only; no receipt identity or adoption proof.
 * The caller supplies the unchanged strict outcome for absence/coverage cases.
 * A consumer still needs reverse-source uniqueness, complete retained ownership
 * and a permanent association reference/write block before committing anything.
 */
export function classifyLotwHistoricalAssociation(
  source: AdifRecord,
  records: AdifRecord[],
  evidence: ReconciliationEvidence,
  strict: ReconciliationOutcome,
): ReconciliationOutcome {
  if (
    evidence.destination !== "lotw" ||
    !evidence.capturedGeneration ||
    evidence.capturedGeneration !== evidence.currentGeneration ||
    !evidence.readAccess ||
    !evidence.inventoryComplete ||
    !evidence.catchupComplete ||
    (!evidence.freshCheckComplete && !evidence.inventoryPositiveOnly)
  )
    return strict;
  const held = (reason: string): ReconciliationOutcome => ({
    state: "history_ambiguous",
    reason,
    evidence,
  });
  const result = historicalCandidates("lotw", source, records);
  if (result.state === "none")
    return strict.state === "adopted_existing"
      ? held("Historical candidate evidence cannot establish this association")
      : strict;
  if (result.state !== "unique")
    return held(
      result.issues.length
        ? "Historical candidate evidence is incomplete or unsupported"
        : "Multiple historical candidates fall within the matching window",
    );
  const candidate = result.candidates[0];
  if (!candidate.time.entireIntervalWithinWindow)
    return held(
      "Recorded time precision crosses the historical matching window",
    );
  const details = historicalOperatingDetails("lotw", source, candidate.record);
  if (details.state !== "adopted_existing")
    return {
      state: details.state,
      reason: "reason" in details ? details.reason : null,
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
