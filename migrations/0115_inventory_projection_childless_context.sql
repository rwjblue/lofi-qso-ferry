-- A newly indexed child has its own projection work and reads current topology.
-- Existing pending jobs still need the newest topology to publish their receipt.
DROP TRIGGER inventory_projection_job_enqueue_insert;
CREATE TRIGGER inventory_projection_job_enqueue_insert AFTER INSERT ON projection_domains BEGIN
 INSERT INTO inventory_projection_jobs(tenant,generation_id,scope_id,operation_key,config_version,topology_version,work_version,due_at)
 SELECT NEW.tenant,g.generation_id,s.scope_id,NEW.operation_key,s.config_version,NEW.topology_version,1,0
 FROM inventory_scopes s JOIN index_generations g ON g.tenant=s.tenant AND g.state IN('active','building')
 WHERE s.tenant=NEW.tenant AND s.scope_id=NEW.scope_id AND s.provider='lofi'
 AND EXISTS(SELECT 1 FROM comparison_index i INDEXED BY comparison_index_parent_cursor
  WHERE (i.tenant,i.generation_id,i.scope_id,i.parent_key,i.facet)=(NEW.tenant,g.generation_id,NEW.scope_id,NEW.operation_key,'source'))
 ON CONFLICT(tenant,generation_id,scope_id,operation_key) DO UPDATE SET config_version=excluded.config_version,topology_version=excluded.topology_version,work_version=inventory_projection_jobs.work_version+1,cursor_key='',due_at=0;
END;
DROP TRIGGER inventory_projection_job_enqueue_update;
CREATE TRIGGER inventory_projection_job_enqueue_update AFTER UPDATE OF topology_version ON projection_domains WHEN NEW.topology_version!=OLD.topology_version BEGIN
 INSERT INTO inventory_projection_jobs(tenant,generation_id,scope_id,operation_key,config_version,topology_version,work_version,due_at)
 SELECT NEW.tenant,g.generation_id,s.scope_id,NEW.operation_key,s.config_version,NEW.topology_version,1,0
 FROM inventory_scopes s JOIN index_generations g ON g.tenant=s.tenant AND g.state IN('active','building')
 WHERE s.tenant=NEW.tenant AND s.scope_id=NEW.scope_id AND s.provider='lofi'
 AND (EXISTS(SELECT 1 FROM comparison_index i INDEXED BY comparison_index_parent_cursor
  WHERE (i.tenant,i.generation_id,i.scope_id,i.parent_key,i.facet)=(NEW.tenant,g.generation_id,NEW.scope_id,NEW.operation_key,'source'))
 OR EXISTS(SELECT 1 FROM inventory_projection_jobs j
  WHERE (j.tenant,j.generation_id,j.scope_id,j.operation_key)=(NEW.tenant,g.generation_id,NEW.scope_id,NEW.operation_key) AND j.completed_version<j.work_version))
 ON CONFLICT(tenant,generation_id,scope_id,operation_key) DO UPDATE SET config_version=excluded.config_version,topology_version=excluded.topology_version,work_version=inventory_projection_jobs.work_version+1,cursor_key='',due_at=0;
END;
