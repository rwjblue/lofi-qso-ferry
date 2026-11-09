import type { AdifRecord } from "./adif.ts";
import { adifInstant } from "./qrz.ts";
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

export interface DestinationIdentityClaim {
  vendor: "qrz" | "lotw";
  hash: string;
}
/** Exact outbound seconds, never a rounded timestamp or a narrative/location key. */
export async function destinationIdentityClaim(
  vendor: DestinationIdentityClaim["vendor"],
  record: AdifRecord,
): Promise<DestinationIdentityClaim> {
  if (
    !/^[0-9]{6}$/.test(record.TIME_ON ?? "") ||
    ["STATION_CALLSIGN", "CALL", "BAND", "MODE"].some(
      (field) => !record[field] || !/^[\x20-\x7e]+$/.test(record[field]),
    )
  )
    throw new Error("Invalid outbound destination identity");
  adifInstant(record);
  const mode =
    vendor === "lotw"
      ? lotwIdentityMode(record.MODE, record.SUBMODE || record.APP_LOTW_MODE)
      : record.MODE;
  const identity = Object.fromEntries(
    [
      "STATION_CALLSIGN",
      "CALL",
      "QSO_DATE",
      "TIME_ON",
      "BAND",
      "MODE",
      ...(vendor === "qrz" ? ["SUBMODE"] : []),
      "PROP_MODE",
      "SAT_NAME",
    ].map((field) => [
      field,
      (field === "MODE" ? mode : (record[field] ?? "")).toUpperCase(),
    ]),
  );
  return { vendor, hash: await sha256(canonical(identity)) };
}

export function historicalQrzLogId(value: string): string {
  if (!value || value.length > 64 || /[^0-9]/.test(value))
    throw new Error("Invalid historical QRZ LOGID");
  return value.replace(/^0+(?=[0-9])/, "");
}
