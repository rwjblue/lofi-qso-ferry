import { type AdifRecord, parseAdif, serializeAdifRecord } from "./adif.ts";
import {
  type QrzCoveringProgress,
  validateQrzCoveringPage,
} from "./qrz-covering.ts";
import { VendorDeferredError } from "./vendor-requests.ts";
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
    public readonly detail?: "ambiguous_empty_selection",
  ) {
    super(message);
  }
}
export type QrzResponse = Record<string, string>;
// Only these fixed parser/body messages may survive a read-response failure.
// Never preserve an arbitrary stream error or its cause, even if it is typed.
const READ_RESPONSE_ERRORS = new Set([
  "Invalid QRZ ADIF entity encoding",
  "Invalid QRZ response framing",
  "Duplicate QRZ response parameter",
  "Invalid QRZ form encoding",
  "Missing QRZ result",
  "QRZ response exceeds 2 MiB",
  "QRZ response body could not be read",
  "Invalid QRZ response UTF-8",
]);
/** The live API uses a raw HTML-entity-encoded ADIF tail, not a form value. */
function decodeHtmlOnce(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  const numeric = (entity: string) => {
    const hex = entity[2]?.toLowerCase() === "x";
    return Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
  };
  const entities = /&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-f]{1,6});/gi;
  const decoded: string[] = [];
  let end = 0;
  for (let match = entities.exec(value); match; match = entities.exec(value)) {
    decoded.push(value.slice(end, match.index));
    const entity = match[0];
    if (entity[1] !== "#")
      decoded.push(named[entity.slice(1, -1).toLowerCase()]);
    else {
      let point = numeric(entity);
      if (point >= 0xd800 && point <= 0xdbff) {
        // QRZ readback has emitted adjacent UTF-16 high/low entity pairs.
        // Consume only that lossless pair from the original input. Decoded
        // ampersands are never scanned again, so literal entities stay literal.
        const nextAt = entities.lastIndex;
        const low = entities.exec(value);
        const lowPoint = low?.[0][1] === "#" ? numeric(low[0]) : -1;
        if (
          !low ||
          low.index !== nextAt ||
          lowPoint < 0xdc00 ||
          lowPoint > 0xdfff
        )
          throw new QrzError("protocol", "Invalid QRZ ADIF entity encoding");
        point = 0x10000 + (point - 0xd800) * 0x400 + lowPoint - 0xdc00;
      } else if (point > 0x10ffff || (point >= 0xdc00 && point <= 0xdfff))
        throw new QrzError("protocol", "Invalid QRZ ADIF entity encoding");
      decoded.push(String.fromCodePoint(point));
    }
    end = entities.lastIndex;
  }
  decoded.push(value.slice(end));
  return decoded.join("");
}

function assertWholeUnicodeFields(record: AdifRecord): void {
  // Code-point iteration combines valid pairs. Any remaining surrogate is
  // unpaired, including one created by an incorrect declared ADIF length.
  for (const value of Object.values(record))
    for (const character of value) {
      const point = character.codePointAt(0) ?? -1;
      if (point >= 0xd800 && point <= 0xdfff)
        throw new QrzError(
          "protocol",
          "QRZ ADIF field splits a Unicode character",
        );
    }
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
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await reader.read();
      } catch {
        throw new QrzError("protocol", "QRZ response body could not be read");
      }
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
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch (error) {
    if (error instanceof TypeError)
      throw new QrzError("protocol", "Invalid QRZ response UTF-8");
    throw error;
  }
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
  /** Only current, caller-fenced book scope may recover ambiguous FETCH results. */
  neighborhoodFallback?: {
    book: QrzBook;
    selectCover: (
      record: AdifRecord,
      target: [string, string],
    ) => Promise<[string, string] | null>;
    isCurrent: () => Promise<boolean>;
    now?: () => number;
  };
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
  signal?: AbortSignal;
}
export interface QrzCoveringReadOptions {
  /** Inclusive target range, limited to seven days. */
  target: [string, string];
  /** Must come from the caller's verified book configuration. */
  stationCallsign: string;
  /** One fixed covering range per call; seven adds seven days on each side. */
  expandDays?: 0 | 7;
  /** Caller-selected known-positive cover, at most 35 days; excludes expandDays. */
  cover?: [string, string];
  shouldContinue?: () => boolean;
  deadlineAt?: number;
  now?: () => number;
}
export interface QrzCoveringRead {
  target: [string, string];
  cover: [string, string];
  records: AdifRecord[];
  pages: number;
  startedAt: number;
  completedAt: number;
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
    signal?: AbortSignal,
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
      response = await this.transport.call(globalThis, QRZ_ENDPOINT, {
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
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
          : AbortSignal.timeout(20000),
        redirect: "manual",
      });
    } catch (error) {
      if (error instanceof VendorDeferredError) throw error;
      throw new QrzError(
        mutating ? "uncertain" : "transient",
        "QRZ request failed; mutation outcome must be reconciled",
      );
    }
    if (
      response.redirected ||
      response.type === "opaque" ||
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)
    ) {
      await response.body?.cancel();
      throw new QrzError(
        mutating ? "uncertain" : "protocol",
        "QRZ redirect or opaque response; mutation outcome must be reconciled",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new QrzError(
        mutating
          ? "uncertain"
          : response.status === 401 || response.status === 403
            ? "auth"
            : "transient",
        "QRZ HTTP error",
      );
    }
    let data: QrzResponse;
    try {
      data = parseQrzResponse(await boundedBody(response));
    } catch (error) {
      if (
        !mutating &&
        error instanceof QrzError &&
        error.kind === "protocol" &&
        READ_RESPONSE_ERRORS.has(error.message)
      )
        throw new QrzError("protocol", error.message);
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
  async status(signal?: AbortSignal): Promise<QrzResponse> {
    const result = await this.request("STATUS", {}, signal);
    if (result.RESULT !== "OK")
      throw new QrzError("rejected", "QRZ status was rejected");
    return result;
  }
  /** STATUS field names are vendor-dependent. Missing identity evidence blocks linking. */
  async verifyBook(expected: QrzBook, signal?: AbortSignal): Promise<QrzBook> {
    const status = await this.status(signal);
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
    const result = await this.request(
      "FETCH",
      { OPTION: filters.join(",") },
      options.signal,
    );
    // A generic FAIL must never authorize missing-history backfill.
    if (result.RESULT !== "OK")
      throw new QrzError(
        "rejected",
        "QRZ inventory incomplete or rejected",
        result.RESULT === "FAIL" &&
          result.COUNT === "0" &&
          !Object.hasOwn(result, "ADIF") &&
          !Object.hasOwn(result, "REASON")
          ? "ambiguous_empty_selection"
          : undefined,
      );
    if (!/^\d+$/.test(result.COUNT ?? ""))
      throw new QrzError("protocol", "Missing QRZ inventory count");
    const document = parseAdif(result.ADIF ?? "");
    assertWholeUnicodeFields(document.header);
    for (const record of document.records) assertWholeUnicodeFields(record);
    const records = document.records;
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
  /**
   * A complete observed covering read, never a snapshot or independent book
   * identity/absence authorization. Callers must retain current book, credential,
   * source and commit fences. No partial result escapes a failed read.
   *
   * At most four FETCH attempts, each bounded by the existing two-MiB response
   * limit; retained records also total at most two MiB. A positive unchanged
   * overlap anchors every continuation, including the final short page.
   */
  async readCoveringRange(
    options: QrzCoveringReadOptions,
  ): Promise<QrzCoveringRead> {
    const day = 86_400_000;
    const target: [string, string] = [
      validDate(options.target[0]),
      validDate(options.target[1]),
    ];
    const start = Date.parse(target[0]);
    const end = Date.parse(target[1]);
    const expansion = options.expandDays ?? 0;
    const now = options.now ?? Date.now;
    const startedAt = now();
    if (
      options.target.length !== 2 ||
      end < start ||
      end - start > 6 * day ||
      (expansion !== 0 && expansion !== 7) ||
      (options.cover !== undefined && options.expandDays !== undefined) ||
      !/^[A-Za-z0-9/.-]{1,64}$/.test(options.stationCallsign) ||
      !Number.isSafeInteger(startedAt) ||
      (options.deadlineAt !== undefined &&
        !Number.isSafeInteger(options.deadlineAt))
    )
      throw new QrzError("protocol", "Invalid QRZ covering read scope");
    const date = (at: number) => new Date(at).toISOString().slice(0, 10);
    const cover: [string, string] = options.cover
      ? [validDate(options.cover[0]), validDate(options.cover[1])]
      : [
          validDate(date(start - expansion * day)),
          validDate(date(end + expansion * day)),
        ];
    if (
      (options.cover !== undefined && options.cover.length !== 2) ||
      cover[0] > target[0] ||
      cover[1] < target[1] ||
      Date.parse(cover[1]) - Date.parse(cover[0]) > 34 * day
    )
      throw new QrzError("protocol", "Invalid QRZ covering read scope");
    const deadlineAt = Math.min(
      options.deadlineAt ?? startedAt + 60_000,
      startedAt + 60_000,
    );
    const deadline = AbortSignal.timeout(Math.max(1, deadlineAt - startedAt));
    const check = () => {
      const at = now();
      if (!Number.isSafeInteger(at) || at < startedAt)
        throw new QrzError("protocol", "QRZ covering read clock changed");
      if (
        at >= deadlineAt ||
        deadline.aborted ||
        options.shouldContinue?.() === false
      )
        throw new QrzError("blocked", "QRZ covering read deadline reached");
      return at;
    };
    const records: AdifRecord[] = [];
    let progress: QrzCoveringProgress | undefined;
    for (let pages = 1; pages <= 4; pages++) {
      check();
      let page: QrzPage;
      try {
        page = await this.fetchPage({
          between: cover,
          afterLogId: progress?.anchor?.id ?? 0,
          max: 250,
          signal: deadline,
        });
      } catch (error) {
        if (deadline.aborted)
          throw new QrzError("blocked", "QRZ covering read deadline reached");
        throw error;
      }
      check();
      const validated = await validateQrzCoveringPage(
        page,
        cover,
        options.stationCallsign,
        progress,
      );
      progress = validated.progress;
      records.push(...validated.records);
      const completedAt = check();
      if (validated.complete)
        return { target, cover, records, pages, startedAt, completedAt };
    }
    throw new QrzError("blocked", "QRZ covering read page limit reached");
  }
  /**
   * Fresh collision read: at most four targeted FETCHs, then (only for the
   * documented ambiguous-empty shape) STATUS and four covering FETCHs. Both
   * scans share one 60-second deadline and return no partial evidence.
   */
  async findNeighborhood(record: AdifRecord): Promise<AdifRecord[]> {
    const at = adifInstant(record);
    const radius = 30 * 60000 + 59000;
    const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const target: [string, string] = [date(at - radius), date(at + radius)];
    const fallback = this.options.neighborhoodFallback;
    const now = fallback?.now ?? Date.now;
    const startedAt = now();
    if (!Number.isSafeInteger(startedAt))
      throw new QrzError("protocol", "Invalid QRZ neighborhood clock");
    const deadlineAt = startedAt + 60_000;
    const deadline = AbortSignal.timeout(60_000);
    const check = async () => {
      const current = now();
      if (!Number.isSafeInteger(current) || current < startedAt)
        throw new QrzError("protocol", "QRZ neighborhood clock changed");
      if (current >= deadlineAt || deadline.aborted)
        throw new QrzError("blocked", "QRZ neighborhood deadline reached");
      if (fallback && !(await fallback.isCurrent()))
        throw new QrzError("blocked", "QRZ neighborhood scope changed");
      if (now() >= deadlineAt || deadline.aborted)
        throw new QrzError("blocked", "QRZ neighborhood deadline reached");
    };
    const matching = (other: AdifRecord) =>
      other.CALL?.toUpperCase() === record.CALL?.toUpperCase() &&
      other.BAND?.toUpperCase() === record.BAND?.toUpperCase() &&
      Math.abs(adifInstant(other) - at) <= radius;
    let found: AdifRecord[] = [];
    let afterLogId = 0;
    let bytes = 0;
    try {
      for (let pages = 0; pages < 4; pages++) {
        await check();
        const page = await this.fetchPage({
          call: record.CALL,
          band: record.BAND,
          between: target,
          afterLogId,
          max: 250,
          signal: deadline,
        });
        await check();
        if (!Number.isSafeInteger(page.count))
          throw new QrzError("protocol", "Invalid QRZ neighborhood count");
        if (page.records.length) {
          // Targeted pagination advances beyond the prior page; the covering
          // validator is reused for scope/identity/order, without an overlap.
          const validated = await validateQrzCoveringPage(
            page,
            target,
            record.STATION_CALLSIGN,
          );
          bytes += validated.progress.bytes;
          if (bytes > 2 * 1024 * 1024)
            throw new QrzError(
              "blocked",
              "QRZ neighborhood retained record bound reached",
            );
          if (
            page.records.some(
              (other) =>
                other.CALL.toUpperCase() !== record.CALL.toUpperCase() ||
                other.BAND.toUpperCase() !== record.BAND.toUpperCase(),
            )
          )
            throw new QrzError("protocol", "QRZ neighborhood filter mismatch");
        }
        found.push(...page.records.filter(matching));
        if (page.nextAfterLogId === null) {
          await check();
          return found;
        }
        if (page.nextAfterLogId <= afterLogId)
          throw new QrzError(
            "protocol",
            "QRZ neighborhood cursor did not advance",
          );
        afterLogId = page.nextAfterLogId;
      }
      throw new QrzError("blocked", "QRZ neighborhood page limit reached");
    } catch (error) {
      if (
        !(error instanceof QrzError) ||
        error.kind !== "rejected" ||
        error.detail !== "ambiguous_empty_selection" ||
        !fallback
      )
        throw error;
    }
    // A rejected targeted read supplies no coverage, including earlier pages.
    found = [];
    await check();
    const book = fallback.book;
    if (
      !book.bookId ||
      book.stationCallsign.toUpperCase() !==
        record.STATION_CALLSIGN?.toUpperCase() ||
      target[0] < validDate(book.startDate) ||
      target[1] > validDate(book.endDate)
    )
      throw new QrzError(
        "blocked",
        "QRZ neighborhood is outside the verified book",
      );
    const cover = await fallback.selectCover(record, target);
    await check();
    if (!cover || cover[0] < book.startDate || cover[1] > book.endDate)
      throw new QrzError(
        "blocked",
        "QRZ neighborhood covering range unavailable",
      );
    await this.verifyBook(book, deadline);
    await check();
    const observed = await this.readCoveringRange({
      target,
      cover,
      stationCallsign: book.stationCallsign,
      now,
      deadlineAt,
      shouldContinue: () => !deadline.aborted,
    });
    await check();
    return observed.records.filter(matching);
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
  if (exact.length !== 1) {
    // Explain a precision-only hold without weakening the identity comparison
    // shared by adoption and writes. Competing candidates remain ambiguous.
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    if (
      candidate &&
      lowerTimePrecision(source, candidate) &&
      !operatingEvidenceMismatch(source, candidate)
    )
      return {
        state: "history_ambiguous",
        reason:
          "Destination history has minute-only TIME_ON precision; source includes seconds and requires association review",
      };
    return {
      state: "history_ambiguous",
      reason: "No unique exact identity, including time precision and mode",
    };
  }
  const remote = exact[0];
  return (
    operatingEvidenceMismatch(source, remote) ?? {
      state: "adopted_existing",
      record: remote,
    }
  );
}
function lowerTimePrecision(source: AdifRecord, remote: AdifRecord): boolean {
  if (
    !/^\d{6}$/.test(source.TIME_ON ?? "") ||
    !/^\d{4}$/.test(remote.TIME_ON ?? "") ||
    source.TIME_ON.slice(0, 4) !== remote.TIME_ON ||
    !sameQrzIdentity({ ...source, TIME_ON: remote.TIME_ON }, remote)
  )
    return false;
  try {
    adifInstant(source);
    adifInstant(remote);
    return true;
  } catch {
    return false;
  }
}
function operatingEvidenceMismatch(
  source: AdifRecord,
  remote: AdifRecord,
): Extract<QrzMatch, { reason: string }> | null {
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
  return null;
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
