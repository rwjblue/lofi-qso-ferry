-- A rebuildable decision and work hint for each current comparison absence.
CREATE TABLE inventory_delivery_review (
 tenant TEXT NOT NULL,destination TEXT NOT NULL,source_scope TEXT NOT NULL,record_key TEXT NOT NULL,
 generation_id TEXT NOT NULL,result_set TEXT NOT NULL,result_version INTEGER NOT NULL CHECK(result_version>0),
 source_config_version INTEGER NOT NULL,destination_config_version INTEGER NOT NULL,
 provider TEXT NOT NULL CHECK(provider IN('qrz','lotw')),source_identity TEXT NOT NULL,book_identity TEXT NOT NULL,
 due_at INTEGER NOT NULL CHECK(due_at>0),reviewed_at INTEGER,
 decision TEXT CHECK(decision IN('source_proof_required','comparison_changed','credentials_unavailable','prior_delivery_evidence','historical_owner','ownership_incomplete','ownership_conflict','ownership_bound','projection_unavailable')),
 ownership_version INTEGER NOT NULL DEFAULT -1 CHECK(ownership_version>=-1),
 source_credential TEXT,destination_credential TEXT,
 PRIMARY KEY(tenant,destination,source_scope,record_key),
 FOREIGN KEY(tenant,destination,source_scope,record_key) REFERENCES match_results(tenant,destination,source_scope,record_key) ON DELETE CASCADE,
 CHECK((decision IS NULL AND reviewed_at IS NULL AND ownership_version=-1) OR (decision IS NOT NULL AND reviewed_at>0 AND ownership_version>=0))
);
CREATE INDEX inventory_delivery_review_due ON inventory_delivery_review(tenant,generation_id,destination,source_scope,source_config_version,destination_config_version,due_at,record_key);
CREATE INDEX inventory_delivery_review_clock ON inventory_delivery_review(tenant,generation_id,destination,source_scope,source_config_version,destination_config_version,ownership_version,record_key) WHERE ownership_version>=0;
CREATE INDEX inventory_delivery_review_set ON inventory_delivery_review(tenant,result_set,source_scope,record_key);

CREATE VIEW inventory_delivery_review_expected AS
 SELECT r.tenant,r.destination,r.source_scope,r.record_key,h.generation_id,r.set_id AS result_set,r.version AS result_version,
 s.config_version AS source_config_version,t.config_version AS destination_config_version,t.provider,
 s.scope_identity AS source_identity,t.scope_identity AS book_identity,r.derived_at AS due_at
 FROM match_results r JOIN inventory_match_sets h ON h.tenant=r.tenant AND h.set_id=r.set_id
 JOIN inventory_match_scopes s ON s.tenant=r.tenant AND s.set_id=r.set_id AND s.scope_id=r.source_scope AND s.source=1 AND s.provider='lofi'
 JOIN inventory_match_scopes t ON t.tenant=r.tenant AND t.set_id=r.set_id AND t.scope_id=r.destination AND t.provider IN('qrz','lotw')
 WHERE r.state='absent_at_inventory';

CREATE TRIGGER inventory_delivery_review_result_insert AFTER INSERT ON match_results WHEN NEW.state='absent_at_inventory' BEGIN
 INSERT INTO inventory_delivery_review(tenant,destination,source_scope,record_key,generation_id,result_set,result_version,source_config_version,destination_config_version,provider,source_identity,book_identity,due_at)
 SELECT * FROM inventory_delivery_review_expected WHERE tenant=NEW.tenant AND destination=NEW.destination AND source_scope=NEW.source_scope AND record_key=NEW.record_key;
END;
CREATE TRIGGER inventory_delivery_review_result_update AFTER UPDATE ON match_results WHEN OLD.state='absent_at_inventory' OR NEW.state='absent_at_inventory' BEGIN
 DELETE FROM inventory_delivery_review WHERE tenant=NEW.tenant AND destination=NEW.destination AND source_scope=NEW.source_scope AND record_key=NEW.record_key;
 INSERT INTO inventory_delivery_review(tenant,destination,source_scope,record_key,generation_id,result_set,result_version,source_config_version,destination_config_version,provider,source_identity,book_identity,due_at)
 SELECT * FROM inventory_delivery_review_expected WHERE tenant=NEW.tenant AND destination=NEW.destination AND source_scope=NEW.source_scope AND record_key=NEW.record_key;
END;
CREATE TRIGGER inventory_delivery_review_match_commit BEFORE UPDATE OF state ON inventory_match_sets WHEN OLD.state='prepared' AND NEW.state='committed' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM match_results r INDEXED BY match_result_set
 WHERE r.tenant=NEW.tenant AND r.set_id=NEW.set_id AND r.state='absent_at_inventory' AND NOT EXISTS(
 SELECT 1 FROM inventory_delivery_review w WHERE w.tenant=r.tenant AND w.destination=r.destination AND w.source_scope=r.source_scope AND w.record_key=r.record_key AND w.result_set=r.set_id AND w.result_version=r.version AND w.decision IS NULL
 )) THEN RAISE(ABORT,'inventory delivery review publication incomplete') END;
END;
CREATE TRIGGER inventory_delivery_review_credential_changed AFTER UPDATE OF credential_version ON connections WHEN NEW.credential_version IS NOT OLD.credential_version BEGIN
 UPDATE inventory_delivery_review SET due_at=CAST(unixepoch('subsec')*1000 AS INTEGER),reviewed_at=NULL,decision=NULL,ownership_version=-1,source_credential=NULL,destination_credential=NULL
 WHERE tenant=NEW.tenant AND decision IS NOT NULL AND EXISTS(SELECT 1 FROM inventory_scopes s WHERE s.tenant=NEW.tenant AND s.connection_id=NEW.id AND s.scope_id IN(inventory_delivery_review.source_scope,inventory_delivery_review.destination));
END;

CREATE VIEW inventory_delivery_review_basis AS
 SELECT w.*,w.rowid AS work_id,r.next_eligible_at AS proof_not_before,coalesce(o.version,0) AS current_ownership_version,
 sc.credential_version AS current_source_credential,dc.credential_version AS current_destination_credential,
 p.current_projection_version AS projection_version,p.payload_id AS projection_payload,
 CASE
 WHEN sp.id IS NULL OR dp.id IS NULL THEN 'credentials_unavailable'
 WHEN EXISTS(SELECT 1 FROM inventory_historical_associations x WHERE x.tenant=w.tenant AND x.provider=w.provider AND x.book_identity=w.book_identity AND x.source_identity=w.source_identity AND x.record_key=w.record_key)
   OR EXISTS(SELECT 1 FROM inventory_ownership_evidence x INDEXED BY inventory_ownership_owner WHERE x.tenant=w.tenant AND x.provider=w.provider AND x.source_identity=w.source_identity AND x.record_key=w.record_key AND (w.provider='lotw' OR x.book_identity=w.book_identity)) THEN 'historical_owner'
 WHEN EXISTS(SELECT 1 FROM inventory_ownership_holds x WHERE x.tenant=w.tenant AND x.provider=w.provider) THEN 'ownership_incomplete'
 WHEN EXISTS(SELECT 1 FROM inventory_prior_delivery_evidence x WHERE x.tenant=w.tenant AND x.provider=w.provider) THEN 'prior_delivery_evidence'
 WHEN p.payload_id IS NULL THEN 'projection_unavailable'
 END AS blocker
 FROM inventory_delivery_review w
 JOIN match_results r ON r.tenant=w.tenant AND r.destination=w.destination AND r.source_scope=w.source_scope AND r.record_key=w.record_key AND r.set_id=w.result_set AND r.version=w.result_version AND r.state='absent_at_inventory'
 JOIN inventory_match_sets h ON h.tenant=w.tenant AND h.set_id=w.result_set AND h.state='committed' AND h.generation_id=w.generation_id
 JOIN inventory_scopes s ON s.tenant=w.tenant AND s.scope_id=w.source_scope AND s.provider='lofi' AND s.state='observing' AND s.logical_identity=w.source_identity AND s.config_version=w.source_config_version
 JOIN inventory_scopes d ON d.tenant=w.tenant AND d.scope_id=w.destination AND d.provider=w.provider AND d.state='observing' AND d.logical_identity=w.book_identity AND d.config_version=w.destination_config_version
 JOIN connections sc ON sc.tenant=s.tenant AND sc.id=s.connection_id AND sc.status='active' AND sc.kind='lofi' AND sc.remote_identity=s.logical_identity
 JOIN connections dc ON dc.tenant=d.tenant AND dc.id=d.connection_id AND dc.status='active' AND dc.kind=d.provider AND dc.remote_identity=d.logical_identity
 JOIN accounts a ON a.id=w.tenant AND a.status='active'
 JOIN comparison_domains g ON g.tenant=w.tenant AND g.active_generation=w.generation_id
 LEFT JOIN inventory_ownership_domains o ON o.tenant=w.tenant AND o.provider=w.provider
 LEFT JOIN private_data sp ON sp.tenant=sc.tenant AND sp.connection=sc.id AND sp.id=sc.credential_version AND sp.kind='credential' AND sp.revoked_at IS NULL AND (sp.expires_at IS NULL OR sp.expires_at>unixepoch('subsec')*1000)
 LEFT JOIN private_data dp ON dp.tenant=dc.tenant AND dp.connection=dc.id AND dp.id=dc.credential_version AND dp.kind='credential' AND dp.revoked_at IS NULL AND (dp.expires_at IS NULL OR dp.expires_at>unixepoch('subsec')*1000)
 LEFT JOIN inventory_match_records p ON p.tenant=w.tenant AND p.set_id=w.result_set AND p.scope_id=w.source_scope AND p.record_key=w.record_key AND p.facet='source' AND p.projection_state='ready';

CREATE VIEW inventory_delivery_review_current AS
 SELECT b.tenant,b.destination,b.source_scope,b.record_key,b.generation_id,b.result_set,b.result_version,b.provider,b.decision,b.reviewed_at,b.proof_not_before
 FROM inventory_delivery_review_basis b WHERE b.decision IS NOT NULL AND b.decision!='comparison_changed'
 AND b.ownership_version=b.current_ownership_version AND b.source_credential IS b.current_source_credential AND b.destination_credential IS b.current_destination_credential
 AND (b.decision=b.blocker OR (b.blocker IS NULL AND b.decision IN('source_proof_required','ownership_conflict','ownership_bound','projection_unavailable')))
 AND NOT EXISTS(SELECT 1 FROM inventory_match_stale_sets x WHERE x.tenant=b.tenant AND x.set_id=b.result_set);
