import { LOFI_CLIENT_NAME, lofiAccountEmail } from "./lofi-identity.ts";

/** LoFi transport. This client never sends operation/QSO mutations. */
export type SourceRecord = Record<string, unknown>;

export interface LoFiCredentials {
  key: string;
  secret: string;
  token?: string;
}

export interface SideProgress {
  cursor?: string;
  watermark?: number;
  latest?: number;
  complete?: boolean;
}

export interface SyncState {
  mode: "backfill" | "forward";
  operations: SideProgress;
  qsos: SideProgress;
  accountId?: string;
}

export interface SyncPage {
  operations: SourceRecord[];
  qsos: SourceRecord[];
  /** Confirmed email from the verified account; null means explicitly unavailable. */
  accountEmail?: string | null;
  next: SyncState;
  complete: boolean;
  /** A client implementation is not proof of a vendor replay boundary. */
  coverage: "client-contract-only";
}

export interface OperationQsosState {
  cursor?: number;
  since?: number;
}

export interface OperationQsosPage {
  qsos: SourceRecord[];
  next: OperationQsosState;
  complete: boolean;
  coverage: "client-contract-only";
}

export class LoFiError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(code);
    this.name = "LoFiError";
  }
}

function object(value: unknown): SourceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LoFiError("malformed_response");
  }
  return value as SourceRecord;
}

function optionalObject(value: unknown): SourceRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as SourceRecord)
    : {};
}

function records(value: unknown): SourceRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new LoFiError("malformed_records");
  return value.map((item) => {
    const record = object(item);
    if (typeof record.uuid !== "string" || !record.uuid) {
      throw new LoFiError("missing_record_uuid");
    }
    return record;
  });
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

async function boundedJson(response: Response): Promise<SourceRecord> {
  if (untrustedResponse(response)) {
    await response.body?.cancel();
    throw new LoFiError("vendor_redirect_or_opaque_response", response.status);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new LoFiError("vendor_http_error", response.status);
  }
  if (!response.body) throw new LoFiError("empty_response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new LoFiError("response_too_large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new LoFiError("invalid_json");
    }
    const result = object(parsed);
    if (result.error || result.error_status || result.success === false) {
      throw new LoFiError("vendor_rejected_response");
    }
    return result;
  } finally {
    reader.releaseLock();
  }
}

function untrustedResponse(response: Response): boolean {
  return (
    response.redirected ||
    response.type === "opaque" ||
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  );
}

/** No user-controlled hostname; injected fetch is for tests/service bindings. */
export class LoFiClient {
  private credentials: LoFiCredentials;

  constructor(
    credentials: LoFiCredentials,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!credentials.key || !credentials.secret) {
      throw new LoFiError("missing_client_identity");
    }
    this.credentials = { ...credentials };
  }

  credentialsSnapshot(): LoFiCredentials {
    return { ...this.credentials };
  }

  async register(): Promise<SourceRecord> {
    const response = await this.fetcher.call(
      globalThis,
      "https://lofi.ham2k.net/v1/client",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "LoFiQSOFerry/0.1.0",
        },
        body: JSON.stringify({
          client: {
            name: LOFI_CLIENT_NAME,
            type: "browser",
            key: this.credentials.key,
            secret: this.credentials.secret,
          },
        }),
        signal: AbortSignal.timeout(15_000),
        redirect: "manual",
      },
    );
    const result = await boundedJson(response);
    if (typeof result.token !== "string" || !result.token) {
      throw new LoFiError("missing_token");
    }
    this.credentials.token = result.token;
    return result;
  }

  private async request(
    path: string,
    body?: SourceRecord,
  ): Promise<SourceRecord> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.credentials.token) await this.register();
      const response = await this.fetcher.call(
        globalThis,
        `https://lofi.ham2k.net${path}`,
        {
          method: body ? "POST" : "GET",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.credentials.token}`,
            "User-Agent": "LoFiQSOFerry/0.1.0",
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(15_000),
          redirect: "manual",
        },
      );
      if (
        response.status === 401 &&
        attempt === 0 &&
        !untrustedResponse(response)
      ) {
        await response.body?.cancel();
        this.credentials.token = undefined;
        continue;
      }
      return boundedJson(response);
    }
    throw new LoFiError("authentication_failed");
  }

  /** Sends LoFi's approval email; this is separate from Ferry signup. */
  async requestApproval(email: string): Promise<SourceRecord> {
    return this.request("/v1/client/permissions", {
      email: email.trim(),
      send_email: true,
    });
  }

  async accounts(): Promise<SourceRecord> {
    const result = await this.request("/v1/accounts");
    const account = object(result.current_account);
    if (typeof account.uuid !== "string" || !account.uuid) {
      throw new LoFiError("account_not_approved");
    }
    return account;
  }

  /** Bounded reread for an operation edit; completion is not a snapshot. */
  async operationQsosPage(
    operationId: string,
    state: OperationQsosState = {},
    limit = 100,
  ): Promise<OperationQsosPage> {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(operationId) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200
    ) {
      throw new LoFiError("invalid_operation_window");
    }
    const query = new URLSearchParams({ limit: String(limit) });
    for (const [key, value] of [
      ["syncedSinceMillis", state.since],
      ["syncedUntilMillis", state.cursor],
    ] as const) {
      if (value === undefined) continue;
      if (count(value) === undefined)
        throw new LoFiError("invalid_operation_window");
      query.set(key, String(value));
    }
    const response = await this.request(
      `/v1/operations/${encodeURIComponent(operationId)}/qsos?${query}`,
    );
    if (
      Object.keys(optionalObject(optionalObject(response.errors).qsos)).length
    ) {
      throw new LoFiError("operation_reread_reconciliation_required");
    }
    const qsos = records(response.qsos).map((record) => {
      if (record.operation !== undefined && record.operation !== operationId) {
        throw new LoFiError("operation_reread_identity_mismatch");
      }
      if (count(record.syncedAtMillis) === undefined)
        throw new LoFiError("missing_server_watermark");
      // The route establishes membership when an older server omits it.
      return { ...record, operation: operationId };
    });
    const info = object(object(response.meta).qsos);
    const left = count(info.records_left ?? info.recordsLeft);
    if (left === undefined) throw new LoFiError("missing_coverage_count");
    if (left === 0)
      return {
        qsos,
        next: { ...state },
        complete: true,
        coverage: "client-contract-only",
      };
    if (!qsos.length)
      return {
        qsos,
        next: { ...state },
        complete: false,
        coverage: "client-contract-only",
      };
    const next = count(
      info.next_synced_until_millis ?? info.nextSyncedUntilMillis,
    );
    if (
      next === undefined ||
      (state.cursor !== undefined && next >= state.cursor)
    ) {
      throw new LoFiError("operation_reread_pagination_stalled");
    }
    return {
      qsos,
      next: { ...state, cursor: next },
      complete: false,
      coverage: "client-contract-only",
    };
  }

  async syncPage(
    state: SyncState,
    now: number,
    limit = 100,
  ): Promise<SyncPage> {
    if (!Number.isSafeInteger(now) || now <= 0 || limit < 1 || limit > 200) {
      throw new LoFiError("invalid_sync_window");
    }
    const window = (progress: SideProgress): SourceRecord => ({
      ...(state.mode === "backfill"
        ? { syncedUntilMillis: progress.watermark ?? now }
        : { syncedSinceMillis: progress.watermark ?? 0 }),
      ...(progress.cursor ? { cursor: progress.cursor } : {}),
      limit,
      anyClient: state.mode === "backfill",
    });
    const response = await this.request("/v1/sync", {
      meta: {
        inboundSync: true,
        ...(state.accountId ? { lastSyncAccountUUID: state.accountId } : {}),
        sync: {
          operations: window(state.operations),
          qsos: window(state.qsos),
        },
      },
    });
    const account = optionalObject(response.account);
    if (state.accountId && account.uuid !== state.accountId) {
      throw new LoFiError("account_changed");
    }
    const meta = object(response.meta);
    const errors = optionalObject(response.errors);
    const operations = records(response.operations);
    const qsos = records(response.qsos);
    const advance = (
      side: "operations" | "qsos",
      values: SourceRecord[],
    ): SideProgress => {
      const previous = state[side];
      const info = object(meta[side]);
      const sideErrors = optionalObject(errors[side]);
      if (Object.keys(sideErrors).length) {
        // Server can fall back after refusing a cursor. Do not mistake the
        // fallback for continuous coverage: recover through reconciliation.
        throw new LoFiError("cursor_or_record_reconciliation_required");
      }
      const cursorValue = info.next_cursor ?? info.nextCursor;
      if (
        cursorValue !== undefined &&
        cursorValue !== null &&
        typeof cursorValue !== "string"
      ) {
        throw new LoFiError("invalid_cursor");
      }
      const cursor =
        typeof cursorValue === "string" && cursorValue
          ? cursorValue
          : undefined;
      const remaining = count(info.records_left ?? info.recordsLeft);
      // Explicit coverage is required; a short/cooldown page proves nothing.
      if (remaining === undefined)
        throw new LoFiError("missing_coverage_count");
      if (remaining > 0 && values.length === 0) {
        return { ...previous, complete: false };
      }
      if (remaining > 0 && cursor === previous.cursor && cursor) {
        throw new LoFiError("repeated_cursor");
      }
      const stamps = values.map((value) => count(value.syncedAtMillis));
      if (stamps.some((stamp) => stamp === undefined)) {
        throw new LoFiError("missing_server_watermark");
      }
      const times = stamps as number[];
      const priorLatest =
        previous.latest ??
        (state.mode === "forward" ? previous.watermark : undefined);
      const latest = times.length
        ? Math.max(priorLatest ?? 0, ...times)
        : priorLatest;
      const oldest = times.length ? Math.min(...times) : previous.watermark;
      const candidate =
        state.mode === "backfill"
          ? oldest === undefined
            ? undefined
            : oldest + (previous.cursor ? 1 : 0)
          : latest === undefined
            ? undefined
            : latest - (previous.cursor && times.length ? 1 : 0);
      if (remaining > 0 && !cursor && candidate === previous.watermark) {
        throw new LoFiError("timestamp_pagination_stalled");
      }
      return {
        cursor,
        watermark: candidate,
        latest,
        complete: remaining === 0,
      };
    };
    let next: SyncState = {
      mode: state.mode,
      ...(state.accountId ? { accountId: state.accountId } : {}),
      operations: advance("operations", operations),
      qsos: advance("qsos", qsos),
    };
    const complete = Boolean(next.operations.complete && next.qsos.complete);
    if (complete && state.mode === "backfill") {
      next = {
        ...next,
        mode: "forward",
        operations: { watermark: next.operations.latest ?? 0 },
        qsos: { watermark: next.qsos.latest ?? 0 },
      };
    }
    return {
      operations,
      qsos,
      ...(state.accountId && Object.hasOwn(account, "email")
        ? { accountEmail: lofiAccountEmail(account.email) ?? null }
        : {}),
      next,
      complete,
      coverage: "client-contract-only",
    };
  }
}
