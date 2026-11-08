import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { Store } from "../src/store.ts";
import { applyMigration, keys } from "./helpers.ts";
import { sourceContact } from "./inventory-matching-fixtures.ts";
import { matchingWorkFixture } from "./inventory-matching-work-fixtures.ts";

test("native workerd publishes and collects opaque date wait points without vendor requests", async (t) => {
  const bundle = await build({
    stdin: {
      contents: `
import {InventoryMatchingResults} from './src/inventory-matching-results.ts';
import {InventoryMatchingCoverageEvents} from './src/inventory-matching-coverage-events.ts';
import {Store} from './src/store.ts';
import {keyring} from './src/security.ts';
export default {async fetch(request,env){
 const store=new Store(env.DB,keyring(env));
 if(new URL(request.url).pathname==='/dispatch'){
  const publication=await new InventoryMatchingCoverageEvents(store).step('a');
  const jobs=await store.statement("SELECT count(*) AS n FROM inventory_matching_coverage_jobs WHERE completed_version<work_version").first();
  const work=await store.statement("SELECT count(*) AS n FROM matching_work WHERE completed_version<work_version").first();
  return Response.json({publication,jobs:jobs.n,work:work.n});
 }
 const selected=Array.from({length:20},(_,i)=>({scope:'source',key:'q'+i}));
 const matches=new InventoryMatchingResults(store);
 const publication=await matches.match('a','destination',selected);
 const current=await matches.current('a','destination',selected);
 const nodes=await store.statement("SELECT count(*) AS n FROM inventory_matching_coverage_dependents").first();
 const attempts=await store.statement("SELECT count(*) AS n FROM attempts").first();
 return Response.json({records:publication.records,incomplete:current.results.filter(row=>row.state==='incomplete').length,absent:current.results.filter(row=>row.state==='absent_at_inventory').length,nodes:nodes.n,attempts:attempts.n});
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
  const f = await matchingWorkFixture(
    {
      provider: "lotw",
      sources: Array.from({ length: 20 }, (_, i) => {
        const source = sourceContact(`q${i}`);
        source.body = {
          ...(source.body as object),
          startAtMillis: Date.parse("2026-10-01T13:00:00Z") + i * 86400000,
        };
        return source;
      }),
      receipts: [],
      range: ["2026-11-09", "2026-11-09"],
    },
    { mf, db, store: new Store(db, keys) },
  );
  for (const migration of [
    "0059_inventory_live_bucket_dependencies.sql",
    "0060_inventory_matching_bucket_pages.sql",
    "0062_inventory_matching_pair_jobs.sql",
    "0063_inventory_matching_pair_pages.sql",
    "0067_inventory_matching_coverage_dispatch.sql",
  ])
    await applyMigration(db, migration);
  const before = await f.inventory.snapshot("a", "source", "sync");
  const credential = await f.store.private("a", "source", "v1", "credential");
  async function turn() {
    const response = await mf.dispatchFetch("http://localhost/match");
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as {
      records: number;
      incomplete: number;
      absent: number;
      nodes: number;
      attempts: number;
    };
  }
  const blocked = await turn();
  assert.equal(blocked.records, 20);
  assert.equal(blocked.incomplete, 20);
  assert.equal(blocked.absent, 0);
  assert.equal(blocked.nodes, 62);
  await f.fullReceipt([], ["2026-10-01", "2026-10-20"]);
  const dispatched = await mf.dispatchFetch("http://localhost/dispatch");
  assert.equal(dispatched.status, 200, await dispatched.clone().text());
  const dispatch = (await dispatched.json()) as {
    publication: { kind: string; jobs: number };
    jobs: number;
    work: number;
  };
  assert.equal(dispatch.publication.kind, "dispatched");
  assert.ok(dispatch.jobs > 0 && dispatch.jobs <= 44);
  assert.equal(dispatch.publication.jobs, dispatch.jobs);
  assert.equal(
    dispatch.work,
    0,
    "dispatch queues prefixes, rather than contacts",
  );
  const ready = await turn();
  assert.equal(ready.incomplete, 0);
  assert.equal(ready.absent, 20);
  assert.equal(ready.nodes, 0);
  assert.equal(ready.attempts, 0);
  assert.equal(outbound, 0);
  assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), before);
  assert.deepEqual(
    await f.store.private("a", "source", "v1", "credential"),
    credential,
  );
});
