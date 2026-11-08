import assert from "node:assert/strict";
import test from "node:test";
import { InventoryComparisonCoordinator } from "../src/inventory-comparison-coordinator.ts";
import { activateInventoryRuntime } from "../src/inventory-runtime.ts";
import { applyMigration } from "./helpers.ts";
import { comparisonWakeupsFixture } from "./inventory-comparison-wakeups-fixtures.ts";

test("read-only handoff admits comparison lease families while legacy sender and reader guards remain", async () => {
  const f = await comparisonWakeupsFixture();
  try {
    await applyMigration(f.db, "0074_inventory_comparison_runtime_leases.sql");
    await activateInventoryRuntime(f.store);
    for (const scope of [
      "inventory-comparison",
      "comparison:g:s",
      "projection:g:s",
      "matching:destination",
      "inventory-ownership:qrz",
      "inventory-ownership:lotw",
      '["projection-fanout","g","s","operation"]',
      '["projection-coverage","g","s"]',
      '["matching-pair","g","d","s"]',
      '["matching-bucket","g","s","call_only","hash"]',
      '["matching-coverage-event","s","stream","source","partition"]',
      '["matching-coverage-node","g","s","source",""]',
      '["matching-selected-record","g","s","source","q"]',
    ]) {
      const lease = await f.store.claim("a", scope, Date.now(), 60000);
      assert.ok(lease, scope);
      await f.store.release(lease);
      const renewed = await f.store.claim("a", scope, Date.now(), 60000);
      assert.ok(renewed, scope);
      await f.store.release(renewed);
    }
    for (const scope of [
      "cycle:source",
      "poll:source:sync",
      "book:destination",
      "lotw-ownership",
      "inventory-comparison:other",
      "inventory-ownership:unknown",
      '["matching-pair","g"]',
      '["unknown","g","d","s"]',
      '["matching-pair"',
      "null",
      "{}",
    ])
      await assert.rejects(f.store.claim("a", scope), /legacy reader retired/);
    for (const sql of [
      "INSERT INTO cursors VALUES('a','source','sync','{}',1,0)",
      "INSERT INTO stage_guards(id) VALUES('legacy')",
      "INSERT INTO attempts(tenant,id,source,qso,destination,generation,payload_id,payload_hash,credential_version,created_at,source_hash) VALUES('a','old','source','q','destination','g','p','h','v1',0,'h')",
    ])
      await assert.rejects(
        f.db.prepare(sql).run(),
        /legacy (reader|sender) retired/,
      );
    await f.db
      .prepare("UPDATE accounts SET status='locked' WHERE id='a'")
      .run();
    await assert.rejects(
      f.store.claim("a", "inventory-comparison"),
      /legacy reader retired/,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("the full comparison coordinator drains after native read-only runtime handoff", async () => {
  const f = await comparisonWakeupsFixture();
  try {
    await applyMigration(f.db, "0074_inventory_comparison_runtime_leases.sql");
    await activateInventoryRuntime(f.store);
    const source = await f.inventory.snapshot("a", "source", "sync"),
      credential = await f.store.private("a", "source", "v1", "credential");
    const coordinator = new InventoryComparisonCoordinator(f.store);
    let parked = false;
    for (let i = 0; i < 100; i++) {
      const result = await coordinator.step("a");
      assert.notEqual(result.kind, "deferred");
      if (!result.more) {
        parked = true;
        break;
      }
    }
    assert.ok(parked);
    assert.deepEqual(await f.wakeups.pending(), []);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT count(*) AS n FROM match_results_current WHERE state='absent_at_inventory'",
        )
        .first(),
      { n: 1 },
    );
    assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), source);
    assert.deepEqual(
      await f.store.private("a", "source", "v1", "credential"),
      credential,
    );
    assert.deepEqual(
      await f.db.prepare("SELECT count(*) AS n FROM attempts").first(),
      { n: 0 },
    );
  } finally {
    await f.mf.dispose();
  }
});
