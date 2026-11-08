import type { AdifRecord } from "./adif.ts";
import { InventoryComparisonGenerations } from "./inventory-comparison-generations.ts";
import {
  type InventoryComparisonToken,
  inventoryComparisonLookup,
} from "./inventory-comparison-keys.ts";
import { canonical } from "./security.ts";
import type { Store } from "./store.ts";

export interface InventoryComparisonRequest {
  id: string;
  scope: string;
  record: AdifRecord;
}
export interface InventoryComparisonCandidate {
  key: string;
  facet: "source" | "receipt";
  keyClass: InventoryComparisonToken["keyClass"];
  hash: string;
  state: "pending" | "ready" | "held";
  semanticVersion: number;
  currentSemanticVersion: number | null;
  configVersion: number;
  parent: string | null;
  topologyVersion: number;
  currentTopologyVersion: number;
  projectionVersion: number;
  membershipVersion: number;
}
export interface InventoryComparisonProbe {
  id: string;
  scope: string;
  configVersion: number | null;
  indexReady: boolean;
  state: "overflow" | "indexing" | "pending" | "observed";
  candidates: InventoryComparisonCandidate[];
  buckets: (InventoryComparisonToken & { version: number })[];
}
interface ProbeRow {
  ordinal: number;
  config_version: number | null;
  scope_state: string | null;
  connection_state: string | null;
  account_state: string;
  build_config_version: number | null;
  complete: number | null;
  generation_state: string;
  candidates: string;
  buckets: string;
}
const encoder = new TextEncoder();
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

/** Bounded candidate collection only. Coverage, exact predicates and reverse
 * uniqueness still have to be checked before publishing any matching result. */
export class InventoryComparisonLookup {
  constructor(readonly store: Store) {}

  async probe(
    tenant: string,
    requests: InventoryComparisonRequest[],
    options: { generation?: string } = {},
  ) {
    requests = structuredClone(requests);
    const requestedGeneration = options.generation;
    if (
      !identifier(tenant) ||
      requests.length < 1 ||
      requests.length > 20 ||
      new Set(requests.map((request) => request.id)).size !== requests.length ||
      requests.some(
        (request) => !identifier(request.id) || !identifier(request.scope),
      ) ||
      encoder.encode(canonical(requests)).byteLength > 128 * 1024
    )
      throw new Error("invalid_inventory_comparison_requests");
    const writers = await new InventoryComparisonGenerations(
      this.store,
    ).writers(tenant);
    const generation = requestedGeneration ?? writers?.domain.active_generation;
    const context = writers?.contexts.find(
      (key) => key.generation === generation,
    );
    if (!writers || !context)
      throw new Error("inventory_comparison_generation_unavailable");
    const probes = await Promise.all(
      requests.map(async (request) => ({
        id: request.id,
        scope: request.scope,
        tokens: await inventoryComparisonLookup(context, request.record),
      })),
    );
    // Limit the total returned candidate metadata as well as every individual
    // equality probe. One extra row proves overflow; no truncated set is usable.
    const candidateLimit = Math.min(512, Math.floor(1024 / requests.length));
    const result = await this.store
      .statement(
        `SELECT CAST(j.key AS INTEGER) AS ordinal,s.config_version,s.state AS scope_state,c.status AS connection_state,a.status AS account_state,
       b.config_version AS build_config_version,b.complete,g.state AS generation_state,
       (SELECT json_group_array(json_object('key',q.record_key,'facet',q.facet,'keyClass',q.key_class,'hash',q.bucket_hash,'state',q.state,
        'semanticVersion',q.semantic_version,'currentSemanticVersion',q.current_semantic_version,'configVersion',q.config_version,
        'parent',q.parent_key,'topologyVersion',q.topology_version,'currentTopologyVersion',q.current_topology_version,'projectionVersion',q.projection_version,'membershipVersion',q.membership_version)) FROM (
         SELECT i.*,f.semantic_version AS current_semantic_version,coalesce(pd.topology_version,0) AS current_topology_version,coalesce(mv.version,0) AS membership_version
         FROM json_each(json_extract(j.value,'$.tokens')) t CROSS JOIN comparison_index i INDEXED BY comparison_bucket
         LEFT JOIN inventory_record_facets f ON f.tenant=i.tenant AND f.scope_id=i.scope_id AND f.entity_family='qso' AND f.record_key=i.record_key AND f.facet=i.facet
         LEFT JOIN projection_domains pd ON pd.tenant=i.tenant AND pd.scope_id=i.scope_id AND pd.operation_key=i.parent_key
         LEFT JOIN inventory_membership_versions mv ON mv.tenant=i.tenant AND mv.scope_id=i.scope_id AND mv.entity_family='qso' AND mv.record_key=i.record_key AND mv.facet=i.facet
         WHERE i.tenant=?2 AND i.generation_id=?4 AND i.scope_id=json_extract(j.value,'$.scope')
          AND i.key_class=json_extract(t.value,'$.keyClass') AND i.bucket_hash=json_extract(t.value,'$.hash') LIMIT ?5
       ) q) AS candidates,
       (SELECT json_group_array(json_object('keyClass',json_extract(t.value,'$.keyClass'),'hash',json_extract(t.value,'$.hash'),'version',coalesce(v.version,0)))
        FROM json_each(json_extract(j.value,'$.tokens')) t LEFT JOIN bucket_versions v ON v.tenant=?2 AND v.generation_id=?4 AND v.scope_id=json_extract(j.value,'$.scope')
         AND v.key_class=json_extract(t.value,'$.keyClass') AND v.bucket_hash=json_extract(t.value,'$.hash')) AS buckets
       FROM json_each(?1) j CROSS JOIN comparison_domains d JOIN accounts a ON a.id=d.tenant
       JOIN index_generations g ON g.tenant=d.tenant AND g.generation_id=?4 AND g.generation_id IN (d.active_generation,d.pending_generation)
       LEFT JOIN inventory_scopes s ON s.tenant=d.tenant AND s.scope_id=json_extract(j.value,'$.scope')
       LEFT JOIN connections c ON c.tenant=s.tenant AND c.id=s.connection_id
       LEFT JOIN comparison_builds b ON b.tenant=s.tenant AND b.generation_id=g.generation_id AND b.scope_id=s.scope_id
       WHERE d.tenant=?2 AND d.version=?3`,
        canonical(probes),
        tenant,
        writers.domain.version,
        context.generation,
        candidateLimit + 1,
      )
      .all<ProbeRow>();
    if (result.results.length !== requests.length)
      throw new Error("inventory_comparison_generation_changed");
    if (encoder.encode(canonical(result.results)).byteLength > 2 * 1024 * 1024)
      throw new Error("inventory_comparison_lookup_too_large");
    const observations: InventoryComparisonProbe[] = result.results
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((row) => {
        const request = requests[row.ordinal];
        const candidates = JSON.parse(
          row.candidates,
        ) as InventoryComparisonCandidate[];
        const overflow = candidates.length > candidateLimit;
        const indexReady =
          row.complete === 1 &&
          row.config_version === row.build_config_version &&
          row.scope_state === "observing" &&
          row.connection_state === "active" &&
          row.account_state === "active" &&
          row.generation_state === "active";
        const pending = candidates.some(
          (candidate) =>
            candidate.state !== "ready" ||
            candidate.semanticVersion !== candidate.currentSemanticVersion ||
            candidate.configVersion !== row.config_version ||
            candidate.topologyVersion !== candidate.currentTopologyVersion,
        );
        return {
          id: request.id,
          scope: request.scope,
          configVersion: row.config_version,
          indexReady,
          state: overflow
            ? "overflow"
            : !indexReady
              ? "indexing"
              : pending
                ? "pending"
                : "observed",
          candidates: overflow ? [] : candidates,
          buckets: JSON.parse(
            row.buckets,
          ) as InventoryComparisonProbe["buckets"],
        };
      });
    return {
      generation: context.generation,
      domainVersion: writers.domain.version,
      sourceSetVersion: writers.domain.source_set_version,
      active: writers.domain.active_generation === context.generation,
      observations,
      candidateLimit,
      rowsRead: result.meta.rows_read,
    };
  }
}
