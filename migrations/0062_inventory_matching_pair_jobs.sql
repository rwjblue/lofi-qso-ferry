-- Scope-wide uncertainty/configuration changes enroll metadata jobs, not contact
-- rows. A separate bounded publisher expands each source/destination pair.
CREATE TABLE inventory_matching_pair_jobs (
 tenant TEXT NOT NULL, generation_id TEXT NOT NULL, destination TEXT NOT NULL, source_scope TEXT NOT NULL,
 source_config_version INTEGER NOT NULL, destination_config_version INTEGER NOT NULL, source_set_version INTEGER NOT NULL,
 work_version INTEGER NOT NULL DEFAULT 1 CHECK(work_version>0), completed_version INTEGER NOT NULL DEFAULT 0,
 cursor_key TEXT NOT NULL DEFAULT '', last_turn INTEGER NOT NULL DEFAULT 0 CHECK(last_turn>=0), PRIMARY KEY(tenant,generation_id,destination,source_scope),
 FOREIGN KEY(tenant,generation_id) REFERENCES index_generations(tenant,generation_id),
 FOREIGN KEY(tenant,destination) REFERENCES inventory_scopes(tenant,scope_id), FOREIGN KEY(tenant,source_scope) REFERENCES inventory_scopes(tenant,scope_id),
 CHECK(completed_version>=0 AND completed_version<=work_version)
);
CREATE INDEX inventory_matching_pair_turn ON inventory_matching_pair_jobs(tenant,last_turn);
CREATE INDEX inventory_matching_source_census ON comparison_index(tenant,generation_id,scope_id,config_version,record_key) WHERE facet='source' AND state!='retired';
CREATE TRIGGER inventory_matching_pair_job_insert BEFORE INSERT ON inventory_matching_pair_jobs BEGIN
 SELECT CASE WHEN NEW.work_version!=1 OR NEW.completed_version!=0 OR NEW.cursor_key!='' OR NEW.last_turn!=0 OR NOT EXISTS(SELECT 1 FROM inventory_matching_source_routes r JOIN comparison_domains d ON d.tenant=r.tenant WHERE r.tenant=NEW.tenant AND r.generation_id=NEW.generation_id AND r.destination=NEW.destination AND r.source_scope=NEW.source_scope AND r.source_config_version=NEW.source_config_version AND r.destination_config_version=NEW.destination_config_version AND d.source_set_version=NEW.source_set_version) THEN RAISE(ABORT,'inventory matching pair route changed') END;
END;
CREATE TRIGGER inventory_matching_pair_job_monotonic BEFORE UPDATE ON inventory_matching_pair_jobs BEGIN
 SELECT CASE WHEN (NEW.tenant,NEW.generation_id,NEW.destination,NEW.source_scope) IS NOT (OLD.tenant,OLD.generation_id,OLD.destination,OLD.source_scope) OR NEW.work_version<OLD.work_version OR NEW.completed_version<OLD.completed_version OR NEW.last_turn<OLD.last_turn THEN RAISE(ABORT,'inventory matching pair regressed') END;
 SELECT CASE WHEN NEW.work_version!=OLD.work_version AND (NEW.work_version!=OLD.work_version+1 OR NEW.completed_version!=OLD.completed_version OR NEW.cursor_key!='' OR NEW.last_turn!=OLD.last_turn OR NOT EXISTS(SELECT 1 FROM inventory_matching_source_routes r JOIN comparison_domains d ON d.tenant=r.tenant WHERE r.tenant=NEW.tenant AND r.generation_id=NEW.generation_id AND r.destination=NEW.destination AND r.source_scope=NEW.source_scope AND r.source_config_version=NEW.source_config_version AND r.destination_config_version=NEW.destination_config_version AND d.source_set_version=NEW.source_set_version)) THEN RAISE(ABORT,'inventory matching pair signal changed progress') END;
 SELECT CASE WHEN NEW.work_version=OLD.work_version AND ((NEW.source_config_version,NEW.destination_config_version,NEW.source_set_version) IS NOT (OLD.source_config_version,OLD.destination_config_version,OLD.source_set_version) OR NEW.cursor_key<OLD.cursor_key) THEN RAISE(ABORT,'inventory matching pair binding changed') END;
END;
CREATE TRIGGER inventory_matching_pair_job_delete BEFORE DELETE ON inventory_matching_pair_jobs WHEN EXISTS(SELECT 1 FROM index_generations g WHERE g.tenant=OLD.tenant AND g.generation_id=OLD.generation_id AND g.state IN('active','building')) BEGIN SELECT RAISE(ABORT,'retained inventory matching pair clock'); END;
CREATE TRIGGER inventory_matching_pair_job_progress BEFORE UPDATE ON inventory_matching_pair_jobs WHEN NEW.work_version=OLD.work_version AND (NEW.completed_version!=OLD.completed_version OR NEW.cursor_key!=OLD.cursor_key OR NEW.last_turn!=OLD.last_turn) BEGIN SELECT RAISE(ABORT,'inventory matching pair page required'); END;
CREATE TRIGGER inventory_matching_pair_wake_insert AFTER INSERT ON inventory_matching_pair_jobs BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
CREATE TRIGGER inventory_matching_pair_wake_update AFTER UPDATE OF work_version ON inventory_matching_pair_jobs WHEN NEW.work_version!=OLD.work_version BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
CREATE TRIGGER inventory_matching_pair_domain AFTER UPDATE ON comparison_domains WHEN NEW.source_set_version!=OLD.source_set_version OR NEW.active_generation IS NOT OLD.active_generation OR NEW.pending_generation IS NOT OLD.pending_generation BEGIN
 INSERT INTO inventory_matching_pair_jobs(tenant,generation_id,destination,source_scope,source_config_version,destination_config_version,source_set_version)
 SELECT r.tenant,r.generation_id,r.destination,r.source_scope,r.source_config_version,r.destination_config_version,d.source_set_version FROM inventory_matching_source_routes r JOIN comparison_domains d ON d.tenant=r.tenant WHERE r.tenant=NEW.tenant AND (NEW.source_set_version!=OLD.source_set_version OR (r.generation_id IS NOT OLD.active_generation AND r.generation_id IS NOT OLD.pending_generation))
 ON CONFLICT(tenant,generation_id,destination,source_scope) DO UPDATE SET source_config_version=excluded.source_config_version,destination_config_version=excluded.destination_config_version,source_set_version=excluded.source_set_version,work_version=inventory_matching_pair_jobs.work_version+1,cursor_key='';
END;
CREATE TRIGGER inventory_matching_pair_destination AFTER INSERT ON inventory_scopes WHEN NEW.provider IN('qrz','lotw') BEGIN
 INSERT INTO inventory_matching_pair_jobs(tenant,generation_id,destination,source_scope,source_config_version,destination_config_version,source_set_version)
 SELECT r.tenant,r.generation_id,r.destination,r.source_scope,r.source_config_version,r.destination_config_version,d.source_set_version FROM inventory_matching_source_routes r JOIN comparison_domains d ON d.tenant=r.tenant WHERE r.tenant=NEW.tenant AND r.destination=NEW.scope_id
 ON CONFLICT(tenant,generation_id,destination,source_scope) DO UPDATE SET source_config_version=excluded.source_config_version,destination_config_version=excluded.destination_config_version,source_set_version=excluded.source_set_version,work_version=inventory_matching_pair_jobs.work_version+1,cursor_key='';
END;
CREATE TRIGGER inventory_matching_pair_destination_update AFTER UPDATE ON inventory_scopes WHEN (NEW.provider IN('qrz','lotw') OR OLD.provider IN('qrz','lotw')) AND (NEW.config_version!=OLD.config_version OR NEW.state!=OLD.state OR NEW.provider!=OLD.provider) BEGIN
 INSERT INTO inventory_matching_pair_jobs(tenant,generation_id,destination,source_scope,source_config_version,destination_config_version,source_set_version)
 SELECT r.tenant,r.generation_id,r.destination,r.source_scope,r.source_config_version,r.destination_config_version,d.source_set_version FROM inventory_matching_source_routes r JOIN comparison_domains d ON d.tenant=r.tenant WHERE r.tenant=NEW.tenant AND r.destination=NEW.scope_id
 ON CONFLICT(tenant,generation_id,destination,source_scope) DO UPDATE SET source_config_version=excluded.source_config_version,destination_config_version=excluded.destination_config_version,source_set_version=excluded.source_set_version,work_version=inventory_matching_pair_jobs.work_version+1,cursor_key='';
END;
-- The original source-set trigger covers NEW.provider='lofi'. Also cover a
-- former source changing provider without relying on a connection update.
CREATE TRIGGER inventory_matching_pair_source_reclassified AFTER UPDATE OF provider ON inventory_scopes WHEN OLD.provider='lofi' AND NEW.provider!='lofi' BEGIN
 UPDATE comparison_domains SET version=version+1,source_set_version=source_set_version+1 WHERE tenant=NEW.tenant;
END;
CREATE TRIGGER inventory_matching_pair_connection AFTER UPDATE ON connections WHEN NEW.kind IN('qrz','lotw') AND (NEW.kind!=OLD.kind OR NEW.status!=OLD.status OR NEW.remote_identity!=OLD.remote_identity) BEGIN
 INSERT INTO inventory_matching_pair_jobs(tenant,generation_id,destination,source_scope,source_config_version,destination_config_version,source_set_version)
 SELECT r.tenant,r.generation_id,r.destination,r.source_scope,r.source_config_version,r.destination_config_version,d.source_set_version FROM inventory_matching_source_routes r JOIN comparison_domains d ON d.tenant=r.tenant WHERE r.tenant=NEW.tenant AND r.destination IN(SELECT scope_id FROM inventory_scopes WHERE tenant=NEW.tenant AND connection_id=NEW.id)
 ON CONFLICT(tenant,generation_id,destination,source_scope) DO UPDATE SET source_config_version=excluded.source_config_version,destination_config_version=excluded.destination_config_version,source_set_version=excluded.source_set_version,work_version=inventory_matching_pair_jobs.work_version+1,cursor_key='';
END;
CREATE TRIGGER inventory_matching_pair_account AFTER UPDATE OF status ON accounts WHEN NEW.status='active' AND OLD.status!='active' BEGIN
 INSERT INTO inventory_matching_pair_jobs(tenant,generation_id,destination,source_scope,source_config_version,destination_config_version,source_set_version)
 SELECT r.tenant,r.generation_id,r.destination,r.source_scope,r.source_config_version,r.destination_config_version,d.source_set_version FROM inventory_matching_source_routes r JOIN comparison_domains d ON d.tenant=r.tenant WHERE r.tenant=NEW.id
 ON CONFLICT(tenant,generation_id,destination,source_scope) DO UPDATE SET source_config_version=excluded.source_config_version,destination_config_version=excluded.destination_config_version,source_set_version=excluded.source_set_version,work_version=inventory_matching_pair_jobs.work_version+1,cursor_key='';
END;
CREATE TRIGGER inventory_matching_pair_uncertainty_insert AFTER INSERT ON inventory_partition_membership WHEN NEW.facet IN('source','receipt') AND NEW.state='unresolved' AND (SELECT count(*) FROM (SELECT 1 FROM inventory_partition_membership m INDEXED BY inventory_unresolved_members WHERE m.tenant=NEW.tenant AND m.scope_id=NEW.scope_id AND m.facet=NEW.facet AND m.state='unresolved' LIMIT 2))=1 BEGIN
 INSERT INTO inventory_matching_pair_jobs(tenant,generation_id,destination,source_scope,source_config_version,destination_config_version,source_set_version)
 SELECT r.tenant,r.generation_id,r.destination,r.source_scope,r.source_config_version,r.destination_config_version,d.source_set_version FROM inventory_matching_source_routes r JOIN comparison_domains d ON d.tenant=r.tenant WHERE r.tenant=NEW.tenant AND (NEW.facet='source' OR r.destination=NEW.scope_id)
 ON CONFLICT(tenant,generation_id,destination,source_scope) DO UPDATE SET source_config_version=excluded.source_config_version,destination_config_version=excluded.destination_config_version,source_set_version=excluded.source_set_version,work_version=inventory_matching_pair_jobs.work_version+1,cursor_key='';
END;
CREATE TRIGGER inventory_matching_pair_uncertainty_update AFTER UPDATE OF state ON inventory_partition_membership WHEN NEW.facet IN('source','receipt') AND NEW.state!=OLD.state AND ((NEW.state='unresolved' AND (SELECT count(*) FROM (SELECT 1 FROM inventory_partition_membership m INDEXED BY inventory_unresolved_members WHERE m.tenant=NEW.tenant AND m.scope_id=NEW.scope_id AND m.facet=NEW.facet AND m.state='unresolved' LIMIT 2))=1) OR (OLD.state='unresolved' AND NOT EXISTS(SELECT 1 FROM inventory_partition_membership m INDEXED BY inventory_unresolved_members WHERE m.tenant=NEW.tenant AND m.scope_id=NEW.scope_id AND m.facet=NEW.facet AND m.state='unresolved'))) BEGIN
 INSERT INTO inventory_matching_pair_jobs(tenant,generation_id,destination,source_scope,source_config_version,destination_config_version,source_set_version)
 SELECT r.tenant,r.generation_id,r.destination,r.source_scope,r.source_config_version,r.destination_config_version,d.source_set_version FROM inventory_matching_source_routes r JOIN comparison_domains d ON d.tenant=r.tenant WHERE r.tenant=NEW.tenant AND (NEW.facet='source' OR r.destination=NEW.scope_id)
 ON CONFLICT(tenant,generation_id,destination,source_scope) DO UPDATE SET source_config_version=excluded.source_config_version,destination_config_version=excluded.destination_config_version,source_set_version=excluded.source_set_version,work_version=inventory_matching_pair_jobs.work_version+1,cursor_key='';
END;
-- Enroll existing routes in metadata only; no source/contact census here.
INSERT INTO inventory_matching_pair_jobs(tenant,generation_id,destination,source_scope,source_config_version,destination_config_version,source_set_version)
 SELECT r.tenant,r.generation_id,r.destination,r.source_scope,r.source_config_version,r.destination_config_version,d.source_set_version FROM inventory_matching_source_routes r JOIN comparison_domains d ON d.tenant=r.tenant WHERE 1=1
 ON CONFLICT(tenant,generation_id,destination,source_scope) DO UPDATE SET source_config_version=excluded.source_config_version,destination_config_version=excluded.destination_config_version,source_set_version=excluded.source_set_version,work_version=inventory_matching_pair_jobs.work_version+1,cursor_key='';
