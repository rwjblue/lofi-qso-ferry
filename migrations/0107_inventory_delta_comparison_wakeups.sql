-- A delta can temporarily hide the retained full source selection while a
-- concurrent comparison turn projects changed contacts. Resume any projections
-- that waited for coverage when the same selection becomes ready again.
DROP TRIGGER inventory_projection_coverage_completed;
CREATE TRIGGER inventory_projection_coverage_completed
AFTER UPDATE ON inventory_coverage
WHEN NEW.facet='source' AND NEW.state='ready'
 AND (NEW.published_run_id IS NOT OLD.published_run_id OR OLD.state!='ready')
BEGIN
 INSERT INTO inventory_projection_coverage_jobs(tenant,generation_id,scope_id,config_version,coverage_stream,coverage_partition,published_run,work_version,due_at)
 SELECT c.tenant,g.generation_id,c.scope_id,c.config_version,c.stream_id,c.partition_id,c.published_run_id,1,0
 FROM inventory_full_source_coverage c JOIN comparison_domains d ON d.tenant=c.tenant
 CROSS JOIN index_generations g
 WHERE c.tenant=NEW.tenant AND c.scope_id=NEW.scope_id AND c.stream_id=NEW.stream_id AND c.partition_id=NEW.partition_id
 AND g.tenant=d.tenant AND g.generation_id IN(d.active_generation,d.pending_generation) AND g.state IN('active','building')
 AND (NEW.published_run_id IS NOT OLD.published_run_id OR EXISTS(
  SELECT 1 FROM comparison_projections p INDEXED BY comparison_projection_coverage_held
  WHERE p.tenant=c.tenant AND p.generation_id=g.generation_id AND p.scope_id=c.scope_id
   AND p.facet='source' AND p.state='held' AND p.reason='source_coverage_incomplete'
 ))
 ON CONFLICT(tenant,generation_id,scope_id) DO UPDATE SET config_version=excluded.config_version,coverage_stream=excluded.coverage_stream,coverage_partition=excluded.coverage_partition,published_run=excluded.published_run,work_version=inventory_projection_coverage_jobs.work_version+1,cursor_key='',due_at=0;
END;

-- The ingestion receipt is published after coverage and membership effects
-- and before cleanup. Keep checkpoint-only deltas from waking comparison.
-- Pair jobs signal independently when receipt membership uncertainty changes.
DROP TRIGGER inventory_comparison_wake_ingestion;
CREATE TRIGGER inventory_comparison_wake_ingestion
AFTER UPDATE OF state ON ingestion_pages
WHEN OLD.state='prepared' AND NEW.state='committed' AND (
 NOT EXISTS(
  SELECT 1 FROM ingestion_run_pages x JOIN inventory_runs r ON r.tenant=x.tenant AND r.run_id=x.run_id
  WHERE x.tenant=NEW.tenant AND x.page_id=NEW.page_id AND r.mode='delta'
   AND x.action IN('begin','page','defer','complete')
 )
 OR EXISTS(SELECT 1 FROM comparison_page_state s WHERE s.tenant=NEW.tenant AND s.page_id=NEW.page_id)
 OR EXISTS(SELECT 1 FROM ingestion_page_domains d WHERE d.tenant=NEW.tenant AND d.page_id=NEW.page_id)
 OR EXISTS(SELECT 1 FROM ingestion_membership_effects m WHERE m.tenant=NEW.tenant AND m.page_id=NEW.page_id)
 OR EXISTS(
  SELECT 1 FROM ingestion_run_pages x JOIN inventory_runs r ON r.tenant=x.tenant AND r.run_id=x.run_id
  JOIN inventory_coverage c ON (c.tenant,c.scope_id,c.stream_id,c.facet,c.partition_id)=(r.tenant,r.scope_id,r.stream_id,r.facet,r.partition_id)
  WHERE x.tenant=NEW.tenant AND x.page_id=NEW.page_id AND x.action='complete' AND c.state='ready'
   AND (EXISTS(
    SELECT 1 FROM inventory_matching_coverage_events e
    WHERE (e.tenant,e.scope_id,e.stream_id,e.facet,e.partition_id)=(c.tenant,c.scope_id,c.stream_id,c.facet,c.partition_id)
     AND e.coverage_version=c.version AND e.completed_version<e.work_version
   ) OR (c.facet='source' AND EXISTS(
    SELECT 1 FROM comparison_domains d CROSS JOIN inventory_projection_coverage_jobs j
    WHERE d.tenant=c.tenant AND j.tenant=d.tenant AND j.generation_id IN(d.active_generation,d.pending_generation)
     AND j.scope_id=c.scope_id AND j.coverage_stream=c.stream_id
     AND j.coverage_partition=c.partition_id AND j.published_run=c.published_run_id AND j.completed_version<j.work_version
   )))
 )
)
BEGIN
 INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant)
 ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1;
END;
