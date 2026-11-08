-- Hash hints, narrow invalidations and the sync cursor share the original page
-- transaction. Old callers cannot silently advance an indexed scope without them.
CREATE TABLE comparison_page_state (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL, domain_version INTEGER NOT NULL,
 PRIMARY KEY(tenant,page_id), FOREIGN KEY(tenant,page_id) REFERENCES ingestion_pages(tenant,page_id)
);
CREATE TABLE comparison_page_rows (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL, generation_id TEXT NOT NULL,
 record_key TEXT NOT NULL, facet TEXT NOT NULL,
 key_class TEXT CHECK(key_class IN ('call_and_time','call_only','time_only','unknown')), bucket_hash TEXT,
 PRIMARY KEY(tenant,page_id,generation_id,record_key,facet),
 FOREIGN KEY(tenant,page_id) REFERENCES comparison_page_state(tenant,page_id),
 FOREIGN KEY(tenant,generation_id) REFERENCES index_generations(tenant,generation_id),
 CHECK((key_class IS NULL AND bucket_hash IS NULL) OR (key_class IS NOT NULL AND length(bucket_hash)=43))
);
CREATE TABLE comparison_page_buckets (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL, generation_id TEXT NOT NULL, scope_id TEXT NOT NULL,
 key_class TEXT NOT NULL, bucket_hash TEXT NOT NULL, expected_version INTEGER NOT NULL CHECK(expected_version>=0),
 PRIMARY KEY(tenant,page_id,generation_id,scope_id,key_class,bucket_hash),
 FOREIGN KEY(tenant,page_id) REFERENCES comparison_page_state(tenant,page_id)
);
CREATE INDEX comparison_page_hint_bucket ON comparison_page_rows(tenant,page_id,generation_id,key_class,bucket_hash);
CREATE TRIGGER comparison_page_guard BEFORE INSERT ON ingestion_page_guards BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ingestion_page_rows WHERE tenant=NEW.tenant AND page_id=NEW.page_id AND entity_family='qso' AND semantic_changed=1)
 AND EXISTS(SELECT 1 FROM comparison_domains WHERE tenant=NEW.tenant AND (active_generation IS NOT NULL OR pending_generation IS NOT NULL)) AND (
  NOT EXISTS(SELECT 1 FROM comparison_page_state s JOIN comparison_domains d ON d.tenant=s.tenant AND d.version=s.domain_version WHERE s.tenant=NEW.tenant AND s.page_id=NEW.page_id)
  OR (SELECT count(*) FROM comparison_page_rows WHERE tenant=NEW.tenant AND page_id=NEW.page_id) !=
    (SELECT count(*) FROM ingestion_page_rows WHERE tenant=NEW.tenant AND page_id=NEW.page_id AND entity_family='qso' AND semantic_changed=1) *
    (SELECT count(*) FROM index_generations g JOIN comparison_domains d ON d.tenant=g.tenant AND g.generation_id IN (d.active_generation,d.pending_generation) WHERE g.tenant=NEW.tenant)
 ) THEN RAISE(ABORT,'comparison page generation changed') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM comparison_page_rows x JOIN ingestion_pages p ON p.tenant=x.tenant AND p.page_id=x.page_id
  LEFT JOIN ingestion_page_rows r ON r.tenant=x.tenant AND r.page_id=x.page_id AND r.entity_family='qso' AND r.record_key=x.record_key AND r.facet=x.facet AND r.semantic_changed=1
  LEFT JOIN comparison_domains d ON d.tenant=x.tenant
  LEFT JOIN index_generations g ON g.tenant=x.tenant AND g.generation_id=x.generation_id
  LEFT JOIN comparison_builds b ON b.tenant=x.tenant AND b.generation_id=x.generation_id AND b.scope_id=p.scope_id
  WHERE x.tenant=NEW.tenant AND x.page_id=NEW.page_id AND (r.record_key IS NULL OR b.scope_id IS NULL OR b.config_version!=p.expected_config_version
   OR g.generation_id IS NULL OR g.state NOT IN ('building','active') OR x.generation_id NOT IN (coalesce(d.active_generation,''),coalesce(d.pending_generation,''))
   OR ((r.subtype='qso' AND r.status='active')!=(x.key_class IS NOT NULL)))
 ) THEN RAISE(ABORT,'comparison page hint incomplete') END;
 SELECT CASE WHEN
  (SELECT count(*) FROM comparison_page_buckets WHERE tenant=NEW.tenant AND page_id=NEW.page_id) !=
  (SELECT count(*) FROM (
   SELECT generation_id,key_class,bucket_hash FROM comparison_page_rows WHERE tenant=NEW.tenant AND page_id=NEW.page_id AND key_class IS NOT NULL
   UNION
   SELECT i.generation_id,i.key_class,i.bucket_hash FROM comparison_page_rows x JOIN ingestion_pages p ON p.tenant=x.tenant AND p.page_id=x.page_id JOIN comparison_index i ON i.tenant=x.tenant AND i.generation_id=x.generation_id AND i.scope_id=p.scope_id AND i.record_key=x.record_key AND i.facet=x.facet WHERE x.tenant=NEW.tenant AND x.page_id=NEW.page_id AND i.key_class IS NOT NULL
  )) OR EXISTS(
   SELECT 1 FROM comparison_page_buckets x JOIN ingestion_pages p ON p.tenant=x.tenant AND p.page_id=x.page_id
   LEFT JOIN bucket_versions b ON b.tenant=x.tenant AND b.generation_id=x.generation_id AND b.scope_id=x.scope_id AND b.key_class=x.key_class AND b.bucket_hash=x.bucket_hash
   WHERE x.tenant=NEW.tenant AND x.page_id=NEW.page_id AND (x.scope_id!=p.scope_id OR x.expected_version!=coalesce(b.version,0) OR (
    NOT EXISTS(SELECT 1 FROM comparison_page_rows r WHERE r.tenant=x.tenant AND r.page_id=x.page_id AND r.generation_id=x.generation_id AND r.key_class=x.key_class AND r.bucket_hash=x.bucket_hash)
    AND NOT EXISTS(SELECT 1 FROM comparison_index i CROSS JOIN comparison_page_rows r WHERE i.tenant=x.tenant AND i.generation_id=x.generation_id AND i.scope_id=x.scope_id AND i.key_class=x.key_class AND i.bucket_hash=x.bucket_hash AND r.tenant=x.tenant AND r.page_id=x.page_id AND r.generation_id=i.generation_id AND r.record_key=i.record_key AND r.facet=i.facet)
   ))
  ) THEN RAISE(ABORT,'comparison bucket manifest incomplete') END;
END;
CREATE TRIGGER comparison_page_commit BEFORE UPDATE ON ingestion_pages WHEN NEW.state='committed' BEGIN
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM comparison_page_rows x CROSS JOIN inventory_record_facets f
  LEFT JOIN comparison_index i ON i.tenant=x.tenant AND i.generation_id=x.generation_id AND i.scope_id=OLD.scope_id AND i.record_key=x.record_key AND i.facet=x.facet
  LEFT JOIN comparison_work w ON w.tenant=i.tenant AND w.generation_id=i.generation_id AND w.scope_id=i.scope_id AND w.record_key=i.record_key AND w.facet=i.facet
  WHERE x.tenant=OLD.tenant AND x.page_id=OLD.page_id AND f.tenant=x.tenant AND f.scope_id=OLD.scope_id AND f.entity_family='qso' AND f.record_key=x.record_key AND f.facet=x.facet
   AND (i.record_key IS NULL OR i.last_page_id!=OLD.page_id OR i.config_version!=OLD.expected_config_version OR i.semantic_version!=f.semantic_version
    OR i.key_class IS NOT x.key_class OR i.bucket_hash IS NOT x.bucket_hash OR i.state!=CASE WHEN x.key_class IS NULL THEN 'retired' ELSE 'pending' END
    OR w.record_key IS NULL OR (i.state='pending' AND w.completed_version>=w.work_version) OR (i.state='retired' AND w.completed_version!=w.work_version))
 ) THEN RAISE(ABORT,'comparison page publication incomplete') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM comparison_page_buckets x LEFT JOIN bucket_versions b ON b.tenant=x.tenant AND b.generation_id=x.generation_id AND b.scope_id=x.scope_id AND b.key_class=x.key_class AND b.bucket_hash=x.bucket_hash
  WHERE x.tenant=OLD.tenant AND x.page_id=OLD.page_id AND (b.version IS NULL OR b.version!=x.expected_version+1)
 ) THEN RAISE(ABORT,'comparison bucket publication incomplete') END;
END;
