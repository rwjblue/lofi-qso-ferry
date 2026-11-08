-- LoFi inventory bootstrap shares the existing global total. Ordinary background
-- keeps its existing four-request cap inside a combined nonforeground cap of 20.
CREATE TABLE inventory_vendor_bootstrap (
 vendor TEXT PRIMARY KEY CHECK(vendor='lofi'), window_start INTEGER NOT NULL,
 requests INTEGER NOT NULL CHECK(requests BETWEEN 0 AND 20)
);
CREATE TRIGGER inventory_bootstrap_monotonic BEFORE UPDATE ON inventory_vendor_bootstrap
 WHEN NEW.window_start<OLD.window_start OR (NEW.window_start=OLD.window_start AND NEW.requests<OLD.requests)
 BEGIN SELECT RAISE(ABORT,'inventory bootstrap window regressed'); END;

-- Legacy background reservations must also respect bootstrap's consumption.
-- IGNORE returns no reservation row, preserving vendorFetch's typed deferral.
CREATE TRIGGER inventory_background_insert BEFORE INSERT ON vendor_requests
 WHEN NEW.vendor='lofi' AND NEW.background_requests>0 AND NEW.background_requests+coalesce((SELECT requests FROM inventory_vendor_bootstrap WHERE vendor='lofi' AND window_start=NEW.window_start),0)>20
 BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER inventory_background_update BEFORE UPDATE ON vendor_requests
 WHEN NEW.vendor='lofi' AND NEW.background_requests>0
 AND (NEW.window_start>OLD.window_start OR NEW.background_requests>OLD.background_requests)
 AND NEW.background_requests+coalesce((SELECT requests FROM inventory_vendor_bootstrap WHERE vendor='lofi' AND window_start=NEW.window_start),0)>20
 BEGIN SELECT RAISE(IGNORE); END;

-- Empty tenant/source denotes the provider-wide inventory pacer. Nonempty keys
-- identify the source connection, so all streams share that source's pacing.
CREATE TABLE inventory_read_pacing (
 vendor TEXT NOT NULL CHECK(vendor='lofi'), tenant TEXT NOT NULL, source TEXT NOT NULL,
 last_requested_at INTEGER NOT NULL CHECK(last_requested_at>=0),
 next_allowed_at INTEGER NOT NULL CHECK(next_allowed_at>=last_requested_at),
 loop_delay_ms INTEGER CHECK(loop_delay_ms IS NULL OR (typeof(loop_delay_ms)='integer' AND loop_delay_ms>=0)),
 check_period_ms INTEGER CHECK(check_period_ms IS NULL OR (typeof(check_period_ms)='integer' AND check_period_ms>0)),
 hints_observed_at INTEGER CHECK(hints_observed_at IS NULL OR (typeof(hints_observed_at)='integer' AND hints_observed_at>=0)),
 policy_version INTEGER NOT NULL DEFAULT 1 CHECK(policy_version>0),
 PRIMARY KEY(vendor,tenant,source),
 CHECK((tenant='' AND source='') OR (tenant!='' AND source!='')),
 CHECK(tenant!='' OR (loop_delay_ms IS NULL AND check_period_ms IS NULL AND hints_observed_at IS NULL))
);
CREATE TRIGGER inventory_pacing_monotonic BEFORE UPDATE ON inventory_read_pacing
 WHEN NEW.last_requested_at<OLD.last_requested_at OR NEW.next_allowed_at<OLD.next_allowed_at OR NEW.policy_version<OLD.policy_version
 OR (OLD.hints_observed_at IS NOT NULL AND (NEW.hints_observed_at IS NULL OR NEW.hints_observed_at<OLD.hints_observed_at))
 BEGIN SELECT RAISE(ABORT,'inventory pacing regressed'); END;

-- Scratch guards are inserted and removed in one native reservation transaction.
CREATE TABLE inventory_request_guards (
 id TEXT PRIMARY KEY, tenant TEXT NOT NULL, scope_id TEXT NOT NULL,
 connection_id TEXT NOT NULL, stream_id TEXT NOT NULL,
 logical_identity TEXT NOT NULL, adapter_binding TEXT NOT NULL, ordering TEXT NOT NULL,
 query_binding TEXT NOT NULL, config_version INTEGER NOT NULL,
 expected_sequence INTEGER NOT NULL, expected_stream_version INTEGER NOT NULL,
 credential_version TEXT NOT NULL, connection_config TEXT NOT NULL, remote_identity TEXT NOT NULL,
 lease_scope TEXT NOT NULL, lease_token TEXT NOT NULL, lease_fence INTEGER NOT NULL,
 priority TEXT NOT NULL CHECK(priority IN('bootstrap','background','live')),
 now INTEGER NOT NULL, window_start INTEGER NOT NULL,
 global_delay INTEGER NOT NULL CHECK(global_delay>=5000),
 source_delay INTEGER NOT NULL CHECK(source_delay>=5000),
 expected_requests INTEGER NOT NULL, expected_background INTEGER NOT NULL,
 phase TEXT NOT NULL DEFAULT 'checking' CHECK(phase IN('checking','reserved'))
);
CREATE TRIGGER inventory_request_authority BEFORE INSERT ON inventory_request_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM inventory_scopes s
  JOIN inventory_streams t ON t.tenant=s.tenant AND t.scope_id=s.scope_id
  JOIN connections c ON c.tenant=s.tenant AND c.id=s.connection_id
  JOIN accounts a ON a.id=c.tenant
  JOIN private_data d ON d.tenant=c.tenant AND d.connection=c.id AND d.id=c.credential_version AND d.kind='credential'
  JOIN leases l ON l.tenant=s.tenant AND l.scope=NEW.lease_scope AND l.token=NEW.lease_token AND l.fence=NEW.lease_fence
  WHERE s.tenant=NEW.tenant AND s.scope_id=NEW.scope_id AND s.connection_id=NEW.connection_id
   AND s.provider='lofi' AND s.state='observing' AND a.status='active' AND c.status='active' AND c.kind='lofi'
   AND s.logical_identity=NEW.logical_identity AND s.adapter_binding=NEW.adapter_binding AND s.ordering=NEW.ordering
   AND s.config_version=NEW.config_version AND s.accepted_sequence=NEW.expected_sequence
   AND t.stream_id=NEW.stream_id AND t.query_binding=NEW.query_binding AND t.checkpoint_version=NEW.expected_stream_version
   AND c.credential_version=NEW.credential_version AND c.config=NEW.connection_config AND c.remote_identity=NEW.remote_identity
   AND d.revoked_at IS NULL AND (d.expires_at IS NULL OR d.expires_at>max(NEW.now,unixepoch('subsec')*1000))
   AND NEW.lease_scope='inventory:'||NEW.scope_id AND l.expires_at>max(NEW.now,unixepoch('subsec')*1000)
 ) THEN RAISE(ABORT,'inventory request authority changed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_read_pacing WHERE vendor='lofi' AND ((tenant='' AND source='') OR (tenant=NEW.tenant AND source=NEW.connection_id)) AND next_allowed_at>NEW.now)
  OR EXISTS(SELECT 1 FROM vendor_requests WHERE vendor='lofi' AND window_start>NEW.window_start)
  OR EXISTS(SELECT 1 FROM inventory_vendor_bootstrap WHERE vendor='lofi' AND window_start>NEW.window_start)
  OR (NEW.priority!='live' AND coalesce((SELECT background_requests FROM vendor_requests WHERE vendor='lofi' AND window_start=NEW.window_start),0)+coalesce((SELECT requests FROM inventory_vendor_bootstrap WHERE vendor='lofi' AND window_start=NEW.window_start),0)>=20)
 THEN RAISE(ABORT,'inventory request deferred') END;
END;
CREATE TRIGGER inventory_request_reserved BEFORE UPDATE OF phase ON inventory_request_guards WHEN NEW.phase='reserved' BEGIN
 SELECT CASE WHEN OLD.phase!='checking' OR NOT EXISTS(
  SELECT 1 FROM vendor_requests WHERE vendor='lofi' AND window_start=OLD.window_start
   AND requests=OLD.expected_requests AND background_requests=OLD.expected_background AND cooldown_until<=OLD.now
 ) THEN RAISE(ABORT,'inventory request deferred') END;
END;
