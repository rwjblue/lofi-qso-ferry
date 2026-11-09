import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { serializeAdifRecord } from "../src/adif.ts";
import { InventoryComparisonCoordinator } from "../src/inventory-comparison-coordinator.ts";
import { InventoryComparisonPages } from "../src/inventory-comparison-pages.ts";
import {
  InventorySendQueue,
  isInventorySendWakeup,
} from "../src/inventory-delivery-send.ts";
import { runHostedInventoryQueue } from "../src/inventory-hosted.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import { InventoryLotwDispatch } from "../src/inventory-lotw-dispatch.ts";
import { InventoryLotwPreparation } from "../src/inventory-lotw-preparation.ts";
import { InventoryLotwReadback } from "../src/inventory-lotw-readback.ts";
import { configuredInventoryShadow } from "../src/inventory-preparation-shadow.ts";
import { InventoryQrzDispatch } from "../src/inventory-qrz-dispatch.ts";
import { InventoryRunner } from "../src/inventory-runner.ts";
import { InventoryRuns } from "../src/inventory-runs.ts";
import { activateInventoryRuntime } from "../src/inventory-runtime.ts";
import {
  registerInventorySelection,
  startInventorySelections,
} from "../src/inventory-scheduler.ts";
import { InventorySourceProofJobs } from "../src/inventory-source-proof-jobs.ts";
import { InventoryUploadPlanner } from "../src/inventory-upload-planner.ts";
import { importPkcs12 } from "../src/signing.ts";
import { TEMPLATE_PROFILE } from "../src/templates.ts";
import { database } from "./helpers.ts";
import {
  applyAdditionalMigrations,
  fixtureEnvironment,
} from "./runtime-fixtures.ts";

test("managed delivery sends 100 LoTW members, recovers partial receipts, and advances QRZ", async (t) => {
  const { db, mf, store } = await database();
  t.after(() => mf.dispose());
  await applyAdditionalMigrations(db);
  const signing = await importPkcs12(
    await readFile(new URL("../fixtures/signing/current.p12", import.meta.url)),
    "ferry-fixture",
    { version: "fixture-batch" },
  );
  const book = {
    bookId: "7",
    stationCallsign: "W1AW",
    startDate: "2026-11-07",
    endDate: "2026-11-09",
  };
  await store.db.batch([
    store.statement(
      "INSERT INTO accounts(id,email,user_handle,verified_at) VALUES('a','a@example.test','a',1)",
    ),
    store.statement(
      "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,config,created_at) VALUES('a','source','lofi','a','Source','active','v1',?,1),('a','lotw','lotw','a','LoTW','active','v1',?,1),('a','qrz','qrz','7','QRZ','active','v1',?,1)",
      JSON.stringify({ accountId: "a" }),
      JSON.stringify({
        readAccess: true,
        station: { callsign: "W1AW", dxcc: 291 },
      }),
      JSON.stringify(book),
    ),
    await store.putPrivate("a", "source", "v1", "credential", {
      key: "browser:fixture",
      secret: "fixture",
      token: "fixture",
    }),
    await store.putPrivate("a", "lotw", "v1", "credential", {
      query: { username: "fixture", password: "fixture" },
      signing,
    }),
    await store.putPrivate("a", "qrz", "v1", "credential", {
      apiKey: "fixture",
    }),
    store.statement(
      "INSERT INTO templates(tenant,destination,id,config,created_at) VALUES('a','qrz','v1',?,1)",
      JSON.stringify({
        profile: TEMPLATE_PROFILE,
        fields: {},
        fallbackNotes: false,
      }),
    ),
    store.statement("INSERT INTO active_templates VALUES('a','qrz','v1')"),
  ]);
  const operation = {
    uuid: "op",
    stationCall: "W1AW",
    syncedAtMillis: Date.now() - 60_000,
  };
  const contacts = Array.from({ length: 100 }, (_, index) => ({
    uuid: `qso-${String(99 - index).padStart(3, "0")}`,
    operation: operation.uuid,
    syncedAtMillis: operation.syncedAtMillis + index + 1,
    startAtMillis: Date.parse("2026-11-08T12:00:01Z") + 60_000 * index,
    their: {
      call: `K${index % 10}B${String.fromCharCode(65 + Math.floor(index / 10))}`,
    },
    our: { grid: "FN31", dxccCode: 291 },
    band: "20m",
    mode: "CW",
  }));
  const recordKeys = contacts.map(({ uuid }) => uuid);
  let uploadRequests = 0;
  let qrzInserts = 0;
  let witnessed = 0;
  let receiptRecords: string[] = [];
  let expectedTq8: Uint8Array | null = null;
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "lofi.ham2k.net") {
      assert.equal(url.pathname, "/v1/sync");
      const body = (await request.json()) as {
        meta: {
          sync: {
            operations: { syncedUntilMillis?: number };
            qsos: { syncedUntilMillis?: number; limit: number };
          };
        };
      };
      assert.deepEqual(Object.keys(body), ["meta"]);
      const { operations, qsos } = body.meta.sync;
      if (qsos.limit === 100) witnessed++;
      return Response.json({
        account: { uuid: "a" },
        operations:
          (operations.syncedUntilMillis ?? 0) > operation.syncedAtMillis
            ? [operation]
            : [],
        qsos: contacts
          .filter((qso) => qso.syncedAtMillis < (qsos.syncedUntilMillis ?? 0))
          .toReversed(),
        meta: {
          operations: { records_left: 0 },
          qsos: { records_left: 0 },
          suggestedSyncLoopDelay: 5000,
        },
      });
    }
    if (url.hostname === "logbook.qrz.com") {
      const form = new URLSearchParams(await request.text());
      if (form.get("ACTION") === "STATUS")
        return new Response(
          `RESULT=OK&BOOKID=7&CALLSIGN=W1AW&STARTDATE=${book.startDate}&ENDDATE=${book.endDate}`,
        );
      if (form.get("ACTION") === "INSERT") {
        qrzInserts++;
        return new Response("RESULT=OK&COUNT=1&LOGID=1");
      }
      assert.equal(form.get("ACTION"), "FETCH");
      return new Response("RESULT=OK&COUNT=0&ADIF=");
    }
    assert.equal(url.hostname, "lotw.arrl.org");
    if (url.pathname === "/lotw/crl")
      return new Response("<Status>Unrevoked</Status>");
    if (url.pathname === "/lotw/upload") {
      uploadRequests++;
      assert.equal(request.method, "POST");
      const payload = (await request.formData()).get("upfile");
      assert.ok(payload instanceof File);
      assert.deepEqual(
        new Uint8Array(await payload.arrayBuffer()),
        expectedTq8,
      );
      return new Response("<!-- .UPL. accepted -->");
    }
    assert.equal(url.pathname, "/lotwuser/lotwreport.adi");
    const count = String(receiptRecords.length);
    return new Response(
      `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:${count.length}>${count}<EOH>${receiptRecords.join("")}<APP_LOTW_EOF>`,
    );
  };
  const runtime = await activateInventoryRuntime(store);
  const source = await store.connection("a", "source");
  const lotw = await store.connection("a", "lotw");
  const qrz = await store.connection("a", "qrz");
  assert.ok(source && lotw && qrz);
  await registerInventorySelection(store, runtime, source, {
    provider: "lofi",
  });
  await registerInventorySelection(store, runtime, lotw, {
    provider: "lotw",
    selection: { startDate: "2026-11-07", endDate: "2026-11-09" },
  });
  await registerInventorySelection(store, runtime, qrz, {
    provider: "qrz",
    book,
    between: [book.startDate, book.endDate],
  });
  assert.equal((await startInventorySelections(store)).started, 3);
  const runs = new InventoryRuns(
    new InventoryIngestion(store, new InventoryComparisonPages(store)),
  );
  const runner = new InventoryRunner(runs, fetcher, { scheduled: true });
  const proofJobs = new InventorySourceProofJobs(runs, fetcher);
  const scope = (provider: string) =>
    store
      .statement(
        "SELECT scope_id FROM inventory_scopes WHERE tenant='a' AND provider=?",
        provider,
      )
      .first<string>("scope_id");
  const sourceScope = await scope("lofi");
  const destinationScope = await scope("lotw");
  const qrzScope = await scope("qrz");
  assert.ok(sourceScope && destinationScope && qrzScope);

  async function finish(scopeId: string) {
    for (let step = 0; step < 15; step++) {
      const job = await store
        .statement(
          "SELECT j.stream_id AS stream,j.active_run_id AS run,j.work_version AS workVersion FROM inventory_stream_jobs j WHERE tenant='a' AND scope_id=?",
          scopeId,
        )
        .first<{ stream: string; run: string; workVersion: number }>();
      assert.ok(job);
      await store.statement("DELETE FROM inventory_read_pacing").run();
      const result = await runner.step({
        version: 1,
        tenant: "a",
        scope: scopeId,
        ...job,
      });
      if (result.kind === "complete") return;
      if (result.kind === "skipped" && result.reason === "not_due") {
        const due = Date.now();
        const version = job.workVersion + 1;
        await db.batch([
          store.statement(
            "UPDATE inventory_stream_jobs SET work_version=?,next_due_at=? WHERE tenant='a' AND scope_id=?",
            version,
            due,
            scopeId,
          ),
          store.statement(
            "INSERT INTO inventory_wakeups(tenant,wakeup_id,scope_id,stream_id,run_id,work_version,not_before) VALUES('a',?,?,?,?,?,?)",
            crypto.randomUUID(),
            scopeId,
            job.stream,
            job.run,
            version,
            due,
          ),
        ]);
      } else
        assert.ok(
          result.kind === "advanced" || result.kind === "started",
          JSON.stringify(result),
        );
    }
    assert.fail("reader did not settle");
  }
  await finish(sourceScope);
  await finish(destinationScope);
  await finish(qrzScope);
  const coordinator = new InventoryComparisonCoordinator(store);
  for (let step = 0; step < 100; step++) {
    const outcome = await coordinator.step("a");
    if (outcome.kind === "idle") break;
    assert.ok(step < 99, JSON.stringify(outcome));
  }
  // Advance only the fixture's quiet clocks, then restore the native guards.
  for (const [triggers, sql] of [
    [
      [
        "comparison_projection_version",
        "inventory_matching_source_projection_update",
      ],
      "UPDATE comparison_projections SET derived_at=? WHERE facet='source'",
    ],
    [
      [
        "inventory_match_result_update",
        "inventory_delivery_review_result_update",
      ],
      "UPDATE match_results SET next_eligible_at=? WHERE state='absent_at_inventory'",
    ],
  ] as const) {
    const ddl = await Promise.all(
      triggers.map((name) =>
        store
          .statement("SELECT sql FROM sqlite_master WHERE name=?", name)
          .first<string>("sql"),
      ),
    );
    await db.batch([
      ...triggers.map((name) => db.prepare(`DROP TRIGGER ${name}`)),
      db.prepare(sql).bind(Date.now() - 3_600_000),
      ...ddl.map((sql) => {
        assert.ok(sql);
        return db.prepare(sql);
      }),
    ]);
  }
  const selection = { tenant: "a", sourceScope, destinationScope, recordKeys };
  const messages: unknown[] = [];
  const message = (body: unknown): Message<unknown> => ({
    id: "fixture",
    timestamp: new Date(),
    attempts: 1,
    body,
    ack() {},
    retry() {
      assert.fail("unexpected send retry");
    },
  });
  const delivery = (body: unknown): MessageBatch<unknown> => ({
    queue: "fixture",
    messages: [message(body)],
    metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } },
    ackAll() {
      assert.fail("unexpected batch ack");
    },
    retryAll() {
      assert.fail("unexpected batch retry");
    },
  });
  const env = {
    ...fixtureEnvironment(db),
    INVENTORY_RUNTIME_MODE: "managed",
    EXPORTS_ENABLED: "true",
    ROLLOUT_CHECKS_PASSED: "true",
    LIVE_WRITE_AUTHORIZATION: "I_AUTHORIZE_LIVE_VENDOR_WRITES",
    QRZ_FRESH_INSERTS_ENABLED: "true",
    LOTW_FRESH_INSERTS_ENABLED: "true",
    ROLLOUT_QSO_IDS_JSON: JSON.stringify(["*"]),
    ROLLOUT_DESTINATION_IDS_JSON: JSON.stringify(["lotw", "qrz"]),
    INVENTORY_QUEUE: {
      async sendBatch(batch) {
        messages.push(...Array.from(batch, ({ body }) => body));
        return {
          metadata: {
            metrics: { backlogCount: messages.length, backlogBytes: 0 },
          },
        };
      },
    } as Env["INVENTORY_QUEUE"],
  };
  const configured = configuredInventoryShadow(
    { ...env, INVENTORY_LOTW_SHADOW_JSON: JSON.stringify(selection) },
    "lotw",
  );
  assert.equal(configured.kind, "configured");
  assert.deepEqual(
    configuredInventoryShadow(
      {
        ...env,
        INVENTORY_LOTW_SHADOW_JSON: JSON.stringify({
          ...selection,
          recordKeys: [...recordKeys, "extra"],
        }),
      },
      "lotw",
    ),
    { kind: "invalid" },
  );
  assert.deepEqual(
    await new InventoryUploadPlanner(
      { ...env, INVENTORY_RUNTIME_MODE: "read_only" },
      proofJobs,
    ).enroll(),
    { qrz: 0, lotw: 0 },
  );
  assert.deepEqual(
    await new InventoryUploadPlanner(
      { ...env, ROLLOUT_QSO_IDS_JSON: "[]" },
      proofJobs,
    ).enroll(),
    { qrz: 0, lotw: 0 },
  );
  const planner = new InventoryUploadPlanner(env, proofJobs);
  assert.deepEqual(await planner.enroll(), { qrz: 0, lotw: 1 });
  assert.deepEqual(await planner.enroll(), { qrz: 0, lotw: 0 });
  const job = await proofJobs.load("a", sourceScope);
  assert.ok(job && job.phase === "collecting");
  // Skip the optional cached witnesses to exercise one larger LoFi read.
  await store
    .statement(
      "UPDATE inventory_source_proof_jobs SET witnesses='[]' WHERE tenant='a'",
    )
    .run();
  await store.statement("DELETE FROM inventory_read_pacing").run();
  assert.equal(
    (await proofJobs.step("a", sourceScope, job.job_id)).kind,
    "draining",
  );
  assert.equal(witnessed, 1);
  assert.equal(
    (await proofJobs.step("a", sourceScope, job.job_id)).kind,
    "deferred",
  );
  await finish(sourceScope);
  await store
    .statement(
      "UPDATE inventory_source_proof_jobs SET due_at=? WHERE tenant='a'",
      Date.now(),
    )
    .run();
  const ready = await proofJobs.load("a", sourceScope);
  assert.ok(ready && ready.phase === "draining");
  const staged = await runHostedInventoryQueue(
    env,
    delivery({
      kind: "inventory-source-proof",
      version: 1,
      tenant: "a",
      scope: sourceScope,
      id: ready.job_id,
      workVersion: ready.version,
    }),
    fetcher,
  );
  assert.equal(staged.mode, "inventory_managed");
  assert.equal(staged.sourceProofProcessed, 1);
  assert.equal(staged.lotwSendQueued, 1);
  assert.equal(staged.failed, 0);
  assert.deepEqual(await planner.stage("a", sourceScope, job.job_id), {
    kind: "idle",
  });
  const prepared = await store
    .statement(
      "SELECT batch_id AS batchId,member_count AS members FROM inventory_lotw_batches WHERE tenant='a'",
    )
    .first<{ batchId: string; members: number }>();
  assert.ok(prepared);
  assert.equal(prepared.members, 100);
  const artifact = await new InventoryLotwPreparation(store).artifact(
    "a",
    prepared.batchId,
  );
  assert.ok(artifact);
  expectedTq8 = artifact.bytes;
  assert.equal(
    gunzipSync(artifact.bytes)
      .toString()
      .match(/<REC_TYPE:8>tCONTACT/g)?.length,
    100,
  );
  const dispatch = new InventoryLotwDispatch(store, fetcher);
  const sender = new InventorySendQueue(env, "lotw", dispatch);
  assert.equal(await sender.retireExpired(), 0);
  assert.equal(await sender.schedule(), 0);
  const wakeup = messages.find((body) => isInventorySendWakeup("lotw", body));
  assert.ok(wakeup);
  const restricted = new InventorySendQueue(
    { ...env, ROLLOUT_QSO_IDS_JSON: JSON.stringify(recordKeys.slice(0, 99)) },
    "lotw",
    dispatch,
  );
  assert.equal((await restricted.consume([message(wakeup)])).outcome, "stale");
  assert.equal(uploadRequests, 0);
  const sent = await runHostedInventoryQueue(env, delivery(wakeup), fetcher);
  assert.equal(sent.mode, "inventory_managed");
  assert.equal(sent.lotwSendOutcome, "submitted");
  assert.equal(sent.qrzSendQueued, 1);
  assert.equal(sent.failed, 0);
  assert.equal((await sender.consume([message(wakeup)])).outcome, "stale");
  assert.equal(uploadRequests, 1);
  const claimedAt = await store
    .statement(
      "SELECT claimed_at FROM inventory_lotw_dispatches WHERE tenant='a' AND batch_id=?",
      prepared.batchId,
    )
    .first<number>("claimed_at");
  assert.ok(claimedAt);
  const stamp = new Date(claimedAt)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  const observations = artifact.members.map(({ qso }) =>
    serializeAdifRecord({
      STATION_CALLSIGN: artifact.station.callsign,
      CALL: qso.call,
      BAND: qso.band,
      MODE: qso.mode,
      QSO_DATE: qso.date.replaceAll("-", ""),
      TIME_ON: qso.time.replaceAll(":", "").replace("Z", ""),
      MY_DXCC: String(artifact.station.dxcc),
      MY_GRIDSQUARE: artifact.station.grid ?? "",
      APP_LOTW_RXQSO: stamp,
      QSL_RCVD: "N",
    }),
  );
  const readback = new InventoryLotwReadback(store, fetcher);
  receiptRecords = observations.slice(0, 61);
  assert.deepEqual(await readback.reconcile("a", prepared.batchId), {
    kind: "partial",
    members: 100,
    observed: 61,
  });
  receiptRecords = observations;
  assert.deepEqual(await readback.reconcile("a", prepared.batchId), {
    kind: "observed",
    members: 100,
    observed: 100,
  });
  assert.equal(uploadRequests, 1);
  assert.deepEqual(await planner.enroll(), { qrz: 0, lotw: 0 });
  assert.equal(
    await store
      .statement(
        "SELECT count(*) n FROM inventory_qrz_attempts WHERE tenant='a'",
      )
      .first("n"),
    20,
  );
  assert.deepEqual(
    (
      await store
        .statement(
          "SELECT record_key FROM inventory_qrz_attempts WHERE tenant='a' ORDER BY record_key",
        )
        .all<{ record_key: string }>()
    ).results.map(({ record_key }) => record_key),
    recordKeys.slice(0, 20).sort(),
  );
  const qrzSender = new InventorySendQueue(
    env,
    "qrz",
    new InventoryQrzDispatch(store, fetcher),
  );
  assert.equal(await qrzSender.retireExpired(), 0);
  const qrzWakeup = messages.find((body) => isInventorySendWakeup("qrz", body));
  assert.ok(qrzWakeup);
  assert.equal(
    (await qrzSender.consume([message(qrzWakeup)])).outcome,
    "delivered",
  );
  assert.equal(
    (await qrzSender.consume([message(qrzWakeup)])).outcome,
    "stale",
  );
  assert.equal(qrzInserts, 1);

  // Advance the fixture's proof expiry without waiting five minutes. The
  // archived proof trigger is restored before the managed retirement turn.
  const immutableProof = await store
    .statement(
      "SELECT sql FROM sqlite_master WHERE name='inventory_source_proof_immutable'",
    )
    .first<string>("sql");
  assert.ok(immutableProof);
  await db.batch([
    db.prepare("DROP TRIGGER inventory_source_proof_immutable"),
    db.prepare(
      "UPDATE inventory_source_proofs SET expires_at=created_at+1 WHERE tenant='a'",
    ),
    db.prepare(immutableProof),
  ]);
  assert.equal(await qrzSender.retireExpired(), 16);
  assert.equal(await qrzSender.retireExpired(), 3);
  assert.equal(await sender.retireExpired(), 0);
  assert.equal(
    await store
      .statement(
        "SELECT count(*) n FROM inventory_qrz_attempts WHERE tenant='a' AND cancelled_at IS NULL",
      )
      .first("n"),
    1,
  );
  assert.equal(qrzInserts, 1);
});
