import type { InventoryBodyArchive } from "./inventory-body-archive.ts";
import type { Envelope, Keyring } from "./security.ts";
import { canonical, open, randomToken, seal } from "./security.ts";

export interface Connection {
  tenant: string;
  id: string;
  kind: "lofi" | "qrz" | "lotw";
  remote_identity: string;
  label: string;
  status: string;
  credential_version: string | null;
  config: string;
  cutover: string | null;
}
export interface Lease {
  tenant: string;
  scope: string;
  token: string;
  fence: number;
  expires_at: number;
}
export interface LotwIdentityEvidence {
  remoteId: string;
  identity: Record<string, string>;
}
type SqlGuard = { sql: string; params: (string | number | null)[] };
export class Store {
  constructor(
    readonly db: D1Database,
    readonly keys: Keyring,
    readonly inventoryBodyArchive?: InventoryBodyArchive,
  ) {}
  statement(sql: string, ...params: (string | number | null)[]) {
    return this.db.prepare(sql).bind(...params);
  }
  async connection(tenant: string, id: string) {
    return this.statement(
      "SELECT * FROM connections WHERE tenant=? AND id=?",
      tenant,
      id,
    ).first<Connection>();
  }
  async connections(tenant: string) {
    return (
      await this.statement(
        "SELECT * FROM connections WHERE tenant=? ORDER BY created_at",
        tenant,
      ).all<Connection>()
    ).results;
  }
  async putPrivate(
    tenant: string,
    connection: string,
    id: string,
    kind: string,
    value: unknown,
    expires: number | null = null,
  ) {
    const envelope = await seal(
      value,
      { tenant, connection, id, kind, purpose: "storage" },
      this.keys,
    );
    return this.statement(
      "INSERT INTO private_data(tenant,connection,id,kind,envelope,created_at,expires_at) VALUES(?,?,?,?,?,?,?)",
      tenant,
      connection,
      id,
      kind,
      JSON.stringify(envelope),
      Date.now(),
      expires,
    );
  }
  async private<T>(
    tenant: string,
    connection: string,
    id: string,
    kind: string,
  ): Promise<T | null> {
    const row = await this.statement(
      "SELECT envelope FROM private_data WHERE tenant=? AND connection=? AND id=? AND kind=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)",
      tenant,
      connection,
      id,
      kind,
      Date.now(),
    ).first<{ envelope: string }>();
    return row
      ? open<T>(
          JSON.parse(row.envelope) as Envelope,
          { tenant, connection, id, kind, purpose: "storage" },
          this.keys,
        )
      : null;
  }
  claimStatement(
    tenant: string,
    scope: string,
    now = Date.now(),
    ttl = 60_000,
    { guard, token = randomToken() }: { guard?: SqlGuard; token?: string } = {},
  ) {
    const input = guard
      ? `SELECT ?,?,?,1,? WHERE ${guard.sql}`
      : "VALUES(?,?,?,1,?)";
    return this.statement(
      `INSERT INTO leases ${input} ON CONFLICT(tenant,scope) DO UPDATE SET token=excluded.token,fence=leases.fence+1,expires_at=excluded.expires_at WHERE leases.expires_at<=? RETURNING *`,
      tenant,
      scope,
      token,
      now + ttl,
      ...(guard?.params ?? []),
      now,
    );
  }
  async claim(
    tenant: string,
    scope: string,
    now = Date.now(),
    ttl = 60_000,
  ): Promise<Lease | null> {
    return this.claimStatement(tenant, scope, now, ttl).first<Lease>();
  }
  async release(lease: Lease) {
    await this.statement(
      "UPDATE leases SET expires_at=0 WHERE tenant=? AND scope=? AND token=? AND fence=?",
      lease.tenant,
      lease.scope,
      lease.token,
      lease.fence,
    ).run();
  }
  async saveTemplate(tenant: string, destination: string, config: unknown) {
    const id = randomToken();
    await this.db.batch([
      this.statement(
        "INSERT INTO templates VALUES(?,?,?,?,?)",
        tenant,
        destination,
        id,
        canonical(config),
        Date.now(),
      ),
      this.statement(
        "INSERT INTO active_templates VALUES(?,?,?) ON CONFLICT(tenant,destination) DO UPDATE SET version=excluded.version",
        tenant,
        destination,
        id,
      ),
    ]);
    return id;
  }
}
