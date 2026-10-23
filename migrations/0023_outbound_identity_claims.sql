-- Minimal destination identities persist independently of encrypted artifacts.
-- Ownership is deliberately never recycled automatically, including cancelled
-- preparations, expired payloads, source edits and revoked connections.
CREATE TABLE destination_identity_claims (
 tenant TEXT NOT NULL, destination TEXT NOT NULL, vendor TEXT NOT NULL CHECK(vendor IN('qrz','lotw')),
 identity_hash TEXT NOT NULL CHECK(length(identity_hash)=43), source TEXT NOT NULL, qso TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(tenant,destination,vendor,identity_hash),
 FOREIGN KEY(tenant,source,qso,destination) REFERENCES ledger(tenant,source,qso,destination)
);
CREATE INDEX destination_claim_owner ON destination_identity_claims(tenant,destination,source,qso);
CREATE TRIGGER destination_claim_immutable BEFORE UPDATE ON destination_identity_claims BEGIN SELECT RAISE(ABORT,'immutable destination identity claim'); END;
CREATE TRIGGER destination_claim_retained BEFORE DELETE ON destination_identity_claims BEGIN SELECT RAISE(ABORT,'destination identity claim requires explicit review'); END;

CREATE TABLE attempt_identity_claims (
 tenant TEXT NOT NULL, attempt TEXT NOT NULL, destination TEXT NOT NULL, vendor TEXT NOT NULL,
 identity_hash TEXT NOT NULL, source TEXT NOT NULL, qso TEXT NOT NULL, source_version INTEGER,
 PRIMARY KEY(tenant,attempt),
 FOREIGN KEY(tenant,attempt) REFERENCES attempts(tenant,id),
 FOREIGN KEY(tenant,destination,vendor,identity_hash) REFERENCES destination_identity_claims(tenant,destination,vendor,identity_hash)
);
CREATE TRIGGER attempt_identity_immutable BEFORE UPDATE ON attempt_identity_claims BEGIN SELECT RAISE(ABORT,'immutable attempt identity claim'); END;
CREATE TRIGGER attempt_identity_retained BEFORE DELETE ON attempt_identity_claims BEGIN SELECT RAISE(ABORT,'attempt identity claim requires explicit review'); END;
CREATE TRIGGER attempt_identity_owner BEFORE INSERT ON attempt_identity_claims BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM attempts a JOIN destination_identity_claims c ON c.tenant=a.tenant AND c.destination=a.destination AND c.source=a.source AND c.qso=a.qso WHERE a.tenant=NEW.tenant AND a.id=NEW.attempt AND a.destination=NEW.destination AND a.source=NEW.source AND a.qso=NEW.qso AND c.vendor=NEW.vendor AND c.identity_hash=NEW.identity_hash) THEN RAISE(ABORT,'outbound identity claim conflict') END;
END;

-- LoTW association IDs already are canonical identity hashes. Older retained
-- LoTW identity ciphertext remains an additional exclusion at claim acquisition.
INSERT INTO destination_identity_claims(tenant,destination,vendor,identity_hash,source,qso,created_at)
SELECT l.tenant,l.destination,'lotw',l.remote_id,l.source,l.qso,l.updated_at FROM ledger l JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination WHERE d.kind='lotw' AND l.remote_id IS NOT NULL AND length(l.remote_id)=43;

-- QRZ LOGIDs cannot be converted into identities from a source that may have
-- changed. Require an exact mapped-record read before any destination writes.
CREATE TABLE legacy_qrz_identity_reservations (
 tenant TEXT NOT NULL, destination TEXT NOT NULL, source TEXT NOT NULL, qso TEXT NOT NULL, remote_id TEXT NOT NULL,
 checked_at INTEGER NOT NULL DEFAULT 0, next_check_at INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant,destination,source,qso),
 FOREIGN KEY(tenant,source,qso,destination) REFERENCES ledger(tenant,source,qso,destination)
);
CREATE INDEX legacy_qrz_identity_due ON legacy_qrz_identity_reservations(next_check_at,checked_at);
INSERT INTO legacy_qrz_identity_reservations(tenant,destination,source,qso,remote_id) SELECT l.tenant,l.destination,l.source,l.qso,l.remote_id FROM ledger l JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination WHERE d.kind='qrz' AND l.remote_id IS NOT NULL;

-- A pre-migration write may have reached a vendor without a LOGID/receipt.
-- Do not infer an identity from absence or expiry of its encrypted outbox.
-- These rare reservations need explicit artifact/receipt recovery before reuse.
CREATE TABLE legacy_outbound_identity_reservations (
 tenant TEXT NOT NULL, destination TEXT NOT NULL, source TEXT NOT NULL, qso TEXT NOT NULL, attempt TEXT NOT NULL,
 PRIMARY KEY(tenant,destination,attempt), FOREIGN KEY(tenant,attempt) REFERENCES attempts(tenant,id)
);
INSERT INTO legacy_outbound_identity_reservations SELECT a.tenant,a.destination,a.source,a.qso,a.id FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE s.state IN('dispatching','uncertain','submitted','reconciliation_required','delivered','observed');

ALTER TABLE stage_guards ADD COLUMN identity_vendor TEXT;
ALTER TABLE stage_guards ADD COLUMN identity_hash TEXT;
ALTER TABLE stage_guards ADD COLUMN identity_source_version INTEGER;
ALTER TABLE stage_guards ADD COLUMN identity_lotw_owner_id TEXT;
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

CREATE TRIGGER dispatch_identity_guard BEFORE UPDATE OF state ON attempt_state WHEN NEW.state='dispatching' AND OLD.state!='dispatching' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM attempts a JOIN leases lease ON lease.tenant=a.tenant AND lease.scope='delivery:'||a.destination AND lease.token=NEW.lease_token AND lease.fence=NEW.fence AND lease.expires_at>NEW.updated_at WHERE a.tenant=NEW.tenant AND a.id=NEW.attempt) THEN RAISE(ABORT,'identity dispatch lease lost') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM attempts a JOIN attempt_identity_claims i ON i.tenant=a.tenant AND i.attempt=a.id AND i.destination=a.destination AND i.source=a.source AND i.qso=a.qso JOIN destination_identity_claims c ON c.tenant=i.tenant AND c.destination=i.destination AND c.vendor=i.vendor AND c.identity_hash=i.identity_hash AND c.source=i.source AND c.qso=i.qso JOIN connections d ON d.tenant=a.tenant AND d.id=a.destination AND d.kind=i.vendor JOIN ledger l ON l.tenant=a.tenant AND l.source=a.source AND l.qso=a.qso AND l.destination=a.destination WHERE a.tenant=NEW.tenant AND a.id=NEW.attempt AND l.generation=a.generation AND l.source_hash=a.source_hash AND l.provenance!='adoption_conflict' AND l.state NOT IN('source_deleted','retained_old_route')) THEN RAISE(ABORT,'outbound identity claim unavailable') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM attempts a JOIN legacy_qrz_identity_reservations r ON r.tenant=a.tenant AND r.destination=a.destination WHERE a.tenant=NEW.tenant AND a.id=NEW.attempt) THEN RAISE(ABORT,'legacy QRZ identity backfill required') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM attempts a JOIN legacy_outbound_identity_reservations r ON r.tenant=a.tenant AND r.destination=a.destination WHERE a.tenant=NEW.tenant AND a.id=NEW.attempt) THEN RAISE(ABORT,'legacy outbound identity backfill required') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM attempts a JOIN attempt_identity_claims i ON i.tenant=a.tenant AND i.attempt=a.id JOIN ledger l ON l.tenant=a.tenant AND l.source=a.source AND l.qso=a.qso AND l.destination=a.destination WHERE a.tenant=NEW.tenant AND a.id=NEW.attempt AND l.context_generation IS NOT NULL AND NOT EXISTS(SELECT 1 FROM reconciliation_work r JOIN source_work w ON w.tenant=r.tenant AND w.source=r.source AND w.id=r.qso AND w.kind='qso' JOIN private_data p ON p.tenant=w.tenant AND p.connection=w.source AND p.id=w.private_id AND p.kind='source' WHERE r.tenant=a.tenant AND r.source=a.source AND r.qso=a.qso AND r.version=i.source_version AND w.deleted=0 AND w.state IN('pending','waiting') AND w.expires_at>NEW.updated_at AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>NEW.updated_at))) THEN RAISE(ABORT,'source changed before identity dispatch') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM attempts a JOIN ledger l ON l.tenant=a.tenant AND l.source=a.source AND l.qso=a.qso AND l.destination=a.destination WHERE a.tenant=NEW.tenant AND a.id=NEW.attempt AND l.context_generation IS NOT NULL AND l.operation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM source_work o JOIN private_data op ON op.tenant=o.tenant AND op.connection=o.source AND op.id=o.private_id AND op.kind='source' WHERE o.tenant=l.tenant AND o.source=l.source AND o.id=l.operation_id AND o.kind='operation' AND o.state='context' AND o.deleted=0 AND o.expires_at>NEW.updated_at AND op.revoked_at IS NULL AND (op.expires_at IS NULL OR op.expires_at>NEW.updated_at) AND NOT EXISTS(SELECT 1 FROM source_work e LEFT JOIN private_data ep ON ep.tenant=e.tenant AND ep.connection=e.source AND ep.id=e.private_id AND ep.kind='source' WHERE e.tenant=o.tenant AND e.source=o.source AND e.operation_id=o.id AND e.kind='qso' AND e.is_event=1 AND e.deleted=0 AND (e.expires_at<=NEW.updated_at OR ep.id IS NULL OR ep.revoked_at IS NOT NULL OR (ep.expires_at IS NOT NULL AND ep.expires_at<=NEW.updated_at))))) THEN RAISE(ABORT,'source dependencies unavailable before identity dispatch') END;
END;
