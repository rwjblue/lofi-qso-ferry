-- Stop comparison workers while widening their metadata control. No contact,
-- account-link, credential or encryption identity is rebuilt by this migration.
DROP TRIGGER inventory_comparison_wake_ingestion;
DROP TRIGGER inventory_comparison_wake_projection;
DROP TRIGGER inventory_comparison_wake_generation;
DROP TRIGGER inventory_comparison_wake_generation_state;
DROP TRIGGER inventory_comparison_wake_scope;
DROP TRIGGER inventory_comparison_wake_scope_update;
DROP TRIGGER inventory_matching_pair_wake_insert;
DROP TRIGGER inventory_matching_pair_wake_update;
CREATE TABLE inventory_comparison_coordinators_next (
 tenant TEXT NOT NULL PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 work_version INTEGER NOT NULL DEFAULT 1 CHECK(work_version>0), observed_version INTEGER NOT NULL DEFAULT 0,
 phase_count INTEGER NOT NULL DEFAULT 10 CHECK(phase_count BETWEEN 1 AND 32), phase INTEGER NOT NULL DEFAULT 0 CHECK(phase>=0 AND phase<phase_count),
 idle_turns INTEGER NOT NULL DEFAULT 0 CHECK(idle_turns>=0 AND idle_turns<=phase_count), next_due_at INTEGER NOT NULL DEFAULT 0 CHECK(next_due_at>=0),
 build_generation TEXT NOT NULL DEFAULT '', build_scope TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0,
 FOREIGN KEY(tenant) REFERENCES accounts(id), CHECK(observed_version>=0 AND observed_version<=work_version)
);
INSERT INTO inventory_comparison_coordinators_next(tenant,version,work_version,observed_version,phase,build_generation,build_scope,updated_at)
 SELECT tenant,version,work_version,observed_version,phase,build_generation,build_scope,updated_at FROM inventory_comparison_coordinators;
DROP TABLE inventory_comparison_coordinators;
ALTER TABLE inventory_comparison_coordinators_next RENAME TO inventory_comparison_coordinators;
CREATE INDEX inventory_comparison_coordinator_due ON inventory_comparison_coordinators(tenant) WHERE idle_turns<phase_count OR observed_version<work_version;
CREATE INDEX inventory_comparison_coordinator_retry ON inventory_comparison_coordinators(next_due_at,tenant) WHERE next_due_at>0;
CREATE TRIGGER inventory_comparison_control_update BEFORE UPDATE ON inventory_comparison_coordinators BEGIN
 SELECT CASE WHEN NEW.tenant!=OLD.tenant OR NEW.phase_count!=OLD.phase_count OR NEW.version<OLD.version OR NEW.work_version<OLD.work_version OR NEW.observed_version<OLD.observed_version THEN RAISE(ABORT,'comparison coordinator regressed') END;
 SELECT CASE WHEN NEW.work_version!=OLD.work_version AND (NEW.work_version!=OLD.work_version+1 OR (NEW.version,NEW.observed_version,NEW.phase,NEW.idle_turns,NEW.next_due_at,NEW.build_generation,NEW.build_scope,NEW.updated_at) IS NOT (OLD.version,OLD.observed_version,OLD.phase,OLD.idle_turns,OLD.next_due_at,OLD.build_generation,OLD.build_scope,OLD.updated_at)) THEN RAISE(ABORT,'comparison wakeup changed progress') END;
 SELECT CASE WHEN NEW.work_version=OLD.work_version AND (NEW.version!=OLD.version+1 OR NEW.observed_version!=NEW.work_version OR NOT EXISTS(SELECT 1 FROM leases l JOIN accounts a ON a.id=l.tenant AND a.status='active' WHERE l.tenant=OLD.tenant AND l.scope='inventory-comparison' AND l.expires_at>unixepoch('subsec')*1000)) THEN RAISE(ABORT,'comparison coordinator lease missing') END;
END;
CREATE TRIGGER inventory_comparison_wake_ingestion AFTER UPDATE ON ingestion_pages WHEN OLD.state='prepared' AND NEW.state='committed' BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
CREATE TRIGGER inventory_comparison_wake_projection AFTER UPDATE ON comparison_projection_pages WHEN OLD.state='prepared' AND NEW.state='committed' BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
CREATE TRIGGER inventory_comparison_wake_generation AFTER INSERT ON index_generations BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
CREATE TRIGGER inventory_comparison_wake_generation_state AFTER UPDATE OF state ON index_generations WHEN NEW.state!=OLD.state BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
CREATE TRIGGER inventory_comparison_wake_scope AFTER INSERT ON inventory_scopes BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
CREATE TRIGGER inventory_comparison_wake_scope_update AFTER UPDATE OF config_version,state ON inventory_scopes WHEN NEW.config_version!=OLD.config_version OR NEW.state!=OLD.state BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
CREATE TRIGGER inventory_matching_pair_wake_insert AFTER INSERT ON inventory_matching_pair_jobs BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
CREATE TRIGGER inventory_matching_pair_wake_update AFTER UPDATE OF work_version ON inventory_matching_pair_jobs WHEN NEW.work_version!=OLD.work_version BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
CREATE TRIGGER inventory_comparison_wake_operation_commit AFTER UPDATE OF state ON inventory_projection_job_pages WHEN OLD.state='prepared' AND NEW.state='committed' BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
CREATE TRIGGER inventory_comparison_wake_coverage_projection_commit AFTER UPDATE OF state ON inventory_projection_coverage_pages WHEN OLD.state='prepared' AND NEW.state='committed' BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
CREATE TRIGGER inventory_comparison_wake_pair_commit AFTER UPDATE OF state ON inventory_matching_pair_pages WHEN OLD.state='prepared' AND NEW.state='committed' BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
CREATE TRIGGER inventory_comparison_wake_bucket_commit AFTER UPDATE OF state ON inventory_matching_bucket_pages WHEN OLD.state='prepared' AND NEW.state='committed' BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
CREATE TRIGGER inventory_comparison_wake_coverage_dispatch_commit AFTER UPDATE OF state ON inventory_matching_coverage_dispatches WHEN OLD.state='prepared' AND NEW.state='committed' BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
CREATE TRIGGER inventory_comparison_wake_coverage_match_commit AFTER UPDATE OF state ON inventory_matching_coverage_pages WHEN OLD.state='prepared' AND NEW.state='committed' BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
CREATE TRIGGER inventory_comparison_wake_matching_commit AFTER UPDATE OF state ON inventory_match_sets WHEN OLD.state='prepared' AND NEW.state='committed' BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
CREATE TRIGGER inventory_comparison_wake_account AFTER UPDATE OF status ON accounts WHEN NEW.status!=OLD.status AND EXISTS(SELECT 1 FROM inventory_scopes s WHERE s.tenant=NEW.id) BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.id) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
CREATE TRIGGER inventory_comparison_wake_connection AFTER UPDATE OF status,kind,remote_identity ON connections WHEN (NEW.status,NEW.kind,NEW.remote_identity) IS NOT (OLD.status,OLD.kind,OLD.remote_identity) AND EXISTS(SELECT 1 FROM inventory_scopes s WHERE s.tenant=NEW.tenant AND s.connection_id=NEW.id) BEGIN INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1; END;
