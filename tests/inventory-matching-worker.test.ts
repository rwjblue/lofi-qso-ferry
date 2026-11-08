import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { Store } from "../src/store.ts";
import { applyMigration, keys } from "./helpers.ts";
import {
  matchingFixture,
  receipt,
  sourceContact,
} from "./inventory-matching-fixtures.ts";

test("native workerd collects a shared forward/reverse matching snapshot without canonical writes or HTTP", async (t) => {
  const bundle = await build({
    stdin: {
      contents: `
import {InventoryMatchingWorkspace} from './src/inventory-matching-workspace.ts';
import {Store} from './src/store.ts';
import {keyring,canonical,sha256} from './src/security.ts';
export default {async fetch(request,env){
 const store=new Store(env.DB,keyring(env));
 const page=await new InventoryMatchingWorkspace(store).prepare('a','destination',Array.from({length:20},(_,i)=>({scope:'source',key:'q'+i})));
 const {digest,...manifest}=page;
 return Response.json({unique:page.graph.results.filter(row=>row.state==='unique').length,records:page.records.length,stats:page.stats,pairs:page.graph.stats,digestMatches:digest===await sha256(canonical(manifest)),plaintextLeaked:canonical(page).includes('Private matching')});
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
  const f = await matchingFixture(
    {
      sources: Array.from({ length: 20 }, (_, i) =>
        sourceContact(`q${i}`, "13:00:00", `W${i}AW`),
      ),
      receipts: Array.from({ length: 20 }, (_, i) =>
        receipt(String(i), "130000", `W${i}AW`),
      ),
    },
    { mf, db, store: new Store(db, keys) },
  );
  const before = await f.inventory.snapshot("a", "source", "sync");
  const credential = await f.store.private("a", "source", "v1", "credential");
  const response = await mf.dispatchFetch("http://localhost/matching");
  assert.equal(response.status, 200, await response.clone().text());
  const result = (await response.json()) as {
    unique: number;
    records: number;
    stats: {
      decryptedBodies: number;
      bodyQueries: number;
      lookupQueries: number;
    };
    pairs: { predicateCalls: number };
    digestMatches: boolean;
    plaintextLeaked: boolean;
  };
  assert.equal(result.unique, 20);
  assert.equal(result.records, 40);
  assert.equal(result.stats.decryptedBodies, 40);
  assert.equal(result.stats.bodyQueries, 4);
  assert.equal(result.stats.lookupQueries, 2);
  assert.equal(result.pairs.predicateCalls, 20);
  assert.equal(result.digestMatches, true);
  assert.equal(result.plaintextLeaked, false);
  assert.equal(outbound, 0);
  assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), before);
  assert.deepEqual(
    await f.store.private("a", "source", "v1", "credential"),
    credential,
  );
});
