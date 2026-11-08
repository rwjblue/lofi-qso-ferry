import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { historicalCandidateKeys } from "../src/historical-matching.ts";
import { InventoryAssociations } from "../src/inventory-associations.ts";
import { InventoryComparisonBuilds } from "../src/inventory-comparison-builds.ts";
import { InventoryComparisonCoordinator } from "../src/inventory-comparison-coordinator.ts";
import { InventoryComparisonGenerations } from "../src/inventory-comparison-generations.ts";
import { inventoryComparisonToken } from "../src/inventory-comparison-keys.ts";
import {
  InventoryComparisonLookup,
  type InventoryComparisonRequest,
} from "../src/inventory-comparison-lookup.ts";
import { inventoryComparisonHint } from "../src/inventory-comparison-pages.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import { InventoryMatchingResults } from "../src/inventory-matching-results.ts";
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
import { applyMigration } from "../tests/helpers.ts";

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
    ])
      await applyMigration(db, name);
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
    const coordinatorControl = await db
      .prepare(
        "SELECT version,work_version,observed_version,phase,idle_turns,build_generation,build_scope FROM inventory_comparison_coordinators WHERE tenant='trial'",
      )
      .first();
    const matchingSnapshots: PreparedInventoryMatchingSnapshot[] = [];
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
        const result = await matches.publish(prepared, lease);
        const replay = await matches.publish(prepared, lease, result.setId);
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
    const indexCounts = (
      await db
        .prepare(
          "SELECT s.provider,i.state,count(*) AS records FROM comparison_index i JOIN inventory_scopes s ON s.tenant=i.tenant AND s.scope_id=i.scope_id WHERE i.tenant='trial' GROUP BY s.provider,i.state ORDER BY s.provider,i.state",
        )
        .all()
    ).results;
    const changed = {
      credentials: before.credentials !== (await credentials()),
      observations: before.observations !== (await observations()),
      streams: before.streams !== (await streams()),
    };
    if (changed.credentials || changed.observations || changed.streams)
      throw new Error("comparison_trial_changed_canonical_state");
    const report = {
      directory,
      vendorHttpRequests: 0,
      uploads: 0,
      generationPublished: true,
      phases,
      indexCounts,
      projections: { published: true, phases: projectionPhases },
      projectionJobs: projectionJobSample,
      coordinator: { turns: coordinatorTurns, control: coordinatorControl },
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
        const fresh = await new InventoryMatchingWorkspace(store).prepare(
          "trial",
          snapshot.destination,
          snapshot.selected,
        );
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
          "SELECT version,work_version,observed_version,phase,idle_turns,build_generation,build_scope FROM inventory_comparison_coordinators WHERE tenant='trial'",
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
