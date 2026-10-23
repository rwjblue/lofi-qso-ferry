import {
  AuthError,
  checkCsrf,
  normalizeEmail,
  requireRecent,
  type SessionIdentity,
} from "./auth.ts";
import { LoFiClient, type LoFiCredentials } from "./lofi.ts";
import { LotwClient } from "./lotw.ts";
import { type QrzBook, QrzClient } from "./qrz.ts";
import {
  boundedJson,
  canonical,
  keyring,
  randomToken,
  sha256,
} from "./security.ts";
import { defaultTemplate as accountDefaultTemplate } from "./settings.ts";
import {
  importPkcs12,
  type LotwStation,
  type SigningCredential,
} from "./signing.ts";
import { type Connection, Store } from "./store.ts";

class ConnectionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const hasAsciiControl = (value: string): boolean => {
  for (const character of value)
    if (character.charCodeAt(0) <= 0x1f) return true;
  return false;
};
const text = (value: unknown, label: string, maximum = 256): string => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    hasAsciiControl(value)
  )
    throw new ConnectionError(400, `Invalid ${label}`);
  return value.trim();
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ConnectionError(400, "Expected an object");
  return value as Record<string, unknown>;
};
function sessionGuard(
  store: Store,
  identity: SessionIdentity,
  now: number,
): D1PreparedStatement {
  return store.statement(
    "INSERT INTO auth_guards(id,browser_hash,purpose,tenant,now,session_hash) VALUES(?,?,?,?,?,?)",
    randomToken(),
    "",
    "connection",
    identity.tenant,
    now,
    identity.tokenHash,
  );
}
/** All identities here have already been established with read-only vendor evidence. */
export async function saveVerifiedConnection(
  store: Store,
  tenant: string,
  input: {
    kind: Connection["kind"];
    remoteIdentity: string;
    label: string;
    credential: unknown;
    config: Record<string, unknown>;
    status?: string;
    credentialVersion?: string;
  },
  identity?: SessionIdentity,
): Promise<{ id: string; version: string }> {
  if (identity && identity.tenant !== tenant)
    throw new ConnectionError(
      403,
      "Tenant does not match the authenticated session",
    );
  const existing = await store
    .statement(
      "SELECT * FROM connections WHERE tenant=? AND kind=? AND remote_identity=?",
      tenant,
      input.kind,
      input.remoteIdentity,
    )
    .first<Connection>();
  const id =
    existing?.id ??
    (await sha256(
      canonical({ tenant, kind: input.kind, remote: input.remoteIdentity }),
    ));
  const version = input.credentialVersion ?? randomToken();
  const privateWrite = await store.putPrivate(
    tenant,
    id,
    version,
    "credential",
    input.credential,
  );
  const now = Date.now();
  const defaultTemplate = randomToken();
  const initialTemplate =
    input.kind === "qrz" && !existing
      ? await accountDefaultTemplate(store, tenant)
      : null;
  const newQrzTemplate =
    input.kind === "qrz" && !existing
      ? [
          store.statement(
            "INSERT INTO templates(tenant,destination,id,config,created_at) SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM active_templates WHERE tenant=? AND destination=?)",
            tenant,
            id,
            defaultTemplate,
            canonical({
              ...initialTemplate,
              id: defaultTemplate,
            }),
            now,
            tenant,
            id,
          ),
          store.statement(
            "INSERT OR IGNORE INTO active_templates(tenant,destination,version) VALUES(?,?,?)",
            tenant,
            id,
            defaultTemplate,
          ),
        ]
      : [];
  await store.db.batch([
    ...(identity ? [sessionGuard(store, identity, now)] : []),
    store.statement(
      `INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,config,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant,kind,remote_identity) DO UPDATE SET label=excluded.label,status=excluded.status,credential_version=excluded.credential_version,config=excluded.config`,
      tenant,
      id,
      input.kind,
      input.remoteIdentity,
      input.label,
      input.status ?? "active",
      version,
      JSON.stringify(input.config),
      now,
    ),
    privateWrite,
    ...newQrzTemplate,
    ...(input.kind !== "lofi" && !existing
      ? [
          store.statement(
            "INSERT INTO cursors(tenant,connection,stream,cursor,generation,updated_at) SELECT tenant,id,?,json_object('mode','backfill','operations',json('{}'),'qsos',json('{}'),'accountId',json_extract(config,'$.accountId'),'requested',json('true')),0,? FROM connections WHERE tenant=? AND kind='lofi' AND status='active' ON CONFLICT(tenant,connection,stream) DO NOTHING",
            `rescan:${id}`,
            now,
            tenant,
          ),
        ]
      : []),
    store.statement(
      "UPDATE private_data SET expires_at=COALESCE(expires_at,?) WHERE tenant=? AND connection=? AND kind='credential' AND id!=?",
      now + 7 * 86_400_000,
      tenant,
      id,
      version,
    ),
    ...(identity
      ? [
          store.statement(
            "DELETE FROM auth_guards WHERE tenant=? AND purpose='connection'",
            tenant,
          ),
        ]
      : []),
  ]);
  return { id, version };
}
function safeConnection(connection: Connection) {
  return {
    id: connection.id,
    kind: connection.kind,
    label: connection.label,
    status: connection.status,
    config: JSON.parse(connection.config),
    cutover: connection.cutover,
    credentialConfigured: Boolean(connection.credential_version),
  };
}
function book(value: unknown): QrzBook {
  const input = object(value);
  const result = {
    bookId: text(input.bookId, "book ID", 100),
    stationCallsign: text(
      input.stationCallsign,
      "station callsign",
      20,
    ).toUpperCase(),
    startDate: text(input.startDate, "start date", 10),
    endDate: text(input.endDate, "end date", 10),
  };
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(result.startDate) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(result.endDate) ||
    result.startDate > result.endDate
  )
    throw new ConnectionError(400, "Invalid book date range");
  return result;
}
export interface ConnectionServices {
  fetcher?: typeof fetch;
}
export async function connectionRoute(
  request: Request,
  env: Env,
  identity: SessionIdentity | null,
  services: ConnectionServices = {},
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/api/connections" && !path.startsWith("/api/connections/"))
    return null;
  try {
    if (!identity) throw new AuthError(401, "Sign in with a passkey");
    const store = new Store(env.DB, keyring(env));
    if (request.method === "GET" && path === "/api/connections")
      return json({
        connections: (await store.connections(identity.tenant)).map(
          safeConnection,
        ),
      });
    if (request.method !== "POST")
      return json({ error: "Unknown connection endpoint" }, 404);
    await checkCsrf(request, env);
    requireRecent(identity);
    const input = await boundedJson(request, 400 * 1024);
    if (path === "/api/connections/lofi/start") {
      const email = normalizeEmail(input.email);
      const throttleKey = `lofi-approval:${identity.tenant}`;
      const now = Date.now();
      const allowed = await store
        .statement(
          `INSERT INTO rate_limits(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END WHERE reset_at<=? OR count<3 RETURNING count`,
          throttleKey,
          now + 900_000,
          now,
          now,
          now,
        )
        .first();
      if (!allowed)
        throw new ConnectionError(
          429,
          "Wait before requesting another LoFi approval email",
        );
      const credentials = { key: randomToken(), secret: randomToken() };
      const client = new LoFiClient(credentials, services.fetcher);
      await client.register();
      const pendingId = randomToken();
      const saved = await saveVerifiedConnection(
        store,
        identity.tenant,
        {
          kind: "lofi",
          remoteIdentity: `pending:${pendingId}`,
          label: "LoFi approval pending",
          status: "approval_pending",
          credential: client.credentialsSnapshot(),
          config: { approvalRequestedAt: now },
        },
        identity,
      );
      await store
        .statement(
          "UPDATE private_data SET expires_at=? WHERE tenant=? AND connection=? AND id=? AND kind='credential'",
          now + 86_400_000,
          identity.tenant,
          saved.id,
          saved.version,
        )
        .run();
      await client.requestApproval(email);
      return json(
        {
          id: saved.id,
          status: "approval_pending",
          message:
            "Approve LoFi access using its email, then finish linking here.",
        },
        201,
      );
    }
    if (path === "/api/connections/lofi/finish") {
      const id = text(input.id, "connection ID", 100);
      const pending = await store.connection(identity.tenant, id);
      if (
        pending?.kind !== "lofi" ||
        pending.status !== "approval_pending" ||
        !pending.credential_version
      )
        throw new ConnectionError(404, "Pending connection not found");
      const credentials = await store.private<LoFiCredentials>(
        identity.tenant,
        id,
        pending.credential_version,
        "credential",
      );
      if (!credentials)
        throw new ConnectionError(409, "Approval expired; start linking again");
      const client = new LoFiClient(credentials, services.fetcher);
      const account = await client.accounts();
      const accountId = text(account.uuid, "verified LoFi account ID", 100);
      const label =
        typeof account.name === "string"
          ? account.name.slice(0, 100)
          : `LoFi ${accountId}`;
      const saved = await saveVerifiedConnection(
        store,
        identity.tenant,
        {
          kind: "lofi",
          remoteIdentity: accountId,
          label,
          credential: client.credentialsSnapshot(),
          config: { accountId, replayBoundaryVerified: false },
        },
        identity,
      );
      await store.db.batch([
        store.statement(
          "DELETE FROM private_data WHERE tenant=? AND connection=?",
          identity.tenant,
          id,
        ),
        store.statement(
          "DELETE FROM connections WHERE tenant=? AND id=?",
          identity.tenant,
          id,
        ),
      ]);
      return json({
        id: saved.id,
        status: "active",
        accountId,
        message:
          "Linked. Read-only history reconciliation must establish export eligibility.",
      });
    }
    if (path === "/api/connections/qrz") {
      const apiKey = text(input.apiKey, "QRZ API key", 512);
      const expected = book(input.book);
      await new QrzClient(apiKey, { fetch: services.fetcher }).verifyBook(
        expected,
      );
      const saved = await saveVerifiedConnection(
        store,
        identity.tenant,
        {
          kind: "qrz",
          remoteIdentity: expected.bookId,
          label:
            typeof input.label === "string"
              ? text(input.label, "label", 100)
              : `QRZ ${expected.stationCallsign}`,
          credential: { apiKey },
          config: { ...expected, replacementContractVerified: false },
        },
        identity,
      );
      return json(
        {
          id: saved.id,
          status: "active",
          message:
            "QRZ book verified. Saving credentials does not export contacts.",
        },
        201,
      );
    }
    if (path === "/api/connections/lotw") {
      const encoded = text(input.p12, "PKCS#12 base64", 360_000);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0)
        throw new ConnectionError(400, "Invalid PKCS#12 base64");
      if (typeof input.password !== "string" || input.password.length > 1024)
        throw new ConnectionError(400, "Invalid PKCS#12 password");
      const rootsInput: unknown = JSON.parse(env.LOTW_TRUST_ROOTS_JSON);
      if (
        !Array.isArray(rootsInput) ||
        rootsInput.length > 8 ||
        rootsInput.some((value) => typeof value !== "string")
      )
        throw new ConnectionError(503, "LoTW trust configuration is invalid");
      const roots = rootsInput as string[];
      const statusClient = new LotwClient(null, { fetcher: services.fetcher });
      const signing = await importPkcs12(
        new Uint8Array(Buffer.from(encoded, "base64")),
        input.password,
        {
          trustedRoots: roots,
          certificateStatus: (serial) => statusClient.certificateStatus(serial),
        },
      );
      let query: { username: string; password: string } | undefined;
      if (input.query) {
        const value = object(input.query);
        query = {
          username: text(value.username, "LoTW query username", 100),
          password: (() => {
            if (
              typeof value.password !== "string" ||
              !value.password.length ||
              value.password.length > 1024 ||
              hasAsciiControl(value.password)
            )
              throw new ConnectionError(400, "Invalid LoTW query password");
            return value.password;
          })(),
        };
        const today = new Date().toISOString().slice(0, 10);
        await new LotwClient(query, { fetcher: services.fetcher }).query({
          startDate: today,
          endDate: today,
        });
      }
      // A signing certificate proves station authorization, not website account membership.
      // Preserve identity for certificate renewal without guessing an account association.
      const stationIdentity = `station:${signing.callsign}:${signing.dxcc}`;
      const remoteIdentity = query
        ? `query:${query.username}`
        : stationIdentity;
      const existing = await store
        .statement(
          "SELECT * FROM connections WHERE tenant=? AND kind='lotw' AND remote_identity=?",
          identity.tenant,
          remoteIdentity,
        )
        .first<Connection>();
      const old = existing?.credential_version
        ? await store.private<{
            signingCredentials?: SigningCredential[];
            signing?: SigningCredential;
          }>(
            identity.tenant,
            existing.id,
            existing.credential_version,
            "credential",
          )
        : null;
      const previous =
        old?.signingCredentials ?? (old?.signing ? [old.signing] : []);
      const signingCredentials = [
        ...previous.filter(
          (credential) =>
            credential.callsign !== signing.callsign ||
            credential.dxcc !== signing.dxcc,
        ),
        signing,
      ];
      if (signingCredentials.length > 8)
        throw new ConnectionError(
          400,
          "A LoTW account supports at most eight station certificates",
        );
      const stations: LotwStation[] = signingCredentials.map((credential) => ({
        callsign: credential.callsign,
        dxcc: credential.dxcc,
      }));
      const status = signingCredentials.every(
        (credential) => credential.trusted && credential.status === "unrevoked",
      )
        ? "active"
        : "needs_verification";
      const saved = await saveVerifiedConnection(
        store,
        identity.tenant,
        {
          kind: "lotw",
          remoteIdentity,
          label:
            typeof input.label === "string"
              ? text(input.label, "label", 100)
              : query
                ? `LoTW account ${query.username}`
                : `LoTW station ${signing.callsign}`,
          credential: { signingCredentials, ...(query ? { query } : {}) },
          status,
          config: {
            stations,
            readAccess: Boolean(query),
            certificates: signingCredentials.map(publicCertificate),
            signingConfiguration: "ferry-lotw-v2-us-ca-1",
          },
        },
        identity,
      );
      return json(
        {
          id: saved.id,
          status,
          certificate: publicCertificate(signing),
          message:
            status === "active"
              ? "Certificate verified. Historical eligibility and rollout gates still apply."
              : "Imported securely; configure verified trust roots and resolve certificate status before signing.",
        },
        201,
      );
    }
    if (
      path === "/api/connections/disable" ||
      path === "/api/connections/revoke"
    ) {
      const id = text(input.id, "connection ID", 100);
      if (!(await store.connection(identity.tenant, id)))
        throw new ConnectionError(404, "Connection not found");
      const revoked = path.endsWith("/revoke");
      const now = Date.now();
      await store.db.batch([
        sessionGuard(store, identity, now),
        store.statement(
          "UPDATE connections SET status=?,credential_version=CASE WHEN ? THEN NULL ELSE credential_version END WHERE tenant=? AND id=?",
          revoked ? "revoked" : "disabled",
          revoked ? 1 : 0,
          identity.tenant,
          id,
        ),
        store.statement(
          "UPDATE attempt_state SET state='cancelled',reason='connection disabled',updated_at=? WHERE tenant=? AND state='prepared' AND attempt IN(SELECT id FROM attempts WHERE tenant=? AND (destination=? OR source=?))",
          now,
          identity.tenant,
          identity.tenant,
          id,
          id,
        ),
        ...(revoked
          ? [
              store.statement(
                "DELETE FROM private_data WHERE tenant=? AND connection=? AND kind='credential'",
                identity.tenant,
                id,
              ),
            ]
          : []),
        store.statement(
          "DELETE FROM auth_guards WHERE tenant=? AND purpose='connection'",
          identity.tenant,
        ),
      ]);
      return json({
        id,
        status: revoked ? "revoked" : "disabled",
        message: "New work stopped. Existing vendor records remain retained.",
      });
    }
    return json({ error: "Unknown connection endpoint" }, 404);
  } catch (error) {
    if (error instanceof AuthError)
      return json(
        { error: error.message, ...(error.code ? { code: error.code } : {}) },
        error.status,
      );
    if (error instanceof ConnectionError)
      return json({ error: error.message }, error.status);
    // Vendor exceptions, input parsing and crypto errors may embed secrets; never echo them.
    return json(
      {
        code: "connection_verification_failed",
        error:
          "Connection could not be verified. Check credentials, approval, trust configuration and vendor availability.",
      },
      400,
    );
  }
}
function publicCertificate(signing: SigningCredential) {
  return {
    callsign: signing.callsign,
    dxcc: signing.dxcc,
    serial: signing.serial,
    validFrom: signing.validFrom,
    validTo: signing.validTo,
    qsoFrom: signing.qsoFrom,
    qsoTo: signing.qsoTo,
    trusted: signing.trusted,
    status: signing.status,
    statusCheckedAt: signing.statusCheckedAt,
  };
}
