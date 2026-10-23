-- Cron invocations already running during a deployment can finish old-style
-- ledger adoptions after the one-time 0023 seed. Keep mapping writes protected
-- at the database boundary, including old Worker binaries.
CREATE TRIGGER destination_claim_owner_insert BEFORE INSERT ON destination_identity_claims BEGIN
 SELECT CASE WHEN NEW.identity_hash GLOB '*[^A-Za-z0-9_-]*' THEN RAISE(ABORT,'invalid destination identity hash') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM destination_identity_claims c WHERE c.tenant=NEW.tenant AND c.destination=NEW.destination AND c.vendor=NEW.vendor AND c.identity_hash=NEW.identity_hash AND (c.source!=NEW.source OR c.qso!=NEW.qso)) THEN RAISE(ABORT,'outbound identity claim conflict') END;
END;

-- A LoTW mapping already is the exact canonical hash. The owner trigger makes
-- this backfill fail closed if a retained claim belongs to a different source.
INSERT INTO destination_identity_claims(tenant,destination,vendor,identity_hash,source,qso,created_at)
SELECT l.tenant,l.destination,'lotw',l.remote_id,l.source,l.qso,l.updated_at FROM ledger l JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination WHERE d.kind='lotw' AND l.remote_id IS NOT NULL
ON CONFLICT(tenant,destination,vendor,identity_hash) DO NOTHING;

CREATE TRIGGER ledger_lotw_claim_insert AFTER INSERT ON ledger WHEN NEW.remote_id IS NOT NULL AND EXISTS(SELECT 1 FROM connections d WHERE d.tenant=NEW.tenant AND d.id=NEW.destination AND d.kind='lotw') BEGIN
 INSERT INTO destination_identity_claims(tenant,destination,vendor,identity_hash,source,qso,created_at) VALUES(NEW.tenant,NEW.destination,'lotw',NEW.remote_id,NEW.source,NEW.qso,NEW.updated_at) ON CONFLICT(tenant,destination,vendor,identity_hash) DO NOTHING;
END;
CREATE TRIGGER ledger_lotw_claim_update AFTER UPDATE OF remote_id ON ledger WHEN NEW.remote_id IS NOT NULL AND EXISTS(SELECT 1 FROM connections d WHERE d.tenant=NEW.tenant AND d.id=NEW.destination AND d.kind='lotw') BEGIN
 INSERT INTO destination_identity_claims(tenant,destination,vendor,identity_hash,source,qso,created_at) VALUES(NEW.tenant,NEW.destination,'lotw',NEW.remote_id,NEW.source,NEW.qso,NEW.updated_at) ON CONFLICT(tenant,destination,vendor,identity_hash) DO NOTHING;
END;

-- A QRZ LOGID cannot be inferred from any earlier claim held by the owner.
-- Only an exact completed receipt linked to its immutable claim proves this
-- mapping. Existing historical associations may need one conservative exact
-- LOGID read again; current adoption clears its own reservation atomically.
INSERT INTO legacy_qrz_identity_reservations(tenant,destination,source,qso,remote_id)
SELECT l.tenant,l.destination,l.source,l.qso,l.remote_id FROM ledger l JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination WHERE d.kind='qrz' AND l.remote_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id JOIN attempt_identity_claims i ON i.tenant=a.tenant AND i.attempt=a.id AND i.destination=a.destination AND i.source=a.source AND i.qso=a.qso JOIN destination_identity_claims c ON c.tenant=i.tenant AND c.destination=i.destination AND c.vendor=i.vendor AND c.identity_hash=i.identity_hash AND c.source=i.source AND c.qso=i.qso WHERE a.tenant=l.tenant AND a.destination=l.destination AND a.source=l.source AND a.qso=l.qso AND i.vendor='qrz' AND s.state IN('delivered','observed') AND s.remote_id=l.remote_id)
ON CONFLICT(tenant,destination,source,qso) DO NOTHING;

CREATE TRIGGER ledger_qrz_reservation_insert AFTER INSERT ON ledger WHEN NEW.remote_id IS NOT NULL AND EXISTS(SELECT 1 FROM connections d WHERE d.tenant=NEW.tenant AND d.id=NEW.destination AND d.kind='qrz') AND NOT EXISTS(SELECT 1 FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id JOIN attempt_identity_claims i ON i.tenant=a.tenant AND i.attempt=a.id AND i.destination=a.destination AND i.source=a.source AND i.qso=a.qso JOIN destination_identity_claims c ON c.tenant=i.tenant AND c.destination=i.destination AND c.vendor=i.vendor AND c.identity_hash=i.identity_hash AND c.source=i.source AND c.qso=i.qso WHERE a.tenant=NEW.tenant AND a.destination=NEW.destination AND a.source=NEW.source AND a.qso=NEW.qso AND i.vendor='qrz' AND s.state IN('delivered','observed') AND s.remote_id=NEW.remote_id) BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM legacy_qrz_identity_reservations r WHERE r.tenant=NEW.tenant AND r.destination=NEW.destination AND r.source=NEW.source AND r.qso=NEW.qso AND r.remote_id!=NEW.remote_id) THEN RAISE(ABORT,'legacy QRZ identity reservation conflict') END;
 INSERT INTO legacy_qrz_identity_reservations(tenant,destination,source,qso,remote_id) VALUES(NEW.tenant,NEW.destination,NEW.source,NEW.qso,NEW.remote_id) ON CONFLICT(tenant,destination,source,qso) DO NOTHING;
END;
CREATE TRIGGER ledger_qrz_reservation_update AFTER UPDATE OF remote_id ON ledger WHEN NEW.remote_id IS NOT NULL AND NEW.remote_id IS NOT OLD.remote_id AND EXISTS(SELECT 1 FROM connections d WHERE d.tenant=NEW.tenant AND d.id=NEW.destination AND d.kind='qrz') AND NOT EXISTS(SELECT 1 FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id JOIN attempt_identity_claims i ON i.tenant=a.tenant AND i.attempt=a.id AND i.destination=a.destination AND i.source=a.source AND i.qso=a.qso JOIN destination_identity_claims c ON c.tenant=i.tenant AND c.destination=i.destination AND c.vendor=i.vendor AND c.identity_hash=i.identity_hash AND c.source=i.source AND c.qso=i.qso WHERE a.tenant=NEW.tenant AND a.destination=NEW.destination AND a.source=NEW.source AND a.qso=NEW.qso AND i.vendor='qrz' AND s.state IN('delivered','observed') AND s.remote_id=NEW.remote_id) BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM legacy_qrz_identity_reservations r WHERE r.tenant=NEW.tenant AND r.destination=NEW.destination AND r.source=NEW.source AND r.qso=NEW.qso AND r.remote_id!=NEW.remote_id) THEN RAISE(ABORT,'legacy QRZ identity reservation conflict') END;
 INSERT INTO legacy_qrz_identity_reservations(tenant,destination,source,qso,remote_id) VALUES(NEW.tenant,NEW.destination,NEW.source,NEW.qso,NEW.remote_id) ON CONFLICT(tenant,destination,source,qso) DO NOTHING;
END;
