import type { AdifRecord } from "./adif.ts";
import { historicalGridRelation } from "./historical-location.ts";
import { historicalCandidates } from "./historical-matching.ts";
import { observeLotwContact, validLotwReceiveTime } from "./lotw.ts";
import { normalizeLotwStationGrid } from "./lotw-grid.ts";
import {
  canonicalSigningData,
  type LotwContact,
  type LotwStation,
  lotwMode,
} from "./signing.ts";

interface LotwGridCorrection {
  station: LotwStation;
  qso: Omit<LotwContact, "id" | "generation">;
  original: AdifRecord;
}

const supportedLocationFields = new Set(
  "MY_DXCC MY_COUNTRY MY_GRIDSQUARE MY_STATE MY_CNTY MY_CQ_ZONE MY_ITU_ZONE MY_IOTA APP_LOTW_MY_DXCC_ENTITY_STATUS".split(
    " ",
  ),
);
const upper = (value: string | undefined) => value?.toUpperCase() ?? "";
const individualMode = (record: AdifRecord) =>
  upper(record.APP_LOTW_MODE || record.SUBMODE || record.MODE);
const receiveBand = (record: AdifRecord) =>
  upper(record.BAND_RX || record.BAND);

/** LoTW's in-place update key includes receive band. Do not use the legacy
 * association hash or reconstruct exact seconds and mode from LoFi. */
export function lotwGridCorrectionRecord(
  baseline: AdifRecord,
  fresh: readonly AdifRecord[],
): AdifRecord | null {
  const nearby = fresh.filter(
    (record) =>
      upper(record.STATION_CALLSIGN) === upper(baseline.STATION_CALLSIGN) &&
      upper(record.CALL) === upper(baseline.CALL) &&
      upper(record.BAND) === upper(baseline.BAND) &&
      record.QSO_DATE === baseline.QSO_DATE &&
      record.TIME_ON?.slice(0, 4) === baseline.TIME_ON?.slice(0, 4),
  );
  // Propagation and satellite details are mutable, outside the provider key.
  // Include any competing row even if those details differ.
  const key = (record: AdifRecord) => {
    const {
      PROP_MODE: _propagation,
      SAT_NAME: _satellite,
      ...identity
    } = record;
    return identity;
  };
  const result = historicalCandidates("lotw", key(baseline), nearby.map(key));
  const possible = result.candidates.filter(
    (item) => item.time.minimumSeparationMs === 0,
  );
  const [candidate] = possible;
  const matches = nearby.filter(
    (record) =>
      record.TIME_ON === baseline.TIME_ON &&
      individualMode(record) === individualMode(baseline),
  );
  const [record] = matches;
  if (
    result.issues.length ||
    possible.length !== 1 ||
    candidate?.time.maximumSeparationMs !== 0 ||
    candidate.modeBasis !== "exact" ||
    matches.length !== 1 ||
    receiveBand(baseline) !== receiveBand(record)
  )
    return null;
  return record;
}

function correctionInputs(
  original: AdifRecord,
  grid: string,
): LotwGridCorrection | null {
  // The report does not expose several signed subdivisions for other DXCC
  // entities. Limit automatic updates to the supported US and Canadian fields.
  if (
    !["1", "6", "110", "291"].includes(original.MY_DXCC) ||
    Object.keys(original).some(
      (field) =>
        (field.startsWith("MY_") || field.startsWith("APP_LOTW_MY_")) &&
        !supportedLocationFields.has(field),
    )
  )
    return null;
  const state = original.MY_STATE;
  const county = original.MY_CNTY;
  if (county && (!state || !upper(county).startsWith(`${upper(state)},`)))
    return null;
  const date = original.QSO_DATE;
  const time = original.TIME_ON;
  const mode = individualMode(original);
  const station: LotwStation = {
    callsign: upper(original.STATION_CALLSIGN),
    dxcc: Number(original.MY_DXCC),
    grid,
    ...(state && { state }),
    ...(county && { county: county.slice(state.length + 1) }),
    ...(original.MY_CQ_ZONE && { cqZone: Number(original.MY_CQ_ZONE) }),
    ...(original.MY_ITU_ZONE && { ituZone: Number(original.MY_ITU_ZONE) }),
    ...(original.MY_IOTA && { iota: original.MY_IOTA }),
  };
  const qso = {
    call: upper(original.CALL),
    band: upper(original.BAND),
    mode,
    date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
    time: `${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`,
    ...(original.BAND_RX && { bandRx: upper(original.BAND_RX) }),
    ...(original.FREQ && { frequencyMHz: original.FREQ }),
    ...(original.FREQ_RX && { frequencyRxMHz: original.FREQ_RX }),
    ...(original.PROP_MODE && { propagation: upper(original.PROP_MODE) }),
    ...(original.SAT_NAME && { satellite: upper(original.SAT_NAME) }),
  };
  const contact = {
    ...qso,
    id: "grid-correction",
    generation: "grid-correction",
  };
  try {
    if (lotwMode(mode) !== mode) return null;
    canonicalSigningData(station, contact);
    // Compare the original report against exactly what we can sign. The report
    // gives frequency to 5 decimals, so hold any non-round-trippable evidence.
    if (
      observeLotwContact(
        { ...station, grid: original.MY_GRIDSQUARE },
        contact,
        {
          records: [original],
          receivedThrough: null,
          complete: true,
        },
      ).state !== "observed"
    )
      return null;
  } catch {
    return null;
  }
  return { station, qso, original };
}

export function lotwGridCorrectionTarget(
  baseline: AdifRecord,
  fresh: readonly AdifRecord[],
  grid: string,
): LotwGridCorrection | null {
  const original = lotwGridCorrectionRecord(baseline, fresh);
  if (
    !original ||
    historicalGridRelation(grid, original.MY_GRIDSQUARE) !== "different"
  )
    return null;
  try {
    normalizeLotwStationGrid(original.MY_GRIDSQUARE);
    return correctionInputs(original, normalizeLotwStationGrid(grid));
  } catch {
    return null;
  }
}

export function lotwGridCorrectionObserved(
  original: AdifRecord,
  fresh: readonly AdifRecord[],
  grid: string,
  claimedAt: number,
  now = Date.now(),
): boolean {
  const record = lotwGridCorrectionRecord(original, fresh);
  if (!record || !validLotwReceiveTime(record.APP_LOTW_RXQSO)) return false;
  const received = Date.parse(`${record.APP_LOTW_RXQSO.replace(" ", "T")}Z`);
  if (
    !Number.isSafeInteger(claimedAt) ||
    !Number.isSafeInteger(now) ||
    received < Math.floor(claimedAt / 1000) * 1000 ||
    received > now ||
    (original.QSL_RCVD === "Y" && record.QSL_RCVD !== "Y")
  )
    return false;
  const expected = lotwGridCorrectionTarget(original, [original], grid);
  if (!expected || !correctionInputs(record, record.MY_GRIDSQUARE))
    return false;
  const contact = {
    ...expected.qso,
    id: "grid-correction",
    generation: "grid-correction",
  };
  return (
    observeLotwContact(expected.station, contact, {
      records: [record],
      receivedThrough: null,
      complete: true,
    }).state === "observed"
  );
}
