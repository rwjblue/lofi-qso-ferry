-- Explicit rehearsal recovery only. The original hold receipt binds the cursor
-- and read authority, and the run stays unpublished until normal completion.
CREATE TABLE inventory_qrz_cover_rearms (
 tenant TEXT NOT NULL, run_id TEXT NOT NULL, run_version INTEGER NOT NULL,
 job_version INTEGER NOT NULL, lease_token TEXT NOT NULL, lease_fence INTEGER NOT NULL,
 requested_at INTEGER NOT NULL CHECK(requested_at>0),
 PRIMARY KEY(tenant,run_id,run_version), FOREIGN KEY(tenant,run_id) REFERENCES inventory_runs(tenant,run_id)
);
CREATE TRIGGER inventory_qrz_cover_rearm_guard BEFORE INSERT ON inventory_qrz_cover_rearms BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_fresh_start_lock WHERE id=1)
  OR NEW.requested_at>unixepoch('subsec')*1000 THEN RAISE(ABORT,'QRZ covering rearm requires a write-locked rehearsal') END;
 SELECT CASE WHEN NOT EXISTS(
   SELECT 1 FROM inventory_runs r
   JOIN inventory_stream_jobs j ON (j.tenant,j.scope_id,j.stream_id)=(r.tenant,r.scope_id,r.stream_id) AND j.active_run_id=r.run_id
   JOIN inventory_streams t ON (t.tenant,t.scope_id,t.stream_id)=(r.tenant,r.scope_id,r.stream_id)
   JOIN inventory_coverage c ON (c.tenant,c.scope_id,c.stream_id,c.facet,c.partition_id)=(r.tenant,r.scope_id,r.stream_id,r.facet,r.partition_id)
   JOIN inventory_scopes s ON (s.tenant,s.scope_id)=(r.tenant,r.scope_id)
   JOIN inventory_runtime runtime ON runtime.id=1 AND runtime.mode='inventory_read_only' AND runtime.version=s.runtime_version
   JOIN inventory_scheduled_selections schedule ON (schedule.tenant,schedule.scope_id,schedule.stream_id)=(r.tenant,r.scope_id,r.stream_id) AND schedule.runtime_version=s.runtime_version AND schedule.config_version=r.config_version
   WHERE r.tenant=NEW.tenant AND r.run_id=NEW.run_id AND r.version=NEW.run_version AND j.work_version=NEW.job_version
    AND r.mode='delta' AND r.facet='receipt' AND r.phase='held' AND j.state='held'
    AND r.reason='verification_required' AND j.reason=r.reason AND r.proposed_checkpoint IS NULL AND NEW.requested_at>=r.position_started_at
    AND c.state='held' AND c.building_run_id=r.run_id AND c.version=r.coverage_version
    AND c.kind='observed_selection' AND c.published_config_version=r.config_version AND c.partition_binding=r.partition_binding
    AND s.state='observing' AND s.provider='qrz' AND s.config_version=r.config_version AND s.adapter_binding=r.adapter_binding
    AND t.query_binding=r.query_binding AND t.checkpoint_version=r.expected_stream_version
    AND json_extract(r.fixed_query,'$.provider')='qrz'
    AND json_extract(r.fixed_query,'$.selection.modifiedSince')=json_extract(t.committed_checkpoint,'$.modifiedSince')
    AND EXISTS(SELECT 1 FROM inventory_runs saved WHERE saved.tenant=r.tenant AND saved.run_id IN(c.published_run_id,c.delta_run_id)
     AND (saved.scope_id,saved.stream_id,saved.facet,saved.partition_id,saved.config_version)=(r.scope_id,r.stream_id,r.facet,r.partition_id,r.config_version)
     AND saved.phase='complete' AND saved.proposed_checkpoint=t.committed_checkpoint)
    AND json_type(t.resume_state,'$.coveringDateSelection')='true' AND json_extract(t.resume_state,'$.version')=1
    AND json_type(t.resume_state,'$.afterLogId')='integer' AND json_extract(t.resume_state,'$.afterLogId')>0
    AND json_type(t.resume_state,'$.previousFullPage.afterLogId')='integer'
    AND json_extract(t.resume_state,'$.previousFullPage.afterLogId')<json_extract(t.resume_state,'$.afterLogId')
    AND json_extract(t.resume_state,'$.previousFullPage.nextAfterLogId')=json_extract(t.resume_state,'$.afterLogId')
    AND json_type(t.resume_state,'$.pageSize')='integer' AND json_extract(t.resume_state,'$.pageSize') BETWEEN 1 AND 250
    AND json_extract(t.resume_state,'$.previousFullPage.pageSize')=json_extract(t.resume_state,'$.pageSize')
  ) THEN RAISE(ABORT,'QRZ covering run cannot be rearmed') END;
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM inventory_runs r
  JOIN inventory_streams t ON (t.tenant,t.scope_id,t.stream_id)=(r.tenant,r.scope_id,r.stream_id)
  JOIN inventory_scopes s ON (s.tenant,s.scope_id)=(r.tenant,r.scope_id)
  JOIN connections link ON (link.tenant,link.id)=(s.tenant,s.connection_id)
  JOIN inventory_wakeups w ON (w.tenant,w.scope_id,w.stream_id,w.work_version)=(r.tenant,r.scope_id,r.stream_id,NEW.job_version) AND w.run_id=r.run_id
  JOIN ingestion_run_pages x ON x.tenant=w.tenant AND x.page_id=substr(w.wakeup_id,1,length(w.wakeup_id)-5) AND w.wakeup_id=x.page_id||':next'
  JOIN ingestion_pages p ON (p.tenant,p.page_id)=(x.tenant,x.page_id)
  WHERE r.tenant=NEW.tenant AND r.run_id=NEW.run_id
   AND x.run_id=r.run_id AND x.action='hold' AND x.expected_phase='collecting' AND x.reason=r.reason
   AND x.expected_run_version+1=NEW.run_version AND x.expected_job_version+1=NEW.job_version
   AND p.state='committed' AND (p.scope_id,p.stream_id,p.expected_config_version,p.adapter_binding,p.query_binding)=(r.scope_id,r.stream_id,r.config_version,r.adapter_binding,r.query_binding)
   AND p.expected_stream_version+1=t.checkpoint_version AND p.expected_sequence+1=s.accepted_sequence
   AND p.next_resume=t.resume_state AND p.next_checkpoint IS NULL
   AND (p.credential_version,p.connection_config,p.remote_identity)=(link.credential_version,link.config,link.remote_identity)
 ) THEN RAISE(ABORT,'QRZ covering hold receipt changed') END;
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM inventory_runs r
  JOIN inventory_scopes s ON (s.tenant,s.scope_id)=(r.tenant,r.scope_id)
  JOIN connections link ON (link.tenant,link.id)=(s.tenant,s.connection_id)
  JOIN accounts a ON a.id=r.tenant AND a.status='active'
  JOIN private_data d ON (d.tenant,d.connection,d.id,d.kind)=(link.tenant,link.id,link.credential_version,'credential')
  JOIN leases l ON l.tenant=r.tenant AND l.scope='inventory:'||r.scope_id AND l.token=NEW.lease_token AND l.fence=NEW.lease_fence
  WHERE r.tenant=NEW.tenant AND r.run_id=NEW.run_id
   AND link.status='active' AND link.kind=s.provider AND link.remote_identity=s.logical_identity
   AND d.revoked_at IS NULL AND (d.expires_at IS NULL OR d.expires_at>unixepoch('subsec')*1000) AND l.expires_at>unixepoch('subsec')*1000
 ) THEN RAISE(ABORT,'QRZ covering read authority changed') END;
END;

DROP TRIGGER inventory_run_version;
CREATE TRIGGER inventory_run_version BEFORE UPDATE ON inventory_runs
 WHEN NEW.version<=OLD.version OR NEW.expected_stream_version<OLD.expected_stream_version OR NEW.coverage_version<OLD.coverage_version
 OR OLD.phase='complete' OR (OLD.phase='held' AND NOT (
  NEW.phase='collecting' AND NEW.version=OLD.version+1 AND NEW.coverage_version=OLD.coverage_version+1 AND NEW.reason IS NULL
  AND (NEW.expected_stream_version,NEW.proposed_checkpoint,NEW.cursor_family,NEW.cursor_key,NEW.completed_at,NEW.phase_started_at)
   IS (OLD.expected_stream_version,OLD.proposed_checkpoint,OLD.cursor_family,OLD.cursor_key,OLD.completed_at,OLD.phase_started_at)
  AND EXISTS(SELECT 1 FROM inventory_qrz_cover_rearms q WHERE (q.tenant,q.run_id,q.run_version,q.requested_at)=(OLD.tenant,OLD.run_id,OLD.version,NEW.position_started_at))
 ))
BEGIN
 SELECT RAISE(ABORT,'inventory run version changed');
END;

CREATE TRIGGER inventory_qrz_cover_rearm_publish AFTER INSERT ON inventory_qrz_cover_rearms BEGIN
 UPDATE inventory_runs SET phase='collecting',reason=NULL,version=version+1,coverage_version=coverage_version+1,position_started_at=NEW.requested_at
 WHERE (tenant,run_id,version)=(NEW.tenant,NEW.run_id,NEW.run_version);
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'QRZ covering run was not rearmed') END;
 UPDATE inventory_coverage SET state='collecting',version=version+1
 WHERE (tenant,scope_id,stream_id,facet,partition_id)=(SELECT tenant,scope_id,stream_id,facet,partition_id FROM inventory_runs WHERE tenant=NEW.tenant AND run_id=NEW.run_id);
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'QRZ covering coverage was not rearmed') END;
 UPDATE inventory_stream_jobs SET state='ready',reason=NULL,work_version=work_version+1,next_due_at=NEW.requested_at
 WHERE tenant=NEW.tenant AND active_run_id=NEW.run_id AND work_version=NEW.job_version;
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'QRZ covering job was not rearmed') END;
 INSERT INTO inventory_wakeups(tenant,wakeup_id,scope_id,stream_id,run_id,work_version,not_before)
 SELECT tenant,'qrz-cover-rearm:'||NEW.run_id||':'||NEW.run_version,scope_id,stream_id,NEW.run_id,work_version,next_due_at
 FROM inventory_stream_jobs WHERE tenant=NEW.tenant AND active_run_id=NEW.run_id;
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'QRZ covering wakeup was not published') END;
END;
CREATE TRIGGER inventory_qrz_cover_rearm_no_update BEFORE UPDATE ON inventory_qrz_cover_rearms BEGIN SELECT RAISE(ABORT,'immutable QRZ covering rearm'); END;
CREATE TRIGGER inventory_qrz_cover_rearm_no_delete BEFORE DELETE ON inventory_qrz_cover_rearms BEGIN SELECT RAISE(ABORT,'retained QRZ covering rearm'); END;
