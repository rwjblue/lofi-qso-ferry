-- QRZ LOGIDs identify remote records independently of their recorded time
-- precision. Ownership survives edited/deleted source metadata and reconnects.
CREATE TABLE historical_remote_owners (
 tenant TEXT NOT NULL, vendor TEXT NOT NULL CHECK(vendor='qrz'),
 book_identity TEXT NOT NULL CHECK(length(book_identity)>0),
 remote_id TEXT NOT NULL CHECK(length(remote_id) BETWEEN 1 AND 64 AND remote_id NOT GLOB '*[^0-9]*' AND (remote_id='0' OR substr(remote_id,1,1)!='0')),
 source TEXT NOT NULL, qso TEXT NOT NULL, destination TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(tenant,vendor,book_identity,remote_id),
 FOREIGN KEY(tenant,source) REFERENCES connections(tenant,id),
 FOREIGN KEY(tenant,destination) REFERENCES connections(tenant,id)
);
CREATE INDEX historical_remote_owner_source ON historical_remote_owners(tenant,source,qso,destination);
CREATE TRIGGER historical_remote_owner_insert BEFORE INSERT ON historical_remote_owners BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM historical_remote_owners h WHERE h.tenant=NEW.tenant AND h.vendor=NEW.vendor AND h.book_identity=NEW.book_identity AND h.remote_id=NEW.remote_id AND (h.source!=NEW.source OR h.qso!=NEW.qso)) THEN RAISE(ABORT,'historical remote ownership conflict') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM connections d WHERE d.tenant=NEW.tenant AND d.id=NEW.destination AND d.kind=NEW.vendor AND d.remote_identity=NEW.book_identity) THEN RAISE(ABORT,'historical remote scope changed') END;
END;
CREATE TRIGGER historical_remote_owner_immutable BEFORE UPDATE ON historical_remote_owners BEGIN SELECT RAISE(ABORT,'immutable historical remote owner'); END;
CREATE TRIGGER historical_remote_owner_retained BEFORE DELETE ON historical_remote_owners BEGIN SELECT RAISE(ABORT,'historical remote owner requires explicit review'); END;

INSERT INTO historical_remote_owners(tenant,vendor,book_identity,remote_id,source,qso,destination,created_at)
SELECT l.tenant,'qrz',d.remote_identity,CASE WHEN length(l.remote_id) BETWEEN 1 AND 64 AND l.remote_id NOT GLOB '*[^0-9]*' THEN COALESCE(NULLIF(ltrim(l.remote_id,'0'),''),'0') ELSE l.remote_id END,l.source,l.qso,l.destination,l.updated_at FROM ledger l JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination WHERE d.kind='qrz' AND length(l.remote_id) BETWEEN 1 AND 64 AND l.remote_id NOT GLOB '*[^0-9]*'
ON CONFLICT(tenant,vendor,book_identity,remote_id) DO NOTHING;

INSERT INTO historical_remote_owners(tenant,vendor,book_identity,remote_id,source,qso,destination,created_at)
SELECT r.tenant,'qrz',d.remote_identity,CASE WHEN length(r.remote_id) BETWEEN 1 AND 64 AND r.remote_id NOT GLOB '*[^0-9]*' THEN COALESCE(NULLIF(ltrim(r.remote_id,'0'),''),'0') ELSE r.remote_id END,r.source,r.qso,r.destination,0 FROM legacy_qrz_identity_reservations r JOIN connections d ON d.tenant=r.tenant AND d.id=r.destination WHERE d.kind='qrz' AND length(r.remote_id) BETWEEN 1 AND 64 AND r.remote_id NOT GLOB '*[^0-9]*'
ON CONFLICT(tenant,vendor,book_identity,remote_id) DO NOTHING;

-- Unrepresentable older IDs remain behind the existing destination-wide hold.
-- Never infer a numeric identity or discard their unknown reservation.
INSERT INTO legacy_qrz_identity_reservations(tenant,destination,source,qso,remote_id)
SELECT l.tenant,l.destination,l.source,l.qso,l.remote_id FROM ledger l JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination WHERE d.kind='qrz' AND l.remote_id IS NOT NULL AND (length(l.remote_id) NOT BETWEEN 1 AND 64 OR l.remote_id GLOB '*[^0-9]*')
ON CONFLICT(tenant,destination,source,qso) DO NOTHING;

-- Preserve the older identity/legacy-reservation triggers. These additional
-- triggers also protect old binaries and ordinary completed receipt mappings.
CREATE TRIGGER historical_remote_mapping_insert AFTER INSERT ON ledger WHEN NEW.remote_id IS NOT NULL AND EXISTS(SELECT 1 FROM connections d WHERE d.tenant=NEW.tenant AND d.id=NEW.destination AND d.kind='qrz') BEGIN
 INSERT INTO historical_remote_owners(tenant,vendor,book_identity,remote_id,source,qso,destination,created_at) SELECT NEW.tenant,'qrz',d.remote_identity,CASE WHEN length(NEW.remote_id) BETWEEN 1 AND 64 AND NEW.remote_id NOT GLOB '*[^0-9]*' THEN COALESCE(NULLIF(ltrim(NEW.remote_id,'0'),''),'0') ELSE NEW.remote_id END,NEW.source,NEW.qso,NEW.destination,NEW.updated_at FROM connections d WHERE d.tenant=NEW.tenant AND d.id=NEW.destination AND length(NEW.remote_id) BETWEEN 1 AND 64 AND NEW.remote_id NOT GLOB '*[^0-9]*' ON CONFLICT(tenant,vendor,book_identity,remote_id) DO NOTHING;
 INSERT INTO legacy_qrz_identity_reservations(tenant,destination,source,qso,remote_id) SELECT NEW.tenant,NEW.destination,NEW.source,NEW.qso,NEW.remote_id WHERE length(NEW.remote_id) NOT BETWEEN 1 AND 64 OR NEW.remote_id GLOB '*[^0-9]*' ON CONFLICT(tenant,destination,source,qso) DO NOTHING;
END;
CREATE TRIGGER historical_remote_mapping_update AFTER UPDATE OF remote_id ON ledger WHEN NEW.remote_id IS NOT NULL AND EXISTS(SELECT 1 FROM connections d WHERE d.tenant=NEW.tenant AND d.id=NEW.destination AND d.kind='qrz') BEGIN
 INSERT INTO historical_remote_owners(tenant,vendor,book_identity,remote_id,source,qso,destination,created_at) SELECT NEW.tenant,'qrz',d.remote_identity,CASE WHEN length(NEW.remote_id) BETWEEN 1 AND 64 AND NEW.remote_id NOT GLOB '*[^0-9]*' THEN COALESCE(NULLIF(ltrim(NEW.remote_id,'0'),''),'0') ELSE NEW.remote_id END,NEW.source,NEW.qso,NEW.destination,NEW.updated_at FROM connections d WHERE d.tenant=NEW.tenant AND d.id=NEW.destination AND length(NEW.remote_id) BETWEEN 1 AND 64 AND NEW.remote_id NOT GLOB '*[^0-9]*' ON CONFLICT(tenant,vendor,book_identity,remote_id) DO NOTHING;
 INSERT INTO legacy_qrz_identity_reservations(tenant,destination,source,qso,remote_id) SELECT NEW.tenant,NEW.destination,NEW.source,NEW.qso,NEW.remote_id WHERE length(NEW.remote_id) NOT BETWEEN 1 AND 64 OR NEW.remote_id GLOB '*[^0-9]*' ON CONFLICT(tenant,destination,source,qso) DO NOTHING;
END;

-- A wider historical association is observation-only forever. It cannot be
-- promoted by changing ledger state, clearing remote_id or reconnecting a book.
CREATE TABLE historical_associations (
 tenant TEXT NOT NULL, vendor TEXT NOT NULL CHECK(vendor='qrz'), book_identity TEXT NOT NULL,
 remote_id TEXT NOT NULL, source TEXT NOT NULL, qso TEXT NOT NULL, destination TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(tenant,vendor,book_identity,remote_id),
 FOREIGN KEY(tenant,vendor,book_identity,remote_id) REFERENCES historical_remote_owners(tenant,vendor,book_identity,remote_id),
 FOREIGN KEY(tenant,source) REFERENCES connections(tenant,id),
 FOREIGN KEY(tenant,destination) REFERENCES connections(tenant,id)
);
CREATE INDEX historical_association_source ON historical_associations(tenant,source,qso,destination);
CREATE TRIGGER historical_association_owner BEFORE INSERT ON historical_associations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM historical_associations h WHERE h.tenant=NEW.tenant AND h.vendor=NEW.vendor AND h.book_identity=NEW.book_identity AND h.remote_id=NEW.remote_id AND (h.source!=NEW.source OR h.qso!=NEW.qso OR h.destination!=NEW.destination)) THEN RAISE(ABORT,'immutable historical association') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM historical_remote_owners h JOIN connections d ON d.tenant=h.tenant AND d.id=NEW.destination AND d.kind=h.vendor AND d.remote_identity=h.book_identity WHERE h.tenant=NEW.tenant AND h.vendor=NEW.vendor AND h.book_identity=NEW.book_identity AND h.remote_id=NEW.remote_id AND h.source=NEW.source AND h.qso=NEW.qso) THEN RAISE(ABORT,'historical remote ownership conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM attempts a JOIN connections d ON d.tenant=a.tenant AND d.id=a.destination LEFT JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE a.tenant=NEW.tenant AND a.source=NEW.source AND a.qso=NEW.qso AND (a.destination=NEW.destination OR (d.kind=NEW.vendor AND d.remote_identity=NEW.book_identity)) AND (s.state IS NULL OR s.state NOT IN('prepared','rejected','cancelled') OR s.remote_id IS NOT NULL OR EXISTS(SELECT 1 FROM attempt_events e WHERE e.tenant=a.tenant AND e.attempt=a.id AND e.state NOT IN('prepared','rejected','cancelled','retry_scheduled')))) THEN RAISE(ABORT,'historical association has prior delivery') END;
END;
CREATE TRIGGER historical_association_immutable BEFORE UPDATE ON historical_associations BEGIN SELECT RAISE(ABORT,'immutable historical association'); END;
CREATE TRIGGER historical_association_retained BEFORE DELETE ON historical_associations BEGIN SELECT RAISE(ABORT,'historical association requires explicit review'); END;

CREATE VIEW historical_association_write_blocks AS
 SELECT tenant,source,qso,destination FROM historical_associations
 UNION ALL
 SELECT h.tenant,h.source,h.qso,d.id AS destination FROM historical_associations h JOIN connections d ON d.tenant=h.tenant AND d.kind=h.vendor AND d.remote_identity=h.book_identity;

CREATE TRIGGER historical_association_stage BEFORE INSERT ON stage_guards BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM historical_association_write_blocks h WHERE h.tenant=NEW.tenant AND h.source=NEW.source AND h.qso=NEW.qso AND h.destination=NEW.destination) THEN RAISE(ABORT,'historical association is read only') END;
END;
CREATE TRIGGER historical_association_stage_update BEFORE UPDATE ON stage_guards BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM historical_association_write_blocks h WHERE h.tenant=NEW.tenant AND h.source=NEW.source AND h.qso=NEW.qso AND h.destination=NEW.destination) THEN RAISE(ABORT,'historical association is read only') END;
END;
CREATE TRIGGER historical_association_attempt BEFORE INSERT ON attempts BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM historical_association_write_blocks h WHERE h.tenant=NEW.tenant AND h.source=NEW.source AND h.qso=NEW.qso AND h.destination=NEW.destination) THEN RAISE(ABORT,'historical association is read only') END;
END;
CREATE TRIGGER historical_association_prepared BEFORE INSERT ON attempt_state WHEN NEW.state IN('prepared','dispatching') BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM attempts a JOIN historical_association_write_blocks h ON h.tenant=a.tenant AND h.source=a.source AND h.qso=a.qso AND h.destination=a.destination WHERE a.tenant=NEW.tenant AND a.id=NEW.attempt) THEN RAISE(ABORT,'historical association is read only') END;
END;
CREATE TRIGGER historical_association_dispatch BEFORE UPDATE OF state ON attempt_state WHEN NEW.state='dispatching' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM attempts a JOIN historical_association_write_blocks h ON h.tenant=a.tenant AND h.source=a.source AND h.qso=a.qso AND h.destination=a.destination WHERE a.tenant=NEW.tenant AND a.id=NEW.attempt) THEN RAISE(ABORT,'historical association is read only') END;
END;
