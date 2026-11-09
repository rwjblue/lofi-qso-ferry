-- A committed vendor reservation is the point of possible send. The immutable
-- claim survives Worker loss, lease expiry and changes to the original source.
CREATE TABLE inventory_qrz_dispatches (
 tenant TEXT NOT NULL,attempt_id TEXT NOT NULL,claim_id TEXT NOT NULL,
 book_identity TEXT NOT NULL,observation_id TEXT NOT NULL,request_hash TEXT NOT NULL,
 lease_token TEXT NOT NULL,lease_fence INTEGER NOT NULL,
 claimed_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,settled_at INTEGER,
 PRIMARY KEY(tenant,attempt_id),UNIQUE(tenant,claim_id),
 FOREIGN KEY(tenant,attempt_id) REFERENCES inventory_qrz_attempts(tenant,attempt_id),
 FOREIGN KEY(tenant,observation_id) REFERENCES inventory_qrz_neighborhood_observations(tenant,observation_id),
 CHECK(claimed_at<expires_at)
);
CREATE TABLE inventory_qrz_dispatch_receipts (
 tenant TEXT NOT NULL,attempt_id TEXT NOT NULL,book_identity TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('delivered','observed')),
 remote_id TEXT NOT NULL CHECK(length(remote_id) BETWEEN 1 AND 64 AND remote_id NOT GLOB '*[^0-9]*' AND (remote_id='0' OR substr(remote_id,1,1)!='0')),
 connection_id TEXT NOT NULL,credential_version TEXT NOT NULL,connection_config TEXT NOT NULL CHECK(json_valid(connection_config)),
 lease_token TEXT NOT NULL,lease_fence INTEGER NOT NULL,read_started_at INTEGER,received_at INTEGER NOT NULL,
 PRIMARY KEY(tenant,attempt_id),UNIQUE(tenant,book_identity,remote_id),
 FOREIGN KEY(tenant,attempt_id) REFERENCES inventory_qrz_dispatches(tenant,attempt_id),
 FOREIGN KEY(tenant,connection_id) REFERENCES connections(tenant,id),
 CHECK((kind='delivered' AND read_started_at IS NULL) OR (kind='observed' AND read_started_at IS NOT NULL AND received_at BETWEEN read_started_at AND read_started_at+60000))
);
CREATE INDEX inventory_qrz_dispatch_unsettled ON inventory_qrz_dispatches(tenant,book_identity) WHERE settled_at IS NULL;
CREATE INDEX inventory_qrz_historical_remote ON inventory_ownership_evidence(tenant,book_identity,remote_id) WHERE provider='qrz';

CREATE VIEW inventory_qrz_dispatch_pending AS
 SELECT * FROM inventory_qrz_dispatches WHERE settled_at IS NULL;

-- An unsettled send is prior delivery evidence. Existing inventory review and
-- adoption pause while that tenant's QRZ outcome is unknown.
DROP VIEW inventory_prior_delivery_evidence;
CREATE VIEW inventory_prior_delivery_evidence AS
 SELECT a.tenant,d.kind AS provider FROM attempts a JOIN connections d ON d.tenant=a.tenant AND d.id=a.destination
 UNION ALL SELECT l.tenant,d.kind FROM ledger l JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination WHERE l.remote_id IS NOT NULL OR l.sent_hash IS NOT NULL OR l.remote_hash IS NOT NULL OR l.provenance!='unknown' OR l.confirmed!=0
 UNION ALL SELECT tenant,'qrz' FROM inventory_qrz_dispatch_pending;

-- A historical result for a sent source or its owned LOGID is still a valid
-- comparison, but it must never create a historical association.
CREATE VIEW inventory_qrz_delivery_owners AS
 SELECT r.tenant,r.book_identity,r.remote_id,a.source_identity,a.record_key
 FROM inventory_qrz_dispatch_receipts r JOIN inventory_qrz_attempts a USING(tenant,attempt_id);
DROP VIEW inventory_adoption_work_expected;
CREATE VIEW inventory_adoption_work_expected AS
 SELECT r.tenant,r.destination,r.source_scope,r.record_key,h.generation_id,r.set_id AS result_set,r.version AS result_version,
 s.config_version AS source_config_version,t.config_version AS destination_config_version,t.provider,
 t.scope_identity AS book_identity,s.scope_identity AS source_identity,h.prepared_at AS due_at
 FROM match_results r JOIN inventory_match_sets h ON h.tenant=r.tenant AND h.set_id=r.set_id AND h.state IN('prepared','committed')
 JOIN inventory_match_scopes s ON s.tenant=r.tenant AND s.set_id=r.set_id AND s.scope_id=r.source_scope AND s.source=1 AND s.provider='lofi'
 JOIN inventory_match_scopes t ON t.tenant=r.tenant AND t.set_id=r.set_id AND t.scope_id=r.destination AND t.provider IN('qrz','lotw')
 WHERE r.state='matched_existing' AND NOT EXISTS(SELECT 1 FROM inventory_historical_associations a WHERE a.tenant=r.tenant AND a.provider=t.provider AND a.book_identity=t.scope_identity AND a.source_identity=s.scope_identity AND a.record_key=r.record_key)
 AND (t.provider!='qrz' OR NOT EXISTS(SELECT 1 FROM inventory_qrz_delivery_owners o WHERE o.tenant=r.tenant AND o.book_identity=t.scope_identity
  AND ((o.source_identity,o.record_key)=(s.scope_identity,r.record_key) OR o.remote_id=coalesce(nullif(ltrim(r.remote_key,'0'),''),'0'))));
CREATE TRIGGER inventory_qrz_delivered_adoption BEFORE INSERT ON inventory_adoption_guards WHEN EXISTS(
 SELECT 1 FROM inventory_adoption_pages h JOIN inventory_adoption_rows a USING(tenant,page_id)
 JOIN inventory_qrz_delivery_owners o ON o.tenant=h.tenant AND o.book_identity=h.book_identity
 AND ((o.source_identity,o.record_key)=(a.source_identity,a.record_key) OR o.remote_id=a.remote_id)
 WHERE h.tenant=NEW.tenant AND h.page_id=NEW.page_id AND h.provider='qrz'
) BEGIN SELECT RAISE(ABORT,'inventory QRZ delivery already owns the record'); END;

CREATE TABLE inventory_qrz_dispatch_guards (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),tenant TEXT NOT NULL,attempt_id TEXT NOT NULL,
 claim_id TEXT NOT NULL,observation_id TEXT NOT NULL,request_hash TEXT NOT NULL,
 lease_token TEXT NOT NULL,lease_fence INTEGER NOT NULL,expires_at INTEGER NOT NULL
);
CREATE TRIGGER inventory_qrz_dispatch_guard BEFORE INSERT ON inventory_qrz_dispatch_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM inventory_qrz_neighborhood_current o
  WHERE (o.tenant,o.attempt_id,o.observation_id,o.request_hash,o.lease_token,o.lease_fence)=
        (NEW.tenant,NEW.attempt_id,NEW.observation_id,NEW.request_hash,NEW.lease_token,NEW.lease_fence)
  AND o.candidate_count=0 AND NEW.expires_at<=o.expires_at AND NEW.expires_at>unixepoch('subsec')*1000
 ) OR EXISTS(SELECT 1 FROM inventory_qrz_dispatches d WHERE d.tenant=NEW.tenant AND d.attempt_id=NEW.attempt_id)
 THEN RAISE(ABORT,'inventory QRZ dispatch authority changed') END;
END;
CREATE VIEW inventory_qrz_reserved_dispatch AS
 SELECT g.tenant,g.attempt_id,g.claim_id,a.book_identity,g.observation_id,g.request_hash,g.lease_token,g.lease_fence,
        CAST(unixepoch('subsec')*1000 AS INTEGER) AS claimed_at,g.expires_at
 FROM inventory_qrz_dispatch_guards g JOIN inventory_qrz_attempts a USING(tenant,attempt_id);
CREATE TRIGGER inventory_qrz_dispatch_on_first_slot AFTER INSERT ON vendor_requests WHEN NEW.vendor='qrz' AND NEW.requests=1 BEGIN
 INSERT INTO inventory_qrz_dispatches(tenant,attempt_id,claim_id,book_identity,observation_id,request_hash,lease_token,lease_fence,claimed_at,expires_at)
 SELECT tenant,attempt_id,claim_id,book_identity,observation_id,request_hash,lease_token,lease_fence,claimed_at,expires_at FROM inventory_qrz_reserved_dispatch;
END;
CREATE TRIGGER inventory_qrz_dispatch_on_reserved_slot AFTER UPDATE OF requests ON vendor_requests
 WHEN NEW.vendor='qrz' AND (NEW.window_start>OLD.window_start AND NEW.requests=1 OR NEW.window_start=OLD.window_start AND NEW.requests=OLD.requests+1)
 BEGIN
 INSERT INTO inventory_qrz_dispatches(tenant,attempt_id,claim_id,book_identity,observation_id,request_hash,lease_token,lease_fence,claimed_at,expires_at)
 SELECT tenant,attempt_id,claim_id,book_identity,observation_id,request_hash,lease_token,lease_fence,claimed_at,expires_at FROM inventory_qrz_reserved_dispatch;
END;
CREATE TRIGGER inventory_qrz_dispatch_insert BEFORE INSERT ON inventory_qrz_dispatches WHEN NEW.settled_at IS NOT NULL OR NOT EXISTS(
 SELECT 1 FROM inventory_qrz_reserved_dispatch g WHERE
 (g.tenant,g.attempt_id,g.claim_id,g.book_identity,g.observation_id,g.request_hash,g.lease_token,g.lease_fence,g.expires_at)=
 (NEW.tenant,NEW.attempt_id,NEW.claim_id,NEW.book_identity,NEW.observation_id,NEW.request_hash,NEW.lease_token,NEW.lease_fence,NEW.expires_at)
) BEGIN SELECT RAISE(ABORT,'inventory QRZ dispatch requires admission'); END;
CREATE TRIGGER inventory_qrz_dispatch_no_update BEFORE UPDATE OF tenant,attempt_id,claim_id,book_identity,observation_id,request_hash,lease_token,lease_fence,claimed_at,expires_at ON inventory_qrz_dispatches BEGIN SELECT RAISE(ABORT,'immutable inventory QRZ dispatch'); END;
CREATE TRIGGER inventory_qrz_dispatch_settled BEFORE UPDATE OF settled_at ON inventory_qrz_dispatches
 WHEN OLD.settled_at IS NOT NULL OR NEW.settled_at IS NULL OR NOT EXISTS(
  SELECT 1 FROM inventory_qrz_dispatch_receipts r WHERE (r.tenant,r.attempt_id,r.received_at)=(NEW.tenant,NEW.attempt_id,NEW.settled_at)
 ) BEGIN SELECT RAISE(ABORT,'inventory QRZ settlement requires a receipt'); END;
CREATE TRIGGER inventory_qrz_dispatch_no_delete BEFORE DELETE ON inventory_qrz_dispatches BEGIN SELECT RAISE(ABORT,'retained inventory QRZ dispatch'); END;
CREATE TRIGGER inventory_qrz_no_cancel_after_claim BEFORE UPDATE OF cancelled_at ON inventory_qrz_attempts WHEN EXISTS(
 SELECT 1 FROM inventory_qrz_dispatches d WHERE d.tenant=OLD.tenant AND d.attempt_id=OLD.attempt_id
) BEGIN SELECT RAISE(ABORT,'inventory QRZ dispatch cannot be cancelled'); END;
DROP VIEW inventory_qrz_attempt_current;
CREATE VIEW inventory_qrz_attempt_current AS
 SELECT a.tenant,a.attempt_id FROM inventory_qrz_attempts a
 JOIN inventory_qrz_preparations h ON h.tenant=a.tenant AND h.stage_id=a.stage_id AND h.committed_at IS NOT NULL
 WHERE a.cancelled_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM inventory_qrz_dispatches d WHERE d.tenant=a.tenant AND d.attempt_id=a.attempt_id)
 AND EXISTS(SELECT 1 FROM inventory_qrz_preparation_authority p WHERE p.tenant=a.tenant AND p.stage_id=a.stage_id)
 AND EXISTS(SELECT 1 FROM inventory_qrz_attempt_reviews r WHERE r.tenant=a.tenant AND r.attempt_id=a.attempt_id)
 AND NOT EXISTS(SELECT 1 FROM inventory_match_stale_sets x WHERE x.tenant=a.tenant AND x.set_id=a.result_set);

-- Readback uses current access to the original logical book. A replacement
-- lease may resolve the exact artifact without the old proof or template.
CREATE VIEW inventory_qrz_dispatch_receipt_authority AS
 SELECT d.tenant,d.attempt_id,d.book_identity,d.claim_id,d.lease_token AS dispatch_token,d.lease_fence AS dispatch_fence,
        h.destination_connection AS dispatch_connection,h.credential_version AS dispatch_credential,d.claimed_at,
        c.id AS connection_id,c.credential_version,json_remove(c.config,'$.lastError','$.lastSuccessfulPollAt') AS connection_config,
        l.scope AS lease_scope,l.token AS lease_token,l.fence AS lease_fence,l.expires_at AS lease_expires_at
 FROM inventory_qrz_dispatch_pending d JOIN inventory_qrz_attempts a USING(tenant,attempt_id)
 JOIN inventory_qrz_preparations h USING(tenant,stage_id)
 JOIN accounts tenant ON tenant.id=d.tenant AND tenant.status='active'
 JOIN connections c ON c.tenant=d.tenant AND c.kind='qrz' AND c.remote_identity=d.book_identity AND c.status='active'
 JOIN private_data p ON (p.tenant,p.connection,p.id,p.kind)=(c.tenant,c.id,c.credential_version,'credential')
 JOIN leases l ON l.tenant=d.tenant AND l.scope='inventory:qrz-delivery:'||d.book_identity
 WHERE json_extract(c.config,'$.bookId')=d.book_identity
 AND json_extract(c.config,'$.stationCallsign')=json_extract(h.destination_config,'$.stationCallsign') COLLATE NOCASE
 AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>unixepoch('subsec')*1000)
 AND l.expires_at>unixepoch('subsec')*1000;
CREATE TRIGGER inventory_qrz_receipt_insert BEFORE INSERT ON inventory_qrz_dispatch_receipts BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM inventory_qrz_dispatch_receipt_authority a
  WHERE (a.tenant,a.attempt_id,a.book_identity,a.connection_id,a.credential_version,a.lease_token,a.lease_fence)=
        (NEW.tenant,NEW.attempt_id,NEW.book_identity,NEW.connection_id,NEW.credential_version,NEW.lease_token,NEW.lease_fence)
  AND NEW.received_at>=a.claimed_at AND NEW.received_at<=unixepoch('subsec')*1000
  AND (NEW.kind='observed' AND a.lease_fence>a.dispatch_fence AND NEW.read_started_at>=a.claimed_at AND a.connection_config=NEW.connection_config OR NEW.kind='delivered'
    AND (a.dispatch_connection,a.dispatch_credential,a.dispatch_token,a.dispatch_fence)=(NEW.connection_id,NEW.credential_version,NEW.lease_token,NEW.lease_fence))
 ) OR EXISTS(SELECT 1 FROM inventory_ownership_evidence x WHERE x.tenant=NEW.tenant AND x.provider='qrz' AND x.book_identity=NEW.book_identity AND x.remote_id=NEW.remote_id)
 THEN RAISE(ABORT,'inventory QRZ receipt authority changed') END;
END;

ALTER TABLE inventory_qrz_neighborhood_guards ADD COLUMN recovery_connection TEXT;
ALTER TABLE inventory_qrz_neighborhood_guards ADD COLUMN recovery_credential TEXT;
ALTER TABLE inventory_qrz_neighborhood_guards ADD COLUMN recovery_config TEXT;
DROP TRIGGER inventory_qrz_neighborhood_guard;
CREATE TRIGGER inventory_qrz_neighborhood_guard BEFORE INSERT ON inventory_qrz_neighborhood_guards BEGIN
 SELECT CASE WHEN NEW.recovery_connection IS NULL AND NOT EXISTS(
  SELECT 1 FROM inventory_qrz_neighborhood_authority a
  WHERE (a.tenant,a.attempt_id,a.lease_token,a.lease_fence)=(NEW.tenant,NEW.attempt_id,NEW.lease_token,NEW.lease_fence)
 ) OR NEW.recovery_connection IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM inventory_qrz_dispatch_receipt_authority a
  WHERE (a.tenant,a.attempt_id,a.lease_token,a.lease_fence)=(NEW.tenant,NEW.attempt_id,NEW.lease_token,NEW.lease_fence)
  AND a.lease_fence>a.dispatch_fence
  AND (a.connection_id,a.credential_version,a.connection_config)=(NEW.recovery_connection,NEW.recovery_credential,NEW.recovery_config)
 ) THEN RAISE(ABORT,'inventory QRZ neighborhood authority changed') END;
END;
CREATE TRIGGER inventory_qrz_receipt_no_update BEFORE UPDATE ON inventory_qrz_dispatch_receipts BEGIN SELECT RAISE(ABORT,'immutable inventory QRZ receipt'); END;
CREATE TRIGGER inventory_qrz_receipt_no_delete BEFORE DELETE ON inventory_qrz_dispatch_receipts BEGIN SELECT RAISE(ABORT,'retained inventory QRZ receipt'); END;
CREATE TRIGGER inventory_qrz_receipt_settles AFTER INSERT ON inventory_qrz_dispatch_receipts BEGIN
 UPDATE inventory_qrz_dispatches SET settled_at=NEW.received_at WHERE tenant=NEW.tenant AND attempt_id=NEW.attempt_id;
 DELETE FROM inventory_adoption_work WHERE (tenant,destination,source_scope,record_key)=(
  SELECT a.tenant,h.destination,h.source_scope,a.record_key
  FROM inventory_qrz_attempts a JOIN inventory_qrz_preparations h USING(tenant,stage_id)
  WHERE a.tenant=NEW.tenant AND a.attempt_id=NEW.attempt_id
 );
END;
