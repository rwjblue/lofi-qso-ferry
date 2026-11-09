CREATE INDEX inventory_lotw_association_activity
 ON inventory_historical_associations(tenant,provider,created_at DESC,id);
CREATE INDEX inventory_lotw_receipt_activity
 ON inventory_lotw_member_receipts(tenant,received_at DESC,attempt_id);

-- Preserve a route's ledger state when it is already visible there. The
-- native activity is independent of upload eligibility and comparison work.
CREATE VIEW inventory_lotw_adopted_activity AS
 SELECT h.tenant,src.id AS source,h.record_key AS qso,dst.id AS destination,h.destination_scope AS scope,
        h.created_at AS updated_at,h.id AS activity_id,'adopted_existing' AS state,0 AS confirmed,
        h.remote_record_key AS receipt_key,NULL AS evidence_id,NULL AS envelope
 FROM inventory_historical_associations h INDEXED BY inventory_lotw_association_activity
 CROSS JOIN connections src ON (src.tenant,src.kind,src.remote_identity)=(h.tenant,'lofi',h.source_identity)
 CROSS JOIN connections dst ON (dst.tenant,dst.kind,dst.remote_identity)=(h.tenant,'lotw',h.book_identity)
 WHERE h.provider='lotw'
 AND NOT EXISTS(SELECT 1 FROM ledger l
   WHERE (l.tenant,l.source,l.qso,l.destination)=(h.tenant,src.id,h.record_key,dst.id));

CREATE VIEW inventory_lotw_observed_activity AS
 SELECT r.tenant,src.id AS source,e.record_key AS qso,dst.id AS destination,e.destination_scope AS scope,
        r.received_at AS updated_at,r.attempt_id AS activity_id,'observed' AS state,r.confirmed,
        NULL AS receipt_key,e.id AS evidence_id,CASE WHEN r.confirmed=0 THEN e.envelope END AS envelope
 FROM inventory_lotw_member_receipts r INDEXED BY inventory_lotw_receipt_activity
 CROSS JOIN inventory_ownership_evidence e ON (e.tenant,e.id)=(r.tenant,r.evidence_id) AND e.provider='lotw'
 CROSS JOIN connections src ON (src.tenant,src.kind,src.remote_identity)=(e.tenant,'lofi',e.source_identity)
 CROSS JOIN connections dst ON (dst.tenant,dst.kind,dst.remote_identity)=(e.tenant,'lotw',e.book_identity)
 WHERE NOT EXISTS(SELECT 1 FROM ledger l
   WHERE (l.tenant,l.source,l.qso,l.destination)=(r.tenant,src.id,e.record_key,dst.id));
