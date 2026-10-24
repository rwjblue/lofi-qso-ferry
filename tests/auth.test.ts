import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { authRoute, normalizeEmail, purgeAuth, session } from "../src/auth.ts";
import { syntheticAuthenticator as authenticator } from "./auth-fixtures.ts";
import { database, keys } from "./helpers.ts";

async function setup() {
  const { db, mf } = await database();
  const sql = (
    await Promise.all(
      [
        "0002_auth.sql",
        "0007_invitations.sql",
        "0012_admin_invitations.sql",
      ].map((file) =>
        readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"),
      ),
    )
  ).join("\n");
  let current = "";
  for (const line of sql.split("\n")) {
    current += `${line}\n`;
    const trigger = current.trimStart().startsWith("CREATE TRIGGER");
    if (line.trimEnd().endsWith(";") && (!trigger || line.trim() === "END;")) {
      await db.prepare(current).run();
      current = "";
    }
  }
  const env = {
    DB: db,
    ASSETS: {
      fetch: async () => new Response(),
      connect: () => {
        throw new Error("unused test binding");
      },
    },
    ENVIRONMENT: "local",
    RP_ID: "localhost",
    ORIGIN: "http://localhost:8787",
    AUTH_SECRET: "a".repeat(64),
    EMAIL_CODE_SECRET: "b".repeat(64),
    ACTIVE_KEK_VERSION: "1",
    KEK_V1: keys.keys["1"],
    RESEND_API_KEY: "",
    MAIL_FROM: "LoFi QSO Ferry <ferry@example.invalid>",
    EXPORTS_ENABLED: "false",
    ROLLOUT_CHECKS_PASSED: "false",
    SOURCE_BOUNDARY_VERIFIED: "false",
    QRZ_FRESH_INSERTS_ENABLED: "false",
    ROLLOUT_QSO_IDS_JSON: "[]",
    ROLLOUT_DESTINATION_IDS_JSON: "[]",
    LIVE_WRITE_AUTHORIZATION: "",
  } as Env;
  return { db, mf, env };
}
class Browser {
  cookies = new Map<string, string>();
  csrf = "";
  constructor(readonly env: Env) {}
  cookieHeader() {
    return [...this.cookies]
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }
  async request(
    path: string,
    data?: unknown,
    headers: Record<string, string> = {},
  ) {
    const request = new Request(`${this.env.ORIGIN}/api/auth/${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        Cookie: this.cookieHeader(),
        ...(data === undefined
          ? {}
          : {
              Origin: this.env.ORIGIN,
              "Content-Type": "application/json",
              "X-CSRF-Token": this.csrf,
            }),
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const response = await authRoute(request, this.env);
    assert.ok(response);
    const set = response.headers.get("Set-Cookie");
    if (set) {
      const [name, value] = set.split(";")[0].split("=");
      this.cookies.set(name, value);
    }
    const body = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body, response };
  }
  async refresh() {
    const response = await this.request("session");
    this.csrf = String(response.body.csrf);
    return response;
  }
}
async function allowInvite(
  db: D1Database,
  email: string,
  expiresAt = Date.now() + 86_400_000,
) {
  await db
    .prepare(
      "INSERT INTO invitations(email,invited_at,expires_at) VALUES(?,?,?)",
    )
    .bind(normalizeEmail(email), Date.now(), expiresAt)
    .run();
}
async function signup(browser: Browser, email = "Person+tag@Example.TEST") {
  await browser.refresh();
  const started = await browser.request("signup", { email });
  assert.equal(started.status, 200);
  const mailbox = await browser.request("local-mailbox");
  const messages = mailbox.body.messages as { id: string; code: string }[];
  const code = messages.find((item) => item.id === started.body.id)?.code;
  assert.ok(code);
  const confirmation = await browser.request("signup/verify", {
    id: started.body.id,
    code,
  });
  assert.equal(confirmation.status, 200);
  assert.equal(
    (await browser.refresh()).body.authenticated,
    false,
    "email proof is not a session",
  );
  const options = await browser.request("register/options", {
    signupId: started.body.id,
  });
  assert.equal(options.status, 200);
  return { started, code, options };
}
async function enrolled(browser: Browser, email?: string) {
  const pending = await signup(browser, email);
  const key = await authenticator();
  const options = pending.options.body.options as Record<string, unknown>;
  const response = await key.registration(options);
  const finish = await browser.request("register/verify", {
    ceremonyId: pending.options.body.ceremonyId,
    response,
    label: "Synthetic synced passkey",
  });
  assert.equal(finish.status, 200, JSON.stringify(finish.body));
  assert.match(
    finish.response.headers.get("Set-Cookie") ?? "",
    /Secure; HttpOnly; SameSite=Lax/,
  );
  const account = await browser.refresh();
  assert.equal(account.body.authenticated, true);
  const user = (options.user as { id: string }).id;
  return { key, user, pending, response };
}

test("email policy preserves local case, dots and plus tags and canonicalizes only domain", () => {
  assert.equal(
    normalizeEmail(" Ab.C+Tag@EXAMPLE.COM "),
    "Ab.C+Tag@example.com",
  );
  assert.notEqual(
    normalizeEmail("Me@example.com"),
    normalizeEmail("me@example.com"),
  );
  for (const value of [
    "bad",
    "a@x",
    "a\n@example.test",
    "a@host.test/path",
    "a@host.test:443",
    "a@host..test",
  ])
    assert.throws(() => normalizeEmail(value));
});

test("authentication CSRF and origin failures have distinct safe codes without creating proofs", async (context) => {
  const { env, mf, db } = await setup();
  context.after(() => mf.dispose());
  const browser = new Browser(env);
  await browser.refresh();
  for (const [headers, code] of [
    [{ "X-CSRF-Token": "wrong" }, "csrf_invalid"],
    [{ Cookie: "" }, "csrf_invalid"],
    [{ Origin: "https://other.example.test" }, "origin_invalid"],
    [{ "Sec-Fetch-Site": "cross-site" }, "origin_invalid"],
  ] as const) {
    const response = await browser.request(
      "signup",
      { email: "fixture@example.test" },
      headers,
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.code, code);
    assert.notEqual(response.body.code, "reauth_required");
  }
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM signups").first<{ n: number }>())
      ?.n,
    0,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) n FROM local_mailbox")
        .first<{ n: number }>()
    )?.n,
    0,
  );
});

test("native email confirms browser-bound signup and email changes while passkey login sends no mail", async (context) => {
  const { env, mf, db } = await setup();
  try {
    env.ENVIRONMENT = "production";
    env.ORIGIN = "https://ferry.example.test";
    env.RP_ID = "ferry.example.test";
    env.MAIL_FROM = "LoFi QSO Ferry <signup@ferry.example.test>";
    const messages: EmailMessageBuilder[] = [];
    env.EMAIL = {
      send: async (message: EmailMessage | EmailMessageBuilder) => {
        assert.ok("subject" in message);
        messages.push(message);
        return { messageId: `synthetic-${messages.length}` };
      },
    };
    const external = context.mock.method(globalThis, "fetch", async () => {
      throw new Error("No real email provider may be contacted by this test");
    });
    const code = (index: number) => {
      const value = /^@ferry\.example\.test #(\d{6})$/m.exec(
        messages[index].text ?? "",
      )?.[1];
      assert.ok(value);
      return value;
    };
    const a = new Browser(env);
    const b = new Browser(env);
    await a.refresh();
    await b.refresh();
    await allowInvite(db, "Native+Tag@example.test");
    const begun = await a.request("signup", {
      email: "Native+Tag@Example.TEST",
    });
    assert.equal(begun.status, 200);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].from, {
      email: "signup@ferry.example.test",
      name: "LoFi QSO Ferry",
    });
    assert.deepEqual(messages[0].to, ["Native+Tag@example.test"]);
    const pending = await db
      .prepare("SELECT * FROM signups WHERE id=?")
      .bind(begun.body.id)
      .first();
    assert.ok(pending);
    assert.equal(pending.purpose, "signup");
    assert.equal(pending.tenant, null);
    assert.ok(!JSON.stringify(pending).includes(code(0)));
    assert.equal(
      (
        await b.request("signup/verify", {
          id: begun.body.id,
          code: code(0),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await a.request("signup/verify", {
          id: begun.body.id,
          code: code(0),
        })
      ).status,
      200,
    );
    assert.equal((await a.refresh()).body.authenticated, false);
    const options = await a.request("register/options", {
      signupId: begun.body.id,
    });
    const key = await authenticator();
    const registration = options.body.options as Record<string, unknown>;
    const user = (registration.user as { id: string }).id;
    const changes = { origin: env.ORIGIN, rp: env.RP_ID };
    assert.equal(
      (
        await a.request("register/verify", {
          ceremonyId: options.body.ceremonyId,
          response: await key.registration(registration, changes),
        })
      ).status,
      200,
    );
    assert.equal((await a.refresh()).body.authenticated, true);
    assert.ok(
      (
        await db
          .prepare("SELECT claimed_at FROM invitations WHERE email=?")
          .bind("Native+Tag@example.test")
          .first<{ claimed_at: number }>()
      )?.claimed_at,
    );
    assert.equal((await a.request("local-mailbox")).status, 404);
    await a.request("logout", {});
    await a.refresh();
    const login = await a.request("login/options", {});
    assert.equal(
      (
        await a.request("login/verify", {
          ceremonyId: login.body.ceremonyId,
          response: await key.assertion(
            login.body.options as Record<string, unknown>,
            user,
            changes,
          ),
        })
      ).status,
      200,
    );
    await a.refresh();
    assert.equal(
      messages.length,
      1,
      "existing-account login uses only a passkey",
    );
    const changed = await a.request("email", { email: "Changed@example.test" });
    assert.equal(changed.status, 200);
    assert.equal(messages.length, 2);
    const emailPending = await db
      .prepare("SELECT * FROM signups WHERE id=?")
      .bind(changed.body.id)
      .first();
    assert.equal(emailPending?.purpose, "email");
    assert.equal(
      emailPending?.tenant,
      (
        await db
          .prepare("SELECT tenant FROM passkeys WHERE id=?")
          .bind(key.id)
          .first<{ tenant: string }>()
      )?.tenant,
    );
    assert.equal(
      (
        await a.request("signup/verify", {
          id: changed.body.id,
          code: code(1),
        })
      ).status,
      400,
      "an email-change proof cannot enroll a new account",
    );
    assert.equal(
      (
        await a.request("email/verify", {
          id: changed.body.id,
          code: code(1),
        })
      ).status,
      200,
    );
    assert.equal(
      ((await a.refresh()).body.account as { email: string }).email,
      "Changed@example.test",
    );
    assert.equal(external.mock.callCount(), 0);
  } finally {
    await mf.dispose();
  }
});

test("hosted signup rejects uninvited, expired and claimed addresses without sending or retaining proofs", async () => {
  const { env, mf, db } = await setup();
  try {
    env.ENVIRONMENT = "production";
    env.ORIGIN = "https://ferry.example.test";
    env.RP_ID = "ferry.example.test";
    let sent = 0;
    env.EMAIL = {
      send: async () => {
        sent++;
        return { messageId: "fixture" };
      },
    };
    const browser = new Browser(env);
    assert.equal((await browser.refresh()).body.signupAllowed, false);
    await allowInvite(db, "Expired@example.test", Date.now() - 1);
    await allowInvite(db, "Claimed@example.test");
    await db
      .prepare("UPDATE invitations SET claimed_at=? WHERE email=?")
      .bind(Date.now(), "Claimed@example.test")
      .run();
    await allowInvite(db, "Exact+tag@example.test");
    for (const email of [
      "Unknown@example.test",
      "Expired@example.test",
      "Claimed@example.test",
      "exact+tag@example.test",
    ]) {
      const denied = await browser.request("signup", { email });
      assert.equal(denied.status, 403);
      assert.match(String(denied.body.error), /invite only/);
    }
    assert.equal(sent, 0);
    for (const table of [
      "accounts",
      "signups",
      "local_mailbox",
      "passkeys",
      "sessions",
    ]) {
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
      (await browser.request("login/options", {})).status,
      200,
      "existing-account passkey login stays available",
    );
  } finally {
    await mf.dispose();
  }
});

test("invitation is rechecked and claimed atomically with passkey enrollment", async () => {
  const { env, mf, db } = await setup();
  try {
    env.ENVIRONMENT = "production";
    env.ORIGIN = "https://ferry.example.test";
    env.RP_ID = "ferry.example.test";
    env.MAIL_FROM = "signup@ferry.example.test";
    const email = "Invited@example.test";
    await allowInvite(db, email);
    let code = "";
    env.EMAIL = {
      send: async (message) => {
        assert.ok("text" in message);
        code =
          /^@ferry\.example\.test #(\d{6})$/m.exec(message.text ?? "")?.[1] ??
          "";
        return { messageId: "fixture" };
      },
    };
    const browser = new Browser(env);
    await browser.refresh();
    const started = await browser.request("signup", { email });
    assert.equal(started.status, 200);
    assert.match(code, /^\d{6}$/);
    assert.equal(
      (await browser.request("signup/verify", { id: started.body.id, code }))
        .status,
      200,
    );
    await db
      .prepare("UPDATE invitations SET expires_at=0 WHERE email=?")
      .bind(email)
      .run();
    assert.equal(
      (await browser.request("register/options", { signupId: started.body.id }))
        .status,
      403,
    );
    await db
      .prepare("UPDATE invitations SET expires_at=? WHERE email=?")
      .bind(Date.now() + 86_400_000, email)
      .run();
    const options = await browser.request("register/options", {
      signupId: started.body.id,
    });
    assert.equal(options.status, 200);
    const key = await authenticator();
    const response = await key.registration(
      options.body.options as Record<string, unknown>,
      { origin: env.ORIGIN, rp: env.RP_ID },
    );
    // Expire the invitation after the application read but before its batch.
    // The real SQLite trigger must reject and roll back proof/account/key state.
    env.DB = {
      prepare: db.prepare.bind(db),
      batch: async (steps: D1PreparedStatement[]) => {
        await db
          .prepare("UPDATE invitations SET expires_at=0 WHERE email=?")
          .bind(email)
          .run();
        return db.batch(steps);
      },
    } as D1Database;
    const raced = await browser.request("register/verify", {
      ceremonyId: options.body.ceremonyId,
      response,
    });
    assert.equal(raced.status, 400);
    env.DB = db;
    assert.equal(
      (
        await db
          .prepare("SELECT claimed_at FROM invitations WHERE email=?")
          .bind(email)
          .first<{ claimed_at: number | null }>()
      )?.claimed_at,
      null,
    );
    assert.equal(
      (
        await db
          .prepare("SELECT consumed_at FROM signups WHERE id=?")
          .bind(started.body.id)
          .first<{ consumed_at: number | null }>()
      )?.consumed_at,
      null,
    );
    assert.equal(
      (
        await db
          .prepare("SELECT count(*) n FROM accounts")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    assert.equal(
      (
        await db
          .prepare("SELECT count(*) n FROM passkeys")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    await db
      .prepare("UPDATE invitations SET expires_at=? WHERE email=?")
      .bind(Date.now() + 86_400_000, email)
      .run();
    const retry = await browser.request("register/options", {
      signupId: started.body.id,
    });
    assert.equal(retry.status, 200);
    const retryResponse = await key.registration(
      retry.body.options as Record<string, unknown>,
      { origin: env.ORIGIN, rp: env.RP_ID },
    );
    assert.equal(
      (
        await browser.request("register/verify", {
          ceremonyId: retry.body.ceremonyId,
          response: retryResponse,
        })
      ).status,
      200,
    );
    assert.ok(
      (
        await db
          .prepare("SELECT claimed_at FROM invitations WHERE email=?")
          .bind(email)
          .first<{ claimed_at: number }>()
      )?.claimed_at,
    );
    const another = new Browser(env);
    await another.refresh();
    assert.equal((await another.request("signup", { email })).status, 403);
    await purgeAuth(env, Date.now() + 92 * 86_400_000);
    assert.equal(
      (
        await db
          .prepare("SELECT count(*) n FROM invitations")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    assert.equal(
      (
        await db
          .prepare("SELECT count(*) n FROM accounts")
          .first<{ n: number }>()
      )?.n,
      1,
    );
  } finally {
    await mf.dispose();
  }
});

test("uncertain native email failure invalidates its proof and never falls back to Resend", async (context) => {
  const { env, mf, db } = await setup();
  try {
    env.ENVIRONMENT = "production";
    env.ORIGIN = "https://ferry.example.test";
    env.RP_ID = "ferry.example.test";
    env.MAIL_FROM = "signup@ferry.example.test";
    env.RESEND_API_KEY = "synthetic-fallback-key";
    let attempts = 0;
    let sent: EmailMessageBuilder | undefined;
    env.EMAIL = {
      send: async (message: EmailMessage | EmailMessageBuilder) => {
        assert.ok("subject" in message);
        attempts++;
        sent = message;
        throw new Error("private-provider-diagnostic-must-not-escape");
      },
    };
    const external = context.mock.method(globalThis, "fetch", async () => {
      throw new Error(
        "Resend fallback must not run after uncertain native send",
      );
    });
    const browser = new Browser(env);
    await browser.refresh();
    await allowInvite(db, "Failure@example.test");
    const failed = await browser.request("signup", {
      email: "Failure@example.test",
    });
    assert.equal(failed.status, 503);
    assert.deepEqual(failed.body, {
      error: "Email delivery is temporarily unavailable",
    });
    assert.equal(attempts, 1);
    assert.ok(sent);
    assert.deepEqual(sent.from, {
      email: "signup@ferry.example.test",
      name: "LoFi QSO Ferry",
    });
    const pending = await db
      .prepare("SELECT id,consumed_at,verified_at,purpose FROM signups")
      .first<{
        id: string;
        consumed_at: number | null;
        verified_at: number | null;
        purpose: string;
      }>();
    assert.ok(pending?.consumed_at);
    assert.equal(pending.verified_at, null);
    assert.equal(pending.purpose, "signup");
    const code = /^@ferry\.example\.test #(\d{6})$/m.exec(sent.text ?? "")?.[1];
    assert.ok(code);
    assert.equal(
      (await browser.request("signup/verify", { id: pending.id, code })).status,
      400,
      "an email possibly delivered before its failure has no usable proof",
    );
    assert.equal((await browser.refresh()).body.authenticated, false);
    assert.equal(external.mock.callCount(), 0);
    assert.equal(
      (
        await db
          .prepare("SELECT count(*) n FROM local_mailbox")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    assert.equal(
      (
        await db
          .prepare("SELECT count(*) n FROM accounts")
          .first<{ n: number }>()
      )?.n,
      0,
    );
  } finally {
    await mf.dispose();
  }
});

test("local email stays local when a native binding exists and absent bindings retain Resend delivery", async (context) => {
  const { env, mf, db } = await setup();
  try {
    let native = 0;
    env.EMAIL = {
      send: async () => {
        native++;
        throw new Error("Local email must not use native binding");
      },
    };
    const local = new Browser(env);
    await signup(local, "Local@example.test");
    assert.equal(native, 0);
    delete env.EMAIL;
    env.ENVIRONMENT = "production";
    env.ORIGIN = "https://ferry.example.test";
    env.RP_ID = "ferry.example.test";
    env.MAIL_FROM = "LoFi QSO Ferry <signup@ferry.example.test>";
    env.RESEND_API_KEY = "synthetic-resend-key";
    let body: Record<string, unknown> | undefined;
    const external = context.mock.method(
      globalThis,
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(String(input), "https://api.resend.com/emails");
        assert.equal(init?.method, "POST");
        assert.equal(init?.redirect, "manual");
        const headers = new Headers(init?.headers);
        assert.equal(
          headers.get("Authorization"),
          "Bearer synthetic-resend-key",
        );
        assert.match(headers.get("Idempotency-Key") ?? "", /^ferry-/);
        body = JSON.parse(String(init?.body));
        return new Response("{}", { status: 200 });
      },
    );
    const browser = new Browser(env);
    await browser.refresh();
    await allowInvite(db, "Resend@example.test");
    assert.equal(
      (await browser.request("signup", { email: "Resend@example.test" }))
        .status,
      200,
    );
    assert.equal(external.mock.callCount(), 1);
    assert.equal(body?.from, env.MAIL_FROM);
    assert.deepEqual(body?.to, ["Resend@example.test"]);
    assert.match(String(body?.subject), /\d{6}/);
    assert.match(String(body?.html), /<!doctype html>/);
  } finally {
    await mf.dispose();
  }
});

test("email-confirmed discoverable registration, no email reset, single-use atomic activation", async () => {
  const { env, mf, db } = await setup();
  try {
    const browser = new Browser(env);
    const pending = await signup(browser);
    const options = pending.options.body.options as {
      challenge: string;
      user: { id: string };
      authenticatorSelection: { residentKey: string; userVerification: string };
    };
    assert.equal(options.authenticatorSelection.residentKey, "required");
    assert.equal(options.authenticatorSelection.userVerification, "required");
    const key = await authenticator();
    const response = await key.registration(options);
    const results = await Promise.all([
      browser.request("register/verify", {
        ceremonyId: pending.options.body.ceremonyId,
        response,
      }),
      browser.request("register/verify", {
        ceremonyId: pending.options.body.ceremonyId,
        response,
      }),
    ]);
    assert.deepEqual(results.map((item) => item.status).sort(), [200, 400]);
    assert.equal(
      (
        await db
          .prepare("SELECT count(*) AS n FROM accounts")
          .first<{ n: number }>()
      )?.n,
      1,
    );
    assert.equal(
      (
        await db
          .prepare("SELECT count(*) AS n FROM sessions")
          .first<{ n: number }>()
      )?.n,
      1,
    );
    const reset = new Browser(env);
    await reset.refresh();
    const start = await reset.request("signup", {
      email: "Person+tag@example.test",
    });
    const mail = (await reset.request("local-mailbox")).body.messages as {
      id: string;
      code: string;
    }[];
    const verify = await reset.request("signup/verify", {
      id: start.body.id,
      code: mail.find((item) => item.id === start.body.id)?.code,
    });
    assert.equal(verify.body.existingAccount, true);
    assert.equal((await reset.refresh()).body.authenticated, false);
    assert.equal(
      (await reset.request("register/options", { signupId: start.body.id }))
        .status,
      400,
    );
    assert.equal(
      (await reset.request("password", { password: "no" })).status,
      404,
    );
  } finally {
    await mf.dispose();
  }
});

test("signup browser binding, code expiry/attempt limit, CSRF and replaced-code rejection", async () => {
  const { env, mf, db } = await setup();
  try {
    const a = new Browser(env);
    const b = new Browser(env);
    await a.refresh();
    await b.refresh();
    const start = await a.request("signup", { email: "bound@example.test" });
    const mail = (await a.request("local-mailbox")).body.messages as {
      id: string;
      code: string;
    }[];
    const code = mail.find((item) => item.id === start.body.id)?.code;
    assert.equal(
      Array.isArray((await b.request("local-mailbox")).body.messages),
      true,
    );
    assert.equal(
      ((await b.request("local-mailbox")).body.messages as unknown[]).length,
      0,
    );
    assert.equal(
      (await b.request("signup/verify", { id: start.body.id, code })).status,
      400,
    );
    assert.equal(
      (
        await a.request(
          "signup/verify",
          { id: start.body.id, code },
          { Origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await a.request(
          "signup/verify",
          { id: start.body.id, code },
          { "X-CSRF-Token": "wrong" },
        )
      ).status,
      403,
    );
    for (let i = 0; i < 5; i++)
      assert.equal(
        (await a.request("signup/verify", { id: start.body.id, code: "wrong" }))
          .status,
        400,
      );
    assert.equal(
      (await a.request("signup/verify", { id: start.body.id, code })).status,
      400,
    );
    const next = await a.request("signup", { email: "bound@example.test" });
    await db
      .prepare("UPDATE signups SET expires_at=0 WHERE id=?")
      .bind(next.body.id)
      .run();
    assert.equal(
      (await a.request("signup/verify", { id: next.body.id, code })).status,
      400,
    );
    const dump = JSON.stringify(
      await db.prepare("SELECT * FROM signups").all(),
    );
    assert.ok(!dump.includes(`"code":"${code}"`));
  } finally {
    await mf.dispose();
  }
});

test("real cryptographic assertions reject wrong challenge/origin/RP/UV/handle and replay while zero counters work", async () => {
  const { env, mf, db } = await setup();
  try {
    const browser = new Browser(env);
    const { key, user } = await enrolled(browser);
    const loggedOut = await browser.request("logout", {});
    assert.equal(loggedOut.status, 200);
    await browser.refresh();
    for (const changes of [
      { challenge: "invalid" },
      { origin: "https://evil.example" },
      { rp: "evil.example" },
      { flags: 0x19 },
    ]) {
      const start = await browser.request("login/options", {});
      const response = await key.assertion(
        start.body.options as Record<string, unknown>,
        user,
        changes,
      );
      assert.equal(
        (
          await browser.request("login/verify", {
            ceremonyId: start.body.ceremonyId,
            response,
          })
        ).status,
        400,
      );
    }
    const mismatch = await browser.request("login/options", {});
    assert.equal(
      (
        await browser.request("login/verify", {
          ceremonyId: mismatch.body.ceremonyId,
          response: await key.assertion(
            mismatch.body.options as Record<string, unknown>,
            "another-account",
          ),
        })
      ).status,
      400,
    );
    const start = await browser.request("login/options", {});
    assert.equal(
      (start.body.options as { allowCredentials?: unknown[] }).allowCredentials,
      undefined,
    );
    const response = await key.assertion(
      start.body.options as Record<string, unknown>,
      user,
    );
    const finishes = await Promise.all([
      browser.request("login/verify", {
        ceremonyId: start.body.ceremonyId,
        response,
      }),
      browser.request("login/verify", {
        ceremonyId: start.body.ceremonyId,
        response,
      }),
    ]);
    assert.deepEqual(finishes.map((item) => item.status).sort(), [200, 400]);
    assert.equal((await browser.refresh()).body.authenticated, true);
    assert.equal(
      (
        await db
          .prepare("SELECT counter FROM passkeys WHERE id=?")
          .bind(key.id)
          .first<{ counter: number }>()
      )?.counter,
      0,
    );
    const req = new Request("http://localhost:8787", {
      headers: { Cookie: browser.cookieHeader() },
    });
    assert.ok(await session(req, env));
    await db.prepare("UPDATE sessions SET revoked_at=1").run();
    assert.equal(await session(req, env), null);
  } finally {
    await mf.dispose();
  }
});

test("wrong registration origin/RP/UV, expired and wrong-purpose ceremonies fail", async () => {
  const { env, mf, db } = await setup();
  try {
    const browser = new Browser(env);
    const pending = await signup(browser, "reg-errors@example.test");
    const key = await authenticator();
    for (const changes of [
      { origin: "https://evil.example" },
      { rp: "evil.example" },
      { flags: 0x59 },
    ]) {
      const next = await browser.request("register/options", {
        signupId: pending.started.body.id,
      });
      assert.equal(
        (
          await browser.request("register/verify", {
            ceremonyId: next.body.ceremonyId,
            response: await key.registration(
              next.body.options as Record<string, unknown>,
              changes,
            ),
          })
        ).status,
        400,
      );
    }
    const wrong = await browser.request("login/options", {});
    assert.equal(
      (
        await browser.request("register/verify", {
          ceremonyId: wrong.body.ceremonyId,
          response: await key.registration(
            wrong.body.options as Record<string, unknown>,
          ),
        })
      ).status,
      400,
    );
    const expires = await browser.request("register/options", {
      signupId: pending.started.body.id,
    });
    await db
      .prepare("UPDATE ceremonies SET expires_at=0 WHERE id=?")
      .bind(expires.body.ceremonyId)
      .run();
    assert.equal(
      (
        await browser.request("register/verify", {
          ceremonyId: expires.body.ceremonyId,
          response: await key.registration(
            expires.body.options as Record<string, unknown>,
          ),
        })
      ).status,
      400,
    );
  } finally {
    await mf.dispose();
  }
});

test("an add-key registration can retry its untouched ceremony after freshness-only rejection and real reauthentication", async (context) => {
  const { env, mf, db } = await setup();
  context.after(() => mf.dispose());
  const browser = new Browser(env);
  const first = await enrolled(browser, "freshness-retry@example.test");
  const backup = await authenticator();
  const options = await browser.request("passkeys/options", {});
  assert.equal(options.status, 200);
  const registration = await backup.registration(
    options.body.options as Record<string, unknown>,
  );
  const payload = {
    ceremonyId: options.body.ceremonyId,
    response: registration,
    label: "Backup",
  };
  await db.prepare("UPDATE sessions SET verified_at=0").run();
  assert.equal((await browser.refresh()).body.recent, false);
  const stale = await browser.request("passkeys/verify", payload);
  assert.equal(stale.status, 403);
  assert.equal(stale.body.code, "reauth_required");
  const consumed = async (id: unknown) =>
    (
      await db
        .prepare("SELECT consumed_at FROM ceremonies WHERE id=?")
        .bind(id)
        .first<{ consumed_at: number | null }>()
    )?.consumed_at;
  assert.equal(
    await consumed(options.body.ceremonyId),
    null,
    "pre-verification freshness rejection must retain the valid ceremony",
  );
  const reauth = await browser.request("reauth/options", {});
  assert.equal(reauth.status, 200);
  assert.equal(
    (
      await browser.request("reauth/verify", {
        ceremonyId: reauth.body.ceremonyId,
        response: await first.key.assertion(
          reauth.body.options as Record<string, unknown>,
          first.user,
        ),
      })
    ).status,
    200,
  );
  assert.equal((await browser.refresh()).body.recent, true);
  assert.equal(
    (await browser.request("passkeys/verify", payload)).status,
    200,
    "the exact original authenticator payload succeeds after reauthentication",
  );
  assert.ok(await consumed(options.body.ceremonyId));
  assert.equal(
    (await browser.request("passkeys/verify", payload)).status,
    400,
    "the successfully consumed ceremony still rejects replay",
  );
  const invalidKey = await authenticator();
  const invalidOptions = await browser.request("passkeys/options", {});
  assert.equal(
    (
      await browser.request("passkeys/verify", {
        ceremonyId: invalidOptions.body.ceremonyId,
        response: await invalidKey.registration(
          invalidOptions.body.options as Record<string, unknown>,
          { flags: 0x59 },
        ),
      })
    ).status,
    400,
  );
  assert.ok(
    await consumed(invalidOptions.body.ceremonyId),
    "a real verification failure must still consume its ceremony",
  );
  assert.equal(
    (
      await browser.request("passkeys/verify", {
        ceremonyId: invalidOptions.body.ceremonyId,
        response: await invalidKey.registration(
          invalidOptions.body.options as Record<string, unknown>,
        ),
      })
    ).status,
    400,
  );
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM passkeys").first<{ n: number }>())
      ?.n,
    2,
  );
});

test("additional keys and email changes require fresh passkeys; last key and other tenants are protected", async () => {
  const { env, mf, db } = await setup();
  try {
    const a = new Browser(env);
    const first = await enrolled(a, "owner@example.test");
    const b = new Browser(env);
    const other = await enrolled(b, "other@example.test");
    assert.equal(
      (await a.request("passkeys/revoke", { id: first.key.id })).status,
      400,
    );
    const key = await authenticator();
    const start = await a.request("passkeys/options", {});
    const options = start.body.options as {
      user: { id: string };
      excludeCredentials: { id: string }[];
    };
    assert.equal(options.user.id, first.user);
    assert.equal(options.excludeCredentials[0].id, first.key.id);
    assert.equal(
      (
        await a.request("passkeys/verify", {
          ceremonyId: start.body.ceremonyId,
          response: await key.registration(options),
          label: "Backup",
        })
      ).status,
      200,
    );
    assert.equal(
      (await a.request("passkeys/revoke", { id: other.key.id })).status,
      404,
    );
    assert.equal(
      (await a.request("passkeys/revoke", { id: key.id })).status,
      200,
    );
    await db
      .prepare(
        "UPDATE sessions SET verified_at=0 WHERE tenant=(SELECT tenant FROM passkeys WHERE id=?)",
      )
      .bind(first.key.id)
      .run();
    assert.equal((await a.request("passkeys/options", {})).status, 403);
    assert.equal(
      (await a.request("email", { email: "new@example.test" })).status,
      403,
    );
    const reauth = await a.request("reauth/options", {});
    assert.equal(
      (
        await a.request("reauth/verify", {
          ceremonyId: reauth.body.ceremonyId,
          response: await other.key.assertion(
            reauth.body.options as Record<string, unknown>,
            other.user,
          ),
        })
      ).status,
      400,
    );
    const fresh = await a.request("reauth/options", {});
    assert.equal(
      (
        await a.request("reauth/verify", {
          ceremonyId: fresh.body.ceremonyId,
          response: await first.key.assertion(
            fresh.body.options as Record<string, unknown>,
            first.user,
          ),
        })
      ).status,
      200,
    );
    const email = await a.request("email", { email: "New+Tag@Example.TEST" });
    assert.equal(email.status, 200);
    const mail = (await a.request("local-mailbox")).body.messages as {
      id: string;
      code: string;
    }[];
    assert.equal(
      (
        await a.request("email/verify", {
          id: email.body.id,
          code: mail.find((item) => item.id === email.body.id)?.code,
        })
      ).status,
      200,
    );
    const account = (await a.refresh()).body.account as {
      email: string;
      user_handle: string;
    };
    assert.equal(account.email, "New+Tag@example.test");
    assert.equal(account.user_handle, first.user);
  } finally {
    await mf.dispose();
  }
});

test("production has no local mailbox and refuses placeholder RP configuration", async () => {
  const { env, mf } = await setup();
  try {
    const production = { ...env, ENVIRONMENT: "production" } as Env;
    const response = await authRoute(
      new Request("http://localhost:8787/api/auth/local-mailbox"),
      production,
    );
    assert.equal(response?.status, 503);
  } finally {
    await mf.dispose();
  }
});

test("conditional and explicit login options remain independently valid and individually single-use", async () => {
  const { env, mf } = await setup();
  try {
    const browser = new Browser(env);
    const { key, user } = await enrolled(
      browser,
      "concurrent-options@example.test",
    );
    await browser.request("logout", {});
    await browser.refresh();
    const conditional = await browser.request("login/options", {});
    const explicit = await browser.request("login/options", {});
    assert.equal(conditional.status, 200);
    assert.equal(explicit.status, 200);
    assert.notEqual(conditional.body.ceremonyId, explicit.body.ceremonyId);
    const first = await key.assertion(
      conditional.body.options as Record<string, unknown>,
      user,
    );
    assert.equal(
      (
        await browser.request("login/verify", {
          ceremonyId: conditional.body.ceremonyId,
          response: first,
        })
      ).status,
      200,
    );
    await browser.refresh();
    assert.equal(
      (
        await browser.request("login/verify", {
          ceremonyId: conditional.body.ceremonyId,
          response: first,
        })
      ).status,
      400,
      "each challenge remains single-use",
    );
    const second = await key.assertion(
      explicit.body.options as Record<string, unknown>,
      user,
    );
    assert.equal(
      (
        await browser.request("login/verify", {
          ceremonyId: explicit.body.ceremonyId,
          response: second,
        })
      ).status,
      200,
      "later options do not invalidate the conditional challenge or vice versa",
    );
    assert.equal((await browser.refresh()).body.authenticated, true);
  } finally {
    await mf.dispose();
  }
});

test("independent WebAuthn ceremonies do not weaken replaced email-code invalidation", async () => {
  const { env, mf } = await setup();
  try {
    const browser = new Browser(env);
    await browser.refresh();
    const first = await browser.request("signup", {
      email: "replace@example.test",
    });
    const oldMail = (await browser.request("local-mailbox")).body.messages as {
      id: string;
      code: string;
    }[];
    const oldCode = oldMail.find((item) => item.id === first.body.id)?.code;
    assert.ok(oldCode);
    const next = await browser.request("signup", {
      email: "replace@example.test",
    });
    const newMail = (await browser.request("local-mailbox")).body.messages as {
      id: string;
      code: string;
    }[];
    const code = newMail.find((item) => item.id === next.body.id)?.code;
    assert.ok(code);
    assert.equal(
      (
        await browser.request("signup/verify", {
          id: first.body.id,
          code: oldCode,
        })
      ).status,
      400,
    );
    assert.equal(
      (await browser.request("signup/verify", { id: next.body.id, code }))
        .status,
      200,
    );
    assert.equal((await browser.refresh()).body.authenticated, false);
  } finally {
    await mf.dispose();
  }
});
