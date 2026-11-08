import { canonical, sha256 } from "./security.ts";
import type { Lease, Store } from "./store.ts";

export interface MatchingCoverageKey {
  generation: string;
  scope: string;
  facet: "source" | "receipt";
  hash: string;
}
interface CoverageJob {
  tenant: string;
  generation_id: string;
  scope_id: string;
  facet: "source" | "receipt";
  node_hash: string;
  config_version: number;
  signal_clock: number;
  work_version: number;
  completed_version: number;
  cursor_destination: string;
  cursor_source: string;
  cursor_clock: number;
  cursor_set: string;
  last_turn: number;
  domain_version: number;
  source_set_version: number;
}
export interface PreparedMatchingCoverage {
  job: CoverageJob;
  lease: Lease;
  pageId: string;
  limit: number;
  preparedAt: number;
  digest: string;
}
interface Receipt {
  input_digest: string;
  state: string;
  row_count: number;
  set_count: number;
  complete: number;
}
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;
const validKey = (key: MatchingCoverageKey) =>
  identifier(key.generation) &&
  identifier(key.scope) &&
  ((key.facet === "source" && key.hash === "") ||
    (key.facet === "receipt" && /^[A-Za-z0-9_-]{43}$/.test(key.hash)));
export const matchingCoverageLeaseScope = (key: MatchingCoverageKey) =>
  canonical([
    "matching-coverage-node",
    key.generation,
    key.scope,
    key.facet,
    key.hash,
  ]);
const jobKey = (job: CoverageJob): MatchingCoverageKey => ({
  generation: job.generation_id,
  scope: job.scope_id,
  facet: job.facet,
  hash: job.node_hash,
});

/** Publish at most ten current incomplete cohort/routes and two hundred contact
 * references. Eligible route metadata precedes bounded reverse-index probes. */
export class InventoryMatchingCoverage {
  constructor(readonly store: Store) {}
  async prepare(
    tenant: string,
    key: MatchingCoverageKey,
    lease: Lease,
    limit = 10,
  ) {
    key = structuredClone(key);
    lease = structuredClone(lease);
    if (
      !identifier(tenant) ||
      !validKey(key) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 10 ||
      lease.tenant !== tenant ||
      lease.scope !== matchingCoverageLeaseScope(key)
    )
      throw new Error("invalid_inventory_matching_coverage");
    const job = await this.store
      .statement(
        `SELECT j.*,d.version AS domain_version,d.source_set_version FROM inventory_matching_coverage_jobs j JOIN comparison_domains d ON d.tenant=j.tenant AND d.active_generation=j.generation_id WHERE j.tenant=? AND j.generation_id=? AND j.scope_id=? AND j.facet=? AND j.node_hash=?`,
        tenant,
        key.generation,
        key.scope,
        key.facet,
        key.hash,
      )
      .first<CoverageJob>();
    if (!job || job.completed_version === job.work_version) return null;
    const input = {
      job,
      lease,
      pageId: crypto.randomUUID(),
      limit,
      preparedAt: Date.now(),
    };
    return { ...input, digest: await sha256(canonical(input)) };
  }
  private async recover(page: PreparedMatchingCoverage) {
    const row = await this.store
      .statement(
        "SELECT input_digest,state,row_count,set_count,complete FROM inventory_matching_coverage_pages WHERE tenant=? AND page_id=?",
        page.job.tenant,
        page.pageId,
      )
      .first<Receipt>();
    if (!row) return null;
    if (row.input_digest !== page.digest || row.state !== "committed")
      throw new Error("inventory_matching_coverage_receipt_conflict");
    return {
      pageId: page.pageId,
      recovered: true,
      records: row.row_count,
      sets: row.set_count,
      complete: !!row.complete,
      statements: 0,
      rowsRead: 0,
      rowsWritten: 0,
    };
  }
  async publish(page: PreparedMatchingCoverage) {
    page = structuredClone(page);
    const { digest, ...input } = page;
    if (digest !== (await sha256(canonical(input))))
      throw new Error("inventory_matching_coverage_preparation_changed");
    const j = page.job;
    if (
      !identifier(j.tenant) ||
      !validKey(jobKey(j)) ||
      !identifier(page.pageId) ||
      !Number.isSafeInteger(page.limit) ||
      page.limit < 1 ||
      page.limit > 10 ||
      page.lease.tenant !== j.tenant ||
      page.lease.scope !== matchingCoverageLeaseScope(jobKey(j))
    )
      throw new Error("invalid_inventory_matching_coverage_manifest");
    const recovered = await this.recover(page);
    if (recovered) return recovered;
    const bound = (sql: string) =>
      this.store.statement(sql, j.tenant, page.pageId);
    const plan = [
      this.store.statement(
        `WITH routes AS MATERIALIZED(SELECT * FROM inventory_matching_coverage_live_routes WHERE tenant=?1 AND generation_id=?2 AND (destination,source_scope)>=(?7,?8)),
selected AS MATERIALIZED(SELECT r.destination,r.source_scope,CAST(json_extract(n.value,'$.clock') AS INTEGER) AS seen_clock,json_extract(n.value,'$.set') AS set_id FROM routes r CROSS JOIN json_each((SELECT json_group_array(json_object('clock',x.seen_clock,'set',x.set_id)) FROM (SELECT d.seen_clock,d.set_id FROM inventory_matching_coverage_dependents d INDEXED BY inventory_matching_coverage_dependents_cursor WHERE d.tenant=r.tenant AND d.generation_id=r.generation_id AND d.scope_id=?3 AND d.facet=?4 AND d.node_hash=?5 AND d.destination=r.destination AND d.source_scope=r.source_scope AND d.seen_clock<?6 AND (d.seen_clock,d.set_id)>(CASE WHEN (r.destination,r.source_scope)=(?7,?8) THEN ?9 ELSE -1 END,CASE WHEN (r.destination,r.source_scope)=(?7,?8) THEN ?10 ELSE '' END) ORDER BY d.seen_clock,d.set_id LIMIT ?11+1) x)) n ORDER BY r.destination,r.source_scope,seen_clock,set_id LIMIT ?11+1),
chunk AS MATERIALIZED(SELECT * FROM selected ORDER BY destination,source_scope,seen_clock,set_id LIMIT ?11),last AS MATERIALIZED(SELECT * FROM chunk ORDER BY destination DESC,source_scope DESC,seen_clock DESC,set_id DESC LIMIT 1)
INSERT INTO inventory_matching_coverage_pages(tenant,page_id,generation_id,scope_id,facet,node_hash,config_version,domain_version,source_set_version,signal_clock,work_version,completed_version,previous_turn,next_turn,previous_destination,previous_source,previous_clock,previous_set,next_destination,next_source,next_clock,next_set,limit_count,set_count,row_count,complete,lease_token,lease_fence,input_digest,prepared_at)
SELECT ?1,?12,?2,?3,?4,?5,?13,?14,?15,?6,?16,?17,?18,(SELECT coalesce(max(last_turn),0)+1 FROM inventory_matching_coverage_jobs INDEXED BY inventory_matching_coverage_job_turn WHERE tenant=?1),?7,?8,?9,?10,coalesce((SELECT destination FROM last),?7),coalesce((SELECT source_scope FROM last),?8),coalesce((SELECT seen_clock FROM last),?9),coalesce((SELECT set_id FROM last),?10),?11,(SELECT count(*) FROM chunk),(SELECT count(*) FROM chunk c CROSS JOIN match_results r INDEXED BY match_result_set WHERE r.tenant=?1 AND r.set_id=c.set_id AND r.destination=c.destination AND r.source_scope=c.source_scope AND r.state='incomplete'),CASE WHEN (SELECT count(*) FROM selected)>?11 THEN 0 ELSE 1 END,?19,?20,?21,?22 RETURNING row_count,set_count,complete`,
        j.tenant,
        j.generation_id,
        j.scope_id,
        j.facet,
        j.node_hash,
        j.signal_clock,
        j.cursor_destination,
        j.cursor_source,
        j.cursor_clock,
        j.cursor_set,
        page.limit,
        page.pageId,
        j.config_version,
        j.domain_version,
        j.source_set_version,
        j.work_version,
        j.completed_version,
        j.last_turn,
        page.lease.token,
        page.lease.fence,
        page.digest,
        page.preparedAt,
      ),
      bound(`INSERT INTO inventory_matching_coverage_rows(tenant,page_id,destination,source_scope,record_key,source_config_version,destination_config_version,expected_work_version,expected_completed_version)
SELECT c.tenant,c.page_id,c.destination,c.source_scope,c.record_key,c.source_config_version,c.destination_config_version,coalesce(w.work_version,0),coalesce(w.completed_version,0) FROM inventory_matching_coverage_page_candidates c LEFT JOIN matching_work w ON w.tenant=c.tenant AND w.generation_id=c.generation_id AND w.destination=c.destination AND w.source_scope=c.source_scope AND w.record_key=c.record_key WHERE c.tenant=?1 AND c.page_id=?2`),
      bound(
        "INSERT INTO inventory_matching_coverage_guards(tenant,page_id) VALUES(?,?)",
      ),
      bound(
        `INSERT INTO matching_work(tenant,generation_id,destination,source_scope,record_key,source_config_version,destination_config_version) SELECT q.tenant,h.generation_id,q.destination,q.source_scope,q.record_key,q.source_config_version,q.destination_config_version FROM inventory_matching_coverage_rows q JOIN inventory_matching_coverage_pages h ON h.tenant=q.tenant AND h.page_id=q.page_id WHERE q.tenant=?1 AND q.page_id=?2 ON CONFLICT(tenant,generation_id,destination,source_scope,record_key) DO UPDATE SET source_config_version=excluded.source_config_version,destination_config_version=excluded.destination_config_version,work_version=matching_work.work_version+1,due_at=0,hold_reason=NULL`,
      ),
      bound(
        `UPDATE inventory_matching_coverage_jobs SET (cursor_destination,cursor_source,cursor_clock,cursor_set,completed_version,last_turn)=(SELECT next_destination,next_source,next_clock,next_set,CASE complete WHEN 1 THEN work_version ELSE completed_version END,next_turn FROM inventory_matching_coverage_pages WHERE tenant=?1 AND page_id=?2) WHERE rowid IN(SELECT j.rowid FROM inventory_matching_coverage_pages p CROSS JOIN inventory_matching_coverage_jobs j WHERE p.tenant=?1 AND p.page_id=?2 AND j.tenant=p.tenant AND j.generation_id=p.generation_id AND j.scope_id=p.scope_id AND j.facet=p.facet AND j.node_hash=p.node_hash)`,
      ),
      bound(
        "UPDATE inventory_matching_coverage_pages SET state='committed' WHERE tenant=? AND page_id=?",
      ),
    ];
    let results: D1Result[];
    try {
      results = await this.store.db.batch(plan);
    } catch (error) {
      const recovered = await this.recover(page).catch(() => null);
      if (recovered) return recovered;
      throw error;
    }
    const receipt = results[0].results[0] as Pick<
      Receipt,
      "row_count" | "set_count" | "complete"
    >;
    return {
      pageId: page.pageId,
      recovered: false,
      records: receipt.row_count,
      sets: receipt.set_count,
      complete: !!receipt.complete,
      statements: plan.length,
      rowsRead: results.reduce((n, r) => n + r.meta.rows_read, 0),
      rowsWritten: results.reduce((n, r) => n + r.meta.rows_written, 0),
    };
  }
  async step(tenant: string) {
    if (!identifier(tenant))
      throw new Error("invalid_inventory_matching_coverage_tenant");
    const key = await this.store
      .statement(
        `WITH live AS MATERIALIZED(SELECT s.* FROM comparison_domains d CROSS JOIN inventory_comparison_ready_builds s WHERE d.tenant=?1 AND s.tenant=d.tenant AND s.generation_id=d.active_generation),heads AS MATERIALIZED(SELECT s.*,(SELECT j.rowid FROM inventory_matching_coverage_jobs j INDEXED BY inventory_matching_coverage_job_fair WHERE j.tenant=s.tenant AND j.generation_id=s.generation_id AND j.scope_id=s.scope_id AND j.config_version=s.config_version AND j.completed_version<j.work_version ORDER BY j.last_turn,j.facet,j.node_hash LIMIT 1) AS head FROM live s) SELECT j.generation_id AS generation,j.scope_id AS scope,j.facet,j.node_hash AS hash FROM heads h CROSS JOIN inventory_matching_coverage_jobs j WHERE j.rowid=h.head ORDER BY j.last_turn,j.scope_id,j.facet,j.node_hash LIMIT 1`,
        tenant,
      )
      .first<MatchingCoverageKey>();
    if (!key) return { kind: "idle" as const };
    const lease = await this.store.claim(
      tenant,
      matchingCoverageLeaseScope(key),
      Date.now(),
      60000,
    );
    if (!lease) return { kind: "deferred" as const };
    try {
      const page = await this.prepare(tenant, key, lease);
      if (!page) return { kind: "idle" as const };
      return { kind: "expanded" as const, ...(await this.publish(page)) };
    } finally {
      await this.store.release(lease);
    }
  }
}
