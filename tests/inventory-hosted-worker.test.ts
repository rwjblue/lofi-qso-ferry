import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { serializeAdifRecord } from "../src/adif.ts";
import { InventoryDeliveryWorkspace } from "../src/inventory-delivery-workspace.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import { InventoryOwnership } from "../src/inventory-ownership.ts";
import { InventoryQrzDispatch } from "../src/inventory-qrz-dispatch.ts";
import { InventoryQrzNeighborhood } from "../src/inventory-qrz-neighborhood.ts";
import { InventoryQrzPreparation } from "../src/inventory-qrz-preparation.ts";
import {
  consumeQrzRecoveryWakeups,
  publishQrzRecoveryWakeups,
} from "../src/inventory-qrz-recovery.ts";
import { InventoryRuns } from "../src/inventory-runs.ts";
import { inventoryRuntime } from "../src/inventory-runtime.ts";
import { registerInventorySelection } from "../src/inventory-scheduler.ts";
import { InventorySourceProofDrain } from "../src/inventory-source-proof-drain.ts";
import { InventorySourceProofJobs } from "../src/inventory-source-proof-jobs.ts";
import { InventorySourceProofWorkspace } from "../src/inventory-source-proof-workspace.ts";
import { lockRestoredDatabase } from "../src/restore.ts";
import { type Lease, Store } from "../src/store.ts";
import { TEMPLATE_PROFILE } from "../src/templates.ts";
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
  let recoveryFixture: { adif: string | null; actions: string[] } | null = null;
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
          if (recoveryFixture) {
            const action = form.get("ACTION");
            assert.ok(action === "STATUS" || action === "FETCH");
            recoveryFixture.actions.push(action);
            if (action === "FETCH") {
              assert.match(form.get("OPTION") ?? "", /CALL:W2AW/);
              return new Response(
                new URLSearchParams({
                  RESULT: "OK",
                  COUNT: recoveryFixture.adif ? "1" : "0",
                  ADIF: recoveryFixture.adif ?? "",
                }),
              );
            }
          }
          if (form.get("ACTION") === "STATUS") {
            if (!recoveryFixture) qrzStatuses++;
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
                  {
                    uuid: "q3",
                    operation: "op",
                    syncedAtMillis: 102,
                    startAtMillis: Date.parse("2026-11-08T13:42:00Z"),
                    their: { call: "W3AW" },
                    our: { grid: "FN31" },
                    band: "20m",
                    mode: "CW",
                  },
                  {
                    uuid: "q4",
                    operation: "op",
                    syncedAtMillis: 103,
                    startAtMillis: Date.parse("2026-11-08T14:30:00Z"),
                    their: { call: "W4AW" },
                    our: { grid: "FN31" },
                    band: "20m",
                    mode: "CW",
                  },
                  {
                    uuid: "q5",
                    operation: "op",
                    syncedAtMillis: 104,
                    startAtMillis: Date.parse("2026-11-08T15:20:00Z"),
                    their: { call: "W5AW" },
                    our: { grid: "FN31" },
                    band: "20m",
                    mode: "CW",
                  },
                ]
              : [],
          meta: {
            operations: {
              records_left: 0,
              ...(reads === 3 ? { next_cursor: "terminal-operation" } : {}),
            },
            qsos: {
              records_left: 0,
              ...(reads === 3 ? { next_cursor: "terminal-qso" } : {}),
            },
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
  await db
    .prepare(
      "INSERT INTO cursors VALUES('a','source','context','{\"complete\":true}',1,0)",
    )
    .run();
  await store
    .statement(
      "UPDATE connections SET config='{\"accountId\":\"source\"}' WHERE id='source'",
    )
    .run();
  await store
    .statement(
      'UPDATE connections SET remote_identity=\'7\',config=\'{"bookId":"7","stationCallsign":"N1RWJ","startDate":"2025-01-01","endDate":"2027-12-31"}\' WHERE id=\'destination\'',
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
    6,
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) n FROM inventory_run_membership r JOIN inventory_scopes s ON s.tenant=r.tenant AND s.scope_id=r.scope_id WHERE s.provider='lofi'",
        )
        .first<{ n: number }>()
    )?.n,
    6,
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
    { n: 4 },
  );
  assert.deepEqual(
    (
      await db
        .prepare(
          "SELECT provider,record_key,decision FROM inventory_delivery_review_current ORDER BY record_key",
        )
        .all()
    ).results,
    [
      { provider: "qrz", record_key: "q2", decision: "source_proof_required" },
      { provider: "qrz", record_key: "q3", decision: "source_proof_required" },
      { provider: "qrz", record_key: "q4", decision: "source_proof_required" },
      { provider: "qrz", record_key: "q5", decision: "source_proof_required" },
    ],
  );
  const sourceScope = await db
    .prepare("SELECT scope_id FROM inventory_scopes WHERE provider='lofi'")
    .first<string>("scope_id");
  assert.ok(sourceScope);
  const captured = await new InventorySourceProofWorkspace(store).capture(
    "a",
    sourceScope,
    ["q2"],
  );
  assert.equal(captured.kind, "captured");
  if (captured.kind !== "captured") assert.fail(JSON.stringify(captured));
  assert.deepEqual(
    captured.snapshot.dependencies.map(({ target }) => [
      target.kind,
      target.id,
    ]),
    [
      ["operation", "op"],
      ["qso", "q2"],
    ],
  );
  const observedAt = await db
    .prepare(
      "SELECT p.request_started_at FROM inventory_record_facets f JOIN ingestion_pages p ON p.tenant=f.tenant AND p.page_id=f.last_page_id WHERE f.facet='source' AND f.record_key='q2'",
    )
    .first<number>("request_started_at");
  assert.ok(observedAt && observedAt <= readTimes[0]);
  assert.deepEqual(
    captured.snapshot.cachedWitnesses.map(
      (witness) => witness.requestStartedAt,
    ),
    [observedAt, observedAt],
  );
  assert.ok(captured.snapshot.contacts[0].eligibleAfter > Date.now());
  const jobs = new InventorySourceProofJobs(
    new InventoryRuns(new InventoryIngestion(store)),
    async () =>
      assert.fail("fresh committed witnesses should avoid collection HTTP"),
  );
  assert.equal((await jobs.enqueue("a", sourceScope, ["q2"])).kind, "quiet");
  // Move the fixture's due clocks back while preserving its published inputs.
  const ageQuietClocks = async () => {
    for (const [triggers, update] of [
      [
        ["comparison_projection_version"],
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
        triggers.map((trigger) =>
          db
            .prepare(
              "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",
            )
            .bind(trigger)
            .first<string>("sql"),
        ),
      );
      await db.batch([
        ...triggers.map((trigger) => db.prepare(`DROP TRIGGER ${trigger}`)),
        db.prepare(update).bind(Date.now() - 3_600_000),
        ...ddl.map((sql: string | null) => {
          assert.ok(sql);
          return db.prepare(sql);
        }),
      ]);
    }
  };
  await ageQuietClocks();
  const queuedProof = await jobs.enqueue("a", sourceScope, [
    "q2",
    "q3",
    "q4",
    "q5",
  ]);
  assert.equal(queuedProof.kind, "queued", JSON.stringify(queuedProof));
  if (queuedProof.kind !== "queued") assert.fail();
  assert.deepEqual(await jobs.enqueue("a", sourceScope, ["q2"]), {
    kind: "existing",
    id: queuedProof.id,
  });
  const drain = new InventorySourceProofDrain(jobs.runs);
  assert.equal(
    await drain.observed(captured.snapshot.source, Date.now()),
    null,
  );
  assert.equal((await jobs.load("a", sourceScope))?.phase, "collecting");
  await worker.scheduled({ scheduledTime: Date.now(), cron: "*/5 * * * *" });
  const reloaded = new InventorySourceProofJobs(jobs.runs, jobs.fetcher);
  let collected: Awaited<ReturnType<typeof reloaded.load>> = null;
  for (let i = 0; i < 500; i++) {
    collected = await reloaded.load("a", sourceScope);
    if (collected?.phase === "complete" || collected?.phase === "held") break;
    await delay(100);
  }
  assert.equal(
    collected?.phase,
    "complete",
    JSON.stringify({
      phase: collected?.phase,
      reason: collected?.reason,
      reads,
    }),
  );
  assert.ok(collected?.collection_finished_at);
  const collectedAt = collected.collection_finished_at;
  const receipt = await drain.observed(captured.snapshot.source, collectedAt);
  assert.equal(receipt?.run_id, collected.drain_run);
  assert.ok(receipt && receipt.request_started_at >= collectedAt);
  assert.deepEqual(
    await db
      .prepare(
        "SELECT json_type(committed_checkpoint,'$.operations.cursor') AS operation_cursor,json_type(committed_checkpoint,'$.qsos.cursor') AS qso_cursor FROM inventory_streams WHERE scope_id=?",
      )
      .bind(sourceScope)
      .first(),
    { operation_cursor: null, qso_cursor: null },
  );
  assert.equal(
    await drain.observed(
      captured.snapshot.source,
      receipt.request_started_at + 1,
    ),
    null,
  );

  assert.deepEqual([reads, qrzReads], [3, 2]);
  assert.equal(
    (await reloaded.current("a", queuedProof.id))?.expires_at,
    observedAt + 300_000,
  );
  assert.equal(collected.attempts, 1);
  assert.deepEqual(await reloaded.enqueue("a", sourceScope, ["q2"]), {
    kind: "complete",
    id: queuedProof.id,
    expiresAt: observedAt + 300_000,
  });
  assert.equal(
    (await reloaded.step("a", sourceScope, queuedProof.id)).kind,
    "complete",
  );
  assert.equal(
    await db
      .prepare("SELECT count(*) AS n FROM inventory_source_proofs")
      .first("n"),
    1,
  );
  assert.deepEqual(
    await db.prepare("SELECT count(*) AS n FROM attempts").first(),
    { n: 0 },
  );
  const qrzScope = await db
    .prepare("SELECT scope_id FROM inventory_scopes WHERE provider='qrz'")
    .first<string>("scope_id");
  assert.ok(qrzScope);
  const delivery = new InventoryDeliveryWorkspace(store);
  let preparation = await delivery.capture("a", queuedProof.id, qrzScope, [
    "q2",
  ]);
  for (let i = 0; i < 100 && preparation.kind !== "captured"; i++) {
    if (preparation.reason === "destination_review_quiet")
      await ageQuietClocks();
    else if (preparation.reason === "destination_review_stale") await delay(50);
    else break;
    preparation = await delivery.capture("a", queuedProof.id, qrzScope, ["q2"]);
  }
  assert.equal(preparation.kind, "captured", JSON.stringify(preparation));
  if (preparation.kind !== "captured") assert.fail();
  assert.equal(preparation.stats.dependencies, 2);
  assert.equal(preparation.members[0].contact.call, "W2AW");
  assert.equal(preparation.members[0].contact.stationCall, "N1RWJ");
  assert.equal(preparation.members[0].contact.operationId, "op");
  assert.equal(preparation.members[0].review.provider, "qrz");
  assert.deepEqual(
    await delivery.capture("a", queuedProof.id, qrzScope, ["q1"]),
    {
      kind: "held",
      reason: "contact_outside_source_proof",
    },
  );
  await db.batch([
    store.statement(
      "INSERT INTO templates VALUES('a','destination',?,?,1),('a','destination',?,?,1)",
      "original",
      JSON.stringify({
        profile: TEMPLATE_PROFILE,
        fields: { COMMENT: "{{ op.station }} to {{ qso.call }} at {{ now }}" },
        fallbackNotes: false,
      }),
      "changed",
      JSON.stringify({
        profile: TEMPLATE_PROFILE,
        fields: { COMMENT: "Changed template" },
        fallbackNotes: false,
      }),
    ),
    store.statement(
      "INSERT INTO active_templates VALUES('a','destination','original')",
    ),
  ]);
  const qrz = new InventoryQrzPreparation(store);
  const stageArgs = ["a", queuedProof.id, qrzScope, ["q2"]] as const;
  // A late template rebind during publication must roll back every insert.
  await db
    .prepare(
      `CREATE TRIGGER fixture_qrz_rebind AFTER INSERT ON inventory_qrz_attempts
       BEGIN UPDATE active_templates SET version='changed' WHERE tenant='a' AND destination='destination'; END;`,
    )
    .run();
  assert.deepEqual(await qrz.prepare(...stageArgs, "lost-fence"), {
    kind: "held",
    reason: "qrz_preparation_changed",
  });
  assert.equal(
    await db
      .prepare("SELECT count(*) AS n FROM inventory_qrz_preparations")
      .first("n"),
    0,
  );
  assert.equal(
    await db
      .prepare("SELECT count(*) AS n FROM inventory_qrz_attempts")
      .first("n"),
    0,
  );
  await db.prepare("DROP TRIGGER fixture_qrz_rebind").run();
  const staged = await qrz.prepare(...stageArgs, "stable-stage");
  if (staged.kind !== "prepared") assert.fail(staged.reason);
  const [attempt] = staged.attempts;
  const recovered = new InventoryQrzPreparation(new Store(db, keys));
  assert.deepEqual(
    await recovered.prepare(...stageArgs, "stable-stage"),
    staged,
  );
  const artifact = await recovered.artifact("a", attempt.attempt_id);
  assert.ok(artifact);
  assert.equal(artifact.hash, attempt.request_hash);
  assert.equal(artifact.record.CALL, "W2AW");
  assert.match(artifact.record.COMMENT, /^N1RWJ to W2AW at /);
  await assert.rejects(
    qrz.prepare(...stageArgs, "overlap"),
    /UNIQUE constraint/,
  );
  assert.equal(
    await db
      .prepare("SELECT count(*) AS n FROM inventory_qrz_preparations")
      .first("n"),
    1,
  );
  assert.equal(await qrz.current("a", attempt.attempt_id), true);
  assert.equal(await qrz.cancelStale("a", attempt.attempt_id), false);
  await db.prepare("UPDATE active_templates SET version='changed'").run();
  assert.equal(await qrz.current("a", attempt.attempt_id), false);
  assert.deepEqual(await recovered.artifact("a", attempt.attempt_id), artifact);
  await db.prepare("UPDATE active_templates SET version='original'").run();
  assert.equal(await qrz.current("a", attempt.attempt_id), true);
  // Read the native fence after the route edit, then roll back the fixture edit.
  await db
    .prepare(
      `CREATE TRIGGER fixture_qrz_route_check AFTER UPDATE OF config ON connections
       WHEN NEW.tenant='a' AND NEW.id='destination' BEGIN
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_qrz_attempt_current WHERE tenant=NEW.tenant)
         THEN RAISE(ABORT,'fixture QRZ route fenced') END;
       END;`,
    )
    .run();
  await assert.rejects(
    db
      .prepare(
        "UPDATE connections SET config=json_set(config,'$.endDate','2025-01-01') WHERE id='destination'",
      )
      .run(),
    /fixture QRZ route fenced/,
  );
  await db.prepare("DROP TRIGGER fixture_qrz_route_check").run();
  await db
    .prepare(
      `CREATE TRIGGER fixture_qrz_source_check AFTER UPDATE OF semantic_version ON inventory_record_facets
       WHEN NEW.tenant='a' AND NEW.record_key='q2' BEGIN
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_qrz_attempt_current WHERE tenant=NEW.tenant)
         THEN RAISE(ABORT,'fixture QRZ source fenced') END;
       END;`,
    )
    .run();
  await assert.rejects(
    db
      .prepare(
        "UPDATE inventory_record_facets SET semantic_version=semantic_version+1 WHERE tenant='a' AND record_key='q2' AND facet='source'",
      )
      .run(),
    /fixture QRZ source fenced/,
  );
  await db.prepare("DROP TRIGGER fixture_qrz_source_check").run();
  assert.equal(await qrz.current("a", attempt.attempt_id), true);
  let freshReads = 0;
  let neighborhoodMode: "race" | "empty" | "candidate" = "race";
  const neighborhood = new InventoryQrzNeighborhood(
    store,
    async (input, init) => {
      assert.equal(String(input), "https://logbook.qrz.com/api");
      assert.equal(init?.method, "POST");
      const form = init?.body;
      assert.ok(form instanceof URLSearchParams);
      assert.equal(form.get("ACTION"), "FETCH");
      assert.match(form.get("OPTION") ?? "", /CALL:W2AW/);
      freshReads++;
      if (neighborhoodMode === "race")
        await db.prepare("UPDATE active_templates SET version='changed'").run();
      if (neighborhoodMode === "candidate")
        return new Response(
          `RESULT=OK&COUNT=1&ADIF=${serializeAdifRecord({
            ...artifact.record,
            APP_QRZLOG_LOGID: "2",
          })}`,
        );
      return new Response("RESULT=OK&COUNT=0&ADIF=");
    },
  );
  const deliveryLease = await neighborhood.acquire("a", attempt.attempt_id);
  assert.ok(deliveryLease);
  assert.equal(await neighborhood.acquire("a", attempt.attempt_id), null);
  assert.deepEqual(
    await neighborhood.observe(attempt.attempt_id, deliveryLease),
    {
      kind: "held",
      reason: "attempt_stale",
    },
  );
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) AS n FROM inventory_qrz_neighborhood_observations",
      )
      .first("n"),
    0,
  );
  await db.prepare("UPDATE active_templates SET version='original'").run();
  neighborhoodMode = "candidate";
  const duplicate = await neighborhood.observe(
    attempt.attempt_id,
    deliveryLease,
  );
  if (duplicate.kind !== "observed") assert.fail(JSON.stringify(duplicate));
  assert.equal(duplicate.candidateCount, 1);
  neighborhoodMode = "empty";
  const empty = await neighborhood.observe(attempt.attempt_id, deliveryLease);
  if (empty.kind !== "observed") assert.fail(JSON.stringify(empty));
  assert.equal(empty.candidateCount, 0);
  assert.equal(
    await db
      .prepare(
        "SELECT candidate_count FROM inventory_qrz_neighborhood_current WHERE observation_id=?",
      )
      .bind(empty.id)
      .first("candidate_count"),
    0,
  );
  assert.equal(
    await db
      .prepare("SELECT count(*) AS n FROM inventory_qrz_neighborhood_current")
      .first("n"),
    1,
  );
  assert.equal(freshReads, 3);
  await store.release(deliveryLease);
  assert.equal(
    await db
      .prepare("SELECT count(*) AS n FROM inventory_qrz_neighborhood_current")
      .first("n"),
    0,
  );
  assert.deepEqual(
    await neighborhood.observe(attempt.attempt_id, deliveryLease),
    {
      kind: "held",
      reason: "attempt_stale",
    },
  );
  assert.equal(freshReads, 3);
  await db.prepare("UPDATE active_templates SET version='changed'").run();
  assert.equal(await qrz.cancelStale("a", attempt.attempt_id), true);
  await db.prepare("UPDATE active_templates SET version='original'").run();
  const sendStage = await qrz.prepare(...stageArgs, "send-stage");
  if (sendStage.kind !== "prepared") assert.fail(sendStage.reason);
  const sendAttempt = sendStage.attempts[0].attempt_id;
  const sendArtifact = await qrz.artifact("a", sendAttempt);
  assert.ok(sendArtifact);
  let dispatchReads = 0;
  let inserts = 0;
  const writes: {
    adif: string | null;
    fields: string[];
    unsettled: unknown;
  }[] = [];
  let sendMode: "candidate" | "budget" | "lost" = "candidate";
  const writeGates = () => ({
    exportsEnabled: true,
    liveWriteAuthorized: true,
    sourceBoundaryVerified: false,
    qrzFreshInsertsEnabled: true,
    allowedQsoIds: ["q2"],
    allowedDestinationIds: ["destination"],
  });
  const vendor: typeof fetch = async (_input, init) => {
    const form = init?.body;
    assert.ok(form instanceof URLSearchParams);
    const action = form.get("ACTION");
    if (action === "INSERT") {
      inserts++;
      writes.push({
        adif: form.get("ADIF"),
        fields: [...form.keys()],
        unsettled: await db
          .prepare(
            "SELECT count(*) AS n FROM inventory_qrz_dispatch_pending WHERE attempt_id=?",
          )
          .bind(sendAttempt)
          .first("n"),
      });
      throw new Error("fixture lost the response");
    }
    dispatchReads++;
    if (action === "STATUS")
      return new Response(
        "RESULT=OK&BOOKID=7&CALLSIGN=N1RWJ&STARTDATE=2025-01-01&ENDDATE=2027-12-31",
      );
    assert.equal(action, "FETCH");
    if (sendMode === "budget")
      await db
        .prepare(
          "UPDATE vendor_requests SET cooldown_until=? WHERE vendor='qrz'",
        )
        .bind(Date.now() + 60_000)
        .run();
    if (sendMode === "candidate")
      return new Response(
        `RESULT=OK&COUNT=1&ADIF=${serializeAdifRecord({
          ...sendArtifact.record,
          APP_QRZLOG_LOGID: "002",
        })}`,
      );
    return new Response("RESULT=OK&COUNT=0&ADIF=");
  };
  const dispatch = new InventoryQrzDispatch(store, vendor);
  assert.deepEqual(
    await dispatch.send("a", sendAttempt, () => ({
      ...writeGates(),
      exportsEnabled: false,
    })),
    { kind: "held", reason: "qrz_exports_disabled" },
  );
  assert.equal(dispatchReads, 0);
  assert.deepEqual(await dispatch.send("a", sendAttempt, writeGates), {
    kind: "held",
    reason: "qrz_neighborhood_has_candidate",
  });
  sendMode = "budget";
  assert.equal(
    (await dispatch.send("a", sendAttempt, writeGates)).kind,
    "deferred",
  );
  assert.equal(
    await db
      .prepare("SELECT count(*) AS n FROM inventory_qrz_dispatches")
      .first("n"),
    0,
  );
  assert.equal(inserts, 0);
  await db
    .prepare("UPDATE vendor_requests SET cooldown_until=0 WHERE vendor='qrz'")
    .run();
  sendMode = "lost";
  await db
    .prepare(
      `CREATE TRIGGER fixture_qrz_dispatch_race BEFORE INSERT ON inventory_qrz_dispatch_guards
       BEGIN UPDATE active_templates SET version='changed' WHERE tenant='a' AND destination='destination'; END;`,
    )
    .run();
  assert.deepEqual(await dispatch.send("a", sendAttempt, writeGates), {
    kind: "held",
    reason: "dispatch_authority_changed",
  });
  assert.equal(inserts, 0);
  await db.prepare("DROP TRIGGER fixture_qrz_dispatch_race").run();
  class StoppedWorker extends Store {
    strandedLease?: Lease;
    override async release(lease: Lease) {
      this.strandedLease = lease;
    }
  }
  const stopped = new StoppedWorker(db, keys);
  assert.deepEqual(
    await new InventoryQrzDispatch(stopped, vendor).send(
      "a",
      sendAttempt,
      writeGates,
    ),
    {
      kind: "uncertain",
    },
  );
  assert.equal(inserts, 1);
  assert.deepEqual(writes, [
    {
      adif: sendArtifact.adif,
      fields: ["KEY", "ACTION", "ADIF"],
      unsettled: 1,
    },
  ]);
  assert.equal(await qrz.cancelStale("a", sendAttempt), false);
  const restarted = new InventoryQrzDispatch(new Store(db, keys), vendor);
  const beforeRecovery = dispatchReads;
  assert.deepEqual(await restarted.send("a", sendAttempt, writeGates), {
    kind: "uncertain",
  });
  assert.equal(dispatchReads, beforeRecovery);
  assert.deepEqual(await restarted.reconcile("a", sendAttempt), {
    kind: "uncertain",
  });
  assert.equal(dispatchReads, beforeRecovery);
  assert.ok(stopped.strandedLease);
  const dueRecovery = () =>
    store
      .statement(
        "UPDATE inventory_qrz_recovery_jobs SET due_at=? WHERE tenant='a' AND attempt_id=?",
        Date.now() - 1,
        sendAttempt,
      )
      .run();
  const recoveryJob = () =>
    store
      .statement(
        "SELECT version,turns,due_at,published_version FROM inventory_qrz_recovery_jobs WHERE tenant='a' AND attempt_id=?",
        sendAttempt,
      )
      .first<{
        version: number;
        turns: number;
        due_at: number;
        published_version: number;
      }>();
  assert.equal((await recoveryJob())?.version, 1);
  assert.ok((await recoveryJob())!.due_at > Date.now());
  await dueRecovery();
  recoveryFixture = { adif: null, actions: [] };
  await worker.scheduled({ scheduledTime: Date.now(), cron: "*/5 * * * *" });
  assert.equal((await recoveryJob())?.published_version, 0);
  await store.release(stopped.strandedLease);
  await assert.rejects(
    publishQrzRecoveryWakeups(store, {
      async sendBatch() {
        throw new Error("fixture recovery Queue unavailable");
      },
    }),
    /fixture recovery Queue unavailable/,
  );
  assert.equal((await recoveryJob())?.published_version, 0);
  await worker.scheduled({ scheduledTime: Date.now(), cron: "*/5 * * * *" });
  for (let i = 0; i < 120 && recoveryFixture.actions.length < 2; i++)
    await delay(50);
  assert.deepEqual(recoveryFixture.actions, ["STATUS", "FETCH"]);
  const retry = await recoveryJob();
  assert.equal(retry?.turns, 1);
  assert.equal(retry?.version, 2);
  assert.ok(retry && retry.due_at > Date.now() + 240_000);
  for (let i = 0; i < 120; i++) {
    const leaseUntil = await store
      .statement(
        "SELECT expires_at FROM leases WHERE tenant=? AND scope=?",
        "a",
        stopped.strandedLease.scope,
      )
      .first<number>("expires_at");
    if (!leaseUntil) break;
    await delay(50);
  }
  let acknowledged = false;
  await consumeQrzRecoveryWakeups(
    new InventoryQrzDispatch(store, async () =>
      assert.fail(
        "a superseded QRZ recovery message must not read the provider",
      ),
    ),
    [
      {
        id: "stale-recovery",
        timestamp: new Date(),
        attempts: 1,
        body: {
          kind: "inventory-qrz-recovery",
          version: 1,
          tenant: "a",
          attempt: sendAttempt,
          workVersion: 1,
        },
        ack() {
          acknowledged = true;
        },
        retry() {
          assert.fail("superseded recovery was retried");
        },
      },
    ],
  );
  assert.ok(acknowledged);
  await db.prepare("UPDATE accounts SET quiet_minutes=31 WHERE id='a'").run();
  assert.equal(await reloaded.current("a", queuedProof.id), null);
  recoveryFixture.adif = serializeAdifRecord({
    ...sendArtifact.record,
    APP_QRZLOG_LOGID: "002",
  });
  await dueRecovery();
  await worker.scheduled({ scheduledTime: Date.now(), cron: "*/5 * * * *" });
  for (let i = 0; i < 120 && (await recoveryJob()); i++) await delay(50);
  assert.equal(await recoveryJob(), null);
  assert.deepEqual(recoveryFixture.actions, [
    "STATUS",
    "FETCH",
    "STATUS",
    "FETCH",
  ]);
  recoveryFixture = null;
  assert.equal(inserts, 1);
  assert.equal(
    await db
      .prepare("SELECT count(*) AS n FROM inventory_qrz_dispatch_pending")
      .first("n"),
    0,
  );
  assert.deepEqual(await restarted.send("a", sendAttempt, writeGates), {
    kind: "observed",
    remoteId: "2",
  });
  assert.equal(await qrz.cancelStale("a", sendAttempt), false);
  await db.prepare("UPDATE accounts SET quiet_minutes=30 WHERE id='a'").run();
  await ageQuietClocks();
  const direct = await qrz.prepare(
    "a",
    queuedProof.id,
    qrzScope,
    ["q3"],
    "direct",
  );
  if (direct.kind !== "prepared") assert.fail(direct.reason);
  const directAttempt = direct.attempts[0].attempt_id;
  const directArtifact = await qrz.artifact("a", directAttempt);
  assert.ok(directArtifact);
  const sentAdif: (string | null)[] = [];
  const directSend = new InventoryQrzDispatch(store, async (_input, init) => {
    const form = init?.body;
    assert.ok(form instanceof URLSearchParams);
    if (form.get("ACTION") === "FETCH")
      return new Response("RESULT=OK&COUNT=0&ADIF=");
    assert.equal(form.get("ACTION"), "INSERT");
    sentAdif.push(form.get("ADIF"));
    return new Response("RESULT=OK&COUNT=1&LOGID=0003");
  });
  const directGates = () => ({ ...writeGates(), allowedQsoIds: ["q3"] });
  assert.deepEqual(await directSend.send("a", directAttempt, directGates), {
    kind: "delivered",
    remoteId: "3",
  });
  assert.deepEqual(await directSend.reconcile("a", directAttempt), {
    kind: "delivered",
    remoteId: "3",
  });
  assert.deepEqual(sentAdif, [directArtifact.adif]);
  assert.deepEqual(
    (
      await db
        .prepare(
          "SELECT record_key,remote_id FROM inventory_qrz_delivery_owners ORDER BY record_key",
        )
        .all()
    ).results,
    [
      { record_key: "q2", remote_id: "2" },
      { record_key: "q3", remote_id: "3" },
    ],
  );
  const restoreStage = await qrz.prepare(
    "a",
    queuedProof.id,
    qrzScope,
    ["q4", "q5"],
    "restore-fixture",
  );
  if (restoreStage.kind !== "prepared") assert.fail(restoreStage.reason);
  const [mayHaveSent, preparedAtSnapshot] = restoreStage.attempts;
  assert.deepEqual(
    restoreStage.attempts.map((row) => row.record_key),
    ["q4", "q5"],
  );
  const restoreArtifacts = await Promise.all(
    restoreStage.attempts.map((row) => qrz.artifact("a", row.attempt_id)),
  );
  assert.ok(restoreArtifacts.every(Boolean));
  const restoreWorker = new StoppedWorker(db, keys);
  const restoreDispatch = new InventoryQrzDispatch(
    restoreWorker,
    async (_input, init) => {
      const body = init?.body as URLSearchParams;
      if (body.get("ACTION") === "FETCH")
        return new Response("RESULT=OK&COUNT=0&ADIF=");
      throw new Error("fixture interrupted after possible send");
    },
  );
  assert.deepEqual(
    await restoreDispatch.send("a", mayHaveSent.attempt_id, () => ({
      ...writeGates(),
      allowedQsoIds: ["q4"],
    })),
    { kind: "uncertain" },
  );
  assert.ok(restoreWorker.strandedLease);
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

  await new InventoryOwnership(store).hold(
    "a",
    "qrz",
    "fixture-inflight",
    "unresolved_delivery",
  );
  await worker.scheduled({ scheduledTime: Date.now(), cron: "*/5 * * * *" });
  let decision: string | null = null;
  for (let i = 0; i < 120; i++) {
    decision = await db
      .prepare(
        "SELECT decision FROM inventory_delivery_review_current WHERE provider='qrz' AND record_key='q2'",
      )
      .first<string>("decision");
    if (decision === "ownership_incomplete") break;
    await delay(50);
  }
  assert.equal(decision, "ownership_incomplete");
  assert.deepEqual([reads, qrzReads, lotwReads.length], [3, 2, 3]);

  assert.ok(
    await reloaded.current("a", queuedProof.id),
    "destination ownership does not change source evidence",
  );
  assert.deepEqual(
    await delivery.capture("a", queuedProof.id, qrzScope, ["q2"]),
    {
      kind: "held",
      reason: "destination_review_stale",
    },
  );
  assert.equal(await qrz.current("a", attempt.attempt_id), false);
  assert.equal(await qrz.cancelStale("a", attempt.attempt_id), false);
  assert.deepEqual(await recovered.artifact("a", attempt.attempt_id), artifact);
  await db.prepare("UPDATE accounts SET quiet_minutes=31 WHERE id='a'").run();
  assert.equal(await reloaded.current("a", queuedProof.id), null);
  assert.deepEqual(
    await delivery.capture("a", queuedProof.id, qrzScope, ["q2"]),
    {
      kind: "held",
      reason: "source_proof_stale",
    },
  );
  await db.prepare("UPDATE accounts SET quiet_minutes=30 WHERE id='a'").run();
  assert.ok(await reloaded.current("a", queuedProof.id));
  const scopeVersions = async () =>
    (
      await store
        .statement(
          "SELECT scope_id,config_version,state FROM inventory_scopes ORDER BY scope_id",
        )
        .all<{ scope_id: string; config_version: number; state: string }>()
    ).results;
  const beforeLock = await scopeVersions();
  const ciphertext = async () =>
    (
      await db
        .prepare(
          "SELECT connection,id,envelope FROM private_data WHERE kind='credential' ORDER BY connection,id",
        )
        .all()
    ).results;
  const originalCiphertext = await ciphertext();
  assert.equal((await lockRestoredDatabase(db)).lockedAccounts, 1);
  assert.deepEqual(
    await scopeVersions(),
    beforeLock.map((row) => ({
      ...row,
      config_version: row.config_version + 1,
      state: "held",
    })),
  );
  assert.equal(await reloaded.current("a", queuedProof.id), null);
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) AS n FROM inventory_coverage WHERE state='ready'",
      )
      .first("n"),
    0,
  );
  assert.deepEqual(
    (
      await db
        .prepare(
          "SELECT attempt_id,prior_state FROM inventory_qrz_restore_pending ORDER BY prior_state",
        )
        .all()
    ).results,
    [
      { attempt_id: mayHaveSent.attempt_id, prior_state: "may_have_sent" },
      {
        attempt_id: preparedAtSnapshot.attempt_id,
        prior_state: "prepared_at_snapshot",
      },
    ],
  );
  assert.equal(
    await qrz.cancelStale("a", preparedAtSnapshot.attempt_id),
    false,
  );
  assert.equal(await qrz.current("a", preparedAtSnapshot.attempt_id), false);
  assert.deepEqual(
    await Promise.all(
      restoreStage.attempts.map((row) => qrz.artifact("a", row.attempt_id)),
    ),
    restoreArtifacts,
  );
  assert.equal(
    await db
      .prepare("SELECT count(*) AS n FROM inventory_qrz_dispatch_receipts")
      .first("n"),
    2,
  );
  assert.equal(
    await db
      .prepare("SELECT count(*) AS n FROM leases WHERE expires_at>0")
      .first("n"),
    0,
  );
  assert.deepEqual(await ciphertext(), originalCiphertext);
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) AS n FROM private_data WHERE kind='credential' AND revoked_at IS NULL",
      )
      .first("n"),
    0,
  );
  const restoreJob = () =>
    db
      .prepare(
        "SELECT version,turns,published_version FROM inventory_qrz_recovery_jobs WHERE attempt_id=?",
      )
      .bind(mayHaveSent.attempt_id)
      .first();
  assert.deepEqual(await restoreJob(), {
    version: 2,
    turns: 0,
    published_version: 0,
  });
  assert.equal(
    await db
      .prepare("SELECT count(*) AS n FROM inventory_qrz_recovery_available")
      .first("n"),
    0,
  );
  const cursor = () =>
    db
      .prepare("SELECT cursor,generation FROM cursors WHERE stream='context'")
      .first();
  assert.deepEqual(await cursor(), { cursor: '{"complete":0}', generation: 2 });
  const operator = await readFile(
    new URL("../ops/lock-restored.sql", import.meta.url),
    "utf8",
  );
  await db.batch(
    operator
      .trim()
      .split(/;\s*/)
      .filter(Boolean)
      .map((sql) => db.prepare(sql)),
  );
  assert.deepEqual(
    await scopeVersions(),
    beforeLock.map((row) => ({
      ...row,
      config_version: row.config_version + 1,
      state: "held",
    })),
  );
  assert.deepEqual(await restoreJob(), {
    version: 2,
    turns: 0,
    published_version: 0,
  });
  assert.deepEqual(await cursor(), { cursor: '{"complete":0}', generation: 2 });
});
