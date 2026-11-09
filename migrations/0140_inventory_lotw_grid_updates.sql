-- Durable claims and readback state for corrections to adopted contacts.
CREATE TABLE inventory_lotw_grid_updates (
 tenant TEXT NOT NULL, association_id TEXT NOT NULL, source_scope TEXT NOT NULL, source_payload TEXT NOT NULL,
 destination_scope TEXT, prior_remote_key TEXT, verified_remote_key TEXT,
 verified_projection_hash TEXT CHECK(verified_projection_hash IS NULL OR length(verified_projection_hash)=43),
 state TEXT NOT NULL CHECK(state IN('deferred','uncertain','submitted','observed','attention')),
 reason TEXT CHECK(reason IS NULL OR (length(reason) BETWEEN 1 AND 64 AND reason NOT GLOB '*[^a-z0-9_]*')),
 due_at INTEGER NOT NULL, claimed_at INTEGER, checked_at INTEGER, checks INTEGER NOT NULL DEFAULT 0 CHECK(checks>=0),
 envelope TEXT CHECK(envelope IS NULL OR (json_valid(envelope) AND length(envelope)<=65536)),
 PRIMARY KEY(tenant,association_id,source_payload),
 FOREIGN KEY(tenant,association_id) REFERENCES inventory_historical_associations(tenant,id),
 FOREIGN KEY(tenant,destination_scope) REFERENCES inventory_scopes(tenant,scope_id),
 FOREIGN KEY(tenant,source_scope,source_payload) REFERENCES comparison_projection_payloads(tenant,scope_id,payload_id),
 CHECK((claimed_at IS NULL AND envelope IS NULL AND state='deferred')
       OR (claimed_at IS NOT NULL AND envelope IS NOT NULL AND state!='deferred'))
);
CREATE UNIQUE INDEX inventory_lotw_grid_update_pending ON inventory_lotw_grid_updates(tenant,association_id)
 WHERE state IN('uncertain','submitted','attention');
CREATE INDEX inventory_lotw_grid_update_due ON inventory_lotw_grid_updates(due_at,tenant,association_id)
 WHERE state IN('uncertain','submitted');
CREATE INDEX inventory_lotw_grid_update_observed ON inventory_lotw_grid_updates(tenant,association_id,claimed_at DESC)
 WHERE state='observed';
CREATE INDEX inventory_lotw_grid_update_variant ON inventory_lotw_grid_updates(tenant,destination_scope,substr(verified_remote_key,1,60))
 WHERE state='observed' AND verified_remote_key IS NOT NULL;
