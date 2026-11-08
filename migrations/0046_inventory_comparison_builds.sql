-- Bounded keyset backfill does not renew vendor observations or stream cursors.
CREATE TABLE comparison_build_pages (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL, generation_id TEXT NOT NULL, scope_id TEXT NOT NULL,
 expected_version INTEGER NOT NULL, expected_config_version INTEGER NOT NULL, expected_sequence INTEGER NOT NULL, domain_version INTEGER NOT NULL,
 lease_token TEXT NOT NULL, lease_fence INTEGER NOT NULL, previous_cursor TEXT NOT NULL, next_cursor TEXT NOT NULL,
 complete INTEGER NOT NULL CHECK(complete IN (0,1)), row_count INTEGER NOT NULL CHECK(row_count BETWEEN 0 AND 200),
 digest TEXT NOT NULL, prepared_at INTEGER NOT NULL, changed_count INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','committed')),
 PRIMARY KEY(tenant,page_id), FOREIGN KEY(tenant,generation_id,scope_id) REFERENCES comparison_builds(tenant,generation_id,scope_id),
 CHECK(next_cursor>=previous_cursor)
);
CREATE TABLE comparison_build_rows (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL, record_key TEXT NOT NULL, facet TEXT NOT NULL,
 subtype TEXT NOT NULL, status TEXT NOT NULL, parent_key TEXT, semantic_version INTEGER NOT NULL, payload_id TEXT NOT NULL,
 key_class TEXT, bucket_hash TEXT, changed INTEGER NOT NULL CHECK(changed IN (0,1)),
 PRIMARY KEY(tenant,page_id,record_key,facet), FOREIGN KEY(tenant,page_id) REFERENCES comparison_build_pages(tenant,page_id)
);
CREATE INDEX comparison_build_row_bucket ON comparison_build_rows(tenant,page_id,key_class,bucket_hash);
CREATE TABLE comparison_build_buckets (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL, key_class TEXT NOT NULL, bucket_hash TEXT NOT NULL,
 expected_version INTEGER NOT NULL CHECK(expected_version>=0), PRIMARY KEY(tenant,page_id,key_class,bucket_hash),
 FOREIGN KEY(tenant,page_id) REFERENCES comparison_build_pages(tenant,page_id)
);
CREATE TABLE comparison_build_guards (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL, PRIMARY KEY(tenant,page_id),
 FOREIGN KEY(tenant,page_id) REFERENCES comparison_build_pages(tenant,page_id)
);
CREATE TRIGGER comparison_build_guard BEFORE INSERT ON comparison_build_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM comparison_build_pages p JOIN comparison_builds b ON b.tenant=p.tenant AND b.generation_id=p.generation_id AND b.scope_id=p.scope_id
  JOIN comparison_domains d ON d.tenant=p.tenant JOIN index_generations g ON g.tenant=p.tenant AND g.generation_id=p.generation_id
  JOIN inventory_scopes s ON s.tenant=p.tenant AND s.scope_id=p.scope_id JOIN connections c ON c.tenant=s.tenant AND c.id=s.connection_id JOIN accounts a ON a.id=s.tenant
  JOIN leases l ON l.tenant=p.tenant AND l.scope='comparison:'||p.generation_id||':'||p.scope_id AND l.token=p.lease_token AND l.fence=p.lease_fence
  WHERE p.tenant=NEW.tenant AND p.page_id=NEW.page_id AND p.state='prepared' AND b.complete=0
   AND b.version=p.expected_version AND b.config_version=p.expected_config_version AND b.cursor_key=p.previous_cursor
   AND s.config_version=p.expected_config_version AND s.accepted_sequence=p.expected_sequence
   AND a.status='active' AND d.version=p.domain_version AND g.state IN ('building','active') AND g.generation_id IN (d.active_generation,d.pending_generation)
   AND l.expires_at>unixepoch('subsec')*1000 AND p.prepared_at<=unixepoch('subsec')*1000
 ) THEN RAISE(ABORT,'comparison build authority changed') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM comparison_build_pages p WHERE p.tenant=NEW.tenant AND p.page_id=NEW.page_id AND (
   (SELECT count(*) FROM comparison_build_rows WHERE tenant=p.tenant AND page_id=p.page_id)!=p.row_count
   OR (SELECT count(*) FROM inventory_records WHERE tenant=p.tenant AND scope_id=p.scope_id AND entity_family='qso' AND record_key>p.previous_cursor AND record_key<=p.next_cursor)!=p.row_count
   OR (p.row_count=0 AND p.next_cursor!=p.previous_cursor)
   OR (p.row_count>0 AND p.next_cursor!=(SELECT max(record_key) FROM comparison_build_rows WHERE tenant=p.tenant AND page_id=p.page_id))
   OR (p.complete=1 AND EXISTS(SELECT 1 FROM inventory_records WHERE tenant=p.tenant AND scope_id=p.scope_id AND entity_family='qso' AND record_key>p.next_cursor LIMIT 1))
  )
 ) THEN RAISE(ABORT,'comparison build range incomplete') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM comparison_build_rows r JOIN comparison_build_pages p ON p.tenant=r.tenant AND p.page_id=r.page_id
  LEFT JOIN inventory_records e ON e.tenant=p.tenant AND e.scope_id=p.scope_id AND e.entity_family='qso' AND e.record_key=r.record_key
  LEFT JOIN inventory_record_facets f ON f.tenant=e.tenant AND f.scope_id=e.scope_id AND f.entity_family=e.entity_family AND f.record_key=e.record_key AND f.facet=r.facet
  LEFT JOIN comparison_index i ON i.tenant=p.tenant AND i.generation_id=p.generation_id AND i.scope_id=p.scope_id AND i.record_key=r.record_key AND i.facet=r.facet
  WHERE r.tenant=NEW.tenant AND r.page_id=NEW.page_id AND (e.record_key IS NULL OR f.record_key IS NULL OR r.record_key<=p.previous_cursor OR r.record_key>p.next_cursor
   OR r.subtype!=e.subtype OR r.status!=e.status OR r.parent_key IS NOT e.parent_key OR r.semantic_version!=f.semantic_version OR r.payload_id!=f.payload_id
   OR ((r.subtype='qso' AND r.status='active')!=(r.key_class IS NOT NULL)) OR (r.key_class IS NOT NULL AND length(r.bucket_hash)!=43)
   OR r.changed!=(i.record_key IS NULL OR i.semantic_version!=r.semantic_version OR i.config_version!=p.expected_config_version OR i.key_class IS NOT r.key_class OR i.bucket_hash IS NOT r.bucket_hash OR ((i.state='retired')!=(r.key_class IS NULL))))
 ) THEN RAISE(ABORT,'comparison build record changed') END;
 SELECT CASE WHEN
  (SELECT count(*) FROM comparison_build_buckets WHERE tenant=NEW.tenant AND page_id=NEW.page_id)!=
  (SELECT count(*) FROM (
   SELECT key_class,bucket_hash FROM comparison_build_rows WHERE tenant=NEW.tenant AND page_id=NEW.page_id AND changed=1 AND key_class IS NOT NULL
   UNION
   SELECT i.key_class,i.bucket_hash FROM comparison_build_rows r JOIN comparison_build_pages p ON p.tenant=r.tenant AND p.page_id=r.page_id JOIN comparison_index i ON i.tenant=p.tenant AND i.generation_id=p.generation_id AND i.scope_id=p.scope_id AND i.record_key=r.record_key AND i.facet=r.facet WHERE r.tenant=NEW.tenant AND r.page_id=NEW.page_id AND r.changed=1 AND i.key_class IS NOT NULL
  )) OR EXISTS(
   SELECT 1 FROM comparison_build_buckets x JOIN comparison_build_pages p ON p.tenant=x.tenant AND p.page_id=x.page_id
   LEFT JOIN bucket_versions b ON b.tenant=p.tenant AND b.generation_id=p.generation_id AND b.scope_id=p.scope_id AND b.key_class=x.key_class AND b.bucket_hash=x.bucket_hash
   WHERE x.tenant=NEW.tenant AND x.page_id=NEW.page_id AND (x.expected_version!=coalesce(b.version,0) OR (
    NOT EXISTS(SELECT 1 FROM comparison_build_rows r WHERE r.tenant=x.tenant AND r.page_id=x.page_id AND r.changed=1 AND r.key_class=x.key_class AND r.bucket_hash=x.bucket_hash)
    AND NOT EXISTS(SELECT 1 FROM comparison_index i CROSS JOIN comparison_build_rows r WHERE i.tenant=p.tenant AND i.generation_id=p.generation_id AND i.scope_id=p.scope_id AND i.key_class=x.key_class AND i.bucket_hash=x.bucket_hash AND r.tenant=x.tenant AND r.page_id=x.page_id AND r.record_key=i.record_key AND r.facet=i.facet AND r.changed=1)
   ))
  ) THEN RAISE(ABORT,'comparison build buckets incomplete') END;
END;
CREATE TRIGGER comparison_build_version BEFORE UPDATE ON comparison_builds WHEN NEW.version<=OLD.version OR NEW.config_version<OLD.config_version BEGIN SELECT RAISE(ABORT,'comparison build version required'); END;
CREATE TRIGGER comparison_build_identity BEFORE UPDATE ON comparison_builds WHEN NEW.tenant!=OLD.tenant OR NEW.generation_id!=OLD.generation_id OR NEW.scope_id!=OLD.scope_id BEGIN SELECT RAISE(ABORT,'comparison build identity immutable'); END;
CREATE TRIGGER comparison_build_progress BEFORE UPDATE ON comparison_builds
 WHEN NOT (NEW.complete=0 AND NEW.cursor_key='') BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM comparison_build_pages p JOIN comparison_build_guards g ON g.tenant=p.tenant AND g.page_id=p.page_id
  WHERE p.tenant=OLD.tenant AND p.generation_id=OLD.generation_id AND p.scope_id=OLD.scope_id AND p.state='prepared'
   AND p.expected_version=OLD.version AND NEW.version=OLD.version+1 AND NEW.config_version=OLD.config_version
   AND NEW.cursor_key=p.next_cursor AND NEW.complete=p.complete
 ) THEN RAISE(ABORT,'comparison build publication required') END;
END;
CREATE TRIGGER comparison_build_commit BEFORE UPDATE ON comparison_build_pages WHEN NEW.state='committed' BEGIN
 SELECT CASE WHEN OLD.state!='prepared' OR NOT EXISTS(
  SELECT 1 FROM comparison_build_guards g JOIN comparison_builds b ON b.tenant=OLD.tenant AND b.generation_id=OLD.generation_id AND b.scope_id=OLD.scope_id
  JOIN inventory_scopes s ON s.tenant=b.tenant AND s.scope_id=b.scope_id
  JOIN leases l ON l.tenant=b.tenant AND l.scope='comparison:'||b.generation_id||':'||b.scope_id AND l.token=OLD.lease_token AND l.fence=OLD.lease_fence
  WHERE g.tenant=OLD.tenant AND g.page_id=OLD.page_id AND b.version=OLD.expected_version+1 AND b.cursor_key=OLD.next_cursor AND b.complete=OLD.complete
   AND b.config_version=OLD.expected_config_version AND s.config_version=b.config_version AND s.accepted_sequence=OLD.expected_sequence AND l.expires_at>unixepoch('subsec')*1000
 ) THEN RAISE(ABORT,'comparison build publication incomplete') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM comparison_build_rows r LEFT JOIN comparison_index i ON i.tenant=r.tenant AND i.generation_id=OLD.generation_id AND i.scope_id=OLD.scope_id AND i.record_key=r.record_key AND i.facet=r.facet
  LEFT JOIN comparison_work w ON w.tenant=i.tenant AND w.generation_id=i.generation_id AND w.scope_id=i.scope_id AND w.record_key=i.record_key AND w.facet=i.facet
  WHERE r.tenant=OLD.tenant AND r.page_id=OLD.page_id AND (i.record_key IS NULL OR i.semantic_version!=r.semantic_version OR i.config_version!=OLD.expected_config_version OR i.key_class IS NOT r.key_class OR i.bucket_hash IS NOT r.bucket_hash OR ((i.state='retired')!=(r.key_class IS NULL)) OR w.record_key IS NULL)
 ) OR EXISTS(
  SELECT 1 FROM comparison_build_buckets x LEFT JOIN bucket_versions b ON b.tenant=x.tenant AND b.generation_id=OLD.generation_id AND b.scope_id=OLD.scope_id AND b.key_class=x.key_class AND b.bucket_hash=x.bucket_hash
  WHERE x.tenant=OLD.tenant AND x.page_id=OLD.page_id AND (b.version IS NULL OR b.version!=x.expected_version+1)
 ) THEN RAISE(ABORT,'comparison build index incomplete') END;
END;
CREATE TRIGGER comparison_build_page_immutable BEFORE UPDATE ON comparison_build_pages WHEN OLD.state='committed' BEGIN SELECT RAISE(ABORT,'comparison build receipt immutable'); END;
