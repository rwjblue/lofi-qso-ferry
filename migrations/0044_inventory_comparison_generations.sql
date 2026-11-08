-- Comparison keys belong to the tenant, independently of account credentials
-- and KEK wrapping versions. All index generations remain rebuildable metadata.
CREATE TABLE inventory_comparison_keys (
 tenant TEXT NOT NULL PRIMARY KEY, key_id TEXT NOT NULL, envelope TEXT NOT NULL,
 created_at INTEGER NOT NULL, UNIQUE(tenant,key_id),
 FOREIGN KEY(tenant) REFERENCES accounts(id), CHECK(json_valid(envelope))
);
CREATE TRIGGER inventory_comparison_key_identity BEFORE UPDATE ON inventory_comparison_keys WHEN NEW.tenant!=OLD.tenant OR NEW.key_id!=OLD.key_id OR NEW.created_at!=OLD.created_at BEGIN SELECT RAISE(ABORT,'comparison key identity immutable'); END;
CREATE TRIGGER inventory_comparison_key_retained BEFORE DELETE ON inventory_comparison_keys BEGIN SELECT RAISE(ABORT,'comparison key retained'); END;
CREATE TABLE comparison_domains (
 tenant TEXT NOT NULL PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 source_set_version INTEGER NOT NULL DEFAULT 1 CHECK(source_set_version>0),
 active_generation TEXT, pending_generation TEXT,
 FOREIGN KEY(tenant) REFERENCES accounts(id),
 FOREIGN KEY(tenant,active_generation) REFERENCES index_generations(tenant,generation_id),
 FOREIGN KEY(tenant,pending_generation) REFERENCES index_generations(tenant,generation_id),
 CHECK(active_generation IS NULL OR active_generation IS NOT pending_generation)
);
CREATE TABLE index_generations (
 tenant TEXT NOT NULL, generation_id TEXT NOT NULL, key_id TEXT NOT NULL,
 key_version INTEGER NOT NULL CHECK(key_version>0), policy_version INTEGER NOT NULL CHECK(policy_version>0),
 bucket_ms INTEGER NOT NULL CHECK(bucket_ms>0 AND bucket_ms%60000=0),
 state TEXT NOT NULL DEFAULT 'building' CHECK(state IN ('building','active','retired')),
 created_at INTEGER NOT NULL, PRIMARY KEY(tenant,generation_id),
 FOREIGN KEY(tenant) REFERENCES comparison_domains(tenant),
 FOREIGN KEY(tenant,key_id) REFERENCES inventory_comparison_keys(tenant,key_id)
);
CREATE UNIQUE INDEX comparison_one_build ON index_generations(tenant) WHERE state='building';
CREATE UNIQUE INDEX comparison_one_active ON index_generations(tenant) WHERE state='active';
CREATE TABLE comparison_builds (
 tenant TEXT NOT NULL, generation_id TEXT NOT NULL, scope_id TEXT NOT NULL,
 config_version INTEGER NOT NULL CHECK(config_version>0), version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 cursor_key TEXT NOT NULL DEFAULT '', complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1)),
 PRIMARY KEY(tenant,generation_id,scope_id),
 FOREIGN KEY(tenant,generation_id) REFERENCES index_generations(tenant,generation_id),
 FOREIGN KEY(tenant,scope_id) REFERENCES inventory_scopes(tenant,scope_id)
);
CREATE TABLE comparison_index (
 tenant TEXT NOT NULL, generation_id TEXT NOT NULL, scope_id TEXT NOT NULL,
 record_key TEXT NOT NULL, facet TEXT NOT NULL CHECK(facet IN ('source','receipt')),
 key_class TEXT CHECK(key_class IN ('call_and_time','call_only','time_only','unknown')),
 bucket_hash TEXT, semantic_version INTEGER NOT NULL CHECK(semantic_version>0),
 config_version INTEGER NOT NULL CHECK(config_version>0),
 state TEXT NOT NULL CHECK(state IN ('pending','ready','held','retired')),
 parent_key TEXT, topology_version INTEGER NOT NULL DEFAULT 0 CHECK(topology_version>=0),
 projection_version INTEGER NOT NULL DEFAULT 0 CHECK(projection_version>=0),
 last_page_id TEXT NOT NULL,
 PRIMARY KEY(tenant,generation_id,scope_id,record_key,facet),
 FOREIGN KEY(tenant,generation_id,scope_id) REFERENCES comparison_builds(tenant,generation_id,scope_id),
 CHECK((state='retired' AND key_class IS NULL AND bucket_hash IS NULL) OR
       (state!='retired' AND key_class IS NOT NULL AND length(bucket_hash)=43))
);
CREATE INDEX comparison_bucket ON comparison_index(tenant,generation_id,scope_id,key_class,bucket_hash);
CREATE TABLE bucket_versions (
 tenant TEXT NOT NULL, generation_id TEXT NOT NULL, scope_id TEXT NOT NULL,
 key_class TEXT NOT NULL CHECK(key_class IN ('call_and_time','call_only','time_only','unknown')),
 bucket_hash TEXT NOT NULL CHECK(length(bucket_hash)=43), version INTEGER NOT NULL CHECK(version>0),
 PRIMARY KEY(tenant,generation_id,scope_id,key_class,bucket_hash),
 FOREIGN KEY(tenant,generation_id,scope_id) REFERENCES comparison_builds(tenant,generation_id,scope_id)
);
CREATE TRIGGER comparison_bucket_monotonic BEFORE UPDATE ON bucket_versions WHEN NEW.version<=OLD.version BEGIN SELECT RAISE(ABORT,'comparison bucket version required'); END;
CREATE TRIGGER comparison_bucket_retained BEFORE DELETE ON bucket_versions BEGIN SELECT RAISE(ABORT,'comparison bucket version retained'); END;
CREATE TABLE comparison_work (
 tenant TEXT NOT NULL, generation_id TEXT NOT NULL, scope_id TEXT NOT NULL,
 record_key TEXT NOT NULL, facet TEXT NOT NULL CHECK(facet IN ('source','receipt')),
 work_version INTEGER NOT NULL CHECK(work_version>0), completed_version INTEGER NOT NULL DEFAULT 0,
 due_at INTEGER NOT NULL,
 PRIMARY KEY(tenant,generation_id,scope_id,record_key,facet),
 FOREIGN KEY(tenant,generation_id,scope_id,record_key,facet) REFERENCES comparison_index(tenant,generation_id,scope_id,record_key,facet),
 CHECK(completed_version>=0 AND completed_version<=work_version)
);
CREATE INDEX comparison_work_due ON comparison_work(tenant,due_at,generation_id,scope_id);
CREATE TRIGGER comparison_work_monotonic BEFORE UPDATE ON comparison_work WHEN NEW.work_version<OLD.work_version OR NEW.completed_version<OLD.completed_version BEGIN SELECT RAISE(ABORT,'comparison work regressed'); END;
CREATE TRIGGER comparison_domain_version BEFORE UPDATE ON comparison_domains WHEN NEW.version<=OLD.version OR NEW.source_set_version<OLD.source_set_version BEGIN SELECT RAISE(ABORT,'comparison domain version required'); END;
CREATE TRIGGER comparison_domain_retained BEFORE DELETE ON comparison_domains BEGIN SELECT RAISE(ABORT,'comparison domain retained'); END;
CREATE TRIGGER comparison_generation_retained BEFORE DELETE ON index_generations BEGIN SELECT RAISE(ABORT,'comparison generation retained'); END;
CREATE TRIGGER comparison_build_retained BEFORE DELETE ON comparison_builds BEGIN SELECT RAISE(ABORT,'comparison build retained'); END;
CREATE TRIGGER comparison_generation_insert BEFORE INSERT ON index_generations BEGIN
 SELECT CASE WHEN NEW.state!='building' OR NOT EXISTS(SELECT 1 FROM comparison_domains WHERE tenant=NEW.tenant AND pending_generation IS NULL) THEN RAISE(ABORT,'comparison generation build required') END;
END;
CREATE TRIGGER comparison_generation_enroll AFTER INSERT ON index_generations BEGIN
 INSERT INTO comparison_builds(tenant,generation_id,scope_id,config_version) SELECT tenant,NEW.generation_id,scope_id,config_version FROM inventory_scopes WHERE tenant=NEW.tenant;
 UPDATE comparison_domains SET pending_generation=NEW.generation_id,version=version+1 WHERE tenant=NEW.tenant;
END;
CREATE TRIGGER comparison_generation_transition BEFORE UPDATE ON index_generations BEGIN
 SELECT CASE WHEN NEW.tenant!=OLD.tenant OR NEW.generation_id!=OLD.generation_id OR NEW.key_id!=OLD.key_id OR NEW.key_version!=OLD.key_version OR NEW.policy_version!=OLD.policy_version OR NEW.bucket_ms!=OLD.bucket_ms OR NEW.created_at!=OLD.created_at
  OR NOT ((OLD.state='building' AND NEW.state='active') OR (OLD.state='active' AND NEW.state='retired')) THEN RAISE(ABORT,'comparison generation immutable') END;
 SELECT CASE WHEN NEW.state='active' AND (
  NOT EXISTS(SELECT 1 FROM comparison_domains WHERE tenant=NEW.tenant AND pending_generation=NEW.generation_id)
  OR EXISTS(SELECT 1 FROM inventory_scopes s LEFT JOIN comparison_builds b ON b.tenant=s.tenant AND b.scope_id=s.scope_id AND b.generation_id=NEW.generation_id WHERE s.tenant=NEW.tenant AND (b.scope_id IS NULL OR b.complete!=1 OR b.config_version!=s.config_version))
 ) THEN RAISE(ABORT,'comparison generation incomplete') END;
END;
-- Publication retires the old generation before updating the unique active row.
CREATE TRIGGER comparison_generation_retire BEFORE UPDATE OF state ON index_generations WHEN NEW.state='active' BEGIN
 UPDATE index_generations SET state='retired' WHERE tenant=NEW.tenant AND state='active';
END;
CREATE TRIGGER comparison_generation_publish AFTER UPDATE OF state ON index_generations WHEN NEW.state='active' BEGIN
 UPDATE comparison_domains SET active_generation=NEW.generation_id,pending_generation=NULL,version=version+1 WHERE tenant=NEW.tenant;
END;
CREATE TRIGGER comparison_scope_enroll AFTER INSERT ON inventory_scopes BEGIN
 INSERT INTO comparison_builds(tenant,generation_id,scope_id,config_version) SELECT NEW.tenant,generation_id,NEW.scope_id,NEW.config_version FROM index_generations WHERE tenant=NEW.tenant AND state IN ('building','active');
 UPDATE comparison_domains SET source_set_version=source_set_version+1,version=version+1 WHERE tenant=NEW.tenant AND NEW.provider='lofi';
END;
CREATE TRIGGER comparison_scope_changed AFTER UPDATE OF config_version,state ON inventory_scopes WHEN NEW.config_version!=OLD.config_version OR NEW.state!=OLD.state BEGIN
 UPDATE comparison_builds SET config_version=NEW.config_version,version=version+1,cursor_key='',complete=0 WHERE tenant=NEW.tenant AND scope_id=NEW.scope_id AND generation_id IN (SELECT generation_id FROM index_generations WHERE tenant=NEW.tenant AND state IN ('building','active'));
 UPDATE comparison_domains SET source_set_version=source_set_version+1,version=version+1 WHERE tenant=NEW.tenant AND NEW.provider='lofi';
END;
-- A linked source invalidates reverse census even before it has an inventory scope.
CREATE TRIGGER comparison_source_linked AFTER INSERT ON connections WHEN NEW.kind='lofi' BEGIN
 UPDATE comparison_domains SET source_set_version=source_set_version+1,version=version+1 WHERE tenant=NEW.tenant;
END;
CREATE TRIGGER comparison_source_changed AFTER UPDATE ON connections WHEN (NEW.kind='lofi' OR OLD.kind='lofi') AND (NEW.kind!=OLD.kind OR NEW.status!=OLD.status OR NEW.remote_identity!=OLD.remote_identity OR NEW.credential_version IS NOT OLD.credential_version) BEGIN
 UPDATE comparison_domains SET source_set_version=source_set_version+1,version=version+1 WHERE tenant=NEW.tenant;
END;
CREATE TRIGGER comparison_source_removed AFTER DELETE ON connections WHEN OLD.kind='lofi' BEGIN
 UPDATE comparison_domains SET source_set_version=source_set_version+1,version=version+1 WHERE tenant=OLD.tenant;
END;
