-- Widen immutable intent without reinterpreting any existing authorization.
-- Neither rebuilt table has incoming foreign keys. Copy every row before swap,
-- keep all original trigger guards, column order, defaults and outgoing FKs.
-- This migration supplies no operator consent, destination absence or source proof.


DROP TRIGGER attempt_qrz_fresh_insert;

DROP TRIGGER attempt_source_export_pin_before;

DROP TRIGGER attempt_source_export_pin_delete;

DROP TRIGGER attempt_source_export_pin_retention;

DROP TRIGGER attempt_source_export_pin_update;

DROP TRIGGER attempt_source_export_proof_after;

DROP TRIGGER attempt_source_export_proof_before;

DROP TRIGGER dispatch_source_export_proof;

DROP TRIGGER prepared_source_export_proof;

DROP TRIGGER qrz_fresh_insert_dispatch_transition;

DROP TRIGGER qrz_fresh_insert_state_insert;

DROP TRIGGER stage_authorization_mode_immutable;

DROP TRIGGER stage_guard;

DROP TRIGGER stage_identity_guard;

DROP TRIGGER stage_identity_reservation;

DROP TRIGGER stage_qrz_fresh_insert;

DROP TRIGGER stage_source_export_proof;

DROP TRIGGER stage_source_guard;

DROP TRIGGER stage_source_read_policy;

DROP VIEW attempt_source_export_proofs_current;

CREATE TABLE stage_guards_v2(id TEXT PRIMARY KEY,tenant TEXT,source TEXT,qso TEXT,destination TEXT,generation TEXT,template_version TEXT,now INTEGER,credential_version TEXT, identity_vendor TEXT, identity_hash TEXT, identity_source_version INTEGER, identity_lotw_owner_id TEXT, source_export_proof_id TEXT, source_export_scope TEXT, source_export_reconciliation_version INTEGER, authorization_mode TEXT NOT NULL DEFAULT 'source_boundary'
 CHECK(authorization_mode IN('source_boundary','qrz_fresh_insert','lotw_fresh_insert')));

INSERT INTO stage_guards_v2 SELECT * FROM stage_guards;

DROP TABLE stage_guards;

ALTER TABLE stage_guards_v2 RENAME TO stage_guards;

CREATE TABLE attempt_source_export_proofs_v2 (
 tenant TEXT NOT NULL,attempt TEXT NOT NULL,proof_id TEXT NOT NULL, authorization_mode TEXT NOT NULL DEFAULT 'source_boundary'
 CHECK(authorization_mode IN('source_boundary','qrz_fresh_insert','lotw_fresh_insert')),
 PRIMARY KEY(tenant,attempt),
 FOREIGN KEY(tenant,attempt) REFERENCES attempts(tenant,id),
 FOREIGN KEY(tenant,proof_id) REFERENCES source_export_proofs(tenant,id)
);

INSERT INTO attempt_source_export_proofs_v2 SELECT * FROM attempt_source_export_proofs;

DROP TABLE attempt_source_export_proofs;

ALTER TABLE attempt_source_export_proofs_v2 RENAME TO attempt_source_export_proofs;

CREATE INDEX attempt_source_export_proof_retention ON attempt_source_export_proofs(tenant,proof_id);

CREATE TRIGGER stage_guard BEFORE INSERT ON stage_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ledger WHERE tenant=NEW.tenant AND source=NEW.source AND qso=NEW.qso AND destination=NEW.destination AND generation=NEW.generation AND due_at<=NEW.now AND state IN('missing_current_identity','changed','live_new') AND (narrative='remote_preserved' AND NEW.template_version IS NULL OR narrative='template_bound' AND template_version=NEW.template_version OR narrative='unbound' AND (NEW.template_version IS NULL OR NEW.template_version=(SELECT version FROM active_templates WHERE tenant=NEW.tenant AND destination=NEW.destination)))) THEN RAISE(ABORT,'stale or ineligible stage') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM connections WHERE tenant=NEW.tenant AND id=NEW.destination AND kind='qrz') AND NEW.template_version IS NULL AND NOT EXISTS(SELECT 1 FROM ledger WHERE tenant=NEW.tenant AND source=NEW.source AND qso=NEW.qso AND destination=NEW.destination AND narrative='remote_preserved') THEN RAISE(ABORT,'QRZ template required') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM connections WHERE tenant=NEW.tenant AND id=NEW.destination AND status='active' AND credential_version=NEW.credential_version) THEN RAISE(ABORT,'inactive credential') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE a.tenant=NEW.tenant AND a.source=NEW.source AND a.qso=NEW.qso AND a.destination=NEW.destination AND s.state NOT IN('delivered','observed','rejected','cancelled')) THEN RAISE(ABORT,'unresolved attempt') END;
END;

CREATE TRIGGER stage_source_guard BEFORE INSERT ON stage_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM connections WHERE tenant=NEW.tenant AND id=NEW.source AND kind='lofi' AND status='active') THEN RAISE(ABORT,'source connection inactive') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ledger WHERE tenant=NEW.tenant AND source=NEW.source AND qso=NEW.qso AND destination=NEW.destination AND context_generation IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cursors WHERE tenant=NEW.tenant AND connection=NEW.source AND stream='context' AND generation=ledger.context_generation AND json_extract(cursor,'$.complete')=1)) THEN RAISE(ABORT,'source context changed before stage') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ledger l WHERE l.tenant=NEW.tenant AND l.source=NEW.source AND l.qso=NEW.qso AND l.destination=NEW.destination AND l.context_generation IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM source_work w WHERE w.tenant=l.tenant AND w.source=l.source AND w.id=l.qso AND w.kind='qso' AND w.state IN('pending','waiting') AND w.expires_at>NEW.now) OR l.operation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM source_work w WHERE w.tenant=l.tenant AND w.source=l.source AND w.id=l.operation_id AND w.kind='operation' AND w.state='context' AND w.expires_at>NEW.now))) THEN RAISE(ABORT,'source payload or operation context unavailable') END;
END;

CREATE TRIGGER stage_identity_guard BEFORE INSERT ON stage_guards WHEN NEW.identity_hash IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM connections d JOIN accounts a ON a.id=d.tenant WHERE d.tenant=NEW.tenant AND d.id=NEW.destination AND d.kind=NEW.identity_vendor AND d.status='active' AND a.status='active') THEN RAISE(ABORT,'outbound identity scope changed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ledger l WHERE l.tenant=NEW.tenant AND l.source=NEW.source AND l.qso=NEW.qso AND l.destination=NEW.destination AND l.provenance='adoption_conflict') OR EXISTS(SELECT 1 FROM destination_identity_claims c WHERE c.tenant=NEW.tenant AND c.destination=NEW.destination AND c.vendor=NEW.identity_vendor AND c.identity_hash=NEW.identity_hash AND (c.source!=NEW.source OR c.qso!=NEW.qso)) THEN RAISE(ABORT,'outbound identity claim conflict') END;
 SELECT CASE WHEN NEW.identity_vendor='qrz' AND EXISTS(SELECT 1 FROM legacy_qrz_identity_reservations r WHERE r.tenant=NEW.tenant AND r.destination=NEW.destination) THEN RAISE(ABORT,'legacy QRZ identity backfill required') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM legacy_outbound_identity_reservations r WHERE r.tenant=NEW.tenant AND r.destination=NEW.destination) THEN RAISE(ABORT,'legacy outbound identity backfill required') END;
 SELECT CASE WHEN NEW.identity_vendor='lotw' AND EXISTS(SELECT 1 FROM private_data p WHERE p.tenant=NEW.tenant AND p.connection=NEW.destination AND p.kind='lotw_identity' AND substr(p.id,-44)=':'||NEW.identity_hash AND p.id!=NEW.identity_lotw_owner_id AND p.revoked_at IS NULL) THEN RAISE(ABORT,'outbound identity claim conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ledger l WHERE l.tenant=NEW.tenant AND l.source=NEW.source AND l.qso=NEW.qso AND l.destination=NEW.destination AND l.context_generation IS NOT NULL AND (NEW.identity_source_version IS NULL OR NOT EXISTS(SELECT 1 FROM reconciliation_work r JOIN source_work w ON w.tenant=r.tenant AND w.source=r.source AND w.id=r.qso AND w.kind='qso' JOIN private_data p ON p.tenant=w.tenant AND p.connection=w.source AND p.id=w.private_id AND p.kind='source' WHERE r.tenant=l.tenant AND r.source=l.source AND r.qso=l.qso AND r.version=NEW.identity_source_version AND w.deleted=0 AND w.state IN('pending','waiting') AND w.expires_at>NEW.now AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>NEW.now)))) THEN RAISE(ABORT,'source changed before identity claim') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM connections s JOIN private_data p ON p.tenant=s.tenant AND p.connection=s.id AND p.id=s.credential_version AND p.kind='credential' WHERE s.tenant=NEW.tenant AND s.id=NEW.source AND s.status='active' AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>NEW.now)) OR NOT EXISTS(SELECT 1 FROM private_data p WHERE p.tenant=NEW.tenant AND p.connection=NEW.destination AND p.id=NEW.credential_version AND p.kind='credential' AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>NEW.now)) THEN RAISE(ABORT,'identity credential unavailable') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ledger l WHERE l.tenant=NEW.tenant AND l.source=NEW.source AND l.qso=NEW.qso AND l.destination=NEW.destination AND l.context_generation IS NOT NULL AND l.operation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM source_work o JOIN private_data op ON op.tenant=o.tenant AND op.connection=o.source AND op.id=o.private_id AND op.kind='source' WHERE o.tenant=l.tenant AND o.source=l.source AND o.id=l.operation_id AND o.kind='operation' AND o.state='context' AND o.deleted=0 AND o.expires_at>NEW.now AND op.revoked_at IS NULL AND (op.expires_at IS NULL OR op.expires_at>NEW.now) AND NOT EXISTS(SELECT 1 FROM source_work e LEFT JOIN private_data ep ON ep.tenant=e.tenant AND ep.connection=e.source AND ep.id=e.private_id AND ep.kind='source' WHERE e.tenant=o.tenant AND e.source=o.source AND e.operation_id=o.id AND e.kind='qso' AND e.is_event=1 AND e.deleted=0 AND (e.expires_at<=NEW.now OR ep.id IS NULL OR ep.revoked_at IS NOT NULL OR (ep.expires_at IS NOT NULL AND ep.expires_at<=NEW.now))))) THEN RAISE(ABORT,'source dependencies unavailable before identity claim') END;
END;

CREATE TRIGGER stage_identity_reservation AFTER INSERT ON stage_guards WHEN NEW.identity_hash IS NOT NULL BEGIN
 INSERT INTO destination_identity_claims(tenant,destination,vendor,identity_hash,source,qso,created_at) VALUES(NEW.tenant,NEW.destination,NEW.identity_vendor,NEW.identity_hash,NEW.source,NEW.qso,NEW.now) ON CONFLICT(tenant,destination,vendor,identity_hash) DO NOTHING;
END;

CREATE TRIGGER stage_source_read_policy BEFORE INSERT ON stage_guards
WHEN EXISTS(SELECT 1 FROM source_read_policies p WHERE p.tenant=NEW.tenant AND p.source=NEW.source) BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM source_read_contact_membership m JOIN ledger l
   ON l.tenant=m.tenant AND l.source=m.source AND l.qso=m.qso AND l.operation_id IS m.operation_id AND l.context_generation IS NOT NULL
  WHERE m.tenant=NEW.tenant AND m.source=NEW.source AND m.qso=NEW.qso AND l.destination=NEW.destination
 ) THEN RAISE(ABORT,'source read policy unavailable before stage') END;
END;

CREATE TRIGGER stage_source_export_proof BEFORE INSERT ON stage_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM source_export_proofs_current p
  JOIN ledger l ON l.tenant=p.tenant AND l.source=p.source AND l.qso=p.qso AND l.destination=NEW.destination
  WHERE p.tenant=NEW.tenant AND p.id=NEW.source_export_proof_id AND p.source=NEW.source AND p.qso=NEW.qso
   AND json_extract(p.proof,'$.scope')=NEW.source_export_scope
   AND json_extract(p.proof,'$.reconciliationVersion')=NEW.source_export_reconciliation_version
   AND json_extract(p.proof,'$.generation')=NEW.generation AND l.generation=NEW.generation
   AND l.context_generation=json_extract(p.proof,'$.contextGeneration') AND l.operation_id IS json_extract(p.proof,'$.operationId')
   AND p.created_at<=NEW.now AND p.expires_at>NEW.now
 ) THEN RAISE(ABORT,'source export proof unavailable before stage') END;
END;

CREATE TRIGGER attempt_source_export_proof_before BEFORE INSERT ON attempts BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM stage_guards g JOIN source_export_proofs_current p ON p.tenant=g.tenant AND p.id=g.source_export_proof_id
  JOIN ledger l ON l.tenant=g.tenant AND l.source=g.source AND l.qso=g.qso AND l.destination=g.destination
  WHERE g.id=NEW.id AND g.tenant=NEW.tenant AND g.source=NEW.source AND g.qso=NEW.qso AND g.destination=NEW.destination
   AND g.generation=NEW.generation AND p.source=NEW.source AND p.qso=NEW.qso
   AND g.now=NEW.created_at AND g.credential_version=NEW.credential_version AND g.template_version IS NEW.template_version
   AND json_extract(p.proof,'$.generation')=NEW.generation
   AND json_extract(p.proof,'$.scope')=g.source_export_scope
   AND json_extract(p.proof,'$.reconciliationVersion')=g.source_export_reconciliation_version
   AND l.generation=NEW.generation AND l.source_hash=NEW.source_hash
   AND l.context_generation=json_extract(p.proof,'$.contextGeneration') AND l.operation_id IS json_extract(p.proof,'$.operationId')
   AND p.created_at<=g.now AND p.expires_at>g.now
 ) THEN RAISE(ABORT,'source export proof unavailable for attempt') END;
END;

CREATE TRIGGER attempt_source_export_pin_retention AFTER INSERT ON attempt_source_export_proofs BEGIN
 DELETE FROM source_export_proof_retention WHERE tenant=NEW.tenant AND id=NEW.proof_id;
END;

CREATE TRIGGER attempt_source_export_pin_update BEFORE UPDATE ON attempt_source_export_proofs BEGIN
 SELECT RAISE(ABORT,'source export proof pin is immutable');
END;

CREATE TRIGGER attempt_source_export_pin_delete BEFORE DELETE ON attempt_source_export_proofs BEGIN
 SELECT RAISE(ABORT,'source export proof pin is immutable');
END;

CREATE TRIGGER prepared_source_export_proof BEFORE INSERT ON attempt_state
WHEN NEW.state IN('prepared','dispatching') BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM attempt_source_export_proofs_current p WHERE p.tenant=NEW.tenant AND p.attempt=NEW.attempt)
 THEN RAISE(ABORT,'source export proof unavailable before preparation') END;
END;

CREATE TRIGGER dispatch_source_export_proof BEFORE UPDATE OF state ON attempt_state
WHEN NEW.state='dispatching' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM attempt_source_export_proofs_current p WHERE p.tenant=NEW.tenant AND p.attempt=NEW.attempt)
 THEN RAISE(ABORT,'source export proof unavailable before dispatch') END;
END;

CREATE TRIGGER stage_qrz_fresh_insert BEFORE INSERT ON stage_guards
WHEN NEW.authorization_mode='qrz_fresh_insert' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM qrz_fresh_insert_eligible l
  WHERE l.tenant=NEW.tenant AND l.source=NEW.source AND l.qso=NEW.qso AND l.destination=NEW.destination)
 THEN RAISE(ABORT,'QRZ fresh insert unavailable before stage') END;
END;

CREATE TRIGGER stage_authorization_mode_immutable BEFORE UPDATE OF authorization_mode ON stage_guards BEGIN
 SELECT RAISE(ABORT,'source export authorization mode is immutable');
END;

CREATE TRIGGER attempt_qrz_fresh_insert BEFORE INSERT ON attempts
WHEN EXISTS(SELECT 1 FROM stage_guards g WHERE g.id=NEW.id AND g.tenant=NEW.tenant AND g.authorization_mode='qrz_fresh_insert') BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM qrz_fresh_insert_eligible l
  WHERE l.tenant=NEW.tenant AND l.source=NEW.source AND l.qso=NEW.qso AND l.destination=NEW.destination)
 THEN RAISE(ABORT,'QRZ fresh insert unavailable for attempt') END;
END;

CREATE TRIGGER attempt_source_export_proof_after AFTER INSERT ON attempts BEGIN
 INSERT INTO attempt_source_export_proofs(tenant,attempt,proof_id,authorization_mode)
 SELECT NEW.tenant,NEW.id,g.source_export_proof_id,g.authorization_mode
 FROM stage_guards g WHERE g.id=NEW.id AND g.tenant=NEW.tenant;
END;

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

-- Separate LoTW-only structural eligibility; same-hash baselines are observation, not prior acceptance.
CREATE VIEW lotw_fresh_insert_ledgers AS
 SELECT l.tenant,l.source,l.qso,l.destination FROM ledger l
 JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination
 WHERE d.kind='lotw' AND d.status='active'
  AND l.remote_id IS NULL AND (l.baseline_hash IS NULL OR l.baseline_hash=l.source_hash)
  AND l.remote_hash IS NULL AND l.sent_hash IS NULL AND l.provenance='unknown'
  AND l.confirmed=0 AND l.narrative!='remote_preserved'
  AND l.state IN('inventory_pending','missing_current_identity','live_new');

CREATE VIEW lotw_fresh_insert_attempt_conflicts AS
 SELECT a.tenant,a.source,a.qso,a.destination,a.id FROM attempts a
 LEFT JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id
 WHERE s.attempt IS NULL OR s.state NOT IN('cancelled','rejected') OR s.remote_id IS NOT NULL
  OR (s.dispatched_at IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM attempt_events e WHERE e.tenant=a.tenant AND e.attempt=a.id
    AND e.state='retry_scheduled' AND e.at>=s.dispatched_at AND e.at<=s.updated_at))
  OR EXISTS(SELECT 1 FROM attempt_events e WHERE e.tenant=a.tenant AND e.attempt=a.id
   AND e.state NOT IN('prepared','retry_scheduled','cancelled','rejected'));

CREATE VIEW lotw_fresh_insert_eligible AS
 SELECT l.* FROM lotw_fresh_insert_ledgers l WHERE NOT EXISTS(
  SELECT 1 FROM lotw_fresh_insert_attempt_conflicts a
  WHERE a.tenant=l.tenant AND a.source=l.source AND a.qso=l.qso AND a.destination=l.destination);



CREATE TRIGGER stage_lotw_fresh_insert BEFORE INSERT ON stage_guards
WHEN NEW.authorization_mode='lotw_fresh_insert' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM lotw_fresh_insert_eligible l
  WHERE l.tenant=NEW.tenant AND l.source=NEW.source AND l.qso=NEW.qso AND l.destination=NEW.destination)
 THEN RAISE(ABORT,'LoTW fresh insert unavailable before stage') END;
END;

CREATE TRIGGER attempt_lotw_fresh_insert BEFORE INSERT ON attempts
WHEN EXISTS(SELECT 1 FROM stage_guards g WHERE g.id=NEW.id AND g.tenant=NEW.tenant AND g.authorization_mode='lotw_fresh_insert') BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM lotw_fresh_insert_eligible l
  WHERE l.tenant=NEW.tenant AND l.source=NEW.source AND l.qso=NEW.qso AND l.destination=NEW.destination)
 THEN RAISE(ABORT,'LoTW fresh insert unavailable for attempt') END;
END;

CREATE TRIGGER lotw_fresh_insert_state_insert BEFORE INSERT ON attempt_state
WHEN EXISTS(SELECT 1 FROM attempt_source_export_proofs p WHERE p.tenant=NEW.tenant AND p.attempt=NEW.attempt AND p.authorization_mode='lotw_fresh_insert') BEGIN
 SELECT CASE WHEN NEW.state!='prepared' OR NOT EXISTS(
  SELECT 1 FROM stage_guards g WHERE g.tenant=NEW.tenant AND g.id=NEW.attempt AND g.authorization_mode='lotw_fresh_insert')
 THEN RAISE(ABORT,'LoTW fresh insert unavailable for initial attempt state') END;
END;

CREATE TRIGGER lotw_fresh_insert_dispatch_transition BEFORE UPDATE OF state ON attempt_state
WHEN NEW.state='dispatching' AND EXISTS(SELECT 1 FROM attempt_source_export_proofs p WHERE p.tenant=NEW.tenant AND p.attempt=NEW.attempt AND p.authorization_mode='lotw_fresh_insert') BEGIN
 SELECT CASE WHEN OLD.state!='prepared' THEN RAISE(ABORT,'LoTW fresh insert unavailable for dispatch transition') END;
END;

-- Existing source-boundary and QRZ authority remains unchanged.
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
     AND EXISTS(SELECT 1 FROM stage_guards g WHERE g.tenant=a.tenant AND g.id=a.id AND g.authorization_mode='qrz_fresh_insert')))))
UNION ALL
 SELECT pin.tenant,pin.attempt,pin.proof_id,p.created_at,p.expires_at,pin.authorization_mode
 FROM attempt_source_export_proofs pin
 JOIN attempts a ON a.tenant=pin.tenant AND a.id=pin.attempt
 JOIN source_export_proofs_current p ON p.tenant=pin.tenant AND p.id=pin.proof_id AND p.source=a.source AND p.qso=a.qso
 JOIN ledger l ON l.tenant=a.tenant AND l.source=a.source AND l.qso=a.qso AND l.destination=a.destination
 WHERE json_extract(p.proof,'$.generation')=a.generation AND l.generation=a.generation
  AND l.source_hash=a.source_hash AND l.context_generation=json_extract(p.proof,'$.contextGeneration')
  AND l.operation_id IS json_extract(p.proof,'$.operationId')
  AND (pin.authorization_mode='lotw_fresh_insert' AND (
   pin.authorization_mode='lotw_fresh_insert'
   AND EXISTS(SELECT 1 FROM lotw_fresh_insert_ledgers f
    WHERE f.tenant=a.tenant AND f.source=a.source AND f.qso=a.qso AND f.destination=a.destination)
   AND NOT EXISTS(SELECT 1 FROM lotw_fresh_insert_attempt_conflicts previous
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
     AND EXISTS(SELECT 1 FROM stage_guards g WHERE g.tenant=a.tenant AND g.id=a.id AND g.authorization_mode='lotw_fresh_insert')))));
