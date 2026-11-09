import { InventoryProjections } from "./inventory-projections.ts";
import { canonical, sha256 } from "./security.ts";
import type { Lease, Store } from "./store.ts";

interface Job {
  tenant: string;
  generation_id: string;
  scope_id: string;
  operation_key: string;
  work_version: number;
  completed_version: number;
  config_version: number;
  topology_version: number;
  cursor_key: string;
}
export interface PreparedProjectionJob {
  job: Job;
  pageId: string;
  lease: Lease;
  nextCursor: string;
  records: number;
  complete: boolean;
  preparedAt: number;
  digest: string;
}
const leaseScope = (
  job: Pick<Job, "generation_id" | "scope_id" | "operation_key">,
) =>
  canonical([
    "projection-fanout",
    job.generation_id,
    job.scope_id,
    job.operation_key,
  ]);
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;

// Keep first-scan source work queued until the full run publishes coverage.
// Completing the run wakes comparison through its ingestion receipt.
const readyBuilds = `SELECT b.* FROM inventory_comparison_ready_builds b
WHERE b.tenant=?1 AND (b.provider!='lofi' OR NOT EXISTS(
  SELECT 1 FROM inventory_coverage c JOIN inventory_runs r
    ON (r.tenant,r.run_id)=(c.tenant,c.building_run_id)
  WHERE (c.tenant,c.scope_id)=(b.tenant,b.scope_id) AND c.facet='source'
    AND c.state IN('collecting','held') AND c.published_run_id IS NULL
    AND r.config_version=b.config_version AND r.mode='full'
))`;

/** Bounded context fan-out and ordinary projection selection. No vendor I/O or
 * observation renewal. Matching/coverage recovery have separate work domains. */
export class InventoryProjectionJobs {
  constructor(readonly store: Store) {}
  async prepare(
    tenant: string,
    generation: string,
    scope: string,
    operation: string,
    lease: Lease,
    limit = 200,
  ): Promise<PreparedProjectionJob | null> {
    lease = structuredClone(lease);
    if (
      ![tenant, generation, scope, operation].every(identifier) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      lease.tenant !== tenant ||
      lease.scope !==
        leaseScope({
          generation_id: generation,
          scope_id: scope,
          operation_key: operation,
        })
    )
      throw new Error("invalid_inventory_projection_job");
    const job = await this.store
      .statement(
        "SELECT tenant,generation_id,scope_id,operation_key,work_version,completed_version,config_version,topology_version,cursor_key FROM inventory_projection_jobs WHERE tenant=? AND generation_id=? AND scope_id=? AND operation_key=?",
        tenant,
        generation,
        scope,
        operation,
      )
      .first<Job>();
    if (!job || job.completed_version === job.work_version) return null;
    const children = await this.store
      .statement(
        "SELECT record_key FROM comparison_index INDEXED BY comparison_index_parent_cursor WHERE tenant=? AND generation_id=? AND scope_id=? AND parent_key=? AND record_key>? AND facet='source' ORDER BY record_key LIMIT ?",
        tenant,
        generation,
        scope,
        operation,
        job.cursor_key,
        limit + 1,
      )
      .all<{ record_key: string }>();
    const selected = children.results.slice(0, limit);
    const input = {
      job,
      pageId: crypto.randomUUID(),
      lease,
      nextCursor: selected.at(-1)?.record_key ?? job.cursor_key,
      records: selected.length,
      complete: children.results.length <= limit,
      preparedAt: Date.now(),
    };
    return { ...input, digest: await sha256(canonical(input)) };
  }
  private async recover(page: PreparedProjectionJob) {
    const row = await this.store
      .statement(
        "SELECT input_digest,state,row_count,complete FROM inventory_projection_job_pages WHERE tenant=? AND page_id=?",
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
      throw new Error("inventory_projection_job_receipt_conflict");
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
  async publish(page: PreparedProjectionJob) {
    page = structuredClone(page);
    const { digest, ...input } = page;
    if (digest !== (await sha256(canonical(input))))
      throw new Error("inventory_projection_job_preparation_changed");
    const recovered = await this.recover(page);
    if (recovered) return recovered;
    const j = page.job;
    if (
      !identifier(page.pageId) ||
      page.lease.tenant !== j.tenant ||
      page.lease.scope !== leaseScope(j) ||
      !Number.isSafeInteger(page.records) ||
      page.records < 0 ||
      page.records > 200
    )
      throw new Error("invalid_inventory_projection_job_manifest");
    const plan = [
      this.store.statement(
        `INSERT INTO inventory_projection_job_pages(tenant,page_id,generation_id,scope_id,operation_key,work_version,completed_version,config_version,topology_version,previous_cursor,next_cursor,row_count,complete,lease_token,lease_fence,input_digest,prepared_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        j.tenant,
        page.pageId,
        j.generation_id,
        j.scope_id,
        j.operation_key,
        j.work_version,
        j.completed_version,
        j.config_version,
        j.topology_version,
        j.cursor_key,
        page.nextCursor,
        page.records,
        Number(page.complete),
        page.lease.token,
        page.lease.fence,
        page.digest,
        page.preparedAt,
      ),
      this.store.statement(
        `INSERT INTO comparison_work(tenant,generation_id,scope_id,record_key,facet,work_version,completed_version,due_at)
SELECT i.tenant,i.generation_id,i.scope_id,i.record_key,i.facet,1,0,h.prepared_at FROM inventory_projection_job_pages h JOIN comparison_index i INDEXED BY comparison_index_parent_cursor ON i.tenant=h.tenant AND i.generation_id=h.generation_id AND i.scope_id=h.scope_id AND i.parent_key=h.operation_key AND i.facet='source' AND i.record_key>h.previous_cursor AND i.record_key<=h.next_cursor WHERE h.tenant=? AND h.page_id=? AND i.state!='retired' AND i.topology_version!=h.topology_version
ON CONFLICT(tenant,generation_id,scope_id,record_key,facet) DO UPDATE SET work_version=comparison_work.work_version+1,due_at=min(comparison_work.due_at,excluded.due_at) WHERE comparison_work.completed_version=comparison_work.work_version`,
        j.tenant,
        page.pageId,
      ),
      this.store.statement(
        "UPDATE inventory_projection_jobs SET cursor_key=?,completed_version=CASE ? WHEN 1 THEN work_version ELSE completed_version END,due_at=? WHERE tenant=? AND generation_id=? AND scope_id=? AND operation_key=? AND work_version=? AND completed_version=? AND cursor_key=?",
        page.nextCursor,
        Number(page.complete),
        page.preparedAt,
        j.tenant,
        j.generation_id,
        j.scope_id,
        j.operation_key,
        j.work_version,
        j.completed_version,
        j.cursor_key,
      ),
      this.store.statement(
        "UPDATE inventory_projection_job_pages SET state='committed' WHERE tenant=? AND page_id=?",
        j.tenant,
        page.pageId,
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
    return {
      pageId: page.pageId,
      recovered: false,
      records: page.records,
      complete: page.complete,
      statements: plan.length,
      rowsRead: results.reduce((n, r) => n + r.meta.rows_read, 0),
      rowsWritten: results.reduce((n, r) => n + r.meta.rows_written, 0),
    };
  }
  async expandNext(tenant: string, limit = 200) {
    if (!identifier(tenant))
      throw new Error("invalid_inventory_projection_tenant");
    // Choose one indexed head per eligible scope before sorting. A global
    // pending-work walk would revisit retained retired/disabled history.
    const job = await this.store
      .statement(
        `WITH live AS MATERIALIZED(${readyBuilds} AND b.provider='lofi'),
heads AS MATERIALIZED(SELECT s.*,(SELECT j.rowid FROM inventory_projection_jobs j INDEXED BY inventory_projection_job_scope_pending WHERE j.tenant=s.tenant AND j.generation_id=s.generation_id AND j.scope_id=s.scope_id AND j.config_version=s.config_version AND j.completed_version<j.work_version AND j.due_at<=?2 ORDER BY j.due_at,j.operation_key LIMIT 1) AS head FROM live s)
SELECT j.* FROM heads h CROSS JOIN inventory_projection_jobs j WHERE j.rowid=h.head ORDER BY j.due_at,j.generation_id,j.scope_id,j.operation_key LIMIT 1`,
        tenant,
        Date.now(),
      )
      .first<Job>();
    if (!job) return { kind: "idle" as const };
    const lease = await this.store.claim(
      tenant,
      leaseScope(job),
      Date.now(),
      60000,
    );
    if (!lease) return { kind: "deferred" as const };
    try {
      const page = await this.prepare(
        tenant,
        job.generation_id,
        job.scope_id,
        job.operation_key,
        lease,
        limit,
      );
      return page
        ? { kind: "expanded" as const, ...(await this.publish(page)) }
        : { kind: "idle" as const };
    } finally {
      await this.store.release(lease);
    }
  }
  async projectNext(tenant: string) {
    if (!identifier(tenant))
      throw new Error("invalid_inventory_projection_tenant");
    // The scope tuple lets the outer query stop at the ordered index limit.
    const rows = await this.store
      .statement(
        `WITH live AS MATERIALIZED(${readyBuilds}),
heads AS MATERIALIZED(SELECT s.*,(SELECT w.rowid FROM comparison_work w INDEXED BY comparison_work_pending_scope WHERE w.tenant=s.tenant AND w.generation_id=s.generation_id AND w.scope_id=s.scope_id AND w.facet=CASE s.provider WHEN 'lofi' THEN 'source' ELSE 'receipt' END AND w.completed_version<w.work_version AND w.due_at<=?2 ORDER BY w.due_at,w.record_key,w.facet LIMIT 1) AS head FROM live s)
SELECT w.generation_id,w.scope_id,w.record_key
FROM comparison_work w INDEXED BY comparison_work_pending_scope
WHERE (w.tenant,w.generation_id,w.scope_id,w.facet)=(
  SELECT h.tenant,p.generation_id,p.scope_id,p.facet FROM heads h CROSS JOIN comparison_work p WHERE p.rowid=h.head
  ORDER BY p.due_at,p.generation_id,p.scope_id,p.record_key,p.facet LIMIT 1
) AND w.completed_version<w.work_version AND w.due_at<=?2
ORDER BY w.due_at,w.record_key,w.facet LIMIT 20`,
        tenant,
        Date.now(),
      )
      .all<{
        generation_id: string;
        scope_id: string;
        record_key: string;
      }>();
    const first = rows.results[0];
    if (!first) return { kind: "idle" as const };
    let selected = rows.results.map((row) => row.record_key);
    for (;;) {
      try {
        const result = await new InventoryProjections(this.store).project(
          tenant,
          first.generation_id,
          first.scope_id,
          selected,
        );
        return "deferred" in result
          ? { kind: "deferred" as const }
          : { kind: "projected" as const, ...result };
      } catch (error) {
        if (
          selected.length === 1 ||
          !(error instanceof Error) ||
          error.message !== "inventory_projection_split_required"
        )
          throw error;
        selected = selected.slice(0, Math.ceil(selected.length / 2));
      }
    }
  }
}
