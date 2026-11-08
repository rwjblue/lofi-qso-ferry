import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  inspectManagedInventoryTrial,
  inventoryManagedTrial,
} from "../scripts/inventory-managed-trial.ts";
import type { inventoryTrialAccess } from "../scripts/inventory-run-trial.ts";
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
  for (const name of ["keys.json", "manifest.json", "report.json"])
    assert.equal((await stat(join(report.directory, name))).mode & 0o077, 0);
  assert.equal((await stat(report.directory)).mode & 0o077, 0);
  assert.ok(!JSON.stringify(report).includes("browser:synthetic"));
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
