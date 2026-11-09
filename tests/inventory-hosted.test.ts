import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { serializeAdifRecord } from "../src/adif.ts";
import { isComparisonMessage } from "../src/inventory-comparison-continuations.ts";
import {
  runHostedInventoryQueue,
  runHostedScheduled,
} from "../src/inventory-hosted.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import { planInventoryRun } from "../src/inventory-run-plans.ts";
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
  registerSourceCalendarSelections,
  restoreLotwDatedPolls,
  startInventorySelections,
} from "../src/inventory-scheduler.ts";
import { isSourceProofWakeup } from "../src/inventory-source-proof-wakeups.ts";
import { database, seed } from "./helpers.ts";
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
  async function due(runId: string) {
    const runs = new InventoryRuns(new InventoryIngestion(f.store));
    const run = await runs.load("a", runId);
    assert.ok(run);
    await f.store
      .statement(
        "UPDATE inventory_stream_jobs SET work_version=work_version+1,next_due_at=? WHERE tenant='a' AND scope_id=? AND stream_id=?",
        Date.now() - 1,
        run.scope,
        run.streamId,
      )
      .run();
    const current = await runs.load("a", runId);
    assert.ok(current);
    await f.store
      .statement(
        "INSERT INTO inventory_wakeups(tenant,wakeup_id,scope_id,stream_id,run_id,work_version,not_before) VALUES('a',?,?,?,?,?,?)",
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
      tenant: "a",
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

test("off selects the old scheduler only while the database is still legacy", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const legacy = async () => {
    calls++;
    throw new Error("legacy selected");
  };
  await assert.rejects(
    runHostedScheduled({ ...f.env, INVENTORY_RUNTIME_MODE: "off" }, { legacy }),
    /legacy selected/,
  );
  assert.equal(calls, 1);
  await activateInventoryRuntime(f.store);
  assert.deepEqual(
    await runHostedScheduled(
      { ...f.env, INVENTORY_RUNTIME_MODE: "off" },
      { legacy },
    ),
    { mode: "inventory_paused", queued: 0 },
  );
  assert.equal(
    calls,
    1,
    "an environment rollback cannot resume the retired sender",
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

test("a mixed hosted batch advances one read and one comparison turn", async (t) => {
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

test("LoTW account deltas keep their checkpoint and fall back to dated polls on overflow", async (t) => {
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
  assert.ok(done.nextDueAt >= Date.now() + 7_190_000);
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
  assert.ok(verified.nextDueAt > Date.now() + 6 * 86_400_000);
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
