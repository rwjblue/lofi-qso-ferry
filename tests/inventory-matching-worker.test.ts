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

test("native workerd matches and adopts historical records without changing inventory or sending HTTP", async (t) => {
  const bundle = await build({
    stdin: {
      contents: `
import {InventoryMatchingResults} from './src/inventory-matching-results.ts';
import {InventoryAssociations} from './src/inventory-associations.ts';
import {Store} from './src/store.ts';
import {keyring,canonical} from './src/security.ts';
export default {async fetch(request,env){
 const store=new Store(env.DB,keyring(env));
 const selected=Array.from({length:20},(_,i)=>({scope:'source',key:'q'+i}));
 const matches=new InventoryMatchingResults(store);
 const publication=await matches.match('a','destination',selected);
 const current=await matches.current('a','destination',selected);
 const associations=new InventoryAssociations(store);
 const adoption=await associations.adopt('a','destination',selected);
 const replay=await associations.adopt('a','destination',selected);
 const activeLease=await store.statement("SELECT count(*) AS n FROM leases WHERE tenant='a' AND (scope='matching:destination' OR scope='inventory-ownership:qrz') AND expires_at>unixepoch('subsec')*1000").first();
 const readOnly=await store.statement("SELECT count(*) AS n FROM inventory_historical_write_blocks WHERE tenant='a'").first();
 return Response.json({publication,adoption,replayRecords:replay.records,readOnly:readOnly.n,current:current.results.filter(row=>row.state==='matched_existing'&&row.version===1).length,activeLease:activeLease.n,plaintextLeaked:canonical({current,adoption,replay}).includes('Private matching')});
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
    publication: {
      records: number;
      preparation: {
        decryptedBodies: number;
        bodyQueries: number;
        lookupQueries: number;
      };
    };
    current: number;
    adoption: { records: number };
    replayRecords: number;
    readOnly: number;
    activeLease: number;
    plaintextLeaked: boolean;
  };
  assert.equal(result.publication.records, 20);
  assert.equal(result.current, 20);
  assert.equal(result.adoption.records, 20);
  assert.equal(result.replayRecords, 0);
  assert.equal(result.readOnly, 20);
  assert.equal(result.activeLease, 0);
  assert.equal(result.publication.preparation.decryptedBodies, 40);
  assert.equal(result.publication.preparation.bodyQueries, 1);
  assert.equal(result.publication.preparation.lookupQueries, 2);
  assert.equal(result.plaintextLeaked, false);
  assert.equal(outbound, 0);
  assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), before);
  assert.deepEqual(
    await f.store.private("a", "source", "v1", "credential"),
    credential,
  );
});
