-- A file result never settles the batch. Only complete independent member
-- receipts release the provider-wide hold. Retain the original claim forever.
ALTER TABLE inventory_lotw_dispatches ADD COLUMN settled_at INTEGER;
DROP TRIGGER inventory_lotw_dispatch_immutable;
CREATE TRIGGER inventory_lotw_dispatch_immutable BEFORE UPDATE OF tenant,batch_id,claim_id,observation_id,wire_hash,lease_token,lease_fence,claimed_at,expires_at ON inventory_lotw_dispatches BEGIN SELECT RAISE(ABORT,'immutable inventory LoTW dispatch'); END;
DROP VIEW inventory_lotw_dispatch_pending;
CREATE VIEW inventory_lotw_dispatch_pending AS SELECT * FROM inventory_lotw_dispatches WHERE settled_at IS NULL;
CREATE INDEX inventory_lotw_pending ON inventory_lotw_dispatches(tenant,batch_id) WHERE settled_at IS NULL;
ALTER TABLE inventory_fresh_start_lock ADD COLUMN prior_lotw_unsettled INTEGER NOT NULL DEFAULT 0 CHECK(prior_lotw_unsettled>=0);

-- Fix the reservation inserts to allow the new settlement column to default.
DROP TRIGGER inventory_lotw_dispatch_first_slot;
DROP TRIGGER inventory_lotw_dispatch_reserved_slot;
CREATE TRIGGER inventory_lotw_dispatch_first_slot AFTER INSERT ON vendor_requests WHEN NEW.vendor='lotw' AND NEW.requests=1 BEGIN
 INSERT INTO inventory_lotw_dispatches(tenant,batch_id,claim_id,observation_id,wire_hash,lease_token,lease_fence,claimed_at,expires_at)
 SELECT * FROM inventory_lotw_reserved_dispatch;
END;
CREATE TRIGGER inventory_lotw_dispatch_reserved_slot AFTER UPDATE OF requests ON vendor_requests
 WHEN NEW.vendor='lotw' AND (NEW.window_start>OLD.window_start AND NEW.requests=1 OR NEW.window_start=OLD.window_start AND NEW.requests=OLD.requests+1)
BEGIN
 INSERT INTO inventory_lotw_dispatches(tenant,batch_id,claim_id,observation_id,wire_hash,lease_token,lease_fence,claimed_at,expires_at)
 SELECT * FROM inventory_lotw_reserved_dispatch;
END;
CREATE TRIGGER inventory_lotw_dispatch_open BEFORE INSERT ON inventory_lotw_dispatches WHEN NEW.settled_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'inventory LoTW dispatch must start pending'); END;

CREATE VIEW inventory_lotw_readback_authority AS
 SELECT d.tenant,d.batch_id,d.claimed_at,d.wire_hash,h.source_scope,h.source_identity,h.destination AS destination_scope,h.book_identity,h.key_id,
        c.id AS connection_id,c.credential_version,json_remove(c.config,'$.lastError','$.lastSuccessfulPollAt') AS connection_config,
        l.token AS lease_token,l.fence AS lease_fence,l.expires_at AS lease_expires_at
 FROM inventory_lotw_dispatch_pending d JOIN inventory_lotw_batches h USING(tenant,batch_id)
 JOIN accounts a ON a.id=d.tenant AND a.status='active'
 JOIN connections c ON c.tenant=d.tenant AND c.kind='lotw' AND c.remote_identity=h.book_identity AND c.status='active'
 JOIN private_data p ON (p.tenant,p.connection,p.id,p.kind)=(c.tenant,c.id,c.credential_version,'credential')
 JOIN leases l ON l.tenant=d.tenant AND l.scope='inventory:lotw-delivery' AND l.fence>d.lease_fence
 WHERE json_extract(c.config,'$.readAccess')=1 AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>unixepoch('subsec')*1000)
 AND l.expires_at>unixepoch('subsec')*1000 AND NOT EXISTS(SELECT 1 FROM inventory_restore_locks x WHERE x.tenant=d.tenant);

ALTER TABLE inventory_lotw_read_guards ADD COLUMN readback INTEGER NOT NULL DEFAULT 0 CHECK(readback IN(0,1));
DROP TRIGGER inventory_lotw_read_guard;
CREATE TRIGGER inventory_lotw_read_guard BEFORE INSERT ON inventory_lotw_read_guards BEGIN
 SELECT CASE WHEN (NEW.readback=0 AND NOT EXISTS(
   SELECT 1 FROM inventory_lotw_send_authority c WHERE (c.tenant,c.batch_id,c.lease_token,c.lease_fence)=(NEW.tenant,NEW.batch_id,NEW.lease_token,NEW.lease_fence)
  )) OR (NEW.readback=1 AND NOT EXISTS(
   SELECT 1 FROM inventory_lotw_readback_authority c WHERE (c.tenant,c.batch_id,c.lease_token,c.lease_fence)=(NEW.tenant,NEW.batch_id,NEW.lease_token,NEW.lease_fence)
  )) THEN RAISE(ABORT,'inventory LoTW read authority changed') END;
END;

CREATE TABLE inventory_lotw_receipt_guards (
 tenant TEXT NOT NULL,batch_id TEXT NOT NULL,guard_id TEXT NOT NULL,
 lease_token TEXT NOT NULL,lease_fence INTEGER NOT NULL,connection_id TEXT NOT NULL,credential_version TEXT NOT NULL,connection_config TEXT NOT NULL,
 ownership_version INTEGER NOT NULL,read_started_at INTEGER NOT NULL,member_count INTEGER NOT NULL CHECK(member_count BETWEEN 1 AND 20),
 manifest TEXT NOT NULL CHECK(json_valid(manifest) AND json_type(manifest)='array' AND json_array_length(manifest)=member_count),
 PRIMARY KEY(tenant,batch_id),UNIQUE(tenant,guard_id)
);
CREATE TRIGGER inventory_lotw_receipt_guard BEFORE INSERT ON inventory_lotw_receipt_guards WHEN NOT EXISTS(
 SELECT 1 FROM inventory_lotw_readback_authority a JOIN inventory_ownership_domains o ON (o.tenant,o.provider,o.key_id)=(a.tenant,'lotw',a.key_id)
 WHERE (a.tenant,a.batch_id,a.lease_token,a.lease_fence,a.connection_id,a.credential_version,a.connection_config,o.version)=
       (NEW.tenant,NEW.batch_id,NEW.lease_token,NEW.lease_fence,NEW.connection_id,NEW.credential_version,NEW.connection_config,NEW.ownership_version)
 AND NEW.read_started_at>a.claimed_at AND NEW.read_started_at<=unixepoch('subsec')*1000 AND NEW.read_started_at+60000>unixepoch('subsec')*1000
 AND NOT EXISTS(SELECT 1 FROM inventory_ownership_holds x WHERE x.tenant=a.tenant AND x.provider='lotw')
) BEGIN
 SELECT RAISE(ABORT,'inventory LoTW receipt authority changed');
END;
CREATE TRIGGER inventory_lotw_receipt_guard_immutable BEFORE UPDATE ON inventory_lotw_receipt_guards BEGIN SELECT RAISE(ABORT,'immutable inventory LoTW receipt guard'); END;

DROP TRIGGER inventory_ownership_evidence_admission;
CREATE TRIGGER inventory_ownership_evidence_admission BEFORE INSERT ON inventory_ownership_evidence BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_adoption_rows q
  JOIN inventory_adoption_pages h ON h.tenant=q.tenant AND h.page_id=q.page_id AND h.state='prepared'
  JOIN inventory_adoption_guards g ON g.tenant=h.tenant AND g.page_id=h.page_id
  WHERE q.tenant=NEW.tenant AND q.evidence_id=NEW.id AND q.existing_evidence=0 AND h.provider=NEW.provider AND h.book_identity=NEW.book_identity AND h.destination_scope=NEW.destination_scope AND h.key_id=NEW.key_id
  AND q.source_scope=NEW.source_scope AND q.source_identity=NEW.source_identity AND q.record_key=NEW.record_key AND q.claim_hash=NEW.claim_hash AND q.bucket_hash=NEW.bucket_hash AND q.remote_id IS NEW.remote_id AND NEW.created_at=h.prepared_at)
 AND NOT EXISTS(SELECT 1 FROM inventory_lotw_receipt_guards g
  JOIN inventory_lotw_readback_authority a ON (a.tenant,a.batch_id,a.lease_token,a.lease_fence,a.connection_id,a.credential_version,a.connection_config)=
   (g.tenant,g.batch_id,g.lease_token,g.lease_fence,g.connection_id,g.credential_version,g.connection_config)
  JOIN inventory_lotw_batch_members m ON (m.tenant,m.batch_id,m.source_identity,m.record_key,m.identity_hash)=
   (a.tenant,a.batch_id,NEW.source_identity,NEW.record_key,NEW.claim_hash) AND m.cancelled_at IS NULL
  WHERE (a.tenant,a.book_identity,a.destination_scope,a.source_scope,a.key_id)=(NEW.tenant,NEW.book_identity,NEW.destination_scope,NEW.source_scope,NEW.key_id)
   AND NEW.provider='lotw' AND NEW.remote_id IS NULL AND NEW.created_at BETWEEN g.read_started_at AND unixepoch('subsec')*1000
   AND EXISTS(SELECT 1 FROM json_each(g.manifest) j WHERE (json_extract(j.value,'$.attempt'),json_extract(j.value,'$.id'),json_extract(j.value,'$.claim'),json_extract(j.value,'$.bucket'))=(m.attempt_id,NEW.id,NEW.claim_hash,NEW.bucket_hash)))
 THEN RAISE(ABORT,'inventory ownership publication guard missing') END;
END;

CREATE TABLE inventory_lotw_member_receipts (
 tenant TEXT NOT NULL,batch_id TEXT NOT NULL,attempt_id TEXT NOT NULL,evidence_id TEXT NOT NULL,guard_id TEXT NOT NULL,
 connection_id TEXT NOT NULL,credential_version TEXT NOT NULL,
 read_started_at INTEGER NOT NULL,vendor_received_at INTEGER NOT NULL,received_at INTEGER NOT NULL,
 confirmed INTEGER NOT NULL CHECK(confirmed IN(0,1)),
 PRIMARY KEY(tenant,attempt_id),UNIQUE(tenant,evidence_id),
 FOREIGN KEY(tenant,attempt_id) REFERENCES inventory_lotw_batch_members(tenant,attempt_id),
 FOREIGN KEY(tenant,batch_id) REFERENCES inventory_lotw_dispatches(tenant,batch_id),
 FOREIGN KEY(tenant,evidence_id) REFERENCES inventory_ownership_evidence(tenant,id),
 CHECK(read_started_at<=received_at AND vendor_received_at<=received_at AND received_at<read_started_at+60000)
);
CREATE INDEX inventory_lotw_receipt_batch ON inventory_lotw_member_receipts(tenant,batch_id,guard_id);
CREATE TRIGGER inventory_lotw_receipt_insert BEFORE INSERT ON inventory_lotw_member_receipts WHEN NOT EXISTS(
 SELECT 1 FROM inventory_lotw_receipt_guards g JOIN inventory_lotw_readback_authority a ON (a.tenant,a.batch_id,a.lease_token,a.lease_fence,a.connection_id,a.credential_version,a.connection_config)=
 (g.tenant,g.batch_id,g.lease_token,g.lease_fence,g.connection_id,g.credential_version,g.connection_config)
 JOIN inventory_lotw_batch_members m ON (m.tenant,m.batch_id,m.attempt_id)=(NEW.tenant,NEW.batch_id,NEW.attempt_id) AND m.cancelled_at IS NULL
 JOIN inventory_ownership_evidence e ON (e.tenant,e.id,e.provider,e.key_id,e.claim_hash,e.source_scope,e.source_identity,e.record_key,e.destination_scope,e.book_identity)=
   (NEW.tenant,NEW.evidence_id,'lotw',a.key_id,m.identity_hash,a.source_scope,m.source_identity,m.record_key,a.destination_scope,a.book_identity)
 WHERE (g.tenant,g.batch_id,g.guard_id,g.connection_id,g.credential_version,g.read_started_at)=
       (NEW.tenant,NEW.batch_id,NEW.guard_id,NEW.connection_id,NEW.credential_version,NEW.read_started_at)
 AND EXISTS(SELECT 1 FROM json_each(g.manifest) j WHERE (json_extract(j.value,'$.attempt'),json_extract(j.value,'$.id'))=(NEW.attempt_id,NEW.evidence_id))
 AND NEW.vendor_received_at>=a.claimed_at-a.claimed_at%1000 AND NEW.received_at<=unixepoch('subsec')*1000
) BEGIN
 SELECT RAISE(ABORT,'inventory LoTW receipt authority changed');
END;
CREATE TRIGGER inventory_lotw_receipt_guard_complete BEFORE DELETE ON inventory_lotw_receipt_guards WHEN OLD.member_count!=(
 SELECT count(*) FROM inventory_lotw_member_receipts r WHERE (r.tenant,r.batch_id,r.guard_id)=(OLD.tenant,OLD.batch_id,OLD.guard_id)
) BEGIN
 SELECT RAISE(ABORT,'inventory LoTW receipt publication incomplete');
END;
CREATE TRIGGER inventory_lotw_receipt_immutable BEFORE UPDATE ON inventory_lotw_member_receipts BEGIN SELECT RAISE(ABORT,'immutable inventory LoTW receipt'); END;
CREATE TRIGGER inventory_lotw_receipt_retained BEFORE DELETE ON inventory_lotw_member_receipts BEGIN SELECT RAISE(ABORT,'retained inventory LoTW receipt'); END;

CREATE TRIGGER inventory_lotw_dispatch_settled BEFORE UPDATE OF settled_at ON inventory_lotw_dispatches BEGIN
 SELECT CASE WHEN OLD.settled_at IS NOT NULL OR NEW.settled_at IS NULL OR NEW.settled_at>unixepoch('subsec')*1000
 OR NOT EXISTS(SELECT 1 FROM inventory_lotw_batches h WHERE (h.tenant,h.batch_id)=(OLD.tenant,OLD.batch_id)
  AND h.member_count=(SELECT count(*) FROM inventory_lotw_member_receipts r WHERE (r.tenant,r.batch_id)=(OLD.tenant,OLD.batch_id) AND r.received_at<=NEW.settled_at))
 THEN RAISE(ABORT,'inventory LoTW settlement requires every receipt') END;
END;
CREATE TRIGGER inventory_lotw_settle_after_receipts AFTER DELETE ON inventory_lotw_receipt_guards BEGIN
 UPDATE inventory_lotw_dispatches SET settled_at=CAST(unixepoch('subsec')*1000 AS INTEGER)
 WHERE (tenant,batch_id)=(OLD.tenant,OLD.batch_id) AND settled_at IS NULL AND EXISTS(
  SELECT 1 FROM inventory_lotw_batches h WHERE (h.tenant,h.batch_id)=(OLD.tenant,OLD.batch_id)
   AND h.member_count=(SELECT count(*) FROM inventory_lotw_member_receipts r WHERE (r.tenant,r.batch_id)=(OLD.tenant,OLD.batch_id)));
END;

-- The permanent ownership index sees observed receipt records. The receipt
-- link keeps them out of historical adoption, including concurrent workers.
CREATE VIEW inventory_lotw_delivery_owners AS
 SELECT r.tenant,r.evidence_id,m.source_identity,m.record_key FROM inventory_lotw_member_receipts r
 JOIN inventory_lotw_batch_members m USING(tenant,attempt_id) WHERE m.cancelled_at IS NULL;
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
  AND ((o.source_identity,o.record_key)=(s.scope_identity,r.record_key) OR o.remote_id=coalesce(nullif(ltrim(r.remote_key,'0'),''),'0'))))
 AND (t.provider!='lotw' OR NOT EXISTS(SELECT 1 FROM inventory_lotw_delivery_owners o WHERE (o.tenant,o.source_identity,o.record_key)=(r.tenant,s.scope_identity,r.record_key)));
CREATE TRIGGER inventory_lotw_retire_delivered_adoption AFTER INSERT ON inventory_lotw_member_receipts BEGIN
 DELETE FROM inventory_adoption_work WHERE rowid IN(
  SELECT w.rowid FROM inventory_lotw_batch_members m JOIN inventory_lotw_batches h USING(tenant,batch_id)
  CROSS JOIN inventory_scopes d CROSS JOIN inventory_adoption_work w
  WHERE (m.tenant,m.attempt_id)=(NEW.tenant,NEW.attempt_id) AND d.tenant=h.tenant AND d.provider='lotw'
  AND (w.tenant,w.destination,w.source_scope,w.record_key)=(h.tenant,d.scope_id,h.source_scope,m.record_key));
END;
CREATE TRIGGER inventory_lotw_delivered_adoption BEFORE INSERT ON inventory_adoption_guards WHEN EXISTS(
 SELECT 1 FROM inventory_adoption_pages h JOIN inventory_adoption_rows a USING(tenant,page_id)
 WHERE (h.tenant,h.page_id,h.provider)=(NEW.tenant,NEW.page_id,'lotw')
 AND (EXISTS(SELECT 1 FROM inventory_lotw_member_receipts r WHERE (r.tenant,r.evidence_id)=(a.tenant,a.evidence_id))
  OR EXISTS(SELECT 1 FROM inventory_lotw_batch_members m JOIN inventory_lotw_member_receipts r USING(tenant,attempt_id)
    WHERE (m.tenant,m.source_identity,m.record_key)=(a.tenant,a.source_identity,a.record_key) AND m.cancelled_at IS NULL))
) BEGIN
 SELECT RAISE(ABORT,'inventory LoTW delivery already owns the record');
END;

DROP VIEW inventory_lotw_restore_pending;
CREATE VIEW inventory_lotw_restore_pending AS
 SELECT h.tenant,h.batch_id,h.proof_id,h.wire_hash,h.member_count,l.locked_at,
 CASE WHEN d.batch_id IS NULL THEN 'prepared_at_snapshot' ELSE 'possibly_sent' END AS prior_state
 FROM inventory_restore_locks l JOIN inventory_lotw_batches h USING(tenant)
 LEFT JOIN inventory_lotw_dispatches d USING(tenant,batch_id)
 WHERE h.committed_at IS NOT NULL AND h.cancelled_at IS NULL AND d.settled_at IS NULL;
