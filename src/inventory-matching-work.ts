import {
  InventoryMatchingResults,
  type InventoryMatchingWorkClaim,
} from "./inventory-matching-results.ts";
import { InventoryMatchingWorkspace } from "./inventory-matching-workspace.ts";
import { canonical, randomToken } from "./security.ts";
import type { Lease, Store } from "./store.ts";

const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;
const capacityErrors = new Set([
  "inventory_matching_scope_split_required",
  "inventory_matching_record_split_required",
  "inventory_matching_coverage_split_required",
  "inventory_matching_recovery_split_required",
  "inventory_matching_candidate_split_required",
  "inventory_matching_probe_split_required",
  "inventory_projection_read_split_required",
  "inventory_projection_read_byte_bound",
]);
interface Head {
  generation_id: string;
  destination: string;
  source_scope: string;
  source_config_version: number;
  destination_config_version: number;
}

/** Durable bounded comparison work. Completion shares the result transaction;
 * neither an incomplete classification nor a capacity hold authorizes delivery.
 * Bucket/scope invalidation continuations and hosted coordination are separate. */
export class InventoryMatchingWork {
  constructor(readonly store: Store) {}
  async enqueue(
    tenant: string,
    generation: string,
    destination: string,
    selected: readonly { scope: string; key: string }[],
  ) {
    selected = structuredClone(selected);
    if (
      ![tenant, generation, destination].every(identifier) ||
      selected.length < 1 ||
      selected.length > 200 ||
      selected.some((row) => !identifier(row.scope) || !identifier(row.key)) ||
      new Set(selected.map((row) => canonical([row.scope, row.key]))).size !==
        selected.length
    )
      throw new Error("invalid_inventory_matching_work_selection");
    const result = await this.store.db.batch([
      this.store.statement(
        `INSERT INTO matching_work(tenant,generation_id,destination,source_scope,record_key,source_config_version,destination_config_version)
SELECT r.tenant,r.generation_id,r.destination,r.source_scope,json_extract(j.value,'$.key'),r.source_config_version,r.destination_config_version FROM json_each(?1) j CROSS JOIN inventory_matching_source_routes r WHERE r.tenant=?2 AND r.generation_id=?3 AND r.destination=?4 AND r.source_scope=json_extract(j.value,'$.scope')
ON CONFLICT(tenant,generation_id,destination,source_scope,record_key) DO UPDATE SET source_config_version=excluded.source_config_version,destination_config_version=excluded.destination_config_version,work_version=matching_work.work_version+1,due_at=0,hold_reason=NULL`,
        canonical(selected),
        tenant,
        generation,
        destination,
      ),
      this.store.statement(
        "INSERT INTO inventory_comparison_coordinators(tenant) VALUES(?) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1",
        tenant,
      ),
    ]);
    return { records: result[0].meta.changes };
  }
  async step(tenant: string) {
    if (!identifier(tenant))
      throw new Error("invalid_inventory_matching_work_tenant");
    const head = await this.store
      .statement(
        `WITH pairs AS MATERIALIZED(SELECT dst.tenant,dst.generation_id,dst.scope_id AS destination,src.scope_id AS source_scope,src.config_version AS source_config_version,dst.config_version AS destination_config_version FROM comparison_domains d CROSS JOIN inventory_comparison_ready_builds dst CROSS JOIN inventory_comparison_ready_builds src WHERE d.tenant=?1 AND dst.tenant=d.tenant AND dst.generation_id=d.active_generation AND dst.provider IN('qrz','lotw') AND src.tenant=d.tenant AND src.generation_id=dst.generation_id AND src.provider='lofi'),
heads AS MATERIALIZED(SELECT p.*,(SELECT w.rowid FROM matching_work w INDEXED BY matching_work_scope_pending WHERE w.tenant=p.tenant AND w.generation_id=p.generation_id AND w.destination=p.destination AND w.source_scope=p.source_scope AND w.source_config_version=p.source_config_version AND w.destination_config_version=p.destination_config_version AND w.completed_version<w.work_version AND w.due_at<=?2 ORDER BY w.due_at,w.record_key LIMIT 1) AS head FROM pairs p)
SELECT w.generation_id,w.destination,w.source_scope,w.source_config_version,w.destination_config_version FROM heads h CROSS JOIN matching_work w WHERE w.rowid=h.head ORDER BY w.due_at,w.destination,w.source_scope,w.record_key LIMIT 1`,
        tenant,
        Date.now(),
      )
      .first<Head>();
    if (!head) return { kind: "idle" as const };
    const scope = `matching:${head.destination}`;
    const now = Date.now();
    const token = randomToken();
    const [claimed, rows] = await this.store.db.batch([
      this.store.claimStatement(tenant, scope, now, 60_000, { token }),
      this.store.statement(
        `SELECT w.source_scope AS scope,w.record_key AS key,w.work_version AS workVersion,w.completed_version AS completedVersion,w.source_config_version AS sourceConfigVersion,w.destination_config_version AS destinationConfigVersion,w.due_at AS dueAt,coalesce(r.version,0) AS resultVersion
         FROM leases l CROSS JOIN matching_work w INDEXED BY matching_work_scope_pending
         LEFT JOIN match_results r ON (r.tenant,r.destination,r.source_scope,r.record_key)=(w.tenant,w.destination,w.source_scope,w.record_key)
         WHERE l.tenant=?1 AND l.scope=?8 AND l.token=?9 AND l.expires_at>unixepoch('subsec')*1000
         AND w.tenant=l.tenant AND w.generation_id=?2 AND w.destination=?3 AND w.source_scope=?4 AND w.source_config_version=?5 AND w.destination_config_version=?6 AND w.completed_version<w.work_version AND w.due_at<=?7
         ORDER BY w.due_at,w.record_key LIMIT 20`,
        tenant,
        head.generation_id,
        head.destination,
        head.source_scope,
        head.source_config_version,
        head.destination_config_version,
        now,
        scope,
        token,
      ),
    ]);
    const lease = claimed.results[0] as Lease | undefined;
    if (!lease) return { kind: "deferred" as const };
    try {
      let work = rows.results as InventoryMatchingWorkClaim[];
      if (!work.length) return { kind: "idle" as const };
      for (;;) {
        try {
          const page = await new InventoryMatchingWorkspace(this.store).prepare(
            tenant,
            head.destination,
            work.map(({ scope, key }) => ({ scope, key })),
          );
          if (page.generation !== head.generation_id)
            throw new Error("inventory_matching_work_generation_changed");
          const result = await new InventoryMatchingResults(this.store).publish(
            page,
            lease,
            crypto.randomUUID(),
            work,
          );
          return {
            ...result,
            kind: "matched" as const,
            preparation: page.stats,
          };
        } catch (error) {
          if (!(error instanceof Error) || !capacityErrors.has(error.message))
            throw error;
          if (work.length > 1) {
            work = work.slice(0, Math.floor(work.length / 2));
            continue;
          }
          const held = await this.store
            .statement(
              `UPDATE matching_work SET due_at=?,hold_reason='capacity' WHERE tenant=? AND generation_id=? AND destination=? AND source_scope=? AND record_key=? AND work_version=? AND completed_version=? AND due_at=? AND EXISTS(SELECT 1 FROM leases l JOIN accounts a ON a.id=l.tenant AND a.status='active' WHERE l.tenant=? AND l.scope=? AND l.token=? AND l.fence=? AND l.expires_at>unixepoch('subsec')*1000)`,
              Date.now() + 300000,
              tenant,
              head.generation_id,
              head.destination,
              work[0].scope,
              work[0].key,
              work[0].workVersion,
              work[0].completedVersion,
              work[0].dueAt,
              tenant,
              lease.scope,
              lease.token,
              lease.fence,
            )
            .run();
          return held.meta.changes
            ? { kind: "held" as const, records: 1, reason: "capacity" as const }
            : { kind: "deferred" as const };
        }
      }
    } finally {
      await this.store.release(lease);
    }
  }
}
