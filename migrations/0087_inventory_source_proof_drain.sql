CREATE INDEX inventory_run_observation_pages ON ingestion_run_pages(tenant,run_id,page_id) WHERE action='page';

-- An ordinary completed forward read can drain a source proof. Earlier pages,
-- a cursor restart, or a checkpoint from a different read policy cannot.
CREATE VIEW inventory_source_proof_drain AS
 SELECT s.tenant,s.scope_id,s.stream_id,s.config_version,s.runtime_version,s.credential_version,s.policy_epoch,s.coverage_epoch,
        json_remove(s.connection_config,'$.lastError','$.lastSuccessfulPollAt','$.accountEmail') AS connection_config,
        r.run_id,p.page_id,p.request_started_at,r.completed_at,s.checkpoint_version
 FROM inventory_source_proof_scope s
 JOIN inventory_coverage v ON v.tenant=s.tenant AND v.scope_id=s.scope_id AND v.stream_id=s.stream_id AND v.facet='source' AND v.partition_id=s.partition_id
 JOIN inventory_runs r ON r.tenant=s.tenant AND r.run_id=v.delta_run_id AND r.scope_id=s.scope_id AND r.stream_id=s.stream_id AND r.config_version=s.config_version
  AND r.facet='source' AND r.mode='delta' AND r.phase='complete' AND r.requires_catchup=0 AND r.expected_stream_version=s.checkpoint_version
 JOIN ingestion_run_pages b ON b.tenant=r.tenant AND b.run_id=r.run_id AND b.page_id='run:'||r.run_id||':begin' AND b.action='begin'
 JOIN ingestion_pages base ON base.tenant=b.tenant AND base.page_id=b.page_id AND base.state='committed'
 JOIN inventory_wakeups prior ON prior.tenant=s.tenant AND prior.scope_id=s.scope_id AND prior.stream_id=s.stream_id AND prior.work_version=b.expected_job_version
 JOIN inventory_runs previous ON previous.tenant=prior.tenant AND previous.run_id=prior.run_id AND previous.phase='complete' AND previous.expected_stream_version=r.initial_stream_version
  AND previous.scope_id=s.scope_id AND previous.stream_id=s.stream_id AND previous.config_version=s.config_version
 JOIN ingestion_run_pages x INDEXED BY inventory_run_observation_pages ON x.tenant=r.tenant AND x.run_id=r.run_id AND x.action='page' AND x.observed_complete=1
 JOIN ingestion_pages p ON p.tenant=x.tenant AND p.page_id=x.page_id AND p.state='committed' AND p.scope_id=s.scope_id AND p.stream_id=s.stream_id
  AND p.expected_config_version=s.config_version AND p.credential_version=s.credential_version
  AND json_remove(p.connection_config,'$.lastError','$.lastSuccessfulPollAt','$.accountEmail')=json_remove(s.connection_config,'$.lastError','$.lastSuccessfulPollAt','$.accountEmail')
 WHERE json_extract(r.fixed_query,'$.provider')='lofi'
 AND json_extract(base.next_resume,'$.mode')='forward' AND json_extract(base.next_resume,'$.accountId')=s.logical_identity
 AND json_extract(base.next_resume,'$.readerPolicy')='all-clients-v1' AND json_extract(base.next_resume,'$.policyEpoch')=s.policy_epoch
 AND json_type(base.next_resume,'$.operations.watermark')='integer' AND json_type(base.next_resume,'$.qsos.watermark')='integer'
 AND json_extract(base.next_resume,'$.operations.watermark')=json_extract(previous.proposed_checkpoint,'$.operations.watermark')
 AND json_extract(base.next_resume,'$.qsos.watermark')=json_extract(previous.proposed_checkpoint,'$.qsos.watermark')
 AND json_type(base.next_resume,'$.operations.cursor') IS NULL AND json_type(base.next_resume,'$.qsos.cursor') IS NULL
 AND json_type(base.next_resume,'$.operations.complete') IS NULL AND json_type(base.next_resume,'$.qsos.complete') IS NULL
 AND x.expected_phase='collecting' AND x.request_binding=r.collection_binding
 AND json_array_length(x.completed_streams)=2
 AND EXISTS(SELECT 1 FROM json_each(x.completed_streams) WHERE value='operations')
 AND EXISTS(SELECT 1 FROM json_each(x.completed_streams) WHERE value='qsos')
 AND x.proposed_checkpoint IS r.proposed_checkpoint AND json_extract(p.next_resume,'$.policyEpoch')=s.policy_epoch
 AND p.request_started_at>=r.started_at AND r.completed_at>=p.prepared_at
 AND NOT EXISTS(SELECT 1 FROM ingestion_run_pages other INDEXED BY inventory_run_observation_pages WHERE other.tenant=x.tenant AND other.run_id=x.run_id AND other.action='page' AND other.page_id!=x.page_id);
