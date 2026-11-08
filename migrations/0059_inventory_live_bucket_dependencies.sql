-- Only currently referenced cohorts belong in the reverse scheduling index.
-- Immutable comparison proofs remain in the original retained dependency tables.
CREATE TABLE inventory_match_live_sets (
 tenant TEXT NOT NULL, set_id TEXT NOT NULL CHECK(length(set_id) BETWEEN 1 AND 512), generation_id TEXT NOT NULL, ref_count INTEGER NOT NULL CHECK(ref_count BETWEEN 1 AND 20),
 PRIMARY KEY(tenant,set_id), FOREIGN KEY(tenant,set_id) REFERENCES inventory_match_sets(tenant,set_id), FOREIGN KEY(tenant,generation_id) REFERENCES index_generations(tenant,generation_id)
);
CREATE TABLE inventory_matching_bucket_jobs (
 tenant TEXT NOT NULL, generation_id TEXT NOT NULL, scope_id TEXT NOT NULL, key_class TEXT NOT NULL CHECK(key_class IN('call_and_time','call_only','time_only','unknown')), bucket_hash TEXT NOT NULL CHECK(length(bucket_hash)=43),
 config_version INTEGER NOT NULL, work_version INTEGER NOT NULL DEFAULT 1 CHECK(work_version>0), completed_version INTEGER NOT NULL DEFAULT 0,
 cursor_version INTEGER NOT NULL DEFAULT 0 CHECK(cursor_version>=0), cursor_set TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(tenant,generation_id,scope_id,key_class,bucket_hash), FOREIGN KEY(tenant,generation_id,scope_id) REFERENCES comparison_builds(tenant,generation_id,scope_id),
 CHECK(completed_version>=0 AND completed_version<=work_version)
);
CREATE INDEX inventory_matching_bucket_pending ON inventory_matching_bucket_jobs(tenant,generation_id,scope_id,config_version,key_class,bucket_hash) WHERE completed_version<work_version;
CREATE TABLE inventory_matching_bucket_dependents (
 tenant TEXT NOT NULL, set_id TEXT NOT NULL, generation_id TEXT NOT NULL, scope_id TEXT NOT NULL, key_class TEXT NOT NULL CHECK(key_class IN('call_and_time','call_only','time_only','unknown')), bucket_hash TEXT NOT NULL CHECK(length(bucket_hash)=43), seen_version INTEGER NOT NULL CHECK(seen_version>=0), probe_id INTEGER NOT NULL,
 PRIMARY KEY(tenant,set_id,scope_id,key_class,bucket_hash), FOREIGN KEY(tenant,set_id) REFERENCES inventory_match_live_sets(tenant,set_id), FOREIGN KEY(tenant,scope_id) REFERENCES inventory_scopes(tenant,scope_id),
 FOREIGN KEY(tenant,set_id,probe_id,key_class,bucket_hash) REFERENCES inventory_match_tokens(tenant,set_id,probe_id,key_class,bucket_hash)
);
CREATE INDEX inventory_matching_bucket_dependents_cursor ON inventory_matching_bucket_dependents(tenant,generation_id,scope_id,key_class,bucket_hash,seen_version,set_id);
CREATE TRIGGER inventory_match_live_insert BEFORE INSERT ON inventory_match_live_sets BEGIN
 SELECT CASE WHEN NEW.ref_count!=1 OR NOT EXISTS(SELECT 1 FROM inventory_match_sets h JOIN inventory_match_guards g ON g.tenant=h.tenant AND g.set_id=h.set_id WHERE h.tenant=NEW.tenant AND h.set_id=NEW.set_id AND h.generation_id=NEW.generation_id AND h.state='prepared') OR (SELECT count(*) FROM match_results r INDEXED BY match_result_set WHERE r.tenant=NEW.tenant AND r.set_id=NEW.set_id)!=1 THEN RAISE(ABORT,'inventory matching live set invalid') END;
END;
CREATE TRIGGER inventory_match_live_update BEFORE UPDATE ON inventory_match_live_sets BEGIN
 SELECT CASE WHEN (NEW.tenant,NEW.set_id,NEW.generation_id) IS NOT (OLD.tenant,OLD.set_id,OLD.generation_id) OR abs(NEW.ref_count-OLD.ref_count)!=1 OR NEW.ref_count!=(SELECT count(*) FROM match_results r INDEXED BY match_result_set WHERE r.tenant=NEW.tenant AND r.set_id=NEW.set_id) THEN RAISE(ABORT,'inventory matching live references changed') END;
END;
CREATE TRIGGER inventory_match_live_delete BEFORE DELETE ON inventory_match_live_sets WHEN EXISTS(SELECT 1 FROM match_results r INDEXED BY match_result_set WHERE r.tenant=OLD.tenant AND r.set_id=OLD.set_id) BEGIN SELECT RAISE(ABORT,'inventory matching live set referenced'); END;
CREATE TRIGGER inventory_matching_dependent_insert BEFORE INSERT ON inventory_matching_bucket_dependents BEGIN
 SELECT CASE WHEN NEW.seen_version!=coalesce((SELECT work_version FROM inventory_matching_bucket_jobs j WHERE j.tenant=NEW.tenant AND j.generation_id=NEW.generation_id AND j.scope_id=NEW.scope_id AND j.key_class=NEW.key_class AND j.bucket_hash=NEW.bucket_hash),0) OR NOT EXISTS(SELECT 1 FROM inventory_match_live_sets l JOIN inventory_match_sets h ON h.tenant=l.tenant AND h.set_id=l.set_id AND h.state='prepared' JOIN inventory_match_guards g ON g.tenant=h.tenant AND g.set_id=h.set_id WHERE l.tenant=NEW.tenant AND l.set_id=NEW.set_id AND l.generation_id=NEW.generation_id) OR NOT EXISTS(SELECT 1 FROM inventory_match_probes p WHERE p.tenant=NEW.tenant AND p.set_id=NEW.set_id AND p.probe_id=NEW.probe_id AND p.search_scope=NEW.scope_id) THEN RAISE(ABORT,'inventory matching dependent invalid') END;
END;
CREATE TRIGGER inventory_matching_dependent_update BEFORE UPDATE ON inventory_matching_bucket_dependents BEGIN SELECT RAISE(ABORT,'immutable inventory matching dependent'); END;
CREATE TRIGGER inventory_matching_dependent_delete BEFORE DELETE ON inventory_matching_bucket_dependents WHEN EXISTS(SELECT 1 FROM match_results r INDEXED BY match_result_set WHERE r.tenant=OLD.tenant AND r.set_id=OLD.set_id) BEGIN SELECT RAISE(ABORT,'inventory matching dependent referenced'); END;
CREATE TRIGGER inventory_match_live_register AFTER INSERT ON inventory_match_live_sets BEGIN
 INSERT INTO inventory_matching_bucket_dependents(tenant,set_id,generation_id,scope_id,key_class,bucket_hash,seen_version,probe_id)
 SELECT NEW.tenant,NEW.set_id,NEW.generation_id,p.search_scope,t.key_class,t.bucket_hash,coalesce(j.work_version,0),min(t.probe_id) FROM inventory_match_tokens t JOIN inventory_match_probes p ON p.tenant=t.tenant AND p.set_id=t.set_id AND p.probe_id=t.probe_id LEFT JOIN inventory_matching_bucket_jobs j ON j.tenant=t.tenant AND j.generation_id=NEW.generation_id AND j.scope_id=p.search_scope AND j.key_class=t.key_class AND j.bucket_hash=t.bucket_hash WHERE t.tenant=NEW.tenant AND t.set_id=NEW.set_id GROUP BY p.search_scope,t.key_class,t.bucket_hash,coalesce(j.work_version,0);
END;
CREATE TRIGGER inventory_match_live_collect AFTER DELETE ON inventory_match_live_sets BEGIN DELETE FROM inventory_matching_bucket_dependents WHERE tenant=OLD.tenant AND set_id=OLD.set_id; END;
CREATE TRIGGER inventory_match_result_live_insert AFTER INSERT ON match_results BEGIN
 UPDATE inventory_match_live_sets SET ref_count=ref_count+1 WHERE tenant=NEW.tenant AND set_id=NEW.set_id;
 INSERT INTO inventory_match_live_sets(tenant,set_id,generation_id,ref_count) SELECT NEW.tenant,NEW.set_id,h.generation_id,1 FROM inventory_match_sets h WHERE h.tenant=NEW.tenant AND h.set_id=NEW.set_id AND NOT EXISTS(SELECT 1 FROM inventory_match_live_sets l WHERE l.tenant=NEW.tenant AND l.set_id=NEW.set_id);
END;
CREATE TRIGGER inventory_match_result_live_update AFTER UPDATE OF set_id ON match_results WHEN NEW.set_id!=OLD.set_id BEGIN
 DELETE FROM inventory_match_live_sets WHERE tenant=OLD.tenant AND set_id=OLD.set_id AND ref_count=1;
 UPDATE inventory_match_live_sets SET ref_count=ref_count-1 WHERE tenant=OLD.tenant AND set_id=OLD.set_id AND ref_count>1;
 UPDATE inventory_match_live_sets SET ref_count=ref_count+1 WHERE tenant=NEW.tenant AND set_id=NEW.set_id;
 INSERT INTO inventory_match_live_sets(tenant,set_id,generation_id,ref_count) SELECT NEW.tenant,NEW.set_id,h.generation_id,1 FROM inventory_match_sets h WHERE h.tenant=NEW.tenant AND h.set_id=NEW.set_id AND NOT EXISTS(SELECT 1 FROM inventory_match_live_sets l WHERE l.tenant=NEW.tenant AND l.set_id=NEW.set_id);
END;
CREATE TRIGGER inventory_match_result_live_delete AFTER DELETE ON match_results BEGIN
 DELETE FROM inventory_match_live_sets WHERE tenant=OLD.tenant AND set_id=OLD.set_id AND ref_count=1;
 UPDATE inventory_match_live_sets SET ref_count=ref_count-1 WHERE tenant=OLD.tenant AND set_id=OLD.set_id AND ref_count>1;
END;
CREATE TRIGGER inventory_matching_dependencies_complete BEFORE UPDATE ON inventory_match_sets WHEN NEW.state='committed' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_match_live_sets l WHERE l.tenant=NEW.tenant AND l.set_id=NEW.set_id AND l.generation_id=NEW.generation_id AND l.ref_count=NEW.row_count) THEN RAISE(ABORT,'inventory matching live references incomplete') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_match_tokens t JOIN inventory_match_probes p ON p.tenant=t.tenant AND p.set_id=t.set_id AND p.probe_id=t.probe_id WHERE t.tenant=NEW.tenant AND t.set_id=NEW.set_id AND NOT EXISTS(SELECT 1 FROM inventory_matching_bucket_dependents d WHERE d.tenant=t.tenant AND d.set_id=t.set_id AND d.scope_id=p.search_scope AND d.key_class=t.key_class AND d.bucket_hash=t.bucket_hash)) THEN RAISE(ABORT,'inventory matching bucket dependencies incomplete') END;
END;

-- Signal only buckets with current dependents. A fresh baseline must not create
-- one empty continuation for every new hash before any result has used it.
CREATE VIEW inventory_matching_bucket_signals AS
 SELECT b.tenant,b.generation_id,b.scope_id,s.config_version,b.key_class,b.bucket_hash FROM bucket_versions b JOIN inventory_scopes s ON s.tenant=b.tenant AND s.scope_id=b.scope_id JOIN comparison_domains d ON d.tenant=b.tenant AND b.generation_id IN(d.active_generation,d.pending_generation) JOIN index_generations g ON g.tenant=b.tenant AND g.generation_id=b.generation_id AND g.state IN('active','building')
 WHERE EXISTS(SELECT 1 FROM inventory_matching_bucket_dependents dep INDEXED BY inventory_matching_bucket_dependents_cursor WHERE dep.tenant=b.tenant AND dep.generation_id=b.generation_id AND dep.scope_id=b.scope_id AND dep.key_class=b.key_class AND dep.bucket_hash=b.bucket_hash);
CREATE TRIGGER inventory_matching_bucket_changed_insert AFTER INSERT ON bucket_versions BEGIN
 INSERT INTO inventory_matching_bucket_jobs(tenant,generation_id,scope_id,key_class,bucket_hash,config_version) SELECT tenant,generation_id,scope_id,key_class,bucket_hash,config_version FROM inventory_matching_bucket_signals WHERE tenant=NEW.tenant AND generation_id=NEW.generation_id AND scope_id=NEW.scope_id AND key_class=NEW.key_class AND bucket_hash=NEW.bucket_hash
 ON CONFLICT(tenant,generation_id,scope_id,key_class,bucket_hash) DO UPDATE SET config_version=excluded.config_version,work_version=inventory_matching_bucket_jobs.work_version+1,cursor_version=0,cursor_set='';
END;
CREATE TRIGGER inventory_matching_bucket_changed_update AFTER UPDATE OF version ON bucket_versions WHEN NEW.version!=OLD.version BEGIN
 INSERT INTO inventory_matching_bucket_jobs(tenant,generation_id,scope_id,key_class,bucket_hash,config_version) SELECT tenant,generation_id,scope_id,key_class,bucket_hash,config_version FROM inventory_matching_bucket_signals WHERE tenant=NEW.tenant AND generation_id=NEW.generation_id AND scope_id=NEW.scope_id AND key_class=NEW.key_class AND bucket_hash=NEW.bucket_hash
 ON CONFLICT(tenant,generation_id,scope_id,key_class,bucket_hash) DO UPDATE SET config_version=excluded.config_version,work_version=inventory_matching_bucket_jobs.work_version+1,cursor_version=0,cursor_set='';
END;
CREATE TRIGGER inventory_matching_projection_changed AFTER UPDATE OF projection_version ON comparison_index WHEN NEW.projection_version!=OLD.projection_version AND NEW.key_class IS NOT NULL BEGIN
 INSERT INTO inventory_matching_bucket_jobs(tenant,generation_id,scope_id,key_class,bucket_hash,config_version) SELECT tenant,generation_id,scope_id,key_class,bucket_hash,config_version FROM inventory_matching_bucket_signals WHERE tenant=NEW.tenant AND generation_id=NEW.generation_id AND scope_id=NEW.scope_id AND key_class=NEW.key_class AND bucket_hash=NEW.bucket_hash
 ON CONFLICT(tenant,generation_id,scope_id,key_class,bucket_hash) DO UPDATE SET config_version=excluded.config_version,work_version=inventory_matching_bucket_jobs.work_version+1,cursor_version=0,cursor_set='';
END;
CREATE TRIGGER inventory_matching_source_retired AFTER UPDATE OF state ON comparison_index WHEN NEW.facet='source' AND NEW.state='retired' AND OLD.state!='retired' BEGIN
 INSERT INTO matching_work(tenant,generation_id,destination,source_scope,record_key,source_config_version,destination_config_version) SELECT r.tenant,r.generation_id,r.destination,r.source_scope,NEW.record_key,r.source_config_version,r.destination_config_version FROM inventory_matching_source_routes r WHERE r.tenant=NEW.tenant AND r.generation_id=NEW.generation_id AND r.source_scope=NEW.scope_id
 ON CONFLICT(tenant,generation_id,destination,source_scope,record_key) DO UPDATE SET source_config_version=excluded.source_config_version,destination_config_version=excluded.destination_config_version,work_version=matching_work.work_version+1,due_at=0,hold_reason=NULL;
END;
CREATE TRIGGER inventory_matching_bucket_job_insert BEFORE INSERT ON inventory_matching_bucket_jobs BEGIN
 SELECT CASE WHEN NEW.work_version!=1 OR NEW.completed_version!=0 OR NEW.cursor_version!=0 OR NEW.cursor_set!='' OR NOT EXISTS(SELECT 1 FROM inventory_scopes s JOIN comparison_domains d ON d.tenant=s.tenant JOIN index_generations g ON g.tenant=d.tenant AND g.generation_id IN(d.active_generation,d.pending_generation) AND g.state IN('active','building') WHERE s.tenant=NEW.tenant AND s.scope_id=NEW.scope_id AND s.config_version=NEW.config_version AND g.generation_id=NEW.generation_id) THEN RAISE(ABORT,'inventory matching bucket job invalid') END;
END;
CREATE TRIGGER inventory_matching_bucket_job_clock BEFORE UPDATE ON inventory_matching_bucket_jobs BEGIN
 SELECT CASE WHEN (NEW.tenant,NEW.generation_id,NEW.scope_id,NEW.key_class,NEW.bucket_hash) IS NOT (OLD.tenant,OLD.generation_id,OLD.scope_id,OLD.key_class,OLD.bucket_hash) OR NEW.work_version<OLD.work_version OR NEW.completed_version<OLD.completed_version THEN RAISE(ABORT,'inventory matching bucket job regressed') END;
 SELECT CASE WHEN NEW.work_version!=OLD.work_version AND (NEW.work_version!=OLD.work_version+1 OR NEW.completed_version!=OLD.completed_version OR NEW.cursor_version!=0 OR NEW.cursor_set!='' OR NOT EXISTS(SELECT 1 FROM inventory_scopes s WHERE s.tenant=NEW.tenant AND s.scope_id=NEW.scope_id AND s.config_version=NEW.config_version)) THEN RAISE(ABORT,'inventory matching bucket clock changed progress') END;
 SELECT CASE WHEN NEW.work_version=OLD.work_version AND (NEW.config_version!=OLD.config_version OR (NEW.cursor_version,NEW.cursor_set)<(OLD.cursor_version,OLD.cursor_set)) THEN RAISE(ABORT,'inventory matching bucket cursor regressed') END;
END;
CREATE TRIGGER inventory_matching_bucket_job_delete BEFORE DELETE ON inventory_matching_bucket_jobs WHEN EXISTS(SELECT 1 FROM index_generations g WHERE g.tenant=OLD.tenant AND g.generation_id=OLD.generation_id AND g.state IN('active','building')) BEGIN SELECT RAISE(ABORT,'retained inventory matching bucket clock'); END;
