import type { Store } from "./store.ts";

/** A single indexed turn. Native triggers collect the closure or roll it back. */
export async function collectInventoryMatchProof(store: Store) {
  const collected = await store
    .statement(
      `UPDATE inventory_match_proof_retirements
       SET collected_at=CAST(unixepoch('subsec')*1000 AS INTEGER)
       WHERE rowid=(
        SELECT q.rowid FROM inventory_match_proof_retirements q INDEXED BY inventory_match_proof_retirement_due
        WHERE q.collected_at IS NULL AND q.eligible_at<CAST(unixepoch('subsec')*1000 AS INTEGER)
        AND NOT EXISTS(SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=q.tenant)
        ORDER BY q.eligible_at,q.tenant,q.set_id LIMIT 1
       )
       RETURNING 1 AS collected`,
    )
    .first<number>("collected");
  return collected ?? 0;
}
