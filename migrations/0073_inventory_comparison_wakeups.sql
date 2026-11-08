-- One reusable metadata outbox row per coordinator. Retain its clock when idle
-- so a delayed Queue acknowledgement cannot become a new wakeup's receipt.
CREATE TABLE inventory_comparison_wakeups (
 tenant TEXT NOT NULL PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 control_version INTEGER NOT NULL CHECK(control_version>0), work_version INTEGER NOT NULL CHECK(work_version>0),
 not_before INTEGER CHECK(not_before IS NULL OR not_before>=0), published_at INTEGER NOT NULL DEFAULT 0 CHECK(published_at>=0),
 FOREIGN KEY(tenant) REFERENCES accounts(id)
);
CREATE INDEX inventory_comparison_wakeup_new ON inventory_comparison_wakeups(not_before,tenant) WHERE not_before IS NOT NULL AND published_at=0;
CREATE INDEX inventory_comparison_wakeup_recovery ON inventory_comparison_wakeups(published_at,not_before,tenant) WHERE not_before IS NOT NULL AND published_at>0;
CREATE VIEW inventory_comparison_wakeup_basis AS
 SELECT c.tenant,c.version AS control_version,c.work_version,
 CASE WHEN a.status!='active' OR NOT EXISTS(SELECT 1 FROM inventory_scopes s JOIN connections k ON k.tenant=s.tenant AND k.id=s.connection_id AND k.status='active' AND k.kind=s.provider AND k.remote_identity=s.logical_identity WHERE s.tenant=c.tenant AND s.state='observing') THEN NULL
 WHEN c.idle_turns<c.phase_count OR c.observed_version<c.work_version THEN 0 ELSE nullif(c.next_due_at,0) END AS due_at
 FROM inventory_comparison_coordinators c JOIN accounts a ON a.id=c.tenant;
INSERT INTO inventory_comparison_wakeups(tenant,control_version,work_version,not_before)
 SELECT tenant,control_version,work_version,CASE due_at WHEN 0 THEN CAST(unixepoch('subsec')*1000 AS INTEGER) ELSE due_at END FROM inventory_comparison_wakeup_basis;
CREATE TRIGGER inventory_comparison_wakeup_insert BEFORE INSERT ON inventory_comparison_wakeups BEGIN
 SELECT CASE WHEN NEW.version!=1 OR NEW.published_at!=0 OR NOT EXISTS(SELECT 1 FROM inventory_comparison_wakeup_basis b WHERE b.tenant=NEW.tenant AND b.control_version=NEW.control_version AND b.work_version=NEW.work_version AND ((b.due_at IS NULL AND NEW.not_before IS NULL) OR (b.due_at=0 AND NEW.not_before BETWEEN 0 AND unixepoch('subsec')*1000) OR (b.due_at>0 AND NEW.not_before=b.due_at))) THEN RAISE(ABORT,'comparison wakeup binding invalid') END;
END;
CREATE TRIGGER inventory_comparison_wakeup_update BEFORE UPDATE ON inventory_comparison_wakeups BEGIN
 SELECT CASE WHEN NEW.tenant!=OLD.tenant OR NEW.version<OLD.version OR NEW.version>OLD.version+1 THEN RAISE(ABORT,'comparison wakeup clock changed') END;
 SELECT CASE WHEN NEW.version!=OLD.version AND (NEW.published_at!=0 OR (NEW.control_version,NEW.work_version)=(OLD.control_version,OLD.work_version) OR NOT EXISTS(SELECT 1 FROM inventory_comparison_wakeup_basis b WHERE b.tenant=NEW.tenant AND b.control_version=NEW.control_version AND b.work_version=NEW.work_version AND ((b.due_at IS NULL AND NEW.not_before IS NULL) OR (b.due_at=0 AND NEW.not_before BETWEEN 0 AND unixepoch('subsec')*1000) OR (b.due_at>0 AND NEW.not_before=b.due_at)))) THEN RAISE(ABORT,'comparison wakeup signal changed progress') END;
 SELECT CASE WHEN NEW.version=OLD.version AND ((NEW.control_version,NEW.work_version,NEW.not_before) IS NOT (OLD.control_version,OLD.work_version,OLD.not_before) OR NEW.published_at<OLD.published_at OR NEW.published_at<=0 OR NEW.published_at>unixepoch('subsec')*1000 OR OLD.not_before IS NULL OR NOT EXISTS(SELECT 1 FROM inventory_runtime WHERE id=1 AND mode='inventory_read_only') OR NOT EXISTS(SELECT 1 FROM inventory_comparison_wakeup_basis b WHERE b.tenant=NEW.tenant AND b.control_version=NEW.control_version AND b.work_version=NEW.work_version AND b.due_at IS NOT NULL)) THEN RAISE(ABORT,'comparison wakeup publication changed') END;
END;
CREATE TRIGGER inventory_comparison_wakeup_delete BEFORE DELETE ON inventory_comparison_wakeups WHEN EXISTS(SELECT 1 FROM inventory_comparison_coordinators c WHERE c.tenant=OLD.tenant) BEGIN SELECT RAISE(ABORT,'retained comparison wakeup clock'); END;
CREATE TRIGGER inventory_comparison_outbox_insert AFTER INSERT ON inventory_comparison_coordinators BEGIN
 INSERT INTO inventory_comparison_wakeups(tenant,control_version,work_version,not_before)
 SELECT tenant,control_version,work_version,CASE due_at WHEN 0 THEN CAST(unixepoch('subsec')*1000 AS INTEGER) ELSE due_at END FROM inventory_comparison_wakeup_basis WHERE tenant=NEW.tenant
 ON CONFLICT(tenant) DO UPDATE SET version=inventory_comparison_wakeups.version+1,control_version=excluded.control_version,work_version=excluded.work_version,not_before=excluded.not_before,published_at=0;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_comparison_wakeups w WHERE w.tenant=NEW.tenant AND w.control_version=NEW.version AND w.work_version=NEW.work_version AND w.published_at=0) THEN RAISE(ABORT,'comparison wakeup missing') END;
END;
CREATE TRIGGER inventory_comparison_outbox_update AFTER UPDATE ON inventory_comparison_coordinators BEGIN
 INSERT INTO inventory_comparison_wakeups(tenant,control_version,work_version,not_before)
 SELECT tenant,control_version,work_version,CASE due_at WHEN 0 THEN CAST(unixepoch('subsec')*1000 AS INTEGER) ELSE due_at END FROM inventory_comparison_wakeup_basis WHERE tenant=NEW.tenant
 ON CONFLICT(tenant) DO UPDATE SET version=inventory_comparison_wakeups.version+1,control_version=excluded.control_version,work_version=excluded.work_version,not_before=excluded.not_before,published_at=0;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_comparison_wakeups w WHERE w.tenant=NEW.tenant AND w.control_version=NEW.version AND w.work_version=NEW.work_version AND w.published_at=0) THEN RAISE(ABORT,'comparison wakeup missing') END;
END;
