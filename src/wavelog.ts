import { type AdifRecord, parseAdif, serializeAdifRecord } from "./adif.ts";
import type { Contact } from "./projection.ts";
import { canonical } from "./security.ts";
import { VendorDeferredError } from "./vendor-requests.ts";
import {
  assertWavelogBaseUrlAllowed,
  normalizeWavelogBaseUrl,
} from "./wavelog-url.ts";

// Contract pinned to wavelog/wavelog tag 3.2.4, Qso_resource, Station_resource,
// Logbook_model::import/update_qso_columns and AdifHelper. PATCH changes the
// Club Log ignore flag to modified, so this client deliberately exposes no PATCH QSO.
export type WavelogErrorKind =
  | "auth"
  | "rejected"
  | "rate"
  | "protocol"
  | "uncertain"
  | "blocked";
export class WavelogError extends Error {
  readonly requestSent: boolean;
  readonly suspend: boolean;
  readonly retryAt?: number;
  constructor(
    readonly kind: WavelogErrorKind,
    readonly code: string,
    options: {
      requestSent?: boolean;
      suspend?: boolean;
      retryAt?: number;
    } = {},
  ) {
    super(`Wavelog: ${/^[a-z0-9_]+$/.test(code) ? code : "request_failed"}`);
    this.name = "WavelogError";
    this.requestSent = options.requestSent ?? false;
    this.suspend = options.suspend ?? kind === "auth";
    this.retryAt = options.retryAt;
  }
}
export interface WavelogCredentials {
  baseUrl: string;
  token: string;
}
export interface WavelogOptions {
  fetcher?: typeof fetch;
  writesEnabled?: boolean;
  beforeWrite?: () => Promise<boolean>;
  allowedBaseUrls?: readonly string[];
}
export interface WavelogToken {
  id: number;
  user_id: number;
  owner: string;
  scopes: string[];
  expires_at: string | null;
}
export interface WavelogStationSpec {
  name: string;
  callsign: string;
  gridsquare: string;
  dxcc: number;
  cq: number;
  itu: number;
  state: string;
  cnty: string;
  pota: string;
  clublog_upload: "disabled";
  eqsl_qth_nickname: "";
}
export interface WavelogStation
  extends Omit<WavelogStationSpec, "clublog_upload" | "eqsl_qth_nickname"> {
  id: number;
  uuid: string;
  active: boolean;
  power: number | null;
  sota: string;
  wwff: string;
  sig: string;
  sig_info: string;
  clublog_upload: "disabled" | "on" | "live";
  eqsl_qth_nickname: string;
}
export interface WavelogLogbook {
  id: number;
  name: string;
  active: boolean;
  station_ids: number[];
}
export interface WavelogRemoteQso {
  id: number;
  stationId: number;
  record: AdifRecord;
}
export interface WavelogQso extends Record<string, unknown> {
  id: number;
  station_id: number;
  call: string;
  band: string;
  mode: string;
  submode: string | null;
  qso_date: string;
}
export type WavelogMatch =
  | { state: "adopted_existing"; record: AdifRecord; remote: WavelogRemoteQso }
  | {
      state:
        | "missing_current_identity"
        | "history_mismatch"
        | "history_ambiguous";
      reason: string;
    };

export const WAVELOG_PASSIVE_FLAGS = Object.freeze({
  LOTW_QSL_SENT: "I",
  EQSL_QSL_SENT: "I",
  CLUBLOG_QSO_UPLOAD_STATUS: "I",
  QRZCOM_QSO_UPLOAD_STATUS: "I",
  HRDLOG_QSO_UPLOAD_STATUS: "I",
  DCL_QSL_SENT: "I",
});
const REQUIRED_SCOPES = ["station:read", "qso:read", "qso:write"];
const MAX_BODY = 2 * 1024 * 1024;
const MAX_CANDIDATES = 200;
const PAGE_SIZE = 100;
const OWNED_FIELDS = [
  "STATION_CALLSIGN",
  "CALL",
  "QSO_DATE",
  "TIME_ON",
  "BAND",
  "MODE",
  "SUBMODE",
  "FREQ",
  "RST_SENT",
  "RST_RCVD",
  "MY_GRIDSQUARE",
  "MY_STATE",
  "MY_CNTY",
  "MY_DXCC",
  "MY_CQ_ZONE",
  "MY_ITU_ZONE",
  "MY_POTA_REF",
  "POTA_REF",
  "OPERATOR",
  "TX_PWR",
];
const NUMERIC_FIELDS = new Set([
  "FREQ",
  "TX_PWR",
  "MY_DXCC",
  "MY_CQ_ZONE",
  "MY_ITU_ZONE",
]);

function fail(code: string): never {
  throw new WavelogError("protocol", code);
}
function blocked(code: string): never {
  throw new WavelogError("blocked", code);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("invalid_object");
  return value as Record<string, unknown>;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  )
    return fail("invalid_integer");
  return value;
}
// GET represents unset legacy station metadata as null. Keep those stations
// visible without treating an unknown zone/entity as a usable routing default.
function stationInteger(value: unknown, max: number): number {
  return value === null || value === 0 ? 0 : integer(value, max);
}
function string(value: unknown, max = 1024): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    return fail("invalid_string");
  return value;
}
function nullableString(value: unknown): string {
  return value === null ? "" : string(value);
}
function call(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (
    !/^[A-Z0-9]+(?:\/[A-Z0-9]+)*$/.test(normalized) ||
    !/[A-Z]/.test(normalized) ||
    !/\d/.test(normalized) ||
    normalized.length > 32
  )
    return blocked("invalid_callsign");
  return normalized;
}
function parks(value: string): string {
  if (!value.trim()) return "";
  const values = value
    .toUpperCase()
    .split(",")
    .map((item) => item.trim())
    .sort();
  if (
    values.length > 16 ||
    values.some((item) => !/^[A-Z0-9]{1,8}-[0-9]{1,8}$/.test(item))
  )
    return blocked("invalid_pota_reference");
  return [...new Set(values)].join(",");
}
function mode(record: AdifRecord): { MODE: string; SUBMODE?: string } {
  let main = (record.MODE ?? "").trim().toUpperCase();
  let sub = (record.SUBMODE ?? "").trim().toUpperCase();
  if (main === "USB" || main === "LSB") {
    sub = main;
    main = "SSB";
  }
  if (main === "FT4" || main === "JS8") {
    sub = main;
    main = "MFSK";
  }
  if (
    !["CW", "SSB", "AM", "FM", "RTTY", "PSK", "FT8", "MFSK"].includes(main) ||
    (sub &&
      !(
        (main === "SSB" && ["USB", "LSB"].includes(sub)) ||
        (main === "MFSK" && ["FT4", "JS8"].includes(sub))
      )) ||
    (main === "MFSK" && !sub)
  )
    return blocked("unsupported_mode");
  return { MODE: main, ...(sub ? { SUBMODE: sub } : {}) };
}
function timestamp(record: AdifRecord): string {
  const date = record.QSO_DATE ?? "";
  const time = record.TIME_ON ?? "";
  if (!/^\d{8}$/.test(date) || !/^\d{6}$/.test(time))
    return blocked("exact_timestamp_required");
  const value = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4)}Z`;
  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    return blocked("invalid_timestamp");
  return value;
}
function normalizedValue(field: string, value: string): string {
  const clean = value.trim();
  if (NUMERIC_FIELDS.has(field)) {
    if (!/^\d+(?:\.\d+)?$/.test(clean) || !Number.isFinite(Number(clean)))
      return blocked("invalid_numeric_field");
    return String(Number(clean));
  }
  if (field === "POTA_REF" || field === "MY_POTA_REF") return parks(clean);
  return clean.toUpperCase();
}
/** Only fields Ferry owns. Upload-state flags and narrative fields are excluded. */
export function wavelogComparable(record: AdifRecord): AdifRecord {
  const result: AdifRecord = {};
  for (const field of OWNED_FIELDS) {
    if ((record[field] ?? "").trim())
      result[field] = normalizedValue(field, record[field]);
  }
  const normalizedMode = mode(record);
  result.MODE = normalizedMode.MODE;
  if (normalizedMode.SUBMODE) result.SUBMODE = normalizedMode.SUBMODE;
  else delete result.SUBMODE;
  return result;
}
export function wavelogIdentity(record: AdifRecord): string {
  const normalized = wavelogComparable(record);
  timestamp(normalized);
  if (!/^\d+(?:\.\d+)?(?:M|CM|MM)$/.test(normalized.BAND ?? ""))
    return blocked("invalid_band");
  return JSON.stringify([
    call(normalized.STATION_CALLSIGN ?? ""),
    normalized.MY_GRIDSQUARE ?? "",
    normalized.MY_POTA_REF ?? "",
    call(normalized.CALL ?? ""),
    normalized.QSO_DATE,
    normalized.TIME_ON,
    normalized.BAND,
    normalized.MODE,
    normalized.SUBMODE ?? "",
  ]);
}
export async function wavelogRemoteIdentity(
  record: AdifRecord,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    canonical({
      version: "wavelog-identity-v1",
      identity: wavelogIdentity(record),
    }),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function wavelogStation(
  contact: Contact,
  defaults: { dxcc?: number; cq?: number; itu?: number } = {},
): WavelogStationSpec {
  const callsign = call(contact.stationCall);
  const grid = contact.grid?.toUpperCase() ?? "";
  if (!/^[A-R]{2}\d{2}(?:[A-X]{2}(?:\d{2})?)?$/.test(grid))
    return blocked("station_grid_required");
  const dxcc = contact.dxcc ?? defaults.dxcc;
  const cq = contact.cqZone ?? defaults.cq;
  const itu = contact.ituZone ?? defaults.itu;
  if (
    !Number.isInteger(dxcc) ||
    !dxcc ||
    dxcc < 1 ||
    dxcc > 999 ||
    !Number.isInteger(cq) ||
    !cq ||
    cq < 1 ||
    cq > 40 ||
    !Number.isInteger(itu) ||
    !itu ||
    itu < 1 ||
    itu > 90
  )
    return blocked("station_entity_zones_required");
  const pota = parks(contact.ownParks.join(","));
  const state = contact.state?.trim().toUpperCase() ?? "";
  let cnty = contact.county?.trim() ?? "";
  if (cnty.includes(",")) {
    const [countyState, ...parts] = cnty.split(",");
    if (!state || countyState.toUpperCase() !== state || parts.length !== 1)
      return blocked("station_county_mismatch");
    cnty = parts[0];
  }
  if (
    cnty &&
    ![
      6, 110, 291, 15, 54, 61, 126, 151, 288, 339, 170, 21, 29, 32, 281,
    ].includes(dxcc)
  )
    return blocked("unsupported_station_county");
  if (
    [...state, ...cnty].some(
      (character) =>
        character.charCodeAt(0) < 32 || character === "<" || character === ">",
    ) ||
    state.length > 64 ||
    cnty.length > 64
  )
    return blocked("invalid_station_subdivision");
  return {
    name: `Ferry ${callsign} ${grid}${pota ? ` ${pota}` : ""}`,
    callsign,
    gridsquare: grid,
    dxcc,
    cq,
    itu,
    state,
    cnty,
    pota,
    clublog_upload: "disabled",
    eqsl_qth_nickname: "",
  };
}
export function wavelogStationMatches(
  station: WavelogStation,
  spec: WavelogStationSpec,
): boolean {
  return (
    [
      "callsign",
      "gridsquare",
      "dxcc",
      "cq",
      "itu",
      "state",
      "cnty",
      "pota",
    ].every(
      (key) =>
        String(station[key as keyof WavelogStation])
          .trim()
          .toUpperCase() ===
        String(spec[key as keyof WavelogStationSpec])
          .trim()
          .toUpperCase(),
    ) &&
    station.clublog_upload === "disabled" &&
    station.eqsl_qth_nickname === "" &&
    !station.sota &&
    !station.wwff &&
    !station.sig &&
    !station.sig_info
  );
}
export function wavelogRecord(
  contact: Contact,
  defaults: { dxcc?: number; cq?: number; itu?: number } = {},
): AdifRecord {
  if (contact.deleted || contact.startAtMillis % 1000)
    return blocked("unexportable_contact");
  // 3.2.4 invents a band-dependent frequency when FREQ is absent. Preserve
  // source truth by refusing that import before any remote write.
  if (contact.frequencyMHz === undefined) return blocked("frequency_required");
  const station = wavelogStation(contact, defaults);
  const iso = new Date(contact.startAtMillis).toISOString();
  const record: AdifRecord = {
    STATION_CALLSIGN: station.callsign,
    CALL: call(contact.call),
    QSO_DATE: iso.slice(0, 10).replaceAll("-", ""),
    TIME_ON: iso.slice(11, 19).replaceAll(":", ""),
    BAND: contact.band.toLowerCase(),
    ...mode({
      MODE: contact.mode,
      ...(contact.submode ? { SUBMODE: contact.submode } : {}),
    }),
    MY_GRIDSQUARE: station.gridsquare,
    MY_DXCC: String(station.dxcc),
    MY_CQ_ZONE: String(station.cq),
    MY_ITU_ZONE: String(station.itu),
    ...WAVELOG_PASSIVE_FLAGS,
  };
  if (station.state) record.MY_STATE = station.state;
  if (station.cnty)
    record.MY_CNTY = [6, 110, 291].includes(station.dxcc)
      ? `${station.state},${station.cnty}`
      : station.cnty;
  if (station.pota) record.MY_POTA_REF = station.pota;
  if (contact.workedParks.length)
    record.POTA_REF = parks(contact.workedParks.join(","));
  if (contact.frequencyMHz !== undefined) {
    if (
      !Number.isFinite(contact.frequencyMHz) ||
      contact.frequencyMHz <= 0 ||
      Math.abs(
        contact.frequencyMHz * 1e6 - Math.round(contact.frequencyMHz * 1e6),
      ) > 0.000001
    )
      return blocked("invalid_frequency");
    record.FREQ = String(contact.frequencyMHz);
  }
  if (contact.power !== undefined) {
    if (
      !Number.isFinite(contact.power) ||
      contact.power <= 0 ||
      Math.abs(contact.power * 1000 - Math.round(contact.power * 1000)) >
        0.000001
    )
      return blocked("invalid_power");
    record.TX_PWR = String(contact.power);
  }
  if (contact.operatorCall) record.OPERATOR = call(contact.operatorCall);
  if (contact.rstSent) record.RST_SENT = contact.rstSent;
  if (contact.rstReceived) record.RST_RCVD = contact.rstReceived;
  wavelogIdentity(record);
  serializeAdifRecord(record);
  return record;
}
/** No supported correction can promise preserved passive flags on 3.2.4. */
export function wavelogPatch(_previous: AdifRecord, _next: AdifRecord): never {
  return blocked("correction_requires_manual_review");
}
export function matchWavelogHistory(
  source: AdifRecord,
  remote: WavelogRemoteQso[],
  options: { requirePassive?: boolean; strictAbsent?: boolean } = {},
): WavelogMatch {
  const desired = wavelogComparable(source);
  const identity = wavelogIdentity(source);
  const exact = remote.filter(
    (item) => wavelogIdentity(item.record) === identity,
  );
  if (exact.length > 1)
    return {
      state: "history_ambiguous",
      reason: "wavelog_multiple_exact_matches",
    };
  if (!exact.length) {
    const nearby = remote.some((item) => {
      const row = wavelogComparable(item.record);
      return (
        row.CALL === desired.CALL &&
        row.QSO_DATE === desired.QSO_DATE &&
        row.TIME_ON.slice(0, 4) === desired.TIME_ON.slice(0, 4) &&
        row.BAND === desired.BAND &&
        row.MODE === desired.MODE
      );
    });
    return nearby
      ? {
          state: "history_mismatch",
          reason: "wavelog_duplicate_minute_collision",
        }
      : { state: "missing_current_identity", reason: "wavelog_qso_missing" };
  }
  const item = exact[0];
  const observed = wavelogComparable(item.record);
  const keys = options.strictAbsent ? OWNED_FIELDS : Object.keys(desired);
  if (keys.some((key) => (desired[key] ?? "") !== (observed[key] ?? "")))
    return { state: "history_mismatch", reason: "wavelog_owned_fields_differ" };
  if (
    options.requirePassive &&
    Object.keys(WAVELOG_PASSIVE_FLAGS).some(
      (field) => item.record[field] !== "I",
    )
  )
    return {
      state: "history_mismatch",
      reason: "wavelog_passive_flags_unverified",
    };
  return { state: "adopted_existing", record: item.record, remote: item };
}

function parseStation(value: unknown): WavelogStation {
  const data = object(value);
  const upload = data.clublog_upload;
  if (
    !["disabled", "on", "live"].includes(String(upload)) ||
    typeof data.active !== "boolean"
  )
    return fail("station_capabilities_unverified");
  if (
    data.power !== null &&
    (typeof data.power !== "number" || !Number.isFinite(data.power))
  )
    return fail("invalid_station_power");
  const uuid = string(data.uuid, 64);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      uuid,
    )
  )
    return fail("invalid_station_uuid");
  return {
    id: integer(data.id),
    uuid,
    name: string(data.name),
    callsign: call(string(data.callsign)),
    gridsquare: nullableString(data.gridsquare).toUpperCase(),
    dxcc: stationInteger(data.dxcc, 999),
    cq: stationInteger(data.cq, 40),
    itu: stationInteger(data.itu, 90),
    state: nullableString(data.state),
    cnty: nullableString(data.cnty),
    pota: parks(nullableString(data.pota)),
    sota: nullableString(data.sota),
    wwff: nullableString(data.wwff),
    sig: nullableString(data.sig),
    sig_info: nullableString(data.sig_info),
    active: data.active,
    power: data.power as number | null,
    clublog_upload: upload as WavelogStation["clublog_upload"],
    eqsl_qth_nickname: nullableString(data.eqsl_qth_nickname),
  };
}
function parseLogbook(value: unknown): WavelogLogbook {
  const data = object(value);
  if (
    !Array.isArray(data.station_ids) ||
    data.station_ids.length > 1000 ||
    typeof data.active !== "boolean"
  )
    return fail("invalid_logbook");
  const ids = data.station_ids.map((id) => integer(id));
  if (new Set(ids).size !== ids.length) return fail("duplicate_station_links");
  return {
    id: integer(data.id),
    name: string(data.name),
    active: data.active,
    station_ids: ids,
  };
}
function parseQso(value: unknown): WavelogQso {
  const data = object(value);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(string(data.qso_date)))
    return fail("invalid_qso_timestamp");
  const qso = {
    ...data,
    id: integer(data.id),
    station_id: integer(data.station_id),
    call: call(string(data.call)),
    band: string(data.band),
    mode: string(data.mode),
    submode: data.submode === null ? null : string(data.submode),
    qso_date: string(data.qso_date),
  };
  timestamp(jsonRecord(qso));
  return qso;
}
function jsonRecord(qso: WavelogQso): AdifRecord {
  const result: AdifRecord = {
    CALL: qso.call,
    BAND: qso.band,
    MODE: qso.mode,
    QSO_DATE: qso.qso_date.slice(0, 10).replaceAll("-", ""),
    TIME_ON: qso.qso_date.slice(11).replaceAll(":", ""),
  };
  if (qso.submode) result.SUBMODE = qso.submode;
  for (const [json, adif] of [
    ["freq", "FREQ"],
    ["rst_sent", "RST_SENT"],
    ["rst_rcvd", "RST_RCVD"],
    ["pota_ref", "POTA_REF"],
  ]) {
    const value = qso[json];
    if (value !== undefined && value !== null && value !== "") {
      if (typeof value !== "string" && typeof value !== "number")
        return fail("invalid_qso_field");
      result[adif] =
        json === "freq" ? String(Number(value) / 1e6) : String(value);
    }
  }
  return result;
}
function correlationIdentity(record: AdifRecord): string {
  const row = wavelogComparable(record);
  timestamp(row);
  return JSON.stringify([
    call(row.CALL ?? ""),
    row.QSO_DATE,
    row.TIME_ON,
    row.BAND,
    row.MODE,
    row.SUBMODE ?? "",
  ]);
}
function parseInventory(adif: unknown, count: number): AdifRecord[] {
  if (!count && adif === null) return [];
  if (
    typeof adif !== "string" ||
    !adif.trim() ||
    /^\s*<(?:!doctype|html|body|form)\b/i.test(adif)
  )
    return fail("invalid_adif_inventory");
  let parsed: ReturnType<typeof parseAdif>;
  try {
    parsed = parseAdif(adif);
  } catch {
    return fail("invalid_adif_inventory");
  }
  if (
    !/^\d+\.\d+\.\d+$/.test(parsed.header.ADIF_VER ?? "") ||
    parsed.records.length !== count
  )
    return fail("incomplete_adif_inventory");
  let pos = adif.indexOf("<");
  let endMarker = "";
  while (pos < adif.length) {
    pos += /^\s*/.exec(adif.slice(pos))?.[0].length ?? 0;
    if (pos === adif.length) break;
    if (adif[pos] !== "<") return fail("invalid_adif_trailer");
    const end = adif.indexOf(">", pos);
    const tag = adif.slice(pos + 1, end).toUpperCase();
    pos = end + 1;
    endMarker = tag;
    if (tag === "EOH" || tag === "EOR") continue;
    const match = /^[A-Z][A-Z0-9_]*:(\d+)(?::[A-Z])?$/.exec(tag);
    if (!match) return fail("invalid_adif_framing");
    pos += Number(match[1]);
  }
  if (endMarker !== (count ? "EOR" : "EOH"))
    return fail("incomplete_adif_inventory");
  return parsed.records;
}
async function boundedBody(response: Response): Promise<string> {
  const declared = response.headers.get("Content-Length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)
  ) {
    await response.body?.cancel().catch(() => undefined);
    return fail("invalid_response_length");
  }
  if (!response.body) return fail("missing_response_body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > MAX_BODY) return fail("response_exceeds_bound");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (
    declared !== null &&
    !response.headers.get("Content-Encoding") &&
    Number(declared) !== length
  )
    return fail("truncated_response");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
interface Envelope {
  data: unknown;
  meta?: unknown;
}

export class WavelogClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly transport: typeof fetch;
  private halted = false;
  constructor(
    credentials: WavelogCredentials,
    private readonly options: WavelogOptions = {},
  ) {
    try {
      this.baseUrl = options.allowedBaseUrls
        ? assertWavelogBaseUrlAllowed(
            credentials.baseUrl,
            options.allowedBaseUrls,
          )
        : normalizeWavelogBaseUrl(credentials.baseUrl);
    } catch {
      throw new WavelogError("blocked", "installation_not_allowed");
    }
    if (
      typeof credentials.token !== "string" ||
      !/^wl2_[A-Za-z0-9_-]{20,256}$/.test(credentials.token)
    )
      throw new WavelogError("auth", "invalid_token_format");
    this.token = credentials.token;
    this.transport = options.fetcher ?? fetch;
  }
  private async request(
    path: string,
    method: "GET" | "POST" | "PATCH" = "GET",
    body?: unknown,
  ): Promise<Envelope> {
    if (this.halted) return blocked("connection_suspended");
    const mutating = method !== "GET";
    if (mutating && (!this.options.writesEnabled || !this.options.beforeWrite))
      return blocked("writes_disabled");
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && new TextEncoder().encode(encoded).length > 128 * 1024)
      return blocked("request_exceeds_bound");
    if (mutating && !(await this.options.beforeWrite?.()))
      return blocked("authorization_changed");
    let response: Response;
    try {
      response = await this.transport.call(
        globalThis,
        `${this.baseUrl}index.php/api/v2/${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
            ...(encoded ? { "Content-Type": "application/json" } : {}),
          },
          body: encoded,
          redirect: "manual",
          signal: AbortSignal.timeout(20000),
        },
      );
    } catch (error) {
      if (error instanceof VendorDeferredError && !error.requestSent)
        throw error;
      throw new WavelogError(
        mutating ? "uncertain" : "protocol",
        "transport_failed",
        {
          requestSent: true,
          ...(error instanceof VendorDeferredError
            ? { retryAt: error.retryAt }
            : {}),
        },
      );
    }
    const discard = async () => {
      await response.body?.cancel().catch(() => undefined);
    };
    if (
      response.redirected ||
      response.type === "opaque" ||
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)
    ) {
      await discard();
      this.halted = true;
      throw new WavelogError(
        mutating ? "uncertain" : "protocol",
        "redirect_refused",
        { requestSent: true, suspend: true },
      );
    }
    if (response.status === 401 || response.status === 403) {
      await discard();
      this.halted = true;
      throw new WavelogError("auth", "access_rejected", { requestSent: true });
    }
    if (response.status === 429) {
      const raw = response.headers.get("Retry-After");
      await discard();
      const seconds = raw && /^\d{1,8}$/.test(raw) ? Number(raw) : 60;
      throw new WavelogError("rate", "rate_limited", {
        requestSent: true,
        retryAt: Date.now() + Math.max(1, seconds) * 1000,
      });
    }
    if (
      ![200, 201].includes(response.status) ||
      (!mutating && response.status !== 200)
    ) {
      await discard();
      throw new WavelogError(
        response.status >= 400 && response.status < 500
          ? "rejected"
          : mutating
            ? "uncertain"
            : "protocol",
        response.status === 409
          ? "conflict"
          : response.status === 404
            ? "not_found"
            : "http_rejected",
        { requestSent: true },
      );
    }
    try {
      if (
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get("Content-Type") ?? "",
        )
      ) {
        await discard();
        return fail("invalid_content_type");
      }
      const envelope = object(JSON.parse(await boundedBody(response)));
      if (!Object.hasOwn(envelope, "data") || Object.hasOwn(envelope, "error"))
        return fail("invalid_response_envelope");
      return { data: envelope.data, meta: envelope.meta };
    } catch {
      throw new WavelogError(
        mutating ? "uncertain" : "protocol",
        "invalid_response",
        { requestSent: true },
      );
    }
  }
  async verifyLogin(
    requiredScopes: readonly string[] = REQUIRED_SCOPES,
  ): Promise<WavelogToken> {
    const data = object((await this.request("token")).data);
    if (
      !Array.isArray(data.scopes) ||
      data.scopes.length > 64 ||
      data.scopes.some(
        (scope) =>
          typeof scope !== "string" ||
          !/^[a-z]+:(?:read|write|delete)$/.test(scope),
      )
    )
      return fail("invalid_token_scopes");
    const scopes = data.scopes as string[];
    if (requiredScopes.some((scope) => !scopes.includes(scope)))
      throw new WavelogError("auth", "required_scopes_missing");
    return {
      id: integer(data.id),
      user_id: integer(data.user_id),
      owner: string(data.owner, 128),
      scopes,
      expires_at: data.expires_at === null ? null : string(data.expires_at, 32),
    };
  }
  async listStations(): Promise<WavelogStation[]> {
    const data = (await this.request("station")).data;
    if (!Array.isArray(data) || data.length > 1000)
      return fail("station_inventory_exceeds_bound");
    const result = data.map(parseStation);
    if (
      new Set(result.map((item) => item.id)).size !== result.length ||
      new Set(result.map((item) => item.uuid)).size !== result.length
    )
      return fail("duplicate_station_identity");
    return result;
  }
  async getStation(id: number): Promise<WavelogStation> {
    const station = parseStation(
      (await this.request(`station/${integer(id)}`)).data,
    );
    if (station.id !== id) return fail("station_id_mismatch");
    return station;
  }
  async createStation(spec: WavelogStationSpec): Promise<WavelogStation> {
    // Restrict input to the immutable core specification; never accept credentials.
    const body = {
      name: spec.name,
      callsign: spec.callsign,
      gridsquare: spec.gridsquare,
      dxcc: spec.dxcc,
      cq: spec.cq,
      itu: spec.itu,
      state: spec.state,
      cnty: spec.cnty,
      pota: spec.pota,
      clublog_upload: "disabled",
      eqsl_qth_nickname: "",
    };
    const response = await this.request("station", "POST", body);
    try {
      const receipt = parseStation(response.data);
      const observed = await this.getStation(receipt.id);
      if (
        observed.uuid !== receipt.uuid ||
        observed.name !== spec.name ||
        !wavelogStationMatches(observed, spec)
      )
        return fail("station_readback_mismatch");
      return observed;
    } catch (error) {
      throw this.uncertain(error, "station_creation_unresolved");
    }
  }
  async getLogbook(id: number): Promise<WavelogLogbook> {
    const logbook = parseLogbook(
      (await this.request(`logbook/${integer(id)}`)).data,
    );
    if (logbook.id !== id) return fail("logbook_id_mismatch");
    return logbook;
  }
  /** API replaces the whole list: caller must serialize linking and retain its intent. */
  async linkStation(
    logbookId: number,
    stationId: number,
  ): Promise<WavelogLogbook> {
    integer(stationId);
    const current = await this.getLogbook(logbookId);
    if (current.station_ids.includes(stationId)) return current;
    const ids = [...current.station_ids, stationId].sort((a, b) => a - b);
    await this.request(`logbook/${logbookId}`, "PATCH", { station_ids: ids });
    try {
      const observed = await this.getLogbook(logbookId);
      if (
        observed.station_ids.length !== ids.length ||
        ids.some((id) => !observed.station_ids.includes(id))
      )
        return fail("logbook_readback_mismatch");
      return observed;
    } catch (error) {
      throw this.uncertain(error, "logbook_link_unresolved");
    }
  }
  async getQso(id: number): Promise<WavelogQso> {
    const qso = parseQso((await this.request(`qso/${integer(id)}`)).data);
    if (qso.id !== id) return fail("qso_id_mismatch");
    return qso;
  }
  private async candidatePages(
    stationId: number,
    source: AdifRecord,
    format: "json" | "adif",
  ): Promise<unknown[]> {
    integer(stationId);
    const at = timestamp(source);
    const output: unknown[] = [];
    let total: number | undefined;
    for (let page = 1; page <= MAX_CANDIDATES / PAGE_SIZE; page++) {
      // Never filter BAND: Wavelog excludes satellite QSOs from ordinary band filters.
      const query = new URLSearchParams({
        station_id: String(stationId),
        callsign: call(source.CALL),
        qso_since: at.slice(0, 10),
        qso_until: at.slice(0, 10),
        per_page: String(PAGE_SIZE),
        page: String(page),
        format,
      });
      const response = await this.request(`qso?${query}`);
      const meta = object(response.meta);
      if (
        !Number.isSafeInteger(meta.total) ||
        Number(meta.total) < 0 ||
        Number(meta.total) > MAX_CANDIDATES ||
        meta.page !== page ||
        meta.per_page !== PAGE_SIZE ||
        !Number.isSafeInteger(meta.count) ||
        Number(meta.count) < 0 ||
        Number(meta.count) > PAGE_SIZE ||
        typeof meta.has_more !== "boolean"
      )
        return fail("incomplete_candidate_page");
      if (total !== undefined && total !== meta.total)
        return fail("candidate_inventory_changed");
      total = Number(meta.total);
      let rows: unknown[];
      if (format === "json") {
        if (!Array.isArray(response.data)) return fail("invalid_qso_inventory");
        rows = response.data;
      } else {
        const data = object(response.data);
        if (data.exported !== meta.count) return fail("adif_count_mismatch");
        rows = parseInventory(data.adif, Number(data.exported));
      }
      if (rows.length !== meta.count || output.length + rows.length > total)
        return fail("candidate_count_mismatch");
      output.push(...rows);
      if (!meta.has_more) {
        if (output.length !== total)
          return fail("candidate_inventory_truncated");
        return output;
      }
      if (rows.length !== PAGE_SIZE || output.length >= total)
        return fail("candidate_pagination_invalid");
    }
    return fail("candidate_inventory_exceeds_bound");
  }
  async findQsos(
    stationId: number,
    source: AdifRecord,
  ): Promise<WavelogRemoteQso[]> {
    const json = (await this.candidatePages(stationId, source, "json")).map(
      parseQso,
    );
    const adif = (await this.candidatePages(
      stationId,
      source,
      "adif",
    )) as AdifRecord[];
    if (
      json.length !== adif.length ||
      new Set(json.map((row) => row.id)).size !== json.length
    )
      return fail("candidate_inventory_changed");
    const used = new Set<number>();
    return json.map((qso) => {
      const row = jsonRecord(qso);
      if (
        qso.station_id !== stationId ||
        qso.call !== call(source.CALL) ||
        row.QSO_DATE !== source.QSO_DATE
      )
        return fail("candidate_scope_mismatch");
      const identity = correlationIdentity(row);
      const matches = adif.flatMap((record, index) =>
        correlationIdentity(record) === identity ? [{ record, index }] : [],
      );
      if (matches.length !== 1 || used.has(matches[0].index))
        return fail("ambiguous_adif_id_correlation");
      const match = matches[0];
      used.add(match.index);
      if (
        call(match.record.STATION_CALLSIGN ?? "") !==
        call(source.STATION_CALLSIGN)
      )
        return fail("candidate_station_mismatch");
      const normalized = wavelogComparable(match.record);
      const fromJson = wavelogComparable(row);
      if (
        Object.entries(fromJson).some(
          ([field, value]) => normalized[field] !== value,
        )
      )
        return fail("candidate_readback_changed");
      return {
        id: qso.id,
        stationId,
        record: { ...match.record, APP_WAVELOG_ID: String(qso.id) },
      };
    });
  }
  async readQso(id: number): Promise<WavelogRemoteQso> {
    const row = await this.getQso(id);
    const station = await this.getStation(row.station_id);
    const source = { ...jsonRecord(row), STATION_CALLSIGN: station.callsign };
    const records = await this.findQsos(row.station_id, source);
    const found = records.find((item) => item.id === id);
    if (
      !found ||
      correlationIdentity(found.record) !== correlationIdentity(source)
    )
      return fail("qso_readback_changed");
    return found;
  }
  async createQso(
    stationId: number,
    record: AdifRecord,
  ): Promise<WavelogRemoteQso> {
    integer(stationId);
    wavelogIdentity(record);
    for (const field of Object.keys(record))
      if (
        !OWNED_FIELDS.includes(field) &&
        !Object.hasOwn(WAVELOG_PASSIVE_FLAGS, field)
      )
        return blocked("unsupported_outbound_field");
    if (!record.TX_PWR?.trim()) {
      const station = await this.getStation(stationId);
      if (station.power !== null && station.power !== 0)
        return blocked("station_default_power_unowned");
    }
    const outbound = { ...record, ...WAVELOG_PASSIVE_FLAGS };
    const adif = `<ADIF_VER:5>3.1.6<PROGRAMID:12>LoFiQSOFerry<EOH>\n${serializeAdifRecord(outbound)}\n`;
    await this.request("qso", "POST", {
      import_type: "adif",
      station_profile_id: stationId,
      adif,
    });
    try {
      const found = matchWavelogHistory(
        outbound,
        await this.findQsos(stationId, outbound),
        { requirePassive: true, strictAbsent: true },
      );
      if (found.state !== "adopted_existing")
        return fail("qso_readback_mismatch");
      return found.remote;
    } catch (error) {
      throw this.uncertain(error, "qso_creation_unresolved");
    }
  }
  private uncertain(error: unknown, code: string): WavelogError {
    return new WavelogError("uncertain", code, {
      requestSent: true,
      suspend: error instanceof WavelogError && error.suspend,
      ...(error instanceof WavelogError || error instanceof VendorDeferredError
        ? { retryAt: error.retryAt }
        : {}),
    });
  }
}
