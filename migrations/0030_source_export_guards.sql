-- One database-clock predicate is reused by mint, stage, dispatch and final checks.
CREATE VIEW source_export_proofs_current AS
 SELECT p.* FROM source_export_proofs p WHERE (((((json_extract(p.proof,'$.scope.readerPolicy')='all-clients-v1') AND (json_array_length(p.proof,'$.dependencies') BETWEEN 1 AND 64)) AND ((json_type(p.proof,'$.createdAt')='integer' AND json_type(p.proof,'$.expiresAt')='integer') AND (json_type(p.proof,'$.collectionFinishedAt')='integer' AND json_extract(p.proof,'$.collectionFinishedAt')>0))) AND (((json_type(p.proof,'$.completeReadStartedAt')='integer') AND (json_array_length(p.proof,'$.dependencies')=(SELECT count(DISTINCT json_array(json_extract(d.value,'$.target.kind'),json_extract(d.value,'$.target.id'))) FROM json_each(p.proof,'$.dependencies') d))) AND ((json_extract(p.proof,'$.createdAt')<=CAST(unixepoch('subsec')*1000 AS INTEGER) AND json_extract(p.proof,'$.expiresAt')>MAX(CAST(unixepoch('subsec')*1000 AS INTEGER),CAST(unixepoch('subsec')*1000 AS INTEGER))) AND (json_extract(p.proof,'$.collectionFinishedAt')<=json_extract(p.proof,'$.completeReadStartedAt') AND json_extract(p.proof,'$.completeReadStartedAt')<=json_extract(p.proof,'$.createdAt'))))) AND ((((EXISTS(SELECT 1 FROM source_read_policy_ready ready
    JOIN source_read_policies policy ON policy.tenant=ready.tenant AND policy.source=ready.source
    JOIN connections c ON c.tenant=ready.tenant AND c.id=ready.source
    JOIN private_data credential ON credential.tenant=c.tenant AND credential.connection=c.id AND credential.id=c.credential_version AND credential.kind='credential'
    JOIN cursors context ON context.tenant=c.tenant AND context.connection=c.id AND context.stream='context'
    WHERE ((ready.tenant=json_extract(p.proof,'$.scope.tenant') AND ready.source=json_extract(p.proof,'$.scope.source') AND ready.epoch=json_extract(p.proof,'$.scope.policyEpoch'))
     AND (policy.account_id=json_extract(p.proof,'$.scope.accountId') AND policy.reader_policy=json_extract(p.proof,'$.scope.readerPolicy')))
     AND ((c.credential_version=json_extract(p.proof,'$.scope.credentialVersion') AND credential.revoked_at IS NULL AND (credential.expires_at IS NULL OR credential.expires_at>MAX(CAST(unixepoch('subsec')*1000 AS INTEGER),CAST(unixepoch('subsec')*1000 AS INTEGER))))
     AND (ready.sync_generation=json_extract(p.proof,'$.syncGeneration') AND json_type(ready.sync_cursor,'$.completeReadStartedAt')='integer' AND json_extract(ready.sync_cursor,'$.completeReadStartedAt')=json_extract(p.proof,'$.completeReadStartedAt')))
     AND ((json_extract(ready.sync_cursor,'$.operations.complete')=1 AND json_extract(ready.sync_cursor,'$.qsos.complete')=1)
     AND (json_extract(ready.sync_cursor,'$.operations.cursor') IS NULL AND json_extract(ready.sync_cursor,'$.qsos.cursor') IS NULL))
     AND (context.generation=json_extract(p.proof,'$.contextGeneration') AND json_valid(context.cursor) AND json_extract(context.cursor,'$.complete')=1 AND json_extract(context.cursor,'$.syncComplete')=1))) AND (EXISTS(SELECT 1 FROM reconciliation_work r WHERE r.tenant=json_extract(p.proof,'$.scope.tenant') AND r.source=json_extract(p.proof,'$.scope.source') AND r.qso=json_extract(p.proof,'$.qso') AND r.version=json_extract(p.proof,'$.reconciliationVersion')))) AND ((EXISTS(SELECT 1 FROM ledger l WHERE l.tenant=json_extract(p.proof,'$.scope.tenant') AND l.source=json_extract(p.proof,'$.scope.source') AND l.qso=json_extract(p.proof,'$.qso') AND l.generation=json_extract(p.proof,'$.generation') AND l.context_generation=json_extract(p.proof,'$.contextGeneration') AND l.operation_id IS json_extract(p.proof,'$.operationId'))) AND (EXISTS(SELECT 1 FROM source_work q WHERE q.tenant=json_extract(p.proof,'$.scope.tenant') AND q.source=json_extract(p.proof,'$.scope.source') AND q.id=json_extract(p.proof,'$.qso') AND q.kind='qso' AND q.operation_id IS json_extract(p.proof,'$.operationId') AND q.deleted=0 AND q.is_event=0 AND q.state IN('pending','waiting'))))) AND ((((SELECT count(*) FROM json_each(p.proof,'$.dependencies') d WHERE json_extract(d.value,'$.target.kind')='qso' AND json_extract(d.value,'$.target.id')=json_extract(p.proof,'$.qso') AND json_extract(d.value,'$.target.isEvent')=0)=1) AND ((SELECT count(*) FROM json_each(p.proof,'$.dependencies') d WHERE json_extract(d.value,'$.target.kind')='operation')=CASE WHEN json_extract(p.proof,'$.operationId') IS NULL THEN 0 ELSE 1 END)) AND ((NOT EXISTS(SELECT 1 FROM json_each(p.proof,'$.dependencies') d WHERE
     json_extract(d.value,'$.target.deleted') IS NOT 0
     OR json_extract(d.value,'$.target.kind') NOT IN('qso','operation')
     OR (json_extract(d.value,'$.target.kind')='operation' AND json_extract(d.value,'$.target.id') IS NOT json_extract(p.proof,'$.operationId'))
     OR (json_extract(d.value,'$.target.kind')='qso' AND json_extract(d.value,'$.target.id')!=json_extract(p.proof,'$.qso') AND (json_extract(d.value,'$.target.isEvent') IS NOT 1 OR json_extract(d.value,'$.target.operationId') IS NOT json_extract(p.proof,'$.operationId'))))) AND ((NOT EXISTS(SELECT 1 FROM json_each(p.proof,'$.dependencies') d WHERE
    json_type(d.value,'$.requestStartedAt') IS NOT 'integer' OR json_extract(d.value,'$.requestStartedAt')>json_extract(p.proof,'$.collectionFinishedAt') OR json_extract(d.value,'$.requestStartedAt')<0
    OR json_extract(p.proof,'$.expiresAt')>json_extract(d.value,'$.requestStartedAt')+300000
    OR NOT EXISTS(SELECT 1 FROM source_work w JOIN private_data b ON b.tenant=w.tenant AND b.connection=w.source AND b.id=w.private_id AND b.kind='source'
     WHERE ((w.tenant=json_extract(p.proof,'$.scope.tenant') AND w.source=json_extract(p.proof,'$.scope.source') AND w.kind=json_extract(d.value,'$.target.kind') AND w.id=json_extract(d.value,'$.target.id'))
      AND (w.revision=json_extract(d.value,'$.target.revision') AND w.synced_at=json_extract(d.value,'$.target.syncedAtMillis')))
      AND ((w.operation_id IS json_extract(d.value,'$.target.operationId') AND w.deleted=0 AND w.is_event=json_extract(d.value,'$.target.isEvent'))
      AND (w.policy_seen_epoch=json_extract(p.proof,'$.scope.policyEpoch') AND (w.kind!='operation' OR w.state='context')))
      AND ((w.private_id=json_extract(d.value,'$.privateId') AND w.expires_at=json_extract(d.value,'$.workExpiresAt') AND w.expires_at>MAX(CAST(unixepoch('subsec')*1000 AS INTEGER),CAST(unixepoch('subsec')*1000 AS INTEGER)))
      AND (b.source_proof_version=json_extract(d.value,'$.bodyVersion') AND b.created_at=json_extract(d.value,'$.bodyCreatedAt')))
      AND (b.expires_at IS json_extract(d.value,'$.bodyExpiresAt') AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>MAX(CAST(unixepoch('subsec')*1000 AS INTEGER),CAST(unixepoch('subsec')*1000 AS INTEGER))))))) AND (NOT EXISTS(SELECT 1 FROM source_work e INDEXED BY source_context_members
    WHERE e.tenant=json_extract(p.proof,'$.scope.tenant') AND e.source=json_extract(p.proof,'$.scope.source') AND e.operation_id=json_extract(p.proof,'$.operationId') AND e.kind='qso' AND e.is_event=1 AND e.deleted=0
     AND NOT EXISTS(SELECT 1 FROM json_each(p.proof,'$.dependencies') d WHERE json_extract(d.value,'$.target.kind')='qso' AND json_extract(d.value,'$.target.id')=e.id))))))));

-- Keep cleanup's scan bounded even when old pinned audit proofs accumulate.
-- This mutable index is not authority; proof content and attempt pins stay immutable.
CREATE TABLE source_export_proof_retention (
 tenant TEXT NOT NULL,id TEXT NOT NULL,expires_at INTEGER NOT NULL,
 PRIMARY KEY(tenant,id),
 FOREIGN KEY(tenant,id) REFERENCES source_export_proofs(tenant,id) ON DELETE CASCADE
);
CREATE INDEX source_export_proof_retention_expiry ON source_export_proof_retention(expires_at,tenant,id);
INSERT INTO source_export_proof_retention(tenant,id,expires_at)
 SELECT tenant,id,expires_at FROM source_export_proofs;
CREATE TRIGGER source_export_proof_retention_insert AFTER INSERT ON source_export_proofs BEGIN
 INSERT INTO source_export_proof_retention(tenant,id,expires_at) VALUES(NEW.tenant,NEW.id,NEW.expires_at);
END;

ALTER TABLE stage_guards ADD COLUMN source_export_proof_id TEXT;
ALTER TABLE stage_guards ADD COLUMN source_export_scope TEXT;
ALTER TABLE stage_guards ADD COLUMN source_export_reconciliation_version INTEGER;

-- This fence is unconditional: old workers, missing policies, identity-free
-- callers and null-context ledgers receive no export authority.
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

CREATE TABLE attempt_source_export_proofs (
 tenant TEXT NOT NULL,attempt TEXT NOT NULL,proof_id TEXT NOT NULL,
 PRIMARY KEY(tenant,attempt),
 FOREIGN KEY(tenant,attempt) REFERENCES attempts(tenant,id),
 FOREIGN KEY(tenant,proof_id) REFERENCES source_export_proofs(tenant,id)
);
CREATE INDEX attempt_source_export_proof_retention ON attempt_source_export_proofs(tenant,proof_id);

CREATE VIEW attempt_source_export_proofs_current AS
 SELECT pin.tenant,pin.attempt,pin.proof_id,p.created_at,p.expires_at
 FROM attempt_source_export_proofs pin
 JOIN attempts a ON a.tenant=pin.tenant AND a.id=pin.attempt
 JOIN source_export_proofs_current p ON p.tenant=pin.tenant AND p.id=pin.proof_id AND p.source=a.source AND p.qso=a.qso
 JOIN ledger l ON l.tenant=a.tenant AND l.source=a.source AND l.qso=a.qso AND l.destination=a.destination
 WHERE json_extract(p.proof,'$.generation')=a.generation AND l.generation=a.generation
  AND l.source_hash=a.source_hash AND l.context_generation=json_extract(p.proof,'$.contextGeneration')
  AND l.operation_id IS json_extract(p.proof,'$.operationId');

-- The immutable pin is created with the attempt, inside the stage transaction.
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
CREATE TRIGGER attempt_source_export_proof_after AFTER INSERT ON attempts BEGIN
 INSERT INTO attempt_source_export_proofs(tenant,attempt,proof_id)
 SELECT NEW.tenant,NEW.id,g.source_export_proof_id FROM stage_guards g WHERE g.id=NEW.id AND g.tenant=NEW.tenant;
END;
CREATE TRIGGER attempt_source_export_pin_before BEFORE INSERT ON attempt_source_export_proofs BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM attempt_source_export_proofs WHERE tenant=NEW.tenant AND attempt=NEW.attempt)
  OR NOT EXISTS(
   SELECT 1 FROM attempts a JOIN stage_guards g ON g.tenant=a.tenant AND g.id=a.id
   JOIN source_export_proofs_current p ON p.tenant=g.tenant AND p.id=g.source_export_proof_id
   WHERE a.tenant=NEW.tenant AND a.id=NEW.attempt AND p.id=NEW.proof_id
    AND g.source=a.source AND g.qso=a.qso AND g.destination=a.destination AND g.generation=a.generation
    AND p.source=a.source AND p.qso=a.qso AND json_extract(p.proof,'$.generation')=a.generation
  ) THEN RAISE(ABORT,'source export proof unavailable for pin') END;
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
