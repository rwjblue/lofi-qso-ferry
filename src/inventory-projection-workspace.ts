import { type AdifRecord, adifStationCallsign } from "./adif.ts";
import { contactReconciliationAdif } from "./contact-adif.ts";
import { historicalCandidates } from "./historical-matching.ts";
import { InventoryComparisonGenerations } from "./inventory-comparison-generations.ts";
import { inventoryComparisonToken } from "./inventory-comparison-keys.ts";
import { inventoryComparisonHint } from "./inventory-comparison-pages.ts";
import { inventoryJsonChunks } from "./inventory-ingestion.ts";
import type { SourceRecord } from "./lofi.ts";
import {
  ProjectionError,
  projectContact,
  sourceFingerprint,
} from "./projection.ts";
import {
  canonical,
  type Envelope,
  open,
  randomToken,
  seal,
  sha256,
} from "./security.ts";
import type { Store } from "./store.ts";

export const INVENTORY_COMPARISON_PROJECTION_VERSION = 1;
export const inventoryProjectionIdentity = (
  tenant: string,
  connection: string,
  id: string,
) => ({
  tenant,
  connection,
  id,
  kind: "inventory_comparison_projection",
  purpose: "storage",
});
const MAX_RECORDS = 20,
  MAX_DEPENDENCIES = 256,
  MAX_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const comparisonFields = new Set(
  "STATION_CALLSIGN CALL QSO_DATE TIME_ON BAND MODE SUBMODE PROP_MODE SAT_NAME MY_GRIDSQUARE MY_STATE MY_CNTY MY_DXCC MY_LAT MY_LON MY_CQ_ZONE MY_ITU_ZONE MY_IOTA FREQ FREQ_RX BAND_RX APP_LOTW_MODE APP_LOTW_MODEGROUP".split(
    " ",
  ),
);
export interface InventoryProjectionBody {
  version: 1;
  state: "ready" | "held" | "excluded";
  record: AdifRecord;
  source?: {
    qrz: string;
    qrzPreserved: string;
    lotw: string;
    startAtMillis: number;
    timePrecision: "second" | "millisecond";
  };
}
export interface InventoryProjectionCoverage {
  stream_id: string;
  partition_id: string;
  version: number;
  epoch: number;
  state: string;
  kind: string;
  published_config_version: number | null;
  full_context: number;
}
export interface InventoryProjectionReference {
  family: string;
  key: string;
  subtype: string | null;
  parent_key: string | null;
  status: string | null;
  facet: "source" | "receipt";
  semantic_version: number | null;
  payload_id: string | null;
  connection_id: string | null;
  kind: string | null;
  payload_bytes: number | null;
  membership_version: number;
  member_state: string | null;
}
export interface InventoryProjectionInput extends InventoryProjectionReference {
  key_class: string;
  bucket_hash: string;
  projection_version: number;
  topology_version: number;
  work_version: number;
  completed_version: number;
}
export interface InventoryProjectionRow {
  key: string;
  facet: "source" | "receipt";
  state: "ready" | "held" | "excluded";
  reason: string | null;
  payload: string;
}
export interface PreparedInventoryProjections {
  tenant: string;
  generation: string;
  scope: string;
  connection: string;
  provider: "lofi" | "qrz" | "lotw";
  domainVersion: number;
  configVersion: number;
  coverage: InventoryProjectionCoverage | null;
  inputs: InventoryProjectionInput[];
  dependencies: InventoryProjectionReference[];
  contextComplete: boolean;
  rows: InventoryProjectionRow[];
  payloads: { id: string; envelope: string }[];
  preparedAt: number;
  digest: string;
  stats: {
    dependencies: number;
    decryptedBodies: number;
    plaintextBytes: number;
    encryptedInputBytes: number;
  };
}
interface Scope {
  connection_id: string;
  provider: "lofi" | "qrz" | "lotw";
  config_version: number;
  state: string;
  account_state: string;
  connection_state: string;
  complete: number;
}
interface ProjectionSnapshotRow {
  row_type: "scope" | "input" | "context" | "payload";
  ordinal: number;
  payload_id: string | null;
  data: string;
}
const referenceFields = `'family',r.family,'key',r.key,'subtype',r.subtype,'parent_key',r.parent_key,
 'status',r.status,'facet',r.facet,'semantic_version',r.semantic_version,'payload_id',r.payload_id,
 'connection_id',r.connection_id,'kind',r.kind,'payload_bytes',r.payload_bytes,
 'membership_version',r.membership_version,'member_state',r.member_state`;

// Keep the scope, membership and bodies in one read snapshot. Return each
// dependency and envelope separately to keep individual result rows small.
const projectionSnapshot = `WITH scoped AS MATERIALIZED (
 SELECT s.tenant,s.scope_id,s.connection_id,s.provider,s.config_version,s.state,
        c.status AS connection_state,a.status AS account_state,b.complete
 FROM inventory_scopes s
 JOIN connections c ON (c.tenant,c.id)=(s.tenant,s.connection_id)
 JOIN accounts a ON a.id=s.tenant
 JOIN comparison_builds b ON (b.tenant,b.scope_id,b.generation_id,b.config_version)=(s.tenant,s.scope_id,?3,s.config_version)
 JOIN comparison_domains d ON d.tenant=s.tenant AND d.version=?4 AND ?3 IN (d.active_generation,d.pending_generation)
 WHERE (s.tenant,s.scope_id)=(?1,?2)
), coverage AS MATERIALIZED (
 SELECT cv.stream_id,cv.partition_id,cv.version,cv.epoch,cv.state,cv.kind,cv.published_config_version,
   CASE WHEN r.mode='full' AND r.requires_catchup=1 AND r.phase='complete' AND r.config_version=s.config_version
     AND json_array_length(r.required_streams)=2
     AND EXISTS(SELECT 1 FROM json_each(r.required_streams) WHERE value='operations')
     AND EXISTS(SELECT 1 FROM json_each(r.required_streams) WHERE value='qsos') THEN 1 ELSE 0 END AS full_context
 FROM scoped s CROSS JOIN inventory_coverage cv
 LEFT JOIN inventory_runs r ON (r.tenant,r.run_id)=(cv.tenant,cv.published_run_id)
 WHERE s.provider='lofi' AND s.complete=1 AND s.account_state='active'
   AND (cv.tenant,cv.scope_id,cv.facet)=(s.tenant,s.scope_id,'source')
 ORDER BY (cv.state='ready') DESC,cv.completed_at DESC,cv.stream_id,cv.partition_id LIMIT 1
), inputs AS MATERIALIZED (
 SELECT CAST(j.key AS INTEGER) AS ordinal,e.entity_family AS family,e.record_key AS key,e.subtype,e.parent_key,e.status,
        f.facet,f.semantic_version,f.payload_id,p.connection_id,p.kind,length(p.envelope) AS payload_bytes,
        length(CAST(p.envelope AS BLOB)) AS cipher_bytes,
        coalesce(mv.version,0) AS membership_version,m.state AS member_state,i.key_class,i.bucket_hash,i.projection_version,
        coalesce(pd.topology_version,0) AS topology_version,w.work_version,w.completed_version
 FROM scoped s CROSS JOIN json_each(?5) j CROSS JOIN inventory_records e
 JOIN inventory_record_facets f ON (f.tenant,f.scope_id,f.entity_family,f.record_key,f.facet)=
   (e.tenant,e.scope_id,e.entity_family,e.record_key,CASE s.provider WHEN 'lofi' THEN 'source' ELSE 'receipt' END)
 JOIN inventory_payloads p ON (p.tenant,p.scope_id,p.payload_id)=(f.tenant,f.scope_id,f.payload_id)
 JOIN comparison_index i ON (i.tenant,i.generation_id,i.scope_id,i.record_key,i.facet)=(e.tenant,?3,e.scope_id,e.record_key,f.facet)
   AND i.state!='retired' AND i.semantic_version=f.semantic_version AND i.config_version=s.config_version
 JOIN comparison_work w ON (w.tenant,w.generation_id,w.scope_id,w.record_key,w.facet)=(i.tenant,i.generation_id,i.scope_id,i.record_key,i.facet)
 LEFT JOIN projection_domains pd ON (pd.tenant,pd.scope_id,pd.operation_key)=(e.tenant,e.scope_id,e.parent_key)
 LEFT JOIN inventory_membership_versions mv ON (mv.tenant,mv.scope_id,mv.entity_family,mv.record_key,mv.facet)=
   (e.tenant,e.scope_id,e.entity_family,e.record_key,f.facet)
 LEFT JOIN coverage cv ON 1
 LEFT JOIN inventory_partition_membership m ON (m.tenant,m.scope_id,m.stream_id,m.partition_id,m.entity_family,m.record_key,m.facet)=
   (e.tenant,e.scope_id,cv.stream_id,cv.partition_id,e.entity_family,e.record_key,f.facet)
 WHERE s.complete=1 AND s.account_state='active'
   AND (e.tenant,e.scope_id,e.entity_family,e.record_key)=(s.tenant,s.scope_id,'qso',j.value)
   AND e.subtype='qso' AND e.status='active'
), parents AS MATERIALIZED (
 SELECT i.parent_key AS key FROM coverage cv CROSS JOIN scoped s CROSS JOIN inputs i
 WHERE i.parent_key IS NOT NULL AND i.parent_key!=''
   AND cv.state='ready' AND cv.kind='observed_selection' AND cv.full_context=1 AND cv.published_config_version=s.config_version
 GROUP BY i.parent_key ORDER BY min(i.ordinal)
), refs AS (
 SELECT 'operation' AS family,key FROM parents
 UNION ALL SELECT e.entity_family,e.record_key FROM parents p CROSS JOIN inventory_records e INDEXED BY inventory_parent
 WHERE (e.tenant,e.scope_id,e.parent_key,e.entity_family,e.subtype)=(?1,?2,p.key,'qso','event')
 LIMIT ${MAX_DEPENDENCIES + 1}
), context_rows AS MATERIALIZED (
 SELECT r.family,r.key,e.subtype,e.parent_key,e.status,'source' AS facet,f.semantic_version,f.payload_id,
        p.connection_id,p.kind,length(p.envelope) AS payload_bytes,length(CAST(p.envelope AS BLOB)) AS cipher_bytes,
        coalesce(mv.version,0) AS membership_version,m.state AS member_state
 FROM coverage cv CROSS JOIN refs r
 LEFT JOIN inventory_records e ON (e.tenant,e.scope_id,e.entity_family,e.record_key)=(?1,?2,r.family,r.key)
 LEFT JOIN inventory_record_facets f ON (f.tenant,f.scope_id,f.entity_family,f.record_key,f.facet)=(e.tenant,e.scope_id,e.entity_family,e.record_key,'source')
 LEFT JOIN inventory_payloads p ON (p.tenant,p.scope_id,p.payload_id)=(f.tenant,f.scope_id,f.payload_id)
 LEFT JOIN inventory_membership_versions mv ON (mv.tenant,mv.scope_id,mv.entity_family,mv.record_key,mv.facet)=
   (e.tenant,e.scope_id,e.entity_family,e.record_key,'source')
 LEFT JOIN inventory_partition_membership m ON (m.tenant,m.scope_id,m.stream_id,m.partition_id,m.entity_family,m.record_key,m.facet)=
   (e.tenant,e.scope_id,cv.stream_id,cv.partition_id,e.entity_family,e.record_key,'source')
), payloads AS MATERIALIZED (
 SELECT payload_id,cipher_bytes FROM inputs WHERE payload_id IS NOT NULL
 UNION SELECT payload_id,cipher_bytes FROM context_rows WHERE payload_id IS NOT NULL
   AND (SELECT count(*) FROM inputs)+(SELECT count(*) FROM context_rows)<=${MAX_DEPENDENCIES}
), budget AS MATERIALIZED (
 SELECT coalesce(sum(cipher_bytes),0) AS bytes FROM payloads
)
SELECT 'scope' AS row_type,0 AS ordinal,NULL AS payload_id,json_object(
  'scope',json_object('connection_id',s.connection_id,'provider',s.provider,'config_version',s.config_version,
    'state',s.state,'connection_state',s.connection_state,'account_state',s.account_state,'complete',s.complete),
  'coverage',json((SELECT json_object('stream_id',stream_id,'partition_id',partition_id,'version',version,'epoch',epoch,
    'state',state,'kind',kind,'published_config_version',published_config_version,'full_context',full_context) FROM coverage)),
  'cipherBytes',(SELECT bytes FROM budget)
) AS data FROM scoped s
UNION ALL SELECT 'input',r.ordinal,NULL,json_object(${referenceFields},
  'key_class',r.key_class,'bucket_hash',r.bucket_hash,'projection_version',r.projection_version,
  'topology_version',r.topology_version,'work_version',r.work_version,'completed_version',r.completed_version)
FROM inputs r
UNION ALL SELECT 'context',0,NULL,json_object(${referenceFields}) FROM context_rows r
UNION ALL SELECT 'payload',0,p.payload_id,p.envelope FROM budget b CROSS JOIN payloads ids CROSS JOIN inventory_payloads p
WHERE b.bytes<=?6 AND (SELECT count(*) FROM inputs)=json_array_length(?5)
  AND (p.tenant,p.scope_id,p.payload_id)=(?1,?2,ids.payload_id)`;

function object(value: unknown): SourceRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as SourceRecord)
    : {};
}
function compact(body: unknown, provider: "qrz" | "lotw"): AdifRecord {
  const record = Object.fromEntries(
    Object.entries(object(body)).filter(
      (entry): entry is [string, string] =>
        comparisonFields.has(entry[0]) && typeof entry[1] === "string",
    ),
  );
  if (provider === "qrz") {
    const station = adifStationCallsign(object(body));
    if (station !== undefined) record.STATION_CALLSIGN = station;
  }
  return record;
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}
export async function inventoryProjectionDigest(
  value: Omit<PreparedInventoryProjections, "digest">,
) {
  return sha256(canonical(["inventory-projection-preparation-v1", value]));
}

/** A read-only bounded workspace. Its encrypted output still needs a native
 * publication guard; retained data never renews upstream observation freshness. */
export class InventoryProjectionWorkspace {
  constructor(readonly store: Store) {}
  async prepare(
    tenant: string,
    generation: string,
    scope: string,
    keys: readonly string[],
  ): Promise<PreparedInventoryProjections> {
    keys = [...keys];
    if (
      ![tenant, generation, scope].every(identifier) ||
      keys.length < 1 ||
      keys.length > MAX_RECORDS ||
      keys.some((key) => !identifier(key)) ||
      new Set(keys).size !== keys.length
    )
      throw new Error("invalid_inventory_projection_inputs");
    const writers = await new InventoryComparisonGenerations(
      this.store,
    ).writers(tenant);
    const context = writers?.contexts.find(
      (value) => value.generation === generation,
    );
    if (!writers || !context)
      throw new Error("inventory_comparison_generation_unavailable");
    const { results: snapshot } = await this.store
      .statement(
        projectionSnapshot,
        tenant,
        scope,
        generation,
        writers.domain.version,
        canonical(keys),
        MAX_BYTES,
      )
      .all<ProjectionSnapshotRow>();
    const header = snapshot.find((row) => row.row_type === "scope");
    if (!header) throw new Error("inventory_projection_scope_changed");
    const {
      scope: current,
      coverage,
      cipherBytes,
    } = JSON.parse(header.data) as {
      scope: Scope;
      coverage: InventoryProjectionCoverage | null;
      cipherBytes: number;
    };
    if (!current.complete)
      throw new Error("inventory_projection_index_incomplete");
    if (current.account_state !== "active")
      throw new Error("inventory_projection_account_unavailable");
    const coverageReady =
      coverage?.state === "ready" &&
      coverage.kind === "observed_selection" &&
      coverage.full_context === 1 &&
      coverage.published_config_version === current.config_version;
    const inputs = snapshot
      .filter((row) => row.row_type === "input")
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((row) => JSON.parse(row.data) as InventoryProjectionInput);
    if (inputs.length !== keys.length)
      throw new Error("inventory_projection_inputs_changed");
    let refs = snapshot
      .filter((row) => row.row_type === "context")
      .map((row) => JSON.parse(row.data) as InventoryProjectionReference);
    const contextOverflow = inputs.length + refs.length > MAX_DEPENDENCIES;
    if (contextOverflow) refs = []; // No truncated context is usable.
    const dependencies: InventoryProjectionReference[] = [...inputs, ...refs];
    const payloadRefs = new Map<string, InventoryProjectionReference>();
    for (const row of dependencies)
      if (row.payload_id) {
        if (
          row.connection_id !== current.connection_id ||
          row.kind !==
            (row.facet === "source"
              ? "inventory_source"
              : "inventory_receipt") ||
          !Number.isSafeInteger(row.payload_bytes) ||
          Number(row.payload_bytes) <= 0
        )
          throw new Error("inventory_projection_payload_binding_changed");
        payloadRefs.set(row.payload_id, row);
      }
    const encryptedInputBytes = [...payloadRefs.values()].reduce(
      (sum, row) => sum + Number(row.payload_bytes),
      0,
    );
    if (cipherBytes !== encryptedInputBytes)
      throw new Error("inventory_projection_payload_size_changed");
    let byteOverflow = encryptedInputBytes > MAX_BYTES,
      plaintextBytes = 0,
      decryptedBodies = 0;
    const bodies = new Map<string, SourceRecord>();
    if (!byteOverflow) {
      for (const payload of snapshot) {
        if (payload.row_type !== "payload") continue;
        const { payload_id: id, data: envelope } = payload;
        const ref = id && payloadRefs.get(id);
        if (
          !id ||
          !ref ||
          encoder.encode(envelope).byteLength !== ref.payload_bytes
        )
          throw new Error("inventory_projection_payload_size_changed");
        const body = await open<unknown>(
          JSON.parse(envelope) as Envelope,
          {
            tenant,
            connection: current.connection_id,
            id,
            kind: ref.kind ?? "",
            purpose: "storage",
          },
          this.store.keys,
        );
        decryptedBodies++;
        plaintextBytes += encoder.encode(canonical(body)).byteLength;
        if (plaintextBytes > MAX_BYTES) {
          byteOverflow = true;
          bodies.clear();
          break;
        }
        bodies.set(id, object(body));
      }
      if (!byteOverflow && bodies.size !== payloadRefs.size)
        throw new Error("inventory_projection_payload_unavailable");
    }
    const byKey = new Map(
      refs.map((ref) => [canonical([ref.family, ref.key]), ref]),
    );
    const rows: InventoryProjectionRow[] = [],
      payloads: { id: string; envelope: string }[] = [];
    for (const input of inputs) {
      const raw = bodies.get(input.payload_id ?? "") ?? {};
      let state: InventoryProjectionRow["state"] = "held",
        reason: string | null = null,
        body: InventoryProjectionBody = {
          version: 1,
          state: "held",
          record: byteOverflow
            ? {}
            : inventoryComparisonHint(current.provider, raw),
        };
      if (byteOverflow) reason = "projection_byte_bound";
      else if (
        current.state !== "observing" ||
        current.connection_state !== "active"
      )
        reason = "projection_scope_unavailable";
      else if (current.provider !== "lofi") {
        const record = compact(raw, current.provider);
        state =
          historicalCandidates(current.provider, record, [record]).state ===
          "unique"
            ? "ready"
            : "held";
        reason = state === "held" ? "invalid_receipt_projection" : null;
        body = { version: 1, state, record };
      } else {
        const operation = input.parent_key
          ? byKey.get(canonical(["operation", input.parent_key]))
          : undefined;
        const eventRefs = refs.filter(
          (ref) =>
            ref.family === "qso" &&
            ref.subtype === "event" &&
            ref.parent_key === input.parent_key,
        );
        if (input.parent_key && !coverageReady)
          reason = "source_coverage_incomplete";
        else if (input.parent_key && contextOverflow)
          reason = "projection_context_bound";
        else if (coverageReady && input.member_state !== "present")
          reason = "source_membership_unresolved";
        else if (
          input.parent_key &&
          (!operation?.payload_id ||
            operation.status !== "active" ||
            operation.member_state !== "present" ||
            eventRefs.some(
              (ref) =>
                ref.member_state !== "present" ||
                !ref.payload_id ||
                ref.semantic_version === null,
            ))
        )
          reason = "operation_context_incomplete";
        else
          try {
            const contact = await projectContact(
              raw,
              operation?.payload_id
                ? (bodies.get(operation.payload_id) ?? null)
                : null,
              eventRefs.flatMap((ref) =>
                ref.payload_id ? [bodies.get(ref.payload_id) ?? {}] : [],
              ),
              { operationComplete: Boolean(coverageReady) },
            );
            const record = contactReconciliationAdif(contact);
            if (
              contact.id !== input.key ||
              contact.operationId !== input.parent_key
            )
              throw new ProjectionError("projection_identity_changed");
            state = "ready";
            body = {
              version: 1,
              state,
              record,
              source: {
                qrz: contact.generation,
                qrzPreserved: await sourceFingerprint(contact, "qrz", true),
                lotw: await sourceFingerprint(contact, "lotw"),
                startAtMillis: contact.startAtMillis,
                timePrecision: contact.timePrecision,
              },
            };
          } catch (error) {
            if (
              error instanceof ProjectionError &&
              error.code === "test_operation_not_exported"
            ) {
              state = "excluded";
              reason = error.code;
            } else
              reason =
                error instanceof ProjectionError
                  ? error.code
                  : "invalid_comparison_projection";
          }
      }
      body.state = state;
      if (state !== "held") {
        const token = await inventoryComparisonToken(context, body.record);
        if (
          token.keyClass !== input.key_class ||
          token.hash !== input.bucket_hash
        )
          throw new Error("inventory_projection_hint_mismatch");
      }
      const id = randomToken();
      payloads.push({
        id,
        envelope: JSON.stringify(
          await seal(
            body,
            inventoryProjectionIdentity(tenant, current.connection_id, id),
            this.store.keys,
          ),
        ),
      });
      rows.push({
        key: input.key,
        facet: input.facet,
        state,
        reason,
        payload: id,
      });
    }
    inventoryJsonChunks(rows);
    inventoryJsonChunks(payloads);
    const result = {
      tenant,
      generation,
      scope,
      connection: current.connection_id,
      provider: current.provider,
      domainVersion: writers.domain.version,
      configVersion: current.config_version,
      coverage,
      inputs,
      dependencies,
      contextComplete:
        !contextOverflow &&
        (current.provider !== "lofi" ||
          coverageReady ||
          !inputs.some((row) => row.parent_key)),
      rows,
      payloads,
      preparedAt: Date.now(),
      stats: {
        dependencies: dependencies.length,
        decryptedBodies,
        plaintextBytes,
        encryptedInputBytes,
      },
    };
    return { ...result, digest: await inventoryProjectionDigest(result) };
  }
}
