import assert from "node:assert/strict";
import test from "node:test";
import {
  importInventoryComparisonKey,
  inventoryComparisonToken,
} from "../src/inventory-comparison-keys.ts";
import {
  inventoryCoverageDays,
  inventoryCoverageRange,
} from "../src/inventory-coverage-keys.ts";

const secret = Buffer.alloc(32, 7).toString("base64url");
test("calendar point and range hashes intersect exactly for included UTC days", async () => {
  const key = await importInventoryComparisonKey("a", secret);
  const dates = Array.from({ length: 40 }, (_, i) =>
    new Date(Date.UTC(2026, 10, i + 1)).toISOString().slice(0, 10),
  );
  const points = await inventoryCoverageDays(key, "scope", dates);
  for (const [start, end] of [
    ["2026-11-08", "2026-11-08"],
    ["2026-11-04", "2026-11-20"],
    ["2026-10-01", "2026-12-01"],
    ["2026-11-30", "2026-12-03"],
  ]) {
    const range = new Set(
      await inventoryCoverageRange(key, "scope", start, end),
    );
    for (const point of points)
      assert.equal(
        point.tags.filter((tag) => range.has(tag)).length,
        point.date >= start && point.date <= end ? 1 : 0,
      );
  }
  assert.ok(
    points.every(
      (point) =>
        point.tags.length === 23 &&
        new Set(point.tags).size === 23 &&
        point.tags.every((tag) => /^[A-Za-z0-9_-]{43}$/.test(tag)),
    ),
  );
});

test("wide and boundary ranges remain bounded without enumerating a log lifetime", async () => {
  const key = await importInventoryComparisonKey("a", secret);
  for (const [start, end] of [
    ["0001-01-01", "9999-12-31"],
    ["0001-01-02", "9999-12-30"],
    ["1929-12-31", "2099-12-31"],
    ["2000-02-28", "2000-03-01"],
    ["9999-12-31", "9999-12-31"],
  ]) {
    const range = new Set(
      await inventoryCoverageRange(key, "scope", start, end),
    );
    assert.ok(range.size > 0 && range.size <= 44);
    for (const point of await inventoryCoverageDays(key, "scope", [start, end]))
      assert.equal(point.tags.filter((tag) => range.has(tag)).length, 1);
  }
});

test("calendar hashes separate tenants, logical scopes and comparison namespaces", async () => {
  const a = await importInventoryComparisonKey("a", secret),
    b = await importInventoryComparisonKey("b", secret);
  const [point] = await inventoryCoverageDays(a, "scope", ["2026-11-08"]);
  for (const range of [
    await inventoryCoverageRange(b, "scope", "2026-11-08", "2026-11-08"),
    await inventoryCoverageRange(a, "other", "2026-11-08", "2026-11-08"),
  ])
    assert.ok(range.every((tag) => !point.tags.includes(tag)));
  const comparison = await inventoryComparisonToken(
    { ...a, generation: "g" },
    { QSO_DATE: "20261108", TIME_ON: "1300", CALL: "W1AW" },
  );
  assert.ok(!point.tags.includes(comparison.hash));
  assert.deepEqual(
    await inventoryCoverageDays(a, "scope", ["2026-11-08", "2026-11-08"]),
    [point],
  );
});

test("invalid and normalized calendar dates cannot silently select a different range", async () => {
  const key = await importInventoryComparisonKey("a", secret);
  for (const date of [
    "0000-01-01",
    "10000-01-01",
    "2026-02-29",
    "2026-02-30",
    "2026-13-01",
    "2026-1-01",
    "garbage",
  ]) {
    await assert.rejects(
      inventoryCoverageDays(key, "scope", [date]),
      /invalid_inventory_coverage_date/,
    );
    await assert.rejects(
      inventoryCoverageRange(key, "scope", date, "9999-12-31"),
      /invalid_inventory_coverage_date/,
    );
  }
  await assert.rejects(
    inventoryCoverageRange(key, "scope", "2026-11-09", "2026-11-08"),
    /invalid_inventory_coverage_range/,
  );
  await assert.rejects(
    inventoryCoverageDays(
      key,
      "scope",
      Array.from({ length: 41 }, () => "2026-11-08"),
    ),
    /split_required/,
  );
});
