import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  inspectManagedInventoryTrial,
  inventoryManagedTrial,
} from "../scripts/inventory-managed-trial.ts";
import {
  type inventoryTrialAccess,
  openInventoryTrial,
} from "../scripts/inventory-run-trial.ts";
import { serializeAdifRecord } from "../src/adif.ts";
import {
  InventoryIngestion,
  type InventoryStream,
} from "../src/inventory-ingestion.ts";
import { planInventoryRun } from "../src/inventory-run-plans.ts";
import { InventoryRuns } from "../src/inventory-runs.ts";
import type { Connection } from "../src/store.ts";
import { trialCapture } from "./inventory-trial-capture-fixtures.ts";

const book = {
  bookId: "7",
  stationCallsign: "N1RWJ",
  startDate: "2025-01-01",
  endDate: "2027-12-31",
};
function connection(
  kind: Connection["kind"],
  remote: string,
  config: unknown,
): Connection {
  return {
    tenant: "trial",
    id: kind,
    kind,
    remote_identity: remote,
    label: "synthetic",
    status: "active",
    credential_version: "fixture",
    config: JSON.stringify(config),
    cutover: null,
  };
}
const access: typeof inventoryTrialAccess = async () => ({
  source: connection("lofi", "source", { accountId: "source" }),
  qrz: connection("qrz", "book-7", book),
  lotw: connection("lotw", "synthetic-lotw", { readAccess: true }),
  sourceCredential: {
    key: "browser:synthetic",
    secret: "synthetic",
    token: "synthetic",
  },
  qrzCredential: { apiKey: "synthetic" },
  lotwCredential: { username: "synthetic", password: "synthetic" },
  reportDay: "2026-11-08",
  captureFingerprint: "synthetic-source-access",
});
function transport() {
  const calls = { lofi: 0, qrz: 0, lotw: 0 };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.redirect, "error");
    if (url.hostname === "lofi.ham2k.net") {
      assert.equal(url.pathname, "/v1/sync");
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init.body));
      assert.deepEqual(Object.keys(body), ["meta"]);
      assert.equal(body.meta.sync.qsos.limit, 1000);
      calls.lofi++;
      return Response.json({
        account: { uuid: "source" },
        operations: [{ uuid: "op", stationCall: "N1RWJ", syncedAtMillis: 99 }],
        qsos: [
          {
            uuid: "q1",
            operation: "op",
            syncedAtMillis: 100,
            startAtMillis: Date.parse("2026-11-08T13:00:00Z"),
            their: { call: "W1AW" },
            our: { grid: "FN31" },
            band: "20m",
            mode: "CW",
          },
        ],
        meta: {
          operations: { records_left: 0 },
          qsos: { records_left: 0 },
          suggestedSyncLoopDelay: 0,
        },
      });
    }
    if (url.hostname === "logbook.qrz.com") {
      calls.qrz++;
      const form = init?.body;
      assert.ok(form instanceof URLSearchParams);
      const action = form.get("ACTION");
      assert.ok(action === "STATUS" || action === "FETCH");
      return new Response(
        action === "STATUS"
          ? new URLSearchParams({
              RESULT: "OK",
              BOOKID: "7",
              CALLSIGN: "N1RWJ",
              STARTDATE: book.startDate,
              ENDDATE: book.endDate,
            })
          : "RESULT=OK&COUNT=0&ADIF=",
      );
    }
    assert.equal(url.hostname, "lotw.arrl.org");
    assert.equal(url.pathname, "/lotwuser/lotwreport.adi");
    calls.lotw++;
    return new Response(
      "<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:1>0<EOH><APP_LOTW_EOF>",
    );
  };
  return { calls, fetcher };
}
test("managed trial completes real native selections and reopens without additional reads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ferry-managed-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mock = transport();
  const capture = await trialCapture(root);
  const report = await inventoryManagedTrial(
    { capture, maxRequests: 20, maxDurationMs: 90000 },
    { root, fetcher: mock.fetcher },
  );
  assert.equal(report.stopReason, "quiescent");
  assert.ok(report.sourceAndQrzComplete && report.lotwSelectedDayComplete);
  assert.ok(
    report.originalAccessUnchanged && report.credentialEnvelopesUnchanged,
  );
  assert.equal(report.uploads, 0);
  assert.deepEqual(mock.calls, { lofi: 2, qrz: 4, lotw: 1 });
  assert.equal(report.results.length, 2);
  assert.ok(
    report.results.some(
      (row) => row.provider === "qrz" && row.state === "absent_at_inventory",
    ),
  );
  const reopened = await inspectManagedInventoryTrial(report.directory);
  assert.ok(reopened.sampleDecrypted && reopened.credentialEnvelopesUnchanged);
  assert.deepEqual(reopened.runs, report.runs);
  assert.equal(reopened.requests, 0);
  const local = await openInventoryTrial(report.directory);
  try {
    assert.equal(
      (await local.store.connection("trial", "qrz"))?.remote_identity,
      book.bookId,
    );
  } finally {
    await local.mf.dispose();
  }
  for (const name of [
    "keys.json",
    "manifest.json",
    "report.json",
    "report-1.json",
  ])
    assert.equal((await stat(join(report.directory, name))).mode & 0o077, 0);
  assert.equal((await stat(report.directory)).mode & 0o077, 0);
  assert.ok(!JSON.stringify(report).includes("browser:synthetic"));
});

test("read-only trial stops when the LoFi bearer is rejected without registering", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ferry-managed-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mock = transport();
  const lofiPaths: string[] = [];
  const report = await inventoryManagedTrial(
    { capture: "synthetic", maxRequests: 20, maxDurationMs: 60000 },
    {
      root,
      access,
      async fetcher(input, init) {
        const url = new URL(String(input));
        if (url.hostname === "lofi.ham2k.net") {
          lofiPaths.push(url.pathname);
          return new Response("", { status: 401 });
        }
        return mock.fetcher(input, init);
      },
    },
  );
  assert.equal(report.stopReason, "source_authentication_required");
  assert.deepEqual(lofiPaths, ["/v1/sync"]);
  assert.equal(report.requestsInInvocation.byProvider.lofi, 1);
  assert.ok(report.originalAccessUnchanged);
  assert.equal(report.uploads, 0);
});

test("request-limited trial resumes original baseline jobs in a new runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ferry-managed-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mock = transport();
  const first = await inventoryManagedTrial(
    { capture: "synthetic", maxRequests: 1, maxDurationMs: 20000 },
    { root, access, fetcher: mock.fetcher },
  );
  assert.equal(first.stopReason, "request_limit");
  assert.equal(first.requestsInInvocation.requests, 1);
  const manifestBefore = JSON.parse(
    await readFile(join(first.directory, "manifest.json"), "utf8"),
  );
  const second = await inventoryManagedTrial(
    { resume: first.directory, maxRequests: 20, maxDurationMs: 90000 },
    { access, fetcher: mock.fetcher },
  );
  assert.equal(second.stopReason, "quiescent");
  assert.ok(second.sourceAndQrzComplete && second.lotwSelectedDayComplete);
  assert.equal(second.invocation, 2);
  const manifestAfter = JSON.parse(
    await readFile(join(first.directory, "manifest.json"), "utf8"),
  );
  assert.deepEqual(manifestAfter.initialRuns, manifestBefore.initialRuns);
  assert.equal(
    mock.calls.lofi,
    2,
    "resuming cannot replay an accepted source page",
  );
  const before = { ...mock.calls };
  const third = await inventoryManagedTrial(
    { resume: first.directory, maxRequests: 20, maxDurationMs: 1000 },
    { access, fetcher: mock.fetcher },
  );
  assert.equal(third.stopReason, "quiescent");
  assert.deepEqual(
    mock.calls,
    before,
    "completed selections cannot start another poll",
  );
});

test("resume rejects changed original access before any provider request", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ferry-managed-access-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mock = transport();
  const first = await inventoryManagedTrial(
    { capture: "synthetic", maxRequests: 1, maxDurationMs: 20000 },
    { root, access, fetcher: mock.fetcher },
  );
  let requests = 0;
  await assert.rejects(
    inventoryManagedTrial(
      { resume: first.directory },
      {
        access: async () => ({
          ...(await access("synthetic")),
          captureFingerprint: "changed",
        }),
        fetcher: async () => {
          requests++;
          throw new Error("must not dispatch");
        },
      },
    ),
    /original captured access changed/,
  );
  assert.equal(requests, 0);
  assert.equal((await readdir(root)).length, 1);
});

test("a spent continuation deadline leaves resumable state without service reads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ferry-managed-deadline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let requests = 0;
  const result = await inventoryManagedTrial(
    { capture: "synthetic", maxDurationMs: 1 },
    {
      root,
      access,
      fetcher: async () => {
        requests++;
        throw new Error("deadline spent");
      },
    },
  );
  assert.equal(result.stopReason, "time_limit");
  assert.equal(requests, 0);
  assert.equal(result.requestsInInvocation.requests, 0);
  assert.ok(
    result.originalAccessUnchanged && result.credentialEnvelopesUnchanged,
  );
  const reopened = await inspectManagedInventoryTrial(result.directory);
  assert.equal(reopened.runs.length, 3);
  assert.ok(reopened.runs.every((row) => row.phase === "collecting"));
});

test("held QRZ selections require explicit verification and leave completed source runs alone", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ferry-managed-held-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mock = transport();
  let valid = false;
  const fetcher: typeof fetch = async (input, init) => {
    if (
      new URL(String(input)).hostname === "logbook.qrz.com" &&
      init?.body instanceof URLSearchParams &&
      init.body.get("ACTION") === "FETCH"
    ) {
      mock.calls.qrz++;
      const record = {
        CALL: "W1AW",
        QSO_DATE: "20261108",
        TIME_ON: "1300",
        BAND: "20m",
        MODE: "CW",
        MY_GRIDSQUARE: "FN31",
        APP_QRZLOG_LOGID: "9",
        OPERATOR: book.stationCallsign,
        ...(!valid ? { STATION_CALLSIGN: "W2AW" } : {}),
      };
      return new Response(
        new URLSearchParams({
          RESULT: "OK",
          COUNT: "1",
          ADIF: serializeAdifRecord(record),
        }),
      );
    }
    return mock.fetcher(input, init);
  };
  const first = await inventoryManagedTrial(
    { capture: "synthetic", maxRequests: 20, maxDurationMs: 90000 },
    { root, access, fetcher },
  );
  assert.equal(first.stopReason, "selection_held");
  assert.ok(
    first.runs.some((row) => row.provider === "qrz" && row.phase === "held"),
  );
  const initial = JSON.parse(
    await readFile(join(first.directory, "manifest.json"), "utf8"),
  );
  const before = { ...mock.calls };
  valid = true;
  const held = await inventoryManagedTrial(
    { resume: first.directory, maxDurationMs: 1000 },
    { access, fetcher },
  );
  assert.equal(held.stopReason, "selection_held");
  assert.deepEqual(
    mock.calls,
    before,
    "ordinary resume cannot retry a held run",
  );
  const f = await openInventoryTrial(first.directory);
  let pending: {
    previous: string;
    stream: InventoryStream;
    expectedJobVersion: number;
  };
  try {
    const runs = new InventoryRuns(new InventoryIngestion(f.store));
    const candidates = await Promise.all(
      initial.initialRuns.map((id: string) => runs.load("trial", id)),
    );
    const previous = candidates.find((run) => run?.phase === "held");
    assert.ok(previous);
    const stream = await runs.inventory.snapshot(
      "trial",
      previous.scope,
      previous.streamId,
    );
    assert.ok(stream);
    pending = {
      previous: previous.id,
      stream,
      expectedJobVersion: previous.jobVersion,
    };
  } finally {
    await f.mf.dispose();
  }
  const verified = await inventoryManagedTrial(
    {
      resume: first.directory,
      verifyHeld: true,
      maxRequests: 20,
      maxDurationMs: 90000,
    },
    { access, fetcher },
  );
  assert.equal(verified.stopReason, "quiescent");
  assert.equal(verified.verificationRestarts, 1);
  assert.ok(verified.sourceAndQrzComplete && verified.lotwSelectedDayComplete);
  assert.equal(mock.calls.lofi, before.lofi);
  assert.equal(mock.calls.lotw, before.lotw);
  assert.ok(
    verified.results.some(
      (row) => row.provider === "qrz" && row.state === "matched_existing",
    ),
    JSON.stringify(verified.results),
  );
  const after = JSON.parse(
    await readFile(join(first.directory, "manifest.json"), "utf8"),
  );
  assert.deepEqual(after.initialRuns, initial.initialRuns);
  assert.equal(after.currentRuns.length, 3);
  assert.equal(
    after.currentRuns.filter((id: string) => !initial.initialRuns.includes(id))
      .length,
    1,
  );
  assert.equal(after.pendingVerification, undefined);
  assert.equal(after.verifications.length, 1);
  const reopened = await inspectManagedInventoryTrial(first.directory);
  assert.deepEqual(reopened.runs, verified.runs);

  // Simulate a crash after native begin committed but before its manifest ACK.
  const verification = after.verifications[0];
  const definition = await planInventoryRun(
    pending.stream,
    {
      provider: "qrz",
      book,
      between: [book.startDate, book.endDate],
      pageSize: 250,
    },
    { mode: "full", id: verification.replacement, now: verification.at },
  );
  await writeFile(
    join(first.directory, "manifest.json"),
    JSON.stringify({
      ...initial,
      pendingVerification: { ...pending, at: verification.at, definition },
    }),
    { mode: 0o600 },
  );
  const beforeRecovery = { ...mock.calls };
  const recovered = await inventoryManagedTrial(
    { resume: first.directory, maxDurationMs: 1000 },
    { access, fetcher },
  );
  assert.equal(recovered.stopReason, "quiescent");
  assert.equal(recovered.verificationRestarts, 1);
  assert.ok(recovered.sourceAndQrzComplete);
  assert.deepEqual(
    mock.calls,
    beforeRecovery,
    "lost manifest ACK cannot repeat a scan",
  );
});
