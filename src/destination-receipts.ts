import type { AdifRecord } from "./adif.ts";
import { canonical, sha256 } from "./security.ts";
import { lotwIdentityMode } from "./signing.ts";

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
  const mode = lotwIdentityMode(
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
