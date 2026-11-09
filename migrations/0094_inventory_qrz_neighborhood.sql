-- The book lease is shared by final reads and any later dispatch claim.
CREATE VIEW inventory_qrz_neighborhood_authority AS
 SELECT a.tenant,a.attempt_id,h.stage_id,h.destination,h.destination_connection,h.destination_config,h.credential_version,
        a.result_set,a.request_hash,h.committed_at,p.expires_at AS proof_expires_at,
        l.scope AS lease_scope,l.token AS lease_token,l.fence AS lease_fence,l.expires_at AS lease_expires_at
 FROM inventory_qrz_attempt_current c
 JOIN inventory_qrz_attempts a USING(tenant,attempt_id)
 JOIN inventory_qrz_preparations h USING(tenant,stage_id)
 JOIN inventory_source_proofs p ON p.tenant=h.tenant AND p.proof_id=h.proof_id
 JOIN leases l ON l.tenant=h.tenant AND l.scope='inventory:qrz-delivery:'||h.book_identity
 WHERE l.expires_at>unixepoch('subsec')*1000;

-- Scratch admission guard. The vendor reservation and guard removal share
-- its transaction, so a failed fence consumes no slot and sends no request.
CREATE TABLE inventory_qrz_neighborhood_guards (
 id TEXT PRIMARY KEY,tenant TEXT NOT NULL,attempt_id TEXT NOT NULL,
 lease_token TEXT NOT NULL,lease_fence INTEGER NOT NULL
);
CREATE TRIGGER inventory_qrz_neighborhood_guard BEFORE INSERT ON inventory_qrz_neighborhood_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM inventory_qrz_neighborhood_authority a
  WHERE (a.tenant,a.attempt_id,a.lease_token,a.lease_fence)=(NEW.tenant,NEW.attempt_id,NEW.lease_token,NEW.lease_fence)
 ) THEN RAISE(ABORT,'inventory QRZ neighborhood authority changed') END;
END;

CREATE TABLE inventory_qrz_neighborhood_observations (
 tenant TEXT NOT NULL,observation_id TEXT NOT NULL,attempt_id TEXT NOT NULL,
 request_hash TEXT NOT NULL CHECK(length(request_hash)=43),lease_token TEXT NOT NULL,lease_fence INTEGER NOT NULL,
 started_at INTEGER NOT NULL,completed_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 candidate_count INTEGER NOT NULL CHECK(candidate_count BETWEEN 0 AND 1000),
 PRIMARY KEY(tenant,observation_id),
 FOREIGN KEY(tenant,attempt_id) REFERENCES inventory_qrz_attempts(tenant,attempt_id),
 CHECK(started_at<=completed_at AND completed_at<expires_at)
);
CREATE INDEX inventory_qrz_neighborhood_expiry ON inventory_qrz_neighborhood_observations(expires_at,tenant,observation_id);
CREATE INDEX inventory_qrz_neighborhood_latest ON inventory_qrz_neighborhood_observations(tenant,attempt_id,lease_fence,started_at);
CREATE TRIGGER inventory_qrz_neighborhood_observed BEFORE INSERT ON inventory_qrz_neighborhood_observations BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM inventory_qrz_neighborhood_authority a
  WHERE (a.tenant,a.attempt_id,a.request_hash,a.lease_token,a.lease_fence)=
        (NEW.tenant,NEW.attempt_id,NEW.request_hash,NEW.lease_token,NEW.lease_fence)
  AND a.committed_at<=NEW.started_at AND NEW.completed_at<=unixepoch('subsec')*1000
  AND NEW.expires_at=min(a.proof_expires_at,a.lease_expires_at,NEW.started_at+60000)
  AND NEW.expires_at>unixepoch('subsec')*1000
 ) THEN RAISE(ABORT,'inventory QRZ neighborhood authority changed') END;
END;
CREATE TRIGGER inventory_qrz_neighborhood_immutable BEFORE UPDATE ON inventory_qrz_neighborhood_observations BEGIN SELECT RAISE(ABORT,'immutable inventory QRZ neighborhood observation'); END;
CREATE VIEW inventory_qrz_neighborhood_current AS
 SELECT o.* FROM inventory_qrz_neighborhood_observations o
 JOIN inventory_qrz_neighborhood_authority a ON a.tenant=o.tenant AND a.attempt_id=o.attempt_id
 AND a.request_hash=o.request_hash AND a.lease_token=o.lease_token AND a.lease_fence=o.lease_fence
 WHERE o.expires_at>unixepoch('subsec')*1000
 AND o.rowid=(
  SELECT x.rowid FROM inventory_qrz_neighborhood_observations x
  WHERE (x.tenant,x.attempt_id,x.lease_fence)=(o.tenant,o.attempt_id,o.lease_fence)
  ORDER BY x.started_at DESC,x.rowid DESC LIMIT 1
 );
