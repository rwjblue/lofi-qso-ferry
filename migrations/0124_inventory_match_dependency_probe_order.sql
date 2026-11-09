-- Load each probe once for its tokens. Registration already groups identical
-- dependencies, so look up the invalidation clock after that grouping.
DROP TRIGGER inventory_match_live_register;
CREATE TRIGGER inventory_match_live_register AFTER INSERT ON inventory_match_live_sets BEGIN
 INSERT INTO inventory_matching_bucket_dependents(tenant,set_id,generation_id,scope_id,key_class,bucket_hash,seen_version,probe_id)
 SELECT NEW.tenant,NEW.set_id,NEW.generation_id,b.search_scope,b.key_class,b.bucket_hash,coalesce(j.work_version,0),b.probe_id
 FROM (
  SELECT p.search_scope,t.key_class,t.bucket_hash,min(t.probe_id) AS probe_id
  FROM inventory_match_probes p CROSS JOIN inventory_match_tokens t
  WHERE (p.tenant,p.set_id)=(NEW.tenant,NEW.set_id)
  AND (t.tenant,t.set_id,t.probe_id)=(p.tenant,p.set_id,p.probe_id)
  GROUP BY p.search_scope,t.key_class,t.bucket_hash
 ) b
 LEFT JOIN inventory_matching_bucket_jobs j
  ON (j.tenant,j.generation_id,j.scope_id,j.key_class,j.bucket_hash)
   =(NEW.tenant,NEW.generation_id,b.search_scope,b.key_class,b.bucket_hash);
END;

DROP TRIGGER inventory_matching_dependencies_complete;
CREATE TRIGGER inventory_matching_dependencies_complete BEFORE UPDATE ON inventory_match_sets WHEN NEW.state='committed' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_match_live_sets l WHERE l.tenant=NEW.tenant AND l.set_id=NEW.set_id AND l.generation_id=NEW.generation_id AND l.ref_count=NEW.row_count) THEN RAISE(ABORT,'inventory matching live references incomplete') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM inventory_match_probes p CROSS JOIN inventory_match_tokens t
  WHERE (p.tenant,p.set_id)=(NEW.tenant,NEW.set_id)
  AND (t.tenant,t.set_id,t.probe_id)=(p.tenant,p.set_id,p.probe_id)
  AND NOT EXISTS(SELECT 1 FROM inventory_matching_bucket_dependents d
    WHERE (d.tenant,d.set_id,d.scope_id,d.key_class,d.bucket_hash)
      =(p.tenant,p.set_id,p.search_scope,t.key_class,t.bucket_hash))
 ) THEN RAISE(ABORT,'inventory matching bucket dependencies incomplete') END;
END;
