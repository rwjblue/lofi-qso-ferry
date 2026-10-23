import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SessionIdentity } from "../src/auth.ts";
import { connectionRoute, saveVerifiedConnection } from "../src/connections.ts";
import { digestCode, sha256 } from "../src/security.ts";
import { importPkcs12 } from "../src/signing.ts";
import type { Store } from "../src/store.ts";
import { DEFAULT_COMMENT_TEMPLATE } from "../src/templates.ts";
import { database, keys, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

const now = Date.now();
const identity: SessionIdentity = {
  tenant: "a",
  credentialId: "key-a",
  tokenHash: "session-a",
  verifiedAt: now,
};
async function setup() {
  const context = await database();
  await applyAdditionalMigrations(context.db);
  await seed(context.store, "a");
  await seed(context.store, "b");
  await context.store
    .statement(
      "INSERT INTO passkeys(id,tenant,public_key,counter,metadata,label,created_at) VALUES('key-a','a','fixture',0,'{}','fixture',?)",
      now,
    )
    .run();
  await context.store
    .statement(
      "INSERT INTO sessions(token_hash,tenant,credential_id,created_at,verified_at,expires_at) VALUES('session-a','a','key-a',?,?,?)",
      now,
      now,
      now + 86400000,
    )
    .run();
  const env = {
    DB: context.db,
    ORIGIN: "http://localhost:8787",
    ACTIVE_KEK_VERSION: "1",
    KEK_V1: keys.keys["1"],
    AUTH_SECRET: "fixture-connection-secret",
    LOTW_TRUST_ROOTS_JSON: "[]",
  } as Env;
  return { ...context, env };
}
async function vacate(store: Store, kind: string) {
  await store
    .statement(
      "UPDATE connections SET status='revoked' WHERE tenant='a' AND kind=?",
      kind,
    )
    .run();
}
async function request(
  path: string,
  input: unknown = {},
  env: Env,
): Promise<Request> {
  return new Request(`http://localhost:8787/api/connections${path}`, {
    method: "POST",
    headers: {
      Origin: env.ORIGIN,
      "Content-Type": "application/json",
      Cookie:
        "__Host-ferry_browser=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "X-CSRF-Token": await digestCode(
        env.AUTH_SECRET,
        `csrf:${await sha256("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")}:anonymous`,
      ),
    },
    body: JSON.stringify(input),
  });
}
const emptyLotwReport =
  "<PROGRAMID:4>LoTW<APP_LoTW_NUMREC:1>0<EOH><APP_LoTW_EOF>";
async function savedLotwLogin(
  store: Store,
  options: {
    tenant?: string;
    status?: string;
    trusted?: boolean;
    query?: boolean;
    statusCheckedAt?: string;
  } = {},
) {
  const signing = await importPkcs12(
    readFileSync(new URL("../fixtures/signing/current.p12", import.meta.url)),
    "ferry-fixture",
    {
      trustedRoots: [
        readFileSync(
          new URL("../fixtures/signing/root.pem", import.meta.url),
          "utf8",
        ),
      ],
      certificateStatus: async () => "unrevoked",
    },
  );
  signing.trusted = options.trusted ?? signing.trusted;
  signing.statusCheckedAt = options.statusCheckedAt ?? signing.statusCheckedAt;
  return saveVerifiedConnection(store, options.tenant ?? "a", {
    kind: "lotw",
    remoteIdentity:
      options.query === false ? "station:W1AW:291" : "query:saved-login-user",
    label: "Synthetic LoTW",
    status: options.status ?? "active",
    credential: {
      signingCredentials: [signing],
      ...(options.query === false
        ? {}
        : {
            query: {
              username: "saved-login-user",
              password: " saved-login-secret ",
            },
          }),
    },
    config: {
      readAccess: options.query !== false,
      certificates: [
        {
          callsign: signing.callsign,
          dxcc: signing.dxcc,
          trusted: signing.trusted,
          status: signing.status,
          statusCheckedAt: signing.statusCheckedAt,
          validFrom: signing.validFrom,
          validTo: signing.validTo,
        },
      ],
    },
  });
}

test("verified connection renewals retain logical destination and ledger, credentials stay encrypted and tenant scoped", async (t) => {
  const { store, db, mf } = await setup();
  t.after(() => mf.dispose());
  const input = {
    kind: "qrz" as const,
    remoteIdentity: "book-123",
    label: "My book",
    credential: { apiKey: "secret-never-plaintext" },
    config: { stationCallsign: "W1AW" },
  };
  const first = await saveVerifiedConnection(store, "a", input, identity);
  const secondTenant = await saveVerifiedConnection(store, "b", input);
  await store.observe(
    { tenant: "a", source: "source", qso: "qso-1", destination: first.id },
    "generation",
    "baseline",
    30,
  );
  const renewed = await saveVerifiedConnection(
    store,
    "a",
    { ...input, credential: { apiKey: "renewed-secret" } },
    identity,
  );
  assert.equal(renewed.id, first.id);
  assert.notEqual(renewed.version, first.version);
  assert.notEqual(secondTenant.id, first.id);
  assert.equal(
    (
      await store.ledger({
        tenant: "a",
        source: "source",
        qso: "qso-1",
        destination: first.id,
      })
    )?.source_hash,
    "baseline",
  );
  assert.deepEqual(
    await store.private("a", first.id, first.version, "credential"),
    { apiKey: "secret-never-plaintext" },
  );
  assert.equal(
    await store.private("b", first.id, renewed.version, "credential"),
    null,
  );
  assert.deepEqual(
    await store.private("a", first.id, renewed.version, "credential"),
    { apiKey: "renewed-secret" },
  );
  const dump = JSON.stringify(
    (await db.prepare("SELECT * FROM private_data").all()).results,
  );
  assert.ok(
    !dump.includes("secret-never-plaintext") &&
      !dump.includes("renewed-secret"),
  );
});
test("credential renewal atomically retires only unsent artifacts using superseded credentials", async (t) => {
  const { store, mf } = await setup();
  t.after(() => mf.dispose());
  const cases = [
    { tenant: "a", id: "old-prepared", state: "prepared", version: "v1" },
    { tenant: "a", id: "old-dispatching", state: "dispatching", version: "v1" },
    { tenant: "a", id: "old-submitted", state: "submitted", version: "v1" },
    { tenant: "a", id: "old-uncertain", state: "uncertain", version: "v1" },
    { tenant: "a", id: "current-prepared", state: "prepared", version: "v2" },
    { tenant: "b", id: "other-tenant", state: "prepared", version: "v1" },
  ];
  for (const entry of cases) {
    await store.observe(
      {
        tenant: entry.tenant,
        source: "source",
        qso: entry.id,
        destination: "destination",
      },
      "g1",
      "h1",
      30,
    );
    await store
      .statement(
        "INSERT INTO attempts(tenant,id,source,qso,destination,generation,payload_id,payload_hash,credential_version,created_at,source_hash) VALUES(?,?,'source',?,'destination','g1',?,'h1',?,0,'h1')",
        entry.tenant,
        entry.id,
        entry.id,
        entry.id,
        entry.version,
      )
      .run();
    await store
      .statement(
        "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES(?,?,?,0,0)",
        entry.tenant,
        entry.id,
        entry.state,
      )
      .run();
    await (
      await store.putPrivate(entry.tenant, "destination", entry.id, "outbox", {
        artifact: entry.id,
      })
    ).run();
  }
  const renewal = {
    kind: "qrz" as const,
    remoteIdentity: "destination",
    label: "Renewed QRZ",
    credential: { apiKey: "renewed-synthetic" },
    credentialVersion: "v2",
    config: {},
  };
  await saveVerifiedConnection(store, "a", renewal, identity);
  for (const entry of cases) {
    const state = await store
      .statement(
        "SELECT state,reason FROM attempt_state WHERE tenant=? AND attempt=?",
        entry.tenant,
        entry.id,
      )
      .first<{ state: string; reason: string | null }>();
    if (entry.id === "old-prepared") {
      assert.equal(state?.state, "cancelled");
      assert.equal(state?.reason, "credential changed before dispatch");
      assert.equal(
        await store.private(entry.tenant, "destination", entry.id, "outbox"),
        null,
      );
    } else {
      assert.equal(state?.state, entry.state);
      assert.deepEqual(
        await store.private(entry.tenant, "destination", entry.id, "outbox"),
        { artifact: entry.id },
      );
    }
  }
  const events = (
    await store
      .statement("SELECT tenant,attempt,state,reason FROM attempt_events")
      .all()
  ).results;
  assert.deepEqual(events, [
    {
      tenant: "a",
      attempt: "old-prepared",
      state: "cancelled",
      reason: "credential changed before dispatch",
    },
  ]);
  assert.equal(
    (await store.connection("a", "destination"))?.credential_version,
    "v2",
  );
  assert(await store.private("a", "destination", "v1", "credential"));
});

test("connection routes enforce passkey freshness, CSRF, tenant ownership and redacted listing", async (t) => {
  const { env, store, mf } = await setup();
  t.after(() => mf.dispose());
  const anonymous = await connectionRoute(
    new Request("http://localhost/api/connections"),
    env,
    null,
  );
  assert.equal(anonymous?.status, 401);
  assert.equal(
    ((await anonymous!.json()) as { code: string }).code,
    "session_required",
  );
  const stale = await connectionRoute(await request("/qrz", {}, env), env, {
    ...identity,
    verifiedAt: 0,
  });
  assert.equal(stale?.status, 403);
  assert.equal(
    ((await stale!.json()) as { code: string }).code,
    "reauth_required",
  );
  const noCsrf = await connectionRoute(
    new Request("http://localhost:8787/api/connections/disable", {
      method: "POST",
      headers: { Origin: env.ORIGIN, "Content-Type": "application/json" },
      body: "{}",
    }),
    env,
    identity,
  );
  assert.equal(noCsrf?.status, 403);
  assert.equal(
    ((await noCsrf!.json()) as { code: string }).code,
    "csrf_invalid",
  );
  const listed = await connectionRoute(
    new Request("http://localhost/api/connections"),
    env,
    identity,
  );
  const body = await listed!.text();
  assert.ok(
    !body.includes("private") &&
      !body.includes("envelope") &&
      !body.includes("credential_version"),
  );
  const other = await saveVerifiedConnection(store, "b", {
    kind: "qrz",
    remoteIdentity: "other-book",
    label: "Other tenant book",
    credential: { apiKey: "other-secret" },
    config: {},
  });
  const crossed = await connectionRoute(
    await request("/revoke", { id: other.id }, env),
    env,
    identity,
  );
  assert.equal(crossed?.status, 404);
  assert.equal((await store.connection("b", other.id))?.status, "active");
});

test("LoFi approval distinguishes preflight authentication from vendor403 and post-request guard failures", async (t) => {
  const { env, store, mf } = await setup();
  t.after(() => mf.dispose());
  await vacate(store, "lofi");
  let outbound = 0;
  const preflightFetcher: typeof fetch = async () => {
    outbound++;
    throw new Error("A preflight failure must never contact LoFi");
  };
  for (const [failure, code] of [
    ["stale", "reauth_required"],
    ["csrf", "csrf_invalid"],
    ["origin", "origin_invalid"],
    ["cross-site", "origin_invalid"],
    ["stale-csrf", "csrf_invalid"],
    ["stale-origin", "origin_invalid"],
  ] as const) {
    const input = await request(
      "/lofi/start",
      { email: "fixture@example.test" },
      env,
    );
    if (failure.endsWith("csrf")) input.headers.delete("X-CSRF-Token");
    if (failure.endsWith("origin"))
      input.headers.set("Origin", "https://other.example.test");
    if (failure === "cross-site")
      input.headers.set("Sec-Fetch-Site", "cross-site");
    const response = await connectionRoute(
      input,
      env,
      {
        ...identity,
        verifiedAt: failure.startsWith("stale")
          ? Date.now() - 300_001
          : Date.now(),
      },
      { fetcher: preflightFetcher },
    );
    assert.equal(response?.status, 403);
    const body = (await response!.json()) as { error: string; code: string };
    assert.equal(body.code, code);
    assert.equal(outbound, 0);
  }
  assert.equal(
    (
      await store
        .statement("SELECT count(*) n FROM rate_limits")
        .first<{ n: number }>()
    )?.n,
    0,
    "preflight failures have no request side effects",
  );
  for (const failure of ["register403", "permissions403", "guard"] as const) {
    await vacate(store, "lofi");
    await store
      .statement(
        "UPDATE sessions SET verified_at=? WHERE tenant='a'",
        Date.now(),
      )
      .run();
    let calls = 0;
    const response = await connectionRoute(
      await request("/lofi/start", { email: "fixture@example.test" }, env),
      env,
      { ...identity, verifiedAt: Date.now() },
      {
        fetcher: async (input) => {
          calls++;
          if (
            failure === "register403" ||
            String(input).endsWith("/permissions")
          )
            return new Response("private-provider-diagnostic-must-not-escape", {
              status: 403,
            });
          assert.ok(String(input).endsWith("/client"));
          if (failure === "guard")
            await store
              .statement("UPDATE sessions SET verified_at=0 WHERE tenant='a'")
              .run();
          return Response.json({ token: "private-fixture-token" });
        },
      },
    );
    assert.equal(response?.status, 400);
    const body = (await response!.json()) as { error: string; code: string };
    assert.equal(body.code, "connection_verification_failed", failure);
    assert.ok(!JSON.stringify(body).includes("private-"));
    assert.equal(calls, failure === "permissions403" ? 2 : 1);
  }
  assert.equal(
    (
      await store
        .statement(
          "SELECT count(*) n FROM connections WHERE remote_identity LIKE 'pending:%'",
        )
        .first<{ n: number }>()
    )?.n,
    1,
    "a vendor permission failure can follow a durable pending connection; it is not a preflight retry",
  );
});
test("connection verification exposes a safe retry delay and shares vendor cooldowns", async (t) => {
  const { env, store, mf } = await setup();
  t.after(() => mf.dispose());
  await vacate(store, "qrz");
  const book = {
    bookId: "123",
    stationCallsign: "W1AW",
    startDate: "2020-01-01",
    endDate: "2030-12-31",
  };
  let network = 0;
  const fetcher: typeof fetch = async () => {
    network++;
    return new Response("sensitive vendor details", {
      status: 429,
      headers: { "Retry-After": "600" },
    });
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await connectionRoute(
      await request("/qrz", { apiKey: "synthetic-secret", book }, env),
      env,
      identity,
      { fetcher },
    );
    assert.equal(response?.status, 503);
    assert(Number(response?.headers.get("Retry-After")) > 0);
    const body = await response!.text();
    assert.match(body, /vendor_deferred/);
    assert(!body.includes("sensitive") && !body.includes("synthetic-secret"));
  }
  assert.equal(network, 1);
});

test("QRZ linking uses STATUS proof, never INSERT, and preserves stable book on key renewal", async (t) => {
  const { env, store, mf } = await setup();
  t.after(() => mf.dispose());
  await vacate(store, "qrz");
  let reads = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    const body = init?.body as URLSearchParams;
    assert.equal(body.get("ACTION"), "STATUS");
    reads++;
    return new Response(
      new URLSearchParams({
        RESULT: "OK",
        BOOKID: "123",
        CALLSIGN: "W1AW",
        STARTDATE: "2020-01-01",
        ENDDATE: "2030-12-31",
      }),
    );
  };
  const book = {
    bookId: "123",
    stationCallsign: "W1AW",
    startDate: "2020-01-01",
    endDate: "2030-12-31",
  };
  const first = await connectionRoute(
    await request("/qrz", { apiKey: "first-key", book }, env),
    env,
    identity,
    { fetcher },
  );
  assert.equal(first?.status, 201, await first?.clone().text());
  const firstBody = (await first!.json()) as { id: string };
  const next = await connectionRoute(
    await request("/qrz", { apiKey: "renewed-key", book }, env),
    env,
    identity,
    { fetcher },
  );
  assert.equal(((await next!.json()) as { id: string }).id, firstBody.id);
  assert.equal(reads, 2);
  assert.equal(
    (await store.connections("a")).filter(
      (row) => row.remote_identity === "123",
    ).length,
    1,
  );
  assert.equal(
    (
      await store
        .statement("SELECT count(*) n FROM attempts")
        .first<{ n: number }>()
    )?.n,
    0,
  );
});
test("expired or revoked authenticated sessions cannot commit vendor-verified credentials", async (t) => {
  const { env, store, mf } = await setup();
  t.after(() => mf.dispose());
  await vacate(store, "qrz");
  await store
    .statement(
      "UPDATE sessions SET revoked_at=? WHERE token_hash='session-a'",
      Date.now(),
    )
    .run();
  const response = await connectionRoute(
    await request(
      "/qrz",
      {
        apiKey: "secret",
        book: {
          bookId: "123",
          stationCallsign: "W1AW",
          startDate: "2020-01-01",
          endDate: "2030-12-31",
        },
      },
      env,
    ),
    env,
    identity,
    {
      fetcher: async () =>
        new Response(
          "RESULT=OK&BOOKID=123&CALLSIGN=W1AW&STARTDATE=2020-01-01&ENDDATE=2030-12-31",
        ),
    },
  );
  assert.equal(response?.status, 400);
  assert.equal(
    (await store.connections("a")).filter(
      (row) => row.remote_identity === "123",
    ).length,
    0,
  );
});
test("revocation removes credential ciphertext and cancels new work without vendor deletes", async (t) => {
  const { env, store, mf } = await setup();
  t.after(() => mf.dispose());
  const response = await connectionRoute(
    await request("/revoke", { id: "destination" }, env),
    env,
    identity,
    {
      fetcher: async () => {
        throw new Error("No vendor request expected");
      },
    },
  );
  assert.equal(response?.status, 200);
  assert.equal((await store.connection("a", "destination"))?.status, "revoked");
  assert.equal(
    await store.private("a", "destination", "v1", "credential"),
    null,
  );
  assert.deepEqual(
    await store.private("b", "destination", "v1", "credential"),
    { secret: "private" },
  );
});

test("LoFi approval binds only the vendor current account and saves no contact writes", async (t) => {
  const { env, store, mf } = await setup();
  t.after(() => mf.dispose());
  await vacate(store, "lofi");
  const seen: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    seen.push(path);
    if (path === "/v1/client")
      return Response.json({ token: "synthetic-lofi-token" });
    if (path === "/v1/client/permissions") {
      assert.equal(JSON.parse(String(init?.body)).send_email, true);
      return Response.json({ success: true });
    }
    if (path === "/v1/accounts")
      return Response.json({
        current_account: {
          uuid: "verified-lofi-account",
          name: "Synthetic station",
        },
      });
    throw new Error("Unexpected vendor path");
  };
  const started = await connectionRoute(
    await request("/lofi/start", { email: "a@example.test" }, env),
    env,
    identity,
    { fetcher },
  );
  assert.equal(started?.status, 201, await started?.clone().text());
  const pending = (await started!.json()) as { id: string };
  assert.equal(
    (await store.connection("a", pending.id))?.status,
    "approval_pending",
  );
  const finished = await connectionRoute(
    await request(
      "/lofi/finish",
      { id: pending.id, accountId: "untrusted-other-account" },
      env,
    ),
    env,
    identity,
    { fetcher },
  );
  assert.equal(finished?.status, 200, await finished?.clone().text());
  const result = (await finished!.json()) as { id: string; accountId: string };
  assert.equal(result.accountId, "verified-lofi-account");
  assert.equal(
    (await store.connection("a", result.id))?.remote_identity,
    "verified-lofi-account",
  );
  assert.equal(await store.connection("a", pending.id), null);
  assert.deepEqual(seen, [
    "/v1/client",
    "/v1/client/permissions",
    "/v1/accounts",
  ]);
  assert.equal(
    (
      await store
        .statement("SELECT count(*) n FROM attempts")
        .first<{ n: number }>()
    )?.n,
    0,
  );
});
test("LoTW account verification permits multiple isolated station certificates and renewal retains destination", async (t) => {
  const { env, store, mf } = await setup();
  t.after(() => mf.dispose());
  env.LOTW_TRUST_ROOTS_JSON = JSON.stringify([
    readFileSync(
      new URL("../fixtures/signing/root.pem", import.meta.url),
      "utf8",
    ),
  ]);
  const fetcher: typeof fetch = async (input, init) => {
    assert.notEqual(init?.method, "POST", "no upload during connection import");
    const url = new URL(String(input));
    if (url.pathname === "/lotw/crl")
      return new Response("<Status>Unrevoked</Status>");
    if (url.pathname === "/lotwuser/lotwreport.adi")
      return new Response(
        "<PROGRAMID:4>LoTW<APP_LoTW_NUMREC:1>0<EOH><APP_LoTW_EOF>",
      );
    throw new Error("No other LoTW endpoint expected");
  };
  const imported: string[] = [];
  for (const fixture of ["current.p12", "second.p12", "current.p12"]) {
    const p12 = readFileSync(
      new URL(`../fixtures/signing/${fixture}`, import.meta.url),
    ).toString("base64");
    const response = await connectionRoute(
      await request(
        "/lotw",
        {
          p12,
          password: "ferry-fixture",
          query: {
            username: "synthetic-account",
            password: " synthetic-password ",
          },
        },
        env,
      ),
      env,
      identity,
      { fetcher },
    );
    assert.equal(response?.status, 201, await response?.clone().text());
    const body = (await response!.json()) as { id: string; status: string };
    assert.equal(body.status, "active");
    imported.push(body.id);
  }
  assert.equal(new Set(imported).size, 1);
  const connection = await store.connection("a", imported[0]!);
  assert.equal(connection?.remote_identity, "query:synthetic-account");
  const loginVerification = JSON.parse(connection!.config).loginVerification;
  assert.equal(loginVerification.status, "verified");
  assert(Number.isFinite(Date.parse(loginVerification.checkedAt)));
  const secret = await store.private<{
    signingCredentials: { callsign: string }[];
    query: { password: string };
  }>("a", connection!.id, connection!.credential_version!, "credential");
  assert.deepEqual(
    secret?.signingCredentials.map((item) => item.callsign).sort(),
    ["W1AW", "W2AW"],
  );
  assert.equal(
    secret?.query.password,
    " synthetic-password ",
    "password whitespace preserved",
  );
  const listed = await connectionRoute(
    new Request("http://localhost/api/connections"),
    env,
    identity,
  );
  const output = await listed!.text();
  assert.equal(
    JSON.parse(output).connections.find(
      (row: { id: string }) => row.id === imported[0],
    ).config.queryUsername,
    "synthetic-account",
    "credential updates prefill the verified readback username without exposing its password",
  );
  assert.ok(
    !output.includes("PRIVATE KEY") &&
      !output.includes("synthetic-password") &&
      !output.includes("ferry-fixture"),
  );
  assert.equal(
    (
      await store
        .statement("SELECT count(*) n FROM attempts")
        .first<{ n: number }>()
    )?.n,
    0,
  );
});
test("LoTW verification identifies certificate and login failures without leaking or saving credentials", async (t) => {
  const p12 = readFileSync(
    new URL("../fixtures/signing/current.p12", import.meta.url),
  ).toString("base64");
  for (const failure of ["password", "corrupt", "html", "http", "transport"]) {
    await t.test(failure, async (t) => {
      const { env, store, mf } = await setup();
      t.after(() => mf.dispose());
      const privateRowsBefore = await store
        .statement("SELECT count(*) n FROM private_data")
        .first<{ n: number }>();
      const certificateFailure =
        failure === "password" || failure === "corrupt";
      const input = {
        p12:
          failure === "corrupt"
            ? Buffer.from("corrupt certificate container").toString("base64")
            : p12,
        password:
          failure === "password" ? "wrong-import-secret" : "ferry-fixture",
        query: { username: "synthetic-account", password: "login-secret" },
      };
      const seen: string[] = [];
      const fetcher: typeof fetch = async (input) => {
        const url = new URL(String(input));
        seen.push(url.pathname);
        if (url.pathname === "/lotw/crl")
          return new Response("<Status>Unrevoked</Status>");
        assert.equal(url.pathname, "/lotwuser/lotwreport.adi");
        if (failure === "transport")
          throw new Error(`sensitive transport details: ${url}`);
        return new Response(
          "<html>sensitive vendor details: synthetic-account login-secret</html>",
          { status: failure === "http" ? 401 : 200 },
        );
      };
      const response = await connectionRoute(
        await request("/lotw", input, env),
        env,
        identity,
        { fetcher },
      );
      assert.equal(
        response?.status,
        certificateFailure || failure === "http" ? 400 : 503,
      );
      const output = await response!.text();
      const body = JSON.parse(output);
      assert.equal(
        body.code,
        certificateFailure
          ? "lotw_certificate_import_failed"
          : failure === "http"
            ? "lotw_login_rejected"
            : "lotw_login_unavailable",
      );
      assert.match(
        body.error,
        certificateFailure ? /^Certificate import failed\./ : /LoTW/i,
      );
      if (certificateFailure) assert.match(body.error, /password/i);
      for (const secret of [
        input.p12,
        input.password,
        "synthetic-account",
        "login-secret",
        "sensitive",
        "lotwreport.adi",
      ])
        assert(!output.includes(secret));
      assert.deepEqual(
        seen,
        certificateFailure ? [] : ["/lotw/crl", "/lotwuser/lotwreport.adi"],
      );
      assert.deepEqual(
        await store
          .statement("SELECT count(*) n FROM private_data")
          .first<{ n: number }>(),
        privateRowsBefore,
      );
      assert.equal(
        (
          await store
            .statement("SELECT count(*) n FROM connections WHERE kind='lotw'")
            .first<{ n: number }>()
        )?.n,
        0,
      );
    });
  }
});
test("LoTW verification preserves vendor deferrals during certificate status and login checks", async (t) => {
  const p12 = readFileSync(
    new URL("../fixtures/signing/current.p12", import.meta.url),
  ).toString("base64");
  for (const deferredPath of ["/lotw/crl", "/lotwuser/lotwreport.adi"]) {
    await t.test(deferredPath, async (t) => {
      const { env, mf } = await setup();
      t.after(() => mf.dispose());
      let network = 0;
      const fetcher: typeof fetch = async (input) => {
        network++;
        const url = new URL(String(input));
        if (url.pathname === deferredPath)
          return new Response("sensitive vendor details", {
            status: 429,
            headers: { "Retry-After": "600" },
          });
        assert.equal(url.pathname, "/lotw/crl");
        return new Response("<Status>Unrevoked</Status>");
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await connectionRoute(
          await request(
            "/lotw",
            {
              p12,
              password: "ferry-fixture",
              query: {
                username: "synthetic-account",
                password: "login-secret",
              },
            },
            env,
          ),
          env,
          identity,
          { fetcher },
        );
        assert.equal(response?.status, 503);
        assert(Number(response?.headers.get("Retry-After")) > 0);
        const output = await response!.text();
        assert.equal(JSON.parse(output).code, "vendor_deferred");
        assert(
          !output.includes("sensitive") && !output.includes("login-secret"),
        );
      }
      assert.equal(network, deferredPath === "/lotw/crl" ? 1 : 2);
    });
  }
});
test("unsaved LoTW login checks distinguish rejection from outages without saving credentials", async (t) => {
  for (const [failure, expected] of [
    ["none", "verified"],
    ["login-html", "rejected"],
    ["401", "rejected"],
    ["503", "unavailable"],
    ["unexpected-html", "unavailable"],
    ["transport", "unavailable"],
  ] as const) {
    await t.test(failure, async (t) => {
      const { env, store, mf } = await setup();
      t.after(() => mf.dispose());
      const connectionsBefore = await store.connections("a");
      const privateRowsBefore = await store
        .statement("SELECT count(*) n FROM private_data")
        .first();
      let network = 0;
      const startedAt = Date.now();
      const response = await connectionRoute(
        await request(
          "/lotw/check-login",
          {
            username: "unsaved-login-user",
            password: " unsaved-login-secret ",
          },
          env,
        ),
        env,
        identity,
        {
          fetcher: async (input, init) => {
            network++;
            const url = new URL(String(input));
            assert.equal(url.pathname, "/lotwuser/lotwreport.adi");
            assert.equal(url.searchParams.get("login"), "unsaved-login-user");
            assert.equal(
              url.searchParams.get("password"),
              " unsaved-login-secret ",
            );
            assert.notEqual(init?.method, "POST");
            if (failure === "transport")
              throw new Error(`sensitive transport details: ${url}`);
            return new Response(
              failure === "none"
                ? emptyLotwReport
                : failure === "login-html"
                  ? "<html>Login failed</html>"
                  : "<html>sensitive vendor details</html>",
              {
                status: failure === "401" ? 401 : failure === "503" ? 503 : 200,
              },
            );
          },
        },
      );
      assert.equal(response?.status, 200);
      const output = await response!.text();
      const body = JSON.parse(output);
      assert.equal(body.loginVerification.status, expected);
      assert.deepEqual(Object.keys(body.loginVerification).sort(), [
        "checkedAt",
        "status",
      ]);
      assert(Date.parse(body.loginVerification.checkedAt) >= startedAt);
      assert(Date.parse(body.loginVerification.checkedAt) <= Date.now());
      assert.equal(typeof body.message, "string");
      for (const secret of [
        "unsaved-login-user",
        "unsaved-login-secret",
        "sensitive",
        "PROGRAMID",
        "lotwreport.adi",
      ])
        assert(!output.includes(secret));
      assert.equal(network, 1);
      assert.deepEqual(await store.connections("a"), connectionsBefore);
      assert.deepEqual(
        await store.statement("SELECT count(*) n FROM private_data").first(),
        privateRowsBefore,
      );
    });
  }
});
test("saved LoTW login checks persist only safe verdicts and preserve certificate and pause gates", async (t) => {
  for (const [status, trusted, verdict, expectedStatus, staleStatus] of [
    ["active", true, "verified", "active", false],
    ["active", true, "verified", "active", true],
    ["active", true, "rejected", "needs_verification", false],
    ["active", true, "unavailable", "active", false],
    ["needs_verification", false, "verified", "needs_verification", false],
    ["disabled", true, "verified", "disabled", false],
    ["disabled", true, "rejected", "disabled", false],
  ] as const) {
    await t.test(
      `${status}/${trusted}/${verdict}/${staleStatus}`,
      async (t) => {
        const { env, store, mf } = await setup();
        t.after(() => mf.dispose());
        env.LOTW_TRUST_ROOTS_JSON = JSON.stringify([
          readFileSync(
            new URL("../fixtures/signing/root.pem", import.meta.url),
            "utf8",
          ),
        ]);
        const statusCheckedAt = staleStatus
          ? new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
          : undefined;
        const saved = await savedLotwLogin(store, {
          status,
          trusted,
          statusCheckedAt,
        });
        const credentialBefore = await store.private(
          "a",
          saved.id,
          saved.version,
          "credential",
        );
        let network = 0;
        const response = await connectionRoute(
          await request("/lotw/check-login", { id: saved.id }, env),
          env,
          identity,
          {
            fetcher: async (input) => {
              network++;
              const url = new URL(String(input));
              assert.equal(url.pathname, "/lotwuser/lotwreport.adi");
              assert.equal(url.searchParams.get("login"), "saved-login-user");
              assert.equal(
                url.searchParams.get("password"),
                " saved-login-secret ",
              );
              return new Response(
                verdict === "verified"
                  ? emptyLotwReport
                  : "sensitive vendor details",
                {
                  status:
                    verdict === "rejected"
                      ? 403
                      : verdict === "unavailable"
                        ? 503
                        : 200,
                },
              );
            },
          },
        );
        assert.equal(response?.status, 200);
        const body = (await response!.json()) as {
          loginVerification: { status: string; checkedAt: string };
        };
        assert.equal(body.loginVerification.status, verdict);
        const connection = await store.connection("a", saved.id);
        assert.equal(connection?.status, expectedStatus);
        assert.equal(connection?.credential_version, saved.version);
        assert.deepEqual(
          JSON.parse(connection!.config).loginVerification,
          body.loginVerification,
        );
        assert.equal(JSON.parse(connection!.config).readAccess, true);
        assert.deepEqual(
          await store.private("a", saved.id, saved.version, "credential"),
          credentialBefore,
        );
        const listed = await connectionRoute(
          new Request("http://localhost/api/connections"),
          env,
          identity,
        );
        const output = await listed!.text();
        const publicConnection = JSON.parse(output).connections.find(
          (row: { id: string }) => row.id === saved.id,
        );
        assert.equal(publicConnection.config.loginVerification.status, verdict);
        if (staleStatus) {
          assert.equal(
            publicConnection.config.certificates[0].statusCheckedAt,
            statusCheckedAt,
          );
          const diagnostic = publicConnection.lotwVerification.find(
            (check: { id: string }) => check.id === "certificate_status",
          );
          assert.equal(diagnostic.status, "warning");
          assert.equal(diagnostic.checkedAt, statusCheckedAt);
          assert.match(diagnostic.message, /24 hours old/);
        }
        for (const secret of [
          "saved-login-secret",
          "PRIVATE KEY",
          "sensitive",
          "PROGRAMID",
        ])
          assert(!output.includes(secret));
        assert.equal(network, 1);
      },
    );
  }
});
test("LoTW login checks reject missing credentials, foreign connections and stale authentication before vendor requests", async (t) => {
  const { env, store, mf } = await setup();
  t.after(() => mf.dispose());
  const foreign = await savedLotwLogin(store, { tenant: "b" });
  const stationOnly = await savedLotwLogin(store, { query: false });
  const removed = await savedLotwLogin(store);
  await store
    .statement(
      "UPDATE connections SET status='revoked',credential_version=NULL WHERE tenant='a' AND id=?",
      removed.id,
    )
    .run();
  let network = 0;
  const services = {
    fetcher: async () => {
      network++;
      return new Response(emptyLotwReport);
    },
  };
  for (const [id, statuses, code] of [
    [foreign.id, [404], undefined],
    ["destination", [404, 409], undefined],
    [removed.id, [404, 409], undefined],
    [stationOnly.id, [400], "lotw_login_not_configured"],
  ] as const) {
    const response = await connectionRoute(
      await request("/lotw/check-login", { id }, env),
      env,
      identity,
      services,
    );
    assert((statuses as readonly number[]).includes(response!.status));
    if (code)
      assert.equal(((await response!.json()) as { code: string }).code, code);
  }
  for (const failure of ["stale", "csrf"] as const) {
    const input = await request(
      "/lotw/check-login",
      { username: "unsaved-login-user", password: "login-secret" },
      env,
    );
    if (failure === "csrf") input.headers.delete("X-CSRF-Token");
    const response = await connectionRoute(
      input,
      env,
      failure === "stale" ? { ...identity, verifiedAt: 0 } : identity,
      services,
    );
    assert.equal(response?.status, 403);
    assert.equal(
      ((await response!.json()) as { code: string }).code,
      failure === "stale" ? "reauth_required" : "csrf_invalid",
    );
  }
  assert.equal(network, 0);
  assert.equal((await store.connection("b", foreign.id))?.status, "active");
});
test("LoTW login checks retain retry delays and never replay a deferred vendor request", async (t) => {
  const { env, store, mf } = await setup();
  t.after(() => mf.dispose());
  const saved = await savedLotwLogin(store);
  const before = await store.connection("a", saved.id);
  let network = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await connectionRoute(
      await request("/lotw/check-login", { id: saved.id }, env),
      env,
      identity,
      {
        fetcher: async () => {
          network++;
          return new Response("sensitive vendor details", {
            status: 429,
            headers: { "Retry-After": "600" },
          });
        },
      },
    );
    assert.equal(response?.status, 503);
    assert(Number(response?.headers.get("Retry-After")) > 0);
    assert.equal(
      ((await response!.json()) as { code: string }).code,
      "vendor_deferred",
    );
  }
  assert.equal(network, 1);
  assert.deepEqual(await store.connection("a", saved.id), before);
});
test("saved LoTW login results are fenced against credential replacement and expired session proof", async (t) => {
  for (const race of ["credentials", "session"] as const) {
    await t.test(race, async (t) => {
      const { env, store, mf } = await setup();
      t.after(() => mf.dispose());
      const saved = await savedLotwLogin(store);
      const before = await store.connection("a", saved.id);
      let network = 0;
      const response = await connectionRoute(
        await request("/lotw/check-login", { id: saved.id }, env),
        env,
        identity,
        {
          fetcher: async () => {
            network++;
            if (race === "credentials")
              await store
                .statement(
                  "UPDATE connections SET credential_version='replacement-version' WHERE tenant='a' AND id=?",
                  saved.id,
                )
                .run();
            else
              await store
                .statement("UPDATE sessions SET verified_at=0 WHERE tenant='a'")
                .run();
            return new Response(emptyLotwReport);
          },
        },
      );
      assert(response!.status >= 400);
      const after = await store.connection("a", saved.id);
      assert.equal(after?.config, before?.config);
      assert.equal(after?.status, before?.status);
      assert.equal(
        after?.credential_version,
        race === "credentials" ? "replacement-version" : saved.version,
      );
      assert.equal(network, 1);
    });
  }
});
test("untrusted LoTW certificate can be encrypted for later verification but cannot become active", async (t) => {
  const { env, store, mf } = await setup();
  t.after(() => mf.dispose());
  const p12 = readFileSync(
    new URL("../fixtures/signing/current.p12", import.meta.url),
  ).toString("base64");
  const response = await connectionRoute(
    await request("/lotw", { p12, password: "ferry-fixture" }, env),
    env,
    identity,
    { fetcher: async () => new Response("<Status>Unrevoked</Status>") },
  );
  assert.equal(response?.status, 201, await response?.clone().text());
  const result = (await response!.json()) as { id: string; status: string };
  assert.equal(result.status, "needs_verification");
  assert.equal(
    (await store.connection("a", result.id))?.remote_identity,
    "station:W1AW:291",
  );
  assert.equal(
    (
      await store
        .statement("SELECT count(*) n FROM attempts")
        .first<{ n: number }>()
    )?.n,
    0,
  );
});

test("new QRZ connection atomically gets the refs-and-notes default and renewal preserves an edited active version", async (t) => {
  const { store, mf } = await setup();
  t.after(() => mf.dispose());
  const input = {
    kind: "qrz" as const,
    remoteIdentity: "default-template-book",
    label: "Default profile book",
    credential: { apiKey: "fixture-key" },
    config: {},
  };
  const first = await saveVerifiedConnection(store, "a", input, identity);
  const initial = await store
    .statement(
      "SELECT a.version,t.config FROM active_templates a JOIN templates t ON t.tenant=a.tenant AND t.destination=a.destination AND t.id=a.version WHERE a.tenant=? AND a.destination=?",
      "a",
      first.id,
    )
    .first<{ version: string; config: string }>();
  assert.ok(initial);
  const profile = JSON.parse(initial.config);
  assert.equal(profile.fields.COMMENT, DEFAULT_COMMENT_TEMPLATE);
  assert.equal(profile.fallbackNotes, false);
  const custom = await store.saveTemplate("a", first.id, {
    id: "custom",
    profile: profile.profile,
    fields: { NOTES: "My future contacts" },
    fallbackNotes: false,
  });
  await saveVerifiedConnection(
    store,
    "a",
    { ...input, credential: { apiKey: "renewed" } },
    identity,
  );
  assert.equal(
    (
      await store
        .statement(
          "SELECT version FROM active_templates WHERE tenant=? AND destination=?",
          "a",
          first.id,
        )
        .first<{ version: string }>()
    )?.version,
    custom,
  );
  assert.equal(
    (
      await store
        .statement(
          "SELECT count(*) n FROM templates WHERE tenant=? AND destination=?",
          "a",
          first.id,
        )
        .first<{ n: number }>()
    )?.n,
    2,
  );
  assert.equal(
    (
      await store
        .statement("SELECT count(*) n FROM attempts")
        .first<{ n: number }>()
    )?.n,
    0,
  );
});

test("new logical destinations request atomic source rescans; renewal and template edits never rescan history", async (t) => {
  const { store, mf } = await setup();
  t.after(() => mf.dispose());
  await store
    .statement(
      "UPDATE connections SET config='{\"accountId\":\"verified-account\"}' WHERE tenant='a' AND id='source'",
    )
    .run();
  const input = {
    kind: "qrz" as const,
    remoteIdentity: "new-history-book",
    label: "Later destination",
    credential: { apiKey: "fixture" },
    config: {},
  };
  const saved = await saveVerifiedConnection(store, "a", input, identity);
  const cursor = await store
    .statement(
      "SELECT cursor,generation FROM cursors WHERE tenant=? AND connection=? AND stream=?",
      "a",
      "source",
      `rescan:${saved.id}`,
    )
    .first<{ cursor: string; generation: number }>();
  assert.ok(cursor);
  assert.deepEqual(JSON.parse(cursor.cursor), {
    mode: "backfill",
    operations: {},
    qsos: {},
    accountId: "verified-account",
    requested: true,
  });
  assert.equal(cursor.generation, 0);
  assert.equal(
    await store
      .statement(
        "SELECT cursor FROM cursors WHERE tenant=? AND stream=?",
        "b",
        `rescan:${saved.id}`,
      )
      .first(),
    null,
  );
  await store
    .statement(
      "UPDATE cursors SET cursor=?,generation=9 WHERE tenant=? AND stream=?",
      '{"rescanComplete":true}',
      "a",
      `rescan:${saved.id}`,
    )
    .run();
  await saveVerifiedConnection(
    store,
    "a",
    { ...input, credential: { apiKey: "renewal" } },
    identity,
  );
  await store.saveTemplate("a", saved.id, {
    id: "future",
    profile: "ferry-liquid-v1",
    fields: { NOTES: "New future text" },
    fallbackNotes: false,
  });
  const retained = await store
    .statement(
      "SELECT cursor,generation FROM cursors WHERE tenant=? AND stream=?",
      "a",
      `rescan:${saved.id}`,
    )
    .first<{ cursor: string; generation: number }>();
  assert.equal(retained?.generation, 9);
  assert.equal(retained?.cursor, '{"rescanComplete":true}');
  assert.equal(
    await store
      .statement(
        "SELECT cursor FROM cursors WHERE tenant='a' AND stream='sync'",
      )
      .first(),
    null,
    "forward source cursor is untouched",
  );
});

test("already connected services reject another account before outbound requests and paused credentials resume without relinking", async (t) => {
  const { env, store, mf } = await setup();
  t.after(() => mf.dispose());
  let outbound = 0;
  const services = {
    fetcher: (async () => {
      outbound++;
      throw new Error("No outbound request expected");
    }) as typeof fetch,
  };
  for (const [path, input] of [
    ["/lofi/start", { email: "fixture@example.test" }],
    [
      "/qrz",
      {
        apiKey: "fixture",
        book: {
          bookId: "different",
          stationCallsign: "W1AW",
          startDate: "2020-01-01",
          endDate: "2030-12-31",
        },
      },
    ],
  ] as const) {
    const response = await connectionRoute(
      await request(path, input, env),
      env,
      identity,
      services,
    );
    assert.equal(response?.status, 409);
  }
  assert.equal(outbound, 0);
  await store
    .statement(
      "UPDATE connections SET config='{\"accountId\":\"fixture\"}' WHERE tenant='a' AND id='source'",
    )
    .run();
  assert.equal(
    (
      await connectionRoute(
        await request("/disable", { id: "source" }, env),
        env,
        identity,
      )
    )?.status,
    200,
  );
  assert.equal(
    (
      await connectionRoute(
        await request("/lofi/start", { email: "fixture@example.test" }, env),
        env,
        identity,
        services,
      )
    )?.status,
    409,
  );
  const resumed = await connectionRoute(
    await request("/enable", { id: "source" }, env),
    env,
    identity,
    services,
  );
  assert.equal(resumed?.status, 200);
  assert.equal((await store.connection("a", "source"))?.status, "active");
  assert.equal((await store.connection("b", "source"))?.status, "active");
  assert.equal(outbound, 0);
  await connectionRoute(
    await request("/revoke", { id: "source" }, env),
    env,
    identity,
  );
  assert.equal(
    (
      await connectionRoute(
        await request("/enable", { id: "source" }, env),
        env,
        identity,
      )
    )?.status,
    409,
  );
  assert.equal(
    (await store.connection("a", "source"))?.credential_version,
    null,
  );
});

test("connection slot races commit at most one account and pending LoFi replacement is atomic", async (t) => {
  const { store, mf } = await setup();
  t.after(() => mf.dispose());
  await vacate(store, "lofi");
  const saved = await Promise.allSettled(
    ["one", "two"].map((remoteIdentity) =>
      saveVerifiedConnection(
        store,
        "a",
        {
          kind: "lofi",
          remoteIdentity: `pending:${remoteIdentity}`,
          label: "Pending",
          status: "approval_pending",
          credential: { key: remoteIdentity },
          config: {},
        },
        identity,
        {},
      ),
    ),
  );
  assert.equal(
    saved.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const pending = (await store.connections("a")).find(
    (row) => row.status === "approval_pending",
  )!;
  assert.ok(pending);
  const finished = await saveVerifiedConnection(
    store,
    "a",
    {
      kind: "lofi",
      remoteIdentity: "verified-account",
      label: "Vendor account",
      credential: { key: "approved" },
      config: { accountId: "verified-account" },
    },
    identity,
    { replacing: pending.id },
  );
  assert.equal(await store.connection("a", pending.id), null);
  assert.equal(
    await store.private(
      "a",
      pending.id,
      pending.credential_version!,
      "credential",
    ),
    null,
  );
  assert.equal((await store.connection("a", finished.id))?.status, "active");
  await assert.rejects(
    saveVerifiedConnection(
      store,
      "a",
      {
        kind: "lofi",
        remoteIdentity: "different-account",
        label: "Stale finish",
        credential: {},
        config: {},
      },
      identity,
      { replacing: pending.id },
    ),
  );
  assert.equal(
    (await store.connections("a")).filter(
      (row) => row.kind === "lofi" && row.status !== "revoked",
    ).length,
    1,
  );
  assert.equal(
    (
      await store
        .statement("SELECT count(*) n FROM connection_kind_guards")
        .first<{ n: number }>()
    )?.n,
    0,
  );
});

test("resuming LoTW never promotes an untrusted certificate or crosses tenants", async (t) => {
  const { store, env, mf } = await setup();
  t.after(() => mf.dispose());
  const saved = await saveVerifiedConnection(store, "a", {
    kind: "lotw",
    remoteIdentity: "station:fixture",
    label: "Unverified",
    status: "disabled",
    credential: { signing: "encrypted-fixture" },
    config: { certificates: [{ trusted: false, status: "unrevoked" }] },
  });
  const resumed = await connectionRoute(
    await request("/enable", { id: saved.id }, env),
    env,
    identity,
  );
  assert.equal(resumed?.status, 200);
  assert.equal(
    (await store.connection("a", saved.id))?.status,
    "needs_verification",
  );
  const crossed = await connectionRoute(
    await request("/enable", { id: saved.id }, env),
    env,
    { ...identity, tenant: "b" },
  );
  assert.equal(crossed?.status, 404);
  await store
    .statement(
      "UPDATE connections SET status='disabled' WHERE tenant='a' AND id=?",
      saved.id,
    )
    .run();
  await store
    .statement(
      "UPDATE private_data SET revoked_at=? WHERE tenant='a' AND connection=? AND kind='credential'",
      Date.now(),
      saved.id,
    )
    .run();
  assert.equal(
    (
      await connectionRoute(
        await request("/enable", { id: saved.id }, env),
        env,
        identity,
      )
    )?.status,
    409,
    "quarantined or revoked ciphertext cannot be resumed",
  );
  assert.equal((await store.connection("a", saved.id))?.status, "disabled");
});
