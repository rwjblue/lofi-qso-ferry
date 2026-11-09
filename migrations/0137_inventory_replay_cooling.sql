-- A restored source body gets a fresh hot period. This prevents repeated
-- full scans when a queued comparison resumes after cold-body recovery.
ALTER TABLE inventory_body_replay_requests ADD COLUMN restored_at INTEGER
 CHECK(restored_at IS NULL OR restored_at>=requested_at);
CREATE VIEW inventory_replay_coolable_bodies AS
 SELECT p.tenant,p.scope_id,p.payload_id FROM inventory_coolable_bodies p
 CROSS JOIN inventory_retention_policy c
 WHERE NOT EXISTS(SELECT 1 FROM inventory_body_replay_requests r
  WHERE (r.tenant,r.scope_id,r.payload_id)=(p.tenant,p.scope_id,p.payload_id) AND r.state='restored'
  AND coalesce(r.restored_at,r.requested_at)>unixepoch('subsec')*1000-c.settled_retention_days*86400000);
