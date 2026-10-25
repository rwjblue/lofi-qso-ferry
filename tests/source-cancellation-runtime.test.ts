import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

test("native source cleanup preserves LoFi outcomes, one renewal and source-proof holds", async (t) => {
  const bundle = await build({
    stdin: {
      contents: `
import { LoFiClient, LoFiError } from './src/lofi.ts';
import { collectSourcePresence } from './src/source-presence-collector.ts';
export default { async fetch(request) {
  const { kind, cancellation } = await request.json();
  let release, cancelCalls = 0, requests = 0, registrations = 0, unhandled = 0;
  const onUnhandled = event => { unhandled++; event.preventDefault(); };
  addEventListener('unhandledrejection', onUnhandled);
  const gate = new Promise(resolve => { release = resolve; });
  const cleanup = () => {
    cancelCalls++;
    if (cancellation === 'throw') throw new Error('synthetic cleanup failure');
    return cancellation === 'pending' ? gate : Promise.reject(new Error('synthetic cleanup failure'));
  };
  const response = status => {
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(kind === 'oversize' ? 2 * 1024 * 1024 + 1 : 1)); },
      cancel: cleanup
    });
    // Exercise an actual synchronous method throw as well as stream rejections.
    if (cancellation === 'throw') {
      if (kind === 'oversize') {
        const getReader = body.getReader.bind(body);
        body.getReader = () => { const reader = getReader(); reader.cancel = cleanup; return reader; };
      } else body.cancel = cleanup;
    }
    return new Response(body, { status });
  };
  const credentials = { key: 'synthetic-key', secret: 'synthetic-secret', token: 'original-token' };
  const run = async () => {
    if (kind === 'scope' || kind === 'deadline') {
      let now = 1000000;
      const scope = { tenant: 'tenant', source: 'source', accountId: 'account', credentialVersion: 'v1', readerPolicy: 'all-clients-v1', policyEpoch: 'epoch' };
      let current = scope;
      const result = await collectSourcePresence({
        scope, credentials,
        targets: [{ kind: 'qso', id: 'q', operationId: null, revision: 'A'.repeat(43), syncedAtMillis: 80, deleted: false, isEvent: false }],
        selectedContacts: ['q'], observedAnchors: [{ kind: 'qso', syncedAtMillis: 90 }],
        remainingRequests: 4, collectionStartedAt: now, collectionDeadline: now + 120000
      }, {
        now: () => now,
        currentScope: async () => current,
        fetcher: async (url, init) => {
          requests++;
          if (url !== 'https://lofi.ham2k.net/v1/sync' || init.redirect !== 'manual') throw new Error('request_shape');
          if (kind === 'scope') current = { ...scope, policyEpoch: 'changed' };
          else now += 120000;
          return response(200);
        }
      });
      return { outcome: result.reason, state: result.status, witnesses: result.witnesses.length,
        actualAttempts: result.actualAttempts, remainingRequests: result.remainingRequests,
        writesAuthorized: result.writesAuthorized, sourceBoundaryVerified: result.sourceBoundaryVerified,
        requiresFinalDrain: result.requiresFinalDrain, requiresDependencyReload: result.requiresDependencyReload };
    }
    const renewal = kind === 'renew' || kind === 'renew_again';
    const client = new LoFiClient(credentials, async (url, init) => {
      requests++;
      if (init.redirect !== 'manual') throw new Error('redirect_policy');
      if (String(url).endsWith('/client')) {
        registrations++;
        const body = JSON.parse(init.body).client;
        if (body.key !== credentials.key || body.secret !== credentials.secret || new Headers(init.headers).has('Authorization')) throw new Error('renewal_identity');
        return Response.json({ token: 'renewed-token' });
      }
      const expected = requests === 1 ? 'original-token' : 'renewed-token';
      if (new Headers(init.headers).get('Authorization') !== 'Bearer ' + expected) throw new Error('bearer');
      if (renewal) {
        if (requests === 1 || kind === 'renew_again') return response(401);
        return Response.json({ current_account: { uuid: 'account' } });
      }
      return response(kind === 'redirect' ? 302 : kind === 'http' ? 500 : 200);
    });
    try {
      const account = await client.accounts();
      return { outcome: account.uuid, token: client.credentialsSnapshot().token };
    } catch (error) {
      return { outcome: error instanceof LoFiError ? error.code : 'raw_error', status: error.status };
    }
  };
  const observed = run();
  let timer;
  try {
    const result = await Promise.race([observed, new Promise(resolve => {
      timer = setTimeout(() => resolve({ outcome: 'cleanup_stalled' }), 1000);
    })]);
    release();
    await observed;
    await new Promise(resolve => setTimeout(resolve, 10));
    return Response.json({ ...result, cancelCalls, requests, registrations, unhandled });
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
  const outcomes = {
    redirect: "vendor_redirect_or_opaque_response",
    http: "vendor_http_error",
    oversize: "response_too_large",
    renew: "account",
    renew_again: "vendor_http_error",
    scope: "scope_changed",
    deadline: "deadline",
  } as const;
  for (const kind of Object.keys(outcomes) as (keyof typeof outcomes)[])
    for (const cancellation of ["pending", "rejected", "throw"] as const)
      await t.test(`${kind}, ${cancellation} cleanup`, async () => {
        const response = await runtime.dispatchFetch("http://local/cancel", {
          method: "POST",
          body: JSON.stringify({ kind, cancellation }),
        });
        assert.equal(response.status, 200);
        const result = (await response.json()) as {
          outcome: string;
          status?: number;
          token?: string;
          state?: string;
          witnesses?: number;
          actualAttempts?: number;
          remainingRequests?: number;
          writesAuthorized?: boolean;
          sourceBoundaryVerified?: boolean;
          requiresFinalDrain?: boolean;
          requiresDependencyReload?: boolean;
          cancelCalls: number;
          requests: number;
          registrations: number;
          unhandled: number;
        };
        assert.equal(result.outcome, outcomes[kind]);
        assert.equal(result.cancelCalls, kind === "renew_again" ? 2 : 1);
        const renewal = kind === "renew" || kind === "renew_again";
        assert.equal(result.requests, renewal ? 3 : 1);
        assert.equal(result.registrations, renewal ? 1 : 0);
        assert.equal(result.unhandled, 0);
        if (kind === "redirect") assert.equal(result.status, 302);
        if (kind === "http") assert.equal(result.status, 500);
        if (kind === "renew_again") assert.equal(result.status, 401);
        if (kind === "renew") assert.equal(result.token, "renewed-token");
        if (kind === "scope" || kind === "deadline") {
          assert.equal(result.state, "held");
          assert.equal(result.witnesses, 0);
          assert.equal(result.actualAttempts, 1);
          assert.equal(result.remainingRequests, 3);
          assert.equal(result.writesAuthorized, false);
          assert.equal(result.sourceBoundaryVerified, false);
          assert.equal(result.requiresFinalDrain, true);
          assert.equal(result.requiresDependencyReload, true);
        }
      });
  assert.equal(outboundCalls, 0);
});
