import { canonical, sha256 } from "./security.ts";
import type { Lease, Store } from "./store.ts";

interface CoverageJob {
  tenant: string;
  generation_id: string;
  scope_id: string;
  config_version: number;
  coverage_stream: string;
  coverage_partition: string;
  published_run: string;
  work_version: number;
  completed_version: number;
  cursor_key: string;
}
export interface PreparedCoverageRecovery {
  job: CoverageJob;
  lease: Lease;
  pageId: string;
  limit: number;
  preparedAt: number;
  digest: string;
}
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;
const leaseScope = (generation: string, scope: string) =>
  canonical(["projection-coverage", generation, scope]);

/** Full baseline completion wakes context-held projections through a bounded
 * native keyset. It does not refresh upstream evidence or create write authority. */
export class InventoryProjectionCoverageJobs {
  constructor(readonly store: Store) {}
  private async intent(
    job: CoverageJob,
    lease: Lease,
    limit: number,
  ): Promise<PreparedCoverageRecovery> {
    job = structuredClone(job);
    lease = structuredClone(lease);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      lease.tenant !== job.tenant ||
      lease.scope !== leaseScope(job.generation_id, job.scope_id)
    )
      throw new Error("invalid_inventory_projection_coverage_job");
    const input = {
      job,
      lease,
      pageId: crypto.randomUUID(),
      limit,
      preparedAt: Date.now(),
    };
    return { ...input, digest: await sha256(canonical(input)) };
  }
  async prepare(
    tenant: string,
    generation: string,
    scope: string,
    lease: Lease,
    limit = 200,
  ) {
    if (![tenant, generation, scope].every(identifier))
      throw new Error("invalid_inventory_projection_coverage_scope");
    lease = structuredClone(lease);
    const job = await this.store
      .statement(
        "SELECT tenant,generation_id,scope_id,config_version,coverage_stream,coverage_partition,published_run,work_version,completed_version,cursor_key FROM inventory_projection_coverage_jobs WHERE tenant=? AND generation_id=? AND scope_id=?",
        tenant,
        generation,
        scope,
      )
      .first<CoverageJob>();
    return !job || job.work_version === job.completed_version
      ? null
      : this.intent(job, lease, limit);
  }
  private async recover(page: PreparedCoverageRecovery) {
    const row = await this.store
      .statement(
        "SELECT input_digest,state,row_count,complete FROM inventory_projection_coverage_pages WHERE tenant=? AND page_id=?",
        page.job.tenant,
        page.pageId,
      )
      .first<{
        input_digest: string;
        state: string;
        row_count: number;
        complete: number;
      }>();
    if (!row) return null;
    if (row.input_digest !== page.digest || row.state !== "committed")
      throw new Error("inventory_projection_coverage_receipt_conflict");
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
  async publish(page: PreparedCoverageRecovery) {
    page = structuredClone(page);
    const { digest, ...input } = page;
    if (digest !== (await sha256(canonical(input))))
      throw new Error("inventory_projection_coverage_preparation_changed");
    const j = page.job;
    if (
      !identifier(page.pageId) ||
      !Number.isSafeInteger(page.limit) ||
      page.limit < 1 ||
      page.limit > 200 ||
      page.lease.tenant !== j.tenant ||
      page.lease.scope !== leaseScope(j.generation_id, j.scope_id)
    )
      throw new Error("invalid_inventory_projection_coverage_manifest");
    const recovered = await this.recover(page);
    if (recovered) return recovered;
    let result: D1Result[];
    try {
      result = await this.store.db.batch([
        this.store.statement(
          `WITH selected AS MATERIALIZED(SELECT record_key FROM comparison_projections INDEXED BY comparison_projection_context_held WHERE tenant=?1 AND generation_id=?2 AND scope_id=?3 AND facet='source' AND state='held' AND reason='operation_context_incomplete' AND record_key>?4 ORDER BY record_key LIMIT ?5+1), chunk AS MATERIALIZED(SELECT record_key FROM selected ORDER BY record_key LIMIT ?5)
INSERT INTO inventory_projection_coverage_pages(tenant,page_id,generation_id,scope_id,config_version,work_version,completed_version,coverage_stream,coverage_partition,published_run,previous_cursor,next_cursor,row_count,complete,lease_token,lease_fence,input_digest,prepared_at)
SELECT ?1,?6,?2,?3,?9,?7,?8,?10,?11,?12,?4,coalesce((SELECT max(record_key) FROM chunk),?4),(SELECT count(*) FROM chunk),CASE WHEN (SELECT count(*) FROM selected)>?5 THEN 0 ELSE 1 END,?13,?14,?15,?16`,
          j.tenant,
          j.generation_id,
          j.scope_id,
          j.cursor_key,
          page.limit,
          page.pageId,
          j.work_version,
          j.completed_version,
          j.config_version,
          j.coverage_stream,
          j.coverage_partition,
          j.published_run,
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
    const receipt = await this.recover(page);
    if (!receipt)
      throw new Error("inventory_projection_coverage_receipt_missing");
    return {
      ...receipt,
      recovered: false,
      statements: 1,
      rowsRead: result.reduce((n, r) => n + r.meta.rows_read, 0),
      rowsWritten: result.reduce((n, r) => n + r.meta.rows_written, 0),
    };
  }
  async step(tenant: string, limit = 200) {
    if (
      !identifier(tenant) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      throw new Error("invalid_inventory_projection_coverage_scope");
    const job = await this.store
      .statement(
        `WITH live AS MATERIALIZED(SELECT * FROM inventory_comparison_ready_builds WHERE tenant=?1 AND provider='lofi')
SELECT j.* FROM live s CROSS JOIN inventory_projection_coverage_jobs j
JOIN inventory_full_source_coverage cv ON cv.tenant=j.tenant AND cv.scope_id=j.scope_id AND cv.stream_id=j.coverage_stream AND cv.partition_id=j.coverage_partition AND cv.published_run_id=j.published_run
WHERE j.tenant=s.tenant AND j.generation_id=s.generation_id AND j.scope_id=s.scope_id AND j.config_version=s.config_version AND j.completed_version<j.work_version AND j.due_at<=?2 ORDER BY j.due_at,j.generation_id,j.scope_id LIMIT 1`,
        tenant,
        Date.now(),
      )
      .first<CoverageJob>();
    if (!job) return { kind: "idle" as const };
    const lease = await this.store.claim(
      tenant,
      leaseScope(job.generation_id, job.scope_id),
      Date.now(),
      60000,
    );
    if (!lease) return { kind: "deferred" as const };
    try {
      return {
        kind: "queued" as const,
        ...(await this.publish(await this.intent(job, lease, limit))),
      };
    } finally {
      await this.store.release(lease);
    }
  }
}
