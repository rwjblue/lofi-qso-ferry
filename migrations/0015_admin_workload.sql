-- Old samples remain unknown rather than implying there was no held work.
ALTER TABLE scheduler_runs ADD COLUMN work_live_ready INTEGER;
ALTER TABLE scheduler_runs ADD COLUMN work_live_held INTEGER;
ALTER TABLE scheduler_runs ADD COLUMN work_live_blocked INTEGER;
ALTER TABLE scheduler_runs ADD COLUMN work_background_ready INTEGER;
ALTER TABLE scheduler_runs ADD COLUMN work_background_held INTEGER;
ALTER TABLE scheduler_runs ADD COLUMN work_background_blocked INTEGER;
CREATE INDEX admin_attempt_contact ON attempts(tenant,source,qso,destination);
CREATE INDEX admin_delivery_events ON attempt_events(tenant,attempt,at)
 WHERE state IN('delivered','observed');
CREATE INDEX admin_delivery_events_time ON attempt_events(at,tenant,attempt)
 WHERE state IN('delivered','observed');
