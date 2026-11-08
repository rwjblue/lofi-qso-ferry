import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { Store } from "../src/store.ts";
import { applyMigration, keys } from "./helpers.ts";
import { coordinatorFixture } from "./inventory-coordinator-fixtures.ts";

test("native workerd resumes coordinator turns across requests and activates only drained projections", async (t) => {
  const bundle = await build({
    stdin: {
      contents: `
import {InventoryComparisonCoordinator} from './src/inventory-comparison-coordinator.ts';
import {Store} from './src/store.ts';
import {keyring} from './src/security.ts';
export default {async fetch(request,env){return Response.json(await new InventoryComparisonCoordinator(new Store(env.DB,keyring(env))).step('a'));}};`,
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
  const f = await coordinatorFixture(21, {
    mf,
    db,
    store: new Store(db, keys),
  });
  const checkpoint = await f.inventory.snapshot("a", "source", "sync");
  const credential = await f.store.private("a", "source", "v1", "credential");
  const phases: string[] = [];
  let finished = false;
  for (let turn = 0; turn < 35; turn++) {
    const response = await mf.dispatchFetch("http://localhost/comparison-turn");
    assert.equal(response.status, 200, await response.clone().text());
    const result = (await response.json()) as {
      kind: string;
      phase?: string;
      records?: number;
      more: boolean;
    };
    assert.notEqual(result.kind, "deferred");
    if (result.kind === "advanced" && result.phase) phases.push(result.phase);
    if (!result.more) {
      finished = true;
      break;
    }
  }
  assert.equal(finished, true);
  assert.deepEqual(phases, [
    "build",
    "operation",
    "coverage",
    "project",
    "project",
    "activate",
  ]);
  assert.equal(
    (await f.generations.domain("a"))?.active_generation,
    f.generation,
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) AS n FROM comparison_projections_current WHERE state='ready'",
        )
        .first<{ n: number }>()
    )?.n,
    21,
  );
  assert.equal(outbound, 0);
  assert.deepEqual(
    await f.inventory.snapshot("a", "source", "sync"),
    checkpoint,
  );
  assert.deepEqual(
    await f.store.private("a", "source", "v1", "credential"),
    credential,
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) AS n FROM leases WHERE scope='inventory-comparison' AND expires_at>0",
        )
        .first<{ n: number }>()
    )?.n,
    0,
  );
});
