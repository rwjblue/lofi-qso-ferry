-- Derived encrypted projections are availability, never renewed vendor evidence.
CREATE TABLE comparison_projection_payloads (
 tenant TEXT NOT NULL, scope_id TEXT NOT NULL, payload_id TEXT NOT NULL, connection_id TEXT NOT NULL,
 envelope TEXT NOT NULL, encrypted_bytes INTEGER NOT NULL CHECK(encrypted_bytes=length(envelope)), created_at INTEGER NOT NULL,
 PRIMARY KEY(tenant,scope_id,payload_id), FOREIGN KEY(tenant,scope_id) REFERENCES inventory_scopes(tenant,scope_id),
 FOREIGN KEY(tenant,connection_id) REFERENCES connections(tenant,id), CHECK(json_valid(envelope))
);
CREATE TRIGGER comparison_projection_payload_immutable BEFORE UPDATE ON comparison_projection_payloads BEGIN SELECT RAISE(ABORT,'immutable comparison projection payload'); END;
CREATE TABLE comparison_projections (
 tenant TEXT NOT NULL, generation_id TEXT NOT NULL, scope_id TEXT NOT NULL, record_key TEXT NOT NULL, facet TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0), semantic_version INTEGER NOT NULL CHECK(semantic_version>0), config_version INTEGER NOT NULL CHECK(config_version>0),
 parent_key TEXT, topology_version INTEGER NOT NULL CHECK(topology_version>=0), membership_version INTEGER NOT NULL CHECK(membership_version>=0),
 state TEXT NOT NULL CHECK(state IN ('ready','held','excluded')), reason TEXT, payload_id TEXT NOT NULL,
 coverage_stream TEXT, coverage_partition TEXT, coverage_version INTEGER, derived_at INTEGER NOT NULL, last_page_id TEXT NOT NULL,
 PRIMARY KEY(tenant,generation_id,scope_id,record_key,facet),
 FOREIGN KEY(tenant,generation_id,scope_id,record_key,facet) REFERENCES comparison_index(tenant,generation_id,scope_id,record_key,facet),
 FOREIGN KEY(tenant,scope_id,payload_id) REFERENCES comparison_projection_payloads(tenant,scope_id,payload_id),
 CHECK((state='ready' AND reason IS NULL) OR (state!='ready' AND reason IS NOT NULL AND length(reason) BETWEEN 1 AND 64 AND reason NOT GLOB '*[^a-z0-9_]*')),
 CHECK(state!='excluded' OR facet='source'),
 CHECK((coverage_stream IS NULL AND coverage_partition IS NULL AND coverage_version IS NULL) OR (coverage_stream IS NOT NULL AND coverage_partition IS NOT NULL AND coverage_version IS NOT NULL))
);
CREATE INDEX comparison_projection_parent ON comparison_index(tenant,generation_id,scope_id,parent_key,record_key,facet);
CREATE TRIGGER comparison_projection_version BEFORE UPDATE ON comparison_projections WHEN NEW.version<=OLD.version BEGIN SELECT RAISE(ABORT,'comparison projection version required'); END;
CREATE TABLE comparison_projection_pages (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL, generation_id TEXT NOT NULL, scope_id TEXT NOT NULL, connection_id TEXT NOT NULL, provider TEXT NOT NULL,
 domain_version INTEGER NOT NULL, config_version INTEGER NOT NULL, input_digest TEXT NOT NULL,
 lease_token TEXT NOT NULL, lease_fence INTEGER NOT NULL, prepared_at INTEGER NOT NULL,
 coverage TEXT NOT NULL CHECK(json_valid(coverage)), context_complete INTEGER NOT NULL CHECK(context_complete IN (0,1)),
 row_count INTEGER NOT NULL CHECK(row_count BETWEEN 1 AND 20), dependency_count INTEGER NOT NULL CHECK(dependency_count BETWEEN 1 AND 256),
 ready_count INTEGER NOT NULL, held_count INTEGER NOT NULL, excluded_count INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','committed')),
 PRIMARY KEY(tenant,page_id), FOREIGN KEY(tenant,generation_id,scope_id) REFERENCES comparison_builds(tenant,generation_id,scope_id),
 CHECK(ready_count>=0 AND held_count>=0 AND excluded_count>=0 AND ready_count+held_count+excluded_count=row_count)
);
CREATE TABLE comparison_projection_rows (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL, record_key TEXT NOT NULL, facet TEXT NOT NULL CHECK(facet IN ('source','receipt')),
 semantic_version INTEGER NOT NULL, raw_payload_id TEXT NOT NULL, parent_key TEXT,
 key_class TEXT NOT NULL, bucket_hash TEXT NOT NULL, projection_version INTEGER NOT NULL, topology_version INTEGER NOT NULL,
 membership_version INTEGER NOT NULL, work_version INTEGER NOT NULL, completed_version INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('ready','held','excluded')), reason TEXT, payload_id TEXT NOT NULL,
 PRIMARY KEY(tenant,page_id,record_key,facet), UNIQUE(tenant,page_id,payload_id),
 FOREIGN KEY(tenant,page_id) REFERENCES comparison_projection_pages(tenant,page_id)
);
CREATE TABLE comparison_projection_dependencies (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL, entity_family TEXT NOT NULL CHECK(entity_family IN ('operation','qso')), record_key TEXT NOT NULL,
 facet TEXT NOT NULL CHECK(facet IN ('source','receipt')), subtype TEXT, status TEXT, parent_key TEXT,
 semantic_version INTEGER, payload_id TEXT, connection_id TEXT, kind TEXT, payload_bytes INTEGER,
 membership_version INTEGER NOT NULL, member_state TEXT,
 PRIMARY KEY(tenant,page_id,entity_family,record_key,facet), FOREIGN KEY(tenant,page_id) REFERENCES comparison_projection_pages(tenant,page_id)
);
CREATE TABLE comparison_projection_guards (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL, PRIMARY KEY(tenant,page_id), FOREIGN KEY(tenant,page_id) REFERENCES comparison_projection_pages(tenant,page_id)
);
CREATE VIEW comparison_projection_stale_authority AS SELECT header.tenant,header.page_id FROM comparison_projection_pages header WHERE header.state='prepared' AND NOT EXISTS(
  SELECT 1 FROM comparison_projection_pages p JOIN comparison_domains d ON d.tenant=p.tenant AND d.version=p.domain_version
  JOIN index_generations g ON g.tenant=p.tenant AND g.generation_id=p.generation_id AND g.generation_id IN (d.active_generation,d.pending_generation) AND g.state IN ('active','building')
  JOIN inventory_scopes s ON s.tenant=p.tenant AND s.scope_id=p.scope_id AND s.config_version=p.config_version AND s.connection_id=p.connection_id AND s.provider=p.provider
  JOIN comparison_builds b ON b.tenant=s.tenant AND b.scope_id=s.scope_id AND b.generation_id=g.generation_id AND b.complete=1 AND b.config_version=s.config_version
  JOIN connections c ON c.tenant=s.tenant AND c.id=s.connection_id JOIN accounts a ON a.id=c.tenant AND a.status='active'
  JOIN leases l ON l.tenant=p.tenant AND l.scope='projection:'||p.generation_id||':'||p.scope_id AND l.token=p.lease_token AND l.fence=p.lease_fence
  WHERE p.tenant=header.tenant AND p.page_id=header.page_id AND p.state='prepared' AND l.expires_at>unixepoch('subsec')*1000 AND p.prepared_at>0 AND p.prepared_at<=unixepoch('subsec')*1000
   AND (p.ready_count+p.excluded_count=0 OR (s.state='observing' AND c.status='active' AND c.kind=s.provider AND c.remote_identity=s.logical_identity))
);
CREATE VIEW comparison_projection_stale_coverage AS
  SELECT p.tenant,p.page_id FROM comparison_projection_pages p WHERE p.provider='lofi' AND (
   (json_type(p.coverage)='null' AND EXISTS(SELECT 1 FROM inventory_coverage WHERE tenant=p.tenant AND scope_id=p.scope_id AND facet='source'))
   OR (json_type(p.coverage)!='null' AND NOT EXISTS(SELECT 1 FROM inventory_coverage c WHERE c.tenant=p.tenant AND c.scope_id=p.scope_id AND c.stream_id=json_extract(p.coverage,'$.stream_id') AND c.partition_id=json_extract(p.coverage,'$.partition_id') AND c.facet='source' AND c.version=json_extract(p.coverage,'$.version') AND c.epoch=json_extract(p.coverage,'$.epoch') AND c.state=json_extract(p.coverage,'$.state') AND c.kind=json_extract(p.coverage,'$.kind') AND c.published_config_version IS json_extract(p.coverage,'$.published_config_version')))
  );
CREATE VIEW comparison_projection_stale_dependencies AS
  SELECT q.tenant,q.page_id FROM comparison_projection_dependencies q JOIN comparison_projection_pages p ON p.tenant=q.tenant AND p.page_id=q.page_id
  LEFT JOIN inventory_records e ON e.tenant=p.tenant AND e.scope_id=p.scope_id AND e.entity_family=q.entity_family AND e.record_key=q.record_key
  LEFT JOIN inventory_record_facets f ON f.tenant=e.tenant AND f.scope_id=e.scope_id AND f.entity_family=e.entity_family AND f.record_key=e.record_key AND f.facet=q.facet
  LEFT JOIN inventory_payloads raw ON raw.tenant=f.tenant AND raw.scope_id=f.scope_id AND raw.payload_id=f.payload_id
  LEFT JOIN inventory_membership_versions mv ON mv.tenant=p.tenant AND mv.scope_id=p.scope_id AND mv.entity_family=q.entity_family AND mv.record_key=q.record_key AND mv.facet=q.facet
  LEFT JOIN inventory_partition_membership m ON m.tenant=p.tenant AND m.scope_id=p.scope_id AND m.stream_id=json_extract(p.coverage,'$.stream_id') AND m.partition_id=json_extract(p.coverage,'$.partition_id') AND m.entity_family=q.entity_family AND m.record_key=q.record_key AND m.facet=q.facet
  WHERE (q.subtype IS NOT e.subtype OR q.status IS NOT e.status OR q.parent_key IS NOT e.parent_key OR q.semantic_version IS NOT f.semantic_version OR q.payload_id IS NOT f.payload_id
   OR q.connection_id IS NOT raw.connection_id OR q.kind IS NOT raw.kind OR q.payload_bytes IS NOT length(raw.envelope) OR q.membership_version!=coalesce(mv.version,0) OR q.member_state IS NOT m.state
   OR (raw.payload_id IS NOT NULL AND (raw.connection_id!=p.connection_id OR raw.kind!=CASE q.facet WHEN 'source' THEN 'inventory_source' ELSE 'inventory_receipt' END)));
CREATE TRIGGER comparison_projection_guard BEFORE INSERT ON comparison_projection_guards BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM comparison_projection_stale_authority WHERE tenant=NEW.tenant AND page_id=NEW.page_id) THEN RAISE(ABORT,'comparison projection authority changed') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM comparison_projection_pages p WHERE p.tenant=NEW.tenant AND p.page_id=NEW.page_id AND (
   p.row_count!=(SELECT count(*) FROM comparison_projection_rows WHERE tenant=p.tenant AND page_id=p.page_id)
   OR p.dependency_count!=(SELECT count(*) FROM comparison_projection_dependencies WHERE tenant=p.tenant AND page_id=p.page_id)
   OR p.ready_count!=(SELECT count(*) FROM comparison_projection_rows WHERE tenant=p.tenant AND page_id=p.page_id AND state='ready')
   OR p.held_count!=(SELECT count(*) FROM comparison_projection_rows WHERE tenant=p.tenant AND page_id=p.page_id AND state='held')
   OR p.excluded_count!=(SELECT count(*) FROM comparison_projection_rows WHERE tenant=p.tenant AND page_id=p.page_id AND state='excluded')
   OR (p.row_count>1 AND EXISTS(SELECT 1 FROM comparison_projection_rows WHERE tenant=p.tenant AND page_id=p.page_id AND reason IN ('projection_byte_bound','projection_context_bound')))
  )
 ) THEN RAISE(ABORT,'comparison projection manifest incomplete') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM comparison_projection_stale_coverage WHERE tenant=NEW.tenant AND page_id=NEW.page_id) THEN RAISE(ABORT,'comparison projection coverage changed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM comparison_projection_stale_dependencies WHERE tenant=NEW.tenant AND page_id=NEW.page_id) THEN RAISE(ABORT,'comparison projection dependency changed') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM comparison_projection_rows q JOIN comparison_projection_pages p ON p.tenant=q.tenant AND p.page_id=q.page_id
  LEFT JOIN comparison_projection_dependencies dep ON dep.tenant=q.tenant AND dep.page_id=q.page_id AND dep.entity_family='qso' AND dep.record_key=q.record_key AND dep.facet=q.facet
  LEFT JOIN comparison_index i ON i.tenant=p.tenant AND i.generation_id=p.generation_id AND i.scope_id=p.scope_id AND i.record_key=q.record_key AND i.facet=q.facet
  LEFT JOIN comparison_projections old ON old.tenant=i.tenant AND old.generation_id=i.generation_id AND old.scope_id=i.scope_id AND old.record_key=i.record_key AND old.facet=i.facet
  LEFT JOIN comparison_work w ON w.tenant=i.tenant AND w.generation_id=i.generation_id AND w.scope_id=i.scope_id AND w.record_key=i.record_key AND w.facet=i.facet
  LEFT JOIN projection_domains pd ON pd.tenant=i.tenant AND pd.scope_id=i.scope_id AND pd.operation_key=i.parent_key
  WHERE q.tenant=NEW.tenant AND q.page_id=NEW.page_id AND (dep.record_key IS NULL OR dep.subtype IS NOT 'qso' OR dep.status IS NOT 'active' OR dep.semantic_version IS NOT q.semantic_version OR dep.payload_id IS NOT q.raw_payload_id OR dep.parent_key IS NOT q.parent_key OR dep.membership_version!=q.membership_version
   OR i.record_key IS NULL OR i.state='retired' OR i.semantic_version!=q.semantic_version OR i.config_version!=p.config_version OR i.parent_key IS NOT q.parent_key OR i.key_class!=q.key_class OR i.bucket_hash!=q.bucket_hash OR i.projection_version!=q.projection_version OR coalesce(old.version,0)!=q.projection_version
   OR w.work_version IS NOT q.work_version OR w.completed_version IS NOT q.completed_version OR coalesce(pd.topology_version,0)!=q.topology_version OR q.facet!=CASE p.provider WHEN 'lofi' THEN 'source' ELSE 'receipt' END
   OR (q.state='excluded' AND p.provider!='lofi'))
 ) THEN RAISE(ABORT,'comparison projection input changed') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM comparison_projection_rows q JOIN comparison_projection_pages p ON p.tenant=q.tenant AND p.page_id=q.page_id
  WHERE q.tenant=NEW.tenant AND q.page_id=NEW.page_id AND q.facet='source' AND q.state!='held' AND (
   (json_extract(p.coverage,'$.state')='ready' AND json_extract(p.coverage,'$.full_context')=1 AND NOT EXISTS(SELECT 1 FROM comparison_projection_dependencies dep WHERE dep.tenant=q.tenant AND dep.page_id=q.page_id AND dep.entity_family='qso' AND dep.record_key=q.record_key AND dep.facet=q.facet AND dep.member_state='present'))
   OR (q.parent_key IS NOT NULL AND (p.context_complete!=1 OR NOT EXISTS(
    SELECT 1 FROM inventory_coverage c JOIN inventory_runs r ON r.tenant=c.tenant AND r.run_id=c.published_run_id
    WHERE c.tenant=p.tenant AND c.scope_id=p.scope_id AND c.stream_id=json_extract(p.coverage,'$.stream_id') AND c.partition_id=json_extract(p.coverage,'$.partition_id') AND c.facet='source' AND c.state='ready' AND c.kind='observed_selection' AND c.published_config_version=p.config_version AND r.mode='full' AND r.requires_catchup=1 AND r.phase='complete' AND r.config_version=p.config_version AND json_array_length(r.required_streams)=2 AND EXISTS(SELECT 1 FROM json_each(r.required_streams) WHERE value='operations') AND EXISTS(SELECT 1 FROM json_each(r.required_streams) WHERE value='qsos')
   ) OR NOT EXISTS(SELECT 1 FROM comparison_projection_dependencies dep WHERE dep.tenant=q.tenant AND dep.page_id=q.page_id AND dep.entity_family='operation' AND dep.record_key=q.parent_key AND dep.facet='source' AND dep.status='active' AND dep.payload_id IS NOT NULL AND dep.member_state='present')
   OR EXISTS(SELECT 1 FROM comparison_projection_dependencies dep WHERE dep.tenant=q.tenant AND dep.page_id=q.page_id AND dep.entity_family='qso' AND dep.subtype='event' AND dep.parent_key=q.parent_key AND (dep.member_state IS NOT 'present' OR dep.payload_id IS NULL OR dep.semantic_version IS NULL))))
  )
 ) THEN RAISE(ABORT,'comparison projection source context incomplete') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM (SELECT DISTINCT q.parent_key,p.scope_id FROM comparison_projection_rows q JOIN comparison_projection_pages p ON p.tenant=q.tenant AND p.page_id=q.page_id WHERE q.tenant=NEW.tenant AND q.page_id=NEW.page_id AND q.facet='source' AND q.state!='held' AND q.parent_key IS NOT NULL) parents
  CROSS JOIN inventory_records e WHERE e.tenant=NEW.tenant AND e.scope_id=parents.scope_id AND e.entity_family='qso' AND e.subtype='event' AND e.parent_key=parents.parent_key AND NOT EXISTS(SELECT 1 FROM comparison_projection_dependencies dep WHERE dep.tenant=NEW.tenant AND dep.page_id=NEW.page_id AND dep.entity_family=e.entity_family AND dep.record_key=e.record_key AND dep.facet='source')
 ) THEN RAISE(ABORT,'comparison projection event closure incomplete') END;
END;
CREATE TRIGGER comparison_projection_commit BEFORE UPDATE ON comparison_projection_pages WHEN NEW.state='committed' BEGIN
 SELECT CASE WHEN OLD.state!='prepared' OR NOT EXISTS(SELECT 1 FROM comparison_projection_guards WHERE tenant=OLD.tenant AND page_id=OLD.page_id)
  OR NOT EXISTS(SELECT 1 FROM leases WHERE tenant=OLD.tenant AND scope='projection:'||OLD.generation_id||':'||OLD.scope_id AND token=OLD.lease_token AND fence=OLD.lease_fence AND expires_at>unixepoch('subsec')*1000)
  OR EXISTS(SELECT 1 FROM comparison_projection_stale_authority WHERE tenant=OLD.tenant AND page_id=OLD.page_id)
  OR EXISTS(SELECT 1 FROM comparison_projection_stale_coverage WHERE tenant=OLD.tenant AND page_id=OLD.page_id)
  OR EXISTS(SELECT 1 FROM comparison_projection_stale_dependencies WHERE tenant=OLD.tenant AND page_id=OLD.page_id)
  THEN RAISE(ABORT,'comparison projection publication guard missing') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM comparison_projection_rows q LEFT JOIN comparison_projections p ON p.tenant=q.tenant AND p.generation_id=OLD.generation_id AND p.scope_id=OLD.scope_id AND p.record_key=q.record_key AND p.facet=q.facet
  LEFT JOIN comparison_index i ON i.tenant=p.tenant AND i.generation_id=p.generation_id AND i.scope_id=p.scope_id AND i.record_key=p.record_key AND i.facet=p.facet
  LEFT JOIN comparison_work w ON w.tenant=i.tenant AND w.generation_id=i.generation_id AND w.scope_id=i.scope_id AND w.record_key=i.record_key AND w.facet=i.facet
  LEFT JOIN comparison_projection_payloads raw ON raw.tenant=p.tenant AND raw.scope_id=p.scope_id AND raw.payload_id=p.payload_id
  LEFT JOIN projection_domains pd ON pd.tenant=p.tenant AND pd.scope_id=p.scope_id AND pd.operation_key=p.parent_key
  LEFT JOIN inventory_membership_versions mv ON mv.tenant=p.tenant AND mv.scope_id=p.scope_id AND mv.entity_family='qso' AND mv.record_key=p.record_key AND mv.facet=p.facet
  WHERE q.tenant=OLD.tenant AND q.page_id=OLD.page_id AND (p.record_key IS NULL OR p.version!=q.projection_version+1 OR p.semantic_version!=q.semantic_version OR p.config_version!=OLD.config_version OR p.topology_version!=q.topology_version OR p.membership_version!=q.membership_version OR p.parent_key IS NOT q.parent_key OR p.state!=q.state OR p.reason IS NOT q.reason OR p.payload_id!=q.payload_id OR p.last_page_id!=OLD.page_id OR p.derived_at!=OLD.prepared_at
   OR i.semantic_version!=p.semantic_version OR i.config_version!=p.config_version OR i.parent_key IS NOT p.parent_key OR i.projection_version!=p.version OR i.topology_version!=p.topology_version OR i.state!=CASE p.state WHEN 'held' THEN 'held' ELSE 'ready' END OR i.key_class!=q.key_class OR i.bucket_hash!=q.bucket_hash
   OR coalesce(pd.topology_version,0)!=p.topology_version OR coalesce(mv.version,0)!=p.membership_version OR w.work_version!=q.work_version OR w.completed_version!=q.work_version OR raw.payload_id IS NULL OR raw.connection_id!=OLD.connection_id)
 ) THEN RAISE(ABORT,'comparison projection publication incomplete') END;
END;
CREATE TRIGGER comparison_projection_page_immutable BEFORE UPDATE ON comparison_projection_pages WHEN OLD.state='committed' BEGIN SELECT RAISE(ABORT,'comparison projection receipt immutable'); END;
-- Do not tie valid ready projections to every unchanged poll's control version.
CREATE VIEW comparison_projections_current AS
 SELECT p.*,raw.connection_id,raw.envelope,raw.encrypted_bytes FROM comparison_projections p
 JOIN comparison_index i ON i.tenant=p.tenant AND i.generation_id=p.generation_id AND i.scope_id=p.scope_id AND i.record_key=p.record_key AND i.facet=p.facet
 JOIN inventory_records e ON e.tenant=p.tenant AND e.scope_id=p.scope_id AND e.entity_family='qso' AND e.record_key=p.record_key
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
