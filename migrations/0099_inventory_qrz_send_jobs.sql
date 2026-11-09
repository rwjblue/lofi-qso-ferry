-- A wakeup schedules a bounded pre-claim turn. Only the dispatch claim can
-- authorize the wire request. The claim retires send work and creates readback
-- work in the same transaction.
CREATE TABLE inventory_qrz_send_jobs (
 tenant TEXT NOT NULL,attempt_id TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 turns INTEGER NOT NULL DEFAULT 0 CHECK(turns BETWEEN 0 AND 3),
 due_at INTEGER CHECK(due_at>0),hold_reason TEXT,
 published_version INTEGER NOT NULL DEFAULT 0 CHECK(published_version BETWEEN 0 AND version),
 published_at INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant,attempt_id),
 FOREIGN KEY(tenant,attempt_id) REFERENCES inventory_qrz_attempts(tenant,attempt_id),
 CHECK((due_at IS NULL)=(hold_reason IS NOT NULL))
);
CREATE VIEW inventory_qrz_send_candidates AS
 SELECT a.tenant,a.attempt_id,a.record_key,h.source_scope,h.destination,h.destination_connection,p.expires_at
 FROM inventory_qrz_attempts a
 JOIN inventory_qrz_attempt_current c USING(tenant,attempt_id)
 JOIN inventory_qrz_preparations h USING(tenant,stage_id)
 JOIN inventory_source_proofs p ON p.tenant=h.tenant AND p.proof_id=h.proof_id
 WHERE NOT EXISTS(SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=a.tenant)
 AND NOT EXISTS(SELECT 1 FROM inventory_fresh_start_lock WHERE id=1);

CREATE TRIGGER inventory_qrz_send_job_claimed AFTER INSERT ON inventory_qrz_dispatches BEGIN
 DELETE FROM inventory_qrz_send_jobs WHERE tenant=NEW.tenant AND attempt_id=NEW.attempt_id;
END;
CREATE TRIGGER inventory_qrz_send_job_cancelled AFTER UPDATE OF cancelled_at ON inventory_qrz_attempts WHEN NEW.cancelled_at IS NOT NULL BEGIN
 DELETE FROM inventory_qrz_send_jobs WHERE tenant=NEW.tenant AND attempt_id=NEW.attempt_id;
END;
