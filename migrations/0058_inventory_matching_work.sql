-- Derived work has its own monotonic clock. Result publication completes only
-- the captured version, in the same native transaction as its dependencies.
CREATE TABLE matching_work (
 tenant TEXT NOT NULL, generation_id TEXT NOT NULL, destination TEXT NOT NULL, source_scope TEXT NOT NULL, record_key TEXT NOT NULL,
 source_config_version INTEGER NOT NULL, destination_config_version INTEGER NOT NULL,
 work_version INTEGER NOT NULL DEFAULT 1 CHECK(work_version>0), completed_version INTEGER NOT NULL DEFAULT 0,
 due_at INTEGER NOT NULL DEFAULT 0 CHECK(due_at>=0), hold_reason TEXT CHECK(hold_reason IS NULL OR hold_reason='capacity'), last_completed_set TEXT,
 PRIMARY KEY(tenant,generation_id,destination,source_scope,record_key),
 FOREIGN KEY(tenant,generation_id) REFERENCES index_generations(tenant,generation_id),
 FOREIGN KEY(tenant,destination) REFERENCES inventory_scopes(tenant,scope_id), FOREIGN KEY(tenant,source_scope) REFERENCES inventory_scopes(tenant,scope_id),
 FOREIGN KEY(tenant,last_completed_set,source_scope,record_key) REFERENCES inventory_match_rows(tenant,set_id,source_scope,record_key),
 CHECK(completed_version>=0 AND completed_version<=work_version), CHECK((completed_version=0)=(last_completed_set IS NULL))
);
CREATE INDEX matching_work_scope_pending ON matching_work(tenant,generation_id,destination,source_scope,source_config_version,destination_config_version,due_at,record_key) WHERE completed_version<work_version;
CREATE VIEW inventory_matching_source_routes AS
 SELECT s.tenant,g.generation_id,t.scope_id AS destination,s.scope_id AS source_scope,s.config_version AS source_config_version,t.config_version AS destination_config_version
 FROM comparison_domains d JOIN accounts a ON a.id=d.tenant AND a.status='active'
 CROSS JOIN index_generations g CROSS JOIN inventory_scopes s CROSS JOIN inventory_scopes t
 JOIN connections sc ON sc.tenant=s.tenant AND sc.id=s.connection_id AND sc.status='active' AND sc.kind='lofi' AND sc.remote_identity=s.logical_identity
 JOIN connections tc ON tc.tenant=t.tenant AND tc.id=t.connection_id AND tc.status='active' AND tc.kind=t.provider AND tc.remote_identity=t.logical_identity
 WHERE g.tenant=d.tenant AND g.generation_id IN(d.active_generation,d.pending_generation) AND g.state IN('active','building')
 AND s.tenant=d.tenant AND s.provider='lofi' AND s.state='observing' AND t.tenant=d.tenant AND t.provider IN('qrz','lotw') AND t.state='observing';
CREATE TRIGGER matching_work_insert BEFORE INSERT ON matching_work BEGIN
 SELECT CASE WHEN NEW.work_version!=1 OR NEW.completed_version!=0 OR NEW.last_completed_set IS NOT NULL OR NEW.hold_reason IS NOT NULL OR NEW.due_at!=0 OR NOT EXISTS(SELECT 1 FROM inventory_matching_source_routes r WHERE r.tenant=NEW.tenant AND r.generation_id=NEW.generation_id AND r.destination=NEW.destination AND r.source_scope=NEW.source_scope AND r.source_config_version=NEW.source_config_version AND r.destination_config_version=NEW.destination_config_version) THEN RAISE(ABORT,'inventory matching work route changed') END;
END;
CREATE TRIGGER matching_work_monotonic BEFORE UPDATE ON matching_work BEGIN
 SELECT CASE WHEN (NEW.tenant,NEW.generation_id,NEW.destination,NEW.source_scope,NEW.record_key) IS NOT (OLD.tenant,OLD.generation_id,OLD.destination,OLD.source_scope,OLD.record_key) OR NEW.work_version<OLD.work_version OR NEW.completed_version<OLD.completed_version THEN RAISE(ABORT,'inventory matching work regressed') END;
 SELECT CASE WHEN NEW.work_version!=OLD.work_version AND (NEW.work_version!=OLD.work_version+1 OR NEW.completed_version!=OLD.completed_version OR NEW.last_completed_set IS NOT OLD.last_completed_set OR NEW.due_at!=0 OR NEW.hold_reason IS NOT NULL OR NOT EXISTS(SELECT 1 FROM inventory_matching_source_routes r WHERE r.tenant=NEW.tenant AND r.generation_id=NEW.generation_id AND r.destination=NEW.destination AND r.source_scope=NEW.source_scope AND r.source_config_version=NEW.source_config_version AND r.destination_config_version=NEW.destination_config_version)) THEN RAISE(ABORT,'inventory matching invalidation changed completion') END;
 SELECT CASE WHEN NEW.work_version=OLD.work_version AND (NEW.source_config_version!=OLD.source_config_version OR NEW.destination_config_version!=OLD.destination_config_version OR (NEW.completed_version=OLD.completed_version AND NEW.last_completed_set IS NOT OLD.last_completed_set)) THEN RAISE(ABORT,'inventory matching work binding changed') END;
 SELECT CASE WHEN NEW.work_version=OLD.work_version AND NEW.completed_version=OLD.completed_version AND (NEW.due_at!=OLD.due_at OR NEW.hold_reason IS NOT OLD.hold_reason) AND NOT EXISTS(SELECT 1 FROM leases l JOIN accounts a ON a.id=l.tenant AND a.status='active' WHERE l.tenant=OLD.tenant AND l.scope='matching:'||OLD.destination AND l.expires_at>unixepoch('subsec')*1000) THEN RAISE(ABORT,'inventory matching deferral lease missing') END;
END;
CREATE TRIGGER matching_work_delete BEFORE DELETE ON matching_work WHEN OLD.completed_version<OLD.work_version AND EXISTS(SELECT 1 FROM index_generations g WHERE g.tenant=OLD.tenant AND g.generation_id=OLD.generation_id AND g.state IN('active','building')) BEGIN SELECT RAISE(ABORT,'pending inventory matching work'); END;
CREATE TRIGGER inventory_matching_source_projection_insert AFTER INSERT ON comparison_projections WHEN NEW.facet='source' BEGIN
 INSERT INTO matching_work(tenant,generation_id,destination,source_scope,record_key,source_config_version,destination_config_version)
 SELECT r.tenant,r.generation_id,r.destination,r.source_scope,NEW.record_key,r.source_config_version,r.destination_config_version FROM inventory_matching_source_routes r WHERE r.tenant=NEW.tenant AND r.generation_id=NEW.generation_id AND r.source_scope=NEW.scope_id
 ON CONFLICT(tenant,generation_id,destination,source_scope,record_key) DO UPDATE SET source_config_version=excluded.source_config_version,destination_config_version=excluded.destination_config_version,work_version=matching_work.work_version+1,due_at=0,hold_reason=NULL;
END;
CREATE TRIGGER inventory_matching_source_projection_update AFTER UPDATE ON comparison_projections WHEN NEW.facet='source' BEGIN
 INSERT INTO matching_work(tenant,generation_id,destination,source_scope,record_key,source_config_version,destination_config_version)
 SELECT r.tenant,r.generation_id,r.destination,r.source_scope,NEW.record_key,r.source_config_version,r.destination_config_version FROM inventory_matching_source_routes r WHERE r.tenant=NEW.tenant AND r.generation_id=NEW.generation_id AND r.source_scope=NEW.scope_id
 ON CONFLICT(tenant,generation_id,destination,source_scope,record_key) DO UPDATE SET source_config_version=excluded.source_config_version,destination_config_version=excluded.destination_config_version,work_version=matching_work.work_version+1,due_at=0,hold_reason=NULL;
END;

CREATE TABLE inventory_match_work_claims (
 tenant TEXT NOT NULL, set_id TEXT NOT NULL, row_count INTEGER NOT NULL CHECK(row_count BETWEEN 1 AND 20), PRIMARY KEY(tenant,set_id),
 FOREIGN KEY(tenant,set_id) REFERENCES inventory_match_sets(tenant,set_id)
);
CREATE TABLE inventory_match_work_rows (
 tenant TEXT NOT NULL, set_id TEXT NOT NULL, generation_id TEXT NOT NULL, destination TEXT NOT NULL, source_scope TEXT NOT NULL, record_key TEXT NOT NULL,
 work_version INTEGER NOT NULL, completed_version INTEGER NOT NULL, source_config_version INTEGER NOT NULL, destination_config_version INTEGER NOT NULL, due_at INTEGER NOT NULL,
 PRIMARY KEY(tenant,set_id,source_scope,record_key), FOREIGN KEY(tenant,set_id) REFERENCES inventory_match_work_claims(tenant,set_id),
 FOREIGN KEY(tenant,set_id,source_scope,record_key) REFERENCES inventory_match_rows(tenant,set_id,source_scope,record_key),
 FOREIGN KEY(tenant,generation_id,destination,source_scope,record_key) REFERENCES matching_work(tenant,generation_id,destination,source_scope,record_key)
);
CREATE TRIGGER inventory_match_work_claim_insert BEFORE INSERT ON inventory_match_work_claims WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets h WHERE h.tenant=NEW.tenant AND h.set_id=NEW.set_id AND h.state='prepared' AND h.row_count=NEW.row_count AND NOT EXISTS(SELECT 1 FROM inventory_match_guards g WHERE g.tenant=h.tenant AND g.set_id=h.set_id)) BEGIN SELECT RAISE(ABORT,'inventory matching work claim closed'); END;
CREATE TRIGGER inventory_match_work_row_insert BEFORE INSERT ON inventory_match_work_rows WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets h WHERE h.tenant=NEW.tenant AND h.set_id=NEW.set_id AND h.state='prepared' AND h.generation_id=NEW.generation_id AND h.destination=NEW.destination AND NOT EXISTS(SELECT 1 FROM inventory_match_guards g WHERE g.tenant=h.tenant AND g.set_id=h.set_id)) BEGIN SELECT RAISE(ABORT,'inventory matching work claim binding changed'); END;
CREATE TRIGGER inventory_match_work_guard BEFORE INSERT ON inventory_match_guards WHEN EXISTS(SELECT 1 FROM inventory_match_work_claims WHERE tenant=NEW.tenant AND set_id=NEW.set_id) BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_match_work_claims c WHERE c.tenant=NEW.tenant AND c.set_id=NEW.set_id AND c.row_count!=(SELECT count(*) FROM inventory_match_work_rows WHERE tenant=c.tenant AND set_id=c.set_id)) THEN RAISE(ABORT,'inventory matching work claim incomplete') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_match_work_rows q JOIN inventory_match_sets h ON h.tenant=q.tenant AND h.set_id=q.set_id LEFT JOIN matching_work w ON w.tenant=q.tenant AND w.generation_id=q.generation_id AND w.destination=q.destination AND w.source_scope=q.source_scope AND w.record_key=q.record_key WHERE q.tenant=NEW.tenant AND q.set_id=NEW.set_id AND (w.record_key IS NULL OR w.work_version!=q.work_version OR w.completed_version!=q.completed_version OR w.completed_version>=w.work_version OR w.source_config_version!=q.source_config_version OR w.destination_config_version!=q.destination_config_version OR w.due_at!=q.due_at OR w.due_at>h.prepared_at OR NOT EXISTS(SELECT 1 FROM inventory_matching_source_routes r WHERE r.tenant=q.tenant AND r.generation_id=q.generation_id AND r.destination=q.destination AND r.source_scope=q.source_scope AND r.source_config_version=q.source_config_version AND r.destination_config_version=q.destination_config_version))) THEN RAISE(ABORT,'inventory matching claimed work changed') END;
END;
CREATE TRIGGER matching_work_complete BEFORE UPDATE OF completed_version ON matching_work WHEN NEW.completed_version!=OLD.completed_version BEGIN
 SELECT CASE WHEN NEW.completed_version!=OLD.work_version OR NEW.work_version!=OLD.work_version OR NEW.hold_reason IS NOT NULL OR NEW.due_at!=OLD.due_at OR NOT EXISTS(
 SELECT 1 FROM inventory_match_work_rows q JOIN inventory_match_sets h ON h.tenant=q.tenant AND h.set_id=q.set_id AND h.state='prepared' JOIN inventory_match_guards g ON g.tenant=h.tenant AND g.set_id=h.set_id JOIN inventory_match_rows m ON m.tenant=q.tenant AND m.set_id=q.set_id AND m.source_scope=q.source_scope AND m.record_key=q.record_key JOIN match_results r ON r.tenant=q.tenant AND r.destination=q.destination AND r.source_scope=q.source_scope AND r.record_key=q.record_key AND r.set_id=q.set_id AND r.version=m.expected_version+1
 WHERE q.tenant=OLD.tenant AND q.set_id=NEW.last_completed_set AND q.generation_id=OLD.generation_id AND q.destination=OLD.destination AND q.source_scope=OLD.source_scope AND q.record_key=OLD.record_key AND q.work_version=OLD.work_version AND q.completed_version=OLD.completed_version AND q.source_config_version=OLD.source_config_version AND q.destination_config_version=OLD.destination_config_version AND q.due_at=OLD.due_at) THEN RAISE(ABORT,'inventory matching completion guard missing') END;
END;
CREATE TRIGGER inventory_match_work_commit BEFORE UPDATE ON inventory_match_sets WHEN EXISTS(SELECT 1 FROM inventory_match_work_claims WHERE tenant=OLD.tenant AND set_id=OLD.set_id) BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM inventory_match_work_rows q CROSS JOIN matching_work w WHERE q.tenant=OLD.tenant AND q.set_id=OLD.set_id AND w.tenant=q.tenant AND w.generation_id=q.generation_id AND w.destination=q.destination AND w.source_scope=q.source_scope AND w.record_key=q.record_key AND w.work_version=q.work_version AND w.completed_version=q.work_version AND w.last_completed_set=q.set_id AND w.source_config_version=q.source_config_version AND w.destination_config_version=q.destination_config_version)!=(SELECT row_count FROM inventory_match_work_claims WHERE tenant=OLD.tenant AND set_id=OLD.set_id) THEN RAISE(ABORT,'inventory matching work completion incomplete') END;
END;
CREATE TRIGGER inventory_match_work_claim_update BEFORE UPDATE ON inventory_match_work_claims BEGIN SELECT RAISE(ABORT,'immutable inventory matching work claim'); END;
CREATE TRIGGER inventory_match_work_row_update BEFORE UPDATE ON inventory_match_work_rows BEGIN SELECT RAISE(ABORT,'immutable inventory matching work claim'); END;
CREATE TRIGGER inventory_match_work_claim_delete BEFORE DELETE ON inventory_match_work_claims WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets h WHERE h.tenant=OLD.tenant AND h.set_id=OLD.set_id AND h.state='committed' AND h.prepared_at<unixepoch('subsec')*1000-604800000 AND NOT EXISTS(SELECT 1 FROM match_results r WHERE r.tenant=h.tenant AND r.set_id=h.set_id)) BEGIN SELECT RAISE(ABORT,'retained inventory matching work claim'); END;
CREATE TRIGGER inventory_match_work_row_delete BEFORE DELETE ON inventory_match_work_rows WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets h WHERE h.tenant=OLD.tenant AND h.set_id=OLD.set_id AND h.state='committed' AND h.prepared_at<unixepoch('subsec')*1000-604800000 AND NOT EXISTS(SELECT 1 FROM match_results r WHERE r.tenant=h.tenant AND r.set_id=h.set_id)) BEGIN SELECT RAISE(ABORT,'retained inventory matching work claim'); END;
