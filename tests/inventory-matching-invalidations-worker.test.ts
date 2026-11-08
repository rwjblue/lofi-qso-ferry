import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { Store } from "../src/store.ts";
import { applyMigration, keys } from "./helpers.ts";
import { sourceContact, receipt } from "./inventory-matching-fixtures.ts";
import { invalidationFixture } from "./inventory-matching-invalidations-fixtures.ts";

test("native Worker resumes bounded bucket expansion across requests without vendor traffic", async (t) => {
  const bundle = await build({
    stdin: {
      contents: `
import {InventoryMatchingInvalidations} from './src/inventory-matching-invalidations.ts';
import {Store} from './src/store.ts';
import {keyring} from './src/security.ts';
export default {async fetch(request,env){
 const store=new Store(env.DB,keyring(env));
 const result=await new InventoryMatchingInvalidations(store).step('a');
 const work=await store.statement("SELECT count(*) AS n FROM matching_work").first();
 const leases=await store.statement("SELECT count(*) AS n FROM leases WHERE scope LIKE '%matching-bucket%' AND expires_at>unixepoch('subsec')*1000").first();
 return Response.json({kind:result.kind,records:result.records??0,sets:result.sets??0,complete:result.complete??false,queued:work.n,leases:leases.n});
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
  const f = await invalidationFixture(
    {
      sources: Array.from({ length: 220 }, (_, i) =>
        sourceContact(`q${String(i).padStart(4, "0")}`),
      ),
      receipts: [],
    },
    { mf, db, store: new Store(db, keys) },
  );
  for (let i = 0; i < 220; i += 20)
    await f.matches.match("a", "destination", f.selected.slice(i, i + 20));
  await f.fullReceipt([receipt("1")]);
  await f.project("destination");
  const before = await f.inventory.snapshot("a", "source", "sync"),
    credential = await f.store.private("a", "source", "v1", "credential");
  for (const [records, sets, complete, total] of [
    [200, 10, false, 200],
    [20, 1, true, 220],
    [0, 0, false, 220],
  ] as const) {
    const response = await mf.dispatchFetch("http://localhost/invalidate");
    assert.equal(response.status, 200, await response.clone().text());
    const result = (await response.json()) as {
      kind: string;
      records: number;
      sets: number;
      complete: boolean;
      queued: number;
      leases: number;
    };
    assert.equal(result.kind, records ? "expanded" : "idle");
    assert.equal(result.records, records);
    assert.equal(result.sets, sets);
    assert.equal(result.complete, complete);
    assert.equal(result.queued, total);
    assert.equal(result.leases, 0);
  }
  assert.deepEqual(await f.inventory.snapshot("a", "source", "sync"), before);
  assert.deepEqual(
    await f.store.private("a", "source", "v1", "credential"),
    credential,
  );
  assert.equal(outbound, 0);
  for (const table of ["attempts", "ledger"])
    assert.equal(
      (
        await db
          .prepare(`SELECT count(*) AS n FROM ${table}`)
          .first<{ n: number }>()
      )?.n,
      0,
    );
});
