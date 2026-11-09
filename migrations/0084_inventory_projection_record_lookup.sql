-- Resolve a projection's exact QSO before checking the operation parent.
-- The parent index can scan an entire operation for each proof record.
DROP VIEW comparison_projections_current;
CREATE VIEW comparison_projections_current AS
 SELECT p.*,raw.connection_id,raw.envelope,raw.encrypted_bytes FROM comparison_projections p
 JOIN comparison_index i ON i.tenant=p.tenant AND i.generation_id=p.generation_id AND i.scope_id=p.scope_id AND i.record_key=p.record_key AND i.facet=p.facet
 JOIN inventory_records e INDEXED BY sqlite_autoindex_inventory_records_1 ON e.tenant=p.tenant AND e.scope_id=p.scope_id AND e.entity_family='qso' AND e.record_key=p.record_key
 JOIN inventory_record_facets f ON f.tenant=e.tenant AND f.scope_id=e.scope_id AND f.entity_family=e.entity_family AND f.record_key=e.record_key AND f.facet=p.facet
 JOIN inventory_scopes s ON s.tenant=p.tenant AND s.scope_id=p.scope_id JOIN connections c ON c.tenant=s.tenant AND c.id=s.connection_id JOIN accounts a ON a.id=s.tenant
 JOIN comparison_domains d ON d.tenant=p.tenant AND p.generation_id IN (d.active_generation,d.pending_generation)
 JOIN index_generations g ON g.tenant=p.tenant AND g.generation_id=p.generation_id AND g.state IN ('active','building')
 JOIN comparison_builds b ON b.tenant=p.tenant AND b.generation_id=p.generation_id AND b.scope_id=p.scope_id AND b.complete=1 AND b.config_version=s.config_version
 JOIN comparison_projection_payloads raw ON raw.tenant=p.tenant AND raw.scope_id=p.scope_id AND raw.payload_id=p.payload_id AND raw.connection_id=s.connection_id
 LEFT JOIN projection_domains pd ON pd.tenant=p.tenant AND pd.scope_id=p.scope_id AND pd.operation_key=p.parent_key
 LEFT JOIN inventory_membership_versions mv ON mv.tenant=p.tenant AND mv.scope_id=p.scope_id AND mv.entity_family='qso' AND mv.record_key=p.record_key AND mv.facet=p.facet
 WHERE a.status='active' AND s.state='observing' AND c.status='active' AND c.kind=s.provider AND c.remote_identity=s.logical_identity
  AND e.status='active' AND e.subtype='qso' AND e.parent_key IS p.parent_key AND i.parent_key IS p.parent_key
  AND i.projection_version=p.version AND i.semantic_version=p.semantic_version AND f.semantic_version=p.semantic_version AND i.config_version=p.config_version AND s.config_version=p.config_version
  AND i.state=CASE p.state WHEN 'held' THEN 'held' ELSE 'ready' END AND i.topology_version=p.topology_version AND coalesce(pd.topology_version,0)=p.topology_version AND coalesce(mv.version,0)=p.membership_version
  AND (p.facet!='source' OR p.parent_key IS NULL OR p.state='held' OR EXISTS(SELECT 1 FROM inventory_coverage cv JOIN inventory_runs r ON r.tenant=cv.tenant AND r.run_id=cv.published_run_id WHERE cv.tenant=p.tenant AND cv.scope_id=p.scope_id AND cv.stream_id=p.coverage_stream AND cv.partition_id=p.coverage_partition AND cv.facet='source' AND cv.state='ready' AND cv.kind='observed_selection' AND cv.published_config_version=p.config_version AND r.mode='full' AND r.requires_catchup=1 AND r.phase='complete' AND r.config_version=p.config_version));
