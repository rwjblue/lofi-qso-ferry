import assert from "node:assert/strict";
import test from "node:test";
import { InventoryComparisonCoordinator } from "../src/inventory-comparison-coordinator.ts";
import {
  consumeComparisonWakeups,
  publishComparisonWakeups,
  type ComparisonQueueMessage,
} from "../src/inventory-comparison-continuations.ts";
import { activateInventoryRuntime } from "../src/inventory-runtime.ts";
import { Store } from "../src/store.ts";
import { applyMigration } from "./helpers.ts";
import { comparisonWakeupsFixture } from "./inventory-comparison-wakeups-fixtures.ts";

async function fixture(activate = true) {
  const f = await comparisonWakeupsFixture();
  try {
    await applyMigration(f.db, "0074_inventory_comparison_runtime_leases.sql");
    if (activate) await activateInventoryRuntime(f.store);
    const sent: MessageSendRequest<ComparisonQueueMessage>[] = [];
    const trace: string[] = [];
    const queue: Pick<Queue<ComparisonQueueMessage>, "sendBatch"> = {
      async sendBatch(messages) {
        trace.push("send");
        sent.push(...structuredClone(Array.from(messages)));
        return {
          metadata: { metrics: { backlogCount: sent.length, backlogBytes: 0 } },
        };
      },
    };
    return { ...f, sent, trace, queue };
  } catch (error) {
    await f.mf.dispose();
    throw error;
  }
}
function batch(bodies: unknown[], trace: string[] = []) {
  const outcomes: (string | number)[][] = bodies.map(() => []);
  const messages: Message<unknown>[] = bodies.map((body, index) => ({
    id: String(index),
    timestamp: new Date(),
    attempts: 1,
    body,
    ack() {
      outcomes[index].push("ack");
      trace.push("ack");
    },
    retry(options) {
      outcomes[index].push(options?.delaySeconds ?? 0);
      trace.push("retry");
    },
  }));
  return { value: { messages }, outcomes };
}

test("comparison turns publish their continuation before acknowledging Queue delivery", async () => {
  const f = await fixture();
  try {
    assert.equal(await publishComparisonWakeups(f.store, f.queue), 1);
    const first = f.sent.shift()!;
    const delivery = batch([first.body], f.trace);
    const report = await consumeComparisonWakeups(
      f.store,
      delivery.value,
      f.queue,
    );
    assert.equal(report.processed, 1);
    assert.equal(report.acknowledged, 1);
    assert.equal(report.queued, 1);
    assert.deepEqual(f.trace, ["send", "send", "ack"]);
    assert.deepEqual(delivery.outcomes, [["ack"]]);
    assert.ok(f.sent[0].body.controlVersion > first.body.controlVersion);
    assert.deepEqual(Object.keys(f.sent[0].body).sort(), [
      "controlVersion",
      "kind",
      "runtimeVersion",
      "tenant",
      "version",
      "wakeupVersion",
      "workVersion",
    ]);
  } finally {
    await f.mf.dispose();
  }
});

test("Queue-driven comparison drains and repeated parked messages leave current state unchanged", async () => {
  const f = await fixture();
  try {
    const source = await f.inventory.snapshot("a", "source", "sync"),
      credential = await f.store.private("a", "source", "v1", "credential");
    await publishComparisonWakeups(f.store, f.queue);
    const original = structuredClone(f.sent[0].body);
    let turns = 0;
    while (f.sent.length) {
      assert.ok(turns++ < 150);
      const delivery = batch([f.sent.shift()!.body]);
      const report = await consumeComparisonWakeups(
        f.store,
        delivery.value,
        f.queue,
      );
      assert.equal(report.failed, 0);
      assert.deepEqual(delivery.outcomes, [["ack"]]);
    }
    assert.ok(turns < 20, `single-contact drain took ${turns} Queue messages`);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT count(*) AS n FROM match_results_current WHERE state='absent_at_inventory'",
        )
        .first(),
      { n: 1 },
    );
    const control = await f.db
      .prepare("SELECT * FROM inventory_comparison_coordinators")
      .first();
    const duplicate = batch([original]);
    await consumeComparisonWakeups(f.store, duplicate.value, f.queue);
    assert.deepEqual(duplicate.outcomes, [["ack"]]);
    assert.deepEqual(
      await f.db
        .prepare("SELECT * FROM inventory_comparison_coordinators")
        .first(),
      control,
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

test("an idle phase sweep preserves a work signal that arrives after it checked a phase", async () => {
  const f = await fixture();
  try {
    const coordinator = new InventoryComparisonCoordinator(f.store);
    for (let i = 0; ; i++) {
      assert.ok(i < 30);
      if (!(await coordinator.step("a")).more) break;
    }
    const lease = await f.store.claim(
      "a",
      "inventory-comparison",
      Date.now(),
      60_000,
    );
    assert.ok(lease);
    await f.db
      .prepare(
        "UPDATE inventory_comparison_coordinators SET version=version+1,phase=10,idle_turns=1 WHERE tenant='a'",
      )
      .run();
    await f.store.release(lease);

    const store = new Store(f.db, f.store.keys);
    const statement = store.statement.bind(store);
    let signaled = false;
    store.statement = (sql, ...params) => {
      const bound = statement(sql, ...params);
      if (
        !sql.startsWith(
          "SELECT b.generation_id,b.scope_id FROM comparison_domains",
        )
      )
        return bound;
      return new Proxy(bound, {
        get(target, property) {
          if (property === "first")
            return async () => {
              const row = await target.first();
              await f.db
                .prepare(
                  "UPDATE inventory_comparison_coordinators SET work_version=work_version+1 WHERE tenant='a'",
                )
                .run();
              signaled = true;
              return row;
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    const swept = await new InventoryComparisonCoordinator(store).step("a");
    assert.equal(signaled, true);
    assert.equal(swept.more, true);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT c.phase,c.idle_turns,c.observed_version=c.work_version AS caught_up,w.not_before IS NOT NULL AS scheduled FROM inventory_comparison_coordinators c JOIN inventory_comparison_wakeups w USING(tenant)",
        )
        .first(),
      { phase: 9, idle_turns: 0, caught_up: 1, scheduled: 1 },
    );
    const match = await coordinator.step("a");
    assert.equal(match.more, true);
    assert.equal("phase" in match && match.phase, "match");
    assert.equal((await coordinator.step("a")).more, false);
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT idle_turns,not_before FROM inventory_comparison_coordinators JOIN inventory_comparison_wakeups USING(tenant)",
        )
        .first(),
      { idle_turns: 11, not_before: null },
    );
  } finally {
    await f.mf.dispose();
  }
});

test("Queue publication failure retries the old message and leaves the advanced frame recoverable", async () => {
  const f = await fixture();
  try {
    await publishComparisonWakeups(f.store, f.queue);
    const delivery = batch([f.sent.shift()!.body]);
    const report = await consumeComparisonWakeups(f.store, delivery.value, {
      async sendBatch() {
        throw new Error("synthetic Queue outage");
      },
    });
    assert.deepEqual(delivery.outcomes, [[60]]);
    assert.equal(report.failed, 1);
    assert.equal(report.acknowledged, 0);
    const pending = await f.wakeups.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].published_at, 0);
    assert.equal(await publishComparisonWakeups(f.store, f.queue), 1);
  } finally {
    await f.mf.dispose();
  }
});

test("a new signal during Queue send cannot be hidden by the old send acknowledgement", async () => {
  const f = await fixture();
  try {
    assert.equal(
      await publishComparisonWakeups(f.store, {
        async sendBatch(messages) {
          await f.queue.sendBatch(messages);
          await f.work.enqueue("a", f.generation, "destination", f.selected);
          return {
            metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } },
          };
        },
      }),
      1,
    );
    const pending = await f.wakeups.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].published_at, 0);
    assert.ok(pending[0].version > f.sent[0].body.wakeupVersion);
    assert.equal(await publishComparisonWakeups(f.store, f.queue), 1);
  } finally {
    await f.mf.dispose();
  }
});

test("early comparison messages retain the parked deadline instead of running work", async () => {
  const f = await fixture(false);
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
    await publishComparisonWakeups(f.store, f.queue);
    assert.ok(f.sent[0].delaySeconds! >= 599);
    const before = await f.db
      .prepare("SELECT * FROM inventory_comparison_coordinators")
      .first();
    const delivery = batch([f.sent.shift()!.body]);
    const report = await consumeComparisonWakeups(
      f.store,
      delivery.value,
      f.queue,
    );
    assert.equal(report.retried, 1);
    assert.equal(report.acknowledged, 0);
    assert.ok(Number(delivery.outcomes[0][0]) >= 599);
    assert.deepEqual(
      await f.db
        .prepare("SELECT * FROM inventory_comparison_coordinators")
        .first(),
      before,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("comparison message batches enforce a bounded turn count and reject malformed envelopes", async () => {
  const f = await fixture();
  try {
    await publishComparisonWakeups(f.store, f.queue);
    const body = f.sent.shift()!.body;
    const delivery = batch([
      body,
      body,
      body,
      { ...body, runtimeVersion: 0 },
      { kind: "comparison", version: 2 },
    ]);
    const report = await consumeComparisonWakeups(
      f.store,
      delivery.value,
      f.queue,
      { maxTurns: 1 },
    );
    assert.deepEqual(delivery.outcomes, [["ack"], [1], [1], ["ack"], ["ack"]]);
    assert.equal(report.processed, 1);
    assert.equal(report.invalid, 2);
    assert.equal(report.retried, 2);
    await assert.rejects(
      consumeComparisonWakeups(f.store, batch([]).value, f.queue, {
        maxTurns: 0,
      }),
      /invalid_comparison_queue_turn_limit/,
    );
  } finally {
    await f.mf.dispose();
  }
});

test("lost published comparison messages are republished by the recovery horizon", async () => {
  const f = await fixture();
  try {
    await publishComparisonWakeups(f.store, f.queue);
    assert.equal(await publishComparisonWakeups(f.store, f.queue), 0);
    assert.equal(
      await publishComparisonWakeups(f.store, f.queue, {
        now: Date.now() + 300001,
      }),
      1,
    );
    assert.deepEqual(f.sent[0].body, f.sent[1].body);
  } finally {
    await f.mf.dispose();
  }
});
