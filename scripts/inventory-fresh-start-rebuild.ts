import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { InventoryComparisonPages } from "../src/inventory-comparison-pages.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import type { InventoryScanPlan } from "../src/inventory-run-plans.ts";
import { InventoryRuns } from "../src/inventory-runs.ts";
import {
  registerInventorySelection,
  startInventorySelections,
} from "../src/inventory-scheduler.ts";
import type { QrzBook } from "../src/qrz.ts";
import { canonical } from "../src/security.ts";
import { openSourceCredentials } from "../src/source-credentials.ts";
import { type Connection, Store } from "../src/store.ts";
import { measureD1 } from "./inventory-benchmark-metrics.ts";
import {
  privateSnapshot,
  requireFreshStartLock,
} from "./inventory-fresh-start.ts";
import {
  managedInventoryResultCounts,
  privateJson,
} from "./inventory-managed-trial.ts";
import { openInventoryTrial } from "./inventory-run-trial.ts";
import {
  driveInventoryTrial,
  inventoryTrialBounds,
} from "./inventory-trial-drive.ts";
import { createInventoryTrialTransport } from "./inventory-trial-transport.ts";

type Selection = {
  connection: string;
  from?: string;
  through?: string;
  receivedSince?: string;
};
type Options = {
  rehearsal: string;
  selections?: readonly Selection[];
  resumeQrzCover?: string;
  pollDue?: boolean;
  maxRequests?: number;
  maxDurationMs?: number;
};

function selectionPlan(
  link: Connection,
  selection: Selection,
): InventoryScanPlan {
  const { from, through, receivedSince } = selection;
  const config = JSON.parse(link.config);
  if (receivedSince !== undefined) {
    if (
      link.kind !== "lotw" ||
      config.readAccess !== true ||
      from !== undefined ||
      through !== undefined
    )
      throw new Error("inventory_fresh_start_invalid_selection");
    return {
      provider: "lotw",
      selection: {
        kind: "account_received",
        initialReceivedSince: receivedSince,
      },
    };
  }
  if (
    link.kind === "lofi" &&
    from === undefined &&
    through === undefined &&
    config.accountId === link.remote_identity
  )
    return { provider: "lofi", pageSize: 1000 };
  if (link.kind === "qrz" && config.bookId === link.remote_identity) {
    const { bookId, stationCallsign, startDate, endDate } = config as QrzBook;
    return {
      provider: "qrz",
      book: { bookId, stationCallsign, startDate, endDate },
      between: [from ?? startDate, through ?? endDate],
      pageSize: 250,
    };
  }
  if (link.kind === "lotw" && config.readAccess === true && from && through)
    return {
      provider: "lotw",
      selection: { startDate: from, endDate: through },
    };
  throw new Error("inventory_fresh_start_invalid_selection");
}

async function sourceReadNeedsBearer(
  store: Store,
  tenant: string,
  pollDueBefore?: number,
) {
  const { results } = await store
    .statement(
      `SELECT DISTINCT c.* FROM inventory_stream_jobs j
       LEFT JOIN inventory_runs r ON (r.tenant,r.run_id)=(j.tenant,j.active_run_id)
       JOIN inventory_scopes s ON (s.tenant,s.scope_id)=(j.tenant,j.scope_id)
       JOIN connections c ON (c.tenant,c.id)=(s.tenant,s.connection_id)
       WHERE j.tenant=? AND s.provider='lofi'
         AND (j.state='ready' AND r.phase IN('collecting','catchup')
           OR j.state='idle' AND j.next_due_at<=?) LIMIT 2`,
      tenant,
      pollDueBefore ?? null,
    )
    .all<Connection>();
  if (results.length > 1)
    throw new Error("inventory_fresh_start_one_source_required");
  const [link] = results;
  if (!link) return false;
  try {
    return !(await openSourceCredentials(store, link)).credentials.token;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "source_connection_unavailable"
    )
      return true;
    throw error;
  }
}

const destinationCredentials = (store: Store) =>
  store
    .statement(
      `SELECT p.* FROM private_data p JOIN connections c ON (c.tenant,c.id)=(p.tenant,p.connection)
     WHERE p.kind='credential' AND c.kind IN('qrz','lotw') ORDER BY p.tenant,p.connection,p.id`,
    )
    .all();

async function assertNoDispatch(store: Store) {
  const { results } = await store
    .statement(
      `SELECT 1 FROM attempts UNION ALL
       SELECT 1 FROM inventory_qrz_dispatches UNION ALL
       SELECT 1 FROM inventory_lotw_dispatches LIMIT 1`,
    )
    .all();
  if (results.length) throw new Error("inventory_fresh_start_dispatch_present");
}

/** Requeue a held covering delta without changing its cursor or checkpoint. */
export async function resumeHeldQrzCover(
  runs: InventoryRuns,
  tenant: string,
  runId: string,
) {
  const run = await runs.load(tenant, runId);
  if (
    run?.phase !== "held" ||
    run.jobState !== "held" ||
    run.activeRun !== runId
  )
    throw new Error("inventory_fresh_start_qrz_cover_not_held");
  const { store } = runs.inventory;
  const lease = await store.claim(
    tenant,
    `inventory:${run.scope}`,
    Date.now(),
    90_000,
  );
  if (!lease) throw new Error("inventory_fresh_start_qrz_cover_busy");
  try {
    await store
      .statement(
        `INSERT INTO inventory_qrz_cover_rearms(tenant,run_id,run_version,job_version,lease_token,lease_fence,requested_at) VALUES(?,?,?,?,?,?,?)`,
        tenant,
        runId,
        run.version,
        run.jobVersion,
        lease.token,
        lease.fence,
        Date.now(),
      )
      .run();
  } catch {
    // The receipt and outbox commit together, including on a lost response.
    const saved = await store
      .statement(
        "SELECT 1 FROM inventory_qrz_cover_rearms WHERE (tenant,run_id,run_version)=(?,?,?)",
        tenant,
        runId,
        run.version,
      )
      .first()
      .catch(() => null);
    if (!saved)
      throw new Error("inventory_fresh_start_qrz_cover_rearm_refused");
  } finally {
    await store.release(lease);
  }
}

/** Enroll explicitly selected links or resume the rehearsal's existing baselines. */
export async function rebuildFreshStart(
  options: Options,
  dependencies: {
    fetcher?: typeof fetch;
    progress?: (value: unknown) => void;
  } = {},
) {
  const bounds = inventoryTrialBounds(options);
  const directory = await privateSnapshot(options.rehearsal);
  const selections = options.selections ?? [];
  if (!Array.isArray(selections) || selections.length > 32)
    throw new Error("inventory_fresh_start_selection_bound");
  const started = Date.now();
  const pollDueBefore = options.pollDue ? started : undefined;
  const f = await openInventoryTrial(directory);
  try {
    const runtime = await requireFreshStartLock(f.store);
    await assertNoDispatch(f.store);
    const accounts = await f.store
      .statement("SELECT id FROM accounts WHERE status='active' LIMIT 2")
      .all<{ id: string }>();
    if (accounts.results.length !== 1)
      throw new Error("inventory_fresh_start_one_account_required");
    const tenant = accounts.results[0].id;
    const destinationBefore = canonical(
      (await destinationCredentials(f.store)).results,
    );
    const meter = measureD1(f.db);
    const store = new Store(meter.database, f.store.keys);
    for (const selection of selections) {
      if (
        !selection ||
        typeof selection.connection !== "string" ||
        (selection.from !== undefined && typeof selection.from !== "string") ||
        (selection.through !== undefined &&
          typeof selection.through !== "string") ||
        (selection.receivedSince !== undefined &&
          typeof selection.receivedSince !== "string")
      )
        throw new Error("inventory_fresh_start_invalid_selection");
      const link = await store.connection(tenant, selection.connection);
      if (link?.status !== "active")
        throw new Error("inventory_fresh_start_inactive_link");
      await registerInventorySelection(
        store,
        runtime,
        link,
        selectionPlan(link, selection),
      );
    }
    const start = await startInventorySelections(store, 32);
    if (start.failed)
      throw new Error("inventory_fresh_start_enrollment_failed");
    if (
      !(await store
        .statement(
          "SELECT 1 FROM inventory_stream_jobs WHERE tenant=? LIMIT 1",
          tenant,
        )
        .first())
    )
      throw new Error("inventory_fresh_start_no_selections");
    const transport = createInventoryTrialTransport(dependencies.fetcher, {
      maxRequests: bounds.maxRequests,
      minLoFiIntervalMs: dependencies.fetcher ? 0 : 20_000,
    });
    const runs = new InventoryRuns(
      new InventoryIngestion(store, new InventoryComparisonPages(store)),
    );
    if (options.resumeQrzCover !== undefined)
      await resumeHeldQrzCover(runs, tenant, options.resumeQrzCover);
    const driven = await driveInventoryTrial(runs, transport, {
      ...bounds,
      tenant,
      pollDueBefore,
      sourcePaused: await sourceReadNeedsBearer(store, tenant, pollDueBefore),
      continueWithoutSource: true,
      async progress(counts) {
        const progress = {
          ...counts,
          elapsedMs: Date.now() - started,
          requests: transport.metrics,
          database: { ...meter.totals },
        };
        await privateJson(directory, "fresh-rebuild-progress.json", progress);
        dependencies.progress?.(progress);
      },
    });
    await requireFreshStartLock(f.store);
    await assertNoDispatch(f.store);
    if (
      destinationBefore !==
      canonical((await destinationCredentials(f.store)).results)
    )
      throw new Error("inventory_fresh_start_destination_credentials_changed");
    const coverage = await f.store
      .statement(
        `SELECT s.provider,r.mode,r.phase,c.state,
                c.state='ready' AND c.published_config_version=s.config_version AS published,
                j.reason,count(*) AS selections
         FROM inventory_stream_jobs j
         JOIN inventory_scopes s ON (s.tenant,s.scope_id)=(j.tenant,j.scope_id)
         JOIN inventory_coverage c
           ON (c.tenant,c.scope_id,c.stream_id)=(j.tenant,j.scope_id,j.stream_id)
         LEFT JOIN inventory_wakeups w ON (w.tenant,w.scope_id,w.stream_id,w.work_version)=(j.tenant,j.scope_id,j.stream_id,j.work_version)
         JOIN inventory_runs r ON (r.tenant,r.run_id)=(j.tenant,coalesce(j.active_run_id,w.run_id,c.published_run_id))
         WHERE j.tenant=? GROUP BY s.provider,r.mode,r.phase,c.state,published,j.reason
         ORDER BY s.provider,r.mode,r.phase,c.state,published,j.reason`,
        tenant,
      )
      .all<{
        provider: Connection["kind"];
        mode: "full" | "delta";
        phase: string;
        state: string;
        published: number | null;
        reason: string | null;
        selections: number;
      }>();
    const records = await f.store
      .statement(
        `SELECT s.provider,r.subtype,r.status,count(*) AS records
         FROM inventory_records r JOIN inventory_scopes s ON (s.tenant,s.scope_id)=(r.tenant,r.scope_id)
         WHERE r.tenant=? GROUP BY s.provider,r.subtype,r.status ORDER BY s.provider,r.subtype,r.status`,
        tenant,
      )
      .all();
    const matches = await managedInventoryResultCounts(f.db, tenant);
    const report = {
      ...driven,
      stopReason:
        ["quiescent", "comparison_parked"].includes(driven.stopReason) &&
        coverage.results.some(
          (row) => row.phase === "held" && row.reason !== "overflow_split",
        )
          ? "selection_held"
          : driven.stopReason,
      requests: transport.metrics,
      coverage: coverage.results,
      records: records.results,
      matches: matches.results,
      database: meter.totals,
      databaseBytes: records.meta.size_after,
      elapsedMs: Date.now() - started,
      destinationCredentialEnvelopesUnchanged: true,
      writeLocked: true,
      uploads: 0,
    };
    await privateJson(directory, "fresh-rebuild-continuation.json", report);
    return report;
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
        rehearsal: { type: "string" },
        plan: { type: "string" },
        "resume-qrz-cover": { type: "string" },
        "poll-due": { type: "boolean" },
        "max-requests": { type: "string", default: "120" },
        "max-minutes": { type: "string", default: "20" },
      },
    });
    if (!values.rehearsal)
      throw new Error("inventory_fresh_start_rehearsal_required");
    const report = await rebuildFreshStart(
      {
        rehearsal: values.rehearsal,
        selections: values.plan
          ? JSON.parse(await readFile(values.plan, "utf8"))
          : undefined,
        resumeQrzCover: values["resume-qrz-cover"],
        pollDue: values["poll-due"],
        maxRequests: Number(values["max-requests"]),
        maxDurationMs: Number(values["max-minutes"]) * 60_000,
      },
      { progress: (progress) => console.log(JSON.stringify(progress)) },
    );
    console.log(JSON.stringify(report));
    if (
      report.sourceAuthenticationRequired ||
      ["selection_held", "read_turn_failed", "comparison_turn_failed"].includes(
        report.stopReason,
      )
    )
      process.exitCode = 1;
  } catch (error) {
    const reason =
      error instanceof Error && /^inventory_[a-z_]+$/.test(error.message)
        ? error.message
        : "rehearsal_unavailable";
    console.error(`Fresh-start rebuild failed (${reason}).`);
    process.exitCode = 1;
  }
}
