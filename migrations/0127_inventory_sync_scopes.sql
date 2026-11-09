-- A sync scope is independent of the connection's identity and scan cursor.
CREATE TABLE inventory_sync_scopes (
 tenant TEXT NOT NULL,destination TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN('all','since','forward')),
 since TEXT,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 changed_at INTEGER NOT NULL CHECK(changed_at>=0),
 PRIMARY KEY(tenant,destination),
 FOREIGN KEY(tenant,destination) REFERENCES connections(tenant,id),
 CHECK((mode='since' AND since IS NOT NULL AND length(since)=10
        AND since GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND substr(since,1,4)!='0000' AND date(since,'+0 days') IS since)
        OR (mode!='since' AND since IS NULL))
);
