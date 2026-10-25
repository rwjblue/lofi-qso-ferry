import type { Store } from "./store.ts";
import {
  VENDOR_POLICIES,
  VendorDeferredError,
  type VendorPriority,
  vendorFetch,
} from "./vendor-requests.ts";

// One bounded final neighborhood (4 targeted + STATUS + 4 covering) plus INSERT.
const FINAL_HEADROOM = 10;
/** Invocation-local planning ceiling; shared vendor reservations remain authoritative. */
export class QrzPlanningAllowance {
  #window = -1;
  #total = 0;
  #background = 0;
  admit(priority: VendorPriority, at: number): void {
    const policy = VENDOR_POLICIES.qrz;
    if (!Number.isSafeInteger(at) || at < 0)
      throw new Error("Invalid QRZ planning clock");
    const window = Math.floor(at / policy.windowMs) * policy.windowMs;
    if (window < this.#window)
      throw new VendorDeferredError(this.#window + policy.windowMs);
    // No refill within a tick, including across a vendor-window boundary. Slow
    // in-flight admission therefore cannot disappear from the planning count.
    this.#window = window;
    if (
      this.#total >= policy.total - FINAL_HEADROOM ||
      (priority === "background" &&
        this.#background >= policy.background - FINAL_HEADROOM)
    )
      throw new VendorDeferredError(window + policy.windowMs);
    this.#total++;
    if (priority === "background") this.#background++;
  }
}
export function qrzPlanningFetch(
  store: Store,
  raw: typeof fetch,
  priority: VendorPriority | undefined,
  now: () => number,
  allowance?: QrzPlanningAllowance,
): typeof fetch {
  return async (input, init) => {
    const at = now();
    // This runs synchronously BEFORE the native shared reservation, never inside raw transport.
    allowance?.admit(priority ?? "live", at);
    return vendorFetch(store, "qrz", raw, { priority, now: at })(input, init);
  };
}
