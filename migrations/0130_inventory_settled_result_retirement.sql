-- Durable ownership and receipts remain. A cooled, reconstructible result
-- can leave the live comparison graph so its reverse dependencies retire.
CREATE INDEX inventory_settled_result_age ON match_results(derived_at,tenant,destination,source_scope,record_key)
 WHERE state IN('matched_existing','absent_at_inventory');

CREATE VIEW inventory_settled_results_retirable AS
 SELECT r.tenant,r.destination,r.source_scope,r.record_key,r.derived_at
 FROM match_results r
 JOIN inventory_match_sets h ON (h.tenant,h.set_id)=(r.tenant,r.set_id) AND h.state='committed'
 JOIN comparison_domains d ON d.tenant=r.tenant AND d.active_generation=h.generation_id
 JOIN accounts account ON account.id=r.tenant AND account.status='active'
 JOIN inventory_scopes s ON (s.tenant,s.scope_id)=(r.tenant,r.source_scope) AND s.provider='lofi'
 JOIN inventory_scopes t ON (t.tenant,t.scope_id)=(r.tenant,r.destination)
 CROSS JOIN inventory_retention_policy p
 WHERE r.state IN('matched_existing','absent_at_inventory')
 AND r.derived_at<=unixepoch('subsec')*1000-p.settled_retention_days*86400000
 AND NOT EXISTS(SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=r.tenant)
 AND NOT EXISTS(SELECT 1 FROM matching_work w WHERE (w.tenant,w.generation_id,w.destination,w.source_scope,w.record_key)=(r.tenant,h.generation_id,r.destination,r.source_scope,r.record_key) AND w.completed_version<w.work_version)
 AND EXISTS(SELECT 1 FROM inventory_match_records q
  JOIN inventory_records e ON (e.tenant,e.scope_id,e.entity_family,e.record_key)=(q.tenant,q.scope_id,'qso',q.record_key)
  JOIN inventory_record_facets f ON (f.tenant,f.scope_id,f.entity_family,f.record_key,f.facet)=(q.tenant,q.scope_id,'qso',q.record_key,'source')
  JOIN comparison_projections c ON (c.tenant,c.generation_id,c.scope_id,c.record_key,c.facet)=(q.tenant,h.generation_id,q.scope_id,q.record_key,'source')
  LEFT JOIN projection_domains v ON (v.tenant,v.scope_id,v.operation_key)=(e.tenant,e.scope_id,e.parent_key)
  WHERE (q.tenant,q.set_id,q.scope_id,q.record_key,q.facet)=(r.tenant,r.set_id,r.source_scope,r.record_key,'source')
  AND (e.status,e.subtype)=('active','qso') AND e.parent_key IS q.parent_key
  AND (f.semantic_version,c.version,c.config_version,coalesce(v.topology_version,0))=(q.current_semantic_version,q.current_projection_version,s.config_version,q.current_topology_version))
 AND (t.provider!='qrz' OR NOT EXISTS(
  SELECT 1 FROM inventory_qrz_attempts a WHERE (a.tenant,a.book_identity,a.source_identity,a.record_key)=(r.tenant,t.logical_identity,s.logical_identity,r.record_key) AND a.cancelled_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM inventory_qrz_dispatches d WHERE (d.tenant,d.attempt_id)=(a.tenant,a.attempt_id) AND d.settled_at IS NOT NULL)
 ))
 AND (t.provider!='lotw' OR NOT EXISTS(
  SELECT 1 FROM inventory_lotw_batch_members m WHERE (m.tenant,m.source_identity,m.record_key)=(r.tenant,s.logical_identity,r.record_key) AND m.cancelled_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM inventory_lotw_dispatches d WHERE (d.tenant,d.batch_id)=(m.tenant,m.batch_id) AND d.settled_at IS NOT NULL)
 ))
 AND (
  (r.state='matched_existing' AND EXISTS(SELECT 1 FROM inventory_historical_associations a
   WHERE (a.tenant,a.provider,a.book_identity,a.source_identity,a.record_key)=(r.tenant,t.provider,t.logical_identity,s.logical_identity,r.record_key)
   AND a.remote_record_key=r.remote_key AND a.created_at<=unixepoch('subsec')*1000-p.settled_retention_days*86400000))
  OR (t.provider='qrz' AND EXISTS(SELECT 1 FROM inventory_qrz_attempts a
   JOIN inventory_qrz_dispatch_receipts q ON (q.tenant,q.attempt_id)=(a.tenant,a.attempt_id)
   JOIN inventory_qrz_dispatches d ON (d.tenant,d.attempt_id)=(a.tenant,a.attempt_id) AND d.settled_at IS NOT NULL
   WHERE (a.tenant,a.book_identity,a.source_identity,a.record_key)=(r.tenant,t.logical_identity,s.logical_identity,r.record_key) AND a.cancelled_at IS NULL
   AND (q.remote_id=coalesce(nullif(ltrim(r.remote_key,'0'),''),'0') AND r.state='matched_existing' OR (a.result_set,a.result_version)=(r.set_id,r.version) AND r.state='absent_at_inventory')
   AND max(q.received_at,d.settled_at)<=unixepoch('subsec')*1000-p.settled_retention_days*86400000))
  OR (t.provider='lotw' AND r.state='absent_at_inventory' AND EXISTS(SELECT 1 FROM inventory_lotw_batch_members m
   JOIN inventory_lotw_batches b ON (b.tenant,b.batch_id,b.book_identity)=(m.tenant,m.batch_id,t.logical_identity)
   JOIN inventory_lotw_member_receipts q ON (q.tenant,q.attempt_id)=(m.tenant,m.attempt_id)
   JOIN inventory_lotw_dispatches d ON (d.tenant,d.batch_id)=(m.tenant,m.batch_id) AND d.settled_at IS NOT NULL
   WHERE (m.tenant,m.source_identity,m.record_key)=(r.tenant,s.logical_identity,r.record_key) AND m.cancelled_at IS NULL
   AND (m.result_set,m.result_version)=(r.set_id,r.version)
   AND max(q.received_at,d.settled_at)<=unixepoch('subsec')*1000-p.settled_retention_days*86400000))
 );

CREATE TRIGGER inventory_settled_result_delete BEFORE DELETE ON match_results
 WHEN NOT EXISTS(SELECT 1 FROM inventory_settled_results_retirable a WHERE (a.tenant,a.destination,a.source_scope,a.record_key)=(OLD.tenant,OLD.destination,OLD.source_scope,OLD.record_key)) BEGIN
 SELECT RAISE(ABORT,'inventory result still retained');
END;

-- A sweep visits only a bounded prefix per turn. Ineligible rows do not block
-- later records, and a later sweep retries records that were pinned or unsettled.
CREATE TABLE inventory_settled_result_census (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 derived_at INTEGER NOT NULL DEFAULT 0,tenant TEXT NOT NULL DEFAULT '',destination TEXT NOT NULL DEFAULT '',
 source_scope TEXT NOT NULL DEFAULT '',record_key TEXT NOT NULL DEFAULT '',restart_at INTEGER
);
INSERT INTO inventory_settled_result_census(singleton) VALUES(1);

CREATE TRIGGER inventory_settled_result_census_collect AFTER UPDATE OF derived_at,tenant,destination,source_scope,record_key ON inventory_settled_result_census BEGIN
 DELETE FROM match_results WHERE (tenant,destination,source_scope,record_key) IN (
  SELECT r.tenant,r.destination,r.source_scope,r.record_key FROM match_results r INDEXED BY inventory_settled_result_age
  WHERE r.state IN('matched_existing','absent_at_inventory')
  AND (r.derived_at,r.tenant,r.destination,r.source_scope,r.record_key)>(CASE WHEN OLD.restart_at IS NULL THEN OLD.derived_at ELSE 0 END,CASE WHEN OLD.restart_at IS NULL THEN OLD.tenant ELSE '' END,CASE WHEN OLD.restart_at IS NULL THEN OLD.destination ELSE '' END,CASE WHEN OLD.restart_at IS NULL THEN OLD.source_scope ELSE '' END,CASE WHEN OLD.restart_at IS NULL THEN OLD.record_key ELSE '' END)
  AND (r.derived_at,r.tenant,r.destination,r.source_scope,r.record_key)<=(NEW.derived_at,NEW.tenant,NEW.destination,NEW.source_scope,NEW.record_key)
  AND EXISTS(SELECT 1 FROM inventory_settled_results_retirable a WHERE (a.tenant,a.destination,a.source_scope,a.record_key)=(r.tenant,r.destination,r.source_scope,r.record_key))
 );
END;

CREATE TRIGGER inventory_retention_policy_restart AFTER UPDATE OF settled_retention_days ON inventory_retention_policy
 WHEN NEW.settled_retention_days!=OLD.settled_retention_days BEGIN
 UPDATE inventory_settled_result_census SET restart_at=0 WHERE singleton=1;
END;
