ALTER TABLE ledger ADD COLUMN operation_id TEXT;
CREATE TABLE source_work (
 tenant TEXT NOT NULL, source TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
 operation_id TEXT, private_id TEXT NOT NULL, revision TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending', reason TEXT, expires_at INTEGER NOT NULL, processed_at INTEGER NOT NULL DEFAULT 0, synced_at INTEGER NOT NULL DEFAULT 0, is_event INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant,source,id,kind), FOREIGN KEY(tenant,source) REFERENCES connections(tenant,id)
);
CREATE INDEX source_operation ON source_work(tenant,source,operation_id);
CREATE INDEX source_pending ON source_work(tenant,source,state);

ALTER TABLE ledger ADD COLUMN context_generation INTEGER;
CREATE TABLE projection_guards(id TEXT PRIMARY KEY,tenant TEXT,source TEXT,context_generation INTEGER,now INTEGER,operation_id TEXT);
CREATE TRIGGER projection_guard BEFORE INSERT ON projection_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM connections WHERE tenant=NEW.tenant AND id=NEW.source AND kind='lofi' AND status='active') THEN RAISE(ABORT,'source connection inactive') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM cursors WHERE tenant=NEW.tenant AND connection=NEW.source AND stream='context' AND generation=NEW.context_generation AND json_extract(cursor,'$.complete')=1) THEN RAISE(ABORT,'source context changed') END;
 SELECT CASE WHEN NEW.operation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM source_work WHERE tenant=NEW.tenant AND source=NEW.source AND id=NEW.operation_id AND kind='operation' AND state='context' AND expires_at>NEW.now) THEN RAISE(ABORT,'operation context unavailable') END;
END;
CREATE TRIGGER stage_source_guard BEFORE INSERT ON stage_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM connections WHERE tenant=NEW.tenant AND id=NEW.source AND kind='lofi' AND status='active') THEN RAISE(ABORT,'source connection inactive') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ledger WHERE tenant=NEW.tenant AND source=NEW.source AND qso=NEW.qso AND destination=NEW.destination AND context_generation IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cursors WHERE tenant=NEW.tenant AND connection=NEW.source AND stream='context' AND generation=ledger.context_generation AND json_extract(cursor,'$.complete')=1)) THEN RAISE(ABORT,'source context changed before stage') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ledger l WHERE l.tenant=NEW.tenant AND l.source=NEW.source AND l.qso=NEW.qso AND l.destination=NEW.destination AND l.context_generation IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM source_work w WHERE w.tenant=l.tenant AND w.source=l.source AND w.id=l.qso AND w.kind='qso' AND w.state IN('pending','waiting') AND w.expires_at>NEW.now) OR l.operation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM source_work w WHERE w.tenant=l.tenant AND w.source=l.source AND w.id=l.operation_id AND w.kind='operation' AND w.state='context' AND w.expires_at>NEW.now))) THEN RAISE(ABORT,'source payload or operation context unavailable') END;
END;
ALTER TABLE source_work ADD COLUMN seen_epoch TEXT;
ALTER TABLE source_work ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
CREATE TABLE source_write_guards(id TEXT PRIMARY KEY,tenant TEXT,source TEXT,record_id TEXT,kind TEXT,expected_synced INTEGER,expected_revision TEXT,credential_version TEXT);
CREATE TRIGGER source_write_guard BEFORE INSERT ON source_write_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM connections WHERE tenant=NEW.tenant AND id=NEW.source AND status='active' AND credential_version IS NEW.credential_version) THEN RAISE(ABORT,'source connection changed') END;
 SELECT CASE WHEN NEW.record_id IS NOT NULL AND (NEW.expected_revision IS NULL AND EXISTS(SELECT 1 FROM source_work WHERE tenant=NEW.tenant AND source=NEW.source AND id=NEW.record_id AND kind=NEW.kind) OR NEW.expected_revision IS NOT NULL AND NOT EXISTS(SELECT 1 FROM source_work WHERE tenant=NEW.tenant AND source=NEW.source AND id=NEW.record_id AND kind=NEW.kind AND revision=NEW.expected_revision AND synced_at=NEW.expected_synced)) THEN RAISE(ABORT,'source row changed') END;
END;
ALTER TABLE ledger ADD COLUMN prior_route_state TEXT;
CREATE TRIGGER dispatch_source_guard BEFORE UPDATE OF state ON attempt_state WHEN NEW.state='dispatching' AND OLD.state!='dispatching' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM attempts a JOIN ledger l ON l.tenant=a.tenant AND l.source=a.source AND l.qso=a.qso AND l.destination=a.destination WHERE a.tenant=NEW.tenant AND a.id=NEW.attempt AND l.context_generation IS NOT NULL AND (a.source_hash!=l.source_hash OR NOT EXISTS(SELECT 1 FROM cursors c WHERE c.tenant=l.tenant AND c.connection=l.source AND c.stream='context' AND c.generation=l.context_generation AND json_extract(c.cursor,'$.complete')=1))) THEN RAISE(ABORT,'source changed before dispatch') END;
END;
