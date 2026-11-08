CREATE TABLE inventory_comparison_coordinators (
 tenant TEXT NOT NULL PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 work_version INTEGER NOT NULL DEFAULT 1 CHECK(work_version>0), observed_version INTEGER NOT NULL DEFAULT 0,
 phase INTEGER NOT NULL DEFAULT 0 CHECK(phase BETWEEN 0 AND 4), idle_turns INTEGER NOT NULL DEFAULT 0 CHECK(idle_turns BETWEEN 0 AND 5),
 build_generation TEXT NOT NULL DEFAULT '', build_scope TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0,
 FOREIGN KEY(tenant) REFERENCES accounts(id), CHECK(observed_version>=0 AND observed_version<=work_version)
);
CREATE INDEX inventory_comparison_coordinator_due ON inventory_comparison_coordinators(tenant) WHERE idle_turns<5 OR observed_version<work_version;
CREATE TRIGGER inventory_comparison_control_update BEFORE UPDATE ON inventory_comparison_coordinators BEGIN
 SELECT CASE WHEN NEW.tenant!=OLD.tenant OR NEW.version<OLD.version OR NEW.work_version<OLD.work_version OR NEW.observed_version<OLD.observed_version THEN RAISE(ABORT,'comparison coordinator regressed') END;
 SELECT CASE WHEN NEW.work_version!=OLD.work_version AND (NEW.work_version!=OLD.work_version+1 OR (NEW.version,NEW.observed_version,NEW.phase,NEW.idle_turns,NEW.build_generation,NEW.build_scope,NEW.updated_at) IS NOT (OLD.version,OLD.observed_version,OLD.phase,OLD.idle_turns,OLD.build_generation,OLD.build_scope,OLD.updated_at)) THEN RAISE(ABORT,'comparison wakeup changed progress') END;
 SELECT CASE WHEN NEW.work_version=OLD.work_version AND (NEW.version!=OLD.version+1 OR NEW.observed_version!=NEW.work_version OR NOT EXISTS(SELECT 1 FROM leases l JOIN accounts a ON a.id=l.tenant AND a.status='active' WHERE l.tenant=OLD.tenant AND l.scope='inventory-comparison' AND l.expires_at>unixepoch('subsec')*1000)) THEN RAISE(ABORT,'comparison coordinator lease missing') END;
END;
CREATE TRIGGER inventory_comparison_wake_ingestion AFTER UPDATE ON ingestion_pages WHEN OLD.state='prepared' AND NEW.state='committed' BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
CREATE TRIGGER inventory_comparison_wake_projection AFTER UPDATE ON comparison_projection_pages WHEN OLD.state='prepared' AND NEW.state='committed' BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
CREATE TRIGGER inventory_comparison_wake_generation AFTER INSERT ON index_generations BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
CREATE TRIGGER inventory_comparison_wake_generation_state AFTER UPDATE OF state ON index_generations WHEN NEW.state!=OLD.state BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
CREATE TRIGGER inventory_comparison_wake_scope AFTER INSERT ON inventory_scopes BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
CREATE TRIGGER inventory_comparison_wake_scope_update AFTER UPDATE OF config_version,state ON inventory_scopes WHEN NEW.config_version!=OLD.config_version OR NEW.state!=OLD.state BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;

CREATE VIEW inventory_comparison_eligible_scopes AS
 SELECT s.tenant,s.scope_id,s.config_version FROM inventory_scopes s JOIN accounts a ON a.id=s.tenant AND a.status='active' JOIN connections c ON c.tenant=s.tenant AND c.id=s.connection_id AND c.status='active' AND c.kind=s.provider AND c.remote_identity=s.logical_identity WHERE s.state='observing';
CREATE VIEW inventory_comparison_generation_debt AS
 SELECT d.tenant,g.generation_id FROM comparison_domains d JOIN index_generations g ON g.tenant=d.tenant AND g.generation_id IN(d.active_generation,d.pending_generation) JOIN inventory_scopes s ON s.tenant=d.tenant LEFT JOIN comparison_builds b ON b.tenant=s.tenant AND b.generation_id=g.generation_id AND b.scope_id=s.scope_id WHERE b.complete IS NOT 1 OR b.config_version IS NOT s.config_version
 UNION ALL SELECT w.tenant,w.generation_id FROM comparison_work w INDEXED BY comparison_work_pending_scope JOIN inventory_comparison_eligible_scopes s ON s.tenant=w.tenant AND s.scope_id=w.scope_id WHERE w.completed_version<w.work_version
 UNION ALL SELECT j.tenant,j.generation_id FROM inventory_projection_jobs j JOIN inventory_comparison_eligible_scopes s ON s.tenant=j.tenant AND s.scope_id=j.scope_id AND s.config_version=j.config_version WHERE j.completed_version<j.work_version
 UNION ALL SELECT j.tenant,j.generation_id FROM inventory_projection_coverage_jobs j JOIN inventory_comparison_eligible_scopes s ON s.tenant=j.tenant AND s.scope_id=j.scope_id AND s.config_version=j.config_version WHERE j.completed_version<j.work_version;

CREATE TABLE inventory_comparison_activations (
 tenant TEXT NOT NULL, activation_id TEXT NOT NULL, generation_id TEXT NOT NULL, previous_generation TEXT,
 domain_version INTEGER NOT NULL, source_set_version INTEGER NOT NULL, lease_token TEXT NOT NULL, lease_fence INTEGER NOT NULL, prepared_at INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN('prepared','committed')), PRIMARY KEY(tenant,activation_id), UNIQUE(tenant,generation_id), FOREIGN KEY(tenant,generation_id) REFERENCES index_generations(tenant,generation_id)
);
CREATE TRIGGER inventory_comparison_activation_admit BEFORE INSERT ON inventory_comparison_activations BEGIN
 SELECT CASE WHEN NEW.state!='prepared' OR NOT EXISTS(SELECT 1 FROM comparison_domains d JOIN accounts a ON a.id=d.tenant AND a.status='active' JOIN index_generations g ON g.tenant=d.tenant AND g.generation_id=d.pending_generation AND g.state='building' JOIN leases l ON l.tenant=d.tenant AND l.scope='inventory-comparison' AND l.token=NEW.lease_token AND l.fence=NEW.lease_fence AND l.expires_at>unixepoch('subsec')*1000 WHERE d.tenant=NEW.tenant AND d.pending_generation=NEW.generation_id AND d.active_generation IS NEW.previous_generation AND d.version=NEW.domain_version AND d.source_set_version=NEW.source_set_version AND NEW.prepared_at>0 AND NEW.prepared_at<=unixepoch('subsec')*1000)
 OR EXISTS(SELECT 1 FROM inventory_comparison_generation_debt x WHERE x.tenant=NEW.tenant AND x.generation_id=NEW.generation_id) THEN RAISE(ABORT,'comparison activation authority or work changed') END;
END;
CREATE TRIGGER inventory_comparison_activation_commit BEFORE UPDATE ON inventory_comparison_activations BEGIN
 SELECT CASE WHEN OLD.state!='prepared' OR NEW.state!='committed' OR NOT EXISTS(SELECT 1 FROM comparison_domains d JOIN accounts a ON a.id=d.tenant AND a.status='active' JOIN index_generations g ON g.tenant=d.tenant AND g.generation_id=d.active_generation AND g.state='active' JOIN leases l ON l.tenant=d.tenant AND l.scope='inventory-comparison' AND l.token=OLD.lease_token AND l.fence=OLD.lease_fence AND l.expires_at>unixepoch('subsec')*1000 WHERE d.tenant=OLD.tenant AND d.active_generation=OLD.generation_id AND d.pending_generation IS NULL AND d.version=OLD.domain_version+1 AND d.source_set_version=OLD.source_set_version)
 OR EXISTS(SELECT 1 FROM inventory_comparison_generation_debt x WHERE x.tenant=OLD.tenant AND x.generation_id=OLD.generation_id) THEN RAISE(ABORT,'comparison activation publication changed') END;
END;
CREATE TRIGGER inventory_comparison_activation_identity BEFORE UPDATE ON inventory_comparison_activations WHEN (NEW.tenant,NEW.activation_id,NEW.generation_id,NEW.previous_generation,NEW.domain_version,NEW.source_set_version,NEW.lease_token,NEW.lease_fence,NEW.prepared_at) IS NOT (OLD.tenant,OLD.activation_id,OLD.generation_id,OLD.previous_generation,OLD.domain_version,OLD.source_set_version,OLD.lease_token,OLD.lease_fence,OLD.prepared_at) BEGIN SELECT RAISE(ABORT,'immutable comparison activation'); END;
CREATE TRIGGER inventory_comparison_activation_delete BEFORE DELETE ON inventory_comparison_activations WHEN OLD.state!='committed' OR OLD.prepared_at>unixepoch('subsec')*1000-604800000 BEGIN SELECT RAISE(ABORT,'retained comparison activation'); END;
