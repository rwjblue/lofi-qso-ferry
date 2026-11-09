import type { InventoryStream } from "./inventory-ingestion.ts";
import { randomToken } from "./security.ts";
import type { Lease, Store } from "./store.ts";
import { VendorDeferredError, vendorFetch } from "./vendor-requests.ts";

export type InventoryReadPriority = "bootstrap" | "background" | "live";
export const INVENTORY_GLOBAL_DELAY_MS = 5000;
export const INVENTORY_DEFAULT_SOURCE_DELAY_MS = 20_000;
export const INVENTORY_MIN_SOURCE_DELAY_MS = 5000;
// Retain the original export as the no-server-hint fallback.
export const INVENTORY_SOURCE_DELAY_MS = INVENTORY_DEFAULT_SOURCE_DELAY_MS;
const WINDOW_MS = 300_000;
const GLOBAL_TOTAL = 24;
const NONFOREGROUND_TOTAL = 20;
const ORDINARY_BACKGROUND_TOTAL = 4;
const BOOTSTRAP_RESERVE_ERROR = "inventory bootstrap reserved background";

export class InventoryVendorAdmissionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "InventoryVendorAdmissionError";
  }
}
function duration(value: number | undefined, minimum: number) {
  if (value === undefined) return minimum;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new InventoryVendorAdmissionError("invalid_inventory_pacing");
  return Math.max(minimum, value);
}

export interface InventoryPacingHints {
  loopDelayMs?: number;
  checkPeriodMs?: number;
  observedAt: number;
}

function sourceBinding(stream: InventoryStream) {
  if (stream.provider !== "lofi" || !stream.tenant || !stream.connection)
    throw new InventoryVendorAdmissionError("invalid_inventory_pacing");
}

/** Retained hints are scheduling input; native admission rechecks authority. */
export async function inventorySourcePacing(
  store: Store,
  stream: InventoryStream,
): Promise<{
  loopDelayMs?: number;
  checkPeriodMs?: number;
  nextAllowedAt: number;
}> {
  sourceBinding(stream);
  const row = await store
    .statement(
      `SELECT loop_delay_ms,check_period_ms,next_allowed_at FROM inventory_read_pacing
       WHERE vendor='lofi' AND tenant=? AND source=?`,
      stream.tenant,
      stream.connection,
    )
    .first<{
      loop_delay_ms: number | null;
      check_period_ms: number | null;
      next_allowed_at: number;
    }>();
  return {
    ...(row?.loop_delay_ms != null ? { loopDelayMs: row.loop_delay_ms } : {}),
    ...(row?.check_period_ms != null
      ? { checkPeriodMs: row.check_period_ms }
      : {}),
    nextAllowedAt: row?.next_allowed_at ?? 0,
  };
}

/** Add to an already guarded publication batch; this never refreshes a witness. */
export function inventorySourcePacingStatement(
  store: Store,
  stream: InventoryStream,
  requestStartedAt: number,
  delayMs: number,
  hints?: InventoryPacingHints,
): D1PreparedStatement {
  sourceBinding(stream);
  let delay = duration(delayMs, INVENTORY_MIN_SOURCE_DELAY_MS);
  if (hints) {
    duration(hints.loopDelayMs, 0);
    if (
      !Number.isSafeInteger(hints.observedAt) ||
      hints.observedAt < 0 ||
      (hints.checkPeriodMs !== undefined &&
        (!Number.isSafeInteger(hints.checkPeriodMs) ||
          hints.checkPeriodMs <= 0))
    )
      throw new InventoryVendorAdmissionError("invalid_inventory_pacing");
    delay = Math.max(delay, hints.loopDelayMs ?? 0);
  }
  if (
    !Number.isSafeInteger(requestStartedAt) ||
    requestStartedAt < 0 ||
    !Number.isSafeInteger(requestStartedAt + delay) ||
    (hints !== undefined && !Number.isSafeInteger(hints.observedAt + delay))
  )
    throw new InventoryVendorAdmissionError("invalid_inventory_pacing");
  return store.statement(
    `UPDATE inventory_read_pacing SET next_allowed_at=max(next_allowed_at,last_requested_at+?1,?2,coalesce(?5+?1,0)),
     loop_delay_ms=coalesce(?3,loop_delay_ms),check_period_ms=coalesce(?4,check_period_ms),
     hints_observed_at=coalesce(?5,hints_observed_at)
     WHERE vendor='lofi' AND tenant=?6 AND source=?7
      AND (?5 IS NULL OR hints_observed_at IS NULL OR ?5>=hints_observed_at)`,
    delay,
    requestStartedAt + delay,
    hints?.loopDelayMs ?? null,
    hints?.checkPeriodMs ?? null,
    hints?.observedAt ?? null,
    stream.tenant,
    stream.connection,
  );
}
async function deferredUntil(
  store: Store,
  stream: InventoryStream,
  priority: InventoryReadPriority,
  now: number,
  backgroundReserved: boolean,
) {
  const result = await store
    .statement(
      `SELECT
       (SELECT window_start FROM vendor_requests WHERE vendor='lofi') global_window,
       (SELECT requests FROM vendor_requests WHERE vendor='lofi') global_requests,
       (SELECT background_requests FROM vendor_requests WHERE vendor='lofi') background_requests,
       (SELECT cooldown_until FROM vendor_requests WHERE vendor='lofi') cooldown,
       (SELECT window_start FROM inventory_vendor_bootstrap WHERE vendor='lofi') bootstrap_window,
       (SELECT requests FROM inventory_vendor_bootstrap WHERE vendor='lofi') bootstrap_requests,
       (SELECT max(next_allowed_at) FROM inventory_read_pacing WHERE vendor='lofi' AND ((tenant='' AND source='') OR (tenant=? AND source=?))) paced_until`,
      stream.tenant,
      stream.connection,
    )
    .first<{
      global_window: number | null;
      global_requests: number | null;
      background_requests: number | null;
      cooldown: number | null;
      bootstrap_window: number | null;
      bootstrap_requests: number | null;
      paced_until: number | null;
    }>();
  const window = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const globalWindow = result?.global_window ?? window;
  const bootstrapWindow = result?.bootstrap_window ?? window;
  const requests = globalWindow >= window ? (result?.global_requests ?? 0) : 0;
  const background =
    globalWindow >= window ? (result?.background_requests ?? 0) : 0;
  const bootstrap =
    bootstrapWindow >= window ? (result?.bootstrap_requests ?? 0) : 0;
  const quota =
    backgroundReserved ||
    globalWindow > window ||
    bootstrapWindow > window ||
    requests >= GLOBAL_TOTAL ||
    (priority !== "live" && bootstrap + background >= NONFOREGROUND_TOTAL) ||
    (priority === "background" && background >= ORDINARY_BACKGROUND_TOTAL);
  return Math.max(
    now + 1,
    result?.cooldown ?? 0,
    result?.paced_until ?? 0,
    quota ? Math.max(window, globalWindow, bootstrapWindow) + WINDOW_MS : 0,
  );
}

/**
 * LoFi inventory reads only. Every actual transport request reserves global
 * quota, its explicit traffic class and both durable pacers in one transaction.
 * A caller must separately restrict endpoints and bodies to read-only requests.
 */
export function inventoryVendorFetch(
  store: Store,
  captured: InventoryStream,
  lease: Lease,
  fetcher: typeof fetch,
  options: {
    priority: InventoryReadPriority;
    now?: number | (() => number);
    /** Validated server hint; absent uses 20s, supplied values have a 5s floor. */
    sourceDelayMs?: number;
    globalDelayMs?: number;
    /** Additional native run/job checks and cleanup, evaluated per request. */
    guard?: () => {
      before: D1PreparedStatement[];
      after: D1PreparedStatement[];
    };
  },
): typeof fetch {
  const stream = structuredClone(captured);
  lease = structuredClone(lease);
  if (
    stream.provider !== "lofi" ||
    !["bootstrap", "background", "live"].includes(options.priority) ||
    lease.tenant !== stream.tenant ||
    lease.scope !== `inventory:${stream.scope}`
  )
    throw new InventoryVendorAdmissionError("invalid_inventory_read_binding");
  const globalDelay = duration(
    options.globalDelayMs,
    INVENTORY_GLOBAL_DELAY_MS,
  );
  const sourceDelay =
    options.sourceDelayMs === undefined
      ? INVENTORY_DEFAULT_SOURCE_DELAY_MS
      : duration(options.sourceDelayMs, INVENTORY_MIN_SOURCE_DELAY_MS);
  const priority = options.priority;
  const clock = options.now;
  const guard = options.guard;
  return async (input, init) => {
    const now = typeof clock === "function" ? clock() : (clock ?? Date.now());
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isSafeInteger(now + Math.max(globalDelay, sourceDelay))
    )
      throw new InventoryVendorAdmissionError("invalid_inventory_pacing");
    const window = Math.floor(now / WINDOW_MS) * WINDOW_MS;
    // Bootstrap is a separate counter, not ordinary background or an upload.
    // The existing total reservation increments background_requests only for
    // actual ordinary background traffic, retaining its original four-slot cap.
    const admittedOptions: NonNullable<Parameters<typeof vendorFetch>[3]> = {
      now,
      priority: priority === "background" ? "background" : "live",
      admit: async (reservation) => {
        const extra = guard?.() ?? { before: [], after: [] };
        const reservationIndex = extra.before.length + 1;
        const id = randomToken();
        try {
          const results = await store.db.batch([
            ...extra.before,
            store.statement(
              `INSERT INTO inventory_request_guards(id,tenant,scope_id,connection_id,stream_id,logical_identity,adapter_binding,ordering,query_binding,config_version,expected_sequence,expected_stream_version,credential_version,connection_config,remote_identity,lease_scope,lease_token,lease_fence,priority,now,window_start,global_delay,source_delay,expected_requests,expected_background)
              SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
               CASE WHEN coalesce((SELECT window_start FROM vendor_requests WHERE vendor='lofi'),-1)<? THEN 1 ELSE (SELECT requests FROM vendor_requests WHERE vendor='lofi')+1 END,
               CASE WHEN coalesce((SELECT window_start FROM vendor_requests WHERE vendor='lofi'),-1)<? THEN ? ELSE (SELECT background_requests FROM vendor_requests WHERE vendor='lofi')+? END`,
              id,
              stream.tenant,
              stream.scope,
              stream.connection,
              stream.stream,
              stream.logicalIdentity,
              stream.adapterBinding,
              stream.ordering,
              stream.queryBinding,
              stream.configVersion,
              stream.sequence,
              stream.version,
              stream.credentialVersion,
              stream.connectionConfig,
              stream.remoteIdentity,
              lease.scope,
              lease.token,
              lease.fence,
              priority,
              now,
              window,
              globalDelay,
              sourceDelay,
              window,
              window,
              Number(priority === "background"),
              Number(priority === "background"),
            ),
            reservation,
            store.statement(
              "UPDATE inventory_request_guards SET phase='reserved' WHERE id=?",
              id,
            ),
            store.statement(
              `INSERT INTO inventory_vendor_bootstrap(vendor,window_start,requests)
               SELECT 'lofi',window_start,1 FROM inventory_request_guards WHERE id=? AND priority='bootstrap'
               ON CONFLICT(vendor) DO UPDATE SET window_start=excluded.window_start,requests=CASE WHEN inventory_vendor_bootstrap.window_start<excluded.window_start THEN 1 ELSE inventory_vendor_bootstrap.requests+1 END`,
              id,
            ),
            store.statement(
              `INSERT INTO inventory_read_pacing(vendor,tenant,source,last_requested_at,next_allowed_at)
               SELECT 'lofi','','',now,now+global_delay FROM inventory_request_guards WHERE id=?
               ON CONFLICT(vendor,tenant,source) DO UPDATE SET last_requested_at=excluded.last_requested_at,next_allowed_at=excluded.next_allowed_at`,
              id,
            ),
            store.statement(
              `INSERT INTO inventory_read_pacing(vendor,tenant,source,last_requested_at,next_allowed_at)
               SELECT 'lofi',g.tenant,g.connection_id,g.now,g.now+max(g.source_delay,
                coalesce((SELECT max(5000,p.loop_delay_ms) FROM inventory_read_pacing p WHERE p.vendor='lofi' AND p.tenant=g.tenant AND p.source=g.connection_id),0))
               FROM inventory_request_guards g WHERE g.id=?
               ON CONFLICT(vendor,tenant,source) DO UPDATE SET last_requested_at=excluded.last_requested_at,next_allowed_at=excluded.next_allowed_at`,
              id,
            ),
            ...extra.after,
            store.statement(
              "DELETE FROM inventory_request_guards WHERE id=?",
              id,
            ),
          ]);
          return results[reservationIndex].results[0] as {
            window_start: number;
            cooldown_until: number;
          };
        } catch (error) {
          const backgroundReserved =
            error instanceof Error &&
            error.message.includes(BOOTSTRAP_RESERVE_ERROR);
          if (
            backgroundReserved ||
            (error instanceof Error &&
              error.message.includes("inventory request deferred"))
          )
            throw new VendorDeferredError(
              await deferredUntil(
                store,
                stream,
                priority,
                now,
                backgroundReserved,
              ),
            );
          if (
            error instanceof Error &&
            error.message.includes("inventory request authority changed")
          )
            throw new InventoryVendorAdmissionError(
              "inventory_authority_changed",
            );
          throw error;
        }
      },
    };
    return vendorFetch(
      store,
      "lofi",
      async (request, requestInit) => {
        const response = await fetcher(request, requestInit);
        // vendorFetch samples options.now again for Retry-After. Advance this
        // private request clock after the response so slow reads do not shorten
        // its cooldown; explicitly fixed numeric clocks remain deterministic.
        const respondedAt =
          typeof clock === "function" ? clock() : (clock ?? Date.now());
        admittedOptions.now = Math.max(now, respondedAt);
        return response;
      },
      admittedOptions,
    )(input, init);
  };
}
