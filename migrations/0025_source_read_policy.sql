-- Dormant until a source explicitly activates its new reader under the poll lease.
CREATE TABLE source_read_policies (
 tenant TEXT NOT NULL, source TEXT NOT NULL,
 reader_policy TEXT NOT NULL CHECK(reader_policy='all-clients-v1'),
 epoch TEXT NOT NULL CHECK(length(epoch)>0),
 source_remote TEXT NOT NULL, account_id TEXT NOT NULL CHECK(length(account_id)>0 AND account_id=source_remote),
 phase TEXT NOT NULL CHECK(phase IN('backfill','drain','quarantine','ready')),
 started_at INTEGER NOT NULL CHECK(started_at>=0),
 completed_sync_generation INTEGER, completed_at INTEGER,
 PRIMARY KEY(tenant,source), FOREIGN KEY(tenant,source) REFERENCES connections(tenant,id),
 CHECK((phase='ready' AND completed_sync_generation IS NOT NULL AND completed_sync_generation>0 AND completed_at IS NOT NULL AND completed_at>=started_at) OR (phase!='ready' AND completed_sync_generation IS NULL AND completed_at IS NULL))
);
ALTER TABLE source_work ADD COLUMN policy_seen_epoch TEXT;
CREATE INDEX source_policy_membership ON source_work(tenant,source,policy_seen_epoch,kind,id);

-- Activation must participate in the existing atomic, leased sync checkpoint.
CREATE TRIGGER source_read_policy_activate BEFORE INSERT ON source_read_policies BEGIN
 SELECT CASE WHEN NEW.phase!='backfill' THEN RAISE(ABORT,'source policy requires baseline') END;
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM connections c JOIN accounts a ON a.id=c.tenant
  WHERE c.tenant=NEW.tenant AND c.id=NEW.source AND c.kind='lofi' AND c.status='active' AND a.status='active'
   AND c.remote_identity=NEW.source_remote AND json_valid(c.config)
   AND json_type(c.config,'$.accountId')='text' AND json_extract(c.config,'$.accountId')=NEW.account_id
 ) THEN RAISE(ABORT,'source policy identity changed') END;
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM checkpoint_guards g JOIN leases l ON l.tenant=g.tenant AND l.scope=g.scope AND l.token=g.token AND l.fence=g.fence AND l.expires_at>g.now
  WHERE g.tenant=NEW.tenant AND g.connection=NEW.source AND g.stream='sync'
   AND g.scope='poll:'||NEW.source||':sync' AND g.now=NEW.started_at
 ) THEN RAISE(ABORT,'source policy activation lease lost') END;
END;
CREATE TRIGGER source_read_policy_reset BEFORE UPDATE OF epoch ON source_read_policies WHEN NEW.epoch!=OLD.epoch BEGIN
 SELECT CASE WHEN NEW.phase!='backfill' OR NEW.tenant!=OLD.tenant OR NEW.source!=OLD.source
  OR NEW.reader_policy!=OLD.reader_policy OR NEW.source_remote!=OLD.source_remote OR NEW.account_id!=OLD.account_id
  THEN RAISE(ABORT,'source policy reset scope changed') END;
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM connections c JOIN accounts a ON a.id=c.tenant
  WHERE c.tenant=NEW.tenant AND c.id=NEW.source AND c.kind='lofi' AND c.status='active' AND a.status='active'
   AND c.remote_identity=NEW.source_remote AND json_valid(c.config)
   AND json_type(c.config,'$.accountId')='text' AND json_extract(c.config,'$.accountId')=NEW.account_id
 ) THEN RAISE(ABORT,'source policy identity changed') END;
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM checkpoint_guards g JOIN leases l ON l.tenant=g.tenant AND l.scope=g.scope AND l.token=g.token AND l.fence=g.fence AND l.expires_at>g.now
  WHERE g.tenant=NEW.tenant AND g.connection=NEW.source AND g.stream='sync'
   AND g.scope='poll:'||NEW.source||':sync' AND g.now=NEW.started_at
 ) THEN RAISE(ABORT,'source policy reset lease lost') END;
END;

-- Old workers reconstruct the cursor without these tags. Reject the final write,
-- rolling back their entire checkpoint instead of accepting filtered provenance.
CREATE TRIGGER source_read_policy_cursor_insert BEFORE INSERT ON cursors
WHEN NEW.stream='sync' AND (EXISTS(SELECT 1 FROM source_read_policies p WHERE p.tenant=NEW.tenant AND p.source=NEW.connection)
 OR CASE WHEN json_valid(NEW.cursor) THEN json_type(NEW.cursor,'$.readerPolicy') IS NOT NULL OR json_type(NEW.cursor,'$.policyEpoch') IS NOT NULL ELSE 0 END) BEGIN
 SELECT CASE WHEN NOT json_valid(NEW.cursor) THEN RAISE(ABORT,'source policy cursor invalid') END;
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM source_read_policies p JOIN connections c ON c.tenant=p.tenant AND c.id=p.source JOIN accounts a ON a.id=p.tenant
  WHERE p.tenant=NEW.tenant AND p.source=NEW.connection
   AND c.kind='lofi' AND c.status='active' AND a.status='active' AND c.remote_identity=p.source_remote
   AND json_valid(c.config) AND json_type(c.config,'$.accountId')='text' AND json_extract(c.config,'$.accountId')=p.account_id
   AND json_type(NEW.cursor,'$.readerPolicy')='text' AND json_type(NEW.cursor,'$.policyEpoch')='text' AND json_type(NEW.cursor,'$.accountId')='text'
   AND json_extract(NEW.cursor,'$.readerPolicy')=p.reader_policy AND json_extract(NEW.cursor,'$.policyEpoch')=p.epoch
   AND json_extract(NEW.cursor,'$.accountId')=p.account_id
 ) THEN RAISE(ABORT,'source policy cursor changed') END;
END;
CREATE TRIGGER source_read_policy_cursor_update BEFORE UPDATE ON cursors
WHEN NEW.stream='sync' AND (EXISTS(SELECT 1 FROM source_read_policies p WHERE p.tenant=NEW.tenant AND p.source=NEW.connection)
 OR CASE WHEN json_valid(NEW.cursor) THEN json_type(NEW.cursor,'$.readerPolicy') IS NOT NULL OR json_type(NEW.cursor,'$.policyEpoch') IS NOT NULL ELSE 0 END) BEGIN
 SELECT CASE WHEN NOT json_valid(NEW.cursor) THEN RAISE(ABORT,'source policy cursor invalid') END;
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM source_read_policies p JOIN connections c ON c.tenant=p.tenant AND c.id=p.source JOIN accounts a ON a.id=p.tenant
  WHERE p.tenant=NEW.tenant AND p.source=NEW.connection
   AND c.kind='lofi' AND c.status='active' AND a.status='active' AND c.remote_identity=p.source_remote
   AND json_valid(c.config) AND json_type(c.config,'$.accountId')='text' AND json_extract(c.config,'$.accountId')=p.account_id
   AND json_type(NEW.cursor,'$.readerPolicy')='text' AND json_type(NEW.cursor,'$.policyEpoch')='text' AND json_type(NEW.cursor,'$.accountId')='text'
   AND json_extract(NEW.cursor,'$.readerPolicy')=p.reader_policy AND json_extract(NEW.cursor,'$.policyEpoch')=p.epoch
   AND json_extract(NEW.cursor,'$.accountId')=p.account_id
 ) THEN RAISE(ABORT,'source policy cursor changed') END;
END;
CREATE TRIGGER source_read_policy_cursor_retained BEFORE DELETE ON cursors
WHEN OLD.stream='sync' AND EXISTS(SELECT 1 FROM source_read_policies p WHERE p.tenant=OLD.tenant AND p.source=OLD.connection) BEGIN
 SELECT RAISE(ABORT,'source policy cursor must be reset under lease');
END;
CREATE TRIGGER source_read_policy_cursor_identity BEFORE UPDATE ON cursors
WHEN OLD.stream='sync' AND (NEW.stream!=OLD.stream OR NEW.tenant!=OLD.tenant OR NEW.connection!=OLD.connection)
 AND EXISTS(SELECT 1 FROM source_read_policies p WHERE p.tenant=OLD.tenant AND p.source=OLD.connection) BEGIN
 SELECT RAISE(ABORT,'source policy cursor identity changed');
END;
