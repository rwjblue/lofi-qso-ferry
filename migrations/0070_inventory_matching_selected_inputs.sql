-- Selected inputs invalidate the whole captured cohort even when no candidate
-- query probes that source. Watch stable identities, including missing inputs.
CREATE TABLE inventory_matching_selected_jobs (
 tenant TEXT NOT NULL, generation_id TEXT NOT NULL, scope_id TEXT NOT NULL, facet TEXT NOT NULL DEFAULT 'source' CHECK(facet='source'), record_key TEXT NOT NULL CHECK(length(record_key) BETWEEN 1 AND 512),
 config_version INTEGER NOT NULL, signal_clock INTEGER NOT NULL DEFAULT 1 CHECK(signal_clock>0), work_version INTEGER NOT NULL DEFAULT 1 CHECK(work_version>0), completed_version INTEGER NOT NULL DEFAULT 0,
 cursor_destination TEXT NOT NULL DEFAULT '', cursor_source TEXT NOT NULL DEFAULT '', cursor_clock INTEGER NOT NULL DEFAULT 0 CHECK(cursor_clock>=0), cursor_set TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(tenant,generation_id,scope_id,facet,record_key), FOREIGN KEY(tenant,generation_id,scope_id) REFERENCES comparison_builds(tenant,generation_id,scope_id),
 CHECK(signal_clock=work_version AND completed_version>=0 AND completed_version<=work_version)
);
CREATE TABLE inventory_matching_selected_dependents (
 tenant TEXT NOT NULL, set_id TEXT NOT NULL, generation_id TEXT NOT NULL, destination TEXT NOT NULL, source_scope TEXT NOT NULL,
 scope_id TEXT NOT NULL, facet TEXT NOT NULL DEFAULT 'source' CHECK(facet='source'), record_key TEXT NOT NULL, seen_clock INTEGER NOT NULL CHECK(seen_clock>=0),
 PRIMARY KEY(tenant,set_id,source_scope,scope_id,facet,record_key), FOREIGN KEY(tenant,set_id) REFERENCES inventory_match_sets(tenant,set_id),
 FOREIGN KEY(tenant,set_id,scope_id,record_key) REFERENCES inventory_match_rows(tenant,set_id,source_scope,record_key)
);
CREATE INDEX inventory_matching_selected_dependents_cursor ON inventory_matching_selected_dependents(tenant,generation_id,scope_id,facet,record_key,destination,source_scope,seen_clock,set_id);

-- A one-time current-only rebuild also schedules old proofs for revalidation.
INSERT INTO inventory_matching_selected_dependents(tenant,set_id,generation_id,destination,source_scope,scope_id,record_key,seen_clock)
 SELECT r.tenant,r.set_id,h.generation_id,h.destination,r.source_scope,q.source_scope,q.record_key,0
 FROM (SELECT tenant,set_id,source_scope FROM match_results GROUP BY tenant,set_id,source_scope) r
 JOIN inventory_match_sets h ON h.tenant=r.tenant AND h.set_id=r.set_id
 JOIN inventory_match_rows q ON q.tenant=r.tenant AND q.set_id=r.set_id;
CREATE VIEW inventory_matching_selected_signals AS
 SELECT i.tenant,i.generation_id,i.scope_id,i.facet,i.record_key,s.config_version FROM comparison_index i
 JOIN inventory_scopes s ON s.tenant=i.tenant AND s.scope_id=i.scope_id
 JOIN comparison_domains d ON d.tenant=i.tenant AND i.generation_id IN(d.active_generation,d.pending_generation)
 JOIN index_generations g ON g.tenant=i.tenant AND g.generation_id=i.generation_id AND g.state IN('active','building')
 WHERE i.facet='source' AND EXISTS(SELECT 1 FROM inventory_matching_selected_dependents dep INDEXED BY inventory_matching_selected_dependents_cursor WHERE dep.tenant=i.tenant AND dep.generation_id=i.generation_id AND dep.scope_id=i.scope_id AND dep.facet=i.facet AND dep.record_key=i.record_key);
INSERT INTO inventory_matching_selected_jobs(tenant,generation_id,scope_id,facet,record_key,config_version)
 SELECT DISTINCT dep.tenant,dep.generation_id,dep.scope_id,dep.facet,dep.record_key,s.config_version
 FROM inventory_matching_selected_dependents dep JOIN inventory_scopes s ON s.tenant=dep.tenant AND s.scope_id=dep.scope_id
 JOIN comparison_domains d ON d.tenant=dep.tenant AND dep.generation_id IN(d.active_generation,d.pending_generation)
 JOIN index_generations g ON g.tenant=dep.tenant AND g.generation_id=dep.generation_id AND g.state IN('active','building');

CREATE TRIGGER inventory_matching_selected_dependent_insert BEFORE INSERT ON inventory_matching_selected_dependents BEGIN
 SELECT CASE WHEN NEW.seen_clock!=coalesce((SELECT work_version FROM inventory_matching_selected_jobs j WHERE j.tenant=NEW.tenant AND j.generation_id=NEW.generation_id AND j.scope_id=NEW.scope_id AND j.facet=NEW.facet AND j.record_key=NEW.record_key),0)
 OR NOT EXISTS(SELECT 1 FROM inventory_match_live_sets l JOIN inventory_match_sets h ON h.tenant=l.tenant AND h.set_id=l.set_id AND h.state='prepared' AND h.destination=NEW.destination JOIN inventory_match_guards g ON g.tenant=h.tenant AND g.set_id=h.set_id WHERE l.tenant=NEW.tenant AND l.set_id=NEW.set_id AND l.generation_id=NEW.generation_id)
 OR NOT EXISTS(SELECT 1 FROM match_results r INDEXED BY match_result_set WHERE r.tenant=NEW.tenant AND r.set_id=NEW.set_id AND r.source_scope=NEW.source_scope)
 THEN RAISE(ABORT,'inventory matching selected dependent invalid') END;
END;
CREATE TRIGGER inventory_matching_selected_dependent_update BEFORE UPDATE ON inventory_matching_selected_dependents BEGIN SELECT RAISE(ABORT,'immutable inventory matching selected dependent'); END;
CREATE TRIGGER inventory_matching_selected_dependent_delete BEFORE DELETE ON inventory_matching_selected_dependents WHEN EXISTS(SELECT 1 FROM match_results r INDEXED BY match_result_set WHERE r.tenant=OLD.tenant AND r.set_id=OLD.set_id AND r.source_scope=OLD.source_scope) BEGIN SELECT RAISE(ABORT,'inventory matching selected dependent referenced'); END;
CREATE TRIGGER inventory_matching_selected_register_insert AFTER INSERT ON inventory_match_live_sets BEGIN
 INSERT INTO inventory_matching_selected_dependents(tenant,set_id,generation_id,destination,source_scope,scope_id,record_key,seen_clock)
 SELECT NEW.tenant,NEW.set_id,NEW.generation_id,h.destination,r.source_scope,q.source_scope,q.record_key,coalesce(j.work_version,0)
 FROM (SELECT source_scope FROM match_results INDEXED BY match_result_set WHERE tenant=NEW.tenant AND set_id=NEW.set_id GROUP BY source_scope) r
 CROSS JOIN inventory_match_sets h CROSS JOIN inventory_match_rows q
 LEFT JOIN inventory_matching_selected_jobs j ON j.tenant=q.tenant AND j.generation_id=NEW.generation_id AND j.scope_id=q.source_scope AND j.facet='source' AND j.record_key=q.record_key
 WHERE h.tenant=NEW.tenant AND h.set_id=NEW.set_id AND q.tenant=h.tenant AND q.set_id=h.set_id;
END;
CREATE TRIGGER inventory_matching_selected_register_route AFTER UPDATE OF ref_count ON inventory_match_live_sets WHEN NEW.ref_count>OLD.ref_count BEGIN
 INSERT INTO inventory_matching_selected_dependents(tenant,set_id,generation_id,destination,source_scope,scope_id,record_key,seen_clock)
 SELECT NEW.tenant,NEW.set_id,NEW.generation_id,h.destination,r.source_scope,q.source_scope,q.record_key,coalesce(j.work_version,0)
 FROM (SELECT r.source_scope FROM match_results r INDEXED BY match_result_set WHERE r.tenant=NEW.tenant AND r.set_id=NEW.set_id AND NOT EXISTS(SELECT 1 FROM inventory_matching_selected_dependents dep WHERE dep.tenant=r.tenant AND dep.set_id=r.set_id AND dep.source_scope=r.source_scope) GROUP BY r.source_scope) r
 CROSS JOIN inventory_match_sets h CROSS JOIN inventory_match_rows q
 LEFT JOIN inventory_matching_selected_jobs j ON j.tenant=q.tenant AND j.generation_id=NEW.generation_id AND j.scope_id=q.source_scope AND j.facet='source' AND j.record_key=q.record_key
 WHERE h.tenant=NEW.tenant AND h.set_id=NEW.set_id AND q.tenant=h.tenant AND q.set_id=h.set_id;
END;
CREATE TRIGGER inventory_matching_selected_collect_set AFTER DELETE ON inventory_match_live_sets BEGIN DELETE FROM inventory_matching_selected_dependents WHERE tenant=OLD.tenant AND set_id=OLD.set_id; END;
CREATE TRIGGER inventory_matching_selected_collect_update AFTER UPDATE OF set_id ON match_results WHEN NEW.set_id!=OLD.set_id BEGIN
 DELETE FROM inventory_matching_selected_dependents WHERE tenant=OLD.tenant AND set_id=OLD.set_id AND source_scope=OLD.source_scope AND NOT EXISTS(SELECT 1 FROM match_results r INDEXED BY match_result_set WHERE r.tenant=OLD.tenant AND r.set_id=OLD.set_id AND r.source_scope=OLD.source_scope);
END;
CREATE TRIGGER inventory_matching_selected_collect_delete AFTER DELETE ON match_results BEGIN
 DELETE FROM inventory_matching_selected_dependents WHERE tenant=OLD.tenant AND set_id=OLD.set_id AND source_scope=OLD.source_scope AND NOT EXISTS(SELECT 1 FROM match_results r INDEXED BY match_result_set WHERE r.tenant=OLD.tenant AND r.set_id=OLD.set_id AND r.source_scope=OLD.source_scope);
END;
CREATE TRIGGER inventory_matching_selected_complete BEFORE UPDATE ON inventory_match_sets WHEN NEW.state='committed' BEGIN
 SELECT CASE WHEN EXISTS(
 SELECT 1 FROM (SELECT source_scope FROM match_results INDEXED BY match_result_set WHERE tenant=NEW.tenant AND set_id=NEW.set_id GROUP BY source_scope) r
 CROSS JOIN inventory_match_rows q WHERE q.tenant=NEW.tenant AND q.set_id=NEW.set_id AND NOT EXISTS(
 SELECT 1 FROM inventory_matching_selected_dependents dep WHERE dep.tenant=q.tenant AND dep.set_id=q.set_id AND dep.source_scope=r.source_scope AND dep.scope_id=q.source_scope AND dep.facet='source' AND dep.record_key=q.record_key)) THEN RAISE(ABORT,'inventory matching selected dependencies incomplete') END;
END;
CREATE TRIGGER inventory_matching_selected_changed_insert AFTER INSERT ON comparison_index WHEN NEW.facet='source' BEGIN
 INSERT INTO inventory_matching_selected_jobs(tenant,generation_id,scope_id,facet,record_key,config_version) SELECT tenant,generation_id,scope_id,facet,record_key,config_version FROM inventory_matching_selected_signals WHERE tenant=NEW.tenant AND generation_id=NEW.generation_id AND scope_id=NEW.scope_id AND facet=NEW.facet AND record_key=NEW.record_key
 ON CONFLICT(tenant,generation_id,scope_id,facet,record_key) DO UPDATE SET config_version=excluded.config_version,work_version=inventory_matching_selected_jobs.work_version+1,signal_clock=inventory_matching_selected_jobs.signal_clock+1,cursor_destination='',cursor_source='',cursor_clock=0,cursor_set='';
END;
CREATE TRIGGER inventory_matching_selected_changed_update AFTER UPDATE ON comparison_index WHEN NEW.facet='source' AND (NEW.state,NEW.key_class,NEW.bucket_hash,NEW.semantic_version,NEW.config_version,NEW.parent_key,NEW.topology_version,NEW.projection_version) IS NOT (OLD.state,OLD.key_class,OLD.bucket_hash,OLD.semantic_version,OLD.config_version,OLD.parent_key,OLD.topology_version,OLD.projection_version) BEGIN
 INSERT INTO inventory_matching_selected_jobs(tenant,generation_id,scope_id,facet,record_key,config_version) SELECT tenant,generation_id,scope_id,facet,record_key,config_version FROM inventory_matching_selected_signals WHERE tenant=NEW.tenant AND generation_id=NEW.generation_id AND scope_id=NEW.scope_id AND facet=NEW.facet AND record_key=NEW.record_key
 ON CONFLICT(tenant,generation_id,scope_id,facet,record_key) DO UPDATE SET config_version=excluded.config_version,work_version=inventory_matching_selected_jobs.work_version+1,signal_clock=inventory_matching_selected_jobs.signal_clock+1,cursor_destination='',cursor_source='',cursor_clock=0,cursor_set='';
END;
CREATE TRIGGER inventory_matching_selected_job_insert BEFORE INSERT ON inventory_matching_selected_jobs BEGIN
 SELECT CASE WHEN NEW.work_version!=1 OR NEW.completed_version!=0 OR (NEW.cursor_destination,NEW.cursor_source,NEW.cursor_clock,NEW.cursor_set)!=('','',0,'') OR NOT EXISTS(
 SELECT 1 FROM inventory_scopes s JOIN comparison_domains d ON d.tenant=s.tenant JOIN index_generations g ON g.tenant=d.tenant AND g.generation_id IN(d.active_generation,d.pending_generation) AND g.state IN('active','building') WHERE s.tenant=NEW.tenant AND s.scope_id=NEW.scope_id AND s.provider='lofi' AND s.config_version=NEW.config_version AND g.generation_id=NEW.generation_id) THEN RAISE(ABORT,'inventory matching selected job invalid') END;
END;
CREATE TRIGGER inventory_matching_selected_job_clock BEFORE UPDATE ON inventory_matching_selected_jobs BEGIN
 SELECT CASE WHEN (NEW.tenant,NEW.generation_id,NEW.scope_id,NEW.facet,NEW.record_key) IS NOT (OLD.tenant,OLD.generation_id,OLD.scope_id,OLD.facet,OLD.record_key) OR NEW.work_version<OLD.work_version OR NEW.completed_version<OLD.completed_version THEN RAISE(ABORT,'inventory matching selected job regressed') END;
 SELECT CASE WHEN NEW.work_version!=OLD.work_version AND (NEW.work_version!=OLD.work_version+1 OR NEW.completed_version!=OLD.completed_version OR (NEW.cursor_destination,NEW.cursor_source,NEW.cursor_clock,NEW.cursor_set)!=('','',0,'') OR NOT EXISTS(SELECT 1 FROM inventory_scopes s WHERE s.tenant=NEW.tenant AND s.scope_id=NEW.scope_id AND s.config_version=NEW.config_version)) THEN RAISE(ABORT,'inventory matching selected clock changed progress') END;
 SELECT CASE WHEN NEW.work_version=OLD.work_version AND (NEW.config_version!=OLD.config_version OR (NEW.cursor_destination,NEW.cursor_source,NEW.cursor_clock,NEW.cursor_set)<(OLD.cursor_destination,OLD.cursor_source,OLD.cursor_clock,OLD.cursor_set)) THEN RAISE(ABORT,'inventory matching selected cursor regressed') END;
END;
CREATE TRIGGER inventory_matching_selected_job_progress BEFORE UPDATE ON inventory_matching_selected_jobs WHEN NEW.work_version=OLD.work_version AND (NEW.completed_version,NEW.cursor_destination,NEW.cursor_source,NEW.cursor_clock,NEW.cursor_set) IS NOT (OLD.completed_version,OLD.cursor_destination,OLD.cursor_source,OLD.cursor_clock,OLD.cursor_set) BEGIN SELECT RAISE(ABORT,'inventory matching selected job publisher required'); END;
CREATE TRIGGER inventory_matching_selected_job_delete BEFORE DELETE ON inventory_matching_selected_jobs WHEN EXISTS(SELECT 1 FROM index_generations g WHERE g.tenant=OLD.tenant AND g.generation_id=OLD.generation_id AND g.state IN('active','building')) BEGIN SELECT RAISE(ABORT,'retained inventory matching selected clock'); END;
