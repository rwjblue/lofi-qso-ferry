-- Only the complete currently authorized batch may receive a pre-claim turn.
-- Once a claim is durable, recovery owns the file and all of its members.
CREATE TABLE inventory_lotw_send_jobs (
 tenant TEXT NOT NULL,batch_id TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 turns INTEGER NOT NULL DEFAULT 0 CHECK(turns BETWEEN 0 AND 3),
 due_at INTEGER CHECK(due_at>0),hold_reason TEXT,
 published_version INTEGER NOT NULL DEFAULT 0 CHECK(published_version BETWEEN 0 AND version),
 published_at INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant,batch_id),
 FOREIGN KEY(tenant,batch_id) REFERENCES inventory_lotw_batches(tenant,batch_id),
 CHECK((due_at IS NULL)=(hold_reason IS NOT NULL))
);
CREATE VIEW inventory_lotw_send_candidates AS
 SELECT h.tenant,h.batch_id,h.source_scope,h.destination,h.destination_connection,p.expires_at
 FROM inventory_lotw_batch_current c JOIN inventory_lotw_batches h USING(tenant,batch_id)
 JOIN inventory_source_proofs p ON (p.tenant,p.proof_id)=(h.tenant,h.proof_id)
 WHERE NOT EXISTS(SELECT 1 FROM inventory_fresh_start_lock WHERE id=1);
CREATE TRIGGER inventory_lotw_send_job_claimed AFTER INSERT ON inventory_lotw_dispatches BEGIN
 DELETE FROM inventory_lotw_send_jobs WHERE tenant=NEW.tenant AND batch_id=NEW.batch_id;
END;
CREATE TRIGGER inventory_lotw_send_job_cancelled AFTER UPDATE OF cancelled_at ON inventory_lotw_batches WHEN NEW.cancelled_at IS NOT NULL BEGIN
 DELETE FROM inventory_lotw_send_jobs WHERE tenant=NEW.tenant AND batch_id=NEW.batch_id;
END;
