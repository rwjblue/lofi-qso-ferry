import assert from "node:assert/strict";
import test from "node:test";
import { InventoryMatchingResults } from "../src/inventory-matching-results.ts";
import { Store } from "../src/store.ts";
import { applyMigration } from "./helpers.ts";
import { matchingFixture } from "./inventory-matching-fixtures.ts";

test("a result update cannot borrow the guard of another admitted preparation", async () => {
  const f = await matchingFixture();
  try {
    await applyMigration(f.db, "0064_inventory_matching_result_update.sql");
    const lease = await f.store.claim(
      "a",
      "matching:destination",
      Date.now(),
      60000,
    );
    assert.ok(lease);
    const selected = [{ scope: "source", key: "q0" }];
    const matches = new InventoryMatchingResults(f.store);
    await matches.publish(
      await f.workspace.prepare("a", "destination", selected),
      lease,
      "original",
    );
    const before = await f.db.prepare("SELECT * FROM match_results").first();
    const pending = await f.workspace.prepare("a", "destination", selected);
    const store = new Store(
      new Proxy(f.db, {
        get(target, property) {
          if (property === "batch")
            return async (plan: D1PreparedStatement[]) => {
              // Persist only admission to model a separate, interrupted publisher.
              await f.db.batch(plan.slice(0, -2));
              throw new Error("admitted preparation only");
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
      f.store.keys,
    );
    await assert.rejects(
      new InventoryMatchingResults(store).publish(pending, lease, "pending"),
      /admitted preparation only/,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM inventory_match_guards WHERE set_id='pending'",
          )
          .first<{ n: number }>()
      )?.n,
      1,
    );
    await assert.rejects(
      f.db
        .prepare(
          "UPDATE match_results SET version=version+1,derived_at=? WHERE tenant='a' AND set_id='original'",
        )
        .bind(pending.preparedAt)
        .run(),
      /result version changed/,
    );
    assert.deepEqual(
      await f.db.prepare("SELECT * FROM match_results").first(),
      before,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("exact-set result updates stay within a fixed read budget with 500 superseded proofs", async (t) => {
  const f = await matchingFixture();
  try {
    await applyMigration(f.db, "0064_inventory_matching_result_update.sql");
    const lease = await f.store.claim(
      "a",
      "matching:destination",
      Date.now(),
      60000,
    );
    assert.ok(lease);
    const selected = [{ scope: "source", key: "q0" }];
    const matches = new InventoryMatchingResults(f.store);
    const reads: number[] = [];
    for (let i = 0; i <= 500; i++) {
      if (i > 0 && i % 25 === 0) {
        await f.store.release(lease);
        const current = await f.store.claim(
          "a",
          "matching:destination",
          Date.now(),
          60000,
        );
        assert.ok(current);
        Object.assign(lease, current);
      }
      const result = await matches.publish(
        await f.workspace.prepare("a", "destination", selected),
        lease,
      );
      if (i === 0) continue;
      reads.push(result.rowsRead);
      // Successful native paths vary by 31 reads even without history growth.
      // A fixed budget at every size catches scans without comparing one low
      // sample with one high sample. Extend past the old 100-proof sample.
      assert.ok(
        result.rowsRead <= 550,
        `publication ${i}: ${result.rowsRead} reads`,
      );
      assert.equal(result.rowsWritten, 64);
    }
    const count = await f.db
      .prepare(
        "SELECT count(*) AS n FROM inventory_match_sets WHERE state='committed'",
      )
      .first<{ n: number }>();
    assert.equal(count?.n, 501);
    t.diagnostic(
      `ready result replacement across 500 old sets: ${Math.min(...reads)}–${Math.max(...reads)} reads per publication, 64 writes`,
    );
  } finally {
    await f.mf.dispose();
  }
});
