-- Only matched results can create adoption work. Transitions away from a
-- match still clear any pending adoption for the previous result.
DROP TRIGGER inventory_adoption_result_insert;
DROP TRIGGER inventory_adoption_result_update;
DROP TRIGGER inventory_adoption_match_commit;

CREATE TRIGGER inventory_adoption_result_insert AFTER INSERT ON match_results
WHEN NEW.state='matched_existing' BEGIN
 INSERT INTO inventory_adoption_work(tenant,destination,source_scope,record_key,generation_id,result_set,result_version,source_config_version,destination_config_version,provider,book_identity,source_identity,due_at)
 SELECT tenant,destination,source_scope,record_key,generation_id,result_set,result_version,source_config_version,destination_config_version,provider,book_identity,source_identity,due_at
 FROM inventory_adoption_work_expected
 WHERE (tenant,destination,source_scope,record_key)=(NEW.tenant,NEW.destination,NEW.source_scope,NEW.record_key);
END;

CREATE TRIGGER inventory_adoption_result_update AFTER UPDATE ON match_results
WHEN OLD.state='matched_existing' OR NEW.state='matched_existing' BEGIN
 INSERT INTO inventory_adoption_work(tenant,destination,source_scope,record_key,generation_id,result_set,result_version,source_config_version,destination_config_version,provider,book_identity,source_identity,due_at)
 SELECT tenant,destination,source_scope,record_key,generation_id,result_set,result_version,source_config_version,destination_config_version,provider,book_identity,source_identity,due_at
 FROM inventory_adoption_work_expected
 WHERE NEW.state='matched_existing' AND (tenant,destination,source_scope,record_key)=(NEW.tenant,NEW.destination,NEW.source_scope,NEW.record_key)
 ON CONFLICT(tenant,destination,source_scope,record_key) DO UPDATE SET generation_id=excluded.generation_id,result_set=excluded.result_set,result_version=excluded.result_version,source_config_version=excluded.source_config_version,destination_config_version=excluded.destination_config_version,provider=excluded.provider,book_identity=excluded.book_identity,source_identity=excluded.source_identity,due_at=excluded.due_at,hold_reason=NULL;
 DELETE FROM inventory_adoption_work
 WHERE (tenant,destination,source_scope,record_key)=(NEW.tenant,NEW.destination,NEW.source_scope,NEW.record_key)
 AND (NEW.state!='matched_existing' OR NOT EXISTS(SELECT 1 FROM inventory_adoption_work_expected e WHERE (e.tenant,e.destination,e.source_scope,e.record_key)=(NEW.tenant,NEW.destination,NEW.source_scope,NEW.record_key)));
END;

CREATE TRIGGER inventory_adoption_match_commit BEFORE UPDATE OF state ON inventory_match_sets
WHEN OLD.state='prepared' AND NEW.state='committed' BEGIN
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM inventory_adoption_work_expected e
  WHERE (e.tenant,e.result_set)=(NEW.tenant,NEW.set_id)
  AND NOT EXISTS(SELECT 1 FROM inventory_adoption_work w
   WHERE (w.tenant,w.destination,w.source_scope,w.record_key,w.generation_id,w.result_set,w.result_version,w.source_config_version,w.destination_config_version,w.provider,w.book_identity,w.source_identity)
   =(e.tenant,e.destination,e.source_scope,e.record_key,e.generation_id,e.result_set,e.result_version,e.source_config_version,e.destination_config_version,e.provider,e.book_identity,e.source_identity))
 ) THEN RAISE(ABORT,'inventory adoption work publication incomplete') END;
END;
