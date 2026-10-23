-- Short-lived encrypted readback, independent of delivery receipts or cursors.
ALTER TABLE partitions ADD COLUMN history_scope TEXT;
ALTER TABLE partitions ADD COLUMN history_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE partitions ADD COLUMN history_accessed_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX history_partition_expiry ON partitions(tenant,source,destination,expires_at) WHERE history_scope IS NOT NULL;
CREATE TABLE history_inventory_pages (
 tenant TEXT NOT NULL, source TEXT NOT NULL, destination TEXT NOT NULL, partition TEXT NOT NULL,
 page INTEGER NOT NULL, payload_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'history_inventory' CHECK(kind='history_inventory'),
 PRIMARY KEY(tenant,source,destination,partition,page),
 FOREIGN KEY(tenant,source,destination,partition) REFERENCES partitions(tenant,source,destination,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant,destination,payload_id,kind) REFERENCES private_data(tenant,connection,id,kind) ON DELETE CASCADE
);
CREATE TABLE history_inventory_neighborhoods (
 tenant TEXT NOT NULL, source TEXT NOT NULL, destination TEXT NOT NULL, partition TEXT NOT NULL,
 identity_hash TEXT NOT NULL, neighborhood_hash TEXT NOT NULL, page INTEGER NOT NULL, record_index INTEGER NOT NULL,
 PRIMARY KEY(tenant,source,destination,partition,identity_hash),
 FOREIGN KEY(tenant,source,destination,partition,page) REFERENCES history_inventory_pages(tenant,source,destination,partition,page) ON DELETE CASCADE
);
CREATE INDEX history_neighborhood_lookup ON history_inventory_neighborhoods(tenant,source,destination,partition,neighborhood_hash);
CREATE TRIGGER history_page_cleanup AFTER DELETE ON history_inventory_pages BEGIN
 DELETE FROM private_data WHERE tenant=OLD.tenant AND connection=OLD.destination AND id=OLD.payload_id AND kind='history_inventory';
END;
CREATE TRIGGER history_partition_lease_cleanup AFTER DELETE ON partitions WHEN OLD.history_scope IS NOT NULL BEGIN
 DELETE FROM leases WHERE tenant=OLD.tenant AND scope='history:'||OLD.id;
END;
CREATE TABLE history_inventory_guards (
 id TEXT PRIMARY KEY, tenant TEXT NOT NULL, source TEXT NOT NULL, destination TEXT NOT NULL,
 partition TEXT NOT NULL, evidence TEXT NOT NULL, lease_scope TEXT NOT NULL, token TEXT NOT NULL, fence INTEGER NOT NULL, now INTEGER NOT NULL,
 destination_version TEXT NOT NULL, destination_config TEXT NOT NULL,
 source_remote TEXT NOT NULL, destination_remote TEXT NOT NULL, destination_kind TEXT NOT NULL,
 qso TEXT NOT NULL, generation TEXT NOT NULL, added_bytes INTEGER NOT NULL
);
CREATE TRIGGER history_inventory_guard BEFORE INSERT ON history_inventory_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM leases WHERE tenant=NEW.tenant AND scope=NEW.lease_scope AND token=NEW.token AND fence=NEW.fence AND expires_at>NEW.now) THEN RAISE(ABORT,'history lease lost') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM partitions WHERE tenant=NEW.tenant AND source=NEW.source AND destination=NEW.destination AND id=NEW.partition AND evidence=NEW.evidence AND expires_at>NEW.now AND history_scope IS NOT NULL) THEN RAISE(ABORT,'history partition changed') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM accounts WHERE id=NEW.tenant AND status='active') THEN RAISE(ABORT,'history account inactive') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM connections s JOIN connections d ON d.tenant=s.tenant JOIN private_data sp ON sp.tenant=s.tenant AND sp.connection=s.id AND sp.id=s.credential_version AND sp.kind='credential' JOIN private_data dp ON dp.tenant=d.tenant AND dp.connection=d.id AND dp.id=d.credential_version AND dp.kind='credential' WHERE s.tenant=NEW.tenant AND s.id=NEW.source AND s.kind='lofi' AND s.status='active' AND s.remote_identity=NEW.source_remote AND d.id=NEW.destination AND d.kind=NEW.destination_kind AND d.status='active' AND d.credential_version=NEW.destination_version AND json_object('bookId',json_extract(d.config,'$.bookId'),'stationCallsign',json_extract(d.config,'$.stationCallsign'),'startDate',json_extract(d.config,'$.startDate'),'endDate',json_extract(d.config,'$.endDate'),'readAccess',json_extract(d.config,'$.readAccess'),'stations',json((SELECT json_group_array(json_array(json_extract(value,'$.callsign'),json_extract(value,'$.dxcc'))) FROM json_each(CASE WHEN json_type(d.config,'$.stations')='array' THEN json_extract(d.config,'$.stations') ELSE json_array(json_extract(d.config,'$.station')) END))))=NEW.destination_config AND d.remote_identity=NEW.destination_remote AND sp.revoked_at IS NULL AND (sp.expires_at IS NULL OR sp.expires_at>NEW.now) AND dp.revoked_at IS NULL AND (dp.expires_at IS NULL OR dp.expires_at>NEW.now)) THEN RAISE(ABORT,'history connection changed') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ledger WHERE tenant=NEW.tenant AND source=NEW.source AND qso=NEW.qso AND destination=NEW.destination AND generation=NEW.generation) THEN RAISE(ABORT,'history source changed') END;
 SELECT CASE WHEN (SELECT COALESCE(SUM(history_bytes),0) FROM partitions WHERE tenant=NEW.tenant AND source=NEW.source AND destination=NEW.destination AND history_scope IS NOT NULL)+NEW.added_bytes>134217728 THEN RAISE(ABORT,'history retention capacity changed') END;
END;

-- Temporary proof rows live only inside an atomic adoption batch.
CREATE TABLE history_adoption_guards(id TEXT PRIMARY KEY);
