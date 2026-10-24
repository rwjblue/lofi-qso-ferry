import type { Connection, Store } from "./store.ts";

export const SOURCE_PRESENCE_MAX_AGE_MS = 300_000;
export const SOURCE_PRESENCE_MAX_TARGETS = 64;
export interface SourcePresenceScope {
  tenant: string;
  source: string;
  accountId: string;
  readerPolicy: "all-clients-v1";
  policyEpoch: string;
  /** Stable stored credential ID; an in-place bearer renewal does not change it. */
  credentialVersion: string;
}
export interface SourcePresenceTarget {
  kind: "operation" | "qso";
  id: string;
  operationId: string | null;
  revision: string;
  syncedAtMillis: number;
  deleted: boolean;
  isEvent: boolean;
}
export interface SourcePresenceWitness {
  scope: SourcePresenceScope;
  target: SourcePresenceTarget;
  /** Conservative request start, no later than the successful transport start. */
  requestStartedAt: number;
}

/** Only canonical intake may execute this statement, inside its leased checkpoint. */
export function recordSourcePresence(
  store: Store,
  source: Connection,
  target: Pick<
    SourcePresenceTarget,
    "kind" | "id" | "revision" | "syncedAtMillis"
  >,
  policyEpoch: string,
  requestStartedAt: number,
): D1PreparedStatement {
  if (!Number.isSafeInteger(requestStartedAt) || requestStartedAt < 0)
    throw new Error("invalid_source_presence_time");
  return store.statement(
    "UPDATE source_work SET positive_observed_at=?,positive_policy_epoch=?,positive_credential_version=? WHERE tenant=? AND source=? AND kind=? AND id=? AND revision=? AND synced_at=? AND policy_seen_epoch=? AND (positive_observed_at IS NULL OR positive_observed_at<=?)",
    requestStartedAt,
    policyEpoch,
    source.credential_version,
    source.tenant,
    source.id,
    target.kind,
    target.id,
    target.revision,
    target.syncedAtMillis,
    policyEpoch,
    requestStartedAt,
  );
}

/**
 * Reuse original observation times for exact current versions. This is not a
 * complete dependency-set proof, upstream snapshot, or permission to export.
 */
export async function loadSourcePresence(
  store: Store,
  scope: SourcePresenceScope,
  targets: readonly SourcePresenceTarget[],
  now = Date.now(),
  maxAgeMs = SOURCE_PRESENCE_MAX_AGE_MS,
): Promise<(SourcePresenceWitness | null)[]> {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs < 0 ||
    targets.length > SOURCE_PRESENCE_MAX_TARGETS ||
    scope.readerPolicy !== "all-clients-v1" ||
    [
      scope.tenant,
      scope.source,
      scope.accountId,
      scope.policyEpoch,
      scope.credentialVersion,
    ].some((value) => typeof value !== "string" || !value) ||
    targets.some(
      (target) =>
        (target.kind !== "operation" && target.kind !== "qso") ||
        typeof target.id !== "string" ||
        !target.id ||
        typeof target.revision !== "string" ||
        !target.revision ||
        (target.operationId !== null &&
          (typeof target.operationId !== "string" || !target.operationId)) ||
        (target.kind === "operation" && target.operationId !== target.id) ||
        !Number.isSafeInteger(target.syncedAtMillis) ||
        target.syncedAtMillis < 0 ||
        typeof target.deleted !== "boolean" ||
        typeof target.isEvent !== "boolean",
    )
  )
    throw new Error("invalid_source_presence_request");
  if (!targets.length) return [];
  const rows = await store
    .statement(
      // CROSS JOIN keeps the bounded requested set ahead of source_work. Without
      // that ordering SQLite can scan every row in the current policy epoch.
      `SELECT CAST(requested.key AS INTEGER) AS position,w.positive_observed_at AS observed_at
     FROM json_each(?1) requested
     CROSS JOIN source_work w ON w.tenant=?2 AND w.source=?3 AND w.kind=json_extract(requested.value,'$.kind') AND w.id=json_extract(requested.value,'$.id')
     JOIN source_read_policy_ready ready ON ready.tenant=w.tenant AND ready.source=w.source AND ready.epoch=?4
     JOIN source_read_policies p ON p.tenant=ready.tenant AND p.source=ready.source AND p.epoch=ready.epoch
     JOIN connections c ON c.tenant=w.tenant AND c.id=w.source
     JOIN private_data credential ON credential.tenant=c.tenant AND credential.connection=c.id AND credential.id=c.credential_version AND credential.kind='credential'
     JOIN private_data body ON body.tenant=w.tenant AND body.connection=w.source AND body.id=w.private_id AND body.kind='source'
     WHERE p.reader_policy=?5 AND p.account_id=?6 AND p.source_remote=?6 AND c.remote_identity=?6
      AND c.credential_version=?7 AND w.positive_credential_version=?7
      AND w.policy_seen_epoch=ready.epoch AND w.positive_policy_epoch=ready.epoch
      AND w.operation_id IS json_extract(requested.value,'$.operationId')
      AND w.revision=json_extract(requested.value,'$.revision') AND w.synced_at=json_extract(requested.value,'$.syncedAtMillis')
      AND w.deleted=json_extract(requested.value,'$.deleted') AND w.is_event=json_extract(requested.value,'$.isEvent')
      AND typeof(w.positive_observed_at)='integer' AND w.positive_observed_at>=0 AND w.positive_observed_at>?8 AND w.positive_observed_at<=?9
      AND w.expires_at>?9 AND body.revoked_at IS NULL AND (body.expires_at IS NULL OR body.expires_at>?9)
      AND credential.revoked_at IS NULL AND (credential.expires_at IS NULL OR credential.expires_at>?9)`,
      JSON.stringify(targets),
      scope.tenant,
      scope.source,
      scope.policyEpoch,
      scope.readerPolicy,
      scope.accountId,
      scope.credentialVersion,
      now - Math.min(maxAgeMs, SOURCE_PRESENCE_MAX_AGE_MS),
      now,
    )
    .all<{ position: number; observed_at: number }>();
  const found = new Map(
    rows.results.map((row) => [row.position, row.observed_at]),
  );
  return targets.map((target, index) => {
    const observed = found.get(index);
    return observed === undefined
      ? null
      : {
          scope: { ...scope },
          target: { ...target },
          requestStartedAt: observed,
        };
  });
}
