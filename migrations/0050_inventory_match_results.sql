-- Shared immutable dependency sets keep result publication/cohort validation
-- set based. These are comparison observations, never delivery/adoption proof.
CREATE TABLE inventory_match_sets (
 tenant TEXT NOT NULL, set_id TEXT NOT NULL, destination TEXT NOT NULL, generation_id TEXT NOT NULL,
 domain_version INTEGER NOT NULL, source_set_version INTEGER NOT NULL, policy_version INTEGER NOT NULL CHECK(policy_version=2), result_version INTEGER NOT NULL CHECK(result_version=1),
 input_digest TEXT NOT NULL, lease_token TEXT NOT NULL, lease_fence INTEGER NOT NULL, prepared_at INTEGER NOT NULL,
 scope_count INTEGER NOT NULL CHECK(scope_count BETWEEN 1 AND 21), coverage_count INTEGER NOT NULL CHECK(coverage_count BETWEEN 0 AND 256), record_count INTEGER NOT NULL CHECK(record_count BETWEEN 1 AND 128),
 probe_count INTEGER NOT NULL CHECK(probe_count BETWEEN 0 AND 148), token_count INTEGER NOT NULL CHECK(token_count=probe_count*8), candidate_count INTEGER NOT NULL CHECK(candidate_count BETWEEN 0 AND 16384), row_count INTEGER NOT NULL CHECK(row_count BETWEEN 1 AND 20),
 state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN('prepared','committed')), PRIMARY KEY(tenant,set_id),
 FOREIGN KEY(tenant,destination) REFERENCES inventory_scopes(tenant,scope_id), FOREIGN KEY(tenant,generation_id) REFERENCES index_generations(tenant,generation_id)
);
CREATE TABLE inventory_match_scopes (
 tenant TEXT NOT NULL, set_id TEXT NOT NULL, connection_id TEXT NOT NULL, scope_id TEXT NOT NULL,
 kind TEXT NOT NULL, connection_state TEXT NOT NULL, logical_identity TEXT NOT NULL,
 provider TEXT, scope_identity TEXT, config_version INTEGER, scope_state TEXT, build_config_version INTEGER, build_complete INTEGER,
 unresolved INTEGER NOT NULL CHECK(unresolved IN(0,1)), source INTEGER NOT NULL CHECK(source IN(0,1)),
 PRIMARY KEY(tenant,set_id,connection_id,scope_id), FOREIGN KEY(tenant,set_id) REFERENCES inventory_match_sets(tenant,set_id)
);
CREATE TABLE inventory_match_coverage (
 tenant TEXT NOT NULL, set_id TEXT NOT NULL, scope_id TEXT NOT NULL, stream_id TEXT NOT NULL, facet TEXT NOT NULL, partition_id TEXT NOT NULL,
 version INTEGER NOT NULL, epoch INTEGER NOT NULL, state TEXT NOT NULL, kind TEXT NOT NULL, config_version INTEGER, run_id TEXT,
 PRIMARY KEY(tenant,set_id,scope_id,stream_id,facet,partition_id), FOREIGN KEY(tenant,set_id) REFERENCES inventory_match_sets(tenant,set_id)
);
CREATE TABLE inventory_match_records (
 tenant TEXT NOT NULL, set_id TEXT NOT NULL, scope_id TEXT NOT NULL, record_key TEXT NOT NULL, facet TEXT NOT NULL CHECK(facet IN('source','receipt')),
 exists_flag INTEGER NOT NULL CHECK(exists_flag IN(0,1)), key_class TEXT, bucket_hash TEXT, state TEXT,
 semantic_version INTEGER, current_semantic_version INTEGER, config_version INTEGER, parent_key TEXT,
 topology_version INTEGER, current_topology_version INTEGER, projection_version INTEGER, membership_version INTEGER,
 current_projection_version INTEGER, projection_state TEXT, projection_reason TEXT, payload_id TEXT,
 PRIMARY KEY(tenant,set_id,scope_id,record_key,facet), FOREIGN KEY(tenant,set_id) REFERENCES inventory_match_sets(tenant,set_id),
 FOREIGN KEY(tenant,scope_id,payload_id) REFERENCES comparison_projection_payloads(tenant,scope_id,payload_id)
);
CREATE TABLE inventory_match_probes (
 tenant TEXT NOT NULL, set_id TEXT NOT NULL, probe_id INTEGER NOT NULL, direction TEXT NOT NULL CHECK(direction IN('forward','reverse')),
 subject_scope TEXT NOT NULL, subject_key TEXT NOT NULL, subject_facet TEXT NOT NULL, search_scope TEXT NOT NULL,
 config_version INTEGER, index_ready INTEGER NOT NULL CHECK(index_ready IN(0,1)), complete INTEGER NOT NULL CHECK(complete IN(0,1)),
 PRIMARY KEY(tenant,set_id,probe_id), UNIQUE(tenant,set_id,direction,subject_scope,subject_key,search_scope),
 FOREIGN KEY(tenant,set_id,subject_scope,subject_key,subject_facet) REFERENCES inventory_match_records(tenant,set_id,scope_id,record_key,facet)
);
CREATE TABLE inventory_match_tokens (
 tenant TEXT NOT NULL, set_id TEXT NOT NULL, probe_id INTEGER NOT NULL, key_class TEXT NOT NULL CHECK(key_class IN('call_and_time','call_only','time_only','unknown')),
 bucket_hash TEXT NOT NULL CHECK(length(bucket_hash)=43), version INTEGER NOT NULL CHECK(version>=0),
 PRIMARY KEY(tenant,set_id,probe_id,key_class,bucket_hash), FOREIGN KEY(tenant,set_id,probe_id) REFERENCES inventory_match_probes(tenant,set_id,probe_id)
);
CREATE TABLE inventory_match_candidates (
 tenant TEXT NOT NULL, set_id TEXT NOT NULL, probe_id INTEGER NOT NULL, scope_id TEXT NOT NULL, record_key TEXT NOT NULL, facet TEXT NOT NULL,
 PRIMARY KEY(tenant,set_id,probe_id,scope_id,record_key,facet), FOREIGN KEY(tenant,set_id,probe_id) REFERENCES inventory_match_probes(tenant,set_id,probe_id),
 FOREIGN KEY(tenant,set_id,scope_id,record_key,facet) REFERENCES inventory_match_records(tenant,set_id,scope_id,record_key,facet)
);
CREATE TABLE inventory_match_rows (
 tenant TEXT NOT NULL, set_id TEXT NOT NULL, source_scope TEXT NOT NULL, record_key TEXT NOT NULL, expected_version INTEGER NOT NULL CHECK(expected_version>=0),
 state TEXT NOT NULL CHECK(state IN('matched_existing','absent_at_inventory','ambiguous','projection_mismatch','incomplete','excluded')),
 reason TEXT, remote_key TEXT, required_coverage TEXT NOT NULL CHECK(json_valid(required_coverage) AND json_type(required_coverage)='array'), PRIMARY KEY(tenant,set_id,source_scope,record_key), FOREIGN KEY(tenant,set_id) REFERENCES inventory_match_sets(tenant,set_id),
 CHECK((state IN('matched_existing','absent_at_inventory','excluded') AND reason IS NULL) OR (state IN('ambiguous','projection_mismatch','incomplete') AND reason IS NOT NULL AND length(reason) BETWEEN 1 AND 64 AND reason NOT GLOB '*[^a-z0-9_]*')),
 CHECK(state NOT IN('matched_existing','projection_mismatch') OR remote_key IS NOT NULL), CHECK(state!='absent_at_inventory' OR remote_key IS NULL)
);
CREATE TABLE inventory_match_guards (
 tenant TEXT NOT NULL, set_id TEXT NOT NULL, PRIMARY KEY(tenant,set_id), FOREIGN KEY(tenant,set_id) REFERENCES inventory_match_sets(tenant,set_id)
);
CREATE TABLE match_results (
 tenant TEXT NOT NULL, destination TEXT NOT NULL, source_scope TEXT NOT NULL, record_key TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0), set_id TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, remote_key TEXT, derived_at INTEGER NOT NULL,
 next_eligible_at INTEGER NOT NULL, PRIMARY KEY(tenant,destination,source_scope,record_key),
 FOREIGN KEY(tenant,set_id,source_scope,record_key) REFERENCES inventory_match_rows(tenant,set_id,source_scope,record_key),
 FOREIGN KEY(tenant,destination) REFERENCES inventory_scopes(tenant,scope_id), FOREIGN KEY(tenant,source_scope) REFERENCES inventory_scopes(tenant,scope_id)
);
CREATE INDEX match_result_due ON match_results(tenant,destination,state,next_eligible_at,source_scope,record_key);
CREATE INDEX match_result_set ON match_results(tenant,set_id);

CREATE VIEW inventory_match_stale_scopes AS
 SELECT q.tenant,q.set_id FROM inventory_match_scopes q JOIN inventory_match_sets h ON h.tenant=q.tenant AND h.set_id=q.set_id
 LEFT JOIN connections c ON c.tenant=q.tenant AND c.id=q.connection_id
 LEFT JOIN inventory_scopes s ON s.tenant=q.tenant AND s.scope_id=q.scope_id AND s.connection_id=q.connection_id
 LEFT JOIN comparison_builds b ON b.tenant=s.tenant AND b.scope_id=s.scope_id AND b.generation_id=h.generation_id
 WHERE c.id IS NULL OR c.kind!=q.kind OR c.status!=q.connection_state OR c.remote_identity!=q.logical_identity
 OR (q.scope_id!='' AND s.scope_id IS NULL) OR s.provider IS NOT q.provider OR s.logical_identity IS NOT q.scope_identity OR s.config_version IS NOT q.config_version OR s.state IS NOT q.scope_state OR b.config_version IS NOT q.build_config_version OR b.complete IS NOT q.build_complete
 OR q.source IS NOT (c.kind='lofi' OR s.provider='lofi')
 OR q.unresolved!=EXISTS(SELECT 1 FROM inventory_partition_membership m INDEXED BY inventory_unresolved_members WHERE m.tenant=q.tenant AND m.scope_id=q.scope_id AND m.facet=CASE q.provider WHEN 'lofi' THEN 'source' ELSE 'receipt' END AND m.state='unresolved');
CREATE VIEW inventory_match_stale_coverage AS
 SELECT q.tenant,q.set_id FROM inventory_match_coverage q
 LEFT JOIN inventory_coverage c ON c.tenant=q.tenant AND c.scope_id=q.scope_id AND c.stream_id=q.stream_id AND c.facet=q.facet AND c.partition_id=q.partition_id
 LEFT JOIN inventory_runs r ON r.tenant=c.tenant AND r.run_id=c.published_run_id
 WHERE c.scope_id IS NULL OR c.state!=q.state OR c.kind!=q.kind OR c.published_config_version IS NOT q.config_version
 OR (q.state!='ready' AND (c.version!=q.version OR c.epoch!=q.epoch OR c.published_run_id IS NOT q.run_id))
 OR (q.state='ready' AND (r.phase IS NOT 'complete' OR r.mode IS NOT 'full' OR r.config_version IS NOT q.config_version
  OR (q.facet='source' AND (r.requires_catchup!=1 OR json_array_length(r.required_streams)!=2 OR NOT EXISTS(SELECT 1 FROM json_each(r.required_streams) WHERE value='operations') OR NOT EXISTS(SELECT 1 FROM json_each(r.required_streams) WHERE value='qsos')))
  OR (q.facet='receipt' AND (json_array_length(r.required_streams)!=1 OR json_extract(r.required_streams,'$[0]')!='selection'
   OR json_extract(r.fixed_query,'$.selection.modifiedSince') IS NOT NULL OR json_extract(r.fixed_query,'$.query.receivedSince') IS NOT NULL))));
CREATE VIEW inventory_match_stale_records AS
 SELECT q.tenant,q.set_id FROM inventory_match_records q JOIN inventory_match_sets h ON h.tenant=q.tenant AND h.set_id=q.set_id
 LEFT JOIN comparison_index i ON i.tenant=q.tenant AND i.generation_id=h.generation_id AND i.scope_id=q.scope_id AND i.record_key=q.record_key AND i.facet=q.facet AND i.state!='retired'
 LEFT JOIN inventory_record_facets f ON f.tenant=i.tenant AND f.scope_id=i.scope_id AND f.entity_family='qso' AND f.record_key=i.record_key AND f.facet=i.facet
 LEFT JOIN projection_domains pd ON pd.tenant=i.tenant AND pd.scope_id=i.scope_id AND pd.operation_key=i.parent_key
 LEFT JOIN inventory_membership_versions mv ON mv.tenant=i.tenant AND mv.scope_id=i.scope_id AND mv.entity_family='qso' AND mv.record_key=i.record_key AND mv.facet=i.facet
 WHERE (q.exists_flag=0 AND i.record_key IS NOT NULL) OR (q.exists_flag=1 AND (i.record_key IS NULL OR i.key_class IS NOT q.key_class OR i.bucket_hash IS NOT q.bucket_hash
 OR i.semantic_version IS NOT q.semantic_version OR f.semantic_version IS NOT q.current_semantic_version OR i.config_version IS NOT q.config_version OR i.parent_key IS NOT q.parent_key
 OR i.topology_version IS NOT q.topology_version OR coalesce(pd.topology_version,0) IS NOT q.current_topology_version OR i.projection_version IS NOT q.projection_version OR coalesce(mv.version,0) IS NOT q.membership_version
 OR (q.current_projection_version IS NULL AND EXISTS(SELECT 1 FROM comparison_projections_current p WHERE p.tenant=q.tenant AND p.generation_id=h.generation_id AND p.scope_id=q.scope_id AND p.record_key=q.record_key AND p.facet=q.facet))
 OR (q.current_projection_version IS NOT NULL AND NOT EXISTS(SELECT 1 FROM comparison_projections_current p WHERE p.tenant=q.tenant AND p.generation_id=h.generation_id AND p.scope_id=q.scope_id AND p.record_key=q.record_key AND p.facet=q.facet AND p.version=q.current_projection_version AND p.payload_id=q.payload_id AND p.state=q.projection_state AND p.reason IS q.projection_reason))));
CREATE VIEW inventory_match_stale_tokens AS
 SELECT t.tenant,t.set_id FROM inventory_match_tokens t JOIN inventory_match_sets h ON h.tenant=t.tenant AND h.set_id=t.set_id JOIN inventory_match_probes p ON p.tenant=t.tenant AND p.set_id=t.set_id AND p.probe_id=t.probe_id
 LEFT JOIN bucket_versions b ON b.tenant=t.tenant AND b.generation_id=h.generation_id AND b.scope_id=p.search_scope AND b.key_class=t.key_class AND b.bucket_hash=t.bucket_hash WHERE coalesce(b.version,0)!=t.version;
CREATE VIEW inventory_match_stale_sets AS
 SELECT h.tenant,h.set_id FROM inventory_match_sets h WHERE
 NOT EXISTS(SELECT 1 FROM comparison_domains d JOIN accounts a ON a.id=d.tenant AND a.status='active' JOIN index_generations g ON g.tenant=d.tenant AND g.generation_id=d.active_generation AND g.state='active' WHERE d.tenant=h.tenant AND d.active_generation=h.generation_id AND d.source_set_version=h.source_set_version AND g.policy_version=h.policy_version)
 UNION ALL SELECT tenant,set_id FROM inventory_match_stale_scopes
 UNION ALL SELECT tenant,set_id FROM inventory_match_stale_coverage
 UNION ALL SELECT tenant,set_id FROM inventory_match_stale_records
 UNION ALL SELECT tenant,set_id FROM inventory_match_stale_tokens;
CREATE VIEW inventory_match_publish_stale AS
 SELECT tenant,set_id FROM inventory_match_stale_sets
 UNION ALL
 SELECT h.tenant,h.set_id FROM inventory_match_sets h WHERE
 NOT EXISTS(SELECT 1 FROM comparison_domains d JOIN leases l ON l.tenant=d.tenant WHERE d.tenant=h.tenant AND d.version=h.domain_version AND l.scope='matching:'||h.destination AND l.token=h.lease_token AND l.fence=h.lease_fence AND l.expires_at>unixepoch('subsec')*1000 AND h.prepared_at>0 AND h.prepared_at<=unixepoch('subsec')*1000)
 UNION ALL
 SELECT q.tenant,q.set_id FROM inventory_match_coverage q LEFT JOIN inventory_coverage c ON c.tenant=q.tenant AND c.scope_id=q.scope_id AND c.stream_id=q.stream_id AND c.facet=q.facet AND c.partition_id=q.partition_id WHERE c.scope_id IS NULL OR c.version!=q.version OR c.epoch!=q.epoch OR c.published_run_id IS NOT q.run_id;

CREATE TRIGGER inventory_match_guard BEFORE INSERT ON inventory_match_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets WHERE tenant=NEW.tenant AND set_id=NEW.set_id AND state='prepared') OR EXISTS(SELECT 1 FROM inventory_match_publish_stale WHERE tenant=NEW.tenant AND set_id=NEW.set_id) THEN RAISE(ABORT,'inventory match authority or dependencies changed') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets h JOIN inventory_match_scopes s ON s.tenant=h.tenant AND s.set_id=h.set_id AND s.scope_id=h.destination AND s.provider IN('qrz','lotw') AND s.source=0 WHERE h.tenant=NEW.tenant AND h.set_id=NEW.set_id) THEN RAISE(ABORT,'inventory match destination invalid') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_match_sets h WHERE h.tenant=NEW.tenant AND h.set_id=NEW.set_id AND (
 h.scope_count!=(SELECT count(*) FROM inventory_match_scopes WHERE tenant=h.tenant AND set_id=h.set_id) OR h.coverage_count!=(SELECT count(*) FROM inventory_match_coverage WHERE tenant=h.tenant AND set_id=h.set_id)
 OR h.record_count!=(SELECT count(*) FROM inventory_match_records WHERE tenant=h.tenant AND set_id=h.set_id) OR h.probe_count!=(SELECT count(*) FROM inventory_match_probes WHERE tenant=h.tenant AND set_id=h.set_id)
 OR h.token_count!=(SELECT count(*) FROM inventory_match_tokens WHERE tenant=h.tenant AND set_id=h.set_id) OR h.candidate_count!=(SELECT count(*) FROM inventory_match_candidates WHERE tenant=h.tenant AND set_id=h.set_id) OR h.row_count!=(SELECT count(*) FROM inventory_match_rows WHERE tenant=h.tenant AND set_id=h.set_id)
 )) THEN RAISE(ABORT,'inventory match manifest incomplete') END;
 -- Source roster closure catches a resigned manifest that omitted a connection.
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_match_sets h CROSS JOIN connections c LEFT JOIN inventory_scopes s ON s.tenant=c.tenant AND s.connection_id=c.id
 WHERE h.tenant=NEW.tenant AND h.set_id=NEW.set_id AND c.tenant=h.tenant AND (c.kind='lofi' OR s.provider='lofi' OR s.scope_id=h.destination)
 AND NOT EXISTS(SELECT 1 FROM inventory_match_scopes q WHERE q.tenant=h.tenant AND q.set_id=h.set_id AND q.connection_id=c.id AND q.scope_id=coalesce(s.scope_id,''))) THEN RAISE(ABORT,'inventory match source roster incomplete') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_match_probes p JOIN inventory_match_sets h ON h.tenant=p.tenant AND h.set_id=p.set_id
 WHERE p.tenant=NEW.tenant AND p.set_id=NEW.set_id AND (
 (p.direction='forward' AND (p.subject_facet!='source' OR p.search_scope!=h.destination)) OR (p.direction='reverse' AND (p.subject_facet!='receipt' OR p.subject_scope!=h.destination))
 OR NOT EXISTS(SELECT 1 FROM inventory_match_scopes s WHERE s.tenant=p.tenant AND s.set_id=p.set_id AND s.scope_id=p.search_scope AND s.config_version IS p.config_version AND (CASE WHEN s.build_complete=1 AND s.build_config_version=s.config_version AND s.scope_state='observing' AND s.connection_state='active' THEN 1 ELSE 0 END)=p.index_ready)
 OR (SELECT count(*) FROM inventory_match_tokens t WHERE t.tenant=p.tenant AND t.set_id=p.set_id AND t.probe_id=p.probe_id)!=8
 OR (SELECT count(*) FROM inventory_match_tokens t WHERE t.tenant=p.tenant AND t.set_id=p.set_id AND t.probe_id=p.probe_id AND t.key_class='call_and_time')!=3
 OR (SELECT count(*) FROM inventory_match_tokens t WHERE t.tenant=p.tenant AND t.set_id=p.set_id AND t.probe_id=p.probe_id AND t.key_class='time_only')!=3
 OR (SELECT count(*) FROM inventory_match_tokens t WHERE t.tenant=p.tenant AND t.set_id=p.set_id AND t.probe_id=p.probe_id AND t.key_class='call_only')!=1
 OR (SELECT count(*) FROM inventory_match_tokens t WHERE t.tenant=p.tenant AND t.set_id=p.set_id AND t.probe_id=p.probe_id AND t.key_class='unknown')!=1
 )) THEN RAISE(ABORT,'inventory match probe incomplete') END;
 -- Compare both sides of each complete coarse candidate set, independently of
 -- application digests or the selected positive match.
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_match_tokens t JOIN inventory_match_probes p ON p.tenant=t.tenant AND p.set_id=t.set_id AND p.probe_id=t.probe_id JOIN inventory_match_sets h ON h.tenant=p.tenant AND h.set_id=p.set_id
 CROSS JOIN comparison_index i INDEXED BY comparison_bucket WHERE t.tenant=NEW.tenant AND t.set_id=NEW.set_id AND i.tenant=t.tenant AND i.generation_id=h.generation_id AND i.scope_id=p.search_scope AND i.key_class=t.key_class AND i.bucket_hash=t.bucket_hash
 AND NOT EXISTS(SELECT 1 FROM inventory_match_candidates c WHERE c.tenant=t.tenant AND c.set_id=t.set_id AND c.probe_id=t.probe_id AND c.scope_id=i.scope_id AND c.record_key=i.record_key AND c.facet=i.facet))
 OR EXISTS(SELECT 1 FROM inventory_match_candidates c JOIN inventory_match_probes p ON p.tenant=c.tenant AND p.set_id=c.set_id AND p.probe_id=c.probe_id JOIN inventory_match_sets h ON h.tenant=p.tenant AND h.set_id=p.set_id
 WHERE c.tenant=NEW.tenant AND c.set_id=NEW.set_id AND (c.scope_id!=p.search_scope OR c.facet!=CASE p.direction WHEN 'forward' THEN 'receipt' ELSE 'source' END OR NOT EXISTS(
 SELECT 1 FROM comparison_index i JOIN inventory_match_tokens t ON t.tenant=c.tenant AND t.set_id=c.set_id AND t.probe_id=c.probe_id AND t.key_class=i.key_class AND t.bucket_hash=i.bucket_hash WHERE i.tenant=c.tenant AND i.generation_id=h.generation_id AND i.scope_id=c.scope_id AND i.record_key=c.record_key AND i.facet=c.facet))) THEN RAISE(ABORT,'inventory match candidate closure incomplete') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_match_rows q JOIN inventory_match_sets h ON h.tenant=q.tenant AND h.set_id=q.set_id LEFT JOIN match_results old ON old.tenant=q.tenant AND old.destination=h.destination AND old.source_scope=q.source_scope AND old.record_key=q.record_key
 WHERE q.tenant=NEW.tenant AND q.set_id=NEW.set_id AND (coalesce(old.version,0)!=q.expected_version OR NOT EXISTS(SELECT 1 FROM inventory_match_scopes s WHERE s.tenant=q.tenant AND s.set_id=q.set_id AND s.scope_id=q.source_scope AND s.source=1 AND s.provider='lofi') OR NOT EXISTS(SELECT 1 FROM inventory_match_records r WHERE r.tenant=q.tenant AND r.set_id=q.set_id AND r.scope_id=q.source_scope AND r.record_key=q.record_key AND r.facet='source')
 OR (q.state='excluded' AND NOT EXISTS(SELECT 1 FROM inventory_match_records r WHERE r.tenant=q.tenant AND r.set_id=q.set_id AND r.scope_id=q.source_scope AND r.record_key=q.record_key AND r.projection_state='excluded'))
 OR (q.state NOT IN('incomplete','excluded') AND (
 json_array_length(q.required_coverage)=0 OR EXISTS(SELECT 1 FROM json_each(q.required_coverage) required WHERE NOT EXISTS(SELECT 1 FROM inventory_match_coverage c WHERE c.tenant=q.tenant AND c.set_id=q.set_id AND c.scope_id=h.destination AND c.facet='receipt' AND c.state='ready' AND json_array(c.scope_id,c.stream_id,c.facet,c.partition_id)=required.value))
 OR
 NOT EXISTS(SELECT 1 FROM inventory_match_records r WHERE r.tenant=q.tenant AND r.set_id=q.set_id AND r.scope_id=q.source_scope AND r.record_key=q.record_key AND r.facet='source' AND r.projection_state='ready')
 OR NOT EXISTS(SELECT 1 FROM inventory_match_probes p WHERE p.tenant=q.tenant AND p.set_id=q.set_id AND p.direction='forward' AND p.subject_scope=q.source_scope AND p.subject_key=q.record_key AND p.search_scope=h.destination AND p.complete=1 AND p.index_ready=1)
 OR NOT EXISTS(SELECT 1 FROM inventory_match_coverage c WHERE c.tenant=q.tenant AND c.set_id=q.set_id AND c.scope_id=q.source_scope AND c.facet='source' AND c.state='ready')
 OR NOT EXISTS(SELECT 1 FROM inventory_match_coverage c WHERE c.tenant=q.tenant AND c.set_id=q.set_id AND c.scope_id=h.destination AND c.facet='receipt' AND c.state='ready')
 OR EXISTS(SELECT 1 FROM inventory_match_scopes s WHERE s.tenant=q.tenant AND s.set_id=q.set_id AND s.scope_id IN(q.source_scope,h.destination) AND (s.scope_state!='observing' OR s.connection_state!='active' OR s.provider!=s.kind OR s.scope_identity!=s.logical_identity OR s.build_complete!=1 OR s.build_config_version!=s.config_version OR s.unresolved!=0))
 )) OR (q.state IN('matched_existing','projection_mismatch') AND (
 NOT EXISTS(SELECT 1 FROM inventory_match_records r WHERE r.tenant=q.tenant AND r.set_id=q.set_id AND r.scope_id=h.destination AND r.record_key=q.remote_key AND r.facet='receipt' AND r.projection_state='ready')
 OR NOT EXISTS(SELECT 1 FROM inventory_match_probes p JOIN inventory_match_candidates c ON c.tenant=p.tenant AND c.set_id=p.set_id AND c.probe_id=p.probe_id WHERE p.tenant=q.tenant AND p.set_id=q.set_id AND p.direction='forward' AND p.subject_scope=q.source_scope AND p.subject_key=q.record_key AND c.scope_id=h.destination AND c.record_key=q.remote_key AND c.facet='receipt')
 OR NOT EXISTS(SELECT 1 FROM inventory_match_probes p JOIN inventory_match_candidates c ON c.tenant=p.tenant AND c.set_id=p.set_id AND c.probe_id=p.probe_id WHERE p.tenant=q.tenant AND p.set_id=q.set_id AND p.direction='reverse' AND p.subject_scope=h.destination AND p.subject_key=q.remote_key AND p.search_scope=q.source_scope AND c.scope_id=q.source_scope AND c.record_key=q.record_key AND c.facet='source')
 OR NOT EXISTS(SELECT 1 FROM inventory_match_scopes s WHERE s.tenant=q.tenant AND s.set_id=q.set_id AND s.source=1)
 OR EXISTS(SELECT 1 FROM inventory_match_scopes s WHERE s.tenant=q.tenant AND s.set_id=q.set_id AND s.source=1 AND (s.scope_id='' OR s.scope_state!='observing' OR s.connection_state!='active' OR s.provider!='lofi' OR s.kind!='lofi' OR s.scope_identity!=s.logical_identity OR s.build_complete!=1 OR s.build_config_version!=s.config_version OR s.unresolved!=0
 OR NOT EXISTS(SELECT 1 FROM inventory_match_coverage c WHERE c.tenant=s.tenant AND c.set_id=s.set_id AND c.scope_id=s.scope_id AND c.facet='source' AND c.state='ready')
 OR NOT EXISTS(SELECT 1 FROM inventory_match_probes p WHERE p.tenant=s.tenant AND p.set_id=s.set_id AND p.direction='reverse' AND p.subject_scope=h.destination AND p.subject_key=q.remote_key AND p.search_scope=s.scope_id AND p.complete=1 AND p.index_ready=1)))
 )))) THEN RAISE(ABORT,'inventory match result requirements incomplete') END;
END;
CREATE TRIGGER inventory_match_result_insert BEFORE INSERT ON match_results BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_match_rows q JOIN inventory_match_sets h ON h.tenant=q.tenant AND h.set_id=q.set_id AND h.state='prepared' JOIN inventory_match_guards g ON g.tenant=h.tenant AND g.set_id=h.set_id WHERE q.tenant=NEW.tenant AND q.set_id=NEW.set_id AND q.source_scope=NEW.source_scope AND q.record_key=NEW.record_key AND h.destination=NEW.destination AND NEW.version=q.expected_version+1 AND NEW.state=q.state AND NEW.reason IS q.reason AND NEW.remote_key IS q.remote_key AND NEW.derived_at=h.prepared_at) THEN RAISE(ABORT,'inventory match publication guard missing') END;
END;
CREATE TRIGGER inventory_match_result_update BEFORE UPDATE ON match_results BEGIN
 SELECT CASE WHEN NEW.tenant!=OLD.tenant OR NEW.destination!=OLD.destination OR NEW.source_scope!=OLD.source_scope OR NEW.record_key!=OLD.record_key OR NEW.version!=OLD.version+1 OR NOT EXISTS(SELECT 1 FROM inventory_match_rows q JOIN inventory_match_sets h ON h.tenant=q.tenant AND h.set_id=q.set_id AND h.state='prepared' JOIN inventory_match_guards g ON g.tenant=h.tenant AND g.set_id=h.set_id WHERE q.tenant=NEW.tenant AND q.set_id=NEW.set_id AND q.source_scope=NEW.source_scope AND q.record_key=NEW.record_key AND h.destination=NEW.destination AND q.expected_version=OLD.version AND NEW.state=q.state AND NEW.reason IS q.reason AND NEW.remote_key IS q.remote_key AND NEW.derived_at=h.prepared_at) THEN RAISE(ABORT,'inventory match result version changed') END;
END;
CREATE TRIGGER inventory_match_commit BEFORE UPDATE ON inventory_match_sets BEGIN
 SELECT CASE WHEN OLD.state!='prepared' OR NEW.state!='committed' OR NOT EXISTS(SELECT 1 FROM inventory_match_guards WHERE tenant=OLD.tenant AND set_id=OLD.set_id) OR EXISTS(SELECT 1 FROM inventory_match_publish_stale WHERE tenant=OLD.tenant AND set_id=OLD.set_id)
 OR OLD.tenant!=NEW.tenant OR OLD.set_id!=NEW.set_id OR OLD.input_digest!=NEW.input_digest OR OLD.destination!=NEW.destination OR OLD.generation_id!=NEW.generation_id OR OLD.domain_version!=NEW.domain_version OR OLD.source_set_version!=NEW.source_set_version
 THEN RAISE(ABORT,'inventory match commit authority changed') END;
 SELECT CASE WHEN (SELECT count(*) FROM match_results r JOIN inventory_match_rows q ON q.tenant=r.tenant AND q.set_id=NEW.set_id AND q.source_scope=r.source_scope AND q.record_key=r.record_key WHERE r.tenant=NEW.tenant AND r.destination=NEW.destination AND r.set_id=NEW.set_id AND r.version=q.expected_version+1 AND r.state=q.state AND r.reason IS q.reason AND r.remote_key IS q.remote_key AND r.derived_at=NEW.prepared_at)!=NEW.row_count THEN RAISE(ABORT,'inventory match result publication incomplete') END;
END;
CREATE TRIGGER inventory_match_set_retained BEFORE DELETE ON inventory_match_sets WHEN EXISTS(SELECT 1 FROM match_results WHERE tenant=OLD.tenant AND set_id=OLD.set_id) BEGIN SELECT RAISE(ABORT,'inventory match set referenced'); END;
CREATE VIEW match_results_current AS SELECT r.* FROM match_results r JOIN inventory_match_sets h ON h.tenant=r.tenant AND h.set_id=r.set_id AND h.state='committed'
 WHERE NOT EXISTS(SELECT 1 FROM inventory_match_stale_sets x WHERE x.tenant=h.tenant AND x.set_id=h.set_id);

CREATE TRIGGER inventory_match_header_identity BEFORE UPDATE ON inventory_match_sets WHEN
 (NEW.tenant,NEW.set_id,NEW.destination,NEW.generation_id,NEW.domain_version,NEW.source_set_version,NEW.policy_version,NEW.result_version,NEW.input_digest,NEW.lease_token,NEW.lease_fence,NEW.prepared_at,NEW.scope_count,NEW.coverage_count,NEW.record_count,NEW.probe_count,NEW.token_count,NEW.candidate_count,NEW.row_count)
 IS NOT (OLD.tenant,OLD.set_id,OLD.destination,OLD.generation_id,OLD.domain_version,OLD.source_set_version,OLD.policy_version,OLD.result_version,OLD.input_digest,OLD.lease_token,OLD.lease_fence,OLD.prepared_at,OLD.scope_count,OLD.coverage_count,OLD.record_count,OLD.probe_count,OLD.token_count,OLD.candidate_count,OLD.row_count)
 BEGIN
 SELECT RAISE(ABORT,'immutable inventory match header');
END;

-- Closing admission freezes the exact relational dependency set. Future GC
-- may remove only superseded sets after the seven-day receipt horizon.
CREATE TRIGGER inventory_match_scopes_insert BEFORE INSERT ON inventory_match_scopes WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets h WHERE h.tenant=NEW.tenant AND h.set_id=NEW.set_id AND h.state='prepared' AND NOT EXISTS(SELECT 1 FROM inventory_match_guards g WHERE g.tenant=h.tenant AND g.set_id=h.set_id)) BEGIN SELECT RAISE(ABORT,'inventory match dependencies closed'); END;
CREATE TRIGGER inventory_match_scopes_update BEFORE UPDATE ON inventory_match_scopes BEGIN SELECT RAISE(ABORT,'immutable inventory match dependency'); END;
CREATE TRIGGER inventory_match_scopes_delete BEFORE DELETE ON inventory_match_scopes WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets h WHERE h.tenant=OLD.tenant AND h.set_id=OLD.set_id AND h.state='committed' AND h.prepared_at<unixepoch('subsec')*1000-604800000 AND NOT EXISTS(SELECT 1 FROM match_results r WHERE r.tenant=h.tenant AND r.set_id=h.set_id)) BEGIN SELECT RAISE(ABORT,'retained inventory match dependency'); END;
CREATE TRIGGER inventory_match_coverage_insert BEFORE INSERT ON inventory_match_coverage WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets h WHERE h.tenant=NEW.tenant AND h.set_id=NEW.set_id AND h.state='prepared' AND NOT EXISTS(SELECT 1 FROM inventory_match_guards g WHERE g.tenant=h.tenant AND g.set_id=h.set_id)) BEGIN SELECT RAISE(ABORT,'inventory match dependencies closed'); END;
CREATE TRIGGER inventory_match_coverage_update BEFORE UPDATE ON inventory_match_coverage BEGIN SELECT RAISE(ABORT,'immutable inventory match dependency'); END;
CREATE TRIGGER inventory_match_coverage_delete BEFORE DELETE ON inventory_match_coverage WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets h WHERE h.tenant=OLD.tenant AND h.set_id=OLD.set_id AND h.state='committed' AND h.prepared_at<unixepoch('subsec')*1000-604800000 AND NOT EXISTS(SELECT 1 FROM match_results r WHERE r.tenant=h.tenant AND r.set_id=h.set_id)) BEGIN SELECT RAISE(ABORT,'retained inventory match dependency'); END;
CREATE TRIGGER inventory_match_records_insert BEFORE INSERT ON inventory_match_records WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets h WHERE h.tenant=NEW.tenant AND h.set_id=NEW.set_id AND h.state='prepared' AND NOT EXISTS(SELECT 1 FROM inventory_match_guards g WHERE g.tenant=h.tenant AND g.set_id=h.set_id)) BEGIN SELECT RAISE(ABORT,'inventory match dependencies closed'); END;
CREATE TRIGGER inventory_match_records_update BEFORE UPDATE ON inventory_match_records BEGIN SELECT RAISE(ABORT,'immutable inventory match dependency'); END;
CREATE TRIGGER inventory_match_records_delete BEFORE DELETE ON inventory_match_records WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets h WHERE h.tenant=OLD.tenant AND h.set_id=OLD.set_id AND h.state='committed' AND h.prepared_at<unixepoch('subsec')*1000-604800000 AND NOT EXISTS(SELECT 1 FROM match_results r WHERE r.tenant=h.tenant AND r.set_id=h.set_id)) BEGIN SELECT RAISE(ABORT,'retained inventory match dependency'); END;
CREATE TRIGGER inventory_match_probes_insert BEFORE INSERT ON inventory_match_probes WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets h WHERE h.tenant=NEW.tenant AND h.set_id=NEW.set_id AND h.state='prepared' AND NOT EXISTS(SELECT 1 FROM inventory_match_guards g WHERE g.tenant=h.tenant AND g.set_id=h.set_id)) BEGIN SELECT RAISE(ABORT,'inventory match dependencies closed'); END;
CREATE TRIGGER inventory_match_probes_update BEFORE UPDATE ON inventory_match_probes BEGIN SELECT RAISE(ABORT,'immutable inventory match dependency'); END;
CREATE TRIGGER inventory_match_probes_delete BEFORE DELETE ON inventory_match_probes WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets h WHERE h.tenant=OLD.tenant AND h.set_id=OLD.set_id AND h.state='committed' AND h.prepared_at<unixepoch('subsec')*1000-604800000 AND NOT EXISTS(SELECT 1 FROM match_results r WHERE r.tenant=h.tenant AND r.set_id=h.set_id)) BEGIN SELECT RAISE(ABORT,'retained inventory match dependency'); END;
CREATE TRIGGER inventory_match_tokens_insert BEFORE INSERT ON inventory_match_tokens WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets h WHERE h.tenant=NEW.tenant AND h.set_id=NEW.set_id AND h.state='prepared' AND NOT EXISTS(SELECT 1 FROM inventory_match_guards g WHERE g.tenant=h.tenant AND g.set_id=h.set_id)) BEGIN SELECT RAISE(ABORT,'inventory match dependencies closed'); END;
CREATE TRIGGER inventory_match_tokens_update BEFORE UPDATE ON inventory_match_tokens BEGIN SELECT RAISE(ABORT,'immutable inventory match dependency'); END;
CREATE TRIGGER inventory_match_tokens_delete BEFORE DELETE ON inventory_match_tokens WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets h WHERE h.tenant=OLD.tenant AND h.set_id=OLD.set_id AND h.state='committed' AND h.prepared_at<unixepoch('subsec')*1000-604800000 AND NOT EXISTS(SELECT 1 FROM match_results r WHERE r.tenant=h.tenant AND r.set_id=h.set_id)) BEGIN SELECT RAISE(ABORT,'retained inventory match dependency'); END;
CREATE TRIGGER inventory_match_candidates_insert BEFORE INSERT ON inventory_match_candidates WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets h WHERE h.tenant=NEW.tenant AND h.set_id=NEW.set_id AND h.state='prepared' AND NOT EXISTS(SELECT 1 FROM inventory_match_guards g WHERE g.tenant=h.tenant AND g.set_id=h.set_id)) BEGIN SELECT RAISE(ABORT,'inventory match dependencies closed'); END;
CREATE TRIGGER inventory_match_candidates_update BEFORE UPDATE ON inventory_match_candidates BEGIN SELECT RAISE(ABORT,'immutable inventory match dependency'); END;
CREATE TRIGGER inventory_match_candidates_delete BEFORE DELETE ON inventory_match_candidates WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets h WHERE h.tenant=OLD.tenant AND h.set_id=OLD.set_id AND h.state='committed' AND h.prepared_at<unixepoch('subsec')*1000-604800000 AND NOT EXISTS(SELECT 1 FROM match_results r WHERE r.tenant=h.tenant AND r.set_id=h.set_id)) BEGIN SELECT RAISE(ABORT,'retained inventory match dependency'); END;
CREATE TRIGGER inventory_match_rows_insert BEFORE INSERT ON inventory_match_rows WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets h WHERE h.tenant=NEW.tenant AND h.set_id=NEW.set_id AND h.state='prepared' AND NOT EXISTS(SELECT 1 FROM inventory_match_guards g WHERE g.tenant=h.tenant AND g.set_id=h.set_id)) BEGIN SELECT RAISE(ABORT,'inventory match dependencies closed'); END;
CREATE TRIGGER inventory_match_rows_update BEFORE UPDATE ON inventory_match_rows BEGIN SELECT RAISE(ABORT,'immutable inventory match dependency'); END;
CREATE TRIGGER inventory_match_rows_delete BEFORE DELETE ON inventory_match_rows WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets h WHERE h.tenant=OLD.tenant AND h.set_id=OLD.set_id AND h.state='committed' AND h.prepared_at<unixepoch('subsec')*1000-604800000 AND NOT EXISTS(SELECT 1 FROM match_results r WHERE r.tenant=h.tenant AND r.set_id=h.set_id)) BEGIN SELECT RAISE(ABORT,'retained inventory match dependency'); END;
