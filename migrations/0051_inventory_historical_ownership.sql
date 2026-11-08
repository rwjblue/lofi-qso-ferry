-- Fresh-format ownership retains original evidence independently of current
-- inventory membership, connection status and comparison-index generations.
CREATE TABLE inventory_ownership_domains (
 tenant TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN('qrz','lotw')), key_id TEXT NOT NULL,
 format_version INTEGER NOT NULL DEFAULT 1 CHECK(format_version=1), version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant,provider), UNIQUE(tenant,provider,key_id), FOREIGN KEY(tenant,key_id) REFERENCES inventory_comparison_keys(tenant,key_id)
);
CREATE TRIGGER inventory_ownership_domain_update BEFORE UPDATE ON inventory_ownership_domains WHEN NEW.tenant!=OLD.tenant OR NEW.provider!=OLD.provider OR NEW.key_id!=OLD.key_id OR NEW.format_version!=OLD.format_version OR NEW.version<=OLD.version BEGIN SELECT RAISE(ABORT,'inventory ownership version changed'); END;
CREATE TRIGGER inventory_ownership_domain_delete BEFORE DELETE ON inventory_ownership_domains BEGIN SELECT RAISE(ABORT,'retained inventory ownership domain'); END;
CREATE TABLE inventory_ownership_holds (
 tenant TEXT NOT NULL, provider TEXT NOT NULL, reference TEXT NOT NULL, reason TEXT NOT NULL CHECK(reason IN('unresolved_delivery','unverified_owner','unsupported_identity')), created_at INTEGER NOT NULL,
 PRIMARY KEY(tenant,provider,reference), FOREIGN KEY(tenant,provider) REFERENCES inventory_ownership_domains(tenant,provider)
);
CREATE TRIGGER inventory_ownership_hold_insert AFTER INSERT ON inventory_ownership_holds BEGIN UPDATE inventory_ownership_domains SET version=version+1 WHERE tenant=NEW.tenant AND provider=NEW.provider; END;
CREATE TRIGGER inventory_ownership_hold_update BEFORE UPDATE ON inventory_ownership_holds BEGIN SELECT RAISE(ABORT,'immutable inventory ownership hold'); END;
CREATE TRIGGER inventory_ownership_hold_delete BEFORE DELETE ON inventory_ownership_holds BEGIN SELECT RAISE(ABORT,'inventory ownership hold requires proof'); END;
CREATE TABLE inventory_ownership_buckets (
 tenant TEXT NOT NULL, provider TEXT NOT NULL, bucket_hash TEXT NOT NULL CHECK(length(bucket_hash)=43), version INTEGER NOT NULL CHECK(version>0),
 PRIMARY KEY(tenant,provider,bucket_hash), FOREIGN KEY(tenant,provider) REFERENCES inventory_ownership_domains(tenant,provider)
);
CREATE TRIGGER inventory_ownership_bucket_update BEFORE UPDATE ON inventory_ownership_buckets WHEN NEW.version<=OLD.version BEGIN SELECT RAISE(ABORT,'inventory ownership bucket regressed'); END;
CREATE TRIGGER inventory_ownership_bucket_delete BEFORE DELETE ON inventory_ownership_buckets BEGIN SELECT RAISE(ABORT,'retained inventory ownership bucket'); END;
CREATE TABLE inventory_ownership_evidence (
 tenant TEXT NOT NULL, id TEXT NOT NULL, provider TEXT NOT NULL, book_identity TEXT NOT NULL, destination_scope TEXT NOT NULL,
 source_scope TEXT NOT NULL, source_identity TEXT NOT NULL, record_key TEXT NOT NULL, remote_id TEXT,
 kind TEXT NOT NULL CHECK(kind='historical'), key_id TEXT NOT NULL, claim_hash TEXT NOT NULL CHECK(length(claim_hash)=43), bucket_hash TEXT NOT NULL CHECK(length(bucket_hash)=43),
 envelope TEXT NOT NULL CHECK(json_valid(envelope)), encrypted_bytes INTEGER NOT NULL CHECK(encrypted_bytes=length(envelope)), created_at INTEGER NOT NULL,
 PRIMARY KEY(tenant,id), UNIQUE(tenant,provider,claim_hash), FOREIGN KEY(tenant,provider,key_id) REFERENCES inventory_ownership_domains(tenant,provider,key_id),
 FOREIGN KEY(tenant,source_scope) REFERENCES inventory_scopes(tenant,scope_id), FOREIGN KEY(tenant,destination_scope) REFERENCES inventory_scopes(tenant,scope_id),
 CHECK((provider='qrz' AND remote_id IS NOT NULL AND length(remote_id) BETWEEN 1 AND 64 AND remote_id NOT GLOB '*[^0-9]*' AND (remote_id='0' OR substr(remote_id,1,1)!='0')) OR (provider='lotw' AND remote_id IS NULL))
);
CREATE INDEX inventory_ownership_bucket ON inventory_ownership_evidence(tenant,provider,bucket_hash);
CREATE INDEX inventory_ownership_owner ON inventory_ownership_evidence(tenant,provider,source_identity,record_key);
CREATE TRIGGER inventory_ownership_evidence_update BEFORE UPDATE ON inventory_ownership_evidence BEGIN SELECT RAISE(ABORT,'immutable inventory ownership evidence'); END;
CREATE TRIGGER inventory_ownership_evidence_delete BEFORE DELETE ON inventory_ownership_evidence BEGIN SELECT RAISE(ABORT,'retained inventory ownership evidence'); END;
CREATE TRIGGER inventory_ownership_evidence_clock AFTER INSERT ON inventory_ownership_evidence BEGIN
 UPDATE inventory_ownership_domains SET version=version+1 WHERE tenant=NEW.tenant AND provider=NEW.provider;
 INSERT INTO inventory_ownership_buckets(tenant,provider,bucket_hash,version) VALUES(NEW.tenant,NEW.provider,NEW.bucket_hash,1) ON CONFLICT(tenant,provider,bucket_hash) DO UPDATE SET version=inventory_ownership_buckets.version+1;
END;
CREATE TABLE inventory_adoption_pages (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL, provider TEXT NOT NULL, destination_scope TEXT NOT NULL, book_identity TEXT NOT NULL,
 key_id TEXT NOT NULL, ownership_version INTEGER NOT NULL, lease_token TEXT NOT NULL, lease_fence INTEGER NOT NULL,
 input_digest TEXT NOT NULL, prepared_at INTEGER NOT NULL, row_count INTEGER NOT NULL CHECK(row_count BETWEEN 1 AND 20), new_evidence_count INTEGER NOT NULL CHECK(new_evidence_count BETWEEN 0 AND row_count),
 state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN('prepared','committed')), PRIMARY KEY(tenant,page_id),
 FOREIGN KEY(tenant,provider,key_id) REFERENCES inventory_ownership_domains(tenant,provider,key_id), FOREIGN KEY(tenant,destination_scope) REFERENCES inventory_scopes(tenant,scope_id)
);
CREATE TABLE inventory_adoption_rows (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL, association_id TEXT NOT NULL, source_scope TEXT NOT NULL, source_identity TEXT NOT NULL, record_key TEXT NOT NULL,
 match_set TEXT NOT NULL, match_version INTEGER NOT NULL, remote_record_key TEXT NOT NULL,
 source_projection_version INTEGER NOT NULL, source_payload TEXT NOT NULL, remote_projection_version INTEGER NOT NULL, remote_payload TEXT NOT NULL,
 evidence_id TEXT NOT NULL, claim_hash TEXT NOT NULL CHECK(length(claim_hash)=43), bucket_hash TEXT NOT NULL CHECK(length(bucket_hash)=43), remote_id TEXT, existing_evidence INTEGER NOT NULL CHECK(existing_evidence IN(0,1)),
 PRIMARY KEY(tenant,page_id,source_identity,record_key), UNIQUE(tenant,page_id,claim_hash), UNIQUE(tenant,association_id), FOREIGN KEY(tenant,page_id) REFERENCES inventory_adoption_pages(tenant,page_id)
);
CREATE TABLE inventory_adoption_guards (
 tenant TEXT NOT NULL, page_id TEXT NOT NULL, PRIMARY KEY(tenant,page_id), FOREIGN KEY(tenant,page_id) REFERENCES inventory_adoption_pages(tenant,page_id)
);
CREATE TABLE inventory_historical_associations (
 tenant TEXT NOT NULL, id TEXT NOT NULL, provider TEXT NOT NULL, book_identity TEXT NOT NULL, destination_scope TEXT NOT NULL,
 source_scope TEXT NOT NULL, source_identity TEXT NOT NULL, record_key TEXT NOT NULL, remote_record_key TEXT NOT NULL,
 source_payload TEXT NOT NULL, remote_payload TEXT NOT NULL, evidence_id TEXT NOT NULL, match_set TEXT NOT NULL, adoption_page TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(tenant,provider,book_identity,source_identity,record_key), UNIQUE(tenant,id),
 FOREIGN KEY(tenant,evidence_id) REFERENCES inventory_ownership_evidence(tenant,id), FOREIGN KEY(tenant,adoption_page) REFERENCES inventory_adoption_pages(tenant,page_id),
 FOREIGN KEY(tenant,source_scope,source_payload) REFERENCES comparison_projection_payloads(tenant,scope_id,payload_id),
 FOREIGN KEY(tenant,destination_scope,remote_payload) REFERENCES comparison_projection_payloads(tenant,scope_id,payload_id),
 FOREIGN KEY(tenant,match_set,source_scope,record_key) REFERENCES inventory_match_rows(tenant,set_id,source_scope,record_key)
);
CREATE TRIGGER inventory_historical_association_update BEFORE UPDATE ON inventory_historical_associations BEGIN SELECT RAISE(ABORT,'immutable inventory historical association'); END;
CREATE TRIGGER inventory_historical_association_delete BEFORE DELETE ON inventory_historical_associations BEGIN SELECT RAISE(ABORT,'inventory historical association requires explicit review'); END;
CREATE TRIGGER inventory_historical_association_clock AFTER INSERT ON inventory_historical_associations BEGIN UPDATE inventory_ownership_domains SET version=version+1 WHERE tenant=NEW.tenant AND provider=NEW.provider; END;
CREATE VIEW inventory_historical_write_blocks AS
 SELECT a.tenant,s.id AS source,a.record_key AS qso,d.id AS destination FROM inventory_historical_associations a
 JOIN connections s ON s.tenant=a.tenant AND s.kind='lofi' AND s.remote_identity=a.source_identity
 JOIN connections d ON d.tenant=a.tenant AND d.kind=a.provider AND d.remote_identity=a.book_identity;
-- Current outbound evidence must not be relabeled as discovered history. A
-- fresh account-preserving cutover need not import or dual-write these rows.
CREATE VIEW inventory_prior_delivery_evidence AS
 SELECT a.tenant,d.kind AS provider FROM attempts a JOIN connections d ON d.tenant=a.tenant AND d.id=a.destination
 UNION ALL SELECT l.tenant,d.kind FROM ledger l JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination WHERE l.remote_id IS NOT NULL OR l.sent_hash IS NOT NULL OR l.remote_hash IS NOT NULL OR l.provenance!='unknown' OR l.confirmed!=0;

CREATE VIEW inventory_adoption_stale_inputs AS
 SELECT q.tenant,q.page_id FROM inventory_adoption_rows q JOIN inventory_adoption_pages h ON h.tenant=q.tenant AND h.page_id=q.page_id
 LEFT JOIN match_results r ON r.tenant=q.tenant AND r.destination=h.destination_scope AND r.source_scope=q.source_scope AND r.record_key=q.record_key
 LEFT JOIN inventory_match_sets m ON m.tenant=r.tenant AND m.set_id=r.set_id
 LEFT JOIN inventory_scopes s ON s.tenant=q.tenant AND s.scope_id=q.source_scope
 LEFT JOIN inventory_scopes d ON d.tenant=h.tenant AND d.scope_id=h.destination_scope
 LEFT JOIN connections sc ON sc.tenant=s.tenant AND sc.id=s.connection_id LEFT JOIN connections dc ON dc.tenant=d.tenant AND dc.id=d.connection_id
 LEFT JOIN private_data sp ON sp.tenant=sc.tenant AND sp.connection=sc.id AND sp.id=sc.credential_version AND sp.kind='credential'
 LEFT JOIN private_data dp ON dp.tenant=dc.tenant AND dp.connection=dc.id AND dp.id=dc.credential_version AND dp.kind='credential'
 WHERE r.version IS NOT q.match_version OR r.set_id IS NOT q.match_set OR r.state IS NOT 'matched_existing' OR r.remote_key IS NOT q.remote_record_key OR m.state IS NOT 'committed'
 OR s.provider IS NOT 'lofi' OR s.logical_identity IS NOT q.source_identity OR sc.kind IS NOT 'lofi' OR sc.remote_identity IS NOT q.source_identity OR sc.status IS NOT 'active'
 OR d.provider IS NOT h.provider OR d.logical_identity IS NOT h.book_identity OR dc.kind IS NOT h.provider OR dc.remote_identity IS NOT h.book_identity OR dc.status IS NOT 'active'
 OR sp.id IS NULL OR sp.revoked_at IS NOT NULL OR (sp.expires_at IS NOT NULL AND sp.expires_at<=unixepoch('subsec')*1000)
 OR dp.id IS NULL OR dp.revoked_at IS NOT NULL OR (dp.expires_at IS NOT NULL AND dp.expires_at<=unixepoch('subsec')*1000)
 OR NOT EXISTS(SELECT 1 FROM inventory_match_records p WHERE p.tenant=q.tenant AND p.set_id=q.match_set AND p.scope_id=q.source_scope AND p.record_key=q.record_key AND p.facet='source' AND p.projection_state='ready' AND p.current_projection_version=q.source_projection_version AND p.payload_id=q.source_payload)
 OR NOT EXISTS(SELECT 1 FROM inventory_match_records p WHERE p.tenant=q.tenant AND p.set_id=q.match_set AND p.scope_id=h.destination_scope AND p.record_key=q.remote_record_key AND p.facet='receipt' AND p.projection_state='ready' AND p.current_projection_version=q.remote_projection_version AND p.payload_id=q.remote_payload)
 OR (h.provider='qrz' AND (q.remote_record_key GLOB '*[^0-9]*' OR length(q.remote_record_key) NOT BETWEEN 1 AND 64 OR q.remote_id IS NOT coalesce(nullif(ltrim(q.remote_record_key,'0'),''),'0') OR q.claim_hash!=q.bucket_hash))
 OR (h.provider='lotw' AND q.remote_id IS NOT NULL);
CREATE VIEW inventory_adoption_stale_authority AS
 SELECT h.tenant,h.page_id FROM inventory_adoption_pages h WHERE
 NOT EXISTS(SELECT 1 FROM inventory_ownership_domains d JOIN accounts a ON a.id=d.tenant AND a.status='active' JOIN leases l ON l.tenant=d.tenant WHERE d.tenant=h.tenant AND d.provider=h.provider AND d.key_id=h.key_id AND l.scope='inventory-ownership:'||h.provider AND l.token=h.lease_token AND l.fence=h.lease_fence AND l.expires_at>unixepoch('subsec')*1000 AND h.prepared_at>0 AND h.prepared_at<=unixepoch('subsec')*1000)
 OR EXISTS(SELECT 1 FROM inventory_ownership_holds x WHERE x.tenant=h.tenant AND x.provider=h.provider)
 OR EXISTS(SELECT 1 FROM inventory_prior_delivery_evidence x WHERE x.tenant=h.tenant AND x.provider=h.provider);
CREATE TRIGGER inventory_adoption_guard BEFORE INSERT ON inventory_adoption_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_adoption_pages h JOIN inventory_ownership_domains d ON d.tenant=h.tenant AND d.provider=h.provider AND d.version=h.ownership_version WHERE h.tenant=NEW.tenant AND h.page_id=NEW.page_id AND h.state='prepared') OR EXISTS(SELECT 1 FROM inventory_adoption_stale_authority WHERE tenant=NEW.tenant AND page_id=NEW.page_id) THEN RAISE(ABORT,'inventory adoption authority or inputs changed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_adoption_stale_inputs WHERE tenant=NEW.tenant AND page_id=NEW.page_id) THEN RAISE(ABORT,'inventory adoption authority or inputs changed') END;
 -- Validate shared comparison dependencies once per distinct captured set.
 SELECT CASE WHEN EXISTS(SELECT 1 FROM (SELECT DISTINCT match_set FROM inventory_adoption_rows WHERE tenant=NEW.tenant AND page_id=NEW.page_id) c CROSS JOIN inventory_match_sets m WHERE m.tenant=NEW.tenant AND m.set_id=c.match_set AND EXISTS(SELECT 1 FROM inventory_match_stale_sets x WHERE x.tenant=m.tenant AND x.set_id=m.set_id)) THEN RAISE(ABORT,'inventory adoption matching dependencies changed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_adoption_pages h WHERE h.tenant=NEW.tenant AND h.page_id=NEW.page_id AND (h.row_count!=(SELECT count(*) FROM inventory_adoption_rows q WHERE q.tenant=h.tenant AND q.page_id=h.page_id) OR h.new_evidence_count!=(SELECT count(*) FROM inventory_adoption_rows q WHERE q.tenant=h.tenant AND q.page_id=h.page_id AND q.existing_evidence=0))) THEN RAISE(ABORT,'inventory adoption manifest incomplete') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_adoption_rows q JOIN inventory_adoption_pages h ON h.tenant=q.tenant AND h.page_id=q.page_id WHERE q.tenant=NEW.tenant AND q.page_id=NEW.page_id AND (
 EXISTS(SELECT 1 FROM inventory_historical_associations a WHERE a.tenant=q.tenant AND a.provider=h.provider AND a.book_identity=h.book_identity AND a.source_identity=q.source_identity AND a.record_key=q.record_key)
 OR (q.existing_evidence=0 AND EXISTS(SELECT 1 FROM inventory_ownership_evidence e WHERE e.tenant=q.tenant AND e.provider=h.provider AND e.claim_hash=q.claim_hash))
 OR (q.existing_evidence=1 AND NOT EXISTS(SELECT 1 FROM inventory_ownership_evidence e WHERE e.tenant=q.tenant AND e.id=q.evidence_id AND e.provider=h.provider AND e.key_id=h.key_id AND e.claim_hash=q.claim_hash AND e.bucket_hash=q.bucket_hash AND e.source_identity=q.source_identity AND e.record_key=q.record_key AND (h.provider='lotw' OR e.book_identity=h.book_identity AND e.remote_id=q.remote_id)))
 )) THEN RAISE(ABORT,'inventory adoption ownership conflict') END;
END;
CREATE TRIGGER inventory_ownership_evidence_admission BEFORE INSERT ON inventory_ownership_evidence BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_adoption_rows q JOIN inventory_adoption_pages h ON h.tenant=q.tenant AND h.page_id=q.page_id AND h.state='prepared' JOIN inventory_adoption_guards g ON g.tenant=h.tenant AND g.page_id=h.page_id WHERE q.tenant=NEW.tenant AND q.evidence_id=NEW.id AND q.existing_evidence=0 AND h.provider=NEW.provider AND h.book_identity=NEW.book_identity AND h.destination_scope=NEW.destination_scope AND h.key_id=NEW.key_id AND q.source_scope=NEW.source_scope AND q.source_identity=NEW.source_identity AND q.record_key=NEW.record_key AND q.claim_hash=NEW.claim_hash AND q.bucket_hash=NEW.bucket_hash AND q.remote_id IS NEW.remote_id AND NEW.created_at=h.prepared_at) THEN RAISE(ABORT,'inventory ownership publication guard missing') END;
END;
CREATE TRIGGER inventory_historical_association_admission BEFORE INSERT ON inventory_historical_associations BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_adoption_rows q JOIN inventory_adoption_pages h ON h.tenant=q.tenant AND h.page_id=q.page_id AND h.state='prepared' JOIN inventory_adoption_guards g ON g.tenant=h.tenant AND g.page_id=h.page_id JOIN inventory_ownership_evidence e ON e.tenant=q.tenant AND e.id=q.evidence_id AND e.provider=h.provider AND e.source_identity=q.source_identity AND e.record_key=q.record_key AND e.claim_hash=q.claim_hash AND e.bucket_hash=q.bucket_hash AND e.key_id=h.key_id
 WHERE q.tenant=NEW.tenant AND q.association_id=NEW.id AND h.provider=NEW.provider AND h.book_identity=NEW.book_identity AND h.destination_scope=NEW.destination_scope AND q.source_scope=NEW.source_scope AND q.source_identity=NEW.source_identity AND q.record_key=NEW.record_key AND q.remote_record_key=NEW.remote_record_key AND q.source_payload=NEW.source_payload AND q.remote_payload=NEW.remote_payload AND q.evidence_id=NEW.evidence_id AND q.match_set=NEW.match_set AND h.page_id=NEW.adoption_page AND NEW.created_at=h.prepared_at) THEN RAISE(ABORT,'inventory historical association guard missing') END;
END;
CREATE TRIGGER inventory_adoption_commit BEFORE UPDATE ON inventory_adoption_pages BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_adoption_stale_inputs WHERE tenant=OLD.tenant AND page_id=OLD.page_id) THEN RAISE(ABORT,'inventory adoption publication incomplete or changed') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM (SELECT DISTINCT match_set FROM inventory_adoption_rows WHERE tenant=OLD.tenant AND page_id=OLD.page_id) c CROSS JOIN inventory_match_sets m WHERE m.tenant=OLD.tenant AND m.set_id=c.match_set AND EXISTS(SELECT 1 FROM inventory_match_stale_sets x WHERE x.tenant=m.tenant AND x.set_id=m.set_id)) THEN RAISE(ABORT,'inventory adoption matching dependencies changed') END;
 SELECT CASE WHEN OLD.state!='prepared' OR NEW.state!='committed' OR NOT EXISTS(SELECT 1 FROM inventory_adoption_guards WHERE tenant=OLD.tenant AND page_id=OLD.page_id) OR EXISTS(SELECT 1 FROM inventory_adoption_stale_authority WHERE tenant=OLD.tenant AND page_id=OLD.page_id)
 OR NOT EXISTS(SELECT 1 FROM inventory_ownership_domains d WHERE d.tenant=OLD.tenant AND d.provider=OLD.provider AND d.version=OLD.ownership_version+OLD.new_evidence_count+OLD.row_count)
 OR (SELECT count(*) FROM inventory_historical_associations a WHERE a.tenant=OLD.tenant AND a.adoption_page=OLD.page_id)!=OLD.row_count
 THEN RAISE(ABORT,'inventory adoption publication incomplete or changed') END;
END;
CREATE TRIGGER inventory_adoption_header_identity BEFORE UPDATE ON inventory_adoption_pages WHEN (NEW.tenant,NEW.page_id,NEW.provider,NEW.destination_scope,NEW.book_identity,NEW.key_id,NEW.ownership_version,NEW.lease_token,NEW.lease_fence,NEW.input_digest,NEW.prepared_at,NEW.row_count,NEW.new_evidence_count) IS NOT (OLD.tenant,OLD.page_id,OLD.provider,OLD.destination_scope,OLD.book_identity,OLD.key_id,OLD.ownership_version,OLD.lease_token,OLD.lease_fence,OLD.input_digest,OLD.prepared_at,OLD.row_count,OLD.new_evidence_count) BEGIN SELECT RAISE(ABORT,'immutable inventory adoption header'); END;
CREATE TRIGGER inventory_adoption_rows_insert BEFORE INSERT ON inventory_adoption_rows WHEN NOT EXISTS(SELECT 1 FROM inventory_adoption_pages h WHERE h.tenant=NEW.tenant AND h.page_id=NEW.page_id AND h.state='prepared' AND NOT EXISTS(SELECT 1 FROM inventory_adoption_guards g WHERE g.tenant=h.tenant AND g.page_id=h.page_id)) BEGIN SELECT RAISE(ABORT,'inventory adoption dependencies closed'); END;
CREATE TRIGGER inventory_adoption_rows_update BEFORE UPDATE ON inventory_adoption_rows BEGIN SELECT RAISE(ABORT,'immutable inventory adoption dependency'); END;
CREATE TRIGGER inventory_adoption_rows_delete BEFORE DELETE ON inventory_adoption_rows BEGIN SELECT RAISE(ABORT,'retained inventory adoption dependency'); END;

CREATE TRIGGER inventory_history_stage BEFORE INSERT ON stage_guards WHEN EXISTS(SELECT 1 FROM inventory_historical_write_blocks b WHERE b.tenant=NEW.tenant AND b.source=NEW.source AND b.qso=NEW.qso AND b.destination=NEW.destination) BEGIN SELECT RAISE(ABORT,'inventory historical association is read only'); END;
CREATE TRIGGER inventory_history_stage_update BEFORE UPDATE ON stage_guards WHEN EXISTS(SELECT 1 FROM inventory_historical_write_blocks b WHERE b.tenant=NEW.tenant AND b.source=NEW.source AND b.qso=NEW.qso AND b.destination=NEW.destination) BEGIN SELECT RAISE(ABORT,'inventory historical association is read only'); END;
CREATE TRIGGER inventory_history_attempt BEFORE INSERT ON attempts WHEN EXISTS(SELECT 1 FROM inventory_historical_write_blocks b WHERE b.tenant=NEW.tenant AND b.source=NEW.source AND b.qso=NEW.qso AND b.destination=NEW.destination) BEGIN SELECT RAISE(ABORT,'inventory historical association is read only'); END;
CREATE TRIGGER inventory_history_state_insert BEFORE INSERT ON attempt_state WHEN NEW.state IN('prepared','dispatching') AND EXISTS(SELECT 1 FROM attempts a JOIN inventory_historical_write_blocks b ON b.tenant=a.tenant AND b.source=a.source AND b.qso=a.qso AND b.destination=a.destination WHERE a.tenant=NEW.tenant AND a.id=NEW.attempt) BEGIN SELECT RAISE(ABORT,'inventory historical association is read only'); END;
CREATE TRIGGER inventory_history_state_update BEFORE UPDATE ON attempt_state WHEN NEW.state IN('prepared','dispatching') AND EXISTS(SELECT 1 FROM attempts a JOIN inventory_historical_write_blocks b ON b.tenant=a.tenant AND b.source=a.source AND b.qso=a.qso AND b.destination=a.destination WHERE a.tenant=NEW.tenant AND a.id=NEW.attempt) BEGIN SELECT RAISE(ABORT,'inventory historical association is read only'); END;

-- Association audit pins retain the complete original comparison dependency set.
CREATE TRIGGER inventory_history_pin_scopes BEFORE DELETE ON inventory_match_scopes WHEN EXISTS(SELECT 1 FROM inventory_historical_associations a WHERE a.tenant=OLD.tenant AND a.match_set=OLD.set_id) BEGIN SELECT RAISE(ABORT,'inventory historical association pins matching evidence'); END;
CREATE TRIGGER inventory_history_pin_coverage BEFORE DELETE ON inventory_match_coverage WHEN EXISTS(SELECT 1 FROM inventory_historical_associations a WHERE a.tenant=OLD.tenant AND a.match_set=OLD.set_id) BEGIN SELECT RAISE(ABORT,'inventory historical association pins matching evidence'); END;
CREATE TRIGGER inventory_history_pin_records BEFORE DELETE ON inventory_match_records WHEN EXISTS(SELECT 1 FROM inventory_historical_associations a WHERE a.tenant=OLD.tenant AND a.match_set=OLD.set_id) BEGIN SELECT RAISE(ABORT,'inventory historical association pins matching evidence'); END;
CREATE TRIGGER inventory_history_pin_probes BEFORE DELETE ON inventory_match_probes WHEN EXISTS(SELECT 1 FROM inventory_historical_associations a WHERE a.tenant=OLD.tenant AND a.match_set=OLD.set_id) BEGIN SELECT RAISE(ABORT,'inventory historical association pins matching evidence'); END;
CREATE TRIGGER inventory_history_pin_tokens BEFORE DELETE ON inventory_match_tokens WHEN EXISTS(SELECT 1 FROM inventory_historical_associations a WHERE a.tenant=OLD.tenant AND a.match_set=OLD.set_id) BEGIN SELECT RAISE(ABORT,'inventory historical association pins matching evidence'); END;
CREATE TRIGGER inventory_history_pin_candidates BEFORE DELETE ON inventory_match_candidates WHEN EXISTS(SELECT 1 FROM inventory_historical_associations a WHERE a.tenant=OLD.tenant AND a.match_set=OLD.set_id) BEGIN SELECT RAISE(ABORT,'inventory historical association pins matching evidence'); END;
CREATE TRIGGER inventory_history_pin_rows BEFORE DELETE ON inventory_match_rows WHEN EXISTS(SELECT 1 FROM inventory_historical_associations a WHERE a.tenant=OLD.tenant AND a.match_set=OLD.set_id) BEGIN SELECT RAISE(ABORT,'inventory historical association pins matching evidence'); END;
