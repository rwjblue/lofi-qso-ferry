CREATE VIEW inventory_lofi_scheduled_links AS
 SELECT p.tenant,p.scope_id,p.stream_id,k.expires_at,
  EXISTS(SELECT 1 FROM inventory_coverage cov
   WHERE (cov.tenant,cov.scope_id,cov.stream_id)=(p.tenant,p.scope_id,p.stream_id)
    AND cov.facet='source' AND cov.kind='observed_selection' AND cov.state IN('ready','collecting')
    AND cov.published_config_version=p.config_version AND cov.published_run_id IS NOT NULL
  ) AS established
 FROM inventory_scopes s
 JOIN inventory_runtime v ON v.mode='inventory_read_only' AND v.version=s.runtime_version
 JOIN inventory_scheduled_selections p
  ON (p.tenant,p.scope_id,p.config_version,p.runtime_version)=(s.tenant,s.scope_id,s.config_version,s.runtime_version)
 JOIN inventory_stream_jobs j USING(tenant,scope_id,stream_id)
 JOIN accounts a ON a.id=s.tenant AND a.status='active'
 JOIN connections c ON (c.tenant,c.id)=(s.tenant,s.connection_id)
 JOIN private_data k ON (k.tenant,k.connection,k.id,k.kind)=(c.tenant,c.id,c.credential_version,'credential')
 WHERE s.provider='lofi' AND s.state='observing' AND j.state IN('idle','ready')
  AND c.kind='lofi' AND c.status='active' AND c.remote_identity=s.logical_identity
  AND json_extract(c.config,'$.accountId')=s.logical_identity
  AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>unixepoch('subsec')*1000);

-- The existing BEFORE guard validates authority, pacing and combined quota.
-- Protect ordinary capacity before the transport reservation can consume it.
CREATE TRIGGER inventory_bootstrap_reserve_background AFTER INSERT ON inventory_request_guards
 WHEN NEW.priority='bootstrap'
  AND EXISTS(SELECT 1 FROM inventory_vendor_bootstrap b WHERE b.vendor='lofi'
   AND b.window_start=NEW.window_start AND b.requests>=16)
  AND EXISTS(SELECT 1 FROM inventory_lofi_scheduled_links s WHERE s.established=1
   AND (s.expires_at IS NULL OR s.expires_at>NEW.now))
 BEGIN
  SELECT RAISE(ABORT,'inventory bootstrap reserved background');
 END;
