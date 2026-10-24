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
import type { Connection, Lease, Store } from "./store.ts";

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

// One predicate is shared by mint and subsequent use. Every supplied dependency
// is a keyed lookup; the reverse event check visits only this operation's events.
function currentPredicate(document: string, at: string): string {
  const p = (path: string) => `json_extract(${document},'$.${path}')`;
  const callerTime = at;
  // Admission/transport can delay a prepared statement. Never let its caller's
  // earlier timestamp extend authority past the database's execution time.
  at = `MAX(${at},CAST(unixepoch('subsec')*1000 AS INTEGER))`;
  const predicate = `${p("scope.readerPolicy")}='all-clients-v1'
   AND json_array_length(${document},'$.dependencies') BETWEEN 1 AND 64
   AND json_type(${document},'$.createdAt')='integer' AND json_type(${document},'$.expiresAt')='integer'
   AND json_type(${document},'$.collectionFinishedAt')='integer' AND ${p("collectionFinishedAt")}>0
   AND json_type(${document},'$.completeReadStartedAt')='integer'
   AND json_array_length(${document},'$.dependencies')=(SELECT count(DISTINCT json_array(json_extract(d.value,'$.target.kind'),json_extract(d.value,'$.target.id'))) FROM json_each(${document},'$.dependencies') d)
   AND ${p("createdAt")}<=${callerTime} AND ${p("expiresAt")}>${at}
   AND ${p("collectionFinishedAt")}<=${p("completeReadStartedAt")} AND ${p("completeReadStartedAt")}<=${p("createdAt")}
   AND EXISTS(SELECT 1 FROM source_read_policy_ready ready
    JOIN source_read_policies policy ON policy.tenant=ready.tenant AND policy.source=ready.source
    JOIN connections c ON c.tenant=ready.tenant AND c.id=ready.source
    JOIN private_data credential ON credential.tenant=c.tenant AND credential.connection=c.id AND credential.id=c.credential_version AND credential.kind='credential'
    JOIN cursors context ON context.tenant=c.tenant AND context.connection=c.id AND context.stream='context'
    WHERE ((ready.tenant=${p("scope.tenant")} AND ready.source=${p("scope.source")} AND ready.epoch=${p("scope.policyEpoch")})
     AND (policy.account_id=${p("scope.accountId")} AND policy.reader_policy=${p("scope.readerPolicy")}))
     AND ((c.credential_version=${p("scope.credentialVersion")} AND credential.revoked_at IS NULL AND (credential.expires_at IS NULL OR credential.expires_at>${at}))
     AND (ready.sync_generation=${p("syncGeneration")} AND json_type(ready.sync_cursor,'$.completeReadStartedAt')='integer' AND json_extract(ready.sync_cursor,'$.completeReadStartedAt')=${p("completeReadStartedAt")}))
     AND ((json_extract(ready.sync_cursor,'$.operations.complete')=1 AND json_extract(ready.sync_cursor,'$.qsos.complete')=1)
     AND (json_extract(ready.sync_cursor,'$.operations.cursor') IS NULL AND json_extract(ready.sync_cursor,'$.qsos.cursor') IS NULL))
     AND (context.generation=${p("contextGeneration")} AND json_valid(context.cursor) AND json_extract(context.cursor,'$.complete')=1 AND json_extract(context.cursor,'$.syncComplete')=1))
   AND EXISTS(SELECT 1 FROM reconciliation_work r WHERE r.tenant=${p("scope.tenant")} AND r.source=${p("scope.source")} AND r.qso=${p("qso")} AND r.version=${p("reconciliationVersion")})
   AND EXISTS(SELECT 1 FROM ledger l WHERE l.tenant=${p("scope.tenant")} AND l.source=${p("scope.source")} AND l.qso=${p("qso")} AND l.generation=${p("generation")} AND l.context_generation=${p("contextGeneration")} AND l.operation_id IS ${p("operationId")})
   AND EXISTS(SELECT 1 FROM source_work q WHERE q.tenant=${p("scope.tenant")} AND q.source=${p("scope.source")} AND q.id=${p("qso")} AND q.kind='qso' AND q.operation_id IS ${p("operationId")} AND q.deleted=0 AND q.is_event=0 AND q.state IN('pending','waiting'))
   AND (SELECT count(*) FROM json_each(${document},'$.dependencies') d WHERE json_extract(d.value,'$.target.kind')='qso' AND json_extract(d.value,'$.target.id')=${p("qso")} AND json_extract(d.value,'$.target.isEvent')=0)=1
   AND (SELECT count(*) FROM json_each(${document},'$.dependencies') d WHERE json_extract(d.value,'$.target.kind')='operation')=CASE WHEN ${p("operationId")} IS NULL THEN 0 ELSE 1 END
   AND NOT EXISTS(SELECT 1 FROM json_each(${document},'$.dependencies') d WHERE
     json_extract(d.value,'$.target.deleted') IS NOT 0
     OR json_extract(d.value,'$.target.kind') NOT IN('qso','operation')
     OR (json_extract(d.value,'$.target.kind')='operation' AND json_extract(d.value,'$.target.id') IS NOT ${p("operationId")})
     OR (json_extract(d.value,'$.target.kind')='qso' AND json_extract(d.value,'$.target.id')!=${p("qso")} AND (json_extract(d.value,'$.target.isEvent') IS NOT 1 OR json_extract(d.value,'$.target.operationId') IS NOT ${p("operationId")})))
   AND NOT EXISTS(SELECT 1 FROM json_each(${document},'$.dependencies') d WHERE
    json_type(d.value,'$.requestStartedAt') IS NOT 'integer' OR json_extract(d.value,'$.requestStartedAt')>${p("collectionFinishedAt")} OR json_extract(d.value,'$.requestStartedAt')<0
    OR ${p("expiresAt")}>json_extract(d.value,'$.requestStartedAt')+300000
    OR NOT EXISTS(SELECT 1 FROM source_work w JOIN private_data b ON b.tenant=w.tenant AND b.connection=w.source AND b.id=w.private_id AND b.kind='source'
     WHERE ((w.tenant=${p("scope.tenant")} AND w.source=${p("scope.source")} AND w.kind=json_extract(d.value,'$.target.kind') AND w.id=json_extract(d.value,'$.target.id'))
      AND (w.revision=json_extract(d.value,'$.target.revision') AND w.synced_at=json_extract(d.value,'$.target.syncedAtMillis')))
      AND ((w.operation_id IS json_extract(d.value,'$.target.operationId') AND w.deleted=0 AND w.is_event=json_extract(d.value,'$.target.isEvent'))
      AND (w.policy_seen_epoch=${p("scope.policyEpoch")} AND (w.kind!='operation' OR w.state='context')))
      AND ((w.private_id=json_extract(d.value,'$.privateId') AND w.expires_at=json_extract(d.value,'$.workExpiresAt') AND w.expires_at>${at})
      AND (b.source_proof_version=json_extract(d.value,'$.bodyVersion') AND b.created_at=json_extract(d.value,'$.bodyCreatedAt')))
      AND (b.expires_at IS json_extract(d.value,'$.bodyExpiresAt') AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>${at}))))
   AND NOT EXISTS(SELECT 1 FROM source_work e INDEXED BY source_context_members
    WHERE e.tenant=${p("scope.tenant")} AND e.source=${p("scope.source")} AND e.operation_id=${p("operationId")} AND e.kind='qso' AND e.is_event=1 AND e.deleted=0
     AND NOT EXISTS(SELECT 1 FROM json_each(${document},'$.dependencies') d WHERE json_extract(d.value,'$.target.kind')='qso' AND json_extract(d.value,'$.target.id')=e.id))`;
  // These fixed top-level clauses are separately indented from subquery ANDs.
  // Balance the tree so composition with other guards stays below D1's depth100.
  const clauses = predicate.split("\n   AND ");
  const balance = (items: string[]): string => {
    if (items.length === 1) return `(${items[0]})`;
    const middle = Math.floor(items.length / 2);
    return `(${balance(items.slice(0, middle))} AND ${balance(items.slice(middle))})`;
  };
  return balance(clauses);
}

/** Mint all or none; observation times are never replaced by local read time. */
export async function mintSourceExportProofs(
  store: Store,
  requests: readonly SourceExportProofRequest[],
  lease: Lease,
  now = Date.now(),
): Promise<SourceExportProof[]> {
  if (!integer(now) || requests.length > 20)
    throw new Error("invalid_source_export_proof_request");
  if (!requests.length) return [];
  const scope = requests[0].snapshot.scope;
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
  await store.db.batch([
    ...proofs.map((proof) =>
      store.statement(
        `WITH input(proof,checked_at) AS(VALUES(?,?)) INSERT INTO source_export_proofs(tenant,id,source,qso,created_at,expires_at,proof)
       SELECT json_extract(proof,'$.scope.tenant'),json_extract(proof,'$.id'),json_extract(proof,'$.scope.source'),json_extract(proof,'$.qso'),json_extract(proof,'$.createdAt'),json_extract(proof,'$.expiresAt'),proof FROM input
       WHERE ${currentPredicate("input.proof", "input.checked_at")} AND EXISTS(SELECT 1 FROM leases WHERE tenant=? AND scope=? AND token=? AND fence=? AND expires_at>MAX(input.checked_at,CAST(unixepoch('subsec')*1000 AS INTEGER)))`,
        canonical(proof),
        now,
        lease.tenant,
        lease.scope,
        lease.token,
        lease.fence,
      ),
    ),
    store.statement(
      "INSERT INTO source_export_proof_batch_guards(id,expected_count,actual_count) SELECT ?,?,count(*) FROM source_export_proofs WHERE tenant=? AND id IN(SELECT value FROM json_each(?))",
      id,
      proofs.length,
      scope.tenant,
      JSON.stringify(proofs.map((proof) => proof.id)),
    ),
    store.statement(
      "DELETE FROM source_export_proof_batch_guards WHERE id=?",
      id,
    ),
  ]);
  return proofs;
}

/** Composable SQL for later stage/dispatch integration; this module grants none. */
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
    // `now` is an already-validated integer literal. Keeping it out of another
    // correlated CTE avoids multiplying expression depth when guards compose.
    sql: `EXISTS(SELECT 1 FROM source_export_proofs p
     WHERE (p.tenant=? AND p.id=? AND json_extract(p.proof,'$.scope')=?)
      AND (p.qso=? AND json_extract(p.proof,'$.generation')=? AND json_extract(p.proof,'$.reconciliationVersion')=?)
      AND ${currentPredicate("p.proof", String(now))})`,
    bindings: [
      scope.tenant,
      proofId,
      canonical(scope),
      identity.qso,
      identity.generation,
      identity.reconciliationVersion,
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
      "DELETE FROM source_export_proofs WHERE (tenant,id) IN(SELECT tenant,id FROM source_export_proofs WHERE expires_at<=? ORDER BY expires_at,tenant,id LIMIT ?)",
      now,
      limit,
    )
    .run();
}
