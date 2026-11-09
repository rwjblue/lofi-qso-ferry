import type { Store } from "./store.ts";

/** Delete one bounded cohort. The foreign key protects current facet bodies. */
export async function collectInventoryPayloads(store: Store) {
  const removed = await store
    .statement(
      `WITH heads AS MATERIALIZED (
        SELECT a.id AS tenant,(
          SELECT r.eligible_at FROM inventory_payload_retirements r INDEXED BY inventory_payload_retirement_due
          WHERE r.tenant=a.id AND r.eligible_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)
          AND NOT EXISTS(SELECT 1 FROM inventory_record_facets f WHERE (f.tenant,f.scope_id,f.payload_id)=(r.tenant,r.scope_id,r.payload_id))
          ORDER BY r.eligible_at LIMIT 1
        ) AS due FROM accounts a
        WHERE NOT EXISTS(SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=a.id)
       ), next AS MATERIALIZED (
        SELECT tenant FROM heads WHERE due IS NOT NULL ORDER BY due,tenant LIMIT 1
       )
       DELETE FROM inventory_payloads WHERE (tenant,scope_id,payload_id) IN (
        SELECT r.tenant,r.scope_id,r.payload_id
        FROM next n CROSS JOIN inventory_payload_retirements r INDEXED BY inventory_payload_retirement_due
        WHERE r.tenant=n.tenant AND r.eligible_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)
        AND NOT EXISTS(SELECT 1 FROM inventory_record_facets f WHERE (f.tenant,f.scope_id,f.payload_id)=(r.tenant,r.scope_id,r.payload_id))
        ORDER BY r.eligible_at,r.scope_id,r.payload_id LIMIT 256
       ) RETURNING 1 AS collected`,
    )
    .all<{ collected: number }>();
  return removed.results.length;
}
