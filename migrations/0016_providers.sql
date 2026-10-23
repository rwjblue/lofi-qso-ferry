-- Provider membership is shared by connections and global request budgets.
-- New providers can now extend this catalog without rebuilding the ledger.
CREATE TABLE providers (kind TEXT PRIMARY KEY);
INSERT INTO providers(kind) VALUES('lofi'),('qrz'),('lotw'),('clublog');

-- D1 runs each migration transactionally with foreign keys enabled. Every
-- connection reference uses NO ACTION (not CASCADE); deferring validation
-- preserves all child rows while the parent is recreated under its original
-- name. Avoid ALTER TABLE RENAME so existing FK and trigger SQL stays intact.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE connections_provider_backup AS SELECT * FROM connections;
DROP TABLE connections;
CREATE TABLE connections (
 tenant TEXT NOT NULL REFERENCES accounts(id), id TEXT NOT NULL,
 kind TEXT NOT NULL REFERENCES providers(kind),
 remote_identity TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'disabled',
 credential_version TEXT, config TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, last_poll_at INTEGER,
 cutover TEXT, PRIMARY KEY(tenant,id), UNIQUE(tenant,kind,remote_identity)
);
INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,config,created_at,last_poll_at,cutover)
 SELECT tenant,id,kind,remote_identity,label,status,credential_version,config,created_at,last_poll_at,cutover FROM connections_provider_backup;
DROP TABLE connections_provider_backup;
CREATE INDEX admin_connections_created ON connections(created_at DESC,tenant,id);

CREATE TABLE vendor_requests_provider_backup AS SELECT * FROM vendor_requests;
DROP TABLE vendor_requests;
CREATE TABLE vendor_requests (
 vendor TEXT PRIMARY KEY REFERENCES providers(kind),
 window_start INTEGER NOT NULL,
 requests INTEGER NOT NULL DEFAULT 0 CHECK(requests>=0),
 background_requests INTEGER NOT NULL DEFAULT 0 CHECK(background_requests>=0),
 cooldown_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO vendor_requests(vendor,window_start,requests,background_requests,cooldown_until)
 SELECT vendor,window_start,requests,background_requests,cooldown_until FROM vendor_requests_provider_backup;
DROP TABLE vendor_requests_provider_backup;
PRAGMA defer_foreign_keys = OFF;
