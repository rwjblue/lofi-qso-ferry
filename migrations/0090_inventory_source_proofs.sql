-- A proof survives its work row. Its captured source data is metadata only.
CREATE TABLE inventory_source_proofs (
 tenant TEXT NOT NULL,proof_id TEXT NOT NULL,scope_id TEXT NOT NULL,
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot) AND length(snapshot)<=262144),
 witnesses TEXT NOT NULL CHECK(json_valid(witnesses) AND json_type(witnesses)='array' AND json_array_length(witnesses) BETWEEN 1 AND 64),
 drain_run TEXT NOT NULL,drain_page TEXT NOT NULL,
 collection_finished_at INTEGER NOT NULL,drain_started_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 lease_token TEXT NOT NULL,lease_fence INTEGER NOT NULL,
 PRIMARY KEY(tenant,proof_id),
 FOREIGN KEY(tenant,scope_id) REFERENCES inventory_scopes(tenant,scope_id),
 FOREIGN KEY(tenant,drain_run) REFERENCES inventory_runs(tenant,run_id),
 FOREIGN KEY(tenant,drain_page) REFERENCES ingestion_pages(tenant,page_id),
 CHECK(collection_finished_at<=drain_started_at AND drain_started_at<=created_at AND created_at<expires_at)
);
CREATE INDEX inventory_source_proofs_expiry ON inventory_source_proofs(expires_at,tenant,proof_id);

CREATE VIEW inventory_source_proof_manifests AS
 SELECT tenant,job_id AS proof_id,scope_id,snapshot FROM inventory_source_proof_jobs WHERE phase='draining'
 UNION ALL SELECT tenant,proof_id,scope_id,snapshot FROM inventory_source_proofs;
CREATE VIEW inventory_source_proof_stale AS
 SELECT m.tenant,m.proof_id FROM inventory_source_proof_manifests m
 WHERE NOT EXISTS(
  SELECT 1 FROM inventory_source_proof_scope s WHERE s.tenant=m.tenant AND s.scope_id=m.scope_id
  AND (s.stream_id,s.config_version,s.runtime_version,s.credential_version,s.coverage_epoch,s.policy_epoch,s.generation_id,s.quiet_minutes)=
      (json_extract(m.snapshot,'$.source.stream_id'),json_extract(m.snapshot,'$.source.config_version'),json_extract(m.snapshot,'$.source.runtime_version'),
       json_extract(m.snapshot,'$.source.credential_version'),json_extract(m.snapshot,'$.source.coverage_epoch'),json_extract(m.snapshot,'$.source.policy_epoch'),
       json_extract(m.snapshot,'$.source.generation_id'),json_extract(m.snapshot,'$.source.quiet_minutes'))
  AND json_remove(s.connection_config,'$.lastError','$.lastSuccessfulPollAt','$.accountEmail')=
      json_remove(json_extract(m.snapshot,'$.source.connection_config'),'$.lastError','$.lastSuccessfulPollAt','$.accountEmail')
 )
 UNION ALL
 SELECT m.tenant,m.proof_id FROM inventory_source_proof_manifests m
 CROSS JOIN json_each(m.snapshot,'$.dependencies') q
 LEFT JOIN inventory_records e INDEXED BY sqlite_autoindex_inventory_records_1 ON e.tenant=m.tenant AND e.scope_id=m.scope_id
  AND e.entity_family=json_extract(q.value,'$.target.kind') AND e.record_key=json_extract(q.value,'$.target.id')
 LEFT JOIN inventory_record_facets f ON f.tenant=e.tenant AND f.scope_id=e.scope_id AND f.entity_family=e.entity_family AND f.record_key=e.record_key AND f.facet='source'
 LEFT JOIN inventory_membership_versions mv ON mv.tenant=e.tenant AND mv.scope_id=e.scope_id AND mv.entity_family=e.entity_family AND mv.record_key=e.record_key AND mv.facet='source'
 LEFT JOIN inventory_partition_membership pm ON pm.tenant=e.tenant AND pm.scope_id=e.scope_id AND pm.entity_family=e.entity_family AND pm.record_key=e.record_key AND pm.facet='source'
  AND pm.stream_id=json_extract(m.snapshot,'$.source.stream_id') AND pm.partition_id=json_extract(m.snapshot,'$.source.partition_id')
 WHERE e.status IS NOT 'active' OR pm.state IS NOT 'present'
 OR e.subtype IS NOT CASE WHEN json_extract(q.value,'$.target.kind')='operation' THEN 'operation' WHEN json_extract(q.value,'$.target.isEvent')=1 THEN 'event' ELSE 'qso' END
 OR (CASE WHEN e.entity_family='operation' THEN e.record_key ELSE e.parent_key END) IS NOT json_extract(q.value,'$.target.operationId')
 OR f.revision IS NOT json_extract(q.value,'$.target.revision') OR f.revision_order IS NOT json_extract(q.value,'$.target.syncedAtMillis')
 OR f.payload_id IS NOT json_extract(q.value,'$.payload') OR f.semantic_version IS NOT json_extract(q.value,'$.semanticVersion')
 OR coalesce(mv.version,0) IS NOT json_extract(q.value,'$.membershipVersion')
 UNION ALL
 SELECT m.tenant,m.proof_id FROM inventory_source_proof_manifests m
 CROSS JOIN json_each(m.snapshot,'$.contacts') q
 LEFT JOIN comparison_projections p ON p.tenant=m.tenant AND p.scope_id=m.scope_id AND p.generation_id=json_extract(m.snapshot,'$.source.generation_id')
  AND p.record_key=json_extract(q.value,'$.key') AND p.facet='source'
 LEFT JOIN projection_domains pd ON pd.tenant=m.tenant AND pd.scope_id=m.scope_id AND pd.operation_key=json_extract(q.value,'$.operation')
 WHERE p.state IS NOT 'ready' OR p.version IS NOT json_extract(q.value,'$.projectionVersion') OR p.payload_id IS NOT json_extract(q.value,'$.projectionPayload')
 OR p.parent_key IS NOT json_extract(q.value,'$.operation') OR coalesce(pd.topology_version,0) IS NOT json_extract(q.value,'$.topologyVersion')
 OR NOT EXISTS(SELECT 1 FROM json_each(m.snapshot,'$.dependencies') dep WHERE json_extract(dep.value,'$.target.kind')='qso' AND json_extract(dep.value,'$.target.id')=json_extract(q.value,'$.key') AND json_extract(dep.value,'$.target.isEvent')=0)
 OR (json_extract(q.value,'$.operation') IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM json_each(m.snapshot,'$.dependencies') dep WHERE json_extract(dep.value,'$.target.kind')='operation' AND json_extract(dep.value,'$.target.id')=json_extract(q.value,'$.operation')
 ))
 OR EXISTS(SELECT 1 FROM inventory_records e INDEXED BY inventory_parent
  WHERE e.tenant=m.tenant AND e.scope_id=m.scope_id AND e.parent_key=json_extract(q.value,'$.operation') AND e.entity_family='qso' AND e.subtype='event' AND e.status='active'
  AND NOT EXISTS(SELECT 1 FROM json_each(m.snapshot,'$.dependencies') dep WHERE json_extract(dep.value,'$.target.kind')='qso' AND json_extract(dep.value,'$.target.id')=e.record_key AND json_extract(dep.value,'$.target.isEvent')=1));

CREATE VIEW inventory_source_proof_current AS
 SELECT p.* FROM inventory_source_proofs p WHERE p.expires_at>unixepoch('subsec')*1000
 AND NOT EXISTS(SELECT 1 FROM inventory_source_proof_stale x WHERE x.tenant=p.tenant AND x.proof_id=p.proof_id);

CREATE TRIGGER inventory_source_proof_insert BEFORE INSERT ON inventory_source_proofs BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM inventory_source_proof_jobs j
  JOIN leases l ON l.tenant=j.tenant AND l.scope='inventory:'||j.scope_id AND l.token=NEW.lease_token AND l.fence=NEW.lease_fence
  JOIN inventory_source_proof_drain d ON d.tenant=j.tenant AND d.scope_id=j.scope_id AND d.run_id=j.drain_run
  WHERE (j.tenant,j.scope_id,j.job_id)=(NEW.tenant,NEW.scope_id,NEW.proof_id) AND j.phase='draining'
  AND (NEW.snapshot,NEW.witnesses,NEW.drain_run,NEW.collection_finished_at,NEW.expires_at)=(j.snapshot,j.witnesses,j.drain_run,j.collection_finished_at,j.expires_at)
  AND (NEW.drain_page,NEW.drain_started_at)=(d.page_id,d.request_started_at)
  AND d.checkpoint_version>json_extract(j.snapshot,'$.source.checkpoint_version')
  AND d.completed_at<=NEW.created_at AND NEW.created_at<=unixepoch('subsec')*1000
  AND l.expires_at>unixepoch('subsec')*1000 AND NEW.expires_at>unixepoch('subsec')*1000
 ) OR EXISTS(SELECT 1 FROM inventory_source_proof_stale x WHERE x.tenant=NEW.tenant AND x.proof_id=NEW.proof_id)
 THEN RAISE(ABORT,'inventory source proof inputs changed') END;
 SELECT CASE WHEN json_type(NEW.snapshot,'$.contacts') IS NOT 'array' OR json_array_length(NEW.snapshot,'$.contacts') NOT BETWEEN 1 AND 20
 OR json_type(NEW.snapshot,'$.dependencies') IS NOT 'array' OR json_array_length(NEW.snapshot,'$.dependencies')!=json_array_length(NEW.witnesses)
 OR EXISTS(SELECT 1 FROM json_each(NEW.witnesses) w WHERE json_type(w.value,'$.requestStartedAt') IS NOT 'integer'
  OR json_extract(w.value,'$.requestStartedAt')>NEW.collection_finished_at
  OR json_extract(w.value,'$.scope') IS NOT json_extract(NEW.snapshot,'$.presence'))
 OR NEW.expires_at IS NOT (SELECT min(json_extract(w.value,'$.requestStartedAt'))+300000 FROM json_each(NEW.witnesses) w)
 OR EXISTS(SELECT 1 FROM json_each(NEW.snapshot,'$.dependencies') dep WHERE 1!=(
  SELECT count(*) FROM json_each(NEW.witnesses) w WHERE json_extract(w.value,'$.target')=json_extract(dep.value,'$.target')
 ))
 OR EXISTS(SELECT 1 FROM json_each(NEW.snapshot,'$.contacts') q WHERE json_extract(q.value,'$.eligibleAfter')>NEW.collection_finished_at)
 THEN RAISE(ABORT,'inventory source proof witnesses incomplete') END;
END;
CREATE TRIGGER inventory_source_proof_commit AFTER INSERT ON inventory_source_proofs BEGIN
 UPDATE inventory_source_proof_jobs SET phase='complete',version=version+1,due_at=NEW.created_at
 WHERE tenant=NEW.tenant AND scope_id=NEW.scope_id AND job_id=NEW.proof_id;
END;
CREATE TRIGGER inventory_source_proof_immutable BEFORE UPDATE ON inventory_source_proofs BEGIN SELECT RAISE(ABORT,'immutable inventory source proof'); END;

-- A proof-owned forward run uses the same admission and outbox as any other
-- run. Expired or exhausted work retires before further inventory requests.
CREATE TRIGGER inventory_source_proof_drain_debit AFTER UPDATE OF phase ON inventory_request_guards WHEN NEW.phase='reserved' BEGIN
 UPDATE inventory_source_proof_jobs SET phase='held',version=version+1,
  reason=CASE WHEN expires_at<=NEW.now THEN 'witness_expired' ELSE 'request_budget' END
 WHERE tenant=NEW.tenant AND scope_id=NEW.scope_id AND phase='draining'
 AND drain_run=(SELECT active_run_id FROM inventory_stream_jobs WHERE tenant=NEW.tenant AND scope_id=NEW.scope_id AND stream_id=NEW.stream_id)
 AND (attempts>=4 OR expires_at<=NEW.now);
 UPDATE inventory_source_proof_jobs SET attempts=attempts+1
 WHERE tenant=NEW.tenant AND scope_id=NEW.scope_id AND phase='draining'
 AND drain_run=(SELECT active_run_id FROM inventory_stream_jobs WHERE tenant=NEW.tenant AND scope_id=NEW.scope_id AND stream_id=NEW.stream_id);
END;
