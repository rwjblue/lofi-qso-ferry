-- Materialize current eligible build scopes before probing their pending work.
-- Retired generations and disabled scopes must not create full-history scans.
CREATE VIEW inventory_comparison_ready_builds AS
 SELECT s.tenant,g.generation_id,s.scope_id,s.provider,s.config_version FROM comparison_domains d
 JOIN accounts a ON a.id=d.tenant AND a.status='active'
 CROSS JOIN index_generations g CROSS JOIN inventory_scopes s
 JOIN connections c ON c.tenant=s.tenant AND c.id=s.connection_id AND c.status='active' AND c.kind=s.provider AND c.remote_identity=s.logical_identity
 JOIN comparison_builds b ON b.tenant=s.tenant AND b.generation_id=g.generation_id AND b.scope_id=s.scope_id AND b.complete=1 AND b.config_version=s.config_version
 WHERE g.tenant=d.tenant AND g.generation_id IN(d.active_generation,d.pending_generation) AND g.state IN('active','building') AND s.tenant=d.tenant AND s.state='observing';
CREATE INDEX inventory_projection_job_scope_pending ON inventory_projection_jobs(tenant,generation_id,scope_id,config_version,due_at,operation_key) WHERE completed_version<work_version;
-- All selectors now probe within eligible scopes. Avoid paying for the
-- superseded tenant-global pending indexes on every queued/completed row.
DROP INDEX comparison_work_pending;
DROP INDEX inventory_projection_job_due;
