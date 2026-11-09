-- Keep completed correction proofs discoverable until the correction uses them.
ALTER TABLE inventory_source_proof_jobs ADD COLUMN grid_pending INTEGER NOT NULL DEFAULT 0 CHECK(grid_pending IN(0,1));
UPDATE inventory_source_proof_jobs SET grid_pending=1
 WHERE phase IN('collecting','draining','complete')
 AND json_extract(snapshot,'$.contacts[0].routes[0].purpose')='lotw_grid_correction';
CREATE INDEX inventory_source_proof_grid_ready ON inventory_source_proof_jobs(due_at,tenant,scope_id,expires_at)
 WHERE phase='complete' AND grid_pending=1;
