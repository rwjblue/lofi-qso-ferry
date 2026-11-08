import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { Store } from "../src/store.ts";
import { applyMigration, keys, seed } from "./helpers.ts";

test("native workerd prepares, publishes and recovers a 1000-record encrypted inventory page", async (t) => {
  const bundle = await build({
    stdin: {
      contents: `import { InventoryIngestion } from './src/inventory-ingestion.ts';
import type { InventoryObservation } from './src/inventory-ingestion.ts';
import { keyring, open } from './src/security.ts';
import { Store } from './src/store.ts';

function requireValue(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}

export default { async fetch(_request: Request, env: Env) {
  const store = new Store(env.DB, keyring(env));
  const inventory = new InventoryIngestion(store);
  const stream = await inventory.initialize({
    tenant: 'a', scope: 'worker-source', connection: 'source', provider: 'lofi',
    logicalIdentity: 'source', adapterBinding: 'worker-test-v1', ordering: 'numeric'
  }, 'sync', 'all-clients-v1');
  const lease = await store.claim('a', 'inventory:worker-source', Date.now(), 90000);
  requireValue(lease, 'fixture_lease_unavailable');
  const observations: InventoryObservation[] = Array.from({ length: 1000 }, (_, i) => ({
    family: 'qso', key: 'q' + i, subtype: 'qso', parentKey: 'op',
    revision: String(i + 1), order: i + 1, status: 'active',
    body: { key: 'q' + i, order: i + 1, call: 'W1AW', note: 'private inventory payload ' + i }
  }));
  try {
    const page = await inventory.prepare({
      pageId: 'worker-page-1', stream, lease, requestStartedAt: Date.now(),
      origin: 'historical', facet: 'source', observations,
      nextResume: { operations: { cursor: 'op-next' }, qsos: { cursor: 'q-next' } },
      nextCheckpoint: { operations: { watermark: 999 }, qsos: { watermark: 1000 } }
    });
    const receipt = await inventory.publish(page);
    for (const index of [0, 499, 999]) {
      const body = await inventory.body('a', 'worker-source', 'qso', 'q' + index, 'source');
      requireValue(JSON.stringify(body) === JSON.stringify(observations[index].body), 'fixture_body_mismatch');
    }

    // Fetch ciphertext once, then exercise native WebCrypto for every row.
    const payloads = await store.statement(
      'SELECT payload_id,connection_id,kind,envelope FROM inventory_payloads WHERE tenant=? AND scope_id=?',
      'a', 'worker-source'
    ).all<{ payload_id: string; connection_id: string; kind: string; envelope: string }>();
    const seen = new Set<string>();
    for (const payload of payloads.results) {
      requireValue(!payload.envelope.includes('private inventory payload'), 'fixture_plaintext_leaked');
      const body = await open<{ key: string; order: number; call: string; note: string }>(
        JSON.parse(payload.envelope),
        { tenant: 'a', connection: payload.connection_id, id: payload.payload_id, kind: payload.kind, purpose: 'storage' },
        store.keys
      );
      const index = body.order - 1;
      requireValue(index >= 0 && index < 1000 && body.key === 'q' + index &&
        body.call === 'W1AW' && body.note === 'private inventory payload ' + index && !seen.has(body.key),
        'fixture_decryption_mismatch');
      seen.add(body.key);
    }

    const recovered = await inventory.recover(page);
    const replay = await inventory.publish(page);
    const current = await inventory.snapshot('a', 'worker-source', 'sync');
    const credential = await store.private('a', 'source', 'v1', 'credential');
    return Response.json({
      receipt, recovered, replay, decrypted: seen.size, payloads: payloads.results.length,
      resume: current?.resume, checkpoint: current?.checkpoint, version: current?.version,
      sequence: current?.sequence, credential, preparationMs: page.preparationMs,
      plaintextBytes: page.plaintextBytes, encryptedBytes: page.encryptedBytes
    });
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
        return new Response("External requests are disabled in this fixture", {
          status: 503,
        });
      },
    }),
  );
  t.after(() => runtime.dispose());
  const db = (await runtime.getD1Database("DB")) as D1Database;
  await applyMigration(db, "0001_foundation.sql");
  await applyMigration(db, "0039_inventory_ingestion.sql");
  await seed(new Store(db, keys));
  const credentialsBefore = (
    await db
      .prepare(
        "SELECT * FROM private_data WHERE kind='credential' ORDER BY tenant,connection,id",
      )
      .all()
  ).results;

  const started = performance.now();
  const response = await runtime.dispatchFetch("http://localhost/inventory");
  const elapsedMs = performance.now() - started;
  assert.equal(response.status, 200, await response.clone().text());
  const result = (await response.json()) as {
    receipt: {
      records: number;
      accepted: number;
      changed: number;
      statements: number;
      committedVersion: number;
      currentVersion: number;
      publicationMs: number;
      recovered: boolean;
    };
    recovered: {
      records: number;
      committedVersion: number;
      currentVersion: number;
      recovered: boolean;
    } | null;
    replay: { recovered: boolean; records: number; currentVersion: number };
    decrypted: number;
    payloads: number;
    resume: unknown;
    checkpoint: unknown;
    version: number;
    sequence: number;
    credential: unknown;
    preparationMs: number;
    plaintextBytes: number;
    encryptedBytes: number;
  };
  assert.equal(result.receipt.records, 1000);
  assert.equal(result.receipt.accepted, 1000);
  assert.equal(result.receipt.changed, 1000);
  assert.ok(result.receipt.statements <= 30, JSON.stringify(result.receipt));
  assert.equal(result.receipt.committedVersion, 1);
  assert.equal(result.receipt.currentVersion, 1);
  assert.equal(result.receipt.recovered, false);
  assert.equal(result.payloads, 1000);
  assert.equal(result.decrypted, 1000);
  assert.ok(result.recovered?.recovered);
  assert.equal(result.recovered.records, 1000);
  assert.equal(result.recovered.committedVersion, 1);
  assert.equal(result.recovered.currentVersion, 1);
  assert.equal(result.replay.recovered, true);
  assert.equal(result.replay.records, 1000);
  assert.equal(result.replay.currentVersion, 1);
  assert.equal(result.version, 1);
  assert.equal(result.sequence, 1);
  assert.deepEqual(result.resume, {
    operations: { cursor: "op-next" },
    qsos: { cursor: "q-next" },
  });
  assert.deepEqual(result.checkpoint, {
    operations: { watermark: 999 },
    qsos: { watermark: 1000 },
  });
  assert.deepEqual(result.credential, { secret: "private" });
  assert.deepEqual(
    (
      await db
        .prepare(
          "SELECT * FROM private_data WHERE kind='credential' ORDER BY tenant,connection,id",
        )
        .all()
    ).results,
    credentialsBefore,
  );
  for (const table of [
    "inventory_records",
    "inventory_record_facets",
    "inventory_payloads",
  ])
    assert.equal(
      await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>("n"),
      1000,
      table,
    );
  for (const table of [
    "ingestion_page_rows",
    "ingestion_page_guards",
    "ledger",
    "attempts",
  ])
    assert.equal(
      await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>("n"),
      0,
      table,
    );
  assert.equal(outbound, 0);
  t.diagnostic(
    `workerd 1000 records: ${result.receipt.statements} publication statements; prepare=${Math.round(result.preparationMs)}ms; publish=${Math.round(result.receipt.publicationMs)}ms; dispatch/decrypt/recovery=${Math.round(elapsedMs)}ms wall; plaintext=${result.plaintextBytes} bytes, encrypted=${result.encryptedBytes} bytes (not billed CPU or production throughput)`,
  );
});
