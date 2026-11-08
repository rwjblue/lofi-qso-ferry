import type { InventoryComparisonKey } from "./inventory-comparison-keys.ts";
import { b64, canonical } from "./security.ts";

const DAY = 86400000;
const FIRST = Date.parse("0001-01-01T00:00:00Z");
const LEVELS = 23;
const encoder = new TextEncoder();

function ordinal(date: string) {
  if (
    typeof date !== "string" ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date) ||
    date < "0001-01-01" ||
    date > "9999-12-31"
  )
    throw new Error("invalid_inventory_coverage_date");
  const stamp = Date.parse(`${date}T00:00:00Z`);
  if (
    !Number.isFinite(stamp) ||
    new Date(stamp).toISOString().slice(0, 10) !== date
  )
    throw new Error("invalid_inventory_coverage_date");
  return (stamp - FIRST) / DAY;
}
function capture(context: InventoryComparisonKey, scope: string) {
  const algorithm = context.key?.algorithm as HmacKeyAlgorithm | undefined;
  if (
    typeof context.tenant !== "string" ||
    !context.tenant.length ||
    context.tenant.length > 128 ||
    typeof context.keyId !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(context.keyId) ||
    typeof scope !== "string" ||
    !scope.length ||
    scope.length > 512 ||
    algorithm?.name !== "HMAC" ||
    algorithm.hash.name !== "SHA-256" ||
    algorithm.length !== 256 ||
    context.key.extractable ||
    !context.key.usages.includes("sign")
  )
    throw new Error("invalid_inventory_coverage_key");
  return {
    tenant: context.tenant,
    keyId: context.keyId,
    key: context.key,
    scope,
  };
}
async function hash(
  context: ReturnType<typeof capture>,
  level: number,
  offset: number,
) {
  return b64(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        context.key,
        encoder.encode(
          canonical([
            "inventory-matching-coverage-v1",
            context.tenant,
            context.keyId,
            context.scope,
            level,
            offset,
          ]),
        ),
      ),
    ),
  );
}

/** A contact day retains its ancestors. Shared coordinates are signed once per
 * call; neither dates nor tree coordinates belong in persisted manifests. */
export async function inventoryCoverageDays(
  key: InventoryComparisonKey,
  scope: string,
  dates: readonly string[],
) {
  const context = capture(key, scope);
  if (dates.length > 40)
    throw new Error("inventory_coverage_day_split_required");
  const nodes = new Map<string, Promise<string>>();
  return Promise.all(
    [...new Set(dates)].map(async (date) => {
      const day = ordinal(date);
      const tags = await Promise.all(
        Array.from({ length: LEVELS }, (_, level) => {
          const offset = Math.floor(day / 2 ** level),
            id = `${level}:${offset}`;
          let tag = nodes.get(id);
          if (!tag) {
            tag = hash(context, level, offset);
            nodes.set(id, tag);
          }
          return tag;
        }),
      );
      return { date, tags };
    }),
  );
}

/** An inclusive range decomposes into at most 44 disjoint calendar prefixes,
 * even for the entire supported calendar. It never enumerates individual days. */
export async function inventoryCoverageRange(
  key: InventoryComparisonKey,
  scope: string,
  start: string,
  end: string,
) {
  const context = capture(key, scope);
  let first = ordinal(start);
  const last = ordinal(end);
  if (first > last) throw new Error("invalid_inventory_coverage_range");
  const nodes: Promise<string>[] = [];
  while (first <= last) {
    let level = 0;
    while (
      level < LEVELS - 1 &&
      first % 2 ** (level + 1) === 0 &&
      first + 2 ** (level + 1) - 1 <= last
    )
      level++;
    nodes.push(hash(context, level, Math.floor(first / 2 ** level)));
    first += 2 ** level;
  }
  return Promise.all(nodes);
}
