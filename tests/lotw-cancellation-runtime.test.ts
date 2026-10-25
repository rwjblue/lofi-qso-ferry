import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const cases = [
  { operation: "query", status: 500, expected: "lotw_unavailable" },
  { operation: "query", status: 302, expected: "lotw_unavailable" },
  { operation: "query", status: 401, expected: "lotw_credentials" },
  { operation: "oversize", status: 200, expected: "vendor_response_bound" },
  { operation: "utf8", status: 200, expected: "invalid_utf8" },
  { operation: "certificate", status: 500, expected: "unknown" },
  { operation: "certificate", status: 302, expected: "unknown" },
  { operation: "submit", status: 500, expected: "http_after_dispatch" },
  { operation: "submit", status: 302, expected: "http_after_dispatch" },
] as const;

test("native LoTW cleanup cannot stall or replace a failed response outcome", async (t) => {
  const bundle = await build({
    stdin: {
      contents: `
import { LotwClient, LotwLoginError, boundedResponse } from './src/lotw.ts';
import { createFailureDiagnostics } from './src/failure-diagnostics.ts';
export default { async fetch(request) {
  const { operation, status, cancellation } = await request.json();
  let cancelCalls = 0, requests = 0, unhandled = 0;
  const onUnhandled = event => { unhandled++; event.preventDefault(); };
  addEventListener('unhandledrejection', onUnhandled);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(operation === 'utf8'
        ? new Uint8Array([255]) : new Uint8Array([65, 66]));
    },
    cancel() {
      cancelCalls++;
      if (cancellation === 'pending') return new Promise(() => {});
      return Promise.reject(new Error('synthetic cleanup failure'));
    }
  });
  const response = new Response(body, { status });
  const client = new LotwClient({ username: 'synthetic', password: 'synthetic' }, {
    exportsEnabled: true,
    fetcher: async () => { requests++; return response; }
  });
  const run = async () => {
    try {
      if (operation === 'query') {
        await client.query({ startDate: '2026-10-22', endDate: '2026-10-22' });
        return { outcome: 'unexpected_query_success' };
      }
      if (operation === 'certificate')
        return { outcome: await client.certificateStatus('123') };
      if (operation === 'submit') {
        const result = await client.submit(new Uint8Array([31, 139]), { liveWriteAuthorized: true });
        return { outcome: result.code, state: result.state };
      }
      await boundedResponse(response, operation === 'oversize' ? 1 : 10);
      return { outcome: 'unexpected_body_success' };
    } catch (error) {
      if (operation === 'utf8' && error instanceof TypeError)
        return { outcome: 'invalid_utf8' };
      const diagnostics = createFailureDiagnostics();
      diagnostics.record(error, 'history_read', 'lotw');
      return {
        outcome: Object.keys(diagnostics.counts)[0].split(':')[2],
        loginError: error instanceof LotwLoginError
      };
    }
  };
  let timer;
  try {
    const result = await Promise.race([
      run(),
      new Promise(resolve => { timer = setTimeout(() => resolve({ outcome: 'cleanup_stalled' }), 1000); })
    ]);
    // Give rejected cleanup promises a turn to emit an unhandled event.
    await new Promise(resolve => setTimeout(resolve, 10));
    return Response.json({ ...result, cancelCalls, requests, unhandled });
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
  for (const fixture of cases) {
    for (const cancellation of ["pending", "rejected"] as const) {
      await t.test(
        `${fixture.operation} ${fixture.status}, ${cancellation} cancellation`,
        async () => {
          const response = await runtime.dispatchFetch("http://local/cancel", {
            method: "POST",
            body: JSON.stringify({ ...fixture, cancellation }),
          });
          assert.equal(response.status, 200);
          const result = (await response.json()) as {
            outcome: string;
            state?: string;
            loginError?: boolean;
            cancelCalls: number;
            requests: number;
            unhandled: number;
          };
          assert.equal(result.outcome, fixture.expected);
          assert.equal(result.cancelCalls, 1);
          assert.equal(
            result.requests,
            fixture.operation === "oversize" || fixture.operation === "utf8"
              ? 0
              : 1,
          );
          assert.equal(result.unhandled, 0);
          if (fixture.operation === "submit")
            assert.equal(result.state, "uncertain");
          if (fixture.status === 401) assert.equal(result.loginError, true);
        },
      );
    }
  }
  assert.equal(outboundCalls, 0);
});
