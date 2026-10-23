import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { lotwTrustRoots } from "../src/lotw-trust.ts";
import {
  effectiveLotwTrustRoots,
  refreshLotwTrustRoots,
} from "../src/lotw-trust-cache.ts";
import { importPkcs12, verifySigningCredentialTrust } from "../src/signing.ts";
import type { Store } from "../src/store.ts";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

const NOW = Date.parse("2027-01-01T00:00:00Z");
const DAY = 86_400_000;
const MINUTE = 60_000;
const credentials = {
  username: "private-root-source-username",
  password: "private-root-source-password",
};
const fixture = (name: string) =>
  readFile(new URL(`../fixtures/signing/${name}`, import.meta.url), "utf8");
const pemBody = (pem: string) =>
  pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
const includesPem = (roots: string[], pem: string) =>
  roots.some((root) => pemBody(root) === pemBody(pem));

function response(roots: string[], userCertificate = "") {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><tqsldata><tqslcerts>${roots.map((root) => `<rootcert>${root}</rootcert>`).join("")}<usercert>${userCertificate}</usercert></tqslcerts></tqsldata>`;
  return new Response(new Uint8Array(gzipSync(xml)));
}

async function harness() {
  const h = await database();
  try {
    await applyAdditionalMigrations(h.db);
    return {
      ...h,
      root: await fixture("root.pem"),
      leaf: await fixture("certificate.pem"),
    };
  } catch (error) {
    await h.mf.dispose();
    throw error;
  }
}

async function saveSource(
  store: Store,
  tenant: string,
  id: string,
  query: { username: string; password: string },
  login = "verified",
) {
  await store
    .statement(
      "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,config,created_at) VALUES(?,?,'lotw',?,?,'needs_verification','v1',?,0)",
      tenant,
      id,
      id,
      id,
      JSON.stringify({
        readAccess: true,
        loginVerification: { status: login },
      }),
    )
    .run();
  await (
    await store.putPrivate(tenant, id, "v1", "credential", { query })
  ).run();
}

test("official gzip root updates are shared publicly and establish trust without retaining account certificates or credentials", async () => {
  const h = await harness();
  let calls = 0;
  try {
    await seed(h.store, "a");
    await seed(h.store, "b");
    assert.equal(
      includesPem(await effectiveLotwTrustRoots(h.store, "bundled"), h.root),
      false,
    );
    const result = await refreshLotwTrustRoots(h.store, "bundled", {
      credentials,
      now: NOW,
      fetcher: async (input, init) => {
        calls++;
        const url = new URL(String(input));
        assert.equal(url.origin, "https://lotw.arrl.org");
        assert.equal(url.pathname, "/lotwuser/certs.tq6");
        assert.equal(url.searchParams.get("login"), credentials.username);
        assert.equal(url.searchParams.get("password"), credentials.password);
        assert.equal(init?.redirect, "manual");
        return response([h.root], h.leaf);
      },
    });
    assert.equal(result.status, "updated");
    assert.equal(calls, 1);
    assert.equal(includesPem(result.roots, h.root), true);
    assert.equal(includesPem(result.roots, h.leaf), false);
    const learned = await effectiveLotwTrustRoots(h.store, "bundled");
    assert.deepEqual(learned, result.roots);
    for (const pinned of lotwTrustRoots("bundled"))
      assert.equal(includesPem(learned, pinned), true);
    const signing = await importPkcs12(
      new Uint8Array(
        await readFile(
          new URL("../fixtures/signing/current.p12", import.meta.url),
        ),
      ),
      "ferry-fixture",
      { now: new Date(NOW) },
    );
    assert.equal(signing.trusted, false);
    assert.equal(
      await verifySigningCredentialTrust(signing, learned, new Date(NOW)),
      true,
    );
    const saved = await h.store
      .statement("SELECT * FROM lotw_trust_cache")
      .all();
    const publicState = JSON.stringify({ saved: saved.results, result });
    assert.doesNotMatch(publicState, /private-root-source|BEGIN PRIVATE KEY/);
    assert.equal(publicState.includes(pemBody(h.leaf).slice(0, 80)), false);
    assert.equal(
      saved.results.length,
      1,
      "trust roots are public across accounts",
    );
  } finally {
    await h.mf.dispose();
  }
});

test("successful root updates are cached for a day and forced refreshes keep a five minute minimum", async () => {
  const h = await harness();
  let calls = 0;
  try {
    const options = {
      credentials,
      now: NOW,
      fetcher: async () => {
        calls++;
        return response([h.root]);
      },
    };
    await refreshLotwTrustRoots(h.store, "bundled", options);
    for (const elapsed of [0, MINUTE, DAY - 1])
      await refreshLotwTrustRoots(h.store, "bundled", {
        ...options,
        now: NOW + elapsed,
      });
    assert.equal(calls, 1);
    await refreshLotwTrustRoots(h.store, "bundled", {
      ...options,
      now: NOW + 4 * MINUTE,
      force: true,
    });
    assert.equal(calls, 1);
    await refreshLotwTrustRoots(h.store, "bundled", {
      ...options,
      now: NOW + 5 * MINUTE,
      force: true,
    });
    assert.equal(calls, 2);
    await refreshLotwTrustRoots(h.store, "bundled", {
      ...options,
      now: NOW + 5 * MINUTE + DAY,
    });
    assert.equal(calls, 3);
  } finally {
    await h.mf.dispose();
  }
});

test("outages and malformed updates retain last good roots, respect retry limits, and cannot poison trust", async () => {
  const h = await harness();
  let calls = 0;
  try {
    await refreshLotwTrustRoots(h.store, "bundled", {
      credentials,
      now: NOW,
      fetcher: async () => response([h.root]),
    });
    const outage = await refreshLotwTrustRoots(h.store, "bundled", {
      credentials,
      now: NOW + DAY,
      fetcher: async () => {
        calls++;
        throw new Error(
          "Synthetic transport failure with private-root-source-password",
        );
      },
    });
    assert.equal(outage.status, "unavailable");
    assert.equal(includesPem(outage.roots, h.root), true);
    await refreshLotwTrustRoots(h.store, "bundled", {
      credentials,
      now: NOW + DAY + 5 * MINUTE,
      force: true,
      fetcher: async () => {
        calls++;
        return response([h.root]);
      },
    });
    assert.equal(calls, 1, "force must still respect failure backoff");
    const malformed = await refreshLotwTrustRoots(h.store, "bundled", {
      credentials,
      now: NOW + DAY + 60 * MINUTE,
      fetcher: async () => response([h.leaf]),
    });
    assert.equal(malformed.status, "unavailable");
    assert.equal(includesPem(malformed.roots, h.root), true);
    assert.equal(includesPem(malformed.roots, h.leaf), false);
    const saved = JSON.stringify(
      (await h.store.statement("SELECT * FROM lotw_trust_cache").all()).results,
    );
    assert.doesNotMatch(saved, /private-root-source|transport failure/);
  } finally {
    await h.mf.dispose();
  }
});

test("a later official response omitting a learned root does not revoke that root", async () => {
  const h = await harness();
  try {
    await refreshLotwTrustRoots(h.store, "bundled", {
      credentials,
      now: NOW,
      fetcher: async () => response([h.root]),
    });
    const result = await refreshLotwTrustRoots(h.store, "bundled", {
      credentials,
      now: NOW + DAY,
      fetcher: async () => response([lotwTrustRoots("bundled")[0]!]),
    });
    assert.equal(result.status, "updated");
    assert.equal(includesPem(result.roots, h.root), true);
    assert.equal(
      includesPem(await effectiveLotwTrustRoots(h.store, "bundled"), h.root),
      true,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("ARRL retry delays keep learned roots and cannot be bypassed with forced refresh", async () => {
  const h = await harness();
  let calls = 0;
  try {
    await refreshLotwTrustRoots(h.store, "bundled", {
      credentials,
      now: NOW,
      fetcher: async () => response([h.root]),
    });
    const deferred = await refreshLotwTrustRoots(h.store, "bundled", {
      credentials,
      now: NOW + DAY,
      fetcher: async () => {
        calls++;
        return new Response("Try later", {
          status: 429,
          headers: { "Retry-After": "7200" },
        });
      },
    });
    assert.equal(deferred.status, "deferred");
    assert.equal(includesPem(deferred.roots, h.root), true);
    await refreshLotwTrustRoots(h.store, "bundled", {
      credentials,
      now: NOW + DAY + 60 * MINUTE,
      force: true,
      fetcher: async () => {
        calls++;
        return response([h.root]);
      },
    });
    assert.equal(calls, 1);
    const cache = await h.store
      .statement("SELECT next_attempt_at FROM lotw_trust_cache WHERE id='arrl'")
      .first<{ next_attempt_at: number }>();
    assert.equal(cache?.next_attempt_at, NOW + DAY + 120 * MINUTE);
  } finally {
    await h.mf.dispose();
  }
});

test("concurrent accounts share one global lease and perform at most one root download", async () => {
  const h = await harness();
  let calls = 0;
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetching = new Promise<void>((resolve) => {
    started = resolve;
  });
  try {
    const options = {
      credentials,
      now: NOW,
      fetcher: async () => {
        calls++;
        started();
        await pending;
        return response([h.root]);
      },
    };
    const first = refreshLotwTrustRoots(h.store, "bundled", options);
    await fetching;
    await refreshLotwTrustRoots(h.store, "bundled", options);
    assert.equal(calls, 1);
    release();
    await first;
    assert.equal(
      includesPem(await effectiveLotwTrustRoots(h.store, "bundled"), h.root),
      true,
    );
  } finally {
    release();
    await h.mf.dispose();
  }
});

test("explicit trust overrides never download or inherit automatically learned roots", async () => {
  const h = await harness();
  let calls = 0;
  try {
    await refreshLotwTrustRoots(h.store, "bundled", {
      credentials,
      now: NOW,
      fetcher: async () => response([h.root]),
    });
    for (const policy of [
      "[]",
      JSON.stringify([lotwTrustRoots("bundled")[0]]),
    ]) {
      const result = await refreshLotwTrustRoots(h.store, policy, {
        credentials,
        now: NOW + DAY,
        force: true,
        fetcher: async () => {
          calls++;
          return response([h.root]);
        },
      });
      assert.deepEqual(result.roots, lotwTrustRoots(policy));
      assert.deepEqual(
        await effectiveLotwTrustRoots(h.store, policy),
        lotwTrustRoots(policy),
      );
      assert.equal(includesPem(result.roots, h.root), false);
    }
    assert.equal(calls, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("automatic discovery waits for readback credentials, skips rejected logins, and rotates saved account sources fairly", async () => {
  const h = await harness();
  const usernames: string[] = [];
  try {
    await seed(h.store, "a");
    await seed(h.store, "b");
    const fetcher: typeof fetch = async (input) => {
      usernames.push(new URL(String(input)).searchParams.get("login")!);
      return response([h.root]);
    };
    const missing = await refreshLotwTrustRoots(h.store, "bundled", {
      now: NOW,
      fetcher,
    });
    assert.equal(missing.status, "unconfigured");
    assert.equal(usernames.length, 0);
    await saveSource(
      h.store,
      "a",
      "rejected",
      { username: "rejected-source", password: "secret" },
      "rejected",
    );
    await saveSource(h.store, "a", "first", {
      username: "first-source",
      password: "secret",
    });
    await saveSource(h.store, "b", "second", {
      username: "second-source",
      password: "secret",
    });
    const firstUpdate = await refreshLotwTrustRoots(h.store, "bundled", {
      now: NOW,
      fetcher,
    });
    assert.equal(firstUpdate.status, "updated");
    const secondUpdate = await refreshLotwTrustRoots(h.store, "bundled", {
      now: NOW + 5 * MINUTE,
      force: true,
      fetcher,
    });
    assert.equal(secondUpdate.status, "updated");
    assert.deepEqual(usernames, ["first-source", "second-source"]);
  } finally {
    await h.mf.dispose();
  }
});
