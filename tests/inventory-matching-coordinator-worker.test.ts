import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { Store } from "../src/store.ts";
import { applyMigration, keys } from "./helpers.ts";
import { installMatchingCoordinator } from "./inventory-matching-coordinator-fixtures.ts";
import { sourceContact } from "./inventory-matching-fixtures.ts";
import { matchingWorkFixture } from "./inventory-matching-work-fixtures.ts";

test("native workerd automatically enrolls, matches and recovers a completed coverage selection", async (t) => {
  const bundle = await build({
    stdin: {
      contents: `
import {InventoryComparisonCoordinator} from './src/inventory-comparison-coordinator.ts';
import {Store} from './src/store.ts';
import {keyring} from './src/security.ts';
export default {async fetch(request,env){
 const store=new Store(env.DB,keyring(env));
 const turn=await new InventoryComparisonCoordinator(store).step('a');
 const state=await store.statement("SELECT (SELECT count(*) FROM match_results_current WHERE state='absent_at_inventory') AS absent,(SELECT count(*) FROM match_results WHERE state='incomplete') AS incomplete,(SELECT count(*) FROM matching_work WHERE completed_version<work_version) AS pending,(SELECT count(*) FROM inventory_matching_coverage_dependents) AS nodes,(SELECT count(*) FROM attempts) AS attempts").first();
 return Response.json({...turn,state});
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
      receipts: [],
      range: ["2026-11-09", "2026-11-09"],
      sources: Array.from({ length: 41 }, (_, i) => sourceContact(`q${i}`)),
    },
    { mf, db, store: new Store(db, keys) },
  );
  await installMatchingCoordinator(db);
  const before = await f.inventory.snapshot("a", "source", "sync");
  const credential = await f.store.private("a", "source", "v1", "credential");
  async function drain() {
    const phases: string[] = [];
    for (let i = 0; i < 160; i++) {
      const response = await mf.dispatchFetch("http://localhost/coordinator");
      assert.equal(response.status, 200, await response.clone().text());
      const turn = (await response.json()) as {
        kind: string;
        phase?: string;
        more: boolean;
        state: {
          absent: number;
          incomplete: number;
          pending: number;
          nodes: number;
          attempts: number;
        };
      };
      assert.notEqual(turn.kind, "deferred");
      if (turn.phase && turn.kind === "advanced") phases.push(turn.phase);
      if (!turn.more) return { ...turn, phases };
    }
    throw new Error("worker coordinator did not park");
  }
  const initial = await drain();
  assert.equal(initial.state.incomplete, 41);
  assert.equal(initial.state.pending, 0);
  assert.equal(initial.state.attempts, 0);
  assert.ok(initial.phases.includes("pair"));
  assert.ok(initial.phases.includes("match"));
  await f.fullReceipt([], ["2026-11-08", "2026-11-08"]);
  const recovered = await drain();
  assert.deepEqual(recovered.state, {
    absent: 41,
    incomplete: 0,
    pending: 0,
    nodes: 0,
    attempts: 0,
  });
  for (const phase of ["coverage-events", "coverage-match", "match"])
    assert.ok(recovered.phases.includes(phase));
  assert.equal(outbound, 0);
  assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), before);
  assert.deepEqual(
    await f.store.private("a", "source", "v1", "credential"),
    credential,
  );
});
