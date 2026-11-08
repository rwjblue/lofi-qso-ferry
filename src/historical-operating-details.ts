import type { AdifRecord } from "./adif.ts";
import { historicalGridsCompatible } from "./historical-location.ts";
import type { HistoricalVendor } from "./historical-matching.ts";
import { matchQrzHistory, type QrzMatch } from "./qrz.ts";

// LoTW query reports do not establish transmitted latitude/longitude or
// narrative. Keep this policy shared by both historical reconciliation paths.
const lotwFields = new Set(
  "STATION_CALLSIGN CALL QSO_DATE TIME_ON BAND MODE SUBMODE PROP_MODE SAT_NAME FREQ FREQ_RX BAND_RX MY_DXCC MY_GRIDSQUARE MY_STATE MY_CNTY MY_CQ_ZONE MY_ITU_ZONE MY_IOTA".split(
    " ",
  ),
);

/** Run only after precise identity candidacy has been established. Temporary
 * identity alignment permits operating-detail comparison without changing the
 * original records, receipt identity or source projection. No adoption proof. */
export function historicalOperatingDetails(
  vendor: HistoricalVendor,
  source: AdifRecord,
  remote: AdifRecord,
): QrzMatch {
  if (vendor === "lotw")
    for (const field of ["FREQ", "FREQ_RX"]) {
      const frequency = source[field];
      if (
        frequency &&
        (!/^\d+(?:\.\d+)?$/.test(frequency) ||
          (frequency.split(".")[1] ?? "").replace(/0+$/, "").length > 5)
      )
        return {
          state: "history_ambiguous",
          reason: `LoTW query cannot establish the transmitted precision of ${field}`,
        };
    }
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
  if (historicalGridsCompatible(source.MY_GRIDSQUARE, remote.MY_GRIDSQUARE))
    operating.MY_GRIDSQUARE = remote.MY_GRIDSQUARE;
  return matchQrzHistory(operating, [remote]);
}
