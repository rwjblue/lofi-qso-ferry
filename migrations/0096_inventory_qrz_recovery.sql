-- A possible send creates recovery demand in the same native transaction.
-- Backfill unsettled claims if the database already has the dispatch schema.
CREATE TABLE inventory_qrz_recovery_jobs (
 tenant TEXT NOT NULL,attempt_id TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 turns INTEGER NOT NULL DEFAULT 0 CHECK(turns BETWEEN 0 AND 6),
 due_at INTEGER,
 published_version INTEGER NOT NULL DEFAULT 0 CHECK(published_version BETWEEN 0 AND version),
 published_at INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant,attempt_id),
 FOREIGN KEY(tenant,attempt_id) REFERENCES inventory_qrz_dispatches(tenant,attempt_id),
 CHECK((due_at IS NULL)=(turns=6)),
 CHECK(due_at IS NULL OR due_at>0)
);
CREATE INDEX inventory_qrz_recovery_due ON inventory_qrz_recovery_jobs(due_at,tenant,attempt_id) WHERE due_at IS NOT NULL;
INSERT INTO inventory_qrz_recovery_jobs(tenant,attempt_id,due_at)
 SELECT tenant,attempt_id,claimed_at+60000 FROM inventory_qrz_dispatch_pending;
CREATE TRIGGER inventory_qrz_recovery_enqueue AFTER INSERT ON inventory_qrz_dispatches BEGIN
 INSERT INTO inventory_qrz_recovery_jobs(tenant,attempt_id,due_at) VALUES(NEW.tenant,NEW.attempt_id,NEW.claimed_at+60000);
END;
CREATE TRIGGER inventory_qrz_recovery_settled AFTER INSERT ON inventory_qrz_dispatch_receipts BEGIN
 DELETE FROM inventory_qrz_recovery_jobs WHERE tenant=NEW.tenant AND attempt_id=NEW.attempt_id;
END;
CREATE VIEW inventory_qrz_recovery_available AS
 SELECT j.*,d.book_identity FROM inventory_qrz_recovery_jobs j
 JOIN inventory_qrz_dispatch_pending d USING(tenant,attempt_id)
 JOIN accounts a ON a.id=j.tenant AND a.status='active'
 JOIN connections c ON c.tenant=j.tenant AND c.kind='qrz' AND c.remote_identity=d.book_identity AND c.status='active'
 JOIN private_data p ON (p.tenant,p.connection,p.id,p.kind)=(c.tenant,c.id,c.credential_version,'credential')
 WHERE j.due_at IS NOT NULL AND json_extract(c.config,'$.bookId')=d.book_identity
 AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>unixepoch('subsec')*1000);
