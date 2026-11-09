-- QSL reports are positive evidence with their own stream checkpoint.
-- They never create receipt facets, membership, coverage or delivery work.
CREATE TABLE inventory_lotw_confirmations (
 tenant TEXT NOT NULL, scope_id TEXT NOT NULL, scope_version INTEGER NOT NULL CHECK(scope_version>0),
 stream_id TEXT NOT NULL, stream_version INTEGER NOT NULL CHECK(stream_version>0),
 connection_id TEXT NOT NULL, identity_hash TEXT, body_hash TEXT NOT NULL,
 confirmed_at TEXT NOT NULL, observed_at INTEGER NOT NULL CHECK(observed_at>0),
 envelope TEXT NOT NULL CHECK(json_valid(envelope)),
 PRIMARY KEY(tenant,scope_id,scope_version,body_hash),
 FOREIGN KEY(tenant,scope_id,stream_id) REFERENCES inventory_streams(tenant,scope_id,stream_id),
 FOREIGN KEY(tenant,connection_id) REFERENCES connections(tenant,id)
);
CREATE INDEX inventory_lotw_confirmation_identity
 ON inventory_lotw_confirmations(tenant,scope_id,scope_version,identity_hash,confirmed_at DESC,body_hash)
 WHERE identity_hash IS NOT NULL;
