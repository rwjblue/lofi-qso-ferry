import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

test("native shared 429 cleanup retains the actual D1 reservation and cooldown", async (t) => {
  const bundle = await build({
    stdin: {
      contents: `
import { Store } from './src/store.ts';
import { VendorDeferredError, vendorFetch } from './src/vendor-requests.ts';
export default { async fetch(request, env) {
  const { vendor, cancellation } = await request.json();
  const store = new Store(env.DB, { active: '1', keys: {} });
  await env.DB.prepare('DELETE FROM vendor_requests').run();
  let release, cancellationStarted, cancelCalls = 0, requests = 0, unhandled = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const cleanupStarted = new Promise(resolve => { cancellationStarted = resolve; });
  const onUnhandled = event => { unhandled++; event.preventDefault(); };
  addEventListener('unhandledrejection', onUnhandled);
  const cleanup = () => {
    cancelCalls++;
    cancellationStarted();
    if (cancellation === 'throw') throw new Error('synthetic cleanup failure');
    return cancellation === 'pending' ? gate : Promise.reject(new Error('synthetic cleanup failure'));
  };
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel: cleanup });
  if (cancellation === 'throw') body.cancel = cleanup;
  const throttled = new Response(body, { status: 429, headers: { 'Retry-After': '2' } });
  const fetcher = async () => { requests++; return requests === 1 ? throttled : new Response('ok'); };
  const policy = { windowMs: 1000, total: 5, background: 2 };
  const invoke = async now => {
    try {
      const result = await vendorFetch(store, vendor, fetcher, { now, policy, priority: 'background' })('https://synthetic.invalid', { method: 'POST' });
      return { state: 'response', status: result.status };
    } catch (error) {
      return error instanceof VendorDeferredError
        ? { state: 'deferred', retryAt: error.retryAt, requestSent: error.requestSent }
        : { state: 'raw_error' };
    }
  };
  const task = invoke(100);
  let timer;
  try {
    // Measure cleanup only: native reservation/cooldown queries may be slow.
    const first = await Promise.race([task, cleanupStarted.then(() => new Promise(resolve => {
      timer = setTimeout(() => resolve({ state: 'cleanup_stalled' }), 1000);
    }))]);
    release();
    await task;
    const persisted = await env.DB.prepare('SELECT requests,background_requests,cooldown_until FROM vendor_requests WHERE vendor=?').bind(vendor).first();
    const during = await invoke(1100);
    const requestsDuring = requests;
    const resumed = await invoke(2100);
    const renewed = await env.DB.prepare('SELECT requests,background_requests,cooldown_until FROM vendor_requests WHERE vendor=?').bind(vendor).first();
    await new Promise(resolve => setTimeout(resolve, 10));
    return Response.json({ first, persisted, during, requestsDuring, resumed, renewed, requests, cancelCalls, unhandled });
  } finally {
    release();
    clearTimeout(timer);
    removeEventListener('unhandledrejection', onUnhandled);
  }
}};`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  let outboundCalls = 0;
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: "2026-10-22",
      d1Databases: ["DB"],
      outboundService: () => {
        outboundCalls++;
        throw new Error("outbound forbidden");
      },
    }),
  );
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database("DB");
  // Apply the real vendor-budget migration, including its attempt priority column.
  await db.prepare("CREATE TABLE attempt_state (id TEXT PRIMARY KEY)").run();
  const migration = await readFile(
    new URL("../migrations/0009_vendor_requests.sql", import.meta.url),
    "utf8",
  );
  for (const sql of migration.split(";"))
    if (sql.trim()) await db.prepare(sql).run();
  for (const vendor of ["lofi", "qrz", "lotw"] as const)
    for (const cancellation of ["pending", "rejected", "throw"] as const)
      await t.test(`${vendor}, ${cancellation} cleanup`, async () => {
        const response = await runtime.dispatchFetch("http://local/cancel", {
          method: "POST",
          body: JSON.stringify({ vendor, cancellation }),
        });
        assert.equal(response.status, 200);
        const result = (await response.json()) as Record<string, unknown>;
        assert.deepEqual(result.first, {
          state: "deferred",
          retryAt: 2100,
          requestSent: true,
        });
        assert.deepEqual(result.persisted, {
          requests: 1,
          background_requests: 1,
          cooldown_until: 2100,
        });
        assert.deepEqual(result.during, {
          state: "deferred",
          retryAt: 2100,
          requestSent: false,
        });
        assert.equal(result.requestsDuring, 1);
        assert.deepEqual(result.resumed, { state: "response", status: 200 });
        assert.deepEqual(result.renewed, {
          requests: 1,
          background_requests: 1,
          cooldown_until: 2100,
        });
        assert.equal(result.requests, 2);
        assert.equal(result.cancelCalls, 1);
        assert.equal(result.unhandled, 0);
      });
  assert.equal(outboundCalls, 0);
});
