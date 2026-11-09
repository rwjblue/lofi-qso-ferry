import { canonical, sha256 } from "./security.ts";
import type { Lease, Store } from "./store.ts";

export interface MatchingPairKey {
  generation: string;
  destination: string;
  source: string;
}
interface PairJob {
  tenant: string;
  generation_id: string;
  destination: string;
  source_scope: string;
  source_config_version: number;
  destination_config_version: number;
  source_set_version: number;
  work_version: number;
  completed_version: number;
  cursor_key: string;
  last_turn: number;
}
export interface PreparedMatchingPair {
  job: PairJob;
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
  complete: number;
}
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;
const validKey = (key: MatchingPairKey) =>
  [key.generation, key.destination, key.source].every(identifier);
export const matchingPairLeaseScope = (key: MatchingPairKey) =>
  canonical(["matching-pair", key.generation, key.destination, key.source]);
const jobKey = (job: PairJob): MatchingPairKey => ({
  generation: job.generation_id,
  destination: job.destination,
  source: job.source_scope,
});

/** Expand global metadata changes and initial enrollment in bounded native
 * pages. No source body, vendor transport or delivery authority is involved. */
export class InventoryMatchingPairs {
  constructor(readonly store: Store) {}
  async prepare(
    tenant: string,
    key: MatchingPairKey,
    lease: Lease,
    limit = 200,
  ) {
    key = structuredClone(key);
    lease = structuredClone(lease);
    if (
      !identifier(tenant) ||
      !validKey(key) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      lease.tenant !== tenant ||
      lease.scope !== matchingPairLeaseScope(key)
    )
      throw new Error("invalid_inventory_matching_pair");
    const job = await this.store
      .statement(
        "SELECT tenant,generation_id,destination,source_scope,source_config_version,destination_config_version,source_set_version,work_version,completed_version,cursor_key,last_turn FROM inventory_matching_pair_jobs WHERE tenant=? AND generation_id=? AND destination=? AND source_scope=?",
        tenant,
        key.generation,
        key.destination,
        key.source,
      )
      .first<PairJob>();
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
  private async recover(page: PreparedMatchingPair) {
    const row = await this.store
      .statement(
        "SELECT input_digest,state,row_count,complete FROM inventory_matching_pair_pages WHERE tenant=? AND page_id=?",
        page.job.tenant,
        page.pageId,
      )
      .first<Receipt>();
    if (!row) return null;
    if (row.input_digest !== page.digest || row.state !== "committed")
      throw new Error("inventory_matching_pair_receipt_conflict");
    return {
      pageId: page.pageId,
      recovered: true,
      records: row.row_count,
      complete: !!row.complete,
      statements: 0,
      rowsRead: 0,
      rowsWritten: 0,
    };
  }
  async publish(page: PreparedMatchingPair) {
    page = structuredClone(page);
    const { digest, ...input } = page;
    if (digest !== (await sha256(canonical(input))))
      throw new Error("inventory_matching_pair_preparation_changed");
    const j = page.job;
    if (
      !identifier(j.tenant) ||
      !validKey(jobKey(j)) ||
      !identifier(page.pageId) ||
      !Number.isSafeInteger(page.limit) ||
      page.limit < 1 ||
      page.limit > 200 ||
      page.lease.tenant !== j.tenant ||
      page.lease.scope !== matchingPairLeaseScope(jobKey(j))
    )
      throw new Error("invalid_inventory_matching_pair_manifest");
    const recovered = await this.recover(page);
    if (recovered) return recovered;
    const bound = (sql: string) =>
      this.store.statement(sql, j.tenant, page.pageId);
    const plan = [
      this.store.statement(
        `WITH source AS MATERIALIZED(SELECT record_key FROM comparison_index INDEXED BY inventory_matching_source_census WHERE tenant=?1 AND generation_id=?2 AND scope_id=?4 AND config_version=?5 AND facet='source' AND state!='retired' AND record_key>?6 ORDER BY record_key LIMIT ?7+1), existing AS MATERIALIZED(SELECT record_key FROM match_results WHERE tenant=?1 AND destination=?3 AND source_scope=?4 AND record_key>?6 ORDER BY record_key LIMIT ?7+1), keys AS MATERIALIZED(SELECT record_key FROM source UNION SELECT record_key FROM existing ORDER BY record_key LIMIT ?7+1), chunk AS MATERIALIZED(SELECT record_key FROM keys ORDER BY record_key LIMIT ?7)
INSERT INTO inventory_matching_pair_pages(tenant,page_id,generation_id,destination,source_scope,source_config_version,destination_config_version,source_set_version,work_version,completed_version,previous_key,next_key,previous_turn,next_turn,page_limit,row_count,complete,lease_token,lease_fence,input_digest,prepared_at)
SELECT ?1,?8,?2,?3,?4,?5,?9,?10,?11,?12,?6,coalesce((SELECT max(record_key) FROM chunk),?6),?17,(SELECT coalesce(max(last_turn),0)+1 FROM inventory_matching_pair_jobs WHERE tenant=?1),?7,(SELECT count(*) FROM chunk),CASE WHEN (SELECT count(*) FROM keys)>?7 THEN 0 ELSE 1 END,?13,?14,?15,?16 RETURNING row_count,complete`,
        j.tenant,
        j.generation_id,
        j.destination,
        j.source_scope,
        j.source_config_version,
        j.cursor_key,
        page.limit,
        page.pageId,
        j.destination_config_version,
        j.source_set_version,
        j.work_version,
        j.completed_version,
        page.lease.token,
        page.lease.fence,
        page.digest,
        page.preparedAt,
        j.last_turn,
      ),
      bound(
        `WITH candidates AS MATERIALIZED(SELECT * FROM inventory_matching_pair_source_candidates WHERE tenant=?1 AND page_id=?2 UNION ALL SELECT * FROM inventory_matching_pair_result_candidates WHERE tenant=?1 AND page_id=?2)
INSERT INTO inventory_matching_pair_rows(tenant,page_id,record_key,expected_work_version,expected_completed_version) SELECT c.tenant,c.page_id,c.record_key,coalesce(w.work_version,0),coalesce(w.completed_version,0) FROM candidates c JOIN inventory_matching_pair_pages h ON h.tenant=c.tenant AND h.page_id=c.page_id LEFT JOIN matching_work w ON w.tenant=c.tenant AND w.generation_id=h.generation_id AND w.destination=h.destination AND w.source_scope=h.source_scope AND w.record_key=c.record_key WHERE c.tenant=?1 AND c.page_id=?2`,
      ),
      bound(
        "INSERT INTO inventory_matching_pair_guards(tenant,page_id) VALUES(?,?)",
      ),
      bound(
        `INSERT INTO matching_work(tenant,generation_id,destination,source_scope,record_key,source_config_version,destination_config_version) SELECT q.tenant,p.generation_id,p.destination,p.source_scope,q.record_key,p.source_config_version,p.destination_config_version FROM inventory_matching_pair_rows q JOIN inventory_matching_pair_pages p ON p.tenant=q.tenant AND p.page_id=q.page_id WHERE q.tenant=?1 AND q.page_id=?2 ON CONFLICT(tenant,generation_id,destination,source_scope,record_key) DO UPDATE SET source_config_version=excluded.source_config_version,destination_config_version=excluded.destination_config_version,work_version=matching_work.work_version+1,due_at=0,hold_reason=NULL`,
      ),
      bound(
        `UPDATE inventory_matching_pair_jobs SET (cursor_key,completed_version,last_turn)=(SELECT next_key,CASE complete WHEN 1 THEN work_version ELSE completed_version END,next_turn FROM inventory_matching_pair_pages WHERE tenant=?1 AND page_id=?2) WHERE rowid IN(SELECT j.rowid FROM inventory_matching_pair_pages p CROSS JOIN inventory_matching_pair_jobs j WHERE p.tenant=?1 AND p.page_id=?2 AND j.tenant=p.tenant AND j.generation_id=p.generation_id AND j.destination=p.destination AND j.source_scope=p.source_scope)`,
      ),
      bound(
        "UPDATE inventory_matching_pair_pages SET state='committed' WHERE tenant=? AND page_id=?",
      ),
    ];
    let results: D1Result[];
    try {
      results = await this.store.db.batch(plan);
    } catch (error) {
      const receipt = await this.recover(page).catch(() => null);
      if (receipt) return receipt;
      throw error;
    }
    const receipt = results[0].results[0] as Pick<
      Receipt,
      "row_count" | "complete"
    >;
    return {
      pageId: page.pageId,
      recovered: false,
      records: receipt.row_count,
      complete: !!receipt.complete,
      statements: plan.length,
      rowsRead: results.reduce((n, row) => n + row.meta.rows_read, 0),
      rowsWritten: results.reduce((n, row) => n + row.meta.rows_written, 0),
    };
  }
  headStatement(tenant: string) {
    if (!identifier(tenant))
      throw new Error("invalid_inventory_matching_pair_tenant");
    return this.store.statement(
      `WITH live AS MATERIALIZED(SELECT * FROM inventory_matching_ready_pairs WHERE tenant=?1)
SELECT j.generation_id AS generation,j.destination,j.source_scope AS source FROM live r CROSS JOIN inventory_matching_pair_jobs j JOIN comparison_domains d ON d.tenant=j.tenant AND d.source_set_version=j.source_set_version WHERE j.tenant=r.tenant AND j.generation_id=r.generation_id AND j.destination=r.destination AND j.source_scope=r.source_scope AND j.source_config_version=r.source_config_version AND j.destination_config_version=r.destination_config_version AND j.completed_version<j.work_version ORDER BY j.last_turn,j.destination,j.source_scope LIMIT 1`,
      tenant,
    );
  }

  async step(tenant: string) {
    const key = await this.headStatement(tenant).first<MatchingPairKey>();
    if (!key) return { kind: "idle" as const };
    const lease = await this.store.claim(
      tenant,
      matchingPairLeaseScope(key),
      Date.now(),
      60000,
    );
    if (!lease) return { kind: "deferred" as const };
    try {
      const page = await this.prepare(tenant, key, lease);
      if (!page) return { kind: "idle" as const };
      return { kind: "enrolled" as const, ...(await this.publish(page)) };
    } finally {
      await this.store.release(lease);
    }
  }
}
