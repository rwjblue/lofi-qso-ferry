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
