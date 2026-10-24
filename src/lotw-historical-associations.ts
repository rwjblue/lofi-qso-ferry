import type { AdifRecord } from "./adif.ts";
import { historicalCandidates } from "./historical-matching.ts";
import type { IdentityGuard } from "./identity-claims.ts";
import { canonicalLotwIdentity, lotwRemoteIdentity } from "./reconcile.ts";
import {
  b64,
  canonical,
  type Envelope,
  open,
  seal,
  unb64,
} from "./security.ts";
import type { LedgerKey, Store } from "./store.ts";

export const LOTW_HISTORICAL_COMPARISON_POLICY = 2;
const MAX_CANDIDATES = 128;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const noAuthority = {
  authoritative: false as const,
  requiresWriteBridge: true as const,
};
export interface LotwHistoricalSnapshot {
  tenant: string;
  keyId: string;
  clock: number;
  comparisonPolicy: number;
}
export interface LotwHistoricalCandidate extends LedgerKey {
  evidenceId: string;
  kind: "exact" | "reserved" | "historical";
  /** Original evidence, including TIME_ON precision and optional report fields. */
  record: AdifRecord;
}
interface Key {
  key: CryptoKey;
  keyId: string;
}
interface Row extends LedgerKey {
  id: string;
  kind: "exact" | "historical";
  key_id: string;
  bucket: string;
  exact_hash: string | null;
  namespace: string | null;
  record_hash: string | null;
  envelope: string | null;
}
function comparable(record: AdifRecord) {
  return Object.fromEntries(
    Object.entries(record).filter(
      ([k, v]) => v !== "" || (k !== "PROP_MODE" && k !== "SAT_NAME"),
    ),
  );
}
function interval(record: AdifRecord) {
  const r = comparable(record),
    result = historicalCandidates("lotw", r, [r]);
  return result.state === "unique" ? result.candidates[0].time.source : null;
}
function capture(value: AdifRecord): AdifRecord | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((v) => typeof v !== "string")
  )
    return null;
  const copy = { ...value };
  return encoder.encode(canonical(copy)).byteLength <= MAX_RECORD_BYTES &&
    interval(copy)
    ? copy
    : null;
}
async function sign(key: CryptoKey, value: unknown) {
  return b64(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(canonical(value))),
    ),
  );
}
async function readKey(store: Store, tenant: string): Promise<Key | null> {
  const row = await store
    .statement(
      "SELECT key_id,key_envelope FROM source_historical_state WHERE tenant=?",
      tenant,
    )
    .first<{ key_id: string; key_envelope: string | null }>();
  if (!row?.key_envelope) return null;
  try {
    const secret = await open<unknown>(
      JSON.parse(row.key_envelope) as Envelope,
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
    return (await sign(key, ["key-id", tenant])) === row.key_id
      ? { key, keyId: row.key_id }
      : null;
  } catch {
    return null;
  }
}
const aad = (tenant: string, id: string, kind: "exact" | "historical") => ({
  tenant,
  connection: tenant,
  id,
  kind: kind === "exact" ? "lotw-ownership" : "lotw-historical",
  purpose: "storage",
});
const bucket = (key: Key, tenant: string, r: AdifRecord, minute: number) =>
  sign(key.key, [
    "lotw-ownership-v1",
    "station-call-minute",
    tenant,
    r.STATION_CALLSIGN.toUpperCase(),
    r.CALL.toUpperCase(),
    minute,
  ]);
const namespace = (key: Key, tenant: string, r: AdifRecord) =>
  sign(key.key, [
    "lotw-ownership-v1",
    "station",
    tenant,
    r.STATION_CALLSIGN.toUpperCase(),
  ]);
const recordHash = (key: Key, tenant: string, r: AdifRecord) =>
  sign(key.key, ["lotw-historical-record-v1", tenant, r]);

export function lotwHistoricalSnapshotGuard(
  snapshot: LotwHistoricalSnapshot,
): IdentityGuard {
  return {
    sql: "EXISTS(SELECT 1 FROM lotw_ownership_state s JOIN source_historical_state k ON k.tenant=s.tenant AND k.key_id=s.key_id WHERE s.tenant=? AND s.key_id=? AND s.clock=? AND s.comparison_policy=? AND NOT EXISTS(SELECT 1 FROM lotw_ownership_inputs WHERE tenant=s.tenant AND status IN('pending','held')) AND NOT EXISTS(SELECT 1 FROM lotw_ownership_owners WHERE tenant=s.tenant AND owner_hash IS NULL))",
    params: [
      snapshot.tenant,
      snapshot.keyId,
      snapshot.clock,
      snapshot.comparisonPolicy,
    ],
  };
}
/** One bounded comparison cohort across raw history and exact/reserved evidence.
 * The station namespace spans inactive/query/signing aliases. This is observation
 * only: no vendor identity, receipt, mapping, or upload permission is invented.
 * Permanent envelopes currently require every referenced KEK to remain readable;
 * rewrapping the stable index secret does not re-encrypt these retained records.
 */
export async function lookupLotwHistoricalOwnership(
  store: Store,
  tenant: string,
  records: readonly AdifRecord[],
) {
  const captured =
    records.length > 0 && records.length <= 20 ? records.map(capture) : [];
  const held = (reason: string) => ({
    ...noAuthority,
    state: "held" as const,
    reason,
    candidates: [] as LotwHistoricalCandidate[],
    snapshot: null as LotwHistoricalSnapshot | null,
  });
  if (
    !tenant ||
    captured.length !== records.length ||
    !captured.length ||
    captured.some((r) => !r)
  )
    return held("invalid_identity");
  const queries = captured as AdifRecord[],
    key = await readKey(store, tenant);
  if (!key) return held("key_unavailable");
  const buckets = new Set<string>();
  for (const r of queries) {
    const time = interval(r);
    if (!time) return held("invalid_identity");
    for (
      let m = Math.floor((time.startMs - 1800000) / 60000);
      m <= Math.floor((time.endMs + 1800000) / 60000);
      m++
    )
      buckets.add(await bucket(key, tenant, r, m));
  }
  const [scope, found] = await store.db.batch([
    store.statement(
      "SELECT s.clock,s.key_id,s.comparison_policy,EXISTS(SELECT 1 FROM lotw_ownership_inputs WHERE tenant=s.tenant AND status IN('pending','held')) AS incomplete,EXISTS(SELECT 1 FROM lotw_ownership_owners WHERE tenant=s.tenant AND owner_hash IS NULL) AS pending FROM lotw_ownership_state s WHERE s.tenant=?",
      tenant,
    ),
    store.statement(
      `WITH requested AS MATERIALIZED (SELECT value FROM json_each(?)), bounded AS MATERIALIZED (
      SELECT 'exact' AS kind,e.tenant,e.id,length(CAST(e.envelope AS BLOB)) AS bytes FROM requested b CROSS JOIN lotw_ownership_evidence e INDEXED BY lotw_ownership_bucket WHERE e.tenant=? AND e.key_id=? AND e.bucket=b.value
      UNION ALL SELECT 'historical',e.tenant,e.id,length(CAST(e.envelope AS BLOB)) FROM requested b CROSS JOIN lotw_historical_associations e INDEXED BY lotw_historical_bucket WHERE e.tenant=? AND e.key_id=? AND e.bucket=b.value LIMIT ?
    ), sized AS MATERIALIZED (SELECT *,SUM(bytes) OVER(ORDER BY kind,id) AS total_bytes FROM bounded)
    SELECT s.kind,e.tenant,e.id,e.destination,e.source,e.qso,e.key_id,e.bucket,e.exact_hash,NULL AS namespace,NULL AS record_hash,CASE WHEN s.total_bytes<=? THEN e.envelope END AS envelope FROM sized s JOIN lotw_ownership_evidence e ON e.tenant=s.tenant AND e.id=s.id WHERE s.kind='exact'
    UNION ALL SELECT s.kind,e.tenant,e.id,e.destination,e.source,e.qso,e.key_id,e.bucket,NULL,e.namespace,e.record_hash,CASE WHEN s.total_bytes<=? THEN e.envelope END FROM sized s JOIN lotw_historical_associations e ON e.tenant=s.tenant AND e.id=s.id WHERE s.kind='historical'`,
      JSON.stringify([...buckets]),
      tenant,
      key.keyId,
      tenant,
      key.keyId,
      MAX_CANDIDATES + 1,
      MAX_BYTES,
      MAX_BYTES,
    ),
  ]);
  const state = scope.results[0] as
    | {
        clock: number;
        key_id: string;
        comparison_policy: number;
        incomplete: number;
        pending: number;
      }
    | undefined;
  if (!state || state.key_id !== key.keyId) return held("key_changed");
  if (![1, 2].includes(state.comparison_policy))
    return held("comparison_policy_unavailable");
  if (state.incomplete || state.pending) return held("coverage_incomplete");
  if (found.results.length > MAX_CANDIDATES) return held("candidate_bound");
  const rows = found.results as unknown as Row[];
  if (rows.some((row) => !row.envelope)) return held("byte_bound");
  const candidates: LotwHistoricalCandidate[] = [];
  for (const row of rows) {
    if (!row.envelope) return held("byte_bound");
    let value: unknown;
    try {
      value = await open<unknown>(
        JSON.parse(row.envelope) as Envelope,
        aad(tenant, row.id, row.kind),
        store.keys,
      );
    } catch {
      return held("evidence_unavailable");
    }
    let raw: AdifRecord | null, kind: LotwHistoricalCandidate["kind"];
    if (row.kind === "historical") {
      raw = capture(value as AdifRecord);
      kind = "historical";
      if (
        !raw ||
        row.record_hash !== (await recordHash(key, tenant, raw)) ||
        row.namespace !== (await namespace(key, tenant, raw))
      )
        return held("evidence_invalid");
    } else {
      const data = value as {
        identity: AdifRecord;
        remoteId: string;
        firstEvidence: string;
        recordedAt: number;
      } | null;
      raw = capture(data?.identity as AdifRecord);
      kind = data?.firstEvidence === "reserved" ? "reserved" : "exact";
      if (
        raw?.TIME_ON?.length !== 6 ||
        !data ||
        !["adopted", "submitted", "uncertain", "observed", "reserved"].includes(
          data.firstEvidence,
        ) ||
        !Number.isSafeInteger(data.recordedAt) ||
        data.recordedAt <= 0 ||
        data.remoteId !== row.exact_hash ||
        canonical(canonicalLotwIdentity(raw)) !== canonical(raw) ||
        (await lotwRemoteIdentity(raw)) !== row.exact_hash
      )
        return held("evidence_invalid");
    }
    const time = interval(raw);
    if (
      !time ||
      row.bucket !==
        (await bucket(key, tenant, raw, Math.floor(time.startMs / 60000)))
    )
      return held("evidence_invalid");
    let relevant = false;
    for (const query of queries) {
      const comparison = historicalCandidates("lotw", comparable(query), [
        comparable(raw),
      ]);
      if (comparison.state === "invalid" || comparison.issues.length)
        return held("evidence_invalid");
      relevant ||= comparison.candidates.length > 0;
    }
    if (relevant)
      candidates.push({
        tenant,
        destination: row.destination,
        source: row.source,
        qso: row.qso,
        evidenceId: row.id,
        kind,
        record: raw,
      });
  }
  const snapshot = {
      tenant,
      keyId: key.keyId,
      clock: state.clock,
      comparisonPolicy: state.comparison_policy,
    },
    guard = lotwHistoricalSnapshotGuard(snapshot);
  if (
    !(await store
      .statement(`SELECT 1 WHERE ${guard.sql}`, ...guard.params)
      .first())
  )
    return held("scope_changed");
  return {
    ...noAuthority,
    state: "observed" as const,
    reason: "registry_observation",
    candidates,
    snapshot,
  };
}

export interface LotwHistoricalAssociationMember {
  key: LedgerKey;
  record: AdifRecord;
  generation: string;
  sourceHash: string;
  /** Exact source projection, reverse uniqueness, inventory and route fences. */
  guard: IdentityGuard;
}
/** Prepare ONE native batch for up to20 associations. All admissions precede any
 * clock-changing publication. Member guards must compare retention deadlines to
 * the actual database clock as well as their captured time. Callers may add guarded adoption updates between
 * publications and finish; never concatenate independent prepared cohorts.
 * Always release in finally, including an unknown batch outcome; never retry.
 */
export async function prepareLotwHistoricalAssociations(
  store: Store,
  members: readonly LotwHistoricalAssociationMember[],
  options: { now?: number } = {},
) {
  if (!members.length || members.length > 20)
    throw new Error("invalid_lotw_historical_cohort");
  const captured = members.map((m) => ({
    ...m,
    key: { ...m.key },
    record: capture(m.record),
    guard: { sql: m.guard.sql, params: [...m.guard.params] },
  }));
  const now = options.now ?? Date.now(),
    tenant = captured[0]?.key.tenant;
  if (
    !tenant ||
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    !captured.length ||
    captured.length > 20 ||
    captured.some(
      (m) => !m.record || m.key.tenant !== tenant || m.guard.params.length > 72,
    ) ||
    new Set(captured.map((m) => canonical(m.key))).size !== captured.length
  )
    throw new Error("invalid_lotw_historical_cohort");
  const lease = await store.claim(tenant, "lotw-ownership", now, 60000);
  if (!lease) throw new Error("lotw_historical_lease_unavailable");
  try {
    const records = captured.map((m) => m.record as AdifRecord),
      result = await lookupLotwHistoricalOwnership(store, tenant, records);
    if (result.state !== "observed" || !result.snapshot)
      throw new Error(`lotw_historical_${result.reason}`);
    for (let i = 0; i < captured.length; i++) {
      const owner = captured[i].key;
      const competing = [
        ...result.candidates,
        ...captured
          .slice(i + 1)
          .map((m) => ({ ...m.key, record: m.record as AdifRecord })),
      ];
      for (const other of competing) {
        const comparison = historicalCandidates(
          "lotw",
          comparable(records[i]),
          [comparable(other.record)],
        );
        if (
          comparison.state === "invalid" ||
          comparison.issues.length ||
          (comparison.candidates.length &&
            (other.source !== owner.source || other.qso !== owner.qso))
        )
          throw new Error("lotw_historical_competing_owner");
      }
    }
    const key = await readKey(store, tenant);
    if (!key || key.keyId !== result.snapshot.keyId)
      throw new Error("lotw_historical_key_changed");
    const destinations = await store.db.batch(
      captured.map((m) =>
        store.statement(
          "SELECT remote_identity,config,credential_version FROM connections WHERE tenant=? AND id=? AND kind='lotw' AND status='active'",
          tenant,
          m.key.destination,
        ),
      ),
    );
    const batchId = crypto.randomUUID(),
      begin: D1PreparedStatement[] = [],
      publications: D1PreparedStatement[] = [],
      ids: string[] = [];
    const snapshotGuard = lotwHistoricalSnapshotGuard(result.snapshot);
    for (let i = 0; i < captured.length; i++) {
      const m = captured[i],
        r = records[i],
        d = destinations[i].results[0] as
          | {
              remote_identity: string;
              config: string;
              credential_version: string;
            }
          | undefined,
        time = interval(r);
      if (!d || !time) throw new Error("lotw_historical_scope_changed");
      const id = crypto.randomUUID(),
        ns = await namespace(key, tenant, r),
        b = await bucket(key, tenant, r, Math.floor(time.startMs / 60000)),
        hash = await recordHash(key, tenant, r);
      const envelope = JSON.stringify(
        await seal(r, aad(tenant, id, "historical"), store.keys),
      );
      if (encoder.encode(envelope).byteLength > 131072)
        throw new Error("lotw_historical_byte_bound");
      ids.push(id);
      begin.push(
        store.statement(
          `INSERT INTO lotw_historical_guards(id,batch_id,members,tenant,association_id,source,qso,destination,book_identity,config,credential_version,generation,source_hash,key_id,clock,comparison_policy,namespace,bucket,record_hash,envelope,lease_token,lease_fence,now,expires_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (${snapshotGuard.sql}) AND (${m.guard.sql})`,
          crypto.randomUUID(),
          batchId,
          captured.length,
          tenant,
          id,
          m.key.source,
          m.key.qso,
          m.key.destination,
          d.remote_identity,
          d.config,
          d.credential_version,
          m.generation,
          m.sourceHash,
          key.keyId,
          result.snapshot.clock,
          result.snapshot.comparisonPolicy,
          ns,
          b,
          hash,
          envelope,
          lease.token,
          lease.fence,
          now,
          lease.expires_at,
          ...snapshotGuard.params,
          ...m.guard.params,
        ),
      );
      publications.push(
        store.statement(
          "INSERT INTO lotw_historical_associations(id,tenant,source,qso,destination,book_identity,key_id,namespace,bucket,record_hash,envelope,generation,source_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          id,
          tenant,
          m.key.source,
          m.key.qso,
          m.key.destination,
          d.remote_identity,
          key.keyId,
          ns,
          b,
          hash,
          envelope,
          m.generation,
          m.sourceHash,
          now,
        ),
        store.statement(
          "UPDATE ledger SET lotw_historical_association_id=? WHERE tenant=? AND source=? AND qso=? AND destination=? AND generation=? AND source_hash=? AND lotw_historical_association_id IS NULL RETURNING lotw_historical_association_id",
          id,
          tenant,
          m.key.source,
          m.key.qso,
          m.key.destination,
          m.generation,
          m.sourceHash,
        ),
      );
    }
    const finish = [
      ...captured.map((m, i) =>
        store.statement(
          `INSERT INTO lotw_historical_commit_checks(id,valid) VALUES(?,CAST((${m.guard.sql}) AS INTEGER))`,
          `${batchId}:${i}`,
          ...m.guard.params,
        ),
      ),
      store.statement(
        "DELETE FROM lotw_historical_guards WHERE batch_id=?",
        batchId,
      ),
      store.statement(
        "DELETE FROM lotw_historical_commit_checks WHERE id IN(SELECT value FROM json_each(?))",
        JSON.stringify(captured.map((_, i) => `${batchId}:${i}`)),
      ),
    ];
    return {
      ...noAuthority,
      associationIds: ids,
      begin,
      publications,
      finish,
      ledgerResultOffsets: ids.map((_, i) => begin.length + i * 2 + 1),
      lease,
      release: () => store.release(lease),
    };
  } catch (error) {
    await store.release(lease);
    throw error;
  }
}
