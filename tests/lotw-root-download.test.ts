import assert from "node:assert/strict";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { gzipSync } from "node:zlib";
import test from "node:test";
import forge from "node-forge";
import {
  downloadLotwTrustRoots,
  normalizeLotwTrustRoots,
} from "../src/lotw-root-download.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";

const key = forge.pki.privateKeyFromPem(
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey,
);
let serial = 0;
function certificate(
  options: {
    ca?: boolean;
    keyCertSign?: boolean;
    unknownCritical?: boolean;
    selfIssued?: boolean;
  } = {},
): forge.pki.Certificate {
  const result = forge.pki.createCertificate();
  result.publicKey = forge.pki.rsa.setPublicKey(key.n, key.e);
  result.serialNumber = (++serial).toString(16).padStart(2, "0");
  result.validity.notBefore = new Date("2020-01-01T00:00:00Z");
  result.validity.notAfter = new Date("2040-01-01T00:00:00Z");
  result.setSubject([{ name: "commonName", value: "Synthetic LoTW Root CA" }]);
  result.setIssuer(
    options.selfIssued === false
      ? [{ name: "commonName", value: "Another issuer" }]
      : result.subject.attributes,
  );
  result.setExtensions([
    { name: "basicConstraints", critical: true, cA: options.ca ?? true },
    {
      name: "keyUsage",
      critical: true,
      keyCertSign: options.keyCertSign ?? true,
    },
    ...(options.unknownCritical
      ? [{ id: "1.2.3.4.5.6.7", critical: true, value: "unknown" }]
      : []),
  ]);
  result.sign(key, forge.md.sha256.create());
  return result;
}
const root = certificate();
const otherRoot = certificate();
const pem = (value: forge.pki.Certificate) => forge.pki.certificateToPem(value);
const credentials = {
  username: "synthetic +/?& user",
  password: "private +/?& password",
};
const xml = (roots = [pem(root)], extra = "") =>
  `<?xml version="1.0" encoding="UTF-8"?><tqsldata><tqslcerts>${roots.map((value) => `<rootcert>${value}</rootcert>`).join("")}${extra}</tqslcerts><tqslconfig><entity value="A &amp; B">A &amp; B</entity></tqslconfig></tqsldata>`;
const responseFetcher =
  (response: Response): typeof fetch =>
  async () =>
    response;
const expected = async (roots = [pem(root)]) => normalizeLotwTrustRoots(roots);

async function rejectsSafely(response: Response) {
  await assert.rejects(
    downloadLotwTrustRoots(credentials, responseFetcher(response)),
    (error: Error) => {
      assert.equal(
        error.message,
        "Unable to refresh LoTW certificate trust from ARRL.",
      );
      assert.doesNotMatch(
        String(error),
        /private|synthetic|password|https:\/\//i,
      );
      assert.equal(error.cause, undefined);
      return true;
    },
  );
}

test("downloads only the fixed ARRL HTTPS endpoint with encoded credentials and no redirects", async () => {
  let calls = 0;
  const result = await downloadLotwTrustRoots(
    credentials,
    async (input, options) => {
      calls++;
      const url = new URL(String(input));
      assert.equal(url.origin, "https://lotw.arrl.org");
      assert.equal(url.pathname, "/lotwuser/certs.tq6");
      assert.equal(url.searchParams.get("login"), credentials.username);
      assert.equal(url.searchParams.get("password"), credentials.password);
      assert.deepEqual([...url.searchParams.keys()], ["login", "password"]);
      assert.equal(options?.redirect, "manual");
      assert.ok(options?.signal instanceof AbortSignal);
      return new Response(gzipSync(xml([pem(root), pem(otherRoot)])));
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(result, await expected([pem(root), pem(otherRoot)]));
  assert.ok(result.every((value) => !value.includes("\r")));
});

test("plain XML, comments, and configuration references work without retaining other certificates", async () => {
  const extra = `<usercert>PRIVATE USER DATA MUST NOT BE RETAINED</usercert><cacert>${pem(otherRoot)}</cacert>`;
  const body = `<!-- header -- > text is disallowed below -->${xml([pem(root)], extra)}`;
  await rejectsSafely(new Response(body));
  const result = await downloadLotwTrustRoots(
    credentials,
    responseFetcher(new Response(xml([pem(root)], extra))),
  );
  assert.deepEqual(result, await expected());
  assert.deepEqual(
    await downloadLotwTrustRoots(
      credentials,
      responseFetcher(
        new Response(xml().replace("<tqsldata>", "<!-- ignored --><tqsldata>")),
      ),
    ),
    await expected(),
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /PRIVATE USER DATA|usercert|cacert/,
  );
  const longPlain = xml().replace(
    "<tqslconfig>",
    `<tqslconfig><padding>${" ".repeat(300_000)}</padding>`,
  );
  assert.deepEqual(
    await downloadLotwTrustRoots(
      credentials,
      responseFetcher(new Response(longPlain)),
    ),
    await expected(),
  );
});

test("normalizes validated self-signed RSA CAs by canonical DER fingerprint", async () => {
  const result = await normalizeLotwTrustRoots([
    pem(otherRoot),
    pem(root),
    pem(root).replace(/\r\n/g, "\n"),
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(
    result,
    await normalizeLotwTrustRoots([pem(root), pem(otherRoot)]),
  );
  const hashes = result.map(
    (value) => new X509Certificate(value).fingerprint256,
  );
  assert.deepEqual(hashes, [...hashes].sort());
  assert.deepEqual(await normalizeLotwTrustRoots([]), []);
  for (const value of [
    pem(certificate({ ca: false })),
    pem(certificate({ keyCertSign: false })),
    pem(certificate({ unknownCritical: true })),
    pem(certificate({ selfIssued: false })),
    "malformed private input",
    `${pem(root)}${pem(otherRoot)}`,
  ]) {
    await assert.rejects(normalizeLotwTrustRoots([value]), {
      message: "Invalid LoTW root certificate bundle.",
    });
  }
  const tampered = certificate();
  tampered.signature = `${String.fromCharCode(tampered.signature.charCodeAt(0) ^ 1)}${tampered.signature.slice(1)}`;
  await assert.rejects(normalizeLotwTrustRoots([pem(tampered)]), {
    message: "Invalid LoTW root certificate bundle.",
  });
  await assert.rejects(normalizeLotwTrustRoots(Array(9).fill(pem(root))));
});

test("rejects unsuccessful, redirected, opaque, and wrong-origin responses", async () => {
  for (const status of [301, 302, 400, 401, 403, 429, 500, 503])
    await rejectsSafely(new Response("private response", { status }));
  for (const [property, value] of [
    ["redirected", true],
    ["type", "opaque"],
    ["type", "opaqueredirect"],
    ["url", "https://example.invalid/certs.tq6"],
  ] as const) {
    const response = new Response(xml());
    Object.defineProperty(response, property, { value });
    await rejectsSafely(response);
  }
  await rejectsSafely(new Response(null));
});

test("rejects HTML, incomplete or malformed XML, DTD, and custom entities", async () => {
  const valid = xml();
  const invalid = [
    `<html><body>${valid}</body></html>`,
    `${valid}<extra/>`,
    valid.replace("</tqsldata>", ""),
    valid.replace("</tqslcerts>", "</wrong>"),
    valid.replace(
      "<tqsldata>",
      '<!DOCTYPE tqsldata [<!ENTITY root SYSTEM "https://attacker.invalid/">]><tqsldata>',
    ),
    valid.replace(pem(root), "&root;"),
    valid.replace("<tqslconfig>", "<tqslconfig>&custom;"),
    valid.replace("<tqslconfig>", "<tqslconfig>&#0;"),
    valid.replace("<tqslconfig>", '<tqslconfig duplicate="a" duplicate="b">'),
    valid.replace("<tqslconfig>", '<tqslconfig bad="unterminated>'),
    valid.replace("<tqslconfig>", "<tqslconfig>\u0000"),
    valid.replace("<rootcert>", "<rootcert><nested/>"),
    valid.replace("<tqslcerts>", "<other>").replace("</tqslcerts>", "</other>"),
    "<tqsldata><tqslcerts/></tqsldata>",
    xml([pem(root), "malformed root"]),
    xml(Array(9).fill(pem(root))),
    `<tqsldata><tqslcerts><!-- <rootcert>${pem(root)}</rootcert> --></tqslcerts></tqsldata>`,
  ];
  for (const body of invalid) await rejectsSafely(new Response(body));
});

test("rejects malformed/truncated gzip and invalid UTF-8 safely", async () => {
  const compressed = gzipSync(xml());
  for (const body of [
    compressed.subarray(0, compressed.length - 8),
    new Uint8Array([0x1f, 0x8b, 0xff]),
    new Uint8Array([0xff, 0xfe, 0xff]),
  ])
    await rejectsSafely(new Response(body));
});

test("bounds raw gzip, XML expansion, and plain XML before certificate processing", async () => {
  const huge = xml().replace(
    "<tqslconfig>",
    `<tqslconfig><padding>${"x".repeat(1024 * 1024)}</padding>`,
  );
  await rejectsSafely(new Response(gzipSync(huge)));
  await rejectsSafely(new Response(huge));
  await rejectsSafely(
    new Response(xml(), {
      headers: { "content-length": String(1024 * 1024 + 1) },
    }),
  );
  await rejectsSafely(
    new Response(xml(), { headers: { "content-length": "invalid" } }),
  );
  const rawGzip = new Uint8Array(256 * 1024 + 1);
  rawGzip.set([0x1f, 0x8b]);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(rawGzip);
    },
    cancel() {
      cancelled = true;
    },
  });
  await rejectsSafely(new Response(stream));
  assert.equal(cancelled, true);
});

test("network and stream errors are redacted and vendor deferrals preserve their retry evidence", async () => {
  const rawError = new Error(
    `private network URL with ${credentials.password}`,
  );
  await assert.rejects(
    downloadLotwTrustRoots(credentials, async () => {
      throw rawError;
    }),
    { message: "Unable to refresh LoTW certificate trust from ARRL." },
  );
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(rawError);
      },
    }),
  );
  await rejectsSafely(response);
  const deferred = new VendorDeferredError(123456, false);
  await assert.rejects(
    downloadLotwTrustRoots(credentials, async () => {
      throw deferred;
    }),
    (error) => error === deferred,
  );
});

test("the fifteen-second deadline aborts a stalled request without leaking its URL", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | null | undefined;
  const pending = downloadLotwTrustRoots(credentials, async (_, options) => {
    signal = options?.signal;
    return new Promise<Response>(() => {});
  });
  const rejected = assert.rejects(pending, {
    message: "Unable to refresh LoTW certificate trust from ARRL.",
  });
  context.mock.timers.tick(14_999);
  assert.equal(signal?.aborted, false);
  context.mock.timers.tick(1);
  await rejected;
  assert.equal(signal?.aborted, true);
});
