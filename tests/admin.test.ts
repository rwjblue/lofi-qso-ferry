import assert from "node:assert/strict";
import test from "node:test";
import { adminRoute } from "../src/admin.ts";
import { isAdmin } from "../src/admin-access.ts";
import type {
  AdminInvitationResult,
  AdminInvitations,
} from "../src/admin-invitation-types.ts";
import { AuthError, purgeAuth, type SessionIdentity } from "../src/auth.ts";
import { database } from "./helpers.ts";
import {
  applyAdditionalMigrations,
  fixtureEnvironment,
} from "./runtime-fixtures.ts";

async function setup() {
  const state = await database();
  await applyAdditionalMigrations(state.db);
  await state.db
    .prepare(
      "INSERT INTO accounts(id,email,user_handle,verified_at) VALUES('admin','me@rwjblue.com','admin',?),('member','member@example.test','member',?)",
    )
    .bind(Date.now(), Date.now())
    .run();
  const env = fixtureEnvironment(state.db);
  env.ENVIRONMENT = "production";
  env.ORIGIN = "https://ferry.example.test";
  const sent: EmailMessageBuilder[] = [];
  env.EMAIL = {
    async send(message: EmailMessage | EmailMessageBuilder) {
      assert.ok("subject" in message);
      sent.push(message);
      return { messageId: "synthetic-message" };
    },
  };
  const identity: SessionIdentity = {
    tenant: "admin",
    credentialId: "key",
    tokenHash: "hash",
    verifiedAt: Date.now(),
  };
  async function request(
    path: string,
    data?: unknown,
    actor: SessionIdentity | null = identity,
  ) {
    const response = await adminRoute(
      new Request(`${env.ORIGIN}${path}`, {
        method: data === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        body: data === undefined ? undefined : JSON.stringify(data),
      }),
      env,
      actor,
    );
    assert.ok(response);
    return response;
  }
  return { ...state, env, sent, identity, request };
}

const isStatus = (status: number) => (error: unknown) =>
  error instanceof AuthError && error.status === status;
const address = "Person+tag@example.test";

test("admin authority follows the exact verified active account and guards unknown routes", async () => {
  const { db, mf, env, identity, request } = await setup();
  try {
    assert.equal(await isAdmin(env, "admin"), true);
    for (const tenant of ["member", "missing"]) {
      assert.equal(await isAdmin(env, tenant), false);
      await assert.rejects(
        request("/api/admin/invitations", undefined, { ...identity, tenant }),
        isStatus(403),
      );
      await assert.rejects(
        request("/api/admin/unknown", undefined, { ...identity, tenant }),
        isStatus(403),
      );
    }
    await assert.rejects(
      request("/api/admin/invitations", undefined, null),
      isStatus(401),
    );
    await db
      .prepare("UPDATE accounts SET email='Me@rwjblue.com' WHERE id='admin'")
      .run();
    assert.equal(await isAdmin(env, "admin"), false);
    await db
      .prepare(
        "UPDATE accounts SET email='me@rwjblue.com',status='disabled' WHERE id='admin'",
      )
      .run();
    assert.equal(await isAdmin(env, "admin"), false);
    assert.equal(
      await adminRoute(new Request(`${env.ORIGIN}/api/app`), env, identity),
      null,
    );
  } finally {
    await mf.dispose();
  }
});

test("invitation send requires recent authentication, normalized valid email, and an unused address", async () => {
  const { mf, db, identity, request, sent } = await setup();
  try {
    await assert.rejects(
      request(
        "/api/admin/invitations",
        { email: address },
        { ...identity, verifiedAt: Date.now() - 300_001 },
      ),
      (error: unknown) =>
        error instanceof AuthError && error.code === "reauth_required",
    );
    for (const email of [
      "bad",
      "a\nb@example.test",
      "Test <a@example.test>",
      null,
    ])
      await assert.rejects(
        request("/api/admin/invitations", { email }),
        isStatus(400),
      );
    await assert.rejects(
      request("/api/admin/invitations", { email: "member@example.test" }),
      isStatus(409),
    );
    assert.equal(sent.length, 0);
    const response = await request("/api/admin/invitations", {
      email: " Person+tag@Example.TEST ",
    });
    const body = (await response.json()) as AdminInvitationResult;
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(body.invitation.email, address);
    assert.equal(
      body.invitation.expiresAt - body.invitation.invitedAt,
      7 * 86_400_000,
    );
    assert.equal(body.invitation.mailStatus, "accepted");
    assert.equal(body.invitation.status, "pending");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, [address]);
    assert.match(sent[0].text ?? "", /https:\/\/ferry.example.test\/join/);
    const listing = (await (
      await request("/api/admin/invitations")
    ).json()) as AdminInvitations;
    assert.equal(listing.audit[0].actor, "me@rwjblue.com");
    assert.equal(listing.audit[0].status, "accepted");
    assert.deepEqual(
      Object.keys(listing.invitations[0]).sort(),
      [
        "email",
        "invitedAt",
        "expiresAt",
        "claimedAt",
        "status",
        "mailStatus",
        "lastSentAt",
      ].sort(),
    );
    await db
      .prepare("UPDATE invitations SET claimed_at=? WHERE email=?")
      .bind(Date.now(), address)
      .run();
    await assert.rejects(
      request("/api/admin/invitations", { email: address }),
      isStatus(409),
    );
    await assert.rejects(
      request("/api/admin/invitations/revoke", { email: address }),
      isStatus(409),
    );
  } finally {
    await mf.dispose();
  }
});

test("concurrent sends reserve exactly one invitation and audit, and revoke is atomic", async () => {
  const { mf, request, sent } = await setup();
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        request("/api/admin/invitations", { email: address }),
      ),
    );
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    for (const result of results)
      if (result.status === "rejected") assert.ok(isStatus(429)(result.reason));
    assert.equal(sent.length, 1);
    const revokes = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        request("/api/admin/invitations/revoke", { email: address }),
      ),
    );
    assert.equal(
      revokes.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const listing = (await (
      await request("/api/admin/invitations")
    ).json()) as AdminInvitations;
    assert.equal(listing.invitations[0].status, "revoked");
    assert.equal(listing.audit.length, 2);
    assert.equal(
      listing.audit.filter((entry) => entry.action === "revoke").length,
      1,
    );
    await assert.rejects(
      request("/api/admin/invitations", { email: address }),
      isStatus(429),
    );
  } finally {
    await mf.dispose();
  }
});

test("uncertain native send preserves its grant and never retries or falls back", async (context) => {
  const { mf, env, db, request } = await setup();
  try {
    let nativeCalls = 0;
    env.RESEND_API_KEY = "synthetic-fallback";
    env.EMAIL = {
      async send() {
        nativeCalls++;
        throw new Error("private-provider-diagnostic");
      },
    };
    const external = context.mock.method(globalThis, "fetch", async () => {
      throw new Error("unexpected fallback");
    });
    const response = await request("/api/admin/invitations", {
      email: address,
    });
    assert.equal(response.status, 202);
    const body = (await response.json()) as AdminInvitationResult;
    assert.equal(body.invitation.mailStatus, "uncertain");
    assert.equal(body.invitation.status, "pending");
    assert.match(body.message, /no retry was sent/);
    assert.doesNotMatch(JSON.stringify(body), /private-provider/);
    await db
      .prepare("UPDATE invitations SET last_sent_at=? WHERE email=?")
      .bind(Date.now() - 61_000, address)
      .run();
    await assert.rejects(
      request("/api/admin/invitations", { email: address }),
      isStatus(409),
    );
    assert.equal(nativeCalls, 1);
    assert.equal(external.mock.callCount(), 0);
    await request("/api/admin/invitations/revoke", { email: address });
    assert.equal(
      (await request("/api/admin/invitations", { email: address })).status,
      202,
    );
    assert.equal(nativeCalls, 2);
  } finally {
    await mf.dispose();
  }
});

test("revocation wins over an in-flight email without reopening its grant", async () => {
  const { mf, env, request } = await setup();
  const started = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  try {
    env.EMAIL = {
      async send() {
        started.resolve();
        await completed.promise;
        return { messageId: "synthetic-message" };
      },
    };
    const sending = request("/api/admin/invitations", { email: address });
    await started.promise;
    await request("/api/admin/invitations/revoke", { email: address });
    completed.resolve();
    const result = (await (await sending).json()) as AdminInvitationResult;
    assert.equal(result.invitation.status, "revoked");
    assert.equal(result.invitation.mailStatus, "accepted");
    assert.match(result.message, /can no longer be used/);
    const listing = (await (
      await request("/api/admin/invitations")
    ).json()) as AdminInvitations;
    assert.equal(listing.invitations[0].status, "revoked");
    assert.equal(listing.audit.length, 2);
  } finally {
    completed.resolve();
    await mf.dispose();
  }
});

test("revocation and enrollment compete atomically for the same pending grant", async () => {
  const { mf, db, request } = await setup();
  try {
    await request("/api/admin/invitations", { email: address });
    const now = Date.now();
    await db
      .prepare(
        "INSERT INTO signups(id,browser_hash,email,code_hash,expires_at,verified_at,user_handle) VALUES('signup','browser',?,'code',?,?,'handle')",
      )
      .bind(address, now + 300_000, now)
      .run();
    const results = await Promise.allSettled([
      request("/api/admin/invitations/revoke", { email: address }),
      db
        .prepare(
          "INSERT INTO auth_guards(id,browser_hash,purpose,now,signup,invited_email) VALUES('enrollment','browser','register',?,'signup',?)",
        )
        .bind(now, address)
        .run(),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const row = await db
      .prepare("SELECT claimed_at,revoked_at FROM invitations WHERE email=?")
      .bind(address)
      .first<{ claimed_at: number | null; revoked_at: number | null }>();
    assert.ok(row);
    assert.notEqual(row.claimed_at === null, row.revoked_at === null);
  } finally {
    await mf.dispose();
  }
});

test("a lost worker acknowledgement is shown as uncertain and cannot resend an active grant", async () => {
  const { mf, db, request } = await setup();
  try {
    await db
      .prepare(
        "INSERT INTO invitations(email,invited_at,expires_at,last_sent_at,mail_status) VALUES(?,?,?,?,'sending')",
      )
      .bind(
        address,
        Date.now() - 61_000,
        Date.now() + 86_400_000,
        Date.now() - 61_000,
      )
      .run();
    const listing = (await (
      await request("/api/admin/invitations")
    ).json()) as AdminInvitations;
    assert.equal(listing.invitations[0].mailStatus, "uncertain");
    await assert.rejects(
      request("/api/admin/invitations", { email: address }),
      isStatus(409),
    );
  } finally {
    await mf.dispose();
  }
});

test("Resend is used only without a native binding, with an idempotency key", async (context) => {
  const { mf, env, request } = await setup();
  try {
    delete env.EMAIL;
    env.RESEND_API_KEY = "synthetic-resend";
    const external = context.mock.method(
      globalThis,
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(String(input), "https://api.resend.com/emails");
        assert.match(
          new Headers(init?.headers).get("Idempotency-Key") ?? "",
          /^ferry-invite-/,
        );
        assert.equal(init?.redirect, "manual");
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.to, [address]);
        return Response.json({ id: "synthetic-provider" });
      },
    );
    assert.equal(
      (await request("/api/admin/invitations", { email: address })).status,
      201,
    );
    assert.equal(external.mock.callCount(), 1);
    env.ENVIRONMENT = "local";
    await assert.rejects(
      request("/api/admin/invitations", { email: "local@example.test" }),
      isStatus(503),
    );
    assert.equal(external.mock.callCount(), 1);
  } finally {
    await mf.dispose();
  }
});

test("admin send budget is race resistant and lists are bounded with explicit truncation", async () => {
  const { mf, db, request, sent } = await setup();
  try {
    await db
      .prepare(
        "INSERT INTO rate_limits(key,count,reset_at) VALUES('admin-invitations:admin',19,?)",
      )
      .bind(Date.now() + 3_600_000)
      .run();
    const results = await Promise.allSettled(
      ["a@example.test", "b@example.test"].map((email) =>
        request("/api/admin/invitations", { email }),
      ),
    );
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(sent.length, 1);
    // Bound fixture setup requests during slow local Worker runs.
    for (let start = 0; start < 101; start += 25) {
      const rows = Array.from(
        { length: Math.min(25, 101 - start) },
        (_, offset) => start + offset,
      );
      await db.batch(
        rows.map((n) =>
          db
            .prepare(
              "INSERT INTO invitations(email,invited_at,expires_at) VALUES(?,?,?)",
            )
            .bind(`list${n}@example.test`, n, n),
        ),
      );
      await db.batch(
        rows.map((n) =>
          db
            .prepare(
              "INSERT INTO admin_audit(id,actor,actor_email,action,email,at,status) VALUES(?,'admin','me@rwjblue.com','revoke',?,?,'revoked')",
            )
            .bind(`audit${n}`, `list${n}@example.test`, n),
        ),
      );
    }
    const listing = (await (
      await request("/api/admin/invitations")
    ).json()) as AdminInvitations;
    assert.equal(listing.invitations.length, 100);
    assert.equal(listing.audit.length, 100);
    assert.equal(listing.invitationsTruncated, true);
    assert.equal(listing.auditTruncated, true);
  } finally {
    await mf.dispose();
  }
});

test("expired and revoked invitations remain inspectable for 90 days with bounded retention", async () => {
  const { mf, env, db, request } = await setup();
  try {
    await request("/api/admin/invitations", { email: address });
    await request("/api/admin/invitations/revoke", { email: address });
    await purgeAuth(env, Date.now() + 86_400_000);
    let listing = (await (
      await request("/api/admin/invitations")
    ).json()) as AdminInvitations;
    assert.equal(listing.invitations[0].status, "revoked");
    assert.equal(listing.audit.length, 2);
    await db.prepare("UPDATE invitations SET revoked_at=NULL").run();
    listing = (await (
      await request("/api/admin/invitations")
    ).json()) as AdminInvitations;
    assert.equal(listing.invitations[0].status, "expired");
    await purgeAuth(env, Date.now() + 91 * 86_400_000);
    listing = (await (
      await request("/api/admin/invitations")
    ).json()) as AdminInvitations;
    assert.equal(listing.invitations.length, 0);
    assert.equal(listing.audit.length, 0);
  } finally {
    await mf.dispose();
  }
});
