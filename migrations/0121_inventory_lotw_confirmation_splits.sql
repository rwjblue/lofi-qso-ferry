DROP VIEW inventory_lotw_confirmation_targets;

-- Keep the receipt selection as authority while giving each QSL date branch
-- an independent query and cursor. An empty branch is the original schedule.
CREATE TABLE inventory_lotw_confirmation_schedule_next (
 tenant TEXT NOT NULL, scope_id TEXT NOT NULL, receipt_stream_id TEXT NOT NULL,
 scope_version INTEGER NOT NULL CHECK(scope_version>0),
 branch TEXT NOT NULL DEFAULT '' CHECK(length(branch)<=5 AND branch NOT GLOB '*[^01]*'),
 start_date TEXT, end_date TEXT,
 initial_confirmed_since TEXT NOT NULL,
 next_due_at INTEGER NOT NULL CHECK(next_due_at>=0),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 rejected_credential_version TEXT, overflow INTEGER NOT NULL DEFAULT 0 CHECK(overflow IN (0,1)),
 split_at INTEGER CHECK(split_at IS NULL OR (split_at>0 AND overflow=1)),
 PRIMARY KEY(tenant,scope_id,receipt_stream_id,scope_version,branch),
 FOREIGN KEY(tenant,scope_id,receipt_stream_id) REFERENCES inventory_scheduled_selections(tenant,scope_id,stream_id),
 CHECK((branch='' AND start_date IS NULL AND end_date IS NULL) OR
       (branch!='' AND start_date IS NOT NULL AND end_date IS NOT NULL AND start_date<=end_date))
);
INSERT INTO inventory_lotw_confirmation_schedule_next(
 tenant,scope_id,receipt_stream_id,scope_version,initial_confirmed_since,next_due_at,version,rejected_credential_version,overflow
) SELECT tenant,scope_id,receipt_stream_id,scope_version,initial_confirmed_since,next_due_at,version,rejected_credential_version,overflow
 FROM inventory_lotw_confirmation_schedule;
DROP TABLE inventory_lotw_confirmation_schedule;
ALTER TABLE inventory_lotw_confirmation_schedule_next RENAME TO inventory_lotw_confirmation_schedule;
CREATE INDEX inventory_lotw_confirmation_due
 ON inventory_lotw_confirmation_schedule(next_due_at,tenant,scope_id,receipt_stream_id,scope_version,branch)
 WHERE overflow=0;
CREATE INDEX inventory_lotw_confirmation_split_due
 ON inventory_lotw_confirmation_schedule(next_due_at,tenant,scope_id,receipt_stream_id,scope_version,branch)
 WHERE overflow=1 AND split_at IS NULL;
CREATE INDEX inventory_lotw_confirmation_rejected_credential
 ON inventory_lotw_confirmation_schedule(tenant,scope_id,scope_version,rejected_credential_version)
 WHERE rejected_credential_version IS NOT NULL;

CREATE VIEW inventory_lotw_confirmation_targets AS
 SELECT p.tenant,p.scope_id,p.stream_id AS receipt_stream_id,p.config_version AS scope_version,
        p.plan,p.created_at,c.credential_version
 FROM inventory_scheduled_selections p
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
