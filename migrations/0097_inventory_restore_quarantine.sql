-- Both restore entry points lock the account before revoking access. Capture
-- that boundary in the inventory schema, including snapshots locked earlier.
CREATE TABLE inventory_restore_locks (
 tenant TEXT PRIMARY KEY REFERENCES accounts(id),locked_at INTEGER NOT NULL CHECK(locked_at>0)
);
CREATE TRIGGER inventory_restore_lock_insert BEFORE INSERT ON inventory_restore_locks WHEN NOT EXISTS(
 SELECT 1 FROM accounts a WHERE a.id=NEW.tenant AND a.status='restore_locked'
) BEGIN
 SELECT RAISE(ABORT,'inventory restore lock requires a quarantined account');
END;
CREATE TRIGGER inventory_restore_lock_update BEFORE UPDATE ON inventory_restore_locks BEGIN SELECT RAISE(ABORT,'immutable inventory restore lock'); END;
CREATE TRIGGER inventory_restore_lock_delete BEFORE DELETE ON inventory_restore_locks BEGIN SELECT RAISE(ABORT,'retained inventory restore lock'); END;
CREATE TRIGGER inventory_restore_invalidate AFTER INSERT ON inventory_restore_locks BEGIN
 UPDATE inventory_scopes SET state='held',config_version=config_version+1 WHERE tenant=NEW.tenant;
 UPDATE inventory_source_proof_jobs SET phase='held',reason='restore_locked',version=version+1
 WHERE tenant=NEW.tenant AND phase IN('collecting','draining');
 UPDATE inventory_qrz_recovery_jobs SET version=version+1,published_version=0,published_at=0 WHERE tenant=NEW.tenant;
 UPDATE leases SET expires_at=0 WHERE tenant=NEW.tenant AND expires_at>0;
END;
CREATE TRIGGER inventory_restore_lock_account AFTER UPDATE OF status ON accounts
 WHEN NEW.status='restore_locked' AND NOT EXISTS(SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=NEW.id)
 BEGIN
 INSERT INTO inventory_restore_locks(tenant,locked_at) VALUES(NEW.id,CAST(unixepoch('subsec')*1000 AS INTEGER));
END;
INSERT INTO inventory_restore_locks(tenant,locked_at)
 SELECT id,CAST(unixepoch('subsec')*1000 AS INTEGER) FROM accounts WHERE status='restore_locked';

-- A prepared artifact could have been sent after the restored snapshot.
-- Preserve its reservation along with all claims and terminal receipts.
CREATE VIEW inventory_qrz_restore_pending AS
 SELECT a.tenant,a.attempt_id,l.locked_at,
        CASE WHEN d.attempt_id IS NULL THEN 'prepared_at_snapshot' ELSE 'may_have_sent' END AS prior_state
 FROM inventory_restore_locks l JOIN inventory_qrz_attempts a ON a.tenant=l.tenant
 JOIN inventory_qrz_preparations h USING(tenant,stage_id)
 LEFT JOIN inventory_qrz_dispatches d USING(tenant,attempt_id)
 WHERE a.cancelled_at IS NULL AND h.committed_at IS NOT NULL AND d.settled_at IS NULL;
DROP VIEW inventory_qrz_preparation_authority;
CREATE VIEW inventory_qrz_preparation_authority AS
 SELECT h.tenant,h.stage_id FROM inventory_qrz_preparations h
 JOIN inventory_source_proof_current p ON p.tenant=h.tenant AND p.proof_id=h.proof_id AND p.scope_id=h.source_scope
 JOIN active_templates t ON t.tenant=h.tenant AND t.destination=h.destination_connection AND t.version=h.template_version
 WHERE NOT EXISTS(SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=h.tenant);
CREATE TRIGGER inventory_qrz_restore_no_preparation BEFORE INSERT ON inventory_qrz_preparations WHEN EXISTS(
 SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=NEW.tenant
) BEGIN
 SELECT RAISE(ABORT,'inventory QRZ preparation changed');
END;
CREATE TRIGGER inventory_qrz_restore_no_cancel BEFORE UPDATE OF cancelled_at ON inventory_qrz_attempts WHEN EXISTS(
 SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=OLD.tenant
) BEGIN
 SELECT RAISE(ABORT,'inventory QRZ restore requires reconciliation');
END;

-- Managed mode retires the legacy writer. Restore alone may invalidate an
-- old context cursor, including one retained on a revoked account.
DROP TRIGGER inventory_retired_cursor_update;
CREATE TRIGGER inventory_retired_cursor_update BEFORE UPDATE ON cursors
 WHEN EXISTS(SELECT 1 FROM inventory_runtime WHERE mode='inventory_read_only')
 AND NOT (
  OLD.stream='context' AND (NEW.tenant,NEW.connection,NEW.stream,NEW.updated_at)=(OLD.tenant,OLD.connection,OLD.stream,OLD.updated_at)
  AND NEW.generation=OLD.generation+1
  AND NEW.cursor=CASE WHEN json_valid(OLD.cursor) THEN json_set(OLD.cursor,'$.complete',0) ELSE '{"complete":false}' END
  AND EXISTS(SELECT 1 FROM accounts a WHERE a.id=OLD.tenant AND a.status IN('restore_locked','revoked'))
 )
 BEGIN
 SELECT RAISE(ABORT,'legacy reader retired');
END;
