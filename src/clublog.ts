import { type AdifRecord, parseAdif, serializeAdifRecord } from "./adif.ts";
import type { Contact } from "./projection.ts";
import { canonical, sha256 } from "./security.ts";
import { VendorDeferredError } from "./vendor-requests.ts";

export const CLUBLOG_ENDPOINT = "https://clublog.org";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 8192;

export class ClubLogError extends Error {
  readonly suspend: boolean;
  constructor(
    readonly kind:
      | "auth"
      | "rejected"
      | "transient"
      | "uncertain"
      | "protocol"
      | "blocked",
    message: string,
    suspend = kind === "auth" || kind === "rejected",
  ) {
    super(message);
    this.name = "ClubLogError";
    this.suspend = suspend;
  }
}

export interface ClubLogCredentials {
  email: string;
  password: string;
  callsign: string;
}
export interface ClubLogOptions {
  /** Application credential, separate from the user's application password. */
  apiKey?: string;
  fetch?: typeof fetch;
  fetcher?: typeof fetch;
  version?: string;
  writesEnabled?: boolean;
  beforeWrite?: () => Promise<boolean>;
}
export interface ClubLogIdentity {
  stationCallsign: string;
  call: string;
  date: string;
  time: string;
  band: string;
  mode: string;
}
export interface ClubLogUploadResult {
  /** A receipt never substitutes for independent readback of the record. */
  state: "accepted" | "submitted" | "duplicate";
}
export type ClubLogMatch =
  | { state: "missing_current_identity" }
  | { state: "history_ambiguous" | "history_mismatch"; reason: string }
  | { state: "adopted_existing"; record: AdifRecord };

// These are the documented retained structured fields this integration owns.
// Never project own-location fields into the contacted station's GRIDSQUARE.
const STRUCTURED_FIELDS = [
  "CALL",
  "QSO_DATE",
  "TIME_ON",
  "TIME_OFF",
  "BAND",
  "BAND_RX",
  "MODE",
  "FREQ",
  "OPERATOR",
  "RST_SENT",
  "RST_RCVD",
  "PROP_MODE",
  "SAT_NAME",
] as const;
const UPLOAD_FIELDS = new Set<string>(STRUCTURED_FIELDS);
const OPTIONAL_CORRECTION_FIELDS = new Set([
  "FREQ",
  "OPERATOR",
  "RST_SENT",
  "RST_RCVD",
]);
const BAND_IDS: Readonly<Record<string, string>> = {
  "160M": "160",
  "80M": "80",
  "60M": "60",
  "40M": "40",
  "30M": "30",
  "20M": "20",
  "17M": "17",
  "15M": "15",
  "12M": "12",
  "10M": "10",
  "6M": "6",
  "4M": "4",
  "2M": "2",
  "70CM": "70",
  "23CM": "23",
  "13CM": "13",
};

function callsign(value: string | undefined): string {
  if (!value || !/^[A-Z0-9][A-Z0-9/]{1,31}$/i.test(value))
    throw new ClubLogError("protocol", "Invalid Club Log callsign");
  return value.toUpperCase();
}

function instant(date: string, time: string): number {
  if (!/^\d{8}$/.test(date) || !/^\d{4}(?:\d{2})?$/.test(time))
    throw new ClubLogError("protocol", "Invalid Club Log date/time");
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6) || "00"}Z`;
  const value = Date.parse(iso);
  if (
    !Number.isFinite(value) ||
    new Date(value).toISOString().slice(0, 19) !== iso.slice(0, 19)
  )
    throw new ClubLogError("protocol", "Invalid Club Log date/time");
  return value;
}

function normalizedMode(record: AdifRecord): string {
  const mode = (record.MODE ?? "").toUpperCase();
  const submode = (record.SUBMODE ?? "").toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,23}$/.test(mode))
    throw new ClubLogError("protocol", "Invalid Club Log mode");
  // Club Log's projection is SSB, not the radio's sideband setting.
  if (mode === "SSB" && ["", "USB", "LSB", "SSB"].includes(submode))
    return mode;
  if (submode && submode !== mode)
    throw new ClubLogError(
      "blocked",
      "Club Log submode mapping requires verified readback",
    );
  return mode;
}

export function clublogIdentity(record: AdifRecord): ClubLogIdentity {
  const date = record.QSO_DATE ?? "";
  const time = record.TIME_ON ?? "";
  instant(date, time);
  const band = (record.BAND ?? "").toUpperCase();
  if (!BAND_IDS[band])
    throw new ClubLogError("blocked", "Unsupported Club Log band");
  return {
    stationCallsign: callsign(record.STATION_CALLSIGN),
    call: callsign(record.CALL),
    date,
    // Preserve precision: HHMM and HHMM00 do not prove the same identity.
    time,
    band,
    mode: normalizedMode(record),
  };
}

/** Stable local mapping key; Club Log does not expose a per-QSO record ID. */
export async function clublogRemoteIdentity(
  record: AdifRecord,
): Promise<string> {
  return sha256(canonical(clublogIdentity(record)));
}

/** The exact supported structured projection, plus account routing identity. */
export function clublogRecord(contact: Contact): AdifRecord {
  if (contact.deleted)
    throw new ClubLogError("blocked", "Deleted contacts cannot be exported");
  if (
    !Number.isSafeInteger(contact.startAtMillis) ||
    contact.startAtMillis % 1000
  )
    throw new ClubLogError(
      "blocked",
      "Club Log requires whole-second QSO time",
    );
  const date = new Date(contact.startAtMillis);
  if (!Number.isFinite(date.getTime()))
    throw new ClubLogError("protocol", "Invalid Club Log QSO time");
  const iso = date.toISOString();
  const record: AdifRecord = {
    STATION_CALLSIGN: callsign(contact.stationCall),
    CALL: callsign(contact.call),
    QSO_DATE: iso.slice(0, 10).replaceAll("-", ""),
    TIME_ON: iso.slice(11, 19).replaceAll(":", ""),
    BAND: contact.band.toUpperCase(),
    MODE: normalizedMode({
      MODE: contact.mode,
      SUBMODE: contact.submode ?? "",
    }),
  };
  for (const [field, value] of [
    ["FREQ", contact.frequencyMHz],
    ["OPERATOR", contact.operatorCall],
    ["RST_SENT", contact.rstSent],
    ["RST_RCVD", contact.rstReceived],
  ] as const)
    if (value !== undefined && value !== "") record[field] = String(value);
  if (record.OPERATOR) record.OPERATOR = callsign(record.OPERATOR);
  if (record.FREQ && normalizedFrequency(record.FREQ) === null)
    throw new ClubLogError("protocol", "Invalid Club Log frequency");
  clublogIdentity(record);
  serializeAdifRecord(record);
  return record;
}

function normalizedFrequency(value: string): string | null {
  if (
    !/^\d+(?:\.\d+)?$/.test(value) ||
    !Number.isFinite(Number(value)) ||
    Number(value) <= 0
  )
    return null;
  const [whole, fraction = ""] = value.split(".");
  const decimals = fraction.replace(/0+$/, "");
  return `${whole.replace(/^0+(?=\d)/, "")}${decimals ? `.${decimals}` : ""}`;
}

/**
 * The caller must supply a complete inventory for the bound account. Nearby
 * or minute-only records are ambiguity, never proof that an upload is absent.
 */
export function matchClublogHistory(
  source: AdifRecord,
  remote: AdifRecord[],
  options: { strictAbsence?: boolean } = {},
): ClubLogMatch {
  let desired: ClubLogIdentity;
  try {
    desired = clublogIdentity(source);
  } catch {
    return {
      state: "history_ambiguous",
      reason: "Source Club Log identity is unsupported",
    };
  }
  let candidates: { record: AdifRecord; identity: ClubLogIdentity }[];
  try {
    const at = instant(desired.date, desired.time);
    candidates = remote
      .map((record) => ({ record, identity: clublogIdentity(record) }))
      .filter(
        ({ identity }) =>
          identity.stationCallsign === desired.stationCallsign &&
          identity.call === desired.call &&
          identity.band === desired.band &&
          Math.abs(instant(identity.date, identity.time) - at) <=
            30 * 60000 + 59000,
      );
  } catch {
    return {
      state: "history_ambiguous",
      reason: "Club Log inventory contains unsupported identity evidence",
    };
  }
  if (!candidates.length) return { state: "missing_current_identity" };
  const exact = candidates.filter(
    ({ identity }) => canonical(identity) === canonical(desired),
  );
  if (candidates.length !== 1 || exact.length !== 1)
    return {
      state: "history_ambiguous",
      reason:
        "No unique exact Club Log identity, including time precision and mode",
    };
  const record = exact[0].record;
  // Match only our supported projection. Remote narratives, confirmations,
  // DXCC calculations and unsupported own-location fields are not ours.
  for (const field of STRUCTURED_FIELDS) {
    if (["CALL", "QSO_DATE", "TIME_ON", "BAND", "MODE"].includes(field))
      continue;
    if (!source[field]) {
      if (
        options.strictAbsence &&
        OPTIONAL_CORRECTION_FIELDS.has(field) &&
        record[field]
      )
        return {
          state: "history_mismatch",
          reason: `Club Log field ${field} remains present remotely`,
        };
      continue;
    }
    const local =
      field === "FREQ"
        ? normalizedFrequency(source[field])
        : source[field].toUpperCase();
    const observed = record[field]
      ? field === "FREQ"
        ? normalizedFrequency(record[field])
        : record[field].toUpperCase()
      : null;
    if (local === null || observed === null)
      return {
        state: "history_ambiguous",
        reason: `Club Log evidence ${field} is unavailable`,
      };
    if (local !== observed)
      return {
        state: "history_mismatch",
        reason: `Club Log field ${field} differs`,
      };
  }
  return { state: "adopted_existing", record };
}

async function boundedBody(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get("Content-Length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > limit)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new ClubLogError("protocol", "Invalid Club Log response length");
  }
  if (!response.body)
    throw new ClubLogError("protocol", "Missing Club Log response body");
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > limit)
        throw new ClubLogError("protocol", "Club Log response exceeds bound");
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
    throw new ClubLogError("protocol", "Truncated Club Log response");
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(data);
}

/** Strict inventory framing; the generic ADIF parser permits trailing prose. */
function downloadRecords(body: string, station: string): AdifRecord[] {
  if (
    !body.trim() ||
    /^\s*<(?:!doctype|html|head|body|script|form)\b/i.test(body)
  )
    throw new ClubLogError("protocol", "Invalid Club Log inventory framing");
  const document = parseAdif(body);
  if (!/^\d+\.\d+\.\d+$/.test(document.header.ADIF_VER ?? ""))
    throw new ClubLogError("protocol", "Missing Club Log ADIF header");
  let pos = body.indexOf("<");
  let hadHeader = false;
  let lastTag = "";
  while (pos < body.length) {
    const gap = /^\s*/.exec(body.slice(pos))?.[0].length ?? 0;
    pos += gap;
    if (pos === body.length) break;
    if (body[pos] !== "<")
      throw new ClubLogError(
        "protocol",
        "Unexpected Club Log inventory trailer",
      );
    const end = body.indexOf(">", pos);
    const tag = body.slice(pos + 1, end).toUpperCase();
    pos = end + 1;
    lastTag = tag;
    if (tag === "EOH") {
      hadHeader = true;
      continue;
    }
    if (tag === "EOR") continue;
    const match = /^[A-Z][A-Z0-9_]*:(\d+)(?::[A-Z])?$/.exec(tag);
    if (!match)
      throw new ClubLogError("protocol", "Invalid Club Log inventory tag");
    pos += Number(match[1]);
  }
  if (!hadHeader || lastTag !== (document.records.length ? "EOR" : "EOH"))
    throw new ClubLogError("protocol", "Incomplete Club Log inventory");
  return document.records.map((record) => {
    if (
      record.STATION_CALLSIGN &&
      callsign(record.STATION_CALLSIGN) !== station
    )
      throw new ClubLogError("protocol", "Club Log inventory account mismatch");
    const bound = { ...record, STATION_CALLSIGN: station };
    clublogIdentity(bound);
    return bound;
  });
}

export class ClubLogClient {
  private readonly transport: typeof fetch;
  private readonly credentials: ClubLogCredentials;
  private halted = false;
  constructor(
    credentials: ClubLogCredentials,
    private readonly options: ClubLogOptions = {},
  ) {
    if (
      !credentials.email ||
      credentials.email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(credentials.email) ||
      !credentials.password ||
      credentials.password.length > 1024
    )
      throw new ClubLogError("auth", "Club Log credentials are incomplete");
    this.credentials = {
      ...credentials,
      callsign: callsign(credentials.callsign),
    };
    this.transport = options.fetcher ?? options.fetch ?? fetch;
  }

  private async request(
    path: string,
    values: Record<string, string>,
    mutating: boolean,
    file?: string,
  ): Promise<string> {
    if (this.halted)
      throw new ClubLogError(
        "blocked",
        "Club Log requests suspended after rejection",
      );
    if (mutating && !this.options.writesEnabled)
      throw new ClubLogError("blocked", "Club Log writes are disabled");
    const apiKey = this.options.apiKey ?? "";
    if (mutating && !apiKey)
      throw new ClubLogError(
        "blocked",
        "Club Log application API key is missing",
      );
    if (
      mutating &&
      this.options.beforeWrite &&
      !(await this.options.beforeWrite())
    )
      throw new ClubLogError(
        "blocked",
        "Club Log authorization changed before dispatch",
      );
    const fields = {
      email: this.credentials.email,
      password: this.credentials.password,
      ...values,
      ...(mutating ? { api: apiKey } : {}),
    };
    let body: URLSearchParams | FormData;
    const headers = new Headers({
      "User-Agent": `LoFiQSOFerry/${this.options.version ?? "0.1.0"}`,
    });
    if (file !== undefined) {
      body = new FormData();
      for (const [key, value] of Object.entries(fields)) body.set(key, value);
      body.set("file", new Blob([file], { type: "text/plain" }), "ferry.adi");
    } else {
      body = new URLSearchParams(fields);
      headers.set("Content-Type", "application/x-www-form-urlencoded");
    }
    let response: Response;
    try {
      response = await this.transport.call(
        globalThis,
        `${CLUBLOG_ENDPOINT}/${path}`,
        {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(20000),
          // Inspect redirects without following them so a non-200 response
          // stops subsequent calls as required by Club Log's API guidance.
          redirect: "manual",
        },
      );
    } catch (error) {
      if (error instanceof VendorDeferredError) {
        if (!error.requestSent) throw error;
        this.halted = true;
        throw new ClubLogError(
          mutating ? "uncertain" : "transient",
          "Club Log rejected a request; verify the account before resuming",
          true,
        );
      }
      throw new ClubLogError(
        mutating ? "uncertain" : "transient",
        "Club Log request failed; reconcile before retrying mutations",
      );
    }
    if (
      response.redirected ||
      response.type === "opaque" ||
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)
    ) {
      await response.body?.cancel().catch(() => undefined);
      this.halted = true;
      throw new ClubLogError(
        mutating ? "uncertain" : "protocol",
        "Club Log returned an unexpected redirect",
        true,
      );
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      const kind =
        response.status === 401 || response.status === 403
          ? "auth"
          : response.status >= 400 && response.status < 500
            ? "rejected"
            : mutating
              ? "uncertain"
              : "transient";
      this.halted = true;
      throw new ClubLogError(
        kind,
        "Club Log rejected the request; check credentials and account before retrying",
        true,
      );
    }
    try {
      // PHP may leave its default text/html MIME type on plain ADIF/receipts.
      // Validate the bounded body below and in the endpoint-specific parser.
      const text = await boundedBody(
        response,
        mutating ? MAX_RECEIPT_BYTES : MAX_RESPONSE_BYTES,
      );
      if (
        /^(?:Access denied|Invalid (?:credentials|password|email)|Authentication failed|Forbidden)(?:[.!:\s]|$)/i.test(
          text.trim(),
        )
      ) {
        this.halted = true;
        throw new ClubLogError("auth", "Club Log credentials were rejected");
      }
      if (/^QSO Rejected(?:[.!:\s]|$)/i.test(text.trim())) {
        this.halted = true;
        throw new ClubLogError("rejected", "Club Log rejected the request");
      }
      if (/^(?:Error|FAIL)(?:[.!:\s]|$)/i.test(text.trim())) {
        this.halted = true;
        // A generic processing error does not prove that a mutation failed
        // before acceptance. Keep its artifact until readback can resolve it.
        throw new ClubLogError(
          mutating ? "uncertain" : "rejected",
          "Club Log reported an error; verify the account before resuming",
          true,
        );
      }
      return text;
    } catch (error) {
      if (error instanceof ClubLogError && error.suspend) throw error;
      throw new ClubLogError(
        mutating ? "uncertain" : "protocol",
        "Invalid or incomplete Club Log response",
      );
    }
  }

  async download(): Promise<AdifRecord[]> {
    const body = await this.request(
      "getadif.php",
      { call: this.credentials.callsign },
      false,
    );
    try {
      return downloadRecords(body, this.credentials.callsign);
    } catch {
      throw new ClubLogError(
        "protocol",
        "Club Log inventory is incomplete or unsupported",
      );
    }
  }

  async verifyLogin(): Promise<{ callsign: string; recordCount: number }> {
    const records = await this.download();
    return { callsign: this.credentials.callsign, recordCount: records.length };
  }

  async upload(
    record: AdifRecord,
    mode: "live" | "background" = "live",
  ): Promise<ClubLogUploadResult> {
    const identity = clublogIdentity(record);
    if (identity.stationCallsign !== this.credentials.callsign)
      throw new ClubLogError("blocked", "Club Log upload account mismatch");
    if (identity.time.length !== 6)
      throw new ClubLogError(
        "blocked",
        "Club Log uploads require exact second precision",
      );
    const outbound: AdifRecord = Object.create(null);
    for (const [field, value] of Object.entries(record)) {
      if (field === "STATION_CALLSIGN" || field === "SUBMODE") continue;
      if (!UPLOAD_FIELDS.has(field))
        throw new ClubLogError(
          "blocked",
          "Unsupported field in Club Log upload projection",
        );
      outbound[field] = value;
    }
    outbound.MODE = identity.mode;
    const adif = serializeAdifRecord(outbound);
    const body = await this.request(
      mode === "background" ? "putlogs.php" : "realtime.php",
      {
        callsign: this.credentials.callsign,
        ...(mode === "live" ? { adif } : {}),
      },
      true,
      mode === "background"
        ? `<ADIF_VER:5>3.1.6<PROGRAMID:12>LoFiQSOFerry<EOH>\n${adif}\n`
        : undefined,
    );
    // Unknown responses are never accepted, even with HTTP 200. These receipts
    // still require readback; batch acknowledgement only means queued.
    if (/^(?:QSO )?Duplicate(?: - OK)?\.?$/i.test(body.trim()))
      return { state: "duplicate" };
    if (/^(?:OK|QSO OK)\.?$/i.test(body.trim()))
      return { state: mode === "background" ? "submitted" : "accepted" };
    throw new ClubLogError(
      "uncertain",
      "Club Log upload receipt requires reconciliation",
    );
  }

  /** Exact scoped deletion only. Caller must establish uniqueness without MODE. */
  async delete(identity: ClubLogIdentity): Promise<{ deleted: boolean }> {
    if (
      identity.stationCallsign !== this.credentials.callsign ||
      identity.time.length !== 6
    )
      throw new ClubLogError(
        "blocked",
        "Club Log deletion identity is not exact",
      );
    const record = {
      STATION_CALLSIGN: identity.stationCallsign,
      CALL: identity.call,
      QSO_DATE: identity.date,
      TIME_ON: identity.time,
      BAND: identity.band,
      MODE: identity.mode,
    };
    const checked = clublogIdentity(record);
    const datetime = new Date(instant(checked.date, checked.time))
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    const body = await this.request(
      "delete.php",
      {
        callsign: this.credentials.callsign,
        dxcall: checked.call,
        datetime,
        bandid: BAND_IDS[checked.band],
      },
      true,
    );
    if (/^QSO Not Deleted\.?$/i.test(body.trim())) return { deleted: false };
    if (/^(?:OK|QSO OK)\.?$/i.test(body.trim())) return { deleted: true };
    throw new ClubLogError(
      "uncertain",
      "Club Log deletion receipt requires reconciliation",
    );
  }
}
