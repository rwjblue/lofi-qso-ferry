-- Index publishable wakeups independently of retained source-proof evidence.
ALTER TABLE inventory_wakeups ADD COLUMN publishable INTEGER NOT NULL DEFAULT 0
 CHECK(publishable IN(0,1));
DROP INDEX inventory_wakeup_pending;
CREATE INDEX inventory_wakeup_pending ON inventory_wakeups(not_before,tenant,scope_id,stream_id)
 WHERE publishable=1 AND published_at IS NULL;
CREATE INDEX inventory_wakeup_recovery ON inventory_wakeups(not_before,tenant,scope_id,stream_id,published_at)
 WHERE publishable=1 AND published_at IS NOT NULL;
CREATE INDEX inventory_wakeup_retirement ON inventory_wakeups(not_before,tenant,wakeup_id)
 WHERE publishable=0;

-- Backfill from the current jobs, with one lookup per stream.
UPDATE inventory_wakeups SET publishable=1 WHERE rowid IN (
 SELECT w.rowid FROM inventory_stream_jobs j CROSS JOIN inventory_wakeups w
 WHERE (w.tenant,w.scope_id,w.stream_id,w.work_version)=(j.tenant,j.scope_id,j.stream_id,j.work_version)
 AND j.state IN('idle','ready')
);

-- A delta may use its predecessor while active and after it becomes the
-- latest published source delta. Keep those proof anchors outside the queue.
CREATE VIEW inventory_wakeup_proof_pins AS
 SELECT j.tenant,j.scope_id,j.stream_id,b.expected_job_version AS work_version
 FROM inventory_stream_jobs j CROSS JOIN ingestion_run_pages b
 WHERE (b.tenant,b.page_id)=(j.tenant,'run:'||j.active_run_id||':begin')
 UNION ALL
 SELECT c.tenant,c.scope_id,c.stream_id,b.expected_job_version
 FROM inventory_coverage c CROSS JOIN ingestion_run_pages b
 WHERE c.facet='source' AND (b.tenant,b.page_id)=(c.tenant,'run:'||c.delta_run_id||':begin');

CREATE TRIGGER inventory_wakeup_publishable_insert AFTER INSERT ON inventory_wakeups
 WHEN EXISTS(SELECT 1 FROM inventory_stream_jobs j
  WHERE (j.tenant,j.scope_id,j.stream_id,j.work_version)=(NEW.tenant,NEW.scope_id,NEW.stream_id,NEW.work_version)
  AND j.state IN('idle','ready')) BEGIN
 UPDATE inventory_wakeups SET publishable=1 WHERE rowid=NEW.rowid AND publishable=0;
 -- Each ordinary publication can retire its predecessor and released pins,
 -- even when the periodic backfill collector is busy with older streams.
 DELETE FROM inventory_wakeups WHERE rowid IN (
  SELECT w.rowid FROM inventory_wakeups w
  WHERE (w.tenant,w.scope_id,w.stream_id)=(NEW.tenant,NEW.scope_id,NEW.stream_id)
  AND w.work_version<NEW.work_version AND w.publishable=0
  AND NOT EXISTS(SELECT 1 FROM inventory_wakeup_proof_pins p
   WHERE (p.tenant,p.scope_id,p.stream_id,p.work_version)=(w.tenant,w.scope_id,w.stream_id,w.work_version))
  ORDER BY w.work_version LIMIT 16
 );
END;

-- Ordinary publication advances the job first. LoTW fallback inserts its
-- wakeup first, so the job transition also activates any already present row.
CREATE TRIGGER inventory_wakeup_publishable_job AFTER UPDATE OF work_version ON inventory_stream_jobs BEGIN
 UPDATE inventory_wakeups SET publishable=0
 WHERE (tenant,scope_id,stream_id,work_version)=(OLD.tenant,OLD.scope_id,OLD.stream_id,OLD.work_version)
 AND publishable=1;
 UPDATE inventory_wakeups SET publishable=1
 WHERE (tenant,scope_id,stream_id,work_version)=(NEW.tenant,NEW.scope_id,NEW.stream_id,NEW.work_version)
 AND publishable=0 AND NEW.state IN('idle','ready');
END;
