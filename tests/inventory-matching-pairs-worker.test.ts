import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { Store } from "../src/store.ts";
import { applyMigration, keys } from "./helpers.ts";
import { sourceContact } from "./inventory-matching-fixtures.ts";
import { pairPagesFixture } from "./inventory-matching-pairs-fixtures.ts";

test("native workerd expands initial enrollment across requests without decrypting or sending contacts", async (t) => {
  const bundle = await build({
    stdin: {
      contents: `
import {InventoryMatchingPairs} from './src/inventory-matching-pairs.ts';
import {Store} from './src/store.ts';
import {keyring} from './src/security.ts';
export default {async fetch(request,env){
 const store=new Store(env.DB,keyring(env));
 const result=await new InventoryMatchingPairs(store).step('a');
 const jobs=await store.statement("SELECT count(*) AS n FROM matching_work").first();
 const leases=await store.statement("SELECT count(*) AS n FROM leases WHERE scope IN(SELECT json_array('matching-pair',generation_id,destination,source_scope) FROM inventory_matching_pair_jobs) AND expires_at>unixepoch('subsec')*1000").first();
 const ledger=await store.statement("SELECT count(*) AS n FROM ledger").first();
 const attempts=await store.statement("SELECT count(*) AS n FROM attempts").first();
 return Response.json({result,jobs:jobs.n,leases:leases.n,ledger:ledger.n,attempts:attempts.n});
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
  const f = await pairPagesFixture(
    {
      sources: Array.from({ length: 205 }, (_, i) =>
        sourceContact(`q${String(i).padStart(3, "0")}`),
      ),
    },
    { mf, db, store: new Store(db, keys) },
  );
  const before = await f.inventory.snapshot("a", "source", "sync");
  const credential = await f.store.private("a", "source", "v1", "credential");
  const results = [];
  for (let i = 0; i < 3; i++) {
    const response = await mf.dispatchFetch("http://localhost/enroll");
    assert.equal(response.status, 200, await response.clone().text());
    const turn = (await response.json()) as {
      result: { kind: string; records?: number; complete?: boolean };
      jobs: number;
      leases: number;
      ledger: number;
      attempts: number;
    };
    assert.equal(turn.leases, 0);
    assert.equal(turn.ledger, 0);
    assert.equal(turn.attempts, 0);
    results.push(turn);
  }
  assert.equal(results[0].result.kind, "enrolled");
  assert.equal(results[0].result.records, 200);
  assert.equal(results[0].result.complete, false);
  assert.equal(results[0].jobs, 200);
  assert.equal(results[1].result.records, 5);
  assert.equal(results[1].result.complete, true);
  assert.equal(results[2].result.kind, "idle");
  assert.equal(results[2].jobs, 205);
  assert.equal(outbound, 0);
  assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), before);
  assert.deepEqual(
    await f.store.private("a", "source", "v1", "credential"),
    credential,
  );
});
