-- Recompute generic operating-detail holds with stable primary reason codes.
-- Reuse the bounded pair census and retain the current results until publication.
INSERT INTO inventory_matching_pair_jobs(tenant,generation_id,destination,source_scope,source_config_version,destination_config_version,source_set_version)
 SELECT r.tenant,r.generation_id,r.destination,r.source_scope,r.source_config_version,r.destination_config_version,d.source_set_version
 FROM inventory_matching_source_routes r JOIN comparison_domains d ON d.tenant=r.tenant
 WHERE r.generation_id=d.active_generation AND NOT EXISTS(
  SELECT 1 FROM inventory_scopes s JOIN inventory_sync_scopes p ON (p.tenant,p.destination)=(s.tenant,s.connection_id)
  WHERE (s.tenant,s.scope_id)=(r.tenant,r.destination) AND p.mode='forward'
 )
 ON CONFLICT(tenant,generation_id,destination,source_scope) DO UPDATE SET source_config_version=excluded.source_config_version,destination_config_version=excluded.destination_config_version,source_set_version=excluded.source_set_version,work_version=inventory_matching_pair_jobs.work_version+1,cursor_key='';
