import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { InventoryComparisonBuilds } from "../src/inventory-comparison-builds.ts";
import { Store } from "../src/store.ts";
import { applyMigration, keys } from "./helpers.ts";
import { fixture, observation } from "./inventory-context-fixtures.ts";

test("native workerd publishes and recovers a shared source projection cohort without changing canonical inventory or sending HTTP", async (t) => {
  const bundle = await build({
    stdin: {
      contents: `
import { InventoryProjectionWorkspace, inventoryProjectionIdentity, inventoryProjectionDigest } from './src/inventory-projection-workspace.ts';
import { InventoryProjections } from './src/inventory-projections.ts';
import { keyring, open } from './src/security.ts';
import { Store } from './src/store.ts';
export default { async fetch(request,env) {
 const store=new Store(env.DB,keyring(env));
 const generation=new URL(request.url).searchParams.get('generation');
 const page=await new InventoryProjectionWorkspace(store).prepare('a',generation,'source',Array.from({length:20},(_,i)=>'q'+i));
 let decoded=0,allMatch=true;
 for(const row of page.rows) {
  const payload=page.payloads.find(payload=>payload.id===row.payload);
  const body=await open(JSON.parse(payload.envelope),inventoryProjectionIdentity(page.tenant,page.connection,payload.id),store.keys);
  allMatch=allMatch&&body.state==='ready'&&body.record.CALL==='W1AW'&&body.record.STATION_CALLSIGN==='K1ABC'&&body.record.TIME_ON==='123000'&&body.source.timePrecision==='millisecond';
  decoded++;
 }
 const { digest,...input }=page;
 const publisher=new InventoryProjections(store);
 const lease=await store.claim('a','projection:'+generation+':source',Date.now(),60000);
 if(!lease)throw new Error('projection fixture lease missing');
 try {
  const publication=await publisher.publish(page,lease,'native-projections');
  const replay=await publisher.publish(page,lease,'native-projections');
  const stored=await publisher.body('a',generation,'source','q0','source');
  return Response.json({decoded,allMatch,stats:page.stats,digestMatches:digest===await inventoryProjectionDigest(input),plaintextLeaked:JSON.stringify(page).includes('Private native source narrative'),publication,recovered:replay.recovered,storedMatches:stored?.version===1&&stored.body.record.STATION_CALLSIGN==='K1ABC'});
 } finally { await store.release(lease); }
} };`,
      loader: "ts",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["node:*"],
  });
  let outbound = 0;
  const runtime = new Miniflare(
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
  t.after(() => runtime.dispose());
  const db = (await runtime.getD1Database("DB")) as D1Database;
  await applyMigration(db, "0001_foundation.sql");
  const f = await fixture({ mf: runtime, db, store: new Store(db, keys) });
  const qsos = Array.from({ length: 20 }, (_, i) => {
    const row = observation(`q${i}`);
    row.body = {
      ...(row.body as object),
      startAtMillis: Date.parse("2026-11-08T12:30:00Z") + 123,
      notes: "Private native source narrative",
    };
    return row;
  });
  await f.full([
    observation("op", "operation"),
    observation("event", "event"),
    ...qsos,
  ]);
  await new InventoryComparisonBuilds(f.store).step(
    "a",
    f.generation,
    "source",
  );
  const before = await f.inventory.snapshot("a", "source", "sync");
  const credential = await f.store.private("a", "source", "v1", "credential");
  const response = await runtime.dispatchFetch(
    "http://localhost/projection?generation=" +
      encodeURIComponent(f.generation),
  );
  assert.equal(response.status, 200, await response.clone().text());
  const result = (await response.json()) as {
    decoded: number;
    allMatch: boolean;
    stats: { dependencies: number; decryptedBodies: number };
    digestMatches: boolean;
    plaintextLeaked: boolean;
    publication: { records: number; ready: number; statements: number };
    recovered: boolean;
    storedMatches: boolean;
  };
  assert.equal(result.decoded, 20);
  assert.equal(result.allMatch, true);
  assert.equal(result.digestMatches, true);
  assert.equal(result.plaintextLeaked, false);
  assert.equal(result.stats.dependencies, 22);
  assert.equal(result.stats.decryptedBodies, 22);
  assert.equal(result.publication.records, 20);
  assert.equal(result.publication.ready, 20);
  assert.ok(result.publication.statements < 20);
  assert.equal(result.recovered, true);
  assert.equal(result.storedMatches, true);
  assert.equal(outbound, 0);
  assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), before);
  assert.deepEqual(
    await f.store.private("a", "source", "v1", "credential"),
    credential,
  );
  t.diagnostic(
    "native workerd: 20 encrypted source projections published/recovered, 22 shared dependency decryptions, no canonical writes or vendor HTTP",
  );
});
