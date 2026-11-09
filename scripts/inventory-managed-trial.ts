import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { InventoryComparisonCoordinator } from "../src/inventory-comparison-coordinator.ts";
import { InventoryComparisonPages } from "../src/inventory-comparison-pages.ts";
import {
  InventoryIngestion,
  type InventoryStream,
} from "../src/inventory-ingestion.ts";
import {
  type InventoryScanPlan,
  planInventoryRun,
} from "../src/inventory-run-plans.ts";
import type { InventoryRunDefinition } from "../src/inventory-run-publication.ts";
import {
  InventoryRunner,
  type InventoryRunWakeup,
} from "../src/inventory-runner.ts";
import { InventoryRuns } from "../src/inventory-runs.ts";
import { activateInventoryRuntime } from "../src/inventory-runtime.ts";
import {
  registerInventorySelection,
  startInventorySelections,
} from "../src/inventory-scheduler.ts";
import type { QrzBook } from "../src/qrz.ts";
import { canonical, sha256 } from "../src/security.ts";
import { Store } from "../src/store.ts";
import { applyMigration } from "../tests/helpers.ts";
import { applyAdditionalMigrations } from "../tests/runtime-fixtures.ts";
import { measureD1 } from "./inventory-benchmark-metrics.ts";
import {
  inventoryTrialAccess,
  openInventoryTrial,
} from "./inventory-run-trial.ts";
import { createInventoryTrialTransport } from "./inventory-trial-transport.ts";

type Access = Awaited<ReturnType<typeof inventoryTrialAccess>>;
interface Manifest {
  version: 1;
  kind: "managed-read-only-inventory-trial";
  sourceCapture: string;
  captureFingerprint: string;
  createdAt: number;
  initialRuns: string[];
  currentRuns?: string[];
  verifications?: { previous: string; replacement: string; at: number }[];
  pendingVerification?: {
    previous: string;
    at: number;
    stream: InventoryStream;
    definition: InventoryRunDefinition;
    expectedJobVersion: number;
  };
  credentialFingerprint: string;
  invocations: number;
}
interface Options {
  capture?: string;
  resume?: string;
  verifyHeld?: boolean;
  maxRequests?: number;
  maxDurationMs?: number;
}
interface Dependencies {
  fetcher?: typeof fetch;
  access?: typeof inventoryTrialAccess;
  root?: string;
  progress?: (value: unknown) => void;
}
type Runtime = Awaited<ReturnType<typeof openInventoryTrial>>;
async function privateJson(directory: string, name: string, value: unknown) {
  const temporary = join(directory, `${name}.next`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, join(directory, name));
}
async function credentialFingerprint(db: D1Database) {
  return sha256(
    canonical(
      (
        await db
          .prepare(
            "SELECT tenant,connection,id,kind,envelope,revoked_at,expires_at FROM private_data WHERE kind='credential' ORDER BY tenant,connection,id",
          )
          .all()
      ).results,
    ),
  );
}
async function initialize(
  f: Runtime,
  access: Access,
  sourceCapture: string,
): Promise<Manifest> {
  await applyMigration(f.db, "0001_foundation.sql");
  await applyAdditionalMigrations(f.db);
  await f.store
    .statement(
      "INSERT INTO accounts(id,email,user_handle,verified_at) VALUES('trial','trial@example.invalid','trial',0)",
    )
    .run();
  const book = JSON.parse(access.qrz.config) as QrzBook;
  const connections = [
    {
      provider: "lofi" as const,
      original: access.source,
      config: { accountId: access.source.remote_identity },
      credential: access.sourceCredential,
    },
    {
      provider: "qrz" as const,
      original: access.qrz,
      config: book,
      credential: access.qrzCredential,
    },
    {
      provider: "lotw" as const,
      original: access.lotw,
      config: { readAccess: true },
      credential: { query: access.lotwCredential },
    },
  ];
  for (const entry of connections) {
    await f.store
      .statement(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,config,created_at) VALUES('trial',?,?,?,?,'active','managed-v1',?,?)",
        entry.provider,
        entry.provider,
        entry.provider === "qrz" ? book.bookId : entry.original.remote_identity,
        `Managed read-only ${entry.provider} trial`,
        JSON.stringify(entry.config),
        Date.now(),
      )
      .run();
    await (
      await f.store.putPrivate(
        "trial",
        entry.provider,
        "managed-v1",
        "credential",
        entry.credential,
      )
    ).run();
  }
  const runtime = await activateInventoryRuntime(f.store);
  for (const entry of connections) {
    const connection = await f.store.connection("trial", entry.provider);
    assert.ok(connection);
    await registerInventorySelection(
      f.store,
      runtime,
      connection,
      entry.provider === "lofi"
        ? { provider: "lofi", pageSize: 1000 }
        : entry.provider === "qrz"
          ? {
              provider: "qrz",
              book,
              between: [book.startDate, book.endDate],
              pageSize: 250,
            }
          : {
              provider: "lotw",
              selection: {
                startDate: access.reportDay,
                endDate: access.reportDay,
              },
            },
    );
  }
  const started = await startInventorySelections(f.store);
  assert.equal(started.started, 3);
  const rows = await f.db
    .prepare(
      "SELECT active_run_id AS id FROM inventory_stream_jobs WHERE tenant='trial' ORDER BY scope_id,stream_id",
    )
    .all<{ id: string }>();
  assert.equal(rows.results.length, 3);
  return {
    version: 1,
    kind: "managed-read-only-inventory-trial",
    sourceCapture,
    captureFingerprint: access.captureFingerprint,
    createdAt: Date.now(),
    initialRuns: rows.results.map((row) => row.id),
    credentialFingerprint: await credentialFingerprint(f.db),
    invocations: 0,
  };
}
async function manifest(directory: string) {
  assert.equal(
    (await stat(directory)).mode & 0o077,
    0,
    "trial directory must be private",
  );
  assert.equal(
    (await stat(join(directory, "keys.json"))).mode & 0o077,
    0,
    "trial keys must be private",
  );
  const value = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  ) as Manifest;
  assert.ok(
    value.version === 1 &&
      value.kind === "managed-read-only-inventory-trial" &&
      Array.isArray(value.initialRuns) &&
      value.initialRuns.length === 3 &&
      value.initialRuns.every((id) => typeof id === "string" && id.length > 0),
  );
  return value;
}

/** Journal the authorization before native publication, then finish it on resume. */
async function finishVerification(
  directory: string,
  m: Manifest,
  runs: InventoryRuns,
) {
  const pending = m.pendingVerification;
  if (!pending) return;
  const current = m.currentRuns ?? m.initialRuns;
  assert.ok(current.includes(pending.previous));
  assert.equal(pending.stream.tenant, "trial");
  assert.equal(pending.definition.mode, "full");
  const store = runs.inventory.store;
  const lease = await store.claim(
    "trial",
    `inventory:${pending.stream.scope}`,
    Date.now(),
    90000,
  );
  assert.ok(lease, "verification selection is busy");
  try {
    const replacement = await runs.begin({
      stream: pending.stream,
      definition: pending.definition,
      expectedJobVersion: pending.expectedJobVersion,
      replaceHeld: true,
      lease,
    });
    m.currentRuns = current.map((id) =>
      id === pending.previous ? replacement.id : id,
    );
    m.verifications ??= [];
    m.verifications.push({
      previous: pending.previous,
      replacement: replacement.id,
      at: pending.at,
    });
    delete m.pendingVerification;
    await privateJson(directory, "manifest.json", m);
  } finally {
    await store.release(lease);
  }
}

async function verifyHeld(directory: string, m: Manifest, runs: InventoryRuns) {
  const held = await runs.inventory.store
    .statement(
      "SELECT r.run_id,r.scope_id,r.stream_id,j.work_version,p.plan FROM json_each(?) x CROSS JOIN inventory_runs r JOIN inventory_stream_jobs j ON j.tenant=r.tenant AND j.scope_id=r.scope_id AND j.stream_id=r.stream_id AND j.active_run_id=r.run_id JOIN inventory_scheduled_selections p ON p.tenant=r.tenant AND p.scope_id=r.scope_id AND p.stream_id=r.stream_id WHERE r.tenant='trial' AND r.run_id=x.value AND r.phase='held' AND j.state='held' ORDER BY r.scope_id,r.stream_id",
      JSON.stringify(m.currentRuns ?? m.initialRuns),
    )
    .all<{
      run_id: string;
      scope_id: string;
      stream_id: string;
      work_version: number;
      plan: string;
    }>();
  for (const row of held.results) {
    const stream = await runs.inventory.snapshot(
      "trial",
      row.scope_id,
      row.stream_id,
    );
    assert.ok(stream);
    const at = Date.now();
    m.pendingVerification = {
      previous: row.run_id,
      at,
      stream,
      definition: await planInventoryRun(
        stream,
        JSON.parse(row.plan) as InventoryScanPlan,
        { mode: "full", now: at },
      ),
      expectedJobVersion: row.work_version,
    };
    await privateJson(directory, "manifest.json", m);
    await finishVerification(directory, m, runs);
  }
}
/** Validate each shared proof once; a whole-log currentness view repeats it per row. */
export async function managedInventoryResultCounts(
  db: D1Database,
  tenant: string,
) {
  return db
    .prepare(
      "WITH live AS MATERIALIZED(SELECT DISTINCT tenant,set_id FROM match_results WHERE tenant=?1), valid AS MATERIALIZED(SELECT h.set_id FROM live c CROSS JOIN inventory_match_sets h WHERE h.tenant=c.tenant AND h.set_id=c.set_id AND h.state='committed' AND NOT EXISTS(SELECT 1 FROM inventory_match_stale_sets x WHERE x.tenant=h.tenant AND x.set_id=h.set_id)) SELECT s.provider,r.state,r.reason,count(*) AS records FROM valid v CROSS JOIN match_results r INDEXED BY match_result_set JOIN inventory_scopes s ON s.tenant=r.tenant AND s.scope_id=r.destination WHERE r.tenant=?1 AND r.set_id=v.set_id GROUP BY s.provider,r.state,r.reason ORDER BY s.provider,r.state,r.reason",
    )
    .bind(tenant)
    .all();
}

async function audit(f: Runtime, m: Manifest) {
  const runs = await f.db
    .prepare(
      "SELECT s.provider,r.phase,r.version,j.state AS jobState,j.reason,c.state AS coverageState,c.published_run_id=r.run_id AS publishedSelection FROM json_each(?) x CROSS JOIN inventory_runs r JOIN inventory_scopes s ON s.tenant=r.tenant AND s.scope_id=r.scope_id JOIN inventory_stream_jobs j ON j.tenant=r.tenant AND j.scope_id=r.scope_id AND j.stream_id=r.stream_id JOIN inventory_coverage c ON c.tenant=r.tenant AND c.scope_id=r.scope_id AND c.stream_id=r.stream_id AND c.facet=r.facet AND c.partition_id=r.partition_id WHERE r.tenant='trial' AND r.run_id=x.value ORDER BY s.provider",
    )
    .bind(JSON.stringify(m.currentRuns ?? m.initialRuns))
    .all<{
      provider: string;
      phase: string;
      version: number;
      jobState: string;
      reason: string | null;
      coverageState: string;
      publishedSelection: number;
    }>();
  assert.equal(runs.results.length, 3);
  const records = await f.db
    .prepare(
      "SELECT s.provider,r.entity_family AS family,r.subtype,r.status,count(*) AS records FROM inventory_records r JOIN inventory_scopes s ON s.tenant=r.tenant AND s.scope_id=r.scope_id WHERE r.tenant='trial' GROUP BY s.provider,r.entity_family,r.subtype,r.status ORDER BY s.provider,r.entity_family,r.subtype,r.status",
    )
    .all();
  const projections = await f.db
    .prepare(
      "SELECT state,reason,count(*) AS records FROM comparison_projections_current WHERE tenant='trial' GROUP BY state,reason ORDER BY state,reason",
    )
    .all();
  const results = await managedInventoryResultCounts(f.db, "trial");
  const control = await f.db
    .prepare(
      "SELECT c.phase,c.phase_count,c.idle_turns,c.work_version,c.observed_version,w.not_before FROM inventory_comparison_coordinators c JOIN inventory_comparison_wakeups w ON w.tenant=c.tenant WHERE c.tenant='trial'",
    )
    .first();
  const attempts = await f.db
    .prepare("SELECT count(*) AS attempts FROM attempts")
    .first<{ attempts: number }>();
  assert.equal(attempts?.attempts, 0);
  return {
    runs: runs.results,
    records: records.results,
    projections: projections.results,
    results: results.results,
    control,
    credentialEnvelopesUnchanged:
      (await credentialFingerprint(f.db)) === m.credentialFingerprint,
    databaseBytes: records.meta.size_after,
  };
}

/** Bounded CLI continuation over persistent native jobs; never a provider sender. */
export async function inventoryManagedTrial(
  options: Options,
  dependencies: Dependencies = {},
) {
  assert.ok(Boolean(options.capture) !== Boolean(options.resume));
  assert.ok(
    !options.verifyHeld || options.resume,
    "verification needs --resume",
  );
  const maxRequests = options.maxRequests ?? 120,
    maxDurationMs = options.maxDurationMs ?? 20 * 60000;
  assert.ok(
    Number.isSafeInteger(maxRequests) &&
      maxRequests >= 1 &&
      maxRequests <= 5000,
  );
  assert.ok(
    Number.isSafeInteger(maxDurationMs) &&
      maxDurationMs >= 1 &&
      maxDurationMs <= 60 * 60000,
  );
  const load = dependencies.access ?? inventoryTrialAccess;
  const previousMask = process.umask(0o077);
  let f: Runtime | undefined;
  const started = Date.now();
  try {
    const directory =
      options.resume ??
      join(
        dependencies.root ??
          join(
            homedir(),
            "Library/Application Support/LoFi QSO Ferry/inventory-managed-trials",
          ),
        crypto.randomUUID(),
      );
    let m: Manifest;
    if (options.capture) {
      const access = await load(options.capture);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        join(directory, "keys.json"),
        JSON.stringify({
          active: "trial",
          keys: { trial: randomBytes(32).toString("base64url") },
        }),
        { mode: 0o600, flag: "wx" },
      );
      f = await openInventoryTrial(directory);
      m = await initialize(f, access, options.capture);
      await privateJson(directory, "manifest.json", m);
    } else {
      m = await manifest(directory);
      f = await openInventoryTrial(directory);
      assert.equal(
        (await load(m.sourceCapture)).captureFingerprint,
        m.captureFingerprint,
        "original captured access changed",
      );
    }
    const meter = measureD1(f.db),
      store = new Store(meter.database, f.store.keys);
    const ingestion = new InventoryIngestion(
      store,
      new InventoryComparisonPages(store),
    );
    const runs = new InventoryRuns(ingestion);
    await finishVerification(directory, m, runs);
    if (options.verifyHeld) await verifyHeld(directory, m, runs);
    const transport = createInventoryTrialTransport(
      dependencies.fetcher ?? fetch,
      { maxRequests, minLoFiIntervalMs: dependencies.fetcher ? 0 : 20000 },
    );
    const reader = new InventoryRunner(runs, transport.fetch, {
      scheduled: true,
    });
    const coordinator = new InventoryComparisonCoordinator(store);
    let readTurns = 0,
      comparisonTurns = 0,
      lastProgress = 0,
      stopReason = "time_limit";
    const deadline = Date.now() + maxDurationMs;
    const progress = async () => {
      lastProgress = Date.now();
      const value = {
        event: "inventory_managed_progress",
        elapsedMs: Date.now() - started,
        readTurns,
        comparisonTurns,
        requests: transport.metrics,
        remainingMs: Math.max(0, deadline - Date.now()),
        database: { ...meter.totals },
      };
      await privateJson(directory, "progress.json", value);
      dependencies.progress?.(value);
    };
    await progress();
    while (Date.now() < deadline) {
      const next = await store
        .statement(
          "SELECT j.scope_id AS scope,j.stream_id AS stream,j.active_run_id AS run,j.work_version AS workVersion,j.next_due_at AS due,r.phase FROM inventory_stream_jobs j JOIN inventory_runs r ON r.tenant=j.tenant AND r.run_id=j.active_run_id WHERE j.tenant='trial' AND j.state='ready' AND j.active_run_id IS NOT NULL ORDER BY j.next_due_at,j.scope_id,j.stream_id LIMIT 1",
        )
        .first<
          Omit<InventoryRunWakeup, "tenant" | "version"> & {
            due: number;
            phase: string;
          }
        >();
      const wake = await store
        .statement(
          "SELECT not_before FROM inventory_comparison_wakeups WHERE tenant='trial'",
        )
        .first<{ not_before: number | null }>();
      if (Date.now() >= deadline) break;
      const requestLimited = transport.metrics.requests >= maxRequests;
      if (
        next &&
        next.due <= Date.now() &&
        (!requestLimited || ["quarantining", "publishing"].includes(next.phase))
      ) {
        try {
          await reader.step(
            {
              version: 1,
              tenant: "trial",
              scope: next.scope,
              stream: next.stream,
              run: next.run,
              workVersion: next.workVersion,
            },
            {
              signal: AbortSignal.timeout(
                Math.max(1, Math.min(90000, deadline - Date.now())),
              ),
            },
          );
          readTurns++;
        } catch {
          stopReason = "read_turn_failed";
          break;
        }
      } else if (
        wake?.not_before !== null &&
        wake?.not_before !== undefined &&
        wake.not_before <= Date.now()
      ) {
        try {
          await coordinator.step("trial");
          comparisonTurns++;
        } catch {
          stopReason = "comparison_turn_failed";
          break;
        }
      } else if (next && next.due <= Date.now() && requestLimited) {
        stopReason = "request_limit";
        break;
      } else if (!next) {
        stopReason = wake?.not_before ? "comparison_parked" : "quiescent";
        break;
      } else
        await delay(
          Math.max(
            1,
            Math.min(1000, next.due - Date.now(), deadline - Date.now()),
          ),
        );
      if (Date.now() - lastProgress >= 30000) await progress();
    }
    await progress(); // Retain final continuation costs even if the audit fails.
    const state = await audit(f, m);
    if (
      ["quiescent", "comparison_parked"].includes(stopReason) &&
      state.runs.some((run) => run.phase === "held")
    )
      stopReason = "selection_held";
    const original = await load(m.sourceCapture);
    assert.equal(
      original.captureFingerprint,
      m.captureFingerprint,
      "original captured access changed",
    );
    m.invocations++;
    await privateJson(directory, "manifest.json", m);
    const report = {
      version: 1,
      kind: m.kind,
      directory,
      invocation: m.invocations,
      verificationRestarts: m.verifications?.length ?? 0,
      stopReason,
      ...state,
      originalAccessUnchanged: true,
      requestsInInvocation: transport.metrics,
      readTurns,
      comparisonTurns,
      database: meter.totals,
      elapsedMs: Date.now() - started,
      sourceAndQrzComplete: state.runs
        .filter((row) => row.provider !== "lotw")
        .every(
          (row) => row.phase === "complete" && row.publishedSelection === 1,
        ),
      lotwSelectedDayComplete: state.runs.some(
        (row) =>
          row.provider === "lotw" &&
          row.phase === "complete" &&
          row.publishedSelection === 1,
      ),
      accountWideCoverage: false,
      uploads: 0,
      execution: "node_with_native_d1",
      hostedQueueExcluded: true,
    };
    await privateJson(directory, `report-${m.invocations}.json`, report);
    await privateJson(directory, "report.json", report);
    await progress();
    return report;
  } finally {
    await f?.mf.dispose();
    process.umask(previousMask);
  }
}
export async function inspectManagedInventoryTrial(directory: string) {
  const m = await manifest(directory),
    f = await openInventoryTrial(directory);
  try {
    const sample = await f.db
      .prepare(
        "SELECT scope_id,entity_family,record_key,facet FROM inventory_record_facets WHERE tenant='trial' LIMIT 1",
      )
      .first<{
        scope_id: string;
        entity_family: string;
        record_key: string;
        facet: "source" | "receipt";
      }>();
    const body = sample
      ? await new InventoryIngestion(f.store).body(
          "trial",
          sample.scope_id,
          sample.entity_family,
          sample.record_key,
          sample.facet,
        )
      : null;
    return {
      state: "reopened",
      ...(await audit(f, m)),
      sampleDecrypted: body !== null,
      requests: 0,
      uploads: 0,
    };
  } finally {
    await f.mf.dispose();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { values } = parseArgs({
      options: {
        capture: { type: "string" },
        resume: { type: "string" },
        "verify-held": { type: "boolean", default: false },
        reopen: { type: "string" },
        "max-requests": { type: "string", default: "120" },
        "max-minutes": { type: "string", default: "20" },
      },
    });
    assert.equal(
      [values.capture, values.resume, values.reopen].filter(Boolean).length,
      1,
    );
    assert.ok(!values["verify-held"] || values.resume);
    const report = values.reopen
      ? await inspectManagedInventoryTrial(values.reopen)
      : await inventoryManagedTrial(
          {
            capture: values.capture,
            resume: values.resume,
            verifyHeld: values["verify-held"],
            maxRequests: Number(values["max-requests"]),
            maxDurationMs: Number(values["max-minutes"]) * 60000,
          },
          {
            progress: (value) =>
              process.stdout.write(`${JSON.stringify(value)}\n`),
          },
        );
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (
      "stopReason" in report &&
      ["read_turn_failed", "comparison_turn_failed", "selection_held"].includes(
        report.stopReason,
      )
    )
      process.exitCode = 1;
  } catch {
    process.stderr.write(
      "Managed read-only inventory trial failed; private state remains available for inspection.\n",
    );
    process.exitCode = 1;
  }
}
