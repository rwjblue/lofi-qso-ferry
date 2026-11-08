import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { Store } from "../src/store.ts";
import { applyMigration, keys } from "./helpers.ts";
import { observation } from "./inventory-context-fixtures.ts";
import {
  matchingFixture,
  sourceContact,
} from "./inventory-matching-fixtures.ts";

test("native workerd recovers held projections after baseline completion without renewing observations", async (t) => {
  const bundle = await build({
    stdin: {
      contents: `
import {InventoryProjectionCoverageJobs} from './src/inventory-projection-coverage-jobs.ts';
import {InventoryProjectionJobs} from './src/inventory-projection-jobs.ts';
import {Store} from './src/store.ts';
import {keyring} from './src/security.ts';
export default {async fetch(request,env){
 const store=new Store(env.DB,keyring(env));
 const recovery=new InventoryProjectionCoverageJobs(store);
 const jobs=new InventoryProjectionJobs(store);
 const turns=[];
 for(let i=0;i<3;i++) turns.push({recover:await recovery.step('a',20),project:await jobs.projectNext('a')});
 const ready=await store.statement("SELECT count(*) AS n FROM comparison_projections_current WHERE scope_id='source' AND state='ready'").first();
 const leased=await store.statement("SELECT count(*) AS n FROM leases WHERE scope LIKE '%projection-coverage%' AND expires_at>unixepoch('subsec')*1000").first();
 return Response.json({turns,ready:ready.n,leased:leased.n});
}};`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["node:*"],
  });
  let outbound = 0;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: "2026-10-22",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      bindings: { ACTIVE_KEK_VERSION: keys.active, KEK_V1: keys.keys["1"] },
      outboundService: async () => {
        outbound++;
        return new Response("disabled", { status: 503 });
      },
    }),
  );
  t.after(() => mf.dispose());
  const db = (await mf.getD1Database("DB")) as D1Database;
  await applyMigration(db, "0001_foundation.sql");
  const sources = Array.from({ length: 21 }, (_, i) =>
    sourceContact(`q${String(i).padStart(4, "0")}`, "13:00:00", `W${i}AW`),
  );
  const f = await matchingFixture(
    { sources, receipts: [] },
    { mf, db, store: new Store(db, keys) },
  );
  await applyMigration(db, "0052_inventory_projection_jobs.sql");
  await applyMigration(db, "0053_inventory_projection_coverage_jobs.sql");
  const run = await f.begin();
  await f.observed(run.id, [observation("op", "operation"), ...sources]);
  for (let i = 0; i < sources.length; i += 20)
    await f.projections.project(
      "a",
      f.generation,
      "source",
      sources.slice(i, i + 20).map((row) => row.key),
    );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) AS n FROM comparison_projections WHERE state='held'",
        )
        .first<{ n: number }>()
    )?.n,
    21,
  );
  await f.observed(run.id, []);
  await f.finish(run.id);
  const before = await f.inventory.snapshot("a", "source", "sync");
  const witnesses = (
    await db
      .prepare("SELECT * FROM inventory_record_facets ORDER BY record_key")
      .all()
  ).results;
  const credential = await f.store.private("a", "source", "v1", "credential");
  const response = await mf.dispatchFetch("http://localhost/coverage-recovery");
  assert.equal(response.status, 200, await response.clone().text());
  const report = (await response.json()) as {
    turns: {
      recover: { kind: string; records?: number };
      project: { kind: string; records?: number };
    }[];
    ready: number;
    leased: number;
  };
  assert.deepEqual(
    report.turns.map((row) => row.recover.records ?? 0),
    [20, 1, 0],
  );
  assert.deepEqual(
    report.turns.map((row) => row.project.records ?? 0),
    [20, 1, 0],
  );
  assert.equal(report.turns[2].recover.kind, "idle");
  assert.equal(report.turns[2].project.kind, "idle");
  assert.equal(report.ready, 21);
  assert.equal(report.leased, 0);
  assert.equal(outbound, 0);
  assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), before);
  assert.deepEqual(
    (
      await db
        .prepare("SELECT * FROM inventory_record_facets ORDER BY record_key")
        .all()
    ).results,
    witnesses,
  );
  assert.deepEqual(
    await f.store.private("a", "source", "v1", "credential"),
    credential,
  );
});
