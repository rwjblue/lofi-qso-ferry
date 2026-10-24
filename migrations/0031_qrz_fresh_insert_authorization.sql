-- Legacy pins remain source-boundary authority. They are never reinterpreted as
-- permission for the separately gated first-insert path.
ALTER TABLE stage_guards ADD COLUMN authorization_mode TEXT NOT NULL DEFAULT 'source_boundary'
 CHECK(authorization_mode IN('source_boundary','qrz_fresh_insert'));
ALTER TABLE attempt_source_export_proofs ADD COLUMN authorization_mode TEXT NOT NULL DEFAULT 'source_boundary'
 CHECK(authorization_mode IN('source_boundary','qrz_fresh_insert'));
CREATE INDEX attempt_authorization_events ON attempt_events(tenant,attempt,state,at);

-- These views describe structural eligibility only, not consent or source proof.
-- The existing contact and event indexes keep lookups scoped to one ledger key.
CREATE VIEW qrz_fresh_insert_ledgers AS
 SELECT l.tenant,l.source,l.qso,l.destination FROM ledger l
 JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination
 WHERE d.kind='qrz' AND d.status='active'
  AND l.remote_id IS NULL AND (l.baseline_hash IS NULL OR l.baseline_hash=l.source_hash)
  AND l.remote_hash IS NULL AND l.sent_hash IS NULL AND l.provenance='unknown'
  AND l.confirmed=0 AND l.narrative!='remote_preserved'
  AND l.state IN('inventory_pending','missing_current_identity','live_new');

CREATE VIEW qrz_fresh_insert_attempt_conflicts AS
 SELECT a.tenant,a.source,a.qso,a.destination,a.id FROM attempts a
 LEFT JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id
 WHERE s.attempt IS NULL OR s.state NOT IN('cancelled','rejected') OR s.remote_id IS NOT NULL
  OR (s.dispatched_at IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM attempt_events e WHERE e.tenant=a.tenant AND e.attempt=a.id
    AND e.state='retry_scheduled' AND e.at>=s.dispatched_at AND e.at<=s.updated_at))
  OR EXISTS(SELECT 1 FROM attempt_events e WHERE e.tenant=a.tenant AND e.attempt=a.id
   AND e.state NOT IN('prepared','retry_scheduled','cancelled','rejected'));

CREATE VIEW qrz_fresh_insert_eligible AS
 SELECT l.* FROM qrz_fresh_insert_ledgers l WHERE NOT EXISTS(
  SELECT 1 FROM qrz_fresh_insert_attempt_conflicts a
  WHERE a.tenant=l.tenant AND a.source=l.source AND a.qso=l.qso AND a.destination=l.destination);

CREATE TRIGGER stage_qrz_fresh_insert BEFORE INSERT ON stage_guards
WHEN NEW.authorization_mode='qrz_fresh_insert' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM qrz_fresh_insert_eligible l
  WHERE l.tenant=NEW.tenant AND l.source=NEW.source AND l.qso=NEW.qso AND l.destination=NEW.destination)
 THEN RAISE(ABORT,'QRZ fresh insert unavailable before stage') END;
END;
CREATE TRIGGER stage_authorization_mode_immutable BEFORE UPDATE OF authorization_mode ON stage_guards BEGIN
 SELECT RAISE(ABORT,'source export authorization mode is immutable');
END;

-- Recheck after the stage guard: callers cannot use a mapping/receipt race or a
-- forged guard update to turn an old identity correction into a first insertion.
CREATE TRIGGER attempt_qrz_fresh_insert BEFORE INSERT ON attempts
WHEN EXISTS(SELECT 1 FROM stage_guards g WHERE g.id=NEW.id AND g.tenant=NEW.tenant AND g.authorization_mode='qrz_fresh_insert') BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM qrz_fresh_insert_eligible l
  WHERE l.tenant=NEW.tenant AND l.source=NEW.source AND l.qso=NEW.qso AND l.destination=NEW.destination)
 THEN RAISE(ABORT,'QRZ fresh insert unavailable for attempt') END;
END;

DROP TRIGGER attempt_source_export_proof_after;
CREATE TRIGGER attempt_source_export_proof_after AFTER INSERT ON attempts BEGIN
 INSERT INTO attempt_source_export_proofs(tenant,attempt,proof_id,authorization_mode)
 SELECT NEW.tenant,NEW.id,g.source_export_proof_id,g.authorization_mode
 FROM stage_guards g WHERE g.id=NEW.id AND g.tenant=NEW.tenant;
END;
DROP TRIGGER attempt_source_export_pin_before;
CREATE TRIGGER attempt_source_export_pin_before BEFORE INSERT ON attempt_source_export_proofs BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM attempt_source_export_proofs WHERE tenant=NEW.tenant AND attempt=NEW.attempt)
  OR NOT EXISTS(
   SELECT 1 FROM attempts a JOIN stage_guards g ON g.tenant=a.tenant AND g.id=a.id
   JOIN source_export_proofs_current p ON p.tenant=g.tenant AND p.id=g.source_export_proof_id
   WHERE a.tenant=NEW.tenant AND a.id=NEW.attempt AND p.id=NEW.proof_id
    AND g.authorization_mode=NEW.authorization_mode
    AND g.source=a.source AND g.qso=a.qso AND g.destination=a.destination AND g.generation=a.generation
    AND p.source=a.source AND p.qso=a.qso AND json_extract(p.proof,'$.generation')=a.generation
  ) THEN RAISE(ABORT,'source export proof unavailable for pin') END;
END;

-- A fresh pin may enter dispatch only through the normal prepared transition.
-- Missing-state and prior uncertain artifacts cannot be reinserted as dispatching.
CREATE TRIGGER qrz_fresh_insert_state_insert BEFORE INSERT ON attempt_state
WHEN EXISTS(SELECT 1 FROM attempt_source_export_proofs p WHERE p.tenant=NEW.tenant AND p.attempt=NEW.attempt AND p.authorization_mode='qrz_fresh_insert') BEGIN
 SELECT CASE WHEN NEW.state!='prepared' OR NOT EXISTS(
  SELECT 1 FROM stage_guards g WHERE g.tenant=NEW.tenant AND g.id=NEW.attempt AND g.authorization_mode='qrz_fresh_insert')
 THEN RAISE(ABORT,'QRZ fresh insert unavailable for initial attempt state') END;
END;
CREATE TRIGGER qrz_fresh_insert_dispatch_transition BEFORE UPDATE OF state ON attempt_state
WHEN NEW.state='dispatching' AND EXISTS(SELECT 1 FROM attempt_source_export_proofs p WHERE p.tenant=NEW.tenant AND p.attempt=NEW.attempt AND p.authorization_mode='qrz_fresh_insert') BEGIN
 SELECT CASE WHEN OLD.state!='prepared' THEN RAISE(ABORT,'QRZ fresh insert unavailable for dispatch transition') END;
END;

DROP VIEW attempt_source_export_proofs_current;
CREATE VIEW attempt_source_export_proofs_current AS
 SELECT pin.tenant,pin.attempt,pin.proof_id,p.created_at,p.expires_at,pin.authorization_mode
 FROM attempt_source_export_proofs pin
 JOIN attempts a ON a.tenant=pin.tenant AND a.id=pin.attempt
 JOIN source_export_proofs_current p ON p.tenant=pin.tenant AND p.id=pin.proof_id AND p.source=a.source AND p.qso=a.qso
 JOIN ledger l ON l.tenant=a.tenant AND l.source=a.source AND l.qso=a.qso AND l.destination=a.destination
 WHERE json_extract(p.proof,'$.generation')=a.generation AND l.generation=a.generation
  AND l.source_hash=a.source_hash AND l.context_generation=json_extract(p.proof,'$.contextGeneration')
  AND l.operation_id IS json_extract(p.proof,'$.operationId')
  AND (pin.authorization_mode='source_boundary' OR (
   pin.authorization_mode='qrz_fresh_insert'
   AND EXISTS(SELECT 1 FROM qrz_fresh_insert_ledgers f
    WHERE f.tenant=a.tenant AND f.source=a.source AND f.qso=a.qso AND f.destination=a.destination)
   AND NOT EXISTS(SELECT 1 FROM qrz_fresh_insert_attempt_conflicts previous
    WHERE previous.tenant=a.tenant AND previous.source=a.source AND previous.qso=a.qso
     AND previous.destination=a.destination AND previous.id!=a.id)
   AND NOT EXISTS(SELECT 1 FROM attempt_events e WHERE e.tenant=a.tenant AND e.attempt=a.id
    AND e.state NOT IN('prepared','retry_scheduled','cancelled','rejected'))
   AND (EXISTS(SELECT 1 FROM attempt_state own WHERE own.tenant=a.tenant AND own.attempt=a.id
     AND own.state IN('prepared','dispatching') AND own.remote_id IS NULL
     AND (own.state='dispatching' OR own.dispatched_at IS NULL OR EXISTS(
      SELECT 1 FROM attempt_events receipt WHERE receipt.tenant=a.tenant AND receipt.attempt=a.id
       AND receipt.state='retry_scheduled' AND receipt.at>=own.dispatched_at AND receipt.at<=own.updated_at)))
    OR (NOT EXISTS(SELECT 1 FROM attempt_state own WHERE own.tenant=a.tenant AND own.attempt=a.id)
     AND EXISTS(SELECT 1 FROM stage_guards g WHERE g.tenant=a.tenant AND g.id=a.id AND g.authorization_mode='qrz_fresh_insert')))));
