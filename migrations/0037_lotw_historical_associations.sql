-- Raw historical observations are not exact receipt identities. Preserve their
-- original precision in encrypted evidence and keep remote_id semantics intact.
CREATE TABLE lotw_historical_associations (
 id TEXT PRIMARY KEY, tenant TEXT NOT NULL, source TEXT NOT NULL, qso TEXT NOT NULL,
 destination TEXT NOT NULL, book_identity TEXT NOT NULL,
 key_id TEXT NOT NULL, namespace TEXT NOT NULL CHECK(length(namespace)=43),
 bucket TEXT NOT NULL CHECK(length(bucket)=43), record_hash TEXT NOT NULL CHECK(length(record_hash)=43),
 envelope TEXT NOT NULL CHECK(length(CAST(envelope AS BLOB))<=131072),
 generation TEXT NOT NULL, source_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(tenant,key_id,namespace,record_hash),
 FOREIGN KEY(tenant,source) REFERENCES connections(tenant,id),
 FOREIGN KEY(tenant,destination) REFERENCES connections(tenant,id)
);
CREATE INDEX lotw_historical_bucket ON lotw_historical_associations(tenant,key_id,bucket);
CREATE INDEX lotw_historical_owner ON lotw_historical_associations(tenant,source,qso,destination);
ALTER TABLE ledger ADD COLUMN lotw_historical_association_id TEXT REFERENCES lotw_historical_associations(id);

-- Ephemeral native-batch admission: the caller additionally supplies its exact
-- source, inventory and reverse-uniqueness guard on this INSERT.
CREATE TABLE lotw_historical_guards (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, members INTEGER NOT NULL CHECK(members BETWEEN 1 AND 20), tenant TEXT NOT NULL, association_id TEXT NOT NULL,
 source TEXT NOT NULL, qso TEXT NOT NULL, destination TEXT NOT NULL,
 book_identity TEXT NOT NULL, config TEXT NOT NULL, credential_version TEXT NOT NULL,
 generation TEXT NOT NULL, source_hash TEXT NOT NULL,
 key_id TEXT NOT NULL, clock INTEGER NOT NULL, comparison_policy INTEGER NOT NULL CHECK(comparison_policy IN(1,2)), namespace TEXT NOT NULL, bucket TEXT NOT NULL,
 record_hash TEXT NOT NULL, envelope TEXT NOT NULL CHECK(length(CAST(envelope AS BLOB))<=131072),
 lease_token TEXT NOT NULL, lease_fence INTEGER NOT NULL, now INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 CHECK(expires_at>now AND expires_at<=now+60000)
);
CREATE INDEX lotw_historical_guard_batch ON lotw_historical_guards(batch_id,association_id);
CREATE TABLE lotw_historical_commit_checks(id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1));
CREATE TRIGGER lotw_historical_admission BEFORE INSERT ON lotw_historical_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM lotw_ownership_state s JOIN source_historical_state k ON k.tenant=s.tenant AND k.key_id=s.key_id JOIN leases x ON x.tenant=s.tenant AND x.scope='lotw-ownership' WHERE s.tenant=NEW.tenant AND s.key_id=NEW.key_id AND s.clock=NEW.clock AND s.comparison_policy=NEW.comparison_policy AND x.token=NEW.lease_token AND x.fence=NEW.lease_fence AND x.expires_at>=NEW.expires_at AND NEW.expires_at>MAX(NEW.now,CAST(unixepoch('subsec')*1000 AS INTEGER)) AND NOT EXISTS(SELECT 1 FROM lotw_ownership_inputs i WHERE i.tenant=s.tenant AND i.status IN('pending','held')) AND NOT EXISTS(SELECT 1 FROM lotw_ownership_owners o WHERE o.tenant=s.tenant AND o.owner_hash IS NULL)) THEN RAISE(ABORT,'LoTW historical ownership unavailable') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ledger l JOIN accounts a ON a.id=l.tenant AND a.status='active' JOIN connections c ON c.tenant=l.tenant AND c.id=l.source AND c.kind='lofi' AND c.status='active' JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination WHERE l.tenant=NEW.tenant AND l.source=NEW.source AND l.qso=NEW.qso AND l.destination=NEW.destination AND l.generation=NEW.generation AND l.source_hash=NEW.source_hash AND l.lotw_historical_association_id IS NULL AND l.remote_id IS NULL AND l.sent_hash IS NULL AND l.remote_hash IS NULL AND l.confirmed=0 AND l.provenance='unknown' AND d.kind='lotw' AND d.status='active' AND d.remote_identity=NEW.book_identity AND d.config=NEW.config AND d.credential_version=NEW.credential_version) THEN RAISE(ABORT,'LoTW historical source changed') END;
 -- A historical match never erases actual or possibly accepted delivery.
 SELECT CASE WHEN EXISTS(SELECT 1 FROM lotw_ownership_inputs WHERE tenant=NEW.tenant AND source=NEW.source AND qso=NEW.qso AND kind IN('mapping','attempt','legacy')) OR EXISTS(SELECT 1 FROM lotw_ownership_unsafe_attempts WHERE tenant=NEW.tenant AND source=NEW.source AND qso=NEW.qso) THEN RAISE(ABORT,'LoTW historical prior delivery') END;
END;
CREATE TRIGGER lotw_historical_guard_immutable BEFORE UPDATE ON lotw_historical_guards BEGIN SELECT RAISE(ABORT,'immutable LoTW historical guard'); END;
CREATE TRIGGER lotw_historical_insert BEFORE INSERT ON lotw_historical_associations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM lotw_historical_associations WHERE id=NEW.id OR (tenant=NEW.tenant AND key_id=NEW.key_id AND namespace=NEW.namespace AND record_hash=NEW.record_hash)) THEN RAISE(ABORT,'immutable LoTW historical association') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM lotw_historical_guards g JOIN lotw_ownership_state s ON s.tenant=g.tenant AND s.clock=g.clock+(SELECT COUNT(*) FROM lotw_historical_associations a JOIN lotw_historical_guards z ON z.association_id=a.id WHERE z.batch_id=g.batch_id)+(s.comparison_policy-g.comparison_policy) AND s.key_id=g.key_id JOIN leases x ON x.tenant=g.tenant AND x.scope='lotw-ownership' AND x.token=g.lease_token AND x.fence=g.lease_fence AND x.expires_at>=g.expires_at WHERE (SELECT COUNT(*) FROM lotw_historical_guards z WHERE z.batch_id=g.batch_id)=g.members AND g.association_id=NEW.id AND g.tenant=NEW.tenant AND g.source=NEW.source AND g.qso=NEW.qso AND g.destination=NEW.destination AND g.book_identity=NEW.book_identity AND g.key_id=NEW.key_id AND g.namespace=NEW.namespace AND g.bucket=NEW.bucket AND g.record_hash=NEW.record_hash AND g.envelope=NEW.envelope AND g.generation=NEW.generation AND g.source_hash=NEW.source_hash AND g.now=NEW.created_at AND g.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)) THEN RAISE(ABORT,'LoTW historical ownership unavailable') END;
END;
CREATE TRIGGER lotw_historical_clock AFTER INSERT ON lotw_historical_associations BEGIN
 UPDATE lotw_ownership_state SET clock=clock+1,comparison_policy=2 WHERE tenant=NEW.tenant;
END;
CREATE TRIGGER lotw_historical_immutable BEFORE UPDATE ON lotw_historical_associations BEGIN SELECT RAISE(ABORT,'immutable LoTW historical association'); END;
CREATE TRIGGER lotw_historical_retained BEFORE DELETE ON lotw_historical_associations BEGIN SELECT RAISE(ABORT,'retained LoTW historical association'); END;
CREATE TRIGGER lotw_historical_reference_insert BEFORE INSERT ON ledger WHEN NEW.lotw_historical_association_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'LoTW historical reference requires existing source'); END;
CREATE TRIGGER lotw_historical_reference_update BEFORE UPDATE OF lotw_historical_association_id ON ledger WHEN NEW.lotw_historical_association_id IS NOT OLD.lotw_historical_association_id BEGIN
 SELECT CASE WHEN OLD.lotw_historical_association_id IS NOT NULL OR NEW.lotw_historical_association_id IS NULL OR NOT EXISTS(SELECT 1 FROM lotw_historical_associations a JOIN lotw_historical_guards g ON g.association_id=a.id AND g.tenant=a.tenant WHERE a.id=NEW.lotw_historical_association_id AND a.tenant=NEW.tenant AND a.source=NEW.source AND a.qso=NEW.qso AND a.destination=NEW.destination AND a.generation=NEW.generation AND a.source_hash=NEW.source_hash AND g.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)) THEN RAISE(ABORT,'immutable LoTW historical reference') END;
END;
CREATE TRIGGER lotw_historical_finish BEFORE DELETE ON lotw_historical_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM lotw_historical_associations a JOIN ledger l ON l.tenant=a.tenant AND l.source=a.source AND l.qso=a.qso AND l.destination=a.destination AND l.lotw_historical_association_id=a.id AND l.generation=a.generation AND l.source_hash=a.source_hash JOIN lotw_ownership_state s ON s.tenant=a.tenant AND s.key_id=a.key_id AND s.clock=OLD.clock+OLD.members+(2-OLD.comparison_policy) AND s.comparison_policy=2 JOIN source_historical_state k ON k.tenant=s.tenant AND k.key_id=s.key_id JOIN leases x ON x.tenant=s.tenant AND x.scope='lotw-ownership' AND x.token=OLD.lease_token AND x.fence=OLD.lease_fence AND x.expires_at>=OLD.expires_at WHERE a.id=OLD.association_id AND NOT EXISTS(SELECT 1 FROM lotw_historical_guards g LEFT JOIN ledger v ON v.tenant=g.tenant AND v.source=g.source AND v.qso=g.qso AND v.destination=g.destination AND v.lotw_historical_association_id=g.association_id AND v.generation=g.generation AND v.source_hash=g.source_hash WHERE g.batch_id=OLD.batch_id AND v.tenant IS NULL) AND OLD.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)) THEN RAISE(ABORT,'LoTW historical publication changed') END;
END;

-- Existing consumers (including old stage/dispatch triggers) inherit the block.
-- QRZ book/LOGID semantics are unchanged. LoTW history blocks the owner across
-- all LoTW routes, even after station changes. Original metadata stays retained.
DROP VIEW historical_association_write_blocks;
CREATE VIEW historical_association_write_blocks AS
 SELECT tenant,source,qso,destination FROM historical_associations
 UNION ALL
 SELECT h.tenant,h.source,h.qso,d.id AS destination FROM historical_associations h JOIN connections d ON d.tenant=h.tenant AND d.kind=h.vendor AND d.remote_identity=h.book_identity
 UNION ALL
 SELECT h.tenant,h.source,h.qso,d.id AS destination FROM lotw_historical_associations h JOIN connections d ON d.tenant=h.tenant AND d.kind='lotw';
