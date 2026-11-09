-- Allow one explicitly requested, larger read for an overflowed account run.
CREATE TABLE inventory_lotw_account_rearms (
 tenant TEXT NOT NULL, run_id TEXT NOT NULL, run_version INTEGER NOT NULL,
 job_version INTEGER NOT NULL, lease_token TEXT NOT NULL, lease_fence INTEGER NOT NULL,
 requested_at INTEGER NOT NULL CHECK(requested_at>0),
 PRIMARY KEY(tenant,run_id), FOREIGN KEY(tenant,run_id) REFERENCES inventory_runs(tenant,run_id)
);
CREATE TRIGGER inventory_lotw_account_rearm_guard BEFORE INSERT ON inventory_lotw_account_rearms BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_fresh_start_lock WHERE id=1)
  OR NEW.requested_at>unixepoch('subsec')*1000 THEN RAISE(ABORT,'LoTW account rearm requires a write-locked rehearsal') END;
 SELECT CASE WHEN NOT EXISTS(
   SELECT 1 FROM inventory_runs r
   JOIN inventory_stream_jobs j ON (j.tenant,j.scope_id,j.stream_id)=(r.tenant,r.scope_id,r.stream_id) AND j.active_run_id=r.run_id
   JOIN inventory_streams t ON (t.tenant,t.scope_id,t.stream_id)=(r.tenant,r.scope_id,r.stream_id)
   JOIN inventory_coverage c ON (c.tenant,c.scope_id,c.stream_id,c.facet,c.partition_id)=(r.tenant,r.scope_id,r.stream_id,r.facet,r.partition_id)
   JOIN inventory_scopes s ON (s.tenant,s.scope_id)=(r.tenant,r.scope_id)
   JOIN inventory_runtime runtime ON runtime.id=1 AND runtime.mode='inventory_read_only' AND runtime.version=s.runtime_version
   JOIN inventory_scheduled_selections p ON (p.tenant,p.scope_id,p.stream_id,p.runtime_version,p.config_version)=(r.tenant,r.scope_id,r.stream_id,s.runtime_version,r.config_version)
   WHERE (r.tenant,r.run_id,r.version,j.work_version)=(NEW.tenant,NEW.run_id,NEW.run_version,NEW.job_version)
    AND r.mode='delta' AND r.facet='receipt' AND r.phase='held' AND j.state='held'
    AND r.reason='overflow' AND j.reason=r.reason AND r.proposed_checkpoint IS NULL AND NEW.requested_at>=r.position_started_at
    AND c.state='held' AND c.building_run_id=r.run_id AND c.version=r.coverage_version AND c.partition_binding=r.partition_binding
    AND c.kind='positive_only' AND c.epoch=0 AND c.published_run_id IS NULL AND c.published_config_version IS NULL
    AND s.state='observing' AND s.provider='lotw' AND s.config_version=r.config_version AND s.adapter_binding=r.adapter_binding
    AND t.query_binding=r.query_binding AND t.checkpoint_version=r.expected_stream_version AND t.resume_state='{}'
    AND json_extract(r.fixed_query,'$.provider')='lotw' AND json_extract(r.fixed_query,'$.query.kind')='account_received'
    AND json_extract(p.plan,'$.selection')=json_remove(json_extract(r.fixed_query,'$.query'),'$.receivedSince')
    AND (t.committed_checkpoint='{}' AND json_extract(r.fixed_query,'$.query.receivedSince')=json_extract(p.plan,'$.selection.initialReceivedSince')
      OR json_extract(t.committed_checkpoint,'$.selection')=json_extract(p.plan,'$.selection')
        AND json_extract(t.committed_checkpoint,'$.receivedThrough')=json_extract(r.fixed_query,'$.query.receivedSince'))
  ) THEN RAISE(ABORT,'LoTW account run cannot be rearmed') END;
 -- Dated fallback may advance the shared scope sequence and connection health.
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM inventory_runs r
  JOIN inventory_streams t ON (t.tenant,t.scope_id,t.stream_id)=(r.tenant,r.scope_id,r.stream_id)
  JOIN inventory_scopes s ON (s.tenant,s.scope_id)=(r.tenant,r.scope_id)
  JOIN connections l ON (l.tenant,l.id)=(s.tenant,s.connection_id)
  JOIN inventory_wakeups w ON (w.tenant,w.scope_id,w.stream_id,w.work_version,w.run_id)=(r.tenant,r.scope_id,r.stream_id,NEW.job_version,r.run_id)
  JOIN ingestion_run_pages x ON x.tenant=w.tenant AND x.page_id=substr(w.wakeup_id,1,length(w.wakeup_id)-5) AND w.wakeup_id=x.page_id||':next'
  JOIN ingestion_pages p ON (p.tenant,p.page_id)=(x.tenant,x.page_id)
  WHERE (r.tenant,r.run_id)=(NEW.tenant,NEW.run_id)
   AND x.run_id=r.run_id AND x.action='hold' AND x.expected_phase='collecting' AND x.reason=r.reason
   AND x.expected_run_version+1=NEW.run_version AND x.expected_job_version+1=NEW.job_version
   AND p.state='committed' AND (p.scope_id,p.stream_id,p.expected_config_version,p.adapter_binding,p.query_binding)=(r.scope_id,r.stream_id,r.config_version,r.adapter_binding,r.query_binding)
   AND p.expected_stream_version+1=t.checkpoint_version AND p.expected_sequence+1<=s.accepted_sequence
   AND p.next_resume=t.resume_state AND p.next_checkpoint IS NULL
   AND (p.credential_version,p.remote_identity)=(l.credential_version,l.remote_identity)
   AND json_remove(p.connection_config,'$.lastError','$.lastSuccessfulPollAt')=json_remove(l.config,'$.lastError','$.lastSuccessfulPollAt')
 ) THEN RAISE(ABORT,'LoTW account hold receipt changed') END;
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM inventory_runs r
  JOIN inventory_scopes s ON (s.tenant,s.scope_id)=(r.tenant,r.scope_id)
  JOIN connections l ON (l.tenant,l.id)=(s.tenant,s.connection_id)
  JOIN accounts a ON a.id=r.tenant AND a.status='active'
  JOIN private_data d ON (d.tenant,d.connection,d.id,d.kind)=(l.tenant,l.id,l.credential_version,'credential')
  JOIN leases lease ON lease.tenant=r.tenant AND lease.scope='inventory:'||r.scope_id AND lease.token=NEW.lease_token AND lease.fence=NEW.lease_fence
  WHERE (r.tenant,r.run_id)=(NEW.tenant,NEW.run_id)
   AND l.status='active' AND l.kind='lotw' AND l.remote_identity=s.logical_identity AND json_extract(l.config,'$.readAccess')=1
   AND d.revoked_at IS NULL AND (d.expires_at IS NULL OR d.expires_at>unixepoch('subsec')*1000) AND lease.expires_at>unixepoch('subsec')*1000
 ) THEN RAISE(ABORT,'LoTW account read authority changed') END;
END;

DROP TRIGGER inventory_run_version;
CREATE TRIGGER inventory_run_version BEFORE UPDATE ON inventory_runs
 WHEN NEW.version<=OLD.version OR NEW.expected_stream_version<OLD.expected_stream_version OR NEW.coverage_version<OLD.coverage_version
 OR OLD.phase='complete' OR (OLD.phase='held' AND NOT (
  NEW.phase='collecting' AND NEW.version=OLD.version+1 AND NEW.coverage_version=OLD.coverage_version+1 AND NEW.reason IS NULL
  AND (NEW.expected_stream_version,NEW.proposed_checkpoint,NEW.cursor_family,NEW.cursor_key,NEW.completed_at,NEW.phase_started_at)
   IS (OLD.expected_stream_version,OLD.proposed_checkpoint,OLD.cursor_family,OLD.cursor_key,OLD.completed_at,OLD.phase_started_at)
  AND (EXISTS(SELECT 1 FROM inventory_qrz_cover_rearms q WHERE (q.tenant,q.run_id,q.run_version,q.requested_at)=(OLD.tenant,OLD.run_id,OLD.version,NEW.position_started_at))
   OR EXISTS(SELECT 1 FROM inventory_lotw_account_rearms l WHERE (l.tenant,l.run_id,l.run_version,l.requested_at)=(OLD.tenant,OLD.run_id,OLD.version,NEW.position_started_at)))
 ))
BEGIN
 SELECT RAISE(ABORT,'inventory run version changed');
END;

CREATE TRIGGER inventory_lotw_account_rearm_publish AFTER INSERT ON inventory_lotw_account_rearms BEGIN
 UPDATE inventory_runs SET phase='collecting',reason=NULL,version=version+1,coverage_version=coverage_version+1,position_started_at=NEW.requested_at
 WHERE (tenant,run_id,version)=(NEW.tenant,NEW.run_id,NEW.run_version);
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'LoTW account run was not rearmed') END;
 UPDATE inventory_coverage SET state='collecting',version=version+1
 WHERE (tenant,scope_id,stream_id,facet,partition_id)=(SELECT tenant,scope_id,stream_id,facet,partition_id FROM inventory_runs WHERE tenant=NEW.tenant AND run_id=NEW.run_id);
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'LoTW account coverage was not rearmed') END;
 UPDATE inventory_stream_jobs SET state='ready',reason=NULL,work_version=work_version+1,next_due_at=NEW.requested_at
 WHERE tenant=NEW.tenant AND active_run_id=NEW.run_id AND work_version=NEW.job_version;
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'LoTW account job was not rearmed') END;
 INSERT INTO inventory_wakeups(tenant,wakeup_id,scope_id,stream_id,run_id,work_version,not_before)
 SELECT tenant,'lotw-account-rearm:'||NEW.run_id,scope_id,stream_id,NEW.run_id,work_version,next_due_at
 FROM inventory_stream_jobs WHERE tenant=NEW.tenant AND active_run_id=NEW.run_id;
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'LoTW account wakeup was not published') END;
END;
CREATE TRIGGER inventory_lotw_account_rearm_no_update BEFORE UPDATE ON inventory_lotw_account_rearms BEGIN SELECT RAISE(ABORT,'immutable LoTW account rearm'); END;
CREATE TRIGGER inventory_lotw_account_rearm_no_delete BEFORE DELETE ON inventory_lotw_account_rearms BEGIN SELECT RAISE(ABORT,'retained LoTW account rearm'); END;

-- A reopened job keeps dated fallback active until its new read completes.
DROP VIEW inventory_lotw_account_feed_status;
CREATE VIEW inventory_lotw_account_feed_status AS
 SELECT p.tenant,p.scope_id,p.config_version,p.runtime_version,
  unixepoch(json_extract(p.plan,'$.selection.initialReceivedSince'))*1000 AS initial_received_at,
  CASE WHEN j.state IN('idle','ready') AND NOT EXISTS(SELECT 1 FROM inventory_lotw_account_rearms q WHERE (q.tenant,q.run_id)=(j.tenant,j.active_run_id))
   THEN r.completed_at+2*p.poll_period_ms END AS healthy_until
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
