import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

test("native QRZ cleanup preserves bounded FETCH failures and uncertain INSERT outcomes", async (t) => {
  const bundle = await build({
    stdin: {
      contents: `
import { QrzClient, QrzError } from './src/qrz.ts';
export default { async fetch(request) {
  const { kind, action, cancellation } = await request.json();
  let release, cancelCalls = 0, requests = 0, writeChecks = 0, unhandled = 0;
  const onUnhandled = event => { unhandled++; event.preventDefault(); };
  addEventListener('unhandledrejection', onUnhandled);
  const gate = new Promise(resolve => { release = resolve; });
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(kind === 'oversize' ? 2 * 1024 * 1024 + 1 : 1));
    },
    cancel() {
      cancelCalls++;
      return cancellation === 'pending' ? gate : Promise.reject(new Error('synthetic cleanup failure'));
    }
  });
  const response = new Response(body, {
    status: kind === 'redirect' ? 302 : kind === 'http' ? 500 : kind === 'auth' ? 401 : 200
  });
  const client = new QrzClient('synthetic', {
    writesEnabled: true,
    beforeWrite: async () => { writeChecks++; return true; },
    fetch: async (url, init) => {
      requests++;
      const data = new URLSearchParams(init.body);
      if (data.get('ACTION') !== action || (action === 'INSERT' && data.has('OPTION')))
        throw new Error('request_shape');
      return response;
    }
  });
  const task = action === 'INSERT'
    ? client.insert({ CALL: 'W1AW', QSO_DATE: '20261022', TIME_ON: '120001', BAND: '20m', MODE: 'CW' })
    : client.fetchPage();
  const observed = task.then(
    () => ({ outcome: 'unexpected_success' }),
    error => ({ outcome: error instanceof QrzError ? error.kind : 'raw_error' })
  );
  let timer;
  try {
    const result = await Promise.race([
      observed,
      new Promise(resolve => { timer = setTimeout(() => resolve({ outcome: 'cleanup_stalled' }), 1000); })
    ]);
    release();
    await observed;
    await new Promise(resolve => setTimeout(resolve, 10));
    return Response.json({ ...result, cancelCalls, requests, writeChecks, unhandled });
  } finally {
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
      outboundService: () => {
        outboundCalls++;
        throw new Error("outbound forbidden");
      },
    }),
  );
  t.after(() => runtime.dispose());
  for (const kind of ["redirect", "http", "auth", "oversize"] as const)
    for (const action of ["FETCH", "INSERT"] as const)
      for (const cancellation of ["pending", "rejected"] as const)
        await t.test(`${action} ${kind}, ${cancellation} cleanup`, async () => {
          const response = await runtime.dispatchFetch("http://local/cancel", {
            method: "POST",
            body: JSON.stringify({ kind, action, cancellation }),
          });
          assert.equal(response.status, 200);
          const result = (await response.json()) as {
            outcome: string;
            cancelCalls: number;
            requests: number;
            writeChecks: number;
            unhandled: number;
          };
          assert.equal(
            result.outcome,
            action === "INSERT"
              ? "uncertain"
              : kind === "http"
                ? "transient"
                : kind === "auth"
                  ? "auth"
                  : "protocol",
          );
          assert.equal(result.cancelCalls, 1);
          assert.equal(result.requests, 1);
          assert.equal(result.writeChecks, action === "INSERT" ? 1 : 0);
          assert.equal(result.unhandled, 0);
        });
  assert.equal(outboundCalls, 0);
});
