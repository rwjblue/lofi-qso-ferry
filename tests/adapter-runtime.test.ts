import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { LoFiClient } from "../src/lofi.ts";
import { QrzClient } from "../src/qrz.ts";
import { LotwClient } from "../src/lotw.ts";

const cases = [
  "lofi-register",
  "lofi-account",
  "qrz-status",
  "qrz-insert",
  "lotw-query",
  "lotw-status",
  "lotw-submit",
] as const;
const emptyReport = "<PROGRAMID:4>LoTW<APP_LoTW_NUMREC:1>0<EOH><APP_LoTW_EOF>";
const record = {
  CALL: "W1AW",
  STATION_CALLSIGN: "N0TEST",
  QSO_DATE: "20261022",
  TIME_ON: "120001",
  BAND: "20m",
  MODE: "CW",
};
const artifact = new Uint8Array([0x1f, 0x8b, 0x08]);

test("actual workerd vendor fetches use manual redirects and never forward credentials to a redirect target", async (context) => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `import { LoFiClient } from './src/lofi.ts';
import { QrzClient } from './src/qrz.ts';
import { LotwClient } from './src/lotw.ts';
export default { async fetch(request) {
 const action = new URL(request.url).pathname.slice(1);
 try {
  const lofi = new LoFiClient({ key: 'fixture-client', secret: 'fixture-client-secret', token: 'fixture-bearer' });
  const qrz = new QrzClient('fixture-book-key', { writesEnabled: true });
  const lotw = new LotwClient({ username: 'fixture-query-user', password: 'fixture-query-password' }, { exportsEnabled: true });
  if (action === 'lofi-register') await lofi.register();
  else if (action === 'lofi-account') await lofi.accounts();
  else if (action === 'qrz-status') await qrz.status();
  else if (action === 'qrz-insert') await qrz.insert(${JSON.stringify(record)});
  else if (action === 'lotw-query') await lotw.query({ startDate: '2026-10-22', endDate: '2026-10-22' });
  else if (action === 'lotw-status') {
   const state = await lotw.certificateStatus('123');
   return Response.json({ accepted: state === 'unrevoked', state });
  } else if (action === 'lotw-submit') {
   const result = await lotw.submit(new Uint8Array([31,139,8]), { liveWriteAuthorized: true });
   return Response.json({ accepted: result.state === 'submitted', state: result.state });
  } else throw new Error('Unknown test action');
  return Response.json({ accepted: true });
 } catch (error) {
  return Response.json({ accepted: false, diagnostic: error.message });
 }
} };`,
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["node:*"],
    target: "es2022",
  });
  let redirect = false;
  let outbound = 0;
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-10-22",
      compatibilityFlags: ["nodejs_compat"],
      outboundService: async (request) => {
        outbound++;
        const url = new URL(request.url);
        assert.ok(
          ["lofi.ham2k.net", "logbook.qrz.com", "lotw.arrl.org"].includes(
            url.hostname,
          ),
          "no outbound request may follow Location to another host",
        );
        // This cross-service Request does not retain the caller's redirect
        // option. Verify native fetch behavior with the 307/no-follow checks.
        let response: string;
        if (url.hostname === "lofi.ham2k.net") {
          if (url.pathname === "/v1/client") {
            assert.equal(request.method, "POST");
            const body = (await request.json()) as {
              client: { secret: string };
            };
            assert.equal(body.client.secret, "fixture-client-secret");
            response = JSON.stringify({ token: "fixture-new-bearer" });
          } else {
            assert.equal(url.pathname, "/v1/accounts");
            assert.equal(
              request.headers.get("Authorization"),
              "Bearer fixture-bearer",
            );
            response = JSON.stringify({
              current_account: { uuid: "fixture-account" },
            });
          }
        } else if (url.hostname === "logbook.qrz.com") {
          const body = new URLSearchParams(await request.text());
          assert.equal(body.get("KEY"), "fixture-book-key");
          response = new URLSearchParams(
            body.get("ACTION") === "INSERT"
              ? { RESULT: "OK", COUNT: "1", LOGID: "1" }
              : { RESULT: "OK" },
          ).toString();
        } else if (url.pathname.endsWith("lotwreport.adi")) {
          assert.equal(
            url.searchParams.get("password"),
            "fixture-query-password",
          );
          response = emptyReport;
        } else if (url.pathname.endsWith("/crl")) {
          response = "<Status>Unrevoked</Status>";
        } else {
          assert.equal(url.pathname, "/lotw/upload");
          assert.equal(request.method, "POST");
          await request.arrayBuffer();
          response = "<!-- .UPL. accepted -->";
        }
        // Success-shaped bodies must never override a redirect status.
        return new Response(
          response,
          redirect
            ? {
                status: 307,
                headers: { Location: "https://credential-sink.example/" },
              }
            : { status: 200 },
        );
      },
    }),
  );
  context.after(() => runtime.dispose());
  for (const action of cases) {
    const before = outbound;
    const response = await runtime.dispatchFetch(`http://localhost/${action}`);
    const result = (await response.json()) as {
      accepted: boolean;
      diagnostic?: string;
    };
    assert.equal(
      result.accepted,
      true,
      `${action}: ${result.diagnostic ?? ""}`,
    );
    assert.equal(
      outbound,
      before + 1,
      `${action} must reach native fetch exactly once`,
    );
  }
  redirect = true;
  for (const action of cases) {
    const before = outbound;
    const response = await runtime.dispatchFetch(`http://localhost/${action}`);
    const result = (await response.json()) as {
      accepted: boolean;
      state?: string;
    };
    assert.equal(
      result.accepted,
      false,
      `${action} must reject a redirect body`,
    );
    if (action === "lotw-submit") assert.equal(result.state, "uncertain");
    if (action === "lotw-status") assert.equal(result.state, "unknown");
    assert.equal(
      outbound,
      before + 1,
      `${action} must not follow or retry Location`,
    );
  }
});

test("opaque and already-redirected responses cannot establish vendor success", async () => {
  for (const property of [
    { redirected: true },
    { type: "opaque" },
    { type: "opaqueredirect" },
  ]) {
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      const body =
        url.hostname === "lofi.ham2k.net"
          ? JSON.stringify({
              token: "fixture-token",
              current_account: { uuid: "fixture-account" },
            })
          : url.hostname === "logbook.qrz.com"
            ? new URLSearchParams({
                RESULT: "OK",
                COUNT: "1",
                LOGID: "1",
              }).toString()
            : url.pathname.endsWith("lotwreport.adi")
              ? emptyReport
              : url.pathname.endsWith("/crl")
                ? "<Status>Unrevoked</Status>"
                : "<!-- .UPL. accepted -->";
      const response = new Response(body);
      for (const [name, value] of Object.entries(property))
        Object.defineProperty(response, name, { value });
      return response;
    };
    const lofi = new LoFiClient(
      { key: "fixture", secret: "fixture", token: "fixture" },
      fetcher,
    );
    await assert.rejects(lofi.accounts(), /vendor_redirect_or_opaque_response/);
    await assert.rejects(lofi.register(), /vendor_redirect_or_opaque_response/);
    const qrz = new QrzClient("fixture", {
      fetch: fetcher,
      writesEnabled: true,
    });
    await assert.rejects(qrz.status(), /redirect or opaque response/);
    await assert.rejects(
      qrz.insert(record),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "kind" in error &&
        error.kind === "uncertain",
    );
    const lotw = new LotwClient(
      { username: "fixture", password: "fixture" },
      { fetcher, exportsEnabled: true },
    );
    await assert.rejects(
      lotw.query({ startDate: "2026-10-22", endDate: "2026-10-22" }),
      /coverage remains incomplete/,
    );
    assert.equal(await lotw.certificateStatus("123"), "unknown");
    assert.equal(
      (await lotw.submit(artifact, { liveWriteAuthorized: true })).state,
      "uncertain",
    );
  }
});
