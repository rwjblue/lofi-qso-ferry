import assert from "node:assert/strict";
import test from "node:test";
import { type AdifRecord, serializeAdifRecord } from "../src/adif.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import { InventoryRunner } from "../src/inventory-runner.ts";
import { InventoryRuns } from "../src/inventory-runs.ts";
import type { LoFiCredentials, SourceRecord } from "../src/lofi.ts";
import {
  book,
  contact,
  inventoryRunnerFixture as fixture,
} from "./inventory-runner-fixtures.ts";

function lofi(
  qsos: SourceRecord[] = [],
  operations: SourceRecord[] = [],
  meta: SourceRecord = {},
) {
  return Response.json({
    account: { uuid: "source" },
    qsos,
    operations,
    meta: {
      operations: { records_left: 0 },
      qsos: { records_left: 0 },
      ...meta,
    },
  });
}
function qrz(records: AdifRecord[]) {
  return new Response(
    new URLSearchParams({
      RESULT: "OK",
      COUNT: String(records.length),
      ADIF: records.map(serializeAdifRecord).join(""),
    }),
  );
}
function status() {
  return new Response(
    new URLSearchParams({
      RESULT: "OK",
      DATA: new URLSearchParams({
        BOOKID: book.bookId,
        CALLSIGN: book.stationCallsign,
        START_DATE: book.startDate,
        END_DATE: book.endDate,
      }).toString(),
    }),
  );
}

test("LoFi runner resumes baseline, catch-up and quarantine with durable pacing and exact observations", async (t) => {
  const f = await fixture(t);
  const run = await f.begin();
  const requests: SourceRecord[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(new URL(new Request(input, init).url).pathname, "/v1/sync");
    requests.push(JSON.parse(String(init?.body)));
    return requests.length === 1
      ? lofi(
          [{ uuid: "q1", syncedAtMillis: 100, operation: "op1" }],
          [{ uuid: "op1", syncedAtMillis: 100 }],
          {
            suggestedSyncLoopDelay: 10_000,
            suggestedSyncCheckPeriod: 3_600_000,
          },
        )
      : lofi();
  };
  const runner = new InventoryRunner(f.runs, fetcher);
  const message = await f.wakeup(run.id);
  const first = await runner.step(message);
  assert.equal(first.kind, "advanced");
  assert.equal((await f.runs.load("a", run.id))?.phase, "catchup");
  const after = Date.now();
  const current = await f.runs.load("a", run.id);
  assert.ok(
    current &&
      current.nextDueAt >= after + 19000 &&
      current.nextDueAt < after + 25000,
    "catch-up respects the initial reservation, not the idle hour",
  );
  const witness = await f.db
    .prepare(
      "SELECT record_key,last_observed_at FROM inventory_record_facets ORDER BY record_key",
    )
    .all();
  assert.deepEqual(await runner.step(message), {
    kind: "skipped",
    reason: "stale",
  });
  assert.equal((await runner.step(await f.wakeup(run.id))).kind, "skipped");
  assert.equal(requests.length, 1);
  const restarted = new InventoryRunner(
    new InventoryRuns(new InventoryIngestion(f.store)),
    fetcher,
  );
  const catchup = await restarted.step(await f.due(run.id));
  assert.equal(catchup.kind, "advanced");
  assert.equal((await f.runs.load("a", run.id))?.phase, "quarantining");
  const completed = await f.finish(restarted, run.id);
  assert.ok(completed.nextDueAt > Date.now() + 3_590_000);
  assert.equal(requests.length, 2, "control steps make no vendor calls");
  assert.deepEqual(
    (
      await f.db
        .prepare(
          "SELECT record_key,last_observed_at FROM inventory_record_facets ORDER BY record_key",
        )
        .all()
    ).results,
    witness.results,
  );
  const stream = await f.inventory.snapshot("a", f.scope, "scan");
  assert.ok(stream);
  assert.equal((stream.checkpoint as { mode: string }).mode, "forward");
  const delta = await f.begin("delta");
  assert.deepEqual((await f.inventory.snapshot("a", f.scope, "scan"))?.resume, {
    mode: "forward",
    accountId: "source",
    readerPolicy: "all-clients-v1",
    policyEpoch: run.id,
    operations: { watermark: 100 },
    qsos: { watermark: 100 },
  });
  assert.equal(delta.mode, "delta");
});

test("stale, held, early and leased jobs issue no HTTP", async (t) => {
  const f = await fixture(t);
  const run = await f.begin();
  let requests = 0;
  const runner = new InventoryRunner(f.runs, async () => {
    requests++;
    return lofi();
  });
  const message = await f.wakeup(run.id);
  assert.equal(
    (await runner.step({ ...message, workVersion: message.workVersion + 1 }))
      .kind,
    "skipped",
  );
  const lease = await f.store.claim("a", `inventory:${f.scope}`);
  assert.ok(lease);
  assert.equal((await runner.step(message)).kind, "skipped");
  await f.store.release(lease);
  await f.store
    .statement(
      "UPDATE inventory_scopes SET config_version=config_version+1 WHERE tenant='a'",
    )
    .run();
  assert.deepEqual(await runner.step(message), {
    kind: "skipped",
    reason: "stale",
  });
  assert.equal(requests, 0);
});

test("QRZ catch-up resets LOGID and next incremental run resets it again", async (t) => {
  const f = await fixture(t, "qrz");
  const run = await f.begin();
  const selections: string[] = [];
  let pages = 0;
  const runner = new InventoryRunner(f.runs, async (input, init) => {
    const form = new URLSearchParams(await new Request(input, init).text());
    if (form.get("ACTION") === "STATUS") return status();
    assert.equal(form.get("ACTION"), "FETCH");
    selections.push(form.get("OPTION") ?? "");
    pages++;
    return qrz(
      pages === 1
        ? [contact, { ...contact, APP_QRZLOG_LOGID: "2" }]
        : pages === 2
          ? [{ ...contact, APP_QRZLOG_LOGID: "3" }]
          : [contact],
    );
  });
  const initial = await runner.step(await f.wakeup(run.id));
  assert.equal(initial.kind, "advanced", JSON.stringify(initial));
  assert.equal((await f.runs.load("a", run.id))?.phase, "collecting");
  await runner.step(await f.wakeup(run.id));
  assert.equal((await f.runs.load("a", run.id))?.phase, "catchup");
  assert.deepEqual(
    (await f.inventory.snapshot("a", f.scope, "scan"))?.resume,
    {},
  );
  await runner.step(await f.wakeup(run.id));
  await f.finish(runner, run.id);
  assert.match(selections[1], /AFTERLOGID:3/);
  assert.match(selections[2], /AFTERLOGID:0/);
  assert.match(selections[2], /MODSINCE:/);
  const delta = await f.begin("delta");
  await runner.step(await f.wakeup(delta.id));
  assert.match(selections[3], /AFTERLOGID:0/);
  assert.match(selections[3], /MODSINCE:/);
  await f.finish(runner, delta.id);
  const coverage = await f.runs.coverage(
    "a",
    f.scope,
    "scan",
    "receipt",
    delta.partition,
  );
  assert.equal(coverage?.epoch, 1);
  assert.equal(coverage?.published_run_id, run.id);
});

test("narrow QRZ verification can repeat the complete selection for catch-up", async (t) => {
  const f = await fixture(t, "qrz");
  if (f.plan.provider !== "qrz") assert.fail();
  f.plan.repeatSelectionCatchup = true;
  f.plan.pageSize = 3;
  const run = await f.begin();
  const options: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = init?.body as URLSearchParams;
    if (body.get("ACTION") === "STATUS") return status();
    assert.equal(body.get("ACTION"), "FETCH");
    options.push(body.get("OPTION") ?? "");
    return qrz(
      options.length === 1
        ? [contact]
        : [contact, { ...contact, APP_QRZLOG_LOGID: "2" }],
    );
  };
  const reader = new InventoryRunner(f.runs, fetcher);
  assert.equal((await reader.step(await f.wakeup(run.id))).kind, "advanced");
  assert.equal((await f.runs.load("a", run.id))?.phase, "catchup");
  const reopened = new InventoryRunner(new InventoryRuns(f.inventory), fetcher);
  await f.finish(reopened, run.id);
  assert.equal(options.length, 2);
  assert.equal(options[0], options[1]);
  assert.match(options[0], /BETWEEN:2026-11-01\+2026-11-14/);
  assert.doesNotMatch(options[0], /MODSINCE/);
  assert.equal(
    await f.db
      .prepare("SELECT count(*) AS n FROM inventory_records")
      .first("n"),
    2,
  );
  assert.equal(
    await f.db.prepare("SELECT state FROM inventory_coverage").first("state"),
    "ready",
  );
});

test("QRZ full catch-up verifies an ambiguous modified selection before publishing coverage", async (t) => {
  const f = await fixture(t, "qrz");
  assert.ok(f.plan.provider === "qrz");
  f.plan.pageSize = 3;
  const run = await f.begin();
  const current = Array.from({ length: 4 }, (_, i) => ({
    ...contact,
    APP_QRZLOG_LOGID: String(i + 1),
  }));
  const options: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const form = init?.body as URLSearchParams;
    if (form.get("ACTION") === "STATUS") return status();
    assert.equal(form.get("ACTION"), "FETCH");
    const option = form.get("OPTION") ?? "";
    options.push(option);
    if (options.length === 1) return qrz([contact]);
    if (option.includes("MODSINCE:"))
      return new Response("RESULT=FAIL&COUNT=0");
    const after = Number(/AFTERLOGID:(\d+)/.exec(option)?.[1]);
    return qrz(
      current
        .filter((row) => Number(row.APP_QRZLOG_LOGID) >= after)
        .slice(0, 3),
    );
  };
  const reader = new InventoryRunner(f.runs, fetcher);
  const baseline = await reader.step(await f.wakeup(run.id));
  assert.equal(baseline.kind, "advanced");
  assert.equal(baseline.phase, "catchup");
  const checkpoint = (await f.inventory.snapshot("a", f.scope, "scan"))
    ?.checkpoint;
  const cover = await reader.step(await f.wakeup(run.id));
  assert.equal(cover.kind, "advanced");
  assert.equal(cover.phase, "catchup");
  assert.equal(cover.usage?.requests, 3);
  const reopened = new InventoryRunner(new InventoryRuns(f.inventory), fetcher);
  const terminal = await reopened.step(await f.wakeup(run.id));
  assert.equal(terminal.kind, "advanced");
  assert.equal(terminal.phase, "quarantining");
  assert.deepEqual(
    (await f.inventory.snapshot("a", f.scope, "scan"))?.checkpoint,
    checkpoint,
  );
  assert.equal(
    (await f.runs.coverage("a", f.scope, "scan", "receipt", run.partition))
      ?.state,
    "collecting",
  );
  assert.equal(options.length, 4);
  assert.match(options[1], /AFTERLOGID:0.*MODSINCE:/);
  assert.equal(options[2], options[0]);
  assert.match(options[3], /AFTERLOGID:4/);
  assert.doesNotMatch(options[3], /MODSINCE:/);
  const completedAfter = Date.now();
  const completed = await f.finish(reopened, run.id);
  assert.ok(completed.nextDueAt >= completedAfter + 86_400_000);
  const coverage = await f.runs.coverage(
    "a",
    f.scope,
    "scan",
    "receipt",
    run.partition,
  );
  assert.equal(coverage?.published_run_id, run.id);
  assert.equal(coverage?.state, "ready");
  assert.equal(
    await f.db
      .prepare(
        "SELECT count(*) AS n FROM inventory_partition_membership WHERE state='present'",
      )
      .first("n"),
    4,
  );
});

test("LoTW runner keeps receipt checkpoints scoped and does not advance on an empty delta", async (t) => {
  const f = await fixture(t, "lotw");
  const run = await f.begin();
  let calls = 0;
  const lower: (string | null)[] = [];
  const runner = new InventoryRunner(f.runs, async (input) => {
    calls++;
    const params = new URL(String(input)).searchParams;
    lower.push(params.get("qso_qsorxsince"));
    const rows =
      calls === 1
        ? [{ ...contact, APP_LOTW_RXQSO: "2026-11-07 13:10:00" }]
        : [];
    return new Response(
      `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:1>${rows.length}<APP_LOTW_LASTQSORX:19>2026-11-07 13:10:00<EOH>${rows.map(serializeAdifRecord).join("")}<APP_LOTW_EOF>`,
    );
  });
  const first = await runner.step(await f.wakeup(run.id));
  assert.equal(first.kind, "advanced", JSON.stringify(first));
  await f.finish(runner, run.id);
  const before = (await f.inventory.snapshot("a", f.scope, "scan"))?.checkpoint;
  const delta = await f.begin("delta");
  await runner.step(await f.wakeup(delta.id));
  await f.finish(runner, delta.id);
  assert.equal(lower[1], "2026-11-07 13:10:00");
  assert.deepEqual(
    (await f.inventory.snapshot("a", f.scope, "scan"))?.checkpoint,
    before,
  );
});

test("vendor cooldown defers atomically without advancing the source cursor", async (t) => {
  const f = await fixture(t);
  const run = await f.begin();
  const before = (await f.inventory.snapshot("a", f.scope, "scan"))?.resume;
  const result = await new InventoryRunner(
    f.runs,
    async () =>
      new Response("", { status: 429, headers: { "Retry-After": "60" } }),
  ).step(await f.wakeup(run.id));
  assert.equal(result.kind, "deferred");
  assert.equal((await f.runs.load("a", run.id))?.phase, "collecting");
  assert.deepEqual(
    (await f.inventory.snapshot("a", f.scope, "scan"))?.resume,
    before,
  );
  assert.ok((await f.runs.load("a", run.id))!.nextDueAt > Date.now() + 50_000);
});

test("a paced 401 persists invalidation, then renewed credentials, across turns", async (t) => {
  const f = await fixture(t);
  const run = await f.begin();
  const paths: string[] = [];
  const runner = new InventoryRunner(f.runs, async (input, init) => {
    const request = new Request(input, init);
    paths.push(new URL(request.url).pathname);
    if (paths.length === 1) return new Response("", { status: 401 });
    if (new URL(request.url).pathname === "/v1/client")
      return Response.json({ token: "new-bearer" });
    assert.equal(request.headers.get("Authorization"), "Bearer new-bearer");
    return lofi();
  });
  assert.equal((await runner.step(await f.wakeup(run.id))).kind, "deferred");
  assert.equal(
    (await f.store.private<LoFiCredentials>("a", "source", "v1", "credential"))
      ?.token,
    undefined,
  );
  assert.equal((await runner.step(await f.due(run.id))).kind, "deferred");
  assert.equal(
    (await f.store.private<LoFiCredentials>("a", "source", "v1", "credential"))
      ?.token,
    "new-bearer",
  );
  assert.equal((await runner.step(await f.due(run.id))).kind, "advanced");
  assert.deepEqual(paths, ["/v1/sync", "/v1/client", "/v1/sync"]);
});

test("a source changed during HTTP rolls the page back instead of refreshing its context", async (t) => {
  const f = await fixture(t);
  const run = await f.begin();
  let calls = 0;
  const runner = new InventoryRunner(f.runs, async () => {
    calls++;
    await f.store
      .statement(
        "UPDATE inventory_scopes SET config_version=config_version+1 WHERE tenant='a'",
      )
      .run();
    return lofi([{ uuid: "q1", syncedAtMillis: 100 }]);
  });
  await assert.rejects(
    runner.step(await f.wakeup(run.id)),
    /inventory (authority|run) changed/,
  );
  assert.equal(calls, 1);
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS n FROM inventory_records")
        .first<{ n: number }>()
    )?.n,
    0,
  );
  assert.equal((await f.runs.load("a", run.id))?.phase, "held");
});

test("ambiguous QRZ absence holds the run without publishing coverage", async (t) => {
  const f = await fixture(t, "qrz");
  const run = await f.begin();
  const runner = new InventoryRunner(f.runs, async (input, init) => {
    const form = new URLSearchParams(await new Request(input, init).text());
    return form.get("ACTION") === "STATUS"
      ? status()
      : new Response("RESULT=FAIL&COUNT=0");
  });
  assert.equal((await runner.step(await f.wakeup(run.id))).kind, "held");
  const coverage = await f.runs.coverage(
    "a",
    f.scope,
    "scan",
    "receipt",
    run.partition,
  );
  assert.equal(coverage?.state, "held");
  assert.equal(coverage?.epoch, 0);
});

test("a multi-page QRZ delta fallback resumes and retains full coverage and older receipts", async (t) => {
  const f = await fixture(t, "qrz");
  assert.ok(f.plan.provider === "qrz");
  f.plan.pageSize = 3;
  const baseline = await f.begin();
  const other = { ...contact, APP_QRZLOG_LOGID: "2", CALL: "W2AW" };
  const added = { ...contact, APP_QRZLOG_LOGID: "3", CALL: "W3AW" };
  const current = [
    contact,
    added,
    { ...added, APP_QRZLOG_LOGID: "4" },
    { ...added, APP_QRZLOG_LOGID: "5" },
    { ...added, APP_QRZLOG_LOGID: "6" },
    { ...added, APP_QRZLOG_LOGID: "7" },
  ];
  const options: string[] = [];
  let isDelta = false;
  let interrupted = false;
  let persistFailure = false;
  const fetcher: typeof fetch = async (input, init) => {
    const form = new URLSearchParams(await new Request(input, init).text());
    if (form.get("ACTION") === "STATUS") return status();
    assert.equal(form.get("ACTION"), "FETCH");
    const option = form.get("OPTION") ?? "";
    if (isDelta) options.push(option);
    if (option.includes("MODSINCE:"))
      return isDelta ? new Response("RESULT=FAIL&COUNT=0") : qrz([]);
    const after = Number(/AFTERLOGID:(\d+)/.exec(option)?.[1]);
    const max = Number(/MAX:(\d+)/.exec(option)?.[1]);
    if (!isDelta) return qrz([contact, other]);
    if (after === 5 && max === 3 && (persistFailure || !interrupted)) {
      interrupted = true;
      return new Response("RESULT=FAIL&REASON=fixture_failure");
    }
    const page = current
      .filter((row) => Number(row.APP_QRZLOG_LOGID) >= after)
      .slice(0, max);
    return page.length ? qrz(page) : new Response("RESULT=FAIL&COUNT=0");
  };
  const runner = new InventoryRunner(f.runs, fetcher);
  await f.finish(runner, baseline.id);
  isDelta = true;
  const delta = await f.begin("delta");
  const checkpoint = (await f.inventory.snapshot("a", f.scope, "scan"))
    ?.checkpoint;
  const recovered = await runner.step(await f.wakeup(delta.id));
  assert.equal(recovered.kind, "advanced");
  assert.equal(recovered.usage?.requests, 3);
  assert.equal((await f.runs.load("a", delta.id))?.phase, "collecting");
  assert.deepEqual(
    (await f.inventory.snapshot("a", f.scope, "scan"))?.checkpoint,
    checkpoint,
  );
  const reopened = new InventoryRunner(new InventoryRuns(f.inventory), fetcher);
  const beforeRetry = (await f.inventory.snapshot("a", f.scope, "scan"))
    ?.resume;
  const retry = await reopened.step(await f.wakeup(delta.id));
  assert.equal(retry.kind, "deferred");
  assert.equal((await f.runs.load("a", delta.id))?.reason, "qrz_cover_retry");
  assert.deepEqual(
    (await f.inventory.snapshot("a", f.scope, "scan"))?.resume,
    beforeRetry,
  );
  await f.due(delta.id);
  for (const [requests, phase] of [
    [2, "collecting"],
    [3, "collecting"],
    [2, "publishing"],
  ] as const) {
    const result = await reopened.step(await f.wakeup(delta.id));
    assert.equal(result.kind, "advanced");
    assert.equal(result.usage?.requests, requests);
    assert.equal(result.phase, phase);
    assert.deepEqual(
      (await f.inventory.snapshot("a", f.scope, "scan"))?.checkpoint,
      checkpoint,
    );
  }
  assert.equal(options.length, 7);
  assert.match(options[0], /AFTERLOGID:0.*MODSINCE:/);
  assert.deepEqual(
    options
      .slice(1)
      .map((option) => /MAX:\d+,AFTERLOGID:\d+/.exec(option)?.[0]),
    [
      "MAX:3,AFTERLOGID:0",
      "MAX:3,AFTERLOGID:5",
      "MAX:3,AFTERLOGID:5",
      "MAX:3,AFTERLOGID:8",
      "MAX:2,AFTERLOGID:5",
      "MAX:2,AFTERLOGID:7",
    ],
  );
  assert.doesNotMatch(options.slice(1).join(" "), /MODSINCE:/);
  const completedAfter = Date.now();
  await f.finish(reopened, delta.id);
  assert.ok(
    ((await f.runs.load("a", delta.id))?.nextDueAt ?? 0) >=
      completedAfter + 86_400_000,
  );
  const coverage = await f.runs.coverage(
    "a",
    f.scope,
    "scan",
    "receipt",
    delta.partition,
  );
  assert.equal(coverage?.state, "ready");
  assert.equal(coverage?.published_run_id, baseline.id);
  assert.equal(coverage?.epoch, 1);
  assert.equal(
    await f.db
      .prepare("SELECT delta_run_id FROM inventory_coverage")
      .first("delta_run_id"),
    delta.id,
  );
  assert.deepEqual(
    (
      await f.db
        .prepare(
          "SELECT state,count(*) AS records FROM inventory_partition_membership GROUP BY state",
        )
        .all()
    ).results,
    [{ state: "present", records: 7 }],
  );

  persistFailure = true;
  const failed = await f.begin("delta");
  const beforeFailure = (await f.inventory.snapshot("a", f.scope, "scan"))
    ?.checkpoint;
  assert.equal(
    (await reopened.step(await f.wakeup(failed.id))).kind,
    "advanced",
  );
  assert.equal(
    (await reopened.step(await f.wakeup(failed.id))).kind,
    "deferred",
  );
  assert.equal((await reopened.step(await f.due(failed.id))).kind, "held");
  assert.deepEqual(
    (await f.inventory.snapshot("a", f.scope, "scan"))?.checkpoint,
    beforeFailure,
  );
});

test("QRZ terminal-page recovery fits the runner request budget and persists the smaller page", async (t) => {
  const f = await fixture(t, "qrz");
  assert.ok(f.plan.provider === "qrz");
  f.plan.pageSize = 250;
  const run = await f.begin();
  const records = Array.from({ length: 250 }, (_, i) => ({
    ...contact,
    APP_QRZLOG_LOGID: String(i + 1),
  }));
  const requests: { action: string; option: string }[] = [];
  const runner = new InventoryRunner(f.runs, async (input, init) => {
    const form = new URLSearchParams(await new Request(input, init).text());
    const action = form.get("ACTION") ?? "",
      option = form.get("OPTION") ?? "";
    requests.push({ action, option });
    if (action === "STATUS") return status();
    assert.equal(action, "FETCH");
    if (option.includes("MODSINCE:")) return qrz([]);
    const after = Number(/AFTERLOGID:(\d+)/.exec(option)?.[1] ?? 0);
    const limit = Number(/MAX:(\d+)/.exec(option)?.[1]);
    const page = records
      .filter((record) => Number(record.APP_QRZLOG_LOGID) >= after)
      .slice(0, limit);
    return page.length ? qrz(page) : new Response("RESULT=FAIL&COUNT=0");
  });
  assert.equal((await runner.step(await f.wakeup(run.id))).kind, "advanced");
  assert.equal(requests.length, 2);
  const boundary = requests.length;
  assert.equal((await runner.step(await f.wakeup(run.id))).kind, "advanced");
  assert.equal(
    requests.length - boundary,
    3,
    "STATUS, rejected empty read and smaller replay share one bounded turn",
  );
  const stream = await f.inventory.snapshot("a", f.scope, "scan");
  assert.ok(stream);
  assert.equal((stream.resume as { pageSize: number }).pageSize, 249);
  assert.equal((stream.resume as { afterLogId: number }).afterLogId, 250);
  const tail = requests.length;
  assert.equal((await runner.step(await f.wakeup(run.id))).kind, "advanced");
  assert.equal(requests.length - tail, 2);
  assert.match(requests.at(-1)!.option, /MAX:249/);
  assert.match(requests.at(-1)!.option, /AFTERLOGID:250/);
  assert.equal((await f.runs.load("a", run.id))?.phase, "catchup");
  await f.finish(runner, run.id);
  assert.equal((await f.runs.load("a", run.id))?.phase, "complete");
  assert.deepEqual(
    await f.db.prepare("SELECT count(*) AS n FROM inventory_records").first(),
    { n: 250 },
  );
});
