-- Baseline completion only retries projections waiting on full-source coverage.
-- Missing operation/event context waits for actual context changes instead.
DROP TRIGGER inventory_projection_coverage_publish;
DROP TRIGGER inventory_projection_coverage_commit;
DROP INDEX comparison_projection_context_held;
CREATE INDEX comparison_projection_coverage_held ON comparison_projections(tenant,generation_id,scope_id,record_key) WHERE facet='source' AND state='held' AND reason='source_coverage_incomplete';

CREATE TRIGGER inventory_projection_coverage_publish AFTER INSERT ON inventory_projection_coverage_pages BEGIN
 SELECT CASE WHEN NEW.state!='prepared' OR EXISTS(SELECT 1 FROM inventory_projection_coverage_stale_authority WHERE tenant=NEW.tenant AND page_id=NEW.page_id)
 OR NOT EXISTS(SELECT 1 FROM inventory_projection_coverage_jobs j WHERE j.tenant=NEW.tenant AND j.generation_id=NEW.generation_id AND j.scope_id=NEW.scope_id AND j.cursor_key=NEW.previous_cursor AND j.completed_version=NEW.completed_version AND j.completed_version<j.work_version)
 OR NEW.row_count!=(SELECT count(*) FROM comparison_projections p INDEXED BY comparison_projection_coverage_held WHERE p.tenant=NEW.tenant AND p.generation_id=NEW.generation_id AND p.scope_id=NEW.scope_id AND p.facet='source' AND p.state='held' AND p.reason='source_coverage_incomplete' AND p.record_key>NEW.previous_cursor AND p.record_key<=NEW.next_cursor)
 OR (NEW.complete=1 AND EXISTS(SELECT 1 FROM comparison_projections p INDEXED BY comparison_projection_coverage_held WHERE p.tenant=NEW.tenant AND p.generation_id=NEW.generation_id AND p.scope_id=NEW.scope_id AND p.facet='source' AND p.state='held' AND p.reason='source_coverage_incomplete' AND p.record_key>NEW.next_cursor))
 THEN RAISE(ABORT,'inventory projection coverage inputs changed') END;
 INSERT INTO comparison_work(tenant,generation_id,scope_id,record_key,facet,work_version,completed_version,due_at)
 SELECT p.tenant,p.generation_id,p.scope_id,p.record_key,p.facet,1,0,NEW.prepared_at FROM comparison_projections p INDEXED BY comparison_projection_coverage_held JOIN comparison_index i ON i.tenant=p.tenant AND i.generation_id=p.generation_id AND i.scope_id=p.scope_id AND i.record_key=p.record_key AND i.facet=p.facet AND i.state!='retired' WHERE p.tenant=NEW.tenant AND p.generation_id=NEW.generation_id AND p.scope_id=NEW.scope_id AND p.facet='source' AND p.state='held' AND p.reason='source_coverage_incomplete' AND p.record_key>NEW.previous_cursor AND p.record_key<=NEW.next_cursor
 ON CONFLICT(tenant,generation_id,scope_id,record_key,facet) DO UPDATE SET work_version=comparison_work.work_version+1,due_at=min(comparison_work.due_at,excluded.due_at) WHERE comparison_work.completed_version=comparison_work.work_version;
 UPDATE inventory_projection_coverage_jobs SET cursor_key=NEW.next_cursor,completed_version=CASE NEW.complete WHEN 1 THEN work_version ELSE completed_version END,due_at=NEW.prepared_at WHERE tenant=NEW.tenant AND generation_id=NEW.generation_id AND scope_id=NEW.scope_id;
 UPDATE inventory_projection_coverage_pages SET state='committed' WHERE tenant=NEW.tenant AND page_id=NEW.page_id;
END;

CREATE TRIGGER inventory_projection_coverage_commit BEFORE UPDATE ON inventory_projection_coverage_pages BEGIN
 SELECT CASE WHEN OLD.state!='prepared' OR NEW.state!='committed' OR EXISTS(SELECT 1 FROM inventory_projection_coverage_stale_authority WHERE tenant=OLD.tenant AND page_id=OLD.page_id)
 OR NOT EXISTS(SELECT 1 FROM inventory_projection_coverage_jobs j WHERE j.tenant=OLD.tenant AND j.generation_id=OLD.generation_id AND j.scope_id=OLD.scope_id AND j.work_version=OLD.work_version AND j.cursor_key=OLD.next_cursor AND j.completed_version=CASE OLD.complete WHEN 1 THEN OLD.work_version ELSE OLD.completed_version END)
 OR EXISTS(SELECT 1 FROM comparison_projections p INDEXED BY comparison_projection_coverage_held JOIN comparison_index i ON i.tenant=p.tenant AND i.generation_id=p.generation_id AND i.scope_id=p.scope_id AND i.record_key=p.record_key AND i.facet=p.facet AND i.state!='retired' LEFT JOIN comparison_work w ON w.tenant=i.tenant AND w.generation_id=i.generation_id AND w.scope_id=i.scope_id AND w.record_key=i.record_key AND w.facet=i.facet WHERE p.tenant=OLD.tenant AND p.generation_id=OLD.generation_id AND p.scope_id=OLD.scope_id AND p.facet='source' AND p.state='held' AND p.reason='source_coverage_incomplete' AND p.record_key>OLD.previous_cursor AND p.record_key<=OLD.next_cursor AND (w.record_key IS NULL OR w.completed_version>=w.work_version))
 THEN RAISE(ABORT,'inventory projection coverage publication incomplete') END;
END;
