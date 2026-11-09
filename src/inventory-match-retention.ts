import type { Store } from "./store.ts";

const MAX_PROOFS_PER_TICK = 16;
// One proof can contain up to 18,121 dependency rows under the header bounds.
const MAX_DEPENDENCIES_PER_TICK = 20_000;
const CENSUS_PAGE_SIZE = 256;
const RESULT_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

/** Collect the oldest bounded cohort through the existing native guards. */
export async function collectInventoryMatchProofs(store: Store) {
  const [, , collected] = await store.db.batch<{ collected: number }>([
    store.statement(
      `WITH page AS MATERIALIZED (
         SELECT a.tenant,a.id FROM inventory_settled_proof_census s CROSS JOIN inventory_historical_associations a
         WHERE s.singleton=1 AND s.complete=0 AND (a.tenant,a.id)>(s.cursor_tenant,s.cursor_association)
         ORDER BY a.tenant,a.id LIMIT ?1+1
       ), tail AS MATERIALIZED (
         SELECT tenant,id FROM (SELECT tenant,id FROM page LIMIT ?1) ORDER BY tenant DESC,id DESC LIMIT 1
       )
       UPDATE inventory_settled_proof_census
       SET cursor_tenant=coalesce((SELECT tenant FROM tail),cursor_tenant),
         cursor_association=coalesce((SELECT id FROM tail),cursor_association),complete=(SELECT count(*) FROM page)<=?1
       WHERE singleton=1 AND complete=0`,
      CENSUS_PAGE_SIZE,
    ),
    // Scalar cursor bounds let the age index supply the page in order.
    store.statement(
      `WITH cursor AS MATERIALIZED (
         SELECT CASE WHEN c.restart_at IS NULL THEN c.derived_at ELSE 0 END AS derived_at,
           CASE WHEN c.restart_at IS NULL THEN c.tenant ELSE '' END AS tenant,
           CASE WHEN c.restart_at IS NULL THEN c.destination ELSE '' END AS destination,
           CASE WHEN c.restart_at IS NULL THEN c.source_scope ELSE '' END AS source_scope,
           CASE WHEN c.restart_at IS NULL THEN c.record_key ELSE '' END AS record_key,
           unixepoch('subsec')*1000-p.settled_retention_days*86400000 AS cutoff
         FROM inventory_settled_result_census c CROSS JOIN inventory_retention_policy p
         WHERE c.singleton=1 AND (c.restart_at IS NULL OR c.restart_at<=unixepoch('subsec')*1000)
       ), page AS MATERIALIZED (
         SELECT r.derived_at,r.tenant,r.destination,r.source_scope,r.record_key,r.set_id
         FROM match_results r INDEXED BY inventory_settled_result_age
         WHERE r.state IN('matched_existing','absent_at_inventory')
           AND r.derived_at<=(SELECT cutoff FROM cursor)
           AND (r.derived_at,r.tenant,r.destination,r.source_scope,r.record_key)>
             (SELECT derived_at,tenant,destination,source_scope,record_key FROM cursor)
         ORDER BY r.derived_at,r.tenant,r.destination,r.source_scope,r.record_key LIMIT ?1+1
       ), sized AS MATERIALIZED (
         SELECT p.*,sum(h.token_count+h.record_count+h.row_count) OVER (
           ORDER BY p.derived_at,p.tenant,p.destination,p.source_scope,p.record_key ROWS UNBOUNDED PRECEDING
         ) AS dependencies
         FROM page p JOIN inventory_match_sets h ON (h.tenant,h.set_id)=(p.tenant,p.set_id)
       ), tail AS MATERIALIZED (
         SELECT * FROM (SELECT * FROM sized WHERE dependencies<=?3 ORDER BY derived_at,tenant,destination,source_scope,record_key LIMIT ?1)
         ORDER BY derived_at DESC,tenant DESC,destination DESC,source_scope DESC,record_key DESC LIMIT 1
       )
       UPDATE inventory_settled_result_census
       SET derived_at=coalesce((SELECT derived_at FROM tail),(SELECT derived_at FROM cursor)),
         tenant=coalesce((SELECT tenant FROM tail),(SELECT tenant FROM cursor)),
         destination=coalesce((SELECT destination FROM tail),(SELECT destination FROM cursor)),
         source_scope=coalesce((SELECT source_scope FROM tail),(SELECT source_scope FROM cursor)),
         record_key=coalesce((SELECT record_key FROM tail),(SELECT record_key FROM cursor)),
         restart_at=CASE WHEN (SELECT count(*) FROM page)<=?1 AND coalesce((SELECT max(dependencies) FROM sized),0)<=?3
           THEN CAST(unixepoch('subsec')*1000 AS INTEGER)+?2 END
       WHERE singleton=1 AND EXISTS(SELECT 1 FROM cursor)`,
      CENSUS_PAGE_SIZE,
      RESULT_SWEEP_INTERVAL_MS,
      MAX_DEPENDENCIES_PER_TICK,
    ),
    store.statement(
      `WITH oldest AS MATERIALIZED (
        SELECT q.rowid AS id,q.tenant,q.set_id,q.eligible_at
        FROM inventory_match_proof_retirements q INDEXED BY inventory_match_proof_retirement_due
        WHERE q.collected_at IS NULL AND q.eligible_at<CAST(unixepoch('subsec')*1000 AS INTEGER)
        AND NOT EXISTS(SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=q.tenant)
        AND EXISTS(SELECT 1 FROM inventory_match_proof_collectable p WHERE (p.tenant,p.set_id,p.eligible_at)=(q.tenant,q.set_id,q.eligible_at))
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
    ),
  ]);
  return collected.results.length;
}
