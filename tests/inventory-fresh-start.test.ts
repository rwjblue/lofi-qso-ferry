import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  inventoryFreshStart,
  refreshFreshStartLoFi,
} from "../scripts/inventory-fresh-start.ts";
import { openInventoryTrial } from "../scripts/inventory-run-trial.ts";
import { createInventoryTrialTransport } from "../scripts/inventory-trial-transport.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import { InventoryQrzDispatch } from "../src/inventory-qrz-dispatch.ts";
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
        sourceBoundaryVerified: false,
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
