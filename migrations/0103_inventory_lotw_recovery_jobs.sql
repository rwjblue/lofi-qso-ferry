-- A possible upload schedules readback in the claim transaction, including
-- when the Worker disappears before receiving any file response.
CREATE TABLE inventory_lotw_recovery_jobs (
 tenant TEXT NOT NULL,batch_id TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 turns INTEGER NOT NULL DEFAULT 0 CHECK(turns BETWEEN 0 AND 6),
 due_at INTEGER,
 published_version INTEGER NOT NULL DEFAULT 0 CHECK(published_version BETWEEN 0 AND version),
 published_at INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant,batch_id),
 FOREIGN KEY(tenant,batch_id) REFERENCES inventory_lotw_dispatches(tenant,batch_id),
 CHECK((due_at IS NULL)=(turns=6)),
 CHECK(due_at IS NULL OR due_at>0)
);
CREATE INDEX inventory_lotw_recovery_due ON inventory_lotw_recovery_jobs(due_at,tenant,batch_id) WHERE due_at IS NOT NULL;
INSERT INTO inventory_lotw_recovery_jobs(tenant,batch_id,due_at)
 SELECT tenant,batch_id,claimed_at+60000 FROM inventory_lotw_dispatch_pending;
CREATE TRIGGER inventory_lotw_recovery_enqueue AFTER INSERT ON inventory_lotw_dispatches BEGIN
 INSERT INTO inventory_lotw_recovery_jobs(tenant,batch_id,due_at) VALUES(NEW.tenant,NEW.batch_id,NEW.claimed_at+60000);
END;
CREATE TRIGGER inventory_lotw_recovery_settled AFTER UPDATE OF settled_at ON inventory_lotw_dispatches WHEN NEW.settled_at IS NOT NULL BEGIN
 DELETE FROM inventory_lotw_recovery_jobs WHERE tenant=NEW.tenant AND batch_id=NEW.batch_id;
END;
CREATE TRIGGER inventory_lotw_recovery_restore AFTER INSERT ON inventory_restore_locks BEGIN
 UPDATE inventory_lotw_recovery_jobs SET version=version+1,published_version=0,published_at=0 WHERE tenant=NEW.tenant;
END;
CREATE VIEW inventory_lotw_recovery_available AS
 SELECT j.* FROM inventory_lotw_recovery_jobs j
 JOIN inventory_lotw_dispatch_pending d USING(tenant,batch_id)
 JOIN inventory_lotw_batches h USING(tenant,batch_id)
 JOIN accounts a ON a.id=j.tenant AND a.status='active'
 JOIN connections c ON c.tenant=j.tenant AND c.kind='lotw' AND c.remote_identity=h.book_identity AND c.status='active'
 JOIN private_data p ON (p.tenant,p.connection,p.id,p.kind)=(c.tenant,c.id,c.credential_version,'credential')
 WHERE j.due_at IS NOT NULL AND json_extract(c.config,'$.readAccess')=1
 AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>unixepoch('subsec')*1000)
 AND NOT EXISTS(SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=j.tenant);
