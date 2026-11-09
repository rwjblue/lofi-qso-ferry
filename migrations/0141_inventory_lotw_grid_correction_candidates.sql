-- A correction uses existing ownership and never enters fresh delivery.
CREATE INDEX inventory_lotw_grid_candidates ON match_results(derived_at,tenant,destination,source_scope,record_key)
 WHERE state='projection_mismatch' AND reason='historical_grid_changed';

CREATE VIEW inventory_lotw_grid_correction_candidates AS
 SELECT r.tenant,r.destination,r.source_scope,r.record_key,r.set_id AS result_set,r.version AS result_version,
        r.derived_at,r.remote_key,h.generation_id,a.id AS association_id,
        a.remote_payload AS adopted_remote_payload,a.destination_scope AS adopted_destination,
        src.current_projection_version AS projection_version,src.payload_id AS projection_payload,
        remote.current_projection_version AS remote_version,remote.payload_id AS remote_payload,
        d.connection_id AS destination_connection,k.id AS destination_credential,c.config AS destination_config
 FROM match_results r
 JOIN inventory_match_sets h ON (h.tenant,h.set_id)=(r.tenant,r.set_id) AND h.state='committed'
 JOIN inventory_scopes d ON (d.tenant,d.scope_id)=(r.tenant,r.destination) AND d.provider='lotw' AND d.state='observing'
 JOIN inventory_scopes s ON (s.tenant,s.scope_id)=(r.tenant,r.source_scope) AND s.provider='lofi' AND s.state='observing'
 JOIN accounts account ON account.id=r.tenant AND account.status='active'
 JOIN connections c ON (c.tenant,c.id,c.kind,c.status,c.remote_identity)=(d.tenant,d.connection_id,'lotw','active',d.logical_identity)
 JOIN private_data k ON (k.tenant,k.connection,k.id,k.kind)=(c.tenant,c.id,c.credential_version,'credential')
   AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>unixepoch('subsec')*1000)
 JOIN inventory_historical_associations a ON (a.tenant,a.provider,a.book_identity,a.source_identity,a.record_key)=(r.tenant,'lotw',d.logical_identity,s.logical_identity,r.record_key)
 JOIN inventory_match_records src ON (src.tenant,src.set_id,src.scope_id,src.record_key,src.facet)=(r.tenant,r.set_id,r.source_scope,r.record_key,'source')
 JOIN inventory_match_records remote ON (remote.tenant,remote.set_id,remote.scope_id,remote.record_key,remote.facet)=(r.tenant,r.set_id,r.destination,r.remote_key,'receipt')
 WHERE r.state='projection_mismatch' AND r.reason='historical_grid_changed'
 AND (r.remote_key=a.remote_record_key OR (a.remote_record_key GLOB 'lotw-variant-v1:*' AND substr(r.remote_key,1,60)=substr(a.remote_record_key,1,60)))
 AND src.projection_state='ready' AND remote.projection_state='ready'
 AND h.sync_scope_version=coalesce((SELECT p.version FROM inventory_sync_scopes p WHERE (p.tenant,p.destination)=(c.tenant,c.id)),0)
 AND NOT EXISTS(SELECT 1 FROM inventory_restore_locks lock WHERE lock.tenant=r.tenant)
 AND NOT EXISTS(SELECT 1 FROM inventory_fresh_start_lock WHERE id=1)
 AND NOT EXISTS(SELECT 1 FROM inventory_match_stale_sets stale WHERE (stale.tenant,stale.set_id)=(r.tenant,r.set_id));
