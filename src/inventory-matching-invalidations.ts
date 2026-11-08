import { canonical, sha256 } from "./security.ts";
import type { Lease, Store } from "./store.ts";

type KeyClass = "call_and_time" | "call_only" | "time_only" | "unknown";
export interface MatchingBucketKey {
  generation: string;
  scope: string;
  keyClass: KeyClass;
  hash: string;
}
interface BucketJob {
  tenant: string;
  generation_id: string;
  scope_id: string;
  key_class: KeyClass;
  bucket_hash: string;
  config_version: number;
  work_version: number;
  completed_version: number;
  cursor_version: number;
  cursor_set: string;
}
export interface PreparedMatchingInvalidation {
  job: BucketJob;
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
const validKey = (key: MatchingBucketKey) =>
  identifier(key.generation) &&
  identifier(key.scope) &&
  ["call_and_time", "call_only", "time_only", "unknown"].includes(
    key.keyClass,
  ) &&
  /^[A-Za-z0-9_-]{43}$/.test(key.hash);
export const matchingBucketLeaseScope = (key: MatchingBucketKey) =>
  canonical([
    "matching-bucket",
    key.generation,
    key.scope,
    key.keyClass,
    key.hash,
  ]);
const jobKey = (job: BucketJob): MatchingBucketKey => ({
  generation: job.generation_id,
  scope: job.scope_id,
  keyClass: job.key_class,
  hash: job.bucket_hash,
});

/** Expand changed buckets through current cohort dependencies, never retained
 * proof history. All queued references and the cursor share native publication. */
export class InventoryMatchingInvalidations {
  constructor(readonly store: Store) {}
  async prepare(
    tenant: string,
    key: MatchingBucketKey,
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
      lease.scope !== matchingBucketLeaseScope(key)
    )
      throw new Error("invalid_inventory_matching_invalidation");
    const job = await this.store
      .statement(
        "SELECT tenant,generation_id,scope_id,key_class,bucket_hash,config_version,work_version,completed_version,cursor_version,cursor_set FROM inventory_matching_bucket_jobs WHERE tenant=? AND generation_id=? AND scope_id=? AND key_class=? AND bucket_hash=?",
        tenant,
        key.generation,
        key.scope,
        key.keyClass,
        key.hash,
      )
      .first<BucketJob>();
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
  private async recover(page: PreparedMatchingInvalidation) {
    const row = await this.store
      .statement(
        "SELECT input_digest,state,row_count,set_count,complete FROM inventory_matching_bucket_pages WHERE tenant=? AND page_id=?",
        page.job.tenant,
        page.pageId,
      )
      .first<Receipt>();
    if (!row) return null;
    if (row.input_digest !== page.digest || row.state !== "committed")
      throw new Error("inventory_matching_invalidation_receipt_conflict");
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
  async publish(page: PreparedMatchingInvalidation) {
    page = structuredClone(page);
    const { digest, ...input } = page;
    if (digest !== (await sha256(canonical(input))))
      throw new Error("inventory_matching_invalidation_preparation_changed");
    const j = page.job;
    if (
      !identifier(j.tenant) ||
      !validKey(jobKey(j)) ||
      !identifier(page.pageId) ||
      !Number.isSafeInteger(page.limit) ||
      page.limit < 1 ||
      page.limit > 10 ||
      page.lease.tenant !== j.tenant ||
      page.lease.scope !== matchingBucketLeaseScope(jobKey(j))
    )
      throw new Error("invalid_inventory_matching_invalidation_manifest");
    const recovered = await this.recover(page);
    if (recovered) return recovered;
    const bound = (sql: string) =>
      this.store.statement(sql, j.tenant, page.pageId);
    const plan = [
      this.store.statement(
        `WITH selected AS MATERIALIZED(SELECT set_id,seen_version FROM inventory_matching_bucket_dependents INDEXED BY inventory_matching_bucket_dependents_cursor WHERE tenant=?1 AND generation_id=?2 AND scope_id=?3 AND key_class=?4 AND bucket_hash=?5 AND seen_version<?6 AND (seen_version,set_id)>(?7,?8) ORDER BY seen_version,set_id LIMIT ?9+1), chunk AS MATERIALIZED(SELECT * FROM selected ORDER BY seen_version,set_id LIMIT ?9)
INSERT INTO inventory_matching_bucket_pages(tenant,page_id,generation_id,scope_id,key_class,bucket_hash,config_version,work_version,completed_version,previous_version,previous_set,next_version,next_set,set_count,row_count,complete,lease_token,lease_fence,input_digest,prepared_at)
SELECT ?1,?10,?2,?3,?4,?5,?11,?6,?12,?7,?8,coalesce((SELECT seen_version FROM chunk ORDER BY seen_version DESC,set_id DESC LIMIT 1),?7),coalesce((SELECT set_id FROM chunk ORDER BY seen_version DESC,set_id DESC LIMIT 1),?8),(SELECT count(*) FROM chunk),(SELECT count(*) FROM chunk c CROSS JOIN match_results r INDEXED BY match_result_set JOIN inventory_matching_source_routes rt ON rt.tenant=r.tenant AND rt.generation_id=?2 AND rt.destination=r.destination AND rt.source_scope=r.source_scope WHERE r.tenant=?1 AND r.set_id=c.set_id),CASE WHEN (SELECT count(*) FROM selected)>?9 THEN 0 ELSE 1 END,?13,?14,?15,?16 RETURNING row_count,set_count,complete`,
        j.tenant,
        j.generation_id,
        j.scope_id,
        j.key_class,
        j.bucket_hash,
        j.work_version,
        j.cursor_version,
        j.cursor_set,
        page.limit,
        page.pageId,
        j.config_version,
        j.completed_version,
        page.lease.token,
        page.lease.fence,
        page.digest,
        page.preparedAt,
      ),
      bound(
        `INSERT INTO inventory_matching_bucket_rows(tenant,page_id,destination,source_scope,record_key,source_config_version,destination_config_version,expected_work_version,expected_completed_version) SELECT c.tenant,c.page_id,c.destination,c.source_scope,c.record_key,c.source_config_version,c.destination_config_version,coalesce(w.work_version,0),coalesce(w.completed_version,0) FROM inventory_matching_bucket_page_candidates c LEFT JOIN matching_work w ON w.tenant=c.tenant AND w.generation_id=c.generation_id AND w.destination=c.destination AND w.source_scope=c.source_scope AND w.record_key=c.record_key WHERE c.tenant=?1 AND c.page_id=?2`,
      ),
      bound(
        "INSERT INTO inventory_matching_bucket_guards(tenant,page_id) VALUES(?,?)",
      ),
      bound(
        `INSERT INTO matching_work(tenant,generation_id,destination,source_scope,record_key,source_config_version,destination_config_version) SELECT q.tenant,h.generation_id,q.destination,q.source_scope,q.record_key,q.source_config_version,q.destination_config_version FROM inventory_matching_bucket_rows q JOIN inventory_matching_bucket_pages h ON h.tenant=q.tenant AND h.page_id=q.page_id WHERE q.tenant=?1 AND q.page_id=?2 ON CONFLICT(tenant,generation_id,destination,source_scope,record_key) DO UPDATE SET source_config_version=excluded.source_config_version,destination_config_version=excluded.destination_config_version,work_version=matching_work.work_version+1,due_at=0,hold_reason=NULL`,
      ),
      bound(
        `UPDATE inventory_matching_bucket_jobs SET (cursor_version,cursor_set,completed_version)=(SELECT next_version,next_set,CASE complete WHEN 1 THEN work_version ELSE completed_version END FROM inventory_matching_bucket_pages WHERE tenant=?1 AND page_id=?2) WHERE rowid IN(SELECT j.rowid FROM inventory_matching_bucket_pages p CROSS JOIN inventory_matching_bucket_jobs j WHERE p.tenant=?1 AND p.page_id=?2 AND j.tenant=p.tenant AND j.generation_id=p.generation_id AND j.scope_id=p.scope_id AND j.key_class=p.key_class AND j.bucket_hash=p.bucket_hash)`,
      ),
      bound(
        "UPDATE inventory_matching_bucket_pages SET state='committed' WHERE tenant=? AND page_id=?",
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
      rowsRead: results.reduce((n, row) => n + row.meta.rows_read, 0),
      rowsWritten: results.reduce((n, row) => n + row.meta.rows_written, 0),
    };
  }
  async step(tenant: string) {
    if (!identifier(tenant))
      throw new Error("invalid_inventory_matching_invalidation_tenant");
    const key = await this.store
      .statement(
        `WITH live AS MATERIALIZED(SELECT s.* FROM comparison_domains d CROSS JOIN inventory_comparison_ready_builds s WHERE d.tenant=?1 AND s.tenant=d.tenant AND s.generation_id=d.active_generation),heads AS MATERIALIZED(SELECT s.*,(SELECT j.rowid FROM inventory_matching_bucket_jobs j INDEXED BY inventory_matching_bucket_pending WHERE j.tenant=s.tenant AND j.generation_id=s.generation_id AND j.scope_id=s.scope_id AND j.config_version=s.config_version AND j.completed_version<j.work_version ORDER BY j.key_class,j.bucket_hash LIMIT 1) AS head FROM live s) SELECT j.generation_id AS generation,j.scope_id AS scope,j.key_class AS keyClass,j.bucket_hash AS hash FROM heads h CROSS JOIN inventory_matching_bucket_jobs j WHERE j.rowid=h.head ORDER BY j.scope_id,j.key_class,j.bucket_hash LIMIT 1`,
        tenant,
      )
      .first<MatchingBucketKey>();
    if (!key) return { kind: "idle" as const };
    const lease = await this.store.claim(
      tenant,
      matchingBucketLeaseScope(key),
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
