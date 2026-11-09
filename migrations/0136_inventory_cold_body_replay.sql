-- Keep repair cursors independent from the ordinary LoFi stream. A request
-- binds the original body digest and current archive pointer before any read.
CREATE TABLE inventory_body_replay_requests (
 tenant TEXT NOT NULL,scope_id TEXT NOT NULL,payload_id TEXT NOT NULL,record_key TEXT NOT NULL,
 body_hash TEXT NOT NULL,marker TEXT NOT NULL CHECK(json_valid(marker)),requested_at INTEGER NOT NULL,
 cursor_id TEXT,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','restored','unavailable','obsolete')),
 PRIMARY KEY(tenant,scope_id,payload_id),FOREIGN KEY(tenant,scope_id) REFERENCES inventory_scopes(tenant,scope_id)
);
CREATE INDEX inventory_body_replay_request_due ON inventory_body_replay_requests(requested_at,tenant,scope_id,payload_id) WHERE state='pending';
CREATE INDEX inventory_body_replay_request_cursor ON inventory_body_replay_requests(tenant,scope_id,cursor_id,payload_id) WHERE state='pending';
CREATE TABLE inventory_body_replay_cursors (
 tenant TEXT NOT NULL,scope_id TEXT NOT NULL,id TEXT NOT NULL,config_version INTEGER NOT NULL,
 credential_version TEXT NOT NULL,connection_config TEXT NOT NULL,upper_bound INTEGER NOT NULL,
 resume TEXT NOT NULL CHECK(json_valid(resume)),next_due_at INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant,scope_id),FOREIGN KEY(tenant,scope_id) REFERENCES inventory_scopes(tenant,scope_id)
);

CREATE TABLE inventory_body_replay_restores (
 tenant TEXT NOT NULL,scope_id TEXT NOT NULL,payload_id TEXT NOT NULL,cursor_id TEXT NOT NULL,
 cursor_version INTEGER NOT NULL,lease_token TEXT NOT NULL,lease_fence INTEGER NOT NULL,
 PRIMARY KEY(tenant,scope_id,payload_id)
);
CREATE TRIGGER inventory_body_replay_restore_admit BEFORE INSERT ON inventory_body_replay_restores
 WHEN NOT EXISTS(
  SELECT 1 FROM inventory_body_replay_requests q
  JOIN inventory_body_replay_cursors j ON (j.tenant,j.scope_id,j.id)=(q.tenant,q.scope_id,q.cursor_id)
  JOIN inventory_scopes s ON (s.tenant,s.scope_id,s.provider,s.state,s.config_version)=(j.tenant,j.scope_id,'lofi','observing',j.config_version)
  JOIN connections c ON (c.tenant,c.id,c.kind,c.status,c.remote_identity,c.credential_version,c.config)=(s.tenant,s.connection_id,'lofi','active',s.logical_identity,j.credential_version,j.connection_config)
  JOIN accounts a ON a.id=s.tenant AND a.status='active'
  JOIN private_data access ON (access.tenant,access.connection,access.id,access.kind)=(c.tenant,c.id,c.credential_version,'credential')
    AND access.revoked_at IS NULL AND (access.expires_at IS NULL OR access.expires_at>unixepoch('subsec')*1000)
  JOIN inventory_payloads p ON (p.tenant,p.scope_id,p.payload_id,p.connection_id,p.envelope,p.cold)=(q.tenant,q.scope_id,q.payload_id,c.id,q.marker,1)
  JOIN inventory_record_facets f ON (f.tenant,f.scope_id,f.entity_family,f.record_key,f.facet,f.payload_id,f.body_hash)=(q.tenant,q.scope_id,'qso',q.record_key,'source',p.payload_id,q.body_hash)
  JOIN leases l ON (l.tenant,l.scope,l.token,l.fence)=(q.tenant,'inventory:'||q.scope_id,NEW.lease_token,NEW.lease_fence) AND l.expires_at>unixepoch('subsec')*1000
  WHERE (q.tenant,q.scope_id,q.payload_id,q.cursor_id,q.state,j.version)=(NEW.tenant,NEW.scope_id,NEW.payload_id,NEW.cursor_id,'pending',NEW.cursor_version)
  AND NOT EXISTS(SELECT 1 FROM inventory_restore_locks x WHERE x.tenant=q.tenant)
 ) BEGIN
 SELECT RAISE(ABORT,'inventory body replay authority changed');
END;

DROP TRIGGER inventory_payloads_immutable;
CREATE TRIGGER inventory_payloads_immutable BEFORE UPDATE ON inventory_payloads
 WHEN (NEW.tenant,NEW.scope_id,NEW.payload_id,NEW.connection_id,NEW.kind,NEW.created_at) IS NOT (OLD.tenant,OLD.scope_id,OLD.payload_id,OLD.connection_id,OLD.kind,OLD.created_at)
 OR NOT json_valid(NEW.envelope) OR NOT (
  (OLD.cold=0 AND NEW.cold=1 AND json_extract(NEW.envelope,'$.archive.version') IS 1
   AND json_extract(NEW.envelope,'$.archive.bytes') IS length(OLD.envelope)
   AND length(coalesce(json_extract(NEW.envelope,'$.archive.digest'),''))=43
   AND json_extract(NEW.envelope,'$.archive.digest') NOT GLOB '*[^A-Za-z0-9_-]*'
   AND EXISTS(SELECT 1 FROM inventory_coolable_bodies a WHERE (a.tenant,a.scope_id,a.payload_id)=(OLD.tenant,OLD.scope_id,OLD.payload_id)))
  OR (OLD.cold=1 AND NEW.cold=0 AND json_extract(NEW.envelope,'$.v') IS 1 AND json_extract(NEW.envelope,'$.algorithm') IS 'AES-256-GCM'
   AND EXISTS(SELECT 1 FROM inventory_body_replay_restores r WHERE (r.tenant,r.scope_id,r.payload_id)=(OLD.tenant,OLD.scope_id,OLD.payload_id)))
 ) BEGIN
 SELECT RAISE(ABORT,'immutable inventory payload');
END;
