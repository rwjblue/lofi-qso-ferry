-- The permanent association and encrypted ownership evidence survive proof
-- retirement. Only superseded comparison dependencies are collectable here.
DROP VIEW inventory_match_proof_retirable;
CREATE VIEW inventory_match_proof_retirable AS
 SELECT h.tenant,h.set_id,h.prepared_at+604800000 AS eligible_at
 FROM inventory_match_sets h WHERE h.state='committed'
 AND NOT EXISTS(SELECT 1 FROM match_results r INDEXED BY match_result_set WHERE (r.tenant,r.set_id)=(h.tenant,h.set_id))
 AND NOT EXISTS(SELECT 1 FROM inventory_qrz_attempts a WHERE (a.tenant,a.result_set)=(h.tenant,h.set_id))
 AND NOT EXISTS(SELECT 1 FROM inventory_lotw_batch_members m WHERE (m.tenant,m.result_set)=(h.tenant,h.set_id));

-- Leave the queue's indexed seven-day receipt floor stable when the operator
-- changes the cooling period. Apply the current policy at collection time.
CREATE VIEW inventory_match_proof_collectable AS
 SELECT p.tenant,p.set_id,p.eligible_at FROM inventory_match_proof_retirable p
 CROSS JOIN inventory_retention_policy c
 WHERE NOT EXISTS(SELECT 1 FROM inventory_historical_associations a
  WHERE (a.tenant,a.match_set)=(p.tenant,p.set_id)
  AND max(a.created_at,p.eligible_at-604800000)>unixepoch('subsec')*1000-c.settled_retention_days*86400000);

DROP TRIGGER inventory_match_proof_retirement_update;
CREATE TRIGGER inventory_match_proof_retirement_update BEFORE UPDATE ON inventory_match_proof_retirements
 WHEN (NEW.tenant,NEW.set_id,NEW.eligible_at) IS NOT (OLD.tenant,OLD.set_id,OLD.eligible_at)
 OR OLD.collected_at IS NOT NULL OR NEW.collected_at IS NULL
 OR NEW.collected_at>unixepoch('subsec')*1000
 OR NOT EXISTS(SELECT 1 FROM inventory_match_proof_collectable p WHERE (p.tenant,p.set_id)=(OLD.tenant,OLD.set_id))
 OR EXISTS(SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=OLD.tenant) BEGIN
 SELECT RAISE(ABORT,'inventory matching proof still pinned');
END;

-- Existing association pins permit dependency deletion only inside an
-- admitted retirement. Never relax the permanent association's row pin.
DROP TRIGGER inventory_history_pin_scopes;
DROP TRIGGER inventory_history_pin_coverage;
DROP TRIGGER inventory_history_pin_records;
DROP TRIGGER inventory_history_pin_probes;
DROP TRIGGER inventory_history_pin_tokens;
DROP TRIGGER inventory_history_pin_candidates;
CREATE TRIGGER inventory_history_pin_scopes BEFORE DELETE ON inventory_match_scopes WHEN EXISTS(SELECT 1 FROM inventory_historical_associations a WHERE (a.tenant,a.match_set)=(OLD.tenant,OLD.set_id)) AND NOT EXISTS(SELECT 1 FROM inventory_match_proof_retirements q WHERE (q.tenant,q.set_id)=(OLD.tenant,OLD.set_id) AND q.collected_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'inventory historical association pins matching evidence'); END;
CREATE TRIGGER inventory_history_pin_coverage BEFORE DELETE ON inventory_match_coverage WHEN EXISTS(SELECT 1 FROM inventory_historical_associations a WHERE (a.tenant,a.match_set)=(OLD.tenant,OLD.set_id)) AND NOT EXISTS(SELECT 1 FROM inventory_match_proof_retirements q WHERE (q.tenant,q.set_id)=(OLD.tenant,OLD.set_id) AND q.collected_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'inventory historical association pins matching evidence'); END;
CREATE TRIGGER inventory_history_pin_records BEFORE DELETE ON inventory_match_records WHEN EXISTS(SELECT 1 FROM inventory_historical_associations a WHERE (a.tenant,a.match_set)=(OLD.tenant,OLD.set_id)) AND NOT EXISTS(SELECT 1 FROM inventory_match_proof_retirements q WHERE (q.tenant,q.set_id)=(OLD.tenant,OLD.set_id) AND q.collected_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'inventory historical association pins matching evidence'); END;
CREATE TRIGGER inventory_history_pin_probes BEFORE DELETE ON inventory_match_probes WHEN EXISTS(SELECT 1 FROM inventory_historical_associations a WHERE (a.tenant,a.match_set)=(OLD.tenant,OLD.set_id)) AND NOT EXISTS(SELECT 1 FROM inventory_match_proof_retirements q WHERE (q.tenant,q.set_id)=(OLD.tenant,OLD.set_id) AND q.collected_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'inventory historical association pins matching evidence'); END;
CREATE TRIGGER inventory_history_pin_tokens BEFORE DELETE ON inventory_match_tokens WHEN EXISTS(SELECT 1 FROM inventory_historical_associations a WHERE (a.tenant,a.match_set)=(OLD.tenant,OLD.set_id)) AND NOT EXISTS(SELECT 1 FROM inventory_match_proof_retirements q WHERE (q.tenant,q.set_id)=(OLD.tenant,OLD.set_id) AND q.collected_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'inventory historical association pins matching evidence'); END;
CREATE TRIGGER inventory_history_pin_candidates BEFORE DELETE ON inventory_match_candidates WHEN EXISTS(SELECT 1 FROM inventory_historical_associations a WHERE (a.tenant,a.match_set)=(OLD.tenant,OLD.set_id)) AND NOT EXISTS(SELECT 1 FROM inventory_match_proof_retirements q WHERE (q.tenant,q.set_id)=(OLD.tenant,OLD.set_id) AND q.collected_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'inventory historical association pins matching evidence'); END;

-- Already superseded proofs were never queued under the old pin. Scan the
-- immutable association identity index in small pages. Future supersession
-- uses the existing native retirement trigger, including inserts behind this
-- one-time cursor.
CREATE TABLE inventory_settled_proof_census (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 cursor_tenant TEXT NOT NULL DEFAULT '',cursor_association TEXT NOT NULL DEFAULT '',
 complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN(0,1))
);
INSERT INTO inventory_settled_proof_census(singleton) VALUES(1);
CREATE TRIGGER inventory_settled_proof_census_queue AFTER UPDATE ON inventory_settled_proof_census
 WHEN (NEW.cursor_tenant,NEW.cursor_association)>(OLD.cursor_tenant,OLD.cursor_association) BEGIN
 INSERT INTO inventory_match_proof_retirements(tenant,set_id,eligible_at)
 SELECT p.tenant,p.set_id,p.eligible_at
 FROM inventory_historical_associations a CROSS JOIN inventory_match_proof_retirable p
 WHERE (a.tenant,a.id)>(OLD.cursor_tenant,OLD.cursor_association) AND (a.tenant,a.id)<=(NEW.cursor_tenant,NEW.cursor_association)
 AND (p.tenant,p.set_id)=(a.tenant,a.match_set)
 ON CONFLICT(tenant,set_id) DO NOTHING;
END;
