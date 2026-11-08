import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { Store } from "../src/store.ts";
import { applyMigration, keys } from "./helpers.ts";
import { coverageFixture } from "./inventory-matching-coverage-fixtures.ts";

test("native workerd resumes prefix expansion and matching without an explicit comparison request", async (t) => {
  const bundle = await build({
    stdin: {
      contents: `
import {InventoryMatchingCoverage} from './src/inventory-matching-coverage.ts';
import {InventoryMatchingWork} from './src/inventory-matching-work.ts';
import {Store} from './src/store.ts';
import {keyring} from './src/security.ts';
export default {async fetch(request,env){
 const store=new Store(env.DB,keyring(env));
 const expansion=await new InventoryMatchingCoverage(store).step('a');
 const matching=await new InventoryMatchingWork(store).step('a');
 const state=await store.statement("SELECT (SELECT count(*) FROM match_results_current WHERE state='absent_at_inventory') AS absent,(SELECT count(*) FROM match_results WHERE state='incomplete') AS incomplete,(SELECT count(*) FROM inventory_matching_coverage_jobs WHERE completed_version<work_version) AS coveragePending,(SELECT count(*) FROM matching_work WHERE completed_version<work_version) AS matchingPending,(SELECT count(*) FROM attempts) AS attempts").first();
 return Response.json({expansion,matching,state});
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
  const f = await coverageFixture(41, { mf, db, store: new Store(db, keys) });
  const source = await f.inventory.snapshot("a", "source", "sync");
  const credential = await f.store.private("a", "source", "v1", "credential");
  const turns = [];
  for (let i = 0; i < 4; i++) {
    const response = await mf.dispatchFetch("http://localhost/continue");
    assert.equal(response.status, 200, await response.clone().text());
    turns.push(
      (await response.json()) as {
        expansion: { kind: string; records?: number };
        matching: { kind: string; records?: number };
        state: {
          absent: number;
          incomplete: number;
          coveragePending: number;
          matchingPending: number;
          attempts: number;
        };
      },
    );
  }
  assert.deepEqual(
    turns.map((row) => row.expansion.records ?? 0),
    [41, 0, 0, 0],
  );
  assert.deepEqual(
    turns.map((row) => row.matching.records ?? 0),
    [20, 20, 1, 0],
  );
  assert.deepEqual(turns[3].state, {
    absent: 41,
    incomplete: 0,
    coveragePending: 0,
    matchingPending: 0,
    attempts: 0,
  });
  assert.equal(turns[3].matching.kind, "idle");
  assert.equal(outbound, 0);
  assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), source);
  assert.deepEqual(
    await f.store.private("a", "source", "v1", "credential"),
    credential,
  );
});
