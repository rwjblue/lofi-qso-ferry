import { canonical } from "./security.ts";
import type { Store } from "./store.ts";

export const COMPARISON_QUEUE_HORIZON_MS = 43_200_000;
export interface ComparisonWakeup {
  tenant: string;
  version: number;
  control_version: number;
  work_version: number;
  not_before: number;
  published_at: number;
  runtime_version: number;
}
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

/** Durable scheduling metadata. Neither Queue publication nor recovery advances
 * a coordinator, contact, stream checkpoint or observation timestamp. */
export class InventoryComparisonWakeups {
  constructor(readonly store: Store) {}

  async pending(
    options: { now?: number; limit?: number; recoverAfterMs?: number } = {},
  ) {
    const now = options.now ?? Date.now(),
      limit = options.limit ?? 100;
    const recovery = options.recoverAfterMs ?? 300_000;
    if (
      !positive(now) ||
      !Number.isSafeInteger(now + COMPARISON_QUEUE_HORIZON_MS) ||
      !positive(limit) ||
      limit > 100 ||
      !positive(recovery) ||
      recovery < 60_000
    )
      throw new Error("invalid_comparison_wakeup_selection");
    const recoveredBefore = Math.max(0, now - recovery);
    return (
      await this.store
        .statement(
          `WITH runtime AS MATERIALIZED(SELECT version FROM inventory_runtime WHERE id=1 AND mode='inventory_read_only'),
fresh AS MATERIALIZED(SELECT w.* FROM runtime CROSS JOIN inventory_comparison_wakeups w INDEXED BY inventory_comparison_wakeup_new WHERE w.not_before IS NOT NULL AND w.published_at=0 AND w.not_before<=?1 ORDER BY w.not_before,w.tenant LIMIT ?3),
recoverable AS MATERIALIZED(SELECT w.* FROM runtime CROSS JOIN inventory_comparison_wakeups w INDEXED BY inventory_comparison_wakeup_recovery WHERE w.not_before IS NOT NULL AND w.published_at>0 AND w.published_at<=?2 AND w.not_before<=?2 ORDER BY w.published_at,w.not_before,w.tenant LIMIT ?3),
selected AS MATERIALIZED(SELECT * FROM fresh UNION ALL SELECT * FROM recoverable)
SELECT s.*,(SELECT version FROM runtime) AS runtime_version FROM selected s CROSS JOIN inventory_comparison_coordinators c WHERE c.tenant=s.tenant AND c.version=s.control_version AND c.work_version=s.work_version ORDER BY s.not_before,s.tenant LIMIT ?3`,
          now + COMPARISON_QUEUE_HORIZON_MS,
          recoveredBefore,
          limit,
        )
        .all<ComparisonWakeup>()
    ).results;
  }

  async markPublished(rows: readonly ComparisonWakeup[]) {
    rows = structuredClone(rows);
    if (
      rows.length > 100 ||
      rows.some(
        (row) =>
          !identifier(row.tenant) ||
          ![
            row.version,
            row.control_version,
            row.work_version,
            row.runtime_version,
          ].every(positive),
      )
    )
      throw new Error("invalid_comparison_wakeup_publication");
    if (!rows.length) return 0;
    const result = await this.store
      .statement(
        `UPDATE inventory_comparison_wakeups SET published_at=?1 WHERE rowid IN(
SELECT w.rowid FROM json_each(?2) q CROSS JOIN inventory_comparison_wakeups w WHERE w.tenant=json_extract(q.value,'$.tenant') AND w.version=json_extract(q.value,'$.version') AND w.control_version=json_extract(q.value,'$.control_version') AND w.work_version=json_extract(q.value,'$.work_version') AND w.not_before IS NOT NULL AND EXISTS(SELECT 1 FROM inventory_runtime r WHERE r.id=1 AND r.mode='inventory_read_only' AND r.version=json_extract(q.value,'$.runtime_version')))`,
        Date.now(),
        canonical(rows),
      )
      .run();
    return result.meta.changes;
  }
}
