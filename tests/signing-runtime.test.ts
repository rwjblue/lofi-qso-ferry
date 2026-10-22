import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("actual workerd imports legacy/current PKCS12 and signs the OpenSSL vector without native TQSL", async (context) => {
  const root = readFileSync(
    new URL("../fixtures/signing/root.pem", import.meta.url),
    "utf8",
  );
  const vector = JSON.parse(
    readFileSync(
      new URL("../fixtures/signing/vector.json", import.meta.url),
      "utf8",
    ),
  );
  const fixtures = ["legacy.p12", "current.p12"].map((name) =>
    readFileSync(
      new URL(`../fixtures/signing/${name}`, import.meta.url),
    ).toString("base64"),
  );
  const bundle = await build({
    stdin: {
      contents: `import { importPkcs12, buildSignedTq8 } from './src/signing.ts';
export default { async fetch(request, env) {
 const input = JSON.parse(env.FIXTURE);
 const results = [];
 for (const encoded of input.fixtures) {
  const data = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  const credential = await importPkcs12(data, 'ferry-fixture', { trustedRoots: [input.root], now: new Date('2027-01-01T00:00:00Z'), certificateStatus: async () => 'unrevoked' });
  const artifact = await buildSignedTq8(credential, input.vector.station, [input.vector.contact], new Date('2027-01-01T00:00:00Z'));
  results.push({ trusted: credential.trusted, canonical: artifact.canonicalData[0], size: artifact.bytes.length, signature: /<SIGN_LOTW_V2.0:\\d+:6>([^\\n]+)/.exec(artifact.text)?.[1] });
 }
 return Response.json(results);
} };`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  const script = bundle.outputFiles[0]!.text;
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat"],
      bindings: { FIXTURE: JSON.stringify({ root, vector, fixtures }) },
    }),
  );
  context.after(() => runtime.dispose());
  const start = performance.now();
  const response = await runtime.dispatchFetch(
    "http://localhost/signing-spike",
  );
  assert.equal(response.status, 200, await response.clone().text());
  const results = (await response.json()) as {
    trusted: boolean;
    canonical: string;
    size: number;
    signature: string;
  }[];
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.trusted, true);
    assert.equal(result.canonical, vector.canonical);
    assert.equal(result.signature, vector.signatureBase64);
    assert.ok(result.size > 500 && result.size < 4096);
  }
  context.diagnostic(
    `workerd bundle=${Buffer.byteLength(script)} bytes; cold dispatch+two imports+two signatures=${Math.round(performance.now() - start)}ms wall (not billed CPU); artifacts=${results.map((item) => item.size).join(",")} bytes`,
  );
});
