import type { AdifRecord } from "./adif.ts";
import { historicalGridRelation } from "./historical-location.ts";
import {
  type HistoricalVendor,
  historicalCandidates,
} from "./historical-matching.ts";
import { matchQrzHistory, type QrzMatch } from "./qrz.ts";

// LoTW query reports do not establish transmitted latitude/longitude or
// narrative. Keep this policy shared by both historical reconciliation paths.
const lotwFields = new Set(
  "STATION_CALLSIGN CALL QSO_DATE TIME_ON BAND MODE SUBMODE PROP_MODE SAT_NAME FREQ FREQ_RX BAND_RX MY_DXCC MY_GRIDSQUARE MY_STATE MY_CNTY MY_CQ_ZONE MY_ITU_ZONE MY_IOTA".split(
    " ",
  ),
);

function frequencyParts(value: string | undefined) {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const magnitude = Number(value);
  if (!Number.isFinite(magnitude) || magnitude <= 0) return null;
  const [megahertz, fraction = ""] = value.split(".");
  return {
    hertz:
      BigInt(megahertz.replace(/^0+(?=\d)/, "")) * 1_000_000n +
      BigInt(fraction.slice(0, 6).padEnd(6, "0")),
    remainder: fraction.slice(6).replace(/0+$/, ""),
  };
}

function withinHistoricalFrequency(
  source: string | undefined,
  remote: string | undefined,
): boolean {
  const local = frequencyParts(source);
  const observed = frequencyParts(remote);
  if (!local || !observed) return false;
  const delta = local.hertz - observed.hertz;
  // Use the exact decimal remainder at the inclusive boundary. Converting
  // the whole comparison to floating point can round a value across it.
  if (delta === 100n) return local.remainder <= observed.remainder;
  if (delta === -100n) return local.remainder >= observed.remainder;
  return delta > -100n && delta < 100n;
}

function exactGridMismatchIdentity(
  vendor: HistoricalVendor,
  source: AdifRecord,
  remote: AdifRecord,
): boolean {
  const candidate = historicalCandidates(vendor, source, [remote])
    .candidates[0];
  return (
    candidate?.modeBasis === "exact" &&
    candidate.time.maximumSeparationMs === 0 &&
    (source.BAND_RX || source.BAND).toUpperCase() ===
      (remote.BAND_RX || remote.BAND).toUpperCase() &&
    (source.PROP_MODE ?? "").toUpperCase() ===
      (remote.PROP_MODE ?? "").toUpperCase()
  );
}

/** Run only after precise identity candidacy has been established. Temporary
 * identity alignment permits operating-detail comparison without changing the
 * original records, receipt identity or source projection. No adoption proof. */
export function historicalOperatingDetails(
  vendor: HistoricalVendor,
  source: AdifRecord,
  remote: AdifRecord,
): QrzMatch {
  const operating =
    vendor === "lotw"
      ? Object.fromEntries(
          Object.entries(source).filter(([field]) => lotwFields.has(field)),
        )
      : { ...source };
  for (const field of [
    "QSO_DATE",
    "TIME_ON",
    "MODE",
    "SUBMODE",
    "PROP_MODE",
    "SAT_NAME",
  ]) {
    delete operating[field];
    if (remote[field] !== undefined) operating[field] = remote[field];
  }
  const grid = historicalGridRelation(
    source.MY_GRIDSQUARE,
    remote.MY_GRIDSQUARE,
  );
  // A conflicting grid is tolerated only with exact contact identity. Other
  // operating details still have to agree under the ordinary historical policy.
  if (
    grid === "compatible" ||
    (grid === "different" && exactGridMismatchIdentity(vendor, source, remote))
  )
    operating.MY_GRIDSQUARE = remote.MY_GRIDSQUARE;
  for (const field of ["FREQ", "FREQ_RX"])
    if (withinHistoricalFrequency(source[field], remote[field]))
      operating[field] = remote[field];
  return matchQrzHistory(operating, [remote]);
}
