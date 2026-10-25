import type { IntakeContact } from "./intake.ts";
import type { SourceRecord } from "./lofi.ts";
import {
  isEventRecord,
  isSourceDeleted,
  projectContact,
} from "./projection.ts";
import {
  canonical,
  type Envelope,
  open,
  randomToken,
  sha256,
} from "./security.ts";
import {
  SOURCE_PRESENCE_MAX_AGE_MS,
  type SourcePresenceScope,
  type SourcePresenceTarget,
  type SourcePresenceWitness,
} from "./source-presence-store.ts";
import type { Connection, Lease, LedgerKey, Store } from "./store.ts";

export interface SourceExportDependency {
  target: SourcePresenceTarget;
  privateId: string;
  bodyVersion: string;
  bodyCreatedAt: number;
  bodyExpiresAt: number | null;
  workExpiresAt: number;
}
export interface SourceExportSnapshot {
  scope: SourcePresenceScope;
  source: Connection;
  contact: IntakeContact & { reconciliationVersion: number };
  targets: SourcePresenceTarget[];
  dependencies: SourceExportDependency[];
  syncGeneration: number;
  contextGeneration: number;
  completeReadStartedAt: number | null;
  loadedAt: number;
}
export interface SourceExportProof {
  id: string;
  scope: SourcePresenceScope;
  qso: string;
  operationId: string | null;
  generation: string;
  reconciliationVersion: number;
  syncGeneration: number;
  contextGeneration: number;
  collectionFinishedAt: number;
  completeReadStartedAt: number;
  createdAt: number;
  expiresAt: number;
  dependencies: (SourceExportDependency & { requestStartedAt: number })[];
}
export interface SourceExportProofRequest {
  snapshot: SourceExportSnapshot;
  witnesses: readonly SourcePresenceWitness[];
  collectionFinishedAt: number;
}
export interface SourceExportProofAdmission {
  /** The enclosing source phase deadline, never a renewed collection window. */
  deadline?: number;
  /** Absolute caller authority cap; it may only shorten normal proof expiry. */
  expiresAtCap?: number;
  now?: () => number;
}
export type SourceExportAuthorizationMode =
  | "source_boundary"
  | "qrz_fresh_insert"
  | "lotw_fresh_insert";
export interface SourceExportAuthorization {
  proofId: string;
  scope: SourcePresenceScope;
  reconciliationVersion: number;
  /** Omission preserves the legacy source-boundary path, never fresh authority. */
  authorizationMode?: SourceExportAuthorizationMode;
}
export interface SourceExportProofIdentity {
  qso: string;
  generation: string;
  reconciliationVersion: number;
}
interface BodyRow {
  id: string;
  kind: "operation" | "qso";
  operation_id: string | null;
  private_id: string;
  revision: string;
  synced_at: number;
  deleted: number;
  is_event: number;
  state: string;
  expires_at: number;
  policy_seen_epoch: string | null;
  envelope: string | null;
  body_version: string | null;
  body_created_at: number | null;
  body_expires_at: number | null;
  body_revoked_at: number | null;
  reconciliation_version?: number;
}
interface Header extends Connection {
  sync_generation: number;
  context_generation: number;
  sync_cursor: string;
}
const bodyColumns = `w.*,b.envelope,b.source_proof_version AS body_version,b.created_at AS body_created_at,b.expires_at AS body_expires_at,b.revoked_at AS body_revoked_at`;
const bodyJoin = `LEFT JOIN private_data b ON b.tenant=w.tenant AND b.connection=w.source AND b.id=w.private_id AND b.kind='source'`;
const key = (target: Pick<SourcePresenceTarget, "kind" | "id">) =>
  canonical([target.kind, target.id]);
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function validScope(scope: SourcePresenceScope) {
  return (
    scope.readerPolicy === "all-clients-v1" &&
    [
      scope.tenant,
      scope.source,
      scope.accountId,
      scope.policyEpoch,
      scope.credentialVersion,
    ].every((value) => typeof value === "string" && value.length > 0)
  );
}

/**
 * A bounded, shared projection read, usable before collecting positives/draining.
 * Returned raw context stays in memory. It is not permission to export. Any
 * concurrent read race is checked again atomically when a proof is minted.
 */
export async function loadSourceExportSnapshots(
  store: Store,
  scope: SourcePresenceScope,
  qsos: readonly string[],
  now = Date.now(),
): Promise<SourceExportSnapshot[]> {
  if (
    !validScope(scope) ||
    !integer(now) ||
    qsos.length > 20 ||
    new Set(qsos).size !== qsos.length ||
    qsos.some((id) => typeof id !== "string" || !id)
  )
    throw new Error("invalid_source_export_snapshot_request");
  if (!qsos.length) return [];
  const result = await store.db.batch([
    store.statement(
      `SELECT c.*,ready.sync_generation,ready.sync_cursor,context.generation AS context_generation
       FROM source_read_policy_ready ready
       JOIN source_read_policies p ON p.tenant=ready.tenant AND p.source=ready.source
       JOIN connections c ON c.tenant=p.tenant AND c.id=p.source
       JOIN private_data credential ON credential.tenant=c.tenant AND credential.connection=c.id AND credential.kind='credential' AND credential.id=c.credential_version
       JOIN cursors context ON context.tenant=c.tenant AND context.connection=c.id AND context.stream='context'
       WHERE c.tenant=? AND c.id=? AND p.epoch=? AND p.reader_policy=? AND p.account_id=? AND c.credential_version=?
        AND credential.revoked_at IS NULL AND (credential.expires_at IS NULL OR credential.expires_at>?)
        AND json_valid(context.cursor) AND json_extract(context.cursor,'$.complete')=1 AND json_extract(context.cursor,'$.syncComplete')=1`,
      scope.tenant,
      scope.source,
      scope.policyEpoch,
      scope.readerPolicy,
      scope.accountId,
      scope.credentialVersion,
      now,
    ),
    store.statement(
      `SELECT ${bodyColumns},r.version AS reconciliation_version FROM json_each(?) requested
       CROSS JOIN source_work w ON w.tenant=? AND w.source=? AND w.kind='qso' AND w.id=requested.value
       ${bodyJoin} LEFT JOIN reconciliation_work r ON r.tenant=w.tenant AND r.source=w.source AND r.qso=w.id`,
      JSON.stringify(qsos),
      scope.tenant,
      scope.source,
    ),
  ]);
  const header = result[0].results[0] as unknown as Header | undefined;
  const selected = result[1].results as unknown as BodyRow[];
  if (
    !header ||
    selected.length !== qsos.length ||
    selected.some(
      (row) =>
        row.is_event !== 0 ||
        row.deleted !== 0 ||
        !["pending", "waiting"].includes(row.state),
    )
  )
    return [];
  const operations = [
    ...new Set(
      selected.flatMap((row) => (row.operation_id ? [row.operation_id] : [])),
    ),
  ];
  const context = operations.length
    ? (
        await store
          .statement(
            `SELECT ${bodyColumns} FROM json_each(?1) requested
     CROSS JOIN source_work w ON w.tenant=?2 AND w.source=?3 AND w.kind='operation' AND w.id=requested.value ${bodyJoin}
     UNION ALL SELECT ${bodyColumns} FROM json_each(?1) requested
     CROSS JOIN source_work w INDEXED BY source_context_members ON w.tenant=?2 AND w.source=?3 AND w.operation_id=requested.value AND w.kind='qso' AND w.is_event=1 ${bodyJoin}
     WHERE w.deleted=0 LIMIT 65`,
            JSON.stringify(operations),
            scope.tenant,
            scope.source,
          )
          .all<BodyRow>()
      ).results
    : [];
  const rows = [...selected, ...context];
  if (rows.length > 64 || new Set(rows.map(key)).size !== rows.length)
    return [];
  let bytes = 0;
  const decoded = new Map<
    string,
    { dependency: SourceExportDependency; raw: SourceRecord }
  >();
  for (const row of rows) {
    if (
      !row.envelope ||
      !row.body_version ||
      row.body_created_at === null ||
      row.body_revoked_at !== null ||
      row.expires_at <= now ||
      (row.body_expires_at !== null && row.body_expires_at <= now) ||
      row.policy_seen_epoch !== scope.policyEpoch ||
      row.deleted !== 0 ||
      (row.kind === "operation" && row.state !== "context")
    )
      return [];
    bytes += row.envelope.length;
    if (bytes > 2_097_152) return [];
    let raw: SourceRecord;
    try {
      raw = await open<SourceRecord>(
        JSON.parse(row.envelope) as Envelope,
        {
          tenant: scope.tenant,
          connection: scope.source,
          id: row.private_id,
          kind: "source",
          purpose: "storage",
        },
        store.keys,
      );
      const { syncedAtMillis: _stamp, ...inputs } = raw;
      // Retained identical bodies may have an older server stamp after metadata
      // advances; the semantic revision still must be exactly the current one.
      if (
        raw.uuid !== row.id ||
        !integer(raw.syncedAtMillis) ||
        raw.syncedAtMillis > row.synced_at ||
        (row.kind === "operation" && row.operation_id !== row.id) ||
        (await sha256(canonical(inputs))) !== row.revision ||
        isSourceDeleted(raw) ||
        (row.kind === "qso" &&
          (isEventRecord(raw) !== Boolean(row.is_event) ||
            (raw.operation ?? null) !== row.operation_id))
      )
        return [];
    } catch {
      return [];
    }
    const target: SourcePresenceTarget = {
      kind: row.kind,
      id: row.id,
      operationId: row.operation_id,
      revision: row.revision,
      syncedAtMillis: row.synced_at,
      deleted: false,
      isEvent: row.is_event === 1,
    };
    decoded.set(key(target), {
      raw,
      dependency: {
        target,
        privateId: row.private_id,
        bodyVersion: row.body_version,
        bodyCreatedAt: row.body_created_at,
        bodyExpiresAt: row.body_expires_at,
        workExpiresAt: row.expires_at,
      },
    });
  }
  const cursor = JSON.parse(header.sync_cursor) as {
    completeReadStartedAt?: unknown;
  };
  const snapshots: SourceExportSnapshot[] = [];
  for (const id of qsos) {
    const row = selected.find((entry) => entry.id === id);
    if (!row) return [];
    const qso = decoded.get(key(row));
    if (!qso) return [];
    const base = row.operation_id
      ? decoded.get(key({ kind: "operation", id: row.operation_id }))
      : undefined;
    if ((row.operation_id && !base) || !integer(row.reconciliation_version))
      return [];
    const events = context
      .filter(
        (entry) =>
          entry.kind === "qso" && entry.operation_id === row.operation_id,
      )
      .flatMap((entry) => {
        const value = decoded.get(key(entry));
        return value ? [value] : [];
      });
    const dependencies = [qso, ...(base ? [base] : []), ...events].map(
      (entry) => entry.dependency,
    );
    try {
      const contact = await projectContact(
        qso.raw,
        base?.raw ?? null,
        events.map((entry) => entry.raw),
        { operationComplete: true },
      );
      snapshots.push({
        scope: { ...scope },
        source: header,
        contact: {
          ...contact,
          contextGeneration: header.context_generation,
          reconciliationVersion: row.reconciliation_version,
        },
        targets: dependencies.map((entry) => entry.target),
        dependencies,
        syncGeneration: header.sync_generation,
        contextGeneration: header.context_generation,
        completeReadStartedAt: integer(cursor.completeReadStartedAt)
          ? cursor.completeReadStartedAt
          : null,
        loadedAt: now,
      });
    } catch {
      return [];
    }
  }
  return snapshots;
}

/** Mint all or none; observation times are never replaced by local read time. */
export async function mintSourceExportProofs(
  store: Store,
  requests: readonly SourceExportProofRequest[],
  lease: Lease,
  now = Date.now(),
  admission: SourceExportProofAdmission = {},
): Promise<SourceExportProof[]> {
  const expiresAtCap = admission.expiresAtCap;
  if (
    expiresAtCap !== undefined &&
    (!integer(expiresAtCap) || expiresAtCap <= now)
  )
    throw new Error("invalid_source_export_proof_expiry_cap");
  if (!integer(now) || requests.length > 20)
    throw new Error("invalid_source_export_proof_request");
  if (!requests.length) return [];
  const scope = { ...requests[0].snapshot.scope };
  lease = { ...lease };
  if (
    !validScope(scope) ||
    lease.tenant !== scope.tenant ||
    lease.scope !== `cycle:${scope.source}`
  )
    throw new Error("source_export_proof_lease_scope");
  const unique = new Set<string>();
  const contacts = new Set<string>();
  const proofs: SourceExportProof[] = [];
  for (const { snapshot, witnesses, collectionFinishedAt } of requests) {
    if (
      canonical(snapshot.scope) !== canonical(scope) ||
      contacts.has(snapshot.contact.id) ||
      !integer(snapshot.loadedAt) ||
      snapshot.loadedAt > now ||
      !integer(collectionFinishedAt) ||
      collectionFinishedAt > snapshot.loadedAt ||
      !integer(snapshot.completeReadStartedAt) ||
      snapshot.completeReadStartedAt < collectionFinishedAt ||
      snapshot.completeReadStartedAt > snapshot.loadedAt ||
      snapshot.dependencies.length < 1 ||
      snapshot.dependencies.length > 64
    )
      throw new Error("source_export_proof_snapshot_unavailable");
    contacts.add(snapshot.contact.id);
    const seen = new Set<string>();
    const dependencies = snapshot.dependencies.map((dependency) => {
      const id = key(dependency.target);
      if (seen.has(id)) throw new Error("duplicate_source_export_dependency");
      seen.add(id);
      unique.add(id);
      const matching = witnesses.filter(
        (witness) =>
          canonical(witness.scope) === canonical(scope) &&
          canonical(witness.target) === canonical(dependency.target) &&
          integer(witness.requestStartedAt) &&
          witness.requestStartedAt <= collectionFinishedAt &&
          witness.requestStartedAt <= now &&
          now - witness.requestStartedAt < SOURCE_PRESENCE_MAX_AGE_MS,
      );
      if (!matching.length)
        throw new Error("source_export_positive_unavailable");
      // The most recent genuine exact observation may be used; never a local refresh.
      return {
        ...dependency,
        target: { ...dependency.target },
        requestStartedAt: Math.max(
          ...matching.map((witness) => witness.requestStartedAt),
        ),
      };
    });
    const qso = dependencies.filter(
      (d) =>
        d.target.kind === "qso" &&
        d.target.id === snapshot.contact.id &&
        !d.target.isEvent,
    );
    const bases = dependencies.filter((d) => d.target.kind === "operation");
    if (
      qso.length !== 1 ||
      qso[0].target.operationId !== snapshot.contact.operationId ||
      dependencies.some(
        (d) =>
          d.target.deleted ||
          (d.target.kind === "qso" &&
            d.target.id !== snapshot.contact.id &&
            (!d.target.isEvent ||
              d.target.operationId !== snapshot.contact.operationId)),
      ) ||
      (snapshot.contact.operationId
        ? bases.length !== 1 ||
          bases[0].target.id !== snapshot.contact.operationId
        : bases.length !== 0)
    )
      throw new Error("source_export_dependency_set_invalid");
    const expiresAt = Math.min(
      expiresAtCap ?? Number.MAX_SAFE_INTEGER,
      ...dependencies.map((d) =>
        Math.min(
          d.requestStartedAt + SOURCE_PRESENCE_MAX_AGE_MS,
          d.workExpiresAt,
          d.bodyExpiresAt ?? Number.MAX_SAFE_INTEGER,
        ),
      ),
    );
    if (expiresAt <= now) throw new Error("source_export_positive_expired");
    proofs.push({
      id: randomToken(),
      scope: { ...scope },
      qso: snapshot.contact.id,
      operationId: snapshot.contact.operationId,
      generation: snapshot.contact.generation,
      reconciliationVersion: snapshot.contact.reconciliationVersion,
      syncGeneration: snapshot.syncGeneration,
      contextGeneration: snapshot.contextGeneration,
      collectionFinishedAt,
      completeReadStartedAt: snapshot.completeReadStartedAt,
      createdAt: now,
      expiresAt,
      dependencies,
    });
  }
  if (unique.size > 64) throw new Error("source_export_dependency_limit");
  const id = randomToken();
  const statements = [
    ...proofs.map((proof) =>
      store.statement(
        "INSERT INTO source_export_proofs(tenant,id,source,qso,created_at,expires_at,proof) VALUES(?,?,?,?,?,?,?)",
        scope.tenant,
        proof.id,
        scope.source,
        proof.qso,
        proof.createdAt,
        proof.expiresAt,
        canonical(proof),
      ),
    ),
    store.statement(
      `INSERT INTO source_export_proof_batch_guards(id,expected_count,actual_count)
       SELECT ?,?,count(*) FROM source_export_proofs_current p
       WHERE p.tenant=? AND p.id IN(SELECT value FROM json_each(?)) AND p.created_at<=? AND p.expires_at>?
        AND EXISTS(SELECT 1 FROM leases WHERE tenant=? AND scope=? AND token=? AND fence=? AND expires_at>MAX(?,CAST(unixepoch('subsec')*1000 AS INTEGER)))`,
      id,
      proofs.length,
      scope.tenant,
      JSON.stringify(proofs.map((proof) => proof.id)),
      now,
      now,
      lease.tenant,
      lease.scope,
      lease.token,
      lease.fence,
      now,
    ),
    store.statement(
      "DELETE FROM source_export_proof_batch_guards WHERE id=?",
      id,
    ),
  ];
  // Worker and D1 clocks are independent. Keep the complete proof and batch
  // immutable while D1 catches up to its creation time; never backdate evidence
  // or retry a batch whose outcome might already have committed.
  const clock = admission.now ?? Date.now;
  const startedAt = clock();
  const wallStartedAt = Date.now();
  let lastTime = startedAt;
  const deadline = Math.min(
    startedAt + 500,
    admission.deadline ?? Number.MAX_SAFE_INTEGER,
    lease.expires_at,
    ...proofs.map((proof) => proof.expiresAt),
  );
  const time = () => {
    const at = clock();
    const wallAt = Date.now();
    if (
      !integer(at) ||
      !integer(deadline) ||
      at < lastTime ||
      at < now ||
      at >= deadline ||
      wallAt < wallStartedAt ||
      wallAt - wallStartedAt >= 500
    )
      throw new Error("source_export_proof_admission_deadline");
    lastTime = at;
    return at;
  };
  for (let check = 0; check < 2; check++) {
    const at = time();
    const current = await store
      .statement(
        `SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) AS database_now
         FROM leases WHERE tenant=? AND scope=? AND token=? AND fence=?
          AND expires_at>MAX(?,CAST(unixepoch('subsec')*1000 AS INTEGER))`,
        lease.tenant,
        lease.scope,
        lease.token,
        lease.fence,
        at,
      )
      .first<{ database_now: number }>();
    const after = time();
    if (!current || !integer(current.database_now))
      throw new Error("source_export_proof_admission_unavailable");
    if (current.database_now >= Math.min(...proofs.map((p) => p.expiresAt)))
      throw new Error("source_export_proof_admission_expired");
    if (current.database_now >= now) {
      await store.db.batch(statements);
      return proofs;
    }
    const wait = now - current.database_now;
    if (
      check !== 0 ||
      wait >= deadline - after ||
      wait >= 500 - (Date.now() - wallStartedAt)
    )
      throw new Error("source_export_proof_clock_unavailable");
    await new Promise<void>((resolve) => setTimeout(resolve, wait));
  }
  throw new Error("source_export_proof_clock_unavailable");
}

/** Current immutable evidence; normal writes must also bind their attempt pin. */
export function sourceExportProofGuard(
  scope: SourcePresenceScope,
  proofId: string,
  identity: SourceExportProofIdentity,
  now = Date.now(),
): { sql: string; bindings: (string | number | null)[] } {
  if (
    !validScope(scope) ||
    !integer(now) ||
    !proofId ||
    !identity.qso ||
    !identity.generation ||
    !integer(identity.reconciliationVersion)
  )
    throw new Error("invalid_source_export_proof_guard");
  return {
    sql: `EXISTS(SELECT 1 FROM source_export_proofs_current p
     WHERE (p.tenant=? AND p.id=? AND json_extract(p.proof,'$.scope')=?)
      AND (p.qso=? AND json_extract(p.proof,'$.generation')=? AND json_extract(p.proof,'$.reconciliationVersion')=?)
      AND p.created_at<=? AND p.expires_at>?)`,
    bindings: [
      scope.tenant,
      proofId,
      canonical(scope),
      identity.qso,
      identity.generation,
      identity.reconciliationVersion,
      now,
      now,
    ],
  };
}
export async function loadCurrentSourceExportProof(
  store: Store,
  scope: SourcePresenceScope,
  proofId: string,
  identity: SourceExportProofIdentity,
  now = Date.now(),
): Promise<SourceExportProof | null> {
  const guard = sourceExportProofGuard(scope, proofId, identity, now);
  const row = await store
    .statement(
      `SELECT proof FROM source_export_proofs WHERE tenant=? AND id=? AND ${guard.sql}`,
      scope.tenant,
      proofId,
      ...guard.bindings,
    )
    .first<{ proof: string }>();
  return row ? (JSON.parse(row.proof) as SourceExportProof) : null;
}

/** Callers must schedule bounded retention cleanup; expiry alone does not delete. */
export async function purgeExpiredSourceExportProofs(
  store: Store,
  now = Date.now(),
  limit = 100,
): Promise<void> {
  if (!integer(now) || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("invalid_source_export_proof_cleanup");
  await store
    .statement(
      "DELETE FROM source_export_proofs WHERE (tenant,id) IN(SELECT tenant,id FROM source_export_proof_retention WHERE expires_at<=? ORDER BY expires_at,tenant,id LIMIT ?)",
      now,
      limit,
    )
    .run();
}

/** The stored logical identity, not a caller-provided policy epoch or credential. */
export async function loadCurrentSourcePresenceScope(
  store: Store,
  source: { tenant: string; id: string },
  now = Date.now(),
): Promise<SourcePresenceScope | null> {
  if (!integer(now)) throw new Error("invalid_source_presence_scope_time");
  const row = await store
    .statement(
      `SELECT p.tenant,p.source,p.account_id,p.reader_policy,p.epoch,c.credential_version
     FROM source_read_policy_ready ready
     JOIN source_read_policies p ON p.tenant=ready.tenant AND p.source=ready.source
     JOIN connections c ON c.tenant=p.tenant AND c.id=p.source
     JOIN private_data b ON b.tenant=c.tenant AND b.connection=c.id AND b.id=c.credential_version AND b.kind='credential'
     WHERE p.tenant=? AND p.source=? AND b.revoked_at IS NULL
      AND (b.expires_at IS NULL OR b.expires_at>MAX(?,CAST(unixepoch('subsec')*1000 AS INTEGER)))`,
      source.tenant,
      source.id,
      now,
    )
    .first<{
      tenant: string;
      source: string;
      account_id: string;
      reader_policy: "all-clients-v1";
      epoch: string;
      credential_version: string;
    }>();
  return row
    ? {
        tenant: row.tenant,
        source: row.source,
        accountId: row.account_id,
        readerPolicy: row.reader_policy,
        policyEpoch: row.epoch,
        credentialVersion: row.credential_version,
      }
    : null;
}

/** One bounded lookup; a new drain invalidates IDs from an older cohort. */
export async function loadCurrentSourceExportProofs(
  store: Store,
  scope: SourcePresenceScope,
  identities: readonly SourceExportProofIdentity[],
  now = Date.now(),
): Promise<(SourceExportProof | null)[]> {
  if (
    !validScope(scope) ||
    !integer(now) ||
    identities.length > 20 ||
    identities.some(
      (identity) =>
        !identity.qso ||
        !identity.generation ||
        !integer(identity.reconciliationVersion),
    )
  )
    throw new Error("invalid_source_export_proof_lookup");
  if (!identities.length) return [];
  const result = await store
    .statement(
      `SELECT requested.key AS position,(
      SELECT p.proof FROM source_export_proofs_current p
      WHERE p.tenant=?2 AND p.source=?3 AND p.qso=json_extract(requested.value,'$.qso')
       AND json_extract(p.proof,'$.scope')=?4 AND json_extract(p.proof,'$.generation')=json_extract(requested.value,'$.generation')
       AND json_extract(p.proof,'$.reconciliationVersion')=json_extract(requested.value,'$.reconciliationVersion')
       AND p.created_at<=?5 AND p.expires_at>?5 ORDER BY p.created_at DESC,p.id LIMIT 1
     ) AS proof FROM json_each(?1) requested ORDER BY CAST(requested.key AS INTEGER)`,
      JSON.stringify(identities),
      scope.tenant,
      scope.source,
      canonical(scope),
      now,
    )
    .all<{ position: number; proof: string | null }>();
  return result.results.map((row) =>
    row.proof ? (JSON.parse(row.proof) as SourceExportProof) : null,
  );
}

export function attemptSourceExportProofGuard(
  tenant: string,
  attempt: string,
  now = Date.now(),
  authorizationMode?: SourceExportAuthorizationMode,
): { sql: string; params: (string | number | null)[] } {
  if (!tenant || !attempt || !integer(now))
    throw new Error("invalid_attempt_source_export_proof_guard");
  return {
    sql: `EXISTS(SELECT 1 FROM attempt_source_export_proofs_current p WHERE p.tenant=? AND p.attempt=? AND p.created_at<=? AND p.expires_at>?${authorizationMode ? " AND p.authorization_mode=?" : ""})`,
    params: [
      tenant,
      attempt,
      now,
      now,
      ...(authorizationMode ? [authorizationMode] : []),
    ],
  };
}
export async function attemptSourceExportProofCurrent(
  store: Store,
  tenant: string,
  attempt: string,
  now = Date.now(),
  authorizationMode?: SourceExportAuthorizationMode,
): Promise<boolean> {
  const guard = attemptSourceExportProofGuard(
    tenant,
    attempt,
    now,
    authorizationMode,
  );
  return (
    (await store
      .statement(`SELECT ${guard.sql} AS current`, ...guard.params)
      .first<number>("current")) === 1
  );
}

/** Reads immutable intent even when its proof has expired; this is not authority. */
export async function attemptSourceExportAuthorizationMode(
  store: Store,
  tenant: string,
  attempt: string,
): Promise<SourceExportAuthorizationMode | null> {
  const mode = await store
    .statement(
      "SELECT authorization_mode FROM attempt_source_export_proofs WHERE tenant=? AND attempt=?",
      tenant,
      attempt,
    )
    .first<string>("authorization_mode");
  return mode === "source_boundary" ||
    mode === "qrz_fresh_insert" ||
    mode === "lotw_fresh_insert"
    ? mode
    : null;
}

/** Structural first-insert eligibility; consent and a current source proof remain mandatory. */
export function qrzFreshInsertEligibleGuard(
  key: LedgerKey,
  excludeAttempt?: string,
): { sql: string; params: (string | number | null)[] } {
  if (
    ![key.tenant, key.source, key.qso, key.destination].every(Boolean) ||
    excludeAttempt === ""
  )
    throw new Error("invalid_qrz_fresh_insert_guard");
  return excludeAttempt === undefined
    ? {
        sql: "EXISTS(SELECT 1 FROM qrz_fresh_insert_eligible l WHERE l.tenant=? AND l.source=? AND l.qso=? AND l.destination=?)",
        params: [key.tenant, key.source, key.qso, key.destination],
      }
    : {
        sql: "EXISTS(SELECT 1 FROM qrz_fresh_insert_ledgers l WHERE l.tenant=? AND l.source=? AND l.qso=? AND l.destination=? AND NOT EXISTS(SELECT 1 FROM qrz_fresh_insert_attempt_conflicts a WHERE a.tenant=l.tenant AND a.source=l.source AND a.qso=l.qso AND a.destination=l.destination AND a.id!=?))",
        params: [
          key.tenant,
          key.source,
          key.qso,
          key.destination,
          excludeAttempt,
        ],
      };
}

export async function qrzFreshInsertCurrent(
  store: Store,
  key: LedgerKey,
  excludeAttempt?: string,
): Promise<boolean> {
  const guard = qrzFreshInsertEligibleGuard(key, excludeAttempt);
  return (
    (await store
      .statement(`SELECT ${guard.sql} AS current`, ...guard.params)
      .first<number>("current")) === 1
  );
}

/** Structural first-insert eligibility; consent and a current source proof remain mandatory. */
export function lotwFreshInsertEligibleGuard(
  key: LedgerKey,
  excludeAttempt?: string,
): { sql: string; params: (string | number | null)[] } {
  if (
    ![key.tenant, key.source, key.qso, key.destination].every(Boolean) ||
    excludeAttempt === ""
  )
    throw new Error("invalid_lotw_fresh_insert_guard");
  return excludeAttempt === undefined
    ? {
        sql: "EXISTS(SELECT 1 FROM lotw_fresh_insert_eligible l WHERE l.tenant=? AND l.source=? AND l.qso=? AND l.destination=?)",
        params: [key.tenant, key.source, key.qso, key.destination],
      }
    : {
        sql: "EXISTS(SELECT 1 FROM lotw_fresh_insert_ledgers l WHERE l.tenant=? AND l.source=? AND l.qso=? AND l.destination=? AND NOT EXISTS(SELECT 1 FROM lotw_fresh_insert_attempt_conflicts a WHERE a.tenant=l.tenant AND a.source=l.source AND a.qso=l.qso AND a.destination=l.destination AND a.id!=?))",
        params: [
          key.tenant,
          key.source,
          key.qso,
          key.destination,
          excludeAttempt,
        ],
      };
}

export async function lotwFreshInsertCurrent(
  store: Store,
  key: LedgerKey,
  excludeAttempt?: string,
): Promise<boolean> {
  const guard = lotwFreshInsertEligibleGuard(key, excludeAttempt);
  return (
    (await store
      .statement(`SELECT ${guard.sql} AS current`, ...guard.params)
      .first<number>("current")) === 1
  );
}
