-- One immutable claim covers the whole signed artifact. A file response is
-- independent from per-contact acceptance and never releases the claim.
CREATE TABLE inventory_lotw_observations (
 tenant TEXT NOT NULL,observation_id TEXT NOT NULL,batch_id TEXT NOT NULL,
 wire_hash TEXT NOT NULL,manifest_hash TEXT NOT NULL,members TEXT NOT NULL CHECK(json_valid(members) AND json_type(members)='array'),
 report_count INTEGER NOT NULL CHECK(report_count BETWEEN 1 AND 3),
 lease_token TEXT NOT NULL,lease_fence INTEGER NOT NULL,started_at INTEGER NOT NULL,completed_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 PRIMARY KEY(tenant,observation_id),FOREIGN KEY(tenant,batch_id) REFERENCES inventory_lotw_batches(tenant,batch_id),
 CHECK(started_at<=completed_at AND completed_at<expires_at)
);
CREATE INDEX inventory_lotw_observation_latest ON inventory_lotw_observations(tenant,batch_id,lease_fence,started_at);
CREATE TABLE inventory_lotw_dispatches (
 tenant TEXT NOT NULL,batch_id TEXT NOT NULL,claim_id TEXT NOT NULL,observation_id TEXT NOT NULL,wire_hash TEXT NOT NULL,
 lease_token TEXT NOT NULL,lease_fence INTEGER NOT NULL,claimed_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 PRIMARY KEY(tenant,batch_id),UNIQUE(tenant,claim_id),
 FOREIGN KEY(tenant,batch_id) REFERENCES inventory_lotw_batches(tenant,batch_id),
 FOREIGN KEY(tenant,observation_id) REFERENCES inventory_lotw_observations(tenant,observation_id),
 CHECK(claimed_at<expires_at)
);
CREATE TABLE inventory_lotw_upload_receipts (
 tenant TEXT NOT NULL,batch_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('submitted','rejected')),
 received_at INTEGER NOT NULL,PRIMARY KEY(tenant,batch_id),
 FOREIGN KEY(tenant,batch_id) REFERENCES inventory_lotw_dispatches(tenant,batch_id)
);
CREATE VIEW inventory_lotw_dispatch_pending AS SELECT * FROM inventory_lotw_dispatches;

DROP VIEW inventory_prior_delivery_evidence;
CREATE VIEW inventory_prior_delivery_evidence AS
 SELECT a.tenant,d.kind AS provider FROM attempts a JOIN connections d ON d.tenant=a.tenant AND d.id=a.destination
 UNION ALL SELECT l.tenant,d.kind FROM ledger l JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination WHERE l.remote_id IS NOT NULL OR l.sent_hash IS NOT NULL OR l.remote_hash IS NOT NULL OR l.provenance!='unknown' OR l.confirmed!=0
 UNION ALL SELECT tenant,'qrz' FROM inventory_qrz_dispatch_pending
 UNION ALL SELECT tenant,'lotw' FROM inventory_lotw_dispatch_pending;

DROP VIEW inventory_lotw_batch_current;
CREATE VIEW inventory_lotw_batch_current AS
 SELECT h.tenant,h.batch_id FROM inventory_lotw_batches h JOIN inventory_lotw_batch_inputs_current p USING(tenant,batch_id)
 WHERE h.committed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inventory_lotw_dispatches d WHERE (d.tenant,d.batch_id)=(h.tenant,h.batch_id));

CREATE VIEW inventory_lotw_send_authority AS
 SELECT h.tenant,h.batch_id,h.destination_connection,h.credential_version,h.wire_hash,h.manifest_hash,h.member_count,h.committed_at,
        p.expires_at AS proof_expires_at,l.token AS lease_token,l.fence AS lease_fence,l.expires_at AS lease_expires_at
 FROM inventory_lotw_batch_current c JOIN inventory_lotw_batches h USING(tenant,batch_id)
 JOIN inventory_source_proofs p ON (p.tenant,p.proof_id)=(h.tenant,h.proof_id)
 JOIN leases l ON l.tenant=h.tenant AND l.scope='inventory:lotw-delivery'
 WHERE l.expires_at>unixepoch('subsec')*1000 AND NOT EXISTS(SELECT 1 FROM inventory_fresh_start_lock WHERE id=1);

CREATE TABLE inventory_lotw_read_guards (
 id TEXT PRIMARY KEY,tenant TEXT NOT NULL,batch_id TEXT NOT NULL,lease_token TEXT NOT NULL,lease_fence INTEGER NOT NULL
);
CREATE TRIGGER inventory_lotw_read_guard BEFORE INSERT ON inventory_lotw_read_guards WHEN NOT EXISTS(
 SELECT 1 FROM inventory_lotw_send_authority c WHERE (c.tenant,c.batch_id,c.lease_token,c.lease_fence)=(NEW.tenant,NEW.batch_id,NEW.lease_token,NEW.lease_fence)
) BEGIN
 SELECT RAISE(ABORT,'inventory LoTW send authority changed');
END;

CREATE TRIGGER inventory_lotw_observation_insert BEFORE INSERT ON inventory_lotw_observations BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_lotw_send_authority c
  WHERE (c.tenant,c.batch_id,c.lease_token,c.lease_fence,c.wire_hash,c.manifest_hash)=(NEW.tenant,NEW.batch_id,NEW.lease_token,NEW.lease_fence,NEW.wire_hash,NEW.manifest_hash)
  AND json_array_length(NEW.members)=c.member_count AND c.committed_at<=NEW.started_at AND NEW.completed_at<=unixepoch('subsec')*1000
  AND NEW.expires_at=min(c.proof_expires_at,c.lease_expires_at,NEW.started_at+60000) AND NEW.expires_at>unixepoch('subsec')*1000)
 OR EXISTS(SELECT 1 FROM inventory_lotw_batch_members m WHERE (m.tenant,m.batch_id)=(NEW.tenant,NEW.batch_id)
  AND NOT EXISTS(SELECT 1 FROM json_each(NEW.members) j WHERE j.value=m.attempt_id))
 THEN RAISE(ABORT,'inventory LoTW send authority changed') END;
END;
CREATE TRIGGER inventory_lotw_observation_immutable BEFORE UPDATE ON inventory_lotw_observations BEGIN SELECT RAISE(ABORT,'immutable inventory LoTW observation'); END;
CREATE VIEW inventory_lotw_observation_current AS
 SELECT o.* FROM inventory_lotw_observations o JOIN inventory_lotw_send_authority c
 ON (c.tenant,c.batch_id,c.lease_token,c.lease_fence,c.wire_hash,c.manifest_hash)=(o.tenant,o.batch_id,o.lease_token,o.lease_fence,o.wire_hash,o.manifest_hash)
 WHERE o.expires_at>unixepoch('subsec')*1000 AND o.rowid=(SELECT n.rowid FROM inventory_lotw_observations n
  WHERE (n.tenant,n.batch_id,n.lease_fence)=(o.tenant,o.batch_id,o.lease_fence) ORDER BY n.started_at DESC,n.rowid DESC LIMIT 1);

CREATE TABLE inventory_lotw_dispatch_guards (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),tenant TEXT NOT NULL,batch_id TEXT NOT NULL,
 claim_id TEXT NOT NULL,observation_id TEXT NOT NULL,wire_hash TEXT NOT NULL,
 lease_token TEXT NOT NULL,lease_fence INTEGER NOT NULL,expires_at INTEGER NOT NULL
);
CREATE TRIGGER inventory_lotw_dispatch_guard BEFORE INSERT ON inventory_lotw_dispatch_guards WHEN NOT EXISTS(
 SELECT 1 FROM inventory_lotw_observation_current o
 WHERE (o.tenant,o.batch_id,o.observation_id,o.wire_hash,o.lease_token,o.lease_fence,o.expires_at)=
       (NEW.tenant,NEW.batch_id,NEW.observation_id,NEW.wire_hash,NEW.lease_token,NEW.lease_fence,NEW.expires_at)
) BEGIN
 SELECT RAISE(ABORT,'inventory LoTW send authority changed');
END;
CREATE VIEW inventory_lotw_reserved_dispatch AS
 SELECT tenant,batch_id,claim_id,observation_id,wire_hash,lease_token,lease_fence,CAST(unixepoch('subsec')*1000 AS INTEGER) AS claimed_at,expires_at
 FROM inventory_lotw_dispatch_guards;
CREATE TRIGGER inventory_lotw_dispatch_first_slot AFTER INSERT ON vendor_requests WHEN NEW.vendor='lotw' AND NEW.requests=1 BEGIN
 INSERT INTO inventory_lotw_dispatches SELECT * FROM inventory_lotw_reserved_dispatch;
END;
CREATE TRIGGER inventory_lotw_dispatch_reserved_slot AFTER UPDATE OF requests ON vendor_requests
 WHEN NEW.vendor='lotw' AND (NEW.window_start>OLD.window_start AND NEW.requests=1 OR NEW.window_start=OLD.window_start AND NEW.requests=OLD.requests+1)
BEGIN
 INSERT INTO inventory_lotw_dispatches SELECT * FROM inventory_lotw_reserved_dispatch;
END;
CREATE TRIGGER inventory_lotw_dispatch_insert BEFORE INSERT ON inventory_lotw_dispatches WHEN NOT EXISTS(
 SELECT 1 FROM inventory_lotw_reserved_dispatch g JOIN inventory_lotw_observation_current o
 ON (o.tenant,o.observation_id)=(g.tenant,g.observation_id) WHERE
 (g.tenant,g.batch_id,g.claim_id,g.observation_id,g.wire_hash,g.lease_token,g.lease_fence,g.claimed_at,g.expires_at)=
 (NEW.tenant,NEW.batch_id,NEW.claim_id,NEW.observation_id,NEW.wire_hash,NEW.lease_token,NEW.lease_fence,NEW.claimed_at,NEW.expires_at)
) BEGIN
 SELECT RAISE(ABORT,'inventory LoTW dispatch requires admission');
END;
CREATE TRIGGER inventory_lotw_dispatch_immutable BEFORE UPDATE ON inventory_lotw_dispatches BEGIN SELECT RAISE(ABORT,'immutable inventory LoTW dispatch'); END;
CREATE TRIGGER inventory_lotw_dispatch_retained BEFORE DELETE ON inventory_lotw_dispatches BEGIN SELECT RAISE(ABORT,'retained inventory LoTW dispatch'); END;
CREATE TRIGGER inventory_lotw_no_cancel_after_claim BEFORE UPDATE OF cancelled_at ON inventory_lotw_batches WHEN EXISTS(
 SELECT 1 FROM inventory_lotw_dispatches d WHERE (d.tenant,d.batch_id)=(OLD.tenant,OLD.batch_id)
) BEGIN
 SELECT RAISE(ABORT,'inventory LoTW dispatch cannot be cancelled');
END;

CREATE TRIGGER inventory_lotw_upload_receipt_insert BEFORE INSERT ON inventory_lotw_upload_receipts WHEN NOT EXISTS(
 SELECT 1 FROM inventory_lotw_dispatches d JOIN leases l ON l.tenant=d.tenant AND l.scope='inventory:lotw-delivery' AND l.token=d.lease_token AND l.fence=d.lease_fence
 WHERE (d.tenant,d.batch_id)=(NEW.tenant,NEW.batch_id) AND d.claimed_at<=NEW.received_at
 AND NEW.received_at<=unixepoch('subsec')*1000 AND l.expires_at>unixepoch('subsec')*1000
) BEGIN
 SELECT RAISE(ABORT,'inventory LoTW upload receipt authority changed');
END;
CREATE TRIGGER inventory_lotw_upload_receipt_immutable BEFORE UPDATE ON inventory_lotw_upload_receipts BEGIN SELECT RAISE(ABORT,'immutable inventory LoTW upload receipt'); END;
CREATE TRIGGER inventory_lotw_upload_receipt_retained BEFORE DELETE ON inventory_lotw_upload_receipts BEGIN SELECT RAISE(ABORT,'retained inventory LoTW upload receipt'); END;

CREATE VIEW inventory_lotw_restore_pending AS
 SELECT h.tenant,h.batch_id,h.proof_id,h.wire_hash,h.member_count,l.locked_at,
 CASE WHEN d.batch_id IS NULL THEN 'prepared_at_snapshot' ELSE 'possibly_sent' END AS prior_state
 FROM inventory_restore_locks l JOIN inventory_lotw_batches h USING(tenant)
 LEFT JOIN inventory_lotw_dispatch_pending d USING(tenant,batch_id)
 WHERE h.committed_at IS NOT NULL AND h.cancelled_at IS NULL;
