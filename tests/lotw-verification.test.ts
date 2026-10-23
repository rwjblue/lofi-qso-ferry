import assert from "node:assert/strict";
import test from "node:test";
import {
  lotwVerification,
  type LotwVerificationCheck,
} from "../src/lotw-verification.ts";

const now = Date.UTC(2026, 9, 23, 12);
const checked = new Date(now - 60_000).toISOString();
const roots = "bundled";
const certificate = {
  validFrom: "2026-01-01T00:00:00.000Z",
  validTo: "2027-01-01T00:00:00.000Z",
  trusted: true,
  status: "unrevoked",
  statusCheckedAt: checked,
};
const config = {
  readAccess: true,
  loginVerification: { status: "verified", checkedAt: checked },
  certificates: [certificate],
};
function checks(
  value: Record<string, unknown> = config,
  trustRootsJson = roots,
) {
  return lotwVerification(value, { trustRootsJson, now });
}
function check(
  id: LotwVerificationCheck["id"],
  value: Record<string, unknown> = config,
  trustRootsJson = roots,
) {
  const result = checks(value, trustRootsJson).find((item) => item.id === id);
  assert(result);
  return result;
}
function certCheck(
  id: LotwVerificationCheck["id"],
  changes: Record<string, unknown>,
) {
  return check(id, {
    ...config,
    certificates: [{ ...certificate, ...changes }],
  });
}

test("LoTW summaries separate accepted login, imported key and dates, issuer trust and fresh ARRL status", () => {
  const result = checks();
  assert.deepEqual(
    result.map(({ id, status }) => ({ id, status })),
    [
      { id: "login", status: "ok" },
      { id: "certificate", status: "ok" },
      { id: "trust", status: "ok" },
      { id: "certificate_status", status: "ok" },
    ],
  );
  assert.equal(check("login").checkedAt, checked);
  assert.equal(check("certificate_status").checkedAt, checked);
  assert.match(check("certificate").message, /matching private key/);
  assert.match(check("certificate").message, /does not verify a QSO upload/);
  assert.match(
    check("certificate_status").message,
    /does not verify a QSO upload/,
  );
});

test("missing login and certificate data remain unknown and legacy credentials explain their original acceptance", () => {
  const empty = checks({}, "[]");
  assert.deepEqual(
    empty.map(({ status }) => status),
    ["unknown", "unknown", "warning", "unknown"],
  );
  assert.match(empty[0].message, /login is not configured/);
  const legacy = check("login", { readAccess: true });
  assert.equal(legacy.status, "warning");
  assert.equal(legacy.checkedAt, undefined);
  assert.match(legacy.message, /accepted when this connection was saved/);
  assert.match(legacy.message, /check time is unknown.*Check login/);
  assert.equal(
    check("login", { ...config, readAccess: false }).status,
    "unknown",
  );
});

test("explicit login rejection differs from vendor unavailability without exposing account details", () => {
  for (const [status, expected] of [
    ["rejected", "error"],
    ["unavailable", "warning"],
  ]) {
    const result = check("login", {
      ...config,
      username: "private-account",
      password: "private-password",
      loginVerification: {
        status,
        checkedAt: checked,
        error: "private-vendor-response",
      },
    });
    assert.equal(result.status, expected);
    assert.equal(result.checkedAt, checked);
    assert.doesNotMatch(JSON.stringify(result), /private-/);
    assert.match(
      result.message,
      status === "rejected" ? /rejected/ : /unavailable/,
    );
  }
  assert.equal(
    check("login", {
      ...config,
      loginVerification: { status: "verified", checkedAt: "private-error" },
    }).checkedAt,
    undefined,
  );
});

test("certificate validity rejects expired, future, reversed and malformed dates", () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ validTo: new Date(now).toISOString() }, /expired/],
    [{ validFrom: new Date(now + 1).toISOString() }, /not valid yet/],
    [{ validFrom: "2028-01-01T00:00:00.000Z" }, /could not be verified/],
    [{ validTo: "2026-02-30T00:00:00.000Z" }, /could not be verified/],
    [{ validFrom: "2026" }, /could not be verified/],
    [{ validTo: undefined }, /could not be verified/],
  ];
  for (const [changes, message] of cases) {
    const result = certCheck("certificate", changes);
    assert.equal(result.status, "error");
    assert.match(result.message, message);
  }
  assert.equal(
    certCheck("certificate", {
      validFrom: new Date(now).toISOString(),
      validTo: new Date(now + 1).toISOString(),
    }).status,
    "ok",
  );
});

test("trust distinguishes missing operator configuration, invalid configuration and an unverified issuer", () => {
  const missing = check("trust", config, "[]");
  assert.equal(missing.status, "warning");
  assert.match(missing.message, /not configured on the server.*Ferry operator/);
  for (const invalid of [
    "private-error",
    "{}",
    "[null]",
    '[""]',
    JSON.stringify(Array(9).fill("root")),
  ]) {
    const result = check("trust", config, invalid);
    assert.equal(result.status, "error");
    assert.match(result.message, /invalid on the server.*Ferry operator/);
    assert.doesNotMatch(result.message, /private-error/);
  }
  const untrusted = certCheck("trust", { trusted: false });
  assert.equal(untrusted.status, "warning");
  assert.match(untrusted.message, /issuer could not be verified/);
  assert.equal(check("trust", {}).status, "unknown");
});

test("ARRL revoked and superseded status remain errors even when checks are old", () => {
  for (const status of ["revoked", "superseded"]) {
    const result = certCheck("certificate_status", {
      status,
      statusCheckedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(result.status, "error");
    assert.match(result.message, new RegExp(status));
  }
  assert.equal(
    certCheck("certificate_status", { status: "unknown" }).status,
    "warning",
  );
});

test("ARRL status needs a known check within 24 hours and uses the oldest certificate check", () => {
  const cutoff = now - 24 * 60 * 60 * 1000;
  assert.equal(
    certCheck("certificate_status", {
      statusCheckedAt: new Date(cutoff + 1).toISOString(),
    }).status,
    "ok",
  );
  const stale = certCheck("certificate_status", {
    statusCheckedAt: new Date(cutoff).toISOString(),
  });
  assert.equal(stale.status, "warning");
  assert.match(stale.message, /at least 24 hours old/);
  for (const statusCheckedAt of [
    undefined,
    "private-error",
    new Date(now + 1).toISOString(),
  ]) {
    const result = certCheck("certificate_status", { statusCheckedAt });
    assert.equal(result.status, "warning");
    assert.equal(result.checkedAt, undefined);
    assert.match(result.message, /check time is unknown/);
  }
  const multiple = check("certificate_status", {
    ...config,
    certificates: [
      certificate,
      { ...certificate, statusCheckedAt: new Date(cutoff).toISOString() },
    ],
  });
  assert.equal(multiple.status, "warning");
  assert.equal(multiple.checkedAt, new Date(cutoff).toISOString());
});

test("verification summaries never serialize private config fields or raw certificate data", () => {
  const output = JSON.stringify(
    checks({
      ...config,
      queryUsername: "private-username",
      secret: "private-password",
      error: "private-vendor-error",
      certificates: [
        {
          ...certificate,
          callsign: "private-callsign",
          certificatePem: "private-pem",
          privateKeyPkcs8: "private-key",
        },
      ],
    }),
  );
  assert.doesNotMatch(output, /private-/);
});
