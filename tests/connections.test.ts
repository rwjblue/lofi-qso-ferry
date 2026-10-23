import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { connectionRoute, saveVerifiedConnection } from "../src/connections.ts";
import type { SessionIdentity } from "../src/auth.ts";
import { digestCode, sha256 } from "../src/security.ts";
import { database, keys, seed } from "./helpers.ts";
const now = Date.now();
const identity: SessionIdentity = {
  tenant: "a",
  credentialId: "key-a",
  tokenHash: "session-a",
  verifiedAt: now,
};
async function setup() {
  const context = await database();
  const sql = readFileSync(
    new URL("../migrations/0002_auth.sql", import.meta.url),
    "utf8",
  );
  let current = "";
  for (const line of sql.split("\n")) {
    current += `${line}\n`;
    const trigger = current.trimStart().startsWith("CREATE TRIGGER");
    if (line.trimEnd().endsWith(";") && (!trigger || line.trim() === "END;")) {
      await context.db.prepare(current).run();
      current = "";
    }
  }
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
test("connection routes enforce passkey freshness, CSRF, tenant ownership and redacted listing", async (t) => {
  const { env, store, mf } = await setup();
  t.after(() => mf.dispose());
  const anonymous = await connectionRoute(
    new Request("http://localhost/api/connections"),
    env,
    null,
  );
  assert.equal(anonymous?.status, 401);
  const stale = await connectionRoute(await request("/qrz", {}, env), env, {
    ...identity,
    verifiedAt: 0,
  });
  assert.equal(stale?.status, 403);
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
test("QRZ linking uses STATUS proof, never INSERT, and preserves stable book on key renewal", async (t) => {
  const { env, store, mf } = await setup();
  t.after(() => mf.dispose());
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

test("new QRZ connection atomically gets a default POTA profile and renewal preserves an edited active version", async (t) => {
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
  assert.match(profile.fields.COMMENT, /potaActivation/);
  assert.equal(profile.fallbackNotes, true);
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
