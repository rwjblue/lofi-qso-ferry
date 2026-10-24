-- A new incarnation closes deletion/reinsertion and ciphertext-renewal races.
-- Bearer credential renewal does not change the logical source credential ID.
ALTER TABLE private_data ADD COLUMN source_proof_version TEXT NOT NULL DEFAULT '';
UPDATE private_data SET source_proof_version=lower(hex(randomblob(16))) WHERE kind='source';
CREATE TRIGGER source_export_body_insert AFTER INSERT ON private_data WHEN NEW.kind='source' BEGIN
 UPDATE private_data SET source_proof_version=lower(hex(randomblob(16))) WHERE tenant=NEW.tenant AND connection=NEW.connection AND id=NEW.id AND kind=NEW.kind;
END;
CREATE TRIGGER source_export_body_update AFTER UPDATE OF tenant,connection,id,kind,envelope,expires_at,revoked_at,created_at ON private_data
WHEN NEW.kind='source' AND (NEW.tenant IS NOT OLD.tenant OR NEW.connection IS NOT OLD.connection OR NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind OR NEW.envelope IS NOT OLD.envelope OR NEW.expires_at IS NOT OLD.expires_at OR NEW.revoked_at IS NOT OLD.revoked_at OR NEW.created_at IS NOT OLD.created_at) BEGIN
 UPDATE private_data SET source_proof_version=lower(hex(randomblob(16))) WHERE tenant=NEW.tenant AND connection=NEW.connection AND id=NEW.id AND kind=NEW.kind;
END;

-- Observation metadata only: never plaintext bodies or source credentials.
-- This unused foundation does not authorize staging or dispatching an export.
CREATE TABLE source_export_proofs (
 tenant TEXT NOT NULL,id TEXT NOT NULL,source TEXT NOT NULL,qso TEXT NOT NULL,
 created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 proof TEXT NOT NULL CHECK(json_valid(proof) AND length(proof)<=131072),
 PRIMARY KEY(tenant,id),FOREIGN KEY(tenant,source) REFERENCES connections(tenant,id),
 CHECK(expires_at>created_at),
 CHECK(json_extract(proof,'$.scope.tenant') IS tenant AND json_extract(proof,'$.id') IS id
  AND json_extract(proof,'$.scope.source') IS source AND json_extract(proof,'$.qso') IS qso
  AND json_extract(proof,'$.createdAt') IS created_at AND json_extract(proof,'$.expiresAt') IS expires_at)
);
CREATE INDEX source_export_proof_contact ON source_export_proofs(tenant,source,qso,expires_at);
CREATE INDEX source_export_proof_expiry ON source_export_proofs(expires_at,tenant,id);
CREATE TRIGGER source_export_proof_immutable BEFORE UPDATE ON source_export_proofs BEGIN
 SELECT RAISE(ABORT,'source export proof is immutable');
END;
CREATE TRIGGER source_export_proof_no_replace BEFORE INSERT ON source_export_proofs
WHEN EXISTS(SELECT 1 FROM source_export_proofs WHERE tenant=NEW.tenant AND id=NEW.id) BEGIN
 SELECT RAISE(ABORT,'source export proof id already exists');
END;

-- A failed cohort member rolls the entire mint batch back. No durable guards.
CREATE TABLE source_export_proof_batch_guards (
 id TEXT PRIMARY KEY,expected_count INTEGER NOT NULL,actual_count INTEGER NOT NULL,
 CHECK(expected_count=actual_count)
);
