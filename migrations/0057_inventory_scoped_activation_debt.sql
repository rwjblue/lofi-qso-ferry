-- Activation asks whether work exists, not for a row from every pending job.
-- Probe current eligible scopes so disabled/obsolete pending history is not
-- scanned again by preflight or either native publication fence.
DROP VIEW inventory_comparison_generation_debt;
CREATE VIEW inventory_comparison_generation_debt AS
 SELECT d.tenant,g.generation_id FROM comparison_domains d JOIN index_generations g ON g.tenant=d.tenant AND g.generation_id IN(d.active_generation,d.pending_generation) JOIN inventory_scopes s ON s.tenant=d.tenant LEFT JOIN comparison_builds b ON b.tenant=s.tenant AND b.generation_id=g.generation_id AND b.scope_id=s.scope_id WHERE b.complete IS NOT 1 OR b.config_version IS NOT s.config_version
 UNION ALL SELECT s.tenant,s.generation_id FROM inventory_comparison_ready_builds s WHERE EXISTS(SELECT 1 FROM comparison_work w INDEXED BY comparison_work_pending_scope WHERE w.tenant=s.tenant AND w.generation_id=s.generation_id AND w.scope_id=s.scope_id AND w.completed_version<w.work_version)
 UNION ALL SELECT s.tenant,s.generation_id FROM inventory_comparison_ready_builds s WHERE EXISTS(SELECT 1 FROM inventory_projection_jobs j INDEXED BY inventory_projection_job_scope_pending WHERE j.tenant=s.tenant AND j.generation_id=s.generation_id AND j.scope_id=s.scope_id AND j.config_version=s.config_version AND j.completed_version<j.work_version)
 UNION ALL SELECT s.tenant,s.generation_id FROM inventory_comparison_ready_builds s WHERE EXISTS(SELECT 1 FROM inventory_projection_coverage_jobs j WHERE j.tenant=s.tenant AND j.generation_id=s.generation_id AND j.scope_id=s.scope_id AND j.config_version=s.config_version AND j.completed_version<j.work_version);
DROP INDEX inventory_projection_coverage_job_due;
