import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeInventoryWakeups,
  publishInventoryWakeups,
} from "../src/inventory-continuations.ts";
import { planInventoryRun } from "../src/inventory-run-plans.ts";
import {
  InventoryRunner,
  type InventoryRunWakeup,
} from "../src/inventory-runner.ts";
import { inventoryRunnerFixture } from "./inventory-runner-fixtures.ts";

function queue() {
  const sent: MessageSendRequest<InventoryRunWakeup>[] = [];
  let fail = false;
  const binding: Pick<Queue<InventoryRunWakeup>, "sendBatch"> = {
    async sendBatch(messages) {
      sent.push(...structuredClone(Array.from(messages)));
      if (fail) throw new Error("lost queue send acknowledgement");
      return {
        metadata: { metrics: { backlogCount: sent.length, backlogBytes: 0 } },
      };
    },
  };
  return {
    sent,
    binding,
    set fail(value: boolean) {
      fail = value;
    },
  };
}
function message(body: unknown) {
  const outcomes: ("ack" | number)[] = [];
  const item: Message<unknown> = {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    attempts: 1,
    body,
    ack() {
      outcomes.push("ack");
    },
    retry(options) {
      outcomes.push(options?.delaySeconds ?? 0);
    },
  };
  return { item, outcomes };
}
function response() {
  return Response.json({
    account: { uuid: "source" },
    operations: [],
    qsos: [],
    meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
  });
}

test("outbox batches are durable, contain only versioned identities and recover dropped delivery", async (t) => {
  const f = await inventoryRunnerFixture(t);
  await f.begin();
  const q = queue();
  assert.equal(await publishInventoryWakeups(f.runs, q.binding), 1);
  assert.deepEqual(Object.keys(q.sent[0].body).sort(), [
    "run",
    "scope",
    "stream",
    "tenant",
    "version",
    "workVersion",
  ]);
  assert.equal(q.sent[0].delaySeconds, 0);
  assert.equal(await publishInventoryWakeups(f.runs, q.binding), 0);
  assert.equal(
    await publishInventoryWakeups(f.runs, q.binding, {
      now: Date.now() + 301_000,
    }),
    1,
  );
  assert.deepEqual(
    q.sent[0].body,
    q.sent[1].body,
    "cron recovers the same current work fence",
  );
});

test("a lost Queue send acknowledgement republishes the identical work without advancing inventory", async (t) => {
  const f = await inventoryRunnerFixture(t);
  const run = await f.begin();
  const q = queue();
  q.fail = true;
  await assert.rejects(
    publishInventoryWakeups(f.runs, q.binding),
    /lost queue send/,
  );
  assert.equal((await f.runs.pendingWakeups()).length, 1);
  q.fail = false;
  assert.equal(await publishInventoryWakeups(f.runs, q.binding), 1);
  assert.deepEqual(q.sent[0].body, q.sent[1].body);
  assert.equal((await f.runs.load("a", run.id))?.version, 1);
});

test("the consumer acknowledges a duplicate only after publishing the committed continuation", async (t) => {
  const f = await inventoryRunnerFixture(t);
  const run = await f.begin();
  let requests = 0;
  const runner = new InventoryRunner(f.runs, async () => {
    requests++;
    return response();
  });
  const q = queue();
  const body = await f.wakeup(run.id);
  const first = message(body);
  const duplicate = message(body);
  const invalid = message({ ...body, version: 7 });
  const report = await consumeInventoryWakeups(
    runner,
    { messages: [first.item, duplicate.item, invalid.item] },
    q.binding,
  );
  assert.equal(report.acknowledged, 3);
  assert.equal(report.invalid, 1);
  assert.equal(report.processed, 2);
  assert.equal(report.failed, 0);
  assert.equal(requests, 1);
  assert.equal(q.sent.length, 1);
  assert.equal(q.sent[0].body.workVersion, body.workVersion + 1);
  assert.ok(q.sent[0].delaySeconds && q.sent[0].delaySeconds >= 19);
  assert.deepEqual(first.outcomes, ["ack"]);
  assert.deepEqual(duplicate.outcomes, ["ack"]);
});

test("publication failure after page commit retries the old message without repeating the vendor read", async (t) => {
  const f = await inventoryRunnerFixture(t);
  const run = await f.begin();
  let requests = 0;
  const runner = new InventoryRunner(f.runs, async () => {
    requests++;
    return response();
  });
  const q = queue();
  const body = await f.wakeup(run.id);
  const first = message(body);
  q.fail = true;
  const failed = await consumeInventoryWakeups(
    runner,
    { messages: [first.item] },
    q.binding,
  );
  assert.equal(failed.failed, 1);
  assert.deepEqual(first.outcomes, [60]);
  assert.equal((await f.runs.load("a", run.id))?.phase, "catchup");
  assert.equal((await f.runs.pendingWakeups()).length, 1);
  q.fail = false;
  const retry = message(body);
  const recovered = await consumeInventoryWakeups(
    runner,
    { messages: [retry.item] },
    q.binding,
  );
  assert.equal(recovered.failed, 0);
  assert.deepEqual(retry.outcomes, ["ack"]);
  assert.equal(requests, 1);
});

test("early delivery and turn limits retry messages without consuming vendor capacity", async (t) => {
  const f = await inventoryRunnerFixture(t);
  const run = await f.begin();
  const runner = new InventoryRunner(f.runs, async () => response());
  await runner.step(await f.wakeup(run.id));
  const q = queue();
  const first = message(await f.wakeup(run.id));
  const second = message(await f.wakeup(run.id));
  const report = await consumeInventoryWakeups(
    runner,
    { messages: [first.item, second.item] },
    q.binding,
    { maxTurns: 1 },
  );
  assert.equal(report.retried, 2);
  assert.equal(report.processed, 1);
  assert.ok(typeof first.outcomes[0] === "number" && first.outcomes[0] >= 19);
  assert.deepEqual(second.outcomes, [1]);
  assert.equal(
    (
      await f.db
        .prepare("SELECT requests FROM vendor_requests WHERE vendor='lofi'")
        .first<{ requests: number }>()
    )?.requests,
    1,
  );
});

test("completed runs start incremental work under the current job fence and reject old run selection", async (t) => {
  const f = await inventoryRunnerFixture(t);
  const first = await f.begin();
  let requests = 0;
  const runner = new InventoryRunner(f.runs, async () => {
    requests++;
    return response();
  });
  await runner.step(await f.wakeup(first.id));
  await runner.step(await f.due(first.id));
  await f.finish(runner, first.id);
  const wakeup = await f.due(first.id);
  const next = await runner.step(wakeup);
  assert.equal(next.kind, "started");
  if (next.kind !== "started") assert.fail();
  assert.equal(requests, 2, "starting the new run performs no HTTP");
  assert.equal((await f.runs.load("a", next.run))?.mode, "delta");
  assert.deepEqual(await runner.step(wakeup), {
    kind: "skipped",
    reason: "stale",
  });
  await runner.step(await f.wakeup(next.run));
  await f.finish(runner, next.run);
  assert.equal(requests, 3);
  const current = await f.due(next.run);
  assert.deepEqual(await runner.step({ ...current, run: first.id }), {
    kind: "skipped",
    reason: "stale",
  });
});

test("begin revalidates the captured idle job fence natively", async (t) => {
  const f = await inventoryRunnerFixture(t);
  const stream = await f.inventory.snapshot("a", f.scope, "scan");
  assert.ok(stream);
  const lease = await f.store.claim("a", `inventory:${f.scope}`);
  assert.ok(lease);
  const definition = await planInventoryRun(stream, f.plan);
  await assert.rejects(
    f.runs.begin({ stream, lease, definition, expectedJobVersion: 1 }),
    /inventory run changed/,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS n FROM inventory_runs")
        .first<{ n: number }>()
    )?.n,
    0,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS n FROM ingestion_pages")
        .first<{ n: number }>()
    )?.n,
    0,
  );
});
