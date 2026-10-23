import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createVerify } from "node:crypto";
import forge from "node-forge";
import {
  buildSignedTq8,
  canonicalSigningData,
  importPkcs12,
  lotwMode,
  signCanonical,
  verifyCertificateSignature,
  type LotwContact,
  type LotwStation,
} from "../src/signing.ts";
const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/signing/${name}`, import.meta.url));
const vector: {
  station: LotwStation;
  contact: LotwContact;
  canonical: string;
  signatureBase64: string;
} = JSON.parse(fixture("vector.json").toString());
const now = new Date("2027-01-01T00:00:00Z");
const importOptions = {
  trustedRoots: [fixture("root.pem").toString()],
  now,
  certificateStatus: async () => "unrevoked" as const,
  version: "synthetic-v1",
};
const authorizationOids = {
  first: "1.3.6.1.4.1.12348.1.2",
  last: "1.3.6.1.4.1.12348.1.3",
  dxcc: "1.3.6.1.4.1.12348.1.4",
};
function authorizationContainer(overrides: Record<string, string | null> = {}) {
  const cert = forge.pki.certificateFromPem(
    fixture("certificate.pem").toString(),
  );
  const key = forge.pki.privateKeyFromPem(fixture("key.pem").toString());
  const claims = {
    [authorizationOids.first]: "2020-01-01",
    [authorizationOids.last]: "2030-12-31",
    [authorizationOids.dxcc]: "291",
    ...overrides,
  };
  cert.setExtensions([
    ...cert.extensions.filter((extension) => !(extension.id in claims)),
    ...Object.entries(claims).flatMap(([id, value]) =>
      value === null ? [] : [{ id, value }],
    ),
  ]);
  cert.sign(key, forge.md.sha256.create());
  return Buffer.from(
    forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(key, [cert], "")).getBytes(),
    "binary",
  );
}

test("legacy RC2/3DES and modern AES PKCS12 import verify MAC, matching RSA, dates and trusted chain", async () => {
  for (const name of ["legacy.p12", "current.p12"]) {
    const credential = await importPkcs12(
      fixture(name),
      "ferry-fixture",
      importOptions,
    );
    assert.equal(credential.trusted, true);
    assert.equal(credential.callsign, "W1AW");
    assert.equal(credential.dxcc, 291);
    assert.equal(credential.qsoFrom, "2020-01-01");
    assert.equal(credential.qsoTo, "2030-12-31");
    assert.equal(credential.status, "unrevoked");
    assert.match(credential.privateKeyPkcs8, /BEGIN PRIVATE KEY/);
  }
});
test("blank-password PKCS12 imports raw ARRL authorization text without granting trust", async () => {
  for (const qsoTo of ["2030-12-31", null]) {
    const credential = await importPkcs12(
      authorizationContainer({ [authorizationOids.last]: qsoTo }),
      "",
      { now },
    );
    assert.equal(credential.callsign, "W1AW");
    assert.equal(credential.dxcc, 291);
    assert.equal(credential.qsoFrom, "2020-01-01");
    assert.equal(credential.qsoTo, qsoTo);
    assert.equal(credential.trusted, false);
    assert.equal(credential.status, "unknown");
  }
});
test("present malformed authorization claims cannot widen certificate QSO dates", async (t) => {
  const asn = forge.asn1;
  const der = (
    value: string,
    tagClass = asn.Class.UNIVERSAL,
    constructed = false,
  ) =>
    asn
      .toDer(
        asn.create(
          tagClass,
          asn.Type.IA5STRING,
          constructed,
          constructed
            ? [
                asn.create(
                  asn.Class.UNIVERSAL,
                  asn.Type.IA5STRING,
                  false,
                  value,
                ),
              ]
            : value,
        ),
      )
      .getBytes();
  for (const [name, oid, value, error] of [
    ["empty optional raw date", authorizationOids.last, "", /encoding/],
    ["empty optional DER date", authorizationOids.last, der(""), /encoding/],
    [
      "trailing DER bytes",
      authorizationOids.last,
      `${der("2030-12-31")}\0`,
      /encoding/,
    ],
    [
      "wrong DER class",
      authorizationOids.last,
      der("2030-12-31", asn.Class.CONTEXT_SPECIFIC),
      /encoding/,
    ],
    [
      "constructed DER string",
      authorizationOids.last,
      der("2030-12-31", asn.Class.UNIVERSAL, true),
      /encoding/,
    ],
    ["invalid raw DXCC", authorizationOids.dxcc, "291garbage", /encoding/],
    ["zero DXCC", authorizationOids.dxcc, "0", /DXCC authorization/],
    ["invalid raw date", authorizationOids.last, "2030-1-01", /encoding/],
    [
      "impossible calendar date",
      authorizationOids.last,
      "2030-02-30",
      /QSO date authorization/,
    ],
    [
      "reversed QSO date bounds",
      authorizationOids.last,
      "2019-12-31",
      /QSO date authorization/,
    ],
  ] as const) {
    await t.test(name, async () => {
      await assert.rejects(
        importPkcs12(authorizationContainer({ [oid]: value }), "", { now }),
        error,
      );
    });
  }
});
test("wrong password, damaged MAC, trailing ASN1 and oversized import fail closed", async () => {
  await assert.rejects(
    importPkcs12(fixture("current.p12"), "wrong"),
    /integrity/,
  );
  const corrupt = Uint8Array.from(fixture("current.p12"));
  corrupt[corrupt.length - 8] ^= 1;
  await assert.rejects(importPkcs12(corrupt, "ferry-fixture"), /integrity/);
  await assert.rejects(
    importPkcs12(
      Buffer.concat([fixture("current.p12"), Buffer.from([0])]),
      "ferry-fixture",
    ),
    /integrity/,
  );
  await assert.rejects(
    importPkcs12(new Uint8Array(256 * 1024 + 1), ""),
    /limits/,
  );
});
test("missing and mismatched keys and missing integrity MAC are rejected", async () => {
  const cert = forge.pki.certificateFromPem(
    fixture("certificate.pem").toString(),
  );
  const key = forge.pki.privateKeyFromPem(fixture("key.pem").toString());
  const encode = (input: forge.asn1.Asn1) =>
    Buffer.from(forge.asn1.toDer(input).getBytes(), "binary");
  await assert.rejects(
    importPkcs12(encode(forge.pkcs12.toPkcs12Asn1(null, [cert], "p")), "p"),
    /one RSA private key/,
  );
  const other = forge.pki.rsa.generateKeyPair({ bits: 1024 });
  await assert.rejects(
    importPkcs12(
      encode(forge.pkcs12.toPkcs12Asn1(other.privateKey, [cert], "p")),
      "p",
    ),
    /must match/,
  );
  await assert.rejects(
    importPkcs12(
      encode(forge.pkcs12.toPkcs12Asn1(key, [cert], "p", { useMac: false })),
      "p",
    ),
    /MAC is required/,
  );
});
test("canonical vector matches independent OpenSSL signature bytes and verifies", async () => {
  const credential = await importPkcs12(
    fixture("current.p12"),
    "ferry-fixture",
    importOptions,
  );
  assert.equal(
    canonicalSigningData(vector.station, vector.contact),
    vector.canonical,
  );
  assert.equal(
    await signCanonical(credential.privateKeyPkcs8, vector.canonical),
    vector.signatureBase64,
  );
  const verifier = createVerify("RSA-SHA1");
  verifier.update(vector.canonical);
  assert.equal(
    verifier.verify(
      fixture("certificate.pem"),
      vector.signatureBase64,
      "base64",
    ),
    true,
  );
  const artifact = await buildSignedTq8(
    credential,
    vector.station,
    [vector.contact],
    now,
  );
  assert.deepEqual(artifact.members, [{ id: "synthetic-1", generation: "1" }]);
  assert.equal(artifact.bytes[0], 0x1f);
  const decoded = await new Response(
    new Blob([new Uint8Array(artifact.bytes)])
      .stream()
      .pipeThrough(new DecompressionStream("gzip")),
  ).text();
  assert.equal(decoded, artifact.text);
  assert.match(decoded, /<SIGN_LOTW_V2.0:344:6>/);
  assert.match(decoded, /<GRIDSQUARE:6>FN31PR/);
});
test("signer requires fresh verified trust/status, correct station and authorized QSO dates", async () => {
  const credential = await importPkcs12(
    fixture("current.p12"),
    "ferry-fixture",
    importOptions,
  );
  for (const delta of [
    { trusted: false },
    { status: "unknown" as const },
    { status: "revoked" as const },
    { status: "superseded" as const },
    { statusCheckedAt: null },
    { statusCheckedAt: "2026-12-29T00:00:00Z" },
  ]) {
    await assert.rejects(
      buildSignedTq8(
        { ...credential, ...delta },
        vector.station,
        [vector.contact],
        now,
      ),
      /trust/,
    );
  }
  await assert.rejects(
    buildSignedTq8(
      credential,
      { ...vector.station, callsign: "W1AW/P" },
      [vector.contact],
      now,
    ),
    /does not match/,
  );
  await assert.rejects(
    buildSignedTq8(
      credential,
      { ...vector.station, dxcc: 110 },
      [vector.contact],
      now,
    ),
    /does not match/,
  );
  await assert.rejects(
    buildSignedTq8(
      credential,
      vector.station,
      [{ ...vector.contact, date: "2019-12-31" }],
      now,
    ),
    /outside certificate/,
  );
  await assert.rejects(
    buildSignedTq8(
      credential,
      vector.station,
      [vector.contact],
      new Date("2040-01-01T00:00:00Z"),
    ),
    /trust|valid/,
  );
  await assert.rejects(
    buildSignedTq8(
      credential,
      vector.station,
      [vector.contact, vector.contact],
      now,
    ),
    /unique/,
  );
  assert.throws(
    () =>
      canonicalSigningData(vector.station, {
        ...vector.contact,
        mode: "UNVERIFIED",
      }),
    /mapping/,
  );
  assert.throws(
    () =>
      canonicalSigningData({ ...vector.station, dxcc: 150 }, vector.contact),
    /versioned configuration/,
  );
});
test("strict platform verifier rejects nested DigestAlgorithm garbage accepted by Forge advisory", async () => {
  const cert = forge.pki.certificateFromPem(
    fixture("certificate.pem").toString(),
  );
  const key = forge.pki.privateKeyFromPem(fixture("key.pem").toString());
  const digest = forge.md.sha256.create();
  digest.update(forge.asn1.toDer(cert.tbsCertificate).getBytes());
  const asn = forge.asn1;
  const algorithm = asn.create(asn.Class.UNIVERSAL, asn.Type.SEQUENCE, true, [
    asn.create(
      asn.Class.UNIVERSAL,
      asn.Type.OID,
      false,
      asn.oidToDer(forge.pki.oids.sha256!).getBytes(),
    ),
    asn.create(asn.Class.UNIVERSAL, asn.Type.NULL, false, ""),
    asn.create(
      asn.Class.UNIVERSAL,
      asn.Type.OCTETSTRING,
      false,
      "untrusted garbage",
    ),
  ]);
  const nested = asn.create(asn.Class.UNIVERSAL, asn.Type.SEQUENCE, true, [
    algorithm,
    asn.create(
      asn.Class.UNIVERSAL,
      asn.Type.OCTETSTRING,
      false,
      digest.digest().getBytes(),
    ),
  ]);
  const signature = key.sign(asn.toDer(nested).getBytes(), "NONE");
  cert.signature = signature;
  assert.ok("verify" in cert.publicKey);
  assert.equal(
    cert.publicKey.verify(digest.digest().getBytes(), signature),
    true,
    "reproduce upstream vulnerable verifier",
  );
  assert.equal(
    await verifyCertificateSignature(cert, cert),
    false,
    "production path uses strict WebCrypto",
  );
});

test("excessive PKCS12 MAC iterations fail before entering synchronous KDF", async () => {
  const asn = forge.asn1.fromDer(
    forge.util.createBuffer(fixture("current.p12").toString("binary")),
  );
  assert.ok(Array.isArray(asn.value));
  const mac = asn.value[2]!;
  assert.ok(Array.isArray(mac.value));
  mac.value[2] = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.INTEGER,
    false,
    forge.asn1.integerToDer(100001).getBytes(),
  );
  await assert.rejects(
    importPkcs12(
      Buffer.from(forge.asn1.toDer(asn).getBytes(), "binary"),
      "ferry-fixture",
    ),
    /KDF iteration limit/,
  );
});

test("ordinary USB and LSB use LoTW SSB parent mode without losing FT4 mapping", () => {
  assert.equal(lotwMode("SSB", "USB"), "SSB");
  assert.equal(lotwMode("SSB", "LSB"), "SSB");
  assert.equal(lotwMode("MFSK", "FT4"), "FT4");
  assert.match(
    canonicalSigningData(vector.station, {
      ...vector.contact,
      mode: "SSB",
      submode: "USB",
    }),
    /14\.074SSB2026/,
  );
});
