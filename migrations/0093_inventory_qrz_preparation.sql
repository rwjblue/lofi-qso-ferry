-- The preparation is a commit receipt for one bounded transaction. QRZ still
-- sends each member separately. Immutable artifacts carry no API key.
CREATE TABLE inventory_qrz_preparations (
 tenant TEXT NOT NULL,stage_id TEXT NOT NULL,proof_id TEXT NOT NULL,source_scope TEXT NOT NULL,destination TEXT NOT NULL,
 source_identity TEXT NOT NULL,book_identity TEXT NOT NULL,destination_connection TEXT NOT NULL,
 destination_config TEXT NOT NULL CHECK(json_valid(destination_config)),credential_version TEXT NOT NULL,
 template_version TEXT NOT NULL,ownership_version INTEGER NOT NULL CHECK(ownership_version>=0),
 input_digest TEXT NOT NULL CHECK(length(input_digest)=43),prepared_at INTEGER NOT NULL CHECK(prepared_at>0),
 member_count INTEGER NOT NULL CHECK(member_count BETWEEN 1 AND 20),committed_at INTEGER,
 PRIMARY KEY(tenant,stage_id),
 FOREIGN KEY(tenant,proof_id) REFERENCES inventory_source_proofs(tenant,proof_id),
 FOREIGN KEY(tenant,source_scope) REFERENCES inventory_scopes(tenant,scope_id),
 FOREIGN KEY(tenant,destination) REFERENCES inventory_scopes(tenant,scope_id),
 FOREIGN KEY(tenant,destination_connection,template_version) REFERENCES templates(tenant,destination,id),
 CHECK(committed_at IS NULL OR committed_at>=prepared_at)
);
CREATE TABLE inventory_qrz_attempts (
 tenant TEXT NOT NULL,attempt_id TEXT NOT NULL,stage_id TEXT NOT NULL,record_key TEXT NOT NULL,
 source_identity TEXT NOT NULL,book_identity TEXT NOT NULL,result_set TEXT NOT NULL,result_version INTEGER NOT NULL CHECK(result_version>0),
 reviewed_at INTEGER NOT NULL,source_hash TEXT NOT NULL CHECK(length(source_hash)=64 AND source_hash NOT GLOB '*[^0-9a-f]*'),
 identity_hash TEXT NOT NULL CHECK(length(identity_hash)=43),request_hash TEXT NOT NULL CHECK(length(request_hash)=43),
 envelope TEXT NOT NULL CHECK(json_valid(envelope) AND length(envelope)<=131072),cancelled_at INTEGER,
 PRIMARY KEY(tenant,attempt_id),UNIQUE(tenant,stage_id,record_key),
 FOREIGN KEY(tenant,stage_id) REFERENCES inventory_qrz_preparations(tenant,stage_id)
);
CREATE UNIQUE INDEX inventory_qrz_active_source ON inventory_qrz_attempts(tenant,book_identity,source_identity,record_key) WHERE cancelled_at IS NULL;
CREATE UNIQUE INDEX inventory_qrz_active_identity ON inventory_qrz_attempts(tenant,book_identity,identity_hash) WHERE cancelled_at IS NULL;

CREATE VIEW inventory_qrz_preparation_authority AS
 SELECT h.tenant,h.stage_id FROM inventory_qrz_preparations h
 JOIN inventory_source_proof_current p ON p.tenant=h.tenant AND p.proof_id=h.proof_id AND p.scope_id=h.source_scope
 JOIN active_templates t ON t.tenant=h.tenant AND t.destination=h.destination_connection AND t.version=h.template_version;

-- One exact review per member. Check matching sets separately so a cohort
-- can validate the shared comparison dependencies only once.
CREATE VIEW inventory_qrz_attempt_reviews AS
 SELECT a.tenant,a.attempt_id,a.stage_id,a.result_set FROM inventory_qrz_attempts a
 JOIN inventory_qrz_preparations h ON h.tenant=a.tenant AND h.stage_id=a.stage_id
 JOIN inventory_delivery_preparation_review r ON r.tenant=a.tenant AND r.source_scope=h.source_scope AND r.destination=h.destination AND r.record_key=a.record_key
 JOIN inventory_source_proofs p ON p.tenant=h.tenant AND p.proof_id=h.proof_id AND p.scope_id=h.source_scope
 WHERE r.provider='qrz' AND r.proof_not_before<=unixepoch('subsec')*1000
 AND (r.result_set,r.result_version,r.reviewed_at,r.ownership_version,r.source_identity,r.book_identity,r.destination_connection,r.destination_credential,r.destination_config)=
     (a.result_set,a.result_version,a.reviewed_at,h.ownership_version,a.source_identity,a.book_identity,h.destination_connection,h.credential_version,h.destination_config)
 AND (r.generation_id,r.source_config_version,r.source_credential)=
     (json_extract(p.snapshot,'$.source.generation_id'),json_extract(p.snapshot,'$.source.config_version'),json_extract(p.snapshot,'$.source.credential_version'))
 AND EXISTS(SELECT 1 FROM json_each(p.snapshot,'$.contacts') c WHERE json_extract(c.value,'$.key')=a.record_key
  AND (json_extract(c.value,'$.projectionVersion'),json_extract(c.value,'$.projectionPayload'))=(r.projection_version,r.projection_payload)
  AND EXISTS(SELECT 1 FROM json_each(c.value,'$.routes') x WHERE json_extract(x.value,'$.provider')='qrz' AND json_extract(x.value,'$.destination')=h.destination));

-- This is a preparation check. Network dispatch needs its own fresh read,
-- fenced claim and write authorization in addition to this predicate.
CREATE VIEW inventory_qrz_attempt_current AS
 SELECT a.tenant,a.attempt_id FROM inventory_qrz_attempts a
 JOIN inventory_qrz_preparations h ON h.tenant=a.tenant AND h.stage_id=a.stage_id AND h.committed_at IS NOT NULL
 WHERE a.cancelled_at IS NULL
 AND EXISTS(SELECT 1 FROM inventory_qrz_preparation_authority p WHERE p.tenant=a.tenant AND p.stage_id=a.stage_id)
 AND EXISTS(SELECT 1 FROM inventory_qrz_attempt_reviews r WHERE r.tenant=a.tenant AND r.attempt_id=a.attempt_id)
 AND NOT EXISTS(SELECT 1 FROM inventory_match_stale_sets x WHERE x.tenant=a.tenant AND x.set_id=a.result_set);

CREATE TRIGGER inventory_qrz_preparation_open BEFORE INSERT ON inventory_qrz_preparations WHEN NEW.committed_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'inventory QRZ preparation must start open'); END;
CREATE TRIGGER inventory_qrz_preparation_identity BEFORE UPDATE OF tenant,stage_id,proof_id,source_scope,destination,source_identity,book_identity,destination_connection,destination_config,credential_version,template_version,ownership_version,input_digest,prepared_at,member_count ON inventory_qrz_preparations BEGIN SELECT RAISE(ABORT,'immutable inventory QRZ preparation'); END;
CREATE TRIGGER inventory_qrz_attempt_open BEFORE INSERT ON inventory_qrz_attempts BEGIN
 SELECT CASE WHEN NEW.cancelled_at IS NOT NULL OR NOT EXISTS(
  SELECT 1 FROM inventory_qrz_preparations h WHERE h.tenant=NEW.tenant AND h.stage_id=NEW.stage_id AND h.committed_at IS NULL
  AND (h.source_identity,h.book_identity)=(NEW.source_identity,NEW.book_identity)
 ) THEN RAISE(ABORT,'inventory QRZ preparation closed') END;
END;
CREATE TRIGGER inventory_qrz_attempt_identity BEFORE UPDATE OF tenant,attempt_id,stage_id,record_key,source_identity,book_identity,result_set,result_version,reviewed_at,source_hash,identity_hash,request_hash,envelope ON inventory_qrz_attempts BEGIN SELECT RAISE(ABORT,'immutable inventory QRZ attempt'); END;
CREATE TRIGGER inventory_qrz_attempt_delete BEFORE DELETE ON inventory_qrz_attempts BEGIN SELECT RAISE(ABORT,'retained inventory QRZ attempt'); END;

CREATE TRIGGER inventory_qrz_preparation_commit BEFORE UPDATE OF committed_at ON inventory_qrz_preparations BEGIN
 SELECT CASE WHEN OLD.committed_at IS NOT NULL OR NEW.committed_at IS NULL OR NEW.committed_at>unixepoch('subsec')*1000
 OR json_extract(OLD.destination_config,'$.bookId') IS NOT OLD.book_identity
 OR NOT EXISTS(SELECT 1 FROM inventory_qrz_preparation_authority p WHERE p.tenant=OLD.tenant AND p.stage_id=OLD.stage_id)
 OR OLD.member_count!=(SELECT count(*) FROM inventory_qrz_attempts a WHERE a.tenant=OLD.tenant AND a.stage_id=OLD.stage_id)
 OR OLD.member_count!=(SELECT count(*) FROM inventory_qrz_attempt_reviews r WHERE r.tenant=OLD.tenant AND r.stage_id=OLD.stage_id)
 OR EXISTS(SELECT 1 FROM (SELECT DISTINCT result_set FROM inventory_qrz_attempts WHERE tenant=OLD.tenant AND stage_id=OLD.stage_id) r
            WHERE EXISTS(SELECT 1 FROM inventory_match_stale_sets x WHERE x.tenant=OLD.tenant AND x.set_id=r.result_set))
 THEN RAISE(ABORT,'inventory QRZ preparation changed') END;
END;
CREATE TRIGGER inventory_qrz_cancel_stale BEFORE UPDATE OF cancelled_at ON inventory_qrz_attempts BEGIN
 SELECT CASE WHEN OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NULL OR NEW.cancelled_at>unixepoch('subsec')*1000
 OR NOT EXISTS(SELECT 1 FROM inventory_qrz_preparations h WHERE h.tenant=OLD.tenant AND h.stage_id=OLD.stage_id AND h.committed_at<=NEW.cancelled_at)
 OR EXISTS(SELECT 1 FROM inventory_qrz_attempt_current a WHERE a.tenant=OLD.tenant AND a.attempt_id=OLD.attempt_id)
 THEN RAISE(ABORT,'inventory QRZ attempt cannot be cancelled') END;
END;
