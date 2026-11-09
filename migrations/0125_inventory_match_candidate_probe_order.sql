-- Check the indexed candidate union in probe order. Each probe supplies its
-- search scope once for all eight tokens; membership remains per probe.
DROP TRIGGER inventory_match_guard;
CREATE TRIGGER inventory_match_guard BEFORE INSERT ON inventory_match_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_match_sets h WHERE h.tenant=NEW.tenant AND h.set_id=NEW.set_id AND h.recovery_count IS NOT NULL AND h.recovery_count=(SELECT count(*) FROM inventory_match_recovery q WHERE q.tenant=h.tenant AND q.set_id=h.set_id) AND coalesce((SELECT max(recovery_id) FROM inventory_match_recovery q WHERE q.tenant=h.tenant AND q.set_id=h.set_id),-1)=h.recovery_count-1) THEN RAISE(ABORT,'inventory matching coverage recovery missing') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_match_recovery_source_requirements s WHERE s.tenant=NEW.tenant AND s.set_id=NEW.set_id AND NOT EXISTS(SELECT 1 FROM inventory_match_recovery q WHERE q.tenant=s.tenant AND q.set_id=s.set_id AND q.scope_id=s.scope_id AND q.facet='source')) OR EXISTS(SELECT 1 FROM inventory_match_recovery_receipt_requirements r WHERE r.tenant=NEW.tenant AND r.set_id=NEW.set_id AND NOT EXISTS(SELECT 1 FROM inventory_match_recovery q WHERE q.tenant=r.tenant AND q.set_id=r.set_id AND q.subject_scope=r.source_scope AND q.subject_key=r.record_key AND q.facet='receipt')) THEN RAISE(ABORT,'inventory matching coverage recovery incomplete') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_matching_stale_coverage_clocks WHERE tenant=NEW.tenant AND set_id=NEW.set_id) THEN RAISE(ABORT,'inventory matching coverage set changed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_match_work_claims c WHERE c.tenant=NEW.tenant AND c.set_id=NEW.set_id AND c.row_count!=(SELECT count(*) FROM inventory_match_work_rows WHERE tenant=c.tenant AND set_id=c.set_id)) THEN RAISE(ABORT,'inventory matching work claim incomplete') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_match_work_claims WHERE (tenant,set_id)=(NEW.tenant,NEW.set_id)) AND EXISTS(SELECT 1 FROM inventory_match_work_rows q JOIN inventory_match_sets h ON h.tenant=q.tenant AND h.set_id=q.set_id LEFT JOIN matching_work w ON w.tenant=q.tenant AND w.generation_id=q.generation_id AND w.destination=q.destination AND w.source_scope=q.source_scope AND w.record_key=q.record_key WHERE q.tenant=NEW.tenant AND q.set_id=NEW.set_id AND (w.record_key IS NULL OR w.work_version!=q.work_version OR w.completed_version!=q.completed_version OR w.completed_version>=w.work_version OR w.source_config_version!=q.source_config_version OR w.destination_config_version!=q.destination_config_version OR w.due_at!=q.due_at OR w.due_at>h.prepared_at OR NOT EXISTS(SELECT 1 FROM inventory_matching_source_routes r WHERE r.tenant=q.tenant AND r.generation_id=q.generation_id AND r.destination=q.destination AND r.source_scope=q.source_scope AND r.source_config_version=q.source_config_version AND r.destination_config_version=q.destination_config_version))) THEN RAISE(ABORT,'inventory matching claimed work changed') END;
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
 OR (SELECT count(*)=8
      AND count(*) FILTER (WHERE t.key_class='call_and_time')=3
      AND count(*) FILTER (WHERE t.key_class='time_only')=3
      AND count(*) FILTER (WHERE t.key_class='call_only')=1
      AND count(*) FILTER (WHERE t.key_class='unknown')=1
     FROM inventory_match_tokens t WHERE (t.tenant,t.set_id,t.probe_id)=(p.tenant,p.set_id,p.probe_id))!=1
 )) THEN RAISE(ABORT,'inventory match probe incomplete') END;
 -- Compare both sides of each complete coarse candidate set, independently of
 -- application digests or the selected positive match.
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_match_sets h CROSS JOIN inventory_match_probes p CROSS JOIN inventory_match_tokens t
 CROSS JOIN comparison_index i INDEXED BY comparison_bucket
 WHERE (h.tenant,h.set_id)=(NEW.tenant,NEW.set_id) AND (p.tenant,p.set_id)=(h.tenant,h.set_id)
 AND (t.tenant,t.set_id,t.probe_id)=(p.tenant,p.set_id,p.probe_id)
 AND (i.tenant,i.generation_id,i.scope_id,i.key_class,i.bucket_hash)=(t.tenant,h.generation_id,p.search_scope,t.key_class,t.bucket_hash)
 AND NOT EXISTS(SELECT 1 FROM inventory_match_candidates c WHERE c.tenant=t.tenant AND c.set_id=t.set_id AND c.probe_id=t.probe_id AND c.scope_id=i.scope_id AND c.record_key=i.record_key AND c.facet=i.facet))
 OR EXISTS(SELECT 1 FROM inventory_match_candidates c JOIN inventory_match_probes p ON p.tenant=c.tenant AND p.set_id=c.set_id AND p.probe_id=c.probe_id JOIN inventory_match_sets h ON h.tenant=p.tenant AND h.set_id=p.set_id
 WHERE c.tenant=NEW.tenant AND c.set_id=NEW.set_id AND (c.scope_id!=p.search_scope OR c.facet!=CASE p.direction WHEN 'forward' THEN 'receipt' ELSE 'source' END OR NOT EXISTS(
 SELECT 1 FROM comparison_index i JOIN inventory_match_tokens t ON t.tenant=c.tenant AND t.set_id=c.set_id AND t.probe_id=c.probe_id AND t.key_class=i.key_class AND t.bucket_hash=i.bucket_hash WHERE i.tenant=c.tenant AND i.generation_id=h.generation_id AND i.scope_id=c.scope_id AND i.record_key=c.record_key AND i.facet=c.facet))) THEN RAISE(ABORT,'inventory match candidate closure incomplete') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_match_rows q JOIN inventory_match_sets h ON h.tenant=q.tenant AND h.set_id=q.set_id LEFT JOIN match_results old ON old.tenant=q.tenant AND old.destination=h.destination AND old.source_scope=q.source_scope AND old.record_key=q.record_key
 WHERE q.tenant=NEW.tenant AND q.set_id=NEW.set_id AND (coalesce(old.version,0)!=q.expected_version OR NOT EXISTS(SELECT 1 FROM inventory_match_scopes s WHERE s.tenant=q.tenant AND s.set_id=q.set_id AND s.scope_id=q.source_scope AND s.source=1 AND s.provider='lofi') OR NOT EXISTS(SELECT 1 FROM inventory_match_records r WHERE r.tenant=q.tenant AND r.set_id=q.set_id AND r.scope_id=q.source_scope AND r.record_key=q.record_key AND r.facet='source')
 OR (q.state='excluded' AND NOT EXISTS(SELECT 1 FROM inventory_match_records r WHERE r.tenant=q.tenant AND r.set_id=q.set_id AND r.scope_id=q.source_scope AND r.record_key=q.record_key AND r.projection_state='excluded'))
 OR (q.state NOT IN('incomplete','excluded') AND (
 json_array_length(q.required_coverage)=0 OR EXISTS(SELECT 1 FROM json_each(q.required_coverage) required WHERE NOT EXISTS(
  SELECT 1 FROM inventory_match_coverage c WHERE c.tenant=q.tenant AND c.set_id=q.set_id AND c.scope_id=h.destination AND c.facet='receipt'
  AND c.stream_id=CASE WHEN json_valid(required.value) THEN json_extract(required.value,'$[1]') END
  AND c.partition_id=CASE WHEN json_valid(required.value) THEN json_extract(required.value,'$[3]') END
  AND c.state='ready' AND json_array(c.scope_id,c.stream_id,c.facet,c.partition_id)=required.value))
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
