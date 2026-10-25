-- Recoverability only: the original encrypted staged payload, with its original
-- storage AAD and expiry. Never a source, receipt, ownership or retry authority.
-- Keep every referenced KEK while these immutable envelopes or backups remain.
CREATE TABLE attempt_artifacts (
 tenant TEXT NOT NULL, attempt TEXT NOT NULL,
 connection TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind='outbox'),
 envelope TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 revoked_at INTEGER, source_proof_version TEXT NOT NULL,
 PRIMARY KEY(tenant,attempt),
 FOREIGN KEY(tenant,attempt) REFERENCES attempts(tenant,id) ON DELETE CASCADE
);
CREATE INDEX attempt_artifacts_expiry ON attempt_artifacts(expires_at);

CREATE TRIGGER attempt_artifact_original BEFORE INSERT ON attempt_artifacts BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM attempts a JOIN private_data p
   ON p.tenant=a.tenant AND p.connection=a.destination AND p.id=a.payload_id AND p.kind='outbox'
  WHERE a.tenant=NEW.tenant AND a.id=NEW.attempt
   AND p.connection=NEW.connection AND p.id=NEW.id AND p.kind=NEW.kind
   AND p.envelope=NEW.envelope AND p.created_at=NEW.created_at
   AND p.expires_at=NEW.expires_at AND p.revoked_at IS NEW.revoked_at
   AND p.source_proof_version=NEW.source_proof_version AND p.revoked_at IS NULL
   AND p.expires_at>a.created_at AND p.expires_at<=a.created_at+604800000
 ) THEN RAISE(ABORT,'original attempt artifact unavailable') END;
END;
CREATE TRIGGER attempt_artifact_immutable BEFORE UPDATE ON attempt_artifacts BEGIN
 SELECT RAISE(ABORT,'immutable attempt artifact');
END;

-- Retain only actual still-available legacy bodies. Purged or expired payloads
-- cannot be reconstructed from hashes or mapped receipts.
INSERT INTO attempt_artifacts(tenant,attempt,connection,id,kind,envelope,created_at,expires_at,revoked_at,source_proof_version)
 SELECT a.tenant,a.id,p.connection,p.id,p.kind,p.envelope,p.created_at,p.expires_at,p.revoked_at,p.source_proof_version
 FROM attempts a JOIN private_data p
  ON p.tenant=a.tenant AND p.connection=a.destination AND p.id=a.payload_id AND p.kind='outbox'
 WHERE p.revoked_at IS NULL AND p.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)
  AND p.expires_at>a.created_at AND p.expires_at<=a.created_at+604800000;

-- Normal staging inserts its outbox before its immutable attempt, in one native
-- transaction. This also captures older workers using that same staging order.
-- Missing capture aborts the complete stage, including prior cohort members.
CREATE TRIGGER attempt_artifact_capture AFTER INSERT ON attempts BEGIN
 INSERT INTO attempt_artifacts(tenant,attempt,connection,id,kind,envelope,created_at,expires_at,revoked_at,source_proof_version)
  SELECT NEW.tenant,NEW.id,p.connection,p.id,p.kind,p.envelope,p.created_at,p.expires_at,p.revoked_at,p.source_proof_version
  FROM private_data p WHERE p.tenant=NEW.tenant AND p.connection=NEW.destination AND p.id=NEW.payload_id AND p.kind='outbox';
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM attempt_artifacts WHERE tenant=NEW.tenant AND attempt=NEW.id)
  THEN RAISE(ABORT,'original attempt artifact unavailable') END;
END;
