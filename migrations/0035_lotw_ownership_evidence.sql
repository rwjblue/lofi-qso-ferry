-- Observation-only foundation. No classifier, stage, dispatch, or mapping may
-- consume this registry as authority until the independent write bridge lands.
-- Exact receipt hashes and ledger.remote_id retain their existing semantics.
CREATE TABLE lotw_ownership_state (
 tenant TEXT PRIMARY KEY, key_id TEXT NOT NULL DEFAULT '', clock INTEGER NOT NULL DEFAULT 0 CHECK(clock>=0)
);
CREATE TABLE lotw_ownership_owners (
 tenant TEXT NOT NULL, destination TEXT NOT NULL, source TEXT NOT NULL, qso TEXT NOT NULL,
 owner_hash TEXT CHECK(owner_hash IS NULL OR length(owner_hash)=43),
 PRIMARY KEY(tenant,destination,source,qso)
);
CREATE INDEX lotw_ownership_owner_hash ON lotw_ownership_owners(tenant,destination,owner_hash);
CREATE INDEX lotw_ownership_owner_pending ON lotw_ownership_owners(tenant,owner_hash,source,qso,destination);
CREATE TRIGGER lotw_ownership_owner_immutable BEFORE UPDATE ON lotw_ownership_owners
WHEN NEW.tenant IS NOT OLD.tenant OR NEW.destination IS NOT OLD.destination OR NEW.source IS NOT OLD.source OR NEW.qso IS NOT OLD.qso OR OLD.owner_hash IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'immutable LoTW ownership owner');
END;
CREATE TRIGGER lotw_ownership_owner_retained BEFORE DELETE ON lotw_ownership_owners BEGIN
 SELECT RAISE(ABORT,'retained LoTW ownership owner');
END;
CREATE TABLE lotw_ownership_evidence (
 tenant TEXT NOT NULL, id TEXT NOT NULL, destination TEXT NOT NULL, source TEXT NOT NULL, qso TEXT NOT NULL,
 exact_hash TEXT NOT NULL CHECK(length(exact_hash)=43), key_id TEXT NOT NULL, bucket TEXT NOT NULL,
 envelope TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(tenant,id), UNIQUE(tenant,destination,source,qso,exact_hash)
);
CREATE TRIGGER lotw_ownership_evidence_key BEFORE INSERT ON lotw_ownership_evidence BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM lotw_ownership_state WHERE tenant=NEW.tenant AND key_id=NEW.key_id AND key_id!='') THEN RAISE(ABORT,'LoTW ownership key changed') END;
END;
CREATE INDEX lotw_ownership_bucket ON lotw_ownership_evidence(tenant,key_id,bucket);
CREATE TRIGGER lotw_ownership_evidence_immutable BEFORE UPDATE ON lotw_ownership_evidence BEGIN
 SELECT RAISE(ABORT,'immutable LoTW ownership evidence');
END;
CREATE TRIGGER lotw_ownership_evidence_retained BEFORE DELETE ON lotw_ownership_evidence BEGIN
 SELECT RAISE(ABORT,'retained LoTW ownership evidence');
END;
CREATE TABLE lotw_ownership_inputs (
 tenant TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('identity','claim','mapping','attempt','legacy')),
 destination TEXT NOT NULL, reference TEXT NOT NULL, source TEXT, qso TEXT, exact_hash TEXT,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','held','covered')),
 checked_at INTEGER NOT NULL DEFAULT 0, evidence_id TEXT,
 PRIMARY KEY(tenant,kind,destination,reference),
 FOREIGN KEY(tenant,evidence_id) REFERENCES lotw_ownership_evidence(tenant,id),
 CHECK((source IS NULL)=(qso IS NULL)), CHECK(status!='covered' OR evidence_id IS NOT NULL)
);
CREATE INDEX lotw_ownership_pending ON lotw_ownership_inputs(tenant,status DESC,checked_at,kind,destination,reference);
CREATE TRIGGER lotw_ownership_input_identity BEFORE UPDATE ON lotw_ownership_inputs
WHEN NEW.tenant IS NOT OLD.tenant OR NEW.kind IS NOT OLD.kind OR NEW.destination IS NOT OLD.destination OR NEW.reference IS NOT OLD.reference OR NEW.source IS NOT OLD.source OR NEW.qso IS NOT OLD.qso OR NEW.exact_hash IS NOT OLD.exact_hash BEGIN
 SELECT RAISE(ABORT,'immutable LoTW ownership input');
END;
CREATE TRIGGER lotw_ownership_input_retained BEFORE DELETE ON lotw_ownership_inputs BEGIN
 SELECT RAISE(ABORT,'retained LoTW ownership input');
END;
CREATE TRIGGER lotw_ownership_owners_insert AFTER INSERT ON lotw_ownership_owners BEGIN
 INSERT INTO lotw_ownership_state(tenant,clock) VALUES(NEW.tenant,1) ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
END;
CREATE TRIGGER lotw_ownership_owners_update AFTER UPDATE ON lotw_ownership_owners BEGIN
 INSERT INTO lotw_ownership_state(tenant,clock) VALUES(NEW.tenant,1) ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
END;
CREATE TRIGGER lotw_ownership_inputs_insert AFTER INSERT ON lotw_ownership_inputs BEGIN
 INSERT INTO lotw_ownership_state(tenant,clock) VALUES(NEW.tenant,1) ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
END;
CREATE TRIGGER lotw_ownership_inputs_update AFTER UPDATE ON lotw_ownership_inputs BEGIN
 INSERT INTO lotw_ownership_state(tenant,clock) VALUES(NEW.tenant,1) ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
END;
CREATE TRIGGER lotw_ownership_evidence_insert AFTER INSERT ON lotw_ownership_evidence BEGIN
 INSERT INTO lotw_ownership_state(tenant,clock) VALUES(NEW.tenant,1) ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
END;
-- Include inactive/revoked/signing-only destinations. No current account,
-- source, credential, or source-body availability filter is appropriate here.
INSERT INTO lotw_ownership_owners(tenant,destination,source,qso)
SELECT l.tenant,l.destination,l.source,l.qso FROM ledger l JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination WHERE d.kind='lotw';
INSERT INTO lotw_ownership_owners(tenant,destination,source,qso)
SELECT tenant,destination,source,qso FROM destination_identity_claims WHERE vendor='lotw' ON CONFLICT DO NOTHING;
INSERT INTO lotw_ownership_owners(tenant,destination,source,qso)
SELECT a.tenant,a.destination,a.source,a.qso FROM attempts a JOIN connections d ON d.tenant=a.tenant AND d.id=a.destination WHERE d.kind='lotw' ON CONFLICT DO NOTHING;
INSERT INTO lotw_ownership_owners(tenant,destination,source,qso)
SELECT r.tenant,r.destination,r.source,r.qso FROM legacy_outbound_identity_reservations r JOIN connections d ON d.tenant=r.tenant AND d.id=r.destination WHERE d.kind='lotw' ON CONFLICT DO NOTHING;
INSERT INTO lotw_ownership_inputs(tenant,kind,destination,reference)
SELECT tenant,'identity',connection,id FROM private_data WHERE kind='lotw_identity';
INSERT INTO lotw_ownership_inputs(tenant,kind,destination,reference,source,qso,exact_hash)
SELECT tenant,'claim',destination,identity_hash,source,qso,identity_hash FROM destination_identity_claims WHERE vendor='lotw';
INSERT INTO lotw_ownership_inputs(tenant,kind,destination,reference,source,qso,exact_hash)
SELECT l.tenant,'mapping',l.destination,json_array(l.source,l.qso,l.remote_id),l.source,l.qso,l.remote_id FROM ledger l JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination WHERE d.kind='lotw' AND l.remote_id IS NOT NULL;
INSERT INTO lotw_ownership_inputs(tenant,kind,destination,reference,source,qso)
SELECT a.tenant,'attempt',a.destination,a.id,a.source,a.qso FROM attempts a JOIN connections d ON d.tenant=a.tenant AND d.id=a.destination WHERE d.kind='lotw';
INSERT INTO lotw_ownership_inputs(tenant,kind,destination,reference,source,qso)
SELECT r.tenant,'legacy',r.destination,r.attempt,r.source,r.qso FROM legacy_outbound_identity_reservations r JOIN connections d ON d.tenant=r.tenant AND d.id=r.destination WHERE d.kind='lotw';
CREATE TRIGGER lotw_ownership_ledger_insert AFTER INSERT ON ledger
WHEN EXISTS(SELECT 1 FROM connections WHERE tenant=NEW.tenant AND id=NEW.destination AND kind='lotw') BEGIN
 INSERT INTO lotw_ownership_owners(tenant,destination,source,qso) VALUES(NEW.tenant,NEW.destination,NEW.source,NEW.qso) ON CONFLICT DO NOTHING;
 INSERT INTO lotw_ownership_inputs(tenant,kind,destination,reference,source,qso,exact_hash) SELECT NEW.tenant,'mapping',NEW.destination,json_array(NEW.source,NEW.qso,NEW.remote_id),NEW.source,NEW.qso,NEW.remote_id WHERE NEW.remote_id IS NOT NULL ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER lotw_ownership_ledger_mapping AFTER UPDATE OF remote_id ON ledger
WHEN NEW.remote_id IS NOT NULL AND NEW.remote_id IS NOT OLD.remote_id AND EXISTS(SELECT 1 FROM connections WHERE tenant=NEW.tenant AND id=NEW.destination AND kind='lotw') BEGIN
 INSERT INTO lotw_ownership_inputs(tenant,kind,destination,reference,source,qso,exact_hash) VALUES(NEW.tenant,'mapping',NEW.destination,json_array(NEW.source,NEW.qso,NEW.remote_id),NEW.source,NEW.qso,NEW.remote_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER lotw_ownership_claim AFTER INSERT ON destination_identity_claims WHEN NEW.vendor='lotw' BEGIN
 INSERT INTO lotw_ownership_owners(tenant,destination,source,qso) VALUES(NEW.tenant,NEW.destination,NEW.source,NEW.qso) ON CONFLICT DO NOTHING;
 INSERT INTO lotw_ownership_inputs(tenant,kind,destination,reference,source,qso,exact_hash) VALUES(NEW.tenant,'claim',NEW.destination,NEW.identity_hash,NEW.source,NEW.qso,NEW.identity_hash) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER lotw_ownership_attempt AFTER INSERT ON attempts
WHEN EXISTS(SELECT 1 FROM connections WHERE tenant=NEW.tenant AND id=NEW.destination AND kind='lotw') BEGIN
 INSERT INTO lotw_ownership_inputs(tenant,kind,destination,reference,source,qso) VALUES(NEW.tenant,'attempt',NEW.destination,NEW.id,NEW.source,NEW.qso) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER lotw_ownership_attempt_claim AFTER INSERT ON attempt_identity_claims WHEN NEW.vendor='lotw' BEGIN
 UPDATE lotw_ownership_inputs SET status='pending',version=version+1,checked_at=0 WHERE tenant=NEW.tenant AND destination=NEW.destination AND reference=NEW.attempt AND kind IN('attempt','legacy');
END;
CREATE TRIGGER lotw_ownership_legacy AFTER INSERT ON legacy_outbound_identity_reservations
WHEN EXISTS(SELECT 1 FROM connections WHERE tenant=NEW.tenant AND id=NEW.destination AND kind='lotw') BEGIN
 INSERT INTO lotw_ownership_inputs(tenant,kind,destination,reference,source,qso) VALUES(NEW.tenant,'legacy',NEW.destination,NEW.attempt,NEW.source,NEW.qso) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER lotw_ownership_identity_insert AFTER INSERT ON private_data WHEN NEW.kind='lotw_identity' BEGIN
 INSERT INTO lotw_ownership_inputs(tenant,kind,destination,reference) VALUES(NEW.tenant,'identity',NEW.connection,NEW.id) ON CONFLICT(tenant,kind,destination,reference) DO UPDATE SET status='pending',version=version+1,checked_at=0;
END;
CREATE TRIGGER lotw_ownership_identity_update AFTER UPDATE ON private_data
WHEN OLD.kind='lotw_identity' AND (NEW.envelope IS NOT OLD.envelope OR NEW.expires_at IS NOT OLD.expires_at OR NEW.revoked_at IS NOT OLD.revoked_at OR NEW.tenant IS NOT OLD.tenant OR NEW.connection IS NOT OLD.connection OR NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind) BEGIN
 UPDATE lotw_ownership_inputs SET status='pending',version=version+1,checked_at=0 WHERE tenant=OLD.tenant AND kind='identity' AND destination=OLD.connection AND reference=OLD.id;
END;
CREATE TRIGGER lotw_ownership_identity_move AFTER UPDATE ON private_data
WHEN NEW.kind='lotw_identity' AND (NEW.tenant IS NOT OLD.tenant OR NEW.connection IS NOT OLD.connection OR NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind) BEGIN
 INSERT INTO lotw_ownership_inputs(tenant,kind,destination,reference) VALUES(NEW.tenant,'identity',NEW.connection,NEW.id) ON CONFLICT(tenant,kind,destination,reference) DO UPDATE SET status='pending',version=version+1,checked_at=0;
END;
CREATE TRIGGER lotw_ownership_identity_delete AFTER DELETE ON private_data WHEN OLD.kind='lotw_identity' BEGIN
 UPDATE lotw_ownership_inputs SET status=CASE WHEN status='covered' THEN 'covered' ELSE 'held' END,version=version+1 WHERE tenant=OLD.tenant AND kind='identity' AND destination=OLD.connection AND reference=OLD.id;
END;
-- Missing/unknown attempt states cannot establish registry coverage. Normal
-- claim/receipt state transitions have no new trigger writes or winner changes.
CREATE TRIGGER lotw_ownership_attempt_state_missing AFTER DELETE ON attempt_state BEGIN
 UPDATE lotw_ownership_inputs SET status='pending',version=version+1,checked_at=0 WHERE tenant=OLD.tenant AND reference=OLD.attempt AND kind IN('attempt','legacy');
END;
CREATE TRIGGER lotw_ownership_attempt_state_unknown AFTER UPDATE OF state ON attempt_state
WHEN NEW.state NOT IN('prepared','dispatching','submitted','uncertain','reconciliation_required','delivered','observed','cancelled','rejected') OR OLD.state NOT IN('prepared','dispatching','submitted','uncertain','reconciliation_required','delivered','observed','cancelled','rejected') BEGIN
 UPDATE lotw_ownership_inputs SET status='pending',version=version+1,checked_at=0 WHERE tenant=NEW.tenant AND reference=NEW.attempt AND kind IN('attempt','legacy');
END;
-- REPLACE must not delete a permanent fact under SQLite's nonrecursive delete
-- trigger behavior. Idempotent observation retries use INSERT...WHERE NOT EXISTS.
CREATE TRIGGER lotw_ownership_evidence_replace BEFORE INSERT ON lotw_ownership_evidence
WHEN EXISTS(SELECT 1 FROM lotw_ownership_evidence WHERE tenant=NEW.tenant AND (id=NEW.id OR (destination=NEW.destination AND source=NEW.source AND qso=NEW.qso AND exact_hash=NEW.exact_hash))) BEGIN
 SELECT RAISE(ABORT,'immutable LoTW ownership evidence');
END;
CREATE TRIGGER lotw_ownership_owner_replace BEFORE INSERT ON lotw_ownership_owners
WHEN EXISTS(SELECT 1 FROM lotw_ownership_owners WHERE tenant=NEW.tenant AND destination=NEW.destination AND source=NEW.source AND qso=NEW.qso) BEGIN
 SELECT RAISE(IGNORE);
END;
CREATE TRIGGER lotw_ownership_attempt_state_unknown_insert AFTER INSERT ON attempt_state
WHEN NEW.state NOT IN('prepared','dispatching','submitted','uncertain','reconciliation_required','delivered','observed','cancelled','rejected') BEGIN
 UPDATE lotw_ownership_inputs SET status='pending',version=version+1,checked_at=0 WHERE tenant=NEW.tenant AND reference=NEW.attempt AND kind IN('attempt','legacy');
END;
CREATE TRIGGER lotw_ownership_input_replace BEFORE INSERT ON lotw_ownership_inputs
WHEN EXISTS(SELECT 1 FROM lotw_ownership_inputs i WHERE i.tenant=NEW.tenant AND i.kind=NEW.kind AND i.destination=NEW.destination AND i.reference=NEW.reference AND (i.source IS NOT NEW.source OR i.qso IS NOT NEW.qso OR i.exact_hash IS NOT NEW.exact_hash)) BEGIN
 SELECT RAISE(ABORT,'immutable LoTW ownership input');
END;
