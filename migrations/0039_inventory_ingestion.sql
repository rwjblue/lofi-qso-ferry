-- Read-only inventory foundation. No legacy source/ledger triggers or delivery
-- eligibility are attached to these tables. Accounts and connections stay put.
CREATE TABLE inventory_scopes (
 tenant TEXT NOT NULL, scope_id TEXT NOT NULL, connection_id TEXT NOT NULL,
 provider TEXT NOT NULL CHECK(provider IN ('lofi','qrz','lotw')),
 logical_identity TEXT NOT NULL, config_version INTEGER NOT NULL DEFAULT 1 CHECK(config_version>0),
 adapter_binding TEXT NOT NULL, ordering TEXT NOT NULL CHECK(ordering IN ('numeric','serialized')),
 accepted_sequence INTEGER NOT NULL DEFAULT 0 CHECK(accepted_sequence>=0),
 state TEXT NOT NULL DEFAULT 'observing' CHECK(state IN ('observing','held')),
 PRIMARY KEY(tenant,scope_id), UNIQUE(tenant,provider,logical_identity),
 FOREIGN KEY(tenant,connection_id) REFERENCES connections(tenant,id)
);
CREATE TABLE inventory_streams (
 tenant TEXT NOT NULL, scope_id TEXT NOT NULL, stream_id TEXT NOT NULL,
 query_binding TEXT NOT NULL, checkpoint_version INTEGER NOT NULL DEFAULT 0 CHECK(checkpoint_version>=0),
 resume_state TEXT NOT NULL DEFAULT '{}', committed_checkpoint TEXT NOT NULL DEFAULT '{}',
 updated_at INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant,scope_id,stream_id),
 FOREIGN KEY(tenant,scope_id) REFERENCES inventory_scopes(tenant,scope_id),
 CHECK(json_valid(resume_state) AND json_valid(committed_checkpoint))
);
CREATE TRIGGER inventory_scope_binding BEFORE UPDATE ON inventory_scopes
 WHEN (NEW.connection_id!=OLD.connection_id OR NEW.provider!=OLD.provider OR NEW.logical_identity!=OLD.logical_identity OR NEW.adapter_binding!=OLD.adapter_binding OR NEW.ordering!=OLD.ordering)
 AND NEW.config_version<=OLD.config_version
 BEGIN
 SELECT RAISE(ABORT,'inventory scope version required');
 END;
CREATE TRIGGER inventory_scope_monotonic BEFORE UPDATE ON inventory_scopes WHEN NEW.config_version<OLD.config_version OR NEW.accepted_sequence<OLD.accepted_sequence BEGIN SELECT RAISE(ABORT,'inventory scope version regressed'); END;
CREATE TRIGGER inventory_stream_monotonic BEFORE UPDATE ON inventory_streams WHEN NEW.checkpoint_version<OLD.checkpoint_version BEGIN SELECT RAISE(ABORT,'inventory stream version regressed'); END;
CREATE TRIGGER inventory_stream_binding BEFORE UPDATE ON inventory_streams
 WHEN NEW.query_binding!=OLD.query_binding AND NEW.checkpoint_version<=OLD.checkpoint_version
 BEGIN
 SELECT RAISE(ABORT,'inventory stream version required');
 END;
CREATE TABLE inventory_payloads (
 tenant TEXT NOT NULL, scope_id TEXT NOT NULL, payload_id TEXT NOT NULL,
 connection_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('inventory_source','inventory_receipt')),
 envelope TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(tenant,scope_id,payload_id),
 FOREIGN KEY(tenant,scope_id) REFERENCES inventory_scopes(tenant,scope_id),
 FOREIGN KEY(tenant,connection_id) REFERENCES connections(tenant,id)
);
CREATE TRIGGER inventory_payloads_immutable BEFORE UPDATE ON inventory_payloads BEGIN SELECT RAISE(ABORT,'immutable inventory payload'); END;
CREATE TABLE inventory_records (
 tenant TEXT NOT NULL, scope_id TEXT NOT NULL, entity_family TEXT NOT NULL CHECK(entity_family IN ('operation','qso')),
 record_key TEXT NOT NULL, subtype TEXT NOT NULL CHECK(subtype IN ('operation','event','qso')),
 parent_key TEXT, row_version INTEGER NOT NULL CHECK(row_version>0),
 status TEXT NOT NULL CHECK(status IN ('active','deleted')),
 last_accepted_sequence INTEGER NOT NULL, last_observed_at INTEGER NOT NULL, last_page_id TEXT NOT NULL,
 PRIMARY KEY(tenant,scope_id,entity_family,record_key),
 FOREIGN KEY(tenant,scope_id) REFERENCES inventory_scopes(tenant,scope_id),
 CHECK((entity_family='operation' AND subtype='operation' AND parent_key IS NULL) OR (entity_family='qso' AND subtype IN ('event','qso')))
);
CREATE INDEX inventory_parent ON inventory_records(tenant,scope_id,parent_key,entity_family,subtype);
CREATE TABLE inventory_record_facets (
 tenant TEXT NOT NULL, scope_id TEXT NOT NULL, entity_family TEXT NOT NULL, record_key TEXT NOT NULL,
 facet TEXT NOT NULL CHECK(facet IN ('source','receipt')), row_version INTEGER NOT NULL CHECK(row_version>0),
 revision TEXT NOT NULL, revision_order INTEGER, body_hash TEXT NOT NULL, semantic_hash TEXT NOT NULL,
 payload_id TEXT NOT NULL, raw_version INTEGER NOT NULL CHECK(raw_version>0), semantic_version INTEGER NOT NULL CHECK(semantic_version>0),
 last_accepted_sequence INTEGER NOT NULL, first_observed_at INTEGER NOT NULL, last_observed_at INTEGER NOT NULL,
 last_page_id TEXT NOT NULL,
 PRIMARY KEY(tenant,scope_id,entity_family,record_key,facet),
 FOREIGN KEY(tenant,scope_id,entity_family,record_key) REFERENCES inventory_records(tenant,scope_id,entity_family,record_key),
 FOREIGN KEY(tenant,scope_id,payload_id) REFERENCES inventory_payloads(tenant,scope_id,payload_id)
);
CREATE TABLE inventory_births (
 tenant TEXT NOT NULL, scope_id TEXT NOT NULL, entity_family TEXT NOT NULL, record_key TEXT NOT NULL, facet TEXT NOT NULL,
 first_page_id TEXT NOT NULL, first_observed_at INTEGER NOT NULL,
 origin TEXT NOT NULL CHECK(origin IN ('historical','forward')),
 PRIMARY KEY(tenant,scope_id,entity_family,record_key,facet),
 FOREIGN KEY(tenant,scope_id) REFERENCES inventory_scopes(tenant,scope_id)
);
CREATE TRIGGER inventory_births_immutable BEFORE UPDATE ON inventory_births BEGIN SELECT RAISE(ABORT,'immutable inventory birth'); END;
CREATE TABLE projection_domains (
 tenant TEXT NOT NULL, scope_id TEXT NOT NULL, operation_key TEXT NOT NULL,
 topology_version INTEGER NOT NULL CHECK(topology_version>0), ready_version INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant,scope_id,operation_key),
 FOREIGN KEY(tenant,scope_id) REFERENCES inventory_scopes(tenant,scope_id),
 CHECK(ready_version>=0 AND ready_version<=topology_version)
);
CREATE TABLE inventory_work (
 tenant TEXT NOT NULL, scope_id TEXT NOT NULL, work_key TEXT NOT NULL, work_version INTEGER NOT NULL CHECK(work_version>0),
 due_at INTEGER NOT NULL,
 PRIMARY KEY(tenant,scope_id,work_key),
 FOREIGN KEY(tenant,scope_id) REFERENCES inventory_scopes(tenant,scope_id)
);
CREATE TABLE ingestion_pages (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL, scope_id TEXT NOT NULL, stream_id TEXT NOT NULL,
 input_digest TEXT NOT NULL, manifest_digest TEXT NOT NULL, adapter_binding TEXT NOT NULL, query_binding TEXT NOT NULL,
 expected_config_version INTEGER NOT NULL, expected_sequence INTEGER NOT NULL, expected_stream_version INTEGER NOT NULL,
 credential_version TEXT NOT NULL, connection_config TEXT NOT NULL, remote_identity TEXT NOT NULL,
 lease_scope TEXT NOT NULL, lease_token TEXT NOT NULL, lease_fence INTEGER NOT NULL,
 request_started_at INTEGER NOT NULL, prepared_at INTEGER NOT NULL,
 raw_count INTEGER NOT NULL, distinct_count INTEGER NOT NULL, accepted_count INTEGER NOT NULL, changed_count INTEGER NOT NULL,
 next_resume TEXT NOT NULL, next_checkpoint TEXT, origin TEXT NOT NULL CHECK(origin IN ('historical','forward')),
 state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','committed')),
 PRIMARY KEY(tenant,page_id),
 FOREIGN KEY(tenant,scope_id,stream_id) REFERENCES inventory_streams(tenant,scope_id,stream_id),
 CHECK(raw_count>=distinct_count AND distinct_count>=accepted_count AND accepted_count>=changed_count AND changed_count>=0),
 CHECK(json_valid(next_resume) AND (next_checkpoint IS NULL OR json_valid(next_checkpoint)))
);
CREATE INDEX ingestion_page_collection ON ingestion_pages(state,prepared_at);
-- Scratch metadata exists only inside the default atomic batch. It contains no
-- plaintext body and is removed before commit; receipts remain for lost ACKs.
CREATE TABLE ingestion_page_rows (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL, entity_family TEXT NOT NULL, record_key TEXT NOT NULL, facet TEXT NOT NULL,
 subtype TEXT NOT NULL, parent_key TEXT, status TEXT NOT NULL, revision TEXT NOT NULL, revision_order INTEGER,
 body_hash TEXT NOT NULL, semantic_hash TEXT NOT NULL, payload_id TEXT NOT NULL,
 expected_record_version INTEGER NOT NULL, expected_facet_version INTEGER NOT NULL,
 accepted INTEGER NOT NULL CHECK(accepted IN (0,1)), changed INTEGER NOT NULL CHECK(changed IN (0,1)),
 semantic_changed INTEGER NOT NULL CHECK(semantic_changed IN (0,1)),
 PRIMARY KEY(tenant,page_id,entity_family,record_key,facet),
 FOREIGN KEY(tenant,page_id) REFERENCES ingestion_pages(tenant,page_id),
 CHECK(expected_record_version>=0 AND expected_facet_version>=0 AND changed<=accepted AND semantic_changed<=accepted)
);
CREATE TABLE ingestion_page_guards (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL,
 PRIMARY KEY(tenant,page_id), FOREIGN KEY(tenant,page_id) REFERENCES ingestion_pages(tenant,page_id)
);
CREATE TRIGGER ingestion_page_guard BEFORE INSERT ON ingestion_page_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM ingestion_pages p
  JOIN inventory_scopes s ON s.tenant=p.tenant AND s.scope_id=p.scope_id
  JOIN inventory_streams t ON t.tenant=p.tenant AND t.scope_id=p.scope_id AND t.stream_id=p.stream_id
  JOIN connections c ON c.tenant=s.tenant AND c.id=s.connection_id
  JOIN accounts a ON a.id=c.tenant
  JOIN private_data d ON d.tenant=c.tenant AND d.connection=c.id AND d.id=c.credential_version AND d.kind='credential'
  JOIN leases l ON l.tenant=p.tenant AND l.scope=p.lease_scope AND l.token=p.lease_token AND l.fence=p.lease_fence
  WHERE p.tenant=NEW.tenant AND p.page_id=NEW.page_id AND p.state='prepared'
   AND s.state='observing' AND a.status='active' AND c.status='active' AND c.kind=s.provider
   AND c.remote_identity=p.remote_identity AND c.config=p.connection_config AND c.credential_version=p.credential_version
   AND d.revoked_at IS NULL AND (d.expires_at IS NULL OR d.expires_at>unixepoch('subsec')*1000)
   AND l.expires_at>unixepoch('subsec')*1000 AND p.lease_scope='inventory:'||p.scope_id
   AND s.config_version=p.expected_config_version AND s.accepted_sequence=p.expected_sequence
   AND s.adapter_binding=p.adapter_binding AND t.query_binding=p.query_binding AND t.checkpoint_version=p.expected_stream_version
   AND p.request_started_at<=p.prepared_at AND p.prepared_at<=unixepoch('subsec')*1000
 ) THEN RAISE(ABORT,'inventory authority changed') END;
 SELECT CASE WHEN (SELECT count(*) FROM ingestion_page_rows r WHERE r.tenant=NEW.tenant AND r.page_id=NEW.page_id)!=(SELECT distinct_count FROM ingestion_pages WHERE tenant=NEW.tenant AND page_id=NEW.page_id)
  OR (SELECT coalesce(sum(accepted),0) FROM ingestion_page_rows r WHERE r.tenant=NEW.tenant AND r.page_id=NEW.page_id)!=(SELECT accepted_count FROM ingestion_pages WHERE tenant=NEW.tenant AND page_id=NEW.page_id)
  OR (SELECT coalesce(sum(changed),0) FROM ingestion_page_rows r WHERE r.tenant=NEW.tenant AND r.page_id=NEW.page_id)!=(SELECT changed_count FROM ingestion_pages WHERE tenant=NEW.tenant AND page_id=NEW.page_id)
  THEN RAISE(ABORT,'inventory manifest count mismatch') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM ingestion_page_rows r JOIN ingestion_pages p ON p.tenant=r.tenant AND p.page_id=r.page_id
  LEFT JOIN inventory_records e ON e.tenant=p.tenant AND e.scope_id=p.scope_id AND e.entity_family=r.entity_family AND e.record_key=r.record_key
  LEFT JOIN inventory_record_facets f ON f.tenant=p.tenant AND f.scope_id=p.scope_id AND f.entity_family=r.entity_family AND f.record_key=r.record_key AND f.facet=r.facet
  WHERE r.tenant=NEW.tenant AND r.page_id=NEW.page_id AND (coalesce(e.row_version,0)!=r.expected_record_version OR coalesce(f.row_version,0)!=r.expected_facet_version)
 ) THEN RAISE(ABORT,'inventory record changed') END;
END;
CREATE TRIGGER ingestion_page_commit BEFORE UPDATE ON ingestion_pages WHEN NEW.state='committed' BEGIN
 SELECT CASE WHEN OLD.state!='prepared' OR NOT EXISTS(SELECT 1 FROM ingestion_page_guards WHERE tenant=OLD.tenant AND page_id=OLD.page_id)
  THEN RAISE(ABORT,'inventory publication guard missing') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM leases l WHERE l.tenant=OLD.tenant AND l.scope=OLD.lease_scope AND l.token=OLD.lease_token AND l.fence=OLD.lease_fence AND l.expires_at>unixepoch('subsec')*1000)
  THEN RAISE(ABORT,'inventory publication lease expired') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_scopes s JOIN private_data d ON d.tenant=s.tenant AND d.connection=s.connection_id AND d.id=OLD.credential_version AND d.kind='credential' WHERE s.tenant=OLD.tenant AND s.scope_id=OLD.scope_id AND d.revoked_at IS NULL AND (d.expires_at IS NULL OR d.expires_at>unixepoch('subsec')*1000))
  THEN RAISE(ABORT,'inventory publication credential expired') END;
 -- Drive assertions from the bounded page, not the entire growing inventory.
 SELECT CASE WHEN (SELECT count(*) FROM ingestion_page_rows r CROSS JOIN inventory_record_facets f
   WHERE r.tenant=OLD.tenant AND r.page_id=OLD.page_id AND r.accepted=1 AND f.tenant=r.tenant AND f.scope_id=OLD.scope_id AND f.entity_family=r.entity_family AND f.record_key=r.record_key AND f.facet=r.facet AND f.last_page_id=OLD.page_id)!=OLD.accepted_count
  OR (SELECT count(*) FROM ingestion_page_rows r CROSS JOIN inventory_records e
   WHERE r.tenant=OLD.tenant AND r.page_id=OLD.page_id AND r.accepted=1 AND e.tenant=r.tenant AND e.scope_id=OLD.scope_id AND e.entity_family=r.entity_family AND e.record_key=r.record_key AND e.last_page_id=OLD.page_id)!=OLD.accepted_count
  OR (SELECT checkpoint_version FROM inventory_streams WHERE tenant=OLD.tenant AND scope_id=OLD.scope_id AND stream_id=OLD.stream_id)!=OLD.expected_stream_version+1
  OR (SELECT accepted_sequence FROM inventory_scopes WHERE tenant=OLD.tenant AND scope_id=OLD.scope_id)!=OLD.expected_sequence+1
  THEN RAISE(ABORT,'inventory publication incomplete') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM ingestion_page_rows r CROSS JOIN inventory_record_facets f CROSS JOIN inventory_payloads b CROSS JOIN inventory_scopes s
  WHERE r.tenant=OLD.tenant AND r.page_id=OLD.page_id AND r.accepted=1
   AND f.tenant=r.tenant AND f.scope_id=OLD.scope_id AND f.entity_family=r.entity_family AND f.record_key=r.record_key AND f.facet=r.facet
   AND b.tenant=f.tenant AND b.scope_id=f.scope_id AND b.payload_id=f.payload_id AND s.tenant=f.tenant AND s.scope_id=f.scope_id
   AND (b.connection_id!=s.connection_id OR b.kind!=CASE f.facet WHEN 'source' THEN 'inventory_source' ELSE 'inventory_receipt' END)
 ) THEN RAISE(ABORT,'inventory payload binding mismatch') END;
END;
CREATE TRIGGER ingestion_page_immutable BEFORE UPDATE ON ingestion_pages WHEN OLD.state='committed' BEGIN SELECT RAISE(ABORT,'immutable inventory receipt'); END;
