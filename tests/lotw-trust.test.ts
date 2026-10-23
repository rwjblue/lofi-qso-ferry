import assert from "node:assert/strict";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import forge from "node-forge";
import {
  BUNDLED_LOTW_TRUST_ROOTS,
  LOTW_TRUST_BUNDLE_VERSION,
  lotwTrustRoots,
} from "../src/lotw-trust.ts";
import { verifySigningCredentialTrust } from "../src/signing.ts";

const now = new Date("2027-01-01T00:00:00Z");
const key = () =>
  forge.pki.privateKeyFromPem(
    generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey,
  );
const rootKey = key();
const intermediateKey = key();
const leafKey = forge.pki.privateKeyFromPem(
  readFileSync(new URL("../fixtures/signing/key.pem", import.meta.url), "utf8"),
);
let serial = 0;
type Issuer = {
  certificate: forge.pki.Certificate;
  key: forge.pki.rsa.PrivateKey;
};
function certificate(
  name: string,
  privateKey: forge.pki.rsa.PrivateKey,
  options: {
    issuer?: Issuer;
    ca?: boolean;
    from?: string;
    to?: string;
  } = {},
): Issuer {
  const result = forge.pki.createCertificate();
  result.publicKey = forge.pki.rsa.setPublicKey(privateKey.n, privateKey.e);
  result.serialNumber = (++serial).toString(16).padStart(2, "0");
  result.validity.notBefore = new Date(options.from ?? "2020-01-01T00:00:00Z");
  result.validity.notAfter = new Date(options.to ?? "2035-01-01T00:00:00Z");
  result.setSubject([{ name: "commonName", value: name }]);
  result.setIssuer(
    options.issuer?.certificate.subject.attributes ?? result.subject.attributes,
  );
  result.setExtensions([
    { name: "basicConstraints", cA: options.ca === true, critical: true },
    {
      name: "keyUsage",
      keyCertSign: options.ca === true,
      digitalSignature: options.ca !== true,
      critical: true,
    },
  ]);
  result.sign(options.issuer?.key ?? privateKey, forge.md.sha256.create());
  return { certificate: result, key: privateKey };
}
const pem = (issuer: Issuer) => forge.pki.certificateToPem(issuer.certificate);
const credential = (leaf: Issuer, chain: Issuer[] = []) => ({
  certificatePem: pem(leaf),
  chainPem: chain.map(pem),
});

test("bundled LoTW anchors match the independently reviewed official TQSL fingerprints", () => {
  assert.ok(LOTW_TRUST_BUNDLE_VERSION.length > 0);
  assert.equal(BUNDLED_LOTW_TRUST_ROOTS.length, 3);
  assert.deepEqual(
    BUNDLED_LOTW_TRUST_ROOTS.map(
      (value) => new X509Certificate(value).fingerprint256,
    ).sort(),
    [
      "0F:B9:62:75:EA:CA:03:EF:29:FF:50:9D:9E:54:5B:1F:38:61:F4:46:8F:06:87:BE:CC:59:3E:D0:06:04:B2:E6",
      "2E:35:F9:6E:F1:86:26:DC:90:1A:2C:F3:1B:FB:56:DA:FA:DC:70:30:D7:33:D9:B3:07:D0:DB:8E:87:C7:9A:0F",
      "A6:89:D0:B4:ED:C4:F1:AF:DD:2C:62:C5:01:C8:13:6E:1F:35:4C:9D:7D:ED:06:4D:91:C9:D6:2A:F8:BD:EC:93",
    ].sort(),
  );
  const configured = lotwTrustRoots("bundled");
  assert.deepEqual(configured, BUNDLED_LOTW_TRUST_ROOTS);
  configured.pop();
  assert.equal(lotwTrustRoots("bundled").length, 3);
  assert.deepEqual(
    lotwTrustRoots("[]"),
    [],
    "an explicit empty override disables trust",
  );
  assert.deepEqual(
    lotwTrustRoots(JSON.stringify([BUNDLED_LOTW_TRUST_ROOTS[0]])),
    [BUNDLED_LOTW_TRUST_ROOTS[0]],
  );
  for (const invalid of [
    "invalid",
    "null",
    "{}",
    "[42]",
    '[""]',
    JSON.stringify(Array(9).fill(BUNDLED_LOTW_TRUST_ROOTS[0])),
  ])
    assert.throws(() => lotwTrustRoots(invalid));
});

test("an expired pinned CA remains a trust anchor for a currently valid signed leaf", async () => {
  const anchor = certificate("Pinned LoTW test CA", rootKey, {
    ca: true,
    to: "2025-01-01T00:00:00Z",
  });
  const leaf = certificate("Current station", leafKey, {
    issuer: anchor,
    from: "2026-01-01T00:00:00Z",
  });
  assert.equal(
    await verifySigningCredentialTrust(credential(leaf), [pem(anchor)], now),
    true,
  );
  assert.equal(
    await verifySigningCredentialTrust(
      credential(leaf, [anchor]),
      [pem(anchor)],
      now,
    ),
    true,
  );
  assert.equal(
    await verifySigningCredentialTrust(credential(leaf, [anchor]), [], now),
    false,
    "including an issuer in an uploaded chain does not make it trusted",
  );
});

test("expired and not-yet-valid leaves still fail with a pinned CA", async () => {
  const anchor = certificate("Pinned valid CA", rootKey, { ca: true });
  for (const validity of [
    { to: "2026-12-31T00:00:00Z" },
    { from: "2028-01-01T00:00:00Z" },
  ]) {
    const leaf = certificate("Invalid station dates", leafKey, {
      issuer: anchor,
      ...validity,
    });
    assert.equal(
      await verifySigningCredentialTrust(credential(leaf), [pem(anchor)], now),
      false,
    );
  }
});

test("rotated pinned CAs with the same subject are selected by a valid signature", async () => {
  const retired = certificate("LoTW rotating CA", rootKey, {
    ca: true,
    to: "2025-01-01T00:00:00Z",
  });
  const current = certificate("LoTW rotating CA", intermediateKey, {
    ca: true,
  });
  const leaf = certificate("Current station", leafKey, { issuer: current });
  for (const roots of [
    [pem(retired), pem(current)],
    [pem(current), pem(retired)],
  ])
    assert.equal(
      await verifySigningCredentialTrust(credential(leaf), roots, now),
      true,
    );
});

test("a non-anchor intermediate must remain current even when its issuer is pinned", async () => {
  const anchor = certificate("Pinned root", rootKey, { ca: true });
  const current = certificate(
    "Current unpinned intermediate",
    intermediateKey,
    {
      issuer: anchor,
      ca: true,
    },
  );
  const validLeaf = certificate("Current station", leafKey, {
    issuer: current,
  });
  assert.equal(
    await verifySigningCredentialTrust(
      credential(validLeaf, [current]),
      [pem(anchor)],
      now,
    ),
    true,
  );
  const intermediate = certificate(
    "Expired unpinned intermediate",
    intermediateKey,
    {
      issuer: anchor,
      ca: true,
      to: "2026-01-01T00:00:00Z",
    },
  );
  const leaf = certificate("Current station", leafKey, {
    issuer: intermediate,
  });
  assert.equal(
    await verifySigningCredentialTrust(
      credential(leaf, [intermediate]),
      [pem(anchor)],
      now,
    ),
    false,
  );
  assert.equal(
    await verifySigningCredentialTrust(
      credential(leaf, [intermediate]),
      [pem(intermediate)],
      now,
    ),
    true,
    "only explicitly pinned anchors are outside path certificate validity checks",
  );
});

test("self-signed station certificates and matching issuer names cannot establish trust", async () => {
  const anchor = certificate("Expected CA", rootKey, { ca: true });
  const impostor = certificate("Expected CA", intermediateKey, { ca: true });
  const leaf = certificate("Forged station", leafKey, { issuer: impostor });
  assert.equal(
    await verifySigningCredentialTrust(credential(leaf), [pem(anchor)], now),
    false,
  );
  assert.equal(
    await verifySigningCredentialTrust(
      credential(leaf, [impostor]),
      [pem(anchor)],
      now,
    ),
    false,
  );
  const selfSigned = certificate("Self-signed station", leafKey);
  assert.equal(
    await verifySigningCredentialTrust(
      credential(selfSigned),
      [pem(anchor)],
      now,
    ),
    false,
  );
  assert.equal(
    await verifySigningCredentialTrust(
      credential(selfSigned),
      [pem(selfSigned)],
      now,
    ),
    false,
    "a station leaf is never accepted as its own trust anchor",
  );
});

test("an expired anchor does not bypass CA authorization or signature checks", async () => {
  const notCa = certificate("Pinned but not authorized as a CA", rootKey, {
    to: "2025-01-01T00:00:00Z",
  });
  const leaf = certificate("Current station", leafKey, { issuer: notCa });
  assert.equal(
    await verifySigningCredentialTrust(credential(leaf), [pem(notCa)], now),
    false,
  );
  const anchor = certificate("Expired pinned CA", rootKey, {
    ca: true,
    to: "2025-01-01T00:00:00Z",
  });
  const tampered = certificate("Tampered station", leafKey, { issuer: anchor });
  const signature = tampered.certificate.signature;
  tampered.certificate.signature =
    signature.slice(0, -1) +
    String.fromCharCode(signature.charCodeAt(signature.length - 1) ^ 1);
  assert.equal(
    await verifySigningCredentialTrust(
      credential(tampered),
      [pem(anchor)],
      now,
    ),
    false,
  );
});
