import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { historicalCandidateKeys } from "../src/historical-matching.ts";
import { InventoryComparisonBuilds } from "../src/inventory-comparison-builds.ts";
import { InventoryComparisonGenerations } from "../src/inventory-comparison-generations.ts";
import { inventoryComparisonToken } from "../src/inventory-comparison-keys.ts";
import {
  InventoryComparisonLookup,
  type InventoryComparisonRequest,
} from "../src/inventory-comparison-lookup.ts";
import { inventoryComparisonHint } from "../src/inventory-comparison-pages.ts";
import { InventoryIngestion } from "../src/inventory-ingestion.ts";
import { canonical, type Keyring, sha256 } from "../src/security.ts";
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
    return {
      directory,
      vendorHttpRequests: 0,
      uploads: 0,
      activeGenerationRecovered: true,
      persistedHashesValidated: validated,
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
