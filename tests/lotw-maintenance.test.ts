import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { refreshLotwCertificates } from "../src/lotw-maintenance.ts";
import { importPkcs12, type SigningCredential } from "../src/signing.ts";
import type { Store } from "../src/store.ts";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

const NOW = Date.parse("2027-01-01T00:00:00Z");
const fixture = (name: string) =>
  readFile(new URL(`../fixtures/signing/${name}`, import.meta.url));

async function signingFixture() {
  return importPkcs12(await fixture("current.p12"), "ferry-fixture", {
    trustedRoots: [(await fixture("root.pem")).toString()],
    now: new Date(NOW),
    certificateStatus: async () => "unrevoked",
  });
}

function publicCertificate(certificate: SigningCredential) {
  return {
    callsign: certificate.callsign,
    dxcc: certificate.dxcc,
    serial: certificate.serial,
    validFrom: certificate.validFrom,
    validTo: certificate.validTo,
    qsoFrom: certificate.qsoFrom,
    qsoTo: certificate.qsoTo,
    trusted: certificate.trusted,
    status: certificate.status,
    statusCheckedAt: certificate.statusCheckedAt,
  };
}

async function save(
  store: Store,
  id: string,
  signing: SigningCredential,
  options: {
    tenant?: string;
    status?: string;
    login?: string;
  } = {},
) {
  const tenant = options.tenant ?? "a";
  await store
    .statement(
      "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,config,created_at) VALUES(?,?,'lotw',?,?,?,'v1',?,0)",
      tenant,
      id,
      id,
      id,
      options.status ?? "needs_verification",
      JSON.stringify({
        readAccess: true,
        loginVerification: {
          status: options.login ?? "verified",
          checkedAt: new Date(NOW).toISOString(),
        },
        retained: "connection setting",
        certificates: [publicCertificate(signing)],
      }),
    )
    .run();
  await (
    await store.putPrivate(tenant, id, "v1", "credential", {
      signingCredentials: [signing],
      query: { username: "synthetic-user", password: "private-login-password" },
    })
  ).run();
}

async function harness() {
  const h = await database();
  try {
    await applyAdditionalMigrations(h.db);
    await seed(h.store);
    return {
      ...h,
      roots: JSON.stringify([(await fixture("root.pem")).toString()]),
      signing: await signingFixture(),
    };
  } catch (error) {
    await h.mf.dispose();
    throw error;
  }
}

test("automatic trust refresh verifies saved certificates without reimporting or rewriting keys", async () => {
  const h = await harness();
  try {
    await save(h.store, "lotw", { ...h.signing, trusted: false });
    const before = await h.store
      .statement("SELECT envelope FROM private_data WHERE connection='lotw'")
      .first<{ envelope: string }>();
    const result = await refreshLotwCertificates(h.store, h.roots, {
      now: NOW,
      fetcher: async () => {
        throw new Error("Fresh certificate status must not need the network");
      },
    });
    assert.deepEqual(result, {
      checked: 1,
      updated: 1,
      errors: 0,
      deferred: 0,
    });
    const connection = (await h.store.connection("a", "lotw"))!;
    assert.equal(connection.status, "active");
    assert.equal(connection.credential_version, "v1");
    const config = JSON.parse(connection.config);
    assert.equal(config.certificates[0].trusted, true);
    assert.equal(
      config.certificates[0].trustCheckedAt,
      new Date(NOW).toISOString(),
    );
    assert.equal(config.trustCheckedAt, NOW);
    assert.equal(config.retained, "connection setting");
    assert.equal(config.loginVerification.status, "verified");
    assert.doesNotMatch(
      connection.config,
      /PRIVATE KEY|private-login-password/,
    );
    const after = await h.store
      .statement("SELECT envelope FROM private_data WHERE connection='lotw'")
      .first<{ envelope: string }>();
    assert.deepEqual(after, before);
  } finally {
    await h.mf.dispose();
  }
});

test("trust refresh preserves paused and revoked connections and never overrides a rejected login", async () => {
  const h = await harness();
  try {
    for (const status of ["disabled", "paused", "revoked"])
      await save(h.store, status, h.signing, { status });
    await save(h.store, "rejected", h.signing, { login: "rejected" });
    const result = await refreshLotwCertificates(h.store, h.roots, {
      now: NOW,
    });
    assert.equal(result.checked, 3);
    for (const status of ["disabled", "paused", "revoked"])
      assert.equal((await h.store.connection("a", status))?.status, status);
    assert.equal(
      (await h.store.connection("a", "rejected"))?.status,
      "needs_verification",
    );
    assert.equal(
      JSON.parse((await h.store.connection("a", "revoked"))!.config)
        .trustCheckedAt,
      undefined,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("removing trust roots demotes an active connection using actual certificate verification", async () => {
  const h = await harness();
  try {
    await save(h.store, "lotw", h.signing, { status: "active" });
    await refreshLotwCertificates(h.store, "[]", { now: NOW });
    const connection = (await h.store.connection("a", "lotw"))!;
    assert.equal(connection.status, "needs_verification");
    assert.equal(JSON.parse(connection.config).certificates[0].trusted, false);
  } finally {
    await h.mf.dispose();
  }
});

test("certificate status refresh is cached for twelve hours and revocation prevents activation", async () => {
  const h = await harness();
  let calls = 0;
  try {
    await save(h.store, "lotw", { ...h.signing, trusted: false });
    const options = {
      now: NOW,
      fetcher: (async (input) => {
        calls++;
        const url = new URL(String(input));
        assert.equal(url.pathname, "/lotw/crl");
        assert.equal(url.searchParams.get("serial"), h.signing.serial);
        return new Response("<Status>Revoked</Status>");
      }) as typeof fetch,
    };
    await refreshLotwCertificates(h.store, h.roots, options);
    assert.equal(calls, 0);
    options.now += 12 * 60 * 60 * 1000;
    await refreshLotwCertificates(h.store, h.roots, options);
    assert.equal(calls, 1);
    const connection = (await h.store.connection("a", "lotw"))!;
    assert.equal(connection.status, "needs_verification");
    const certificate = JSON.parse(connection.config).certificates[0];
    assert.equal(certificate.status, "revoked");
    assert.equal(
      certificate.statusCheckedAt,
      new Date(options.now).toISOString(),
    );
    await refreshLotwCertificates(h.store, h.roots, options);
    assert.equal(calls, 1);
  } finally {
    await h.mf.dispose();
  }
});

test("vendor deferrals keep cooldowns and still record local trust without claiming fresh status", async () => {
  const h = await harness();
  let calls = 0;
  try {
    await save(h.store, "lotw", {
      ...h.signing,
      trusted: false,
      statusCheckedAt: new Date(NOW - 2 * 86_400_000).toISOString(),
    });
    const result = await refreshLotwCertificates(h.store, h.roots, {
      now: NOW,
      fetcher: async () => {
        calls++;
        return new Response("Try later", {
          status: 429,
          headers: { "Retry-After": "90" },
        });
      },
    });
    assert.deepEqual(result, {
      checked: 1,
      updated: 1,
      errors: 0,
      deferred: 1,
    });
    assert.equal(calls, 1);
    const connection = (await h.store.connection("a", "lotw"))!;
    assert.equal(connection.status, "needs_verification");
    const certificate = JSON.parse(connection.config).certificates[0];
    assert.equal(certificate.trusted, true);
    assert.equal(
      certificate.statusCheckedAt,
      new Date(NOW - 2 * 86_400_000).toISOString(),
    );
    assert.deepEqual(
      await h.store
        .statement(
          "SELECT cooldown_until FROM vendor_requests WHERE vendor='lotw'",
        )
        .first(),
      { cooldown_until: NOW + 90_000 },
    );
  } finally {
    await h.mf.dispose();
  }
});

test("bounded oldest-first refresh reaches later tenants without duplicating fresh status requests", async () => {
  const h = await harness();
  try {
    await seed(h.store, "b");
    await save(h.store, "first", h.signing);
    await save(h.store, "second", h.signing, { tenant: "b" });
    const options = { now: NOW, limit: 1 };
    await refreshLotwCertificates(h.store, h.roots, options);
    assert.equal((await h.store.connection("a", "first"))?.status, "active");
    assert.equal(
      (await h.store.connection("b", "second"))?.status,
      "needs_verification",
    );
    await refreshLotwCertificates(h.store, h.roots, options);
    assert.equal((await h.store.connection("b", "second"))?.status, "active");
  } finally {
    await h.mf.dispose();
  }
});

test("local trust checks continue after the bounded status budget is spent", async () => {
  const h = await harness();
  let calls = 0;
  try {
    for (const id of ["first", "second", "third"])
      await save(h.store, id, {
        ...h.signing,
        trusted: false,
        statusCheckedAt: null,
      });
    const options = {
      now: NOW,
      fetcher: async () => {
        calls++;
        return new Response("<Status>Unrevoked</Status>");
      },
    };
    const result = await refreshLotwCertificates(h.store, h.roots, options);
    assert.equal(result.checked, 3);
    assert.equal(calls, 2);
    for (const id of ["first", "second", "third"])
      assert.equal(
        JSON.parse((await h.store.connection("a", id))!.config).certificates[0]
          .trusted,
        true,
      );
    assert.equal(
      (await h.store.connection("a", "third"))?.status,
      "needs_verification",
    );
    await refreshLotwCertificates(h.store, h.roots, options);
    assert.equal(calls, 3);
    assert.equal((await h.store.connection("a", "third"))?.status, "active");
  } finally {
    await h.mf.dispose();
  }
});

test("a credential replacement or revoke during refresh cannot receive stale verification", async (t) => {
  for (const action of ["replace", "revoke", "pause", "login-rejected"])
    await t.test(action, async () => {
      const h = await harness();
      try {
        await save(h.store, "lotw", {
          ...h.signing,
          statusCheckedAt: null,
        });
        const result = await refreshLotwCertificates(h.store, h.roots, {
          now: NOW,
          fetcher: async () => {
            if (action === "replace")
              await h.store
                .statement(
                  "UPDATE connections SET credential_version='v2' WHERE id='lotw'",
                )
                .run();
            if (action === "revoke")
              await h.store
                .statement(
                  "UPDATE connections SET status='revoked',credential_version=NULL WHERE id='lotw'",
                )
                .run();
            if (action === "pause")
              await h.store
                .statement(
                  "UPDATE connections SET status='disabled' WHERE id='lotw'",
                )
                .run();
            if (action === "login-rejected")
              await h.store
                .statement(
                  "UPDATE connections SET config=json_set(config,'$.loginVerification.status','rejected') WHERE id='lotw'",
                )
                .run();
            return new Response("<Status>Unrevoked</Status>");
          },
        });
        const connection = (await h.store.connection("a", "lotw"))!;
        const config = JSON.parse(connection.config);
        if (action === "replace" || action === "revoke") {
          assert.equal(result.updated, 0);
          assert.equal(config.trustCheckedAt, undefined);
          assert.equal(
            connection.credential_version,
            action === "replace" ? "v2" : null,
          );
        } else {
          assert.equal(result.updated, 1);
          assert.equal(
            connection.status,
            action === "pause" ? "disabled" : "needs_verification",
          );
          if (action === "login-rejected")
            assert.equal(config.loginVerification.status, "rejected");
        }
      } finally {
        await h.mf.dispose();
      }
    });
});
