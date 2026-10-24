import type {
  SourcePresenceScope,
  SourcePresenceTarget,
} from "./source-presence-store.ts";
import type { Store } from "./store.ts";

/** Actual server stamps only; they position a read and grant no coverage. */
export async function sourcePresenceAnchors(
  store: Store,
  scope: SourcePresenceScope,
  targets: readonly SourcePresenceTarget[],
  now = Date.now(),
): Promise<{ kind: "operation" | "qso"; syncedAtMillis: number }[]> {
  if (
    targets.length > 64 ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
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
        !["operation", "qso"].includes(target.kind) ||
        !Number.isSafeInteger(target.syncedAtMillis) ||
        target.syncedAtMillis < 0,
    )
  )
    throw new Error("invalid_source_presence_anchor_request");
  if (!targets.length) return [];
  const rows = await store
    .statement(
      `SELECT json_extract(requested.value,'$.kind') AS kind,
       (SELECT w.synced_at FROM source_work w INDEXED BY source_presence_anchor
        WHERE w.tenant=?2 AND w.source=?3 AND w.policy_seen_epoch=?4
         AND w.kind=json_extract(requested.value,'$.kind')
         AND w.synced_at>json_extract(requested.value,'$.syncedAtMillis')
        ORDER BY w.synced_at LIMIT 1) AS stamp
       FROM json_each(?1) requested
       JOIN source_read_policy_ready ready ON ready.tenant=?2 AND ready.source=?3 AND ready.epoch=?4
       JOIN source_read_policies policy ON policy.tenant=ready.tenant AND policy.source=ready.source
       JOIN connections c ON c.tenant=ready.tenant AND c.id=ready.source
       JOIN private_data credential ON credential.tenant=c.tenant AND credential.connection=c.id AND credential.id=c.credential_version AND credential.kind='credential'
       WHERE policy.reader_policy=?5 AND policy.account_id=?6 AND policy.source_remote=?6
        AND c.credential_version=?7 AND credential.revoked_at IS NULL
        AND (credential.expires_at IS NULL OR credential.expires_at>?8)`,
      JSON.stringify(
        targets.map(({ kind, syncedAtMillis }) => ({ kind, syncedAtMillis })),
      ),
      scope.tenant,
      scope.source,
      scope.policyEpoch,
      scope.readerPolicy,
      scope.accountId,
      scope.credentialVersion,
      now,
    )
    .all<{ kind: "operation" | "qso"; stamp: number | null }>();
  const found = new Map<
    string,
    { kind: "operation" | "qso"; syncedAtMillis: number }
  >();
  for (const row of rows.results)
    if (row.stamp !== null)
      found.set(`${row.kind}:${row.stamp}`, {
        kind: row.kind,
        syncedAtMillis: row.stamp,
      });
  return [...found.values()];
}
