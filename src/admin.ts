import { isAdmin } from "./admin-access.ts";
import { getAdminOverview } from "./admin-metrics.ts";
import type {
  AdminAuditEntry,
  AdminInvitation,
  AdminInvitationResult,
  AdminInvitations,
} from "./admin-invitation-types.ts";
import {
  AuthError,
  normalizeEmail,
  requireRecent,
  sendEmail,
  type SessionIdentity,
} from "./auth.ts";
import { invitationEmail } from "./mail.ts";
import { boundedJson } from "./security.ts";

export type {
  AdminAuditEntry,
  AdminInvitation,
  AdminInvitationResult,
  AdminInvitations,
} from "./admin-invitation-types.ts";

const limit = 100;
const week = 7 * 86_400_000;
const cooldown = 60_000;
const statement = (env: Env, sql: string, ...values: (string | number)[]) =>
  env.DB.prepare(sql).bind(...values);
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

interface InvitationRow {
  email: string;
  invited_at: number;
  expires_at: number;
  claimed_at: number | null;
  revoked_at: number | null;
  last_sent_at: number | null;
  mail_status: AdminInvitation["mailStatus"];
  send_id: string | null;
}

function invitation(row: InvitationRow, now = Date.now()): AdminInvitation {
  return {
    email: row.email,
    invitedAt: row.invited_at,
    expiresAt: row.expires_at,
    claimedAt: row.claimed_at,
    status:
      row.claimed_at !== null
        ? "claimed"
        : row.revoked_at !== null
          ? "revoked"
          : row.expires_at <= now
            ? "expired"
            : "pending",
    // A worker may have died before persisting the provider acknowledgement.
    mailStatus:
      row.mail_status === "sending" &&
      row.last_sent_at !== null &&
      row.last_sent_at <= now - cooldown
        ? "uncertain"
        : row.mail_status,
    lastSentAt: row.last_sent_at,
  };
}

async function findInvitation(
  env: Env,
  email: string,
): Promise<InvitationRow | null> {
  return statement(
    env,
    "SELECT * FROM invitations WHERE email=?",
    email,
  ).first<InvitationRow>();
}

async function listInvitations(env: Env): Promise<AdminInvitations> {
  const now = Date.now();
  const [invitations, audit] = await env.DB.batch<
    InvitationRow | AdminAuditEntry
  >([
    statement(
      env,
      "SELECT * FROM invitations ORDER BY invited_at DESC,email LIMIT ?",
      limit + 1,
    ),
    statement(
      env,
      "SELECT id,actor_email AS actor,action,email,at,status FROM admin_audit ORDER BY at DESC,id LIMIT ?",
      limit + 1,
    ),
  ]);
  return {
    invitations: (invitations.results as InvitationRow[])
      .slice(0, limit)
      .map((row) => invitation(row, now)),
    audit: (audit.results as AdminAuditEntry[]).slice(0, limit).map((row) => ({
      ...row,
      status:
        row.status === "sending" && row.at <= now - cooldown
          ? "uncertain"
          : row.status,
    })),
    limit,
    invitationsTruncated: invitations.results.length > limit,
    auditTruncated: audit.results.length > limit,
  };
}

async function sendBudget(env: Env, identity: SessionIdentity, now: number) {
  const row = await statement(
    env,
    `INSERT INTO rate_limits(key,count,reset_at) VALUES(?,1,?)
     ON CONFLICT(key) DO UPDATE SET
       count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,
       reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END
     RETURNING count`,
    `admin-invitations:${identity.tenant}`,
    now + 3_600_000,
    now,
    now,
  ).first<{ count: number }>();
  if (!row || row.count > 20)
    throw new AuthError(429, "Invitation limit reached. Try again in an hour.");
}

async function sendInvitation(
  env: Env,
  identity: SessionIdentity,
  email: string,
): Promise<Response> {
  if (env.ENVIRONMENT === "local")
    throw new AuthError(
      503,
      "Invitation email is disabled in local development.",
    );
  const now = Date.now();
  const id = crypto.randomUUID();
  const expiresAt = now + week;
  const mail = invitationEmail({ origin: env.ORIGIN, expiresAt });
  await sendBudget(env, identity, now);
  // The conditional UPSERT chooses one sender even across concurrent workers.
  // Its audit entry is committed in the same transaction before external I/O.
  const [reservation] = await env.DB.batch<InvitationRow>([
    statement(
      env,
      `INSERT INTO invitations(email,invited_at,expires_at,last_sent_at,mail_status,send_id,action_id)
       SELECT ?,?,?,?,'sending',?,? WHERE NOT EXISTS(SELECT 1 FROM accounts WHERE email=?)
       ON CONFLICT(email) DO UPDATE SET
         invited_at=excluded.invited_at,expires_at=excluded.expires_at,revoked_at=NULL,
         last_sent_at=excluded.last_sent_at,mail_status='sending',send_id=excluded.send_id,action_id=excluded.action_id
       WHERE invitations.claimed_at IS NULL
         AND (invitations.last_sent_at IS NULL OR invitations.last_sent_at<=?)
         AND (invitations.mail_status NOT IN ('sending','uncertain') OR invitations.expires_at<=?)
       RETURNING *`,
      email,
      now,
      expiresAt,
      now,
      id,
      id,
      email,
      now - cooldown,
      now,
    ),
    statement(
      env,
      `INSERT INTO admin_audit(id,actor,actor_email,action,email,at,status)
       SELECT ?,?,'me@rwjblue.com','invite',email,?,'sending' FROM invitations WHERE email=? AND action_id=?`,
      id,
      identity.tenant,
      now,
      email,
      id,
    ),
  ]);
  if (!reservation.results.length) {
    const existing = await findInvitation(env, email);
    if (
      (existing?.claimed_at !== null && existing?.claimed_at !== undefined) ||
      (await statement(
        env,
        "SELECT 1 FROM accounts WHERE email=?",
        email,
      ).first())
    )
      throw new AuthError(
        409,
        "This email already belongs to an account or a claimed invitation.",
      );
    if (
      existing?.last_sent_at !== null &&
      existing?.last_sent_at !== undefined &&
      existing.last_sent_at > now - cooldown
    )
      throw new AuthError(
        429,
        "Wait at least 60 seconds before sending another invitation to this address.",
      );
    throw new AuthError(
      409,
      "The previous email may have been sent. Revoke the invitation before explicitly sending a new one.",
    );
  }
  let accepted = false;
  try {
    await sendEmail(env, email, mail, `invite-${id}`);
    accepted = true;
  } catch {
    // Keep the grant: the recipient may already have received the email.
    // Never retry automatically or try a second transport after ambiguity.
  }
  await env.DB.batch([
    statement(
      env,
      "UPDATE invitations SET mail_status=? WHERE email=? AND send_id=?",
      accepted ? "accepted" : "uncertain",
      email,
      id,
    ),
    statement(
      env,
      "UPDATE admin_audit SET status=? WHERE id=?",
      accepted ? "accepted" : "uncertain",
      id,
    ),
  ]);
  const current = await findInvitation(env, email);
  if (!current)
    throw new AuthError(
      409,
      "Invitation changed; refresh the invitation list.",
    );
  const currentInvitation = invitation(current);
  const grantMessage =
    currentInvitation.status === "pending"
      ? "The invitation remains valid"
      : `The invitation is ${currentInvitation.status}`;
  const result: AdminInvitationResult = {
    invitation: currentInvitation,
    message: accepted
      ? `Invitation email accepted by the mail provider. Inbox delivery is not confirmed.${currentInvitation.status === "revoked" ? " The invitation was revoked while sending and can no longer be used." : ""}`
      : `Email acceptance is uncertain. ${grantMessage}; no retry was sent. Check with the recipient, or revoke a pending invitation before explicitly sending a new one.`,
  };
  return json(result, accepted ? 201 : 202);
}

async function revokeInvitation(
  env: Env,
  identity: SessionIdentity,
  email: string,
): Promise<Response> {
  const now = Date.now();
  const id = crypto.randomUUID();
  const [revoked] = await env.DB.batch<InvitationRow>([
    statement(
      env,
      "UPDATE invitations SET expires_at=?,revoked_at=?,action_id=? WHERE email=? AND claimed_at IS NULL AND revoked_at IS NULL AND expires_at>? RETURNING *",
      now,
      now,
      id,
      email,
      now,
    ),
    statement(
      env,
      `INSERT INTO admin_audit(id,actor,actor_email,action,email,at,status)
       SELECT ?,?,'me@rwjblue.com','revoke',email,?,'revoked' FROM invitations WHERE email=? AND action_id=?`,
      id,
      identity.tenant,
      now,
      email,
      id,
    ),
  ]);
  if (!revoked.results.length)
    throw new AuthError(
      409,
      "Only a pending invitation can be revoked. Refresh the list.",
    );
  const result: AdminInvitationResult = {
    invitation: invitation(revoked.results[0]),
    message:
      "Invitation revoked. It can no longer be used to create an account.",
  };
  return json(result);
}

/** Caller validates CSRF for mutations before dispatching this route. */
export async function adminRoute(
  request: Request,
  env: Env,
  identity: SessionIdentity | null,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/admin/")) return null;
  if (!identity) throw new AuthError(401, "Sign in with a passkey");
  if (!(await isAdmin(env, identity.tenant)))
    throw new AuthError(403, "Administrator access required");
  if (request.method === "GET" && path === "/api/admin/overview")
    return json(await getAdminOverview(env));
  if (request.method === "GET" && path === "/api/admin/invitations")
    return json(await listInvitations(env));
  if (
    request.method === "POST" &&
    (path === "/api/admin/invitations" ||
      path === "/api/admin/invitations/revoke")
  ) {
    requireRecent(identity);
    let body: Record<string, unknown>;
    try {
      body = await boundedJson(request, 1024);
    } catch {
      throw new AuthError(
        400,
        "Enter a valid email address in a JSON request.",
      );
    }
    const email = normalizeEmail(body.email);
    return path.endsWith("/revoke")
      ? revokeInvitation(env, identity, email)
      : sendInvitation(env, identity, email);
  }
  return json({ error: "Admin endpoint not found" }, 404);
}
