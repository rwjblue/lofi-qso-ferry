-- Index the committed artifacts that have never been claimed or cancelled.
-- Proof expiry remains authoritative, and held artifacts remain candidates.
CREATE TABLE inventory_qrz_retirement_candidates (
 tenant TEXT NOT NULL,attempt_id TEXT NOT NULL,
 PRIMARY KEY(tenant,attempt_id),
 FOREIGN KEY(tenant,attempt_id) REFERENCES inventory_qrz_attempts(tenant,attempt_id)
) WITHOUT ROWID;
CREATE TABLE inventory_lotw_retirement_candidates (
 tenant TEXT NOT NULL,batch_id TEXT NOT NULL,
 PRIMARY KEY(tenant,batch_id),
 FOREIGN KEY(tenant,batch_id) REFERENCES inventory_lotw_batches(tenant,batch_id)
) WITHOUT ROWID;

INSERT INTO inventory_qrz_retirement_candidates(tenant,attempt_id)
 SELECT a.tenant,a.attempt_id FROM inventory_qrz_attempts a
 JOIN inventory_qrz_preparations h USING(tenant,stage_id)
 WHERE a.cancelled_at IS NULL AND h.committed_at IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM inventory_qrz_dispatches d WHERE (d.tenant,d.attempt_id)=(a.tenant,a.attempt_id));
INSERT INTO inventory_lotw_retirement_candidates(tenant,batch_id)
 SELECT h.tenant,h.batch_id FROM inventory_lotw_batches h
 WHERE h.cancelled_at IS NULL AND h.committed_at IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM inventory_lotw_dispatches d WHERE (d.tenant,d.batch_id)=(h.tenant,h.batch_id));

CREATE TRIGGER inventory_qrz_retirement_enqueue AFTER UPDATE OF committed_at ON inventory_qrz_preparations
 WHEN NEW.committed_at IS NOT NULL BEGIN
 INSERT INTO inventory_qrz_retirement_candidates(tenant,attempt_id)
 SELECT a.tenant,a.attempt_id FROM inventory_qrz_attempts a
 WHERE (a.tenant,a.stage_id)=(NEW.tenant,NEW.stage_id) AND a.cancelled_at IS NULL;
END;
CREATE TRIGGER inventory_lotw_retirement_enqueue AFTER UPDATE OF committed_at ON inventory_lotw_batches
 WHEN NEW.committed_at IS NOT NULL AND NEW.cancelled_at IS NULL BEGIN
 INSERT INTO inventory_lotw_retirement_candidates(tenant,batch_id) VALUES(NEW.tenant,NEW.batch_id);
END;
CREATE TRIGGER inventory_qrz_retirement_claimed AFTER INSERT ON inventory_qrz_dispatches BEGIN
 DELETE FROM inventory_qrz_retirement_candidates WHERE (tenant,attempt_id)=(NEW.tenant,NEW.attempt_id);
END;
CREATE TRIGGER inventory_lotw_retirement_claimed AFTER INSERT ON inventory_lotw_dispatches BEGIN
 DELETE FROM inventory_lotw_retirement_candidates WHERE (tenant,batch_id)=(NEW.tenant,NEW.batch_id);
END;
CREATE TRIGGER inventory_qrz_retirement_cancelled AFTER UPDATE OF cancelled_at ON inventory_qrz_attempts
 WHEN NEW.cancelled_at IS NOT NULL BEGIN
 DELETE FROM inventory_qrz_retirement_candidates WHERE (tenant,attempt_id)=(NEW.tenant,NEW.attempt_id);
END;
CREATE TRIGGER inventory_lotw_retirement_cancelled AFTER UPDATE OF cancelled_at ON inventory_lotw_batches
 WHEN NEW.cancelled_at IS NOT NULL BEGIN
 DELETE FROM inventory_lotw_retirement_candidates WHERE (tenant,batch_id)=(NEW.tenant,NEW.batch_id);
END;
