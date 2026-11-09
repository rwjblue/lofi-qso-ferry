-- One signed artifact and a fixed, ordered member manifest. No dispatch
-- permission follows from publishing a preparation.
CREATE TABLE inventory_lotw_batches (
 tenant TEXT NOT NULL,batch_id TEXT NOT NULL,proof_id TEXT NOT NULL,source_scope TEXT NOT NULL,destination TEXT NOT NULL,
 source_identity TEXT NOT NULL,book_identity TEXT NOT NULL,destination_connection TEXT NOT NULL,
 destination_config TEXT NOT NULL CHECK(json_valid(destination_config)),credential_version TEXT NOT NULL,
 ownership_version INTEGER NOT NULL CHECK(ownership_version>=0),key_id TEXT NOT NULL,
 certificate_version TEXT NOT NULL,certificate_hash TEXT NOT NULL CHECK(length(certificate_hash)=43),
 certificate_checked_at INTEGER NOT NULL CHECK(certificate_checked_at>0),certificate_valid_until INTEGER NOT NULL,
 signing_configuration TEXT NOT NULL,station_hash TEXT NOT NULL CHECK(length(station_hash)=43),
 input_digest TEXT NOT NULL CHECK(length(input_digest)=43),manifest_hash TEXT NOT NULL CHECK(length(manifest_hash)=43),
 wire_hash TEXT NOT NULL CHECK(length(wire_hash)=43),wire_bytes INTEGER NOT NULL CHECK(wire_bytes BETWEEN 1 AND 512000),
 envelope TEXT NOT NULL CHECK(json_valid(envelope) AND length(envelope)<=1048576),
 prepared_at INTEGER NOT NULL,member_count INTEGER NOT NULL CHECK(member_count BETWEEN 1 AND 20),committed_at INTEGER,cancelled_at INTEGER,
 PRIMARY KEY(tenant,batch_id),
 FOREIGN KEY(tenant,proof_id) REFERENCES inventory_source_proofs(tenant,proof_id),
 FOREIGN KEY(tenant,source_scope) REFERENCES inventory_scopes(tenant,scope_id),
 FOREIGN KEY(tenant,destination) REFERENCES inventory_scopes(tenant,scope_id),
 FOREIGN KEY(tenant,destination_connection) REFERENCES connections(tenant,id),
 FOREIGN KEY(tenant,key_id) REFERENCES inventory_comparison_keys(tenant,key_id),
 CHECK(prepared_at BETWEEN certificate_checked_at AND certificate_valid_until),
 CHECK(committed_at IS NULL OR committed_at>=prepared_at),
 CHECK(cancelled_at IS NULL OR (committed_at IS NOT NULL AND cancelled_at>=committed_at))
);
CREATE TABLE inventory_lotw_batch_members (
 tenant TEXT NOT NULL,attempt_id TEXT NOT NULL,batch_id TEXT NOT NULL,position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 20),
 source_identity TEXT NOT NULL,record_key TEXT NOT NULL,result_set TEXT NOT NULL,result_version INTEGER NOT NULL CHECK(result_version>0),reviewed_at INTEGER NOT NULL,
 source_hash TEXT NOT NULL CHECK(length(source_hash)=64 AND source_hash NOT GLOB '*[^0-9a-f]*'),
 projection_hash TEXT NOT NULL CHECK(length(projection_hash)=43),identity_hash TEXT NOT NULL CHECK(length(identity_hash)=43),cancelled_at INTEGER,
 PRIMARY KEY(tenant,attempt_id),UNIQUE(tenant,batch_id,position),UNIQUE(tenant,batch_id,record_key),
 FOREIGN KEY(tenant,batch_id) REFERENCES inventory_lotw_batches(tenant,batch_id)
);
-- LoTW owners span query accounts and connection aliases.
CREATE UNIQUE INDEX inventory_lotw_active_source ON inventory_lotw_batch_members(tenant,source_identity,record_key) WHERE cancelled_at IS NULL;
CREATE UNIQUE INDEX inventory_lotw_active_identity ON inventory_lotw_batch_members(tenant,identity_hash) WHERE cancelled_at IS NULL;

CREATE VIEW inventory_lotw_batch_authority AS
 SELECT h.tenant,h.batch_id FROM inventory_lotw_batches h
 JOIN inventory_source_proof_current p ON (p.tenant,p.proof_id,p.scope_id)=(h.tenant,h.proof_id,h.source_scope)
 JOIN inventory_ownership_domains o ON (o.tenant,o.provider,o.key_id,o.version)=(h.tenant,'lotw',h.key_id,h.ownership_version)
 WHERE h.cancelled_at IS NULL AND h.certificate_valid_until>=unixepoch('subsec')*1000
 AND h.certificate_checked_at+86400000>unixepoch('subsec')*1000
 AND NOT EXISTS(SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=h.tenant);

CREATE VIEW inventory_lotw_batch_reviews AS
 SELECT a.tenant,a.batch_id,a.attempt_id,a.result_set FROM inventory_lotw_batch_members a
 JOIN inventory_lotw_batches h USING(tenant,batch_id)
 JOIN inventory_delivery_preparation_review r ON (r.tenant,r.source_scope,r.destination,r.record_key)=(a.tenant,h.source_scope,h.destination,a.record_key)
 JOIN inventory_source_proofs p ON (p.tenant,p.proof_id,p.scope_id)=(h.tenant,h.proof_id,h.source_scope)
 WHERE a.cancelled_at IS NULL AND r.provider='lotw' AND r.proof_not_before<=unixepoch('subsec')*1000
 AND (r.result_set,r.result_version,r.reviewed_at,r.ownership_version,r.source_identity,r.book_identity,r.destination_connection,r.destination_credential,r.destination_config)=
     (a.result_set,a.result_version,a.reviewed_at,h.ownership_version,a.source_identity,h.book_identity,h.destination_connection,h.credential_version,h.destination_config)
 AND (r.generation_id,r.source_config_version,r.source_credential)=
     (json_extract(p.snapshot,'$.source.generation_id'),json_extract(p.snapshot,'$.source.config_version'),json_extract(p.snapshot,'$.source.credential_version'))
 AND EXISTS(SELECT 1 FROM json_each(p.snapshot,'$.contacts') c WHERE json_extract(c.value,'$.key')=a.record_key
  AND (json_extract(c.value,'$.projectionVersion'),json_extract(c.value,'$.projectionPayload'))=(r.projection_version,r.projection_payload)
  AND EXISTS(SELECT 1 FROM json_each(c.value,'$.routes') x WHERE json_extract(x.value,'$.provider')='lotw' AND json_extract(x.value,'$.destination')=h.destination));

-- A cohort checks each distinct matching set once, at commit and preflight.
CREATE VIEW inventory_lotw_batch_inputs_current AS
 SELECT h.tenant,h.batch_id FROM inventory_lotw_batches h
 JOIN inventory_lotw_batch_authority p USING(tenant,batch_id)
 WHERE h.member_count=(SELECT count(*) FROM inventory_lotw_batch_reviews r WHERE (r.tenant,r.batch_id)=(h.tenant,h.batch_id))
 AND NOT EXISTS(SELECT 1 FROM (SELECT DISTINCT result_set FROM inventory_lotw_batch_members a WHERE (a.tenant,a.batch_id)=(h.tenant,h.batch_id)) r
   WHERE EXISTS(SELECT 1 FROM inventory_match_stale_sets x WHERE x.tenant=h.tenant AND x.set_id=r.result_set));
CREATE VIEW inventory_lotw_batch_current AS
 SELECT h.tenant,h.batch_id FROM inventory_lotw_batches h
 JOIN inventory_lotw_batch_inputs_current p USING(tenant,batch_id) WHERE h.committed_at IS NOT NULL;

CREATE TRIGGER inventory_lotw_batch_open BEFORE INSERT ON inventory_lotw_batches BEGIN
 SELECT CASE WHEN NEW.committed_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL
 OR EXISTS(SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=NEW.tenant)
 THEN RAISE(ABORT,'inventory LoTW preparation changed') END;
END;
CREATE TRIGGER inventory_lotw_member_open BEFORE INSERT ON inventory_lotw_batch_members BEGIN
 SELECT CASE WHEN NEW.cancelled_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM inventory_lotw_batches h
  WHERE (h.tenant,h.batch_id,h.source_identity)=(NEW.tenant,NEW.batch_id,NEW.source_identity)
  AND h.committed_at IS NULL AND NEW.position<=h.member_count)
 THEN RAISE(ABORT,'inventory LoTW preparation changed') END;
END;
CREATE TRIGGER inventory_lotw_batch_identity BEFORE UPDATE OF tenant,batch_id,proof_id,source_scope,destination,source_identity,book_identity,destination_connection,destination_config,credential_version,ownership_version,key_id,certificate_version,certificate_hash,certificate_checked_at,certificate_valid_until,signing_configuration,station_hash,input_digest,manifest_hash,wire_hash,wire_bytes,envelope,prepared_at,member_count ON inventory_lotw_batches BEGIN SELECT RAISE(ABORT,'immutable inventory LoTW batch'); END;
CREATE TRIGGER inventory_lotw_member_identity BEFORE UPDATE OF tenant,attempt_id,batch_id,position,source_identity,record_key,result_set,result_version,reviewed_at,source_hash,projection_hash,identity_hash ON inventory_lotw_batch_members BEGIN SELECT RAISE(ABORT,'immutable inventory LoTW member'); END;
CREATE TRIGGER inventory_lotw_batch_retained BEFORE DELETE ON inventory_lotw_batches BEGIN SELECT RAISE(ABORT,'retained inventory LoTW batch'); END;
CREATE TRIGGER inventory_lotw_member_retained BEFORE DELETE ON inventory_lotw_batch_members BEGIN SELECT RAISE(ABORT,'retained inventory LoTW member'); END;
CREATE TRIGGER inventory_lotw_batch_commit BEFORE UPDATE OF committed_at ON inventory_lotw_batches BEGIN
 SELECT CASE WHEN OLD.committed_at IS NOT NULL OR NEW.committed_at IS NULL OR NEW.committed_at>unixepoch('subsec')*1000
 OR NOT EXISTS(SELECT 1 FROM inventory_lotw_batch_inputs_current c WHERE (c.tenant,c.batch_id)=(OLD.tenant,OLD.batch_id))
 THEN RAISE(ABORT,'inventory LoTW preparation changed') END;
END;

CREATE TRIGGER inventory_lotw_batch_cancel BEFORE UPDATE OF cancelled_at ON inventory_lotw_batches BEGIN
 SELECT CASE WHEN OLD.cancelled_at IS NOT NULL OR OLD.committed_at IS NULL OR NEW.cancelled_at IS NULL OR NEW.cancelled_at>unixepoch('subsec')*1000
 OR EXISTS(SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=OLD.tenant)
 OR EXISTS(SELECT 1 FROM inventory_lotw_batch_current c WHERE (c.tenant,c.batch_id)=(OLD.tenant,OLD.batch_id))
 THEN RAISE(ABORT,'inventory LoTW batch cannot be cancelled') END;
END;
CREATE TRIGGER inventory_lotw_batch_release AFTER UPDATE OF cancelled_at ON inventory_lotw_batches BEGIN
 UPDATE inventory_lotw_batch_members SET cancelled_at=NEW.cancelled_at WHERE (tenant,batch_id)=(NEW.tenant,NEW.batch_id);
END;
CREATE TRIGGER inventory_lotw_member_cancel BEFORE UPDATE OF cancelled_at ON inventory_lotw_batch_members BEGIN
 SELECT CASE WHEN OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NULL OR NOT EXISTS(
  SELECT 1 FROM inventory_lotw_batches h WHERE (h.tenant,h.batch_id,h.cancelled_at)=(OLD.tenant,OLD.batch_id,NEW.cancelled_at)
 ) THEN RAISE(ABORT,'inventory LoTW member requires batch cancellation') END;
END;
