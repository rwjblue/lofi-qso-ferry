-- Filter old scheduled windows at selection, broker recovery, and request
-- admission. A forward destination only uses the per-contact final checks.
CREATE VIEW inventory_scoped_schedule AS
 SELECT p.*,
  coalesce(json_extract(p.plan,'$.between[0]'),json_extract(p.plan,'$.selection.startDate')) AS from_date,
  coalesce(json_extract(p.plan,'$.between[1]'),json_extract(p.plan,'$.selection.endDate')) AS through_date
 FROM inventory_scheduled_selections p
 JOIN inventory_scopes s ON (s.tenant,s.scope_id,s.config_version,s.runtime_version)=(p.tenant,p.scope_id,p.config_version,p.runtime_version)
 LEFT JOIN inventory_sync_scopes policy ON (policy.tenant,policy.destination)=(s.tenant,s.connection_id)
 WHERE s.provider='lofi' OR coalesce(policy.mode,'all')='all'
 OR (policy.mode='since'
   AND coalesce(json_extract(p.plan,'$.between[0]'),json_extract(p.plan,'$.selection.startDate'))>=date(policy.since,'-1 day')
   AND coalesce(json_extract(p.plan,'$.between[1]'),json_extract(p.plan,'$.selection.endDate'))>=date(policy.since,'-1 day'));

CREATE TRIGGER inventory_scoped_read_admit BEFORE INSERT ON ingestion_run_pages
 WHEN NEW.action='admit' AND EXISTS (
  SELECT 1 FROM inventory_runs r JOIN inventory_scopes s ON (s.tenant,s.scope_id)=(r.tenant,r.scope_id)
  JOIN inventory_sync_scopes p ON (p.tenant,p.destination)=(s.tenant,s.connection_id)
  WHERE (r.tenant,r.run_id)=(NEW.tenant,NEW.run_id) AND s.provider IN('qrz','lotw') AND p.mode!='all'
  AND NOT EXISTS(SELECT 1 FROM inventory_scoped_schedule q WHERE (q.tenant,q.scope_id,q.stream_id)=(r.tenant,r.scope_id,r.stream_id))
 ) BEGIN
 SELECT RAISE(ABORT,'inventory read outside sync scope');
END;

CREATE TABLE inventory_forward_registration_progress (
 id INTEGER PRIMARY KEY CHECK(id=1),last_tenant TEXT NOT NULL,last_connection TEXT NOT NULL
);
INSERT INTO inventory_forward_registration_progress VALUES(1,'','');

DROP VIEW inventory_lotw_confirmation_targets;
CREATE VIEW inventory_lotw_confirmation_targets AS
 SELECT p.tenant,p.scope_id,p.stream_id AS receipt_stream_id,p.config_version AS scope_version,
        p.plan,p.created_at,c.credential_version
 FROM inventory_scoped_schedule p
 JOIN inventory_scopes s ON (s.tenant,s.scope_id,s.config_version,s.runtime_version)=(p.tenant,p.scope_id,p.config_version,p.runtime_version)
 JOIN inventory_runtime v ON v.id=1 AND v.mode='inventory_read_only' AND v.version=s.runtime_version
 JOIN connections c ON (c.tenant,c.id,c.remote_identity,c.kind)=(s.tenant,s.connection_id,s.logical_identity,s.provider)
 JOIN accounts a ON a.id=c.tenant AND a.status='active'
 JOIN private_data k ON (k.tenant,k.connection,k.id,k.kind)=(c.tenant,c.id,c.credential_version,'credential')
 LEFT JOIN inventory_stream_jobs j ON (j.tenant,j.scope_id,j.stream_id)=(p.tenant,p.scope_id,p.stream_id)
 WHERE s.provider='lotw' AND s.state='observing' AND c.status='active' AND json_extract(c.config,'$.readAccess')=1
   AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>unixepoch('subsec')*1000)
   AND json_extract(p.plan,'$.provider')='lotw'
   AND json_type(p.plan,'$.selection.startDate')='text' AND json_type(p.plan,'$.selection.endDate')='text'
   AND j.reason IS NOT 'overflow_split'
   AND NOT EXISTS(SELECT 1 FROM inventory_lotw_confirmation_schedule q
     WHERE (q.tenant,q.scope_id,q.scope_version,q.rejected_credential_version)=(s.tenant,s.scope_id,s.config_version,c.credential_version));
