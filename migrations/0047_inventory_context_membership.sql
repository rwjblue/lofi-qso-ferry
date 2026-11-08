-- Membership uncertainty is an input change, even when retained bytes agree.
-- Stage both semantic and membership domains before incrementing each once.
CREATE TABLE inventory_membership_versions (
 tenant TEXT NOT NULL, scope_id TEXT NOT NULL, entity_family TEXT NOT NULL, record_key TEXT NOT NULL, facet TEXT NOT NULL CHECK(facet='source'),
 version INTEGER NOT NULL CHECK(version>0), PRIMARY KEY(tenant,scope_id,entity_family,record_key,facet),
 FOREIGN KEY(tenant,scope_id,entity_family,record_key,facet) REFERENCES inventory_record_facets(tenant,scope_id,entity_family,record_key,facet)
);
CREATE TRIGGER inventory_membership_version_monotonic BEFORE UPDATE ON inventory_membership_versions WHEN NEW.version<=OLD.version BEGIN SELECT RAISE(ABORT,'inventory membership version required'); END;
CREATE TRIGGER inventory_membership_version_retained BEFORE DELETE ON inventory_membership_versions BEGIN SELECT RAISE(ABORT,'inventory membership version retained'); END;
CREATE TABLE ingestion_context_pages (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL, PRIMARY KEY(tenant,page_id),
 FOREIGN KEY(tenant,page_id) REFERENCES ingestion_pages(tenant,page_id)
);
CREATE TABLE ingestion_page_domains (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL, operation_key TEXT NOT NULL, expected_version INTEGER NOT NULL CHECK(expected_version>=0),
 PRIMARY KEY(tenant,page_id,operation_key), FOREIGN KEY(tenant,page_id) REFERENCES ingestion_context_pages(tenant,page_id)
);
CREATE TABLE ingestion_membership_effects (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL, entity_family TEXT NOT NULL, record_key TEXT NOT NULL, facet TEXT NOT NULL CHECK(facet='source'),
 subtype TEXT NOT NULL, parent_key TEXT, before_state TEXT NOT NULL CHECK(before_state IN ('missing','present','unresolved')),
 after_state TEXT NOT NULL CHECK(after_state IN ('present','unresolved')), expected_version INTEGER NOT NULL CHECK(expected_version>=0),
 PRIMARY KEY(tenant,page_id,entity_family,record_key,facet), FOREIGN KEY(tenant,page_id) REFERENCES ingestion_context_pages(tenant,page_id),
 CHECK(before_state!=after_state)
);
-- Consumers always restrict this relation to the current bounded page.
CREATE VIEW ingestion_source_membership_changes AS
 SELECT s.tenant,s.page_id,s.entity_family,s.record_key,s.facet,s.subtype,s.parent_key,coalesce(m.state,'missing') AS before_state,'present' AS after_state
 FROM ingestion_page_rows s CROSS JOIN ingestion_pages p CROSS JOIN ingestion_run_pages x CROSS JOIN inventory_runs r
 LEFT JOIN inventory_partition_membership m ON m.tenant=p.tenant AND m.scope_id=p.scope_id AND m.stream_id=p.stream_id AND m.facet=s.facet AND m.partition_id=r.partition_id AND m.entity_family=s.entity_family AND m.record_key=s.record_key
 WHERE p.tenant=s.tenant AND p.page_id=s.page_id AND x.tenant=p.tenant AND x.page_id=p.page_id AND r.tenant=x.tenant AND r.run_id=x.run_id AND x.action='page' AND s.facet='source' AND s.accepted=1 AND coalesce(m.state,'missing')!='present'
 UNION ALL
 SELECT q.tenant,q.page_id,q.entity_family,q.record_key,r.facet,e.subtype,e.parent_key,m.state,
  CASE WHEN seen.run_id IS NOT NULL OR (f.last_accepted_sequence>r.start_sequence AND f.last_observed_at>=r.started_at) THEN 'present' WHEN m.last_accepted_sequence<=r.start_sequence THEN 'unresolved' ELSE m.state END
 FROM inventory_quarantine_rows q CROSS JOIN ingestion_run_pages x CROSS JOIN inventory_runs r CROSS JOIN ingestion_pages p
 JOIN inventory_partition_membership m ON m.tenant=r.tenant AND m.scope_id=r.scope_id AND m.stream_id=r.stream_id AND m.facet=r.facet AND m.partition_id=r.partition_id AND m.entity_family=q.entity_family AND m.record_key=q.record_key
 JOIN inventory_records e ON e.tenant=m.tenant AND e.scope_id=m.scope_id AND e.entity_family=m.entity_family AND e.record_key=m.record_key
 JOIN inventory_record_facets f ON f.tenant=m.tenant AND f.scope_id=m.scope_id AND f.entity_family=m.entity_family AND f.record_key=m.record_key AND f.facet=m.facet
 LEFT JOIN inventory_run_membership seen ON seen.tenant=r.tenant AND seen.run_id=r.run_id AND seen.entity_family=q.entity_family AND seen.record_key=q.record_key AND seen.facet=r.facet
 WHERE x.tenant=q.tenant AND x.page_id=q.page_id AND r.tenant=x.tenant AND r.run_id=x.run_id AND p.tenant=x.tenant AND p.page_id=x.page_id AND x.action='quarantine' AND r.facet='source'
  AND m.state!=CASE WHEN seen.run_id IS NOT NULL OR (f.last_accepted_sequence>r.start_sequence AND f.last_observed_at>=r.started_at) THEN 'present' WHEN m.last_accepted_sequence<=r.start_sequence THEN 'unresolved' ELSE m.state END;
CREATE VIEW ingestion_required_context_domains AS
 SELECT r.tenant,r.page_id,r.record_key AS operation_key FROM ingestion_page_rows r WHERE r.semantic_changed=1 AND r.entity_family='operation'
 UNION
 SELECT r.tenant,r.page_id,r.parent_key FROM ingestion_page_rows r WHERE r.semantic_changed=1 AND r.subtype='event' AND r.parent_key IS NOT NULL
 UNION
 SELECT r.tenant,r.page_id,e.parent_key FROM ingestion_page_rows r CROSS JOIN ingestion_pages p CROSS JOIN inventory_records e WHERE r.semantic_changed=1 AND r.tenant=p.tenant AND r.page_id=p.page_id AND e.tenant=p.tenant AND e.scope_id=p.scope_id AND e.entity_family=r.entity_family AND e.record_key=r.record_key AND e.subtype='event' AND e.parent_key IS NOT NULL
 UNION
 SELECT tenant,page_id,CASE WHEN entity_family='operation' THEN record_key ELSE parent_key END FROM ingestion_membership_effects WHERE entity_family='operation' OR (subtype='event' AND parent_key IS NOT NULL);
CREATE TRIGGER ingestion_context_guard BEFORE INSERT ON ingestion_page_guards
 WHEN EXISTS(SELECT 1 FROM ingestion_context_pages WHERE tenant=NEW.tenant AND page_id=NEW.page_id)
 OR EXISTS(SELECT 1 FROM ingestion_pages p JOIN inventory_scopes s ON s.tenant=p.tenant AND s.scope_id=p.scope_id JOIN comparison_domains d ON d.tenant=p.tenant WHERE p.tenant=NEW.tenant AND p.page_id=NEW.page_id AND s.provider='lofi' AND (d.active_generation IS NOT NULL OR d.pending_generation IS NOT NULL) AND (EXISTS(SELECT 1 FROM ingestion_source_membership_changes v WHERE v.tenant=p.tenant AND v.page_id=p.page_id) OR EXISTS(SELECT 1 FROM ingestion_required_context_domains v WHERE v.tenant=p.tenant AND v.page_id=p.page_id))) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ingestion_context_pages WHERE tenant=NEW.tenant AND page_id=NEW.page_id)
  OR (SELECT count(*) FROM ingestion_membership_effects WHERE tenant=NEW.tenant AND page_id=NEW.page_id)!=(SELECT count(*) FROM ingestion_source_membership_changes WHERE tenant=NEW.tenant AND page_id=NEW.page_id)
  OR EXISTS(
   SELECT 1 FROM ingestion_membership_effects q JOIN ingestion_pages p ON p.tenant=q.tenant AND p.page_id=q.page_id
   LEFT JOIN inventory_membership_versions v ON v.tenant=p.tenant AND v.scope_id=p.scope_id AND v.entity_family=q.entity_family AND v.record_key=q.record_key AND v.facet=q.facet
   WHERE q.tenant=NEW.tenant AND q.page_id=NEW.page_id AND (q.expected_version!=coalesce(v.version,0) OR NOT EXISTS(SELECT 1 FROM ingestion_source_membership_changes m WHERE m.tenant=q.tenant AND m.page_id=q.page_id AND m.entity_family=q.entity_family AND m.record_key=q.record_key AND m.facet=q.facet AND m.subtype=q.subtype AND m.parent_key IS q.parent_key AND m.before_state=q.before_state AND m.after_state=q.after_state))
  ) THEN RAISE(ABORT,'inventory context membership changed') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM ingestion_required_context_domains v WHERE v.tenant=NEW.tenant AND v.page_id=NEW.page_id AND NOT EXISTS(SELECT 1 FROM ingestion_page_domains q WHERE q.tenant=v.tenant AND q.page_id=v.page_id AND q.operation_key=v.operation_key)
 ) OR EXISTS(
  SELECT 1 FROM ingestion_page_domains q JOIN ingestion_pages p ON p.tenant=q.tenant AND p.page_id=q.page_id LEFT JOIN projection_domains d ON d.tenant=p.tenant AND d.scope_id=p.scope_id AND d.operation_key=q.operation_key
  WHERE q.tenant=NEW.tenant AND q.page_id=NEW.page_id AND q.expected_version!=coalesce(d.topology_version,0)
 ) THEN RAISE(ABORT,'inventory context domain incomplete') END;
END;
CREATE TRIGGER ingestion_context_commit BEFORE UPDATE ON ingestion_pages WHEN NEW.state='committed' AND EXISTS(SELECT 1 FROM ingestion_context_pages WHERE tenant=OLD.tenant AND page_id=OLD.page_id) BEGIN
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM ingestion_page_domains q LEFT JOIN projection_domains d ON d.tenant=q.tenant AND d.scope_id=OLD.scope_id AND d.operation_key=q.operation_key WHERE q.tenant=OLD.tenant AND q.page_id=OLD.page_id AND (d.topology_version IS NULL OR d.topology_version!=q.expected_version+1)
 ) OR EXISTS(
  SELECT 1 FROM ingestion_membership_effects q JOIN ingestion_run_pages x ON x.tenant=q.tenant AND x.page_id=q.page_id JOIN inventory_runs r ON r.tenant=x.tenant AND r.run_id=x.run_id
  LEFT JOIN inventory_partition_membership m ON m.tenant=r.tenant AND m.scope_id=r.scope_id AND m.stream_id=r.stream_id AND m.facet=r.facet AND m.partition_id=r.partition_id AND m.entity_family=q.entity_family AND m.record_key=q.record_key
  LEFT JOIN inventory_membership_versions v ON v.tenant=r.tenant AND v.scope_id=r.scope_id AND v.entity_family=q.entity_family AND v.record_key=q.record_key AND v.facet=r.facet
  WHERE q.tenant=OLD.tenant AND q.page_id=OLD.page_id AND (m.state IS NOT q.after_state OR v.version IS NULL OR v.version!=q.expected_version+1)
 ) THEN RAISE(ABORT,'inventory context publication incomplete') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM ingestion_membership_effects q CROSS JOIN comparison_domains d CROSS JOIN comparison_index i
  LEFT JOIN comparison_work w ON w.tenant=i.tenant AND w.generation_id=i.generation_id AND w.scope_id=i.scope_id AND w.record_key=i.record_key AND w.facet=i.facet
  WHERE q.tenant=OLD.tenant AND q.page_id=OLD.page_id AND q.entity_family='qso' AND q.subtype='qso' AND d.tenant=q.tenant AND i.tenant=q.tenant AND i.generation_id IN (d.active_generation,d.pending_generation) AND i.scope_id=OLD.scope_id AND i.record_key=q.record_key AND i.facet=q.facet AND i.state!='retired'
   AND (i.state!='pending' OR w.work_version IS NULL OR w.completed_version>=w.work_version)
 ) THEN RAISE(ABORT,'inventory context work incomplete') END;
END;
