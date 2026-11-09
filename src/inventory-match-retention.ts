import type { Store } from "./store.ts";

const MAX_PROOFS_PER_TICK = 16;
// One proof can contain up to 18,121 dependency rows under the header bounds.
const MAX_DEPENDENCIES_PER_TICK = 20_000;

/** Collect the oldest bounded cohort through the existing native guards. */
export async function collectInventoryMatchProofs(store: Store) {
  const collected = await store
    .statement(
      `WITH oldest AS MATERIALIZED (
        SELECT q.rowid AS id,q.tenant,q.set_id,q.eligible_at
        FROM inventory_match_proof_retirements q INDEXED BY inventory_match_proof_retirement_due
        WHERE q.collected_at IS NULL AND q.eligible_at<CAST(unixepoch('subsec')*1000 AS INTEGER)
        AND NOT EXISTS(SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=q.tenant)
        AND EXISTS(SELECT 1 FROM inventory_match_proof_retirable p WHERE (p.tenant,p.set_id,p.eligible_at)=(q.tenant,q.set_id,q.eligible_at))
        ORDER BY q.eligible_at,q.tenant,q.set_id LIMIT ?1
       ), sized AS MATERIALIZED (
        SELECT q.id,sum(h.scope_count+h.coverage_count+h.record_count+h.probe_count+h.token_count+h.candidate_count)
          OVER (ORDER BY q.eligible_at,q.tenant,q.set_id ROWS UNBOUNDED PRECEDING) AS dependencies
        FROM oldest q JOIN inventory_match_sets h USING(tenant,set_id)
       )
       UPDATE inventory_match_proof_retirements
       SET collected_at=CAST(unixepoch('subsec')*1000 AS INTEGER)
       WHERE rowid IN(SELECT id FROM sized WHERE dependencies<=?2)
       RETURNING 1 AS collected`,
      MAX_PROOFS_PER_TICK,
      MAX_DEPENDENCIES_PER_TICK,
    )
    .all<{ collected: number }>();
  return collected.results.length;
}
