import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { Store } from "../src/store.ts";
import { applyMigration, keys } from "./helpers.ts";
import { receipt, sourceContact } from "./inventory-matching-fixtures.ts";
import { matchingWorkFixture } from "./inventory-matching-work-fixtures.ts";

test("native Worker resumes durable matching across requests with no vendor traffic", async (t) => {
  const bundle = await build({
    stdin: {
      contents: `
import {InventoryMatchingWork} from './src/inventory-matching-work.ts';
import {Store} from './src/store.ts';
import {keyring} from './src/security.ts';
export default {async fetch(request,env){
 const store=new Store(env.DB,keyring(env));
 const result=await new InventoryMatchingWork(store).step('a');
 const work=await store.statement("SELECT count(*) AS total,sum(completed_version=work_version) AS done FROM matching_work WHERE tenant='a'").first();
 const matches=await store.statement("SELECT count(*) AS n FROM match_results WHERE tenant='a' AND state='matched_existing'").first();
 const leases=await store.statement("SELECT count(*) AS n FROM leases WHERE scope='matching:destination' AND expires_at>unixepoch('subsec')*1000").first();
 return Response.json({kind:result.kind,records:result.records??0,work,matches:matches.n,leases:leases.n});
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
      sources: Array.from({ length: 21 }, (_, i) =>
        sourceContact(`q${i}`, "13:00:00", `W${i}AW`),
      ),
      receipts: Array.from({ length: 21 }, (_, i) =>
        receipt(String(i), "130000", `W${i}AW`),
      ),
    },
    { mf, db, store: new Store(db, keys) },
  );
  const checkpoint = await f.inventory.snapshot("a", "source", "sync");
  const credential = await f.store.private("a", "source", "v1", "credential");
  await f.work.enqueue("a", f.generation, "destination", f.selected);
  for (const expected of [20, 1, 0]) {
    const response = await mf.dispatchFetch("http://localhost/matching-work");
    assert.equal(response.status, 200, await response.clone().text());
    const result = (await response.json()) as {
      kind: string;
      records: number;
      work: { total: number; done: number };
      matches: number;
      leases: number;
    };
    assert.equal(result.records, expected);
    assert.equal(result.kind, expected ? "matched" : "idle");
    assert.equal(result.work.total, 21);
    assert.equal(result.work.done, expected === 20 ? 20 : 21);
    assert.equal(result.matches, result.work.done);
    assert.equal(result.leases, 0);
  }
  assert.deepEqual(
    await f.inventory.snapshot("a", "source", "sync"),
    checkpoint,
  );
  assert.deepEqual(
    await f.store.private("a", "source", "v1", "credential"),
    credential,
  );
  assert.equal(outbound, 0);
  for (const table of ["ledger", "attempts"])
    assert.equal(
      (
        await db
          .prepare(`SELECT count(*) AS n FROM ${table}`)
          .first<{ n: number }>()
      )?.n,
      0,
    );
});
