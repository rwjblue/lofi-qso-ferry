import { canonical, open, randomToken, seal, sha256 } from "./security.ts";
import type { Envelope, Keyring } from "./security.ts";
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
export interface LedgerKey {
  tenant: string;
  source: string;
  qso: string;
  destination: string;
}
export interface Ledger extends LedgerKey {
  generation: string;
  source_hash: string;
  baseline_hash: string | null;
  remote_hash: string | null;
  sent_hash: string | null;
  state: string;
  reason: string | null;
  narrative: "unbound" | "template_bound" | "remote_preserved";
  template_version: string | null;
  remote_id: string | null;
  provenance: string;
  due_at: number;
  updated_at: number;
  confirmed: number;
}
export interface Lease {
  tenant: string;
  scope: string;
  token: string;
  fence: number;
  expires_at: number;
}
export class Store {
  constructor(
    readonly db: D1Database,
    readonly keys: Keyring,
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
  async claim(
    tenant: string,
    scope: string,
    now = Date.now(),
    ttl = 60_000,
  ): Promise<Lease | null> {
    return this.statement(
      `INSERT INTO leases VALUES(?,?,?,1,?) ON CONFLICT(tenant,scope) DO UPDATE SET token=excluded.token,fence=leases.fence+1,expires_at=excluded.expires_at WHERE leases.expires_at<=? RETURNING *`,
      tenant,
      scope,
      randomToken(),
      now + ttl,
      now,
    ).first<Lease>();
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
  async checkpoint(
    lease: Lease,
    connection: string,
    stream: string,
    expected: number,
    cursor: unknown,
    work: D1PreparedStatement[],
    now = Date.now(),
  ) {
    // A trigger aborts the entire batch if the cursor/lease compare-and-set loses.
    const guard = randomToken();
    await this.db.batch([
      this.statement(
        "INSERT INTO checkpoint_guards(id,tenant,scope,token,fence,now,connection,stream,expected) VALUES(?,?,?,?,?,?,?,?,?)",
        guard,
        lease.tenant,
        lease.scope,
        lease.token,
        lease.fence,
        now,
        connection,
        stream,
        expected,
      ),
      ...work,
      this.statement(
        `INSERT INTO cursors VALUES(?,?,?,?,1,?) ON CONFLICT(tenant,connection,stream) DO UPDATE SET cursor=excluded.cursor,generation=cursors.generation+1,updated_at=excluded.updated_at`,
        lease.tenant,
        connection,
        stream,
        JSON.stringify(cursor),
        now,
      ),
      this.statement("DELETE FROM checkpoint_guards WHERE id=?", guard),
    ]);
  }
  async ledger(key: LedgerKey) {
    return this.statement(
      "SELECT * FROM ledger WHERE tenant=? AND source=? AND qso=? AND destination=?",
      key.tenant,
      key.source,
      key.qso,
      key.destination,
    ).first<Ledger>();
  }
  async observe(
    key: LedgerKey,
    generation: string,
    inputHash: string,
    quietMinutes: number,
    deleted = false,
    now = Date.now(),
  ) {
    if (quietMinutes < 20 || quietMinutes > 60)
      throw new Error("quiet period must be 20–60 minutes");
    await this.statement(
      `INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,due_at,updated_at,state) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant,source,qso,destination) DO UPDATE SET generation=excluded.generation,source_hash=excluded.source_hash,due_at=CASE WHEN ledger.source_hash!=excluded.source_hash THEN excluded.due_at ELSE ledger.due_at END,updated_at=excluded.updated_at,state=CASE WHEN excluded.state='source_deleted' THEN 'source_deleted' WHEN ledger.source_hash!=excluded.source_hash AND ledger.state IN ('adopted_existing','delivered','observed','submitted') THEN 'changed' ELSE ledger.state END`,
      key.tenant,
      key.source,
      key.qso,
      key.destination,
      generation,
      inputHash,
      now + quietMinutes * 60_000,
      now,
      deleted ? "source_deleted" : "inventory_pending",
    ).run();
    if (deleted)
      await this.statement(
        `UPDATE attempt_state SET state='cancelled',updated_at=? WHERE tenant=? AND state='prepared' AND attempt IN(SELECT id FROM attempts WHERE tenant=? AND source=? AND qso=? AND destination=?)`,
        now,
        key.tenant,
        key.tenant,
        key.source,
        key.qso,
        key.destination,
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
  async stage(
    key: LedgerKey,
    generation: string,
    payload: unknown,
    credentialVersion: string,
    expectedTemplate: string | null,
    now = Date.now(),
  ) {
    const id = randomToken();
    const payloadHash = await sha256(canonical(payload));
    const encrypted = await this.putPrivate(
      key.tenant,
      key.destination,
      id,
      "outbox",
      payload,
      now + 7 * 86400_000,
    );
    await this.db.batch([
      this.statement(
        "INSERT INTO stage_guards(id,tenant,source,qso,destination,generation,template_version,now,credential_version) VALUES(?,?,?,?,?,?,?,?,?)",
        id,
        key.tenant,
        key.source,
        key.qso,
        key.destination,
        generation,
        expectedTemplate,
        now,
        credentialVersion,
      ),
      encrypted,
      this.statement(
        "INSERT INTO attempts SELECT ?,?,?,?,?,?,?,?,?,?,?,source_hash FROM ledger WHERE tenant=? AND source=? AND qso=? AND destination=?",
        key.tenant,
        id,
        key.source,
        key.qso,
        key.destination,
        generation,
        id,
        payloadHash,
        expectedTemplate,
        credentialVersion,
        now,
        key.tenant,
        key.source,
        key.qso,
        key.destination,
      ),
      this.statement(
        "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES(?,?,'prepared',?,?)",
        key.tenant,
        id,
        now,
        now,
      ),
      this.statement(
        "INSERT INTO attempt_events(tenant,attempt,state,at) VALUES(?,?,'prepared',?)",
        key.tenant,
        id,
        now,
      ),
      this.statement(
        "UPDATE ledger SET narrative=CASE WHEN narrative='unbound' AND ? IS NOT NULL THEN 'template_bound' ELSE narrative END,template_version=? WHERE tenant=? AND source=? AND qso=? AND destination=?",
        expectedTemplate,
        expectedTemplate,
        key.tenant,
        key.source,
        key.qso,
        key.destination,
      ),
      this.statement("DELETE FROM stage_guards WHERE id=?", id),
    ]);
    return id;
  }
  async claimAttempt(
    tenant: string,
    id: string,
    lease: Lease,
    now = Date.now(),
  ): Promise<boolean> {
    const result = await this.statement(
      `UPDATE attempt_state SET state='dispatching',dispatched_at=?,updated_at=?,lease_token=?,fence=? WHERE tenant=? AND attempt=? AND state='prepared' AND due_at<=? AND EXISTS(SELECT 1 FROM leases WHERE tenant=? AND scope=? AND token=? AND fence=? AND expires_at>?) AND EXISTS(SELECT 1 FROM attempts a JOIN connections c ON c.tenant=a.tenant AND c.id=a.destination JOIN private_data p ON p.tenant=a.tenant AND p.connection=a.destination AND p.id=a.credential_version AND p.kind='credential' WHERE a.tenant=? AND a.id=? AND c.status='active' AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?) AND c.credential_version=a.credential_version)`,
      now,
      now,
      lease.token,
      lease.fence,
      tenant,
      id,
      now,
      tenant,
      lease.scope,
      lease.token,
      lease.fence,
      now,
      tenant,
      id,
      now,
    ).run();
    return result.meta.changes === 1;
  }
  async resolve(
    tenant: string,
    id: string,
    lease: Lease,
    state: "uncertain" | "submitted" | "observed" | "delivered" | "rejected",
    remoteId: string | null = null,
    now = Date.now(),
  ) {
    const guard = randomToken();
    await this.db.batch([
      this.statement(
        "INSERT INTO resolution_guards VALUES(?,?,?,?,?,?)",
        guard,
        tenant,
        id,
        lease.token,
        lease.fence,
        now,
      ),
      this.statement(
        "UPDATE attempt_state SET state=?,remote_id=?,updated_at=? WHERE tenant=? AND attempt=?",
        state,
        remoteId,
        now,
        tenant,
        id,
      ),
      this.statement(
        "INSERT INTO attempt_events(tenant,attempt,state,at) VALUES(?,?,?,?)",
        tenant,
        id,
        state,
        now,
      ),
      this.statement(
        `UPDATE ledger SET state=CASE WHEN state='source_deleted' THEN state WHEN source_hash!=(SELECT source_hash FROM attempts WHERE tenant=? AND id=?) THEN 'changed' ELSE ? END,remote_id=COALESCE(?,remote_id),sent_hash=(SELECT payload_hash FROM attempts WHERE tenant=? AND id=?),baseline_hash=(SELECT source_hash FROM attempts WHERE tenant=? AND id=?) WHERE tenant=? AND (source,qso,destination) IN(SELECT source,qso,destination FROM attempts WHERE tenant=? AND id=?) AND ? IN ('delivered','observed','submitted')`,
        tenant,
        id,
        state,
        remoteId,
        tenant,
        id,
        tenant,
        id,
        tenant,
        tenant,
        id,
        state,
      ),
      this.statement(
        "DELETE FROM private_data WHERE tenant=? AND id=? AND kind='outbox' AND ? IN ('delivered','observed','rejected')",
        tenant,
        id,
        state,
      ),
      this.statement("DELETE FROM resolution_guards WHERE id=?", guard),
    ]);
  }
  async recover(now = Date.now()) {
    // A crash after dispatch can never become a blind retry.
    await this.statement(
      "UPDATE attempt_state SET state='uncertain',reason='dispatch lease expired; reconcile before retry',updated_at=? WHERE state='dispatching' AND NOT EXISTS(SELECT 1 FROM leases l WHERE l.tenant=attempt_state.tenant AND l.token=attempt_state.lease_token AND l.fence=attempt_state.fence AND l.expires_at>?)",
      now,
      now,
    ).run();
    await this.statement(
      "UPDATE attempt_state SET state='reconciliation_required',reason='private payload retention expired',updated_at=? WHERE state IN('uncertain','submitted','prepared') AND EXISTS(SELECT 1 FROM private_data p JOIN attempts a ON a.tenant=p.tenant AND a.id=p.id AND a.destination=p.connection WHERE p.tenant=attempt_state.tenant AND a.id=attempt_state.attempt AND p.kind='outbox' AND p.expires_at<=?)",
      now,
      now,
    ).run();
    await this.statement(
      "DELETE FROM private_data WHERE expires_at<=?",
      now,
    ).run();
  }
}
