import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { SourceRecord } from "../src/lofi.ts";
import { Store } from "../src/store.ts";
import { applyMigration, keys, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

test("native workerd fetch collects source presence and drains before minting a proof", async (t) => {
  const operations: SourceRecord[] = [
    { uuid: "op", stationCall: "N0CALL", grid: "FN31AA", syncedAtMillis: 99 },
  ];
  const qsos: SourceRecord[] = [
    {
      uuid: "q",
      operation: "op",
      syncedAtMillis: 100,
      startAtMillis: 1_792_684_800_000,
      band: "20m",
      mode: "FT8",
      freq: 14074,
      their: { call: "W1AW" },
      our: { dxccCode: 291 },
    },
  ];
  const requests: { path: string; forward: boolean | null }[] = [];
  const bundle = await build({
    stdin: {
      contents: `import { Store } from './src/store.ts';
import { pollSource, rereadOperation } from './src/intake.ts';
import { sourceReadPolicy } from './src/source-read-policy.ts';
import { ensureSourceExportProofs } from './src/source-export-coordinator.ts';
export default { async fetch(request, env) {
  const store = new Store(env.DB, JSON.parse(env.KEYS));
  const source = await store.connection('a', 'source');
  const destination = await store.connection('a', 'destination');
  for (let i = 0; i < 3; i++) await pollSource(store, source, fetch, Date.now(), 'sync', null);
  await rereadOperation(store, source, fetch, Date.now(), 'background', null);
  const policy = await sourceReadPolicy(store, 'a', 'source');
  if (policy?.phase !== 'ready') throw new Error('fixture policy not ready');
  await store.statement('UPDATE source_work SET positive_observed_at=NULL,positive_policy_epoch=NULL,positive_credential_version=NULL').run();
  await store.statement('DELETE FROM vendor_requests').run();
  const lease = await store.claim('a', 'cycle:source', Date.now(), 120000);
  if (!lease) throw new Error('fixture lease unavailable');
  try {
    const result = await ensureSourceExportProofs(store, {
      tenant:'a', source:'source', accountId:'source', readerPolicy:'all-clients-v1',
      policyEpoch:policy.epoch, credentialVersion:'source-key'
    }, ['q'], lease, {
      rawFetcher:fetch, deadline:Date.now()+90000, remainingRequests:4,
      routedDestinations:() => [destination]
    });
    return Response.json({held:result.held, ready:result.ready.map(row=>row.contact.id),
      actualAttempts:result.actualAttempts, remainingRequests:result.remainingRequests,
      sourceBoundaryVerified:result.sourceBoundaryVerified, writesAuthorized:result.writesAuthorized});
  } finally { await store.release(lease); }
} };`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      // Never fetch Miniflare's optional cf.json or use external networking.
      cf: false,
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: "2026-10-22",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      bindings: { KEYS: JSON.stringify(keys) },
      outboundService: async (request) => {
        const url = new URL(request.url);
        assert.equal(url.origin, "https://lofi.ham2k.net");
        if (url.pathname === "/v1/operations/op/qsos") {
          assert.equal(request.method, "GET");
          requests.push({ path: url.pathname, forward: null });
          return Response.json({ qsos, meta: { qsos: { records_left: 0 } } });
        }
        assert.equal(url.pathname, "/v1/sync");
        assert.equal(request.method, "POST");
        const { meta } = (await request.json()) as {
          meta: {
            sync: Record<
              "operations" | "qsos",
              {
                syncedSinceMillis?: number;
                syncedUntilMillis?: number;
                limit: number;
                anyClient: boolean;
              }
            >;
          };
        };
        const sync = meta.sync;
        const forward = typeof sync.qsos.syncedSinceMillis === "number";
        assert.equal(sync.qsos.anyClient, true);
        assert.equal(sync.operations.anyClient, true);
        requests.push({ path: url.pathname, forward });
        const select = (rows: SourceRecord[], side: typeof sync.qsos) =>
          rows
            .filter((row) =>
              side.syncedSinceMillis === undefined
                ? Number(row.syncedAtMillis) < Number(side.syncedUntilMillis)
                : Number(row.syncedAtMillis) > side.syncedSinceMillis,
            )
            .slice(0, side.limit);
        return Response.json({
          account: { uuid: "source" },
          operations: select(operations, sync.operations),
          qsos: select(qsos, sync.qsos),
          meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
        });
      },
    }),
  );
  t.after(() => mf.dispose());
  const db = (await mf.getD1Database("DB")) as D1Database;
  await applyMigration(db, "0001_foundation.sql");
  await applyAdditionalMigrations(db);
  const store = new Store(db, keys);
  await seed(store);
  await store
    .statement(
      "UPDATE connections SET credential_version='source-key',config=? WHERE tenant='a' AND id='source'",
      JSON.stringify({ accountId: "source" }),
    )
    .run();
  await (
    await store.putPrivate("a", "source", "source-key", "credential", {
      key: "browser:fixture",
      secret: "fixture",
      token: "fixture",
    })
  ).run();
  const response = await mf.dispatchFetch("http://localhost/proof");
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    held: null,
    ready: ["q"],
    actualAttempts: 2,
    remainingRequests: 2,
    sourceBoundaryVerified: false,
    writesAuthorized: false,
  });
  assert.deepEqual(requests.slice(-2), [
    { path: "/v1/sync", forward: false },
    { path: "/v1/sync", forward: true },
  ]);
  assert.equal(
    await store
      .statement("SELECT COUNT(*) AS n FROM source_export_proofs")
      .first<number>("n"),
    1,
  );
  assert.equal(
    await store
      .statement("SELECT COUNT(*) AS n FROM attempts")
      .first<number>("n"),
    0,
  );
  assert.deepEqual(
    (await store.statement("SELECT vendor,requests FROM vendor_requests").all())
      .results,
    [{ vendor: "lofi", requests: 2 }],
  );
});
