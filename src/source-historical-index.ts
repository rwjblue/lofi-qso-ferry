import type { SourceRecord } from "./lofi.ts";
import { isEventRecord, isSourceDeleted } from "./projection.ts";
import {
  b64,
  canonical,
  type Envelope,
  open,
  randomToken,
  rewrap,
  seal,
  sha256,
  unb64,
} from "./security.ts";
import type { Store } from "./store.ts";

export interface SourceHistoricalIndexSnapshot {
  tenant: string;
  keyId: string;
  epoch: number;
  clock: number;
}
export interface SourceHistoricalIndexRow {
  scope: "exact" | "call" | "minute" | "unknown";
  source: string;
  qso: string;
  revision: string;
  syncedAt: number;
  privateId: string;
  bodyVersion: string;
}
export interface SourceHistoricalIndexKey {
  keyId: string;
  key: CryptoKey;
}
interface State {
  tenant: string;
  key_id: string;
  key_envelope: string | null;
  epoch: number;
  clock: number;
  rebuilding: number;
  cursor_source: string | null;
  cursor_qso: string | null;
}
interface IndexedRow {
  tenant: string;
  source: string;
  qso: string;
  revision: string;
  synced_at: number;
  private_id: string;
  body_version: string;
  scope: string;
  dirty: number;
  key_id: string;
  envelope: string | null;
  expires_at: number;
  payload_expires_at: number | null;
  revoked_at: number | null;
  current_body_version: string | null;
  current_revision: string | null;
  current_stamp: number | null;
  current_private_id: string | null;
}
const MAX_BACKFILL = 100;
const MAX_BACKFILL_BYTES = 4 * 1024 * 1024;
const MAX_CANDIDATES = 512;
const encoder = new TextEncoder();
function time(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return;
  if (typeof value === "string" && !value.trim()) return;
  const n = Number(value);
  return Number.isSafeInteger(n) &&
    n > 0 &&
    Number.isFinite(new Date(n).getTime())
    ? n
    : undefined;
}
function call(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const normalized = value.trim().toUpperCase();
  return normalized.length <= 32 &&
    /^[A-Z0-9]+(?:\/[A-Z0-9]+)*$/.test(normalized) &&
    /[A-Z]/.test(normalized) &&
    /[0-9]/.test(normalized)
    ? normalized
    : undefined;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
async function sign(key: CryptoKey, tuple: unknown): Promise<string> {
  return b64(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(canonical(tuple))),
    ),
  );
}
function keyIdentity(tenant: string) {
  return {
    tenant,
    connection: tenant,
    id: "historical-index",
    kind: "index-key",
    purpose: "storage",
  };
}
async function importIndexSecret(
  secret: unknown,
  tenant: string,
): Promise<SourceHistoricalIndexKey> {
  if (typeof secret !== "string" || unb64(secret).length !== 32)
    throw new Error("invalid_source_historical_key");
  const key = await crypto.subtle.importKey(
    "raw",
    unb64(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return { key, keyId: await sign(key, ["key-id", tenant]) };
}
async function decodeKey(
  store: Store,
  tenant: string,
  state: Pick<State, "key_id" | "key_envelope">,
) {
  if (!state.key_envelope) throw new Error("source_historical_key_unavailable");
  const envelope = JSON.parse(state.key_envelope) as Envelope;
  const key = await importIndexSecret(
    await open<unknown>(envelope, keyIdentity(tenant), store.keys),
    tenant,
  );
  if (key.keyId !== state.key_id)
    throw new Error("source_historical_key_mismatch");
  return { ...key, envelope };
}
/** Stable tenant secret: KEK rotation rewraps it without changing archived buckets.
 * Initialization is CAS; a losing worker reloads the winner, never publishes its key.
 */
export async function sourceHistoricalIndexKey(
  store: Store,
  tenant: string,
): Promise<SourceHistoricalIndexKey> {
  if (!tenant) throw new Error("invalid_source_historical_tenant");
  let state = await store
    .statement(
      "SELECT key_id,key_envelope FROM source_historical_state WHERE tenant=?",
      tenant,
    )
    .first<State>();
  if (!state?.key_envelope) {
    const secret = randomToken();
    const key = await importIndexSecret(secret, tenant);
    const envelope = canonical(
      await seal(secret, keyIdentity(tenant), store.keys),
    );
    await store.db.batch([
      store.statement(
        "INSERT INTO source_historical_state(tenant) VALUES(?) ON CONFLICT(tenant) DO NOTHING",
        tenant,
      ),
      store.statement(
        "UPDATE source_historical_state SET key_id=?,key_envelope=?,epoch=epoch+1,clock=clock+1,rebuilding=1,cursor_source=NULL,cursor_qso=NULL WHERE tenant=? AND key_id='' AND key_envelope IS NULL",
        key.keyId,
        envelope,
        tenant,
      ),
    ]);
    state = await store
      .statement(
        "SELECT key_id,key_envelope FROM source_historical_state WHERE tenant=?",
        tenant,
      )
      .first<State>();
  }
  if (!state) throw new Error("source_historical_key_unavailable");
  const key = await decodeKey(store, tenant, state);
  if (key.envelope.kek !== store.keys.active) {
    const wrapped = canonical(
      await rewrap(key.envelope, keyIdentity(tenant), store.keys),
    );
    await store
      .statement(
        "UPDATE source_historical_state SET key_envelope=?,clock=clock+1 WHERE tenant=? AND key_id=? AND key_envelope=?",
        wrapped,
        tenant,
        key.keyId,
        state.key_envelope,
      )
      .run();
  }
  return { key: key.key, keyId: key.keyId };
}
function activate(store: Store, tenant: string, keyId: string) {
  return store.statement(
    "SELECT 1 FROM source_historical_state WHERE tenant=? AND key_id=?",
    tenant,
    keyId,
  );
}
function snapshot(s: State): SourceHistoricalIndexSnapshot {
  return { tenant: s.tenant, keyId: s.key_id, epoch: s.epoch, clock: s.clock };
}
export async function ensureSourceHistoricalIndex(
  store: Store,
  tenant: string,
): Promise<SourceHistoricalIndexSnapshot> {
  const key = await sourceHistoricalIndexKey(store, tenant);
  const result = await store.db.batch<State>([
    activate(store, tenant, key.keyId),
    store.statement(
      "SELECT * FROM source_historical_state WHERE tenant=?",
      tenant,
    ),
  ]);
  return snapshot(result[1].results[0]);
}
async function bucket(
  key: SourceHistoricalIndexKey,
  tenant: string,
  raw: SourceRecord,
) {
  const worked = call(object(raw.their).call);
  const at = time(raw.startAtMillis);
  const minute = at === undefined ? null : Math.floor(at / 60_000);
  const scope =
    worked && minute !== null
      ? "exact"
      : worked
        ? "call"
        : minute !== null
          ? "minute"
          : "unknown";
  return {
    scope,
    hash: await sign(key.key, [
      "bucket",
      tenant,
      scope,
      worked ?? null,
      minute,
    ]),
  };
}
/** For a fresh body, the caller inserts its unique privateId in this same atomic checkpoint.
 * For retained bodies, expected bodyVersion is mandatory to prevent a stale publication.
 */
export async function sourceHistoricalPublication(
  store: Store,
  tenant: string,
  source: string,
  raw: SourceRecord,
  expected: {
    revision: string;
    syncedAt: number;
    privateId: string;
    bodyVersion: string | null;
  },
  key: SourceHistoricalIndexKey,
  now: number,
): Promise<D1PreparedStatement[]> {
  if (isEventRecord(raw) || isSourceDeleted(raw)) return [];
  const value = await bucket(key, tenant, raw);
  return [
    activate(store, tenant, key.keyId),
    store.statement(
      `UPDATE source_historical_index SET key_id=?1,scope=?2,bucket_hash=?3,body_version=(SELECT p.source_proof_version FROM private_data p WHERE p.tenant=?4 AND p.connection=?5 AND p.id=?8 AND p.kind='source'),dirty=0,checked_at=?10
   WHERE tenant=?4 AND source=?5 AND qso=?6 AND revision=?7 AND private_id=?8 AND synced_at=?9
    AND EXISTS(SELECT 1 FROM source_work w JOIN private_data p ON p.tenant=w.tenant AND p.connection=w.source AND p.id=w.private_id AND p.kind='source'
      WHERE w.tenant=?4 AND w.source=?5 AND w.kind='qso' AND w.id=?6 AND w.revision=?7 AND w.private_id=?8 AND w.synced_at=?9 AND w.is_event=0 AND w.deleted=0
       AND (?11 IS NULL OR p.source_proof_version=?11) AND p.revoked_at IS NULL AND w.expires_at>?10 AND (p.expires_at IS NULL OR p.expires_at>?10))
    AND EXISTS(SELECT 1 FROM source_historical_state WHERE tenant=?4 AND key_id=?1) RETURNING qso`,
      key.keyId,
      value.scope,
      value.hash,
      tenant,
      source,
      String(raw.uuid),
      expected.revision,
      expected.privateId,
      expected.syncedAt,
      now,
      expected.bodyVersion,
    ),
  ];
}
function coverage(alias: string): string {
  return `${alias}.rebuilding=0 AND NOT EXISTS(SELECT 1 FROM connections c INDEXED BY source_historical_active WHERE c.tenant=${alias}.tenant AND c.kind='lofi' AND c.status='active' AND EXISTS(SELECT 1 FROM source_historical_index i INDEXED BY source_historical_dirty WHERE i.tenant=c.tenant AND i.source=c.id AND i.dirty=1))`;
}
/** Compose this with per-candidate current retention/context and inventory guards. */
export function sourceHistoricalIndexGuard(s: SourceHistoricalIndexSnapshot): {
  sql: string;
  params: (string | number | null)[];
} {
  return {
    sql: `EXISTS(SELECT 1 FROM source_historical_state h WHERE h.tenant=? AND h.key_id=? AND h.epoch=? AND h.clock=? AND ${coverage("h")})`,
    params: [s.tenant, s.keyId, s.epoch, s.clock],
  };
}
export type SourceHistoricalIndexLookup = {
  status: "ready" | "held";
  reason?:
    | "index_uninitialized"
    | "index_key_unavailable"
    | "index_incomplete"
    | "candidate_bound"
    | "index_changed";
  snapshot?: SourceHistoricalIndexSnapshot;
  rows: SourceHistoricalIndexRow[];
};
/** No source-body reads: bounded equality probes of HMAC buckets only. */
export async function lookupSourceHistoricalIndex(
  store: Store,
  tenant: string,
  input: {
    workedCall: string;
    startMs: number;
    endMs: number;
    limit?: number;
    now?: number;
  },
): Promise<SourceHistoricalIndexLookup> {
  const worked = call(input.workedCall);
  const limit = input.limit ?? 128;
  if (
    !worked ||
    !Number.isSafeInteger(input.startMs) ||
    !Number.isSafeInteger(input.endMs) ||
    input.startMs <= 0 ||
    input.endMs < input.startMs ||
    input.endMs - input.startMs > 122 * 60_000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_CANDIDATES
  )
    throw new Error("invalid_source_historical_lookup");
  const state = await store
    .statement(
      `SELECT *,(${coverage("h")}) AS covered FROM source_historical_state h WHERE tenant=?`,
      tenant,
    )
    .first<State & { covered: number }>();
  if (!state?.key_id || !state.key_envelope)
    return { status: "held", reason: "index_uninitialized", rows: [] };
  let key: SourceHistoricalIndexKey;
  try {
    key = await decodeKey(store, tenant, state);
  } catch {
    return { status: "held", reason: "index_key_unavailable", rows: [] };
  }
  const captured = snapshot(state);
  if (!state.covered)
    return {
      status: "held",
      reason: "index_incomplete",
      snapshot: captured,
      rows: [],
    };
  const hashes = [
    await sign(key.key, ["bucket", tenant, "call", worked, null]),
    await sign(key.key, ["bucket", tenant, "unknown", null, null]),
  ];
  for (
    let minute = Math.floor(input.startMs / 60_000);
    minute <= Math.floor(input.endMs / 60_000);
    minute++
  )
    hashes.push(
      await sign(key.key, ["bucket", tenant, "exact", worked, minute]),
      await sign(key.key, ["bucket", tenant, "minute", null, minute]),
    );
  const rows = (
    await store
      .statement(
        `SELECT i.source,i.qso,i.revision,i.synced_at AS syncedAt,i.private_id AS privateId,i.body_version AS bodyVersion,i.scope
    FROM json_each(?1) requested CROSS JOIN source_historical_index i INDEXED BY source_historical_bucket ON i.tenant=?2 AND i.key_id=?3 AND i.bucket_hash=requested.value
    JOIN connections c ON c.tenant=i.tenant AND c.id=i.source WHERE c.kind='lofi' AND c.status='active' AND i.dirty=0 LIMIT ?4`,
        JSON.stringify(hashes),
        tenant,
        key.keyId,
        limit + 1,
      )
      .all<SourceHistoricalIndexRow & { scope: string }>()
  ).results;
  const guard = sourceHistoricalIndexGuard(captured);
  if (
    !(await store
      .statement(`SELECT 1 AS ok WHERE ${guard.sql}`, ...guard.params)
      .first())
  )
    return {
      status: "held",
      reason: "index_changed",
      snapshot: captured,
      rows: [],
    };
  if (rows.length > limit)
    return {
      status: "held",
      reason: "candidate_bound",
      snapshot: captured,
      rows: [],
    };
  // Partial/unknown keys are included, never discarded. The reverse projector
  // may exclude a proven test operation, but must hold unknown contacts.
  return { status: "ready", snapshot: captured, rows };
}

/** Bounded local backfill; never-indexed missing bodies remain dirty and held.
 * Published unavailable bodies keep opaque buckets, blocking only their neighbors. */
export async function backfillSourceHistoricalIndex(
  store: Store,
  tenant: string,
  options: { limit?: number; now?: number } = {},
): Promise<{
  examined: number;
  published: number;
  held: number;
  rebuilding: boolean;
}> {
  const limit = options.limit ?? 50,
    now = options.now ?? Date.now();
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_BACKFILL ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    throw new Error("invalid_source_historical_backfill");
  const key = await sourceHistoricalIndexKey(store, tenant);
  const initial = await store.db.batch<State>([
    activate(store, tenant, key.keyId),
    store.statement(
      "SELECT * FROM source_historical_state WHERE tenant=?",
      tenant,
    ),
  ]);
  const state = initial[1].results[0];
  const rows = (
    await store
      .statement(
        `WITH page AS (SELECT i.*,p.envelope,p.expires_at AS payload_expires_at,p.revoked_at,p.source_proof_version AS current_body_version,w.expires_at,w.revision AS current_revision,w.synced_at AS current_stamp,w.private_id AS current_private_id
   FROM source_historical_index i ${state.rebuilding ? "" : "INDEXED BY source_historical_backfill"}
   LEFT JOIN source_work w ON w.tenant=i.tenant AND w.source=i.source AND w.kind='qso' AND w.id=i.qso
   LEFT JOIN private_data p ON p.tenant=w.tenant AND p.connection=w.source AND p.id=w.private_id AND p.kind='source'
   WHERE i.tenant=?1 AND ${state.rebuilding ? "(i.source,i.qso)>(?2,?3)" : "i.dirty=1 AND ?2 IS NULL AND ?3 IS NULL"}
   ORDER BY ${state.rebuilding ? "i.source,i.qso" : "i.checked_at,i.source,i.qso"} LIMIT ?4)
   SELECT tenant,source,qso,revision,synced_at,private_id,body_version,scope,dirty,key_id,expires_at,payload_expires_at,revoked_at,current_body_version,current_revision,current_stamp,current_private_id,
    CASE WHEN SUM(COALESCE(length(CAST(envelope AS BLOB)),0)) OVER(ORDER BY ${state.rebuilding ? "source,qso" : "checked_at,source,qso"} ROWS UNBOUNDED PRECEDING)<=?5 THEN envelope ELSE NULL END AS envelope
   FROM page ORDER BY ${state.rebuilding ? "source,qso" : "checked_at,source,qso"}`,
        tenant,
        state.rebuilding ? (state.cursor_source ?? "") : null,
        state.rebuilding ? (state.cursor_qso ?? "") : null,
        limit,
        MAX_BACKFILL_BYTES,
      )
      .all<IndexedRow>()
  ).results;
  const work: D1PreparedStatement[] = [];
  let previouslyPublished = 0;
  for (const row of rows) {
    // Canonical intake may already have published a row ahead of the rebuild
    // cursor. Its missing/expired body must not erase known localization.
    if (row.dirty === 0 && row.key_id === key.keyId) {
      previouslyPublished++;
      continue;
    }
    let available = false;
    try {
      if (
        !row.envelope ||
        !row.current_body_version ||
        row.revoked_at !== null ||
        row.expires_at <= now ||
        (row.payload_expires_at !== null && row.payload_expires_at <= now) ||
        row.current_revision !== row.revision ||
        row.current_stamp !== row.synced_at ||
        row.current_private_id !== row.private_id
      )
        throw new Error("unavailable");
      const raw = await open<SourceRecord>(
        JSON.parse(row.envelope) as Envelope,
        {
          tenant,
          connection: row.source,
          id: row.private_id,
          kind: "source",
          purpose: "storage",
        },
        store.keys,
      );
      const { syncedAtMillis: _stamp, ...inputs } = raw;
      if (
        String(raw.uuid) !== row.qso ||
        !Number.isSafeInteger(Number(raw.syncedAtMillis)) ||
        Number(raw.syncedAtMillis) < 0 ||
        Number(raw.syncedAtMillis) > row.synced_at ||
        isSourceDeleted(raw) ||
        isEventRecord(raw) ||
        (await sha256(canonical(inputs))) !== row.revision
      )
        throw new Error("inconsistent");
      const statements = await sourceHistoricalPublication(
        store,
        tenant,
        row.source,
        raw,
        {
          revision: row.revision,
          syncedAt: row.synced_at,
          privateId: row.private_id,
          bodyVersion: row.current_body_version,
        },
        key,
        now,
      );
      work.push(statements[1]);
      available = true;
    } catch {
      // Unavailable or inconsistent bodies remain dirty; never infer absence.
    }
    work.push(
      store.statement(
        "UPDATE source_historical_index SET checked_at=?,dirty=CASE WHEN ? THEN dirty ELSE 1 END WHERE tenant=? AND source=? AND qso=? AND revision=? AND private_id=? AND synced_at=?",
        now,
        Number(available),
        tenant,
        row.source,
        row.qso,
        row.revision,
        row.private_id,
        row.synced_at,
      ),
    );
  }
  if (state.rebuilding) {
    const last = rows.at(-1);
    work.push(
      store.statement(
        "UPDATE source_historical_state SET cursor_source=?,cursor_qso=?,rebuilding=? WHERE tenant=? AND key_id=? AND epoch=? AND cursor_source IS ? AND cursor_qso IS ? AND rebuilding=1",
        last?.source ?? state.cursor_source,
        last?.qso ?? state.cursor_qso,
        rows.length < limit ? 0 : 1,
        tenant,
        key.keyId,
        state.epoch,
        state.cursor_source,
        state.cursor_qso,
      ),
    );
  }
  const result = work.length ? await store.db.batch(work) : [];
  const published = result.reduce(
    (n, r) =>
      n +
      r.results.filter(
        (row) =>
          row !== null && typeof row === "object" && Object.hasOwn(row, "qso"),
      ).length,
    0,
  );
  const current = await store
    .statement(
      "SELECT rebuilding FROM source_historical_state WHERE tenant=?",
      tenant,
    )
    .first<{ rebuilding: number }>();
  return {
    examined: rows.length,
    published,
    held: rows.length - published - previouslyPublished,
    rebuilding: !!current?.rebuilding,
  };
}
