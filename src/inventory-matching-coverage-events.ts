import { InventoryComparisonGenerations } from "./inventory-comparison-generations.ts";
import { inventoryCoverageRange } from "./inventory-coverage-keys.ts";
import { inventoryRunQuery } from "./inventory-run-plans.ts";
import { canonical, sha256 } from "./security.ts";
import type { Lease, Store } from "./store.ts";

export interface MatchingCoverageEventKey {
  scope: string;
  stream: string;
  facet: "source" | "receipt";
  partition: string;
}
interface CoverageEvent {
  tenant: string;
  scope_id: string;
  stream_id: string;
  facet: "source" | "receipt";
  partition_id: string;
  config_version: number;
  published_run_id: string;
  coverage_version: number;
  work_version: number;
  completed_version: number;
  generation_id: string;
  key_id: string;
  domain_version: number;
  source_set_version: number;
  scope_clock: number;
  provider: "lofi" | "qrz" | "lotw";
  query: string;
}
export interface PreparedMatchingCoverageEvent {
  event: CoverageEvent;
  lease: Lease;
  dispatchId: string;
  nodes: string[];
  preparedAt: number;
  digest: string;
}
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;
const validKey = (key: MatchingCoverageEventKey) =>
  [key.scope, key.stream, key.partition].every(identifier) &&
  ["source", "receipt"].includes(key.facet);
export const matchingCoverageEventLeaseScope = (
  key: MatchingCoverageEventKey,
) =>
  canonical([
    "matching-coverage-event",
    key.scope,
    key.stream,
    key.facet,
    key.partition,
  ]);
const eventKey = (event: CoverageEvent): MatchingCoverageEventKey => ({
  scope: event.scope_id,
  stream: event.stream_id,
  facet: event.facet,
  partition: event.partition_id,
});

/** Dispatch completed full selections into coalesced calendar-prefix jobs. The
 * publication scans eligible route metadata and point probes current interests;
 * it does not enumerate contacts, refresh observations or authorize writes. */
export class InventoryMatchingCoverageEvents {
  constructor(readonly store: Store) {}
  async prepare(tenant: string, key: MatchingCoverageEventKey, lease: Lease) {
    key = structuredClone(key);
    lease = structuredClone(lease);
    if (
      !identifier(tenant) ||
      !validKey(key) ||
      lease.tenant !== tenant ||
      lease.scope !== matchingCoverageEventLeaseScope(key)
    )
      throw new Error("invalid_inventory_matching_coverage_event");
    const event = await this.store
      .statement(
        `SELECT e.*,d.active_generation AS generation_id,g.key_id,d.version AS domain_version,d.source_set_version,clk.version AS scope_clock,s.provider,r.fixed_query AS query
FROM inventory_matching_coverage_events e
JOIN inventory_matching_recoverable_coverage cv ON cv.tenant=e.tenant AND cv.scope_id=e.scope_id AND cv.stream_id=e.stream_id AND cv.facet=e.facet AND cv.partition_id=e.partition_id AND cv.version=e.coverage_version AND cv.published_run_id=e.published_run_id AND cv.published_config_version=e.config_version
JOIN inventory_scopes s ON s.tenant=e.tenant AND s.scope_id=e.scope_id AND s.state='observing' AND s.config_version=e.config_version
JOIN accounts a ON a.id=s.tenant AND a.status='active'
JOIN connections c ON c.tenant=s.tenant AND c.id=s.connection_id AND c.status='active' AND c.kind=s.provider AND c.remote_identity=s.logical_identity
JOIN comparison_domains d ON d.tenant=e.tenant
JOIN index_generations g ON g.tenant=d.tenant AND g.generation_id=d.active_generation AND g.state='active'
JOIN inventory_comparison_keys k ON k.tenant=g.tenant AND k.key_id=g.key_id
JOIN inventory_comparison_ready_builds b ON b.tenant=g.tenant AND b.generation_id=g.generation_id AND b.scope_id=s.scope_id AND b.config_version=e.config_version
JOIN inventory_matching_coverage_clocks clk ON clk.tenant=e.tenant AND clk.scope_id=e.scope_id AND clk.facet=e.facet
JOIN inventory_runs r ON r.tenant=e.tenant AND r.run_id=e.published_run_id
WHERE e.tenant=? AND e.scope_id=? AND e.stream_id=? AND e.facet=? AND e.partition_id=? AND e.completed_version<e.work_version`,
        tenant,
        key.scope,
        key.stream,
        key.facet,
        key.partition,
      )
      .first<CoverageEvent>();
    if (!event) return null;
    let nodes: string[];
    if (event.facet === "source") nodes = [""];
    else {
      const query = inventoryRunQuery(JSON.parse(event.query));
      if (query.provider !== event.provider || query.provider === "lofi")
        throw new Error("inventory_matching_coverage_query_changed");
      let dates: [string, string];
      if (query.provider === "qrz") {
        if (query.selection.modifiedSince !== undefined)
          throw new Error("inventory_matching_coverage_selection_incomplete");
        dates = query.selection.between;
      } else {
        const selection = query.query;
        if ("kind" in selection || selection.receivedSince !== undefined)
          throw new Error("inventory_matching_coverage_selection_incomplete");
        dates = [selection.startDate, selection.endDate];
      }
      const key = await new InventoryComparisonGenerations(this.store).key(
        tenant,
      );
      if (key.keyId !== event.key_id)
        throw new Error("inventory_matching_coverage_key_changed");
      nodes = await inventoryCoverageRange(key, event.scope_id, ...dates);
    }
    const input = {
      event,
      lease,
      nodes,
      dispatchId: crypto.randomUUID(),
      preparedAt: Date.now(),
    };
    return { ...input, digest: await sha256(canonical(input)) };
  }
  private async recover(page: PreparedMatchingCoverageEvent) {
    const row = await this.store
      .statement(
        "SELECT input_digest,state,queued_count FROM inventory_matching_coverage_dispatches WHERE tenant=? AND dispatch_id=?",
        page.event.tenant,
        page.dispatchId,
      )
      .first<{ input_digest: string; state: string; queued_count: number }>();
    if (!row) return null;
    if (row.input_digest !== page.digest || row.state !== "committed")
      throw new Error("inventory_matching_coverage_dispatch_receipt_conflict");
    return {
      dispatchId: page.dispatchId,
      recovered: true,
      jobs: row.queued_count,
      statements: 0,
      rowsRead: 0,
      rowsWritten: 0,
    };
  }
  async publish(page: PreparedMatchingCoverageEvent) {
    page = structuredClone(page);
    const { digest, ...input } = page;
    if (digest !== (await sha256(canonical(input))))
      throw new Error("inventory_matching_coverage_event_preparation_changed");
    const e = page.event;
    if (
      !identifier(e.tenant) ||
      !validKey(eventKey(e)) ||
      !identifier(page.dispatchId) ||
      !Array.isArray(page.nodes) ||
      page.nodes.length < 1 ||
      page.nodes.length > 44 ||
      page.lease.tenant !== e.tenant ||
      page.lease.scope !== matchingCoverageEventLeaseScope(eventKey(e))
    )
      throw new Error("invalid_inventory_matching_coverage_event_manifest");
    const recovered = await this.recover(page);
    if (recovered) return recovered;
    let results: D1Result[];
    try {
      results = await this.store.db.batch([
        this.store.statement(
          `INSERT INTO inventory_matching_coverage_dispatches(tenant,dispatch_id,scope_id,stream_id,facet,partition_id,generation_id,key_id,domain_version,source_set_version,config_version,published_run_id,coverage_version,scope_clock,work_version,completed_version,nodes,queued_count,lease_token,lease_fence,input_digest,prepared_at)
SELECT ?1,?17,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,
(SELECT count(*) FROM json_each(?16) n WHERE EXISTS(SELECT 1 FROM inventory_matching_coverage_live_routes r WHERE r.tenant=?1 AND r.generation_id=?6 AND EXISTS(SELECT 1 FROM inventory_matching_coverage_dependents dep INDEXED BY inventory_matching_coverage_dependents_cursor WHERE dep.tenant=r.tenant AND dep.generation_id=r.generation_id AND dep.scope_id=?2 AND dep.facet=?4 AND dep.node_hash=n.value AND dep.destination=r.destination AND dep.source_scope=r.source_scope AND dep.seen_clock<?13)) AND NOT EXISTS(SELECT 1 FROM inventory_matching_coverage_jobs w WHERE w.tenant=?1 AND w.generation_id=?6 AND w.scope_id=?2 AND w.facet=?4 AND w.node_hash=n.value AND w.signal_clock>=?13)),?18,?19,?20,?21 RETURNING queued_count`,
          e.tenant,
          e.scope_id,
          e.stream_id,
          e.facet,
          e.partition_id,
          e.generation_id,
          e.key_id,
          e.domain_version,
          e.source_set_version,
          e.config_version,
          e.published_run_id,
          e.coverage_version,
          e.scope_clock,
          e.work_version,
          e.completed_version,
          canonical(page.nodes),
          page.dispatchId,
          page.lease.token,
          page.lease.fence,
          page.digest,
          page.preparedAt,
        ),
      ]);
    } catch (error) {
      const receipt = await this.recover(page).catch(() => null);
      if (receipt) return receipt;
      throw error;
    }
    return {
      dispatchId: page.dispatchId,
      recovered: false,
      jobs: (results[0].results[0] as { queued_count: number }).queued_count,
      statements: 1,
      rowsRead: results.reduce((n, r) => n + r.meta.rows_read, 0),
      rowsWritten: results.reduce((n, r) => n + r.meta.rows_written, 0),
    };
  }
  async step(tenant: string) {
    if (!identifier(tenant))
      throw new Error("invalid_inventory_matching_coverage_event_tenant");
    const key = await this.store
      .statement(
        `WITH live AS MATERIALIZED(SELECT s.* FROM comparison_domains d CROSS JOIN inventory_comparison_ready_builds s WHERE d.tenant=?1 AND s.tenant=d.tenant AND s.generation_id=d.active_generation),heads AS MATERIALIZED(
SELECT s.*,(SELECT e.rowid FROM inventory_matching_coverage_events e INDEXED BY inventory_matching_coverage_event_pending JOIN inventory_matching_recoverable_coverage cv ON cv.tenant=e.tenant AND cv.scope_id=e.scope_id AND cv.stream_id=e.stream_id AND cv.facet=e.facet AND cv.partition_id=e.partition_id AND cv.version=e.coverage_version AND cv.published_run_id=e.published_run_id AND cv.published_config_version=e.config_version WHERE e.tenant=s.tenant AND e.scope_id=s.scope_id AND e.config_version=s.config_version AND e.completed_version<e.work_version ORDER BY e.stream_id,e.facet,e.partition_id LIMIT 1) AS head FROM live s)
SELECT e.scope_id AS scope,e.stream_id AS stream,e.facet,e.partition_id AS partition FROM heads h CROSS JOIN inventory_matching_coverage_events e WHERE e.rowid=h.head ORDER BY e.scope_id,e.stream_id,e.facet,e.partition_id LIMIT 1`,
        tenant,
      )
      .first<MatchingCoverageEventKey>();
    if (!key) return { kind: "idle" as const };
    const lease = await this.store.claim(
      tenant,
      matchingCoverageEventLeaseScope(key),
      Date.now(),
      60000,
    );
    if (!lease) return { kind: "deferred" as const };
    try {
      const page = await this.prepare(tenant, key, lease);
      if (!page) return { kind: "idle" as const };
      return { kind: "dispatched" as const, ...(await this.publish(page)) };
    } finally {
      await this.store.release(lease);
    }
  }
}
