import type { AdifRecord } from "./adif.ts";
import { historicalCandidates } from "./historical-matching.ts";
import { canonicalLotwIdentity, lotwRemoteIdentity } from "./reconcile.ts";
import {
  b64,
  canonical,
  type Envelope,
  open,
  seal,
  sha256,
  unb64,
} from "./security.ts";
import {
  type SourceHistoricalIndexKey,
  SourceHistoricalIndexKeyUnavailableError,
  sourceHistoricalIndexKey,
} from "./source-historical-index.ts";
import type { RetainedLotwIdentity, Store } from "./store.ts";

const MAX_INPUTS = 100;
const MAX_CANDIDATES = 128;
const MAX_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
interface Owner {
  tenant: string;
  destination: string;
  source: string;
  qso: string;
}
interface State {
  clock: number;
  key_id: string;
}
interface Input extends Owner {
  kind: "identity" | "claim" | "mapping" | "attempt" | "legacy";
  reference: string;
  exact_hash: string | null;
  version: number;
  evidence_id: string | null;
  envelope: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  oversized: number;
}
interface Evidence extends Owner {
  id: string;
  exact_hash: string;
  key_id: string;
  bucket: string;
  envelope: string;
}
export interface LotwOwnershipSnapshot {
  tenant: string;
  keyId: string;
  clock: number;
}
export interface LotwOwnershipCandidate extends Owner {
  evidenceId: string;
  /** Original validated tuple, never rounded or rewritten to the query identity. */
  evidence: RetainedLotwIdentity;
}
const noAuthority = {
  authoritative: false as const,
  requiresWriteBridge: true as const,
};
function bound(value: number | undefined, maximum: number) {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error("invalid_lotw_ownership_bound");
  return value;
}
function instant(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("invalid_lotw_ownership_time");
  return value;
}
const evidenceIdentity = (tenant: string, id: string) => ({
  tenant,
  connection: tenant,
  id,
  kind: "lotw-ownership",
  purpose: "storage",
});
async function sign(key: CryptoKey, values: unknown) {
  return b64(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(canonical(values))),
    ),
  );
}
async function bucket(
  key: CryptoKey,
  tenant: string,
  record: AdifRecord,
  minute: number,
) {
  return sign(key, [
    "lotw-ownership-v1",
    "station-call-minute",
    tenant,
    record.STATION_CALLSIGN.toUpperCase(),
    record.CALL.toUpperCase(),
    minute,
  ]);
}
// Exact receipt canonicalization stores absent optional propagation fields as
// empty strings. Omit only those empty optionals for the candidate-policy view;
// the encrypted original and its exact hash remain unchanged.
function comparisonRecord(record: AdifRecord): AdifRecord {
  return Object.fromEntries(
    Object.entries(record).filter(
      ([field, value]) =>
        value !== "" || (field !== "PROP_MODE" && field !== "SAT_NAME"),
    ),
  );
}
function interval(record: AdifRecord) {
  const comparable = comparisonRecord(record);
  const result = historicalCandidates("lotw", comparable, [comparable]);
  return result.state === "unique" ? result.candidates[0].time.source : null;
}
async function retained(value: unknown): Promise<RetainedLotwIdentity | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as RetainedLotwIdentity;
  if (
    typeof data.remoteId !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(data.remoteId) ||
    !["adopted", "submitted", "uncertain", "observed"].includes(
      data.firstEvidence,
    ) ||
    !Number.isSafeInteger(data.recordedAt) ||
    data.recordedAt <= 0 ||
    !data.identity ||
    typeof data.identity !== "object" ||
    Object.values(data.identity).some((v) => typeof v !== "string") ||
    data.identity.TIME_ON?.length !== 6 ||
    !interval(data.identity)
  )
    return null;
  // The stored exact tuple and its original hash are inseparable. No projected
  // source fields, current station config, invented seconds, or guessed aliases.
  if (
    canonical(canonicalLotwIdentity(data.identity)) !==
      canonical(data.identity) ||
    (await lotwRemoteIdentity(data.identity)) !== data.remoteId
  )
    return null;
  return data;
}
async function readKey(store: Store, tenant: string) {
  const state = await store
    .statement(
      "SELECT key_id,key_envelope FROM source_historical_state WHERE tenant=?",
      tenant,
    )
    .first<{ key_id: string; key_envelope: string | null }>();
  if (!state?.key_envelope) return null;
  try {
    const secret = await open<unknown>(
      JSON.parse(state.key_envelope) as Envelope,
      {
        tenant,
        connection: tenant,
        id: "historical-index",
        kind: "index-key",
        purpose: "storage",
      },
      store.keys,
    );
    if (typeof secret !== "string" || unb64(secret).length !== 32) return null;
    const key = await crypto.subtle.importKey(
      "raw",
      unb64(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const keyId = await sign(key, ["key-id", tenant]);
    return keyId === state.key_id ? { key, keyId } : null;
  } catch {
    return null;
  }
}
const inputWhere =
  "tenant=? AND kind=? AND destination=? AND reference=? AND version=?";
const inputParams = (input: Input) =>
  [
    input.tenant,
    input.kind,
    input.destination,
    input.reference,
    input.version,
  ] as const;
async function finishInput(
  store: Store,
  input: Input,
  now: number,
  evidenceId: string | null,
) {
  const result = await store
    .statement(
      `UPDATE lotw_ownership_inputs SET status=?,checked_at=?,evidence_id=COALESCE(?,evidence_id) WHERE ${inputWhere} RETURNING reference`,
      evidenceId ? "covered" : "held",
      now,
      evidenceId,
      ...inputParams(input),
    )
    .all();
  return result.results.length === 1;
}
async function publishIdentity(
  store: Store,
  input: Input,
  key: SourceHistoricalIndexKey,
  now: number,
) {
  if (
    !input.envelope ||
    input.oversized ||
    input.revoked_at !== null ||
    (input.expires_at !== null && input.expires_at <= now)
  )
    return false;
  const match = /^identity:([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{43})$/.exec(
    input.reference,
  );
  if (!match) return false;
  const owners = (
    await store
      .statement(
        "SELECT tenant,destination,source,qso FROM lotw_ownership_owners WHERE tenant=? AND destination=? AND owner_hash=? LIMIT 2",
        input.tenant,
        input.destination,
        match[1],
      )
      .all<Owner>()
  ).results;
  if (owners.length !== 1) return false;
  let data: RetainedLotwIdentity | null;
  try {
    data = await retained(
      await open<unknown>(
        JSON.parse(input.envelope) as Envelope,
        {
          tenant: input.tenant,
          connection: input.destination,
          id: input.reference,
          kind: "lotw_identity",
          purpose: "storage",
        },
        store.keys,
      ),
    );
  } catch {
    return false;
  }
  const time = data && interval(data.identity);
  if (!data || !time || data.remoteId !== match[2]) return false;
  const owner = owners[0];
  const id = await sha256(
    canonical([
      "lotw-ownership-v1",
      owner.tenant,
      owner.destination,
      owner.source,
      owner.qso,
      data.remoteId,
    ]),
  );
  const locality = await bucket(
    key.key,
    owner.tenant,
    data.identity,
    Math.floor(time.startMs / 60000),
  );
  const envelope = canonical(
    await seal(data, evidenceIdentity(owner.tenant, id), store.keys),
  );
  const guard = `EXISTS(SELECT 1 FROM lotw_ownership_inputs WHERE ${inputWhere}) AND EXISTS(SELECT 1 FROM private_data WHERE tenant=? AND connection=? AND id=? AND kind='lotw_identity' AND envelope=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>MAX(?,CAST(unixepoch('subsec')*1000 AS INTEGER)))) AND EXISTS(SELECT 1 FROM source_historical_state WHERE tenant=? AND key_id=?)`;
  const params = [
    ...inputParams(input),
    input.tenant,
    input.destination,
    input.reference,
    input.envelope,
    now,
    input.tenant,
    key.keyId,
  ];
  const result = await store.db.batch([
    store.statement(
      `INSERT INTO lotw_ownership_evidence(tenant,id,destination,source,qso,exact_hash,key_id,bucket,envelope,created_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${guard} AND NOT EXISTS(SELECT 1 FROM lotw_ownership_evidence WHERE tenant=? AND id=?) ON CONFLICT DO NOTHING`,
      owner.tenant,
      id,
      owner.destination,
      owner.source,
      owner.qso,
      data.remoteId,
      key.keyId,
      locality,
      envelope,
      now,
      ...params,
      owner.tenant,
      id,
    ),
    store.statement(
      `UPDATE lotw_ownership_inputs SET status='covered',evidence_id=?,checked_at=? WHERE ${inputWhere} AND ${guard} AND EXISTS(SELECT 1 FROM lotw_ownership_evidence WHERE tenant=? AND id=? AND key_id=? AND bucket=?) RETURNING reference`,
      id,
      now,
      ...inputParams(input),
      ...params,
      owner.tenant,
      id,
      key.keyId,
      locality,
    ),
  ]);
  return result[1].results.length === 1;
}
/** Bounded maintenance only. Never grants historical adoption or write authority.
 * Each pass hashes at most 100 owner references and examines at most 100 inputs;
 * at most 4 MiB of ciphertext is fetched. Missing evidence remains a global hold.
 */
export async function backfillLotwOwnership(
  store: Store,
  tenant: string,
  options: { limit?: number; now?: number } = {},
) {
  if (!tenant) throw new Error("invalid_lotw_ownership_tenant");
  const limit = bound(options.limit, MAX_INPUTS),
    now = instant(options.now ?? Date.now());
  let key: SourceHistoricalIndexKey;
  try {
    key = await sourceHistoricalIndexKey(store, tenant);
  } catch (error) {
    if (!(error instanceof SourceHistoricalIndexKeyUnavailableError))
      throw error;
    return {
      ...noAuthority,
      reason: "key_unavailable" as const,
      ownersHashed: 0,
      examined: 0,
      covered: 0,
    };
  }
  await store
    .statement(
      "INSERT INTO lotw_ownership_state(tenant,key_id) VALUES(?,?) ON CONFLICT(tenant) DO UPDATE SET key_id=excluded.key_id,clock=clock+1 WHERE lotw_ownership_state.key_id=''",
      tenant,
      key.keyId,
    )
    .run();
  const state = await store
    .statement(
      "SELECT key_id,clock FROM lotw_ownership_state WHERE tenant=?",
      tenant,
    )
    .first<State>();
  if (state?.key_id !== key.keyId)
    return {
      ...noAuthority,
      reason: "key_changed" as const,
      ownersHashed: 0,
      examined: 0,
      covered: 0,
    };
  const owners = (
    await store
      .statement(
        "SELECT tenant,destination,source,qso FROM lotw_ownership_owners WHERE tenant=? AND owner_hash IS NULL ORDER BY source,qso,destination LIMIT ?",
        tenant,
        limit,
      )
      .all<Owner>()
  ).results;
  if (owners.length)
    await store.db.batch(
      await Promise.all(
        owners.map(async (owner) =>
          store.statement(
            "UPDATE lotw_ownership_owners SET owner_hash=? WHERE tenant=? AND destination=? AND source=? AND qso=? AND owner_hash IS NULL",
            await sha256(canonical([owner.source, owner.qso])),
            tenant,
            owner.destination,
            owner.source,
            owner.qso,
          ),
        ),
      ),
    );
  const inputs = (
    await store
      .statement(
        `WITH picked AS MATERIALIZED (
    SELECT * FROM lotw_ownership_inputs WHERE tenant=? AND status IN('pending','held') ORDER BY status DESC,checked_at,kind,destination,reference LIMIT ?
  ), sized AS MATERIALIZED (
    SELECT i.*,p.expires_at,p.revoked_at,length(CAST(p.envelope AS BLOB)) AS bytes,SUM(COALESCE(length(CAST(p.envelope AS BLOB)),0)) OVER(ORDER BY i.kind,i.destination,i.reference) AS total_bytes
    FROM picked i LEFT JOIN private_data p ON i.kind='identity' AND p.tenant=i.tenant AND p.connection=i.destination AND p.id=i.reference AND p.kind='lotw_identity'
  ) SELECT s.*,CASE WHEN s.total_bytes<=? THEN p.envelope END AS envelope,CASE WHEN s.total_bytes>? THEN 1 ELSE 0 END AS oversized FROM sized s LEFT JOIN private_data p ON s.kind='identity' AND p.tenant=s.tenant AND p.connection=s.destination AND p.id=s.reference AND p.kind='lotw_identity' ORDER BY CASE s.kind WHEN 'identity' THEN 0 ELSE 1 END,s.kind,s.destination,s.reference`,
        tenant,
        limit,
        MAX_BYTES,
        MAX_BYTES,
      )
      .all<Input>()
  ).results;
  let covered = 0;
  for (const input of inputs) {
    if (input.kind === "identity") {
      if (await publishIdentity(store, input, key, now)) {
        covered++;
        continue;
      }
      await finishInput(store, input, now, null);
      continue;
    }
    const hash =
      input.exact_hash ??
      (
        await store
          .statement(
            "SELECT i.identity_hash FROM attempt_identity_claims i JOIN attempt_state s ON s.tenant=i.tenant AND s.attempt=i.attempt WHERE i.tenant=? AND i.destination=? AND i.attempt=? AND i.source=? AND i.qso=? AND i.vendor='lotw' AND s.state IN('prepared','dispatching','submitted','uncertain','reconciliation_required','delivered','observed','cancelled','rejected')",
            tenant,
            input.destination,
            input.reference,
            input.source,
            input.qso,
          )
          .first<{ identity_hash: string }>()
      )?.identity_hash;
    const evidence = hash
      ? await store
          .statement(
            "SELECT id FROM lotw_ownership_evidence WHERE tenant=? AND destination=? AND source=? AND qso=? AND exact_hash=? AND key_id=?",
            tenant,
            input.destination,
            input.source,
            input.qso,
            hash,
            key.keyId,
          )
          .first<{ id: string }>()
      : null;
    const changed = await finishInput(store, input, now, evidence?.id ?? null);
    if (evidence && changed) covered++;
  }
  return {
    ...noAuthority,
    reason: "examined" as const,
    ownersHashed: owners.length,
    examined: inputs.length,
    covered,
  };
}
/** Observation-only comparison. The tenant + exact station callsign namespace
 * intentionally spans inactive, signing-only, and query-account destinations.
 * Query credentials control access to vendor evidence, never ownership identity.
 */
export async function lookupLotwOwnership(
  store: Store,
  tenant: string,
  record: AdifRecord,
  options: { limit?: number } = {},
) {
  // Freeze the supplied identity before any key/database await.
  record = { ...record };
  const limit = bound(options.limit, MAX_CANDIDATES);
  const held = (reason: string) => ({
    ...noAuthority,
    state: "held" as const,
    reason,
    candidates: [] as LotwOwnershipCandidate[],
    snapshot: null as LotwOwnershipSnapshot | null,
  });
  const range = interval(record);
  if (!tenant || !range) return held("invalid_identity");
  const key = await readKey(store, tenant);
  if (!key) return held("key_unavailable");
  const buckets = await Promise.all(
    Array.from(
      {
        length:
          Math.floor((range.endMs + 1800000) / 60000) -
          Math.floor((range.startMs - 1800000) / 60000) +
          1,
      },
      (_, n) =>
        bucket(
          key.key,
          tenant,
          record,
          Math.floor((range.startMs - 1800000) / 60000) + n,
        ),
    ),
  );
  const [scope, rows] = await store.db.batch([
    store.statement(
      `SELECT s.clock,s.key_id,
    EXISTS(SELECT 1 FROM lotw_ownership_inputs WHERE tenant=s.tenant AND status IN('pending','held') LIMIT 1) AS incomplete,
    EXISTS(SELECT 1 FROM lotw_ownership_owners WHERE tenant=s.tenant AND owner_hash IS NULL LIMIT 1) AS pending_owners
    FROM lotw_ownership_state s WHERE s.tenant=?`,
      tenant,
    ),
    store.statement(
      `WITH bounded AS MATERIALIZED (SELECT e.tenant,e.id,length(CAST(e.envelope AS BLOB)) AS bytes FROM json_each(?) b CROSS JOIN lotw_ownership_evidence e INDEXED BY lotw_ownership_bucket WHERE e.tenant=? AND e.key_id=? AND e.bucket=b.value LIMIT ?), sized AS MATERIALIZED (SELECT *,SUM(bytes) OVER(ORDER BY id) AS total_bytes FROM bounded) SELECT e.tenant,e.id,e.destination,e.source,e.qso,e.exact_hash,e.key_id,e.bucket,CASE WHEN s.total_bytes<=? THEN e.envelope END AS envelope FROM sized s JOIN lotw_ownership_evidence e ON e.tenant=s.tenant AND e.id=s.id ORDER BY e.id`,
      JSON.stringify(buckets),
      tenant,
      key.keyId,
      limit + 1,
      MAX_BYTES,
    ),
  ]);
  const state = scope.results[0] as
    | (State & { incomplete: number; pending_owners: number })
    | undefined;
  if (!state || state.key_id !== key.keyId) return held("key_changed");
  if (state.incomplete || state.pending_owners)
    return held("coverage_incomplete");
  if (rows.results.length > limit) return held("candidate_bound");
  const candidates: LotwOwnershipCandidate[] = [];
  for (const row of rows.results as unknown as Evidence[]) {
    if (!row.envelope) return held("byte_bound");
    let data: RetainedLotwIdentity | null;
    try {
      data = await retained(
        await open<unknown>(
          JSON.parse(row.envelope) as Envelope,
          evidenceIdentity(tenant, row.id),
          store.keys,
        ),
      );
    } catch {
      return held("evidence_unavailable");
    }
    const time = data && interval(data.identity);
    if (
      !data ||
      !time ||
      data.remoteId !== row.exact_hash ||
      row.bucket !==
        (await bucket(
          key.key,
          tenant,
          data.identity,
          Math.floor(time.startMs / 60000),
        ))
    )
      return held("evidence_invalid");
    const comparison = historicalCandidates("lotw", comparisonRecord(record), [
      comparisonRecord(data.identity),
    ]);
    if (comparison.state === "invalid") return held("evidence_invalid");
    if (comparison.candidates.length)
      candidates.push({
        tenant,
        destination: row.destination,
        source: row.source,
        qso: row.qso,
        evidenceId: row.id,
        evidence: data,
      });
  }
  const snapshot = { tenant, keyId: key.keyId, clock: state.clock };
  if (!(await lotwOwnershipSnapshotCurrent(store, snapshot)))
    return held("scope_changed");
  return {
    ...noAuthority,
    state: "observed" as const,
    reason: "registry_observation",
    candidates,
    snapshot,
  };
}
/** Stability check only; deliberately not a SQL adoption/staging authorization. */
export async function lotwOwnershipSnapshotCurrent(
  store: Store,
  snapshot: LotwOwnershipSnapshot,
) {
  return Boolean(
    await store
      .statement(
        "SELECT 1 current FROM lotw_ownership_state s JOIN source_historical_state k ON k.tenant=s.tenant WHERE s.tenant=? AND s.clock=? AND s.key_id=? AND k.key_id=s.key_id AND NOT EXISTS(SELECT 1 FROM lotw_ownership_inputs WHERE tenant=s.tenant AND status IN('pending','held')) AND NOT EXISTS(SELECT 1 FROM lotw_ownership_owners WHERE tenant=s.tenant AND owner_hash IS NULL)",
        snapshot.tenant,
        snapshot.clock,
        snapshot.keyId,
      )
      .first(),
  );
}
