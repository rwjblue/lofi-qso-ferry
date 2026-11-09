import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { serializeAdifRecord } from "../src/adif.ts";
import { InventoryComparisonCoordinator } from "../src/inventory-comparison-coordinator.ts";
import { InventoryComparisonPages } from "../src/inventory-comparison-pages.ts";
import { runHostedInventoryQueue } from "../src/inventory-hosted.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import { INVENTORY_LOTW_DELIVERY_LEASE } from "../src/inventory-lotw-dispatch.ts";
import { InventoryLotwGridUpdates } from "../src/inventory-lotw-grid-updates.ts";
import { InventoryRunner } from "../src/inventory-runner.ts";
import { InventoryRuns } from "../src/inventory-runs.ts";
import { activateInventoryRuntime } from "../src/inventory-runtime.ts";
import {
  registerInventorySelection,
  startInventorySelections,
} from "../src/inventory-scheduler.ts";
import { InventorySourceProofDrain } from "../src/inventory-source-proof-drain.ts";
import { InventorySourceProofJobs } from "../src/inventory-source-proof-jobs.ts";
import {
  isSourceProofWakeup,
  publishSourceProofWakeups,
} from "../src/inventory-source-proof-wakeups.ts";
import type { InventorySourceProofScope } from "../src/inventory-source-proof-workspace.ts";
import { importPkcs12 } from "../src/signing.ts";
import { database, unusedInventoryQueue } from "./helpers.ts";
import {
  applyAdditionalMigrations,
  fixtureEnvironment,
} from "./runtime-fixtures.ts";

test("LoTW grid correction uses a fresh source proof and recovers an uncertain upload without resending", async (t) => {
  const { db, mf, store } = await database();
  t.after(() => mf.dispose());
  await applyAdditionalMigrations(db);
  const signing = await importPkcs12(
    await readFile(new URL("../fixtures/signing/current.p12", import.meta.url)),
    "ferry-fixture",
    { version: "fixture-correction" },
  );
  await db.batch([
    store.statement(
      "INSERT INTO accounts(id,email,user_handle,verified_at) VALUES('a','a@example.test','a',1)",
    ),
    store.statement(
      "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,config,created_at) VALUES('a','source','lofi','a','Source','active','v1',?,1),('a','lotw','lotw','a','LoTW','active','v1',?,1)",
      JSON.stringify({ accountId: "a" }),
      JSON.stringify({
        readAccess: true,
        station: { callsign: "W1AW", dxcc: 291 },
      }),
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
  ]);
  let source = {
    uuid: "contact",
    operation: null,
    syncedAtMillis: Date.now() - 60_000,
    startAtMillis: Date.parse("2026-11-08T12:34:56Z"),
    their: { call: "K1ABC" },
    our: { stationCall: "W1AW", dxccCode: 291, grid: "FN31" },
    band: "20m",
    mode: "CW",
  };
  let receipt = {
    CALL: "K1ABC",
    STATION_CALLSIGN: "W1AW",
    QSO_DATE: "20261108",
    TIME_ON: "123456",
    BAND: "20m",
    MODE: "CW",
    MY_DXCC: "291",
    MY_GRIDSQUARE: "FN31",
    QSL_RCVD: "Y",
    APP_LOTW_RXQSO: "2026-11-08 15:00:00",
  };
  let uploads = 0;
  let stateAtUpload: string | null = null;
  let signed = "";
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "lofi.ham2k.net") {
      assert.equal(url.pathname, "/v1/sync");
      const body = (await request.json()) as {
        meta: {
          sync: {
            qsos: { syncedSinceMillis?: number; syncedUntilMillis?: number };
          };
        };
      };
      const { syncedSinceMillis = 0, syncedUntilMillis = Infinity } =
        body.meta.sync.qsos;
      return Response.json({
        account: { uuid: "a" },
        operations: [],
        qsos:
          source.syncedAtMillis >= syncedSinceMillis &&
          source.syncedAtMillis < syncedUntilMillis
            ? [source]
            : [],
        meta: {
          operations: { records_left: 0 },
          qsos: { records_left: 0 },
          suggestedSyncLoopDelay: 5000,
        },
      });
    }
    assert.equal(url.hostname, "lotw.arrl.org");
    if (url.pathname === "/lotw/crl")
      return new Response("<Status>Unrevoked</Status>");
    if (url.pathname === "/lotw/upload") {
      assert.equal(request.method, "POST");
      uploads++;
      stateAtUpload = await store
        .statement("SELECT state FROM inventory_lotw_grid_updates")
        .first<string>("state");
      const payload = (await request.formData()).get("upfile");
      assert.ok(payload instanceof File);
      signed = gunzipSync(
        new Uint8Array(await payload.arrayBuffer()),
      ).toString();
      throw new Error("fixture connection lost after receipt");
    }
    assert.equal(url.pathname, "/lotwuser/lotwreport.adi");
    return new Response(
      `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:1>1<APP_LOTW_LASTQSORX:19>${receipt.APP_LOTW_RXQSO}<EOH>${serializeAdifRecord(receipt)}<APP_LOTW_EOF>`,
    );
  };
  const runtime = await activateInventoryRuntime(store);
  const sourceConnection = await store.connection("a", "source");
  const lotwConnection = await store.connection("a", "lotw");
  assert.ok(sourceConnection && lotwConnection);
  const { scope: sourceScope } = await registerInventorySelection(
    store,
    runtime,
    sourceConnection,
    { provider: "lofi" },
  );
  const { scope: destination } = await registerInventorySelection(
    store,
    runtime,
    lotwConnection,
    {
      provider: "lotw",
      selection: { startDate: "2026-11-07", endDate: "2026-11-09" },
    },
  );
  assert.equal((await startInventorySelections(store)).started, 2);
  const runs = new InventoryRuns(
    new InventoryIngestion(store, new InventoryComparisonPages(store)),
  );
  const runner = new InventoryRunner(runs, fetcher, { scheduled: true });
  const proofJobs = new InventorySourceProofJobs(runs, fetcher);
  const updates = new InventoryLotwGridUpdates(store, proofJobs, fetcher);
  const sent: MessageSendRequest<unknown>[] = [];
  const env = {
    ...fixtureEnvironment(db),
    INVENTORY_QUEUE: {
      ...unusedInventoryQueue,
      async sendBatch(messages) {
        sent.push(...messages);
        return {
          metadata: { metrics: { backlogCount: sent.length, backlogBytes: 0 } },
        };
      },
    } satisfies Queue,
    INVENTORY_RUNTIME_MODE: "managed",
    EXPORTS_ENABLED: "true",
    ROLLOUT_CHECKS_PASSED: "true",
    LIVE_WRITE_AUTHORIZATION: "I_AUTHORIZE_LIVE_VENDOR_WRITES",
    LOTW_FRESH_INSERTS_ENABLED: "true",
    LOTW_GRID_CORRECTIONS_ENABLED: "true",
    ROLLOUT_QSO_IDS_JSON: '["contact"]',
    ROLLOUT_DESTINATION_IDS_JSON: '["lotw"]',
  } as const;

  async function finish(scope: string) {
    for (let step = 0; step < 15; step++) {
      const job = await store
        .statement(
          "SELECT stream_id AS stream,active_run_id AS run,work_version AS workVersion FROM inventory_stream_jobs WHERE tenant='a' AND scope_id=?",
          scope,
        )
        .first<{ stream: string; run: string; workVersion: number }>();
      assert.ok(job?.run);
      await store.statement("DELETE FROM inventory_read_pacing").run();
      const result = await runner.step({
        version: 1,
        tenant: "a",
        scope,
        ...job,
      });
      if (result.kind === "complete") return;
      if (result.kind === "skipped" && result.reason === "not_due") {
        const due = Date.now();
        await db.batch([
          store.statement(
            "UPDATE inventory_stream_jobs SET work_version=work_version+1,next_due_at=? WHERE tenant='a' AND scope_id=?",
            due,
            scope,
          ),
          store.statement(
            "INSERT INTO inventory_wakeups(tenant,wakeup_id,scope_id,stream_id,run_id,work_version,not_before) VALUES('a',?,?,?,?,?,?)",
            crypto.randomUUID(),
            scope,
            job.stream,
            job.run,
            job.workVersion + 1,
            due,
          ),
        ]);
      } else {
        assert.ok(
          result.kind === "advanced" || result.kind === "started",
          JSON.stringify(result),
        );
      }
    }
    assert.fail("reader did not settle");
  }

  async function compare() {
    const coordinator = new InventoryComparisonCoordinator(store);
    for (let step = 0; step < 50; step++) {
      if ((await coordinator.step("a")).kind === "idle") return;
    }
    assert.fail("comparison did not settle");
  }

  await finish(sourceScope);
  await finish(destination);
  await compare();
  assert.equal(
    await store
      .statement("SELECT count(*) AS n FROM inventory_historical_associations")
      .first("n"),
    1,
  );
  assert.deepEqual(await updates.step(env), {
    attempted: false,
    observed: false,
  });
  const before = await store
    .statement("SELECT * FROM inventory_source_proof_scope")
    .first<InventorySourceProofScope>();
  assert.ok(before);
  source = {
    ...source,
    syncedAtMillis: Date.now() - 1,
    our: { ...source.our, grid: "FN32" },
  };
  assert.equal(
    (await new InventorySourceProofDrain(runs).start(before, Date.now() - 1))
      .kind,
    "started",
  );
  await finish(sourceScope);
  await compare();
  assert.equal(
    await store
      .statement(
        "SELECT reason FROM match_results_current WHERE record_key='contact'",
      )
      .first("reason"),
    "historical_grid_changed",
  );
  assert.deepEqual(
    await updates.step({ ...env, LOTW_GRID_CORRECTIONS_ENABLED: "false" }),
    { attempted: false, observed: false },
  );
  assert.equal(await proofJobs.load("a", sourceScope), null);
  // Age only the quiet clocks in this fixture while keeping other guards live.
  const triggers = [
    "inventory_match_result_update",
    "comparison_projection_version",
    "inventory_matching_source_projection_update",
  ];
  const ddl = await Promise.all(
    triggers.map((name) =>
      store
        .statement("SELECT sql FROM sqlite_master WHERE name=?", name)
        .first<string>("sql"),
    ),
  );
  const past = Date.now() - 3_600_000;
  await db.batch([
    ...triggers.map((name) => db.prepare(`DROP TRIGGER ${name}`)),
    store.statement("UPDATE match_results SET derived_at=?", past),
    store.statement(
      "UPDATE comparison_projections SET derived_at=? WHERE facet='source'",
      past,
    ),
    ...ddl.map((sql) => {
      assert.ok(sql);
      return db.prepare(sql);
    }),
  ]);
  assert.deepEqual(await updates.step(env), {
    attempted: false,
    observed: false,
  });
  const job = await proofJobs.load("a", sourceScope);
  assert.equal(job?.phase, "collecting");
  assert.ok(job);
  assert.equal(
    JSON.parse(job.snapshot).contacts[0].routes[0].purpose,
    "lotw_grid_correction",
  );
  assert.equal(
    (await proofJobs.step("a", sourceScope, job.job_id)).kind,
    "draining",
  );
  assert.equal(
    (await proofJobs.step("a", sourceScope, job.job_id)).kind,
    "deferred",
  );
  await finish(sourceScope);
  await store
    .statement("UPDATE inventory_source_proof_jobs SET due_at=?", Date.now())
    .run();
  assert.equal(
    await publishSourceProofWakeups(proofJobs, env.INVENTORY_QUEUE),
    1,
  );
  const wakeup = sent.find(({ body }) => isSourceProofWakeup(body));
  assert.ok(wakeup);
  async function deliverProof(body: unknown) {
    const outcomes: (number | string)[] = [];
    await runHostedInventoryQueue(
      env,
      {
        queue: "fixture",
        metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } },
        messages: [
          {
            id: "proof",
            body,
            timestamp: new Date(),
            attempts: 1,
            ack: () => outcomes.push("ack"),
            retry: (options) => outcomes.push(options?.delaySeconds ?? 0),
          },
        ],
        ackAll: () => assert.fail("unexpected batch acknowledgement"),
        retryAll: () => assert.fail("unexpected batch retry"),
      },
      fetcher,
    );
    return outcomes;
  }
  const deliveryLease = await store.claim(
    "a",
    INVENTORY_LOTW_DELIVERY_LEASE,
    Date.now(),
    30_000,
  );
  assert.ok(deliveryLease);
  const retry = await deliverProof(wakeup.body);
  assert.ok(typeof retry[0] === "number" && retry[0] > 0);
  assert.equal(uploads, 0);
  assert.equal((await proofJobs.load("a", sourceScope))?.phase, "complete");
  assert.equal(
    (await proofJobs.enqueue("a", sourceScope, ["contact"])).kind,
    "existing",
  );
  await store.release(deliveryLease);
  sent.length = 0;
  assert.equal(
    await publishSourceProofWakeups(proofJobs, env.INVENTORY_QUEUE),
    1,
  );
  assert.ok(sent.some(({ body }) => isSourceProofWakeup(body)));
  assert.deepEqual(await deliverProof(wakeup.body), ["ack"]);
  assert.deepEqual(await deliverProof(wakeup.body), ["ack"]);
  assert.equal((await proofJobs.load("a", sourceScope))?.grid_pending, 0);
  assert.equal(uploads, 1);
  assert.equal(stateAtUpload, "uncertain");
  assert.match(signed, /<GRIDSQUARE:4>FN32/);
  assert.match(signed, /<QSO_TIME:9>12:34:56Z/);
  assert.equal(signed.match(/<REC_TYPE:8>tCONTACT/g)?.length, 1);

  const outcome = () =>
    store
      .statement("SELECT state,reason,checks FROM inventory_lotw_grid_updates")
      .first();
  const makeDue = () =>
    store.statement("UPDATE inventory_lotw_grid_updates SET due_at=0").run();
  assert.deepEqual(await outcome(), {
    state: "uncertain",
    reason: "lotw_grid_dispatch_uncertain",
    checks: 0,
  });
  await makeDue();
  assert.deepEqual(await updates.step(env), {
    attempted: false,
    observed: false,
  });
  assert.equal(uploads, 1);
  assert.deepEqual(await outcome(), {
    state: "uncertain",
    reason: "lotw_grid_update_not_observed",
    checks: 1,
  });

  receipt = {
    ...receipt,
    MY_GRIDSQUARE: "FN32",
    APP_LOTW_RXQSO: new Date().toISOString().slice(0, 19).replace("T", " "),
  };
  await makeDue();
  assert.deepEqual(await updates.step(env), {
    attempted: false,
    observed: true,
  });
  assert.deepEqual(await outcome(), {
    state: "observed",
    reason: null,
    checks: 2,
  });
  assert.equal(uploads, 1);
  assert.equal(
    await store
      .statement("SELECT count(*) AS n FROM inventory_lotw_batches")
      .first("n"),
    0,
  );
});
