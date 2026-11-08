-- Full source completion queues constant-size recovery controls. Held contacts
-- are visited later through an indexed keyset, outside the ingestion commit.
CREATE INDEX comparison_projection_context_held ON comparison_projections(tenant,generation_id,scope_id,record_key) WHERE facet='source' AND state='held' AND reason='operation_context_incomplete';
CREATE VIEW inventory_full_source_coverage AS
 SELECT c.*,s.config_version FROM inventory_coverage c JOIN inventory_scopes s ON s.tenant=c.tenant AND s.scope_id=c.scope_id AND s.provider='lofi' AND s.state='observing' AND s.config_version=c.published_config_version
 JOIN inventory_runs r ON r.tenant=c.tenant AND r.run_id=c.published_run_id AND r.scope_id=c.scope_id AND r.stream_id=c.stream_id AND r.partition_id=c.partition_id AND r.facet='source' AND r.mode='full' AND r.requires_catchup=1 AND r.phase='complete' AND r.config_version=s.config_version
 WHERE c.facet='source' AND c.state='ready' AND c.kind='observed_selection' AND json_array_length(r.required_streams)=2 AND EXISTS(SELECT 1 FROM json_each(r.required_streams) WHERE value='operations') AND EXISTS(SELECT 1 FROM json_each(r.required_streams) WHERE value='qsos');
CREATE TABLE inventory_projection_coverage_jobs (
 tenant TEXT NOT NULL, generation_id TEXT NOT NULL, scope_id TEXT NOT NULL,
 config_version INTEGER NOT NULL, coverage_stream TEXT NOT NULL, coverage_partition TEXT NOT NULL, published_run TEXT NOT NULL,
 work_version INTEGER NOT NULL CHECK(work_version>0), completed_version INTEGER NOT NULL DEFAULT 0,
 cursor_key TEXT NOT NULL DEFAULT '', due_at INTEGER NOT NULL,
 PRIMARY KEY(tenant,generation_id,scope_id), FOREIGN KEY(tenant,generation_id) REFERENCES index_generations(tenant,generation_id),
 FOREIGN KEY(tenant,scope_id) REFERENCES inventory_scopes(tenant,scope_id), FOREIGN KEY(tenant,published_run) REFERENCES inventory_runs(tenant,run_id),
 CHECK(completed_version>=0 AND completed_version<=work_version)
);
CREATE INDEX inventory_projection_coverage_job_due ON inventory_projection_coverage_jobs(tenant,due_at,generation_id,scope_id) WHERE completed_version<work_version;
CREATE TRIGGER inventory_projection_coverage_completed AFTER UPDATE ON inventory_coverage WHEN NEW.facet='source' AND NEW.state='ready' AND NEW.published_run_id IS NOT OLD.published_run_id BEGIN
 INSERT INTO inventory_projection_coverage_jobs(tenant,generation_id,scope_id,config_version,coverage_stream,coverage_partition,published_run,work_version,due_at)
 SELECT c.tenant,g.generation_id,c.scope_id,c.config_version,c.stream_id,c.partition_id,c.published_run_id,1,0 FROM inventory_full_source_coverage c JOIN index_generations g ON g.tenant=c.tenant AND g.state IN('active','building') WHERE c.tenant=NEW.tenant AND c.scope_id=NEW.scope_id AND c.stream_id=NEW.stream_id AND c.partition_id=NEW.partition_id
 ON CONFLICT(tenant,generation_id,scope_id) DO UPDATE SET config_version=excluded.config_version,coverage_stream=excluded.coverage_stream,coverage_partition=excluded.coverage_partition,published_run=excluded.published_run,work_version=inventory_projection_coverage_jobs.work_version+1,cursor_key='',due_at=0;
END;
CREATE TRIGGER inventory_projection_coverage_generation AFTER INSERT ON index_generations BEGIN
 INSERT INTO inventory_projection_coverage_jobs(tenant,generation_id,scope_id,config_version,coverage_stream,coverage_partition,published_run,work_version,due_at)
 SELECT tenant,NEW.generation_id,scope_id,config_version,stream_id,partition_id,published_run_id,1,0 FROM (SELECT c.*,row_number() OVER(PARTITION BY tenant,scope_id ORDER BY completed_at DESC,stream_id,partition_id) AS rank FROM inventory_full_source_coverage c WHERE c.tenant=NEW.tenant) WHERE rank=1;
END;
INSERT INTO inventory_projection_coverage_jobs(tenant,generation_id,scope_id,config_version,coverage_stream,coverage_partition,published_run,work_version,due_at)
 SELECT c.tenant,g.generation_id,c.scope_id,c.config_version,c.stream_id,c.partition_id,c.published_run_id,1,0 FROM (SELECT c.*,row_number() OVER(PARTITION BY tenant,scope_id ORDER BY completed_at DESC,stream_id,partition_id) AS rank FROM inventory_full_source_coverage c) c JOIN index_generations g ON g.tenant=c.tenant AND g.state IN('active','building') WHERE c.rank=1;

CREATE TABLE inventory_projection_coverage_pages (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL, generation_id TEXT NOT NULL, scope_id TEXT NOT NULL, config_version INTEGER NOT NULL,
 work_version INTEGER NOT NULL, completed_version INTEGER NOT NULL, coverage_stream TEXT NOT NULL, coverage_partition TEXT NOT NULL, published_run TEXT NOT NULL,
 previous_cursor TEXT NOT NULL, next_cursor TEXT NOT NULL, row_count INTEGER NOT NULL CHECK(row_count BETWEEN 0 AND 200), complete INTEGER NOT NULL CHECK(complete IN(0,1)),
 lease_token TEXT NOT NULL, lease_fence INTEGER NOT NULL, input_digest TEXT NOT NULL, prepared_at INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN('prepared','committed')), PRIMARY KEY(tenant,page_id),
 FOREIGN KEY(tenant,generation_id,scope_id) REFERENCES inventory_projection_coverage_jobs(tenant,generation_id,scope_id),
 CHECK((row_count=0 AND previous_cursor=next_cursor AND complete=1) OR (row_count>0 AND next_cursor>previous_cursor))
);
CREATE VIEW inventory_projection_coverage_stale_authority AS
 SELECT h.tenant,h.page_id FROM inventory_projection_coverage_pages h WHERE NOT EXISTS(
 SELECT 1 FROM inventory_projection_coverage_jobs j JOIN inventory_scopes s ON s.tenant=j.tenant AND s.scope_id=j.scope_id AND s.state='observing' AND s.config_version=h.config_version
 JOIN accounts a ON a.id=s.tenant AND a.status='active' JOIN connections c ON c.tenant=s.tenant AND c.id=s.connection_id AND c.kind='lofi' AND c.status='active' AND c.remote_identity=s.logical_identity
 JOIN index_generations g ON g.tenant=j.tenant AND g.generation_id=j.generation_id AND g.state IN('active','building')
 JOIN comparison_builds b ON b.tenant=j.tenant AND b.generation_id=j.generation_id AND b.scope_id=j.scope_id AND b.complete=1 AND b.config_version=s.config_version
 JOIN inventory_full_source_coverage cv ON cv.tenant=j.tenant AND cv.scope_id=j.scope_id AND cv.stream_id=h.coverage_stream AND cv.partition_id=h.coverage_partition AND cv.published_run_id=h.published_run
 JOIN leases l ON l.tenant=j.tenant AND l.scope=json_array('projection-coverage',j.generation_id,j.scope_id) AND l.token=h.lease_token AND l.fence=h.lease_fence AND l.expires_at>unixepoch('subsec')*1000
 WHERE j.tenant=h.tenant AND j.generation_id=h.generation_id AND j.scope_id=h.scope_id AND j.work_version=h.work_version AND j.config_version=h.config_version AND j.coverage_stream=h.coverage_stream AND j.coverage_partition=h.coverage_partition AND j.published_run=h.published_run AND h.prepared_at>0 AND h.prepared_at<=unixepoch('subsec')*1000);
CREATE TRIGGER inventory_projection_coverage_publish AFTER INSERT ON inventory_projection_coverage_pages BEGIN
 SELECT CASE WHEN NEW.state!='prepared' OR EXISTS(SELECT 1 FROM inventory_projection_coverage_stale_authority WHERE tenant=NEW.tenant AND page_id=NEW.page_id)
 OR NOT EXISTS(SELECT 1 FROM inventory_projection_coverage_jobs j WHERE j.tenant=NEW.tenant AND j.generation_id=NEW.generation_id AND j.scope_id=NEW.scope_id AND j.cursor_key=NEW.previous_cursor AND j.completed_version=NEW.completed_version AND j.completed_version<j.work_version)
 OR NEW.row_count!=(SELECT count(*) FROM comparison_projections p INDEXED BY comparison_projection_context_held WHERE p.tenant=NEW.tenant AND p.generation_id=NEW.generation_id AND p.scope_id=NEW.scope_id AND p.facet='source' AND p.state='held' AND p.reason='operation_context_incomplete' AND p.record_key>NEW.previous_cursor AND p.record_key<=NEW.next_cursor)
 OR (NEW.complete=1 AND EXISTS(SELECT 1 FROM comparison_projections p INDEXED BY comparison_projection_context_held WHERE p.tenant=NEW.tenant AND p.generation_id=NEW.generation_id AND p.scope_id=NEW.scope_id AND p.facet='source' AND p.state='held' AND p.reason='operation_context_incomplete' AND p.record_key>NEW.next_cursor))
 THEN RAISE(ABORT,'inventory projection coverage inputs changed') END;
 INSERT INTO comparison_work(tenant,generation_id,scope_id,record_key,facet,work_version,completed_version,due_at)
 SELECT p.tenant,p.generation_id,p.scope_id,p.record_key,p.facet,1,0,NEW.prepared_at FROM comparison_projections p INDEXED BY comparison_projection_context_held JOIN comparison_index i ON i.tenant=p.tenant AND i.generation_id=p.generation_id AND i.scope_id=p.scope_id AND i.record_key=p.record_key AND i.facet=p.facet AND i.state!='retired' WHERE p.tenant=NEW.tenant AND p.generation_id=NEW.generation_id AND p.scope_id=NEW.scope_id AND p.facet='source' AND p.state='held' AND p.reason='operation_context_incomplete' AND p.record_key>NEW.previous_cursor AND p.record_key<=NEW.next_cursor
 ON CONFLICT(tenant,generation_id,scope_id,record_key,facet) DO UPDATE SET work_version=comparison_work.work_version+1,due_at=min(comparison_work.due_at,excluded.due_at) WHERE comparison_work.completed_version=comparison_work.work_version;
 UPDATE inventory_projection_coverage_jobs SET cursor_key=NEW.next_cursor,completed_version=CASE NEW.complete WHEN 1 THEN work_version ELSE completed_version END,due_at=NEW.prepared_at WHERE tenant=NEW.tenant AND generation_id=NEW.generation_id AND scope_id=NEW.scope_id;
 UPDATE inventory_projection_coverage_pages SET state='committed' WHERE tenant=NEW.tenant AND page_id=NEW.page_id;
END;
CREATE TRIGGER inventory_projection_coverage_progress BEFORE UPDATE ON inventory_projection_coverage_jobs WHEN NEW.work_version=OLD.work_version AND (NEW.cursor_key!=OLD.cursor_key OR NEW.completed_version!=OLD.completed_version) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_projection_coverage_pages h WHERE h.tenant=OLD.tenant AND h.generation_id=OLD.generation_id AND h.scope_id=OLD.scope_id AND h.work_version=OLD.work_version AND h.completed_version=OLD.completed_version AND h.previous_cursor=OLD.cursor_key AND h.next_cursor=NEW.cursor_key AND NEW.completed_version=CASE h.complete WHEN 1 THEN h.work_version ELSE h.completed_version END AND h.state='prepared' AND NOT EXISTS(SELECT 1 FROM inventory_projection_coverage_stale_authority x WHERE x.tenant=h.tenant AND x.page_id=h.page_id)) THEN RAISE(ABORT,'inventory projection coverage publication guard missing') END;
END;
CREATE TRIGGER inventory_projection_coverage_monotonic BEFORE UPDATE ON inventory_projection_coverage_jobs WHEN NEW.tenant!=OLD.tenant OR NEW.generation_id!=OLD.generation_id OR NEW.scope_id!=OLD.scope_id OR NEW.work_version<OLD.work_version OR NEW.completed_version<OLD.completed_version OR (NEW.work_version>OLD.work_version AND (NEW.work_version!=OLD.work_version+1 OR NEW.completed_version!=OLD.completed_version OR NEW.cursor_key!='')) OR (NEW.work_version=OLD.work_version AND (NEW.cursor_key<OLD.cursor_key OR NEW.config_version!=OLD.config_version OR NEW.coverage_stream!=OLD.coverage_stream OR NEW.coverage_partition!=OLD.coverage_partition OR NEW.published_run!=OLD.published_run)) BEGIN SELECT RAISE(ABORT,'inventory projection coverage job regressed'); END;
CREATE TRIGGER inventory_projection_coverage_job_delete BEFORE DELETE ON inventory_projection_coverage_jobs WHEN OLD.completed_version<OLD.work_version AND EXISTS(SELECT 1 FROM index_generations g WHERE g.tenant=OLD.tenant AND g.generation_id=OLD.generation_id AND g.state IN('active','building')) BEGIN SELECT RAISE(ABORT,'pending inventory projection coverage job'); END;
CREATE TRIGGER inventory_projection_coverage_commit BEFORE UPDATE ON inventory_projection_coverage_pages BEGIN
 SELECT CASE WHEN OLD.state!='prepared' OR NEW.state!='committed' OR EXISTS(SELECT 1 FROM inventory_projection_coverage_stale_authority WHERE tenant=OLD.tenant AND page_id=OLD.page_id)
 OR NOT EXISTS(SELECT 1 FROM inventory_projection_coverage_jobs j WHERE j.tenant=OLD.tenant AND j.generation_id=OLD.generation_id AND j.scope_id=OLD.scope_id AND j.work_version=OLD.work_version AND j.cursor_key=OLD.next_cursor AND j.completed_version=CASE OLD.complete WHEN 1 THEN OLD.work_version ELSE OLD.completed_version END)
 OR EXISTS(SELECT 1 FROM comparison_projections p INDEXED BY comparison_projection_context_held JOIN comparison_index i ON i.tenant=p.tenant AND i.generation_id=p.generation_id AND i.scope_id=p.scope_id AND i.record_key=p.record_key AND i.facet=p.facet AND i.state!='retired' LEFT JOIN comparison_work w ON w.tenant=i.tenant AND w.generation_id=i.generation_id AND w.scope_id=i.scope_id AND w.record_key=i.record_key AND w.facet=i.facet WHERE p.tenant=OLD.tenant AND p.generation_id=OLD.generation_id AND p.scope_id=OLD.scope_id AND p.facet='source' AND p.state='held' AND p.reason='operation_context_incomplete' AND p.record_key>OLD.previous_cursor AND p.record_key<=OLD.next_cursor AND (w.record_key IS NULL OR w.completed_version>=w.work_version))
 THEN RAISE(ABORT,'inventory projection coverage publication incomplete') END;
END;
CREATE TRIGGER inventory_projection_coverage_page_identity BEFORE UPDATE ON inventory_projection_coverage_pages WHEN (NEW.tenant,NEW.page_id,NEW.generation_id,NEW.scope_id,NEW.config_version,NEW.work_version,NEW.completed_version,NEW.coverage_stream,NEW.coverage_partition,NEW.published_run,NEW.previous_cursor,NEW.next_cursor,NEW.row_count,NEW.complete,NEW.lease_token,NEW.lease_fence,NEW.input_digest,NEW.prepared_at) IS NOT (OLD.tenant,OLD.page_id,OLD.generation_id,OLD.scope_id,OLD.config_version,OLD.work_version,OLD.completed_version,OLD.coverage_stream,OLD.coverage_partition,OLD.published_run,OLD.previous_cursor,OLD.next_cursor,OLD.row_count,OLD.complete,OLD.lease_token,OLD.lease_fence,OLD.input_digest,OLD.prepared_at) BEGIN SELECT RAISE(ABORT,'immutable inventory projection coverage receipt'); END;
CREATE TRIGGER inventory_projection_coverage_page_delete BEFORE DELETE ON inventory_projection_coverage_pages WHEN OLD.state!='committed' OR OLD.prepared_at>unixepoch('subsec')*1000-604800000 BEGIN SELECT RAISE(ABORT,'retained inventory projection coverage receipt'); END;
