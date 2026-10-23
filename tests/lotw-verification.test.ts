import assert from "node:assert/strict";
import test from "node:test";
import {
  type LotwVerificationCheck,
  lotwReadyForUpload,
  lotwVerification,
} from "../src/lotw-verification.ts";

const now = Date.UTC(2026, 9, 23, 12);
const checked = new Date(now - 60_000).toISOString();
const certificate = {
  validFrom: "2026-01-01T00:00:00.000Z",
  validTo: "2027-01-01T00:00:00.000Z",
  status: "unrevoked",
  statusCheckedAt: checked,
};
const config = {
  readAccess: true,
  loginVerification: { status: "verified", checkedAt: checked },
  certificates: [certificate],
};
function checks(value: Record<string, unknown> = config) {
  return lotwVerification(value, { now });
}
function check(
  id: LotwVerificationCheck["id"],
  value: Record<string, unknown> = config,
) {
  const result = checks(value).find((item) => item.id === id);
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

test("LoTW summaries separate accepted login, imported key and dates, and fresh ARRL serial status from upload acceptance", () => {
  const result = checks();
  assert.deepEqual(
    result.map(({ id, status }) => ({ id, status })),
    [
      { id: "login", status: "ok" },
      { id: "certificate", status: "ok" },
      { id: "certificate_status", status: "ok" },
    ],
  );
  assert.equal(check("login").checkedAt, checked);
  assert.equal(check("certificate_status").checkedAt, checked);
  assert.match(check("certificate").message, /matching private key/);
  assert.match(check("certificate").message, /LoTW validates.*on upload/);
  assert.match(check("certificate").message, /do not verify upload acceptance/);
  assert.match(
    check("certificate_status").message,
    /does not authenticate the certificate or verify upload acceptance/,
  );
});

test("missing login and certificate data remain unknown and legacy credentials explain their original acceptance", () => {
  const empty = checks({});
  assert.deepEqual(
    empty.map(({ status }) => status),
    ["unknown", "unknown", "unknown"],
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

test("legacy issuer-trust fields no longer block valid certificates or appear in summaries", () => {
  for (const trusted of [true, false, undefined]) {
    const legacy = {
      ...config,
      certificates: [{ ...certificate, trusted }],
    };
    assert.deepEqual(checks(legacy), checks());
    assert.equal(lotwReadyForUpload(legacy, now), true);
  }
  assert.doesNotMatch(JSON.stringify(checks()), /trust|root|issuer/i);
});

test("upload preflight requires usable certificates and fresh ARRL status, with readback login optional", () => {
  for (const loginVerification of [
    undefined,
    { status: "verified", checkedAt: checked },
    { status: "unavailable", checkedAt: checked },
  ]) {
    assert.equal(
      lotwReadyForUpload({ ...config, loginVerification }, now),
      true,
    );
  }
  assert.equal(lotwReadyForUpload({ ...config, readAccess: false }, now), true);
  assert.equal(
    lotwReadyForUpload(
      {
        ...config,
        loginVerification: { status: "rejected", checkedAt: checked },
      },
      now,
    ),
    false,
  );
  for (const changes of [
    { status: "revoked" },
    { status: "superseded" },
    { status: "unknown" },
    { statusCheckedAt: new Date(now - 86_400_000).toISOString() },
    { validTo: new Date(now).toISOString() },
  ]) {
    assert.equal(
      lotwReadyForUpload(
        { ...config, certificates: [{ ...certificate, ...changes }] },
        now,
      ),
      false,
    );
  }
  assert.equal(lotwReadyForUpload({}, now), false);
  assert.equal(lotwReadyForUpload({ ...config, certificates: [] }, now), false);
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
