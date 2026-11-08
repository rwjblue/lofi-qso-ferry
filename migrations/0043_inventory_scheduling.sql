CREATE TABLE inventory_scheduled_selections (
 tenant TEXT NOT NULL, scope_id TEXT NOT NULL, stream_id TEXT NOT NULL,
 runtime_version INTEGER NOT NULL, config_version INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 plan TEXT NOT NULL CHECK(json_valid(plan)), created_at INTEGER NOT NULL,
 poll_period_ms INTEGER NOT NULL CHECK(poll_period_ms BETWEEN 300000 AND 604800000),
 verification_period_ms INTEGER NOT NULL CHECK(verification_period_ms BETWEEN 86400000 AND 7776000000),
 next_full_at INTEGER NOT NULL DEFAULT 0, last_full_completed_at INTEGER,
 PRIMARY KEY(tenant,scope_id,stream_id),
 FOREIGN KEY(tenant,scope_id,stream_id) REFERENCES inventory_streams(tenant,scope_id,stream_id)
);
CREATE TABLE inventory_registration_progress(id INTEGER PRIMARY KEY CHECK(id=1),last_tenant TEXT NOT NULL,last_connection TEXT NOT NULL);
INSERT INTO inventory_registration_progress VALUES(1,'','');
CREATE TRIGGER inventory_schedule_binding BEFORE INSERT ON inventory_scheduled_selections BEGIN
 SELECT CASE WHEN NOT EXISTS(
 SELECT 1 FROM inventory_scopes s JOIN inventory_runtime runtime ON runtime.mode='inventory_read_only' AND runtime.version=s.runtime_version
 JOIN connections c ON c.tenant=s.tenant AND c.id=s.connection_id JOIN accounts a ON a.id=c.tenant
 WHERE s.tenant=NEW.tenant AND s.scope_id=NEW.scope_id AND s.state='observing' AND s.runtime_version=NEW.runtime_version AND s.config_version=NEW.config_version
 AND c.status='active' AND a.status='active' AND c.remote_identity=s.logical_identity AND c.kind=s.provider AND json_extract(NEW.plan,'$.provider')=s.provider
 AND (s.provider!='lofi' OR json_extract(c.config,'$.accountId')=c.remote_identity)
 AND (s.provider!='qrz' OR (json_extract(c.config,'$.bookId')=json_extract(NEW.plan,'$.book.bookId') AND json_extract(c.config,'$.stationCallsign')=json_extract(NEW.plan,'$.book.stationCallsign') AND json_extract(c.config,'$.startDate')=json_extract(NEW.plan,'$.book.startDate') AND json_extract(c.config,'$.endDate')=json_extract(NEW.plan,'$.book.endDate')))
 AND (s.provider!='lotw' OR json_extract(c.config,'$.readAccess')=1)
 ) THEN RAISE(ABORT,'inventory schedule authority changed') END;
END;
CREATE TRIGGER inventory_schedule_immutable BEFORE UPDATE ON inventory_scheduled_selections
 WHEN NEW.tenant!=OLD.tenant OR NEW.scope_id!=OLD.scope_id OR NEW.stream_id!=OLD.stream_id OR NEW.runtime_version!=OLD.runtime_version OR NEW.plan!=OLD.plan OR NEW.created_at!=OLD.created_at
 OR NEW.version<=OLD.version OR NEW.config_version<OLD.config_version OR NEW.last_full_completed_at<OLD.last_full_completed_at
 BEGIN
 SELECT RAISE(ABORT,'inventory schedule binding changed');
END;
CREATE TRIGGER inventory_managed_run_selection BEFORE INSERT ON inventory_runs
 WHEN EXISTS(SELECT 1 FROM inventory_scopes s WHERE s.tenant=NEW.tenant AND s.scope_id=NEW.scope_id AND s.runtime_version>0)
 BEGIN
 SELECT CASE WHEN NOT EXISTS(
 SELECT 1 FROM inventory_scheduled_selections p JOIN inventory_scopes s ON s.tenant=p.tenant AND s.scope_id=p.scope_id
 WHERE p.tenant=NEW.tenant AND p.scope_id=NEW.scope_id AND p.stream_id=NEW.stream_id AND p.config_version=NEW.config_version AND p.runtime_version=s.runtime_version
 AND json_extract(p.plan,'$.provider')=json_extract(NEW.fixed_query,'$.provider')
 AND (s.provider!='qrz' OR (json_extract(p.plan,'$.book')=json_extract(NEW.fixed_query,'$.book') AND json_extract(p.plan,'$.between')=json_extract(NEW.fixed_query,'$.selection.between')))
 AND (s.provider!='lotw' OR json_extract(p.plan,'$.selection')=json_remove(json_extract(NEW.fixed_query,'$.query'),'$.receivedSince'))
 ) THEN RAISE(ABORT,'inventory scheduled selection changed') END;
END;
CREATE TRIGGER inventory_schedule_full_completion AFTER UPDATE OF phase ON inventory_runs
 WHEN NEW.phase='complete' AND OLD.phase!='complete' AND NEW.mode='full'
 BEGIN
 UPDATE inventory_scheduled_selections SET version=version+1,last_full_completed_at=NEW.completed_at,next_full_at=NEW.completed_at+verification_period_ms
 WHERE tenant=NEW.tenant AND scope_id=NEW.scope_id AND stream_id=NEW.stream_id AND config_version=NEW.config_version;
END;
