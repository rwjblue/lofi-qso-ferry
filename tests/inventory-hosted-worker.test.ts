import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { serializeAdifRecord } from "../src/adif.ts";
import { inventoryRuntime } from "../src/inventory-runtime.ts";
import { registerInventorySelection } from "../src/inventory-scheduler.ts";
import { Store } from "../src/store.ts";
import { keys, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

test("actual Worker cron drives paced inventory, comparison and historical adoption", async (t) => {
  const bundle = await build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["node:*"],
  });
  const output = bundle.outputFiles[0];
  assert.ok(output);
  let reads = 0;
  let qrzReads = 0;
  let qrzStatuses = 0;
  const lotwReads: [string | null, string | null][] = [];
  const readTimes: number[] = [];
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script: output.text,
      compatibilityDate: "2026-10-22",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      bindings: {
        ENVIRONMENT: "local",
        RP_ID: "localhost",
        ORIGIN: "http://localhost:8787",
        ACTIVE_KEK_VERSION: keys.active,
        KEK_V1: keys.keys["1"],
        AUTH_SECRET: "fixture-auth-secret",
        EMAIL_CODE_SECRET: "fixture-email-secret",
        EXPORTS_ENABLED: "false",
        INVENTORY_RUNTIME_MODE: "read_only",
      },
      queueProducers: { INVENTORY_QUEUE: "inventory-fixture" },
      queueConsumers: {
        "inventory-fixture": {
          maxBatchSize: 1,
          maxBatchTimeout: 0,
          maxRetries: 0,
        },
      },
      serviceBindings: { ASSETS: async () => new Response("fixture") },
      outboundService: async (request) => {
        const url = new URL(request.url);
        if (url.hostname === "lotw.arrl.org") {
          assert.equal(request.method, "GET");
          const start = url.searchParams.get("qso_startdate");
          const end = url.searchParams.get("qso_enddate");
          lotwReads.push([start, end]);
          assert.equal(url.searchParams.get("qso_qsorxsince"), "1900-01-01");
          assert.equal(url.searchParams.get("qso_owncall"), null);
          assert.equal(url.searchParams.get("qso_callsign"), null);
          if (start === "2026-11-01" && end === "2026-11-30")
            return new Response("x".repeat(2 * 1024 * 1024 + 1));
          return new Response(
            "<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:1>0<EOH><APP_LOTW_EOF>",
          );
        }
        if (url.hostname === "logbook.qrz.com") {
          assert.equal(request.method, "POST");
          const form = new URLSearchParams(await request.text());
          if (form.get("ACTION") === "STATUS") {
            qrzStatuses++;
            return new Response(
              new URLSearchParams({
                RESULT: "OK",
                BOOKID: "7",
                CALLSIGN: "N1RWJ",
                STARTDATE: "2025-01-01",
                ENDDATE: "2027-12-31",
              }),
            );
          }
          assert.equal(form.get("ACTION"), "FETCH");
          qrzReads++;
          return new Response(
            new URLSearchParams({
              RESULT: "OK",
              COUNT: "1",
              ADIF: serializeAdifRecord({
                OPERATOR: "N1RWJ",
                CALL: "W1AW",
                QSO_DATE: "20261108",
                TIME_ON: "1300",
                BAND: "20m",
                MODE: "CW",
                MY_GRIDSQUARE: "FN31",
                APP_QRZLOG_LOGID: "9",
              }),
            }),
          );
        }
        assert.equal(request.url, "https://lofi.ham2k.net/v1/sync");
        assert.equal(request.method, "POST");
        const body = (await request.json()) as {
          meta: { sync: { qsos: { limit: number; anyClient: boolean } } };
        };
        assert.equal(body.meta.sync.qsos.limit, 1000);
        assert.equal(body.meta.sync.qsos.anyClient, true);
        reads++;
        readTimes.push(Date.now());
        return Response.json({
          account: { uuid: "source" },
          operations:
            reads === 1
              ? [{ uuid: "op", stationCall: "N1RWJ", syncedAtMillis: 99 }]
              : [],
          qsos:
            reads === 1
              ? [
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
                  {
                    uuid: "q2",
                    operation: "op",
                    syncedAtMillis: 101,
                    startAtMillis: Date.parse("2026-11-08T13:01:00Z"),
                    their: { call: "W2AW" },
                    our: { grid: "FN31" },
                    band: "20m",
                    mode: "CW",
                  },
                ]
              : [],
          meta: {
            operations: { records_left: 0 },
            qsos: { records_left: 0 },
            suggestedSyncLoopDelay: 0,
          },
        });
      },
    }),
  );
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database("DB");
  // This entrypoint's foundation is real D1, with the complete ordered schema.
  const { applyMigration } = await import("./helpers.ts");
  await applyMigration(db, "0001_foundation.sql");
  await applyAdditionalMigrations(db);
  const store = new Store(db, keys);
  await seed(store);
  await store
    .statement(
      "UPDATE connections SET config='{\"accountId\":\"source\"}' WHERE id='source'",
    )
    .run();
  await store
    .statement(
      'UPDATE connections SET config=\'{"bookId":"7","stationCallsign":"N1RWJ","startDate":"2025-01-01","endDate":"2027-12-31"}\' WHERE id=\'destination\'',
    )
    .run();
  await store
    .statement("DELETE FROM private_data WHERE connection='source'")
    .run();
  await (
    await store.putPrivate("a", "source", "v1", "credential", {
      key: "browser:fixture",
      secret: "fixture-secret",
      token: "fixture-token",
    })
  ).run();
  await store
    .statement("DELETE FROM private_data WHERE connection='destination'")
    .run();
  await (
    await store.putPrivate("a", "destination", "v1", "credential", {
      apiKey: "fixture-qrz",
    })
  ).run();
  const credentials = (
    await db
      .prepare(
        "SELECT envelope FROM private_data WHERE kind='credential' ORDER BY connection",
      )
      .all()
  ).results;
  const worker = await runtime.getWorker();
  // Miniflare exposes experimental extra handlers at runtime; narrow the
  // generated proxy structurally rather than casting its experimental types.
  assert.ok("scheduled" in worker && typeof worker.scheduled === "function");
  await worker.scheduled({ scheduledTime: Date.now(), cron: "*/5 * * * *" });
  let state: {
    phase: string;
    published_at: number | null;
    next_due_at: number;
  } | null = null;
  for (let i = 0; i < 100; i++) {
    state = await db
      .prepare(
        "SELECT r.phase,w.published_at,j.next_due_at FROM inventory_runs r JOIN inventory_scopes s ON s.tenant=r.tenant AND s.scope_id=r.scope_id AND s.provider='lofi' JOIN inventory_stream_jobs j ON j.tenant=r.tenant AND j.active_run_id=r.run_id JOIN inventory_wakeups w ON w.tenant=j.tenant AND w.scope_id=j.scope_id AND w.stream_id=j.stream_id AND w.work_version=j.work_version WHERE r.phase='catchup'",
      )
      .first();
    if (state?.published_at) break;
    await delay(50);
  }
  assert.equal(
    state?.phase,
    "catchup",
    JSON.stringify({
      reads,
      qrzReads,
      runs: (
        await db
          .prepare(
            "SELECT s.provider,r.phase,j.state,j.reason FROM inventory_runs r JOIN inventory_scopes s ON s.tenant=r.tenant AND s.scope_id=r.scope_id JOIN inventory_stream_jobs j ON j.tenant=r.tenant AND j.scope_id=r.scope_id AND j.stream_id=r.stream_id ORDER BY s.provider",
          )
          .all()
      ).results,
    }),
  );
  assert.ok(state.published_at);
  assert.ok(state.next_due_at >= readTimes[0] + 19000);
  assert.equal(reads, 1);
  assert.equal(
    (
      await db
        .prepare("SELECT mode FROM inventory_runtime")
        .first<{ mode: string }>()
    )?.mode,
    "inventory_read_only",
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) n FROM inventory_records r JOIN inventory_scopes s ON s.tenant=r.tenant AND s.scope_id=r.scope_id WHERE s.provider='lofi'",
        )
        .first<{ n: number }>()
    )?.n,
    3,
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) n FROM inventory_run_membership r JOIN inventory_scopes s ON s.tenant=r.tenant AND s.scope_id=r.scope_id WHERE s.provider='lofi'",
        )
        .first<{ n: number }>()
    )?.n,
    3,
  );
  for (const table of [
    "source_work",
    "ledger",
    "attempts",
    "source_export_proofs",
  ])
    assert.equal(
      (
        await db
          .prepare(`SELECT count(*) n FROM ${table}`)
          .first<{ n: number }>()
      )?.n,
      0,
    );
  assert.deepEqual(
    (
      await db
        .prepare(
          "SELECT envelope FROM private_data WHERE kind='credential' ORDER BY connection",
        )
        .all()
    ).results,
    credentials,
  );
  let phase: string | null = null;
  for (let i = 0; i < 400; i++) {
    phase = await db
      .prepare(
        "SELECT r.phase FROM inventory_runs r JOIN inventory_scopes s ON s.tenant=r.tenant AND s.scope_id=r.scope_id WHERE s.provider='lofi' LIMIT 1",
      )
      .first<string>("phase");
    if (phase === "complete") break;
    await delay(100);
  }
  assert.equal(
    phase,
    "complete",
    "real delayed Queue delivery completes catch-up and local controls",
  );
  assert.equal(reads, 2);
  assert.ok(
    readTimes[1] - readTimes[0] >= 19000,
    "the next provider request respects the durable initial pacing reservation",
  );
  let compared: {
    idle_turns: number;
    phase_count: number;
    not_before: number | null;
    state: string;
  } | null = null;
  for (let i = 0; i < 200; i++) {
    compared = await db
      .prepare(
        "SELECT c.idle_turns,c.phase_count,w.not_before,g.state FROM inventory_comparison_coordinators c JOIN inventory_comparison_wakeups w ON w.tenant=c.tenant JOIN comparison_domains d ON d.tenant=c.tenant JOIN index_generations g ON g.tenant=d.tenant AND g.generation_id=d.active_generation WHERE c.tenant='a'",
      )
      .first();
    if (
      compared?.idle_turns === compared?.phase_count &&
      compared?.not_before === null
    )
      break;
    await delay(50);
  }
  assert.ok(compared);
  assert.equal(compared.state, "active");
  assert.equal(compared.idle_turns, 11);
  assert.equal(compared.not_before, null);
  assert.deepEqual(
    await db
      .prepare(
        "SELECT count(*) AS n FROM comparison_projections WHERE reason='source_coverage_incomplete'",
      )
      .first(),
    { n: 0 },
  );
  assert.equal(
    reads,
    2,
    "derived comparison Queue turns make no provider calls",
  );
  assert.equal(
    qrzReads,
    2,
    "independent QRZ full scan and catch-up need no per-contact discovery",
  );
  assert.equal(qrzStatuses, 2);
  assert.deepEqual(
    await db
      .prepare(
        "SELECT count(*) AS n FROM match_results_current WHERE state='absent_at_inventory'",
      )
      .first(),
    { n: 1 },
  );
  assert.deepEqual(
    await db.prepare("SELECT count(*) AS n FROM attempts").first(),
    { n: 0 },
  );
  assert.deepEqual(
    await db
      .prepare(
        "SELECT (SELECT count(*) FROM match_results_current WHERE state='matched_existing') AS matched,(SELECT count(*) FROM inventory_historical_associations WHERE record_key='q1') AS historical,(SELECT count(*) FROM inventory_adoption_work) AS pending",
      )
      .first(),
    { matched: 1, historical: 1, pending: 0 },
  );
  assert.deepEqual(
    (
      await db
        .prepare(
          "SELECT month_start FROM inventory_source_calendar_months WHERE tenant='a'",
        )
        .all()
    ).results,
    [{ month_start: "2026-11-01" }],
  );
  assert.deepEqual(
    (
      await db
        .prepare(
          "SELECT envelope FROM private_data WHERE kind='credential' ORDER BY connection",
        )
        .all()
    ).results,
    credentials,
  );

  await store
    .statement(
      `INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at,config)
       VALUES('a','lotw','lotw','fixture','LoTW','active','v1',1,'{"readAccess":true}')`,
    )
    .run();
  await (
    await store.putPrivate("a", "lotw", "v1", "credential", {
      query: { username: "fixture", password: "fixture" },
    })
  ).run();
  await worker.scheduled({ scheduledTime: Date.now(), cron: "*/5 * * * *" });
  let lotwPhase: string | null = null;
  for (let i = 0; i < 100; i++) {
    lotwPhase = await db
      .prepare(
        "SELECT r.phase FROM inventory_runs r JOIN inventory_scopes s ON s.tenant=r.tenant AND s.scope_id=r.scope_id WHERE s.provider='lotw'",
      )
      .first<string>("phase");
    if (lotwPhase === "held") break;
    await delay(50);
  }
  assert.equal(lotwPhase, "held");
  assert.deepEqual(lotwReads, [["2026-11-01", "2026-11-30"]]);
  const link = await store.connection("a", "lotw");
  assert.ok(link);
  // Simulate interruption after persisting the first half.
  await registerInventorySelection(store, await inventoryRuntime(store), link, {
    provider: "lotw",
    selection: { startDate: "2026-11-01", endDate: "2026-11-15" },
  });
  await worker.scheduled({ scheduledTime: Date.now(), cron: "*/5 * * * *" });
  let completeChildren: number | null = null;
  for (let i = 0; i < 120; i++) {
    completeChildren = await db
      .prepare(
        "SELECT count(*) AS n FROM inventory_runs r JOIN inventory_scopes s ON s.tenant=r.tenant AND s.scope_id=r.scope_id WHERE s.provider='lotw' AND r.phase='complete' AND r.mode='full'",
      )
      .first<number>("n");
    if (completeChildren === 2) break;
    await delay(50);
  }
  assert.equal(completeChildren, 2);
  assert.deepEqual(lotwReads.toSorted(), [
    ["2026-11-01", "2026-11-15"],
    ["2026-11-01", "2026-11-30"],
    ["2026-11-16", "2026-11-30"],
  ]);
  assert.deepEqual(
    await db
      .prepare(
        "SELECT j.state,j.reason,c.state AS coverage FROM inventory_stream_jobs j JOIN inventory_coverage c USING(tenant,scope_id,stream_id) WHERE j.reason='overflow_split'",
      )
      .first(),
    { state: "held", reason: "overflow_split", coverage: "held" },
  );
  await worker.scheduled({ scheduledTime: Date.now(), cron: "*/5 * * * *" });
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) AS n FROM inventory_scheduled_selections p JOIN inventory_scopes s USING(tenant,scope_id) WHERE s.provider='lotw'",
      )
      .first("n"),
    3,
  );
  assert.equal(lotwReads.length, 3);
});
