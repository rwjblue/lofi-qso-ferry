-- Recovery declarations retain opaque calendar paths, not contact dates.
-- Only current incomplete cohorts are materialized in the scheduling index.
ALTER TABLE inventory_match_sets ADD COLUMN recovery_count INTEGER CHECK(recovery_count IS NULL OR recovery_count BETWEEN 0 AND 40);
CREATE TABLE inventory_match_recovery (
 tenant TEXT NOT NULL, set_id TEXT NOT NULL, recovery_id INTEGER NOT NULL CHECK(recovery_id BETWEEN 0 AND 39),
 scope_id TEXT NOT NULL, facet TEXT NOT NULL CHECK(facet IN('source','receipt')),
 subject_scope TEXT NOT NULL, subject_key TEXT NOT NULL, nodes TEXT NOT NULL CHECK(json_valid(nodes) AND json_type(nodes)='array'),
 PRIMARY KEY(tenant,set_id,recovery_id), FOREIGN KEY(tenant,set_id) REFERENCES inventory_match_sets(tenant,set_id),
 FOREIGN KEY(tenant,set_id,subject_scope,subject_key) REFERENCES inventory_match_rows(tenant,set_id,source_scope,record_key),
 FOREIGN KEY(tenant,scope_id) REFERENCES inventory_scopes(tenant,scope_id),
 CHECK((facet='source' AND json_array_length(nodes)=1 AND json_extract(nodes,'$[0]')='') OR (facet='receipt' AND json_array_length(nodes)=23))
);
CREATE UNIQUE INDEX inventory_match_recovery_source ON inventory_match_recovery(tenant,set_id,scope_id) WHERE facet='source';
CREATE UNIQUE INDEX inventory_match_recovery_day ON inventory_match_recovery(tenant,set_id,subject_scope,subject_key) WHERE facet='receipt';
CREATE TABLE inventory_matching_coverage_dependents (
 tenant TEXT NOT NULL, set_id TEXT NOT NULL, generation_id TEXT NOT NULL, destination TEXT NOT NULL, source_scope TEXT NOT NULL, scope_id TEXT NOT NULL, facet TEXT NOT NULL CHECK(facet IN('source','receipt')),
 node_hash TEXT NOT NULL, seen_clock INTEGER NOT NULL CHECK(seen_clock>=0), recovery_id INTEGER NOT NULL, node_index INTEGER NOT NULL CHECK(node_index BETWEEN 0 AND 22),
 PRIMARY KEY(tenant,set_id,source_scope,scope_id,facet,node_hash),
 FOREIGN KEY(tenant,set_id,recovery_id) REFERENCES inventory_match_recovery(tenant,set_id,recovery_id),
 FOREIGN KEY(tenant,generation_id) REFERENCES index_generations(tenant,generation_id),
 FOREIGN KEY(tenant,destination) REFERENCES inventory_scopes(tenant,scope_id), FOREIGN KEY(tenant,source_scope) REFERENCES inventory_scopes(tenant,scope_id),
 CHECK((facet='source' AND node_hash='' AND node_index=0) OR (facet='receipt' AND length(node_hash)=43))
);
CREATE INDEX inventory_matching_coverage_dependents_cursor ON inventory_matching_coverage_dependents(tenant,generation_id,scope_id,facet,node_hash,destination,source_scope,seen_clock,set_id);
CREATE INDEX inventory_matching_coverage_dependents_scope ON inventory_matching_coverage_dependents(tenant,scope_id,facet);
CREATE VIEW inventory_match_recovery_missing_source AS
 SELECT s.tenant,s.set_id,s.scope_id FROM inventory_match_scopes s WHERE s.provider='lofi' AND s.scope_id!='' AND NOT EXISTS(
 SELECT 1 FROM inventory_match_coverage q JOIN inventory_runs r ON r.tenant=q.tenant AND r.run_id=q.run_id
 WHERE q.tenant=s.tenant AND q.set_id=s.set_id AND q.scope_id=s.scope_id AND q.facet='source' AND q.state='ready' AND q.kind='observed_selection' AND q.config_version=s.config_version
 AND r.config_version=s.config_version AND r.mode='full' AND r.phase='complete' AND r.requires_catchup=1 AND json_array_length(r.required_streams)=2
 AND EXISTS(SELECT 1 FROM json_each(r.required_streams) WHERE value='operations') AND EXISTS(SELECT 1 FROM json_each(r.required_streams) WHERE value='qsos'));
CREATE VIEW inventory_match_recovery_source_requirements AS
 SELECT s.tenant,s.set_id,s.scope_id FROM inventory_match_recovery_missing_source s WHERE EXISTS(SELECT 1 FROM inventory_match_rows r WHERE r.tenant=s.tenant AND r.set_id=s.set_id AND r.reason='reverse_incomplete')
 UNION ALL SELECT s.tenant,s.set_id,s.scope_id FROM inventory_match_scopes s WHERE s.provider='lofi' AND s.scope_id!=''
 AND EXISTS(SELECT 1 FROM inventory_match_rows r WHERE r.tenant=s.tenant AND r.set_id=s.set_id AND r.state='incomplete')
 AND EXISTS(SELECT 1 FROM inventory_match_records p WHERE p.tenant=s.tenant AND p.set_id=s.set_id AND p.scope_id=s.scope_id AND p.facet='source' AND p.exists_flag=1 AND p.current_projection_version IS NULL)
 AND (EXISTS(SELECT 1 FROM inventory_match_recovery_missing_source m WHERE m.tenant=s.tenant AND m.set_id=s.set_id AND m.scope_id=s.scope_id) OR EXISTS(SELECT 1 FROM inventory_match_coverage q WHERE q.tenant=s.tenant AND q.set_id=s.set_id AND q.scope_id=s.scope_id AND q.facet='source' AND q.state!='ready'));
CREATE VIEW inventory_match_recovery_receipt_requirements AS
 SELECT r.tenant,r.set_id,r.source_scope,r.record_key FROM inventory_match_rows r JOIN inventory_match_records p ON p.tenant=r.tenant AND p.set_id=r.set_id AND p.scope_id=r.source_scope AND p.record_key=r.record_key AND p.facet='source'
 WHERE r.state='incomplete' AND r.reason='forward_incomplete' AND json_array_length(r.required_coverage)=0 AND p.exists_flag=1 AND p.key_class='call_and_time' AND p.current_projection_version IS NOT NULL AND p.projection_state='ready';
CREATE TRIGGER inventory_match_recovery_insert BEFORE INSERT ON inventory_match_recovery BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets h JOIN inventory_match_rows r ON r.tenant=h.tenant AND r.set_id=h.set_id AND r.source_scope=NEW.subject_scope AND r.record_key=NEW.subject_key AND r.state='incomplete' JOIN inventory_match_scopes s ON s.tenant=h.tenant AND s.set_id=h.set_id AND s.scope_id=NEW.scope_id AND s.coverage_clock IS NOT NULL WHERE h.tenant=NEW.tenant AND h.set_id=NEW.set_id AND h.state='prepared' AND NOT EXISTS(SELECT 1 FROM inventory_match_guards g WHERE g.tenant=h.tenant AND g.set_id=h.set_id) AND ((NEW.facet='source' AND s.provider='lofi') OR (NEW.facet='receipt' AND s.scope_id=h.destination AND s.provider IN('qrz','lotw')))) THEN RAISE(ABORT,'inventory matching recovery declaration closed') END;
 SELECT CASE WHEN NEW.facet='source' AND NOT EXISTS(SELECT 1 FROM inventory_match_recovery_source_requirements s WHERE s.tenant=NEW.tenant AND s.set_id=NEW.set_id AND s.scope_id=NEW.scope_id) THEN RAISE(ABORT,'inventory matching source recovery not required') END;
 SELECT CASE WHEN NEW.facet='receipt' AND (EXISTS(SELECT 1 FROM json_each(NEW.nodes) WHERE type!='text' OR length(value)!=43 OR value GLOB '*[^A-Za-z0-9_-]*') OR NOT EXISTS(SELECT 1 FROM inventory_match_rows r JOIN inventory_match_records p ON p.tenant=r.tenant AND p.set_id=r.set_id AND p.scope_id=r.source_scope AND p.record_key=r.record_key AND p.facet='source' AND p.projection_state='ready' AND p.current_projection_version IS NOT NULL WHERE r.tenant=NEW.tenant AND r.set_id=NEW.set_id AND r.source_scope=NEW.subject_scope AND r.record_key=NEW.subject_key AND r.reason='forward_incomplete' AND json_array_length(r.required_coverage)=0)) THEN RAISE(ABORT,'inventory matching receipt recovery invalid') END;
END;
CREATE TRIGGER inventory_match_recovery_header_identity BEFORE UPDATE ON inventory_match_sets WHEN NEW.recovery_count IS NOT OLD.recovery_count BEGIN SELECT RAISE(ABORT,'immutable inventory matching recovery count'); END;
CREATE TRIGGER inventory_match_recovery_update BEFORE UPDATE ON inventory_match_recovery BEGIN SELECT RAISE(ABORT,'immutable inventory matching recovery declaration'); END;
CREATE TRIGGER inventory_match_recovery_delete BEFORE DELETE ON inventory_match_recovery WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets h WHERE h.tenant=OLD.tenant AND h.set_id=OLD.set_id AND h.state='committed' AND h.prepared_at<unixepoch('subsec')*1000-604800000 AND NOT EXISTS(SELECT 1 FROM match_results r INDEXED BY match_result_set WHERE r.tenant=h.tenant AND r.set_id=h.set_id)) BEGIN SELECT RAISE(ABORT,'retained inventory matching recovery declaration'); END;
CREATE TRIGGER inventory_match_recovery_guard BEFORE INSERT ON inventory_match_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets h WHERE h.tenant=NEW.tenant AND h.set_id=NEW.set_id AND h.recovery_count IS NOT NULL AND h.recovery_count=(SELECT count(*) FROM inventory_match_recovery q WHERE q.tenant=h.tenant AND q.set_id=h.set_id) AND coalesce((SELECT max(recovery_id) FROM inventory_match_recovery q WHERE q.tenant=h.tenant AND q.set_id=h.set_id),-1)=h.recovery_count-1) THEN RAISE(ABORT,'inventory matching coverage recovery missing') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_match_recovery_source_requirements s WHERE s.tenant=NEW.tenant AND s.set_id=NEW.set_id AND NOT EXISTS(SELECT 1 FROM inventory_match_recovery q WHERE q.tenant=s.tenant AND q.set_id=s.set_id AND q.scope_id=s.scope_id AND q.facet='source')) OR EXISTS(SELECT 1 FROM inventory_match_recovery_receipt_requirements r WHERE r.tenant=NEW.tenant AND r.set_id=NEW.set_id AND NOT EXISTS(SELECT 1 FROM inventory_match_recovery q WHERE q.tenant=r.tenant AND q.set_id=r.set_id AND q.subject_scope=r.source_scope AND q.subject_key=r.record_key AND q.facet='receipt')) THEN RAISE(ABORT,'inventory matching coverage recovery incomplete') END;
END;
CREATE TRIGGER inventory_matching_coverage_dependent_insert BEFORE INSERT ON inventory_matching_coverage_dependents BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_match_recovery q JOIN inventory_match_sets h ON h.tenant=q.tenant AND h.set_id=q.set_id AND h.state='prepared' AND h.generation_id=NEW.generation_id AND h.destination=NEW.destination JOIN inventory_match_guards g ON g.tenant=h.tenant AND g.set_id=h.set_id JOIN inventory_match_scopes s ON s.tenant=q.tenant AND s.set_id=q.set_id AND s.scope_id=q.scope_id AND s.coverage_clock=NEW.seen_clock WHERE q.tenant=NEW.tenant AND q.set_id=NEW.set_id AND q.recovery_id=NEW.recovery_id AND q.scope_id=NEW.scope_id AND q.facet=NEW.facet AND (q.facet='source' OR q.subject_scope=NEW.source_scope) AND json_extract(q.nodes,'$['||NEW.node_index||']')=NEW.node_hash) OR NOT EXISTS(SELECT 1 FROM match_results r INDEXED BY match_result_set WHERE r.tenant=NEW.tenant AND r.set_id=NEW.set_id AND r.source_scope=NEW.source_scope AND r.state='incomplete') THEN RAISE(ABORT,'inventory matching coverage dependent invalid') END;
END;
CREATE TRIGGER inventory_matching_coverage_dependent_update BEFORE UPDATE ON inventory_matching_coverage_dependents BEGIN SELECT RAISE(ABORT,'immutable inventory matching coverage dependent'); END;
CREATE TRIGGER inventory_matching_coverage_dependent_delete BEFORE DELETE ON inventory_matching_coverage_dependents WHEN EXISTS(SELECT 1 FROM match_results r INDEXED BY match_result_set WHERE r.tenant=OLD.tenant AND r.set_id=OLD.set_id AND r.source_scope=OLD.source_scope AND r.state='incomplete') BEGIN SELECT RAISE(ABORT,'inventory matching coverage dependent referenced'); END;
CREATE TRIGGER inventory_matching_coverage_result_insert AFTER INSERT ON match_results WHEN NEW.state='incomplete' BEGIN
 INSERT INTO inventory_matching_coverage_dependents(tenant,set_id,generation_id,destination,source_scope,scope_id,facet,node_hash,seen_clock,recovery_id,node_index)
 SELECT NEW.tenant,NEW.set_id,h.generation_id,h.destination,NEW.source_scope,q.scope_id,q.facet,j.value,s.coverage_clock,min(q.recovery_id*23+CAST(j.key AS INTEGER))/23,min(q.recovery_id*23+CAST(j.key AS INTEGER))%23
 FROM inventory_match_recovery q JOIN inventory_match_sets h ON h.tenant=q.tenant AND h.set_id=q.set_id JOIN inventory_match_scopes s ON s.tenant=q.tenant AND s.set_id=q.set_id AND s.scope_id=q.scope_id CROSS JOIN json_each(q.nodes) j
 WHERE q.tenant=NEW.tenant AND q.set_id=NEW.set_id AND (q.facet='source' OR q.subject_scope=NEW.source_scope) AND NOT EXISTS(SELECT 1 FROM inventory_matching_coverage_dependents d WHERE d.tenant=q.tenant AND d.set_id=q.set_id AND d.source_scope=NEW.source_scope)
 GROUP BY q.scope_id,q.facet,j.value,s.coverage_clock;
END;
CREATE TRIGGER inventory_matching_coverage_result_update AFTER UPDATE OF set_id,state ON match_results WHEN NEW.set_id!=OLD.set_id OR NEW.state!=OLD.state BEGIN
 DELETE FROM inventory_matching_coverage_dependents WHERE tenant=OLD.tenant AND set_id=OLD.set_id AND source_scope=OLD.source_scope AND NOT EXISTS(SELECT 1 FROM match_results r INDEXED BY match_result_set WHERE r.tenant=OLD.tenant AND r.set_id=OLD.set_id AND r.source_scope=OLD.source_scope AND r.state='incomplete');
 INSERT INTO inventory_matching_coverage_dependents(tenant,set_id,generation_id,destination,source_scope,scope_id,facet,node_hash,seen_clock,recovery_id,node_index)
 SELECT NEW.tenant,NEW.set_id,h.generation_id,h.destination,NEW.source_scope,q.scope_id,q.facet,j.value,s.coverage_clock,min(q.recovery_id*23+CAST(j.key AS INTEGER))/23,min(q.recovery_id*23+CAST(j.key AS INTEGER))%23
 FROM inventory_match_recovery q JOIN inventory_match_sets h ON h.tenant=q.tenant AND h.set_id=q.set_id JOIN inventory_match_scopes s ON s.tenant=q.tenant AND s.set_id=q.set_id AND s.scope_id=q.scope_id CROSS JOIN json_each(q.nodes) j
 WHERE NEW.state='incomplete' AND q.tenant=NEW.tenant AND q.set_id=NEW.set_id AND (q.facet='source' OR q.subject_scope=NEW.source_scope) AND NOT EXISTS(SELECT 1 FROM inventory_matching_coverage_dependents d WHERE d.tenant=q.tenant AND d.set_id=q.set_id AND d.source_scope=NEW.source_scope)
 GROUP BY q.scope_id,q.facet,j.value,s.coverage_clock;
END;
CREATE TRIGGER inventory_matching_coverage_result_delete AFTER DELETE ON match_results BEGIN
 DELETE FROM inventory_matching_coverage_dependents WHERE tenant=OLD.tenant AND set_id=OLD.set_id AND source_scope=OLD.source_scope AND NOT EXISTS(SELECT 1 FROM match_results r INDEXED BY match_result_set WHERE r.tenant=OLD.tenant AND r.set_id=OLD.set_id AND r.source_scope=OLD.source_scope AND r.state='incomplete');
END;
CREATE TRIGGER inventory_match_recovery_commit BEFORE UPDATE ON inventory_match_sets WHEN NEW.state='committed' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_match_recovery q CROSS JOIN json_each(q.nodes) j WHERE q.tenant=OLD.tenant AND q.set_id=OLD.set_id AND q.facet='receipt' AND NOT EXISTS(SELECT 1 FROM inventory_matching_coverage_dependents d WHERE d.tenant=q.tenant AND d.set_id=q.set_id AND d.source_scope=q.subject_scope AND d.scope_id=q.scope_id AND d.facet=q.facet AND d.node_hash=j.value)) THEN RAISE(ABORT,'inventory matching coverage dependents incomplete') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_match_recovery q WHERE q.tenant=OLD.tenant AND q.set_id=OLD.set_id AND q.facet='source' AND EXISTS(SELECT 1 FROM inventory_match_rows r WHERE r.tenant=q.tenant AND r.set_id=q.set_id AND r.state='incomplete' AND NOT EXISTS(SELECT 1 FROM inventory_matching_coverage_dependents d WHERE d.tenant=q.tenant AND d.set_id=q.set_id AND d.source_scope=r.source_scope AND d.scope_id=q.scope_id AND d.facet=q.facet AND d.node_hash=''))) THEN RAISE(ABORT,'inventory matching source coverage dependents incomplete') END;
END;

-- Readiness edges journal only small query metadata. The later dispatcher reads
-- the post-transaction scope clock, avoiding reliance on AFTER-trigger order.
CREATE TABLE inventory_matching_coverage_events (
 tenant TEXT NOT NULL, scope_id TEXT NOT NULL, stream_id TEXT NOT NULL, facet TEXT NOT NULL CHECK(facet IN('source','receipt')), partition_id TEXT NOT NULL,
 config_version INTEGER NOT NULL, published_run_id TEXT NOT NULL, coverage_version INTEGER NOT NULL CHECK(coverage_version>=0),
 work_version INTEGER NOT NULL DEFAULT 1 CHECK(work_version>0), completed_version INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant,scope_id,stream_id,facet,partition_id), FOREIGN KEY(tenant,scope_id,stream_id,facet,partition_id) REFERENCES inventory_coverage(tenant,scope_id,stream_id,facet,partition_id),
 FOREIGN KEY(tenant,published_run_id) REFERENCES inventory_runs(tenant,run_id), CHECK(completed_version>=0 AND completed_version<=work_version)
);
CREATE INDEX inventory_matching_coverage_event_pending ON inventory_matching_coverage_events(tenant,scope_id,config_version,stream_id,facet,partition_id) WHERE completed_version<work_version;
CREATE VIEW inventory_matching_recoverable_coverage AS
 SELECT c.*,s.provider FROM inventory_coverage c JOIN inventory_scopes s ON s.tenant=c.tenant AND s.scope_id=c.scope_id AND s.config_version=c.published_config_version
 JOIN inventory_runs r ON r.tenant=c.tenant AND r.run_id=c.published_run_id AND r.config_version=s.config_version AND r.mode='full' AND r.phase='complete' AND r.scope_id=c.scope_id AND r.stream_id=c.stream_id AND r.facet=c.facet AND r.partition_id=c.partition_id
 WHERE c.state='ready' AND c.kind='observed_selection' AND (
 (s.provider='lofi' AND c.facet='source' AND r.requires_catchup=1 AND json_array_length(r.required_streams)=2 AND EXISTS(SELECT 1 FROM json_each(r.required_streams) WHERE value='operations') AND EXISTS(SELECT 1 FROM json_each(r.required_streams) WHERE value='qsos'))
 OR (s.provider IN('qrz','lotw') AND c.facet='receipt' AND (s.provider='lotw' OR r.requires_catchup=1) AND json_array_length(r.required_streams)=1 AND json_extract(r.required_streams,'$[0]')='selection'));
CREATE TRIGGER inventory_matching_coverage_ready_insert AFTER INSERT ON inventory_coverage WHEN NEW.state='ready' AND NEW.facet IN('source','receipt') BEGIN
 INSERT INTO inventory_matching_coverage_events(tenant,scope_id,stream_id,facet,partition_id,config_version,published_run_id,coverage_version)
 SELECT c.tenant,c.scope_id,c.stream_id,c.facet,c.partition_id,c.published_config_version,c.published_run_id,c.version FROM inventory_matching_recoverable_coverage c
 WHERE c.tenant=NEW.tenant AND c.scope_id=NEW.scope_id AND c.stream_id=NEW.stream_id AND c.facet=NEW.facet AND c.partition_id=NEW.partition_id
 AND (EXISTS(SELECT 1 FROM inventory_matching_coverage_dependents d INDEXED BY inventory_matching_coverage_dependents_scope WHERE d.tenant=c.tenant AND d.scope_id=c.scope_id AND d.facet=c.facet) OR EXISTS(SELECT 1 FROM inventory_matching_coverage_events e WHERE e.tenant=c.tenant AND e.scope_id=c.scope_id AND e.stream_id=c.stream_id AND e.facet=c.facet AND e.partition_id=c.partition_id AND e.completed_version<e.work_version))
 ON CONFLICT(tenant,scope_id,stream_id,facet,partition_id) DO UPDATE SET config_version=excluded.config_version,published_run_id=excluded.published_run_id,coverage_version=excluded.coverage_version,work_version=inventory_matching_coverage_events.work_version+1;
END;
CREATE TRIGGER inventory_matching_coverage_ready_update AFTER UPDATE ON inventory_coverage WHEN NEW.state='ready' AND NEW.facet IN('source','receipt') AND (OLD.state!='ready' OR NEW.published_run_id IS NOT OLD.published_run_id OR NEW.published_config_version IS NOT OLD.published_config_version OR NEW.kind!=OLD.kind) BEGIN
 INSERT INTO inventory_matching_coverage_events(tenant,scope_id,stream_id,facet,partition_id,config_version,published_run_id,coverage_version)
 SELECT c.tenant,c.scope_id,c.stream_id,c.facet,c.partition_id,c.published_config_version,c.published_run_id,c.version FROM inventory_matching_recoverable_coverage c
 WHERE c.tenant=NEW.tenant AND c.scope_id=NEW.scope_id AND c.stream_id=NEW.stream_id AND c.facet=NEW.facet AND c.partition_id=NEW.partition_id
 AND (EXISTS(SELECT 1 FROM inventory_matching_coverage_dependents d INDEXED BY inventory_matching_coverage_dependents_scope WHERE d.tenant=c.tenant AND d.scope_id=c.scope_id AND d.facet=c.facet) OR EXISTS(SELECT 1 FROM inventory_matching_coverage_events e WHERE e.tenant=c.tenant AND e.scope_id=c.scope_id AND e.stream_id=c.stream_id AND e.facet=c.facet AND e.partition_id=c.partition_id AND e.completed_version<e.work_version))
 ON CONFLICT(tenant,scope_id,stream_id,facet,partition_id) DO UPDATE SET config_version=excluded.config_version,published_run_id=excluded.published_run_id,coverage_version=excluded.coverage_version,work_version=inventory_matching_coverage_events.work_version+1;
END;
CREATE TRIGGER inventory_matching_coverage_event_insert BEFORE INSERT ON inventory_matching_coverage_events BEGIN
 SELECT CASE WHEN NEW.work_version!=1 OR NEW.completed_version!=0 OR NOT EXISTS(SELECT 1 FROM inventory_matching_recoverable_coverage c WHERE c.tenant=NEW.tenant AND c.scope_id=NEW.scope_id AND c.stream_id=NEW.stream_id AND c.facet=NEW.facet AND c.partition_id=NEW.partition_id AND c.published_config_version=NEW.config_version AND c.published_run_id=NEW.published_run_id AND c.version=NEW.coverage_version) THEN RAISE(ABORT,'inventory matching coverage event invalid') END;
END;
CREATE TRIGGER inventory_matching_coverage_event_clock BEFORE UPDATE ON inventory_matching_coverage_events BEGIN
 SELECT CASE WHEN (NEW.tenant,NEW.scope_id,NEW.stream_id,NEW.facet,NEW.partition_id) IS NOT (OLD.tenant,OLD.scope_id,OLD.stream_id,OLD.facet,OLD.partition_id) OR NEW.work_version<OLD.work_version OR NEW.completed_version<OLD.completed_version THEN RAISE(ABORT,'inventory matching coverage event regressed') END;
 SELECT CASE WHEN NEW.work_version!=OLD.work_version AND (NEW.work_version!=OLD.work_version+1 OR NEW.completed_version!=OLD.completed_version OR NEW.coverage_version<OLD.coverage_version) THEN RAISE(ABORT,'inventory matching coverage event signal changed progress') END;
 SELECT CASE WHEN NEW.work_version=OLD.work_version AND (NEW.config_version,NEW.published_run_id,NEW.coverage_version) IS NOT (OLD.config_version,OLD.published_run_id,OLD.coverage_version) THEN RAISE(ABORT,'inventory matching coverage event binding changed') END;
 SELECT CASE WHEN NEW.work_version!=OLD.work_version AND NOT EXISTS(SELECT 1 FROM inventory_matching_recoverable_coverage c WHERE c.tenant=NEW.tenant AND c.scope_id=NEW.scope_id AND c.stream_id=NEW.stream_id AND c.facet=NEW.facet AND c.partition_id=NEW.partition_id AND c.published_config_version=NEW.config_version AND c.published_run_id=NEW.published_run_id AND c.version=NEW.coverage_version) THEN RAISE(ABORT,'inventory matching coverage event signal invalid') END;
END;
CREATE TRIGGER inventory_matching_coverage_event_progress BEFORE UPDATE ON inventory_matching_coverage_events WHEN NEW.work_version=OLD.work_version AND NEW.completed_version!=OLD.completed_version BEGIN SELECT RAISE(ABORT,'inventory matching coverage event publisher required'); END;
CREATE TRIGGER inventory_matching_coverage_event_delete BEFORE DELETE ON inventory_matching_coverage_events BEGIN SELECT RAISE(ABORT,'retained inventory matching coverage event clock'); END;
