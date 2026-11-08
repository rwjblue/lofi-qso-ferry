-- Readiness dispatch is bounded by calendar prefixes, not contact count. These
-- jobs are hints for fresh comparisons and never grant delivery authority.
CREATE VIEW inventory_matching_coverage_live_routes AS
 SELECT r.* FROM comparison_domains d CROSS JOIN inventory_matching_source_routes r
 JOIN inventory_comparison_ready_builds s ON s.tenant=r.tenant AND s.generation_id=r.generation_id AND s.scope_id=r.source_scope AND s.config_version=r.source_config_version
 JOIN inventory_comparison_ready_builds t ON t.tenant=r.tenant AND t.generation_id=r.generation_id AND t.scope_id=r.destination AND t.config_version=r.destination_config_version
 WHERE r.tenant=d.tenant AND r.generation_id=d.active_generation;
CREATE TABLE inventory_matching_coverage_dispatches (
 tenant TEXT NOT NULL, dispatch_id TEXT NOT NULL, scope_id TEXT NOT NULL, stream_id TEXT NOT NULL, facet TEXT NOT NULL CHECK(facet IN('source','receipt')), partition_id TEXT NOT NULL,
 generation_id TEXT NOT NULL, key_id TEXT NOT NULL, domain_version INTEGER NOT NULL, source_set_version INTEGER NOT NULL,
 config_version INTEGER NOT NULL, published_run_id TEXT NOT NULL, coverage_version INTEGER NOT NULL, scope_clock INTEGER NOT NULL CHECK(scope_clock>0),
 work_version INTEGER NOT NULL, completed_version INTEGER NOT NULL, nodes TEXT NOT NULL CHECK(json_valid(nodes) AND json_type(nodes)='array' AND json_array_length(nodes) BETWEEN 1 AND 44),
 queued_count INTEGER NOT NULL CHECK(queued_count BETWEEN 0 AND 44), lease_token TEXT NOT NULL, lease_fence INTEGER NOT NULL, input_digest TEXT NOT NULL, prepared_at INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN('prepared','committed')), PRIMARY KEY(tenant,dispatch_id),
 FOREIGN KEY(tenant,scope_id,stream_id,facet,partition_id) REFERENCES inventory_matching_coverage_events(tenant,scope_id,stream_id,facet,partition_id),
 FOREIGN KEY(tenant,generation_id) REFERENCES index_generations(tenant,generation_id),
 CHECK(work_version>completed_version AND completed_version>=0)
);
CREATE INDEX inventory_matching_coverage_dispatch_prepared ON inventory_matching_coverage_dispatches(tenant,scope_id,stream_id,facet,partition_id,work_version) WHERE state='prepared';
CREATE TABLE inventory_matching_coverage_jobs (
 tenant TEXT NOT NULL, generation_id TEXT NOT NULL, scope_id TEXT NOT NULL, facet TEXT NOT NULL CHECK(facet IN('source','receipt')), node_hash TEXT NOT NULL,
 config_version INTEGER NOT NULL, signal_clock INTEGER NOT NULL CHECK(signal_clock>0), work_version INTEGER NOT NULL DEFAULT 1 CHECK(work_version>0), completed_version INTEGER NOT NULL DEFAULT 0,
 cursor_destination TEXT NOT NULL DEFAULT '', cursor_source TEXT NOT NULL DEFAULT '', cursor_clock INTEGER NOT NULL DEFAULT 0, cursor_set TEXT NOT NULL DEFAULT '',
 last_dispatch TEXT NOT NULL, PRIMARY KEY(tenant,generation_id,scope_id,facet,node_hash), FOREIGN KEY(tenant,last_dispatch) REFERENCES inventory_matching_coverage_dispatches(tenant,dispatch_id),
 FOREIGN KEY(tenant,generation_id) REFERENCES index_generations(tenant,generation_id), FOREIGN KEY(tenant,scope_id) REFERENCES inventory_scopes(tenant,scope_id),
 CHECK(completed_version>=0 AND completed_version<=work_version), CHECK(cursor_clock>=0),
 CHECK((facet='source' AND node_hash='') OR (facet='receipt' AND length(node_hash)=43 AND node_hash NOT GLOB '*[^A-Za-z0-9_-]*'))
);
CREATE INDEX inventory_matching_coverage_job_dispatch ON inventory_matching_coverage_jobs(tenant,last_dispatch);
CREATE INDEX inventory_matching_coverage_job_pending ON inventory_matching_coverage_jobs(tenant,generation_id,scope_id,config_version,facet,node_hash) WHERE completed_version<work_version;
CREATE VIEW inventory_matching_coverage_dispatch_stale AS
 SELECT h.tenant,h.dispatch_id FROM inventory_matching_coverage_dispatches h WHERE NOT EXISTS(
 SELECT 1 FROM inventory_matching_coverage_events e
 JOIN inventory_matching_recoverable_coverage cv ON cv.tenant=e.tenant AND cv.scope_id=e.scope_id AND cv.stream_id=e.stream_id AND cv.facet=e.facet AND cv.partition_id=e.partition_id AND cv.version=h.coverage_version AND cv.published_run_id=h.published_run_id AND cv.published_config_version=h.config_version
 JOIN inventory_scopes s ON s.tenant=e.tenant AND s.scope_id=e.scope_id AND s.config_version=h.config_version AND s.state='observing'
 JOIN accounts a ON a.id=s.tenant AND a.status='active'
 JOIN connections c ON c.tenant=s.tenant AND c.id=s.connection_id AND c.status='active' AND c.kind=s.provider AND c.remote_identity=s.logical_identity
 JOIN comparison_domains d ON d.tenant=e.tenant AND d.active_generation=h.generation_id AND d.version=h.domain_version AND d.source_set_version=h.source_set_version
 JOIN index_generations g ON g.tenant=d.tenant AND g.generation_id=d.active_generation AND g.state='active' AND g.key_id=h.key_id
 JOIN inventory_comparison_keys k ON k.tenant=g.tenant AND k.key_id=g.key_id
 JOIN inventory_comparison_ready_builds b ON b.tenant=g.tenant AND b.generation_id=g.generation_id AND b.scope_id=s.scope_id AND b.config_version=h.config_version
 JOIN inventory_matching_coverage_clocks clk ON clk.tenant=e.tenant AND clk.scope_id=e.scope_id AND clk.facet=e.facet AND clk.version=h.scope_clock
 JOIN leases l ON l.tenant=e.tenant AND l.scope=json_array('matching-coverage-event',e.scope_id,e.stream_id,e.facet,e.partition_id) AND l.token=h.lease_token AND l.fence=h.lease_fence AND l.expires_at>unixepoch('subsec')*1000
 WHERE e.tenant=h.tenant AND e.scope_id=h.scope_id AND e.stream_id=h.stream_id AND e.facet=h.facet AND e.partition_id=h.partition_id AND e.config_version=h.config_version AND e.published_run_id=h.published_run_id AND e.coverage_version=h.coverage_version AND e.work_version=h.work_version AND h.prepared_at>0 AND h.prepared_at<=unixepoch('subsec')*1000);
-- Enumerate eligible route metadata before each point probe. Retired/disabled
-- current pointers must not dominate lookup through the dependency reverse map.
CREATE VIEW inventory_matching_coverage_dispatch_needed AS
 SELECT h.tenant,h.dispatch_id,j.value AS node_hash FROM inventory_matching_coverage_dispatches h CROSS JOIN json_each(h.nodes) j
 WHERE EXISTS(SELECT 1 FROM inventory_matching_coverage_live_routes r WHERE r.tenant=h.tenant AND r.generation_id=h.generation_id AND EXISTS(
 SELECT 1 FROM inventory_matching_coverage_dependents dep INDEXED BY inventory_matching_coverage_dependents_cursor
 WHERE dep.tenant=r.tenant AND dep.generation_id=r.generation_id AND dep.scope_id=h.scope_id AND dep.facet=h.facet AND dep.node_hash=j.value AND dep.destination=r.destination AND dep.source_scope=r.source_scope AND dep.seen_clock<h.scope_clock))
 AND NOT EXISTS(SELECT 1 FROM inventory_matching_coverage_jobs w WHERE w.tenant=h.tenant AND w.generation_id=h.generation_id AND w.scope_id=h.scope_id AND w.facet=h.facet AND w.node_hash=j.value AND w.signal_clock>=h.scope_clock);
CREATE TRIGGER inventory_matching_coverage_dispatch_admit AFTER INSERT ON inventory_matching_coverage_dispatches BEGIN
 SELECT CASE WHEN NEW.state!='prepared' OR EXISTS(SELECT 1 FROM inventory_matching_coverage_dispatch_stale WHERE tenant=NEW.tenant AND dispatch_id=NEW.dispatch_id)
 OR NOT EXISTS(SELECT 1 FROM inventory_matching_coverage_events e WHERE e.tenant=NEW.tenant AND e.scope_id=NEW.scope_id AND e.stream_id=NEW.stream_id AND e.facet=NEW.facet AND e.partition_id=NEW.partition_id AND e.work_version=NEW.work_version AND e.completed_version=NEW.completed_version AND e.completed_version<e.work_version)
 THEN RAISE(ABORT,'inventory matching coverage dispatch authority changed') END;
 SELECT CASE WHEN (NEW.facet='source' AND (json_array_length(NEW.nodes)!=1 OR json_extract(NEW.nodes,'$[0]')!=''))
 OR (NEW.facet='receipt' AND EXISTS(SELECT 1 FROM json_each(NEW.nodes) WHERE type!='text' OR length(value)!=43 OR value GLOB '*[^A-Za-z0-9_-]*'))
 OR json_array_length(NEW.nodes)!=(SELECT count(DISTINCT value) FROM json_each(NEW.nodes))
 OR NEW.queued_count!=(SELECT count(*) FROM inventory_matching_coverage_dispatch_needed WHERE tenant=NEW.tenant AND dispatch_id=NEW.dispatch_id)
 THEN RAISE(ABORT,'inventory matching coverage dispatch nodes invalid') END;
 INSERT INTO inventory_matching_coverage_jobs(tenant,generation_id,scope_id,facet,node_hash,config_version,signal_clock,last_dispatch)
 SELECT NEW.tenant,NEW.generation_id,NEW.scope_id,NEW.facet,n.node_hash,NEW.config_version,NEW.scope_clock,NEW.dispatch_id FROM inventory_matching_coverage_dispatch_needed n WHERE n.tenant=NEW.tenant AND n.dispatch_id=NEW.dispatch_id
 ON CONFLICT(tenant,generation_id,scope_id,facet,node_hash) DO UPDATE SET config_version=excluded.config_version,signal_clock=excluded.signal_clock,work_version=inventory_matching_coverage_jobs.work_version+1,cursor_destination='',cursor_source='',cursor_clock=0,cursor_set='',last_dispatch=excluded.last_dispatch;
 UPDATE inventory_matching_coverage_events SET completed_version=NEW.work_version WHERE tenant=NEW.tenant AND scope_id=NEW.scope_id AND stream_id=NEW.stream_id AND facet=NEW.facet AND partition_id=NEW.partition_id;
 UPDATE inventory_matching_coverage_dispatches SET state='committed' WHERE tenant=NEW.tenant AND dispatch_id=NEW.dispatch_id;
END;
DROP TRIGGER inventory_matching_coverage_event_progress;
CREATE TRIGGER inventory_matching_coverage_event_progress BEFORE UPDATE ON inventory_matching_coverage_events WHEN NEW.work_version=OLD.work_version AND NEW.completed_version!=OLD.completed_version BEGIN
 SELECT CASE WHEN NEW.completed_version!=OLD.work_version OR NOT EXISTS(SELECT 1 FROM inventory_matching_coverage_dispatches h INDEXED BY inventory_matching_coverage_dispatch_prepared WHERE h.tenant=OLD.tenant AND h.scope_id=OLD.scope_id AND h.stream_id=OLD.stream_id AND h.facet=OLD.facet AND h.partition_id=OLD.partition_id AND h.work_version=OLD.work_version AND h.completed_version=OLD.completed_version AND h.state='prepared' AND NOT EXISTS(SELECT 1 FROM inventory_matching_coverage_dispatch_stale x WHERE x.tenant=h.tenant AND x.dispatch_id=h.dispatch_id)) THEN RAISE(ABORT,'inventory matching coverage dispatch progress guard missing') END;
END;
CREATE TRIGGER inventory_matching_coverage_job_insert BEFORE INSERT ON inventory_matching_coverage_jobs BEGIN
 SELECT CASE WHEN NEW.work_version!=1 OR NEW.completed_version!=0 OR (NEW.cursor_destination,NEW.cursor_source,NEW.cursor_clock,NEW.cursor_set)!=('','',0,'')
 OR NOT EXISTS(SELECT 1 FROM inventory_matching_coverage_dispatches h WHERE h.tenant=NEW.tenant AND h.dispatch_id=NEW.last_dispatch AND h.state='prepared' AND h.generation_id=NEW.generation_id AND h.scope_id=NEW.scope_id AND h.facet=NEW.facet AND h.config_version=NEW.config_version AND h.scope_clock=NEW.signal_clock AND EXISTS(SELECT 1 FROM inventory_matching_coverage_dispatch_needed n WHERE n.tenant=h.tenant AND n.dispatch_id=h.dispatch_id AND n.node_hash=NEW.node_hash)) THEN RAISE(ABORT,'inventory matching coverage job signal invalid') END;
END;
CREATE TRIGGER inventory_matching_coverage_job_clock BEFORE UPDATE ON inventory_matching_coverage_jobs BEGIN
 SELECT CASE WHEN (NEW.tenant,NEW.generation_id,NEW.scope_id,NEW.facet,NEW.node_hash) IS NOT (OLD.tenant,OLD.generation_id,OLD.scope_id,OLD.facet,OLD.node_hash) OR NEW.work_version<OLD.work_version OR NEW.completed_version<OLD.completed_version OR NEW.signal_clock<OLD.signal_clock THEN RAISE(ABORT,'inventory matching coverage job regressed') END;
 SELECT CASE WHEN NEW.work_version!=OLD.work_version AND (NEW.work_version!=OLD.work_version+1 OR NEW.completed_version!=OLD.completed_version OR NEW.signal_clock<=OLD.signal_clock OR (NEW.cursor_destination,NEW.cursor_source,NEW.cursor_clock,NEW.cursor_set)!=('','',0,'') OR NOT EXISTS(SELECT 1 FROM inventory_matching_coverage_dispatches h WHERE h.tenant=NEW.tenant AND h.dispatch_id=NEW.last_dispatch AND h.state='prepared' AND h.generation_id=NEW.generation_id AND h.scope_id=NEW.scope_id AND h.facet=NEW.facet AND h.config_version=NEW.config_version AND h.scope_clock=NEW.signal_clock AND EXISTS(SELECT 1 FROM json_each(h.nodes) WHERE value=NEW.node_hash))) THEN RAISE(ABORT,'inventory matching coverage job signal changed progress') END;
 SELECT CASE WHEN NEW.work_version=OLD.work_version AND (NEW.config_version,NEW.signal_clock,NEW.last_dispatch) IS NOT (OLD.config_version,OLD.signal_clock,OLD.last_dispatch) THEN RAISE(ABORT,'inventory matching coverage job binding changed') END;
END;
CREATE TRIGGER inventory_matching_coverage_job_progress BEFORE UPDATE ON inventory_matching_coverage_jobs WHEN NEW.work_version=OLD.work_version AND (NEW.completed_version,NEW.cursor_destination,NEW.cursor_source,NEW.cursor_clock,NEW.cursor_set) IS NOT (OLD.completed_version,OLD.cursor_destination,OLD.cursor_source,OLD.cursor_clock,OLD.cursor_set) BEGIN SELECT RAISE(ABORT,'inventory matching coverage job publisher required'); END;
CREATE TRIGGER inventory_matching_coverage_job_delete BEFORE DELETE ON inventory_matching_coverage_jobs WHEN OLD.completed_version<OLD.work_version AND EXISTS(SELECT 1 FROM index_generations g WHERE g.tenant=OLD.tenant AND g.generation_id=OLD.generation_id AND g.state IN('active','building')) BEGIN SELECT RAISE(ABORT,'pending inventory matching coverage job'); END;
CREATE TRIGGER inventory_matching_coverage_dispatch_commit BEFORE UPDATE ON inventory_matching_coverage_dispatches BEGIN
 SELECT CASE WHEN OLD.state!='prepared' OR NEW.state!='committed' OR EXISTS(SELECT 1 FROM inventory_matching_coverage_dispatch_stale WHERE tenant=OLD.tenant AND dispatch_id=OLD.dispatch_id)
 OR NOT EXISTS(SELECT 1 FROM inventory_matching_coverage_events e WHERE e.tenant=OLD.tenant AND e.scope_id=OLD.scope_id AND e.stream_id=OLD.stream_id AND e.facet=OLD.facet AND e.partition_id=OLD.partition_id AND e.work_version=OLD.work_version AND e.completed_version=OLD.work_version)
 THEN RAISE(ABORT,'inventory matching coverage dispatch commit changed') END;
 SELECT CASE WHEN OLD.queued_count!=(SELECT count(*) FROM inventory_matching_coverage_jobs WHERE tenant=OLD.tenant AND last_dispatch=OLD.dispatch_id)
 OR EXISTS(SELECT 1 FROM inventory_matching_coverage_jobs w WHERE w.tenant=OLD.tenant AND w.last_dispatch=OLD.dispatch_id AND (w.generation_id!=OLD.generation_id OR w.scope_id!=OLD.scope_id OR w.facet!=OLD.facet OR w.config_version!=OLD.config_version OR w.signal_clock!=OLD.scope_clock OR NOT EXISTS(SELECT 1 FROM json_each(OLD.nodes) WHERE value=w.node_hash)))
 OR EXISTS(SELECT 1 FROM inventory_matching_coverage_dispatch_needed WHERE tenant=OLD.tenant AND dispatch_id=OLD.dispatch_id)
 THEN RAISE(ABORT,'inventory matching coverage dispatch publication incomplete') END;
END;
CREATE TRIGGER inventory_matching_coverage_dispatch_identity BEFORE UPDATE ON inventory_matching_coverage_dispatches WHEN (NEW.tenant,NEW.dispatch_id,NEW.scope_id,NEW.stream_id,NEW.facet,NEW.partition_id,NEW.generation_id,NEW.key_id,NEW.domain_version,NEW.source_set_version,NEW.config_version,NEW.published_run_id,NEW.coverage_version,NEW.scope_clock,NEW.work_version,NEW.completed_version,NEW.nodes,NEW.queued_count,NEW.lease_token,NEW.lease_fence,NEW.input_digest,NEW.prepared_at) IS NOT (OLD.tenant,OLD.dispatch_id,OLD.scope_id,OLD.stream_id,OLD.facet,OLD.partition_id,OLD.generation_id,OLD.key_id,OLD.domain_version,OLD.source_set_version,OLD.config_version,OLD.published_run_id,OLD.coverage_version,OLD.scope_clock,OLD.work_version,OLD.completed_version,OLD.nodes,OLD.queued_count,OLD.lease_token,OLD.lease_fence,OLD.input_digest,OLD.prepared_at) BEGIN SELECT RAISE(ABORT,'immutable inventory matching coverage dispatch'); END;
CREATE TRIGGER inventory_matching_coverage_dispatch_delete BEFORE DELETE ON inventory_matching_coverage_dispatches WHEN OLD.state!='committed' OR OLD.prepared_at>unixepoch('subsec')*1000-604800000 OR EXISTS(SELECT 1 FROM inventory_matching_coverage_jobs w WHERE w.tenant=OLD.tenant AND w.last_dispatch=OLD.dispatch_id) BEGIN SELECT RAISE(ABORT,'retained inventory matching coverage dispatch'); END;
