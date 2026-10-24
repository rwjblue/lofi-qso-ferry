-- Weak HMAC lookup only. No plaintext call/time, projected contact, or authority.
CREATE TABLE source_historical_state (
 tenant TEXT PRIMARY KEY REFERENCES accounts(id),key_id TEXT NOT NULL DEFAULT '',key_envelope TEXT,
 epoch INTEGER NOT NULL DEFAULT 1 CHECK(epoch>0),clock INTEGER NOT NULL DEFAULT 0 CHECK(clock>=0),
 rebuilding INTEGER NOT NULL DEFAULT 1 CHECK(rebuilding IN(0,1)),
 cursor_source TEXT,cursor_qso TEXT,
 CHECK((cursor_source IS NULL)=(cursor_qso IS NULL))
);
CREATE TABLE source_historical_index (
 tenant TEXT NOT NULL,source TEXT NOT NULL,qso TEXT NOT NULL,
 revision TEXT NOT NULL,synced_at INTEGER NOT NULL,private_id TEXT NOT NULL,
 body_version TEXT NOT NULL DEFAULT '',key_id TEXT NOT NULL DEFAULT '',
 scope TEXT NOT NULL DEFAULT 'unknown' CHECK(scope IN('exact','call','minute','unknown')),
 bucket_hash TEXT NOT NULL DEFAULT '',dirty INTEGER NOT NULL DEFAULT 1 CHECK(dirty IN(0,1)),
 checked_at INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant,source,qso),FOREIGN KEY(tenant,source) REFERENCES connections(tenant,id)
);
CREATE INDEX source_historical_bucket ON source_historical_index(tenant,key_id,bucket_hash,source,qso);
CREATE INDEX source_historical_dirty ON source_historical_index(tenant,source,dirty,checked_at,qso);
CREATE INDEX source_historical_backfill ON source_historical_index(tenant,dirty,checked_at,source,qso);
CREATE INDEX source_historical_index_body ON source_historical_index(tenant,source,private_id);
CREATE INDEX source_historical_body ON source_work(tenant,source,private_id);
CREATE INDEX source_historical_active ON connections(tenant,kind,status,id);
INSERT INTO source_historical_state(tenant) SELECT id FROM accounts;
INSERT INTO source_historical_index(tenant,source,qso,revision,synced_at,private_id)
 SELECT tenant,source,id,revision,synced_at,private_id FROM source_work WHERE kind='qso' AND is_event=0 AND deleted=0;
CREATE TRIGGER source_historical_state_monotonic BEFORE UPDATE ON source_historical_state
WHEN NEW.tenant IS NOT OLD.tenant OR NEW.clock<OLD.clock OR NEW.epoch<OLD.epoch OR (NEW.key_envelope IS NOT OLD.key_envelope AND NEW.clock<=OLD.clock) OR (NEW.key_id IS NOT OLD.key_id AND (OLD.key_id!='' OR NEW.epoch<=OLD.epoch OR NEW.clock<=OLD.clock OR NEW.rebuilding!=1 OR NEW.cursor_source IS NOT NULL OR NEW.key_envelope IS NULL)) BEGIN
 SELECT RAISE(ABORT,'source historical index state regression');
END;
CREATE TRIGGER source_historical_state_retained BEFORE DELETE ON source_historical_state BEGIN
 SELECT RAISE(ABORT,'source historical index state retained');
END;
CREATE TRIGGER source_historical_work_insert AFTER INSERT ON source_work BEGIN
 INSERT INTO source_historical_state(tenant,clock) VALUES(NEW.tenant,1) ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
 INSERT INTO source_historical_index(tenant,source,qso,revision,synced_at,private_id)
 SELECT NEW.tenant,NEW.source,NEW.id,NEW.revision,NEW.synced_at,NEW.private_id WHERE NEW.kind='qso' AND NEW.is_event=0 AND NEW.deleted=0
 ON CONFLICT(tenant,source,qso) DO UPDATE SET revision=excluded.revision,synced_at=excluded.synced_at,private_id=excluded.private_id,body_version='',dirty=1,checked_at=0;
END;
CREATE TRIGGER source_historical_work_update AFTER UPDATE ON source_work WHEN NEW.tenant IS NOT OLD.tenant OR NEW.source IS NOT OLD.source OR NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind OR NEW.revision IS NOT OLD.revision OR NEW.synced_at IS NOT OLD.synced_at OR NEW.private_id IS NOT OLD.private_id OR NEW.operation_id IS NOT OLD.operation_id OR NEW.is_event IS NOT OLD.is_event OR NEW.deleted IS NOT OLD.deleted OR NEW.expires_at IS NOT OLD.expires_at OR NEW.policy_seen_epoch IS NOT OLD.policy_seen_epoch BEGIN
 INSERT INTO source_historical_state(tenant,clock) VALUES(OLD.tenant,1) ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
 INSERT INTO source_historical_state(tenant,clock) SELECT NEW.tenant,1 WHERE NEW.tenant!=OLD.tenant ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
 DELETE FROM source_historical_index WHERE tenant=OLD.tenant AND source=OLD.source AND qso=OLD.id AND NOT EXISTS(SELECT 1 FROM source_work w WHERE w.tenant=OLD.tenant AND w.source=OLD.source AND w.id=OLD.id AND w.kind='qso' AND w.is_event=0 AND w.deleted=0);
 INSERT INTO source_historical_index(tenant,source,qso,revision,synced_at,private_id)
 SELECT NEW.tenant,NEW.source,NEW.id,NEW.revision,NEW.synced_at,NEW.private_id WHERE NEW.kind='qso' AND NEW.is_event=0 AND NEW.deleted=0
 ON CONFLICT(tenant,source,qso) DO UPDATE SET revision=excluded.revision,synced_at=excluded.synced_at,private_id=excluded.private_id,
 body_version=CASE WHEN revision=excluded.revision AND private_id=excluded.private_id THEN body_version ELSE '' END,
 dirty=CASE WHEN revision=excluded.revision AND private_id=excluded.private_id THEN dirty ELSE 1 END,
 checked_at=CASE WHEN revision=excluded.revision AND private_id=excluded.private_id THEN checked_at ELSE 0 END;
END;
CREATE TRIGGER source_historical_work_delete AFTER DELETE ON source_work BEGIN
 INSERT INTO source_historical_state(tenant,clock) VALUES(OLD.tenant,1) ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
 DELETE FROM source_historical_index WHERE tenant=OLD.tenant AND source=OLD.source AND qso=OLD.id AND OLD.kind='qso';
END;
CREATE TRIGGER source_historical_clean_insert BEFORE INSERT ON source_historical_index WHEN NEW.dirty=0 AND NOT EXISTS(SELECT 1 FROM source_historical_state s JOIN source_work w ON w.tenant=s.tenant AND w.source=NEW.source AND w.kind='qso' AND w.id=NEW.qso JOIN private_data p ON p.tenant=w.tenant AND p.connection=w.source AND p.id=w.private_id AND p.kind='source'
 WHERE s.tenant=NEW.tenant AND s.key_id=NEW.key_id AND length(NEW.key_id)=43 AND length(NEW.bucket_hash)=43
 AND w.is_event=0 AND w.deleted=0 AND w.revision=NEW.revision AND w.synced_at=NEW.synced_at AND w.private_id=NEW.private_id AND p.source_proof_version=NEW.body_version AND length(NEW.body_version)>0
 AND p.revoked_at IS NULL AND w.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND (p.expires_at IS NULL OR p.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN
 SELECT RAISE(ABORT,'source historical index publication stale');
END;
CREATE TRIGGER source_historical_clean_update BEFORE UPDATE ON source_historical_index WHEN NEW.dirty=0 AND (OLD.dirty!=0 OR NEW.key_id IS NOT OLD.key_id OR NEW.bucket_hash IS NOT OLD.bucket_hash OR NEW.scope IS NOT OLD.scope OR NEW.body_version IS NOT OLD.body_version OR NEW.revision IS NOT OLD.revision OR NEW.synced_at IS NOT OLD.synced_at OR NEW.private_id IS NOT OLD.private_id OR NEW.tenant IS NOT OLD.tenant OR NEW.source IS NOT OLD.source OR NEW.qso IS NOT OLD.qso) AND NOT (OLD.dirty=0 AND NEW.key_id=OLD.key_id AND NEW.bucket_hash=OLD.bucket_hash AND NEW.scope=OLD.scope AND NEW.body_version=OLD.body_version AND NEW.revision=OLD.revision AND NEW.private_id=OLD.private_id AND NEW.synced_at>=OLD.synced_at AND NEW.tenant=OLD.tenant AND NEW.source=OLD.source AND NEW.qso=OLD.qso
 AND EXISTS(SELECT 1 FROM source_work w WHERE w.tenant=NEW.tenant AND w.source=NEW.source AND w.kind='qso' AND w.id=NEW.qso AND w.revision=NEW.revision AND w.private_id=NEW.private_id AND w.synced_at=NEW.synced_at AND w.is_event=0 AND w.deleted=0)) AND NOT EXISTS(SELECT 1 FROM source_historical_state s JOIN source_work w ON w.tenant=s.tenant AND w.source=NEW.source AND w.kind='qso' AND w.id=NEW.qso JOIN private_data p ON p.tenant=w.tenant AND p.connection=w.source AND p.id=w.private_id AND p.kind='source'
 WHERE s.tenant=NEW.tenant AND s.key_id=NEW.key_id AND length(NEW.key_id)=43 AND length(NEW.bucket_hash)=43
 AND w.is_event=0 AND w.deleted=0 AND w.revision=NEW.revision AND w.synced_at=NEW.synced_at AND w.private_id=NEW.private_id AND p.source_proof_version=NEW.body_version AND length(NEW.body_version)>0
 AND p.revoked_at IS NULL AND w.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND (p.expires_at IS NULL OR p.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER))) BEGIN
 SELECT RAISE(ABORT,'source historical index publication stale');
END;
CREATE TRIGGER source_historical_row_retained BEFORE DELETE ON source_historical_index WHEN EXISTS(SELECT 1 FROM source_work w WHERE w.tenant=OLD.tenant AND w.source=OLD.source AND w.id=OLD.qso AND w.kind='qso' AND w.is_event=0 AND w.deleted=0) BEGIN
 SELECT RAISE(ABORT,'source historical index row retained');
END;
CREATE TRIGGER source_historical_publication_clock AFTER UPDATE ON source_historical_index WHEN NEW.dirty IS NOT OLD.dirty OR NEW.key_id IS NOT OLD.key_id OR NEW.bucket_hash IS NOT OLD.bucket_hash OR NEW.scope IS NOT OLD.scope OR NEW.body_version IS NOT OLD.body_version BEGIN
 INSERT INTO source_historical_state(tenant,clock) VALUES(NEW.tenant,1) ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
END;
CREATE TRIGGER source_historical_body_insert AFTER INSERT ON private_data WHEN NEW.kind IN('source','credential') BEGIN
 INSERT INTO source_historical_state(tenant,clock) VALUES(NEW.tenant,1) ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
 UPDATE source_historical_index SET dirty=1,checked_at=0 WHERE tenant=NEW.tenant AND source=NEW.connection AND private_id=NEW.id AND NEW.kind='source';
END;
CREATE TRIGGER source_historical_body_delete AFTER DELETE ON private_data WHEN OLD.kind IN('source','credential') BEGIN
 INSERT INTO source_historical_state(tenant,clock) VALUES(OLD.tenant,1) ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
END;
CREATE TRIGGER source_historical_body_update AFTER UPDATE ON private_data
WHEN ((NEW.kind='source' OR OLD.kind='source') AND (NEW.envelope IS NOT OLD.envelope OR NEW.source_proof_version IS NOT OLD.source_proof_version OR NEW.tenant IS NOT OLD.tenant OR NEW.connection IS NOT OLD.connection OR NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind))
 OR ((NEW.kind='credential' OR OLD.kind='credential') AND (NEW.expires_at IS NOT OLD.expires_at OR NEW.revoked_at IS NOT OLD.revoked_at OR NEW.tenant IS NOT OLD.tenant OR NEW.connection IS NOT OLD.connection OR NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind)) BEGIN
 INSERT INTO source_historical_state(tenant,clock) VALUES(OLD.tenant,1) ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
 INSERT INTO source_historical_state(tenant,clock) SELECT NEW.tenant,1 WHERE NEW.tenant!=OLD.tenant ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
 UPDATE source_historical_index SET dirty=1,checked_at=0 WHERE ((tenant=OLD.tenant AND source=OLD.connection AND private_id=OLD.id AND OLD.kind='source') OR (tenant=NEW.tenant AND source=NEW.connection AND private_id=NEW.id AND NEW.kind='source')) AND (NEW.envelope IS NOT OLD.envelope OR NEW.tenant IS NOT OLD.tenant OR NEW.connection IS NOT OLD.connection OR NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind);
END;
CREATE TRIGGER source_historical_connections_insert AFTER INSERT ON connections BEGIN
 INSERT INTO source_historical_state(tenant,clock) VALUES(NEW.tenant,1) ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
END;
CREATE TRIGGER source_historical_connections_delete AFTER DELETE ON connections BEGIN
 INSERT INTO source_historical_state(tenant,clock) VALUES(OLD.tenant,1) ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
END;
CREATE TRIGGER source_historical_connections_update AFTER UPDATE ON connections WHEN NEW.kind IS NOT OLD.kind OR NEW.status IS NOT OLD.status OR NEW.remote_identity IS NOT OLD.remote_identity OR NEW.credential_version IS NOT OLD.credential_version OR NEW.tenant IS NOT OLD.tenant OR NEW.id IS NOT OLD.id OR json_remove(NEW.config,'$.lastError','$.lastSuccessfulPollAt','$.accountEmail') IS NOT json_remove(OLD.config,'$.lastError','$.lastSuccessfulPollAt','$.accountEmail') BEGIN
 INSERT INTO source_historical_state(tenant,clock) VALUES(OLD.tenant,1) ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
 INSERT INTO source_historical_state(tenant,clock) SELECT NEW.tenant,1 WHERE NEW.tenant!=OLD.tenant ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
END;
CREATE TRIGGER source_historical_source_read_policies_insert AFTER INSERT ON source_read_policies BEGIN
 INSERT INTO source_historical_state(tenant,clock) VALUES(NEW.tenant,1) ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
END;
CREATE TRIGGER source_historical_source_read_policies_delete AFTER DELETE ON source_read_policies BEGIN
 INSERT INTO source_historical_state(tenant,clock) VALUES(OLD.tenant,1) ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
END;
CREATE TRIGGER source_historical_source_read_policies_update AFTER UPDATE ON source_read_policies WHEN 1 BEGIN
 INSERT INTO source_historical_state(tenant,clock) VALUES(OLD.tenant,1) ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
 INSERT INTO source_historical_state(tenant,clock) SELECT NEW.tenant,1 WHERE NEW.tenant!=OLD.tenant ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
END;
CREATE TRIGGER source_historical_cursors_insert AFTER INSERT ON cursors WHEN NEW.stream='context' BEGIN
 INSERT INTO source_historical_state(tenant,clock) VALUES(NEW.tenant,1) ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
END;
CREATE TRIGGER source_historical_cursors_delete AFTER DELETE ON cursors WHEN OLD.stream='context' BEGIN
 INSERT INTO source_historical_state(tenant,clock) VALUES(OLD.tenant,1) ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
END;
CREATE TRIGGER source_historical_cursors_update AFTER UPDATE ON cursors WHEN (NEW.stream='context' OR OLD.stream='context') AND (NEW.cursor IS NOT OLD.cursor OR NEW.generation IS NOT OLD.generation OR NEW.tenant IS NOT OLD.tenant OR NEW.connection IS NOT OLD.connection OR NEW.stream IS NOT OLD.stream) BEGIN
 INSERT INTO source_historical_state(tenant,clock) VALUES(OLD.tenant,1) ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
 INSERT INTO source_historical_state(tenant,clock) SELECT NEW.tenant,1 WHERE NEW.tenant!=OLD.tenant ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
END;
CREATE TRIGGER source_historical_account_update AFTER UPDATE OF status ON accounts WHEN NEW.status IS NOT OLD.status BEGIN
 INSERT INTO source_historical_state(tenant,clock) VALUES(NEW.id,1) ON CONFLICT(tenant) DO UPDATE SET clock=clock+1;
END;

CREATE TRIGGER source_historical_identity_immutable BEFORE UPDATE OF tenant,source,qso ON source_historical_index WHEN NEW.tenant IS NOT OLD.tenant OR NEW.source IS NOT OLD.source OR NEW.qso IS NOT OLD.qso BEGIN
 SELECT RAISE(ABORT,'source historical index identity immutable');
END;

-- Rare global matching-policy changes invalidate existing comparison snapshots.
CREATE TRIGGER source_historical_matching_insert AFTER INSERT ON reconciliation_policy BEGIN
 UPDATE source_historical_state SET clock=clock+1;
END;
CREATE TRIGGER source_historical_matching_update AFTER UPDATE ON reconciliation_policy WHEN NEW.id IS NOT OLD.id OR NEW.value IS NOT OLD.value BEGIN
 UPDATE source_historical_state SET clock=clock+1;
END;
CREATE TRIGGER source_historical_matching_delete AFTER DELETE ON reconciliation_policy BEGIN
 UPDATE source_historical_state SET clock=clock+1;
END;
