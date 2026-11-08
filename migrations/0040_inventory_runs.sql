-- Stream progress remains authoritative. Runs bind a selection and retain its
-- observed membership; neither a delta nor a missing member invents a deletion.
CREATE TABLE inventory_runs (
 tenant TEXT NOT NULL, run_id TEXT NOT NULL, scope_id TEXT NOT NULL, stream_id TEXT NOT NULL,
 facet TEXT NOT NULL CHECK(facet IN ('source','receipt')), partition_id TEXT NOT NULL, partition_binding TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('full','delta')), requires_catchup INTEGER NOT NULL CHECK(requires_catchup IN (0,1)),
 config_version INTEGER NOT NULL, adapter_binding TEXT NOT NULL, query_binding TEXT NOT NULL,
 collection_binding TEXT NOT NULL, catchup_binding TEXT, fixed_query TEXT NOT NULL, required_streams TEXT NOT NULL,
 input_digest TEXT NOT NULL, start_sequence INTEGER NOT NULL, initial_stream_version INTEGER NOT NULL,
 expected_stream_version INTEGER NOT NULL, coverage_version INTEGER NOT NULL DEFAULT 0 CHECK(coverage_version>=0), version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 phase TEXT NOT NULL DEFAULT 'collecting' CHECK(phase IN ('collecting','catchup','quarantining','publishing','complete','held')),
 proposed_checkpoint TEXT, cursor_family TEXT, cursor_key TEXT,
 started_at INTEGER NOT NULL, phase_started_at INTEGER NOT NULL, position_started_at INTEGER NOT NULL, completed_at INTEGER, reason TEXT,
 PRIMARY KEY(tenant,run_id), UNIQUE(tenant,scope_id,stream_id,run_id),
 FOREIGN KEY(tenant,scope_id,stream_id) REFERENCES inventory_streams(tenant,scope_id,stream_id),
 CHECK(mode='full' OR requires_catchup=0), CHECK(requires_catchup=0 OR catchup_binding IS NOT NULL), CHECK(catchup_binding IS NULL OR catchup_binding!=collection_binding),
 CHECK(json_valid(fixed_query) AND json_valid(required_streams) AND json_type(required_streams)='array' AND json_array_length(required_streams) BETWEEN 1 AND 8),
 CHECK(proposed_checkpoint IS NULL OR json_valid(proposed_checkpoint)),
 CHECK((cursor_family IS NULL AND cursor_key IS NULL) OR (cursor_family IS NOT NULL AND cursor_key IS NOT NULL))
);
CREATE TABLE inventory_stream_jobs (
 tenant TEXT NOT NULL, scope_id TEXT NOT NULL, stream_id TEXT NOT NULL, active_run_id TEXT,
 work_version INTEGER NOT NULL DEFAULT 0 CHECK(work_version>=0),
 state TEXT NOT NULL DEFAULT 'idle' CHECK(state IN ('idle','ready','held')),
 next_due_at INTEGER NOT NULL DEFAULT 0, reason TEXT,
 PRIMARY KEY(tenant,scope_id,stream_id),
 FOREIGN KEY(tenant,scope_id,stream_id) REFERENCES inventory_streams(tenant,scope_id,stream_id),
 FOREIGN KEY(tenant,scope_id,stream_id,active_run_id) REFERENCES inventory_runs(tenant,scope_id,stream_id,run_id)
);
CREATE INDEX inventory_job_due ON inventory_stream_jobs(state,next_due_at,tenant,scope_id,stream_id);
CREATE TABLE inventory_run_membership (
 tenant TEXT NOT NULL, run_id TEXT NOT NULL, scope_id TEXT NOT NULL, entity_family TEXT NOT NULL, record_key TEXT NOT NULL, facet TEXT NOT NULL,
 facet_version INTEGER NOT NULL, revision TEXT NOT NULL, body_hash TEXT NOT NULL,
 accepted_sequence INTEGER NOT NULL, observed_at INTEGER NOT NULL, last_page_id TEXT NOT NULL,
 PRIMARY KEY(tenant,run_id,entity_family,record_key,facet),
 FOREIGN KEY(tenant,scope_id,entity_family,record_key,facet) REFERENCES inventory_record_facets(tenant,scope_id,entity_family,record_key,facet),
 FOREIGN KEY(tenant,run_id) REFERENCES inventory_runs(tenant,run_id)
);
CREATE TABLE inventory_partition_membership (
 tenant TEXT NOT NULL, scope_id TEXT NOT NULL, stream_id TEXT NOT NULL, facet TEXT NOT NULL, partition_id TEXT NOT NULL,
 entity_family TEXT NOT NULL, record_key TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('present','unresolved')), row_version INTEGER NOT NULL CHECK(row_version>0),
 facet_version INTEGER NOT NULL, last_accepted_sequence INTEGER NOT NULL, last_observed_at INTEGER NOT NULL, last_run_id TEXT NOT NULL,
 PRIMARY KEY(tenant,scope_id,stream_id,facet,partition_id,entity_family,record_key),
 FOREIGN KEY(tenant,scope_id,entity_family,record_key,facet) REFERENCES inventory_record_facets(tenant,scope_id,entity_family,record_key,facet),
 FOREIGN KEY(tenant,last_run_id) REFERENCES inventory_runs(tenant,run_id)
);
CREATE TABLE inventory_coverage (
 tenant TEXT NOT NULL, scope_id TEXT NOT NULL, stream_id TEXT NOT NULL, facet TEXT NOT NULL, partition_id TEXT NOT NULL,
 partition_binding TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0), epoch INTEGER NOT NULL DEFAULT 0 CHECK(epoch>=0),
 state TEXT NOT NULL DEFAULT 'partial' CHECK(state IN ('partial','collecting','ready','held')),
 kind TEXT NOT NULL DEFAULT 'positive_only' CHECK(kind IN ('positive_only','observed_selection')),
 building_run_id TEXT, published_run_id TEXT, published_config_version INTEGER, delta_run_id TEXT,
 completed_at INTEGER,
 PRIMARY KEY(tenant,scope_id,stream_id,facet,partition_id),
 FOREIGN KEY(tenant,scope_id,stream_id) REFERENCES inventory_streams(tenant,scope_id,stream_id),
 FOREIGN KEY(tenant,building_run_id) REFERENCES inventory_runs(tenant,run_id),
 FOREIGN KEY(tenant,published_run_id) REFERENCES inventory_runs(tenant,run_id),
 FOREIGN KEY(tenant,delta_run_id) REFERENCES inventory_runs(tenant,run_id),
 CHECK(state!='ready' OR (kind='observed_selection' AND published_run_id IS NOT NULL AND published_config_version IS NOT NULL))
);
CREATE TABLE inventory_wakeups (
 tenant TEXT NOT NULL, wakeup_id TEXT NOT NULL, scope_id TEXT NOT NULL, stream_id TEXT NOT NULL,
 run_id TEXT NOT NULL, work_version INTEGER NOT NULL, not_before INTEGER NOT NULL, published_at INTEGER,
 PRIMARY KEY(tenant,wakeup_id), UNIQUE(tenant,scope_id,stream_id,work_version),
 FOREIGN KEY(tenant,scope_id,stream_id) REFERENCES inventory_stream_jobs(tenant,scope_id,stream_id),
 FOREIGN KEY(tenant,run_id) REFERENCES inventory_runs(tenant,run_id)
);
CREATE INDEX inventory_wakeup_pending ON inventory_wakeups(published_at,not_before,tenant,wakeup_id);
CREATE TABLE ingestion_run_pages (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL, run_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('begin','page','quarantine','complete','defer','hold','admit')),
 expected_run_version INTEGER NOT NULL, expected_job_version INTEGER NOT NULL, expected_phase TEXT NOT NULL,
 request_binding TEXT, observed_complete INTEGER NOT NULL DEFAULT 0 CHECK(observed_complete IN (0,1)),
 completed_streams TEXT NOT NULL DEFAULT '[]', proposed_checkpoint TEXT,
 next_due_at INTEGER NOT NULL, cursor_family TEXT, cursor_key TEXT, quarantine_complete INTEGER NOT NULL DEFAULT 0 CHECK(quarantine_complete IN (0,1)),
 reason TEXT, replace_held INTEGER NOT NULL DEFAULT 0 CHECK(replace_held IN (0,1)),
 PRIMARY KEY(tenant,page_id),
 FOREIGN KEY(tenant,page_id) REFERENCES ingestion_pages(tenant,page_id), FOREIGN KEY(tenant,run_id) REFERENCES inventory_runs(tenant,run_id),
 CHECK(json_valid(completed_streams) AND json_type(completed_streams)='array'),
 CHECK(proposed_checkpoint IS NULL OR json_valid(proposed_checkpoint))
);
CREATE TABLE inventory_quarantine_rows (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL, entity_family TEXT NOT NULL, record_key TEXT NOT NULL, expected_version INTEGER NOT NULL,
 PRIMARY KEY(tenant,page_id,entity_family,record_key),
 FOREIGN KEY(tenant,page_id) REFERENCES ingestion_run_pages(tenant,page_id)
);
CREATE TRIGGER inventory_run_identity BEFORE UPDATE ON inventory_runs
 WHEN NEW.tenant!=OLD.tenant OR NEW.run_id!=OLD.run_id OR NEW.scope_id!=OLD.scope_id OR NEW.stream_id!=OLD.stream_id
 OR NEW.facet!=OLD.facet OR NEW.partition_id!=OLD.partition_id OR NEW.partition_binding!=OLD.partition_binding OR NEW.mode!=OLD.mode
 OR NEW.requires_catchup!=OLD.requires_catchup OR NEW.config_version!=OLD.config_version OR NEW.adapter_binding!=OLD.adapter_binding
 OR NEW.query_binding!=OLD.query_binding OR NEW.collection_binding!=OLD.collection_binding OR NEW.catchup_binding IS NOT OLD.catchup_binding
 OR NEW.fixed_query!=OLD.fixed_query OR NEW.required_streams!=OLD.required_streams OR NEW.input_digest!=OLD.input_digest
 OR NEW.start_sequence!=OLD.start_sequence OR NEW.initial_stream_version!=OLD.initial_stream_version OR NEW.started_at!=OLD.started_at
 BEGIN
 SELECT RAISE(ABORT,'immutable inventory run binding');
 END;
CREATE TRIGGER inventory_run_version BEFORE UPDATE ON inventory_runs WHEN NEW.version<=OLD.version OR NEW.expected_stream_version<OLD.expected_stream_version OR NEW.coverage_version<OLD.coverage_version OR OLD.phase IN ('complete','held') BEGIN SELECT RAISE(ABORT,'inventory run version changed'); END;
CREATE TRIGGER inventory_job_monotonic BEFORE UPDATE ON inventory_stream_jobs WHEN NEW.work_version<=OLD.work_version BEGIN SELECT RAISE(ABORT,'inventory job version changed'); END;
CREATE TRIGGER inventory_coverage_monotonic BEFORE UPDATE ON inventory_coverage WHEN NEW.version<=OLD.version OR NEW.epoch<OLD.epoch OR NEW.partition_binding!=OLD.partition_binding BEGIN SELECT RAISE(ABORT,'inventory coverage version changed'); END;
CREATE TRIGGER inventory_coverage_no_delete BEFORE DELETE ON inventory_coverage BEGIN SELECT RAISE(ABORT,'inventory coverage generation retained'); END;
CREATE TRIGGER inventory_partition_no_delete BEFORE DELETE ON inventory_partition_membership BEGIN SELECT RAISE(ABORT,'inventory membership generation retained'); END;
CREATE TRIGGER inventory_partition_late_history BEFORE INSERT ON inventory_partition_membership BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_stream_jobs j JOIN inventory_runs r ON r.tenant=j.tenant AND r.run_id=j.active_run_id WHERE j.tenant=NEW.tenant AND j.scope_id=NEW.scope_id AND j.stream_id=NEW.stream_id AND r.facet=NEW.facet AND r.partition_id=NEW.partition_id AND r.phase IN ('quarantining','publishing') AND r.cursor_family IS NOT NULL AND (NEW.entity_family,NEW.record_key)<=(r.cursor_family,r.cursor_key) AND NEW.last_accepted_sequence<=r.start_sequence)
 THEN RAISE(ABORT,'historical inventory member behind cursor') END;
END;
CREATE TRIGGER inventory_partition_monotonic BEFORE UPDATE ON inventory_partition_membership
 WHEN NEW.tenant!=OLD.tenant OR NEW.scope_id!=OLD.scope_id OR NEW.stream_id!=OLD.stream_id OR NEW.facet!=OLD.facet OR NEW.partition_id!=OLD.partition_id
 OR NEW.entity_family!=OLD.entity_family OR NEW.record_key!=OLD.record_key OR NEW.row_version<=OLD.row_version OR NEW.last_accepted_sequence<OLD.last_accepted_sequence
 BEGIN
 SELECT RAISE(ABORT,'inventory membership version changed');
 END;
CREATE TRIGGER inventory_stream_progress_version BEFORE UPDATE ON inventory_streams
 WHEN (NEW.resume_state!=OLD.resume_state OR NEW.committed_checkpoint!=OLD.committed_checkpoint) AND NEW.checkpoint_version<=OLD.checkpoint_version
 BEGIN
 SELECT RAISE(ABORT,'inventory progress version required');
 END;
-- Query authority changes invalidate active runs. Display/template/login-check
-- metadata and same-account QRZ/LoTW password renewal do not change read scope.
CREATE TRIGGER inventory_connection_query_changed AFTER UPDATE ON connections
 WHEN NEW.kind!=OLD.kind OR NEW.remote_identity!=OLD.remote_identity
 OR (NEW.kind='lofi' AND NEW.credential_version IS NOT OLD.credential_version)
 OR (NEW.kind='qrz' AND (json_extract(NEW.config,'$.bookId') IS NOT json_extract(OLD.config,'$.bookId') OR json_extract(NEW.config,'$.stationCallsign') IS NOT json_extract(OLD.config,'$.stationCallsign') OR json_extract(NEW.config,'$.startDate') IS NOT json_extract(OLD.config,'$.startDate') OR json_extract(NEW.config,'$.endDate') IS NOT json_extract(OLD.config,'$.endDate')))
 OR (NEW.kind='lotw' AND json_extract(NEW.config,'$.readAccess') IS NOT json_extract(OLD.config,'$.readAccess'))
 BEGIN
 UPDATE inventory_scopes SET config_version=config_version+1,state='held' WHERE tenant=NEW.tenant AND connection_id=NEW.id;
 END;
CREATE TRIGGER inventory_scope_query_changed AFTER UPDATE ON inventory_scopes WHEN NEW.config_version!=OLD.config_version BEGIN
 UPDATE inventory_runs SET version=version+1,coverage_version=coverage_version+1,phase='held',reason='scope_changed' WHERE tenant=NEW.tenant AND scope_id=NEW.scope_id AND phase NOT IN ('complete','held');
 UPDATE inventory_stream_jobs SET work_version=work_version+1,state='held',reason='scope_changed' WHERE tenant=NEW.tenant AND scope_id=NEW.scope_id;
 UPDATE inventory_coverage SET version=version+1,state='held' WHERE tenant=NEW.tenant AND scope_id=NEW.scope_id;
END;
CREATE TRIGGER ingestion_run_page_immutable BEFORE UPDATE ON ingestion_run_pages BEGIN SELECT RAISE(ABORT,'immutable inventory run page'); END;

CREATE TRIGGER inventory_run_page_guard BEFORE INSERT ON ingestion_page_guards BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ingestion_pages p JOIN inventory_stream_jobs j ON j.tenant=p.tenant AND j.scope_id=p.scope_id AND j.stream_id=p.stream_id WHERE p.tenant=NEW.tenant AND p.page_id=NEW.page_id)
  AND NOT EXISTS(SELECT 1 FROM ingestion_run_pages WHERE tenant=NEW.tenant AND page_id=NEW.page_id)
  THEN RAISE(ABORT,'managed inventory stream requires run') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM ingestion_run_pages x JOIN ingestion_pages p ON p.tenant=x.tenant AND p.page_id=x.page_id
  JOIN inventory_runs r ON r.tenant=x.tenant AND r.run_id=x.run_id
  JOIN inventory_scopes scope ON scope.tenant=r.tenant AND scope.scope_id=r.scope_id
  JOIN inventory_stream_jobs j ON j.tenant=r.tenant AND j.scope_id=r.scope_id AND j.stream_id=r.stream_id
  WHERE x.tenant=NEW.tenant AND x.page_id=NEW.page_id AND (
   r.scope_id!=p.scope_id OR r.stream_id!=p.stream_id OR r.config_version!=p.expected_config_version OR r.adapter_binding!=p.adapter_binding OR r.query_binding!=p.query_binding
   OR r.version!=x.expected_run_version OR j.work_version!=x.expected_job_version OR r.expected_stream_version!=p.expected_stream_version OR r.phase!=x.expected_phase
   OR (x.action='begin' AND (r.version!=0 OR (j.active_run_id IS NOT NULL AND NOT (x.replace_held=1 AND j.state='held' AND EXISTS(SELECT 1 FROM inventory_runs prior WHERE prior.tenant=j.tenant AND prior.run_id=j.active_run_id AND prior.phase='held'))) OR (j.state='held' AND x.replace_held=0) OR (x.replace_held=1 AND r.mode!='full')))
   OR (x.action!='begin' AND (j.active_run_id IS NOT r.run_id OR j.state!='ready'))
   OR r.facet!=CASE scope.provider WHEN 'lofi' THEN 'source' ELSE 'receipt' END
   OR (scope.provider='lofi' AND r.mode='full' AND r.requires_catchup!=1)
   OR (scope.provider='lofi' AND (json_array_length(r.required_streams)!=2 OR NOT EXISTS(SELECT 1 FROM json_each(r.required_streams) WHERE value='operations') OR NOT EXISTS(SELECT 1 FROM json_each(r.required_streams) WHERE value='qsos')))
   OR (scope.provider!='lofi' AND (json_array_length(r.required_streams)!=1 OR NOT EXISTS(SELECT 1 FROM json_each(r.required_streams) WHERE value='selection')))
   OR (x.action!='page' AND p.raw_count!=0)
   OR (x.action!='complete' AND p.next_checkpoint IS NOT NULL)
   OR (x.action IN ('page','admit') AND (r.phase NOT IN ('collecting','catchup') OR p.request_started_at<r.position_started_at OR x.request_binding IS NOT CASE r.phase WHEN 'collecting' THEN r.collection_binding ELSE r.catchup_binding END OR EXISTS(SELECT 1 FROM ingestion_page_rows s WHERE s.tenant=p.tenant AND s.page_id=p.page_id AND s.facet!=r.facet)))
   OR (x.action='quarantine' AND (r.mode!='full' OR r.phase!='quarantining'))
   OR (x.action='complete' AND (r.phase!='publishing' OR p.next_checkpoint IS NOT r.proposed_checkpoint))
   OR (x.action IN ('defer','hold') AND r.phase IN ('complete','held'))
   OR NOT EXISTS(SELECT 1 FROM inventory_coverage c WHERE c.tenant=r.tenant AND c.scope_id=r.scope_id AND c.stream_id=r.stream_id AND c.facet=r.facet AND c.partition_id=r.partition_id AND c.partition_binding=r.partition_binding AND (x.action='begin' OR c.version=r.coverage_version AND c.building_run_id=r.run_id AND c.state='collecting'))
  )
 ) THEN RAISE(ABORT,'inventory run changed') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM ingestion_run_pages x JOIN inventory_runs r ON r.tenant=x.tenant AND r.run_id=x.run_id
  WHERE x.tenant=NEW.tenant AND x.page_id=NEW.page_id AND x.observed_complete=1
   AND EXISTS(SELECT 1 FROM json_each(r.required_streams) required WHERE NOT EXISTS(SELECT 1 FROM json_each(x.completed_streams) done WHERE done.value=required.value))
 ) THEN RAISE(ABORT,'inventory completion vector incomplete') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM inventory_quarantine_rows q JOIN ingestion_run_pages x ON x.tenant=q.tenant AND x.page_id=q.page_id
  JOIN inventory_runs r ON r.tenant=x.tenant AND r.run_id=x.run_id
  LEFT JOIN inventory_partition_membership m ON m.tenant=r.tenant AND m.scope_id=r.scope_id AND m.stream_id=r.stream_id AND m.facet=r.facet AND m.partition_id=r.partition_id AND m.entity_family=q.entity_family AND m.record_key=q.record_key
  WHERE q.tenant=NEW.tenant AND q.page_id=NEW.page_id AND (x.action!='quarantine' OR m.row_version IS NOT q.expected_version)
 ) THEN RAISE(ABORT,'inventory quarantine member changed') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM ingestion_run_pages x JOIN inventory_runs r ON r.tenant=x.tenant AND r.run_id=x.run_id
  WHERE x.tenant=NEW.tenant AND x.page_id=NEW.page_id AND x.action='quarantine' AND (
   (x.quarantine_complete=1 AND ((SELECT count(*) FROM inventory_quarantine_rows q WHERE q.tenant=x.tenant AND q.page_id=x.page_id)!=0 OR EXISTS(SELECT 1 FROM inventory_partition_membership m WHERE m.tenant=r.tenant AND m.scope_id=r.scope_id AND m.stream_id=r.stream_id AND m.facet=r.facet AND m.partition_id=r.partition_id AND (m.entity_family,m.record_key)>(coalesce(r.cursor_family,''),coalesce(r.cursor_key,'')))))
   OR (x.quarantine_complete=0 AND (x.cursor_family IS NULL OR x.cursor_key IS NULL
    OR (r.cursor_family IS NOT NULL AND (x.cursor_family,x.cursor_key)<=(r.cursor_family,r.cursor_key))
    OR (SELECT count(*) FROM inventory_partition_membership m WHERE m.tenant=r.tenant AND m.scope_id=r.scope_id AND m.stream_id=r.stream_id AND m.facet=r.facet AND m.partition_id=r.partition_id AND (m.entity_family,m.record_key)>(coalesce(r.cursor_family,''),coalesce(r.cursor_key,'')) AND (m.entity_family,m.record_key)<=(x.cursor_family,x.cursor_key))!=(SELECT count(*) FROM inventory_quarantine_rows q WHERE q.tenant=x.tenant AND q.page_id=x.page_id)
    OR NOT EXISTS(SELECT 1 FROM inventory_quarantine_rows q WHERE q.tenant=x.tenant AND q.page_id=x.page_id AND q.entity_family=x.cursor_family AND q.record_key=x.cursor_key)))
  )
 ) THEN RAISE(ABORT,'inventory quarantine cursor changed') END;
END;
CREATE TRIGGER inventory_run_page_commit BEFORE UPDATE ON ingestion_pages WHEN NEW.state='committed' BEGIN
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM ingestion_run_pages x JOIN inventory_runs r ON r.tenant=x.tenant AND r.run_id=x.run_id
  JOIN inventory_stream_jobs j ON j.tenant=r.tenant AND j.scope_id=r.scope_id AND j.stream_id=r.stream_id
  JOIN inventory_coverage c ON c.tenant=r.tenant AND c.scope_id=r.scope_id AND c.stream_id=r.stream_id AND c.facet=r.facet AND c.partition_id=r.partition_id
  WHERE x.tenant=OLD.tenant AND x.page_id=OLD.page_id AND (
   x.action='admit' OR r.version!=x.expected_run_version+1 OR r.expected_stream_version!=OLD.expected_stream_version+1 OR j.work_version!=x.expected_job_version+1
   OR c.version!=r.coverage_version
   OR r.phase!=CASE x.action WHEN 'begin' THEN 'collecting' WHEN 'complete' THEN 'complete' WHEN 'hold' THEN 'held' WHEN 'quarantine' THEN CASE WHEN x.quarantine_complete=1 THEN 'publishing' ELSE 'quarantining' END WHEN 'page' THEN CASE WHEN x.observed_complete=0 THEN x.expected_phase WHEN r.mode='delta' THEN 'publishing' WHEN x.expected_phase='collecting' AND r.requires_catchup=1 THEN 'catchup' ELSE 'quarantining' END ELSE x.expected_phase END
   OR (x.action NOT IN ('complete','hold') AND j.active_run_id IS NOT r.run_id)
   OR (x.action NOT IN ('complete','hold') AND (c.state!='collecting' OR c.building_run_id IS NOT r.run_id))
   OR (x.action='complete' AND (r.phase!='complete' OR j.active_run_id IS NOT NULL OR j.state!='idle'))
   OR (x.action='complete' AND (c.building_run_id IS NOT NULL OR (r.mode='full' AND (c.published_run_id IS NOT r.run_id OR c.published_config_version IS NOT r.config_version OR c.state!='ready' OR c.kind!='observed_selection')) OR (r.mode='delta' AND (c.delta_run_id IS NOT r.run_id OR c.state!=CASE WHEN c.published_run_id IS NOT NULL AND c.published_config_version=r.config_version THEN 'ready' ELSE 'partial' END))))
   OR (x.action='hold' AND (r.phase!='held' OR j.state!='held'))
   OR (x.action='hold' AND c.state!='held')
   OR NOT EXISTS(SELECT 1 FROM inventory_wakeups w WHERE w.tenant=j.tenant AND w.scope_id=j.scope_id AND w.stream_id=j.stream_id AND w.work_version=j.work_version AND w.run_id=r.run_id AND w.not_before=j.next_due_at)
  )
 ) THEN RAISE(ABORT,'inventory run publication incomplete') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM ingestion_run_pages x WHERE x.tenant=OLD.tenant AND x.page_id=OLD.page_id AND x.action='page'
  AND (SELECT count(*) FROM ingestion_page_rows s CROSS JOIN inventory_run_membership m WHERE s.tenant=x.tenant AND s.page_id=x.page_id AND s.accepted=1 AND m.tenant=s.tenant AND m.run_id=x.run_id AND m.entity_family=s.entity_family AND m.record_key=s.record_key AND m.facet=s.facet AND m.last_page_id=x.page_id)!=OLD.accepted_count
 ) THEN RAISE(ABORT,'inventory run membership incomplete') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM ingestion_run_pages x JOIN inventory_runs r ON r.tenant=x.tenant AND r.run_id=x.run_id
  WHERE x.tenant=OLD.tenant AND x.page_id=OLD.page_id AND x.action='page'
   AND (SELECT count(*) FROM ingestion_page_rows s CROSS JOIN inventory_partition_membership m WHERE s.tenant=x.tenant AND s.page_id=x.page_id AND s.accepted=1 AND m.tenant=s.tenant AND m.scope_id=r.scope_id AND m.stream_id=r.stream_id AND m.facet=s.facet AND m.partition_id=r.partition_id AND m.entity_family=s.entity_family AND m.record_key=s.record_key AND m.last_run_id=r.run_id AND m.last_accepted_sequence=OLD.expected_sequence+1 AND m.state='present')!=OLD.accepted_count
 ) THEN RAISE(ABORT,'inventory partition membership incomplete') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM inventory_quarantine_rows q CROSS JOIN ingestion_run_pages x CROSS JOIN inventory_runs r CROSS JOIN inventory_partition_membership m CROSS JOIN inventory_record_facets f
  LEFT JOIN inventory_run_membership seen ON seen.tenant=r.tenant AND seen.run_id=r.run_id AND seen.entity_family=q.entity_family AND seen.record_key=q.record_key AND seen.facet=r.facet
  WHERE q.tenant=OLD.tenant AND q.page_id=OLD.page_id AND x.tenant=q.tenant AND x.page_id=q.page_id AND r.tenant=x.tenant AND r.run_id=x.run_id
   AND m.tenant=r.tenant AND m.scope_id=r.scope_id AND m.stream_id=r.stream_id AND m.facet=r.facet AND m.partition_id=r.partition_id AND m.entity_family=q.entity_family AND m.record_key=q.record_key
   AND f.tenant=m.tenant AND f.scope_id=m.scope_id AND f.entity_family=m.entity_family AND f.record_key=m.record_key AND f.facet=m.facet
   AND ((seen.run_id IS NOT NULL AND (m.state!='present' OR m.facet_version!=seen.facet_version OR m.last_accepted_sequence!=seen.accepted_sequence OR m.last_observed_at!=seen.observed_at))
    OR (seen.run_id IS NULL AND (m.last_run_id=r.run_id OR (m.last_accepted_sequence<=r.start_sequence AND m.state!='unresolved')))
    OR (r.facet='source' AND f.last_accepted_sequence>r.start_sequence AND f.last_observed_at>=r.started_at AND (seen.facet_version IS NOT f.row_version OR m.facet_version!=f.row_version)))
 ) THEN RAISE(ABORT,'inventory quarantine publication incomplete') END;
END;
