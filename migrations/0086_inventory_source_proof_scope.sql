-- Accepted server stamps position the collector's bounded backfill reads.
CREATE INDEX inventory_source_presence_anchor ON inventory_record_facets(tenant,scope_id,entity_family,revision_order)
 WHERE facet='source' AND revision_order IS NOT NULL;
CREATE INDEX inventory_source_proof_reviews ON inventory_delivery_review(tenant,source_scope,record_key,destination)
 WHERE decision='source_proof_required';

CREATE VIEW inventory_source_proof_scope AS
 SELECT s.tenant,s.scope_id,s.connection_id,s.logical_identity,s.config_version,s.runtime_version,
        c.config AS connection_config,c.credential_version,t.stream_id,t.checkpoint_version,j.work_version,
        v.partition_id,v.epoch AS coverage_epoch,v.published_run_id AS policy_epoch,d.active_generation AS generation_id,a.quiet_minutes
 FROM inventory_scopes s
 JOIN inventory_runtime runtime ON runtime.id=1 AND runtime.mode='inventory_read_only' AND runtime.version=s.runtime_version
 JOIN accounts a ON a.id=s.tenant AND a.status='active'
 JOIN connections c ON c.tenant=s.tenant AND c.id=s.connection_id AND c.kind='lofi' AND c.status='active' AND c.remote_identity=s.logical_identity AND json_extract(c.config,'$.accountId')=s.logical_identity
 JOIN private_data credential ON credential.tenant=c.tenant AND credential.connection=c.id AND credential.id=c.credential_version AND credential.kind='credential' AND credential.revoked_at IS NULL AND (credential.expires_at IS NULL OR credential.expires_at>unixepoch('subsec')*1000)
 JOIN comparison_domains d ON d.tenant=s.tenant AND d.active_generation IS NOT NULL
 JOIN inventory_scheduled_selections p ON p.tenant=s.tenant AND p.scope_id=s.scope_id AND p.config_version=s.config_version AND p.runtime_version=s.runtime_version AND json_extract(p.plan,'$.provider')='lofi'
 JOIN inventory_streams t ON t.tenant=p.tenant AND t.scope_id=p.scope_id AND t.stream_id=p.stream_id
 JOIN inventory_stream_jobs j ON j.tenant=t.tenant AND j.scope_id=t.scope_id AND j.stream_id=t.stream_id AND j.state='idle'
 JOIN inventory_coverage v ON v.tenant=t.tenant AND v.scope_id=t.scope_id AND v.stream_id=t.stream_id AND v.facet='source' AND v.state='ready' AND v.kind='observed_selection' AND v.published_config_version=s.config_version
 JOIN inventory_runs r ON r.tenant=v.tenant AND r.run_id=v.published_run_id AND r.scope_id=s.scope_id AND r.stream_id=t.stream_id AND r.config_version=s.config_version AND r.mode='full' AND r.phase='complete' AND r.requires_catchup=1
 WHERE s.provider='lofi' AND s.state='observing'
 AND json_extract(t.committed_checkpoint,'$.mode')='forward'
 AND json_extract(t.committed_checkpoint,'$.readerPolicy')='all-clients-v1'
 AND json_extract(t.committed_checkpoint,'$.accountId')=s.logical_identity
 AND json_extract(t.committed_checkpoint,'$.policyEpoch')=r.run_id
 AND json_type(t.committed_checkpoint,'$.operations.watermark')='integer' AND json_extract(t.committed_checkpoint,'$.operations.watermark')>=0
 AND json_type(t.committed_checkpoint,'$.qsos.watermark')='integer' AND json_extract(t.committed_checkpoint,'$.qsos.watermark')>=0
 AND json_type(t.committed_checkpoint,'$.operations.cursor') IS NULL AND json_type(t.committed_checkpoint,'$.qsos.cursor') IS NULL;
