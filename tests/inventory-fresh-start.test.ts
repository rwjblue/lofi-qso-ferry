import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  inventoryFreshStart,
  refreshFreshStartLoFi,
} from "../scripts/inventory-fresh-start.ts";
import {
  rebuildFreshStart,
  restartHeldLoFiSource,
  resumeHeldQrzCover,
} from "../scripts/inventory-fresh-start-rebuild.ts";
import { openInventoryTrial } from "../scripts/inventory-run-trial.ts";
import { createInventoryTrialTransport } from "../scripts/inventory-trial-transport.ts";
import { serializeAdifRecord } from "../src/adif.ts";
import { InventoryComparisonPages } from "../src/inventory-comparison-pages.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import { InventoryQrzDispatch } from "../src/inventory-qrz-dispatch.ts";
import { planInventoryRun } from "../src/inventory-run-plans.ts";
import { InventoryRunner } from "../src/inventory-runner.ts";
import { InventoryRuns } from "../src/inventory-runs.ts";
import { inventoryRuntime } from "../src/inventory-runtime.ts";
import {
  registerInventorySelection,
  startInventorySelections,
} from "../src/inventory-scheduler.ts";
import { openSourceCredentials } from "../src/source-credentials.ts";
import { applyMigration } from "./helpers.ts";
import { trialCapture } from "./inventory-trial-capture-fixtures.ts";

test("a fresh account copy retains credential bindings and quarantines prior unsettled work", async (t) => {
  const root = await mkdtemp(`${tmpdir()}/ferry-fresh-account-`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = await trialCapture(root);
  const prior = await openInventoryTrial(directory);
  try {
    await applyMigration(prior.db, "0006_account_templates.sql");
    await prior.db.batch([
      prior.store.statement(
        "INSERT INTO passkeys(id,tenant,public_key,counter,metadata,label,created_at) VALUES('credential','trial','fixture-public-key',8,'{}','Test passkey',1)",
      ),
      prior.store.statement(
        "INSERT INTO sessions(token_hash,tenant,credential_id,created_at,verified_at,expires_at) VALUES('old-session','trial','credential',1,1,?)",
        Date.now() + 60000,
      ),
      prior.store.statement(
        "INSERT INTO account_templates VALUES('trial','default','{}',1)",
      ),
      prior.store.statement(
        "INSERT INTO active_account_templates VALUES('trial','default')",
      ),
      prior.store.statement(
        "INSERT INTO templates VALUES('trial','qrz','per-book','{}',1)",
      ),
      prior.store.statement(
        "INSERT INTO active_templates VALUES('trial','qrz','per-book')",
      ),
      prior.store.statement(
        "UPDATE connections SET last_poll_at=42,cutover='old-selection'",
      ),
      prior.store.statement(
        "INSERT INTO cursors VALUES('trial','lofi','context','{}',2,1)",
      ),
      prior.store.statement(
        "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,due_at,updated_at) VALUES('trial','lofi','old-qso','qrz','generation','hash',1,1)",
      ),
      prior.store.statement(
        "INSERT INTO attempts VALUES('trial','old-attempt','lofi','old-qso','qrz','generation','body','digest',NULL,'fixture',1,'hash')",
      ),
      prior.store.statement(
        "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('trial','old-attempt','uncertain',1,1)",
      ),
      await prior.store.putPrivate("trial", "qrz", "body", "outbox", {
        discarded: true,
      }),
    ]);
  } finally {
    await prior.mf.dispose();
  }
  const report = await inventoryFreshStart(directory, root);
  assert.deepEqual(report.decrypted, { lofi: 1, qrz: 1, lotw: 1 });
  assert.deepEqual(report.priorUnsettled, {
    legacy: 1,
    qrz: 0,
    lotwBatches: 0,
  });
  assert.equal(report.passkeys, 1);
  assert.equal(report.contactStateEmpty, true);
  assert.equal((await stat(report.directory)).mode & 0o077, 0);
  const fresh = await openInventoryTrial(report.directory);
  try {
    assert.equal(
      (await inventoryRuntime(fresh.store)).mode,
      "inventory_read_only",
    );
    assert.deepEqual(
      await fresh.db
        .prepare("SELECT id,counter,public_key FROM passkeys")
        .first(),
      { id: "credential", counter: 8, public_key: "fixture-public-key" },
    );
    assert.deepEqual(
      await fresh.db
        .prepare("SELECT last_poll_at,cutover FROM connections WHERE id='qrz'")
        .first(),
      { last_poll_at: null, cutover: null },
    );
    assert.equal(
      await fresh.db
        .prepare("SELECT version FROM active_templates")
        .first("version"),
      "per-book",
    );
    assert.equal(
      await fresh.db
        .prepare("SELECT version FROM active_account_templates")
        .first("version"),
      "default",
    );
    assert.deepEqual(
      await fresh.store.private("trial", "lotw", "fixture", "credential"),
      { query: { username: "synthetic", password: "synthetic" } },
    );
    assert.equal(
      await fresh.db
        .prepare(
          "SELECT count(*) AS n FROM private_data WHERE kind!='credential'",
        )
        .first("n"),
      0,
    );
    const sender = new InventoryQrzDispatch(fresh.store, async () =>
      assert.fail("a fresh rehearsal must not contact the sender"),
    );
    assert.deepEqual(
      await sender.send("trial", "old-attempt", () => ({
        exportsEnabled: true,
        liveWriteAuthorized: true,
        qrzFreshInsertsEnabled: true,
        allowedQsoIds: null,
        allowedDestinationIds: null,
      })),
      { kind: "held", reason: "fresh_start_requires_cutover" },
    );
    await assert.rejects(
      fresh.db.prepare("DELETE FROM inventory_fresh_start_lock").run(),
      /audited cutover/,
    );
    await assert.rejects(
      fresh.db
        .prepare(
          `INSERT INTO inventory_qrz_dispatch_guards(singleton,tenant,attempt_id,claim_id,observation_id,request_hash,lease_token,lease_fence,expires_at)
         VALUES(1,'trial','old-attempt','claim','observation','digest','token',1,?)`,
        )
        .bind(Date.now() + 60_000)
        .run(),
      /fresh start requires an audited cutover/,
    );
  } finally {
    await fresh.mf.dispose();
  }
  const reopened = await openInventoryTrial(directory);
  try {
    assert.equal(
      await reopened.db
        .prepare("SELECT state FROM attempt_state")
        .first("state"),
      "uncertain",
    );
    assert.equal(
      await reopened.db
        .prepare("SELECT count(*) AS n FROM inventory_records")
        .first("n"),
      1,
    );
  } finally {
    await reopened.mf.dispose();
  }
});

test("a write-locked rebuild can finish and poll destinations while LoFi waits for authentication", async (t) => {
  const root = await mkdtemp(`${tmpdir()}/ferry-fresh-rebuild-`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await trialCapture(root);
  const captured = await openInventoryTrial(snapshot);
  try {
    await applyMigration(captured.db, "0006_account_templates.sql");
    await captured.db
      .prepare("UPDATE connections SET remote_identity='7' WHERE kind='qrz'")
      .run();
  } finally {
    await captured.mf.dispose();
  }
  const { directory } = await inventoryFreshStart(snapshot, root);
  const requests: string[] = [];
  const qrzOptions: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.redirect, "error");
    if (url.hostname === "lofi.ham2k.net") {
      assert.equal(url.pathname, "/v1/sync");
      requests.push("lofi");
      return new Response(null, { status: 401 });
    }
    if (url.hostname === "logbook.qrz.com") {
      requests.push("qrz");
      const form = init?.body;
      assert.ok(form instanceof URLSearchParams);
      const action = form.get("ACTION");
      assert.ok(action === "STATUS" || action === "FETCH");
      if (action === "FETCH") qrzOptions.push(form.get("OPTION") ?? "");
      return new Response(
        action === "STATUS"
          ? "RESULT=OK&BOOKID=7&CALLSIGN=N1RWJ&STARTDATE=2025-01-01&ENDDATE=2027-12-31"
          : "RESULT=OK&COUNT=0&ADIF=",
      );
    }
    assert.equal(url.hostname, "lotw.arrl.org");
    assert.equal(url.pathname, "/lotwuser/lotwreport.adi");
    if (!url.searchParams.has("qso_startdate"))
      assert.equal(
        url.searchParams.get("qso_qsorxsince"),
        "2026-11-07 12:00:00",
      );
    requests.push("lotw");
    return new Response(
      "<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:1>0<EOH><APP_LOTW_EOF>",
    );
  };
  const report = await rebuildFreshStart(
    {
      rehearsal: directory,
      selections: [
        { connection: "lofi" },
        { connection: "qrz" },
        { connection: "lotw", from: "2026-11-01", through: "2026-11-30" },
        { connection: "lotw", receivedSince: "2026-11-07 12:00:00" },
      ],
      maxRequests: 10,
      maxDurationMs: 60_000,
    },
    { fetcher },
  );
  assert.equal(report.stopReason, "source_authentication_required");
  assert.equal(report.sourceAuthenticationRequired, true);
  assert.equal(report.writeLocked, true);
  assert.equal(report.uploads, 0);
  assert.equal(report.destinationCredentialEnvelopesUnchanged, true);
  assert.ok(
    requests
      .slice(requests.indexOf("lofi") + 1)
      .some((request) => request !== "lofi"),
  );
  assert.deepEqual(report.requests.byProvider, { lofi: 1, qrz: 4, lotw: 2 });
  assert.deepEqual(
    report.coverage.map(({ provider, phase, state, published }) => ({
      provider,
      phase,
      state,
      published,
    })),
    [
      {
        provider: "lofi",
        phase: "collecting",
        state: "collecting",
        published: 0,
      },
      { provider: "lotw", phase: "complete", state: "partial", published: 0 },
      { provider: "lotw", phase: "complete", state: "ready", published: 1 },
      { provider: "qrz", phase: "complete", state: "ready", published: 1 },
    ],
  );
  // Make one completed selection due without waiting for its real poll period.
  const saved = await openInventoryTrial(directory);
  try {
    await saved.db.batch([
      saved.db.prepare(
        `UPDATE inventory_stream_jobs SET work_version=work_version+1,next_due_at=1
         WHERE state='idle' AND scope_id IN (SELECT scope_id FROM inventory_scopes WHERE provider='qrz')`,
      ),
      saved.db.prepare(
        `INSERT INTO inventory_wakeups(tenant,wakeup_id,scope_id,stream_id,run_id,work_version,not_before)
         SELECT j.tenant,'fixture-qrz-poll',j.scope_id,j.stream_id,w.run_id,j.work_version,j.next_due_at
         FROM inventory_stream_jobs j JOIN inventory_wakeups w
           ON (w.tenant,w.scope_id,w.stream_id,w.work_version)=(j.tenant,j.scope_id,j.stream_id,j.work_version-1)
         WHERE j.next_due_at=1`,
      ),
    ]);
  } finally {
    await saved.mf.dispose();
  }
  const reopened = await rebuildFreshStart(
    { rehearsal: directory, maxRequests: 1, maxDurationMs: 1000 },
    {
      fetcher: async () =>
        assert.fail(
          "completed selections and a missing bearer need no network",
        ),
    },
  );
  assert.equal(reopened.stopReason, "source_authentication_required");
  assert.equal(reopened.requests.requests, 0);
  assert.deepEqual(reopened.coverage, report.coverage);
  const sourceOnly = await rebuildFreshStart(
    {
      rehearsal: directory,
      lofiOnly: true,
      pollDue: true,
      maxRequests: 1,
      maxDurationMs: 1000,
    },
    {
      fetcher: async () =>
        assert.fail("a LoFi-only continuation cannot poll the due QRZ book"),
    },
  );
  assert.equal(sourceOnly.stopReason, "source_authentication_required");
  assert.equal(sourceOnly.readScope, "lofi");
  assert.equal(sourceOnly.requests.requests, 0);
  assert.deepEqual(sourceOnly.coverage, report.coverage);
  qrzOptions.length = 0;
  const polled = await rebuildFreshStart(
    {
      rehearsal: directory,
      pollDue: true,
      maxRequests: 10,
      maxDurationMs: 30_000,
    },
    { fetcher },
  );
  assert.equal(polled.stopReason, "source_authentication_required");
  assert.deepEqual(polled.requests.byProvider, { lofi: 0, qrz: 2, lotw: 0 });
  assert.equal(qrzOptions.length, 1);
  assert.match(qrzOptions[0], /MODSINCE:/);
  assert.equal(polled.comparisonTurns, 0);
  assert.equal(polled.destinationCredentialEnvelopesUnchanged, true);
  assert.deepEqual(
    polled.coverage.find((row) => row.provider === "qrz"),
    {
      provider: "qrz",
      mode: "delta",
      phase: "complete",
      state: "ready",
      published: 1,
      reason: null,
      selections: 1,
    },
  );
});

test("a held QRZ covering delta resumes its saved cursor on a write-locked rebuild", async (t) => {
  const root = await mkdtemp(`${tmpdir()}/ferry-qrz-cover-`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await trialCapture(root);
  const captured = await openInventoryTrial(snapshot);
  try {
    await applyMigration(captured.db, "0006_account_templates.sql");
    await captured.db
      .prepare("UPDATE connections SET remote_identity='7' WHERE kind='qrz'")
      .run();
  } finally {
    await captured.mf.dispose();
  }
  const { directory } = await inventoryFreshStart(snapshot, root);
  let covering = false;
  let held = false;
  const fetcher: typeof fetch = async (_input, init) => {
    const form = init?.body;
    assert.ok(form instanceof URLSearchParams);
    if (form.get("ACTION") === "STATUS")
      return new Response(
        "RESULT=OK&BOOKID=7&CALLSIGN=N1RWJ&STARTDATE=2025-01-01&ENDDATE=2027-12-31",
      );
    assert.equal(form.get("ACTION"), "FETCH");
    const option = form.get("OPTION") ?? "";
    if (covering && option.includes("MODSINCE:"))
      return new Response("RESULT=FAIL&COUNT=0");
    if (covering && option.includes("AFTERLOGID:3") && !held)
      return new Response("RESULT=AUTH");
    if (held) {
      assert.match(option, /AFTERLOGID:3/);
      assert.doesNotMatch(option, /MODSINCE:/);
    }
    const ids = held
      ? ["3"]
      : covering
        ? ["1", "2"]
        : option.includes("MODSINCE:")
          ? []
          : ["1"];
    return new Response(
      new URLSearchParams({
        RESULT: "OK",
        COUNT: String(ids.length),
        ADIF: ids
          .map((id) =>
            serializeAdifRecord({
              CALL: "W1AW",
              STATION_CALLSIGN: "N1RWJ",
              QSO_DATE: "20261108",
              TIME_ON: "130000",
              BAND: "20m",
              MODE: "CW",
              APP_QRZLOG_LOGID: id,
            }),
          )
          .join(""),
      }),
    );
  };
  const f = await openInventoryTrial(directory);
  let deltaId: string;
  try {
    const link = await f.store.connection("trial", "qrz");
    assert.ok(link);
    const plan = {
      provider: "qrz",
      book: {
        bookId: "7",
        stationCallsign: "N1RWJ",
        startDate: "2025-01-01",
        endDate: "2027-12-31",
      },
      between: ["2026-11-01", "2026-11-30"],
      pageSize: 2,
    } satisfies Parameters<typeof registerInventorySelection>[3];
    const selection = await registerInventorySelection(
      f.store,
      await inventoryRuntime(f.store),
      link,
      plan,
    );
    assert.equal((await startInventorySelections(f.store)).started, 1);
    const baseline = await f.db
      .prepare(
        "SELECT active_run_id FROM inventory_stream_jobs WHERE tenant='trial'",
      )
      .first<string>("active_run_id");
    assert.ok(baseline);
    const runs = new InventoryRuns(new InventoryIngestion(f.store));
    const transport = createInventoryTrialTransport(fetcher, {
      maxRequests: 12,
    });
    const runner = new InventoryRunner(runs, transport.fetch, {
      scheduled: true,
    });
    const wakeup = async (run: string) => {
      const state = await runs.load("trial", run);
      assert.ok(state);
      return {
        version: 1 as const,
        tenant: "trial",
        scope: selection.scope,
        stream: selection.stream,
        run,
        workVersion: state.jobVersion,
      };
    };
    for (let i = 0; ; i++) {
      assert.ok(i < 8);
      if ((await runner.step(await wakeup(baseline))).kind === "complete")
        break;
    }
    const stream = () =>
      runs.inventory.snapshot("trial", selection.scope, selection.stream);
    const before = await stream();
    assert.ok(before);
    const lease = await f.store.claim(
      "trial",
      `inventory:${selection.scope}`,
      Date.now(),
      90_000,
    );
    assert.ok(lease);
    try {
      deltaId = (
        await runs.begin({
          stream: before,
          lease,
          definition: await planInventoryRun(before, plan, { mode: "delta" }),
        })
      ).id;
    } finally {
      await f.store.release(lease);
    }
    covering = true;
    assert.equal((await runner.step(await wakeup(deltaId))).kind, "advanced");
    assert.equal((await runner.step(await wakeup(deltaId))).kind, "held");
    const heldRun = await runs.load("trial", deltaId);
    assert.ok(heldRun);
    const heldStream = await stream();
    assert.deepEqual(heldStream?.checkpoint, before.checkpoint);
    assert.ok(link.credential_version);
    const setCredential = (version: string) =>
      f.db
        .prepare(
          "UPDATE connections SET credential_version=? WHERE tenant='trial' AND id='qrz'",
        )
        .bind(version)
        .run();
    await (
      await f.store.putPrivate("trial", "qrz", "rotated", "credential", {
        apiKey: "fixture-rotation",
      })
    ).run();
    await setCredential("rotated");
    await assert.rejects(
      resumeHeldQrzCover(runs, "trial", deltaId),
      /inventory_fresh_start_qrz_cover_rearm_refused/,
    );
    await setCredential(link.credential_version);
    await assert.rejects(
      f.db
        .prepare(
          "UPDATE inventory_runs SET phase='collecting',version=version+1 WHERE run_id=?",
        )
        .bind(deltaId)
        .run(),
      /inventory run version changed/,
    );
    await f.db
      .prepare(
        "CREATE TRIGGER reject_cover_rearm BEFORE INSERT ON inventory_wakeups WHEN NEW.wakeup_id LIKE 'qrz-cover-rearm:%' BEGIN SELECT RAISE(ABORT,'test wakeup failure'); END",
      )
      .run();
    await assert.rejects(
      resumeHeldQrzCover(runs, "trial", deltaId),
      /inventory_fresh_start_qrz_cover_rearm_refused/,
    );
    assert.deepEqual(await runs.load("trial", deltaId), heldRun);
    assert.deepEqual(await stream(), heldStream);
    assert.equal(
      await f.db
        .prepare("SELECT count(*) AS n FROM inventory_qrz_cover_rearms")
        .first("n"),
      0,
    );
    await f.db.prepare("DROP TRIGGER reject_cover_rearm").run();
  } finally {
    await f.mf.dispose();
  }
  held = true;
  const report = await rebuildFreshStart(
    {
      rehearsal: directory,
      resumeQrzCover: deltaId,
      maxRequests: 4,
      maxDurationMs: 10_000,
    },
    { fetcher },
  );
  assert.deepEqual(report.requests.byProvider, { lofi: 0, qrz: 2, lotw: 0 });
  assert.equal(report.coverage[0]?.state, "ready");
  assert.equal(report.coverage[0]?.mode, "delta");
  assert.equal(report.records[0]?.records, 3);
  assert.equal(report.uploads, 0);
});

test("a verified same-client LoFi bearer resumes a write-locked rebuild at its accepted cursor", async (t) => {
  const root = await mkdtemp(`${tmpdir()}/ferry-fresh-bearer-`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await trialCapture(root);
  const captured = await openInventoryTrial(snapshot);
  try {
    await applyMigration(captured.db, "0006_account_templates.sql");
  } finally {
    await captured.mf.dispose();
  }
  const { directory } = await inventoryFreshStart(snapshot, root);
  const noNetwork: typeof fetch = async () =>
    assert.fail("no provider request expected");
  assert.deepEqual(
    await refreshFreshStartLoFi(directory, snapshot, noNetwork),
    {
      status: "bearer_present",
      requests: 0,
    },
  );
  const donor = await openInventoryTrial(snapshot);
  let donorEnvelope: unknown;
  try {
    const link = await donor.store.connection("trial", "lofi");
    assert.ok(link);
    const session = await openSourceCredentials(donor.store, link);
    await session.persistRenewal({
      ...session.credentials,
      token: "new-fixture-bearer",
    });
    donorEnvelope = await donor.db
      .prepare("SELECT envelope FROM private_data WHERE connection='lofi'")
      .first("envelope");
  } finally {
    await donor.mf.dispose();
  }

  const sourcePage = (key: string, stamp: number, cursor?: string) =>
    Response.json({
      account: { uuid: "source" },
      operations: [],
      qsos: [
        {
          uuid: key,
          operation: "op",
          syncedAtMillis: stamp,
          startAtMillis: 100,
          their: { call: "W1AW" },
        },
      ],
      meta: {
        operations: { records_left: 0 },
        qsos: cursor
          ? { records_left: 1, next_cursor: cursor }
          : { records_left: 0 },
        suggestedSyncLoopDelay: 5000,
      },
    });
  const otherCredentials = (db: D1Database) =>
    db
      .prepare(
        "SELECT * FROM private_data WHERE kind='credential' AND connection!='lofi' ORDER BY connection",
      )
      .all();
  const streamState = (db: D1Database) =>
    db.prepare("SELECT * FROM inventory_streams").first();
  const jobState = (db: D1Database) =>
    db.prepare("SELECT * FROM inventory_stream_jobs").first();
  const local = await openInventoryTrial(directory);
  let runId: string;
  let checkpoint: unknown;
  let job: unknown;
  let destinationEnvelopes: unknown;
  const step = async (f: typeof local, id: string, fetcher: typeof fetch) => {
    const runs = new InventoryRuns(new InventoryIngestion(f.store));
    const run = await runs.load("trial", id);
    assert.ok(run);
    const wait = Math.max(0, run.nextDueAt - Date.now());
    assert.ok(wait < 20_000, "fixture expects a bounded LoFi pacing delay");
    await delay(wait + 5);
    return new InventoryRunner(runs, fetcher, { scheduled: true }).step({
      version: 1,
      tenant: "trial",
      scope: run.scope,
      stream: run.streamId,
      run: id,
      workVersion: run.jobVersion,
    });
  };
  try {
    const connection = await local.store.connection("trial", "lofi");
    assert.ok(connection);
    await registerInventorySelection(
      local.store,
      await inventoryRuntime(local.store),
      connection,
      { provider: "lofi", pageSize: 1000 },
    );
    assert.equal((await startInventorySelections(local.store)).started, 1);
    const id = await local.db
      .prepare("SELECT active_run_id FROM inventory_stream_jobs")
      .first<string>("active_run_id");
    assert.ok(id);
    runId = id;
    const rejected = createInventoryTrialTransport(
      async (input, init) => {
        assert.equal(new URL(String(input)).pathname, "/v1/sync");
        assert.equal(
          new Headers(init?.headers).get("Authorization"),
          "Bearer synthetic",
        );
        const request = JSON.parse(String(init?.body));
        return request.meta.sync.qsos.cursor
          ? new Response(null, { status: 401 })
          : sourcePage("q1", 100, "accepted-cursor");
      },
      { maxRequests: 2, minLoFiIntervalMs: 0 },
    );
    assert.equal((await step(local, id, rejected.fetch)).kind, "advanced");
    assert.equal((await step(local, id, rejected.fetch)).kind, "deferred");
    assert.equal(rejected.metrics.requests, 2);
    assert.equal(rejected.lofiAuthorizationRequired, true);
    const session = await openSourceCredentials(local.store, connection);
    assert.equal(session.credentials.token, undefined);
    checkpoint = await streamState(local.db);
    assert.match(JSON.stringify(checkpoint), /accepted-cursor/);
    job = await jobState(local.db);
    destinationEnvelopes = (await otherCredentials(local.db)).results;
  } finally {
    await local.mf.dispose();
  }

  let verifications = 0;
  const verify =
    (response: Response): typeof fetch =>
    async (input, init) => {
      assert.equal(input, "https://lofi.ham2k.net/v1/accounts");
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer new-fixture-bearer",
      );
      verifications++;
      return response;
    };
  await assert.rejects(
    refreshFreshStartLoFi(
      directory,
      snapshot,
      verify(new Response(null, { status: 401 })),
    ),
    /lofi_verification_failed/,
  );
  await assert.rejects(
    refreshFreshStartLoFi(
      directory,
      snapshot,
      verify(Response.json({ current_account: { uuid: "different" } })),
    ),
    /lofi_account_changed/,
  );
  assert.deepEqual(
    await refreshFreshStartLoFi(
      directory,
      snapshot,
      verify(Response.json({ current_account: { uuid: "source" } })),
    ),
    { status: "bearer_verified", requests: 1 },
  );
  assert.equal(verifications, 3);

  const resumed = await openInventoryTrial(directory);
  try {
    assert.deepEqual(await streamState(resumed.db), checkpoint);
    assert.deepEqual(await jobState(resumed.db), job);
    assert.deepEqual(
      (await otherCredentials(resumed.db)).results,
      destinationEnvelopes,
    );
    assert.equal(
      await resumed.db
        .prepare("SELECT count(*) AS n FROM inventory_fresh_start_lock")
        .first("n"),
      1,
    );
    const accepted = createInventoryTrialTransport(
      async (input, init) => {
        assert.equal(new URL(String(input)).pathname, "/v1/sync");
        assert.equal(
          new Headers(init?.headers).get("Authorization"),
          "Bearer new-fixture-bearer",
        );
        assert.equal(
          JSON.parse(String(init?.body)).meta.sync.qsos.cursor,
          "accepted-cursor",
        );
        return sourcePage("q2", 99);
      },
      { maxRequests: 1, minLoFiIntervalMs: 0 },
    );
    assert.equal((await step(resumed, runId, accepted.fetch)).kind, "advanced");
    assert.equal(accepted.metrics.requests, 1);
    assert.deepEqual(
      (
        await resumed.db
          .prepare(
            "SELECT record_key FROM inventory_records ORDER BY record_key",
          )
          .all()
      ).results,
      [{ record_key: "q1" }, { record_key: "q2" }],
    );
  } finally {
    await resumed.mf.dispose();
  }
  const original = await openInventoryTrial(snapshot);
  try {
    assert.equal(
      await original.db
        .prepare("SELECT envelope FROM private_data WHERE connection='lofi'")
        .first("envelope"),
      donorEnvelope,
    );
  } finally {
    await original.mf.dispose();
  }
});

test("a refused LoFi cursor can restart only its locked source selection", async (t) => {
  const root = await mkdtemp(`${tmpdir()}/ferry-fresh-cursor-`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = await trialCapture(root);
  const captured = await openInventoryTrial(original);
  try {
    await applyMigration(captured.db, "0006_account_templates.sql");
  } finally {
    await captured.mf.dispose();
  }
  const { directory } = await inventoryFreshStart(original, root);
  let f = await openInventoryTrial(directory);
  t.after(() => f.mf.dispose());
  const source = await f.store.connection("trial", "lofi");
  assert.ok(source);
  const registered = await registerInventorySelection(
    f.store,
    await inventoryRuntime(f.store),
    source,
    { provider: "lofi", pageSize: 1000 },
  );
  assert.equal((await startInventorySelections(f.store)).started, 1);
  const priorId = await f.db
    .prepare("SELECT active_run_id FROM inventory_stream_jobs")
    .first<string>("active_run_id");
  assert.ok(priorId);
  let runs = new InventoryRuns(new InventoryIngestion(f.store));
  const snapshot = () =>
    runs.inventory.snapshot("trial", registered.scope, registered.stream);
  const credentialEnvelopes = async () =>
    (
      await f.db
        .prepare(
          "SELECT * FROM private_data WHERE kind='credential' ORDER BY tenant,connection,id",
        )
        .all()
    ).results;
  const due = async (id: string) => {
    const previous = await runs.load("trial", id);
    assert.ok(previous);
    const at = Date.now();
    await f.db.batch([
      f.db.prepare("DELETE FROM inventory_read_pacing"),
      f.db
        .prepare(
          "UPDATE inventory_stream_jobs SET work_version=work_version+1,next_due_at=? WHERE tenant='trial' AND scope_id=? AND stream_id=?",
        )
        .bind(at, registered.scope, registered.stream),
      f.db
        .prepare(
          "INSERT INTO inventory_wakeups(tenant,wakeup_id,scope_id,stream_id,run_id,work_version,not_before) VALUES('trial',?,?,?,?,?,?)",
        )
        .bind(
          crypto.randomUUID(),
          registered.scope,
          registered.stream,
          id,
          previous.jobVersion + 1,
          at,
        ),
    ]);
    return {
      version: 1 as const,
      tenant: "trial",
      scope: registered.scope,
      stream: registered.stream,
      run: id,
      workVersion: previous.jobVersion + 1,
    };
  };
  const qso = (uuid: string) => ({
    uuid,
    syncedAtMillis: 100,
    startAtMillis: 100,
  });
  const page = (qsos: ReturnType<typeof qso>[], cursor?: string) =>
    Response.json({
      account: { uuid: "source" },
      operations: [],
      qsos,
      meta: {
        operations: { records_left: 0 },
        qsos: cursor
          ? { records_left: 1, next_cursor: cursor }
          : { records_left: 0 },
      },
      ...(cursor === "refused" && { errors: { qsos: { cursor: "expired" } } }),
    });
  await assert.rejects(
    restartHeldLoFiSource(runs, "trial", priorId),
    /lofi_cursor_not_held/,
  );
  const first = new InventoryRunner(
    runs,
    async () => page([qso("q1")], "accepted-cursor"),
    { scheduled: true },
  );
  assert.equal((await first.step(await due(priorId))).kind, "advanced");
  const refusing = new InventoryRunner(
    runs,
    async (_input, init) => {
      assert.equal(
        JSON.parse(String(init?.body)).meta.sync.qsos.cursor,
        "accepted-cursor",
      );
      return page([], "refused");
    },
    { scheduled: true },
  );
  const oldWakeup = await due(priorId);
  assert.equal((await refusing.step(oldWakeup)).kind, "held");
  const held = await snapshot();
  assert.match(JSON.stringify(held?.resume), /accepted-cursor/);
  assert.equal((await runs.load("trial", priorId))?.reason, "cursor_refused");

  await f.mf.dispose();
  try {
    const report = await rebuildFreshStart(
      { rehearsal: directory, lofiOnly: true, maxDurationMs: 1000 },
      { fetcher: async () => assert.fail("a held LoFi run cannot read") },
    );
    assert.deepEqual(report.lofiCursorRefusedRuns, [priorId]);
    assert.equal(report.nextLoFiPollAt, null);
    assert.equal(report.requests.requests, 0);
  } finally {
    f = await openInventoryTrial(directory);
    runs = new InventoryRuns(
      new InventoryIngestion(f.store, new InventoryComparisonPages(f.store)),
    );
  }

  const session = await openSourceCredentials(f.store, source);
  await session.persistTokenState({ ...session.credentials, token: undefined });
  await assert.rejects(
    restartHeldLoFiSource(runs, "trial", priorId),
    /lofi_bearer_unavailable/,
  );
  assert.equal((await snapshot())?.version, held?.version);
  const missing = await openSourceCredentials(f.store, source);
  await missing.persistRenewal(session.credentials);
  const envelopes = await credentialEnvelopes();
  const replacement = await restartHeldLoFiSource(runs, "trial", priorId);
  assert.notEqual(replacement.id, priorId);
  assert.equal(replacement.mode, "full");
  assert.equal(replacement.scope, registered.scope);
  assert.equal(replacement.streamId, registered.stream);
  assert.equal(
    (await restartHeldLoFiSource(runs, "trial", priorId)).id,
    replacement.id,
  );
  assert.equal(
    await f.db.prepare("SELECT count(*) AS n FROM inventory_runs").first("n"),
    2,
  );
  assert.deepEqual((await snapshot())?.checkpoint, held?.checkpoint);
  assert.doesNotMatch(
    JSON.stringify((await snapshot())?.resume),
    /accepted-cursor/,
  );
  assert.equal(
    await f.db
      .prepare("SELECT count(*) AS n FROM inventory_records")
      .first("n"),
    1,
  );

  const restarted = new InventoryRunner(
    runs,
    async (_input, init) => {
      const request = JSON.parse(String(init?.body)).meta.sync;
      assert.equal(request.qsos.cursor, undefined);
      assert.equal(request.qsos.anyClient, true);
      return page([qso("q1"), qso("q2")]);
    },
    { scheduled: true },
  );
  assert.deepEqual(await restarted.step(oldWakeup), {
    kind: "skipped",
    reason: "stale",
  });
  for (let turn = 0; turn < 6; turn++) {
    const result = await restarted.step(await due(replacement.id));
    if (result.kind === "complete") break;
    assert.equal(result.kind, "advanced");
  }
  assert.equal((await runs.load("trial", replacement.id))?.phase, "complete");
  assert.deepEqual(await credentialEnvelopes(), envelopes);
  assert.deepEqual(
    await f.db
      .prepare("SELECT state,kind,epoch FROM inventory_coverage")
      .first(),
    { state: "ready", kind: "observed_selection", epoch: 1 },
  );
  assert.equal(
    await f.db
      .prepare("SELECT count(*) AS n FROM inventory_records")
      .first("n"),
    2,
  );
});
