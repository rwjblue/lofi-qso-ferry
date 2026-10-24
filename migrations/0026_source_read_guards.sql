-- A policy row activates these fences. Sources without one retain the previous
-- behavior during the read-only migration rollout; absence is not export proof.
-- Main export activation must require a policy for every exporting source.
-- An older operation reread does not know policy_seen_epoch and would otherwise
-- retain it when replacing a previously witnessed version. Only a tagged,
-- leased canonical checkpoint can carry membership across a semantic change.
-- An identical-version ciphertext renewal leaves the witnessed body unchanged.
CREATE TRIGGER source_read_membership_changed AFTER UPDATE OF revision,synced_at,deleted,is_event,operation_id ON source_work
WHEN (NEW.revision IS NOT OLD.revision OR NEW.synced_at IS NOT OLD.synced_at
 OR NEW.deleted IS NOT OLD.deleted OR NEW.is_event IS NOT OLD.is_event OR NEW.operation_id IS NOT OLD.operation_id)
 AND EXISTS(SELECT 1 FROM source_read_policies p WHERE p.tenant=NEW.tenant AND p.source=NEW.source AND p.epoch=NEW.policy_seen_epoch)
 AND NOT EXISTS(
  SELECT 1 FROM checkpoint_guards g
  JOIN leases l ON l.tenant=g.tenant AND l.scope=g.scope AND l.token=g.token AND l.fence=g.fence AND l.expires_at>g.now
  JOIN source_read_policies p ON p.tenant=g.tenant AND p.source=g.connection
  JOIN cursors s ON s.tenant=p.tenant AND s.connection=p.source AND s.stream='sync' AND s.generation=g.expected
  WHERE g.tenant=NEW.tenant AND g.connection=NEW.source AND g.stream='sync' AND g.scope='poll:'||NEW.source||':sync'
   AND p.epoch=NEW.policy_seen_epoch AND p.reader_policy='all-clients-v1'
   AND json_valid(s.cursor) AND json_type(s.cursor,'$.readerPolicy')='text'
   AND json_type(s.cursor,'$.policyEpoch')='text' AND json_type(s.cursor,'$.accountId')='text'
   AND json_extract(s.cursor,'$.readerPolicy')=p.reader_policy
   AND json_extract(s.cursor,'$.policyEpoch')=p.epoch AND json_extract(s.cursor,'$.accountId')=p.account_id
 ) BEGIN
 UPDATE source_work SET policy_seen_epoch=NULL WHERE tenant=NEW.tenant AND source=NEW.source AND kind=NEW.kind AND id=NEW.id;
END;

CREATE VIEW source_read_policy_ready AS
 SELECT p.tenant,p.source,p.epoch,p.completed_sync_generation,p.completed_at,
  s.generation AS sync_generation,s.cursor AS sync_cursor
 FROM source_read_policies p
 JOIN connections c ON c.tenant=p.tenant AND c.id=p.source
 JOIN accounts a ON a.id=p.tenant
 JOIN cursors s ON s.tenant=p.tenant AND s.connection=p.source AND s.stream='sync'
 WHERE p.reader_policy='all-clients-v1' AND p.phase='ready'
  AND p.completed_sync_generation>0 AND p.completed_at>=p.started_at
  AND c.kind='lofi' AND c.status='active' AND a.status='active'
  AND c.remote_identity=p.source_remote AND p.account_id=p.source_remote
  AND json_valid(c.config) AND json_type(c.config,'$.accountId')='text'
  AND json_extract(c.config,'$.accountId')=p.account_id
  AND json_valid(s.cursor) AND json_extract(s.cursor,'$.mode')='forward'
  AND json_type(s.cursor,'$.readerPolicy')='text' AND json_type(s.cursor,'$.policyEpoch')='text'
  AND json_type(s.cursor,'$.accountId')='text'
  AND json_extract(s.cursor,'$.readerPolicy')=p.reader_policy
  AND json_extract(s.cursor,'$.policyEpoch')=p.epoch
  AND json_extract(s.cursor,'$.accountId')=p.account_id
  AND s.generation>=p.completed_sync_generation;

-- Membership is distinct from payload validity. Existing guards continue to
-- require exact revisions, retained bodies, expiry, credentials and leases.
-- Do not hide this proof behind legacy ledger.context_generation=NULL paths.
CREATE VIEW source_read_contact_membership AS
 SELECT p.tenant,p.source,q.id AS qso,q.operation_id,p.epoch
 FROM source_read_policy_ready p
 JOIN source_work q ON q.tenant=p.tenant AND q.source=p.source AND q.kind='qso'
 JOIN cursors context ON context.tenant=p.tenant AND context.connection=p.source AND context.stream='context'
 WHERE q.policy_seen_epoch=p.epoch AND q.deleted=0 AND q.is_event=0
  AND q.state IN('pending','waiting')
  AND json_valid(context.cursor) AND json_extract(context.cursor,'$.complete')=1
  AND json_extract(context.cursor,'$.syncComplete')=1
  AND (q.operation_id IS NULL OR EXISTS(
   SELECT 1 FROM source_work o
   WHERE o.tenant=q.tenant AND o.source=q.source AND o.id=q.operation_id AND o.kind='operation'
    AND o.policy_seen_epoch=p.epoch AND o.state='context' AND o.deleted=0
    AND NOT EXISTS(SELECT 1 FROM source_work e
     WHERE e.tenant=o.tenant AND e.source=o.source AND e.operation_id=o.id
      AND e.kind='qso' AND e.is_event=1 AND e.deleted=0 AND e.policy_seen_epoch IS NOT p.epoch)
  ));

CREATE TRIGGER stage_source_read_policy BEFORE INSERT ON stage_guards
WHEN EXISTS(SELECT 1 FROM source_read_policies p WHERE p.tenant=NEW.tenant AND p.source=NEW.source) BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM source_read_contact_membership m JOIN ledger l
   ON l.tenant=m.tenant AND l.source=m.source AND l.qso=m.qso AND l.operation_id IS m.operation_id AND l.context_generation IS NOT NULL
  WHERE m.tenant=NEW.tenant AND m.source=NEW.source AND m.qso=NEW.qso AND l.destination=NEW.destination
 ) THEN RAISE(ABORT,'source read policy unavailable before stage') END;
END;

CREATE TRIGGER dispatch_source_read_policy BEFORE UPDATE OF state ON attempt_state
WHEN NEW.state='dispatching' AND OLD.state!='dispatching'
 AND EXISTS(SELECT 1 FROM attempts a JOIN source_read_policies p ON p.tenant=a.tenant AND p.source=a.source WHERE a.tenant=NEW.tenant AND a.id=NEW.attempt) BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM attempts a JOIN source_read_contact_membership m ON m.tenant=a.tenant AND m.source=a.source AND m.qso=a.qso
  JOIN ledger l ON l.tenant=a.tenant AND l.source=a.source AND l.qso=a.qso AND l.destination=a.destination AND l.operation_id IS m.operation_id AND l.context_generation IS NOT NULL
  WHERE a.tenant=NEW.tenant AND a.id=NEW.attempt
 ) THEN RAISE(ABORT,'source read policy unavailable before dispatch') END;
END;

CREATE TRIGGER birth_source_read_policy BEFORE INSERT ON source_births
WHEN NEW.phase='forward_new' AND EXISTS(SELECT 1 FROM source_read_policies p WHERE p.tenant=NEW.tenant AND p.source=NEW.source) BEGIN
 SELECT CASE WHEN NEW.first_stream!='sync' OR NOT EXISTS(
  SELECT 1 FROM source_read_policy_ready p WHERE p.tenant=NEW.tenant AND p.source=NEW.source
   AND NEW.first_cursor_generation>p.completed_sync_generation
 ) THEN RAISE(ABORT,'source read policy cannot establish new birth') END;
END;

CREATE TRIGGER cutover_source_read_policy BEFORE INSERT ON source_cutovers
WHEN EXISTS(SELECT 1 FROM source_read_policies p WHERE p.tenant=NEW.tenant AND p.source=NEW.source) BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM source_read_policy_ready p WHERE p.tenant=NEW.tenant AND p.source=NEW.source
   AND p.sync_generation=NEW.source_generation AND p.sync_cursor=NEW.source_cursor
   AND NEW.source_generation>=p.completed_sync_generation
 ) THEN RAISE(ABORT,'source read policy cannot establish cutover') END;
END;
