import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { historicalCandidateKeys } from "../src/historical-matching.ts";
import { InventoryAssociations } from "../src/inventory-associations.ts";
import { InventoryComparisonBuilds } from "../src/inventory-comparison-builds.ts";
import { InventoryComparisonCoordinator } from "../src/inventory-comparison-coordinator.ts";
import { InventoryComparisonWakeups } from "../src/inventory-comparison-wakeups.ts";
import { InventoryComparisonGenerations } from "../src/inventory-comparison-generations.ts";
import { inventoryComparisonToken } from "../src/inventory-comparison-keys.ts";
import {
  InventoryComparisonLookup,
  type InventoryComparisonRequest,
} from "../src/inventory-comparison-lookup.ts";
import { inventoryComparisonHint } from "../src/inventory-comparison-pages.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import { InventoryMatchingCoverage } from "../src/inventory-matching-coverage.ts";
import { InventoryMatchingCoverageEvents } from "../src/inventory-matching-coverage-events.ts";
import { InventoryMatchingInvalidations } from "../src/inventory-matching-invalidations.ts";
import { InventoryMatchingPairs } from "../src/inventory-matching-pairs.ts";
import {
  InventoryMatchingResults,
  type InventoryMatchingWorkClaim,
} from "../src/inventory-matching-results.ts";
import { InventoryMatchingWork } from "../src/inventory-matching-work.ts";
import { InventoryMatchingSelected } from "../src/inventory-matching-selected.ts";
import {
  InventoryMatchingWorkspace,
  type PreparedInventoryMatchingSnapshot,
} from "../src/inventory-matching-workspace.ts";
import { InventoryProjectionCoverageJobs } from "../src/inventory-projection-coverage-jobs.ts";
import { InventoryProjectionJobs } from "../src/inventory-projection-jobs.ts";
import {
  type InventoryProjectionBody,
  InventoryProjectionWorkspace,
  inventoryProjectionDigest,
  inventoryProjectionIdentity,
  type PreparedInventoryProjections,
} from "../src/inventory-projection-workspace.ts";
import {
  type InventoryProjectionRead,
  InventoryProjections,
} from "../src/inventory-projections.ts";
import {
  canonical,
  type Envelope,
  type Keyring,
  open,
  sha256,
} from "../src/security.ts";
import { Store } from "../src/store.ts";
import {
  activateInventoryRuntime,
  inventoryRuntime,
} from "../src/inventory-runtime.ts";
import { applyMigration } from "../tests/helpers.ts";

interface MatchingDependencyState {
  sets: number;
  refs: number;
  buckets: number;
  pending: number;
}
async function matchingDependencyState(db: D1Database) {
  return db
    .prepare(
      "SELECT (SELECT count(*) FROM inventory_match_live_sets WHERE tenant='trial') AS sets,(SELECT coalesce(sum(ref_count),0) FROM inventory_match_live_sets WHERE tenant='trial') AS refs,(SELECT count(*) FROM inventory_matching_bucket_dependents WHERE tenant='trial') AS buckets,(SELECT count(*) FROM inventory_matching_bucket_jobs WHERE tenant='trial' AND completed_version<work_version) AS pending",
    )
    .first<MatchingDependencyState>();
}

async function matchingPairState(db: D1Database) {
  const [jobs, pages, rows] = await Promise.all([
    db
      .prepare(
        "SELECT * FROM inventory_matching_pair_jobs WHERE tenant='trial' ORDER BY generation_id,destination,source_scope",
      )
      .all(),
    db
      .prepare(
        "SELECT * FROM inventory_matching_pair_pages WHERE tenant='trial' ORDER BY page_id",
      )
      .all(),
    db
      .prepare(
        "SELECT * FROM inventory_matching_pair_rows WHERE tenant='trial' ORDER BY page_id,record_key",
      )
      .all(),
  ]);
  return { jobs: jobs.results, pages: pages.results, rows: rows.results };
}

interface CoverageRecoveryState {
  trackedSets: number;
  declarations: number;
  currentNodes: number;
  pendingEvents: number;
  invalidReferences: number;
}
async function coverageRecoveryState(db: D1Database) {
  return db
    .prepare(`SELECT
 (SELECT count(*) FROM inventory_match_sets WHERE tenant='trial' AND state='committed' AND recovery_count IS NOT NULL) AS trackedSets,
 (SELECT count(*) FROM inventory_match_recovery WHERE tenant='trial') AS declarations,
 (SELECT count(*) FROM inventory_matching_coverage_dependents WHERE tenant='trial') AS currentNodes,
 (SELECT count(*) FROM inventory_matching_coverage_events WHERE tenant='trial' AND completed_version<work_version) AS pendingEvents,
 (SELECT count(*) FROM inventory_matching_coverage_dependents d WHERE d.tenant='trial' AND (NOT EXISTS(SELECT 1 FROM inventory_match_recovery q JOIN inventory_match_sets h ON h.tenant=q.tenant AND h.set_id=q.set_id AND h.state='committed' AND h.generation_id=d.generation_id AND h.destination=d.destination JOIN inventory_match_scopes s ON s.tenant=q.tenant AND s.set_id=q.set_id AND s.scope_id=q.scope_id AND s.coverage_clock=d.seen_clock WHERE q.tenant=d.tenant AND q.set_id=d.set_id AND q.recovery_id=d.recovery_id AND q.scope_id=d.scope_id AND q.facet=d.facet AND (q.facet='source' OR q.subject_scope=d.source_scope) AND json_extract(q.nodes,'$['||d.node_index||']')=d.node_hash) OR NOT EXISTS(SELECT 1 FROM match_results r WHERE r.tenant=d.tenant AND r.set_id=d.set_id AND r.source_scope=d.source_scope AND r.state='incomplete'))) AS invalidReferences`)
    .first<CoverageRecoveryState>();
}

interface CoverageDispatchState {
  receipts: number;
  jobs: number;
  pendingJobs: number;
  invalidBindings: number;
}
async function coverageDispatchState(db: D1Database) {
  return db
    .prepare(`SELECT
 (SELECT count(*) FROM inventory_matching_coverage_dispatches WHERE tenant='trial' AND state='committed') AS receipts,
 (SELECT count(*) FROM inventory_matching_coverage_jobs WHERE tenant='trial') AS jobs,
 (SELECT count(*) FROM inventory_matching_coverage_jobs WHERE tenant='trial' AND completed_version<work_version) AS pendingJobs,
 (SELECT count(*) FROM inventory_matching_coverage_jobs j WHERE j.tenant='trial' AND NOT EXISTS(SELECT 1 FROM inventory_matching_coverage_dispatches h JOIN inventory_matching_coverage_clocks c ON c.tenant=h.tenant AND c.scope_id=h.scope_id AND c.facet=h.facet AND c.version>=h.scope_clock WHERE h.tenant=j.tenant AND h.dispatch_id=j.last_dispatch AND h.state='committed' AND h.generation_id=j.generation_id AND h.scope_id=j.scope_id AND h.facet=j.facet AND h.config_version=j.config_version AND h.scope_clock=j.signal_clock AND EXISTS(SELECT 1 FROM json_each(h.nodes) WHERE value=j.node_hash))) AS invalidBindings`)
    .first<CoverageDispatchState>();
}

interface CoverageExpansionState {
  pages: number;
  references: number;
  pendingJobs: number;
  invalidReceipts: number;
}
async function coverageExpansionState(db: D1Database) {
  return db
    .prepare(`SELECT
 (SELECT count(*) FROM inventory_matching_coverage_pages WHERE tenant='trial' AND state='committed') AS pages,
 (SELECT count(*) FROM inventory_matching_coverage_rows WHERE tenant='trial') AS "references",
 (SELECT count(*) FROM inventory_matching_coverage_jobs WHERE tenant='trial' AND completed_version<work_version) AS pendingJobs,
 (SELECT count(*) FROM inventory_matching_coverage_pages h WHERE h.tenant='trial' AND (h.state!='committed' OR NOT EXISTS(SELECT 1 FROM inventory_matching_coverage_guards g WHERE g.tenant=h.tenant AND g.page_id=h.page_id) OR h.row_count!=(SELECT count(*) FROM inventory_matching_coverage_rows q WHERE q.tenant=h.tenant AND q.page_id=h.page_id))) AS invalidReceipts`)
    .first<CoverageExpansionState>();
}

interface SelectedInputState extends CoverageExpansionState {
  dependents: number;
  invalidReferences: number;
  missingReferences: number;
}
async function selectedInputState(db: D1Database) {
  return db
    .prepare(`SELECT
 (SELECT count(*) FROM inventory_matching_selected_dependents WHERE tenant='trial') AS dependents,
 (SELECT count(*) FROM inventory_matching_selected_pages WHERE tenant='trial' AND state='committed') AS pages,
 (SELECT count(*) FROM inventory_matching_selected_rows WHERE tenant='trial') AS "references",
 (SELECT count(*) FROM inventory_matching_selected_jobs WHERE tenant='trial' AND completed_version<work_version) AS pendingJobs,
 (SELECT count(*) FROM inventory_matching_selected_pages h WHERE h.tenant='trial' AND (h.state!='committed' OR NOT EXISTS(SELECT 1 FROM inventory_matching_selected_guards g WHERE g.tenant=h.tenant AND g.page_id=h.page_id) OR h.row_count!=(SELECT count(*) FROM inventory_matching_selected_rows q WHERE q.tenant=h.tenant AND q.page_id=h.page_id))) AS invalidReceipts,
 (SELECT count(*) FROM inventory_matching_selected_dependents d JOIN inventory_match_sets h ON h.tenant=d.tenant AND h.set_id=d.set_id WHERE d.tenant='trial' AND (h.state!='committed' OR h.generation_id!=d.generation_id OR h.destination!=d.destination OR NOT EXISTS(SELECT 1 FROM inventory_match_rows q WHERE q.tenant=d.tenant AND q.set_id=d.set_id AND q.source_scope=d.scope_id AND q.record_key=d.record_key) OR NOT EXISTS(SELECT 1 FROM match_results r INDEXED BY match_result_set WHERE r.tenant=d.tenant AND r.set_id=d.set_id AND r.source_scope=d.source_scope) OR d.seen_clock>coalesce((SELECT j.work_version FROM inventory_matching_selected_jobs j WHERE j.tenant=d.tenant AND j.generation_id=d.generation_id AND j.scope_id=d.scope_id AND j.facet=d.facet AND j.record_key=d.record_key),0))) AS invalidReferences,
 (SELECT count(*) FROM (SELECT tenant,set_id,source_scope FROM match_results WHERE tenant='trial' GROUP BY tenant,set_id,source_scope) r CROSS JOIN inventory_match_rows q WHERE q.tenant=r.tenant AND q.set_id=r.set_id AND NOT EXISTS(SELECT 1 FROM inventory_matching_selected_dependents d WHERE d.tenant=q.tenant AND d.set_id=q.set_id AND d.source_scope=r.source_scope AND d.scope_id=q.source_scope AND d.facet='source' AND d.record_key=q.record_key)) AS missingReferences`)
    .first<SelectedInputState>();
}

interface ComparisonWakeupState {
  rows: number;
  scheduled: number;
  unpublished: number;
  invalidBindings: number;
  missingRows: number;
}
async function comparisonWakeupState(db: D1Database) {
  return db
    .prepare(`SELECT
 (SELECT count(*) FROM inventory_comparison_wakeups WHERE tenant='trial') AS rows,
 (SELECT count(*) FROM inventory_comparison_wakeups WHERE tenant='trial' AND not_before IS NOT NULL) AS scheduled,
 (SELECT count(*) FROM inventory_comparison_wakeups WHERE tenant='trial' AND not_before IS NOT NULL AND published_at=0) AS unpublished,
 (SELECT count(*) FROM inventory_comparison_wakeups w LEFT JOIN inventory_comparison_wakeup_basis b ON b.tenant=w.tenant WHERE w.tenant='trial' AND (b.tenant IS NULL OR w.control_version!=b.control_version OR w.work_version!=b.work_version OR (b.due_at IS NULL AND w.not_before IS NOT NULL) OR (b.due_at=0 AND w.not_before IS NULL) OR (b.due_at>0 AND w.not_before IS NOT b.due_at))) AS invalidBindings,
 (SELECT count(*) FROM inventory_comparison_coordinators c WHERE c.tenant='trial' AND NOT EXISTS(SELECT 1 FROM inventory_comparison_wakeups w WHERE w.tenant=c.tenant)) AS missingRows`)
    .first<ComparisonWakeupState>();
}

/** Offline replay of the encrypted three-provider run capture. The original is
 * never opened for mutation; the working copy stays outside the repository. */
export async function inventoryComparisonTrial(captureDirectory: string) {
  const directory = join(
    homedir(),
    "Library/Application Support/LoFi QSO Ferry/inventory-comparison-trials",
    crypto.randomUUID(),
  );
  const previousMask = process.umask(0o077);
  let mf: Miniflare | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const keyText = await readFile(join(captureDirectory, "keys.json"), "utf8");
    await writeFile(join(directory, "keys.json"), keyText, {
      mode: 0o600,
      flag: "wx",
    });
    await cp(join(captureDirectory, "database"), join(directory, "database"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script:
          "export default {fetch(){return new Response('offline comparison trial')}}",
        compatibilityDate: "2026-10-22",
        d1Databases: ["DB"],
        resourcePersistencePath: join(directory, "database"),
      }),
    );
    const db = (await mf.getD1Database("DB")) as D1Database;
    const store = new Store(db, JSON.parse(keyText) as Keyring);
    const credentials = async () =>
      sha256(
        canonical(
          (
            await db
              .prepare(
                "SELECT tenant,connection,id,envelope,revoked_at,expires_at FROM private_data WHERE kind='credential' ORDER BY tenant,connection,id",
              )
              .all()
          ).results,
        ),
      );
    const observations = async () =>
      sha256(
        canonical(
          (
            await db
              .prepare(
                "SELECT tenant,scope_id,record_key,facet,row_version,raw_version,semantic_version,first_observed_at,last_observed_at FROM inventory_record_facets ORDER BY tenant,scope_id,record_key,facet",
              )
              .all()
          ).results,
        ),
      );
    const streams = async () =>
      canonical(
        (
          await db
            .prepare(
              "SELECT * FROM inventory_streams ORDER BY tenant,scope_id,stream_id",
            )
            .all()
        ).results,
      );
    const before = {
      credentials: await credentials(),
      observations: await observations(),
      streams: await streams(),
    };
    // The bounded capture predates the runtime schema. Complete its native
    // prerequisites on this private copy before exercising the handoff.
    for (const name of (
      await readdir(new URL("../migrations/", import.meta.url))
    )
      .filter(
        (name) =>
          /^\d{4}_.*\.sql$/.test(name) &&
          name > "0001_" &&
          !name.startsWith("0001_") &&
          !name.startsWith("0009_") &&
          name < "0039_",
      )
      .sort())
      await applyMigration(db, name);
    await applyMigration(db, "0042_inventory_runtime.sql");
    await applyMigration(db, "0043_inventory_scheduling.sql");
    for (const name of [
      "0044_inventory_comparison_generations.sql",
      "0045_inventory_comparison_ingestion.sql",
      "0046_inventory_comparison_builds.sql",
      "0047_inventory_context_membership.sql",
      "0048_inventory_projection_publication.sql",
      "0049_inventory_matching_read_indexes.sql",
      "0050_inventory_match_results.sql",
      "0051_inventory_historical_ownership.sql",
      "0052_inventory_projection_jobs.sql",
      "0053_inventory_projection_coverage_jobs.sql",
      "0054_inventory_bounded_generation_setup.sql",
      "0055_inventory_comparison_coordinator.sql",
      "0056_inventory_current_work_selection.sql",
      "0057_inventory_scoped_activation_debt.sql",
      "0058_inventory_matching_work.sql",
      "0059_inventory_live_bucket_dependencies.sql",
      "0060_inventory_matching_bucket_pages.sql",
      "0061_inventory_matching_coverage_clocks.sql",
      "0062_inventory_matching_pair_jobs.sql",
      "0063_inventory_matching_pair_pages.sql",
      "0064_inventory_matching_result_update.sql",
      "0065_inventory_matching_coverage_recovery.sql",
      "0066_inventory_projection_coverage_holds.sql",
      "0067_inventory_matching_coverage_dispatch.sql",
      "0068_inventory_matching_coverage_pages.sql",
      "0069_inventory_matching_coordinator.sql",
      "0070_inventory_matching_selected_inputs.sql",
      "0071_inventory_matching_selected_pages.sql",
      "0072_inventory_selected_matching_coordinator.sql",
      "0073_inventory_comparison_wakeups.sql",
      "0074_inventory_comparison_runtime_leases.sql",
    ])
      await applyMigration(db, name);
    await activateInventoryRuntime(store);
    const generations = new InventoryComparisonGenerations(store);
    const domain = await generations.begin("trial");
    if (!domain.pending_generation)
      throw new Error("comparison_trial_generation_missing");
    const generation = domain.pending_generation;
    const scopes = (
      await db
        .prepare(
          "SELECT scope_id,provider FROM inventory_scopes WHERE tenant='trial' ORDER BY scope_id",
        )
        .all<{ scope_id: string; provider: string }>()
    ).results;
    if (
      scopes.length !== 3 ||
      new Set(scopes.map((scope) => scope.provider)).size !== 3
    )
      throw new Error("comparison_trial_requires_three_provider_capture");
    const builds = new InventoryComparisonBuilds(store);
    const phases = [];
    for (const scope of scopes) {
      const phase = {
        provider: scope.provider,
        pages: 0,
        records: 0,
        changed: 0,
        statements: 0,
        rowsRead: 0,
        rowsWritten: 0,
      };
      let complete = false;
      for (let page = 0; page < 100; page++) {
        const result = await builds.step("trial", generation, scope.scope_id);
        if (!("records" in result))
          throw new Error("comparison_trial_build_did_not_advance");
        phase.pages++;
        phase.records += result.records;
        phase.changed += result.changed;
        phase.statements += result.statements;
        phase.rowsRead += result.rowsRead;
        phase.rowsWritten += result.rowsWritten;
        if (result.complete) {
          complete = true;
          break;
        }
      }
      if (!complete) throw new Error("comparison_trial_page_limit");
      phases.push(phase);
    }
    await builds.activate("trial", generation);
    const source = scopes.find((scope) => scope.provider === "lofi");
    if (!source) throw new Error("comparison_trial_source_missing");
    const selected = (
      await db
        .prepare(
          "SELECT record_key FROM inventory_records WHERE tenant='trial' AND scope_id=? AND entity_family='qso' AND subtype='qso' AND status='active' ORDER BY record_key LIMIT 80",
        )
        .bind(source.scope_id)
        .all<{ record_key: string }>()
    ).results;
    const inventory = new InventoryIngestion(store);
    const requests: InventoryComparisonRequest[] = [];
    let contacts = 0;
    for (const row of selected) {
      const hint = inventoryComparisonHint(
        "lofi",
        await inventory.body(
          "trial",
          source.scope_id,
          "qso",
          row.record_key,
          "source",
        ),
      );
      const keys = historicalCandidateKeys(hint);
      if (!keys.workedCall || !keys.time) continue;
      for (const scope of scopes.filter((scope) => scope.provider !== "lofi"))
        requests.push({
          id: `${contacts}:${scope.provider}`,
          scope: scope.scope_id,
          record: hint,
        });
      contacts++;
      if (requests.length >= 20) break;
    }
    if (!requests.length)
      throw new Error("comparison_trial_no_complete_input_keys");
    const lookup = await new InventoryComparisonLookup(store).probe(
      "trial",
      requests,
    );
    const preparations: PreparedInventoryProjections[] = [];
    const projectionPhases = [];
    const projections = new InventoryProjections(store);
    for (const scope of scopes) {
      const selected = (
        await db
          .prepare(
            "SELECT record_key FROM comparison_index WHERE tenant='trial' AND generation_id=? AND scope_id=? AND state!='retired' ORDER BY record_key LIMIT 20",
          )
          .bind(generation, scope.scope_id)
          .all<{ record_key: string }>()
      ).results;
      if (!selected.length) continue;
      const prepared = await new InventoryProjectionWorkspace(store).prepare(
        "trial",
        generation,
        scope.scope_id,
        selected.map((row) => row.record_key),
      );
      preparations.push(prepared);
      const lease = await store.claim(
        "trial",
        `projection:${generation}:${scope.scope_id}`,
        Date.now(),
        60_000,
      );
      if (!lease) throw new Error("comparison_trial_projection_lease_busy");
      let publication: Awaited<ReturnType<InventoryProjections["publish"]>>;
      try {
        publication = await projections.publish(prepared, lease);
        const replay = await projections.publish(
          prepared,
          lease,
          publication.pageId,
        );
        if (!replay.recovered || replay.statements !== 0)
          throw new Error("comparison_trial_projection_receipt_failed");
      } finally {
        await store.release(lease);
      }
      projectionPhases.push({
        provider: scope.provider,
        prepared: prepared.rows.length,
        ready: prepared.rows.filter((row) => row.state === "ready").length,
        held: prepared.rows.filter((row) => row.state === "held").length,
        excluded: prepared.rows.filter((row) => row.state === "excluded")
          .length,
        stats: prepared.stats,
        publication,
        receiptReplayRecovered: true,
      });
    }
    await writeFile(
      join(directory, "projection-preparations.json"),
      JSON.stringify(preparations),
      { mode: 0o600, flag: "wx" },
    );
    const sourcePreparation = preparations.find(
      (row) => row.provider === "lofi",
    );
    if (!sourcePreparation)
      throw new Error("comparison_trial_source_projections_missing");
    const projectionJobs = new InventoryProjectionJobs(store);
    const projectionJobSample = {
      sampled: true,
      operation: await projectionJobs.expandNext("trial"),
      coverage: await new InventoryProjectionCoverageJobs(store).step("trial"),
      projection: await projectionJobs.projectNext("trial"),
    };
    if (
      [
        projectionJobSample.operation,
        projectionJobSample.coverage,
        projectionJobSample.projection,
      ].some((row) => row.kind === "deferred")
    )
      throw new Error("comparison_trial_projection_job_deferred");
    const coordinatorTurns: Awaited<
      ReturnType<InventoryComparisonCoordinator["step"]>
    >[] = [];
    for (let turn = 0; turn < 4; turn++) {
      const result = await new InventoryComparisonCoordinator(store).step(
        "trial",
      );
      if (result.kind === "deferred")
        throw new Error("comparison_trial_coordinator_deferred");
      coordinatorTurns.push(result);
      if (!result.more) break;
    }
    const matchingSnapshots: PreparedInventoryMatchingSnapshot[] = [];
    const pairTurns = [];
    for (const _scope of scopes.filter((row) => row.provider !== "lofi")) {
      const result = await new InventoryMatchingPairs(store).step("trial");
      if (
        result.kind !== "enrolled" ||
        result.records !== 200 ||
        result.complete
      )
        throw new Error("comparison_trial_pair_enrollment_incomplete");
      pairTurns.push(result);
    }
    const matchingWorkSnapshots: {
      setId: string;
      matchingDigest: string;
      work: InventoryMatchingWorkClaim[];
    }[] = [];
    const historicalAdoptions: {
      provider: string;
      selected: number;
      records: number;
      skipped: Record<string, number>;
    }[] = [];
    const matchingPublications: (Awaited<
      ReturnType<InventoryMatchingResults["publish"]>
    > & {
      receiptReplayRecovered: boolean;
      currentResults: number;
      currentRowsRead: number;
    })[] = [];
    for (const scope of scopes.filter((row) => row.provider !== "lofi")) {
      const prepared = await new InventoryMatchingWorkspace(store).prepare(
        "trial",
        scope.scope_id,
        sourcePreparation.rows
          .slice(0, 10)
          .map((row) => ({ scope: source.scope_id, key: row.key })),
      );
      matchingSnapshots.push(prepared);
      const lease = await store.claim(
        "trial",
        `matching:${scope.scope_id}`,
        Date.now(),
        60_000,
      );
      if (!lease) throw new Error("comparison_trial_matching_lease_busy");
      const matches = new InventoryMatchingResults(store);
      try {
        await new InventoryMatchingWork(store).enqueue(
          "trial",
          generation,
          scope.scope_id,
          prepared.selected,
        );
        const work = (
          await db
            .prepare(
              "SELECT w.source_scope AS scope,w.record_key AS key,w.work_version AS workVersion,w.completed_version AS completedVersion,w.source_config_version AS sourceConfigVersion,w.destination_config_version AS destinationConfigVersion,w.due_at AS dueAt FROM json_each(?1) j CROSS JOIN matching_work w WHERE w.tenant='trial' AND w.generation_id=?2 AND w.destination=?3 AND w.source_scope=json_extract(j.value,'$.scope') AND w.record_key=json_extract(j.value,'$.key') ORDER BY CAST(j.key AS INTEGER)",
            )
            .bind(canonical(prepared.selected), generation, scope.scope_id)
            .all<InventoryMatchingWorkClaim>()
        ).results;
        if (work.length !== prepared.selected.length)
          throw new Error("comparison_trial_matching_work_missing");
        const result = await matches.publish(
          prepared,
          lease,
          crypto.randomUUID(),
          work,
        );
        const replay = await matches.publish(
          prepared,
          lease,
          result.setId,
          work,
        );
        const current = await matches.current(
          "trial",
          scope.scope_id,
          prepared.selected,
        );
        if (
          !replay.recovered ||
          current.results.length !== prepared.selected.length
        )
          throw new Error("comparison_trial_matching_publication_failed");
        matchingPublications.push({
          ...result,
          receiptReplayRecovered: true,
          currentResults: current.results.length,
          currentRowsRead: current.rowsRead,
        });
        matchingWorkSnapshots.push({
          setId: result.setId,
          matchingDigest: prepared.digest,
          work,
        });
      } finally {
        await store.release(lease);
      }
      const adoption = await new InventoryAssociations(store).adopt(
        "trial",
        scope.scope_id,
        prepared.selected,
      );
      if (adoption.deferred)
        throw new Error("comparison_trial_adoption_deferred");
      historicalAdoptions.push({
        provider: scope.provider,
        selected: prepared.selected.length,
        records: adoption.records,
        skipped: Object.fromEntries(
          [...new Set(adoption.skipped.map((row) => row.reason))].map(
            (reason) => [
              reason,
              adoption.skipped.filter((row) => row.reason === reason).length,
            ],
          ),
        ),
      });
    }
    await writeFile(
      join(directory, "matching-snapshots.json"),
      JSON.stringify(matchingSnapshots),
      { mode: 0o600, flag: "wx" },
    );
    await writeFile(
      join(directory, "matching-work.json"),
      JSON.stringify(matchingWorkSnapshots),
      { mode: 0o600, flag: "wx" },
    );
    const matchingWorkCounts = await db
      .prepare(
        "SELECT count(*) AS total,coalesce(sum(completed_version=work_version),0) AS completed,coalesce(sum(completed_version<work_version),0) AS pending FROM matching_work WHERE tenant='trial'",
      )
      .first<{ total: number; completed: number; pending: number }>();
    if (
      !matchingWorkCounts ||
      matchingWorkCounts.completed !==
        matchingWorkSnapshots.reduce((sum, row) => sum + row.work.length, 0)
    )
      throw new Error("comparison_trial_matching_work_completion_failed");
    const invalidation = await new InventoryMatchingInvalidations(store).step(
      "trial",
    );
    if (invalidation.kind !== "idle")
      throw new Error("comparison_trial_unexpected_bucket_invalidation");
    const dependencyState = await matchingDependencyState(db);
    if (
      !dependencyState ||
      dependencyState.refs !== matchingWorkCounts.completed
    )
      throw new Error("comparison_trial_matching_dependencies_missing");
    const indexCounts = (
      await db
        .prepare(
          "SELECT s.provider,i.state,count(*) AS records FROM comparison_index i JOIN inventory_scopes s ON s.tenant=i.tenant AND s.scope_id=i.scope_id WHERE i.tenant='trial' GROUP BY s.provider,i.state ORDER BY s.provider,i.state",
        )
        .all()
    ).results;
    const pairState = await matchingPairState(db);
    const coverageState = await coverageRecoveryState(db);
    const coverageDispatch = await new InventoryMatchingCoverageEvents(
      store,
    ).step("trial");
    const dispatchState = await coverageDispatchState(db);
    const coverageExpansion = await new InventoryMatchingCoverage(store).step(
      "trial",
    );
    const expansionState = await coverageExpansionState(db);
    const selectedInputs = await new InventoryMatchingSelected(store).step(
      "trial",
    );
    const selectedState = await selectedInputState(db);
    if (
      selectedInputs.kind !== "idle" ||
      !selectedState ||
      selectedState.invalidReferences !== 0 ||
      selectedState.missingReferences !== 0 ||
      selectedState.invalidReceipts !== 0
    )
      throw new Error("comparison_trial_selected_inputs_incomplete");
    if (
      coverageExpansion.kind !== "idle" ||
      !expansionState ||
      expansionState.invalidReceipts !== 0
    )
      throw new Error("comparison_trial_unexpected_coverage_expansion");
    if (
      coverageDispatch.kind !== "idle" ||
      !dispatchState ||
      dispatchState.invalidBindings !== 0
    )
      throw new Error("comparison_trial_unexpected_coverage_dispatch");
    if (
      !coverageState ||
      coverageState.trackedSets !== matchingSnapshots.length ||
      coverageState.invalidReferences !== 0
    )
      throw new Error("comparison_trial_coverage_recovery_incomplete");
    if (
      pairState.jobs.length !== pairTurns.length ||
      pairState.pages.length !== pairTurns.length ||
      pairState.rows.length !==
        pairTurns.reduce((sum, turn) => sum + turn.records, 0)
    )
      throw new Error("comparison_trial_pair_state_incomplete");
    await writeFile(
      join(directory, "matching-pairs.json"),
      JSON.stringify(pairState),
      { mode: 0o600, flag: "wx" },
    );
    const changed = {
      credentials: before.credentials !== (await credentials()),
      observations: before.observations !== (await observations()),
      streams: before.streams !== (await streams()),
    };
    if (changed.credentials || changed.observations || changed.streams)
      throw new Error("comparison_trial_changed_canonical_state");
    const coordinatorControl = await db
      .prepare(
        "SELECT version,work_version,observed_version,phase_count,phase,idle_turns,next_due_at,build_generation,build_scope FROM inventory_comparison_coordinators WHERE tenant='trial'",
      )
      .first();
    const wakeupState = await comparisonWakeupState(db);
    const runtime = await inventoryRuntime(store);
    const queueCandidates = await new InventoryComparisonWakeups(
      store,
    ).pending();
    if (
      wakeupState?.rows !== 1 ||
      wakeupState.scheduled !== 1 ||
      wakeupState.unpublished !== 1 ||
      wakeupState.invalidBindings !== 0 ||
      wakeupState.missingRows !== 0 ||
      queueCandidates.length !== (runtime.mode === "legacy" ? 0 : 1)
    )
      throw new Error("comparison_trial_outbox_incomplete");
    const report = {
      directory,
      comparisonWakeups: {
        sampled: true,
        runtimeMode: runtime.mode,
        queueCandidates: queueCandidates.length,
        state: wakeupState,
      },
      vendorHttpRequests: 0,
      uploads: 0,
      generationPublished: true,
      phases,
      indexCounts,
      projections: { published: true, phases: projectionPhases },
      projectionJobs: projectionJobSample,
      coordinator: { turns: coordinatorTurns, control: coordinatorControl },
      matchingWork: {
        sampled: true,
        ...matchingWorkCounts,
        manifestDigest: await sha256(canonical(matchingWorkSnapshots)),
      },
      matchingPairs: {
        sampled: true,
        turns: pairTurns,
        jobs: pairState.jobs.length,
        pages: pairState.pages.length,
        rows: pairState.rows.length,
        manifestDigest: await sha256(canonical(pairState)),
      },
      coverageRecovery: { sampled: true, state: coverageState },
      coverageDispatch: {
        sampled: true,
        kind: coverageDispatch.kind,
        state: dispatchState,
      },
      coverageExpansion: {
        sampled: true,
        kind: coverageExpansion.kind,
        state: expansionState,
      },
      selectedInputs: {
        sampled: true,
        kind: selectedInputs.kind,
        state: selectedState,
      },
      matchingInvalidation: {
        sampled: true,
        kind: invalidation.kind,
        state: dependencyState,
      },
      matchingSnapshots: {
        published: true,
        resultsPublished: matchingPublications.reduce(
          (sum, row) => sum + row.records,
          0,
        ),
        phases: matchingSnapshots.map((row, index) => ({
          provider: scopes.find((scope) => scope.scope_id === row.destination)
            ?.provider,
          selected: row.selected.length,
          states: Object.fromEntries(
            [
              "absent_at_inventory",
              "matched_existing",
              "projection_mismatch",
              "ambiguous",
              "incomplete",
              "excluded",
            ].map((state) => [
              state,
              row.results.filter((result) => result.state === state).length,
            ]),
          ),
          records: row.records.length,
          lookupProbes: row.lookups.length,
          stats: row.stats,
          publication: matchingPublications[index],
        })),
      },
      historicalAdoption: {
        evaluated: true,
        associationsCreated: historicalAdoptions.reduce(
          (sum, row) => sum + row.records,
          0,
        ),
        phases: historicalAdoptions,
      },
      lookup: {
        contacts,
        probes: requests.length,
        rowsRead: lookup.rowsRead,
        candidateReferences: lookup.observations.reduce(
          (sum, row) => sum + row.candidates.length,
          0,
        ),
        overflow: lookup.observations.filter((row) => row.state === "overflow")
          .length,
        indexReady: lookup.observations.filter((row) => row.indexReady).length,
        matchResultsPublished: 0,
      },
      canonicalStateUnchanged: true,
      databaseBytes: (await db.prepare("SELECT 1").run()).meta.size_after,
    };
    await writeFile(
      join(directory, "comparison-report.json"),
      JSON.stringify(report, null, 2),
      { mode: 0o600, flag: "wx" },
    );
    return report;
  } finally {
    await mf?.dispose();
    process.umask(previousMask);
  }
}

/** Reopening verifies the private key and original bodies in a fresh process. */
export async function reopenInventoryComparisonTrial(directory: string) {
  const keys = JSON.parse(
    await readFile(join(directory, "keys.json"), "utf8"),
  ) as Keyring;
  const report = JSON.parse(
    await readFile(join(directory, "comparison-report.json"), "utf8"),
  ) as {
    projections?: { published: boolean };
    matchingSnapshots?: { published: boolean };
    matchingWork?: {
      sampled: boolean;
      total: number;
      completed: number;
      pending: number;
      manifestDigest: string;
    };
    matchingInvalidation?: {
      sampled: boolean;
      kind: string;
      state: MatchingDependencyState;
    };
    matchingPairs?: {
      sampled: boolean;
      turns: { pageId: string; records: number; complete: boolean }[];
      jobs: number;
      pages: number;
      rows: number;
      manifestDigest: string;
    };
    coverageRecovery?: { sampled: boolean; state: CoverageRecoveryState };
    coverageDispatch?: {
      sampled: boolean;
      kind: string;
      state: CoverageDispatchState;
    };
    coverageExpansion?: {
      sampled: boolean;
      kind: string;
      state: CoverageExpansionState;
    };
    selectedInputs?: {
      sampled: boolean;
      kind: string;
      state: SelectedInputState;
    };
    comparisonWakeups?: {
      sampled: boolean;
      runtimeMode: string;
      queueCandidates: number;
      state: ComparisonWakeupState;
    };
    historicalAdoption?: { evaluated: boolean; associationsCreated: number };
    projectionJobs?: {
      sampled: boolean;
      operation: { kind: string; pageId?: string; records?: number };
      coverage: { kind: string; pageId?: string; records?: number };
      projection: { kind: string; pageId?: string; records?: number };
    };
    coordinator?: {
      turns: {
        kind: string;
        phase?: string;
        pageId?: string;
        records?: number;
      }[];
      control: Record<string, unknown>;
    };
  };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script:
        "export default {fetch(){return new Response('offline comparison reopen')}}",
      compatibilityDate: "2026-10-22",
      d1Databases: ["DB"],
      resourcePersistencePath: join(directory, "database"),
    }),
  );
  try {
    const db = (await mf.getD1Database("DB")) as D1Database;
    const store = new Store(db, keys);
    const writers = await new InventoryComparisonGenerations(store).writers(
      "trial",
    );
    const context = writers?.contexts.find(
      (key) => key.generation === writers.domain.active_generation,
    );
    if (!writers || !context)
      throw new Error("comparison_trial_active_generation_missing");
    const scopes = (
      await db
        .prepare(
          "SELECT scope_id,provider FROM inventory_scopes WHERE tenant='trial' ORDER BY scope_id",
        )
        .all<{ scope_id: string; provider: string }>()
    ).results;
    const inventory = new InventoryIngestion(store);
    const validated = [];
    for (const scope of scopes) {
      const row = await db
        .prepare(
          "SELECT record_key,facet,key_class,bucket_hash FROM comparison_index WHERE tenant='trial' AND generation_id=? AND scope_id=? AND state!='retired' ORDER BY record_key LIMIT 1",
        )
        .bind(context.generation, scope.scope_id)
        .first<{
          record_key: string;
          facet: "source" | "receipt";
          key_class: string;
          bucket_hash: string;
        }>();
      if (!row) throw new Error("comparison_trial_sample_missing");
      const body = await inventory.body(
        "trial",
        scope.scope_id,
        "qso",
        row.record_key,
        row.facet,
      );
      const token = await inventoryComparisonToken(
        context,
        inventoryComparisonHint(scope.provider, body),
      );
      if (token.keyClass !== row.key_class || token.hash !== row.bucket_hash)
        throw new Error("comparison_trial_restart_hash_mismatch");
      validated.push(scope.provider);
    }
    const preparationText = await readFile(
      join(directory, "projection-preparations.json"),
      "utf8",
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    let preparedProjectionsValidated = 0;
    let publishedProjectionsValidated = 0;
    const published = new Map<
      string,
      { reference: InventoryProjectionRead; body: InventoryProjectionBody }
    >();
    if (preparationText) {
      const preparations = JSON.parse(
        preparationText,
      ) as PreparedInventoryProjections[];
      for (const preparation of preparations) {
        const { digest, ...input } = preparation;
        if (digest !== (await inventoryProjectionDigest(input)))
          throw new Error("comparison_trial_projection_manifest_changed");
        for (const row of preparation.rows) {
          const payload = preparation.payloads.find(
            (payload) => payload.id === row.payload,
          );
          if (!payload)
            throw new Error("comparison_trial_projection_payload_missing");
          const body = await open<InventoryProjectionBody>(
            JSON.parse(payload.envelope) as Envelope,
            inventoryProjectionIdentity(
              preparation.tenant,
              preparation.connection,
              payload.id,
            ),
            keys,
          );
          if (body.version !== 1 || body.state !== row.state)
            throw new Error("comparison_trial_projection_body_mismatch");
          preparedProjectionsValidated++;
          if (report.projections?.published) {
            if (
              preparation.tenant !== "trial" ||
              preparation.generation !== context.generation
            )
              throw new Error("comparison_trial_projection_scope_mismatch");
            published.set(canonical([preparation.scope, row.key, row.facet]), {
              reference: {
                scope: preparation.scope,
                key: row.key,
                facet: row.facet,
                version: 1,
                payload: payload.id,
              },
              body,
            });
          }
        }
      }
    }
    const loaded = await new InventoryProjections(store).bodies(
      "trial",
      context.generation,
      [...published.values()].map((row) => row.reference),
    );
    if (loaded.missing.length || loaded.items.length !== published.size)
      throw new Error("comparison_trial_published_projection_missing");
    for (const stored of loaded.items) {
      const expected = published.get(
        canonical([stored.scope, stored.key, stored.facet]),
      );
      if (!expected || canonical(stored.body) !== canonical(expected.body))
        throw new Error("comparison_trial_published_projection_mismatch");
      publishedProjectionsValidated++;
    }
    const matchingText = await readFile(
      join(directory, "matching-snapshots.json"),
      "utf8",
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    let matchingSnapshotsValidated = 0;
    let matchingResultsValidated = 0;
    let historicalAssociationsValidated: number | undefined;
    if (matchingText) {
      const snapshots = JSON.parse(
        matchingText,
      ) as PreparedInventoryMatchingSnapshot[];
      for (const snapshot of snapshots) {
        const { digest, ...manifest } = snapshot;
        if (
          digest !== (await sha256(canonical(manifest))) ||
          snapshot.tenant !== "trial" ||
          snapshot.generation !== context.generation
        )
          throw new Error("comparison_trial_matching_snapshot_changed");
        const fresh = await new InventoryMatchingWorkspace(store, {
          trackCoverageClocks: snapshot.coverageClocks === 1,
          trackCoverageRecovery: snapshot.coverageRecovery === 1,
        }).prepare("trial", snapshot.destination, snapshot.selected);
        const {
          digest: _oldDigest,
          preparedAt: _oldTime,
          stats: _oldStats,
          ...oldState
        } = snapshot;
        const {
          digest: _newDigest,
          preparedAt: _newTime,
          stats: _newStats,
          ...newState
        } = fresh;
        // Older capture manifests predate classified results and format tags.
        // Reproduce all their original fields without inventing new evidence.
        const comparable = Object.fromEntries(
          Object.keys(oldState).map((key) => [key, Reflect.get(newState, key)]),
        );
        if (canonical(oldState) !== canonical(comparable))
          throw new Error("comparison_trial_matching_snapshot_not_reproduced");
        if (report.matchingSnapshots?.published) {
          const current = await new InventoryMatchingResults(store).current(
            "trial",
            snapshot.destination,
            snapshot.selected,
          );
          if (
            current.results.length !== snapshot.results.length ||
            current.results.some(
              (row) =>
                !snapshot.results.some(
                  (expected) =>
                    expected.source.scope === row.source_scope &&
                    expected.source.key === row.record_key &&
                    expected.state === row.state &&
                    expected.reason === row.reason &&
                    (expected.remote?.key ?? null) === row.remote_key,
                ),
            )
          )
            throw new Error("comparison_trial_matching_results_not_recovered");
          matchingResultsValidated += current.results.length;
        }
        matchingSnapshotsValidated++;
      }
    }
    if (report.historicalAdoption?.evaluated) {
      const count = await db
        .prepare(
          "SELECT count(*) AS n FROM inventory_historical_associations WHERE tenant='trial'",
        )
        .first<{ n: number }>();
      if (count?.n !== report.historicalAdoption.associationsCreated)
        throw new Error(
          "comparison_trial_historical_associations_not_recovered",
        );
      historicalAssociationsValidated = count.n;
      if (matchingText)
        for (const snapshot of JSON.parse(
          matchingText,
        ) as PreparedInventoryMatchingSnapshot[]) {
          const adoption = await new InventoryAssociations(store).prepare(
            "trial",
            snapshot.destination,
            snapshot.selected,
          );
          if (adoption.rows.length)
            throw new Error("comparison_trial_historical_adoption_not_stable");
        }
    }
    const validateProjectionPage = async (
      pageId: string | undefined,
      records: number | undefined,
    ) => {
      if (
        !pageId ||
        records === undefined ||
        !Number.isSafeInteger(records) ||
        records < 1 ||
        records > 20
      )
        throw new Error("comparison_trial_job_projection_manifest_changed");
      const receipt = await db
        .prepare(
          "SELECT state,row_count FROM comparison_projection_pages WHERE tenant='trial' AND page_id=?",
        )
        .bind(pageId)
        .first<{ state: string; row_count: number }>();
      if (receipt?.state !== "committed" || receipt.row_count !== records)
        throw new Error(
          "comparison_trial_job_projection_receipt_not_recovered",
        );
      const refs = (
        await db
          .prepare(
            "SELECT scope_id AS scope,record_key AS key,facet,version,payload_id AS payload FROM comparison_projections WHERE tenant='trial' AND last_page_id=? ORDER BY scope_id,record_key,facet",
          )
          .bind(pageId)
          .all<InventoryProjectionRead>()
      ).results;
      if (refs.length !== records)
        throw new Error("comparison_trial_job_projection_refs_changed");
      const bodies = await new InventoryProjections(store).bodies(
        "trial",
        context.generation,
        refs,
      );
      if (bodies.missing.length || bodies.items.length !== refs.length)
        throw new Error("comparison_trial_job_projections_not_recovered");
      return bodies.items.length;
    };
    let jobProjectionsValidated: number | undefined;
    if (report.projectionJobs?.sampled) {
      const operation = report.projectionJobs.operation;
      if (operation.kind === "expanded") {
        const receipt = await db
          .prepare(
            "SELECT state,row_count FROM inventory_projection_job_pages WHERE tenant='trial' AND page_id=?",
          )
          .bind(operation.pageId)
          .first<{ state: string; row_count: number }>();
        if (
          receipt?.state !== "committed" ||
          receipt.row_count !== operation.records
        )
          throw new Error("comparison_trial_operation_job_not_recovered");
      }
      const projection = report.projectionJobs.projection;
      const coverage = report.projectionJobs.coverage;
      if (coverage.kind === "queued") {
        const receipt = await db
          .prepare(
            "SELECT state,row_count FROM inventory_projection_coverage_pages WHERE tenant='trial' AND page_id=?",
          )
          .bind(coverage.pageId)
          .first<{ state: string; row_count: number }>();
        if (
          receipt?.state !== "committed" ||
          receipt.row_count !== coverage.records
        )
          throw new Error("comparison_trial_coverage_job_not_recovered");
      }
      if (projection.kind === "projected") {
        jobProjectionsValidated = await validateProjectionPage(
          projection.pageId,
          projection.records,
        );
      } else jobProjectionsValidated = 0;
    }
    let coordinatorProjectionsValidated: number | undefined;
    if (report.coordinator) {
      const control = await db
        .prepare(
          "phase_count" in report.coordinator.control
            ? "SELECT version,work_version,observed_version,phase_count,phase,idle_turns,next_due_at,build_generation,build_scope FROM inventory_comparison_coordinators WHERE tenant='trial'"
            : "SELECT version,work_version,observed_version,phase,idle_turns,build_generation,build_scope FROM inventory_comparison_coordinators WHERE tenant='trial'",
        )
        .first();
      if (canonical(control) !== canonical(report.coordinator.control))
        throw new Error("comparison_trial_coordinator_control_not_recovered");
      coordinatorProjectionsValidated = 0;
      for (const turn of report.coordinator.turns)
        if (turn.kind === "advanced" && turn.phase === "project")
          coordinatorProjectionsValidated += await validateProjectionPage(
            turn.pageId,
            turn.records,
          );
    }
    let matchingWorkValidated: number | undefined;
    if (report.matchingWork?.sampled) {
      const workSnapshots = JSON.parse(
        await readFile(join(directory, "matching-work.json"), "utf8"),
      ) as {
        setId: string;
        matchingDigest: string;
        work: InventoryMatchingWorkClaim[];
      }[];
      if (
        (await sha256(canonical(workSnapshots))) !==
        report.matchingWork.manifestDigest
      )
        throw new Error("comparison_trial_matching_work_manifest_changed");
      matchingWorkValidated = 0;
      for (const snapshot of workSnapshots) {
        if (
          !matchingText ||
          !(
            JSON.parse(matchingText) as PreparedInventoryMatchingSnapshot[]
          ).some((page) => page.digest === snapshot.matchingDigest)
        )
          throw new Error("comparison_trial_matching_work_snapshot_missing");
        const receipt = await db
          .prepare(
            "SELECT h.state,h.input_digest,c.row_count,(SELECT count(*) FROM inventory_match_work_rows q JOIN matching_work w ON w.tenant=q.tenant AND w.generation_id=q.generation_id AND w.destination=q.destination AND w.source_scope=q.source_scope AND w.record_key=q.record_key WHERE q.tenant=h.tenant AND q.set_id=h.set_id AND w.work_version=q.work_version AND w.completed_version=q.work_version AND w.last_completed_set=h.set_id) AS completed FROM inventory_match_sets h JOIN inventory_match_work_claims c ON c.tenant=h.tenant AND c.set_id=h.set_id WHERE h.tenant='trial' AND h.set_id=?",
          )
          .bind(snapshot.setId)
          .first<{
            state: string;
            input_digest: string;
            row_count: number;
            completed: number;
          }>();
        const rows = (
          await db
            .prepare(
              "SELECT source_scope AS scope,record_key AS key,work_version AS workVersion,completed_version AS completedVersion,source_config_version AS sourceConfigVersion,destination_config_version AS destinationConfigVersion,due_at AS dueAt FROM inventory_match_work_rows WHERE tenant='trial' AND set_id=? ORDER BY source_scope,record_key",
            )
            .bind(snapshot.setId)
            .all<InventoryMatchingWorkClaim>()
        ).results;
        const byKey = new Map(
          rows.map((row) => [canonical([row.scope, row.key]), row]),
        );
        const captured = snapshot.work.map((row) =>
          byKey.get(canonical([row.scope, row.key])),
        );
        const expectedDigest = await sha256(
          canonical({
            matchingDigest: snapshot.matchingDigest,
            work: snapshot.work,
          }),
        );
        if (
          receipt?.state !== "committed" ||
          receipt.input_digest !== expectedDigest ||
          receipt.row_count !== snapshot.work.length ||
          receipt.completed !== snapshot.work.length ||
          rows.length !== snapshot.work.length ||
          canonical(captured) !== canonical(snapshot.work)
        )
          throw new Error("comparison_trial_matching_work_not_recovered");
        matchingWorkValidated += receipt.completed;
      }
      const counts = await db
        .prepare(
          "SELECT count(*) AS total,coalesce(sum(completed_version=work_version),0) AS completed,coalesce(sum(completed_version<work_version),0) AS pending FROM matching_work WHERE tenant='trial'",
        )
        .first();
      if (
        canonical(counts) !==
          canonical({
            total: report.matchingWork.total,
            completed: report.matchingWork.completed,
            pending: report.matchingWork.pending,
          }) ||
        matchingWorkValidated !== report.matchingWork.completed
      )
        throw new Error("comparison_trial_matching_work_counts_changed");
    }
    let matchingPairRowsValidated: number | undefined;
    if (report.matchingPairs?.sampled) {
      const saved = JSON.parse(
        await readFile(join(directory, "matching-pairs.json"), "utf8"),
      ) as Awaited<ReturnType<typeof matchingPairState>>;
      const actual = await matchingPairState(db);
      if (
        (await sha256(canonical(saved))) !==
          report.matchingPairs.manifestDigest ||
        canonical(actual) !== canonical(saved) ||
        actual.jobs.length !== report.matchingPairs.jobs ||
        actual.pages.length !== report.matchingPairs.pages ||
        actual.rows.length !== report.matchingPairs.rows
      )
        throw new Error("comparison_trial_pair_state_not_recovered");
      for (const turn of report.matchingPairs.turns) {
        const page = actual.pages.find((row) => row.page_id === turn.pageId);
        if (
          page?.state !== "committed" ||
          page.row_count !== turn.records ||
          !!page.complete !== turn.complete
        )
          throw new Error("comparison_trial_pair_receipt_not_recovered");
      }
      const validated = await db
        .prepare(
          `SELECT count(*) AS n FROM inventory_matching_pair_rows q JOIN inventory_matching_pair_pages p ON p.tenant=q.tenant AND p.page_id=q.page_id AND p.state='committed' JOIN inventory_matching_pair_guards g ON g.tenant=p.tenant AND g.page_id=p.page_id JOIN matching_work w ON w.tenant=q.tenant AND w.generation_id=p.generation_id AND w.destination=p.destination AND w.source_scope=p.source_scope AND w.record_key=q.record_key AND w.source_config_version=p.source_config_version AND w.destination_config_version=p.destination_config_version AND w.work_version>q.expected_work_version AND w.completed_version>=q.expected_completed_version WHERE q.tenant='trial'`,
        )
        .first<{ n: number }>();
      if (validated?.n !== report.matchingPairs.rows)
        throw new Error("comparison_trial_pair_work_not_recovered");
      matchingPairRowsValidated = validated.n;
    }
    let coverageRecoveryStateRecovered: boolean | undefined;
    if (report.coverageRecovery?.sampled) {
      const state = await coverageRecoveryState(db);
      if (
        state?.invalidReferences !== 0 ||
        canonical(state) !== canonical(report.coverageRecovery.state)
      )
        throw new Error("comparison_trial_coverage_recovery_not_recovered");
      coverageRecoveryStateRecovered = true;
    }
    let matchingInvalidationStateRecovered: boolean | undefined;
    let coverageDispatchStateRecovered: boolean | undefined;
    let coverageExpansionStateRecovered: boolean | undefined;
    let selectedInputStateRecovered: boolean | undefined;
    let comparisonWakeupStateRecovered: boolean | undefined;
    if (report.comparisonWakeups?.sampled) {
      const state = await comparisonWakeupState(db);
      if (
        state?.invalidBindings !== 0 ||
        state.missingRows !== 0 ||
        canonical(state) !== canonical(report.comparisonWakeups.state)
      )
        throw new Error("comparison_trial_outbox_not_recovered");
      comparisonWakeupStateRecovered = true;
    }
    if (report.selectedInputs?.sampled) {
      const state = await selectedInputState(db);
      if (
        state?.invalidReferences !== 0 ||
        state.missingReferences !== 0 ||
        state.invalidReceipts !== 0 ||
        canonical(state) !== canonical(report.selectedInputs.state)
      )
        throw new Error("comparison_trial_selected_inputs_not_recovered");
      selectedInputStateRecovered = true;
    }
    if (report.coverageExpansion?.sampled) {
      const state = await coverageExpansionState(db);
      if (
        state?.invalidReceipts !== 0 ||
        canonical(state) !== canonical(report.coverageExpansion.state)
      )
        throw new Error("comparison_trial_coverage_expansion_not_recovered");
      coverageExpansionStateRecovered = true;
    }
    if (report.coverageDispatch?.sampled) {
      const state = await coverageDispatchState(db);
      if (
        state?.invalidBindings !== 0 ||
        canonical(state) !== canonical(report.coverageDispatch.state)
      )
        throw new Error("comparison_trial_coverage_dispatch_not_recovered");
      coverageDispatchStateRecovered = true;
    }
    if (report.matchingInvalidation?.sampled) {
      if (
        canonical(await matchingDependencyState(db)) !==
        canonical(report.matchingInvalidation.state)
      )
        throw new Error("comparison_trial_matching_dependency_state_changed");
      const bad = await db
        .prepare(
          "SELECT count(*) AS n FROM inventory_match_live_sets l WHERE l.tenant='trial' AND (l.ref_count!=(SELECT count(*) FROM match_results r INDEXED BY match_result_set WHERE r.tenant=l.tenant AND r.set_id=l.set_id) OR NOT EXISTS(SELECT 1 FROM inventory_match_sets h WHERE h.tenant=l.tenant AND h.set_id=l.set_id AND h.generation_id=l.generation_id AND h.state='committed') OR EXISTS(SELECT 1 FROM inventory_match_tokens t JOIN inventory_match_probes p ON p.tenant=t.tenant AND p.set_id=t.set_id AND p.probe_id=t.probe_id WHERE t.tenant=l.tenant AND t.set_id=l.set_id AND NOT EXISTS(SELECT 1 FROM inventory_matching_bucket_dependents d WHERE d.tenant=t.tenant AND d.set_id=t.set_id AND d.scope_id=p.search_scope AND d.key_class=t.key_class AND d.bucket_hash=t.bucket_hash)))",
        )
        .first<{ n: number }>();
      if (bad?.n !== 0)
        throw new Error("comparison_trial_matching_dependencies_not_recovered");
      matchingInvalidationStateRecovered = true;
    }
    return {
      directory,
      vendorHttpRequests: 0,
      uploads: 0,
      activeGenerationRecovered: true,
      persistedHashesValidated: validated,
      preparedProjectionsValidated,
      publishedProjectionsValidated,
      publishedProjectionReadStats: loaded.stats,
      matchingSnapshotsValidated,
      matchingResultsValidated,
      historicalAssociationsValidated,
      jobProjectionsValidated,
      coordinatorProjectionsValidated,
      matchingWorkValidated,
      matchingInvalidationStateRecovered,
      matchingPairRowsValidated,
      coverageRecoveryStateRecovered,
      coverageDispatchStateRecovered,
      coverageExpansionStateRecovered,
      selectedInputStateRecovered,
      comparisonWakeupStateRecovered,
      counts: await db
        .prepare(
          "SELECT (SELECT count(*) FROM comparison_index) AS records,(SELECT count(*) FROM bucket_versions) AS buckets,(SELECT count(*) FROM comparison_work) AS work,(SELECT count(*) FROM comparison_build_pages WHERE state='committed') AS buildPages",
        )
        .first(),
      databaseBytes: (await db.prepare("SELECT 1").run()).meta.size_after,
    };
  } finally {
    await mf.dispose();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { values } = parseArgs({
    options: { capture: { type: "string" }, reopen: { type: "string" } },
  });
  if (Boolean(values.capture) === Boolean(values.reopen))
    throw new Error(
      "usage: inventory-comparison-trial --capture DIRECTORY | --reopen DIRECTORY",
    );
  console.log(
    JSON.stringify(
      values.capture
        ? await inventoryComparisonTrial(values.capture)
        : await reopenInventoryComparisonTrial(values.reopen as string),
      null,
      2,
    ),
  );
}
