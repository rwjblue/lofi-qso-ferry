import { readonlyVendorTransport } from "./vendor-readonly.ts";

type Provider = "lofi" | "qrz" | "lotw";
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MIN_LOFI_INTERVAL_MS = 5_000;
const encoder = new TextEncoder();

function requireValue(value: unknown): asserts value {
  if (!value) throw new Error("inventory_trial_request_blocked");
}
function object(value: unknown): Record<string, unknown> {
  requireValue(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  requireValue(Object.keys(value).every((key) => allowed.includes(key)));
}
function safeMillis(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function readWindow(value: unknown) {
  const window = object(value);
  keys(window, [
    "syncedSinceMillis",
    "syncedUntilMillis",
    "cursor",
    "limit",
    "anyClient",
  ]);
  requireValue(
    window.anyClient === true &&
      Number.isSafeInteger(window.limit) &&
      (window.limit as number) > 0 &&
      (window.limit as number) <= 1000,
  );
  const since = Object.hasOwn(window, "syncedSinceMillis");
  const until = Object.hasOwn(window, "syncedUntilMillis");
  requireValue(since !== until);
  requireValue(
    safeMillis(since ? window.syncedSinceMillis : window.syncedUntilMillis),
  );
  if (Object.hasOwn(window, "cursor"))
    requireValue(
      typeof window.cursor === "string" &&
        window.cursor.length > 0 &&
        window.cursor.length <= 16_384,
    );
}
function syncBody(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("inventory_trial_request_blocked");
  }
  const body = object(parsed);
  keys(body, ["meta"]);
  const meta = object(body.meta);
  keys(meta, ["inboundSync", "lastSyncAccountUUID", "sync"]);
  requireValue(meta.inboundSync === true);
  if (Object.hasOwn(meta, "lastSyncAccountUUID"))
    requireValue(
      typeof meta.lastSyncAccountUUID === "string" &&
        meta.lastSyncAccountUUID.length > 0 &&
        meta.lastSyncAccountUUID.length <= 512,
    );
  const sync = object(meta.sync);
  keys(sync, ["operations", "qsos"]);
  readWindow(sync.operations);
  readWindow(sync.qsos);
  // Send the parsed allowlisted value, removing ambiguous duplicate JSON keys.
  return JSON.stringify(body);
}
async function requestBody(input: Request): Promise<string> {
  const reader = input.clone().body?.getReader();
  requireValue(reader);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      requireValue(bytes <= MAX_REQUEST_BODY_BYTES);
      chunks.push(next.value);
    }
  } catch {
    void reader.cancel().catch(() => undefined);
    throw new Error("inventory_trial_request_blocked");
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}
function abort(signal?: AbortSignal | null) {
  if (signal?.aborted) throw new Error("inventory_trial_request_aborted");
}
function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
  abort(signal);
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      reject(new Error("inventory_trial_request_aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/**
 * No registration, renewal, approval emails or log mutations in local trials.
 * Pace outside client calls too: their timeout starts before this spacing check.
 */
export function createInventoryTrialTransport(
  transport: typeof fetch = fetch,
  options: { maxRequests?: number; minLoFiIntervalMs?: number } = {},
) {
  const maxRequests = options.maxRequests ?? 8;
  requireValue(Number.isSafeInteger(maxRequests) && maxRequests > 0);
  const requestedInterval = options.minLoFiIntervalMs ?? 20_000;
  requireValue(safeMillis(requestedInterval));
  // Zero is reserved for an explicitly injected synthetic transport in tests.
  requireValue(requestedInterval !== 0 || transport !== fetch);
  let loFiInterval =
    requestedInterval === 0
      ? 0
      : Math.max(MIN_LOFI_INTERVAL_MS, requestedInterval);
  let requestCount = 0;
  let lastLoFiStartedAt: number | null = null;
  let lofiAuthorizationRequired = false;
  let loFiQueue: Promise<void> = Promise.resolve();
  const metrics = {
    requests: 0,
    byProvider: { lofi: 0, qrz: 0, lotw: 0 },
    responseBytes: 0,
  };
  const setLoFiDelay = (ms: number): void => {
    requireValue(safeMillis(ms));
    loFiInterval = Math.max(loFiInterval, MIN_LOFI_INTERVAL_MS, ms);
  };
  const send = async (
    provider: Provider,
    url: string,
    init: RequestInit,
  ): Promise<Response> => {
    abort(init.signal);
    if (requestCount >= maxRequests)
      throw new Error("inventory_trial_request_budget_exhausted");
    requestCount++;
    metrics.requests = requestCount;
    metrics.byProvider[provider]++;
    let response: Response;
    try {
      response = await transport(url, { ...init, redirect: "error" });
    } catch {
      // Upstream errors can contain LoTW passwords or other request details.
      throw new Error("inventory_trial_transport_failed");
    }
    if (provider === "lofi" && response.status === 401)
      lofiAuthorizationRequired = true;
    if (
      response.redirected ||
      ["opaque", "opaqueredirect"].includes(response.type) ||
      (response.status >= 300 && response.status < 400)
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("inventory_trial_redirect_blocked");
    }
    if (!response.body) return response;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        metrics.responseBytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    return new Response(response.body.pipeThrough(counter), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  const vendor = readonlyVendorTransport(async (input, init) => {
    const url = new URL(String(input));
    return send(
      url.origin === "https://logbook.qrz.com" ? "qrz" : "lotw",
      url.href,
      init ?? {},
    );
  });
  const guarded: typeof fetch = async (input, init) => {
    let url: URL;
    try {
      url = new URL(input instanceof Request ? input.url : String(input));
    } catch {
      throw new Error("inventory_trial_request_blocked");
    }
    requireValue(!url.username && !url.password && !url.hash);
    const request = input instanceof Request ? input : null;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers);
    const signal = init?.signal ?? request?.signal;
    let body = init?.body;
    const bodyPresent =
      body !== undefined && body !== null ? true : Boolean(request?.body);
    if (url.origin === "https://lofi.ham2k.net") {
      requireValue(!url.search);
      // A cleared or missing bearer may make the client try registration.
      // Preserve a useful stop reason without sending that request.
      if (url.pathname === "/v1/client" && method === "POST")
        lofiAuthorizationRequired = true;
      if (url.pathname === "/v1/accounts")
        requireValue(method === "GET" && !bodyPresent);
      else {
        requireValue(url.pathname === "/v1/sync" && method === "POST");
        requireValue(
          /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
            headers.get("Content-Type") ?? "",
          ),
        );
        if (body === undefined && request) body = await requestBody(request);
        requireValue(
          typeof body === "string" &&
            encoder.encode(body).byteLength <= MAX_REQUEST_BODY_BYTES,
        );
        body = syncBody(body);
      }
      const frozen: RequestInit = {
        ...init,
        method,
        headers,
        signal,
        body,
        redirect: "error",
      };
      const previous = loFiQueue;
      let release = () => {};
      loFiQueue = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        for (;;) {
          abort(signal);
          const remaining =
            lastLoFiStartedAt === null
              ? 0
              : lastLoFiStartedAt + loFiInterval - Date.now();
          if (remaining <= 0) break;
          await wait(Math.min(remaining, 2_147_483_647), signal);
        }
        lastLoFiStartedAt = Date.now();
        return await send("lofi", url.href, frozen);
      } finally {
        release();
      }
    }
    if (url.origin === "https://logbook.qrz.com") {
      requireValue(body instanceof URLSearchParams);
      const form = new URLSearchParams(body);
      body = form;
      requireValue(
        [...form.keys()].every((key) =>
          ["KEY", "ACTION", "OPTION", "LOGIDS"].includes(key),
        ) && [...form.keys()].every((key) => form.getAll(key).length === 1),
      );
    } else if (url.origin === "https://lotw.arrl.org") {
      requireValue(!bodyPresent);
      const allowed = [
        "login",
        "password",
        "qso_query",
        "qso_qsl",
        "qso_qsorxsince",
        "qso_mydetail",
        "qso_withown",
        "qso_startdate",
        "qso_enddate",
        "qso_owncall",
        "qso_callsign",
      ];
      requireValue(
        [...url.searchParams.keys()].every((key) => allowed.includes(key)) &&
          [...url.searchParams.keys()].every(
            (key) => url.searchParams.getAll(key).length === 1,
          ),
      );
    }
    return vendor(url.href, {
      ...init,
      method,
      body,
      headers,
      signal,
      redirect: "error",
    });
  };
  return {
    fetch: guarded,
    metrics,
    setLoFiDelay,
    get lofiAuthorizationRequired() {
      return lofiAuthorizationRequired;
    },
  };
}
