import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { resumeHeldLotwAccount } from "../scripts/inventory-fresh-start-rebuild.ts";
import { serializeAdifRecord } from "../src/adif.ts";
import { isComparisonMessage } from "../src/inventory-comparison-continuations.ts";
import {
  runHostedInventoryQueue,
  runHostedScheduled,
} from "../src/inventory-hosted.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import {
  lofiPollSlot,
  lofiRecurringDueAt,
} from "../src/inventory-lofi-schedule.ts";
import { runLotwConfirmationSchedule } from "../src/inventory-lotw-confirmation-schedule.ts";
import { pollInventoryLotwConfirmations } from "../src/inventory-lotw-confirmations.ts";
import { lotwRecurringDueAt } from "../src/inventory-lotw-schedule.ts";
import {
  inventoryRunQuery,
  planInventoryRun,
} from "../src/inventory-run-plans.ts";
import {
  InventoryRunner,
  type InventoryRunWakeup,
} from "../src/inventory-runner.ts";
import { InventoryRuns } from "../src/inventory-runs.ts";
import {
  activateInventoryRuntime,
  bindInventoryScopeRuntime,
  inventoryRuntime,
} from "../src/inventory-runtime.ts";
import {
  lotwInventorySelections,
  registerInventorySelection,
  registerKnownInventoryConnections,
  registerLotwAccountFeeds,
  registerSourceCalendarSelections,
  restoreLotwDatedPolls,
  startInventorySelections,
} from "../src/inventory-scheduler.ts";
import { isSourceProofWakeup } from "../src/inventory-source-proof-wakeups.ts";
import { inventoryVendorFetch } from "../src/inventory-vendor-admission.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";
import { applyMigration, database, seed } from "./helpers.ts";
import {
  applyAdditionalMigrations,
  fixtureEnvironment,
} from "./runtime-fixtures.ts";

const book = {
  bookId: "7",
  stationCallsign: "N1RWJ",
  startDate: "2025-01-01",
  endDate: "2027-12-31",
};
async function fixture(t: TestContext) {
  const f = await database();
  t.after(() => f.mf.dispose());
  await applyAdditionalMigrations(f.db);
  await seed(f.store);
  await f.store
    .statement(
      "UPDATE connections SET config=? WHERE id='source'",
      JSON.stringify({ accountId: "source" }),
    )
    .run();
  await f.store
    .statement(
      "UPDATE connections SET config=? WHERE id='destination'",
      JSON.stringify(book),
    )
    .run();
  for (const [connection, value] of [
    [
      "source",
      {
        key: "browser:fixture",
        secret: "fixture-secret",
        token: "fixture-token",
      },
    ],
    ["destination", { apiKey: "fixture-key" }],
  ] as const) {
    await f.store
      .statement("DELETE FROM private_data WHERE connection=?", connection)
      .run();
    await (
      await f.store.putPrivate("a", connection, "v1", "credential", value)
    ).run();
  }
  const sent: MessageSendRequest<unknown>[] = [];
  const queue: Queue<unknown> = {
    async send(body, options) {
      sent.push({ body, ...options });
      return {
        metadata: { metrics: { backlogCount: sent.length, backlogBytes: 0 } },
      };
    },
    async sendBatch(messages) {
      sent.push(...structuredClone(Array.from(messages)));
      return {
        metadata: { metrics: { backlogCount: sent.length, backlogBytes: 0 } },
      };
    },
    async metrics() {
      return { backlogCount: sent.length, backlogBytes: 0 };
    },
  };
  const env = {
    ...fixtureEnvironment(f.db),
    INVENTORY_RUNTIME_MODE: "read_only",
    INVENTORY_QUEUE: queue,
  };
  async function due(runId: string, tenant = "a") {
    const runs = new InventoryRuns(new InventoryIngestion(f.store));
    const run = await runs.load(tenant, runId);
    assert.ok(run);
    await f.store
      .statement(
        "UPDATE inventory_stream_jobs SET work_version=work_version+1,next_due_at=? WHERE tenant=? AND scope_id=? AND stream_id=?",
        Date.now() - 1,
        tenant,
        run.scope,
        run.streamId,
      )
      .run();
    const current = await runs.load(tenant, runId);
    assert.ok(current);
    await f.store
      .statement(
        "INSERT INTO inventory_wakeups(tenant,wakeup_id,scope_id,stream_id,run_id,work_version,not_before) VALUES(?,?,?,?,?,?,?)",
        tenant,
        crypto.randomUUID(),
        current.scope,
        current.streamId,
        current.id,
        current.jobVersion,
        current.nextDueAt,
      )
      .run();
    return {
      version: 1 as const,
      tenant,
      scope: current.scope,
      stream: current.streamId,
      run: runId,
      workVersion: current.jobVersion,
    };
  }
  return { ...f, env, sent, due };
}
function batch(body: unknown) {
  const outcomes: (string | number)[] = [];
  const message: Message<unknown> = {
    id: "fixture",
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
  const value: MessageBatch<unknown> = {
    messages: [message],
    queue: "fixture",
    metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } },
    ackAll() {
      outcomes.push("ackAll");
    },
    retryAll(options) {
      outcomes.push(options?.delaySeconds ?? 0);
    },
  };
  return { value, outcomes };
}
function lofi() {
  return Response.json({
    account: { uuid: "source" },
    operations: [],
    qsos: [{ uuid: "q1", syncedAtMillis: 100 }],
    meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
  });
}

test("off pauses cron before and after the inventory database handoff", async (t) => {
  const f = await fixture(t);
  const env = { ...f.env, INVENTORY_RUNTIME_MODE: "off" };
  const paused = { mode: "inventory_paused", queued: 0 };
  assert.deepEqual(await runHostedScheduled(env), paused);
  assert.equal(
    await f.db
      .prepare("SELECT version FROM inventory_runtime")
      .first("version"),
    0,
  );
  await activateInventoryRuntime(f.store);
  assert.deepEqual(await runHostedScheduled(env), paused);
  assert.equal(
    await f.db.prepare("SELECT count(*) AS n FROM inventory_scopes").first("n"),
    0,
  );
});

test("cron registers source/book selections and publishes initial jobs without vendor reads", async (t) => {
  const f = await fixture(t);
  const credentials = (
    await f.db
      .prepare(
        "SELECT * FROM private_data WHERE kind='credential' ORDER BY connection",
      )
      .all()
  ).results;
  const result = await runHostedScheduled(f.env);
  assert.equal(result.mode, "inventory_read_only");
  if (result.mode !== "inventory_read_only") assert.fail();
  assert.equal(result.registration.registered, 2);
  assert.equal(result.rawPayloadsCollected, 0);
  assert.equal(result.rawPayloadCollectionFailed, 0);
  assert.equal(result.starts.started, 2);
  assert.equal(result.queued, 3);
  assert.equal(result.inventoryQueued, 2);
  assert.equal(result.comparisonQueued, 1);
  assert.equal(result.qrzShadow, "off");
  assert.equal((await inventoryRuntime(f.store)).mode, "inventory_read_only");
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) n FROM inventory_scheduled_selections")
        .first<{ n: number }>()
    )?.n,
    2,
  );
  const repeated = await runHostedScheduled({
    ...f.env,
    INVENTORY_QRZ_SHADOW_JSON: "{",
  });
  assert.equal(repeated.mode, "inventory_read_only");
  if (repeated.mode !== "inventory_read_only") assert.fail();
  assert.equal(repeated.qrzShadow, "invalid");
  assert.equal(repeated.queued, 0);
  assert.deepEqual(
    (
      await f.db
        .prepare(
          "SELECT * FROM private_data WHERE kind='credential' ORDER BY connection",
        )
        .all()
    ).results,
    credentials,
  );
});

test("proof wakeup publication recovers a failed queue send and ignores an old work version", async (t) => {
  const f = await fixture(t);
  await runHostedScheduled(f.env);
  const scope = await f.db
    .prepare("SELECT scope_id FROM inventory_scopes WHERE provider='lofi'")
    .first<string>("scope_id");
  assert.ok(scope);
  const now = Date.now();
  // Only wakeup behavior is exercised. The stale message must never load a snapshot.
  await f.db
    .prepare(
      "INSERT INTO inventory_source_proof_jobs(tenant,scope_id,job_id,snapshot,witnesses,started_at,collection_deadline,due_at) VALUES('a',?,'fixture-proof','{}','[]',?,?,?)",
    )
    .bind(scope, now, now + 120000, now)
    .run();
  await assert.rejects(
    runHostedScheduled({
      ...f.env,
      INVENTORY_QUEUE: {
        ...f.env.INVENTORY_QUEUE,
        async sendBatch() {
          throw new Error("fixture_queue_unavailable");
        },
      },
    }),
    /fixture_queue_unavailable/,
  );
  assert.equal(
    await f.db
      .prepare("SELECT published_version FROM inventory_source_proof_jobs")
      .first("published_version"),
    0,
  );
  const recovered = await runHostedScheduled(f.env);
  assert.equal(
    "sourceProofQueued" in recovered && recovered.sourceProofQueued,
    1,
  );
  const message = f.sent.find((row) => isSourceProofWakeup(row.body));
  assert.ok(message);
  const repeated = await runHostedScheduled(f.env);
  assert.equal(
    "sourceProofQueued" in repeated && repeated.sourceProofQueued,
    0,
  );
  await f.db
    .prepare("UPDATE inventory_source_proof_jobs SET version=version+1")
    .run();
  const replay = batch(message.body);
  const report = await runHostedInventoryQueue(f.env, replay.value, async () =>
    assert.fail("stale proof wakeup must not read the provider"),
  );
  assert.deepEqual(replay.outcomes, ["ack"]);
  assert.equal("sourceProofQueued" in report && report.sourceProofQueued, 1);
  assert.equal(
    await f.db
      .prepare("SELECT published_version FROM inventory_source_proof_jobs")
      .first("published_version"),
    2,
  );
});

test("the hosted queue executes an owned source page, and off pauses future delivery", async (t) => {
  const f = await fixture(t);
  await runHostedScheduled(f.env);
  const scope = await f.db
    .prepare(
      "SELECT scope_id FROM inventory_scopes WHERE connection_id='source'",
    )
    .first<{ scope_id: string }>();
  assert.ok(scope);
  const request = f.sent.find(
    (row) => (row.body as InventoryRunWakeup).scope === scope.scope_id,
  );
  assert.ok(request);
  const delivery = batch(request.body);
  let reads = 0;
  const report = await runHostedInventoryQueue(
    f.env,
    delivery.value,
    async () => {
      reads++;
      return lofi();
    },
  );
  assert.equal("failed" in report && report.failed, 0);
  assert.deepEqual(delivery.outcomes, ["ack"]);
  assert.equal(reads, 1);
  const continuation = f.sent.findLast((row) => !isComparisonMessage(row.body));
  assert.ok(continuation?.delaySeconds && continuation.delaySeconds >= 19);
  const paused = batch(continuation.body);
  await runHostedInventoryQueue(
    { ...f.env, INVENTORY_RUNTIME_MODE: "off" },
    paused.value,
    async () => {
      reads++;
      return lofi();
    },
  );
  assert.deepEqual(paused.outcomes, [300]);
  assert.equal(reads, 1);
  assert.equal(
    (await f.db.prepare("SELECT count(*) n FROM ledger").first<{ n: number }>())
      ?.n,
    0,
  );
});

test("a mixed hosted batch advances one read and bounded comparison steps", async (t) => {
  const f = await fixture(t);
  await runHostedScheduled(f.env);
  const scope = await f.db
    .prepare(
      "SELECT scope_id FROM inventory_scopes WHERE connection_id='source'",
    )
    .first<{ scope_id: string }>();
  assert.ok(scope);
  const sourceRequest = f.sent.find(
    (row) => (row.body as InventoryRunWakeup).scope === scope.scope_id,
  );
  const comparisonRequest = f.sent.find((row) => isComparisonMessage(row.body));
  assert.ok(sourceRequest && comparisonRequest);
  const source = batch(sourceRequest.body),
    comparison = batch(comparisonRequest.body);
  let reads = 0;
  const report = await runHostedInventoryQueue(
    f.env,
    {
      ...source.value,
      messages: [...source.value.messages, ...comparison.value.messages],
    },
    async () => {
      reads++;
      return lofi();
    },
  );
  assert.equal(report.mode, "inventory_read_only");
  assert.ok("inventoryProcessed" in report);
  assert.equal(report.inventoryProcessed, 1);
  assert.equal(report.comparisonProcessed, 1);
  assert.ok(report.comparisonSteps > 1 && report.comparisonSteps <= 4);
  assert.equal(report.processed, 2);
  assert.equal(report.failed, 0);
  assert.equal(reads, 1);
  assert.deepEqual(source.outcomes, ["ack"]);
  assert.deepEqual(comparison.outcomes, ["ack"]);
});

test("a failed comparison continuation keeps the committed read message retryable", async (t) => {
  const f = await fixture(t);
  await runHostedScheduled(f.env);
  const scope = await f.db
    .prepare(
      "SELECT scope_id FROM inventory_scopes WHERE connection_id='source'",
    )
    .first<{ scope_id: string }>();
  assert.ok(scope);
  const request = f.sent.find(
    (row) => (row.body as InventoryRunWakeup).scope === scope.scope_id,
  );
  assert.ok(request);
  const first = batch(request.body);
  const queue = {
    ...f.env.INVENTORY_QUEUE,
    async sendBatch(messages: Iterable<MessageSendRequest<unknown>>) {
      const rows = Array.from(messages);
      if (rows.some((row) => isComparisonMessage(row.body)))
        throw new Error("synthetic comparison Queue outage");
      return f.env.INVENTORY_QUEUE.sendBatch(rows);
    },
  };
  let reads = 0;
  const failed = await runHostedInventoryQueue(
    { ...f.env, INVENTORY_QUEUE: queue },
    first.value,
    async () => {
      reads++;
      return lofi();
    },
  );
  assert.equal("failed" in failed && failed.failed, 1);
  assert.deepEqual(first.outcomes, [60]);
  assert.equal(reads, 1);
  assert.deepEqual(
    await f.db.prepare("SELECT count(*) AS n FROM inventory_records").first(),
    { n: 1 },
  );
  const replay = batch(request.body);
  const recovered = await runHostedInventoryQueue(
    f.env,
    replay.value,
    async () => {
      reads++;
      return lofi();
    },
  );
  assert.equal("failed" in recovered && recovered.failed, 0);
  assert.deepEqual(replay.outcomes, ["ack"]);
  assert.equal(
    reads,
    1,
    "the old committed page is recovered without another vendor read",
  );
});

test("a malformed first account cannot starve the bounded registration roster", async (t) => {
  const f = await fixture(t);
  await f.store
    .statement("UPDATE connections SET config='{}' WHERE id='destination'")
    .run();
  const runtime = await activateInventoryRuntime(f.store);
  assert.deepEqual(
    await registerKnownInventoryConnections(f.store, runtime, 1),
    { registered: 0, failed: 1 },
  );
  assert.deepEqual(
    await registerKnownInventoryConnections(f.store, runtime, 1),
    { registered: 1, failed: 0 },
  );
});

test("LoFi recurrence slots only established links and respects server check periods", async (t) => {
  const slots = Array.from({ length: 100 }, (_, position) =>
    lofiPollSlot(0, 100, position),
  );
  assert.equal(new Set(slots).size, 100);
  const windows = new Map<number, number>();
  for (const slot of slots) {
    const window = Math.floor(slot / 300_000);
    windows.set(window, (windows.get(window) ?? 0) + 1);
  }
  assert.equal(windows.size, 34);
  assert.equal(Math.max(...windows.values()), 3);

  const f = await fixture(t);
  for (const tenant of ["b", "c", "d"]) {
    await f.db.batch([
      f.store.statement(
        "INSERT INTO accounts(id,email,user_handle,verified_at) VALUES(?,?,?,1)",
        tenant,
        `${tenant}@example.test`,
        tenant,
      ),
      f.store.statement(
        `INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at,config)
         VALUES(?,'source','lofi',?,'Fixture','active','v1',1,?)`,
        tenant,
        tenant,
        JSON.stringify({ accountId: tenant }),
      ),
      await f.store.putPrivate(tenant, "source", "v1", "credential", {
        key: `browser:${tenant}`,
        secret: "fixture-secret",
        token: "fixture-token",
      }),
    ]);
  }
  await runHostedScheduled(f.env);
  const sources = (
    await f.db
      .prepare(
        `SELECT j.tenant,j.scope_id AS scope,j.stream_id AS streamId,j.active_run_id AS runId,s.logical_identity
         FROM inventory_stream_jobs j JOIN inventory_scopes s USING(tenant,scope_id)
         WHERE s.provider='lofi' ORDER BY j.tenant`,
      )
      .all<{
        tenant: string;
        scope: string;
        streamId: string;
        runId: string;
        logical_identity: string;
      }>()
  ).results;
  assert.equal(sources.length, 4);
  const runs = new InventoryRuns(new InventoryIngestion(f.store));
  for (const [position, source] of sources.entries()) {
    const checkPeriod = position === 3 ? 900_000 : 300_000;
    const runner = new InventoryRunner(
      runs,
      async () =>
        Response.json({
          account: { uuid: source.logical_identity },
          operations: [],
          qsos: [],
          meta: {
            operations: { records_left: 0 },
            qsos: { records_left: 0 },
            suggestedSyncCheckPeriod: checkPeriod,
          },
        }),
      { scheduled: true },
    );
    for (let turn = 0; turn < 6; turn++) {
      const run = await runs.load(source.tenant, source.runId);
      assert.ok(run);
      if (run.phase === "complete") break;
      if (run.phase === "collecting" || run.phase === "catchup") {
        // Advance the pacer only in this synthetic native fixture.
        await f.store
          .statement(
            "DELETE FROM inventory_read_pacing WHERE tenant='' OR tenant=?",
            source.tenant,
          )
          .run();
      }
      await runner.step(await f.due(source.runId, source.tenant));
    }
    const completed = await f.store
      .statement(
        `SELECT r.completed_at,j.next_due_at FROM inventory_runs r
         JOIN inventory_stream_jobs j USING(tenant,scope_id,stream_id)
         WHERE (r.tenant,r.run_id)=(?,?) AND r.phase='complete'`,
        source.tenant,
        source.runId,
      )
      .first<{ completed_at: number; next_due_at: number }>();
    assert.ok(completed);
    const delay = completed.next_due_at - completed.completed_at;
    assert.ok(delay >= checkPeriod - 1000);
    if (position < 3) assert.ok(delay <= checkPeriod);
    else {
      assert.equal(completed.next_due_at % 600_000, lofiPollSlot(0, 4, 3));
      assert.ok(delay < checkPeriod + 600_000);
    }
  }

  await f.db
    .prepare("UPDATE connections SET status='disabled' WHERE tenant='b'")
    .run();
  const earliest = Date.now() + 300_000;
  assert.equal(
    await lofiRecurringDueAt(f.store, sources[0], earliest),
    earliest,
  );
});

test("LoFi bootstrap leaves four slots for established links in the same window", async (t) => {
  const f = await fixture(t);
  const initial = await runHostedScheduled(f.env);
  assert.ok(initial.mode === "inventory_read_only");
  const runs = new InventoryRuns(new InventoryIngestion(f.store));
  const source = await f.db
    .prepare(
      `SELECT j.active_run_id FROM inventory_stream_jobs j
       JOIN inventory_scopes s USING(tenant,scope_id) WHERE s.provider='lofi'`,
    )
    .first<string>("active_run_id");
  assert.ok(source);
  const runner = new InventoryRunner(runs, async () => lofi(), {
    scheduled: true,
  });
  for (let turn = 0; turn < 6; turn++) {
    const run = await runs.load("a", source);
    assert.ok(run);
    if (run.phase === "complete") break;
    // The remaining part of this fixture advances a synthetic quota clock.
    await f.db.prepare("DELETE FROM inventory_read_pacing").run();
    const result = await runner.step(await f.due(source));
    assert.ok(result.kind === "advanced" || result.kind === "complete");
  }
  const established = await runs.load("a", source);
  assert.ok(established?.phase === "complete");

  await f.db.batch([
    f.db.prepare(
      `INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at,config)
       VALUES('a','new-source','lofi','new-source','Fixture','active','v1',1,'{"accountId":"new-source"}')`,
    ),
    await f.store.putPrivate("a", "new-source", "v1", "credential", {
      key: "browser:new-source",
      secret: "fixture-secret",
      token: "fixture-token",
    }),
  ]);
  const link = await f.store.connection("a", "new-source");
  assert.ok(link);
  const runtime = await inventoryRuntime(f.store);
  const fresh = await registerInventorySelection(f.store, runtime, link, {
    provider: "lofi",
    pageSize: 1000,
  });
  assert.equal((await startInventorySelections(f.store)).started, 1);
  const oldStream = await runs.inventory.snapshot(
    "a",
    established.scope,
    established.streamId,
  );
  const freshStream = await runs.inventory.snapshot(
    "a",
    fresh.scope,
    fresh.stream,
  );
  const oldLease = await f.store.claim(
    "a",
    `inventory:${established.scope}`,
    Date.now(),
    3_600_000,
  );
  const freshLease = await f.store.claim(
    "a",
    `inventory:${fresh.scope}`,
    Date.now(),
    3_600_000,
  );
  assert.ok(oldStream && freshStream && oldLease && freshLease);
  const window = (Math.floor(Date.now() / 300_000) + 1) * 300_000;
  let now = window + 1000;
  let transportCalls = 0;
  const fetcher = async () => {
    transportCalls++;
    return new Response("fixture");
  };
  const bootstrap = inventoryVendorFetch(
    f.store,
    freshStream,
    freshLease,
    fetcher,
    {
      priority: "bootstrap",
      now: () => now,
      sourceDelayMs: 5000,
    },
  );
  const ordinary = inventoryVendorFetch(f.store, oldStream, oldLease, fetcher, {
    priority: "background",
    now: () => now,
    sourceDelayMs: 5000,
  });
  const live = inventoryVendorFetch(f.store, oldStream, oldLease, fetcher, {
    priority: "live",
    now: () => now,
    sourceDelayMs: 5000,
  });
  const endpoint = "https://lofi.ham2k.net/v1/sync";
  const read = async (fetcher: typeof fetch, count: number) => {
    for (let i = 0; i < count; i++) {
      await fetcher(endpoint);
      now += 5000;
    }
  };
  await read(bootstrap, 16);
  await assert.rejects(
    bootstrap(endpoint),
    (error) =>
      error instanceof VendorDeferredError &&
      !error.requestSent &&
      error.retryAt === window + 300_000,
  );
  assert.equal(transportCalls, 16);
  await read(ordinary, 4);
  await read(live, 4);
  assert.equal(transportCalls, 24);
  const budget = () =>
    f.db
      .prepare(
        "SELECT requests,background_requests FROM vendor_requests WHERE vendor='lofi'",
      )
      .first();
  assert.deepEqual(await budget(), { requests: 24, background_requests: 4 });

  await f.db
    .prepare(
      "UPDATE connections SET status='disabled' WHERE tenant='a' AND id='source'",
    )
    .run();
  now = window + 301_000;
  await read(bootstrap, 20);
  assert.equal(transportCalls, 44);
  assert.deepEqual(await budget(), { requests: 20, background_requests: 0 });
});

test("date selection partitioning is gap-free, bounded and retains station filters", () => {
  const plans = lotwInventorySelections({
    startDate: "2024-02-01",
    endDate: "2024-04-02",
    stationCallsign: "N1RWJ",
  });
  assert.equal(plans.length, 2);
  assert.deepEqual(plans, [
    {
      provider: "lotw",
      selection: {
        startDate: "2024-02-01",
        endDate: "2024-03-03",
        stationCallsign: "N1RWJ",
      },
    },
    {
      provider: "lotw",
      selection: {
        startDate: "2024-03-04",
        endDate: "2024-04-02",
        stationCallsign: "N1RWJ",
      },
    },
  ]);
  assert.throws(
    () =>
      lotwInventorySelections({
        startDate: "2025-02-29",
        endDate: "2025-03-01",
      }),
    /date_range/,
  );
});

test("calendar enrollment resumes by month and binds current unfiltered LoTW selections", async (t) => {
  const f = await fixture(t);
  await f.store
    .statement(
      `INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at,config)
       VALUES('a','lotw','lotw','fixture','LoTW','active','v1',1,'{"readAccess":true}'),
             ('a','upload-only','lotw','upload','Upload','active','v1',1,'{"readAccess":false}')`,
    )
    .run();
  await (
    await f.store.putPrivate("a", "lotw", "v1", "credential", {
      query: { username: "fixture", password: "fixture" },
    })
  ).run();
  const first = await runHostedScheduled(f.env);
  assert.ok(first.mode === "inventory_read_only");
  assert.deepEqual(first.calendarRegistration, { registered: 0, failed: 0 });
  const source = await f.db
    .prepare("SELECT scope_id FROM inventory_scopes WHERE provider='lofi'")
    .first<string>("scope_id");
  const wakeup = f.sent.find(
    (row) => (row.body as InventoryRunWakeup).scope === source,
  );
  assert.ok(wakeup);
  const delivery = batch(wakeup.body);
  await runHostedInventoryQueue(f.env, delivery.value, async () =>
    Response.json({
      account: { uuid: "source" },
      operations: [],
      qsos: [
        {
          uuid: "q1",
          syncedAtMillis: 100,
          startAtMillis: Date.parse("2024-03-01T00:10:00Z"),
        },
      ],
      meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
    }),
  );
  assert.deepEqual(delivery.outcomes, ["ack"]);
  const runtime = await inventoryRuntime(f.store);
  const link = await f.store.connection("a", "lotw");
  assert.ok(link);
  await registerInventorySelection(f.store, runtime, link, {
    provider: "lotw",
    selection: {
      startDate: "2024-02-01",
      endDate: "2024-02-29",
      stationCallsign: "N1RWJ",
    },
  });
  for (let i = 0; i < 2; i++)
    assert.deepEqual(
      await registerSourceCalendarSelections(f.store, runtime, 1),
      { registered: 1, failed: 0 },
    );
  assert.deepEqual(
    await registerSourceCalendarSelections(f.store, runtime, 1),
    { registered: 0, failed: 0 },
  );
  const plans = await f.db
    .prepare(
      `SELECT json_extract(p.plan,'$.selection.startDate') AS start,
        json_extract(p.plan,'$.selection.endDate') AS end
       FROM inventory_scheduled_selections p
       JOIN inventory_scopes s ON s.tenant=p.tenant AND s.scope_id=p.scope_id
       WHERE s.provider='lotw' AND json_type(p.plan,'$.selection.stationCallsign') IS NULL
       ORDER BY start`,
    )
    .all();
  assert.deepEqual(plans.results, [
    { start: "2024-02-01", end: "2024-02-29" },
    { start: "2024-03-01", end: "2024-03-31" },
  ]);
  assert.equal(
    await f.db
      .prepare(
        "SELECT count(*) AS n FROM inventory_coverage c JOIN inventory_scopes s ON s.tenant=c.tenant AND s.scope_id=c.scope_id WHERE s.provider='lotw'",
      )
      .first("n"),
    0,
    "scheduling a month provides no coverage",
  );
  await f.db
    .prepare("UPDATE connections SET config=? WHERE id='lotw'")
    .bind('{"readAccess":false}')
    .run();
  assert.deepEqual(await registerSourceCalendarSelections(f.store, runtime), {
    registered: 0,
    failed: 0,
  });
  await f.db
    .prepare("UPDATE connections SET config=? WHERE id='lotw'")
    .bind('{"readAccess":true}')
    .run();
  assert.deepEqual(await registerSourceCalendarSelections(f.store, runtime), {
    registered: 2,
    failed: 0,
  });

  const accountFeed = () =>
    f.db
      .prepare(
        `SELECT p.plan,p.scope_id,p.stream_id,p.poll_period_ms,j.active_run_id
         FROM inventory_scheduled_selections p
         JOIN inventory_stream_jobs j USING(tenant,scope_id,stream_id)
         WHERE json_extract(p.plan,'$.selection.kind')='account_received'`,
      )
      .first<{
        plan: string;
        scope_id: string;
        stream_id: string;
        poll_period_ms: number;
        active_run_id: string;
      }>();
  assert.ok((await runHostedScheduled(f.env)).mode === "inventory_read_only");
  assert.equal(await accountFeed(), null);
  const env = { ...f.env, INVENTORY_LOTW_ACCOUNT_FEEDS: "true" };
  const enrollment = await runHostedScheduled(env);
  assert.ok(enrollment.mode === "inventory_read_only");
  assert.deepEqual(enrollment.lotwAccountRegistration, {
    registered: 1,
    failed: 0,
  });
  const feed = await accountFeed();
  assert.ok(feed?.active_run_id);
  assert.equal(feed.poll_period_ms, 7_200_000);
  const oldest = await f.db
    .prepare(
      `SELECT min(created_at) AS at FROM inventory_scheduled_selections
       WHERE scope_id=? AND json_type(plan,'$.selection.startDate')='text'
       AND json_type(plan,'$.selection.stationCallsign') IS NULL`,
    )
    .bind(feed.scope_id)
    .first<number>("at");
  assert.ok(oldest);
  const plan = JSON.parse(feed.plan);
  const initial = plan.selection.initialReceivedSince;
  assert.equal(
    initial,
    new Date(oldest).toISOString().slice(0, 19).replace("T", " "),
  );
  const repeated = await runHostedScheduled(env);
  assert.ok(repeated.mode === "inventory_read_only");
  assert.deepEqual(repeated.lotwAccountRegistration, {
    registered: 0,
    failed: 0,
  });
  assert.deepEqual(await accountFeed(), feed);

  const runs = new InventoryRuns(new InventoryIngestion(f.store));
  const nextStamp = (at: string) =>
    new Date(Date.parse(`${at.replace(" ", "T")}Z`) + 1000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
  const through = nextStamp(initial);
  const record = serializeAdifRecord({
    CALL: "W1AW",
    STATION_CALLSIGN: "N1RWJ",
    QSO_DATE: "20240301",
    TIME_ON: "120000",
    MODE: "CW",
    BAND: "20M",
    QSL_RCVD: "N",
    APP_LOTW_RXQSO: through,
  });
  const reads: string[] = [];
  const runner = new InventoryRunner(
    runs,
    async (url) => {
      const query = new URL(String(url)).searchParams;
      assert.equal(query.has("qso_startdate"), false);
      reads.push(query.get("qso_qsorxsince") ?? "");
      return new Response(
        `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:1>1<APP_LOTW_LASTQSORX:19>${through}<EOH>${record}<APP_LOTW_EOF>`,
      );
    },
    { scheduled: true },
  );
  assert.equal(
    (await runner.step(await f.due(feed.active_run_id))).kind,
    "advanced",
  );
  assert.equal(
    (await runner.step(await f.due(feed.active_run_id))).kind,
    "complete",
  );
  assert.deepEqual(reads, [initial]);
  const oldWakeup = await f.due(feed.active_run_id);
  await f.db
    .prepare("UPDATE connections SET config=? WHERE id='lotw'")
    .bind('{"readAccess":false}')
    .run();
  assert.deepEqual(await registerLotwAccountFeeds(f.store, runtime), {
    registered: 0,
    failed: 0,
  });
  await f.db
    .prepare("UPDATE connections SET config=? WHERE id='lotw'")
    .bind('{"readAccess":true}')
    .run();
  await registerSourceCalendarSelections(f.store, runtime);
  assert.deepEqual(await registerLotwAccountFeeds(f.store, runtime), {
    registered: 1,
    failed: 0,
  });
  const stream = await runs.inventory.snapshot(
    "a",
    feed.scope_id,
    feed.stream_id,
  );
  assert.ok(stream);
  const definition = await planInventoryRun(stream, plan);
  const query = inventoryRunQuery(definition.fixedQuery);
  assert.ok(query.provider === "lotw" && "kind" in query.query);
  assert.equal(query.query.receivedSince, through);
  const lease = await f.store.claim(
    "a",
    `inventory:${feed.scope_id}`,
    Date.now(),
    90_000,
  );
  assert.ok(lease);
  try {
    await assert.rejects(
      runs.begin({
        stream,
        lease,
        definition: {
          ...definition,
          fixedQuery: {
            ...query,
            query: { ...query.query, receivedSince: nextStamp(through) },
          },
        },
        replaceHeld: true,
      }),
      /inventory run changed/,
    );
  } finally {
    await f.store.release(lease);
  }
  const restarted = await runHostedScheduled(env);
  assert.ok(restarted.mode === "inventory_read_only");
  const newFeed = await accountFeed();
  assert.ok(
    newFeed?.active_run_id && newFeed.active_run_id !== feed.active_run_id,
  );
  assert.equal(newFeed.plan, feed.plan);
  assert.equal(newFeed.stream_id, feed.stream_id);
  assert.deepEqual(await runner.step(oldWakeup), {
    kind: "skipped",
    reason: "stale",
  });
  assert.equal(
    (await runner.step(await f.due(newFeed.active_run_id))).kind,
    "advanced",
  );
  assert.equal(
    (await runner.step(await f.due(newFeed.active_run_id))).kind,
    "complete",
  );
  assert.deepEqual(reads, [initial, through]);
  assert.deepEqual(
    await f.db
      .prepare(
        "SELECT state,kind,epoch FROM inventory_coverage WHERE stream_id=?",
      )
      .bind(feed.stream_id)
      .first(),
    { state: "partial", kind: "positive_only", epoch: 0 },
  );
});

test("hosted QSL polling is opt-in, paced and independent of receipt coverage", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await f.db
    .prepare(
      `INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at,config)
     VALUES('a','lotw','lotw','fixture','LoTW','active','v1',1,'{"readAccess":true}')`,
    )
    .run();
  const query = { username: "fixture", password: "fixture" };
  await (
    await f.store.putPrivate("a", "lotw", "v1", "credential", { query })
  ).run();
  const connection = await f.store.connection("a", "lotw");
  assert.ok(connection);
  const runtime = await activateInventoryRuntime(f.store);
  for (const month of ["02", "03"]) {
    await registerInventorySelection(f.store, runtime, connection, {
      provider: "lotw",
      selection: { startDate: `2024-${month}-01`, endDate: `2024-${month}-05` },
    });
  }
  await registerInventorySelection(f.store, runtime, connection, {
    provider: "lotw",
    selection: {
      kind: "account_received",
      initialReceivedSince: "2026-01-01 00:00:00",
    },
  });
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  const calls: URLSearchParams[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://lotw.arrl.org");
    assert.equal(url.pathname, "/lotwuser/lotwreport.adi");
    assert.equal(init?.method ?? "GET", "GET");
    const query = url.searchParams;
    calls.push(query);
    assert.equal(query.get("qso_qsl"), "yes");
    assert.equal(query.has("qso_qsorxsince"), false);
    const start = query.get("qso_startdate");
    assert.ok(start === "2024-02-01" || start === "2024-03-01");
    assert.equal(query.get("qso_enddate"), `${start.slice(0, -2)}05`);
    const record = serializeAdifRecord({
      CALL: "W1AW",
      STATION_CALLSIGN: "N1RWJ",
      QSO_DATE: start.replaceAll("-", ""),
      TIME_ON: "120000",
      MODE: "CW",
      BAND: "20M",
      QSL_RCVD: "Y",
      APP_LOTW_RXQSL: stamp,
    });
    return new Response(
      `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:1>1<APP_LOTW_LASTQSL:19>${stamp}<EOH>${record}<APP_LOTW_EOF>`,
    );
  };
  const off = await runHostedScheduled(f.env, {
    lotwConfirmationFetch: fetcher,
  });
  assert.equal(off.mode, "inventory_read_only");
  assert.equal(off.lotwConfirmations, null);
  assert.equal(calls.length, 0);
  const coverage = () =>
    f.db
      .prepare("SELECT * FROM inventory_coverage ORDER BY scope_id,stream_id")
      .all();
  const before = (await coverage()).results;
  const report = await runHostedScheduled(
    { ...f.env, INVENTORY_LOTW_CONFIRMATIONS: "true" },
    { lotwConfirmationFetch: fetcher },
  );
  assert.equal(report.mode, "inventory_read_only");
  assert.deepEqual(report.lotwConfirmations, {
    registered: 2,
    split: 0,
    polled: 1,
    added: 1,
    deferred: 0,
    held: 0,
    failed: 0,
  });
  const scheduled = await f.db
    .prepare(
      "SELECT initial_confirmed_since,next_due_at FROM inventory_lotw_confirmation_schedule WHERE version=1",
    )
    .first<{ initial_confirmed_since: string; next_due_at: number }>();
  assert.ok(scheduled);
  assert.equal(calls[0].get("qso_qslsince"), scheduled.initial_confirmed_since);
  const days = (scheduled.next_due_at - Date.now()) / 86_400_000;
  assert.ok(days > 3.49 && days < 10.51);
  assert.deepEqual((await coverage()).results, before);
  assert.equal(
    await f.db
      .prepare("SELECT count(*) AS n FROM inventory_record_facets")
      .first("n"),
    0,
  );

  const repeated = await runLotwConfirmationSchedule(f.store, fetcher);
  assert.equal(repeated.polled, 0);
  assert.equal(calls.length, 1);
  const nextSlot = () =>
    f.db
      .prepare("UPDATE inventory_lotw_confirmation_slot SET last_slot=-1")
      .run();
  await nextSlot();
  await f.db
    .prepare(
      "UPDATE inventory_lotw_confirmation_schedule SET next_due_at=0 WHERE version=1",
    )
    .run();
  const [retryA, retryB] = await Promise.all([
    runLotwConfirmationSchedule(f.store, fetcher),
    runLotwConfirmationSchedule(f.store, fetcher),
  ]);
  assert.equal(retryA.polled + retryB.polled, 1);
  assert.equal(retryA.added + retryB.added, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].get("qso_qslsince"), stamp);
  assert.equal(
    await f.db
      .prepare(
        "SELECT background_requests FROM vendor_requests WHERE vendor='lotw'",
      )
      .first("background_requests"),
    2,
  );

  await nextSlot();
  const rejected = await runLotwConfirmationSchedule(
    f.store,
    async () => new Response(null, { status: 403 }),
  );
  assert.equal(rejected.held, 1);
  assert.equal(
    await f.db
      .prepare(
        "SELECT rejected_credential_version FROM inventory_lotw_confirmation_schedule WHERE rejected_credential_version IS NOT NULL",
      )
      .first("rejected_credential_version"),
    "v1",
  );
  await nextSlot();
  await f.db
    .prepare("UPDATE inventory_lotw_confirmation_schedule SET next_due_at=0")
    .run();
  assert.equal((await runLotwConfirmationSchedule(f.store, fetcher)).polled, 0);
  assert.equal(calls.length, 2);
  await f.db
    .prepare(
      "UPDATE inventory_lotw_confirmation_schedule SET next_due_at=? WHERE rejected_credential_version IS NULL",
    )
    .bind(Date.now() + 7 * 86_400_000)
    .run();
  await (
    await f.store.putPrivate("a", "lotw", "v2", "credential", { query })
  ).run();
  await f.db
    .prepare("UPDATE connections SET credential_version='v2' WHERE id='lotw'")
    .run();
  await f.db
    .prepare("UPDATE vendor_requests SET cooldown_until=? WHERE vendor='lotw'")
    .bind(Date.now() + 300_000)
    .run();
  assert.equal(
    (await runLotwConfirmationSchedule(f.store, fetcher)).deferred,
    1,
  );
  assert.equal(calls.length, 2);
  await f.db
    .prepare("UPDATE vendor_requests SET cooldown_until=0 WHERE vendor='lotw'")
    .run();
  const resumed = await runLotwConfirmationSchedule(f.store, fetcher);
  assert.equal(resumed.polled, 1);
  assert.equal(resumed.added, 1);
  assert.equal(calls.length, 3);
  assert.deepEqual((await coverage()).results, before);
  const confirmations = await f.db
    .prepare("SELECT * FROM inventory_lotw_confirmations ORDER BY stream_id")
    .all();
  await nextSlot();
  await f.db
    .prepare(
      "UPDATE inventory_lotw_confirmation_schedule SET next_due_at=0 WHERE version=2",
    )
    .run();
  const oversized = await runLotwConfirmationSchedule(
    f.store,
    async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)),
  );
  assert.equal(oversized.held, 1);
  assert.equal(
    await f.db
      .prepare(
        "SELECT count(*) AS n FROM inventory_lotw_confirmation_schedule WHERE overflow=1",
      )
      .first("n"),
    1,
  );
  assert.deepEqual(
    await f.db
      .prepare("SELECT * FROM inventory_lotw_confirmations ORDER BY stream_id")
      .all()
      .then((rows) => rows.results),
    confirmations.results,
  );
});

test("an upgraded QSL hold splits atomically at its saved watermark", async (t) => {
  const f = await database();
  t.after(() => f.mf.dispose());
  const upgrade = "0121_inventory_lotw_confirmation_splits.sql";
  for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter(
      (file) =>
        file.endsWith(".sql") && file > "0001_foundation.sql" && file < upgrade,
    )
    .sort())
    await applyMigration(f.db, name);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await seed(f.store);
  await f.db
    .prepare(
      `INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at,config)
     VALUES('a','lotw','lotw','fixture','LoTW','active','v1',1,'{"readAccess":true}')`,
    )
    .run();
  await (
    await f.store.putPrivate("a", "lotw", "v1", "credential", {
      query: { username: "fixture", password: "fixture" },
    })
  ).run();
  const connection = await f.store.connection("a", "lotw");
  assert.ok(connection);
  const selection = {
    startDate: "2026-11-08",
    endDate: "2026-11-09",
    stationCallsign: "N1RWJ",
    workedCallsign: "W1AW",
  };
  const initial = "2026-11-08 00:00:00";
  const watermark = "2026-11-08 14:00:00";
  const runtime = await activateInventoryRuntime(f.store);
  const root = await registerInventorySelection(f.store, runtime, connection, {
    provider: "lotw",
    selection,
  });
  const record = serializeAdifRecord({
    CALL: selection.workedCallsign,
    STATION_CALLSIGN: selection.stationCallsign,
    QSO_DATE: "20261108",
    TIME_ON: "120000",
    MODE: "CW",
    BAND: "20M",
    QSL_RCVD: "Y",
    APP_LOTW_RXQSL: watermark,
  });
  const qsl = () =>
    new Response(
      `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:1>1<APP_LOTW_LASTQSL:19>${watermark}<EOH>${record}<APP_LOTW_EOF>`,
    );
  const saved = await pollInventoryLotwConfirmations(
    f.store,
    {
      tenant: "a",
      scope: root.scope,
      selection: { ...selection, confirmedSince: initial },
    },
    async () => qsl(),
  );
  assert.equal(saved.state, "complete");
  assert.equal(saved.confirmedThrough, watermark);
  await f.db
    .prepare(
      `INSERT INTO inventory_lotw_confirmation_schedule(tenant,scope_id,receipt_stream_id,scope_version,initial_confirmed_since,next_due_at,version,overflow)
     SELECT tenant,scope_id,stream_id,config_version,?,0,3,1 FROM inventory_scheduled_selections WHERE stream_id=?`,
    )
    .bind(initial, root.stream)
    .run();
  await applyMigration(f.db, upgrade);
  const parentCheckpoint = () =>
    f.db
      .prepare(
        "SELECT checkpoint_version,committed_checkpoint FROM inventory_streams WHERE stream_id=?",
      )
      .bind(saved.streamId)
      .first();
  const parentBefore = await parentCheckpoint();
  const schedules = async () =>
    (
      await f.db
        .prepare(
          "SELECT branch,start_date,end_date,initial_confirmed_since,version,overflow,split_at FROM inventory_lotw_confirmation_schedule ORDER BY branch",
        )
        .all<{
          branch: string;
          start_date: string | null;
          end_date: string | null;
          initial_confirmed_since: string;
          version: number;
          overflow: number;
          split_at: number | null;
        }>()
    ).results;
  assert.deepEqual(await schedules(), [
    {
      branch: "",
      start_date: null,
      end_date: null,
      initial_confirmed_since: initial,
      version: 3,
      overflow: 1,
      split_at: null,
    },
  ]);
  await f.db
    .prepare(
      `CREATE TRIGGER fixture_qsl_split_failure BEFORE UPDATE OF split_at ON inventory_lotw_confirmation_schedule
     WHEN NEW.split_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture split failure'); END`,
    )
    .run();
  let requests = 0;
  const fetcher: typeof fetch = async (input) => {
    const { searchParams } = new URL(String(input));
    const start = searchParams.get("qso_startdate");
    assert.equal(start, searchParams.get("qso_enddate"));
    assert.equal(searchParams.get("qso_owncall"), selection.stationCallsign);
    assert.equal(searchParams.get("qso_callsign"), selection.workedCallsign);
    assert.equal(searchParams.get("qso_qslsince"), watermark);
    assert.equal(searchParams.get("qso_qsl"), "yes");
    assert.equal(
      start,
      requests === 0 ? selection.startDate : selection.endDate,
    );
    requests++;
    return start === selection.startDate
      ? qsl()
      : new Response(new Uint8Array(2 * 1024 * 1024 + 1));
  };
  const failed = await runLotwConfirmationSchedule(f.store, fetcher);
  assert.equal(failed.failed, 1);
  assert.equal(failed.split, 0);
  assert.equal(requests, 0);
  assert.equal((await schedules()).length, 1);
  assert.equal((await schedules())[0].split_at, null);
  await f.db.prepare("DROP TRIGGER fixture_qsl_split_failure").run();
  await f.db
    .prepare("UPDATE inventory_lotw_confirmation_schedule SET next_due_at=0")
    .run();

  const reports = await Promise.all([
    runLotwConfirmationSchedule(f.store, fetcher),
    runLotwConfirmationSchedule(f.store, fetcher),
  ]);
  assert.equal(
    reports.reduce((sum, report) => sum + report.split, 0),
    1,
  );
  assert.equal(
    reports.reduce((sum, report) => sum + report.polled, 0),
    1,
  );
  assert.equal(
    reports.reduce((sum, report) => sum + report.added, 0),
    0,
  );
  assert.equal(requests, 1);
  const [parent, left, right] = await schedules();
  assert.equal(parent.split_at, Date.now());
  assert.equal(parent.version, 4);
  assert.deepEqual(
    [left, right].map(
      ({ branch, start_date, end_date, initial_confirmed_since }) => [
        branch,
        start_date,
        end_date,
        initial_confirmed_since,
      ],
    ),
    [
      ["0", selection.startDate, selection.startDate, watermark],
      ["1", selection.endDate, selection.endDate, watermark],
    ],
  );
  assert.deepEqual(await parentCheckpoint(), parentBefore);
  const nextSlot = () =>
    f.db
      .prepare("UPDATE inventory_lotw_confirmation_slot SET last_slot=-1")
      .run();
  await nextSlot();
  const singleDay = await runLotwConfirmationSchedule(f.store, fetcher);
  assert.equal(singleDay.held, 1);
  assert.equal(requests, 2);
  await nextSlot();
  await f.db
    .prepare(
      "UPDATE inventory_lotw_confirmation_schedule SET next_due_at=0 WHERE branch='1'",
    )
    .run();
  const stillHeld = await runLotwConfirmationSchedule(f.store, fetcher);
  assert.equal(stillHeld.split, 0);
  assert.equal(stillHeld.polled, 0);
  assert.equal(requests, 2);
  assert.equal((await schedules()).length, 3);
  assert.deepEqual(await parentCheckpoint(), parentBefore);
  assert.equal(
    await f.db
      .prepare("SELECT count(*) AS n FROM inventory_coverage")
      .first("n"),
    0,
  );
  assert.equal(
    await f.db
      .prepare("SELECT count(*) AS n FROM inventory_lotw_confirmations")
      .first("n"),
    1,
  );
});

test("scheduled recurrence respects poll policy and switches to full verification when due", async (t) => {
  const f = await fixture(t);
  await f.store
    .statement(
      "UPDATE connections SET kind='lotw',config='{\"readAccess\":true}' WHERE id='destination'",
    )
    .run();
  await f.store
    .statement("DELETE FROM private_data WHERE connection='destination'")
    .run();
  await (
    await f.store.putPrivate("a", "destination", "v1", "credential", {
      query: { username: "fixture", password: "fixture" },
    })
  ).run();
  const connection = await f.store.connection("a", "destination");
  assert.ok(connection);
  const runtime = await activateInventoryRuntime(f.store);
  const selection = await registerInventorySelection(
    f.store,
    runtime,
    connection,
    {
      provider: "lotw",
      selection: { startDate: "2025-01-01", endDate: "2025-01-01" },
    },
    { pollPeriodMs: 600000, verificationPeriodMs: 86400000 },
  );
  assert.equal((await startInventorySelections(f.store)).started, 1);
  const first = await f.db
    .prepare("SELECT run_id FROM inventory_runs")
    .first<{ run_id: string }>();
  assert.ok(first);
  const runs = new InventoryRuns(new InventoryIngestion(f.store));
  const runner = new InventoryRunner(
    runs,
    async () =>
      new Response("<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:1>0<EOH><APP_LOTW_EOF>"),
    { scheduled: true },
  );
  for (let i = 0; i < 4; i++) {
    const result = await runner.step(await f.due(first.run_id));
    if (result.kind === "complete") break;
  }
  const complete = await runs.load("a", first.run_id);
  assert.equal(complete?.phase, "complete");
  assert.ok(complete && complete.nextDueAt > Date.now() + 590000);
  const policy = await f.db
    .prepare("SELECT next_full_at FROM inventory_scheduled_selections")
    .first<{ next_full_at: number }>();
  assert.ok(policy && policy.next_full_at > Date.now() + 86000000);
  // An empty LoTW selection has no receive stamp, so it repeats a bounded full
  // read; a synthetic valid scoped stamp exercises the independent delta branch.
  await f.store
    .statement(
      "UPDATE inventory_streams SET checkpoint_version=checkpoint_version+1,committed_checkpoint=? WHERE scope_id=? AND stream_id=?",
      JSON.stringify({
        selection: { startDate: "2025-01-01", endDate: "2025-01-01" },
        receivedThrough: "2026-11-07 12:00:00",
      }),
      selection.scope,
      selection.stream,
    )
    .run();
  const next = await runner.step(await f.due(first.run_id));
  assert.equal(next.kind, "started");
  if (next.kind !== "started") assert.fail();
  assert.equal((await runs.load("a", next.run))?.mode, "delta");
  for (let i = 0; i < 3; i++) {
    const result = await runner.step(await f.due(next.run));
    if (result.kind === "complete") break;
  }
  await f.store
    .statement(
      "UPDATE inventory_scheduled_selections SET next_full_at=0,version=version+1",
    )
    .run();
  const verification = await runner.step(await f.due(next.run));
  assert.equal(verification.kind, "started");
  if (verification.kind !== "started") assert.fail();
  assert.equal((await runs.load("a", verification.run))?.mode, "full");
});

test("LoTW recurring phases keep their cadence and honor an existing verification deadline", async () => {
  const now = Date.parse("2026-11-09T00:00:00Z");
  const hour = 3_600_000;
  const period = 2 * hour;
  const identity = ["tenant", "scope", "account-feed"] as const;
  const first = await lotwRecurringDueAt(now, identity, period);
  assert.ok(first >= now + hour && first < now + 3 * hour);
  assert.equal(
    await lotwRecurringDueAt(first + 30_000, identity, period),
    first + period,
  );
  assert.notEqual(
    await lotwRecurringDueAt(now, ["other", "other", "account-feed"], period),
    first,
  );
  const weekly = 7 * 24 * hour;
  const latest = now + 900_000;
  const verification = { periodMs: weekly, existingDeadline: latest };
  assert.equal(
    await lotwRecurringDueAt(now, identity, 600_000, verification),
    latest,
  );
  assert.equal(
    await lotwRecurringDueAt(latest + 1, identity, 600_000, verification),
    latest + 1,
  );
});

test("LoTW account deltas keep their checkpoint through overflow, dated fallback and rearm", async (t) => {
  const f = await fixture(t);
  await f.db
    .prepare(`INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at,config)
    VALUES('a','lotw','lotw','fixture','LoTW','active','v1',1,'{"readAccess":true}')`)
    .run();
  await (
    await f.store.putPrivate("a", "lotw", "v1", "credential", {
      query: { username: "fixture", password: "fixture" },
    })
  ).run();
  const link = await f.store.connection("a", "lotw");
  assert.ok(link);
  const runtime = await activateInventoryRuntime(f.store);
  const datePlan = {
    provider: "lotw",
    selection: { startDate: "2025-01-01", endDate: "2025-01-31" },
  } as const;
  const dated = await registerInventorySelection(
    f.store,
    runtime,
    link,
    datePlan,
    { pollPeriodMs: 600_000 },
  );
  const runs = new InventoryRuns(new InventoryIngestion(f.store));
  const lower = "2026-11-06 12:00:00";
  const through = "2026-11-07 13:10:00";
  const accountReads: string[] = [];
  const datedReads: string[] = [];
  let overflow = false;
  let largerReport: string | undefined;
  const receipt = serializeAdifRecord({
    CALL: "W1AW",
    STATION_CALLSIGN: "N1RWJ",
    QSO_DATE: "20250101",
    TIME_ON: "120000",
    MODE: "CW",
    BAND: "20M",
    QSL_RCVD: "N",
    APP_LOTW_RXQSO: through,
  });
  const runner = new InventoryRunner(
    runs,
    async (input) => {
      const params = new URL(String(input)).searchParams;
      const isDated = params.has("qso_startdate");
      (isDated ? datedReads : accountReads).push(
        params.get("qso_qsorxsince") ?? "",
      );
      if (!isDated && largerReport) return new Response(largerReport);
      if (!isDated && overflow)
        return new Response("x".repeat(2 * 1024 * 1024 + 1));
      const record = isDated || accountReads.length === 1 ? receipt : "";
      return new Response(
        `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:1>${record ? 1 : 0}<APP_LOTW_LASTQSORX:19>${through}<EOH>${record}<APP_LOTW_EOF>`,
      );
    },
    { scheduled: true },
  );
  const active = (stream: string) =>
    f.db
      .prepare(
        "SELECT active_run_id FROM inventory_stream_jobs WHERE stream_id=?",
      )
      .bind(stream)
      .first<string>("active_run_id");
  const coverage = (stream: string) =>
    f.db
      .prepare(
        "SELECT state,kind,epoch,published_run_id FROM inventory_coverage WHERE stream_id=?",
      )
      .bind(stream)
      .first();
  const finish = async (id: string) => {
    for (let i = 0; i < 4; i++) {
      const result = await runner.step(await f.due(id));
      if (result.kind === "complete") return result;
      assert.equal(result.kind, "advanced");
    }
    assert.fail("expected terminal publication");
  };
  const datedStream = await runs.inventory.snapshot(
    "a",
    dated.scope,
    dated.stream,
  );
  const datedLease = await f.store.claim(
    "a",
    `inventory:${dated.scope}`,
    Date.now(),
    90_000,
  );
  assert.ok(datedStream && datedLease);
  // This earlier baseline does not overlap the account feed's lower bound.
  const startedBeforeFeed = Date.parse("2026-11-06T11:00:00Z");
  let datedRun: string;
  try {
    datedRun = (
      await runs.begin({
        stream: datedStream,
        lease: datedLease,
        definition: await planInventoryRun(datedStream, datePlan),
        now: startedBeforeFeed,
      })
    ).id;
  } finally {
    await f.store.release(datedLease);
  }
  assert.ok((await finish(datedRun)).nextDueAt < Date.now() + 601_000);
  const datedCoverage = await coverage(dated.stream);
  assert.deepEqual(datedCoverage, {
    state: "ready",
    kind: "observed_selection",
    epoch: 1,
    published_run_id: datedRun,
  });

  const plan = {
    provider: "lotw",
    selection: { kind: "account_received", initialReceivedSince: lower },
  } as const;
  const selected = await registerInventorySelection(
    f.store,
    runtime,
    link,
    plan,
  );
  const snapshot = () =>
    runs.inventory.snapshot("a", selected.scope, selected.stream);
  await assert.rejects(
    registerInventorySelection(f.store, runtime, link, {
      ...plan,
      selection: {
        ...plan.selection,
        initialReceivedSince: "2026-11-06 11:00:00",
      },
    }),
    /inventory_schedule_binding_changed/,
  );
  const stream = await snapshot();
  assert.ok(stream);
  const definition = await planInventoryRun(stream, plan);
  const lease = await f.store.claim(
    "a",
    `inventory:${selected.scope}`,
    Date.now(),
    90_000,
  );
  assert.ok(lease);
  try {
    await assert.rejects(
      runs.begin({
        stream,
        lease,
        definition: { ...definition, mode: "full" },
      }),
      /require a positive-only stream/,
    );
  } finally {
    await f.store.release(lease);
  }
  assert.equal((await startInventorySelections(f.store)).started, 1);
  const first = await active(selected.stream);
  assert.ok(first);
  assert.equal((await runs.load("a", first))?.mode, "delta");
  assert.equal((await runner.step(await f.due(first))).kind, "advanced");
  assert.deepEqual((await snapshot())?.checkpoint, {});
  const done = await finish(first);
  assert.ok(done.nextDueAt >= Date.now() + 3_590_000);
  assert.ok(done.nextDueAt <= Date.now() + 10_800_000);
  const checkpoint = { selection: plan.selection, receivedThrough: through };
  assert.deepEqual((await snapshot())?.checkpoint, checkpoint);
  assert.deepEqual(await coverage(selected.stream), {
    state: "partial",
    kind: "positive_only",
    epoch: 0,
    published_run_id: null,
  });
  const next = await runner.step(await f.due(first));
  if (next.kind !== "started") assert.fail(JSON.stringify(next));
  assert.equal((await runs.load("a", next.run))?.mode, "delta");
  await finish(next.run);
  assert.deepEqual((await snapshot())?.checkpoint, checkpoint);
  assert.deepEqual(await coverage(dated.stream), datedCoverage);

  const ordinary = await runner.step(await f.due(datedRun));
  assert.ok(ordinary.kind === "started");
  assert.equal((await runs.load("a", ordinary.run))?.mode, "delta");
  assert.ok((await finish(ordinary.run)).nextDueAt < Date.now() + 601_000);
  await f.db
    .prepare(
      "UPDATE inventory_scheduled_selections SET version=version+1,next_full_at=1 WHERE stream_id=?",
    )
    .bind(dated.stream)
    .run();
  const verify = await runner.step(await f.due(ordinary.run));
  assert.ok(verify.kind === "started");
  assert.equal((await runs.load("a", verify.run))?.mode, "full");
  const verified = await finish(verify.run);
  assert.ok(verified.nextDueAt >= Date.now() + 3_590_000);
  assert.ok(verified.nextDueAt <= Date.now() + 7 * 86_400_000);
  const verifiedCoverage = await coverage(dated.stream);
  assert.equal(await restoreLotwDatedPolls(f.store), 0);

  const attempt = await runner.step(await f.due(next.run));
  assert.ok(attempt.kind === "started");
  overflow = true;
  assert.equal((await runner.step(await f.due(attempt.run))).kind, "held");
  assert.equal((await runs.load("a", attempt.run))?.reason, "overflow");
  assert.deepEqual((await snapshot())?.checkpoint, checkpoint);
  assert.deepEqual(await coverage(dated.stream), verifiedCoverage);

  await f.db
    .prepare(`CREATE TRIGGER fixture_ignore_fallback BEFORE UPDATE ON inventory_stream_jobs
    WHEN NEW.next_due_at<OLD.next_due_at AND NEW.state='idle' BEGIN SELECT RAISE(IGNORE); END`)
    .run();
  await assert.rejects(
    restoreLotwDatedPolls(f.store),
    /LoTW dated poll fallback changed/,
  );
  assert.equal(
    (await runs.load("a", verify.run))?.jobVersion,
    verified.workVersion,
  );
  assert.equal(
    await f.db
      .prepare(
        "SELECT count(*) AS n FROM inventory_wakeups WHERE wakeup_id LIKE 'lotw-dated-fallback:%'",
      )
      .first("n"),
    0,
  );
  await f.db.prepare("DROP TRIGGER fixture_ignore_fallback").run();

  const cron = await runHostedScheduled(f.env);
  assert.ok(cron.mode === "inventory_read_only");
  assert.equal(cron.lotwDatedPollsRestored, 1);
  assert.equal(await restoreLotwDatedPolls(f.store), 0);
  const restored = await runs.load("a", verify.run);
  assert.ok(restored && restored.jobVersion === verified.workVersion + 1);
  assert.ok(restored.nextDueAt < Date.now() + 601_000);
  assert.deepEqual(
    await runner.step({
      version: 1,
      tenant: "a",
      scope: dated.scope,
      stream: dated.stream,
      run: verify.run,
      workVersion: verified.workVersion,
    }),
    { kind: "skipped", reason: "stale" },
  );
  const fallback = await runner.step(await f.due(verify.run));
  assert.ok(fallback.kind === "started");
  assert.equal((await runs.load("a", fallback.run))?.mode, "delta");
  assert.ok((await finish(fallback.run)).nextDueAt < Date.now() + 601_000);
  assert.deepEqual(await coverage(dated.stream), verifiedCoverage);
  assert.deepEqual((await snapshot())?.checkpoint, checkpoint);
  assert.deepEqual(accountReads, [lower, through, through]);
  assert.deepEqual(datedReads, ["1900-01-01", through, "1900-01-01", through]);
  assert.equal(
    await f.db
      .prepare("SELECT count(*) AS n FROM inventory_records")
      .first("n"),
    1,
  );

  const held = await runs.load("a", attempt.run);
  assert.ok(held);
  await assert.rejects(
    resumeHeldLotwAccount(runs, "a", held.id),
    /lotw_account_rearm_refused/,
  );
  await f.db
    .prepare(
      "INSERT INTO inventory_fresh_start_lock(id,locked_at,prior_legacy_unsettled,prior_qrz_unsettled,prior_lotw_unsettled) VALUES(1,?,0,0,0)",
    )
    .bind(Date.now())
    .run();
  await f.db
    .prepare(`CREATE TRIGGER fixture_rearm_fails BEFORE INSERT ON inventory_wakeups
    WHEN NEW.wakeup_id LIKE 'lotw-account-rearm:%' BEGIN SELECT RAISE(ABORT,'fixture rearm failed'); END`)
    .run();
  await assert.rejects(
    resumeHeldLotwAccount(runs, "a", held.id),
    /lotw_account_rearm_refused/,
  );
  assert.deepEqual(await runs.load("a", held.id), held);
  assert.equal(
    await f.db
      .prepare("SELECT count(*) AS n FROM inventory_lotw_account_rearms")
      .first("n"),
    0,
  );
  await f.db.prepare("DROP TRIGGER fixture_rearm_fails").run();

  const heldStream = await snapshot();
  await resumeHeldLotwAccount(runs, "a", held.id);
  const reopened = await runs.load("a", held.id);
  assert.ok(
    reopened &&
      reopened.phase === "collecting" &&
      reopened.jobVersion === held.jobVersion + 1,
  );
  assert.deepEqual(await snapshot(), heldStream);
  const health = () =>
    f.db
      .prepare(
        "SELECT healthy_until FROM inventory_lotw_account_feed_status WHERE tenant='a'",
      )
      .first<number>("healthy_until");
  assert.equal(await health(), null);
  const heldWake = {
    version: 1 as const,
    tenant: "a",
    scope: selected.scope,
    stream: selected.stream,
    run: held.id,
    workVersion: held.jobVersion,
  };
  assert.deepEqual(await runner.step(heldWake), {
    kind: "skipped",
    reason: "stale",
  });

  const newest = "2026-11-07 13:11:00";
  const count = 2_200;
  const records = Array.from({ length: count }, (_, i) =>
    serializeAdifRecord({
      CALL: "W1AW",
      STATION_CALLSIGN: "N1RWJ",
      QSO_DATE: "20250101",
      TIME_ON: new Date(Date.UTC(2025, 0, 1, 0, 0, i))
        .toISOString()
        .slice(11, 19)
        .replaceAll(":", ""),
      MODE: "CW",
      BAND: "20M",
      QSL_RCVD: "N",
      APP_LOTW_RXQSO: newest,
      APP_FERRY_FIXTURE_PADDING: "x".repeat(1024),
    }),
  );
  largerReport = `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:4>${count}<APP_LOTW_LASTQSORX:19>${newest}<EOH>${records.join("")}<APP_LOTW_EOF>`;
  assert.ok(
    largerReport.length > 2 * 1024 * 1024 &&
      largerReport.length <= 4 * 1024 * 1024,
  );
  const accepted = await runner.step({
    ...heldWake,
    workVersion: reopened.jobVersion,
  });
  assert.ok(accepted.kind === "advanced" && accepted.receipt.records === count);
  assert.equal(await health(), null);
  assert.deepEqual((await snapshot())?.checkpoint, checkpoint);
  const complete = await runner.step({
    ...heldWake,
    workVersion: accepted.workVersion,
  });
  assert.equal(complete.kind, "complete");
  assert.deepEqual((await snapshot())?.checkpoint, {
    selection: plan.selection,
    receivedThrough: newest,
  });
  assert.ok(await health());
  assert.deepEqual(await coverage(dated.stream), verifiedCoverage);
  assert.deepEqual(accountReads, [lower, through, through, through]);

  // Advance the local admission window and repeat the inclusive large batch.
  await f.db
    .prepare("UPDATE vendor_requests SET window_start=0 WHERE vendor='lotw'")
    .run();
  const recurrence = await runner.step(await f.due(held.id));
  assert.ok(recurrence.kind === "started");
  const repeated = await runner.step(await f.due(recurrence.run));
  assert.ok(repeated.kind === "advanced" && repeated.receipt.records === count);
  assert.equal(repeated.receipt.changed, 0);
  await finish(recurrence.run);
  assert.deepEqual((await snapshot())?.checkpoint, {
    selection: plan.selection,
    receivedThrough: newest,
  });
  assert.equal(accountReads.at(-1), newest);
});

test("a scheduled run cannot substitute a different receipt selection", async (t) => {
  const f = await fixture(t);
  await f.store
    .statement(
      "UPDATE connections SET kind='lotw',config='{\"readAccess\":true}' WHERE id='destination'",
    )
    .run();
  const connection = await f.store.connection("a", "destination");
  assert.ok(connection);
  const runtime = await activateInventoryRuntime(f.store);
  const selected = await registerInventorySelection(
    f.store,
    runtime,
    connection,
    {
      provider: "lotw",
      selection: { startDate: "2025-01-01", endDate: "2025-01-01" },
    },
  );
  const runs = new InventoryRuns(new InventoryIngestion(f.store));
  const stream = await runs.inventory.snapshot(
    "a",
    selected.scope,
    selected.stream,
  );
  assert.ok(stream);
  const lease = await f.store.claim("a", `inventory:${selected.scope}`);
  assert.ok(lease);
  const definition = await planInventoryRun(stream, {
    provider: "lotw",
    selection: { startDate: "2025-01-02", endDate: "2025-01-02" },
  });
  await assert.rejects(
    runs.begin({ stream, lease, definition }),
    /scheduled selection changed/,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) n FROM inventory_runs")
        .first<{ n: number }>()
    )?.n,
    0,
  );
});

test("source client changes restart a full run instead of reviving the old cursor", async (t) => {
  const f = await fixture(t);
  await runHostedScheduled(f.env);
  const old = await f.db
    .prepare(
      "SELECT r.run_id,r.scope_id FROM inventory_runs r JOIN inventory_scopes s ON s.tenant=r.tenant AND s.scope_id=r.scope_id WHERE s.connection_id='source'",
    )
    .first<{ run_id: string; scope_id: string }>();
  assert.ok(old);
  await (
    await f.store.putPrivate("a", "source", "v2", "credential", {
      key: "browser:new",
      secret: "new-secret",
      token: "new-token",
    })
  ).run();
  await f.store
    .statement(
      "UPDATE connections SET credential_version='v2' WHERE id='source'",
    )
    .run();
  const runs = new InventoryRuns(new InventoryIngestion(f.store));
  assert.equal((await runs.load("a", old.run_id))?.phase, "held");
  await f.store
    .statement(
      "UPDATE inventory_registration_progress SET last_tenant='',last_connection=''",
    )
    .run();
  const result = await runHostedScheduled(f.env);
  if (result.mode !== "inventory_read_only") assert.fail();
  assert.equal(result.starts.started, 1);
  const current = await f.db
    .prepare("SELECT active_run_id FROM inventory_stream_jobs WHERE scope_id=?")
    .bind(old.scope_id)
    .first<{ active_run_id: string }>();
  assert.ok(current);
  assert.notEqual(current.active_run_id, old.run_id);
  assert.equal((await runs.load("a", current.active_run_id))?.mode, "full");
});

test("managed scopes bind the runtime generation before inventory reads", async (t) => {
  const f = await fixture(t);
  await f.store
    .statement(
      "UPDATE connections SET config='{\"accountId\":\"source\"}' WHERE id='source'",
    )
    .run();
  await f.store
    .statement("DELETE FROM private_data WHERE connection='source'")
    .run();
  await (
    await f.store.putPrivate("a", "source", "v1", "credential", {
      key: "browser:fixture",
      secret: "fixture-secret",
      token: "fixture-token",
    })
  ).run();
  const inventory = new InventoryIngestion(f.store);
  const runs = new InventoryRuns(inventory);
  await inventory.initialize(
    {
      tenant: "a",
      scope: "source-scope",
      connection: "source",
      provider: "lofi",
      logicalIdentity: "source",
      adapterBinding: "runtime-v1",
      ordering: "numeric",
    },
    "sync",
    "all-v1",
  );
  const runtime = await activateInventoryRuntime(f.store);
  const lease = await f.store.claim("a", "inventory:source-scope");
  assert.ok(lease);
  const unmanaged = await inventory.snapshot("a", "source-scope", "sync");
  assert.ok(unmanaged);
  await assert.rejects(
    runs.begin({
      stream: unmanaged,
      lease,
      definition: await planInventoryRun(unmanaged, { provider: "lofi" }),
    }),
    /inventory runtime reader unavailable/,
  );
  await bindInventoryScopeRuntime(
    f.store,
    "a",
    "source-scope",
    runtime.version,
  );
  await f.store
    .statement(
      "INSERT INTO inventory_scheduled_selections(tenant,scope_id,stream_id,runtime_version,config_version,plan,created_at,poll_period_ms,verification_period_ms) SELECT tenant,scope_id,'sync',runtime_version,config_version,'{\"pageSize\":1000,\"provider\":\"lofi\"}',1,300000,86400000 FROM inventory_scopes WHERE scope_id='source-scope'",
    )
    .run();
  const stream = await inventory.snapshot("a", "source-scope", "sync");
  assert.ok(stream);
  const run = await runs.begin({
    stream,
    lease,
    definition: await planInventoryRun(stream, { provider: "lofi" }),
  });
  await f.store.release(lease);
  let requests = 0;
  const result = await new InventoryRunner(runs, async () => {
    requests++;
    return Response.json({
      account: { uuid: "source" },
      operations: [],
      qsos: [],
      meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
    });
  }).step({
    version: 1,
    tenant: "a",
    scope: "source-scope",
    stream: "sync",
    run: run.id,
    workVersion: run.jobVersion,
  });
  assert.equal(result.kind, "advanced");
  assert.equal(requests, 1);
  await assert.rejects(
    f.store
      .statement(
        "UPDATE inventory_scopes SET runtime_version=0,config_version=config_version+1 WHERE scope_id='source-scope'",
      )
      .run(),
    /runtime changed/,
  );
});
