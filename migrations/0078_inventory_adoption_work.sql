-- Rebuildable scheduling hints for guarded, permanent historical adoption.
-- The association itself is the completion receipt; no completed-job history.
CREATE TABLE inventory_adoption_work (
 tenant TEXT NOT NULL, destination TEXT NOT NULL, source_scope TEXT NOT NULL, record_key TEXT NOT NULL,
 generation_id TEXT NOT NULL, result_set TEXT NOT NULL, result_version INTEGER NOT NULL CHECK(result_version>0),
 source_config_version INTEGER NOT NULL, destination_config_version INTEGER NOT NULL,
 provider TEXT NOT NULL CHECK(provider IN('qrz','lotw')), book_identity TEXT NOT NULL, source_identity TEXT NOT NULL,
 due_at INTEGER NOT NULL CHECK(due_at>0), hold_reason TEXT CHECK(hold_reason IN('capacity','comparison','ownership','prior_delivery')),
 PRIMARY KEY(tenant,destination,source_scope,record_key),
 FOREIGN KEY(tenant,generation_id) REFERENCES index_generations(tenant,generation_id),
 FOREIGN KEY(tenant,result_set) REFERENCES inventory_match_sets(tenant,set_id),
 FOREIGN KEY(tenant,destination) REFERENCES inventory_scopes(tenant,scope_id),
 FOREIGN KEY(tenant,source_scope) REFERENCES inventory_scopes(tenant,scope_id)
);
CREATE INDEX inventory_adoption_work_due ON inventory_adoption_work(tenant,generation_id,destination,source_scope,source_config_version,destination_config_version,due_at,record_key);
CREATE INDEX inventory_adoption_work_set_due ON inventory_adoption_work(tenant,result_set,source_scope,due_at,record_key);
CREATE VIEW inventory_adoption_work_expected AS
 SELECT r.tenant,r.destination,r.source_scope,r.record_key,h.generation_id,r.set_id AS result_set,r.version AS result_version,
 s.config_version AS source_config_version,t.config_version AS destination_config_version,t.provider,
 t.scope_identity AS book_identity,s.scope_identity AS source_identity,h.prepared_at AS due_at
 FROM match_results r JOIN inventory_match_sets h ON h.tenant=r.tenant AND h.set_id=r.set_id AND h.state IN('prepared','committed')
 JOIN inventory_match_scopes s ON s.tenant=r.tenant AND s.set_id=r.set_id AND s.scope_id=r.source_scope AND s.source=1 AND s.provider='lofi'
 JOIN inventory_match_scopes t ON t.tenant=r.tenant AND t.set_id=r.set_id AND t.scope_id=r.destination AND t.provider IN('qrz','lotw')
 WHERE r.state='matched_existing' AND NOT EXISTS(SELECT 1 FROM inventory_historical_associations a WHERE a.tenant=r.tenant AND a.provider=t.provider AND a.book_identity=t.scope_identity AND a.source_identity=s.scope_identity AND a.record_key=r.record_key);
CREATE TRIGGER inventory_adoption_work_insert BEFORE INSERT ON inventory_adoption_work BEGIN
 SELECT CASE WHEN NEW.hold_reason IS NOT NULL OR NOT EXISTS(SELECT 1 FROM inventory_adoption_work_expected e WHERE (e.tenant,e.destination,e.source_scope,e.record_key,e.generation_id,e.result_set,e.result_version,e.source_config_version,e.destination_config_version,e.provider,e.book_identity,e.source_identity,e.due_at)=(NEW.tenant,NEW.destination,NEW.source_scope,NEW.record_key,NEW.generation_id,NEW.result_set,NEW.result_version,NEW.source_config_version,NEW.destination_config_version,NEW.provider,NEW.book_identity,NEW.source_identity,NEW.due_at)) THEN RAISE(ABORT,'inventory adoption work result changed') END;
END;
CREATE TRIGGER inventory_adoption_work_update BEFORE UPDATE ON inventory_adoption_work BEGIN
 SELECT CASE WHEN (NEW.tenant,NEW.destination,NEW.source_scope,NEW.record_key) IS NOT (OLD.tenant,OLD.destination,OLD.source_scope,OLD.record_key) OR NEW.result_version<OLD.result_version THEN RAISE(ABORT,'inventory adoption work regressed') END;
 SELECT CASE WHEN NEW.result_version!=OLD.result_version AND (NEW.hold_reason IS NOT NULL OR NOT EXISTS(SELECT 1 FROM inventory_adoption_work_expected e WHERE (e.tenant,e.destination,e.source_scope,e.record_key,e.generation_id,e.result_set,e.result_version,e.source_config_version,e.destination_config_version,e.provider,e.book_identity,e.source_identity,e.due_at)=(NEW.tenant,NEW.destination,NEW.source_scope,NEW.record_key,NEW.generation_id,NEW.result_set,NEW.result_version,NEW.source_config_version,NEW.destination_config_version,NEW.provider,NEW.book_identity,NEW.source_identity,NEW.due_at))) THEN RAISE(ABORT,'inventory adoption work signal invalid') END;
 SELECT CASE WHEN NEW.result_version=OLD.result_version AND (NEW.generation_id,NEW.result_set,NEW.source_config_version,NEW.destination_config_version,NEW.provider,NEW.book_identity,NEW.source_identity) IS NOT (OLD.generation_id,OLD.result_set,OLD.source_config_version,OLD.destination_config_version,OLD.provider,OLD.book_identity,OLD.source_identity) THEN RAISE(ABORT,'inventory adoption work binding changed') END;
 SELECT CASE WHEN NEW.result_version=OLD.result_version AND (NEW.due_at,NEW.hold_reason) IS NOT (OLD.due_at,OLD.hold_reason) AND (NEW.due_at<=unixepoch('subsec')*1000 OR NEW.due_at>unixepoch('subsec')*1000+900000 OR NEW.hold_reason IS NULL OR NOT EXISTS(SELECT 1 FROM leases l JOIN accounts a ON a.id=l.tenant AND a.status='active' WHERE l.tenant=OLD.tenant AND l.scope='inventory-ownership:'||OLD.provider AND l.expires_at>unixepoch('subsec')*1000)) THEN RAISE(ABORT,'inventory adoption deferral lease missing') END;
END;
CREATE TRIGGER inventory_adoption_work_delete BEFORE DELETE ON inventory_adoption_work WHEN EXISTS(SELECT 1 FROM inventory_adoption_work_expected e WHERE e.tenant=OLD.tenant AND e.destination=OLD.destination AND e.source_scope=OLD.source_scope AND e.record_key=OLD.record_key) BEGIN SELECT RAISE(ABORT,'pending inventory adoption work'); END;
CREATE TRIGGER inventory_adoption_result_insert AFTER INSERT ON match_results BEGIN
 INSERT INTO inventory_adoption_work(tenant,destination,source_scope,record_key,generation_id,result_set,result_version,source_config_version,destination_config_version,provider,book_identity,source_identity,due_at)
 SELECT tenant,destination,source_scope,record_key,generation_id,result_set,result_version,source_config_version,destination_config_version,provider,book_identity,source_identity,due_at FROM inventory_adoption_work_expected WHERE tenant=NEW.tenant AND destination=NEW.destination AND source_scope=NEW.source_scope AND record_key=NEW.record_key;
END;
CREATE TRIGGER inventory_adoption_result_update AFTER UPDATE ON match_results BEGIN
 INSERT INTO inventory_adoption_work(tenant,destination,source_scope,record_key,generation_id,result_set,result_version,source_config_version,destination_config_version,provider,book_identity,source_identity,due_at)
 SELECT tenant,destination,source_scope,record_key,generation_id,result_set,result_version,source_config_version,destination_config_version,provider,book_identity,source_identity,due_at FROM inventory_adoption_work_expected WHERE tenant=NEW.tenant AND destination=NEW.destination AND source_scope=NEW.source_scope AND record_key=NEW.record_key
 ON CONFLICT(tenant,destination,source_scope,record_key) DO UPDATE SET generation_id=excluded.generation_id,result_set=excluded.result_set,result_version=excluded.result_version,source_config_version=excluded.source_config_version,destination_config_version=excluded.destination_config_version,provider=excluded.provider,book_identity=excluded.book_identity,source_identity=excluded.source_identity,due_at=excluded.due_at,hold_reason=NULL;
 DELETE FROM inventory_adoption_work WHERE tenant=NEW.tenant AND destination=NEW.destination AND source_scope=NEW.source_scope AND record_key=NEW.record_key AND NOT EXISTS(SELECT 1 FROM inventory_adoption_work_expected e WHERE e.tenant=NEW.tenant AND e.destination=NEW.destination AND e.source_scope=NEW.source_scope AND e.record_key=NEW.record_key);
END;
CREATE TRIGGER inventory_adoption_result_delete AFTER DELETE ON match_results BEGIN DELETE FROM inventory_adoption_work WHERE tenant=OLD.tenant AND destination=OLD.destination AND source_scope=OLD.source_scope AND record_key=OLD.record_key; END;
CREATE TRIGGER inventory_adoption_match_commit BEFORE UPDATE OF state ON inventory_match_sets WHEN OLD.state='prepared' AND NEW.state='committed' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM match_results r INDEXED BY match_result_set JOIN inventory_adoption_work_expected e ON e.tenant=r.tenant AND e.destination=r.destination AND e.source_scope=r.source_scope AND e.record_key=r.record_key WHERE r.tenant=NEW.tenant AND r.set_id=NEW.set_id AND NOT EXISTS(SELECT 1 FROM inventory_adoption_work w WHERE (w.tenant,w.destination,w.source_scope,w.record_key,w.generation_id,w.result_set,w.result_version,w.source_config_version,w.destination_config_version,w.provider,w.book_identity,w.source_identity)=(e.tenant,e.destination,e.source_scope,e.record_key,e.generation_id,e.result_set,e.result_version,e.source_config_version,e.destination_config_version,e.provider,e.book_identity,e.source_identity))) THEN RAISE(ABORT,'inventory adoption work publication incomplete') END;
END;
