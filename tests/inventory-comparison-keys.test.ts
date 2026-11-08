import assert from "node:assert/strict";
import test from "node:test";
import type { AdifRecord } from "../src/adif.ts";
import {
  historicalCandidateKeys,
  historicalCandidates,
} from "../src/historical-matching.ts";
import {
  importInventoryComparisonKey,
  inventoryComparisonLookup,
  inventoryComparisonToken,
} from "../src/inventory-comparison-keys.ts";

const secret = Buffer.alloc(32, 7).toString("base64url");
const context = async (tenant = "tenant", generation = "generation-1") => ({
  ...(await importInventoryComparisonKey(tenant, secret)),
  generation,
});
function record(
  at: number,
  precision: "minute" | "second" = "second",
): AdifRecord {
  const iso = new Date(at).toISOString();
  return {
    CALL: "W1AW",
    STATION_CALLSIGN: "N1RWJ",
    BAND: "20m",
    MODE: "CW",
    QSO_DATE: iso.slice(0, 10).replaceAll("-", ""),
    TIME_ON: iso
      .slice(11, precision === "minute" ? 16 : 19)
      .replaceAll(":", ""),
  };
}
const identity = (value: { keyClass: string; hash: string }) =>
  `${value.keyClass}:${value.hash}`;

test("comparison keys are private, tenant/generation separated and nonexportable", async () => {
  const a = await context();
  const b = await context("other");
  const c = await context("tenant", "generation-2");
  const row = record(Date.parse("2026-12-31T23:59:59Z"));
  const token = await inventoryComparisonToken(a, row);
  assert.equal(token.keyClass, "call_and_time");
  assert.match(token.hash, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(token).includes(row.CALL), false);
  assert.equal(JSON.stringify(token).includes(row.QSO_DATE), false);
  assert.notDeepEqual(await inventoryComparisonToken(b, row), token);
  assert.notDeepEqual(await inventoryComparisonToken(c, row), token);
  assert.deepEqual(await inventoryComparisonToken(await context(), row), token);
  await assert.rejects(crypto.subtle.exportKey("raw", a.key));
  await assert.rejects(
    importInventoryComparisonKey("tenant", secret.slice(1)),
    /comparison_key/,
  );
  const otherAlgorithm = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  await assert.rejects(
    inventoryComparisonToken({ ...a, key: otherAlgorithm }, row),
    /comparison_key/,
  );
});

test("every relevant partial-key class participates in a complete lookup", async () => {
  const key = await context();
  const complete = record(Date.parse("2026-11-08T12:30:00Z"));
  const lookup = new Set(
    (await inventoryComparisonLookup(key, complete)).map(identity),
  );
  assert.equal(lookup.size, 8);
  for (const row of [
    complete,
    { ...complete, TIME_ON: "invalid" },
    { ...complete, CALL: "invalid" },
    { ...complete, TIME_ON: "invalid", CALL: "invalid" },
  ])
    assert.ok(lookup.has(identity(await inventoryComparisonToken(key, row))));
  const spaced = { ...complete, CALL: " W1AW" };
  assert.equal(
    (await inventoryComparisonToken(key, spaced)).keyClass,
    "time_only",
    "normalization agrees with strict matcher validity",
  );
  assert.equal(historicalCandidateKeys(spaced).workedCall, undefined);
  assert.ok(lookup.has(identity(await inventoryComparisonToken(key, spaced))));
  assert.ok(
    !lookup.has(
      identity(
        await inventoryComparisonToken(key, {
          ...complete,
          CALL: "K1ABC",
          TIME_ON: "invalid",
        }),
      ),
    ),
  );
  await assert.rejects(
    inventoryComparisonLookup(key, { ...complete, TIME_ON: "invalid" }),
    /input_incomplete/,
  );
});

test("one stored half-hour bucket preserves every candidate accepted by the precision-aware matcher", async () => {
  const key = await context();
  let candidates = 0,
    issues = 0,
    pairs = 0;
  const origins = [
    "1930-01-01T00:00:00Z",
    "1969-12-31T23:30:00Z",
    "2024-02-29T23:30:00Z",
    "2026-12-31T23:30:00Z",
  ].map(Date.parse);
  const cache = new Map<string, Set<string>>();
  for (const origin of origins)
    for (const offset of [0, 1, 59, 60, 1799, 1800, 1801, 3599])
      for (const localPrecision of ["second", "minute"] as const) {
        const source = record(origin + offset * 1000, localPrecision);
        const cacheKey = JSON.stringify(source);
        let lookup = cache.get(cacheKey);
        if (!lookup) {
          lookup = new Set(
            (await inventoryComparisonLookup(key, source)).map(identity),
          );
          cache.set(cacheKey, lookup);
        }
        for (const gap of [
          -1860, -1801, -1800, -1799, 0, 1799, 1800, 1801, 1859,
        ])
          for (const remotePrecision of ["second", "minute"] as const) {
            const remote = record(
              origin + (offset + gap) * 1000,
              remotePrecision,
            );
            pairs++;
            const result = historicalCandidates("qrz", source, [remote]);
            // The earliest generated 1929 rows are invalid time, so their partial
            // tokens must remain discoverable as holds when the matcher sees them.
            if (
              result.candidates.length ||
              result.issues.some((issue) => issue.side === "remote")
            ) {
              if (result.candidates.length) candidates++;
              else issues++;
              assert.ok(
                lookup.has(
                  identity(await inventoryComparisonToken(key, remote)),
                ),
                JSON.stringify({ source, remote, result: result.state }),
              );
            }
          }
      }
  assert.equal(pairs, 1152);
  assert.ok(candidates > 500);
  assert.ok(issues > 0);
});

test("bucket neighbors remain a coarse prefilter and never replace precise matching", async () => {
  const key = await context();
  const source = record(Date.parse("2026-11-08T12:00:00Z"));
  const remote = record(Date.parse("2026-11-08T12:31:00Z"));
  const lookup = new Set(
    (await inventoryComparisonLookup(key, source)).map(identity),
  );
  assert.ok(lookup.has(identity(await inventoryComparisonToken(key, remote))));
  assert.equal(historicalCandidates("qrz", source, [remote]).state, "none");
});

test("async signing captures the generation and normalized record before yielding", async () => {
  const key = await context();
  const row = record(Date.parse("2026-11-08T12:00:00Z"));
  const expected = await inventoryComparisonLookup(key, row);
  const pending = inventoryComparisonLookup(key, row);
  key.generation = "mutated";
  key.tenant = "mutated";
  row.CALL = "K1ABC";
  assert.deepEqual(await pending, expected);
});
