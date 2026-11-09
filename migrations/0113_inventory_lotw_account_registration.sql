CREATE TABLE inventory_lotw_account_registration_progress (
 id INTEGER PRIMARY KEY CHECK(id=1),
 last_tenant TEXT NOT NULL,
 last_connection TEXT NOT NULL
);
INSERT INTO inventory_lotw_account_registration_progress VALUES(1,'','');

-- A scope change fences the old run. An account receipt stream can only
-- restart as a delta and must resume its own committed receive timestamp.
DROP TRIGGER inventory_run_page_guard;
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
   OR (x.action='begin' AND (r.version!=0 OR (j.active_run_id IS NOT NULL AND NOT (x.replace_held=1 AND j.state='held' AND EXISTS(SELECT 1 FROM inventory_runs prior WHERE prior.tenant=j.tenant AND prior.run_id=j.active_run_id AND prior.phase='held'))) OR (j.state='held' AND x.replace_held=0) OR (x.replace_held=1 AND r.mode!='full' AND NOT EXISTS(
    SELECT 1 FROM inventory_streams t
    WHERE (t.tenant,t.scope_id,t.stream_id)=(r.tenant,r.scope_id,r.stream_id)
     AND scope.provider='lotw' AND scope.runtime_version>0 AND j.reason='scope_changed'
     AND json_extract(r.fixed_query,'$.provider')='lotw'
     AND json_extract(r.fixed_query,'$.query.kind')='account_received'
     AND p.next_resume='{}'
     AND (
       (t.committed_checkpoint='{}' AND json_extract(r.fixed_query,'$.query.receivedSince')=json_extract(r.fixed_query,'$.query.initialReceivedSince'))
       OR (json_extract(t.committed_checkpoint,'$.selection')=json_remove(json_extract(r.fixed_query,'$.query'),'$.receivedSince')
        AND json_extract(t.committed_checkpoint,'$.receivedThrough')=json_extract(r.fixed_query,'$.query.receivedSince'))
     )
   ))))
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
