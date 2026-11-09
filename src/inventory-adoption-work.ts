import { InventoryAssociations } from "./inventory-associations.ts";
import { canonical, randomToken } from "./security.ts";
import type { Lease, Store } from "./store.ts";

interface Head {
  generation_id: string;
  destination: string;
  source_scope: string;
  source_config_version: number;
  destination_config_version: number;
  provider: "qrz" | "lotw";
  result_set: string;
}
interface Claim {
  scope: string;
  key: string;
  resultSet: string;
  resultVersion: number;
  dueAt: number;
}
type Hold = "capacity" | "comparison" | "ownership" | "prior_delivery";
const capacityErrors = new Set([
  "inventory_projection_read_split_required",
  "inventory_projection_read_byte_bound",
]);
const capacityReasons = new Set([
  "ownership_record_bound",
  "ownership_byte_bound",
]);
function hold(reason: string): Hold {
  if (capacityReasons.has(reason)) return "capacity";
  if (reason === "prior_delivery_evidence") return "prior_delivery";
  if (reason.startsWith("ownership_")) return "ownership";
  return "comparison";
}

/** Jobs carry no adoption authority. The guarded association is their receipt. */
export class InventoryAdoptionWork {
  constructor(readonly store: Store) {}
  private async finish(
    tenant: string,
    head: Head,
    work: readonly (Claim & { reason: Hold })[],
    lease: Lease,
  ) {
    const args = [
      canonical(work),
      tenant,
      head.destination,
      lease.scope,
      lease.token,
      lease.fence,
    ];
    const selected = `FROM json_each(?1) q CROSS JOIN inventory_adoption_work w WHERE w.tenant=?2 AND w.destination=?3 AND w.source_scope=json_extract(q.value,'$.scope') AND w.record_key=json_extract(q.value,'$.key') AND w.result_set=json_extract(q.value,'$.resultSet') AND w.result_version=json_extract(q.value,'$.resultVersion') AND w.due_at=json_extract(q.value,'$.dueAt') AND EXISTS(SELECT 1 FROM leases l JOIN accounts a ON a.id=l.tenant AND a.status='active' WHERE l.tenant=w.tenant AND l.scope=?4 AND l.scope='inventory-ownership:'||w.provider AND l.token=?5 AND l.fence=?6 AND l.expires_at>unixepoch('subsec')*1000)`;
    const results = await this.store.db.batch([
      this.store.statement(
        `DELETE FROM inventory_adoption_work WHERE rowid IN(SELECT w.rowid ${selected} AND EXISTS(SELECT 1 FROM inventory_historical_associations a WHERE a.tenant=w.tenant AND a.provider=w.provider AND a.book_identity=w.book_identity AND a.source_identity=w.source_identity AND a.record_key=w.record_key))`,
        ...args,
      ),
      this.store.statement(
        `WITH ready AS MATERIALIZED(SELECT w.rowid AS id,json_extract(q.value,'$.reason') AS reason ${selected} AND EXISTS(SELECT 1 FROM inventory_matching_coverage_live_routes r WHERE r.tenant=w.tenant AND r.generation_id=w.generation_id AND r.destination=w.destination AND r.source_scope=w.source_scope AND r.source_config_version=w.source_config_version AND r.destination_config_version=w.destination_config_version)) UPDATE inventory_adoption_work SET due_at=?7,hold_reason=(SELECT reason FROM ready WHERE id=inventory_adoption_work.rowid) WHERE rowid IN(SELECT id FROM ready)`,
        ...args,
        Date.now() + 300000,
      ),
    ]);
    return {
      completed: results[0].meta.changes,
      held: results[1].meta.changes,
    };
  }
  async step(tenant: string) {
    if (typeof tenant !== "string" || !tenant.length || tenant.length > 512)
      throw new Error("invalid_inventory_adoption_work_tenant");
    const head = await this.store
      .statement(
        `WITH routes AS MATERIALIZED(SELECT * FROM inventory_matching_coverage_live_routes WHERE tenant=?1), heads AS MATERIALIZED(SELECT r.*,(SELECT w.rowid FROM inventory_adoption_work w INDEXED BY inventory_adoption_work_due WHERE w.tenant=r.tenant AND w.generation_id=r.generation_id AND w.destination=r.destination AND w.source_scope=r.source_scope AND w.source_config_version=r.source_config_version AND w.destination_config_version=r.destination_config_version AND w.due_at<=?2 ORDER BY w.due_at,w.record_key LIMIT 1) AS head FROM routes r) SELECT w.generation_id,w.destination,w.source_scope,w.source_config_version,w.destination_config_version,w.provider,w.result_set FROM heads h CROSS JOIN inventory_adoption_work w WHERE w.rowid=h.head ORDER BY w.due_at,w.destination,w.source_scope,w.record_key LIMIT 1`,
        tenant,
        Date.now(),
      )
      .first<Head>();
    if (!head) return { kind: "idle" as const };
    const scope = `inventory-ownership:${head.provider}`;
    const now = Date.now();
    const token = randomToken();
    const [claimed, selected] = await this.store.db.batch([
      this.store.claimStatement(tenant, scope, now, 60_000, { token }),
      this.store.statement(
        `SELECT w.source_scope AS scope,w.record_key AS key,w.result_set AS resultSet,w.result_version AS resultVersion,w.due_at AS dueAt
         FROM leases l CROSS JOIN inventory_adoption_work w INDEXED BY inventory_adoption_work_set_due
         WHERE l.tenant=?1 AND l.scope=?9 AND l.token=?10 AND l.expires_at>unixepoch('subsec')*1000
         AND w.tenant=l.tenant AND w.result_set=?2 AND w.generation_id=?3 AND w.destination=?4 AND w.source_scope=?5 AND w.source_config_version=?6 AND w.destination_config_version=?7 AND w.due_at<=?8
         ORDER BY w.due_at,w.record_key LIMIT 20`,
        tenant,
        head.result_set,
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
      let work = selected.results as Claim[];
      if (!work.length) return { kind: "idle" as const };
      for (;;) {
        try {
          const associations = new InventoryAssociations(this.store);
          const page = await associations.prepare(
            tenant,
            head.destination,
            work,
          );
          if (
            work.length > 1 &&
            page.skipped.some((row) => capacityReasons.has(row.reason)) &&
            !page.skipped.some((row) => row.reason === "ownership_conflict")
          ) {
            work = work.slice(0, Math.floor(work.length / 2));
            continue;
          }
          const claims = new Map(work.map((row) => [row.key, row]));
          if (
            page.rows.some((row) => {
              const claim = claims.get(row.key);
              return (
                !claim ||
                claim.scope !== row.scope ||
                claim.resultSet !== row.match_set ||
                claim.resultVersion !== row.match_version
              );
            })
          )
            return { kind: "deferred" as const };
          const skipped = new Map(
            page.skipped.map((row) => [row.key, hold(row.reason)]),
          );
          const published = page.rows.length
            ? await associations.publish(page, lease)
            : null;
          const completed = await this.finish(
            tenant,
            head,
            work.map((row) => ({
              ...row,
              reason: skipped.get(row.key) ?? "comparison",
            })),
            lease,
          );
          return {
            kind: "processed" as const,
            records: published?.records ?? 0,
            ...completed,
          };
        } catch (error) {
          if (!(error instanceof Error) || !capacityErrors.has(error.message))
            throw error;
          if (work.length > 1) {
            work = work.slice(0, Math.floor(work.length / 2));
            continue;
          }
          const completed = await this.finish(
            tenant,
            head,
            work.map((row) => ({ ...row, reason: "capacity" })),
            lease,
          );
          return {
            kind: "processed" as const,
            records: 0,
            ...completed,
          };
        }
      }
    } finally {
      await this.store.release(lease);
    }
  }
}
