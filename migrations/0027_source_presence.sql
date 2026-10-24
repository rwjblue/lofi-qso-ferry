-- Observation metadata only. No stage, dispatch or cutover authority is added.
ALTER TABLE source_work ADD COLUMN positive_observed_at INTEGER;
ALTER TABLE source_work ADD COLUMN positive_policy_epoch TEXT;
ALTER TABLE source_work ADD COLUMN positive_credential_version TEXT;

-- A new version cannot inherit a previous version's positive observation,
-- including when an older Worker does not know these columns exist.
CREATE TRIGGER source_presence_changed AFTER UPDATE OF tenant,source,id,kind,revision,synced_at,operation_id,deleted,is_event ON source_work
WHEN NEW.tenant IS NOT OLD.tenant OR NEW.source IS NOT OLD.source OR NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind
 OR NEW.revision IS NOT OLD.revision OR NEW.synced_at IS NOT OLD.synced_at
 OR NEW.operation_id IS NOT OLD.operation_id OR NEW.deleted IS NOT OLD.deleted OR NEW.is_event IS NOT OLD.is_event BEGIN
 UPDATE source_work SET positive_observed_at=NULL,positive_policy_epoch=NULL,positive_credential_version=NULL
 WHERE tenant=NEW.tenant AND source=NEW.source AND id=NEW.id AND kind=NEW.kind;
END;

-- Intake inserts the version first and separately records its actual observation
-- inside the same canonical checkpoint. REST/ciphertext refresh cannot mint one.
CREATE TRIGGER source_presence_insert BEFORE INSERT ON source_work
WHEN NEW.positive_observed_at IS NOT NULL OR NEW.positive_policy_epoch IS NOT NULL OR NEW.positive_credential_version IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'source presence requires canonical checkpoint');
END;
CREATE TRIGGER source_presence_update BEFORE UPDATE OF positive_observed_at,positive_policy_epoch,positive_credential_version ON source_work
WHEN (NEW.positive_observed_at IS NOT NULL OR NEW.positive_policy_epoch IS NOT NULL OR NEW.positive_credential_version IS NOT NULL)
 AND (NEW.positive_observed_at IS NOT OLD.positive_observed_at OR NEW.positive_policy_epoch IS NOT OLD.positive_policy_epoch OR NEW.positive_credential_version IS NOT OLD.positive_credential_version) BEGIN
 SELECT CASE WHEN typeof(NEW.positive_observed_at)!='integer' OR NEW.positive_observed_at<0
  OR NEW.positive_policy_epoch IS NULL OR NEW.positive_credential_version IS NULL
  OR (OLD.positive_observed_at IS NOT NULL AND NEW.positive_observed_at<OLD.positive_observed_at)
  THEN RAISE(ABORT,'source presence timestamp invalid') END;
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM checkpoint_guards g
  JOIN leases l ON l.tenant=g.tenant AND l.scope=g.scope AND l.token=g.token AND l.fence=g.fence AND l.expires_at>g.now
  JOIN source_read_policies p ON p.tenant=g.tenant AND p.source=g.connection
  JOIN connections c ON c.tenant=p.tenant AND c.id=p.source
  JOIN accounts a ON a.id=p.tenant
  JOIN private_data credential ON credential.tenant=c.tenant AND credential.connection=c.id AND credential.id=c.credential_version AND credential.kind='credential'
  JOIN cursors s ON s.tenant=p.tenant AND s.connection=p.source AND s.stream='sync' AND s.generation=g.expected
  WHERE g.tenant=NEW.tenant AND g.connection=NEW.source AND g.stream='sync' AND g.scope='poll:'||NEW.source||':sync'
   AND g.now>=NEW.positive_observed_at AND p.reader_policy='all-clients-v1'
   AND p.epoch=NEW.positive_policy_epoch AND p.epoch=NEW.policy_seen_epoch
   AND c.kind='lofi' AND c.status='active' AND a.status='active'
   AND c.remote_identity=p.source_remote AND p.account_id=p.source_remote
   AND c.credential_version=NEW.positive_credential_version
   AND credential.revoked_at IS NULL AND (credential.expires_at IS NULL OR credential.expires_at>g.now)
   AND json_valid(c.config) AND json_type(c.config,'$.accountId')='text' AND json_extract(c.config,'$.accountId')=p.account_id
   AND json_valid(s.cursor) AND json_type(s.cursor,'$.readerPolicy')='text' AND json_type(s.cursor,'$.policyEpoch')='text' AND json_type(s.cursor,'$.accountId')='text'
   AND json_extract(s.cursor,'$.readerPolicy')=p.reader_policy AND json_extract(s.cursor,'$.policyEpoch')=p.epoch AND json_extract(s.cursor,'$.accountId')=p.account_id
 ) THEN RAISE(ABORT,'source presence requires canonical checkpoint') END;
END;
