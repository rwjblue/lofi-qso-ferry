import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { syntheticAuthenticator } from "./auth-fixtures.ts";

async function runtime(environment = "local", emailFixture = false) {
  const [bundle, browser, html] = await Promise.all([
    build({
      entryPoints: ["src/index.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      external: ["node:*"],
      target: "es2022",
    }),
    build({
      entryPoints: ["src/browser.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
    }),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  ]);
  let outbound = 0;
  const messages: { text: string; html: string }[] = [];
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-10-22",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      bindings: {
        ENVIRONMENT: environment,
        RP_ID: "localhost",
        ORIGIN: "http://localhost:8787",
        AUTH_SECRET: "fixture-auth-".repeat(5),
        EMAIL_CODE_SECRET: "fixture-codes-".repeat(5),
        ACTIVE_KEK_VERSION: "1",
        KEK_V1: Buffer.alloc(32, 7).toString("base64url"),
        RESEND_API_KEY: "",
        MAIL_FROM: "fixture@example.invalid",
        LOTW_TRUST_ROOTS_JSON: "[]",
        EXPORTS_ENABLED: "false",
        ROLLOUT_CHECKS_PASSED: "false",
        SOURCE_BOUNDARY_VERIFIED: "false",
        LIVE_WRITE_AUTHORIZATION: "",
        ...(emailFixture
          ? {
              RP_ID: "ferry.example.test",
              ORIGIN: "https://ferry.example.test",
              RESEND_API_KEY: "synthetic-email-fixture",
              MAIL_FROM: "signup@ferry.example.test",
            }
          : {}),
      },
      serviceBindings: {
        ASSETS: async (request) =>
          new Response(
            new URL(request.url).pathname === "/app.js"
              ? browser.outputFiles[0].text
              : html,
            {
              headers: {
                "Content-Type":
                  new URL(request.url).pathname === "/app.js"
                    ? "text/javascript"
                    : "text/html",
              },
            },
          ),
      },
      outboundService: async (request) => {
        outbound++;
        if (emailFixture && request.url === "https://api.resend.com/emails") {
          messages.push(
            (await request.json()) as { text: string; html: string },
          );
          return Response.json({ id: "synthetic-email-acceptance" });
        }
        return new Response("No live vendor requests permitted in E2E", {
          status: 503,
        });
      },
    }),
  );
  const db = await mf.getD1Database("DB");
  const paths = (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const path of paths) {
    const schema = await readFile(
      new URL(`../migrations/${path}`, import.meta.url),
      "utf8",
    );
    let current = "";
    for (const line of schema.split("\n")) {
      current += `${line}\n`;
      const trigger = current.trimStart().startsWith("CREATE TRIGGER");
      if (
        line.trimEnd().endsWith(";") &&
        (!trigger ||
          line.trim() === "END;" ||
          line.trimStart().startsWith("CREATE TRIGGER"))
      ) {
        await db.prepare(current).run();
        current = "";
      }
    }
    assert.ok(!current.trim(), `unterminated migration ${path}`);
  }
  return {
    mf,
    db,
    outbound: () => outbound,
    bundleBytes: Buffer.byteLength(bundle.outputFiles[0].text),
    messages,
  };
}
class Client {
  cookies = new Map<string, string>();
  csrf = "";
  constructor(
    readonly mf: Miniflare,
    readonly origin = "http://localhost:8787",
  ) {}
  async request(
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    const response = await this.mf.dispatchFetch(`${this.origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie: [...this.cookies]
          .map(([key, value]) => `${key}=${value}`)
          .join("; "),
        ...(body === undefined
          ? {}
          : {
              Origin: this.origin,
              "Content-Type": "application/json",
              "X-CSRF-Token": this.csrf,
            }),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const header = response.headers.get("Set-Cookie");
    if (header) {
      const [name, value] = header.split(";")[0].split("=");
      this.cookies.set(name, value);
    }
    const result = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body: result, headers: response.headers };
  }
  async refresh() {
    const response = await this.request("/api/auth/session");
    assert.equal(response.status, 200, JSON.stringify(response.body));
    this.csrf = String(response.body.csrf);
    return response.body;
  }
}
async function activate(client: Client, email: string) {
  await client.refresh();
  const begun = await client.request("/api/auth/signup", { email });
  assert.equal(begun.status, 200, JSON.stringify(begun.body));
  const mailbox = await client.request("/api/auth/local-mailbox");
  assert.equal(mailbox.status, 200);
  const messages = mailbox.body.messages as { id: string; code: string }[];
  const code = messages.find((item) => item.id === begun.body.id)?.code;
  assert.ok(code);
  assert.equal(
    (
      await client.request("/api/auth/signup/verify", {
        id: begun.body.id,
        code,
      })
    ).status,
    200,
  );
  assert.equal((await client.refresh()).authenticated, false);
  const options = await client.request("/api/auth/register/options", {
    signupId: begun.body.id,
  });
  assert.equal(options.status, 200, JSON.stringify(options.body));
  const key = await syntheticAuthenticator();
  const creation = options.body.options as Record<string, unknown>;
  const registration = await key.registration(creation);
  const accepted = await client.request("/api/auth/register/verify", {
    ceremonyId: options.body.ceremonyId,
    response: registration,
    label: "E2E synced passkey",
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.match(
    accepted.headers.get("Set-Cookie") ?? "",
    /^__Host-ferry_session=.*Secure; HttpOnly; SameSite=Lax/,
  );
  assert.equal((await client.refresh()).authenticated, true);
  return { key, userHandle: (creation.user as { id: string }).id };
}

test("actual Worker HTTP flow verifies passkeys, isolates tenants, preserves template versions and disables exports", async (context) => {
  const { mf, db, outbound, bundleBytes } = await runtime();
  context.after(() => mf.dispose());
  const page = await mf.dispatchFetch("http://localhost:8787/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /LoFi QSO Ferry/);
  assert.match(
    page.headers.get("Content-Security-Policy") ?? "",
    /frame-ancestors 'none'/,
  );
  const app = await mf.dispatchFetch("http://localhost:8787/app.js");
  assert.equal(app.status, 200);
  assert.match(await app.text(), /startAuthentication/);
  const a = new Client(mf);
  const b = new Client(mf);
  assert.equal((await a.request("/api/dashboard")).status, 401);
  assert.equal((await a.request("/api/review")).status, 401);
  const identityA = await activate(a, "worker-a@example.test");
  const identityB = await activate(b, "worker-b@example.test");
  const accountA = (
    await db
      .prepare("SELECT id FROM accounts WHERE email='worker-a@example.test'")
      .first<{ id: string }>()
  )?.id;
  const accountB = (
    await db
      .prepare("SELECT id FROM accounts WHERE email='worker-b@example.test'")
      .first<{ id: string }>()
  )?.id;
  assert.ok(accountA && accountB && accountA !== accountB);
  for (const tenant of [accountA, accountB])
    await db
      .prepare(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,created_at) VALUES(?,'qrz','qrz',?,'Synthetic QRZ book','disabled',0)",
      )
      .bind(tenant, `book-${tenant}`)
      .run();
  let dashboard = await a.request("/api/dashboard");
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.email, "worker-a@example.test");
  assert.equal(dashboard.body.exportsEnabled, false);
  assert.equal(
    (dashboard.body.passkeys as { id: string }[])[0].id,
    identityA.key.id,
  );
  assert.ok(!JSON.stringify(dashboard.body).includes(identityB.key.id));
  const review = await a.request("/api/review");
  assert.equal(review.status, 200);
  assert.equal(review.body.readOnly, true);
  assert.equal(review.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(review.body.sources, []);
  assert.deepEqual(review.body.recentContacts, []);
  assert.equal((await a.request("/api/review", {})).status, 405);
  await db
    .prepare(
      "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,created_at) VALUES(?,'source-b','lofi','private-b','Other tenant source','disabled',0)",
    )
    .bind(accountB)
    .run();
  assert.equal((await a.request("/api/review?source=source-b")).status, 404);
  assert.equal(
    (await a.request("/api/settings", { quietMinutes: 45 })).status,
    200,
  );
  assert.equal((await b.request("/api/dashboard")).body.quietMinutes, 30);
  assert.equal(
    (await a.request("/api/settings", { quietMinutes: 19 })).status,
    400,
  );
  const template = {
    destination: "qrz",
    fields: {
      COMMENT:
        "{% assign parks = op.refs | where: 'type', 'potaActivation' | map: 'ref' %}POTA {{ parks | sentence }}",
    },
    fallbackNotes: true,
  };
  const first = await a.request("/api/templates", template);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await a.request("/api/templates", {
    ...template,
    fields: { COMMENT: "A different forward template" },
  });
  assert.equal(second.status, 200);
  assert.notEqual(first.body.id, second.body.id);
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) AS n FROM templates WHERE tenant=?")
        .bind(accountA)
        .first<{ n: number }>()
    )?.n,
    2,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) AS n FROM templates WHERE tenant=?")
        .bind(accountB)
        .first<{ n: number }>()
    )?.n,
    0,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) AS n FROM ledger")
        .first<{ n: number }>()
    )?.n,
    0,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) AS n FROM attempts")
        .first<{ n: number }>()
    )?.n,
    0,
  );
  assert.equal(
    (
      await a.request(
        "/api/settings",
        { quietMinutes: 30 },
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  assert.equal((await a.request("/api/auth/logout", {})).status, 200);
  await a.refresh();
  assert.equal((await a.request("/api/dashboard")).status, 401);
  const login = await a.request("/api/auth/login/options", {});
  assert.equal(login.status, 200);
  const assertion = await identityA.key.assertion(
    login.body.options as Record<string, unknown>,
    identityA.userHandle,
  );
  const results = await Promise.all([
    a.request("/api/auth/login/verify", {
      ceremonyId: login.body.ceremonyId,
      response: assertion,
    }),
    a.request("/api/auth/login/verify", {
      ceremonyId: login.body.ceremonyId,
      response: assertion,
    }),
  ]);
  assert.deepEqual(results.map((item) => item.status).sort(), [200, 400]);
  await a.refresh();
  dashboard = await a.request("/api/dashboard");
  assert.equal(dashboard.body.email, "worker-a@example.test");
  const invalid = await a.request("/api/auth/reauth/options", {});
  const bad = await identityA.key.assertion(
    invalid.body.options as Record<string, unknown>,
    identityA.userHandle,
    { flags: 0x19 },
  );
  assert.equal(
    (
      await a.request("/api/auth/reauth/verify", {
        ceremonyId: invalid.body.ceremonyId,
        response: bad,
      })
    ).status,
    400,
  );
  assert.equal((await a.request("/health")).body.exportsEnabled, false);
  assert.equal(outbound(), 0, "flow never contacts live vendors or email");
  context.diagnostic(
    `bundled Worker ${bundleBytes} bytes; real workerd registration/authentication and D1 HTTP flow, synthetic ES256 authenticator, fixture static ASSETS binding; no live vendors`,
  );
});

test("production Worker does not expose fixture mailbox or enroll under local RP", async (context) => {
  const { mf, outbound } = await runtime("production");
  context.after(() => mf.dispose());
  const response = await mf.dispatchFetch(
    "http://localhost:8787/api/auth/local-mailbox",
  );
  assert.equal(response.status, 503);
  assert.equal(outbound(), 0);
  const health = await mf.dispatchFetch("http://localhost:8787/health");
  assert.equal(
    ((await health.json()) as { exportsEnabled: boolean }).exportsEnabled,
    false,
  );
});

test("admin HTTP routes require the current owner account and fresh, CSRF-protected mutations", async (context) => {
  const { mf, db, outbound } = await runtime();
  context.after(() => mf.dispose());
  const anonymous = new Client(mf);
  const member = new Client(mf);
  const admin = new Client(mf);
  const paths = ["/api/admin/overview", "/api/admin/invitations"];
  const mutations = ["/api/admin/invitations", "/api/admin/invitations/revoke"];
  const invitation = { email: "invitee@example.test" };
  for (const path of paths)
    assert.equal((await anonymous.request(path)).status, 401);
  for (const path of mutations)
    assert.equal((await anonymous.request(path, invitation)).status, 401);

  // The local part is case-sensitive: this verified account is not the owner.
  await activate(member, "Me@rwjblue.com");
  await activate(admin, "me@rwjblue.com");
  const account = await db
    .prepare("SELECT id FROM accounts WHERE email='me@rwjblue.com'")
    .first<{ id: string }>();
  assert.ok(account);
  assert.equal((await member.request("/api/dashboard")).body.admin, false);
  assert.equal((await admin.request("/api/dashboard")).body.admin, true);
  for (const path of paths)
    assert.equal((await member.request(path)).status, 403);
  assert.equal(
    (
      await member.request(
        `/api/admin/overview?admin=true&tenant=${account.id}`,
        undefined,
        { "X-Admin": "true", "X-User-Email": "me@rwjblue.com" },
      )
    ).status,
    403,
  );
  for (const path of mutations)
    assert.equal(
      (
        await member.request(path, {
          ...invitation,
          admin: true,
          role: "admin",
          tenant: account.id,
          actorEmail: "me@rwjblue.com",
        })
      ).status,
      403,
    );

  const secret = "admin-overview-must-not-expose-this";
  await db
    .prepare(
      "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,config,created_at) VALUES(?,'private-source','lofi',?,'Synthetic source','disabled',?,0)",
    )
    .bind(
      account.id,
      secret,
      JSON.stringify({ credential: secret, lastError: secret }),
    )
    .run();
  await db
    .prepare(
      "INSERT INTO private_data(tenant,connection,id,kind,envelope,created_at) VALUES(?,'private-source','credential','credential',?,0)",
    )
    .bind(account.id, secret)
    .run();
  const overview = await admin.request("/api/admin/overview");
  assert.equal(overview.status, 200, JSON.stringify(overview.body));
  assert.equal(overview.headers.get("Cache-Control"), "no-store");
  assert.equal((overview.body.accounts as { total: number }).total, 2);
  assert.equal(
    (overview.body.gates as { effective: boolean }).effective,
    false,
  );
  assert.ok(!JSON.stringify(overview.body).includes(secret));
  assert.doesNotMatch(
    JSON.stringify(overview.body),
    /"(?:token_hash|public_key|envelope|config|remote_identity|credential_version|code_hash|challenge_hash)"\s*:/,
  );
  assert.equal((await admin.request("/api/admin/invitations")).status, 200);

  const invalidHeaders: Record<string, string>[] = [
    { "X-CSRF-Token": "" },
    { Origin: "https://evil.example" },
  ];
  for (const path of mutations)
    for (const headers of invalidHeaders)
      assert.equal(
        (await admin.request(path, invitation, headers)).status,
        403,
      );
  await db
    .prepare("UPDATE sessions SET verified_at=? WHERE tenant=?")
    .bind(Date.now() - 300_001, account.id)
    .run();
  for (const path of mutations) {
    const stale = await admin.request(path, invitation);
    assert.equal(stale.status, 403);
    assert.equal(stale.body.code, "reauth_required");
  }
  assert.equal((await admin.request("/api/admin/overview")).status, 200);

  // Authorization follows the current account, even with an existing session.
  await db
    .prepare("UPDATE accounts SET email='former-owner@example.test' WHERE id=?")
    .bind(account.id)
    .run();
  assert.equal((await admin.request("/api/dashboard")).body.admin, false);
  assert.equal((await admin.request("/api/admin/overview")).status, 403);
  await db
    .prepare(
      "UPDATE accounts SET email='me@rwjblue.com',status='disabled' WHERE id=?",
    )
    .bind(account.id)
    .run();
  assert.equal((await admin.request("/api/admin/overview")).status, 401);
  await db
    .prepare("UPDATE accounts SET status='active' WHERE id=?")
    .bind(account.id)
    .run();
  await db
    .prepare("UPDATE sessions SET revoked_at=? WHERE tenant=?")
    .bind(Date.now(), account.id)
    .run();
  for (const path of paths)
    assert.equal((await admin.request(path)).status, 401);
  for (const path of mutations)
    assert.equal((await admin.request(path, invitation)).status, 401);
  for (const table of ["invitations", "admin_audit"])
    assert.equal(
      (
        await db
          .prepare(`SELECT count(*) AS n FROM ${table}`)
          .first<{ n: number }>()
      )?.n,
      0,
      `${table} is unchanged by rejected mutations`,
    );
  assert.equal(outbound(), 0);
});

test("actual hosted Worker requires an invitation and saves preferences with no services", async (context) => {
  const { mf, db, outbound, messages } = await runtime("production", true);
  context.after(() => mf.dispose());
  const origin = "https://ferry.example.test";
  const client = new Client(mf, origin);
  assert.equal((await client.refresh()).signupAllowed, false);
  assert.equal(
    (
      await client.request("/api/auth/signup", {
        email: "Uninvited@example.test",
      })
    ).status,
    403,
  );
  assert.equal(outbound(), 0);
  const join = await mf.dispatchFetch(`${origin}/join`);
  assert.equal(join.status, 200);
  assert.match(await join.text(), /LoFi QSO Ferry/);
  await db
    .prepare(
      "INSERT INTO invitations(email,invited_at,expires_at) VALUES('Invited@example.test',?,?)",
    )
    .bind(Date.now(), Date.now() + 86_400_000)
    .run();
  const begun = await client.request("/api/auth/signup", {
    email: "Invited@example.test",
  });
  assert.equal(begun.status, 200);
  assert.equal(messages.length, 1);
  assert.match(messages[0].html, /<!doctype html>/);
  const code = /^@ferry\.example\.test #(\d{6})$/m.exec(messages[0].text)?.[1];
  assert.ok(code);
  assert.equal(
    (
      await client.request("/api/auth/signup/verify", {
        id: begun.body.id,
        code,
      })
    ).status,
    200,
  );
  const options = await client.request("/api/auth/register/options", {
    signupId: begun.body.id,
  });
  assert.equal(options.status, 200);
  const key = await syntheticAuthenticator();
  assert.equal(
    (
      await client.request("/api/auth/register/verify", {
        ceremonyId: options.body.ceremonyId,
        response: await key.registration(
          options.body.options as Record<string, unknown>,
          { origin, rp: "ferry.example.test" },
        ),
      })
    ).status,
    200,
  );
  assert.ok(
    (
      await db
        .prepare(
          "SELECT claimed_at FROM invitations WHERE email='Invited@example.test'",
        )
        .first<{ claimed_at: number }>()
    )?.claimed_at,
  );
  assert.equal((await client.refresh()).authenticated, true);
  const before = await client.request("/api/dashboard");
  assert.deepEqual(before.body.connections, []);
  assert.equal(
    (await client.request("/api/settings", { quietMinutes: 40 })).status,
    200,
  );
  const fields = {
    COMMENT: "Saved before connecting any service: {{ qso.notes }}",
  };
  const saved = await client.request("/api/templates", {
    fields,
    fallbackNotes: false,
  });
  assert.equal(saved.status, 200);
  const after = await client.request("/api/dashboard");
  assert.equal(after.body.quietMinutes, 40);
  assert.deepEqual(
    (after.body.defaultTemplate as { fields: unknown }).fields,
    fields,
  );
  assert.equal(after.body.exportsEnabled, false);
  for (const table of ["connections", "ledger", "attempts", "local_mailbox"]) {
    assert.equal(
      (
        await db
          .prepare(`SELECT count(*) n FROM ${table}`)
          .first<{ n: number }>()
      )?.n,
      0,
    );
  }
  assert.equal(
    outbound(),
    1,
    "only the fixture email provider was contacted; no vendor writes",
  );
});
