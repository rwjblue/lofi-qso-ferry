import type { AdifRecord } from "./adif.ts";

export const HISTORICAL_CANDIDATE_POLICY_VERSION = 2;
export const HISTORICAL_TIME_WINDOW_MS = 30 * 60_000;
export const HISTORICAL_CANDIDATE_LIMIT = 512;
export type HistoricalVendor = "qrz" | "lotw";
export interface HistoricalTimeInterval {
  startMs: number;
  endMs: number;
  precision: "minute" | "second";
}
export type HistoricalIssueReason =
  | "invalid_station_call"
  | "invalid_worked_call"
  | "invalid_band"
  | "invalid_time"
  | "invalid_mode"
  | "invalid_satellite"
  | "candidate_bound";
export interface HistoricalIssue {
  side: "source" | "remote" | "input";
  record?: AdifRecord;
  reason: HistoricalIssueReason;
}
export interface HistoricalCandidate {
  source: AdifRecord;
  record: AdifRecord;
  time: {
    source: HistoricalTimeInterval;
    remote: HistoricalTimeInterval;
    minimumSeparationMs: number;
    maximumSeparationMs: number;
    entireIntervalWithinWindow: boolean;
  };
  modeBasis: "exact" | "primary" | "group";
  satellite: boolean;
  differences: Array<{
    field: string;
    kind: "different" | "missing_source" | "missing_remote";
  }>;
}
export interface HistoricalCandidates {
  policyVersion: typeof HISTORICAL_CANDIDATE_POLICY_VERSION;
  authoritative: false;
  requiresSourceUniqueness: true;
  requiresRemoteOwnership: true;
  state: "none" | "unique" | "ambiguous" | "invalid";
  candidates: HistoricalCandidate[];
  issues: HistoricalIssue[];
}

// Pinned ADIF 3.1.5 band/primary-mode enumerations and a deliberately limited
// submode map. Unrecognized relevant evidence is held, never interpreted as
// absence. https://www.adif.org/315/ADIF_315.htm
const bands = new Set(
  "2190M 630M 560M 160M 80M 60M 40M 30M 20M 17M 15M 12M 10M 8M 6M 5M 4M 2M 1.25M 70CM 33CM 23CM 13CM 9CM 6CM 3CM 1.25CM 6MM 4MM 2.5MM 2MM 1MM SUBMM".split(
    " ",
  ),
);
const primaryModes = new Set(
  "AM ARDOP ATV CHIP CLO CONTESTI CW DIGITALVOICE DOMINO DYNAMIC FAX FM FSK441 FT8 HELL ISCAT JT4 JT6M JT9 JT44 JT65 MFSK MSK144 MT63 OLIVIA OPERA PAC PAX PKT PSK PSK2K Q15 QRA64 ROS RTTY RTTYM SSB SSTV T10 THOR THRB TOR V4 VOI WINMOR WSPR".split(
    " ",
  ),
);
const parents: Readonly<Record<string, string>> = Object.freeze({
  USB: "SSB",
  LSB: "SSB",
  PCW: "CW",
  C4FM: "DIGITALVOICE",
  DMR: "DIGITALVOICE",
  DSTAR: "DIGITALVOICE",
  FREEDV: "DIGITALVOICE",
  M17: "DIGITALVOICE",
  FT4: "MFSK",
  JS8: "MFSK",
  FSQCALL: "MFSK",
  FST4: "MFSK",
  FST4W: "MFSK",
  Q65: "MFSK",
  MFSK8: "MFSK",
  MFSK16: "MFSK",
  PSK10: "PSK",
  PSK31: "PSK",
  PSK63: "PSK",
  PSK63F: "PSK",
  PSK125: "PSK",
  PSKAM10: "PSK",
  PSKAM31: "PSK",
  PSKAM50: "PSK",
  PSKFEC31: "PSK",
  QPSK31: "PSK",
  QPSK63: "PSK",
  QPSK125: "PSK",
  JT65A: "JT65",
  JT65B: "JT65",
  JT65C: "JT65",
});
type ModeGroup = "CW" | "PHONE" | "DATA" | "IMAGE";
// ARRL's explicit LoTW mode groups, checked against released TQSL 2.8.6
// configuration 11.34. An ADIF parent alone does not establish a LoTW group.
// https://lotw.arrl.org/lotw-help/frequently-asked-questions/
const groups = new Map<string, ModeGroup>([
  ...["CW"].map((mode) => [mode, "CW"] as const),
  ..."PHONE AM C4FM DIGITALVOICE DSTAR FM SSB"
    .split(" ")
    .map((mode) => [mode, "PHONE"] as const),
  ..."IMAGE ATV FAX SSTV".split(" ").map((mode) => [mode, "IMAGE"] as const),
  ..."DATA AMTOR ARDOP CHIP CLOVER CONTESTI DOMINO FSK31 FSK441 FT4 FT8 GTOR HELL HFSK ISCAT JT4 JT65 JT6M JT9 MFSK16 MFSK8 MINIRTTY MSK144 MT63 OLIVIA OPERA PACKET PACTOR PAX PSK10 PSK125 PSK2K PSK31 PSK63 PSK63F PSKAM PSKFEC31 Q15 QRA64 ROS RTTY RTTYM T10 THOR THROB VOI WINMOR WSPR FST4 Q65"
    .split(" ")
    .map((mode) => [mode, "DATA"] as const),
]);
function token(value: string | undefined): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 32 &&
    !/[^A-Za-z0-9/.-]/.test(value)
    ? value.toUpperCase()
    : undefined;
}
function call(value: string | undefined): string | undefined {
  const result = token(value);
  return result &&
    /^[A-Z0-9]+(?:\/[A-Z0-9]+)*$/.test(result) &&
    /[A-Z]/.test(result) &&
    /[0-9]/.test(result)
    ? result
    : undefined;
}
function band(value: string | undefined): string | undefined {
  const result = token(value);
  return result && bands.has(result) ? result : undefined;
}
function time(record: AdifRecord): HistoricalTimeInterval | undefined {
  const date = record.QSO_DATE;
  const clock = record.TIME_ON;
  if (
    typeof date !== "string" ||
    date.length !== 8 ||
    /[^0-9]/.test(date) ||
    Number(date.slice(0, 4)) < 1930 ||
    typeof clock !== "string" ||
    ![4, 6].includes(clock.length) ||
    /[^0-9]/.test(clock) ||
    Number(clock.slice(0, 2)) > 23 ||
    Number(clock.slice(2, 4)) > 59 ||
    Number(clock.slice(4) || "0") > 59
  )
    return;
  const isoDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const startMs = Date.parse(
    `${isoDate}T${clock.slice(0, 2)}:${clock.slice(2, 4)}:${clock.slice(4) || "00"}.000Z`,
  );
  if (
    !Number.isFinite(startMs) ||
    new Date(startMs).toISOString().slice(0, 10) !== isoDate
  )
    return;
  return {
    startMs,
    endMs: startMs + (clock.length === 4 ? 59_999 : 0),
    precision: clock.length === 4 ? "minute" : "second",
  };
}
interface Mode {
  primary: string;
  individual: string;
  group?: ModeGroup;
}
function mode(record: AdifRecord, vendor: HistoricalVendor): Mode | undefined {
  // LoTW may omit MODE while retaining its individual APP_LOTW_MODE.
  // https://lotw.arrl.org/lotw-help/developer-query-qsos-qsls/
  const raw = token(
    record.MODE ?? (vendor === "lotw" ? record.APP_LOTW_MODE : undefined),
  );
  const sub = record.SUBMODE === undefined ? undefined : token(record.SUBMODE);
  if (!raw || (record.SUBMODE !== undefined && !sub)) return;
  const primary = parents[raw] ?? raw;
  const known =
    primaryModes.has(primary) || (vendor === "lotw" && groups.has(raw));
  if (
    !known ||
    (sub && (parents[sub] !== primary || (parents[raw] && raw !== sub)))
  )
    return;
  let individual = sub ?? raw;
  if (vendor === "qrz") {
    if (!primaryModes.has(primary)) return;
    return { primary, individual };
  }
  const app =
    record.APP_LOTW_MODE === undefined
      ? undefined
      : token(record.APP_LOTW_MODE);
  if (record.APP_LOTW_MODE !== undefined && !app) return;
  if (app) {
    const appPrimary = parents[app] ?? app;
    if (!primaryModes.has(appPrimary) && !groups.has(app)) return;
    const groupOnly = ["CW", "PHONE", "DATA", "IMAGE"].includes(raw);
    if (sub && app !== sub) return;
    if (
      app !== individual &&
      !(groupOnly && groups.get(app) === raw) &&
      appPrimary !== primary
    )
      return;
    // An explicit individual child cannot be silently replaced by a sibling.
    if ((sub || parents[raw]) && app !== individual) return;
    individual = app;
  }
  if (individual === "USB" || individual === "LSB") individual = "SSB";
  const group = groups.get(individual);
  // Without a verified LoTW group, a different known ADIF mode might still
  // belong to the same group. Do not turn unsupported group evidence into none.
  if (!group) return;
  if (record.APP_LOTW_MODEGROUP !== undefined) {
    const reported = token(record.APP_LOTW_MODEGROUP);
    if (!reported || !group || reported !== group) return;
  }
  return { primary, individual, group };
}
// ADIF 3.1.5 III.B.12: only enumerated propagation values can establish
// non-satellite evidence. A new/unknown token remains unavailable.
const propagationModes = new Set(
  "AS AUE AUR BS ECH EME ES F2 FAI GWAVE INTERNET ION IRL LOS MS RPT RS SAT TEP TR".split(
    " ",
  ),
);
function satellite(
  record: AdifRecord,
): { satellite: boolean; name?: string } | undefined {
  const prop =
    record.PROP_MODE === undefined ? undefined : token(record.PROP_MODE);
  if (record.PROP_MODE !== undefined && (!prop || !propagationModes.has(prop)))
    return;
  if (prop !== "SAT")
    return record.SAT_NAME === undefined ? { satellite: false } : undefined;
  const name = record.SAT_NAME;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 64 ||
    /[^A-Za-z0-9 ()/._-]/.test(name) ||
    name.trim() !== name
  )
    return;
  return { satellite: true, name: name.toUpperCase() };
}
const detailFields = [
  "QSO_DATE",
  "TIME_ON",
  "MODE",
  "SUBMODE",
  "FREQ",
  "FREQ_RX",
  "BAND_RX",
  "PROP_MODE",
  "MY_GRIDSQUARE",
  "MY_STATE",
  "MY_CNTY",
  "MY_DXCC",
  "MY_LAT",
  "MY_LON",
  "MY_CQ_ZONE",
  "MY_ITU_ZONE",
  "MY_IOTA",
];
function differences(
  source: AdifRecord,
  remote: AdifRecord,
): HistoricalCandidate["differences"] {
  return detailFields.flatMap((field) =>
    source[field] === remote[field]
      ? []
      : [
          {
            field,
            kind:
              source[field] === undefined
                ? ("missing_source" as const)
                : remote[field] === undefined
                  ? ("missing_remote" as const)
                  : ("different" as const),
          },
        ],
  );
}

/** Candidate discovery only: no completeness, adoption, ownership or write authority.
 * `none` describes this supplied record set, not remote absence. Minute timestamps
 * remain intervals; even a unique possible candidate still needs caller review.
 * Rules: https://www.qrz.com/docs/logbook30/confirmations-how and ARRL FAQ above.
 */
export function historicalCandidates(
  vendor: HistoricalVendor,
  source: AdifRecord,
  records: readonly AdifRecord[],
): HistoricalCandidates {
  const result: HistoricalCandidates = {
    policyVersion: HISTORICAL_CANDIDATE_POLICY_VERSION,
    authoritative: false,
    requiresSourceUniqueness: true,
    requiresRemoteOwnership: true,
    state: "none",
    candidates: [],
    issues: [],
  };
  if (records.length > HISTORICAL_CANDIDATE_LIMIT) {
    result.state = "invalid";
    result.issues.push({ side: "input", reason: "candidate_bound" });
    return result;
  }
  const local = {
    station: call(source.STATION_CALLSIGN),
    worked: call(source.CALL),
    band: band(source.BAND),
    time: time(source),
    mode: mode(source, vendor),
    satellite: satellite(source),
  };
  const validations = [
    ["station", "invalid_station_call"],
    ["worked", "invalid_worked_call"],
    ["band", "invalid_band"],
    ["time", "invalid_time"],
    ["mode", "invalid_mode"],
    ["satellite", "invalid_satellite"],
  ] as const;
  for (const [key, reason] of validations)
    if (!local[key])
      result.issues.push({ side: "source", record: source, reason });
  if (
    !local.station ||
    !local.worked ||
    !local.band ||
    !local.time ||
    !local.mode ||
    !local.satellite
  )
    return { ...result, state: "invalid" };
  for (const record of records) {
    const station = call(record.STATION_CALLSIGN);
    const worked = call(record.CALL);
    const remoteBand = band(record.BAND);
    // Establish irrelevance using valid keys before inspecting optional/unknown
    // mode evidence. An unrelated unsupported mode must not poison the cohort.
    if (
      (station && station !== local.station) ||
      (worked && worked !== local.worked) ||
      (remoteBand && remoteBand !== local.band)
    )
      continue;
    const remoteTime = time(record);
    const minimum = remoteTime
      ? Math.max(
          0,
          local.time.startMs - remoteTime.endMs,
          remoteTime.startMs - local.time.endMs,
        )
      : undefined;
    if (minimum !== undefined && minimum > HISTORICAL_TIME_WINDOW_MS) continue;
    const invalidKey = !station
      ? "invalid_station_call"
      : !worked
        ? "invalid_worked_call"
        : !remoteBand
          ? "invalid_band"
          : !remoteTime
            ? "invalid_time"
            : undefined;
    if (invalidKey || !remoteTime || minimum === undefined) {
      result.issues.push({
        side: "remote",
        record,
        reason: invalidKey ?? "invalid_time",
      });
      continue;
    }
    const remoteMode = mode(record, vendor);
    const remoteSatellite = satellite(record);
    if (!remoteMode || !remoteSatellite) {
      result.issues.push({
        side: "remote",
        record,
        reason: !remoteMode ? "invalid_mode" : "invalid_satellite",
      });
      continue;
    }
    if (
      remoteSatellite.satellite !== local.satellite.satellite ||
      remoteSatellite.name !== local.satellite.name
    )
      continue;
    const modeBasis =
      local.mode.individual === remoteMode.individual
        ? "exact"
        : vendor === "qrz" && local.mode.primary === remoteMode.primary
          ? "primary"
          : vendor === "lotw" &&
              local.mode.group &&
              local.mode.group === remoteMode.group
            ? "group"
            : undefined;
    if (!modeBasis) continue;
    const maximum = Math.max(
      Math.abs(local.time.startMs - remoteTime.endMs),
      Math.abs(local.time.endMs - remoteTime.startMs),
    );
    result.candidates.push({
      source,
      record,
      time: {
        source: local.time,
        remote: remoteTime,
        minimumSeparationMs: minimum,
        maximumSeparationMs: maximum,
        entireIntervalWithinWindow: maximum <= HISTORICAL_TIME_WINDOW_MS,
      },
      modeBasis,
      satellite: local.satellite.satellite,
      differences: differences(source, record),
    });
  }
  result.state =
    result.issues.length || result.candidates.length > 1
      ? "ambiguous"
      : result.candidates.length === 1
        ? "unique"
        : "none";
  return result;
}
