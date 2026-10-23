import { parseAdif, serializeAdifRecord, type AdifRecord } from "./adif.ts";
export const QRZ_ENDPOINT = "https://logbook.qrz.com/api";
export class QrzError extends Error {
  constructor(
    public readonly kind:
      | "auth"
      | "rejected"
      | "transient"
      | "uncertain"
      | "protocol"
      | "blocked",
    message: string,
  ) {
    super(message);
  }
}
export type QrzResponse = Record<string, string>;
/** The live API uses a raw HTML-entity-encoded ADIF tail, not a form value. */
function decodeHtmlOnce(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  return value.replace(
    /&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-f]{1,6});/gi,
    (entity) => {
      if (entity[1] !== "#") return named[entity.slice(1, -1).toLowerCase()];
      const hex = entity[2]?.toLowerCase() === "x";
      const point = Number.parseInt(
        entity.slice(hex ? 3 : 2, -1),
        hex ? 16 : 10,
      );
      if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))
        throw new QrzError("protocol", "Invalid QRZ ADIF entity encoding");
      return String.fromCodePoint(point);
    },
  );
}
export function parseQrzResponse(body: string): QrzResponse {
  if (body.length > 2 * 1024 * 1024 || /^\s*</.test(body))
    throw new QrzError("protocol", "Invalid QRZ response framing");
  const result: QrzResponse = Object.create(null);
  const marker = /(?:^|&)ADIF=/i.exec(body);
  const prefix = marker ? body.slice(0, marker.index) : body.trim();
  for (const [key, value] of new URLSearchParams(prefix)) {
    const name = key.toUpperCase();
    if (Object.hasOwn(result, name))
      throw new QrzError("protocol", "Duplicate QRZ response parameter");
    result[name] = value;
  }
  if (marker) {
    const tail = body.slice(marker.index + marker[0].length);
    if (/&lt;(?:EOH|EOR|[a-z][a-z0-9_]*:\d)/i.test(tail))
      result.ADIF = decodeHtmlOnce(tail);
    else if (/%3c(?:EOH|EOR|[a-z][a-z0-9_]*(?::|%3a)\d)/i.test(tail)) {
      try {
        result.ADIF = decodeURIComponent(tail.replace(/\+/g, " "));
      } catch {
        throw new QrzError("protocol", "Invalid QRZ form encoding");
      }
    } else result.ADIF = tail;
  }
  if (!result.RESULT) throw new QrzError("protocol", "Missing QRZ result");
  return result;
}
async function boundedBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > 2 * 1024 * 1024)
        throw new QrzError("protocol", "QRZ response exceeds 2 MiB");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(data);
}
export interface QrzBook {
  bookId: string;
  stationCallsign: string;
  startDate: string;
  endDate: string;
}
export interface QrzPage {
  records: AdifRecord[];
  nextAfterLogId: number | null;
  count: number;
}
export interface QrzOptions {
  fetch?: typeof fetch;
  version?: string;
  writesEnabled?: boolean;
  replacementContractVerified?: boolean;
  beforeWrite?: () => Promise<boolean>;
}
export interface QrzFetchOptions {
  afterLogId?: number;
  max?: number;
  between?: [string, string];
  modifiedSince?: string;
  call?: string;
  band?: string;
  mode?: string;
  logIds?: string[];
}
export class QrzClient {
  private readonly transport: typeof fetch;
  constructor(
    private readonly apiKey: string,
    private readonly options: QrzOptions = {},
  ) {
    this.transport = options.fetch ?? fetch;
  }
  private async request(
    action: string,
    values: Record<string, string> = {},
  ): Promise<QrzResponse> {
    const mutating = action === "INSERT" || action === "DELETE";
    if (mutating && !this.options.writesEnabled)
      throw new QrzError("blocked", "QRZ writes are disabled");
    if (
      mutating &&
      this.options.beforeWrite &&
      !(await this.options.beforeWrite())
    )
      throw new QrzError(
        "blocked",
        "Credential, source, lease or export authorization changed before dispatch",
      );
    let response: Response;
    try {
      response = await this.transport(QRZ_ENDPOINT, {
        method: "POST",
        headers: {
          "User-Agent": `LoFiQSOFerry/${this.options.version ?? "0.1.0"}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          KEY: this.apiKey,
          ACTION: action,
          ...values,
        }),
        signal: AbortSignal.timeout(20000),
        redirect: "error",
      });
    } catch {
      throw new QrzError(
        mutating ? "uncertain" : "transient",
        "QRZ request failed; mutation outcome must be reconciled",
      );
    }
    if (!response.ok)
      throw new QrzError(
        mutating
          ? "uncertain"
          : response.status === 401 || response.status === 403
            ? "auth"
            : "transient",
        "QRZ HTTP error",
      );
    let data: QrzResponse;
    try {
      data = parseQrzResponse(await boundedBody(response));
    } catch {
      throw new QrzError(
        mutating ? "uncertain" : "protocol",
        "Invalid QRZ response; mutation outcome must be reconciled",
      );
    }
    if (data.RESULT === "AUTH")
      throw new QrzError(
        "auth",
        "QRZ subscription or credentials do not permit access",
      );
    return data;
  }
  async status(): Promise<QrzResponse> {
    const result = await this.request("STATUS");
    if (result.RESULT !== "OK")
      throw new QrzError("rejected", "QRZ status was rejected");
    return result;
  }
  /** STATUS field names are vendor-dependent. Missing identity evidence blocks linking. */
  async verifyBook(expected: QrzBook): Promise<QrzBook> {
    const status = await this.status();
    const data = {
      ...status,
      ...Object.fromEntries(new URLSearchParams(status.DATA ?? "")),
    };
    const normalized = Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key.toUpperCase(), value]),
    );
    if (
      normalized.BOOKID !== expected.bookId ||
      (normalized.CALLSIGN ?? normalized.CALL)?.toUpperCase() !==
        expected.stationCallsign.toUpperCase() ||
      (normalized.START_DATE ?? normalized.STARTDATE) !== expected.startDate ||
      (normalized.END_DATE ?? normalized.ENDDATE) !== expected.endDate
    )
      throw new QrzError(
        "blocked",
        "QRZ did not establish the expected book identity and date range",
      );
    return expected;
  }
  async fetchPage(options: QrzFetchOptions = {}): Promise<QrzPage> {
    const max = options.max ?? 250;
    const after = options.afterLogId ?? 0;
    if (
      !Number.isInteger(max) ||
      max < 1 ||
      max > 250 ||
      !Number.isSafeInteger(after) ||
      after < 0
    )
      throw new QrzError("protocol", "Invalid QRZ page bounds");
    const filters = ["TYPE:ADIF", `MAX:${max}`, `AFTERLOGID:${after}`];
    if (options.between)
      filters.push(
        `BETWEEN:${validDate(options.between[0])}+${validDate(options.between[1])}`,
      );
    if (options.modifiedSince)
      filters.push(`MODSINCE:${validDate(options.modifiedSince)}`);
    for (const [key, value] of [
      ["CALL", options.call],
      ["BAND", options.band],
      ["MODE", options.mode],
    ] as const)
      if (value) {
        if (!/^[A-Za-z0-9/.-]+$/.test(value))
          throw new QrzError("protocol", "Invalid QRZ filter");
        filters.push(`${key}:${value}`);
      }
    if (options.logIds) {
      if (
        !options.logIds.length ||
        options.logIds.some((id) => !/^\d+$/.test(id))
      )
        throw new QrzError("protocol", "Invalid QRZ LOGIDs");
      filters.push(`LOGIDS:${options.logIds.join("+")}`);
    }
    const result = await this.request("FETCH", { OPTION: filters.join(",") });
    // A generic FAIL must never authorize missing-history backfill.
    if (result.RESULT !== "OK")
      throw new QrzError("rejected", "QRZ inventory incomplete or rejected");
    if (!/^\d+$/.test(result.COUNT ?? ""))
      throw new QrzError("protocol", "Missing QRZ inventory count");
    const records = parseAdif(result.ADIF ?? "").records;
    if (
      records.length > max ||
      Number(result.COUNT) < records.length ||
      (!records.length && Number(result.COUNT) > 0 && !options.afterLogId)
    )
      throw new QrzError("protocol", "Inconsistent QRZ inventory framing");
    let highest = after - 1;
    const seen = new Set<string>();
    for (const record of records) {
      const id = record.APP_QRZLOG_LOGID;
      if (
        !id ||
        !/^\d+$/.test(id) ||
        !Number.isSafeInteger(Number(id)) ||
        Number(id) < after ||
        seen.has(id)
      )
        throw new QrzError("protocol", "Invalid or repeated QRZ LOGID");
      seen.add(id);
      highest = Math.max(highest, Number(id));
    }
    return {
      records,
      count: Number(result.COUNT),
      nextAfterLogId: records.length === max ? highest + 1 : null,
    };
  }
  async *inventory(
    options: Omit<QrzFetchOptions, "afterLogId"> = {},
  ): AsyncGenerator<QrzPage> {
    let afterLogId = 0;
    for (let page = 0; page < 10000; page++) {
      const result = await this.fetchPage({ ...options, afterLogId });
      yield result;
      if (result.nextAfterLogId === null) return;
      if (result.nextAfterLogId <= afterLogId)
        throw new QrzError("protocol", "QRZ cursor did not advance");
      afterLogId = result.nextAfterLogId;
    }
    throw new QrzError(
      "blocked",
      "QRZ inventory page limit reached; resume explicitly",
    );
  }
  async fetchLogId(logId: string): Promise<AdifRecord | null> {
    const page = await this.fetchPage({ logIds: [logId] });
    if (page.records.length > 1)
      throw new QrzError("protocol", "Nonunique mapped QRZ record");
    return page.records[0] ?? null;
  }
  async findNeighborhood(record: AdifRecord): Promise<AdifRecord[]> {
    const at = adifInstant(record);
    const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const found: AdifRecord[] = [];
    for await (const page of this.inventory({
      call: record.CALL,
      band: record.BAND,
      between: [date(at - 30 * 60000), date(at + 30 * 60000)],
    }))
      found.push(
        ...page.records.filter(
          (other) => Math.abs(adifInstant(other) - at) <= 30 * 60000 + 59000,
        ),
      );
    return found;
  }
  async insert(
    record: AdifRecord,
  ): Promise<{ logId: string; replaced: boolean }> {
    return this.writeRecord(record, false);
  }
  private async writeRecord(
    record: AdifRecord,
    replace: boolean,
  ): Promise<{ logId: string; replaced: boolean }> {
    const result = await this.request("INSERT", {
      ADIF: serializeAdifRecord(record),
      ...(replace ? { OPTION: "REPLACE" } : {}),
    });
    if (result.RESULT !== "OK" && result.RESULT !== "REPLACE")
      throw new QrzError(
        "rejected",
        "QRZ rejected the record; reconcile duplicate responses before any retry",
      );
    if (
      (!replace && result.RESULT === "REPLACE") ||
      result.COUNT !== "1" ||
      !/^\d+$/.test(result.LOGID ?? "")
    )
      throw new QrzError(
        "uncertain",
        "QRZ mutation receipt is inconsistent; reconcile before retry",
      );
    return { logId: result.LOGID, replaced: result.RESULT === "REPLACE" };
  }
  /** Recheck remote-owned fields while preserving the exact durably prepared payload. */
  async replacePrepared(
    logId: string,
    record: AdifRecord,
    policy: "remote_preserved" | "template_bound",
  ): Promise<{ logId: string; replaced: boolean }> {
    if (!this.options.replacementContractVerified)
      throw new QrzError(
        "blocked",
        "QRZ replacement contract requires scoped live verification",
      );
    const remote = await this.fetchLogId(logId);
    if (!remote || !sameQrzIdentity(remote, record))
      throw new QrzError("blocked", "QRZ replacement mapping changed");
    const neighbors = await this.findNeighborhood(record);
    if (neighbors.length !== 1 || neighbors[0].APP_QRZLOG_LOGID !== logId)
      throw new QrzError("blocked", "QRZ duplicate neighborhood is ambiguous");
    const merged = mergeQrzCorrection(remote, record, policy);
    const canonicalRecord = (value: AdifRecord) =>
      JSON.stringify(
        Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
      );
    if (canonicalRecord(merged) !== canonicalRecord(record))
      throw new QrzError(
        "blocked",
        "QRZ remote-owned fields changed after preparation; prepare a new attempt",
      );
    return this.writeRecord(record, true);
  }
  async replaceSafely(
    logId: string,
    current: AdifRecord,
    policy: "remote_preserved" | "template_bound",
  ): Promise<{ logId: string; replaced: boolean }> {
    if (!this.options.replacementContractVerified)
      throw new QrzError(
        "blocked",
        "QRZ replacement contract requires scoped live verification",
      );
    const remote = await this.fetchLogId(logId);
    if (!remote || !sameQrzIdentity(remote, current))
      throw new QrzError(
        "blocked",
        "QRZ replacement identity differs from mapping",
      );
    const candidates = await this.findNeighborhood(current);
    if (candidates.length !== 1 || candidates[0].APP_QRZLOG_LOGID !== logId)
      throw new QrzError("blocked", "QRZ duplicate neighborhood is ambiguous");
    return this.writeRecord(mergeQrzCorrection(remote, current, policy), true);
  }
}
function validDate(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  )
    throw new QrzError("protocol", "Invalid QRZ date");
  return value;
}
export function adifInstant(record: AdifRecord): number {
  const date = record.QSO_DATE ?? "";
  const time = record.TIME_ON ?? "";
  if (!/^\d{8}$/.test(date) || !/^\d{4}(\d{2})?$/.test(time))
    throw new QrzError("protocol", "Missing precise ADIF date/time");
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6) || "00"}Z`;
  const at = Date.parse(iso);
  if (
    !Number.isFinite(at) ||
    new Date(at).toISOString().slice(0, 19) !== iso.slice(0, 19)
  )
    throw new QrzError("protocol", "Invalid ADIF date/time");
  return at;
}
export function sameQrzIdentity(left: AdifRecord, right: AdifRecord): boolean {
  return [
    "STATION_CALLSIGN",
    "CALL",
    "QSO_DATE",
    "TIME_ON",
    "BAND",
    "MODE",
    "SUBMODE",
    "PROP_MODE",
    "SAT_NAME",
  ].every(
    (field) =>
      (left[field] ?? "").toUpperCase() === (right[field] ?? "").toUpperCase(),
  );
}
const NARRATIVE = new Set(["COMMENT", "NOTES", "QSLMSG"]);
const SOURCE_FIELDS = new Set([
  "STATION_CALLSIGN",
  "CALL",
  "QSO_DATE",
  "TIME_ON",
  "TIME_OFF",
  "BAND",
  "FREQ",
  "MODE",
  "SUBMODE",
  "RST_SENT",
  "RST_RCVD",
  "MY_GRIDSQUARE",
  "MY_STATE",
  "MY_CNTY",
  "MY_DXCC",
  "MY_CQ_ZONE",
  "MY_ITU_ZONE",
  "MY_COUNTRY",
  "MY_LAT",
  "MY_LON",
  "MY_CITY",
  "TX_PWR",
  "MY_POTA_REF",
  "MY_SOTA_REF",
  "PROP_MODE",
  "SAT_NAME",
  "OPERATOR",
]);
export function mergeQrzCorrection(
  remote: AdifRecord,
  current: AdifRecord,
  policy: "remote_preserved" | "template_bound",
): AdifRecord {
  const merged: AdifRecord = Object.create(null);
  for (const [field, value] of Object.entries(remote)) {
    // Never re-submit IDs, confirmations, award credits, or server extension state.
    if (
      field.startsWith("QRZCOM_") ||
      field.startsWith("APP_QRZLOG_") ||
      field.startsWith("APP_LOTW_") ||
      (/(?:QSL|LOTW|EQSL|CREDIT|AWARD)/.test(field) && field !== "QSLMSG")
    )
      continue;
    if (
      !SOURCE_FIELDS.has(field) &&
      (!NARRATIVE.has(field) || policy === "remote_preserved")
    )
      merged[field] = value;
  }
  for (const [field, value] of Object.entries(current))
    if (
      SOURCE_FIELDS.has(field) ||
      (NARRATIVE.has(field) && policy === "template_bound")
    )
      merged[field] = value;
  return merged;
}
export type QrzMatch =
  | { state: "missing_current_identity" }
  | { state: "history_ambiguous" | "history_mismatch"; reason: string }
  | { state: "adopted_existing"; record: AdifRecord };
function normalizedFrequency(value: string): string | null {
  if (
    !/^\d+(?:\.\d+)?$/.test(value) ||
    !Number.isFinite(Number(value)) ||
    Number(value) <= 0
  )
    return null;
  const [integer, fraction = ""] = value.split(".");
  const whole = integer.replace(/^0+(?=\d)/, "");
  const decimals = fraction.replace(/0+$/, "");
  return decimals ? `${whole}.${decimals}` : whole;
}
export function matchQrzHistory(
  source: AdifRecord,
  candidates: AdifRecord[],
): QrzMatch {
  if (!candidates.length) return { state: "missing_current_identity" };
  if (
    ![
      "MY_GRIDSQUARE",
      "MY_STATE",
      "MY_CNTY",
      "MY_DXCC",
      "MY_LAT",
      "MY_LON",
    ].some((field) => source[field])
  )
    return {
      state: "history_ambiguous",
      reason: "Source operating location evidence is unavailable",
    };
  const exact = candidates.filter((record) => sameQrzIdentity(source, record));
  if (exact.length !== 1)
    return {
      state: "history_ambiguous",
      reason: "No unique exact identity, including time precision and mode",
    };
  const remote = exact[0];
  for (const field of ["FREQ", "FREQ_RX"])
    if (source[field]) {
      const local = normalizedFrequency(source[field]);
      const observed = remote[field]
        ? normalizedFrequency(remote[field])
        : null;
      if (!local || !observed)
        return {
          state: "history_ambiguous",
          reason: `Frequency evidence ${field} is invalid or unavailable`,
        };
      if (local !== observed)
        return {
          state: "history_mismatch",
          reason: `Operating frequency ${field} differs`,
        };
    }
  for (const field of [
    "MY_GRIDSQUARE",
    "MY_STATE",
    "MY_CNTY",
    "MY_DXCC",
    "MY_LAT",
    "MY_LON",
    "MY_CQ_ZONE",
    "MY_ITU_ZONE",
    "MY_IOTA",
  ])
    if (
      source[field] &&
      (source[field] ?? "").toUpperCase() !==
        (remote[field] ?? "").toUpperCase()
    )
      return {
        state: remote[field] ? "history_mismatch" : "history_ambiguous",
        reason: `Operating location ${field} differs or is absent`,
      };
  return { state: "adopted_existing", record: remote };
}
/** Cleanup is deliberately unavailable until the duplicate/deletion contract is live-proven. */
export function mayCleanOldQrzIdentity(evidence: {
  oldProvenance: string;
  newAcknowledged: boolean;
  oldLogId: string;
  newLogId: string;
  freshOldIdentityMatches: boolean;
}): boolean {
  return (
    evidence.oldProvenance === "ferry_created" &&
    evidence.newAcknowledged &&
    evidence.oldLogId !== evidence.newLogId &&
    evidence.freshOldIdentityMatches
  );
}
