-- A fresh runtime owns discovery and retires the old reader/sender together.
-- This is a one-way database decision, independent from an environment pause.
CREATE TABLE inventory_runtime (
 id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL CHECK(mode IN('legacy','inventory_read_only')),
 version INTEGER NOT NULL CHECK(version>=0), activated_at INTEGER,
 CHECK((mode='legacy' AND version=0 AND activated_at IS NULL) OR (mode='inventory_read_only' AND version>0 AND activated_at IS NOT NULL))
);
INSERT INTO inventory_runtime VALUES(1,'legacy',0,NULL);
CREATE TABLE inventory_runtime_switch_guards (
 id TEXT PRIMARY KEY, expected_version INTEGER NOT NULL, lease_tenant TEXT NOT NULL,
 lease_token TEXT NOT NULL, lease_fence INTEGER NOT NULL
);
CREATE TRIGGER inventory_runtime_switch_guard BEFORE INSERT ON inventory_runtime_switch_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_runtime WHERE id=1 AND mode='legacy' AND version=NEW.expected_version)
 OR NOT EXISTS(SELECT 1 FROM leases WHERE tenant=NEW.lease_tenant AND scope='inventory:runtime' AND token=NEW.lease_token AND fence=NEW.lease_fence AND expires_at>unixepoch('subsec')*1000)
 THEN RAISE(ABORT,'inventory runtime activation changed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM leases WHERE expires_at>unixepoch('subsec')*1000 AND substr(scope,1,10)!='inventory:')
 THEN RAISE(ABORT,'legacy work still leased') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM attempts a LEFT JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE s.state IS NULL OR s.state NOT IN('observed','delivered','rejected','cancelled'))
 THEN RAISE(ABORT,'legacy attempt needs reconciliation') END;
END;
CREATE TRIGGER inventory_runtime_transition BEFORE UPDATE ON inventory_runtime BEGIN
 SELECT CASE WHEN NEW.id!=OLD.id OR OLD.mode!='legacy' OR NEW.mode!='inventory_read_only' OR NEW.version!=OLD.version+1
 OR NOT EXISTS(SELECT 1 FROM inventory_runtime_switch_guards g JOIN leases l ON l.tenant=g.lease_tenant AND l.scope='inventory:runtime' AND l.token=g.lease_token AND l.fence=g.lease_fence WHERE g.expected_version=OLD.version AND l.expires_at>unixepoch('subsec')*1000)
 THEN RAISE(ABORT,'inventory runtime transition refused') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM leases WHERE expires_at>unixepoch('subsec')*1000 AND substr(scope,1,10)!='inventory:')
 THEN RAISE(ABORT,'legacy work still leased') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM attempts a LEFT JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE s.state IS NULL OR s.state NOT IN('observed','delivered','rejected','cancelled'))
 THEN RAISE(ABORT,'legacy attempt needs reconciliation') END;
END;
CREATE TRIGGER inventory_runtime_switch_immutable BEFORE UPDATE ON inventory_runtime_switch_guards BEGIN SELECT RAISE(ABORT,'inventory runtime switch immutable'); END;
CREATE TRIGGER inventory_runtime_no_delete BEFORE DELETE ON inventory_runtime BEGIN SELECT RAISE(ABORT,'inventory runtime ownership retained'); END;
CREATE TRIGGER inventory_runtime_no_replace BEFORE INSERT ON inventory_runtime WHEN EXISTS(SELECT 1 FROM inventory_runtime WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'inventory runtime ownership retained'); END;

ALTER TABLE inventory_scopes ADD COLUMN runtime_version INTEGER NOT NULL DEFAULT 0 CHECK(runtime_version>=0);
CREATE TRIGGER inventory_scope_runtime_version BEFORE UPDATE OF runtime_version ON inventory_scopes WHEN NEW.runtime_version!=OLD.runtime_version BEGIN
 SELECT CASE WHEN OLD.runtime_version!=0 OR NEW.runtime_version<=0 OR NEW.config_version<=OLD.config_version OR OLD.accepted_sequence!=0
 OR NOT EXISTS(SELECT 1 FROM inventory_runtime WHERE mode='inventory_read_only' AND version=NEW.runtime_version)
 THEN RAISE(ABORT,'inventory scope runtime changed') END;
END;
CREATE TRIGGER inventory_managed_runtime BEFORE INSERT ON ingestion_page_guards BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ingestion_pages p JOIN inventory_scopes s ON s.tenant=p.tenant AND s.scope_id=p.scope_id CROSS JOIN inventory_runtime runtime WHERE p.tenant=NEW.tenant AND p.page_id=NEW.page_id AND (s.runtime_version>0 AND (runtime.mode!='inventory_read_only' OR runtime.version!=s.runtime_version) OR runtime.mode='inventory_read_only' AND s.runtime_version!=runtime.version))
 THEN RAISE(ABORT,'inventory runtime reader unavailable') END;
END;

-- Native lease admission closes the race between an old scheduler's roster
-- read and a handoff. An in-flight legacy lease prevents activation above.
CREATE TRIGGER inventory_retired_lease_insert BEFORE INSERT ON leases
 WHEN NEW.expires_at>unixepoch('subsec')*1000 AND substr(NEW.scope,1,10)!='inventory:' AND EXISTS(SELECT 1 FROM inventory_runtime WHERE mode='inventory_read_only')
 BEGIN
 SELECT RAISE(ABORT,'legacy reader retired');
END;
CREATE TRIGGER inventory_retired_lease_update BEFORE UPDATE ON leases
 WHEN NEW.expires_at>unixepoch('subsec')*1000 AND substr(NEW.scope,1,10)!='inventory:' AND EXISTS(SELECT 1 FROM inventory_runtime WHERE mode='inventory_read_only')
 BEGIN
 SELECT RAISE(ABORT,'legacy reader retired');
END;
CREATE TRIGGER inventory_retired_checkpoint BEFORE INSERT ON checkpoint_guards WHEN EXISTS(SELECT 1 FROM inventory_runtime WHERE mode='inventory_read_only') BEGIN SELECT RAISE(ABORT,'legacy reader retired'); END;
CREATE TRIGGER inventory_retired_source_write BEFORE INSERT ON source_write_guards WHEN EXISTS(SELECT 1 FROM inventory_runtime WHERE mode='inventory_read_only') BEGIN SELECT RAISE(ABORT,'legacy reader retired'); END;
CREATE TRIGGER inventory_retired_projection BEFORE INSERT ON projection_guards WHEN EXISTS(SELECT 1 FROM inventory_runtime WHERE mode='inventory_read_only') BEGIN SELECT RAISE(ABORT,'legacy reader retired'); END;
CREATE TRIGGER inventory_retired_history BEFORE INSERT ON history_inventory_guards WHEN EXISTS(SELECT 1 FROM inventory_runtime WHERE mode='inventory_read_only') BEGIN SELECT RAISE(ABORT,'legacy reader retired'); END;
CREATE TRIGGER inventory_retired_cursor_insert BEFORE INSERT ON cursors WHEN EXISTS(SELECT 1 FROM inventory_runtime WHERE mode='inventory_read_only') BEGIN SELECT RAISE(ABORT,'legacy reader retired'); END;
CREATE TRIGGER inventory_retired_cursor_update BEFORE UPDATE ON cursors WHEN EXISTS(SELECT 1 FROM inventory_runtime WHERE mode='inventory_read_only') BEGIN SELECT RAISE(ABORT,'legacy reader retired'); END;
CREATE TRIGGER inventory_retired_stage BEFORE INSERT ON stage_guards WHEN EXISTS(SELECT 1 FROM inventory_runtime WHERE mode='inventory_read_only') BEGIN SELECT RAISE(ABORT,'legacy sender retired'); END;
CREATE TRIGGER inventory_retired_attempt BEFORE INSERT ON attempts WHEN EXISTS(SELECT 1 FROM inventory_runtime WHERE mode='inventory_read_only') BEGIN SELECT RAISE(ABORT,'legacy sender retired'); END;
CREATE TRIGGER inventory_retired_dispatch_insert BEFORE INSERT ON attempt_state WHEN NEW.state IN('prepared','dispatching') AND EXISTS(SELECT 1 FROM inventory_runtime WHERE mode='inventory_read_only') BEGIN SELECT RAISE(ABORT,'legacy sender retired'); END;
CREATE TRIGGER inventory_retired_dispatch_update BEFORE UPDATE OF state ON attempt_state WHEN NEW.state='dispatching' AND EXISTS(SELECT 1 FROM inventory_runtime WHERE mode='inventory_read_only') BEGIN SELECT RAISE(ABORT,'legacy sender retired'); END;
CREATE TRIGGER inventory_retired_proof BEFORE INSERT ON source_export_proofs WHEN EXISTS(SELECT 1 FROM inventory_runtime WHERE mode='inventory_read_only') BEGIN SELECT RAISE(ABORT,'legacy sender retired'); END;
