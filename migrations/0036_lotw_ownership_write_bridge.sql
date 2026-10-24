ALTER TABLE lotw_ownership_state ADD COLUMN comparison_policy INTEGER NOT NULL DEFAULT 1 CHECK(comparison_policy>=1);
CREATE TRIGGER lotw_ownership_policy_monotonic BEFORE UPDATE OF comparison_policy ON lotw_ownership_state WHEN NEW.comparison_policy<OLD.comparison_policy BEGIN SELECT RAISE(ABORT,'LoTW ownership policy cannot regress'); END;
CREATE TRIGGER lotw_ownership_policy_clock AFTER UPDATE OF comparison_policy ON lotw_ownership_state WHEN NEW.comparison_policy!=OLD.comparison_policy BEGIN UPDATE lotw_ownership_state SET clock=clock+1 WHERE tenant=NEW.tenant; END;
-- Mandatory LoTW ownership bridge. Exact reservations are not vendor receipts.
-- All old/new modes require an immutable pin; renewable checks carry freshness.
CREATE TABLE lotw_ownership_write_guards (
 id TEXT PRIMARY KEY,tenant TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN('stage','claim','check','mapping','receipt')),
 key_id TEXT NOT NULL,clock INTEGER NOT NULL,comparison_policy INTEGER NOT NULL CHECK(comparison_policy>=1),plan TEXT NOT NULL CHECK(length(CAST(plan AS BLOB))<=4194304 AND json_valid(plan) AND json_type(plan)='array' AND json_array_length(plan) BETWEEN 1 AND 20),
 lease_token TEXT NOT NULL,lease_fence INTEGER NOT NULL,checked_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 CHECK(expires_at>checked_at AND expires_at<=checked_at+60000)
);
CREATE TRIGGER lotw_ownership_write_admission BEFORE INSERT ON lotw_ownership_write_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM lotw_ownership_state s JOIN source_historical_state k ON k.tenant=s.tenant JOIN leases l ON l.tenant=s.tenant AND l.scope='lotw-ownership' WHERE s.tenant=NEW.tenant AND s.key_id=NEW.key_id AND s.key_id=k.key_id AND s.clock=NEW.clock AND s.comparison_policy=NEW.comparison_policy AND l.token=NEW.lease_token AND l.fence=NEW.lease_fence AND l.expires_at>=NEW.expires_at AND NEW.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND NOT EXISTS(SELECT 1 FROM lotw_ownership_inputs i WHERE i.tenant=s.tenant AND i.status IN('pending','held')) AND NOT EXISTS(SELECT 1 FROM lotw_ownership_owners o WHERE o.tenant=s.tenant AND o.owner_hash IS NULL)) THEN RAISE(ABORT,'LoTW ownership unavailable') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.plan) m WHERE json_type(m.value,'$.source') IS NOT 'text' OR json_type(m.value,'$.qso') IS NOT 'text' OR json_type(m.value,'$.destination') IS NOT 'text' OR (json_type(m.value,'$.identityHash') IS NOT 'text' OR length(json_extract(m.value,'$.identityHash'))!=43) OR (json_type(m.value,'$.namespace') IS NOT 'text' OR length(json_extract(m.value,'$.namespace'))!=43) OR json_type(m.value,'$.evidenceId') IS NOT 'text' OR NOT EXISTS(SELECT 1 FROM connections d WHERE d.tenant=NEW.tenant AND d.id=json_extract(m.value,'$.destination') AND d.kind='lotw')) THEN RAISE(ABORT,'invalid LoTW ownership plan') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM json_each(NEW.plan))!=(SELECT COUNT(DISTINCT json_array(json_extract(value,'$.source'),json_extract(value,'$.qso'),json_extract(value,'$.destination'))) FROM json_each(NEW.plan)) THEN RAISE(ABORT,'duplicate LoTW ownership plan') END;
END;
CREATE TRIGGER lotw_ownership_write_immutable BEFORE UPDATE ON lotw_ownership_write_guards BEGIN SELECT RAISE(ABORT,'immutable LoTW ownership guard'); END;
CREATE TABLE attempt_lotw_ownership_pins (
 tenant TEXT NOT NULL,attempt TEXT NOT NULL,source TEXT NOT NULL,qso TEXT NOT NULL,destination TEXT NOT NULL,
 key_id TEXT NOT NULL,namespace TEXT NOT NULL,identity_hash TEXT NOT NULL,evidence_id TEXT NOT NULL,
 payload_hash TEXT NOT NULL,artifact_hash TEXT NOT NULL,generation TEXT NOT NULL,source_hash TEXT NOT NULL,
 source_version INTEGER NOT NULL,source_export_proof_id TEXT NOT NULL,credential_version TEXT NOT NULL,
 PRIMARY KEY(tenant,attempt),FOREIGN KEY(tenant,attempt) REFERENCES attempts(tenant,id),FOREIGN KEY(tenant,evidence_id) REFERENCES lotw_ownership_evidence(tenant,id)
);
CREATE TRIGGER attempt_lotw_pin_immutable BEFORE UPDATE ON attempt_lotw_ownership_pins BEGIN SELECT RAISE(ABORT,'immutable LoTW ownership pin'); END;
CREATE TRIGGER attempt_lotw_pin_retained BEFORE DELETE ON attempt_lotw_ownership_pins BEGIN SELECT RAISE(ABORT,'retained LoTW ownership pin'); END;
CREATE TRIGGER attempt_lotw_pin_no_replace BEFORE INSERT ON attempt_lotw_ownership_pins WHEN EXISTS(SELECT 1 FROM attempt_lotw_ownership_pins WHERE tenant=NEW.tenant AND attempt=NEW.attempt) BEGIN SELECT RAISE(ABORT,'immutable LoTW ownership pin'); END;
CREATE TABLE lotw_ownership_checks (
 tenant TEXT NOT NULL,attempt TEXT NOT NULL,clock INTEGER NOT NULL,key_id TEXT NOT NULL,comparison_policy INTEGER NOT NULL,
 lease_token TEXT NOT NULL,lease_fence INTEGER NOT NULL,checked_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 PRIMARY KEY(tenant,attempt),FOREIGN KEY(tenant,attempt) REFERENCES attempt_lotw_ownership_pins(tenant,attempt)
);
CREATE INDEX lotw_ownership_check_expiry ON lotw_ownership_checks(expires_at,tenant,attempt);
CREATE VIEW lotw_ownership_planned AS
 SELECT g.*,json_extract(m.value,'$.attempt') AS planned_attempt,json_extract(m.value,'$.source') AS source,json_extract(m.value,'$.qso') AS qso,json_extract(m.value,'$.destination') AS destination,json_extract(m.value,'$.identityHash') AS identity_hash,json_extract(m.value,'$.evidenceId') AS evidence_id,json_extract(m.value,'$.namespace') AS namespace,json_extract(m.value,'$.payloadHash') AS payload_hash,json_extract(m.value,'$.artifactHash') AS artifact_hash,json_extract(m.value,'$.generation') AS generation,json_extract(m.value,'$.sourceHash') AS source_hash,json_extract(m.value,'$.sourceVersion') AS source_version,json_extract(m.value,'$.sourceProofId') AS source_export_proof_id,json_extract(m.value,'$.credentialVersion') AS credential_version
 FROM lotw_ownership_write_guards g JOIN lotw_ownership_state s ON s.tenant=g.tenant AND s.key_id=g.key_id AND s.comparison_policy=g.comparison_policy,json_each(g.plan) m;
CREATE VIEW attempt_lotw_ownership_current AS
 SELECT p.*,c.expires_at FROM attempt_lotw_ownership_pins p
 JOIN attempts a ON a.tenant=p.tenant AND a.id=p.attempt AND a.source=p.source AND a.qso=p.qso AND a.destination=p.destination AND a.generation=p.generation AND a.source_hash=p.source_hash AND a.payload_hash=p.payload_hash AND a.credential_version=p.credential_version
 JOIN attempt_identity_claims i ON i.tenant=p.tenant AND i.attempt=p.attempt AND i.vendor='lotw' AND i.identity_hash=p.identity_hash AND i.destination=p.destination AND i.source=p.source AND i.qso=p.qso AND i.source_version=p.source_version
 JOIN attempt_source_export_proofs sp ON sp.tenant=p.tenant AND sp.attempt=p.attempt AND sp.proof_id=p.source_export_proof_id
 JOIN lotw_ownership_checks c ON c.tenant=p.tenant AND c.attempt=p.attempt AND c.key_id=p.key_id
 JOIN lotw_ownership_state s ON s.tenant=p.tenant AND s.key_id=p.key_id AND s.clock=c.clock AND s.comparison_policy=c.comparison_policy
 JOIN source_historical_state k ON k.tenant=s.tenant AND k.key_id=s.key_id
 JOIN leases l ON l.tenant=p.tenant AND l.scope='lotw-ownership' AND l.token=c.lease_token AND l.fence=c.lease_fence AND l.expires_at>=c.expires_at
 WHERE c.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)
 AND NOT EXISTS(SELECT 1 FROM lotw_ownership_inputs x WHERE x.tenant=p.tenant AND x.status IN('pending','held'))
 AND NOT EXISTS(SELECT 1 FROM lotw_ownership_owners o WHERE o.tenant=p.tenant AND o.owner_hash IS NULL)
 AND NOT EXISTS(SELECT 1 FROM lotw_ownership_unsafe_attempts a WHERE a.tenant=p.tenant AND a.source=p.source AND a.qso=p.qso AND a.destination!=p.destination)
 AND NOT EXISTS(SELECT 1 FROM lotw_ownership_inputs x WHERE x.tenant=p.tenant AND x.kind='mapping' AND x.source=p.source AND x.qso=p.qso AND x.destination!=p.destination);
CREATE TRIGGER lotw_ownership_stage BEFORE INSERT ON stage_guards WHEN EXISTS(SELECT 1 FROM connections WHERE tenant=NEW.tenant AND id=NEW.destination AND kind='lotw') BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM lotw_ownership_planned p JOIN lotw_ownership_evidence e ON e.tenant=p.tenant AND e.id=p.evidence_id AND e.key_id=p.key_id AND e.source=p.source AND e.qso=p.qso AND e.destination=p.destination AND e.exact_hash=p.identity_hash WHERE p.phase='stage' AND p.tenant=NEW.tenant AND p.planned_attempt=NEW.id AND p.source=NEW.source AND p.qso=NEW.qso AND p.destination=NEW.destination AND p.identity_hash=NEW.identity_hash AND p.generation=NEW.generation AND p.source_version=NEW.identity_source_version AND p.source_export_proof_id=NEW.source_export_proof_id AND p.credential_version=NEW.credential_version AND p.expires_at>MAX(NEW.now,CAST(unixepoch('subsec')*1000 AS INTEGER))) THEN RAISE(ABORT,'LoTW ownership unavailable') END;
END;
CREATE TRIGGER lotw_ownership_attempt_pin BEFORE INSERT ON attempts WHEN EXISTS(SELECT 1 FROM connections WHERE tenant=NEW.tenant AND id=NEW.destination AND kind='lotw') BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM lotw_ownership_planned p JOIN stage_guards g ON g.tenant=p.tenant AND g.id=p.planned_attempt WHERE p.phase='stage' AND p.tenant=NEW.tenant AND p.planned_attempt=NEW.id AND p.source=NEW.source AND p.qso=NEW.qso AND p.destination=NEW.destination AND p.generation=NEW.generation AND p.source_hash=NEW.source_hash AND p.payload_hash=NEW.payload_hash AND p.credential_version=NEW.credential_version) THEN RAISE(ABORT,'LoTW ownership unavailable') END;
END;
CREATE TRIGGER lotw_ownership_pin AFTER INSERT ON attempts WHEN EXISTS(SELECT 1 FROM connections WHERE tenant=NEW.tenant AND id=NEW.destination AND kind='lotw') BEGIN
 INSERT INTO attempt_lotw_ownership_pins SELECT p.tenant,NEW.id,p.source,p.qso,p.destination,p.key_id,p.namespace,p.identity_hash,p.evidence_id,p.payload_hash,p.artifact_hash,p.generation,p.source_hash,p.source_version,p.source_export_proof_id,p.credential_version FROM lotw_ownership_planned p WHERE p.phase='stage' AND p.tenant=NEW.tenant AND p.planned_attempt=NEW.id;
END;
CREATE TRIGGER lotw_ownership_pin_admission BEFORE INSERT ON attempt_lotw_ownership_pins BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM lotw_ownership_planned p WHERE p.phase='stage' AND p.tenant=NEW.tenant AND p.planned_attempt=NEW.attempt AND p.source=NEW.source AND p.qso=NEW.qso AND p.destination=NEW.destination AND p.key_id=NEW.key_id AND p.namespace=NEW.namespace AND p.identity_hash=NEW.identity_hash AND p.evidence_id=NEW.evidence_id AND p.artifact_hash=NEW.artifact_hash AND p.payload_hash=NEW.payload_hash AND p.generation=NEW.generation AND p.source_hash=NEW.source_hash AND p.source_version=NEW.source_version AND p.source_export_proof_id=NEW.source_export_proof_id AND p.credential_version=NEW.credential_version) THEN RAISE(ABORT,'LoTW ownership unavailable') END;
END;
CREATE TRIGGER lotw_ownership_initial_state BEFORE INSERT ON attempt_state WHEN EXISTS(SELECT 1 FROM attempts a JOIN connections d ON d.tenant=a.tenant AND d.id=a.destination WHERE a.tenant=NEW.tenant AND a.id=NEW.attempt AND d.kind='lotw') BEGIN
 SELECT CASE WHEN NOT (NEW.state='reconciliation_required' AND NEW.lease_token IS NULL AND NEW.fence IS NULL AND NEW.dispatched_at IS NULL AND NEW.remote_id IS NULL AND NOT EXISTS(SELECT 1 FROM attempt_lotw_ownership_pins WHERE tenant=NEW.tenant AND attempt=NEW.attempt)) AND (NEW.state!='prepared' OR NOT EXISTS(SELECT 1 FROM lotw_ownership_planned p JOIN attempt_lotw_ownership_pins pin ON pin.tenant=p.tenant AND pin.attempt=p.planned_attempt WHERE p.phase='stage' AND p.tenant=NEW.tenant AND p.planned_attempt=NEW.attempt)) THEN RAISE(ABORT,'LoTW ownership unavailable') END;
END;
CREATE TRIGGER lotw_ownership_dispatch BEFORE UPDATE OF state ON attempt_state WHEN NEW.state='dispatching' AND EXISTS(SELECT 1 FROM attempts a JOIN connections d ON d.tenant=a.tenant AND d.id=a.destination WHERE a.tenant=NEW.tenant AND a.id=NEW.attempt AND d.kind='lotw') BEGIN
 SELECT CASE WHEN OLD.state!='prepared' OR NOT EXISTS(SELECT 1 FROM attempt_lotw_ownership_current c JOIN lotw_ownership_planned p ON p.tenant=c.tenant AND p.planned_attempt=c.attempt AND p.phase='claim' AND p.identity_hash=c.identity_hash AND p.artifact_hash=c.artifact_hash WHERE c.tenant=NEW.tenant AND c.attempt=NEW.attempt AND c.expires_at>MAX(NEW.updated_at,CAST(unixepoch('subsec')*1000 AS INTEGER))) THEN RAISE(ABORT,'LoTW ownership unavailable') END;
END;
-- A real old/new receipt may project only its original exact claimed identity.
-- It does not require a current source proof and never grants a resend.
CREATE TABLE lotw_ownership_receipt_checks (
 tenant TEXT NOT NULL,attempt TEXT NOT NULL,identity_hash TEXT NOT NULL,clock INTEGER NOT NULL,key_id TEXT NOT NULL,comparison_policy INTEGER NOT NULL,lease_token TEXT NOT NULL,lease_fence INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 PRIMARY KEY(tenant,attempt),FOREIGN KEY(tenant,attempt) REFERENCES attempts(tenant,id)
);
CREATE VIEW lotw_ownership_receipt_intents AS
 SELECT a.tenant,a.id AS attempt,a.source,a.qso,a.destination,s.remote_id AS identity_hash FROM attempts a
 JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id AND s.state='observed'
 JOIN leases l ON l.tenant=a.tenant AND l.scope IN('delivery:'||a.destination,'reconcile:'||a.destination) AND l.token=s.lease_token AND l.fence=s.fence AND l.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER);
CREATE VIEW lotw_ownership_receipt_mappings AS
 SELECT r.* FROM lotw_ownership_receipt_intents r
 JOIN attempt_identity_claims i ON i.tenant=r.tenant AND i.attempt=r.attempt AND i.vendor='lotw' AND i.identity_hash=r.identity_hash AND i.source=r.source AND i.qso=r.qso AND i.destination=r.destination
 JOIN lotw_ownership_receipt_checks c ON c.tenant=r.tenant AND c.attempt=r.attempt AND c.identity_hash=r.identity_hash
 JOIN lotw_ownership_state s ON s.tenant=c.tenant AND s.clock=c.clock AND s.key_id=c.key_id AND s.comparison_policy=c.comparison_policy
 JOIN source_historical_state k ON k.tenant=s.tenant AND k.key_id=s.key_id
 JOIN leases l ON l.tenant=c.tenant AND l.scope='lotw-ownership' AND l.token=c.lease_token AND l.fence=c.lease_fence AND l.expires_at>=c.expires_at
 WHERE c.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND NOT EXISTS(SELECT 1 FROM lotw_ownership_inputs x WHERE x.tenant=r.tenant AND x.status IN('pending','held')) AND NOT EXISTS(SELECT 1 FROM lotw_ownership_owners o WHERE o.tenant=r.tenant AND o.owner_hash IS NULL);
CREATE TRIGGER lotw_ownership_mapping_insert BEFORE INSERT ON ledger WHEN NEW.remote_id IS NOT NULL AND EXISTS(SELECT 1 FROM connections WHERE tenant=NEW.tenant AND id=NEW.destination AND kind='lotw') BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM lotw_ownership_planned p WHERE p.phase='mapping' AND p.tenant=NEW.tenant AND p.source=NEW.source AND p.qso=NEW.qso AND p.destination=NEW.destination AND p.identity_hash=NEW.remote_id AND p.generation=NEW.generation AND p.source_hash=NEW.source_hash AND p.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)) AND NOT EXISTS(SELECT 1 FROM lotw_ownership_receipt_intents r WHERE r.tenant=NEW.tenant AND r.source=NEW.source AND r.qso=NEW.qso AND r.destination=NEW.destination AND r.identity_hash=NEW.remote_id) THEN RAISE(ABORT,'LoTW ownership mapping unavailable') END;
END;
CREATE TRIGGER lotw_ownership_mapping_update BEFORE UPDATE OF remote_id ON ledger WHEN NEW.remote_id IS NOT NULL AND NEW.remote_id IS NOT OLD.remote_id AND EXISTS(SELECT 1 FROM connections WHERE tenant=NEW.tenant AND id=NEW.destination AND kind='lotw') BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM lotw_ownership_planned p WHERE p.phase='mapping' AND p.tenant=NEW.tenant AND p.source=NEW.source AND p.qso=NEW.qso AND p.destination=NEW.destination AND p.identity_hash=NEW.remote_id AND p.generation=NEW.generation AND p.source_hash=OLD.source_hash AND p.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)) AND NOT EXISTS(SELECT 1 FROM lotw_ownership_receipt_intents r WHERE r.tenant=NEW.tenant AND r.source=NEW.source AND r.qso=NEW.qso AND r.destination=NEW.destination AND r.identity_hash=NEW.remote_id) THEN RAISE(ABORT,'LoTW ownership mapping unavailable') END;
END;
CREATE TRIGGER lotw_ownership_write_finish BEFORE DELETE ON lotw_ownership_write_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM leases WHERE tenant=OLD.tenant AND scope='lotw-ownership' AND token=OLD.lease_token AND fence=OLD.lease_fence AND expires_at>=OLD.expires_at AND OLD.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)) OR EXISTS(SELECT 1 FROM lotw_ownership_inputs WHERE tenant=OLD.tenant AND status IN('pending','held')) OR EXISTS(SELECT 1 FROM lotw_ownership_owners WHERE tenant=OLD.tenant AND owner_hash IS NULL) OR NOT EXISTS(SELECT 1 FROM lotw_ownership_state s JOIN source_historical_state k ON k.tenant=s.tenant AND k.key_id=s.key_id WHERE s.tenant=OLD.tenant AND s.key_id=OLD.key_id AND s.comparison_policy=OLD.comparison_policy) THEN RAISE(ABORT,'LoTW ownership changed') END;
END;
CREATE TRIGGER lotw_ownership_check_insert BEFORE INSERT ON lotw_ownership_checks BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM lotw_ownership_planned p JOIN lotw_ownership_state s ON s.tenant=p.tenant WHERE p.tenant=NEW.tenant AND p.planned_attempt=NEW.attempt AND p.phase IN('stage','claim','check') AND NEW.clock=s.clock AND NEW.comparison_policy=p.comparison_policy AND NEW.comparison_policy=s.comparison_policy AND NEW.key_id=p.key_id AND NEW.lease_token=p.lease_token AND NEW.lease_fence=p.lease_fence AND NEW.checked_at=p.checked_at AND NEW.expires_at=p.expires_at) THEN RAISE(ABORT,'LoTW ownership unavailable') END;
END;
CREATE TRIGGER lotw_ownership_check_update BEFORE UPDATE ON lotw_ownership_checks BEGIN
 SELECT CASE WHEN NEW.tenant IS NOT OLD.tenant OR NEW.attempt IS NOT OLD.attempt OR NOT EXISTS(SELECT 1 FROM lotw_ownership_planned p JOIN lotw_ownership_state s ON s.tenant=p.tenant WHERE p.tenant=NEW.tenant AND p.planned_attempt=NEW.attempt AND p.phase IN('stage','claim','check') AND NEW.clock=s.clock AND NEW.comparison_policy=p.comparison_policy AND NEW.comparison_policy=s.comparison_policy AND NEW.key_id=p.key_id AND NEW.lease_token=p.lease_token AND NEW.lease_fence=p.lease_fence AND NEW.checked_at=p.checked_at AND NEW.expires_at=p.expires_at) THEN RAISE(ABORT,'LoTW ownership unavailable') END;
END;

CREATE TRIGGER lotw_ownership_receipt_hold_insert BEFORE INSERT ON ledger WHEN NEW.remote_id IS NOT NULL AND EXISTS(SELECT 1 FROM connections WHERE tenant=NEW.tenant AND id=NEW.destination AND kind='lotw') AND EXISTS(SELECT 1 FROM lotw_ownership_receipt_intents r WHERE r.tenant=NEW.tenant AND r.source=NEW.source AND r.qso=NEW.qso AND r.destination=NEW.destination AND r.identity_hash=NEW.remote_id) AND NOT EXISTS(SELECT 1 FROM lotw_ownership_receipt_mappings r WHERE r.tenant=NEW.tenant AND r.source=NEW.source AND r.qso=NEW.qso AND r.destination=NEW.destination AND r.identity_hash=NEW.remote_id) BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER lotw_ownership_receipt_hold_update BEFORE UPDATE OF remote_id ON ledger WHEN NEW.remote_id IS NOT NULL AND NEW.remote_id IS NOT OLD.remote_id AND EXISTS(SELECT 1 FROM connections WHERE tenant=NEW.tenant AND id=NEW.destination AND kind='lotw') AND EXISTS(SELECT 1 FROM lotw_ownership_receipt_intents r WHERE r.tenant=NEW.tenant AND r.source=NEW.source AND r.qso=NEW.qso AND r.destination=NEW.destination AND r.identity_hash=NEW.remote_id) AND NOT EXISTS(SELECT 1 FROM lotw_ownership_receipt_mappings r WHERE r.tenant=NEW.tenant AND r.source=NEW.source AND r.qso=NEW.qso AND r.destination=NEW.destination AND r.identity_hash=NEW.remote_id) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER lotw_ownership_receipt_check_insert BEFORE INSERT ON lotw_ownership_receipt_checks BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM lotw_ownership_planned p JOIN lotw_ownership_state s ON s.tenant=p.tenant JOIN attempts a ON a.tenant=p.tenant AND a.id=p.planned_attempt AND a.source=p.source AND a.qso=p.qso AND a.destination=p.destination AND a.payload_hash=p.payload_hash JOIN attempt_identity_claims i ON i.tenant=a.tenant AND i.attempt=a.id AND i.vendor='lotw' AND i.identity_hash=p.identity_hash WHERE p.phase='receipt' AND p.tenant=NEW.tenant AND p.planned_attempt=NEW.attempt AND p.identity_hash=NEW.identity_hash AND NEW.clock=s.clock AND NEW.comparison_policy=p.comparison_policy AND NEW.comparison_policy=s.comparison_policy AND NEW.key_id=p.key_id AND NEW.lease_token=p.lease_token AND NEW.lease_fence=p.lease_fence AND NEW.expires_at=p.expires_at) THEN RAISE(ABORT,'LoTW ownership receipt unavailable') END; END;
CREATE TRIGGER lotw_ownership_receipt_check_update BEFORE UPDATE ON lotw_ownership_receipt_checks BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM lotw_ownership_planned p JOIN lotw_ownership_state s ON s.tenant=p.tenant JOIN attempts a ON a.tenant=p.tenant AND a.id=p.planned_attempt AND a.source=p.source AND a.qso=p.qso AND a.destination=p.destination AND a.payload_hash=p.payload_hash JOIN attempt_identity_claims i ON i.tenant=a.tenant AND i.attempt=a.id AND i.vendor='lotw' AND i.identity_hash=p.identity_hash WHERE p.phase='receipt' AND p.tenant=NEW.tenant AND p.planned_attempt=NEW.attempt AND p.identity_hash=NEW.identity_hash AND NEW.clock=s.clock AND NEW.comparison_policy=p.comparison_policy AND NEW.comparison_policy=s.comparison_policy AND NEW.key_id=p.key_id AND NEW.lease_token=p.lease_token AND NEW.lease_fence=p.lease_fence AND NEW.expires_at=p.expires_at) THEN RAISE(ABORT,'LoTW ownership receipt unavailable') END; END;
CREATE TRIGGER lotw_ownership_plan_headers BEFORE INSERT ON lotw_ownership_write_guards BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.plan) m WHERE json_type(m.value,'$.generation') IS NOT 'text' OR json_type(m.value,'$.sourceHash') IS NOT 'text' OR (NEW.phase!='mapping' AND (json_type(m.value,'$.attempt') IS NOT 'text' OR json_type(m.value,'$.payloadHash') IS NOT 'text' OR json_type(m.value,'$.artifactHash') IS NOT 'text')) OR (NEW.phase IN('stage','claim','check') AND (json_type(m.value,'$.sourceVersion') IS NOT 'integer' OR json_extract(m.value,'$.sourceVersion')<1 OR json_type(m.value,'$.sourceProofId') IS NOT 'text' OR json_type(m.value,'$.credentialVersion') IS NOT 'text'))) THEN RAISE(ABORT,'invalid LoTW ownership plan') END; END;

CREATE TRIGGER lotw_ownership_plan_pins BEFORE INSERT ON lotw_ownership_write_guards WHEN NEW.phase IN('claim','check') BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.plan) m WHERE NOT EXISTS(SELECT 1 FROM attempt_lotw_ownership_pins p WHERE p.tenant=NEW.tenant AND p.attempt=json_extract(m.value,'$.attempt') AND p.source=json_extract(m.value,'$.source') AND p.qso=json_extract(m.value,'$.qso') AND p.destination=json_extract(m.value,'$.destination') AND p.key_id=NEW.key_id AND p.namespace=json_extract(m.value,'$.namespace') AND p.identity_hash=json_extract(m.value,'$.identityHash') AND p.evidence_id=json_extract(m.value,'$.evidenceId') AND p.payload_hash=json_extract(m.value,'$.payloadHash') AND p.artifact_hash=json_extract(m.value,'$.artifactHash') AND p.generation=json_extract(m.value,'$.generation') AND p.source_hash=json_extract(m.value,'$.sourceHash') AND p.source_version=json_extract(m.value,'$.sourceVersion') AND p.source_export_proof_id=json_extract(m.value,'$.sourceProofId') AND p.credential_version=json_extract(m.value,'$.credentialVersion'))) THEN RAISE(ABORT,'LoTW ownership pin changed') END; END;
CREATE TRIGGER lotw_ownership_mapping_complete BEFORE DELETE ON lotw_ownership_write_guards WHEN OLD.phase='mapping' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(OLD.plan) m WHERE NOT EXISTS(SELECT 1 FROM ledger l WHERE l.tenant=OLD.tenant AND l.source=json_extract(m.value,'$.source') AND l.qso=json_extract(m.value,'$.qso') AND l.destination=json_extract(m.value,'$.destination') AND l.generation=json_extract(m.value,'$.generation') AND l.remote_id=json_extract(m.value,'$.identityHash') AND l.state='adopted_existing')) THEN RAISE(ABORT,'LoTW ownership mapping changed') END; END;

-- Conservative reroute fence. Query-account changes cannot make a prior upload
-- disappear. Old evidence with no recoverable station stays held rather than
-- assigning it to today's configured station. Actual receipt recovery is separate.
CREATE VIEW lotw_ownership_unsafe_attempts AS
 SELECT a.tenant,a.id,a.source,a.qso,a.destination FROM attempts a JOIN connections d ON d.tenant=a.tenant AND d.id=a.destination AND d.kind='lotw' LEFT JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id
 WHERE s.state IS NULL OR s.state NOT IN('cancelled','rejected') OR s.remote_id IS NOT NULL
 OR EXISTS(SELECT 1 FROM attempt_events e WHERE e.tenant=a.tenant AND e.attempt=a.id AND e.state IN('submitted','observed','delivered','uncertain','reconciliation_required'))
 OR (s.dispatched_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM attempt_events e WHERE e.tenant=a.tenant AND e.attempt=a.id AND e.state='retry_scheduled' AND e.at>=s.dispatched_at));
CREATE TRIGGER lotw_ownership_reroute_admission BEFORE INSERT ON lotw_ownership_write_guards WHEN NEW.phase IN('stage','claim','check') BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.plan) m JOIN lotw_ownership_unsafe_attempts a ON a.tenant=NEW.tenant AND a.source=json_extract(m.value,'$.source') AND a.qso=json_extract(m.value,'$.qso') AND a.destination!=json_extract(m.value,'$.destination')) OR EXISTS(SELECT 1 FROM json_each(NEW.plan) m JOIN lotw_ownership_inputs x ON x.tenant=NEW.tenant AND x.kind='mapping' AND x.source=json_extract(m.value,'$.source') AND x.qso=json_extract(m.value,'$.qso') AND x.destination!=json_extract(m.value,'$.destination')) THEN RAISE(ABORT,'LoTW ownership prior route unavailable') END;
END;
CREATE INDEX lotw_ownership_owner_input ON lotw_ownership_inputs(tenant,source,qso,kind,destination);
