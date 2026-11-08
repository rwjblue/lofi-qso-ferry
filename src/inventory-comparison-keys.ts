import type { AdifRecord } from "./adif.ts";
import {
  HISTORICAL_CANDIDATE_POLICY_VERSION,
  HISTORICAL_TIME_WINDOW_MS,
  historicalCandidateKeys,
} from "./historical-matching.ts";
import { b64, canonical, unb64 } from "./security.ts";

export const INVENTORY_COMPARISON_KEY_VERSION = 1;
export const INVENTORY_COMPARISON_BUCKET_MS = HISTORICAL_TIME_WINDOW_MS;
export type InventoryComparisonKeyClass =
  | "call_and_time"
  | "call_only"
  | "time_only"
  | "unknown";
export interface InventoryComparisonKey {
  tenant: string;
  keyId: string;
  key: CryptoKey;
}
export interface InventoryComparisonKeyContext extends InventoryComparisonKey {
  generation: string;
}
export interface InventoryComparisonToken {
  keyClass: InventoryComparisonKeyClass;
  hash: string;
}

const encoder = new TextEncoder();
function requireValue(value: unknown): asserts value {
  if (!value) throw new Error("invalid_inventory_comparison_key");
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}
async function hmac(key: CryptoKey, value: unknown) {
  return b64(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(canonical(value))),
    ),
  );
}

/** Storage/rotation is separate; an index generation pins this tenant key ID. */
export async function importInventoryComparisonKey(
  tenant: string,
  secret: string,
): Promise<InventoryComparisonKey> {
  requireValue(
    identifier(tenant) &&
      typeof secret === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(secret),
  );
  const bytes = unb64(secret);
  requireValue(bytes.length === 32 && b64(bytes) === secret);
  const key = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return {
    tenant,
    key,
    keyId: await hmac(key, ["inventory-comparison-key-id-v1", tenant]),
  };
}

function capture(context: InventoryComparisonKeyContext) {
  const { tenant, generation, keyId, key } = context;
  const algorithm = key?.algorithm as HmacKeyAlgorithm | undefined;
  requireValue(
    identifier(tenant) &&
      identifier(generation) &&
      typeof keyId === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(keyId) &&
      algorithm?.name === "HMAC" &&
      algorithm.hash.name === "SHA-256" &&
      algorithm.length === 256 &&
      !key.extractable &&
      key.usages.includes("sign"),
  );
  // The single-bucket proof depends on ADIF minute intervals fitting wholly
  // inside a bucket. A future non-minute-aligned policy needs a new format.
  requireValue(
    INVENTORY_COMPARISON_BUCKET_MS > 0 &&
      INVENTORY_COMPARISON_BUCKET_MS % 60000 === 0,
  );
  return { tenant, generation, keyId, key };
}
function bucket(start: number, end: number) {
  const value = Math.floor(start / INVENTORY_COMPARISON_BUCKET_MS);
  requireValue(
    Number.isSafeInteger(value) &&
      Math.floor(end / INVENTORY_COMPARISON_BUCKET_MS) === value,
  );
  return value;
}
function token(
  context: InventoryComparisonKeyContext,
  keyClass: InventoryComparisonKeyClass,
  values: readonly (string | number)[],
): Promise<InventoryComparisonToken> {
  return hmac(context.key, [
    "inventory-comparison",
    INVENTORY_COMPARISON_KEY_VERSION,
    HISTORICAL_CANDIDATE_POLICY_VERSION,
    INVENTORY_COMPARISON_BUCKET_MS,
    context.tenant,
    context.generation,
    context.keyId,
    keyClass,
    ...values,
  ]).then((hash) => ({ keyClass, hash }));
}

/** One stored bucket, including partial candidates; never match/write authority. */
export async function inventoryComparisonToken(
  context: InventoryComparisonKeyContext,
  record: AdifRecord,
): Promise<InventoryComparisonToken> {
  context = capture(context);
  const keys = historicalCandidateKeys(record);
  const timeBucket = keys.time
    ? bucket(keys.time.startMs, keys.time.endMs)
    : undefined;
  if (keys.workedCall && timeBucket !== undefined)
    return token(context, "call_and_time", [keys.workedCall, timeBucket]);
  if (keys.workedCall) return token(context, "call_only", [keys.workedCall]);
  if (timeBucket !== undefined)
    return token(context, "time_only", [timeBucket]);
  return token(context, "unknown", []);
}

/**
 * Equality probes for a complete selected contact: three neighboring complete
 * buckets and every relevant partial class. Exact predicates still run after
 * loading candidates; a neighboring hash is only a coarse search restriction.
 */
export async function inventoryComparisonLookup(
  context: InventoryComparisonKeyContext,
  record: AdifRecord,
): Promise<InventoryComparisonToken[]> {
  context = capture(context);
  const keys = historicalCandidateKeys(record);
  if (!keys.workedCall || !keys.time)
    throw new Error("inventory_comparison_input_incomplete");
  const center = bucket(keys.time.startMs, keys.time.endMs);
  const workedCall = keys.workedCall;
  const neighbors = [center - 1, center, center + 1];
  return Promise.all([
    ...neighbors.map((value) =>
      token(context, "call_and_time", [workedCall, value]),
    ),
    token(context, "call_only", [workedCall]),
    ...neighbors.map((value) => token(context, "time_only", [value])),
    token(context, "unknown", []),
  ]);
}
