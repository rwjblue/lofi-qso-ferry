import { deliveryGates } from "./delivery-gates.ts";
import type { InventoryShadowEnvironment } from "./inventory-preparation-shadow.ts";

export type InventoryUploadProvider = "qrz" | "lotw";
export type InventoryDeliveryEnvironment = InventoryShadowEnvironment & {
  QRZ_FRESH_INSERT_EXPIRES_AT?: string;
  LOTW_FRESH_INSERT_EXPIRES_AT?: string;
};

/** Managed uploads need an explicit mode, provider gate and rollout scope.
 * A wildcard is explicit approval. Missing or invalid scopes stay closed. */
export function managedInventoryAuthorization(
  env: InventoryDeliveryEnvironment,
  provider: InventoryUploadProvider,
) {
  if (env.INVENTORY_RUNTIME_MODE !== "managed") return null;
  let gates: ReturnType<typeof deliveryGates>;
  try {
    gates = deliveryGates(env);
  } catch {
    return null;
  }
  const enabled =
    provider === "qrz"
      ? gates.qrzFreshInsertsEnabled
      : gates.lotwFreshInsertsEnabled;
  const keys = gates.allowedQsoIds;
  const destinations = gates.allowedDestinationIds;
  if (
    !enabled ||
    !gates.exportsEnabled ||
    !gates.liveWriteAuthorized ||
    (keys !== null && !keys?.length) ||
    (destinations !== null && !destinations?.length)
  )
    return null;
  const rawExpiry =
    provider === "qrz"
      ? env.QRZ_FRESH_INSERT_EXPIRES_AT
      : env.LOTW_FRESH_INSERT_EXPIRES_AT;
  const expiresAt =
    rawExpiry === undefined || rawExpiry === ""
      ? Number.MAX_SAFE_INTEGER
      : /^\d{13}$/.test(rawExpiry)
        ? Number(rawExpiry)
        : 0;
  if (expiresAt <= Date.now()) return null;

  // The managed provider window is checked independently of the other vendor.
  // Native proof and scope checks still run at the provider's may-send claim.
  return {
    keys: keys ?? null,
    destinations: destinations ?? null,
    expiresAt,
    gates: {
      ...gates,
      qrzFreshInsertExpiresAt: undefined,
      qrzFreshInsertsEnabled: provider === "qrz",
      lotwFreshInsertsEnabled: provider === "lotw",
    },
  };
}
