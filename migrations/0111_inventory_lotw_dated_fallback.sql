-- Only a recent completed account read can take over receipt polling.
CREATE VIEW inventory_lotw_account_feed_status AS
 SELECT p.tenant,p.scope_id,p.config_version,p.runtime_version,
  unixepoch(json_extract(p.plan,'$.selection.initialReceivedSince'))*1000 AS initial_received_at,
  CASE WHEN j.state IN('idle','ready') THEN r.completed_at+2*p.poll_period_ms END AS healthy_until
 FROM inventory_scheduled_selections p
 JOIN inventory_scopes s ON (s.tenant,s.scope_id,s.config_version,s.runtime_version)=(p.tenant,p.scope_id,p.config_version,p.runtime_version)
 JOIN inventory_runtime v ON v.mode='inventory_read_only' AND v.version=s.runtime_version
 JOIN accounts a ON a.id=s.tenant AND a.status='active'
 JOIN connections l ON (l.tenant,l.id)=(s.tenant,s.connection_id) AND l.kind='lotw' AND l.status='active' AND l.remote_identity=s.logical_identity
 JOIN private_data k ON (k.tenant,k.connection,k.id,k.kind)=(l.tenant,l.id,l.credential_version,'credential')
 LEFT JOIN inventory_stream_jobs j ON (j.tenant,j.scope_id,j.stream_id)=(p.tenant,p.scope_id,p.stream_id)
 LEFT JOIN inventory_coverage c ON (c.tenant,c.scope_id,c.stream_id)=(p.tenant,p.scope_id,p.stream_id) AND c.facet='receipt'
  AND c.kind='positive_only' AND c.state IN('partial','collecting') AND c.published_run_id IS NULL
 LEFT JOIN inventory_runs r ON (r.tenant,r.scope_id,r.stream_id,r.run_id,r.config_version)=(p.tenant,p.scope_id,p.stream_id,c.delta_run_id,p.config_version)
  AND r.mode='delta' AND r.phase='complete' AND json_extract(r.fixed_query,'$.query.kind')='account_received'
 WHERE s.provider='lotw' AND s.state='observing' AND json_extract(l.config,'$.readAccess')=1
 AND json_extract(p.plan,'$.provider')='lotw' AND json_extract(p.plan,'$.selection.kind')='account_received'
 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>unixepoch('subsec')*1000);

-- Only shorten idle polls that were spaced beyond their ordinary cadence.
CREATE VIEW inventory_lotw_dated_fallback_due AS
 SELECT j.tenant,j.scope_id,j.stream_id,w.run_id,j.work_version,
  r.completed_at+p.poll_period_ms AS due_at
 FROM inventory_lotw_account_feed_status a
 JOIN inventory_scheduled_selections p ON (p.tenant,p.scope_id,p.config_version,p.runtime_version)=(a.tenant,a.scope_id,a.config_version,a.runtime_version)
 JOIN inventory_stream_jobs j ON (j.tenant,j.scope_id,j.stream_id)=(p.tenant,p.scope_id,p.stream_id) AND j.state='idle' AND j.active_run_id IS NULL
 JOIN inventory_wakeups w ON (w.tenant,w.scope_id,w.stream_id,w.work_version,w.not_before)=(j.tenant,j.scope_id,j.stream_id,j.work_version,j.next_due_at)
 JOIN inventory_runs r ON (r.tenant,r.scope_id,r.stream_id,r.run_id,r.config_version)=(p.tenant,p.scope_id,p.stream_id,w.run_id,p.config_version) AND r.phase='complete'
 WHERE json_extract(p.plan,'$.provider')='lotw' AND json_type(p.plan,'$.selection.startDate')='text'
 AND coalesce(a.healthy_until,0)<=unixepoch('subsec')*1000
 AND j.next_due_at>r.completed_at+p.poll_period_ms;

-- The new outbox row and its job fence become visible together.
CREATE TRIGGER inventory_lotw_dated_fallback AFTER INSERT ON inventory_wakeups
 WHEN NEW.wakeup_id='lotw-dated-fallback:'||NEW.run_id||':'||NEW.work_version BEGIN
 UPDATE inventory_stream_jobs SET work_version=NEW.work_version,next_due_at=NEW.not_before
 WHERE (tenant,scope_id,stream_id,work_version)=(NEW.tenant,NEW.scope_id,NEW.stream_id,NEW.work_version-1)
 AND EXISTS(SELECT 1 FROM inventory_lotw_dated_fallback_due d
  WHERE (d.tenant,d.scope_id,d.stream_id,d.run_id,d.work_version,d.due_at)=(NEW.tenant,NEW.scope_id,NEW.stream_id,NEW.run_id,NEW.work_version-1,NEW.not_before));
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'LoTW dated poll fallback changed') END;
END;
