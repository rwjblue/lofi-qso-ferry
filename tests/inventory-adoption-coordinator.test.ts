import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { InventoryComparisonCoordinator } from "../src/inventory-comparison-coordinator.ts";
import { InventoryOwnership } from "../src/inventory-ownership.ts";
import { applyMigration, database } from "./helpers.ts";
import { installMatchingCoordinator } from "./inventory-matching-coordinator-fixtures.ts";
import { receipt, sourceContact } from "./inventory-matching-fixtures.ts";
import { matchingWorkFixture } from "./inventory-matching-work-fixtures.ts";

async function fixture(count: number) {
  const base = await database();
  try {
    for (const name of (
      await readdir(new URL("../migrations/", import.meta.url))
    )
      .filter(
        (name) =>
          name.endsWith(".sql") &&
          name > "0001_foundation.sql" &&
          name < "0039_",
      )
      .sort())
      await applyMigration(base.db, name);
    const f = await matchingWorkFixture(
      {
        sources: Array.from({ length: count }, (_, i) =>
          sourceContact(`q${i}`, "13:00:00", `W${i}AW`),
        ),
        receipts: Array.from({ length: count }, (_, i) =>
          receipt(String(i), "130000", `W${i}AW`),
        ),
      },
      base,
    );
    await applyMigration(f.db, "0042_inventory_runtime.sql");
    await installMatchingCoordinator(f.db, 72);
    await applyMigration(f.db, "0073_inventory_comparison_wakeups.sql");
    await applyMigration(f.db, "0078_inventory_adoption_work.sql");
    return f;
  } catch (error) {
    await base.mf.dispose();
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const coordinatorMigration = "0079_inventory_adoption_coordinator.sql";
async function atMatchingSlot(f: Fixture, idleTurns = 0) {
  const lease = await f.store.claim(
    "a",
    "inventory-comparison",
    Date.now(),
    60000,
  );
  assert.ok(lease);
  try {
    await f.db
      .prepare(
        "UPDATE inventory_comparison_coordinators SET version=version+1,observed_version=work_version,phase=9,idle_turns=? WHERE tenant='a'",
      )
      .bind(idleTurns)
      .run();
  } finally {
    await f.store.release(lease);
  }
  return new InventoryComparisonCoordinator(f.store).step("a");
}
async function debt(f: Fixture) {
  return f.db
    .prepare(
      "SELECT (SELECT count(*) FROM matching_work WHERE completed_version<work_version) AS matching,(SELECT count(*) FROM inventory_adoption_work) AS adoption,(SELECT count(*) FROM inventory_historical_associations) AS historical,(SELECT count(*) FROM attempts) AS attempts",
    )
    .first();
}

test("durable turns alternate matching and adoption while both queues remain busy", async () => {
  const f = await fixture(41);
  try {
    await f.matches.match("a", "destination", f.selected.slice(0, 20));
    const control = () =>
      f.db
        .prepare(
          "SELECT * FROM inventory_comparison_coordinators WHERE tenant='a'",
        )
        .first<{ work_version: number }>();
    const before = await control();
    assert.ok(before);
    await applyMigration(f.db, coordinatorMigration);
    assert.deepEqual(await control(), {
      ...before,
      work_version: before.work_version + 1,
      match_activity: 0,
    });
    await f.work.enqueue(
      "a",
      f.generation,
      "destination",
      f.selected.slice(20),
    );
    const first = await atMatchingSlot(f);
    assert.ok(
      "activity" in first && first.activity === "match" && first.records === 20,
    );
    assert.deepEqual(await debt(f), {
      matching: 1,
      adoption: 40,
      historical: 0,
      attempts: 0,
    });
    const second = await atMatchingSlot(f);
    assert.ok(
      "activity" in second &&
        second.activity === "adopt" &&
        second.records === 20,
    );
    assert.deepEqual(await debt(f), {
      matching: 1,
      adoption: 20,
      historical: 20,
      attempts: 0,
    });
    const third = await atMatchingSlot(f);
    assert.ok(
      "activity" in third && third.activity === "match" && third.records === 1,
    );
    assert.deepEqual(await debt(f), {
      matching: 0,
      adoption: 21,
      historical: 20,
      attempts: 0,
    });
    const lease = await f.store.claim(
      "a",
      "inventory-comparison",
      Date.now(),
      60000,
    );
    assert.ok(lease);
    try {
      await assert.rejects(
        f.db
          .prepare(
            "UPDATE inventory_comparison_coordinators SET version=version+1,observed_version=work_version,match_activity=1-match_activity WHERE tenant='a'",
          )
          .run(),
        /match activity out of turn/,
      );
    } finally {
      await f.store.release(lease);
    }
  } finally {
    await f.mf.dispose();
  }
});

test("both activities retain the earliest live retry deadline in the hosted outbox", async () => {
  const f = await fixture(3);
  try {
    await f.matches.match("a", "destination", f.selected);
    await new InventoryOwnership(f.store).hold(
      "a",
      "qrz",
      "uncertain",
      "unresolved_delivery",
    );
    await applyMigration(f.db, coordinatorMigration);
    const held = await atMatchingSlot(f);
    assert.ok(
      "activity" in held && held.activity === "adopt" && "nextDueAt" in held,
    );
    const adoptionDue = held.nextDueAt;
    assert.ok(adoptionDue > Date.now());
    await f.work.enqueue(
      "a",
      f.generation,
      "destination",
      f.selected.slice(0, 1),
    );
    async function matchDue(at: number) {
      const lease = await f.store.claim(
        "a",
        "matching:destination",
        Date.now(),
        60000,
      );
      assert.ok(lease);
      try {
        await f.db
          .prepare(
            "UPDATE matching_work SET due_at=?,hold_reason='capacity' WHERE record_key='q0'",
          )
          .bind(at)
          .run();
      } finally {
        await f.store.release(lease);
      }
    }
    const wakeup = () =>
      f.db
        .prepare(
          "SELECT not_before FROM inventory_comparison_wakeups WHERE tenant='a'",
        )
        .first();
    await matchDue(adoptionDue + 60000);
    const later = await atMatchingSlot(f, 10);
    assert.ok(
      "nextDueAt" in later && later.nextDueAt === adoptionDue && !later.more,
    );
    assert.deepEqual(await wakeup(), { not_before: adoptionDue });
    await matchDue(adoptionDue - 60000);
    const earlier = await atMatchingSlot(f, 10);
    assert.ok(
      "nextDueAt" in earlier &&
        earlier.nextDueAt === adoptionDue - 60000 &&
        !earlier.more,
    );
    assert.deepEqual(await wakeup(), { not_before: adoptionDue - 60000 });
    assert.deepEqual(await debt(f), {
      matching: 1,
      adoption: 3,
      historical: 0,
      attempts: 0,
    });
  } finally {
    await f.mf.dispose();
  }
});
