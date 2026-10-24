import type { SyncState } from "./lofi.ts";
import { randomToken } from "./security.ts";
import type { Connection, Lease, Store } from "./store.ts";

export const SOURCE_READER_POLICY = "all-clients-v1";
export interface SourceReadPolicy {
  tenant: string;
  source: string;
  reader_policy: typeof SOURCE_READER_POLICY;
  epoch: string;
  source_remote: string;
  account_id: string;
  phase: "backfill" | "drain" | "quarantine" | "ready";
  started_at: number;
  completed_sync_generation: number | null;
  completed_at: number | null;
}
export type PolicySyncState = SyncState & {
  readerPolicy: typeof SOURCE_READER_POLICY;
  policyEpoch: string;
  accountId: string;
};
export interface SourceReadPolicyResult {
  policy: SourceReadPolicy;
  cursor: { cursor: PolicySyncState; generation: number };
  activated: boolean;
}

export function sourceReadPolicy(store: Store, tenant: string, source: string) {
  return store
    .statement(
      "SELECT * FROM source_read_policies WHERE tenant=? AND source=?",
      tenant,
      source,
    )
    .first<SourceReadPolicy>();
}

function accountId(source: Connection): string {
  let config: unknown;
  try {
    config = JSON.parse(source.config);
  } catch {
    throw new Error("source policy identity invalid");
  }
  const account =
    config && typeof config === "object" && "accountId" in config
      ? config.accountId
      : undefined;
  if (
    source.kind !== "lofi" ||
    source.status !== "active" ||
    typeof account !== "string" ||
    !account ||
    account !== source.remote_identity
  )
    throw new Error("source policy identity invalid");
  return account;
}

function savedState(text: string, policy: SourceReadPolicy): PolicySyncState {
  let state: PolicySyncState;
  try {
    state = JSON.parse(text) as PolicySyncState;
  } catch {
    throw new Error("source policy cursor invalid");
  }
  if (
    !state ||
    state.readerPolicy !== policy.reader_policy ||
    state.policyEpoch !== policy.epoch ||
    state.accountId !== policy.account_id ||
    !["backfill", "forward"].includes(state.mode) ||
    !state.operations ||
    typeof state.operations !== "object" ||
    Array.isArray(state.operations) ||
    !state.qsos ||
    typeof state.qsos !== "object" ||
    Array.isArray(state.qsos)
  )
    throw new Error("source policy cursor invalid");
  return state;
}

function validateLease(source: Connection, lease: Lease, now: number) {
  if (
    lease.tenant !== source.tenant ||
    lease.scope !== `poll:${source.id}:sync` ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    throw new Error("source policy lease invalid");
}

/**
 * Activate once under the caller's canonical poll lease. This never makes a
 * policy ready or provides source-boundary authority. Subsequent page/handoff
 * transactions must retain the tags and revalidate their own current guards.
 */
export async function ensureSourceReadPolicy(
  store: Store,
  source: Connection,
  lease: Lease,
  now = Date.now(),
): Promise<SourceReadPolicyResult> {
  const account = accountId(source);
  validateLease(source, lease, now);
  const snapshot = await store
    .statement(
      `SELECT p.*,s.cursor AS sync_cursor,s.generation AS sync_generation
       FROM connections c JOIN accounts a ON a.id=c.tenant
       JOIN leases l ON l.tenant=c.tenant AND l.scope=?3 AND l.token=?4 AND l.fence=?5 AND l.expires_at>?6
       LEFT JOIN source_read_policies p ON p.tenant=c.tenant AND p.source=c.id
       LEFT JOIN cursors s ON s.tenant=c.tenant AND s.connection=c.id AND s.stream='sync'
       WHERE c.tenant=?1 AND c.id=?2 AND c.kind='lofi' AND c.status='active' AND a.status='active'
        AND c.remote_identity=?7 AND json_valid(c.config)
        AND json_type(c.config,'$.accountId')='text' AND json_extract(c.config,'$.accountId')=?8`,
      source.tenant,
      source.id,
      lease.scope,
      lease.token,
      lease.fence,
      now,
      source.remote_identity,
      account,
    )
    .first<
      Partial<SourceReadPolicy> & {
        sync_cursor: string | null;
        sync_generation: number | null;
      }
    >();
  if (!snapshot) throw new Error("source policy identity or lease changed");
  const { sync_cursor, sync_generation, ...existing } = snapshot;
  if (existing.reader_policy !== null && existing.reader_policy !== undefined) {
    const policy = existing as SourceReadPolicy;
    if (
      policy.reader_policy !== SOURCE_READER_POLICY ||
      policy.source_remote !== source.remote_identity ||
      policy.account_id !== account ||
      sync_cursor === null ||
      sync_generation === null
    )
      throw new Error("source policy scope changed");
    return {
      policy,
      cursor: {
        cursor: savedState(sync_cursor, policy),
        generation: sync_generation,
      },
      activated: false,
    };
  }
  return replacePolicy(store, source, lease, sync_generation ?? 0, now);
}

export type SourceReadPolicyResetReason = "cursor_gap" | "context_expired";

/** Restart only the same logical source; stale epochs/cursors roll back fully. */
export async function resetSourceReadPolicy(
  store: Store,
  source: Connection,
  lease: Lease,
  expected: { epoch: string; generation: number },
  reason: SourceReadPolicyResetReason,
  now = Date.now(),
): Promise<SourceReadPolicyResult> {
  accountId(source);
  validateLease(source, lease, now);
  if (
    !expected.epoch ||
    !Number.isSafeInteger(expected.generation) ||
    expected.generation < 1 ||
    !["cursor_gap", "context_expired"].includes(reason)
  )
    throw new Error("source policy reset invalid");
  return replacePolicy(store, source, lease, expected.generation, now, {
    epoch: expected.epoch,
    reason,
  });
}

async function replacePolicy(
  store: Store,
  source: Connection,
  lease: Lease,
  generation: number,
  now: number,
  reset?: { epoch: string; reason: SourceReadPolicyResetReason },
): Promise<SourceReadPolicyResult> {
  const account = accountId(source);
  const policy: SourceReadPolicy = {
    tenant: source.tenant,
    source: source.id,
    reader_policy: SOURCE_READER_POLICY,
    epoch: randomToken(),
    source_remote: source.remote_identity,
    account_id: account,
    phase: "backfill",
    started_at: now,
    completed_sync_generation: null,
    completed_at: null,
  };
  const cursor: PolicySyncState = {
    mode: "backfill",
    operations: {},
    qsos: {},
    accountId: account,
    readerPolicy: SOURCE_READER_POLICY,
    policyEpoch: policy.epoch,
  };
  await store.checkpoint(
    lease,
    source.id,
    "sync",
    generation,
    cursor,
    [
      reset
        ? store.statement(
            `UPDATE source_read_policies SET epoch=?1,phase='backfill',started_at=?2,completed_sync_generation=NULL,completed_at=NULL
             WHERE tenant=?3 AND source=?4 AND epoch=?5 AND reader_policy=?6 AND source_remote=?7 AND account_id=?8`,
            policy.epoch,
            now,
            source.tenant,
            source.id,
            reset.epoch,
            policy.reader_policy,
            policy.source_remote,
            policy.account_id,
          )
        : store.statement(
            "INSERT INTO source_read_policies(tenant,source,reader_policy,epoch,source_remote,account_id,phase,started_at) VALUES(?,?,?,?,?,?,'backfill',?)",
            source.tenant,
            source.id,
            policy.reader_policy,
            policy.epoch,
            policy.source_remote,
            policy.account_id,
            now,
          ),
      store.statement(
        "INSERT INTO cursors(tenant,connection,stream,cursor,generation,updated_at) SELECT tenant,connection,?,json_object('stream','sync','code',?,'previous',json(cursor),'observedAt',?),1,? FROM cursors WHERE tenant=? AND connection=? AND stream='sync'",
        `gap:${policy.epoch}`,
        reset?.reason ?? "reader_policy_changed",
        now,
        now,
        source.tenant,
        source.id,
      ),
      store.statement(
        `INSERT INTO cursors(tenant,connection,stream,cursor,generation,updated_at)
         VALUES(?,?,'context','{"complete":false,"syncComplete":false,"coverage":"client-contract-only"}',1,?)
         ON CONFLICT(tenant,connection,stream) DO UPDATE SET
          cursor=json_set(cursors.cursor,'$.complete',json('false'),'$.syncComplete',json('false')),
          generation=cursors.generation+1,updated_at=excluded.updated_at`,
        source.tenant,
        source.id,
        now,
      ),
    ],
    now,
  );
  return {
    policy,
    cursor: { cursor, generation: generation + 1 },
    activated: true,
  };
}
