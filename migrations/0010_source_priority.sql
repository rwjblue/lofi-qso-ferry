-- Source priority is durable so historical imports cannot hide a later edit.
ALTER TABLE source_work ADD COLUMN priority TEXT NOT NULL DEFAULT 'background' CHECK(priority IN('live','background'));
CREATE INDEX source_work_priority ON source_work(tenant,source,priority,processed_at);
UPDATE source_work SET priority='live' WHERE kind='qso' AND (
 EXISTS(SELECT 1 FROM ledger l WHERE l.tenant=source_work.tenant AND l.source=source_work.source AND l.qso=source_work.id AND l.state='changed')
 OR EXISTS(SELECT 1 FROM source_births b WHERE b.tenant=source_work.tenant AND b.source=source_work.source AND b.qso=source_work.id AND b.phase='forward_new')
);
UPDATE attempt_state SET priority='live' WHERE EXISTS(
 SELECT 1 FROM attempts a WHERE a.tenant=attempt_state.tenant AND a.id=attempt_state.attempt AND (
  EXISTS(SELECT 1 FROM source_work w WHERE w.tenant=a.tenant AND w.source=a.source AND w.id=a.qso AND w.kind='qso' AND w.priority='live')
  OR EXISTS(SELECT 1 FROM source_births b WHERE b.tenant=a.tenant AND b.source=a.source AND b.qso=a.qso AND b.phase='forward_new')
  OR EXISTS(SELECT 1 FROM ledger l WHERE l.tenant=a.tenant AND l.source=a.source AND l.qso=a.qso AND l.destination=a.destination AND l.state='changed')
 )
);
