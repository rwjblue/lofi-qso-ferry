import type { DestinationIdentityClaim } from "./identity-claims.ts";
import {
  attemptLotwOwnershipWrite,
  type LotwOwnershipWrite,
  lotwPayloadIdentity,
  prepareLotwOwnershipBatch,
  prepareLotwReceiptOwnership,
} from "./lotw-ownership-bridge.ts";
import type { Envelope, Keyring } from "./security.ts";
import { canonical, open, randomToken, seal, sha256 } from "./security.ts";
import type { SourceExportAuthorization } from "./source-export-proofs.ts";
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
export interface StageInput {
  key: LedgerKey;
  generation: string;
  payload: unknown;
  credentialVersion: string;
  expectedTemplate: string | null;
  now?: number;
  transmittedHash?: string;
  lotwIdentityId?: string;
  priority?: "live" | "background";
  identity?: { claim: DestinationIdentityClaim; sourceVersion?: number };
  sourceProof?: SourceExportAuthorization;
}
export interface Ledger extends LedgerKey {
  generation: string;
  context_generation?: number | null;
  source_hash: string;
  baseline_hash: string | null;
  remote_hash: string | null;
  sent_hash: string | null;
  state: string;
  reason: string | null;
  narrative: "unbound" | "template_bound" | "remote_preserved";
  template_version: string | null;
  remote_id: string | null;
  /** A retained historical report; never an exact delivery receipt identity. */
  lotw_historical_association_id?: string | null;
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
export interface LotwIdentityEvidence {
  remoteId: string;
  identity: Record<string, string>;
}
export interface RetainedLotwIdentity extends LotwIdentityEvidence {
  firstEvidence: "adopted" | "submitted" | "uncertain" | "observed";
  recordedAt: number;
}
export const LOTW_PRIOR_IDENTITY_NOTICE =
  "LoTW identity changed; prior remote record may remain";
type SqlGuard = { sql: string; params: (string | number | null)[] };
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
  async historicalAssociationOnly(key: LedgerKey): Promise<boolean> {
    return Boolean(
      await this.statement(
        "SELECT 1 held FROM historical_association_write_blocks WHERE tenant=? AND source=? AND qso=? AND destination=? LIMIT 1",
        key.tenant,
        key.source,
        key.qso,
        key.destination,
      ).first(),
    );
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
  private async lotwIdentityPrefix(key: LedgerKey) {
    return `identity:${await sha256(canonical([key.source, key.qso]))}:`;
  }
  async lotwIdentityClaimGuard(
    key: LedgerKey,
    remoteId: string,
  ): Promise<SqlGuard> {
    const suffix = `:${remoteId}`;
    return {
      sql: "NOT EXISTS(SELECT 1 FROM private_data p WHERE p.tenant=? AND p.connection=? AND p.kind='lotw_identity' AND substr(p.id,-?)=? AND p.id!=? AND p.revoked_at IS NULL)",
      params: [
        key.tenant,
        key.destination,
        suffix.length,
        suffix,
        (await this.lotwIdentityPrefix(key)) + remoteId,
      ],
    };
  }
  /** Retain one encrypted tuple per actual identity, atomically with its evidence. */
  async lotwIdentityStatement(
    key: LedgerKey,
    evidence: LotwIdentityEvidence,
    firstEvidence: RetainedLotwIdentity["firstEvidence"],
    now: number,
    guard: SqlGuard,
    capture?: (envelope: string) => void,
  ): Promise<D1PreparedStatement> {
    const id = (await this.lotwIdentityPrefix(key)) + evidence.remoteId;
    const value: RetainedLotwIdentity = {
      ...evidence,
      firstEvidence,
      recordedAt: now,
    };
    const envelope = await seal(
      value,
      {
        tenant: key.tenant,
        connection: key.destination,
        id,
        kind: "lotw_identity",
        purpose: "storage",
      },
      this.keys,
    );
    capture?.(JSON.stringify(envelope));
    return this.statement(
      `INSERT INTO private_data(tenant,connection,id,kind,envelope,created_at) SELECT ?,?,?,'lotw_identity',?,? WHERE ${guard.sql} ON CONFLICT(tenant,connection,id,kind) DO NOTHING`,
      key.tenant,
      key.destination,
      id,
      JSON.stringify(envelope),
      now,
      ...guard.params,
    );
  }
  /** Bounded explicit review; the dashboard count does not decrypt these tuples. */
  async lotwIdentities(
    key: LedgerKey,
    limit = 20,
  ): Promise<RetainedLotwIdentity[]> {
    const prefix = await this.lotwIdentityPrefix(key);
    const rows = (
      await this.statement(
        "SELECT id,envelope FROM private_data WHERE tenant=? AND connection=? AND kind='lotw_identity' AND substr(id,1,?)=? AND revoked_at IS NULL ORDER BY created_at DESC,id LIMIT ?",
        key.tenant,
        key.destination,
        prefix.length,
        prefix,
        Math.max(
          1,
          Math.min(50, Math.floor(Number.isFinite(limit) ? limit : 20)),
        ),
      ).all<{ id: string; envelope: string }>()
    ).results;
    return Promise.all(
      rows.map((row) =>
        open<RetainedLotwIdentity>(
          JSON.parse(row.envelope) as Envelope,
          {
            tenant: key.tenant,
            connection: key.destination,
            id: row.id,
            kind: "lotw_identity",
            purpose: "storage",
          },
          this.keys,
        ),
      ),
    );
  }
  async lotwPriorIdentityCount(key: LedgerKey): Promise<number> {
    const prefix = await this.lotwIdentityPrefix(key);
    const count = await this.statement(
      "SELECT COUNT(*) n FROM private_data WHERE tenant=? AND connection=? AND kind='lotw_identity' AND substr(id,1,?)=? AND revoked_at IS NULL",
      key.tenant,
      key.destination,
      prefix.length,
      prefix,
    ).first<{ n: number }>();
    return Math.max(0, (count?.n ?? 0) - 1);
  }
  private async lotwResolutionStatements(
    tenant: string,
    attempt: string,
    identity: LotwIdentityEvidence | undefined,
    firstEvidence: RetainedLotwIdentity["firstEvidence"],
    now: number,
    guard: SqlGuard,
    capture?: (envelope: string) => void,
  ): Promise<D1PreparedStatement[]> {
    if (!identity) return [];
    const key = await this.statement(
      "SELECT a.tenant,a.source,a.qso,a.destination FROM attempts a JOIN connections c ON c.tenant=a.tenant AND c.id=a.destination AND c.kind='lotw' WHERE a.tenant=? AND a.id=?",
      tenant,
      attempt,
    ).first<LedgerKey>();
    if (!key)
      throw new Error("LoTW identity requires its tenant-bound attempt");
    const prefix = await this.lotwIdentityPrefix(key);
    return [
      await this.lotwIdentityStatement(
        key,
        identity,
        firstEvidence,
        now,
        guard,
        capture,
      ),
      this.statement(
        `UPDATE ledger SET confirmed=CASE WHEN remote_id IS NULL OR remote_id!=? THEN 0 ELSE confirmed END,reason=CASE WHEN state IN('source_deleted','retained_old_route') THEN reason WHEN EXISTS(SELECT 1 FROM private_data p WHERE p.tenant=? AND p.connection=? AND p.kind='lotw_identity' AND substr(p.id,1,?)=? AND p.id!=? AND p.revoked_at IS NULL) THEN ? ELSE reason END WHERE tenant=? AND source=? AND qso=? AND destination=? AND ${guard.sql}`,
        identity.remoteId,
        key.tenant,
        key.destination,
        prefix.length,
        prefix,
        prefix + identity.remoteId,
        LOTW_PRIOR_IDENTITY_NOTICE,
        key.tenant,
        key.source,
        key.qso,
        key.destination,
        ...guard.params,
      ),
    ];
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
  observation(
    key: LedgerKey,
    generation: string,
    inputHash: string,
    quietMinutes: number,
    deleted = false,
    now = Date.now(),
  ) {
    if (quietMinutes < 20 || quietMinutes > 60)
      throw new Error("quiet period must be 20–60 minutes");
    return this.statement(
      `INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,due_at,updated_at,state) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant,source,qso,destination) DO UPDATE SET generation=excluded.generation,source_hash=excluded.source_hash,confirmed=CASE WHEN ledger.source_hash!=excluded.source_hash THEN 0 ELSE ledger.confirmed END,due_at=CASE WHEN ledger.source_hash!=excluded.source_hash THEN excluded.due_at ELSE ledger.due_at END,updated_at=excluded.updated_at,state=CASE WHEN excluded.state='source_deleted' THEN 'source_deleted' WHEN ledger.source_hash!=excluded.source_hash AND ledger.state IN ('adopted_existing','delivered','observed','submitted') THEN 'changed' ELSE ledger.state END`,
      key.tenant,
      key.source,
      key.qso,
      key.destination,
      generation,
      inputHash,
      now + quietMinutes * 60_000,
      now,
      deleted ? "source_deleted" : "inventory_pending",
    );
  }
  async observe(
    key: LedgerKey,
    generation: string,
    inputHash: string,
    quietMinutes: number,
    deleted = false,
    now = Date.now(),
  ) {
    await this.observation(
      key,
      generation,
      inputHash,
      quietMinutes,
      deleted,
      now,
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
    transmittedHash?: string,
    lotwIdentityId?: string,
    priority?: "live" | "background",
    identity?: {
      claim: DestinationIdentityClaim;
      sourceVersion?: number;
    },
    sourceProof?: SourceExportAuthorization,
  ) {
    const [id] = await this.stageBatch([
      {
        key,
        generation,
        payload,
        credentialVersion,
        expectedTemplate,
        now,
        transmittedHash,
        lotwIdentityId,
        priority,
        identity,
        sourceProof,
      },
    ]);
    if (!id) throw new Error("stage produced no attempt");
    return id;
  }
  /** Stage at most 20 members under one ownership clock (203 native statements). */
  async stageBatch(supplied: readonly StageInput[]): Promise<string[]> {
    if (
      !supplied.length ||
      supplied.length > 20 ||
      new Set(supplied.map((x) => x.key.tenant)).size !== 1
    )
      throw new Error("invalid stage cohort");
    const inputs = structuredClone(supplied);
    const plans = [];
    for (const input of inputs) plans.push(await this.stagePlan(input));
    const writes = plans.flatMap((p) => (p.ownership ? [p.ownership] : []));
    const ownership = writes.length
      ? await prepareLotwOwnershipBatch(
          this,
          "stage",
          writes,
          Math.min(...inputs.map((x) => x.now ?? Date.now())),
        )
      : null;
    try {
      await this.db.batch([
        ...(ownership?.begin ?? []),
        ...plans.flatMap((p) => p.statements),
        ...(ownership?.finish ?? []),
      ]);
    } finally {
      await ownership?.release();
    }
    return plans.map((p) => p.id);
  }
  private async stagePlan(input: StageInput) {
    const {
      key,
      generation,
      payload,
      credentialVersion,
      expectedTemplate,
      now = Date.now(),
      transmittedHash,
      lotwIdentityId,
      priority,
      identity,
      sourceProof,
    } = input;
    const id = randomToken();
    const payloadHash = transmittedHash ?? (await sha256(canonical(payload)));
    const encrypted = await this.putPrivate(
      key.tenant,
      key.destination,
      id,
      "outbox",
      payload,
      now + 7 * 86400_000,
    );
    const ledger =
      identity?.claim.vendor === "lotw"
        ? await this.statement(
            "SELECT source_hash FROM ledger WHERE tenant=? AND source=? AND qso=? AND destination=?",
            key.tenant,
            key.source,
            key.qso,
            key.destination,
          ).first<{ source_hash: string }>()
        : null;
    const ownership: LotwOwnershipWrite | undefined =
      identity?.claim.vendor === "lotw"
        ? {
            ...key,
            attempt: id,
            generation,
            sourceHash: ledger?.source_hash ?? "",
            payloadHash,
            artifactHash: await sha256(canonical(payload)),
            sourceVersion: identity.sourceVersion,
            sourceProofId: sourceProof?.proofId,
            credentialVersion,
            identity: await lotwPayloadIdentity(payload),
          }
        : undefined;
    const statements = [
      this.statement(
        `INSERT INTO stage_guards(id,tenant,source,qso,destination,generation,template_version,now,credential_version${identity ? ",identity_vendor,identity_hash,identity_source_version,identity_lotw_owner_id" : ""}${sourceProof ? ",source_export_proof_id,source_export_scope,source_export_reconciliation_version" : ""}${sourceProof?.authorizationMode !== undefined ? ",authorization_mode" : ""}) VALUES(${Array.from({ length: 9 + (identity ? 4 : 0) + (sourceProof ? 3 : 0) + (sourceProof?.authorizationMode !== undefined ? 1 : 0) }, () => "?").join(",")})`,
        id,
        key.tenant,
        key.source,
        key.qso,
        key.destination,
        generation,
        expectedTemplate,
        now,
        credentialVersion,
        ...(identity
          ? [
              identity.claim.vendor,
              identity.claim.hash,
              identity.sourceVersion ?? null,
              identity.claim.vendor === "lotw"
                ? (await this.lotwIdentityPrefix(key)) + identity.claim.hash
                : null,
            ]
          : []),
        ...(sourceProof
          ? [
              sourceProof.proofId,
              canonical(sourceProof.scope),
              sourceProof.reconciliationVersion,
            ]
          : []),
        ...(sourceProof?.authorizationMode !== undefined
          ? [sourceProof.authorizationMode]
          : []),
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
        priority === undefined
          ? "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES(?,?,'prepared',?,?)"
          : "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at,priority) VALUES(?,?,'prepared',?,?,?)",
        key.tenant,
        id,
        now,
        now,
        ...(priority === undefined ? [] : [priority]),
      ),
      ...(identity
        ? [
            this.statement(
              "INSERT INTO attempt_identity_claims(tenant,attempt,destination,vendor,identity_hash,source,qso,source_version) VALUES(?,?,?,?,?,?,?,?)",
              key.tenant,
              id,
              key.destination,
              identity.claim.vendor,
              identity.claim.hash,
              key.source,
              key.qso,
              identity.sourceVersion ?? null,
            ),
          ]
        : []),
      this.statement(
        "INSERT INTO attempt_events(tenant,attempt,state,at) VALUES(?,?,'prepared',?)",
        key.tenant,
        id,
        now,
      ),
      this.statement(
        "UPDATE ledger SET narrative=CASE WHEN narrative='unbound' AND ? IS NOT NULL THEN 'template_bound' ELSE narrative END,template_version=?,confirmed=CASE WHEN ? IS NOT NULL AND (remote_id IS NULL OR remote_id!=?) THEN 0 ELSE confirmed END WHERE tenant=? AND source=? AND qso=? AND destination=?",
        expectedTemplate,
        expectedTemplate,
        lotwIdentityId ?? null,
        lotwIdentityId ?? null,
        key.tenant,
        key.source,
        key.qso,
        key.destination,
      ),
      this.statement("DELETE FROM stage_guards WHERE id=?", id),
    ];
    return { id, statements, ownership };
  }
  async claimAttempt(
    tenant: string,
    id: string,
    lease: Lease,
    now = Date.now(),
    lotwIdentity?: LotwIdentityEvidence,
    ownershipContext?: { payload: unknown; lease: Lease },
  ): Promise<boolean> {
    let privateEnvelope: string | undefined;
    const winner = lotwIdentity ? randomToken() : null;
    const identityStatements = await this.lotwResolutionStatements(
      tenant,
      id,
      lotwIdentity,
      "uncertain",
      now,
      {
        sql: "EXISTS(SELECT 1 FROM attempt_state WHERE tenant=? AND attempt=? AND state='dispatching' AND reason=?)",
        params: [tenant, id, winner],
      },
      (value) => {
        privateEnvelope = value;
      },
    );
    const ownership =
      lotwIdentity && ownershipContext
        ? await prepareLotwOwnershipBatch(
            this,
            "claim",
            [
              await attemptLotwOwnershipWrite(
                this,
                tenant,
                id,
                ownershipContext.payload,
                privateEnvelope,
              ),
            ],
            now,
            ownershipContext.lease,
          )
        : null;
    const results = await this.db.batch([
      ...(ownership?.begin ?? []),
      this.statement(
        `UPDATE attempt_state SET state='dispatching',dispatched_at=?,updated_at=?,lease_token=?,fence=?,reason=CASE WHEN ? IS NULL THEN reason ELSE ? END WHERE tenant=? AND attempt=? AND state='prepared' AND due_at<=? AND EXISTS(SELECT 1 FROM leases WHERE tenant=? AND scope=? AND token=? AND fence=? AND expires_at>?) AND EXISTS(SELECT 1 FROM attempts a JOIN connections c ON c.tenant=a.tenant AND c.id=a.destination JOIN connections src ON src.tenant=a.tenant AND src.id=a.source AND src.status='active' JOIN private_data p ON p.tenant=a.tenant AND p.connection=a.destination AND p.id=a.credential_version AND p.kind='credential' WHERE a.tenant=? AND a.id=? AND c.status='active' AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?) AND c.credential_version=a.credential_version) RETURNING attempt`,
        now,
        now,
        lease.token,
        lease.fence,
        winner,
        winner,
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
      ),
      ...identityStatements,
      ...(winner
        ? [
            this.statement(
              "UPDATE attempt_state SET reason=NULL WHERE tenant=? AND attempt=? AND reason=?",
              tenant,
              id,
              winner,
            ),
          ]
        : []),
      ...(ownership?.finish ?? []),
    ]);
    return results[ownership?.begin.length ?? 0].results.length === 1;
  }
  async resolve(
    tenant: string,
    id: string,
    lease: Lease,
    state: "uncertain" | "submitted" | "observed" | "delivered" | "rejected",
    remoteId: string | null = null,
    now = Date.now(),
    lotwIdentity?: LotwIdentityEvidence,
  ) {
    const guard = randomToken();
    const identityStatements = ["submitted", "uncertain", "observed"].includes(
      state,
    )
      ? await this.lotwResolutionStatements(
          tenant,
          id,
          lotwIdentity,
          state as "submitted" | "uncertain" | "observed",
          now,
          {
            sql: "EXISTS(SELECT 1 FROM resolution_guards WHERE id=? AND tenant=? AND attempt=?)",
            params: [guard, tenant, id],
          },
        )
      : [];
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
      ...identityStatements,
      this.statement(
        `UPDATE ledger SET state=CASE WHEN state IN('source_deleted','retained_old_route') THEN state WHEN source_hash!=(SELECT source_hash FROM attempts WHERE tenant=? AND id=?) THEN 'changed' ELSE ? END,remote_id=COALESCE(?,remote_id),sent_hash=(SELECT payload_hash FROM attempts WHERE tenant=? AND id=?),baseline_hash=(SELECT source_hash FROM attempts WHERE tenant=? AND id=?) WHERE tenant=? AND (source,qso,destination) IN(SELECT source,qso,destination FROM attempts WHERE tenant=? AND id=?) AND ? IN ('delivered','observed','submitted')`,
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
  /** Retry only when the coordinator knows no mutating request began. */
  async retryUnsent(
    tenant: string,
    id: string,
    lease: Lease,
    reason: string,
    now = Date.now(),
    minimumDueAt = 0,
  ): Promise<number> {
    if (tenant !== lease.tenant) throw new Error("tenant lease mismatch");
    const count =
      (
        await this.statement(
          "SELECT COUNT(*) n FROM attempt_events WHERE tenant=? AND attempt=? AND state='retry_scheduled'",
          tenant,
          id,
        ).first<{ n: number }>()
      )?.n ?? 0;
    const jitter = crypto.getRandomValues(new Uint32Array(1))[0] % 1000;
    const due = Math.max(
      minimumDueAt,
      now + Math.min(6 * 3600000, 30000 * 2 ** Math.min(count, 10)) + jitter,
    );
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
        "UPDATE attempt_state SET state='prepared',due_at=?,reason=?,lease_token=NULL,fence=NULL,updated_at=? WHERE tenant=? AND attempt=?",
        due,
        reason,
        now,
        tenant,
        id,
      ),
      this.statement(
        "INSERT INTO attempt_events(tenant,attempt,state,at,reason) VALUES(?,?,'retry_scheduled',?,?)",
        tenant,
        id,
        now,
        reason,
      ),
      this.statement("DELETE FROM resolution_guards WHERE id=?", guard),
    ]);
    return due;
  }
  /** Reconcile a durable uncertain/submitted artifact only after exact revision observation. */
  async resolveReconciled(
    tenant: string,
    id: string,
    lease: Lease,
    remoteId: string | null,
    now = Date.now(),
    observation?: {
      confirmed: boolean;
      data: unknown;
      identity?: LotwIdentityEvidence;
    },
  ): Promise<boolean> {
    if (lease.tenant !== tenant) return false;
    const winner = randomToken();
    let privateEnvelope: string | undefined;
    const identityStatements = await this.lotwResolutionStatements(
      tenant,
      id,
      observation?.identity,
      "observed",
      now,
      {
        sql: "EXISTS(SELECT 1 FROM attempt_state WHERE tenant=? AND attempt=? AND reason=?)",
        params: [tenant, id, winner],
      },
      (value) => {
        privateEnvelope = value;
      },
    );
    const destination = observation
      ? (
          await this.statement(
            "SELECT destination FROM attempts WHERE tenant=? AND id=?",
            tenant,
            id,
          ).first<{ destination: string }>()
        )?.destination
      : undefined;
    const identityId = `observation:${id}`;
    const identityEnvelope =
      observation && destination
        ? JSON.stringify(
            await seal(
              observation.data,
              {
                tenant,
                connection: destination,
                id: identityId,
                kind: "lotw_observation",
                purpose: "storage",
              },
              this.keys,
            ),
          )
        : null;
    let ownership:
      | Awaited<ReturnType<typeof prepareLotwReceiptOwnership>>
      | undefined;
    if (observation?.identity)
      try {
        ownership = await prepareLotwReceiptOwnership(
          this,
          tenant,
          id,
          observation.identity,
          privateEnvelope,
          now,
        );
      } catch {
        /* Facts survive incomplete/conflicting ownership; mapping remains held. */
      }
    let results: D1Result[];
    let withOwnership = Boolean(ownership);
    const execute = () =>
      this.db.batch([
        ...(withOwnership ? (ownership?.begin ?? []) : []),
        this.statement(
          `UPDATE attempt_state SET state='observed',lease_token=?,fence=?,updated_at=?,reason=?,remote_id=? WHERE tenant=? AND attempt=? AND state IN('uncertain','submitted','reconciliation_required') AND EXISTS(SELECT 1 FROM leases WHERE tenant=? AND scope=? AND token=? AND fence=? AND expires_at>?) AND EXISTS(SELECT 1 FROM attempts a JOIN private_data p ON p.tenant=a.tenant AND p.connection=a.destination AND p.id=a.payload_id AND p.kind='outbox' WHERE a.tenant=? AND a.id=? AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?)) RETURNING attempt`,
          lease.token,
          lease.fence,
          now,
          winner,
          remoteId,
          tenant,
          id,
          tenant,
          lease.scope,
          lease.token,
          lease.fence,
          now,
          tenant,
          id,
          now,
        ),
        ...identityStatements,
        this.statement(
          `INSERT INTO private_data(tenant,connection,id,kind,envelope,created_at) SELECT ?,?,?,'lotw_observation',?,? WHERE ? IS NOT NULL AND EXISTS(SELECT 1 FROM attempt_state WHERE tenant=? AND attempt=? AND reason=?) ON CONFLICT(tenant,connection,id,kind) DO NOTHING`,
          tenant,
          destination ?? null,
          identityId,
          identityEnvelope,
          now,
          identityEnvelope,
          tenant,
          id,
          winner,
        ),
        this.statement(
          `DELETE FROM private_data WHERE tenant=? AND kind='lotw_observation' AND ? IS NOT NULL AND (connection,id) IN(SELECT destination,'observation:'||id FROM attempts a WHERE a.tenant=? AND a.id!=? AND (a.source,a.qso,a.destination)=(SELECT source,qso,destination FROM attempts WHERE tenant=? AND id=?)) AND EXISTS(SELECT 1 FROM attempt_state WHERE tenant=? AND attempt=? AND reason=?)`,
          tenant,
          identityEnvelope,
          tenant,
          id,
          tenant,
          id,
          tenant,
          id,
          winner,
        ),
        ...(withOwnership ? (ownership?.account ?? []) : []),
        ...(withOwnership ? (ownership?.checks ?? []) : []),
        this.statement(
          `UPDATE ledger SET confirmed=CASE WHEN source_hash!=(SELECT source_hash FROM attempts WHERE tenant=? AND id=?) THEN 0 ELSE COALESCE(?,confirmed) END,state=CASE WHEN state IN('source_deleted','retained_old_route') THEN state WHEN source_hash!=(SELECT source_hash FROM attempts WHERE tenant=? AND id=?) THEN 'changed' ELSE 'observed' END,remote_id=COALESCE(?,remote_id),sent_hash=(SELECT payload_hash FROM attempts WHERE tenant=? AND id=?),baseline_hash=(SELECT source_hash FROM attempts WHERE tenant=? AND id=?) WHERE tenant=? AND (source,qso,destination) IN(SELECT source,qso,destination FROM attempts WHERE tenant=? AND id=?) AND EXISTS(SELECT 1 FROM attempt_state WHERE tenant=? AND attempt=? AND reason=?)`,
          tenant,
          id,
          observation ? (observation.confirmed ? 1 : 0) : null,
          tenant,
          id,
          remoteId,
          tenant,
          id,
          tenant,
          id,
          tenant,
          tenant,
          id,
          tenant,
          id,
          winner,
        ),
        this.statement(
          `INSERT INTO attempt_events(tenant,attempt,state,at) SELECT ?,?,'observed',? WHERE EXISTS(SELECT 1 FROM attempt_state WHERE tenant=? AND attempt=? AND reason=?)`,
          tenant,
          id,
          now,
          tenant,
          id,
          winner,
        ),
        this.statement(
          `DELETE FROM private_data WHERE tenant=? AND connection=(SELECT destination FROM attempts WHERE tenant=? AND id=?) AND id=(SELECT payload_id FROM attempts WHERE tenant=? AND id=?) AND kind='outbox' AND EXISTS(SELECT 1 FROM attempt_state WHERE tenant=? AND attempt=? AND reason=?)`,
          tenant,
          tenant,
          id,
          tenant,
          id,
          tenant,
          id,
          winner,
        ),
        this.statement(
          "UPDATE attempt_state SET reason=NULL WHERE tenant=? AND attempt=? AND reason=?",
          tenant,
          id,
          winner,
        ),
        ...(withOwnership ? (ownership?.finish ?? []) : []),
      ]);
    try {
      try {
        results = await execute();
      } catch (error) {
        if (
          !withOwnership ||
          !(error instanceof Error) ||
          !/^D1_ERROR: LoTW ownership (?:unavailable|changed|receipt unavailable|prior route unavailable|pin changed): SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?$/.test(
            error.message,
          )
        )
          throw error;
        // The native batch rolled back. Preserve the exact observed facts once
        // under their original receipt CAS; the mapping trigger holds projection.
        withOwnership = false;
        results = await execute();
      }
    } finally {
      await ownership?.release();
    }
    return (
      results[withOwnership ? (ownership?.begin.length ?? 0) : 0].results
        .length === 1
    );
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
    // Terminal outbox cleanup must not erase the original recovery copy. Its
    // original seven-day deadline still applies, including after quarantine.
    await this.statement(
      "DELETE FROM attempt_artifacts WHERE expires_at<=?",
      now,
    ).run();
  }
}
