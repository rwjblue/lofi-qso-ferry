-- Classification needs the encrypted source, so revisit retained contacts that
-- older versions parked or rejected before they understood HaLo test calls.
-- Normal intake will classify them under the existing source/context fences.
UPDATE source_work SET state='pending',reason='test_classification_pending'
WHERE kind='qso' AND is_event=0 AND deleted=0 AND state IN('waiting','blocked')
AND expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)
AND EXISTS(SELECT 1 FROM private_data p WHERE p.tenant=source_work.tenant AND p.connection=source_work.source AND p.id=source_work.private_id AND p.kind='source' AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)));

CREATE TRIGGER dispatch_test_source_guard BEFORE UPDATE OF state ON attempt_state WHEN NEW.state='dispatching' AND OLD.state!='dispatching' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM attempts a JOIN source_work w ON w.tenant=a.tenant AND w.source=a.source AND w.id=a.qso AND w.kind='qso' WHERE a.tenant=NEW.tenant AND a.id=NEW.attempt AND w.state='test') THEN RAISE(ABORT,'test operation cannot be exported') END;
END;
