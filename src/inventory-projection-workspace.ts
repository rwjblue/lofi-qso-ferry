import type { AdifRecord } from "./adif.ts";
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
function object(value: unknown): SourceRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as SourceRecord)
    : {};
}
function compact(body: unknown): AdifRecord {
  return Object.fromEntries(
    Object.entries(object(body)).filter(
      (entry): entry is [string, string] =>
        comparisonFields.has(entry[0]) && typeof entry[1] === "string",
    ),
  );
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
    const current = await this.store
      .statement(
        `SELECT s.connection_id,s.provider,s.config_version,s.state,c.status AS connection_state,a.status AS account_state,b.complete
      FROM inventory_scopes s JOIN connections c ON c.tenant=s.tenant AND c.id=s.connection_id JOIN accounts a ON a.id=s.tenant
      JOIN comparison_builds b ON b.tenant=s.tenant AND b.scope_id=s.scope_id AND b.generation_id=? AND b.config_version=s.config_version
      JOIN comparison_domains d ON d.tenant=s.tenant AND d.version=? AND ? IN (d.active_generation,d.pending_generation)
      WHERE s.tenant=? AND s.scope_id=?`,
        generation,
        writers.domain.version,
        generation,
        tenant,
        scope,
      )
      .first<Scope>();
    if (!current) throw new Error("inventory_projection_scope_changed");
    if (!current.complete)
      throw new Error("inventory_projection_index_incomplete");
    if (current.account_state !== "active")
      throw new Error("inventory_projection_account_unavailable");
    const facet = current.provider === "lofi" ? "source" : "receipt";
    const coverage =
      current.provider === "lofi"
        ? await this.store
            .statement(
              `SELECT c.stream_id,c.partition_id,c.version,c.epoch,c.state,c.kind,c.published_config_version,
      CASE WHEN r.mode='full' AND r.requires_catchup=1 AND r.phase='complete' AND r.config_version=? AND json_array_length(r.required_streams)=2
        AND EXISTS(SELECT 1 FROM json_each(r.required_streams) WHERE value='operations') AND EXISTS(SELECT 1 FROM json_each(r.required_streams) WHERE value='qsos') THEN 1 ELSE 0 END AS full_context
      FROM inventory_coverage c LEFT JOIN inventory_runs r ON r.tenant=c.tenant AND r.run_id=c.published_run_id
      WHERE c.tenant=? AND c.scope_id=? AND c.facet='source' ORDER BY (c.state='ready') DESC,c.completed_at DESC,c.stream_id,c.partition_id LIMIT 1`,
              current.config_version,
              tenant,
              scope,
            )
            .first<InventoryProjectionCoverage>()
        : null;
    const coverageReady =
      coverage?.state === "ready" &&
      coverage.kind === "observed_selection" &&
      coverage.full_context === 1 &&
      coverage.published_config_version === current.config_version;
    const inputs = (
      await this.store
        .statement(
          `SELECT e.entity_family AS family,e.record_key AS key,e.subtype,e.parent_key,e.status,f.facet,f.semantic_version,f.payload_id,p.connection_id,p.kind,length(p.envelope) AS payload_bytes,
      coalesce(mv.version,0) AS membership_version,m.state AS member_state,i.key_class,i.bucket_hash,i.projection_version,coalesce(pd.topology_version,0) AS topology_version,w.work_version,w.completed_version
      FROM json_each(?) j CROSS JOIN inventory_records e
      JOIN inventory_record_facets f ON f.tenant=e.tenant AND f.scope_id=e.scope_id AND f.entity_family=e.entity_family AND f.record_key=e.record_key AND f.facet=?
      JOIN inventory_payloads p ON p.tenant=f.tenant AND p.scope_id=f.scope_id AND p.payload_id=f.payload_id
      JOIN comparison_index i ON i.tenant=e.tenant AND i.generation_id=? AND i.scope_id=e.scope_id AND i.record_key=e.record_key AND i.facet=f.facet AND i.state!='retired' AND i.semantic_version=f.semantic_version AND i.config_version=?
      JOIN comparison_work w ON w.tenant=i.tenant AND w.generation_id=i.generation_id AND w.scope_id=i.scope_id AND w.record_key=i.record_key AND w.facet=i.facet
      LEFT JOIN projection_domains pd ON pd.tenant=e.tenant AND pd.scope_id=e.scope_id AND pd.operation_key=e.parent_key
      LEFT JOIN inventory_membership_versions mv ON mv.tenant=e.tenant AND mv.scope_id=e.scope_id AND mv.entity_family=e.entity_family AND mv.record_key=e.record_key AND mv.facet=f.facet
      LEFT JOIN inventory_partition_membership m ON m.tenant=e.tenant AND m.scope_id=e.scope_id AND m.stream_id=? AND m.partition_id=? AND m.entity_family=e.entity_family AND m.record_key=e.record_key AND m.facet=f.facet
      WHERE e.tenant=? AND e.scope_id=? AND e.entity_family='qso' AND e.subtype='qso' AND e.status='active' AND e.record_key=j.value`,
          canonical(keys),
          facet,
          generation,
          current.config_version,
          coverage?.stream_id ?? null,
          coverage?.partition_id ?? null,
          tenant,
          scope,
        )
        .all<InventoryProjectionInput>()
    ).results;
    if (inputs.length !== keys.length)
      throw new Error("inventory_projection_inputs_changed");
    const parents = [
      ...new Set(
        inputs.flatMap((row) => (row.parent_key ? [row.parent_key] : [])),
      ),
    ];
    let refs: InventoryProjectionReference[] = [];
    if (current.provider === "lofi" && coverageReady && parents.length)
      refs = (
        await this.store
          .statement(
            `WITH refs AS (
      SELECT 'operation' AS family,value AS key FROM json_each(?1)
      UNION ALL SELECT e.entity_family,e.record_key FROM json_each(?1) j CROSS JOIN inventory_records e WHERE e.tenant=?2 AND e.scope_id=?3 AND e.parent_key=j.value AND e.entity_family='qso' AND e.subtype='event' LIMIT 257
      ) SELECT r.family,r.key,e.subtype,e.parent_key,e.status,'source' AS facet,f.semantic_version,f.payload_id,p.connection_id,p.kind,length(p.envelope) AS payload_bytes,coalesce(mv.version,0) AS membership_version,m.state AS member_state
      FROM refs r LEFT JOIN inventory_records e ON e.tenant=?2 AND e.scope_id=?3 AND e.entity_family=r.family AND e.record_key=r.key
      LEFT JOIN inventory_record_facets f ON f.tenant=e.tenant AND f.scope_id=e.scope_id AND f.entity_family=e.entity_family AND f.record_key=e.record_key AND f.facet='source'
      LEFT JOIN inventory_payloads p ON p.tenant=f.tenant AND p.scope_id=f.scope_id AND p.payload_id=f.payload_id
      LEFT JOIN inventory_membership_versions mv ON mv.tenant=e.tenant AND mv.scope_id=e.scope_id AND mv.entity_family=e.entity_family AND mv.record_key=e.record_key AND mv.facet='source'
      LEFT JOIN inventory_partition_membership m ON m.tenant=e.tenant AND m.scope_id=e.scope_id AND m.stream_id=?4 AND m.partition_id=?5 AND m.entity_family=e.entity_family AND m.record_key=e.record_key AND m.facet='source'`,
            canonical(parents),
            tenant,
            scope,
            coverage?.stream_id ?? null,
            coverage?.partition_id ?? null,
          )
          .all<InventoryProjectionReference>()
      ).results;
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
    let byteOverflow = encryptedInputBytes > MAX_BYTES,
      plaintextBytes = 0,
      decryptedBodies = 0;
    const bodies = new Map<string, SourceRecord>();
    if (!byteOverflow) {
      for (const chunk of inventoryJsonChunks([...payloadRefs.keys()])) {
        const payloads = await this.store
          .statement(
            `SELECT p.payload_id,p.envelope FROM json_each(?) j CROSS JOIN inventory_payloads p WHERE p.tenant=? AND p.scope_id=? AND p.payload_id=j.value`,
            chunk,
            tenant,
            scope,
          )
          .all<{ payload_id: string; envelope: string }>();
        for (const payload of payloads.results) {
          const ref = payloadRefs.get(payload.payload_id);
          if (
            !ref ||
            encoder.encode(payload.envelope).byteLength !== ref.payload_bytes
          )
            throw new Error("inventory_projection_payload_size_changed");
          const body = await open<unknown>(
            JSON.parse(payload.envelope) as Envelope,
            {
              tenant,
              connection: current.connection_id,
              id: payload.payload_id,
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
          bodies.set(payload.payload_id, object(body));
        }
        if (byteOverflow) break;
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
        const record = compact(raw);
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
        (current.provider !== "lofi" || !parents.length || coverageReady),
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
