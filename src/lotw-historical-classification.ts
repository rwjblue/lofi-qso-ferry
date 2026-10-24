import type { AdifRecord } from "./adif.ts";
import { historicalGridsCompatible } from "./historical-location.ts";
import { historicalCandidates } from "./historical-matching.ts";
import { matchQrzHistory } from "./qrz.ts";
import type {
  ReconciliationEvidence,
  ReconciliationOutcome,
} from "./reconcile.ts";

// LoTW query reports expose these operating fields. Latitude/longitude and
// narrative fields are not evidence of what this interface returned.
const operatingFields = new Set([
  "STATION_CALLSIGN",
  "CALL",
  "QSO_DATE",
  "TIME_ON",
  "BAND",
  "MODE",
  "SUBMODE",
  "PROP_MODE",
  "SAT_NAME",
  "FREQ",
  "FREQ_RX",
  "BAND_RX",
  "MY_DXCC",
  "MY_GRIDSQUARE",
  "MY_STATE",
  "MY_CNTY",
  "MY_CQ_ZONE",
  "MY_ITU_ZONE",
  "MY_IOTA",
]);

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
  for (const field of ["FREQ", "FREQ_RX"]) {
    const frequency = source[field];
    if (
      frequency &&
      (!/^\d+(?:\.\d+)?$/.test(frequency) ||
        (frequency.split(".")[1] ?? "").replace(/0+$/, "").length > 5)
    )
      return held(
        `LoTW query cannot establish the transmitted precision of ${field}`,
      );
  }
  const operating = Object.fromEntries(
    Object.entries(source).filter(([field]) => operatingFields.has(field)),
  );
  // The vendor policy has established identity candidacy. Align only a temporary
  // comparison view to check operating details; retain both original records.
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
  const details = matchQrzHistory(operating, [candidate.record]);
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
