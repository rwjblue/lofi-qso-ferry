import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { Store } from "../src/store.ts";
import { applyMigration, keys, seed } from "./helpers.ts";

test("native Worker runs a 1000-record page and publishes its delayed fenced continuation", async (t) => {
  const bundle = await build({
    stdin: {
      contents: `
import { consumeInventoryWakeups } from './src/inventory-continuations.ts';
import { InventoryIngestion } from './src/inventory-ingestion.ts';
import { planInventoryRun } from './src/inventory-run-plans.ts';
import { InventoryRunner } from './src/inventory-runner.ts';
import { InventoryRuns } from './src/inventory-runs.ts';
import { keyring } from './src/security.ts';
import { Store } from './src/store.ts';
export default { async fetch(_request: Request, env: Env) {
  const store = new Store(env.DB, keyring(env));
  const inventory = new InventoryIngestion(store);
  const runs = new InventoryRuns(inventory);
  const stream = await inventory.initialize({ tenant: 'a', scope: 'worker-run', connection: 'source', provider: 'lofi', logicalIdentity: 'source', adapterBinding: 'worker-run-v1', ordering: 'numeric' }, 'scan', 'worker-query-v1');
  const lease = await store.claim('a', 'inventory:worker-run');
  if (!lease) throw new Error('fixture lease unavailable');
  let run;
  try { run = await runs.begin({ stream, lease, definition: await planInventoryRun(stream, { provider: 'lofi', pageSize: 1000 }) }); }
  finally { await store.release(lease); }
  let vendorRequests = 0;
  const runner = new InventoryRunner(runs, async () => {
    vendorRequests++;
    return Response.json({ account: { uuid: 'source' }, operations: [], qsos: Array.from({ length: 1000 }, (_, i) => ({ uuid: 'q' + i, syncedAtMillis: i + 1, their: { call: 'W1AW' } })), meta: { operations: { records_left: 0 }, qsos: { records_left: 0 }, suggestedSyncLoopDelay: 0 } });
  });
  const queued = [];
  const outcomes = [];
  const queue = { async sendBatch(messages) { queued.push(...Array.from(messages)); return { metadata: { metrics: { backlogCount: queued.length, backlogBytes: 0 } } }; } };
  const message = { id: 'fixture', timestamp: new Date(), attempts: 1, body: { version: 1, tenant: 'a', scope: 'worker-run', stream: 'scan', run: run.id, workVersion: run.jobVersion }, ack() { outcomes.push('ack'); }, retry() { outcomes.push('retry'); } };
  const report = await consumeInventoryWakeups(runner, { messages: [message] }, queue);
  const current = await runs.load('a', run.id);
  const body = await inventory.body('a', 'worker-run', 'qso', 'q999', 'source');
  return Response.json({ report, vendorRequests, queued, outcomes, phase: current?.phase, stream: await inventory.snapshot('a', 'worker-run', 'scan'), sampleIdentityMatches: body?.uuid === 'q999' });
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
  const output = bundle.outputFiles[0];
  assert.ok(output);
  let outbound = 0;
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script: output.text,
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
  const db = await runtime.getD1Database("DB");
  for (const name of [
    "0001_foundation.sql",
    "0009_vendor_requests.sql",
    "0039_inventory_ingestion.sql",
    "0040_inventory_runs.sql",
    "0041_inventory_vendor_admission.sql",
  ])
    await applyMigration(db, name);
  const store = new Store(db, keys);
  await seed(store);
  await store
    .statement(
      "UPDATE connections SET config='{\"accountId\":\"source\"}' WHERE id='source'",
    )
    .run();
  await store
    .statement("DELETE FROM private_data WHERE connection='source'")
    .run();
  await (
    await store.putPrivate("a", "source", "v1", "credential", {
      key: "browser:fixture",
      secret: "fixture-secret",
      token: "fixture-token",
    })
  ).run();
  const credentialsBefore = (
    await db
      .prepare("SELECT envelope FROM private_data WHERE connection='source'")
      .all()
  ).results;
  const response = await runtime.dispatchFetch("http://localhost/run");
  assert.equal(response.status, 200, await response.clone().text());
  const result = (await response.json()) as {
    report: { acknowledged: number; queued: number; failed: number };
    vendorRequests: number;
    queued: {
      body: { version: number; workVersion: number };
      delaySeconds: number;
    }[];
    outcomes: string[];
    phase: string;
    stream: { version: number; checkpoint: unknown };
    sampleIdentityMatches: boolean;
  };
  assert.equal(result.report.acknowledged, 1);
  assert.equal(result.report.queued, 1);
  assert.equal(result.report.failed, 0);
  assert.equal(result.vendorRequests, 1);
  assert.equal(result.phase, "catchup");
  assert.deepEqual(result.outcomes, ["ack"]);
  assert.equal(result.queued[0].body.version, 1);
  assert.equal(result.queued[0].body.workVersion, 2);
  assert.ok(result.queued[0].delaySeconds >= 19);
  assert.equal(result.stream.version, 2);
  assert.deepEqual(result.stream.checkpoint, {});
  assert.equal(result.sampleIdentityMatches, true);
  for (const table of [
    "inventory_records",
    "inventory_record_facets",
    "inventory_run_membership",
    "inventory_partition_membership",
  ])
    assert.equal(
      await db.prepare(`SELECT count(*) n FROM ${table}`).first<number>("n"),
      1000,
    );
  for (const table of [
    "ingestion_page_guards",
    "ingestion_page_rows",
    "inventory_request_guards",
    "ledger",
    "attempts",
  ])
    assert.equal(
      await db.prepare(`SELECT count(*) n FROM ${table}`).first<number>("n"),
      0,
    );
  assert.deepEqual(
    (
      await db
        .prepare("SELECT envelope FROM private_data WHERE connection='source'")
        .all()
    ).results,
    credentialsBefore,
  );
  assert.equal(outbound, 0);
});
