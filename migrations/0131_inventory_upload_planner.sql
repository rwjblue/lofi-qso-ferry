-- A bounded route cursor keeps old work moving without storing another upload
-- ledger. Native source proofs and artifact/dispatch claims own the evidence.
CREATE TABLE inventory_upload_planner (
 tenant TEXT NOT NULL,source_scope TEXT NOT NULL,destination TEXT NOT NULL,
 after_stamp INTEGER,after_key TEXT,planned_at INTEGER NOT NULL CHECK(planned_at>=0),
 due_at INTEGER NOT NULL CHECK(due_at>=0),
 batch_limit INTEGER NOT NULL CHECK(batch_limit BETWEEN 1 AND 100),
 proof_id TEXT,record_keys TEXT,
 PRIMARY KEY(tenant,source_scope,destination),
 FOREIGN KEY(tenant,source_scope) REFERENCES inventory_scopes(tenant,scope_id),
 FOREIGN KEY(tenant,destination) REFERENCES inventory_scopes(tenant,scope_id),
 CHECK((after_stamp IS NULL)=(after_key IS NULL)),
 CHECK((proof_id IS NULL)=(record_keys IS NULL)),
 CHECK(record_keys IS NULL OR (json_valid(record_keys) AND json_type(record_keys)='array' AND json_array_length(record_keys) BETWEEN 1 AND batch_limit))
);
CREATE UNIQUE INDEX inventory_upload_planner_source_pending ON inventory_upload_planner(tenant,source_scope) WHERE proof_id IS NOT NULL;
CREATE INDEX inventory_upload_planner_due ON inventory_upload_planner(due_at,tenant,source_scope,destination) WHERE proof_id IS NOT NULL;
CREATE INDEX inventory_qrz_preparations_proof ON inventory_qrz_preparations(tenant,proof_id,stage_id);
CREATE INDEX inventory_lotw_batches_proof ON inventory_lotw_batches(tenant,proof_id,batch_id);
CREATE INDEX inventory_qrz_preparations_source ON inventory_qrz_preparations(tenant,source_scope,stage_id);
CREATE INDEX inventory_lotw_batches_source ON inventory_lotw_batches(tenant,source_scope,batch_id) WHERE cancelled_at IS NULL;
CREATE INDEX inventory_qrz_send_jobs_due ON inventory_qrz_send_jobs(due_at,tenant,attempt_id) WHERE due_at IS NOT NULL;
CREATE INDEX inventory_lotw_send_jobs_due ON inventory_lotw_send_jobs(due_at,tenant,batch_id) WHERE due_at IS NOT NULL;
