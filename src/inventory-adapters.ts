import { type AdifRecord, adifStationCallsign } from "./adif.ts";
import type { InventoryObservation } from "./inventory-ingestion.ts";
import {
  InventoryObservationError,
  lofiInventoryObservations,
  lotwInventoryObservations,
  qrzInventoryObservations,
} from "./inventory-observations.ts";
import {
  LoFiClient,
  type LoFiCredentials,
  LoFiError,
  type SourceRecord,
  type SyncState,
} from "./lofi.ts";
import {
  LotwClient,
  LotwLoginError,
  type LotwQuery,
  splitLotwQuery,
} from "./lotw.ts";
import { type QrzBook, QrzClient, QrzError, type QrzPage } from "./qrz.ts";
import { canonical } from "./security.ts";
import { VendorDeferredError } from "./vendor-requests.ts";

export interface InventoryQueryBinding {
  scope: string;
  configVersion: number;
  queryBinding: string;
}
export interface InventoryReadContext {
  /** Core-owned admission, credentials and vendor policy remain outside adapters. */
  transport: typeof fetch;
  limits: {
    maxRequests: number;
    /** Aggregate response bytes, including renewal and STATUS responses. */
    maxResponseBytes: number;
    maxRecords: number;
    deadlineAt: number;
  };
  signal?: AbortSignal;
  now?: () => number;
}
export interface InventoryReadUsage {
  /** Injected transport attempts; core separately knows whether admission sent I/O. */
  requests: number;
  responseBytes: number;
  records: number;
}
export type InventoryReadCode =
  | "invalid_request"
  | "request_budget"
  | "response_budget"
  | "record_budget"
  | "deadline"
  | "aborted"
  | "vendor_cooldown"
  | "credentials_unavailable"
  | "scope_mismatch"
  | "cursor_refused"
  | "ambiguous_empty"
  | "invalid_response"
  | "unsupported_identity"
  | "vendor_unavailable";
export type InventoryReadRecovery =
  | "retry"
  | "restart"
  | "verify"
  | "reconnect"
  | "reduce_bounds"
  | "review";
export interface InventoryCoverageClaim {
  kind: "observed_selection";
  provider: "lofi" | "qrz" | "lotw";
  purpose: "source" | "receipt";
  selection:
    | "all_client_sync_window"
    | "book_date_selection"
    | "book_modified_selection"
    | "station_date_receipt_selection";
  /** Scope/query binding applies to this selection, never the entire account. */
  binding: InventoryQueryBinding;
  immutableSnapshot: false;
  absenceAuthority: false;
  deletionCoverage: "unknown";
}
export type InventoryReadProgress =
  | { kind: "continue"; resume: unknown }
  | {
      kind: "observed_complete";
      resume: unknown;
      proposedCheckpoint: unknown;
      coverage: InventoryCoverageClaim;
    };
interface ReadMetadata {
  binding: InventoryQueryBinding;
  requestStartedAt: number;
  completedAt: number;
  usage: InventoryReadUsage;
}
type ReadOutcome =
  | {
      kind: "page";
      observations: InventoryObservation[];
      progress: InventoryReadProgress;
      streamProgress?: Record<string, "continue" | "observed_complete">;
      completedStreams: string[];
      pacing?: { loopDelayMs?: number; checkPeriodMs?: number };
      nextReadAt?: number;
    }
  | { kind: "deferred"; code: InventoryReadCode; retryAt: number }
  | {
      kind: "blocked";
      code: InventoryReadCode;
      recovery: InventoryReadRecovery;
    }
  | { kind: "split"; partitions: LotwQuery[] }
  | { kind: "unsupported"; capability: "confirmation" };
export type InventoryReadResult = ReadMetadata & ReadOutcome;
export interface InventoryReadCapabilities {
  purpose: "source" | "receipt";
  baseline: "vector_cursor" | "logid_selection" | "bounded_report";
  delta: "server_stamp" | "modified_date" | "received_stamp";
  recordIdentity: "uuid" | "logid" | "local_identity_variants";
  deletionCoverage: "unknown";
  checkpointScope: "query";
  confirmation: "unsupported";
}
export interface InventoryReadAdapter<Request> {
  readonly provider: "lofi" | "qrz" | "lotw";
  readonly capabilities: InventoryReadCapabilities;
  readStep(
    context: InventoryReadContext,
    request: Request,
  ): Promise<InventoryReadResult>;
}
export interface LoFiInventoryRequest {
  binding: InventoryQueryBinding;
  resume: SyncState;
  /** Run-owned initial backfill boundary; never regenerated on page retry. */
  fixedUpperBound: number;
  pageSize?: number;
}
export interface QrzInventorySelection {
  between: [string, string];
  modifiedSince?: string;
}
export interface QrzInventoryResume {
  afterLogId: number;
  queryKey: string;
  /** Legacy resumes have no version or recovery witness. */
  version?: 1;
  pageSize?: number;
  /** An in-progress covering read retains the original modified query key. */
  coveringDateSelection?: true;
  previousFullPage?: {
    afterLogId: number;
    pageSize: number;
    nextAfterLogId: number;
  };
}
export interface QrzInventoryRequest {
  binding: InventoryQueryBinding;
  selection: QrzInventorySelection;
  resume?: QrzInventoryResume;
  pageSize?: number;
  /** Allow a covering date read to verify an ambiguous modified selection. */
  verifyAmbiguousDelta?: true;
}
export interface LotwInventoryRequest {
  binding: InventoryQueryBinding;
  query: LotwQuery;
  purpose?: "receipt" | "confirmation";
}

class ReadStopped extends Error {
  constructor(readonly code: InventoryReadCode) {
    super(code);
  }
}
function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new ReadStopped("invalid_request");
}
function cancel(stream: ReadableStream | null) {
  try {
    void stream?.cancel().catch(() => undefined);
  } catch {
    // Cleanup cannot replace the fixed read outcome.
  }
}
function retryAfter(value: string | null, now: number): number | null {
  if (!value || value.length > 128) return null;
  const at = /^\d+$/.test(value)
    ? now + Number(value) * 1000
    : Date.parse(value);
  return Number.isSafeInteger(at) ? Math.max(now + 1, at) : null;
}
function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}
function validReceiveTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return false;
  const at = Date.parse(`${value.replace(" ", "T")}Z`);
  return (
    Number.isFinite(at) &&
    new Date(at).toISOString().slice(0, 19).replace("T", " ") === value
  );
}
function validBinding(binding: InventoryQueryBinding) {
  requireValue(
    typeof binding.scope === "string" &&
      binding.scope.length > 0 &&
      binding.scope.length <= 512 &&
      typeof binding.queryBinding === "string" &&
      binding.queryBinding.length > 0 &&
      binding.queryBinding.length <= 4096 &&
      Number.isSafeInteger(binding.configVersion) &&
      binding.configVersion > 0,
  );
}

/** One aggregate budget surrounds every request made by an existing client. */
class ReadBudget {
  readonly usage: InventoryReadUsage = {
    requests: 0,
    responseBytes: 0,
    records: 0,
  };
  stopped: InventoryReadCode | null = null;
  lastResponseStatus: number | null = null;
  bodyDeadlineWithProgress = false;
  readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly onAbort = () => this.stop("aborted");

  constructor(readonly context: InventoryReadContext) {
    const { limits } = context;
    requireValue(
      Number.isSafeInteger(limits.maxRequests) &&
        limits.maxRequests >= 0 &&
        limits.maxRequests <= 32 &&
        Number.isSafeInteger(limits.maxResponseBytes) &&
        limits.maxResponseBytes > 0 &&
        limits.maxResponseBytes <= 8 * 1024 * 1024 &&
        Number.isSafeInteger(limits.maxRecords) &&
        limits.maxRecords > 0 &&
        limits.maxRecords <= 10000 &&
        Number.isSafeInteger(limits.deadlineAt) &&
        limits.deadlineAt > 0,
    );
    const remaining = limits.deadlineAt - this.now();
    requireValue(remaining <= 120000);
    this.timer = setTimeout(
      () => this.stop("deadline"),
      Math.max(0, remaining),
    );
    context.signal?.addEventListener("abort", this.onAbort, { once: true });
    if (context.signal?.aborted) this.stop("aborted");
  }

  now() {
    return (this.context.now ?? Date.now)();
  }
  private stop(code: InventoryReadCode) {
    this.stopped ??= code;
    this.controller.abort();
  }
  check() {
    if (this.now() >= this.context.limits.deadlineAt) this.stop("deadline");
    if (this.context.signal?.aborted) this.stop("aborted");
    if (this.stopped) throw new ReadStopped(this.stopped);
  }
  records(count: number) {
    this.usage.records += count;
    if (this.usage.records > this.context.limits.maxRecords) {
      this.stop("record_budget");
    }
    this.check();
  }
  private wait<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(new ReadStopped(this.stopped ?? "aborted"));
      const cleanup = () => signal.removeEventListener("abort", aborted);
      signal.addEventListener("abort", aborted, { once: true });
      pending.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
      if (signal.aborted) {
        cleanup();
        aborted();
      }
    });
  }
  readonly fetch: typeof fetch = async (input, init) => {
    this.check();
    if (this.usage.requests >= this.context.limits.maxRequests) {
      this.stop("request_budget");
      this.check();
    }
    this.usage.requests++;
    const requestSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = requestSignal
      ? AbortSignal.any([this.controller.signal, requestSignal])
      : this.controller.signal;
    const response = await this.wait(
      this.context.transport.call(globalThis, input, { ...init, signal }),
      signal,
    );
    this.lastResponseStatus = response.status;
    this.check();
    if (
      response.redirected ||
      response.type === "opaque" ||
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)
    ) {
      cancel(response.body);
      throw new ReadStopped("invalid_response");
    }
    const cooldown = retryAfter(
      response.headers.get("Retry-After"),
      this.now(),
    );
    if (
      response.status === 429 ||
      (response.status === 503 && cooldown !== null)
    ) {
      cancel(response.body);
      throw new VendorDeferredError(cooldown ?? this.now() + 300000, true);
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const { done, value } = await this.wait(reader.read(), signal);
          this.check();
          if (done) break;
          length += value.byteLength;
          this.usage.responseBytes += value.byteLength;
          if (this.usage.responseBytes > this.context.limits.maxResponseBytes) {
            this.stop("response_budget");
            this.check();
          }
          chunks.push(value);
        }
      } catch (error) {
        this.bodyDeadlineWithProgress =
          response.status === 200 &&
          length > 0 &&
          !this.context.signal?.aborted &&
          (this.stopped === "deadline" ||
            (requestSignal?.aborted === true &&
              requestSignal.reason instanceof DOMException &&
              requestSignal.reason.name === "TimeoutError"));
        throw error;
      } finally {
        try {
          void reader.cancel().catch(() => undefined);
        } catch {
          /* Best effort cleanup. */
        }
      }
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(
      response.status === 204 ||
        response.status === 205 ||
        response.status === 304
        ? null
        : bytes,
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
  };
  dispose() {
    clearTimeout(this.timer);
    this.context.signal?.removeEventListener("abort", this.onAbort);
  }
}

function failure(
  error: unknown,
  budget: ReadBudget | undefined,
  now: number,
): ReadOutcome {
  const stopped =
    budget?.stopped ?? (error instanceof ReadStopped ? error.code : null);
  if (stopped) {
    if (["request_budget", "deadline", "aborted"].includes(stopped))
      return { kind: "deferred", code: stopped, retryAt: now + 1000 };
    return {
      kind: "blocked",
      code: stopped,
      recovery:
        stopped === "invalid_request"
          ? "review"
          : stopped === "invalid_response"
            ? "verify"
            : "reduce_bounds",
    };
  }
  if (error instanceof VendorDeferredError)
    return {
      kind: "deferred",
      code: "vendor_cooldown",
      retryAt: error.retryAt,
    };
  if (error instanceof InventoryObservationError)
    return {
      kind: "blocked",
      code: "unsupported_identity",
      recovery: "review",
    };
  if (error instanceof LotwLoginError)
    return {
      kind: "blocked",
      code:
        error.reason === "credentials"
          ? "credentials_unavailable"
          : "vendor_unavailable",
      recovery: error.reason === "credentials" ? "reconnect" : "retry",
    };
  if (error instanceof QrzError) {
    if (error.message === "QRZ response exceeds 2 MiB")
      return {
        kind: "blocked",
        code: "response_budget",
        recovery: "reduce_bounds",
      };
    if (error.detail === "ambiguous_empty_selection")
      return { kind: "blocked", code: "ambiguous_empty", recovery: "verify" };
    if (error.kind === "auth")
      return {
        kind: "blocked",
        code: "credentials_unavailable",
        recovery: "reconnect",
      };
    return {
      kind: "blocked",
      code:
        error.kind === "blocked"
          ? "scope_mismatch"
          : error.kind === "transient"
            ? "vendor_unavailable"
            : "invalid_response",
      recovery:
        error.kind === "blocked"
          ? "verify"
          : error.kind === "transient"
            ? "retry"
            : "review",
    };
  }
  if (error instanceof LoFiError) {
    if (error.status !== undefined && error.status >= 500)
      return { kind: "blocked", code: "vendor_unavailable", recovery: "retry" };
    if (error.status === 401 || error.status === 403)
      return {
        kind: "blocked",
        code: "credentials_unavailable",
        recovery: "reconnect",
      };
    if (error.code === "account_changed")
      return { kind: "blocked", code: "scope_mismatch", recovery: "verify" };
    if (
      [
        "cursor_or_record_reconciliation_required",
        "repeated_cursor",
        "timestamp_pagination_stalled",
      ].includes(error.code)
    )
      return { kind: "blocked", code: "cursor_refused", recovery: "restart" };
    return { kind: "blocked", code: "invalid_response", recovery: "review" };
  }
  if (error instanceof Error) {
    if (error.message === "LoTW report does not match the requested scope")
      return { kind: "blocked", code: "scope_mismatch", recovery: "verify" };
    if (["Invalid LoTW query callsign"].includes(error.message))
      return { kind: "blocked", code: "invalid_request", recovery: "review" };
    if (
      [
        "Incomplete or non-ADIF LoTW report",
        "LoTW report count or program identity mismatch",
        "LoTW report has invalid identity/confirmation fields",
        "Invalid LoTW receive checkpoint",
      ].includes(error.message)
    )
      return { kind: "blocked", code: "invalid_response", recovery: "verify" };
  }
  return { kind: "blocked", code: "vendor_unavailable", recovery: "retry" };
}

async function readStep<Request extends { binding: InventoryQueryBinding }>(
  context: InventoryReadContext,
  request: Request,
  operation: (
    budget: ReadBudget,
    input: Request,
    startedAt: number,
  ) => Promise<ReadOutcome>,
  recover?: (
    error: unknown,
    budget: ReadBudget | undefined,
    input: Request,
  ) => ReadOutcome | undefined,
): Promise<InventoryReadResult> {
  const input = structuredClone(request);
  const clock = context.now ?? Date.now;
  const requestStartedAt = clock();
  const capturedContext = { ...context, limits: { ...context.limits } };
  let budget: ReadBudget | undefined;
  let outcome: ReadOutcome;
  try {
    validBinding(input.binding);
    budget = new ReadBudget(capturedContext);
    budget.check();
    outcome = await operation(budget, input, requestStartedAt);
    budget.check();
  } catch (error) {
    outcome =
      recover?.(error, budget, input) ?? failure(error, budget, clock());
  } finally {
    budget?.dispose();
  }
  return {
    ...outcome,
    binding: input.binding,
    requestStartedAt,
    completedAt: Math.max(requestStartedAt, clock()),
    usage: {
      ...(budget?.usage ?? { requests: 0, responseBytes: 0, records: 0 }),
    },
  };
}

function coverage(
  provider: InventoryCoverageClaim["provider"],
  binding: InventoryQueryBinding,
  selection: InventoryCoverageClaim["selection"],
): InventoryCoverageClaim {
  return {
    kind: "observed_selection",
    provider,
    purpose: provider === "lofi" ? "source" : "receipt",
    selection,
    binding,
    immutableSnapshot: false,
    absenceAuthority: false,
    deletionCoverage: "unknown",
  };
}

function validateLoFiResume(state: SyncState) {
  requireValue(
    state !== null &&
      typeof state === "object" &&
      !Array.isArray(state) &&
      (state.mode === "backfill" || state.mode === "forward"),
  );
  for (const side of ["operations", "qsos"] as const) {
    const progress = state[side];
    requireValue(
      progress !== null &&
        typeof progress === "object" &&
        !Array.isArray(progress),
    );
    for (const field of ["watermark", "latest"] as const)
      requireValue(
        progress[field] === undefined ||
          (Number.isSafeInteger(progress[field]) && progress[field] >= 0),
      );
    requireValue(
      progress.cursor === undefined ||
        (typeof progress.cursor === "string" && progress.cursor.length > 0),
    );
    requireValue(
      progress.complete === undefined || typeof progress.complete === "boolean",
    );
  }
}

function withinLoFiWindow(
  records: SourceRecord[],
  state: SyncState,
  side: "operations" | "qsos",
  fixedUpperBound: number,
) {
  const boundary =
    state[side].watermark ?? (state.mode === "backfill" ? fixedUpperBound : 0);
  return records.every(
    (row) =>
      typeof row.syncedAtMillis === "number" &&
      Number.isSafeInteger(row.syncedAtMillis) &&
      row.syncedAtMillis >= 0 &&
      (state.mode === "backfill"
        ? row.syncedAtMillis <= boundary
        : row.syncedAtMillis >= boundary),
  );
}

export function createLoFiInventoryAdapter(
  credentials: LoFiCredentials,
  options: { allowLargePages?: boolean } = {},
): InventoryReadAdapter<LoFiInventoryRequest> & {
  credentialsSnapshot(): LoFiCredentials;
} {
  let currentCredentials = structuredClone(credentials);
  return {
    provider: "lofi",
    capabilities: {
      purpose: "source",
      baseline: "vector_cursor",
      delta: "server_stamp",
      recordIdentity: "uuid",
      deletionCoverage: "unknown",
      checkpointScope: "query",
      confirmation: "unsupported",
    },
    credentialsSnapshot: () => ({ ...currentCredentials }),
    readStep: (context, request) =>
      readStep(context, request, async (budget, input) => {
        const limit = input.pageSize ?? 100;
        requireValue(
          Number.isSafeInteger(limit) &&
            limit > 0 &&
            limit <= (options.allowLargePages ? 1000 : 200),
        );
        requireValue(
          Number.isSafeInteger(input.fixedUpperBound) &&
            input.fixedUpperBound > 0 &&
            Number.isFinite(new Date(input.fixedUpperBound).getTime()),
        );
        validateLoFiResume(input.resume);
        requireValue(
          input.resume.readerPolicy === "all-clients-v1" &&
            typeof input.resume.accountId === "string" &&
            input.resume.accountId.length > 0 &&
            typeof input.resume.policyEpoch === "string" &&
            input.resume.policyEpoch.length > 0,
        );
        const client = new LoFiClient(currentCredentials, budget.fetch, {
          maxSyncRecords: options.allowLargePages ? 1000 : 200,
          maxResponseBytes: Math.min(
            context.limits.maxResponseBytes,
            8 * 1024 * 1024,
          ),
        });
        try {
          const page = await client.syncPage(
            input.resume,
            input.fixedUpperBound,
            limit,
          );
          budget.records(page.operations.length + page.qsos.length);
          // Cursors are opaque, but they do not establish permission to accept
          // a response outside the explicitly requested numeric side window.
          // Hold contradictory cursor behavior rather than poison a checkpoint.
          if (
            !withinLoFiWindow(
              page.operations,
              input.resume,
              "operations",
              input.fixedUpperBound,
            ) ||
            !withinLoFiWindow(
              page.qsos,
              input.resume,
              "qsos",
              input.fixedUpperBound,
            )
          )
            return {
              kind: "blocked",
              code: "scope_mismatch",
              recovery: "verify",
            };
          if (page.operations.length > limit || page.qsos.length > limit)
            return {
              kind: "blocked",
              code: "invalid_response",
              recovery: "verify",
            };
          const observations = await lofiInventoryObservations(
            page.operations,
            page.qsos,
          );
          const finished = page.complete;
          // LoFi can return cursor strings even with zero records left. A
          // completed inventory run resumes later from its server watermarks.
          const resume = finished
            ? {
                ...page.next,
                operations: { watermark: page.next.operations.watermark },
                qsos: { watermark: page.next.qsos.watermark },
              }
            : page.next;
          const hint = finished
            ? page.pacing?.checkPeriodMs
            : page.pacing?.loopDelayMs;
          const nextReadAt =
            hint !== undefined || (!finished && observations.length === 0)
              ? budget.now() + Math.max(1, hint ?? 1000)
              : undefined;
          return {
            kind: "page",
            observations,
            progress: finished
              ? {
                  kind: "observed_complete",
                  resume,
                  proposedCheckpoint: resume,
                  coverage: coverage(
                    "lofi",
                    input.binding,
                    "all_client_sync_window",
                  ),
                }
              : { kind: "continue", resume },
            streamProgress: {
              operations:
                finished || page.next.operations.complete
                  ? "observed_complete"
                  : "continue",
              qsos:
                finished || page.next.qsos.complete
                  ? "observed_complete"
                  : "continue",
            },
            completedStreams: [
              ...(finished || page.next.operations.complete
                ? ["operations"]
                : []),
              ...(finished || page.next.qsos.complete ? ["qsos"] : []),
            ],
            ...(page.pacing ? { pacing: { ...page.pacing } } : {}),
            ...(nextReadAt === undefined ? {} : { nextReadAt }),
          };
        } finally {
          currentCredentials = client.credentialsSnapshot();
        }
      }),
  };
}

function qrzSelectionKey(
  binding: InventoryQueryBinding,
  book: QrzBook,
  selection: QrzInventorySelection,
) {
  return canonical(["qrz-selection-v1", binding, book, selection]);
}
function validQrzScope(book: QrzBook, selection: QrzInventorySelection) {
  requireValue(
    typeof book.bookId === "string" &&
      book.bookId.length > 0 &&
      typeof book.stationCallsign === "string" &&
      book.stationCallsign.length > 0,
  );
  requireValue(
    validDate(book.startDate) &&
      validDate(book.endDate) &&
      book.startDate <= book.endDate,
  );
  requireValue(
    Array.isArray(selection.between) &&
      selection.between.length === 2 &&
      selection.between.every(validDate),
  );
  requireValue(
    selection.between[0] <= selection.between[1] &&
      selection.between[0] >= book.startDate &&
      selection.between[1] <= book.endDate,
  );
  requireValue(
    selection.modifiedSince === undefined || validDate(selection.modifiedSince),
  );
}
function withinQrzScope(
  body: AdifRecord,
  book: QrzBook,
  selection: QrzInventorySelection,
) {
  const date = body.QSO_DATE;
  return (
    typeof date === "string" &&
    /^\d{8}$/.test(date) &&
    validDate(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`) &&
    adifStationCallsign(body)?.toUpperCase() ===
      book.stationCallsign.toUpperCase() &&
    date >= selection.between[0].replaceAll("-", "") &&
    date <= selection.between[1].replaceAll("-", "")
  );
}

function validateQrzResume(
  resume: QrzInventoryResume | undefined,
  queryKey: string,
  canVerifyDelta: boolean,
) {
  if (!resume) return;
  requireValue(
    resume.queryKey === queryKey &&
      Number.isSafeInteger(resume.afterLogId) &&
      resume.afterLogId >= 0,
  );
  if (resume.version === undefined) {
    requireValue(
      resume.pageSize === undefined &&
        resume.previousFullPage === undefined &&
        resume.coveringDateSelection === undefined,
    );
    return;
  }
  requireValue(
    resume.version === 1 &&
      Number.isSafeInteger(resume.pageSize) &&
      resume.pageSize !== undefined &&
      resume.pageSize > 0 &&
      resume.pageSize <= 250,
  );
  const previous = resume.previousFullPage;
  requireValue(
    resume.coveringDateSelection === undefined ||
      (canVerifyDelta &&
        resume.coveringDateSelection === true &&
        previous !== undefined),
  );
  if (previous !== undefined)
    requireValue(
      previous !== null &&
        Number.isSafeInteger(previous.afterLogId) &&
        previous.afterLogId >= 0 &&
        previous.afterLogId < resume.afterLogId &&
        previous.pageSize === resume.pageSize &&
        previous.nextAfterLogId === resume.afterLogId,
    );
}

export function createQrzInventoryAdapter(
  apiKey: string,
  expectedBook: QrzBook,
): InventoryReadAdapter<QrzInventoryRequest> {
  const book = structuredClone(expectedBook);
  return {
    provider: "qrz",
    capabilities: {
      purpose: "receipt",
      baseline: "logid_selection",
      delta: "modified_date",
      recordIdentity: "logid",
      deletionCoverage: "unknown",
      checkpointScope: "query",
      confirmation: "unsupported",
    },
    readStep: (context, request) =>
      readStep(context, request, async (budget, input, startedAt) => {
        validQrzScope(book, input.selection);
        const requestedLimit = input.pageSize ?? 250;
        requireValue(
          Number.isSafeInteger(requestedLimit) &&
            requestedLimit > 0 &&
            requestedLimit <= 250,
        );
        const queryKey = qrzSelectionKey(input.binding, book, input.selection);
        const canVerifyDelta =
          input.verifyAmbiguousDelta === true &&
          input.selection.modifiedSince !== undefined;
        validateQrzResume(input.resume, queryKey, canVerifyDelta);
        // A recovery's smaller effective MAX persists even when core continues
        // supplying the run's original configured page size.
        let limit = input.resume?.pageSize ?? requestedLimit;
        let afterLogId = input.resume?.afterLogId ?? 0;
        let covering = input.resume?.coveringDateSelection === true;
        const client = new QrzClient(apiKey, { fetch: budget.fetch });
        await client.verifyBook(book);
        const fetchPage = () =>
          client.fetchPage({
            afterLogId,
            max: limit,
            between: input.selection.between,
            modifiedSince: covering ? undefined : input.selection.modifiedSince,
          });
        let page: QrzPage;
        try {
          page = await fetchPage();
        } catch (error) {
          if (
            !(error instanceof QrzError) ||
            error.detail !== "ambiguous_empty_selection"
          )
            throw error;
          if (canVerifyDelta && !input.resume) {
            // A successful scan over the same dates covers the modified
            // selection. Use a separate effective cursor from the first page.
            covering = true;
            page = await fetchPage();
            if (!page.records.length) throw error;
          } else {
            const previous = input.resume?.previousFullPage;
            if (
              input.resume?.version !== 1 ||
              !previous ||
              previous.pageSize <= 1
            )
              throw error;
            // Re-query a proven full-page boundary with smaller MAX. An
            // explicitly empty replay cannot establish a positive witness.
            afterLogId = previous.afterLogId;
            limit = previous.pageSize - 1;
            page = await fetchPage();
            if (!page.records.length) throw error;
          }
        }
        budget.records(page.records.length);
        if (
          covering &&
          page.nextAfterLogId === null &&
          page.count !== page.records.length
        )
          return {
            kind: "blocked",
            code: "ambiguous_empty",
            recovery: "verify",
          };
        if (
          page.nextAfterLogId !== null &&
          (!Number.isSafeInteger(page.nextAfterLogId) ||
            page.nextAfterLogId <= afterLogId)
        )
          return {
            kind: "blocked",
            code: "invalid_response",
            recovery: "verify",
          };
        if (
          page.records.some(
            (row) => !withinQrzScope(row, book, input.selection),
          )
        )
          return {
            kind: "blocked",
            code: "scope_mismatch",
            recovery: "verify",
          };
        const observations = await qrzInventoryObservations(page.records);
        const resume: QrzInventoryResume = {
          version: 1,
          afterLogId: page.nextAfterLogId ?? afterLogId,
          queryKey,
          pageSize: limit,
          ...(covering && (input.resume || page.nextAfterLogId !== null)
            ? { coveringDateSelection: true }
            : {}),
          ...(page.nextAfterLogId === null
            ? {}
            : {
                previousFullPage: {
                  afterLogId,
                  pageSize: limit,
                  nextAfterLogId: page.nextAfterLogId,
                },
              }),
        };
        return {
          kind: "page",
          observations,
          completedStreams: page.nextAfterLogId === null ? ["selection"] : [],
          progress:
            page.nextAfterLogId === null
              ? {
                  kind: "observed_complete",
                  resume,
                  // No modification timestamp is returned. Preserve the fixed lower
                  // selection instead of inventing an advancing vendor watermark.
                  proposedCheckpoint: {
                    kind: "qrz_selection_complete",
                    queryKey,
                    modifiedSince: input.selection.modifiedSince ?? null,
                    observedStartedAt: startedAt,
                  },
                  coverage: coverage(
                    "qrz",
                    input.binding,
                    !covering && input.selection.modifiedSince
                      ? "book_modified_selection"
                      : "book_date_selection",
                  ),
                }
              : {
                  kind: "continue",
                  resume,
                },
        };
      }),
  };
}

function splitLotw(
  query: LotwQuery,
  code: "response_budget" | "record_budget" | "deadline" = "response_budget",
): ReadOutcome {
  const partitions = splitLotwQuery(query);
  return partitions
    ? { kind: "split", partitions }
    : { kind: "blocked", code, recovery: "review" };
}
export function createLotwInventoryAdapter(credentials: {
  username: string;
  password: string;
}): InventoryReadAdapter<LotwInventoryRequest> {
  const saved = structuredClone(credentials);
  return {
    provider: "lotw",
    capabilities: {
      purpose: "receipt",
      baseline: "bounded_report",
      delta: "received_stamp",
      recordIdentity: "local_identity_variants",
      deletionCoverage: "unknown",
      checkpointScope: "query",
      confirmation: "unsupported",
    },
    readStep: (context, request) =>
      readStep(
        context,
        request,
        async (budget, input) => {
          if (input.purpose === "confirmation")
            return { kind: "unsupported", capability: "confirmation" };
          requireValue(
            input.purpose === undefined || input.purpose === "receipt",
          );
          requireValue(
            validDate(input.query.startDate) &&
              validDate(input.query.endDate) &&
              input.query.startDate <= input.query.endDate,
          );
          requireValue(
            input.query.receivedSince === undefined ||
              validDate(input.query.receivedSince) ||
              validReceiveTime(input.query.receivedSince),
          );
          if (
            Date.parse(input.query.endDate) -
              Date.parse(input.query.startDate) >
            31 * 86400000
          )
            return splitLotw(input.query);
          const report = await new LotwClient(saved, {
            fetcher: budget.fetch,
          }).query(input.query);
          if (
            report.records.length > 0 &&
            report.receivedThrough !== null &&
            (!validReceiveTime(report.receivedThrough) ||
              (input.query.receivedSince !== undefined &&
                Date.parse(`${report.receivedThrough.replace(" ", "T")}Z`) <
                  Date.parse(
                    input.query.receivedSince.length === 10
                      ? `${input.query.receivedSince}T00:00:00Z`
                      : `${input.query.receivedSince.replace(" ", "T")}Z`,
                  )))
          )
            throw new ReadStopped("invalid_response");
          if (report.records.length > 0 && report.receivedThrough !== null) {
            // ARRL binds LASTQSORX to the newest QSO in this report, normally
            // the first row's RXQSO. Missing legacy row fields supply no extra
            // assertion, and no returned RX timestamp may exceed the header.
            const firstReceived = report.records[0].APP_LOTW_RXQSO;
            if (
              firstReceived !== undefined &&
              firstReceived !== report.receivedThrough
            )
              throw new ReadStopped("invalid_response");
            const through = Date.parse(
              `${report.receivedThrough.replace(" ", "T")}Z`,
            );
            if (
              report.records.some(
                (row) =>
                  row.APP_LOTW_RXQSO !== undefined &&
                  (!validReceiveTime(row.APP_LOTW_RXQSO) ||
                    Date.parse(`${row.APP_LOTW_RXQSO.replace(" ", "T")}Z`) >
                      through),
              )
            )
              throw new ReadStopped("invalid_response");
          }
          budget.records(report.records.length);
          const observations = await lotwInventoryObservations(report.records);
          const { receivedSince: _lower, ...selection } = input.query;
          return {
            kind: "page",
            observations,
            completedStreams: ["selection"],
            progress: {
              kind: "observed_complete",
              resume: { query: input.query },
              proposedCheckpoint:
                report.records.length === 0 || report.receivedThrough === null
                  ? null
                  : { selection, receivedThrough: report.receivedThrough },
              coverage: coverage(
                "lotw",
                input.binding,
                "station_date_receipt_selection",
              ),
            },
          };
        },
        (error, budget, input) => {
          if (budget?.bodyDeadlineWithProgress)
            return splitLotw(input.query, "deadline");
          if (budget?.stopped === "response_budget") {
            if (budget.lastResponseStatus === 200)
              return splitLotw(input.query);
            if ((budget.lastResponseStatus ?? 0) >= 500)
              return {
                kind: "blocked",
                code: "vendor_unavailable",
                recovery: "retry",
              };
          }
          if (
            budget?.stopped === "record_budget" ||
            (error instanceof Error &&
              error.message ===
                "Vendor response exceeds bounded partition; split the date range")
          )
            return splitLotw(
              input.query,
              budget?.stopped === "record_budget"
                ? "record_budget"
                : "response_budget",
            );
          return undefined;
        },
      ),
  };
}
