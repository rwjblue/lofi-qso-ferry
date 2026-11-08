import type { AdifRecord } from "./adif.ts";
import { historicalQrzLogId } from "./historical-associations.ts";
import {
  type HistoricalVendor,
  historicalCandidateKeys,
  historicalCandidates,
} from "./historical-matching.ts";
import { InventoryComparisonGenerations } from "./inventory-comparison-generations.ts";
import type { InventoryComparisonKey } from "./inventory-comparison-keys.ts";
import { b64, canonical, type Envelope, open } from "./security.ts";
import type { Store } from "./store.ts";

const MAX_BYTES = 4 * 1024 * 1024;
const BUCKET_MS = 30 * 60_000;
const encoder = new TextEncoder();
export interface InventoryOwnerIdentity {
  sourceIdentity: string;
  key: string;
}
export interface InventoryOwnershipQuery extends InventoryOwnerIdentity {
  id: string;
  book: string;
  remoteKey: string;
  record: AdifRecord;
}
export interface InventoryOwnershipDomain {
  key_id: string;
  version: number;
  format_version: number;
}
export interface InventoryOwnershipEvidence {
  id: string;
  provider: HistoricalVendor;
  book_identity: string;
  source_scope: string;
  source_identity: string;
  record_key: string;
  destination_scope: string;
  claim_hash: string;
  bucket_hash: string;
  key_id: string;
  kind: "historical";
  remote_id: string | null;
  envelope: string | null;
  encrypted_bytes: number;
}
export interface InventoryOwnershipBody {
  version: 1;
  provider: HistoricalVendor;
  kind: "historical";
  record: AdifRecord;
}
export const inventoryOwnershipIdentity = (tenant: string, id: string) => ({
  tenant,
  connection: "inventory-ownership",
  id,
  kind: "inventory_ownership_evidence",
  purpose: "storage",
});
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}
async function hash(key: InventoryComparisonKey, values: unknown[]) {
  return b64(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key.key,
        encoder.encode(
          canonical([
            "inventory-ownership-v1",
            key.tenant,
            key.keyId,
            ...values,
          ]),
        ),
      ),
    ),
  );
}
function validate(provider: HistoricalVendor, record: AdifRecord) {
  if (historicalCandidates(provider, record, [record]).state !== "unique")
    throw new Error("invalid_inventory_ownership_record");
}
/** Permanent namespace: independent of active comparison generations and KEKs.
 * LoTW tokens are candidate locality/claim hashes, never vendor receipt IDs. */
export async function inventoryOwnershipTokens(
  key: InventoryComparisonKey,
  provider: HistoricalVendor,
  book: string,
  remoteKey: string,
  record: AdifRecord,
) {
  validate(provider, record);
  if (provider === "qrz") {
    const claim = await hash(key, [
      "qrz-logid",
      book,
      historicalQrzLogId(remoteKey),
    ]);
    return { claim, bucket: claim, probes: [claim] };
  }
  const keys = historicalCandidateKeys(record);
  if (!keys.time || !keys.workedCall)
    throw new Error("invalid_inventory_ownership_record");
  const center = Math.floor(keys.time.startMs / BUCKET_MS);
  if (Math.floor(keys.time.endMs / BUCKET_MS) !== center)
    throw new Error("invalid_inventory_ownership_interval");
  const bucket = (value: number) =>
    hash(key, [
      "lotw-station-call-time",
      record.STATION_CALLSIGN.toUpperCase(),
      keys.workedCall,
      value,
    ]);
  const identity = Object.fromEntries(
    Object.entries(record)
      .filter(([field]) =>
        [
          "STATION_CALLSIGN",
          "CALL",
          "QSO_DATE",
          "TIME_ON",
          "BAND",
          "MODE",
          "SUBMODE",
          "PROP_MODE",
          "SAT_NAME",
          "APP_LOTW_MODE",
          "APP_LOTW_MODEGROUP",
        ].includes(field),
      )
      .map(([field, value]) => [field, value.toUpperCase()]),
  );
  return {
    claim: await hash(key, ["lotw-historical-claim", identity]),
    bucket: await bucket(center),
    probes: await Promise.all([center - 1, center, center + 1].map(bucket)),
  };
}

export class InventoryOwnership {
  constructor(readonly store: Store) {}
  private async ensure(tenant: string, provider: HistoricalVendor) {
    if (!identifier(tenant) || !["qrz", "lotw"].includes(provider))
      throw new Error("invalid_inventory_ownership_scope");
    const key = await new InventoryComparisonGenerations(this.store).key(
      tenant,
    );
    await this.store
      .statement(
        "INSERT INTO inventory_ownership_domains(tenant,provider,key_id) VALUES(?,?,?) ON CONFLICT DO NOTHING",
        tenant,
        provider,
        key.keyId,
      )
      .run();
    return key;
  }
  async initialize(tenant: string, provider: HistoricalVendor) {
    const key = await this.ensure(tenant, provider);
    const domain = await this.store
      .statement(
        "SELECT key_id,version,format_version FROM inventory_ownership_domains WHERE tenant=? AND provider=?",
        tenant,
        provider,
      )
      .first<InventoryOwnershipDomain>();
    if (!domain || domain.key_id !== key.keyId || domain.format_version !== 1)
      throw new Error("inventory_ownership_format_unavailable");
    return { key, domain };
  }
  async hold(
    tenant: string,
    provider: HistoricalVendor,
    reference: string,
    reason: "unresolved_delivery" | "unverified_owner" | "unsupported_identity",
  ) {
    if (!identifier(reference))
      throw new Error("invalid_inventory_ownership_reference");
    await this.ensure(tenant, provider);
    await this.store
      .statement(
        "INSERT INTO inventory_ownership_holds(tenant,provider,reference,reason,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",
        tenant,
        provider,
        reference,
        reason,
        Date.now(),
      )
      .run();
  }
  async lookup(
    tenant: string,
    provider: HistoricalVendor,
    queries: readonly InventoryOwnershipQuery[],
    limits: { maxBytes?: number; maxRecords?: number } = {},
  ) {
    queries = structuredClone(queries);
    const maxBytes = limits.maxBytes ?? MAX_BYTES,
      maxRecords = limits.maxRecords ?? 128;
    if (
      queries.length < 1 ||
      queries.length > 20 ||
      new Set(queries.map((q) => q.id)).size !== queries.length ||
      queries.some(
        (q) =>
          ![q.id, q.book, q.remoteKey, q.sourceIdentity, q.key].every(
            identifier,
          ),
      ) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 ||
      maxBytes > MAX_BYTES ||
      !Number.isSafeInteger(maxRecords) ||
      maxRecords < 0 ||
      maxRecords > 128
    )
      throw new Error("invalid_inventory_ownership_queries");
    const key = await this.ensure(tenant, provider);
    const tokens = await Promise.all(
      queries.map((query) =>
        inventoryOwnershipTokens(
          key,
          provider,
          query.book,
          query.remoteKey,
          query.record,
        ),
      ),
    );
    const hashes = [...new Set(tokens.flatMap((token) => token.probes))];
    const [header, found] = await this.store.db.batch([
      this.store.statement(
        `SELECT d.*,EXISTS(SELECT 1 FROM inventory_ownership_holds h WHERE h.tenant=d.tenant AND h.provider=d.provider) AS held,
       (SELECT json_group_array(json_object('hash',j.value,'version',coalesce(b.version,0))) FROM json_each(?3) j LEFT JOIN inventory_ownership_buckets b ON b.tenant=d.tenant AND b.provider=d.provider AND b.bucket_hash=j.value) AS buckets
       FROM inventory_ownership_domains d WHERE d.tenant=?1 AND d.provider=?2`,
        tenant,
        provider,
        canonical(hashes),
      ),
      this.store.statement(
        `WITH bounded AS MATERIALIZED(SELECT e.id,e.encrypted_bytes FROM json_each(?1) j CROSS JOIN inventory_ownership_evidence e INDEXED BY inventory_ownership_bucket WHERE e.tenant=?2 AND e.provider=?3 AND e.bucket_hash=j.value AND NOT EXISTS(SELECT 1 FROM inventory_ownership_holds h WHERE h.tenant=e.tenant AND h.provider=e.provider) LIMIT ?4),
       sized AS MATERIALIZED(SELECT *,SUM(encrypted_bytes) OVER() AS total_bytes,COUNT(*) OVER() AS total_records FROM bounded)
       SELECT e.id,e.provider,e.book_identity,e.source_scope,e.source_identity,e.record_key,e.destination_scope,e.claim_hash,e.bucket_hash,e.key_id,e.kind,e.remote_id,e.encrypted_bytes,CASE WHEN s.total_records<?4 AND s.total_bytes<=?5 THEN e.envelope END AS envelope FROM sized s JOIN inventory_ownership_evidence e ON e.tenant=?2 AND e.id=s.id`,
        canonical(hashes),
        tenant,
        provider,
        maxRecords + 1,
        maxBytes,
      ),
    ]);
    const state = header.results[0] as unknown as
      | (InventoryOwnershipDomain & { held: number; buckets: string })
      | undefined;
    if (!state || state.key_id !== key.keyId || state.format_version !== 1)
      throw new Error("inventory_ownership_format_unavailable");
    const base = {
      keyId: key.keyId,
      version: state.version,
      buckets: JSON.parse(state.buckets) as { hash: string; version: number }[],
      tokens,
      stats: {
        rowsRead: header.meta.rows_read + found.meta.rows_read,
        decryptedBodies: 0,
        encryptedInputBytes: 0,
        plaintextBytes: 0,
      },
    };
    const held = (reason: string) => ({
      ...base,
      state: "held" as const,
      reason,
      evidence: [] as (InventoryOwnershipEvidence & {
        body: InventoryOwnershipBody;
      })[],
      observations: queries.map((query) => ({
        id: query.id,
        state: "held" as const,
        reason,
        evidenceId: null as string | null,
      })),
    });
    if (state.held) return held("ownership_incomplete");
    if (found.results.length > maxRecords)
      return held("ownership_record_bound");
    const rows = found.results as unknown as InventoryOwnershipEvidence[];
    if (rows.some((row) => !row.envelope)) return held("ownership_byte_bound");
    const evidence: (InventoryOwnershipEvidence & {
      body: InventoryOwnershipBody;
    })[] = [];
    for (const row of rows) {
      if (!row.envelope)
        throw new Error("inventory_ownership_evidence_unavailable");
      const body = await open<InventoryOwnershipBody>(
        JSON.parse(row.envelope) as Envelope,
        inventoryOwnershipIdentity(tenant, row.id),
        this.store.keys,
      );
      base.stats.encryptedInputBytes += encoder.encode(row.envelope).byteLength;
      base.stats.plaintextBytes += encoder.encode(canonical(body)).byteLength;
      if (
        base.stats.encryptedInputBytes > maxBytes ||
        base.stats.plaintextBytes > maxBytes
      )
        return held("ownership_byte_bound");
      if (
        body.version !== 1 ||
        body.provider !== provider ||
        body.kind !== "historical" ||
        row.key_id !== key.keyId
      )
        throw new Error("inventory_ownership_evidence_invalid");
      const token = await inventoryOwnershipTokens(
        key,
        provider,
        row.book_identity,
        provider === "qrz" ? (row.remote_id ?? "") : row.id,
        body.record,
      );
      if (
        token.claim !== row.claim_hash ||
        token.bucket !== row.bucket_hash ||
        row.encrypted_bytes !== encoder.encode(row.envelope).byteLength
      )
        throw new Error("inventory_ownership_evidence_invalid");
      base.stats.decryptedBodies++;
      evidence.push({ ...row, body });
    }
    const observations = queries.map((query, index) => {
      const candidates = evidence.filter((row) =>
        provider === "qrz"
          ? row.claim_hash === tokens[index].claim
          : historicalCandidates("lotw", query.record, [row.body.record])
              .state !== "none",
      );
      const conflict = candidates.some(
        (row) =>
          row.source_identity !== query.sourceIdentity ||
          row.record_key !== query.key,
      );
      return {
        id: query.id,
        state: conflict
          ? ("conflict" as const)
          : candidates.length
            ? ("owned" as const)
            : ("clear" as const),
        reason: conflict ? "ownership_conflict" : null,
        evidenceId:
          candidates.find((row) => row.claim_hash === tokens[index].claim)
            ?.id ?? null,
      };
    });
    return {
      ...base,
      state: "observed" as const,
      reason: null,
      evidence,
      observations,
    };
  }
}
