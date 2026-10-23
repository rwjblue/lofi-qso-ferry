import { timingSafeEqual } from "node:crypto";
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { type MailContent, verificationEmail } from "./mail.ts";
import {
  b64,
  boundedJson,
  digestCode,
  type Envelope,
  keyring,
  open,
  randomToken,
  seal,
  sha256,
  unb64,
} from "./security.ts";

const browserCookie = "__Host-ferry_browser";
const sessionCookie = "__Host-ferry_session";
const fiveMinutes = 300_000;
const thirtyDays = 30 * 86_400_000;
export interface SessionIdentity {
  tenant: string;
  credentialId: string;
  tokenHash: string;
  verifiedAt: number;
}
interface Account {
  id: string;
  email: string;
  user_handle: string;
}
interface Pending {
  id: string;
  email: string;
  browser_hash: string;
  code_hash: string;
  expires_at: number;
  verified_at: number | null;
  consumed_at: number | null;
  attempts: number;
  tenant: string | null;
  purpose: string;
  user_handle: string;
}
interface Ceremony {
  id: string;
  browser_hash: string;
  tenant: string | null;
  purpose: string;
  challenge_hash: string;
  expires_at: number;
  consumed_at: number | null;
  signup_id: string | null;
}
interface Passkey {
  id: string;
  tenant: string;
  public_key: string;
  counter: number;
  metadata: string;
  user_handle: string;
}
export type AuthErrorCode =
  | "session_required"
  | "reauth_required"
  | "csrf_invalid"
  | "origin_invalid";
export class AuthError extends Error {
  constructor(
    readonly status: number,
    message = "Authentication failed",
    readonly code: AuthErrorCode | undefined = status === 401
      ? "session_required"
      : undefined,
  ) {
    super(message);
  }
}
// Public enrollment is available only in the isolated local development path.
// Hosted signup always requires a still-valid invitation to the exact address.
function signupAllowed(env: Env): boolean {
  return env.ENVIRONMENT === "local";
}
async function requireInvitation(env: Env, email: string): Promise<void> {
  if (signupAllowed(env)) return;
  const invitation = await statement(
    env,
    "SELECT email FROM invitations WHERE email=? AND claimed_at IS NULL AND expires_at>?",
    email,
    Date.now(),
  ).first();
  if (!invitation)
    throw new AuthError(
      403,
      "Ferry is invite only for now. Use your invited email address, or sign in with an existing passkey.",
    );
}
const statement = (
  env: Env,
  sql: string,
  ...args: (string | number | null)[]
) => env.DB.prepare(sql).bind(...args);
const json = (value: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
function cookie(request: Request, name: string): string | undefined {
  const matches = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  const value = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
const setCookie = (name: string, value: string, maxAge = thirtyDays / 1000) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string")
    throw new AuthError(400, "Enter a valid email address");
  const trimmed = value.trim();
  if (trimmed.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed))
    throw new AuthError(400, "Enter a valid email address");
  const split = trimmed.lastIndexOf("@");
  const local = trimmed.slice(0, split);
  const rawDomain = trimmed.slice(split + 1);
  if (
    local.length > 64 ||
    /[<>(),:;\\[\]"]/.test(local) ||
    [...local].some((character) => character.charCodeAt(0) <= 0x1f) ||
    /[/:?#[\]\\]/.test(rawDomain)
  )
    throw new AuthError(400, "Enter a valid email address");
  const domain = new URL(`https://${rawDomain}`).hostname.toLowerCase();
  if (
    !/^[a-z0-9.-]+$/.test(domain) ||
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    domain.includes("..")
  )
    throw new AuthError(400, "Enter a valid email address");
  return `${local}@${domain}`;
}
export async function session(
  request: Request,
  env: Env,
): Promise<SessionIdentity | null> {
  const token = cookie(request, sessionCookie);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await statement(
    env,
    `SELECT s.tenant,s.credential_id,s.verified_at FROM sessions s JOIN accounts a ON a.id=s.tenant JOIN passkeys p ON p.id=s.credential_id AND p.tenant=s.tenant WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND a.status='active' AND p.revoked_at IS NULL`,
    tokenHash,
    Date.now(),
  ).first<{ tenant: string; credential_id: string; verified_at: number }>();
  return row
    ? {
        tenant: row.tenant,
        credentialId: row.credential_id,
        tokenHash,
        verifiedAt: row.verified_at,
      }
    : null;
}
export function requireRecent(
  identity: SessionIdentity | null,
): asserts identity is SessionIdentity {
  if (!identity) throw new AuthError(401, "Sign in with a passkey");
  if (identity.verifiedAt <= Date.now() - fiveMinutes)
    throw new AuthError(403, "Verify your passkey again", "reauth_required");
}

/** Expired proofs cannot authenticate; remove their bounded retained state. */
export async function purgeAuth(env: Env, now = Date.now()): Promise<void> {
  await env.DB.batch([
    statement(env, "DELETE FROM local_mailbox WHERE expires_at<=?", now),
    statement(
      env,
      "DELETE FROM ceremonies WHERE expires_at<=? OR signup_id IN(SELECT id FROM signups WHERE expires_at<=?)",
      now,
      now,
    ),
    statement(env, "DELETE FROM signups WHERE expires_at<=?", now),
    statement(env, "DELETE FROM rate_limits WHERE reset_at<=?", now),
    statement(env, "DELETE FROM sessions WHERE expires_at<=?", now),
    // Keep recent expired/revoked grants and operator actions available for
    // troubleshooting, with a bounded retention window.
    statement(
      env,
      "DELETE FROM invitations WHERE expires_at<=?",
      now - 90 * 86_400_000,
    ),
    statement(
      env,
      "DELETE FROM admin_audit WHERE at<=?",
      now - 90 * 86_400_000,
    ),
  ]);
}
export async function checkCsrf(request: Request, env: Env): Promise<void> {
  if (
    request.headers.get("Origin") !== env.ORIGIN ||
    request.headers.get("Sec-Fetch-Site") === "cross-site"
  )
    throw new AuthError(403, "Same-origin request required", "origin_invalid");
  if (
    request.headers.get("Content-Type")?.split(";")[0].trim() !==
    "application/json"
  )
    throw new AuthError(415, "JSON request required");
  const browser = cookie(request, browserCookie);
  if (!browser)
    throw new AuthError(
      403,
      "Refresh this page before continuing",
      "csrf_invalid",
    );
  const expected = await csrf(request, env, browser);
  if (!(await same(expected, request.headers.get("X-CSRF-Token") ?? "")))
    throw new AuthError(
      403,
      "Refresh this page before continuing",
      "csrf_invalid",
    );
}
async function same(a: string, b: string): Promise<boolean> {
  return timingSafeEqual(unb64(await sha256(a)), unb64(await sha256(b)));
}
async function csrf(
  request: Request,
  env: Env,
  browser: string,
): Promise<string> {
  return digestCode(
    env.AUTH_SECRET,
    `csrf:${await sha256(browser)}:${cookie(request, sessionCookie) ? await sha256(cookie(request, sessionCookie) as string) : "anonymous"}`,
  );
}
async function browserHash(request: Request): Promise<string> {
  const browser = cookie(request, browserCookie);
  if (!browser)
    throw new AuthError(
      403,
      "Refresh this page before continuing",
      "csrf_invalid",
    );
  return sha256(browser);
}
async function rate(
  env: Env,
  key: string,
  maximum: number,
  window: number,
): Promise<void> {
  const now = Date.now();
  const row = await statement(
    env,
    `INSERT INTO rate_limits(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.reset_at<=? THEN 1 ELSE rate_limits.count+1 END,reset_at=CASE WHEN rate_limits.reset_at<=? THEN excluded.reset_at ELSE rate_limits.reset_at END RETURNING count`,
    key,
    now + window,
    now,
    now,
  ).first<{ count: number }>();
  if (!row || row.count > maximum)
    throw new AuthError(429, "Too many attempts; try again later");
}
async function requestLimit(request: Request, env: Env, action: string) {
  const source = request.headers.get("CF-Connecting-IP") ?? "local";
  await rate(
    env,
    `${action}:${await digestCode(env.AUTH_SECRET, source)}`,
    30,
    60_000,
  );
}
function localMail(request: Request, env: Env): boolean {
  return (
    env.ENVIRONMENT === "local" &&
    env.ORIGIN === "http://localhost:8787" &&
    new URL(request.url).origin === env.ORIGIN
  );
}
function verificationCode(): string {
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= 4_200_000_000);
  return String(value[0] % 1_000_000).padStart(6, "0");
}
async function sendCode(
  request: Request,
  env: Env,
  pending: Pending,
  code: string,
) {
  if (localMail(request, env)) {
    const envelope = await seal(
      { code, to: pending.email },
      {
        tenant: "local-mailbox",
        connection: pending.browser_hash,
        id: pending.id,
        kind: "mail",
        purpose: "local-mailbox",
      },
      keyring(env),
    );
    await statement(
      env,
      "INSERT INTO local_mailbox VALUES(?,?,?,?)",
      pending.id,
      pending.browser_hash,
      JSON.stringify(envelope),
      pending.expires_at,
    ).run();
    return;
  }
  await sendEmail(
    env,
    pending.email,
    verificationEmail({
      origin: env.ORIGIN,
      code,
      purpose: pending.purpose === "email" ? "email" : "signup",
    }),
    pending.id,
  );
}

/** A successful return means provider acceptance, never inbox delivery.
 * Native send failures never fall back: a lost acknowledgement is ambiguous.
 */
export async function sendEmail(
  env: Env,
  email: string,
  mail: MailContent,
  id: string,
): Promise<void> {
  if (env.ENVIRONMENT === "local" || env.MAIL_FROM.includes("invalid"))
    throw new AuthError(503, "Email delivery is not configured");
  const content = { to: [email], ...mail };
  if (env.EMAIL) {
    try {
      // MAIL_FROM is operator configuration, not an arbitrary RFC 5322 header.
      // Accept a bare address or the controlled display-name form used here.
      const named = /^([A-Za-z0-9 ._-]{1,80}) <([^<>]+)>$/.exec(env.MAIL_FROM);
      const from: EmailAddress = {
        email: normalizeEmail(named?.[2] ?? env.MAIL_FROM),
        name: named?.[1] ?? "LoFi QSO Ferry",
      };
      await env.EMAIL.send({ ...content, from });
      return;
    } catch {
      // A lost acknowledgement can still mean the email was sent.
      throw new AuthError(503, "Email delivery is temporarily unavailable");
    }
  }
  if (!env.RESEND_API_KEY)
    throw new AuthError(503, "Email delivery is not configured");
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `ferry-${id}`,
      },
      body: JSON.stringify({
        ...content,
        from: env.MAIL_FROM,
      }),
      signal: AbortSignal.timeout(15_000),
      redirect: "manual",
    });
  } catch {
    throw new AuthError(503, "Email delivery is temporarily unavailable");
  }
  await response.body?.cancel();
  if (!response.ok)
    throw new AuthError(503, "Email delivery is temporarily unavailable");
}
async function beginEmail(
  request: Request,
  env: Env,
  data: Record<string, unknown>,
  identity: SessionIdentity | null,
  purpose: "signup" | "email",
) {
  if (purpose === "email") requireRecent(identity);
  const email = normalizeEmail(data.email);
  if (purpose === "signup") await requireInvitation(env, email);
  const binding = await browserHash(request);
  await requestLimit(request, env, "email");
  await rate(
    env,
    `address:${await digestCode(env.EMAIL_CODE_SECRET, email)}`,
    3,
    3_600_000,
  );
  const code = verificationCode();
  const pending: Pending = {
    id: randomToken(),
    browser_hash: binding,
    email,
    code_hash: "",
    attempts: 0,
    expires_at: Date.now() + 600_000,
    verified_at: null,
    consumed_at: null,
    tenant: identity?.tenant ?? null,
    purpose,
    user_handle: randomToken(),
  };
  pending.code_hash = await digestCode(
    env.EMAIL_CODE_SECRET,
    `${pending.id}:${code}`,
  );
  await env.DB.batch([
    statement(
      env,
      "UPDATE signups SET consumed_at=? WHERE browser_hash=? AND purpose=? AND consumed_at IS NULL",
      Date.now(),
      binding,
      purpose,
    ),
    statement(
      env,
      "INSERT INTO signups(id,browser_hash,email,code_hash,expires_at,tenant,purpose,user_handle) VALUES(?,?,?,?,?,?,?,?)",
      pending.id,
      binding,
      email,
      pending.code_hash,
      pending.expires_at,
      pending.tenant,
      purpose,
      pending.user_handle,
    ),
  ]);
  try {
    await sendCode(request, env, pending, code);
  } catch (error) {
    await statement(
      env,
      "UPDATE signups SET consumed_at=? WHERE id=?",
      Date.now(),
      pending.id,
    ).run();
    throw error;
  }
  return json({
    id: pending.id,
    message:
      "Enter the verification code in this tab. Existing accounts must use a passkey.",
  });
}
async function verifyEmail(
  request: Request,
  env: Env,
  data: Record<string, unknown>,
  identity: SessionIdentity | null,
  purpose: "signup" | "email",
) {
  if (purpose === "email") requireRecent(identity);
  const binding = await browserHash(request);
  const id = string(data.id);
  const pending = await statement(
    env,
    "SELECT * FROM signups WHERE id=? AND browser_hash=? AND purpose=? AND tenant IS ? AND consumed_at IS NULL AND verified_at IS NULL AND expires_at>? AND attempts<5",
    id,
    binding,
    purpose,
    purpose === "email" ? (identity?.tenant ?? null) : null,
    Date.now(),
  ).first<Pending>();
  if (!pending) throw new AuthError(400);
  const hash = await digestCode(
    env.EMAIL_CODE_SECRET,
    `${id}:${string(data.code)}`,
  );
  const now = Date.now();
  const result = await statement(
    env,
    "UPDATE signups SET attempts=attempts+1,verified_at=CASE WHEN code_hash=? THEN ? ELSE verified_at END WHERE id=? AND browser_hash=? AND consumed_at IS NULL AND verified_at IS NULL AND expires_at>? AND attempts<5 RETURNING verified_at",
    hash,
    now,
    id,
    binding,
    now,
  ).first<{ verified_at: number | null }>();
  if (!result?.verified_at) throw new AuthError(400, "Invalid or expired code");
  if (purpose === "signup") {
    const existing = await statement(
      env,
      "SELECT id FROM accounts WHERE email=?",
      pending.email,
    ).first();
    return json({
      verified: true,
      existingAccount: Boolean(existing),
      message: existing
        ? "This account already exists. Sign in with a passkey."
        : "Email confirmed. Create your first passkey.",
    });
  }
  const guard = guardStatement(env, {
    binding,
    purpose: "email",
    tenant: identity?.tenant ?? null,
    sessionHash: identity?.tokenHash,
    signup: id,
  });
  await env.DB.batch([
    guard.sql,
    statement(
      env,
      "UPDATE accounts SET email=?,verified_at=? WHERE id=?",
      pending.email,
      now,
      identity?.tenant ?? null,
    ),
    statement(env, "DELETE FROM auth_guards WHERE id=?", guard.id),
  ]);
  return json({ updated: true });
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 100_000)
    throw new AuthError(400);
  return value;
}
async function newCeremony(
  env: Env,
  binding: string,
  purpose: string,
  challenge: string,
  tenant: string | null,
  signupId: string | null = null,
) {
  const id = randomToken();
  // Concurrent conditional/explicit options must not invalidate each other.
  await statement(
    env,
    "INSERT INTO ceremonies(id,browser_hash,tenant,purpose,challenge_hash,expires_at,signup_id) VALUES(?,?,?,?,?,?,?)",
    id,
    binding,
    tenant,
    purpose,
    await sha256(challenge),
    Date.now() + fiveMinutes,
    signupId,
  ).run();
  return id;
}
async function ceremony(
  env: Env,
  id: string,
  binding: string,
  purpose: string,
  tenant: string | null,
): Promise<Ceremony> {
  const row = await statement(
    env,
    "SELECT * FROM ceremonies WHERE id=? AND browser_hash=? AND purpose=? AND tenant IS ? AND consumed_at IS NULL AND expires_at>?",
    id,
    binding,
    purpose,
    tenant,
    Date.now(),
  ).first<Ceremony>();
  if (!row) throw new AuthError(400);
  return row;
}
function guardStatement(
  env: Env,
  input: {
    binding: string;
    purpose: string;
    tenant: string | null;
    ceremonyId?: string;
    sessionHash?: string;
    credential?: Passkey;
    signup?: string;
    invitedEmail?: string;
  },
) {
  const id = randomToken();
  return {
    id,
    sql: statement(
      env,
      input.invitedEmail
        ? "INSERT INTO auth_guards(id,ceremony,browser_hash,purpose,tenant,now,session_hash,credential,expected_counter,signup,invited_email) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
        : "INSERT INTO auth_guards(id,ceremony,browser_hash,purpose,tenant,now,session_hash,credential,expected_counter,signup) VALUES(?,?,?,?,?,?,?,?,?,?)",
      id,
      input.ceremonyId ?? null,
      input.binding,
      input.purpose,
      input.tenant,
      Date.now(),
      input.sessionHash ?? null,
      input.credential?.id ?? null,
      input.credential?.counter ?? null,
      input.signup ?? null,
      ...(input.invitedEmail ? [input.invitedEmail] : []),
    ),
  };
}
async function registrationOptions(
  request: Request,
  env: Env,
  data: Record<string, unknown>,
  identity: SessionIdentity | null,
  additional: boolean,
) {
  let account: Account;
  let pending: Pending | null = null;
  let binding: string;
  if (additional) {
    requireRecent(identity);
    binding = identity.tokenHash;
    const found = await statement(
      env,
      "SELECT * FROM accounts WHERE id=? AND status='active'",
      identity.tenant,
    ).first<Account>();
    if (!found) throw new AuthError(401);
    account = found;
  } else {
    binding = await browserHash(request);
    pending = await statement(
      env,
      "SELECT * FROM signups WHERE id=? AND browser_hash=? AND purpose='signup' AND tenant IS NULL AND verified_at IS NOT NULL AND consumed_at IS NULL AND expires_at>?",
      string(data.signupId),
      binding,
      Date.now(),
    ).first<Pending>();
    if (
      !pending ||
      (await statement(
        env,
        "SELECT id FROM accounts WHERE email=?",
        pending.email,
      ).first())
    )
      throw new AuthError(400, "Use passkey sign-in for an existing account");
    account = {
      id: "",
      email: pending.email,
      user_handle: pending.user_handle,
    };
    await requireInvitation(env, pending.email);
  }
  await requestLimit(request, env, "registration");
  const existing = additional
    ? (
        await statement(
          env,
          "SELECT id FROM passkeys WHERE tenant=? AND revoked_at IS NULL",
          account.id,
        ).all<{ id: string }>()
      ).results
    : [];
  const options = await generateRegistrationOptions({
    rpName: "LoFi QSO Ferry",
    rpID: env.RP_ID,
    userName: account.email,
    userID: unb64(account.user_handle),
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    excludeCredentials: existing.map(({ id }) => ({ id })),
    supportedAlgorithmIDs: [-7, -257],
    timeout: fiveMinutes,
  });
  const ceremonyId = await newCeremony(
    env,
    binding,
    additional ? "add-key" : "register",
    options.challenge,
    additional ? account.id : null,
    pending?.id ?? null,
  );
  return json({ ceremonyId, options });
}
async function registrationVerify(
  request: Request,
  env: Env,
  data: Record<string, unknown>,
  identity: SessionIdentity | null,
  additional: boolean,
) {
  if (additional) requireRecent(identity);
  const binding = additional
    ? (identity as SessionIdentity).tokenHash
    : await browserHash(request);
  const purpose = additional ? "add-key" : "register";
  const challenge = await ceremony(
    env,
    string(data.ceremonyId),
    binding,
    purpose,
    additional ? (identity as SessionIdentity).tenant : null,
  );
  checkClientData(
    (data.response as RegistrationResponseJSON)?.response?.clientDataJSON,
  );
  const verified = await verifyRegistrationResponse({
    response: data.response as RegistrationResponseJSON,
    expectedChallenge: async (value) =>
      same(await sha256(value), challenge.challenge_hash),
    expectedOrigin: env.ORIGIN,
    expectedRPID: env.RP_ID,
    requireUserVerification: true,
    requireUserPresence: true,
    supportedAlgorithmIDs: [-7, -257],
  });
  if (!verified.verified) throw new AuthError(400);
  const info = verified.registrationInfo;
  let pending: Pending | null = null;
  let tenant = identity?.tenant ?? randomToken();
  if (!additional) {
    pending = await statement(
      env,
      "SELECT * FROM signups WHERE id=? AND browser_hash=?",
      challenge.signup_id,
      binding,
    ).first<Pending>();
    if (!pending) throw new AuthError(400);
    await requireInvitation(env, pending.email);
    tenant = randomToken();
  }
  const now = Date.now();
  const token = randomToken();
  const tokenHash = await sha256(token);
  const guard = guardStatement(env, {
    binding,
    purpose,
    tenant: additional ? tenant : null,
    ceremonyId: challenge.id,
    sessionHash: additional ? identity?.tokenHash : undefined,
    signup: pending?.id,
    invitedEmail: pending && !signupAllowed(env) ? pending.email : undefined,
  });
  const steps = [guard.sql];
  if (pending)
    steps.push(
      statement(
        env,
        "INSERT INTO accounts(id,email,user_handle,verified_at) VALUES(?,?,?,?)",
        tenant,
        pending.email,
        pending.user_handle,
        now,
      ),
    );
  steps.push(
    statement(
      env,
      "INSERT INTO passkeys(id,tenant,public_key,counter,metadata,label,created_at,last_used_at) VALUES(?,?,?,?,?,?,?,?)",
      info.credential.id,
      tenant,
      b64(info.credential.publicKey),
      info.credential.counter,
      JSON.stringify({
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        transports: info.credential.transports ?? [],
      }),
      typeof data.label === "string" ? data.label.slice(0, 80) : "Passkey",
      now,
      now,
    ),
  );
  if (!additional)
    steps.push(
      statement(
        env,
        "INSERT INTO sessions VALUES(?,?,?,?,?,?,NULL)",
        tokenHash,
        tenant,
        info.credential.id,
        now,
        now,
        now + thirtyDays,
      ),
    );
  steps.push(statement(env, "DELETE FROM auth_guards WHERE id=?", guard.id));
  await env.DB.batch(steps);
  return json(
    { authenticated: !additional, added: additional },
    200,
    additional ? {} : { "Set-Cookie": setCookie(sessionCookie, token) },
  );
}
async function authenticationOptions(
  request: Request,
  env: Env,
  identity: SessionIdentity | null,
  reauth: boolean,
) {
  if (reauth && !identity) throw new AuthError(401);
  await requestLimit(request, env, "authentication");
  const binding = reauth
    ? (identity as SessionIdentity).tokenHash
    : await browserHash(request);
  const options = await generateAuthenticationOptions({
    rpID: env.RP_ID,
    userVerification: "required",
    timeout: fiveMinutes,
  });
  const ceremonyId = await newCeremony(
    env,
    binding,
    reauth ? "reauth" : "login",
    options.challenge,
    reauth ? (identity as SessionIdentity).tenant : null,
  );
  return json({ ceremonyId, options });
}
async function authenticationVerify(
  request: Request,
  env: Env,
  data: Record<string, unknown>,
  identity: SessionIdentity | null,
  reauth: boolean,
) {
  if (reauth && !identity) throw new AuthError(401);
  const binding = reauth
    ? (identity as SessionIdentity).tokenHash
    : await browserHash(request);
  const purpose = reauth ? "reauth" : "login";
  const challenge = await ceremony(
    env,
    string(data.ceremonyId),
    binding,
    purpose,
    reauth ? (identity as SessionIdentity).tenant : null,
  );
  const response = data.response as AuthenticationResponseJSON;
  checkClientData(response?.response?.clientDataJSON);
  const key = await statement(
    env,
    "SELECT p.*,a.user_handle FROM passkeys p JOIN accounts a ON a.id=p.tenant WHERE p.id=? AND p.revoked_at IS NULL AND a.status='active'",
    string(response?.id),
  ).first<Passkey>();
  if (
    !key ||
    (reauth && key.tenant !== identity?.tenant) ||
    response.response?.userHandle !== key.user_handle
  )
    throw new AuthError(400);
  const metadata = JSON.parse(key.metadata) as {
    transports?: AuthenticatorTransport[];
  };
  const verified = await verifyAuthenticationResponse({
    response,
    expectedChallenge: async (value) =>
      same(await sha256(value), challenge.challenge_hash),
    expectedOrigin: env.ORIGIN,
    expectedRPID: env.RP_ID,
    requireUserVerification: true,
    credential: {
      id: key.id,
      publicKey: unb64(key.public_key),
      counter: key.counter,
      transports: metadata.transports,
    },
  });
  if (!verified.verified) throw new AuthError(400);
  const now = Date.now();
  const token = randomToken();
  const guard = guardStatement(env, {
    binding,
    purpose,
    tenant: reauth ? key.tenant : null,
    ceremonyId: challenge.id,
    sessionHash: reauth ? identity?.tokenHash : undefined,
  });
  // Login ceremonies are account-independent. The second guard checks the
  // verified credential under its actual tenant and the original counter.
  const keyGuard = guardStatement(env, {
    binding,
    purpose: "credential",
    tenant: key.tenant,
    credential: key,
  });
  const steps = [
    guard.sql,
    keyGuard.sql,
    statement(
      env,
      "UPDATE passkeys SET counter=?,metadata=?,last_used_at=? WHERE id=? AND tenant=?",
      verified.authenticationInfo.newCounter,
      JSON.stringify({
        ...metadata,
        deviceType: verified.authenticationInfo.credentialDeviceType,
        backedUp: verified.authenticationInfo.credentialBackedUp,
      }),
      now,
      key.id,
      key.tenant,
    ),
  ];
  if (reauth)
    steps.push(
      statement(
        env,
        "UPDATE sessions SET verified_at=? WHERE token_hash=? AND tenant=?",
        now,
        identity?.tokenHash ?? null,
        key.tenant,
      ),
    );
  else {
    if (identity)
      steps.push(
        statement(
          env,
          "UPDATE sessions SET revoked_at=? WHERE token_hash=?",
          now,
          identity.tokenHash,
        ),
      );
    steps.push(
      statement(
        env,
        "INSERT INTO sessions VALUES(?,?,?,?,?,?,NULL)",
        await sha256(token),
        key.tenant,
        key.id,
        now,
        now,
        now + thirtyDays,
      ),
    );
  }
  steps.push(
    statement(
      env,
      "DELETE FROM auth_guards WHERE id IN(?,?)",
      guard.id,
      keyGuard.id,
    ),
  );
  await env.DB.batch(steps);
  return json(
    { authenticated: true, recent: true },
    200,
    reauth ? {} : { "Set-Cookie": setCookie(sessionCookie, token) },
  );
}
function checkClientData(value: unknown): void {
  const client: unknown = JSON.parse(
    new TextDecoder().decode(unb64(string(value))),
  );
  if (!client || typeof client !== "object" || Array.isArray(client))
    throw new AuthError(400);
  const data = client as Record<string, unknown>;
  if (
    (data.crossOrigin !== undefined && data.crossOrigin !== false) ||
    data.topOrigin !== undefined
  )
    throw new AuthError(400);
}
const postRoutes = new Set([
  "signup",
  "signup/verify",
  "register/options",
  "register/verify",
  "login/options",
  "login/verify",
  "reauth/options",
  "reauth/verify",
  "passkeys/options",
  "passkeys/verify",
  "passkeys/revoke",
  "email",
  "email/verify",
  "sessions/revoke",
  "logout",
]);
export async function authRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/auth/")) return null;
  let failedCeremony: string | undefined;
  let failedBinding: string | undefined;
  try {
    if (!env.AUTH_SECRET || !env.EMAIL_CODE_SECRET)
      throw new AuthError(503, "Authentication secrets are not configured");
    if (
      env.ENVIRONMENT !== "local" &&
      (!env.ORIGIN.startsWith("https://") || env.RP_ID === "configure.invalid")
    )
      throw new AuthError(
        503,
        "Configure the permanent passkey hostname first",
      );
    const identity = await session(request, env);
    if (request.method === "GET" && path === "/api/auth/session") {
      const existing = cookie(request, browserCookie);
      const browser = existing ?? randomToken();
      const account = identity
        ? await statement(
            env,
            "SELECT email,user_handle FROM accounts WHERE id=?",
            identity.tenant,
          ).first()
        : null;
      return json(
        {
          authenticated: Boolean(identity),
          signupAllowed: signupAllowed(env),
          csrf: await csrf(request, env, browser),
          account,
          recent: Boolean(
            identity && identity.verifiedAt > Date.now() - fiveMinutes,
          ),
          recovery:
            "Register a second independent passkey. Losing every usable passkey has no email reset.",
        },
        200,
        existing ? {} : { "Set-Cookie": setCookie(browserCookie, browser) },
      );
    }
    if (
      request.method === "GET" &&
      path === "/api/auth/local-mailbox" &&
      localMail(request, env)
    ) {
      const binding = await browserHash(request);
      const rows = (
        await statement(
          env,
          "SELECT * FROM local_mailbox WHERE browser_hash=? AND expires_at>?",
          binding,
          Date.now(),
        ).all<{ id: string; envelope: string }>()
      ).results;
      const messages = await Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          ...(await open<{ code: string; to: string }>(
            JSON.parse(row.envelope) as Envelope,
            {
              tenant: "local-mailbox",
              connection: binding,
              id: row.id,
              kind: "mail",
              purpose: "local-mailbox",
            },
            keyring(env),
          )),
        })),
      );
      return json({ messages });
    }
    if (request.method === "GET" && path === "/api/auth/passkeys" && identity)
      return json({
        passkeys: (
          await statement(
            env,
            "SELECT id,label,created_at,last_used_at,metadata FROM passkeys WHERE tenant=? AND revoked_at IS NULL",
            identity.tenant,
          ).all()
        ).results,
      });
    if (request.method === "GET" && path === "/api/auth/sessions" && identity)
      return json({
        sessions: (
          await statement(
            env,
            "SELECT token_hash,created_at,verified_at,expires_at FROM sessions WHERE tenant=? AND revoked_at IS NULL AND expires_at>?",
            identity.tenant,
            Date.now(),
          ).all()
        ).results,
        current: identity.tokenHash,
      });
    if (request.method !== "POST") return json({ error: "Not found" }, 404);
    if (!postRoutes.has(path.slice("/api/auth/".length)))
      return json({ error: "Not found" }, 404);
    await checkCsrf(request, env);
    await requestLimit(request, env, "request");
    const data = await boundedJson(request, 128 * 1024);
    if (path.endsWith("/verify") && typeof data.ceremonyId === "string") {
      failedCeremony = data.ceremonyId;
      failedBinding =
        path === "/api/auth/login/verify" ||
        path === "/api/auth/register/verify"
          ? await browserHash(request)
          : identity?.tokenHash;
    }
    if (path === "/api/auth/signup")
      return await beginEmail(request, env, data, null, "signup");
    if (path === "/api/auth/signup/verify")
      return await verifyEmail(request, env, data, null, "signup");
    if (path === "/api/auth/register/options")
      return await registrationOptions(request, env, data, null, false);
    if (path === "/api/auth/register/verify")
      return await registrationVerify(request, env, data, null, false);
    if (path === "/api/auth/login/options")
      return await authenticationOptions(request, env, identity, false);
    if (path === "/api/auth/login/verify")
      return await authenticationVerify(request, env, data, identity, false);
    if (path === "/api/auth/reauth/options")
      return await authenticationOptions(request, env, identity, true);
    if (path === "/api/auth/reauth/verify")
      return await authenticationVerify(request, env, data, identity, true);
    if (path === "/api/auth/passkeys/options")
      return await registrationOptions(request, env, data, identity, true);
    if (path === "/api/auth/passkeys/verify")
      return await registrationVerify(request, env, data, identity, true);
    if (path === "/api/auth/email")
      return await beginEmail(request, env, data, identity, "email");
    if (path === "/api/auth/email/verify")
      return await verifyEmail(request, env, data, identity, "email");
    if (path === "/api/auth/logout") {
      if (identity)
        await statement(
          env,
          "UPDATE sessions SET revoked_at=? WHERE token_hash=? AND tenant=?",
          Date.now(),
          identity.tokenHash,
          identity.tenant,
        ).run();
      return json({ signedOut: true }, 200, {
        "Set-Cookie": setCookie(sessionCookie, "", 0),
      });
    }
    if (!identity) throw new AuthError(401);
    if (path === "/api/auth/sessions/revoke") {
      if (data.allOthers === true)
        await statement(
          env,
          "UPDATE sessions SET revoked_at=? WHERE tenant=? AND token_hash!=? AND revoked_at IS NULL",
          Date.now(),
          identity.tenant,
          identity.tokenHash,
        ).run();
      else
        await statement(
          env,
          "UPDATE sessions SET revoked_at=? WHERE tenant=? AND token_hash=?",
          Date.now(),
          identity.tenant,
          string(data.tokenHash),
        ).run();
      return json({ revoked: true });
    }
    if (path === "/api/auth/passkeys/revoke") {
      requireRecent(identity);
      const id = string(data.id);
      const guard = guardStatement(env, {
        binding: identity.tokenHash,
        purpose: "revoke-key",
        tenant: identity.tenant,
        sessionHash: identity.tokenHash,
      });
      const results = await env.DB.batch([
        guard.sql,
        statement(
          env,
          "UPDATE passkeys SET revoked_at=? WHERE tenant=? AND id=? AND revoked_at IS NULL",
          Date.now(),
          identity.tenant,
          id,
        ),
        statement(
          env,
          "UPDATE sessions SET revoked_at=? WHERE tenant=? AND credential_id=?",
          Date.now(),
          identity.tenant,
          id,
        ),
        statement(env, "DELETE FROM auth_guards WHERE id=?", guard.id),
      ]);
      if (results[1].meta.changes !== 1) throw new AuthError(404);
      return json({ revoked: true });
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    // Freshness is checked before verification. Preserve that unexpired
    // ceremony for a bounded retry after reauthentication; other failures burn it.
    if (
      failedCeremony &&
      failedBinding &&
      !(error instanceof AuthError && error.code === "reauth_required")
    ) {
      try {
        await statement(
          env,
          "UPDATE ceremonies SET consumed_at=? WHERE id=? AND browser_hash=? AND consumed_at IS NULL",
          Date.now(),
          failedCeremony,
          failedBinding,
        ).run();
      } catch {
        /* No response includes database diagnostics. */
      }
    }
    if (error instanceof AuthError)
      return json(
        { error: error.message, ...(error.code ? { code: error.code } : {}) },
        error.status,
      );
    return json(
      {
        error:
          "Authentication failed; restart the passkey action or sign in with an existing passkey.",
      },
      400,
    );
  }
}
