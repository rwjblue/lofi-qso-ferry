import type { Connection } from "./store.ts";

export interface DeliveryGates {
  exportsEnabled: boolean;
  liveWriteAuthorized: boolean;
  qrzFreshInsertsEnabled?: boolean;
  lotwFreshInsertsEnabled?: boolean;
  allowedQsoIds?: string[] | null;
  allowedDestinationIds?: string[] | null;
}
/** Each fresh capability is vendor-specific and grants no source-wide authority. */
function deliveryMode(gates: DeliveryGates, kind: "qrz" | "lotw") {
  if (!gates.exportsEnabled || !gates.liveWriteAuthorized) return null;
  if (kind === "qrz" && gates.qrzFreshInsertsEnabled === true)
    return "qrz_fresh_insert";
  return kind === "lotw" && gates.lotwFreshInsertsEnabled === true
    ? "lotw_fresh_insert"
    : null;
}
export type ScheduledDeliveryGates = DeliveryGates & {
  /** Undefined preserves ordinary operation; zero is a malformed closed window. */
  qrzFreshInsertExpiresAt?: number;
};
export type ScheduledEnvironment = Env & {
  QRZ_FRESH_INSERT_EXPIRES_AT?: string;
};

export function deliveryGates(
  env: ScheduledEnvironment,
): ScheduledDeliveryGates {
  const scope = (value: string | undefined): string[] | null => {
    const parsed: unknown = JSON.parse(value || "[]");
    if (
      !Array.isArray(parsed) ||
      parsed.some((v) => typeof v !== "string" || !v || v.length > 256) ||
      (parsed.includes("*") && parsed.length !== 1)
    )
      throw new Error("Invalid rollout scope");
    return parsed.length === 1 && parsed[0] === "*"
      ? null
      : (parsed as string[]);
  };
  const rawExpiry = env.QRZ_FRESH_INSERT_EXPIRES_AT;
  const expiry =
    rawExpiry === undefined || rawExpiry === ""
      ? undefined
      : typeof rawExpiry === "string" &&
          rawExpiry.length === 13 &&
          /^\d{13}$/.test(rawExpiry) &&
          Number.isSafeInteger(Number(rawExpiry))
        ? Number(rawExpiry)
        : 0;
  return {
    ...(expiry === undefined ? {} : { qrzFreshInsertExpiresAt: expiry }),
    allowedQsoIds: scope(env.ROLLOUT_QSO_IDS_JSON),
    allowedDestinationIds: scope(env.ROLLOUT_DESTINATION_IDS_JSON),
    exportsEnabled:
      String(env.EXPORTS_ENABLED) === "true" &&
      String(env.ROLLOUT_CHECKS_PASSED) === "true",
    liveWriteAuthorized:
      String(env.LIVE_WRITE_AUTHORIZATION) === "I_AUTHORIZE_LIVE_VENDOR_WRITES",
    qrzFreshInsertsEnabled: String(env.QRZ_FRESH_INSERTS_ENABLED) === "true",
    lotwFreshInsertsEnabled: String(env.LOTW_FRESH_INSERTS_ENABLED) === "true",
  };
}
function qrzWindowOpen(gates: ScheduledDeliveryGates, now = Date.now()) {
  const expiresAt = gates.qrzFreshInsertExpiresAt;
  return (
    expiresAt === undefined ||
    (Number.isSafeInteger(expiresAt) &&
      expiresAt > Math.max(now, Date.now()) &&
      gates.lotwFreshInsertsEnabled !== true &&
      gates.qrzFreshInsertsEnabled === true &&
      gates.allowedDestinationIds?.length === 1)
  );
}
/** This never extends an existing proof or changes its immutable ID. */
export function qrzWindowProofAllowed(
  gates: ScheduledDeliveryGates,
  expiresAt: number,
  now = Date.now(),
) {
  return (
    qrzWindowOpen(gates, now) &&
    (gates.qrzFreshInsertExpiresAt === undefined ||
      (Number.isSafeInteger(expiresAt) &&
        expiresAt > Math.max(now, Date.now()) &&
        expiresAt <= gates.qrzFreshInsertExpiresAt))
  );
}
export function routeDeliveryMode(
  gates: ScheduledDeliveryGates,
  qso: string,
  destination: Pick<Connection, "id" | "kind">,
) {
  if (
    !qrzWindowOpen(gates) ||
    (destination.kind !== "qrz" && destination.kind !== "lotw") ||
    (gates.allowedQsoIds !== null && !gates.allowedQsoIds?.includes(qso)) ||
    (gates.allowedDestinationIds !== null &&
      !gates.allowedDestinationIds?.includes(destination.id))
  )
    return null;
  return deliveryMode(gates, destination.kind);
}
