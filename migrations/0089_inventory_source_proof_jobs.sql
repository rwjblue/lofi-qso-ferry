-- One short-lived collection per managed source, shared by its destinations.
CREATE TABLE inventory_source_proof_jobs (
 tenant TEXT NOT NULL,scope_id TEXT NOT NULL,job_id TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 phase TEXT NOT NULL DEFAULT 'collecting' CHECK(phase IN('collecting','draining','held','complete')),
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot) AND length(snapshot)<=262144),
 witnesses TEXT NOT NULL CHECK(json_valid(witnesses) AND json_type(witnesses)='array' AND json_array_length(witnesses)<=64),
 continuation TEXT CHECK(continuation IS NULL OR (json_valid(continuation) AND length(continuation)<=65536)),
 started_at INTEGER NOT NULL CHECK(started_at>0),collection_deadline INTEGER NOT NULL,
 due_at INTEGER NOT NULL CHECK(due_at>0),attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 4),
 collection_finished_at INTEGER,expires_at INTEGER,drain_run TEXT,reason TEXT,
 PRIMARY KEY(tenant,scope_id),UNIQUE(tenant,job_id),UNIQUE(tenant,drain_run),
 FOREIGN KEY(tenant,scope_id) REFERENCES inventory_scopes(tenant,scope_id),
 CHECK(collection_deadline>started_at AND collection_deadline<=started_at+120000),
 CHECK((collection_finished_at IS NULL AND expires_at IS NULL AND drain_run IS NULL) OR
       (collection_finished_at IS NOT NULL AND expires_at IS NOT NULL AND drain_run IS NOT NULL
        AND collection_finished_at BETWEEN started_at AND collection_deadline AND expires_at>collection_finished_at AND expires_at<=collection_finished_at+300000)),
 CHECK(phase NOT IN('draining','complete') OR collection_finished_at IS NOT NULL),
 CHECK((phase='held')=(reason IS NOT NULL))
);
CREATE INDEX inventory_source_proof_job_due ON inventory_source_proof_jobs(due_at,tenant,scope_id)
 WHERE phase IN('collecting','draining');

CREATE TABLE inventory_source_proof_admissions (
 tenant TEXT NOT NULL,scope_id TEXT NOT NULL,job_id TEXT NOT NULL,
 version INTEGER NOT NULL,lease_token TEXT NOT NULL,lease_fence INTEGER NOT NULL,
 PRIMARY KEY(tenant,scope_id)
);
CREATE TRIGGER inventory_source_proof_admit BEFORE INSERT ON inventory_source_proof_admissions BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM inventory_source_proof_jobs j
  JOIN leases l ON l.tenant=j.tenant AND l.scope='inventory:'||j.scope_id AND l.token=NEW.lease_token AND l.fence=NEW.lease_fence
  JOIN inventory_source_proof_scope s ON s.tenant=j.tenant AND s.scope_id=j.scope_id
  WHERE j.tenant=NEW.tenant AND j.scope_id=NEW.scope_id AND j.job_id=NEW.job_id AND j.version=NEW.version AND j.phase='collecting'
  AND j.attempts<3 AND j.collection_deadline>unixepoch('subsec')*1000 AND l.expires_at>unixepoch('subsec')*1000
  AND (s.stream_id,s.config_version,s.runtime_version,s.credential_version,s.connection_config,s.checkpoint_version,s.work_version,s.coverage_epoch,s.policy_epoch,s.generation_id)=
   (json_extract(j.snapshot,'$.source.stream_id'),json_extract(j.snapshot,'$.source.config_version'),json_extract(j.snapshot,'$.source.runtime_version'),
    json_extract(j.snapshot,'$.source.credential_version'),json_extract(j.snapshot,'$.source.connection_config'),json_extract(j.snapshot,'$.source.checkpoint_version'),
    json_extract(j.snapshot,'$.source.work_version'),json_extract(j.snapshot,'$.source.coverage_epoch'),json_extract(j.snapshot,'$.source.policy_epoch'),json_extract(j.snapshot,'$.source.generation_id'))
 ) THEN RAISE(ABORT,'inventory source proof admission changed') END;
END;
CREATE TRIGGER inventory_source_proof_debit AFTER INSERT ON inventory_source_proof_admissions BEGIN
 UPDATE inventory_source_proof_jobs SET attempts=attempts+1
 WHERE tenant=NEW.tenant AND scope_id=NEW.scope_id AND job_id=NEW.job_id AND version=NEW.version;
END;
