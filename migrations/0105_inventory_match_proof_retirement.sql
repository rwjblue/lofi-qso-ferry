-- Retire bulky comparison dependencies after the receipt horizon. Keep the
-- original header and result rows for retries and durable work receipts.
CREATE INDEX inventory_history_match_set ON inventory_historical_associations(tenant,match_set);
CREATE INDEX inventory_qrz_attempt_match_set ON inventory_qrz_attempts(tenant,result_set);
CREATE INDEX inventory_lotw_member_match_set ON inventory_lotw_batch_members(tenant,result_set);

CREATE VIEW inventory_match_proof_retirable AS
 SELECT h.tenant,h.set_id,h.prepared_at+604800000 AS eligible_at
 FROM inventory_match_sets h WHERE h.state='committed'
 AND NOT EXISTS(SELECT 1 FROM match_results r INDEXED BY match_result_set WHERE (r.tenant,r.set_id)=(h.tenant,h.set_id))
 AND NOT EXISTS(SELECT 1 FROM inventory_historical_associations a WHERE (a.tenant,a.match_set)=(h.tenant,h.set_id))
 AND NOT EXISTS(SELECT 1 FROM inventory_qrz_attempts a WHERE (a.tenant,a.result_set)=(h.tenant,h.set_id))
 AND NOT EXISTS(SELECT 1 FROM inventory_lotw_batch_members m WHERE (m.tenant,m.result_set)=(h.tenant,h.set_id));

CREATE TABLE inventory_match_proof_retirements (
 tenant TEXT NOT NULL,set_id TEXT NOT NULL,eligible_at INTEGER NOT NULL,collected_at INTEGER,
 PRIMARY KEY(tenant,set_id),
 FOREIGN KEY(tenant,set_id) REFERENCES inventory_match_sets(tenant,set_id),
 CHECK(collected_at IS NULL OR collected_at>eligible_at)
);
CREATE INDEX inventory_match_proof_retirement_due ON inventory_match_proof_retirements(eligible_at,tenant,set_id) WHERE collected_at IS NULL;

CREATE TRIGGER inventory_match_proof_retirement_insert BEFORE INSERT ON inventory_match_proof_retirements
 WHEN NEW.collected_at IS NOT NULL OR NOT EXISTS(
  SELECT 1 FROM inventory_match_proof_retirable h WHERE (h.tenant,h.set_id,h.eligible_at)=(NEW.tenant,NEW.set_id,NEW.eligible_at)
 ) BEGIN
 SELECT RAISE(ABORT,'inventory matching proof still pinned');
END;
CREATE TRIGGER inventory_match_proof_retirement_delete BEFORE DELETE ON inventory_match_proof_retirements
 BEGIN
 SELECT RAISE(ABORT,'retained inventory matching proof retirement');
END;
CREATE TRIGGER inventory_match_proof_retirement_update BEFORE UPDATE ON inventory_match_proof_retirements
 WHEN (NEW.tenant,NEW.set_id,NEW.eligible_at) IS NOT (OLD.tenant,OLD.set_id,OLD.eligible_at)
 OR OLD.collected_at IS NOT NULL OR NEW.collected_at IS NULL
 OR NEW.collected_at>unixepoch('subsec')*1000
 OR NOT EXISTS(SELECT 1 FROM inventory_match_proof_retirable h WHERE (h.tenant,h.set_id)=(OLD.tenant,OLD.set_id))
 OR EXISTS(SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=OLD.tenant)
 BEGIN
 SELECT RAISE(ABORT,'inventory matching proof still pinned');
END;

CREATE TRIGGER inventory_match_proof_retire AFTER DELETE ON inventory_match_live_sets BEGIN
 INSERT INTO inventory_match_proof_retirements(tenant,set_id,eligible_at)
 SELECT tenant,set_id,eligible_at FROM inventory_match_proof_retirable WHERE (tenant,set_id)=(OLD.tenant,OLD.set_id);
END;

INSERT INTO inventory_match_proof_retirements(tenant,set_id,eligible_at)
 SELECT tenant,set_id,eligible_at FROM inventory_match_proof_retirable;

CREATE TRIGGER inventory_match_proof_compact AFTER UPDATE OF collected_at ON inventory_match_proof_retirements BEGIN
 DELETE FROM inventory_match_candidates WHERE (tenant,set_id)=(OLD.tenant,OLD.set_id);
 DELETE FROM inventory_match_tokens WHERE (tenant,set_id)=(OLD.tenant,OLD.set_id);
 DELETE FROM inventory_match_probes WHERE (tenant,set_id)=(OLD.tenant,OLD.set_id);
 DELETE FROM inventory_match_records WHERE (tenant,set_id)=(OLD.tenant,OLD.set_id);
 DELETE FROM inventory_match_coverage WHERE (tenant,set_id)=(OLD.tenant,OLD.set_id);
 DELETE FROM inventory_match_scopes WHERE (tenant,set_id)=(OLD.tenant,OLD.set_id);
END;

-- A compacted proof has an acknowledgement receipt but no usable dependency
-- closure. Preserve that distinction for currentness checks.
DROP VIEW inventory_match_stale_sets;
CREATE VIEW inventory_match_stale_sets AS
 SELECT h.tenant,h.set_id FROM inventory_match_sets h WHERE
 NOT EXISTS(SELECT 1 FROM comparison_domains d JOIN accounts a ON a.id=d.tenant AND a.status='active' JOIN index_generations g ON g.tenant=d.tenant AND g.generation_id=d.active_generation AND g.state='active' WHERE d.tenant=h.tenant AND d.active_generation=h.generation_id AND d.source_set_version=h.source_set_version AND g.policy_version=h.policy_version)
 OR EXISTS(SELECT 1 FROM inventory_match_proof_retirements q WHERE (q.tenant,q.set_id)=(h.tenant,h.set_id) AND q.collected_at IS NOT NULL)
 UNION ALL SELECT tenant,set_id FROM inventory_match_stale_scopes
 UNION ALL SELECT tenant,set_id FROM inventory_match_stale_coverage
 UNION ALL SELECT tenant,set_id FROM inventory_match_stale_records
 UNION ALL SELECT tenant,set_id FROM inventory_match_stale_tokens;
