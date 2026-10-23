-- Retry only retained general-log projection failures. This does not establish
-- destination history, routing, adoption, absence evidence, or export eligibility.
UPDATE source_work
SET state='pending', reason=NULL
WHERE kind='qso' AND operation_id IS NULL AND is_event=0 AND deleted=0
 AND state='blocked' AND reason='missing_or_ambiguous_station_call'
 AND expires_at>unixepoch('now','subsec')*1000
 AND EXISTS (
  SELECT 1 FROM private_data p
  WHERE p.tenant=source_work.tenant AND p.connection=source_work.source
   AND p.id=source_work.private_id AND p.kind='source'
   AND p.revoked_at IS NULL AND p.expires_at>unixepoch('now','subsec')*1000
 );
