import {
  INVENTORY_LOTW_BATCH_LIMIT,
  INVENTORY_SOURCE_PROOF_DEPENDENCY_LIMIT,
} from "./inventory-delivery-limits.ts";
import { canonical } from "./security.ts";
import {
  SOURCE_PRESENCE_MAX_AGE_MS,
  type SourcePresenceScope,
  type SourcePresenceTarget,
  type SourcePresenceWitness,
} from "./source-presence-collector.ts";
import type { Store } from "./store.ts";

export interface InventorySourceProofScope {
  tenant: string;
  scope_id: string;
  connection_id: string;
  logical_identity: string;
  config_version: number;
  runtime_version: number;
  connection_config: string;
  credential_version: string;
  stream_id: string;
  checkpoint_version: number;
  work_version: number;
  partition_id: string;
  coverage_epoch: number;
  policy_epoch: string;
  generation_id: string;
  quiet_minutes: number;
}

export interface InventorySourceProofRoute {
  provider: "qrz" | "lotw";
  destination: string;
  result_set: string;
  result_version: number;
}
interface ReviewedContact extends InventorySourceProofRoute {
  record_key: string;
  projection_version: number;
  projection_payload: string;
  topology_version: number;
  eligible_after: number;
}
interface DependencyRow {
  kind: SourcePresenceTarget["kind"];
  key: string;
  subtype: "operation" | "qso" | "event" | null;
  parent: string | null;
  status: "active" | "deleted" | null;
  revision: string | null;
  stamp: number | null;
  payload: string | null;
  semantic_version: number | null;
  membership_version: number | null;
  membership: "present" | "unresolved" | null;
  witness: number | null;
  anchor: number | null;
}
export interface InventorySourceProofDependency {
  target: SourcePresenceTarget;
  payload: string;
  semanticVersion: number;
  membershipVersion: number;
}
export interface InventorySourceProofContact {
  key: string;
  operation: string | null;
  projectionVersion: number;
  projectionPayload: string;
  topologyVersion: number;
  eligibleAfter: number;
  routes: InventorySourceProofRoute[];
}
export interface InventorySourceProofSnapshot {
  source: InventorySourceProofScope;
  presence: SourcePresenceScope;
  contacts: InventorySourceProofContact[];
  dependencies: InventorySourceProofDependency[];
  cachedWitnesses: SourcePresenceWitness[];
  anchors: { kind: SourcePresenceTarget["kind"]; syncedAtMillis: number }[];
}
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
const stamp = (value: number | null): value is number =>
  value !== null && Number.isSafeInteger(value) && value >= 0;

/** Gather one source closure for all current routes, from accepted metadata. */
export class InventorySourceProofWorkspace {
  constructor(readonly store: Store) {}

  async capture(
    tenant: string,
    scope: string,
    contactKeys: readonly string[],
    now = Date.now(),
  ) {
    const keys = [...contactKeys].sort();
    if (
      !identifier(tenant) ||
      !identifier(scope) ||
      keys.length < 1 ||
      keys.length > INVENTORY_LOTW_BATCH_LIMIT ||
      keys.some((key) => !identifier(key)) ||
      new Set(keys).size !== keys.length ||
      !stamp(now)
    )
      throw new Error("invalid_inventory_source_proof_selection");
    const selected = canonical(keys);
    const [scopeRows, reviewedRows, dependencyRows] = await this.store.db.batch(
      [
        this.store.statement(
          "SELECT * FROM inventory_source_proof_scope WHERE tenant=? AND scope_id=? LIMIT 2",
          tenant,
          scope,
        ),
        this.store.statement(
          `WITH chosen AS MATERIALIZED(
           SELECT b.record_key,b.destination,b.provider,b.result_set,b.result_version,
                  b.projection_version,b.projection_payload,p.topology_version,
                  max(b.proof_not_before,p.derived_at+s.quiet_minutes*60000) AS eligible_after
           FROM json_each(?1) x CROSS JOIN inventory_delivery_review_basis b
           JOIN inventory_source_proof_scope s ON s.tenant=b.tenant AND s.scope_id=b.source_scope AND s.generation_id=b.generation_id
           JOIN comparison_projections p ON p.tenant=b.tenant AND p.generation_id=b.generation_id AND p.scope_id=b.source_scope AND p.record_key=b.record_key AND p.facet='source' AND p.version=b.projection_version AND p.payload_id=b.projection_payload
           WHERE b.tenant=?2 AND b.source_scope=?3 AND b.record_key=x.value
             AND b.decision='source_proof_required' AND b.blocker IS NULL AND b.ownership_version=b.current_ownership_version
             AND b.source_credential=b.current_source_credential AND b.destination_credential=b.current_destination_credential
           LIMIT ${INVENTORY_SOURCE_PROOF_DEPENDENCY_LIMIT + 1}
         ), valid AS MATERIALIZED(
           SELECT result_set FROM (SELECT DISTINCT result_set FROM chosen) c
           WHERE NOT EXISTS(SELECT 1 FROM inventory_match_stale_sets stale WHERE stale.tenant=?2 AND stale.set_id=c.result_set)
         )
         SELECT c.* FROM chosen c JOIN valid v USING(result_set) ORDER BY c.record_key,c.destination`,
          selected,
          tenant,
          scope,
        ),
        this.store.statement(
          `WITH source AS MATERIALIZED(SELECT * FROM inventory_source_proof_scope WHERE tenant=?2 AND scope_id=?3),
         parents AS MATERIALIZED(
           SELECT DISTINCT e.parent_key FROM json_each(?1) j CROSS JOIN inventory_records e
           WHERE e.tenant=?2 AND e.scope_id=?3 AND e.entity_family='qso' AND e.record_key=j.value AND e.parent_key IS NOT NULL
         ), refs(kind,key) AS MATERIALIZED(
           SELECT 'qso',value FROM json_each(?1)
           UNION ALL SELECT 'operation',parent_key FROM parents
           UNION ALL SELECT 'qso',e.record_key FROM parents p CROSS JOIN inventory_records e INDEXED BY inventory_parent
            WHERE e.tenant=?2 AND e.scope_id=?3 AND e.parent_key=p.parent_key AND e.entity_family='qso' AND e.subtype='event' AND e.status='active'
           LIMIT ${INVENTORY_SOURCE_PROOF_DEPENDENCY_LIMIT + 1}
         )
         SELECT ref.kind,ref.key,e.subtype,e.parent_key AS parent,e.status,f.revision,f.revision_order AS stamp,f.payload_id AS payload,
                f.semantic_version,coalesce(mv.version,0) AS membership_version,m.state AS membership,
                CASE WHEN x.action='page' AND p.state='committed' AND p.stream_id=s.stream_id AND p.expected_config_version=s.config_version AND p.credential_version=s.credential_version
                       AND json_extract(p.next_resume,'$.policyEpoch')=s.policy_epoch AND p.expected_sequence+1=f.last_accepted_sequence
                       AND p.request_started_at>?4 AND p.request_started_at<=?5 THEN p.request_started_at END AS witness,
                (SELECT a.revision_order FROM inventory_record_facets a INDEXED BY inventory_source_presence_anchor
                 WHERE a.tenant=s.tenant AND a.scope_id=s.scope_id AND a.entity_family=ref.kind AND a.facet='source' AND a.revision_order IS NOT NULL AND a.revision_order>f.revision_order
                 ORDER BY a.revision_order LIMIT 1) AS anchor
         FROM source s CROSS JOIN refs ref
         LEFT JOIN inventory_records e ON e.tenant=s.tenant AND e.scope_id=s.scope_id AND e.entity_family=ref.kind AND e.record_key=ref.key
         LEFT JOIN inventory_record_facets f ON f.tenant=e.tenant AND f.scope_id=e.scope_id AND f.entity_family=e.entity_family AND f.record_key=e.record_key AND f.facet='source'
         LEFT JOIN inventory_partition_membership m ON m.tenant=e.tenant AND m.scope_id=e.scope_id AND m.entity_family=e.entity_family AND m.record_key=e.record_key AND m.facet='source' AND m.stream_id=s.stream_id AND m.partition_id=s.partition_id
         LEFT JOIN inventory_membership_versions mv ON mv.tenant=e.tenant AND mv.scope_id=e.scope_id AND mv.entity_family=e.entity_family AND mv.record_key=e.record_key AND mv.facet='source'
         LEFT JOIN ingestion_pages p ON p.tenant=f.tenant AND p.scope_id=f.scope_id AND p.page_id=f.last_page_id
         LEFT JOIN ingestion_run_pages x ON x.tenant=p.tenant AND x.page_id=p.page_id
         ORDER BY ref.kind,ref.key`,
          selected,
          tenant,
          scope,
          now - SOURCE_PRESENCE_MAX_AGE_MS,
          now,
        ),
      ],
    );
    const source = scopeRows.results[0] as
      | InventorySourceProofScope
      | undefined;
    if (
      scopeRows.results.length !== 1 ||
      !source ||
      ![
        source.connection_id,
        source.logical_identity,
        source.credential_version,
        source.policy_epoch,
      ].every(identifier)
    )
      return { kind: "held" as const, reason: "source_unavailable" as const };
    const reviewed = reviewedRows.results as unknown as ReviewedContact[];
    const rows = dependencyRows.results as unknown as DependencyRow[];
    if (
      reviewed.length > INVENTORY_SOURCE_PROOF_DEPENDENCY_LIMIT ||
      rows.length > INVENTORY_SOURCE_PROOF_DEPENDENCY_LIMIT
    )
      return { kind: "held" as const, reason: "dependency_bound" as const };
    if (new Set(reviewed.map((row) => row.record_key)).size !== keys.length)
      return { kind: "held" as const, reason: "review_unavailable" as const };
    const presence: SourcePresenceScope = {
      tenant,
      source: source.connection_id,
      accountId: source.logical_identity,
      credentialVersion: source.credential_version,
      readerPolicy: "all-clients-v1",
      policyEpoch: source.policy_epoch,
    };
    const dependencies: InventorySourceProofDependency[] = [];
    const cachedWitnesses: SourcePresenceWitness[] = [];
    const anchors = new Map<
      string,
      InventorySourceProofSnapshot["anchors"][number]
    >();
    for (const row of rows) {
      if (
        row.status !== "active" ||
        row.membership !== "present" ||
        !identifier(row.key) ||
        (row.parent !== null && !identifier(row.parent)) ||
        !row.revision ||
        !/^[A-Za-z0-9_-]{43}$/.test(row.revision) ||
        !stamp(row.stamp) ||
        !row.payload ||
        !row.semantic_version ||
        !stamp(row.membership_version) ||
        row.subtype !==
          (row.kind === "operation"
            ? "operation"
            : keys.includes(row.key)
              ? "qso"
              : "event")
      )
        return {
          kind: "held" as const,
          reason: "dependency_unavailable" as const,
        };
      const target: SourcePresenceTarget = {
        kind: row.kind,
        id: row.key,
        operationId: row.kind === "operation" ? row.key : row.parent,
        revision: row.revision,
        syncedAtMillis: row.stamp,
        deleted: false,
        isEvent: row.subtype === "event",
      };
      dependencies.push({
        target,
        payload: row.payload,
        semanticVersion: row.semantic_version,
        membershipVersion: row.membership_version,
      });
      if (stamp(row.witness))
        cachedWitnesses.push({
          scope: presence,
          target,
          requestStartedAt: row.witness,
        });
      if (stamp(row.anchor))
        anchors.set(canonical([row.kind, row.anchor]), {
          kind: row.kind,
          syncedAtMillis: row.anchor,
        });
    }
    const contacts: InventorySourceProofContact[] = [];
    for (const key of keys) {
      const dependency = dependencies.find(
        ({ target }) => target.kind === "qso" && target.id === key,
      );
      const routes = reviewed.filter((row) => row.record_key === key);
      const [first] = routes;
      if (
        !dependency ||
        !first ||
        routes.some(
          (row) =>
            row.projection_version !== first.projection_version ||
            row.projection_payload !== first.projection_payload ||
            row.topology_version !== first.topology_version,
        )
      )
        return { kind: "held" as const, reason: "review_unavailable" as const };
      contacts.push({
        key,
        operation: dependency.target.operationId,
        projectionVersion: first.projection_version,
        projectionPayload: first.projection_payload,
        topologyVersion: first.topology_version,
        eligibleAfter: Math.max(...routes.map((row) => row.eligible_after)),
        routes: routes.map(
          ({ provider, destination, result_set, result_version }) => ({
            provider,
            destination,
            result_set,
            result_version,
          }),
        ),
      });
    }
    return {
      kind: "captured" as const,
      snapshot: {
        source,
        presence,
        contacts,
        dependencies,
        cachedWitnesses,
        anchors: [...anchors.values()],
      } satisfies InventorySourceProofSnapshot,
    };
  }
}
