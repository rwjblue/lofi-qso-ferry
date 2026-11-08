import assert from "node:assert/strict";
import test from "node:test";
import { activateInventoryRuntime } from "../src/inventory-runtime.ts";
import { InventoryComparisonWakeups } from "../src/inventory-comparison-wakeups.ts";
import { Store } from "../src/store.ts";
import { comparisonWakeupsFixture } from "./inventory-comparison-wakeups-fixtures.ts";

test("comparison publication is paused in legacy mode and lost messages become recoverable", async () => {
  const f = await comparisonWakeupsFixture();
  try {
    assert.deepEqual(await f.wakeups.pending(), []);
    const source = await f.inventory.snapshot("a", "source", "sync"),
      credential = await f.store.private("a", "source", "v1", "credential");
    await activateInventoryRuntime(f.store);
    const rows = await f.wakeups.pending();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].runtime_version, 1);
    assert.equal(await f.wakeups.markPublished(rows), 1);
    assert.deepEqual(await f.wakeups.pending(), []);
    const recovered = await f.wakeups.pending({ now: Date.now() + 300001 });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].version, rows[0].version);
    assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), source);
    assert.deepEqual(
      await f.store.private("a", "source", "v1", "credential"),
      credential,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("a stale publication acknowledgement cannot hide a newer comparison wakeup", async () => {
  const f = await comparisonWakeupsFixture();
  try {
    await activateInventoryRuntime(f.store);
    const before = await f.wakeups.pending();
    await f.work.enqueue("a", f.generation, "destination", f.selected);
    assert.equal(await f.wakeups.markPublished(before), 0);
    const next = await f.wakeups.pending();
    assert.equal(next.length, 1);
    assert.equal(next[0].version, before[0].version + 1);
    assert.equal(next[0].published_at, 0);
    assert.deepEqual(
      await f.db
        .prepare("SELECT count(*) AS n FROM inventory_comparison_wakeups")
        .first(),
      { n: 1 },
    );
  } finally {
    await f.mf.dispose();
  }
});

test("parked comparison deadlines survive Queue publication without premature recovery", async () => {
  const f = await comparisonWakeupsFixture();
  try {
    const lease = await f.store.claim(
      "a",
      "inventory-comparison",
      Date.now(),
      60000,
    );
    assert.ok(lease);
    const deadline = Date.now() + 600000;
    await f.db
      .prepare(
        "UPDATE inventory_comparison_coordinators SET version=version+1,observed_version=work_version,idle_turns=phase_count,next_due_at=? WHERE tenant='a'",
      )
      .bind(deadline)
      .run();
    await f.store.release(lease);
    await activateInventoryRuntime(f.store);
    const rows = await f.wakeups.pending();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].not_before, deadline);
    assert.equal(await f.wakeups.markPublished(rows), 1);
    assert.deepEqual(await f.wakeups.pending({ now: deadline - 1 }), []);
    assert.equal(
      (await f.wakeups.pending({ now: deadline + 300001 })).length,
      1,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("idle and locked accounts leave the pending indexes and a later wake retains the clock", async () => {
  const f = await comparisonWakeupsFixture();
  try {
    const lease = await f.store.claim(
      "a",
      "inventory-comparison",
      Date.now(),
      60000,
    );
    assert.ok(lease);
    await f.db
      .prepare(
        "UPDATE inventory_comparison_coordinators SET version=version+1,observed_version=work_version,idle_turns=phase_count WHERE tenant='a'",
      )
      .run();
    await f.store.release(lease);
    const parked = await f.db
      .prepare("SELECT version,not_before FROM inventory_comparison_wakeups")
      .first<{ version: number; not_before: null }>();
    assert.ok(parked);
    assert.equal(parked.not_before, null);
    await activateInventoryRuntime(f.store);
    assert.deepEqual(await f.wakeups.pending(), []);
    await f.work.enqueue("a", f.generation, "destination", f.selected);
    const awakened = await f.wakeups.pending();
    assert.equal(awakened.length, 1);
    assert.ok(awakened[0].version > parked.version);
    await f.db
      .prepare("UPDATE accounts SET status='locked' WHERE id='a'")
      .run();
    assert.deepEqual(await f.wakeups.pending(), []);
    await f.db
      .prepare("UPDATE accounts SET status='active' WHERE id='a'")
      .run();
    const restored = await f.wakeups.pending();
    assert.equal(restored.length, 1);
    assert.ok(restored[0].version > awakened[0].version);
    await f.db
      .prepare("UPDATE connections SET status='disabled' WHERE tenant='a'")
      .run();
    assert.deepEqual(await f.wakeups.pending(), []);
  } finally {
    await f.mf.dispose();
  }
});

test("suppressed outbox writes roll back the comparison wake and its enqueued work", async () => {
  const f = await comparisonWakeupsFixture();
  try {
    const control = await f.db
      .prepare("SELECT * FROM inventory_comparison_coordinators")
      .first();
    const outbox = await f.db
      .prepare("SELECT * FROM inventory_comparison_wakeups")
      .first();
    await f.db
      .prepare(
        "CREATE TRIGGER suppress_comparison_outbox BEFORE UPDATE ON inventory_comparison_wakeups BEGIN SELECT RAISE(IGNORE); END;",
      )
      .run();
    await assert.rejects(
      f.work.enqueue("a", f.generation, "destination", f.selected),
      /wakeup missing/,
    );
    assert.deepEqual(
      await f.db
        .prepare("SELECT * FROM inventory_comparison_coordinators")
        .first(),
      control,
    );
    assert.deepEqual(
      await f.db.prepare("SELECT * FROM inventory_comparison_wakeups").first(),
      outbox,
    );
    assert.deepEqual(
      await f.db.prepare("SELECT count(*) AS n FROM matching_work").first(),
      { n: 0 },
    );
  } finally {
    await f.mf.dispose();
  }
});

test("native outbox guards reject forged frames, publication and clock erasure", async () => {
  const f = await comparisonWakeupsFixture();
  try {
    for (const sql of [
      "UPDATE inventory_comparison_wakeups SET version=version+2",
      "UPDATE inventory_comparison_wakeups SET published_at=1",
      "UPDATE inventory_comparison_wakeups SET control_version=control_version+1",
      "UPDATE inventory_comparison_wakeups SET version=version+1",
      "DELETE FROM inventory_comparison_wakeups",
    ])
      await assert.rejects(f.db.prepare(sql).run(), /comparison wakeup/);
  } finally {
    await f.mf.dispose();
  }
});

test("five thousand parked accounts cannot turn pending comparison selection into a history scan", async (t) => {
  const f = await comparisonWakeupsFixture();
  try {
    await activateInventoryRuntime(f.store);
    let reads = 0;
    const store = new Store(f.db, f.store.keys),
      statement = store.statement.bind(store);
    store.statement = (sql, ...parameters) =>
      new Proxy(statement(sql, ...parameters), {
        get(target, property) {
          if (property === "all")
            return async () => {
              const result = await target.all();
              reads += result.meta.rows_read;
              return result;
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const wakeups = new InventoryComparisonWakeups(store);
    await wakeups.pending();
    reads = 0;
    assert.equal((await wakeups.pending()).length, 1);
    const before = reads;
    const tenants = Array.from({ length: 5000 }, (_, i) => `parked-${i}`);
    await f.db
      .prepare(
        "INSERT INTO accounts(id,email,user_handle,verified_at,status) SELECT value,value||'@example.test',value,1,'locked' FROM json_each(?)",
      )
      .bind(JSON.stringify(tenants))
      .run();
    await f.db
      .prepare(
        "INSERT INTO inventory_comparison_coordinators(tenant) SELECT value FROM json_each(?)",
      )
      .bind(JSON.stringify(tenants))
      .run();
    reads = 0;
    assert.equal((await wakeups.pending()).length, 1);
    t.diagnostic(
      `pending comparison selector with/without 5000 parked accounts: ${reads}/${before} reads`,
    );
    assert.ok(reads <= before + 8);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT count(*) AS n FROM inventory_comparison_wakeups WHERE not_before IS NULL",
        )
        .first(),
      { n: 5000 },
    );
  } finally {
    await f.mf.dispose();
  }
});

test("comparison wakeup arguments reject oversized batches and invalid recovery horizons", async () => {
  const f = await comparisonWakeupsFixture();
  try {
    for (const options of [
      { limit: 0 },
      { limit: 101 },
      { recoverAfterMs: 59999 },
      { now: Number.MAX_SAFE_INTEGER },
    ])
      await assert.rejects(
        f.wakeups.pending(options),
        /invalid_comparison_wakeup_selection/,
      );
    await activateInventoryRuntime(f.store);
    const rows = await f.wakeups.pending();
    await assert.rejects(
      f.wakeups.markPublished(Array.from({ length: 101 }, () => rows[0])),
      /invalid_comparison_wakeup_publication/,
    );
    assert.equal((await f.wakeups.pending()).length, 1);
  } finally {
    await f.mf.dispose();
  }
});
