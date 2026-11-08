-- Context changes enqueue one continuation per operation/generation, never one
-- mutation per child during ingestion. Native keyset pages dirty bounded cohorts.
CREATE INDEX comparison_index_parent_cursor ON comparison_index(tenant,generation_id,scope_id,parent_key,record_key,facet);
CREATE INDEX comparison_work_pending ON comparison_work(tenant,due_at,generation_id,scope_id,record_key,facet) WHERE completed_version<work_version;
CREATE INDEX comparison_work_pending_scope ON comparison_work(tenant,generation_id,scope_id,due_at,record_key,facet) WHERE completed_version<work_version;
-- Pending-only selectors replace the old index over completed work as well.
DROP INDEX comparison_work_due;
CREATE TABLE inventory_projection_jobs (
 tenant TEXT NOT NULL, generation_id TEXT NOT NULL, scope_id TEXT NOT NULL, operation_key TEXT NOT NULL,
 config_version INTEGER NOT NULL, topology_version INTEGER NOT NULL CHECK(topology_version>0),
 work_version INTEGER NOT NULL CHECK(work_version>0), completed_version INTEGER NOT NULL DEFAULT 0,
 cursor_key TEXT NOT NULL DEFAULT '', due_at INTEGER NOT NULL,
 PRIMARY KEY(tenant,generation_id,scope_id,operation_key),
 FOREIGN KEY(tenant,generation_id) REFERENCES index_generations(tenant,generation_id),
 FOREIGN KEY(tenant,scope_id,operation_key) REFERENCES projection_domains(tenant,scope_id,operation_key),
 CHECK(completed_version>=0 AND completed_version<=work_version)
);
CREATE INDEX inventory_projection_job_due ON inventory_projection_jobs(tenant,due_at,generation_id,scope_id,operation_key) WHERE completed_version<work_version;
CREATE TRIGGER inventory_projection_job_enqueue_insert AFTER INSERT ON projection_domains BEGIN
 INSERT INTO inventory_projection_jobs(tenant,generation_id,scope_id,operation_key,config_version,topology_version,work_version,due_at)
 SELECT NEW.tenant,g.generation_id,s.scope_id,NEW.operation_key,s.config_version,NEW.topology_version,1,0 FROM inventory_scopes s JOIN index_generations g ON g.tenant=s.tenant AND g.state IN('active','building') WHERE s.tenant=NEW.tenant AND s.scope_id=NEW.scope_id AND s.provider='lofi'
 ON CONFLICT(tenant,generation_id,scope_id,operation_key) DO UPDATE SET config_version=excluded.config_version,topology_version=excluded.topology_version,work_version=inventory_projection_jobs.work_version+1,cursor_key='',due_at=0;
END;
CREATE TRIGGER inventory_projection_job_enqueue_update AFTER UPDATE OF topology_version ON projection_domains WHEN NEW.topology_version!=OLD.topology_version BEGIN
 INSERT INTO inventory_projection_jobs(tenant,generation_id,scope_id,operation_key,config_version,topology_version,work_version,due_at)
 SELECT NEW.tenant,g.generation_id,s.scope_id,NEW.operation_key,s.config_version,NEW.topology_version,1,0 FROM inventory_scopes s JOIN index_generations g ON g.tenant=s.tenant AND g.state IN('active','building') WHERE s.tenant=NEW.tenant AND s.scope_id=NEW.scope_id AND s.provider='lofi'
 ON CONFLICT(tenant,generation_id,scope_id,operation_key) DO UPDATE SET config_version=excluded.config_version,topology_version=excluded.topology_version,work_version=inventory_projection_jobs.work_version+1,cursor_key='',due_at=0;
END;
CREATE TRIGGER inventory_projection_job_generation AFTER INSERT ON index_generations BEGIN
 INSERT INTO inventory_projection_jobs(tenant,generation_id,scope_id,operation_key,config_version,topology_version,work_version,due_at)
 SELECT p.tenant,NEW.generation_id,p.scope_id,p.operation_key,s.config_version,p.topology_version,1,0 FROM projection_domains p JOIN inventory_scopes s ON s.tenant=p.tenant AND s.scope_id=p.scope_id AND s.provider='lofi' WHERE p.tenant=NEW.tenant;
END;
CREATE TRIGGER inventory_projection_job_scope AFTER UPDATE OF config_version ON inventory_scopes WHEN NEW.config_version!=OLD.config_version AND NEW.provider='lofi' BEGIN
 INSERT INTO inventory_projection_jobs(tenant,generation_id,scope_id,operation_key,config_version,topology_version,work_version,due_at)
 SELECT NEW.tenant,g.generation_id,NEW.scope_id,p.operation_key,NEW.config_version,p.topology_version,1,0 FROM projection_domains p JOIN index_generations g ON g.tenant=p.tenant AND g.state IN('active','building') WHERE p.tenant=NEW.tenant AND p.scope_id=NEW.scope_id
 ON CONFLICT(tenant,generation_id,scope_id,operation_key) DO UPDATE SET config_version=excluded.config_version,topology_version=excluded.topology_version,work_version=inventory_projection_jobs.work_version+1,cursor_key='',due_at=0;
END;
INSERT INTO inventory_projection_jobs(tenant,generation_id,scope_id,operation_key,config_version,topology_version,work_version,due_at)
 SELECT p.tenant,g.generation_id,p.scope_id,p.operation_key,s.config_version,p.topology_version,1,0 FROM projection_domains p JOIN inventory_scopes s ON s.tenant=p.tenant AND s.scope_id=p.scope_id AND s.provider='lofi' JOIN index_generations g ON g.tenant=p.tenant AND g.state IN('active','building');

CREATE TABLE inventory_projection_job_pages (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL, generation_id TEXT NOT NULL, scope_id TEXT NOT NULL, operation_key TEXT NOT NULL,
 work_version INTEGER NOT NULL, completed_version INTEGER NOT NULL, config_version INTEGER NOT NULL, topology_version INTEGER NOT NULL,
 previous_cursor TEXT NOT NULL, next_cursor TEXT NOT NULL, row_count INTEGER NOT NULL CHECK(row_count BETWEEN 0 AND 200), complete INTEGER NOT NULL CHECK(complete IN(0,1)),
 lease_token TEXT NOT NULL, lease_fence INTEGER NOT NULL, input_digest TEXT NOT NULL, prepared_at INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN('prepared','committed')), PRIMARY KEY(tenant,page_id),
 FOREIGN KEY(tenant,generation_id,scope_id,operation_key) REFERENCES inventory_projection_jobs(tenant,generation_id,scope_id,operation_key),
 CHECK((row_count=0 AND previous_cursor=next_cursor AND complete=1) OR (row_count>0 AND next_cursor>previous_cursor))
);
CREATE VIEW inventory_projection_job_stale_authority AS
 SELECT h.tenant,h.page_id FROM inventory_projection_job_pages h WHERE NOT EXISTS(
 SELECT 1 FROM inventory_projection_jobs j JOIN inventory_scopes s ON s.tenant=j.tenant AND s.scope_id=j.scope_id
 JOIN accounts a ON a.id=s.tenant AND a.status='active' JOIN connections c ON c.tenant=s.tenant AND c.id=s.connection_id AND c.kind='lofi' AND c.status='active' AND c.remote_identity=s.logical_identity
 JOIN comparison_builds b ON b.tenant=j.tenant AND b.generation_id=j.generation_id AND b.scope_id=j.scope_id AND b.complete=1 AND b.config_version=s.config_version
 JOIN index_generations g ON g.tenant=j.tenant AND g.generation_id=j.generation_id AND g.state IN('active','building')
 JOIN projection_domains d ON d.tenant=j.tenant AND d.scope_id=j.scope_id AND d.operation_key=j.operation_key AND d.topology_version=h.topology_version
 JOIN leases l ON l.tenant=j.tenant AND l.scope=json_array('projection-fanout',j.generation_id,j.scope_id,j.operation_key) AND l.token=h.lease_token AND l.fence=h.lease_fence AND l.expires_at>unixepoch('subsec')*1000
 WHERE j.tenant=h.tenant AND j.generation_id=h.generation_id AND j.scope_id=h.scope_id AND j.operation_key=h.operation_key AND j.work_version=h.work_version AND j.config_version=h.config_version AND j.topology_version=h.topology_version AND s.config_version=h.config_version AND s.state='observing' AND h.prepared_at>0 AND h.prepared_at<=unixepoch('subsec')*1000);
CREATE TRIGGER inventory_projection_job_page_admit AFTER INSERT ON inventory_projection_job_pages BEGIN
 SELECT CASE WHEN NEW.state!='prepared' OR EXISTS(SELECT 1 FROM inventory_projection_job_stale_authority WHERE tenant=NEW.tenant AND page_id=NEW.page_id)
 OR NOT EXISTS(SELECT 1 FROM inventory_projection_jobs j WHERE j.tenant=NEW.tenant AND j.generation_id=NEW.generation_id AND j.scope_id=NEW.scope_id AND j.operation_key=NEW.operation_key AND j.cursor_key=NEW.previous_cursor AND j.completed_version=NEW.completed_version AND j.completed_version<j.work_version)
 OR NEW.row_count!=(SELECT count(*) FROM comparison_index i WHERE i.tenant=NEW.tenant AND i.generation_id=NEW.generation_id AND i.scope_id=NEW.scope_id AND i.parent_key=NEW.operation_key AND i.facet='source' AND i.record_key>NEW.previous_cursor AND i.record_key<=NEW.next_cursor)
 OR (NEW.complete=1 AND EXISTS(SELECT 1 FROM comparison_index i WHERE i.tenant=NEW.tenant AND i.generation_id=NEW.generation_id AND i.scope_id=NEW.scope_id AND i.parent_key=NEW.operation_key AND i.facet='source' AND i.record_key>NEW.next_cursor))
 THEN RAISE(ABORT,'inventory projection job inputs changed') END;
END;
CREATE TRIGGER inventory_projection_job_progress BEFORE UPDATE ON inventory_projection_jobs WHEN NEW.work_version=OLD.work_version AND (NEW.cursor_key!=OLD.cursor_key OR NEW.completed_version!=OLD.completed_version) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_projection_job_pages h WHERE h.tenant=OLD.tenant AND h.generation_id=OLD.generation_id AND h.scope_id=OLD.scope_id AND h.operation_key=OLD.operation_key AND h.work_version=OLD.work_version AND h.completed_version=OLD.completed_version AND h.previous_cursor=OLD.cursor_key AND h.next_cursor=NEW.cursor_key AND NEW.completed_version=CASE h.complete WHEN 1 THEN h.work_version ELSE h.completed_version END AND h.state='prepared' AND NOT EXISTS(SELECT 1 FROM inventory_projection_job_stale_authority x WHERE x.tenant=h.tenant AND x.page_id=h.page_id)) THEN RAISE(ABORT,'inventory projection job publication guard missing') END;
END;
CREATE TRIGGER inventory_projection_job_monotonic BEFORE UPDATE ON inventory_projection_jobs WHEN NEW.tenant!=OLD.tenant OR NEW.generation_id!=OLD.generation_id OR NEW.scope_id!=OLD.scope_id OR NEW.operation_key!=OLD.operation_key OR NEW.work_version<OLD.work_version OR NEW.completed_version<OLD.completed_version OR (NEW.work_version>OLD.work_version AND (NEW.work_version!=OLD.work_version+1 OR NEW.completed_version!=OLD.completed_version OR NEW.cursor_key!='')) OR (NEW.work_version=OLD.work_version AND (NEW.cursor_key<OLD.cursor_key OR NEW.topology_version!=OLD.topology_version OR NEW.config_version!=OLD.config_version)) BEGIN SELECT RAISE(ABORT,'inventory projection job regressed'); END;
CREATE TRIGGER inventory_projection_job_delete BEFORE DELETE ON inventory_projection_jobs WHEN OLD.completed_version<OLD.work_version AND EXISTS(SELECT 1 FROM index_generations g WHERE g.tenant=OLD.tenant AND g.generation_id=OLD.generation_id AND g.state IN('active','building')) BEGIN SELECT RAISE(ABORT,'pending inventory projection job'); END;
CREATE TRIGGER inventory_projection_job_page_commit BEFORE UPDATE ON inventory_projection_job_pages BEGIN
 SELECT CASE WHEN OLD.state!='prepared' OR NEW.state!='committed' OR EXISTS(SELECT 1 FROM inventory_projection_job_stale_authority WHERE tenant=OLD.tenant AND page_id=OLD.page_id)
 OR NOT EXISTS(SELECT 1 FROM inventory_projection_jobs j WHERE j.tenant=OLD.tenant AND j.generation_id=OLD.generation_id AND j.scope_id=OLD.scope_id AND j.operation_key=OLD.operation_key AND j.work_version=OLD.work_version AND j.cursor_key=OLD.next_cursor AND j.completed_version=CASE OLD.complete WHEN 1 THEN OLD.work_version ELSE OLD.completed_version END)
 OR EXISTS(SELECT 1 FROM comparison_index i LEFT JOIN comparison_work w ON w.tenant=i.tenant AND w.generation_id=i.generation_id AND w.scope_id=i.scope_id AND w.record_key=i.record_key AND w.facet=i.facet WHERE i.tenant=OLD.tenant AND i.generation_id=OLD.generation_id AND i.scope_id=OLD.scope_id AND i.parent_key=OLD.operation_key AND i.facet='source' AND i.record_key>OLD.previous_cursor AND i.record_key<=OLD.next_cursor AND i.state!='retired' AND i.topology_version!=OLD.topology_version AND (w.record_key IS NULL OR w.completed_version>=w.work_version))
 THEN RAISE(ABORT,'inventory projection job publication incomplete') END;
END;
CREATE TRIGGER inventory_projection_job_page_identity BEFORE UPDATE ON inventory_projection_job_pages WHEN (NEW.tenant,NEW.page_id,NEW.generation_id,NEW.scope_id,NEW.operation_key,NEW.work_version,NEW.completed_version,NEW.config_version,NEW.topology_version,NEW.previous_cursor,NEW.next_cursor,NEW.row_count,NEW.complete,NEW.lease_token,NEW.lease_fence,NEW.input_digest,NEW.prepared_at) IS NOT (OLD.tenant,OLD.page_id,OLD.generation_id,OLD.scope_id,OLD.operation_key,OLD.work_version,OLD.completed_version,OLD.config_version,OLD.topology_version,OLD.previous_cursor,OLD.next_cursor,OLD.row_count,OLD.complete,OLD.lease_token,OLD.lease_fence,OLD.input_digest,OLD.prepared_at) BEGIN SELECT RAISE(ABORT,'immutable inventory projection job receipt'); END;
CREATE TRIGGER inventory_projection_job_page_delete BEFORE DELETE ON inventory_projection_job_pages WHEN OLD.state!='committed' OR OLD.prepared_at>unixepoch('subsec')*1000-604800000 BEGIN SELECT RAISE(ABORT,'retained inventory projection job receipt'); END;
