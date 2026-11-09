import type { Store } from "./store.ts";

export type Vendor = "lofi" | "qrz" | "lotw";
export type VendorPriority = "live" | "background";
export interface VendorPolicy {
  windowMs: number;
  total: number;
  background: number;
}

/** Application limits. LoFi reserves a separate foreground allowance. */
export const VENDOR_POLICIES: Readonly<Record<Vendor, Readonly<VendorPolicy>>> =
  {
    lofi: { windowMs: 300_000, total: 24, background: 4 },
    qrz: { windowMs: 60_000, total: 60, background: 60 },
    lotw: { windowMs: 60_000, total: 60, background: 60 },
  };

export class VendorDeferredError extends Error {
  readonly status = 503;
  constructor(
    readonly retryAt: number,
    /** False means the budget rejected the request before any network I/O. */
    readonly requestSent = false,
  ) {
    super("Vendor request deferred; retry later");
    this.name = "VendorDeferredError";
  }
}

interface Budget {
  window_start: number;
  cooldown_until: number;
}
/** Execute this request's native reservation together with a caller's guards. */
export type VendorAdmission = (
  reservation: D1PreparedStatement,
) => Promise<Budget | null>;

/** Scheduling hint only. Actual requests must still reserve their own slot. */
export async function vendorRequestsAvailable(
  store: Store,
  vendor: Vendor,
  priority: VendorPriority,
  now: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("Invalid vendor scheduling clock");
  const policy = VENDOR_POLICIES[vendor];
  if (priority === "background" && policy.background === 0) return false;
  const window = Math.floor(now / policy.windowMs) * policy.windowMs;
  return Boolean(
    await store
      .statement(
        `SELECT 1 available WHERE NOT EXISTS(SELECT 1 FROM vendor_requests
     WHERE vendor=? AND (cooldown_until>? OR (window_start>=? AND
      (requests>=? OR (?=1 AND background_requests>=?)))))`,
        vendor,
        now,
        window,
        policy.total,
        priority === "background" ? 1 : 0,
        policy.background,
      )
      .first(),
  );
}

/** The persisted cooldown determines the outcome, independently of cleanup. */
function cancelBestEffort(stream: { cancel(): Promise<void> } | null): void {
  try {
    void stream?.cancel().catch(() => undefined);
  } catch {
    // A synchronous cleanup failure cannot replace the typed deferral.
  }
}

function retryAfter(value: string | null, now: number): number | null {
  if (value === null || value.length > 128) return null;
  const header = value.trim();
  let deadline: number;
  if (/^\d+$/.test(header)) {
    deadline = now + Number(header) * 1000;
  } else if (/^[A-Za-z]{3,9}(?:,| )/.test(header)) {
    deadline = Date.parse(header);
  } else {
    return null;
  }
  return Number.isSafeInteger(deadline) ? Math.max(now + 1000, deadline) : null;
}

/**
 * All tenants and all Worker invocations share one row per vendor. A request
 * reserves its slot before dispatch; there is no sleep or automatic replay.
 */
export function vendorFetch(
  store: Store,
  vendor: Vendor,
  fetcher: typeof fetch = fetch,
  options: {
    priority?: VendorPriority;
    now?: number;
    policy?: VendorPolicy;
    admit?: VendorAdmission;
  } = {},
): typeof fetch {
  const policy = options.policy ?? VENDOR_POLICIES[vendor];
  if (
    !Number.isSafeInteger(policy.windowMs) ||
    policy.windowMs < 1 ||
    !Number.isSafeInteger(policy.total) ||
    policy.total < 1 ||
    !Number.isSafeInteger(policy.background) ||
    policy.background < 0 ||
    policy.background > policy.total
  )
    throw new Error("Invalid vendor request policy");
  const background = options.priority === "background" ? 1 : 0;
  return async (input, init) => {
    const now = options.now ?? Date.now();
    const window = Math.floor(now / policy.windowMs) * policy.windowMs;
    // The conflict guard and both counters are one atomic statement. A stale
    // invocation cannot move the window backwards and refill another's budget.
    const reservation = store.statement(
      `INSERT INTO vendor_requests(vendor,window_start,requests,background_requests,cooldown_until)
         SELECT ?1,?2,1,?3,0 WHERE ?3=0 OR ?4>0
         ON CONFLICT(vendor) DO UPDATE SET
          window_start=MAX(vendor_requests.window_start,excluded.window_start),
          requests=CASE WHEN vendor_requests.window_start<excluded.window_start THEN 1 ELSE vendor_requests.requests+1 END,
          background_requests=CASE WHEN vendor_requests.window_start<excluded.window_start THEN excluded.background_requests ELSE vendor_requests.background_requests+excluded.background_requests END
         WHERE vendor_requests.cooldown_until<=?5
          AND (vendor_requests.window_start<excluded.window_start OR vendor_requests.requests<?6)
          AND (?3=0 OR ?4>0 AND (vendor_requests.window_start<excluded.window_start OR vendor_requests.background_requests<?4))
         RETURNING window_start,cooldown_until`,
      vendor,
      window,
      background,
      policy.background,
      now,
      policy.total,
    );
    const reserved = options.admit
      ? await options.admit(reservation)
      : await reservation.first<Budget>();
    if (!reserved) {
      const budget = await store
        .statement(
          "SELECT window_start,cooldown_until FROM vendor_requests WHERE vendor=?",
          vendor,
        )
        .first<Budget>();
      throw new VendorDeferredError(
        budget && budget.cooldown_until > now
          ? budget.cooldown_until
          : Math.max(
              now + 1,
              (budget?.window_start ?? window) + policy.windowMs,
            ),
      );
    }
    const response = await fetcher(input, init);
    if (response.status !== 429 && response.status !== 503) return response;
    const respondedAt = options.now ?? Date.now();
    const until =
      retryAfter(response.headers.get("Retry-After"), respondedAt) ??
      (response.status === 429 ? respondedAt + 300_000 : null);
    if (until === null) return response;
    // A shorter concurrent response must never cancel a longer vendor cooldown.
    const cooldown = await store
      .statement(
        `INSERT INTO vendor_requests(vendor,window_start,requests,background_requests,cooldown_until) VALUES(?,?,0,0,?)
         ON CONFLICT(vendor) DO UPDATE SET cooldown_until=MAX(vendor_requests.cooldown_until,excluded.cooldown_until)
         RETURNING window_start,cooldown_until`,
        vendor,
        window,
        until,
      )
      .first<Budget>();
    if (response.status === 429) {
      cancelBestEffort(response.body);
      throw new VendorDeferredError(cooldown?.cooldown_until ?? until, true);
    }
    return response;
  };
}
