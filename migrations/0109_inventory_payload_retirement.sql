-- Current raw inputs are pinned by the facet foreign key. Index the reverse
-- lookup for retirement and for SQLite's foreign-key check on deletion.
CREATE INDEX inventory_record_facets_payload ON inventory_record_facets(tenant,scope_id,payload_id);

CREATE TABLE inventory_payload_retirements (
 tenant TEXT NOT NULL, scope_id TEXT NOT NULL, payload_id TEXT NOT NULL,
 eligible_at INTEGER NOT NULL CHECK(eligible_at>=0),
 PRIMARY KEY(tenant,scope_id,payload_id),
 FOREIGN KEY(tenant,scope_id,payload_id) REFERENCES inventory_payloads(tenant,scope_id,payload_id) ON DELETE CASCADE
);
CREATE INDEX inventory_payload_retirement_due ON inventory_payload_retirements(tenant,eligible_at,scope_id,payload_id);

CREATE TRIGGER inventory_payload_retire AFTER UPDATE OF payload_id ON inventory_record_facets
 WHEN NEW.payload_id!=OLD.payload_id BEGIN
 INSERT INTO inventory_payload_retirements(tenant,scope_id,payload_id,eligible_at)
 SELECT OLD.tenant,OLD.scope_id,OLD.payload_id,CAST(unixepoch('subsec')*1000 AS INTEGER)+604800000
 WHERE NOT EXISTS(SELECT 1 FROM inventory_record_facets f WHERE (f.tenant,f.scope_id,f.payload_id)=(OLD.tenant,OLD.scope_id,OLD.payload_id))
 ON CONFLICT(tenant,scope_id,payload_id) DO UPDATE SET eligible_at=max(eligible_at,excluded.eligible_at);
END;

-- Existing unused bodies have no recorded retirement time. Give them the
-- same grace period measured from this migration.
INSERT INTO inventory_payload_retirements(tenant,scope_id,payload_id,eligible_at)
 SELECT p.tenant,p.scope_id,p.payload_id,CAST(unixepoch('subsec')*1000 AS INTEGER)+604800000
 FROM inventory_payloads p
 WHERE NOT EXISTS(SELECT 1 FROM inventory_record_facets f WHERE (f.tenant,f.scope_id,f.payload_id)=(p.tenant,p.scope_id,p.payload_id));

CREATE TRIGGER inventory_payload_delete BEFORE DELETE ON inventory_payloads
 WHEN NOT EXISTS(
  SELECT 1 FROM inventory_payload_retirements r WHERE (r.tenant,r.scope_id,r.payload_id)=(OLD.tenant,OLD.scope_id,OLD.payload_id)
  AND r.eligible_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)
 ) OR EXISTS(SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=OLD.tenant) BEGIN
 SELECT RAISE(ABORT,'inventory payload retained');
END;
