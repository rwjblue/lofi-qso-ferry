-- Raw payload identity stays pinned by the current facet. Only its encrypted
-- representation moves, and only after durable ownership covers the live routes.
ALTER TABLE inventory_payloads ADD COLUMN cold INTEGER NOT NULL DEFAULT 0 CHECK(cold IN(0,1));
CREATE INDEX inventory_cold_body_age ON inventory_payloads(created_at,tenant,scope_id,payload_id)
 WHERE kind='inventory_source' AND cold=0;
CREATE INDEX inventory_cold_qrz_source ON inventory_qrz_attempts(tenant,source_identity,record_key)
 WHERE cancelled_at IS NULL;

CREATE VIEW inventory_coolable_bodies AS
 SELECT p.tenant,p.scope_id,p.payload_id
 FROM inventory_payloads p
 JOIN inventory_record_facets f ON (f.tenant,f.scope_id,f.payload_id)=(p.tenant,p.scope_id,p.payload_id) AND f.facet='source' AND f.entity_family='qso'
 JOIN inventory_records e ON (e.tenant,e.scope_id,e.entity_family,e.record_key)=(f.tenant,f.scope_id,f.entity_family,f.record_key) AND e.subtype='qso' AND e.status='active'
 JOIN inventory_scopes s ON (s.tenant,s.scope_id,s.provider,s.state)=(f.tenant,f.scope_id,'lofi','observing')
 JOIN accounts a ON a.id=s.tenant AND a.status='active'
 JOIN comparison_domains d ON d.tenant=s.tenant
 JOIN comparison_projections c ON (c.tenant,c.generation_id,c.scope_id,c.record_key,c.facet)=(d.tenant,d.active_generation,s.scope_id,f.record_key,'source')
 LEFT JOIN projection_domains v ON (v.tenant,v.scope_id,v.operation_key)=(e.tenant,e.scope_id,e.parent_key)
 CROSS JOIN inventory_retention_policy policy
 WHERE p.kind='inventory_source' AND p.cold=0 AND length(p.envelope) BETWEEN 1 AND 524288
 AND (c.semantic_version,c.config_version,c.topology_version,c.state)=(f.semantic_version,s.config_version,coalesce(v.topology_version,0),'ready')
 AND c.parent_key IS e.parent_key
 AND max(c.derived_at,p.created_at)<=unixepoch('subsec')*1000-policy.settled_retention_days*86400000
 AND NOT EXISTS(SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=s.tenant)
 AND NOT EXISTS(SELECT 1 FROM inventory_qrz_attempts q WHERE (q.tenant,q.source_identity,q.record_key)=(s.tenant,s.logical_identity,f.record_key) AND q.cancelled_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM inventory_qrz_dispatches b WHERE (b.tenant,b.attempt_id)=(q.tenant,q.attempt_id) AND b.settled_at IS NOT NULL))
 AND NOT EXISTS(SELECT 1 FROM inventory_lotw_batch_members m WHERE (m.tenant,m.source_identity,m.record_key)=(s.tenant,s.logical_identity,f.record_key) AND m.cancelled_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM inventory_lotw_dispatches b WHERE (b.tenant,b.batch_id)=(m.tenant,m.batch_id) AND b.settled_at IS NOT NULL))
 AND EXISTS(SELECT 1 FROM connections t WHERE t.tenant=s.tenant AND t.kind IN('qrz','lotw') AND t.status='active')
 AND NOT EXISTS(SELECT 1 FROM connections t WHERE t.tenant=s.tenant AND t.kind IN('qrz','lotw') AND t.status='active'
  AND NOT EXISTS(SELECT 1 FROM inventory_historical_associations h
   WHERE (h.tenant,h.provider,h.book_identity,h.source_identity,h.record_key)=(t.tenant,t.kind,t.remote_identity,s.logical_identity,f.record_key)
   AND h.created_at<=unixepoch('subsec')*1000-policy.settled_retention_days*86400000)
  AND (t.kind!='qrz' OR NOT EXISTS(SELECT 1 FROM inventory_qrz_attempts q
   JOIN inventory_qrz_dispatch_receipts receipt ON (receipt.tenant,receipt.attempt_id)=(q.tenant,q.attempt_id)
   JOIN inventory_qrz_dispatches b ON (b.tenant,b.attempt_id)=(q.tenant,q.attempt_id) AND b.settled_at IS NOT NULL
   WHERE (q.tenant,q.book_identity,q.source_identity,q.record_key)=(t.tenant,t.remote_identity,s.logical_identity,f.record_key) AND q.cancelled_at IS NULL
   AND max(receipt.received_at,b.settled_at)<=unixepoch('subsec')*1000-policy.settled_retention_days*86400000))
  AND (t.kind!='lotw' OR NOT EXISTS(SELECT 1 FROM inventory_lotw_batch_members m
   JOIN inventory_lotw_batches batch ON (batch.tenant,batch.batch_id,batch.book_identity)=(m.tenant,m.batch_id,t.remote_identity)
   JOIN inventory_lotw_member_receipts receipt ON (receipt.tenant,receipt.attempt_id)=(m.tenant,m.attempt_id)
   JOIN inventory_lotw_dispatches b ON (b.tenant,b.batch_id)=(m.tenant,m.batch_id) AND b.settled_at IS NOT NULL
   WHERE (m.tenant,m.source_identity,m.record_key)=(t.tenant,s.logical_identity,f.record_key) AND m.cancelled_at IS NULL
   AND max(receipt.received_at,b.settled_at)<=unixepoch('subsec')*1000-policy.settled_retention_days*86400000))
 );

DROP TRIGGER inventory_payloads_immutable;
CREATE TRIGGER inventory_payloads_immutable BEFORE UPDATE ON inventory_payloads
 WHEN (NEW.tenant,NEW.scope_id,NEW.payload_id,NEW.connection_id,NEW.kind,NEW.created_at) IS NOT (OLD.tenant,OLD.scope_id,OLD.payload_id,OLD.connection_id,OLD.kind,OLD.created_at)
 OR OLD.cold!=0 OR NEW.cold!=1
 OR NOT json_valid(NEW.envelope) OR json_extract(NEW.envelope,'$.archive.version') IS NOT 1
 OR json_extract(NEW.envelope,'$.archive.bytes') IS NOT length(OLD.envelope)
 OR length(coalesce(json_extract(NEW.envelope,'$.archive.digest'),''))!=43
 OR json_extract(NEW.envelope,'$.archive.digest') GLOB '*[^A-Za-z0-9_-]*'
 OR NOT EXISTS(SELECT 1 FROM inventory_coolable_bodies a WHERE (a.tenant,a.scope_id,a.payload_id)=(OLD.tenant,OLD.scope_id,OLD.payload_id)) BEGIN
 SELECT RAISE(ABORT,'immutable inventory payload');
END;

CREATE TABLE inventory_cold_body_census (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL DEFAULT 0,tenant TEXT NOT NULL DEFAULT '',scope_id TEXT NOT NULL DEFAULT '',payload_id TEXT NOT NULL DEFAULT '',restart_at INTEGER
);
INSERT INTO inventory_cold_body_census(singleton) VALUES(1);
CREATE TRIGGER inventory_cold_body_policy_restart AFTER UPDATE OF settled_retention_days ON inventory_retention_policy
 WHEN NEW.settled_retention_days!=OLD.settled_retention_days BEGIN
 UPDATE inventory_cold_body_census SET version=version+1,restart_at=0 WHERE singleton=1;
END;
