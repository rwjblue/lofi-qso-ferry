-- Unknown upstream membership is a scope-wide matching barrier. A retained
-- old hash cannot prove where an unresolved identity currently belongs.
CREATE INDEX inventory_unresolved_members
 ON inventory_partition_membership(tenant,scope_id,facet,stream_id,partition_id)
 WHERE state='unresolved';
CREATE INDEX inventory_scope_connection
 ON inventory_scopes(tenant,connection_id,scope_id);
