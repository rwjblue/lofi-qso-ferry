import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import forge from "node-forge";
import { serializeAdifRecord } from "../src/adif.ts";
import {
  consumeInventoryRecoveryWakeups,
  publishInventoryRecoveryWakeups,
} from "../src/inventory-delivery-recovery.ts";
import {
  InventorySendQueue,
  isInventorySendWakeup,
} from "../src/inventory-delivery-send.ts";
import { InventoryDeliveryWorkspace } from "../src/inventory-delivery-workspace.ts";
import {
  runHostedInventoryQueue,
  runHostedScheduled,
} from "../src/inventory-hosted.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import { inventoryLotwActivity } from "../src/inventory-lotw-activity.ts";
import { InventoryLotwDispatch } from "../src/inventory-lotw-dispatch.ts";
import { InventoryLotwPreparation } from "../src/inventory-lotw-preparation.ts";
import { InventoryLotwReadback } from "../src/inventory-lotw-readback.ts";
import { InventoryOwnership } from "../src/inventory-ownership.ts";
import { InventoryQrzDispatch } from "../src/inventory-qrz-dispatch.ts";
import {
  InventoryQrzNeighborhood,
  inventoryQrzBookLeaseScope,
} from "../src/inventory-qrz-neighborhood.ts";
import { InventoryQrzPreparation } from "../src/inventory-qrz-preparation.ts";
import { InventoryRuns } from "../src/inventory-runs.ts";
import { inventoryRuntime } from "../src/inventory-runtime.ts";
import { registerInventorySelection } from "../src/inventory-scheduler.ts";
import { InventorySourceProofDrain } from "../src/inventory-source-proof-drain.ts";
import { InventorySourceProofJobs } from "../src/inventory-source-proof-jobs.ts";
import { InventorySourceProofWorkspace } from "../src/inventory-source-proof-workspace.ts";
import { lockRestoredDatabase } from "../src/restore.ts";
import { canonical, sha256 } from "../src/security.ts";
import { importPkcs12 } from "../src/signing.ts";
import { type Lease, Store } from "../src/store.ts";
import { TEMPLATE_PROFILE } from "../src/templates.ts";
import { keys, seed } from "./helpers.ts";
import {
  applyAdditionalMigrations,
  fixtureEnvironment,
} from "./runtime-fixtures.ts";

function singleDelivery(body: unknown) {
  let acknowledged = false;
  const batch: MessageBatch<unknown> = {
    queue: "inventory-fixture",
    messages: [
      {
        id: "fixture-message",
        timestamp: new Date(),
        attempts: 1,
        body,
        ack() {
          acknowledged = true;
        },
        retry() {
          assert.fail("unexpected message retry");
        },
      },
    ],
    metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } },
    ackAll() {
      assert.fail("unexpected queue acknowledgement");
    },
    retryAll() {
      assert.fail("unexpected queue retry");
    },
  };
  return { batch, assertAcknowledged: () => assert.ok(acknowledged) };
}

async function setFixtureProofExpiry(
  db: D1Database,
  proof: string,
  expiresAt?: number,
) {
  const ddl = await db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE name='inventory_source_proof_immutable'",
    )
    .first<string>("sql");
  assert.ok(ddl);
  const original = await db
    .prepare(
      "SELECT expires_at FROM inventory_source_proofs WHERE tenant='a' AND proof_id=?",
    )
    .bind(proof)
    .first<number>("expires_at");
  assert.ok(original);
  await db.batch([
    db.prepare("DROP TRIGGER inventory_source_proof_immutable"),
    db
      .prepare(
        "UPDATE inventory_source_proofs SET expires_at=coalesce(?,created_at+1) WHERE tenant='a' AND proof_id=?",
      )
      .bind(expiresAt ?? null, proof),
    db.prepare(ddl),
  ]);
  return original;
}

async function openRestoredFixture(source: string, target: string) {
  const paths = (await readdir(join(source, "d1"), { recursive: true })).filter(
    (path) => path.endsWith(".sqlite") && basename(path) !== "metadata.sqlite",
  );
  assert.equal(paths.length, 1);
  const relative = join("d1", paths[0]);
  const destination = join(target, relative);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(join(source, relative), { readOnly: true });
  try {
    await backup(database, destination);
  } finally {
    database.close();
  }
  return {
    path: destination,
    runtime: new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: "export default {fetch(){throw new Error('offline restore')}}",
        compatibilityDate: "2026-10-22",
        d1Databases: ["DB"],
        resourcePersistencePath: target,
      }),
    ),
  };
}

test("actual Worker cron drives paced inventory, comparison and historical adoption", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ferry-worker-restore-"));
  const workerStorage = join(root, "original");
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
  let lotwRecoveryReport:
    | ((request: { url: string; method: string; body: unknown }) => Response)
    | undefined;
  const lotwReads: [string | null, string | null][] = [];
  const readTimes: number[] = [];
  const shadowSelection = {
    tenant: "a",
    sourceScope: await sha256(
      canonical(["inventory-scope-v1", "a", "lofi", "source"]),
    ),
    destinationScope: await sha256(
      canonical(["inventory-scope-v1", "a", "qrz", "7"]),
    ),
    recordKeys: ["q2"],
  };
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script: output.text,
      compatibilityDate: "2026-10-22",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      resourcePersistencePath: workerStorage,
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
        INVENTORY_QRZ_SHADOW_JSON: JSON.stringify(shadowSelection),
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
          if (lotwRecoveryReport) return lotwRecoveryReport(request);
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
  t.after(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
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
  const scheduleTick = worker.scheduled.bind(worker);
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
  assert.equal(qrzReads, 0);
  await scheduleTick({ scheduledTime: Date.now(), cron: "*/5 * * * *" });
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
  const drain = new InventorySourceProofDrain(jobs.runs);
  assert.equal(
    await drain.observed(captured.snapshot.source, Date.now()),
    null,
  );
  assert.equal(await jobs.load("a", sourceScope), null);
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
  const shadowEnv = {
    ...fixtureEnvironment(db),
    INVENTORY_QUEUE: await runtime.getQueueProducer("INVENTORY_QUEUE"),
    INVENTORY_RUNTIME_MODE: "read_only",
    INVENTORY_QRZ_SHADOW_JSON: JSON.stringify({
      ...shadowSelection,
      // Exercise source collection for four members. The running Queue
      // consumer has a narrower selection and must only stage q2.
      recordKeys: ["q1", "q2", "q3", "q4", "q5"],
    }),
  };
  const enrollment = await runHostedScheduled(shadowEnv);
  assert.equal(enrollment.mode, "inventory_read_only");
  if (enrollment.mode !== "inventory_read_only") assert.fail();
  assert.equal(enrollment.qrzShadow, "queued");
  assert.equal(enrollment.sourceProofQueued, 1);
  const enqueued = await jobs.load("a", sourceScope);
  assert.ok(enqueued);
  assert.deepEqual(
    JSON.parse(enqueued.snapshot).contacts.map(
      ({ key }: { key: string }) => key,
    ),
    ["q2", "q3", "q4", "q5"],
  );
  const queuedProof = { id: enqueued.job_id };
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
  const qrz = new InventoryQrzPreparation(store);
  const stageArgs = ["a", queuedProof.id, qrzScope, ["q2"]] as const;
  const stagedRows = () =>
    db
      .prepare(
        "SELECT stage_id,record_key FROM inventory_qrz_attempts ORDER BY record_key",
      )
      .all<{ stage_id: string; record_key: string }>();
  // Re-deliver after the fixture advances the quiet clocks. Workerd runs the
  // same proof consumer that handles a delayed delivery in production.
  await shadowEnv.INVENTORY_QUEUE.send({
    kind: "inventory-source-proof",
    version: 1,
    tenant: "a",
    scope: sourceScope,
    id: queuedProof.id,
    workVersion: enqueued.version,
  });
  for (let i = 0; i < 100 && !(await stagedRows()).results.length; i++)
    await delay(50);
  const [shadowStage, ...unexpected] = (await stagedRows()).results;
  assert.equal(unexpected.length, 0);
  assert.equal(shadowStage?.record_key, "q2");
  assert.equal(
    await db
      .prepare("SELECT count(*) AS n FROM inventory_qrz_dispatches")
      .first("n"),
    0,
  );
  // A late template rebind during publication must roll back every insert.
  await db
    .prepare(
      `CREATE TRIGGER fixture_qrz_rebind AFTER INSERT ON inventory_qrz_attempts
       BEGIN UPDATE active_templates SET version='changed' WHERE tenant='a' AND destination='destination'; END;`,
    )
    .run();
  assert.deepEqual(
    await qrz.prepare("a", queuedProof.id, qrzScope, ["q3"], "lost-fence"),
    {
      kind: "held",
      reason: "qrz_preparation_changed",
    },
  );
  assert.equal(
    await db
      .prepare("SELECT count(*) AS n FROM inventory_qrz_preparations")
      .first("n"),
    1,
  );
  assert.equal(
    await db
      .prepare("SELECT count(*) AS n FROM inventory_qrz_attempts")
      .first("n"),
    1,
  );
  await db.prepare("DROP TRIGGER fixture_qrz_rebind").run();
  const staged = await qrz.prepare(...stageArgs, shadowStage.stage_id);
  if (staged.kind !== "prepared") assert.fail(staged.reason);
  const [attempt] = staged.attempts;
  const recovered = new InventoryQrzPreparation(new Store(db, keys));
  assert.deepEqual(
    await recovered.prepare(...stageArgs, shadowStage.stage_id),
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
  const qrzSelectedEnv = {
    ...shadowEnv,
    INVENTORY_RUNTIME_MODE: "selected_qrz",
    INVENTORY_QRZ_SHADOW_JSON: JSON.stringify(shadowSelection),
    EXPORTS_ENABLED: "true",
    ROLLOUT_CHECKS_PASSED: "true",
    LIVE_WRITE_AUTHORIZATION: "I_AUTHORIZE_LIVE_VENDOR_WRITES",
    QRZ_FRESH_INSERTS_ENABLED: "true",
    ROLLOUT_QSO_IDS_JSON: JSON.stringify(["q2"]),
    ROLLOUT_DESTINATION_IDS_JSON: JSON.stringify(["destination"]),
    QRZ_FRESH_INSERT_EXPIRES_AT: String(Date.now() + 300_000),
  };
  const offlineDispatch = new InventoryQrzDispatch(store, async () =>
    assert.fail("retirement must use only inventory state"),
  );
  const qrzRetirement = new InventorySendQueue(
    qrzSelectedEnv,
    "qrz",
    offlineDispatch,
  );
  assert.equal(await qrzRetirement.retireExpired(), 0);
  const originalExpiry = await setFixtureProofExpiry(db, queuedProof.id);
  assert.equal(
    await new InventorySendQueue(
      shadowEnv,
      "qrz",
      offlineDispatch,
    ).retireExpired(),
    0,
  );
  await store
    .statement(
      "INSERT INTO inventory_qrz_send_jobs(tenant,attempt_id,hold_reason) VALUES('a',?,'qrz_neighborhood_has_candidate')",
      attempt.attempt_id,
    )
    .run();
  assert.equal(await qrzRetirement.retireExpired(), 0);
  await store
    .statement(
      "UPDATE inventory_qrz_send_jobs SET hold_reason='send_turn_limit' WHERE tenant='a' AND attempt_id=?",
      attempt.attempt_id,
    )
    .run();
  assert.equal(await qrzRetirement.retireExpired(), 1);
  assert.equal(await qrzRetirement.retireExpired(), 0);
  assert.equal(
    await store
      .statement(
        "SELECT version FROM inventory_qrz_send_jobs WHERE tenant='a' AND attempt_id=?",
        attempt.attempt_id,
      )
      .first(),
    null,
  );
  assert.deepEqual(await qrz.artifact("a", attempt.attempt_id), artifact);
  await setFixtureProofExpiry(db, queuedProof.id, originalExpiry);
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

  let failPublication = true;
  const deliveries: MessageSendRequest<unknown>[] = [];
  const sendEnv = {
    ...qrzSelectedEnv,
    INVENTORY_QUEUE: {
      ...shadowEnv.INVENTORY_QUEUE,
      async sendBatch(messages: Iterable<MessageSendRequest<unknown>>) {
        const batch = Array.from(messages);
        if (!batch.every(({ body }) => isInventorySendWakeup("qrz", body)))
          return shadowEnv.INVENTORY_QUEUE.sendBatch(batch);
        if (failPublication) throw new Error("fixture send queue unavailable");
        deliveries.push(...batch);
        return {
          metadata: {
            metrics: { backlogCount: deliveries.length, backlogBytes: 0 },
          },
        };
      },
    },
  };
  const sendJob = () =>
    store
      .statement(
        "SELECT version,turns,published_version FROM inventory_qrz_send_jobs WHERE tenant='a' AND attempt_id=?",
        sendAttempt,
      )
      .first();
  const disabled = await runHostedScheduled({
    ...sendEnv,
    EXPORTS_ENABLED: "false",
  });
  assert.equal(disabled.mode, "inventory_selected_qrz");
  if (disabled.mode !== "inventory_selected_qrz") assert.fail();
  assert.equal(disabled.qrzSendQueued, 0);
  assert.equal(await sendJob(), null);
  const lostPublish = await runHostedScheduled(sendEnv);
  assert.equal(lostPublish.mode, "inventory_selected_qrz");
  if (lostPublish.mode !== "inventory_selected_qrz") assert.fail();
  assert.equal(lostPublish.qrzSendFailed, 1);
  assert.deepEqual(await sendJob(), {
    version: 1,
    turns: 0,
    published_version: 0,
  });
  failPublication = false;
  const published = await runHostedScheduled(sendEnv);
  assert.equal(published.mode, "inventory_selected_qrz");
  if (published.mode !== "inventory_selected_qrz") assert.fail();
  assert.equal(published.qrzSendQueued, 1);
  assert.equal(deliveries.length, 1);
  const firstSend = deliveries[0].body;
  const hostedSend = async (body: unknown, env = sendEnv) => {
    const delivery = singleDelivery(body);
    const result = await runHostedInventoryQueue(env, delivery.batch, vendor);
    delivery.assertAcknowledged();
    assert.ok(
      result.mode === "inventory_read_only" ||
        result.mode === "inventory_selected_qrz",
    );
    return result.qrzSendOutcome;
  };
  const closedReads = dispatchReads;
  assert.equal(
    await hostedSend(firstSend, {
      ...sendEnv,
      INVENTORY_RUNTIME_MODE: "read_only",
    }),
    "stale",
  );
  assert.equal(
    await hostedSend(firstSend, {
      ...sendEnv,
      QRZ_FRESH_INSERT_EXPIRES_AT: "",
    }),
    "stale",
  );
  assert.equal(dispatchReads, closedReads);
  assert.deepEqual(await sendJob(), {
    version: 1,
    turns: 0,
    published_version: 1,
  });

  sendMode = "budget";
  assert.equal(await hostedSend(firstSend), "deferred");
  assert.equal(inserts, 0);
  assert.deepEqual(await sendJob(), {
    version: 3,
    turns: 1,
    published_version: 3,
  });
  assert.equal(deliveries.length, 2);
  assert.ok((deliveries[1].delaySeconds ?? 0) > 0);
  const beforeReplay = dispatchReads;
  assert.equal(await hostedSend(firstSend), "stale");
  assert.equal(dispatchReads, beforeReplay);
  await db.batch([
    db.prepare(
      "UPDATE vendor_requests SET cooldown_until=0 WHERE vendor='qrz'",
    ),
    store.statement(
      "UPDATE inventory_qrz_send_jobs SET due_at=? WHERE tenant='a' AND attempt_id=?",
      Date.now() - 1,
      sendAttempt,
    ),
  ]);
  sendMode = "lost";
  const secondSend = deliveries[1].body;
  assert.equal(await hostedSend(secondSend), "uncertain");
  assert.equal(inserts, 1);
  assert.deepEqual(writes, [
    {
      adif: sendArtifact.adif,
      fields: ["KEY", "ACTION", "ADIF"],
      unsettled: 1,
    },
  ]);
  assert.equal(await sendJob(), null);
  assert.equal(await qrz.cancelStale("a", sendAttempt), false);
  const restarted = new InventoryQrzDispatch(new Store(db, keys), vendor);
  const beforeRecovery = dispatchReads;
  assert.equal(await hostedSend(secondSend), "stale");
  assert.equal(dispatchReads, beforeRecovery);
  const strandedLease = await store.claim(
    "a",
    inventoryQrzBookLeaseScope("7"),
    Date.now(),
    90_000,
  );
  assert.ok(strandedLease);
  assert.deepEqual(await restarted.reconcile("a", sendAttempt), {
    kind: "uncertain",
  });
  assert.equal(dispatchReads, beforeRecovery);
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
  await store.release(strandedLease);
  await assert.rejects(
    publishInventoryRecoveryWakeups(store, "qrz", {
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
        strandedLease.scope,
      )
      .first<number>("expires_at");
    if (!leaseUntil) break;
    await delay(50);
  }
  let acknowledged = false;
  await consumeInventoryRecoveryWakeups(
    new InventoryQrzDispatch(store, async () =>
      assert.fail(
        "a superseded QRZ recovery message must not read the provider",
      ),
    ),
    "qrz",
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
  await setFixtureProofExpiry(db, queuedProof.id);
  assert.equal(
    await qrzRetirement.retireExpired(),
    0,
    "a claim stays reserved",
  );
  await setFixtureProofExpiry(db, queuedProof.id, originalExpiry);
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
  class StoppedWorker extends Store {
    strandedLease?: Lease;
    override async release(lease: Lease) {
      this.strandedLease = lease;
    }
  }
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

  const signingCert = forge.pki.certificateFromPem(
    await readFile(
      new URL("../fixtures/signing/certificate.pem", import.meta.url),
      "utf8",
    ),
  );
  const signingKey = forge.pki.privateKeyFromPem(
    await readFile(
      new URL("../fixtures/signing/key.pem", import.meta.url),
      "utf8",
    ),
  );
  signingCert.setSubject([
    { name: "commonName", value: "Ferry synthetic batch fixture" },
    { type: "1.3.6.1.4.1.12348.1.1", value: "N1RWJ" },
  ]);
  signingCert.validity.notBefore = new Date(Date.now() - 3_600_000);
  signingCert.validity.notAfter = new Date(Date.now() + 86_400_000);
  signingCert.sign(signingKey, forge.md.sha256.create());
  const signing = await importPkcs12(
    Buffer.from(
      forge.asn1
        .toDer(forge.pkcs12.toPkcs12Asn1(signingKey, [signingCert], ""))
        .getBytes(),
      "binary",
    ),
    "",
    { version: "fixture-batch-certificate" },
  );
  const lotwConfig = JSON.stringify({
    readAccess: true,
    station: { callsign: "N1RWJ", dxcc: 291 },
  });
  await store
    .statement(
      `INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at,config)
       VALUES('a','lotw','lotw','fixture','LoTW','active','v1',1,?)`,
      lotwConfig,
    )
    .run();
  await (
    await store.putPrivate("a", "lotw", "v1", "credential", {
      query: { username: "fixture", password: "fixture" },
      signing,
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

  const lotwScope = await db
    .prepare("SELECT scope_id FROM inventory_scopes WHERE provider='lotw'")
    .first<string>("scope_id");
  assert.ok(lotwScope);
  const lotwKeys = ["q2", "q3"];
  const lotwReviewCount = () =>
    db
      .prepare(
        "SELECT count(*) AS n FROM inventory_delivery_review_current WHERE provider='lotw' AND decision='source_proof_required' AND record_key IN('q2','q3')",
      )
      .first<number>("n");
  for (let i = 0; i < 120 && (await lotwReviewCount()) !== 2; i++)
    await delay(50);
  assert.equal(await lotwReviewCount(), 2);
  await ageQuietClocks();
  const lotwEnv = {
    ...shadowEnv,
    INVENTORY_QRZ_SHADOW_JSON: undefined,
    INVENTORY_LOTW_SHADOW_JSON: JSON.stringify({
      tenant: "a",
      sourceScope,
      destinationScope: lotwScope,
      recordKeys: lotwKeys,
    }),
  };
  const lotwSelectedEnv = {
    ...lotwEnv,
    INVENTORY_RUNTIME_MODE: "selected_lotw",
    LOTW_FRESH_INSERT_EXPIRES_AT: String(Date.now() + 300_000),
    EXPORTS_ENABLED: "true",
    ROLLOUT_CHECKS_PASSED: "true",
    LIVE_WRITE_AUTHORIZATION: "I_AUTHORIZE_LIVE_VENDOR_WRITES",
    LOTW_FRESH_INSERTS_ENABLED: "true",
    ROLLOUT_QSO_IDS_JSON: JSON.stringify(lotwKeys),
    ROLLOUT_DESTINATION_IDS_JSON: JSON.stringify(["lotw"]),
  };
  const partialLotwEnv = {
    ...lotwSelectedEnv,
    ROLLOUT_QSO_IDS_JSON: JSON.stringify(["q2"]),
  };
  const lotwEnrollment = await runHostedScheduled(lotwEnv);
  if (lotwEnrollment.mode !== "inventory_read_only")
    assert.fail(lotwEnrollment.mode);
  assert.equal(lotwEnrollment.lotwShadow, "queued");
  assert.equal(lotwEnrollment.sourceProofQueued, 1);
  const lotwJob = await jobs.load("a", sourceScope);
  assert.ok(lotwJob);
  const lotwProof = { id: lotwJob.job_id };
  for (let i = 0; i < 500; i++) {
    const job = await jobs.load("a", sourceScope);
    if (job?.phase === "complete" || job?.phase === "held") break;
    await delay(100);
  }
  assert.ok(
    await jobs.current("a", lotwProof.id),
    JSON.stringify(
      await jobs
        .load("a", sourceScope)
        .then((job) => ({ phase: job?.phase, reason: job?.reason })),
    ),
  );
  await ageQuietClocks();
  let certificateChecks = 0;
  let crlStatus = "Revoked";
  const certificateFetch: typeof fetch = async (input, init) => {
    assert.equal(
      String(input),
      `https://lotw.arrl.org/lotw/crl?serial=${signing.serial}`,
    );
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.body, undefined);
    certificateChecks++;
    return new Response(`<Status>${crlStatus}</Status>`);
  };
  const prepareLotw = new InventoryLotwPreparation(store, certificateFetch);
  const lotwBatchArgs = ["a", lotwProof.id, lotwScope, lotwKeys] as const;
  assert.deepEqual(await prepareLotw.prepare(...lotwBatchArgs, "revoked"), {
    kind: "held",
    reason: "lotw_certificate_revoked",
  });
  crlStatus = "Unrevoked";
  await db
    .prepare(`CREATE TRIGGER fixture_lotw_rebind AFTER INSERT ON inventory_lotw_batch_members WHEN NEW.position=2
    BEGIN UPDATE connections SET config=json_set(config,'$.station.dxcc',1) WHERE tenant='a' AND id='lotw'; END;`)
    .run();
  assert.deepEqual(await prepareLotw.prepare(...lotwBatchArgs, "rebound"), {
    kind: "held",
    reason: "lotw_preparation_changed",
  });
  assert.deepEqual(
    await db
      .prepare(
        "SELECT (SELECT count(*) FROM inventory_lotw_batches) AS batches,(SELECT count(*) FROM inventory_lotw_batch_members) AS members",
      )
      .first(),
    { batches: 0, members: 0 },
  );
  await db.prepare("DROP TRIGGER fixture_lotw_rebind").run();
  const preparedLotw = await prepareLotw.prepare(
    ...lotwBatchArgs,
    "two-contacts",
  );
  if (preparedLotw.kind !== "prepared")
    assert.fail(JSON.stringify(preparedLotw));
  assert.equal(
    certificateChecks,
    3,
    "one certificate read per attempted batch",
  );
  assert.deepEqual(
    preparedLotw.members.map((member) => member.record_key),
    lotwKeys,
  );
  const reopenedLotw = new InventoryLotwPreparation(
    new Store(db, keys),
    async () => assert.fail("reopening does not contact LoTW"),
  );
  assert.deepEqual(
    await reopenedLotw.prepare(...lotwBatchArgs, "two-contacts"),
    preparedLotw,
  );
  const lotwArtifact = await reopenedLotw.artifact("a", preparedLotw.batchId);
  assert.ok(lotwArtifact);
  assert.equal(lotwArtifact.hash, await sha256(lotwArtifact.bytes));
  assert.equal(lotwArtifact.hash, preparedLotw.wireHash);
  const tq8 = gunzipSync(lotwArtifact.bytes).toString();
  assert.equal([...tq8.matchAll(/<REC_TYPE:8>tCONTACT/g)].length, 2);
  assert.equal([...tq8.matchAll(/<REC_TYPE:8>tSTATION/g)].length, 1);
  assert.equal([...tq8.matchAll(/<REC_TYPE:5>tCERT/g)].length, 1);
  assert.deepEqual(
    lotwArtifact.members.map((member) => member.qso.call),
    ["W2AW", "W3AW"],
  );
  assert.equal(await reopenedLotw.current("a", preparedLotw.batchId), true);
  assert.deepEqual(await reopenedLotw.prepare(...lotwBatchArgs, "overlap"), {
    kind: "held",
    reason: "lotw_member_reserved",
  });
  assert.equal(
    await reopenedLotw.cancelStale("a", preparedLotw.batchId),
    false,
  );
  await db.prepare("UPDATE accounts SET quiet_minutes=31 WHERE id='a'").run();
  assert.equal(await reopenedLotw.current("a", preparedLotw.batchId), false);
  const lotwRetirement = new InventorySendQueue(
    lotwSelectedEnv,
    "lotw",
    new InventoryLotwDispatch(store, async () =>
      assert.fail("retirement must use only inventory state"),
    ),
  );
  assert.equal(await lotwRetirement.retireExpired(), 0, "proof has time left");
  await db.prepare("UPDATE accounts SET quiet_minutes=30 WHERE id='a'").run();
  await setFixtureProofExpiry(db, lotwProof.id);
  const partialRetirement = await runHostedScheduled(partialLotwEnv);
  if (partialRetirement.mode !== "inventory_selected_lotw")
    assert.fail(partialRetirement.mode);
  assert.equal(partialRetirement.lotwExpiredRetired, 0);
  assert.equal(partialRetirement.lotwSendFailed, 0);
  await store
    .statement(
      "INSERT INTO inventory_lotw_send_jobs(tenant,batch_id,due_at) VALUES('a',?,?)",
      preparedLotw.batchId,
      Date.now(),
    )
    .run();
  const renewal = await runHostedScheduled(lotwSelectedEnv);
  if (renewal.mode !== "inventory_selected_lotw") assert.fail(renewal.mode);
  assert.equal(renewal.lotwSendFailed, 0);
  assert.equal(renewal.lotwExpiredRetired, 1);
  assert.equal(renewal.lotwShadow, "queued");
  assert.equal(renewal.sourceProofQueued, 1);
  assert.equal(renewal.lotwSendQueued, 0);
  assert.equal(
    await store
      .statement(
        "SELECT version FROM inventory_lotw_send_jobs WHERE tenant='a' AND batch_id=?",
        preparedLotw.batchId,
      )
      .first(),
    null,
  );
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) AS n FROM inventory_lotw_batch_members WHERE cancelled_at IS NULL",
      )
      .first("n"),
    0,
  );
  assert.deepEqual(
    await reopenedLotw.artifact("a", preparedLotw.batchId),
    lotwArtifact,
  );
  const renewalJob = await jobs.load("a", sourceScope);
  assert.ok(renewalJob && renewalJob.job_id !== lotwProof.id);
  for (let i = 0; i < 500; i++) {
    const job = await jobs.load("a", sourceScope);
    if (job?.phase === "complete" || job?.phase === "held") break;
    await delay(100);
  }
  assert.ok(await jobs.current("a", renewalJob.job_id));
  const renewed = await jobs.load("a", sourceScope);
  assert.equal(renewed?.phase, "complete");
  await ageQuietClocks();
  const lotwDelivery = singleDelivery({
    kind: "inventory-source-proof",
    version: 1,
    tenant: "a",
    scope: sourceScope,
    id: renewed.job_id,
    workVersion: renewed.version,
  });
  const hostedBatch = await runHostedInventoryQueue(
    lotwEnv,
    lotwDelivery.batch,
    certificateFetch,
  );
  if (hostedBatch.mode !== "inventory_read_only") assert.fail(hostedBatch.mode);
  lotwDelivery.assertAcknowledged();
  assert.equal(hostedBatch.lotwShadow, "prepared");
  assert.equal(certificateChecks, 4);
  const replacementId = await sha256(
    canonical([
      "inventory-lotw-shadow-v1",
      renewed.job_id,
      lotwScope,
      lotwKeys,
    ]),
  );
  const replacement = await reopenedLotw.prepare(
    "a",
    renewed.job_id,
    lotwScope,
    lotwKeys,
    replacementId,
  );
  if (replacement.kind !== "prepared") assert.fail(JSON.stringify(replacement));
  const archivedLotw = await reopenedLotw.artifact("a", replacement.batchId);
  assert.ok(archivedLotw);

  const lotwGates = () => ({
    ...writeGates(),
    qrzFreshInsertsEnabled: false,
    lotwFreshInsertsEnabled: true,
    allowedQsoIds: lotwKeys,
    allowedDestinationIds: ["lotw"],
  });
  let lotwSendMode: "candidate" | "budget" | "lost" = "candidate";
  const lotwSendActions: string[] = [];
  const lotwClaims = () =>
    db
      .prepare("SELECT count(*) AS n FROM inventory_lotw_dispatch_pending")
      .first<number>("n");
  const lotwTransport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://lotw.arrl.org");
    assert.equal(init?.redirect, "manual");
    if (url.pathname === "/lotw/crl") {
      lotwSendActions.push("certificate");
      return certificateFetch(input, init);
    }
    if (url.pathname === "/lotwuser/lotwreport.adi") {
      lotwSendActions.push("history");
      assert.equal(init?.method ?? "GET", "GET");
      assert.equal(url.searchParams.get("qso_owncall"), "N1RWJ");
      assert.equal(url.searchParams.get("qso_callsign"), null);
      assert.equal(url.searchParams.get("qso_startdate"), "2026-11-07");
      assert.equal(url.searchParams.get("qso_enddate"), "2026-11-09");
      assert.equal(url.searchParams.get("qso_qsorxsince"), "1900-01-01");
      if (lotwSendMode === "budget")
        await store
          .statement(
            "UPDATE vendor_requests SET cooldown_until=? WHERE vendor='lotw'",
            Date.now() + 60_000,
          )
          .run();
      const prior = serializeAdifRecord({
        STATION_CALLSIGN: "N1RWJ",
        CALL: lotwSendMode === "candidate" ? "W3AW" : "W4AW",
        BAND: "40m",
        MODE: "SSB",
        QSO_DATE: "20261107",
        TIME_ON: "151500",
        QSL_RCVD: "N",
      });
      return new Response(
        `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:1>1<EOH>${prior}<APP_LOTW_EOF>`,
      );
    }
    assert.equal(url.href, "https://lotw.arrl.org/lotw/upload");
    assert.equal(init?.method, "POST");
    assert.ok(init?.body instanceof FormData);
    assert.deepEqual([...init.body.keys()], ["upfile"]);
    const file = init.body.get("upfile");
    assert.ok(file instanceof File);
    assert.deepEqual(
      new Uint8Array(await file.arrayBuffer()),
      archivedLotw.bytes,
    );
    assert.equal(
      await lotwClaims(),
      1,
      "the claim must be durable before HTTP",
    );
    assert.equal(
      await db
        .prepare(
          "SELECT count(*) AS n FROM inventory_lotw_recovery_jobs WHERE batch_id=?",
        )
        .bind(replacement.batchId)
        .first("n"),
      1,
    );
    lotwSendActions.push("upload");
    throw new Error("fixture lost the LoTW response");
  };
  const lotwSender = new InventoryLotwDispatch(store, lotwTransport);
  const sendLotw = (gates = lotwGates) =>
    lotwSender.send("a", replacement.batchId, gates, "live");
  assert.deepEqual(
    await sendLotw(() => ({ ...lotwGates(), allowedQsoIds: ["q2"] })),
    { kind: "held", reason: "lotw_exports_disabled" },
  );
  assert.deepEqual(lotwSendActions, []);
  assert.deepEqual(await sendLotw(), {
    kind: "held",
    reason: "lotw_batch_existing_history",
  });
  assert.deepEqual(lotwSendActions.splice(0), ["certificate", "history"]);
  assert.equal(await lotwClaims(), 0);
  lotwSendMode = "budget";
  assert.equal((await sendLotw()).kind, "deferred");
  assert.deepEqual(lotwSendActions.splice(0), ["certificate", "history"]);
  assert.equal(await lotwClaims(), 0);
  await db
    .prepare("UPDATE vendor_requests SET cooldown_until=0 WHERE vendor='lotw'")
    .run();
  lotwSendMode = "lost";
  await db
    .prepare(`CREATE TRIGGER fixture_lotw_dispatch_rebind BEFORE UPDATE OF requests ON vendor_requests
    WHEN NEW.vendor='lotw' AND EXISTS(SELECT 1 FROM inventory_lotw_dispatch_guards)
    BEGIN UPDATE connections SET config=json_set(config,'$.station.dxcc',1) WHERE tenant='a' AND id='lotw'; END;`)
    .run();
  assert.deepEqual(await sendLotw(), {
    kind: "held",
    reason: "lotw_send_authority_changed",
  });
  assert.deepEqual(lotwSendActions.splice(0), ["certificate", "history"]);
  assert.equal(await lotwClaims(), 0);
  await db.prepare("DROP TRIGGER fixture_lotw_dispatch_rebind").run();
  const lotwSendMessages: MessageSendRequest<unknown>[] = [];
  const lotwSendEnv = {
    ...lotwSelectedEnv,
    INVENTORY_QUEUE: {
      ...lotwEnv.INVENTORY_QUEUE,
      async sendBatch(messages: Iterable<MessageSendRequest<unknown>>) {
        const batch = Array.from(messages);
        if (!batch.every(({ body }) => isInventorySendWakeup("lotw", body)))
          return lotwEnv.INVENTORY_QUEUE.sendBatch(batch);
        lotwSendMessages.push(...batch);
        return {
          metadata: {
            metrics: { backlogCount: lotwSendMessages.length, backlogBytes: 0 },
          },
        };
      },
    },
  };
  const lotwSendJob = () =>
    store
      .statement(
        "SELECT version,turns,published_version FROM inventory_lotw_send_jobs WHERE tenant='a' AND batch_id=?",
        replacement.batchId,
      )
      .first();
  const partialTick = await runHostedScheduled(partialLotwEnv);
  if (partialTick.mode !== "inventory_selected_lotw")
    assert.fail(partialTick.mode);
  assert.equal(partialTick.lotwSendQueued, 0);
  assert.equal(await lotwSendJob(), null);
  const closedTick = await runHostedScheduled({
    ...lotwSendEnv,
    LOTW_FRESH_INSERT_EXPIRES_AT: "",
  });
  if (closedTick.mode !== "inventory_selected_lotw")
    assert.fail(closedTick.mode);
  assert.equal(closedTick.lotwSendQueued, 0);
  const sendTick = await runHostedScheduled(lotwSendEnv);
  if (sendTick.mode !== "inventory_selected_lotw") assert.fail(sendTick.mode);
  assert.equal(sendTick.lotwSendQueued, 1);
  assert.equal(lotwSendMessages.length, 1);
  const lotwWakeup = lotwSendMessages[0].body;
  const consumeLotwSend = async (env = lotwSendEnv) => {
    const delivery = singleDelivery(lotwWakeup);
    const result = await runHostedInventoryQueue(
      env,
      delivery.batch,
      lotwTransport,
    );
    delivery.assertAcknowledged();
    if (
      result.mode !== "inventory_selected_lotw" &&
      result.mode !== "inventory_read_only"
    )
      assert.fail(result.mode);
    return result.lotwSendOutcome;
  };
  assert.equal(await consumeLotwSend(partialLotwEnv), "stale");
  assert.equal(
    await consumeLotwSend({
      ...lotwSendEnv,
      INVENTORY_RUNTIME_MODE: "read_only",
    }),
    "stale",
  );
  assert.deepEqual(await lotwSendJob(), {
    version: 1,
    turns: 0,
    published_version: 1,
  });
  assert.deepEqual(lotwSendActions, []);
  await db.prepare("DELETE FROM vendor_requests WHERE vendor='lotw'").run();
  assert.equal(await consumeLotwSend(), "uncertain");
  assert.deepEqual(lotwSendActions.splice(0), [
    "certificate",
    "history",
    "upload",
  ]);
  assert.equal(await lotwSendJob(), null);
  assert.equal(await consumeLotwSend(), "stale");
  assert.deepEqual(lotwSendActions, []);
  assert.equal(await lotwClaims(), 1);
  assert.equal(await reopenedLotw.cancelStale("a", replacement.batchId), false);

  const claimedAt = await db
    .prepare(
      "SELECT claimed_at FROM inventory_lotw_dispatches WHERE batch_id=?",
    )
    .bind(replacement.batchId)
    .first<number>("claimed_at");
  assert.ok(claimedAt);
  const stamp = new Date(claimedAt)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  const oldStamp = new Date(claimedAt - 120_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  const first = archivedLotw.members[0].qso;
  const second = archivedLotw.members[1].qso;
  const readbackRecord = (
    qso: typeof first,
    options: { minute?: boolean; prior?: boolean; confirmed?: boolean } = {},
  ) => {
    const time = qso.time.replaceAll(":", "").replace("Z", "");
    return serializeAdifRecord({
      STATION_CALLSIGN: archivedLotw.station.callsign,
      CALL: qso.call,
      BAND: qso.band,
      MODE: qso.mode,
      QSO_DATE: qso.date.replaceAll("-", ""),
      TIME_ON: options.minute ? time.slice(0, 4) : time,
      MY_DXCC: String(archivedLotw.station.dxcc),
      MY_GRIDSQUARE: archivedLotw.station.grid ?? "",
      APP_LOTW_RXQSO: options.prior ? oldStamp : stamp,
      QSL_RCVD: options.confirmed ? "Y" : "N",
    });
  };
  let readbackPhase: "partial" | "old" | "complete" = "partial";
  let readbackRequests = 0;
  const readback = new InventoryLotwReadback(new Store(db, keys));
  lotwRecoveryReport = (request) => {
    const url = new URL(request.url);
    assert.equal(
      url.origin + url.pathname,
      "https://lotw.arrl.org/lotwuser/lotwreport.adi",
    );
    assert.equal(request.method, "GET");
    assert.equal(request.body, null);
    assert.equal(url.searchParams.get("qso_qsorxsince"), stamp);
    assert.equal(
      url.searchParams.get("qso_owncall"),
      archivedLotw.station.callsign,
    );
    assert.equal(url.searchParams.get("qso_callsign"), null);
    readbackRequests++;
    const rows = [
      readbackRecord(first, { confirmed: true }),
      readbackRecord(second, {
        minute: readbackPhase === "partial",
        prior: readbackPhase === "old",
      }),
    ];
    return new Response(
      `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:1>2<EOH>${rows.join("")}<APP_LOTW_EOF>`,
    );
  };
  const readbackOutcome = () => readback.outcome("a", replacement.batchId);
  const readbackJob = () =>
    store
      .statement(
        "SELECT version,turns,published_version,due_at FROM inventory_lotw_recovery_jobs WHERE tenant='a' AND batch_id=?",
        replacement.batchId,
      )
      .first<{
        version: number;
        turns: number;
        published_version: number;
        due_at: number;
      }>();
  const dueLotwReadback = () =>
    store
      .statement(
        "UPDATE inventory_lotw_recovery_jobs SET due_at=? WHERE tenant='a' AND batch_id=?",
        Date.now() - 1,
        replacement.batchId,
      )
      .run();
  const runLotwReadback = async (turn: number) => {
    await dueLotwReadback();
    await scheduleTick({ scheduledTime: Date.now(), cron: "*/5 * * * *" });
    for (let i = 0; i < 120; i++) {
      const busy = await db
        .prepare(
          "SELECT 1 FROM leases WHERE tenant='a' AND scope='inventory:lotw-delivery' AND expires_at>unixepoch('subsec')*1000",
        )
        .first();
      if (readbackRequests === turn && !busy) return;
      await delay(50);
    }
    assert.fail("expected hosted LoTW readback turn");
  };
  await db.prepare("UPDATE accounts SET quiet_minutes=31 WHERE id='a'").run();
  assert.equal(await jobs.current("a", renewed.job_id), null);
  const initialReadback = await readbackJob();
  assert.ok(initialReadback && initialReadback.due_at > Date.now());
  assert.deepEqual(
    [
      initialReadback.version,
      initialReadback.turns,
      initialReadback.published_version,
    ],
    [1, 0, 0],
  );
  await dueLotwReadback();
  await assert.rejects(
    publishInventoryRecoveryWakeups(store, "lotw", {
      async sendBatch() {
        throw new Error("fixture LoTW recovery queue unavailable");
      },
    }),
    /fixture LoTW recovery queue unavailable/,
  );
  assert.equal((await readbackJob())?.published_version, 0);
  // Give the recovery phase a fresh vendor window after the preparation and
  // dispatch checks in this fixture. Production uses the normal admission.
  await db.prepare("DELETE FROM vendor_requests WHERE vendor='lotw'").run();
  await runLotwReadback(1);
  assert.deepEqual(await readbackOutcome(), {
    kind: "partial",
    observed: 1,
    members: 2,
  });
  assert.equal(await lotwClaims(), 1);
  assert.equal(await reopenedLotw.cancelStale("a", replacement.batchId), false);
  assert.deepEqual(
    [(await readbackJob())?.version, (await readbackJob())?.turns],
    [2, 1],
  );
  const ciphertext = async (database = db) =>
    (
      await database
        .prepare(
          "SELECT connection,id,envelope FROM private_data WHERE kind='credential' ORDER BY connection,id",
        )
        .all()
    ).results;
  const recoveryVersions = async (database: D1Database) =>
    (
      await database
        .prepare(
          `SELECT 'lotw' AS provider,version,turns,published_version FROM inventory_lotw_recovery_jobs WHERE tenant='a' AND batch_id=?
           UNION ALL SELECT 'qrz',version,turns,published_version FROM inventory_qrz_recovery_jobs WHERE tenant='a' AND attempt_id=?
           ORDER BY provider`,
        )
        .bind(replacement.batchId, mayHaveSent.attempt_id)
        .all<{
          provider: string;
          version: number;
          turns: number;
          published_version: number;
        }>()
    ).results;
  const snapshotCredentials = await ciphertext();
  const snapshotVersions = await recoveryVersions(db);
  assert.equal(snapshotVersions.length, 2);
  const restored = await openRestoredFixture(
    workerStorage,
    join(root, "restored"),
  );
  try {
    const restoredDb = await restored.runtime.getD1Database("DB");
    const restoredStore = new Store(restoredDb, keys);
    const offline: typeof fetch = async () =>
      assert.fail("offline restore made a request");
    const restoredLotw = new InventoryLotwPreparation(restoredStore, offline);
    const restoredReadback = new InventoryLotwReadback(restoredStore, offline);
    const restoredQrz = new InventoryQrzPreparation(restoredStore);
    assert.deepEqual(await recoveryVersions(restoredDb), snapshotVersions);
    assert.deepEqual(await ciphertext(restoredDb), snapshotCredentials);
    for (const id of ["source", "destination", "lotw"]) {
      const link = await restoredStore.connection("a", id);
      assert.ok(link?.credential_version);
      assert.ok(
        await restoredStore.private(
          "a",
          id,
          link.credential_version,
          "credential",
        ),
      );
    }

    assert.equal((await lockRestoredDatabase(restoredDb)).lockedAccounts, 1);
    const fenced = snapshotVersions.map((row) => ({
      ...row,
      version: row.version + 1,
      published_version: 0,
    }));
    assert.deepEqual(await recoveryVersions(restoredDb), fenced);
    assert.equal((await lockRestoredDatabase(restoredDb)).lockedAccounts, 0);
    assert.deepEqual(await recoveryVersions(restoredDb), fenced);
    assert.deepEqual(await ciphertext(restoredDb), snapshotCredentials);
    assert.deepEqual(await restoredReadback.outcome("a", replacement.batchId), {
      kind: "partial",
      observed: 1,
      members: 2,
    });
    assert.equal(
      await restoredDb
        .prepare(
          "SELECT prior_state FROM inventory_lotw_restore_pending WHERE batch_id=?",
        )
        .bind(replacement.batchId)
        .first("prior_state"),
      "possibly_sent",
    );
    assert.deepEqual(
      (
        await restoredDb
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
    assert.deepEqual(
      await restoredLotw.artifact("a", replacement.batchId),
      archivedLotw,
    );
    assert.deepEqual(
      await Promise.all(
        restoreStage.attempts.map((row) =>
          restoredQrz.artifact("a", row.attempt_id),
        ),
      ),
      restoreArtifacts,
    );
    const offlineQueue = {
      async sendBatch() {
        assert.fail("offline restore scheduled recovery");
      },
    };
    assert.equal(
      await publishInventoryRecoveryWakeups(
        restoredStore,
        "lotw",
        offlineQueue,
      ),
      0,
    );
    assert.equal(
      await publishInventoryRecoveryWakeups(restoredStore, "qrz", offlineQueue),
      0,
    );
  } finally {
    await restored.runtime.dispose();
  }
  const restoredFile = new DatabaseSync(restored.path, { readOnly: true });
  try {
    assert.equal(
      restoredFile.prepare("PRAGMA integrity_check").get()?.integrity_check,
      "ok",
    );
    assert.deepEqual(
      restoredFile.prepare("PRAGMA foreign_key_check").all(),
      [],
    );
  } finally {
    restoredFile.close();
  }
  const staleReadback = singleDelivery({
    kind: "inventory-lotw-recovery",
    version: 1,
    tenant: "a",
    batch: replacement.batchId,
    workVersion: 1,
  });
  const staleReadbackResult = await runHostedInventoryQueue(
    lotwEnv,
    staleReadback.batch,
    async () => assert.fail("a stale readback must not contact LoTW"),
  );
  staleReadback.assertAcknowledged();
  assert.equal(staleReadbackResult.mode, "inventory_read_only");
  assert.equal((await readbackJob())?.turns, 1);
  readbackPhase = "old";
  await runLotwReadback(2);
  assert.deepEqual(await readbackOutcome(), {
    kind: "partial",
    observed: 1,
    members: 2,
  });
  readbackPhase = "complete";
  await runLotwReadback(3);
  assert.deepEqual(await readbackOutcome(), {
    kind: "observed",
    observed: 2,
    members: 2,
  });
  assert.equal(await lotwClaims(), 0);
  assert.equal(await readbackJob(), null);
  await worker.scheduled({ scheduledTime: Date.now(), cron: "*/5 * * * *" });
  assert.deepEqual(await readbackOutcome(), {
    kind: "observed",
    observed: 2,
    members: 2,
  });
  assert.deepEqual(await sendLotw(), { kind: "observed" });
  assert.equal(readbackRequests, 3);
  lotwRecoveryReport = undefined;
  assert.deepEqual(lotwSendActions, []);
  assert.deepEqual(
    (
      await db
        .prepare(
          `SELECT m.record_key,r.confirmed FROM inventory_lotw_member_receipts r JOIN inventory_lotw_batch_members m USING(tenant,attempt_id) ORDER BY m.record_key`,
        )
        .all()
    ).results,
    [
      { record_key: "q2", confirmed: 1 },
      { record_key: "q3", confirmed: 0 },
    ],
  );
  const lotwActivity = await inventoryLotwActivity(store, "a");
  assert.deepEqual(
    lotwActivity.activity
      .map(({ qso, state, confirmed }) => ({ qso, state, confirmed }))
      .sort((a, b) => a.qso.localeCompare(b.qso)),
    [
      { qso: "q2", state: "observed", confirmed: 1 },
      { qso: "q3", state: "observed", confirmed: 0 },
    ],
  );
  const otherOwner = await new InventoryOwnership(store).lookup("a", "lotw", [
    {
      id: "conflict",
      sourceIdentity: "other-source",
      key: "other-key",
      book: "another-book",
      remoteKey: "other",
      record: {
        STATION_CALLSIGN: archivedLotw.station.callsign,
        CALL: first.call,
        BAND: first.band,
        MODE: first.mode,
        QSO_DATE: first.date.replaceAll("-", ""),
        TIME_ON: first.time.replaceAll(":", "").replace("Z", ""),
      },
    },
  ]);
  assert.equal(otherOwner.observations[0]?.state, "conflict");
  await db.prepare("UPDATE accounts SET quiet_minutes=30 WHERE id='a'").run();

  const scopeVersions = async () =>
    (
      await store
        .statement(
          "SELECT scope_id,config_version,state FROM inventory_scopes ORDER BY scope_id",
        )
        .all<{ scope_id: string; config_version: number; state: string }>()
    ).results;
  const beforeLock = await scopeVersions();
  const originalCiphertext = await ciphertext();
  assert.equal((await lockRestoredDatabase(db)).lockedAccounts, 1);
  assert.equal(
    await db
      .prepare(
        "SELECT prior_state FROM inventory_lotw_restore_pending WHERE batch_id=?",
      )
      .bind(replacement.batchId)
      .first("prior_state"),
    null,
  );
  assert.deepEqual(await readback.outcome("a", replacement.batchId), {
    kind: "observed",
    observed: 2,
    members: 2,
  });
  assert.equal(await reopenedLotw.current("a", replacement.batchId), false);
  assert.equal(await reopenedLotw.cancelStale("a", replacement.batchId), false);
  assert.deepEqual(
    await reopenedLotw.artifact("a", replacement.batchId),
    archivedLotw,
  );
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
  await setFixtureProofExpiry(db, queuedProof.id);
  assert.equal(
    await new InventorySendQueue(
      {
        ...qrzSelectedEnv,
        INVENTORY_QRZ_SHADOW_JSON: JSON.stringify({
          ...shadowSelection,
          recordKeys: ["q5"],
        }),
        ROLLOUT_QSO_IDS_JSON: JSON.stringify(["q5"]),
      },
      "qrz",
      offlineDispatch,
    ).retireExpired(),
    0,
    "restore quarantine keeps even an expired unsent attempt",
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
