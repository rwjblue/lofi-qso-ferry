-- A newly added coverage partition was not present in an older preparation's
-- per-row dependencies. Fence the coverage set as well as its captured rows.
CREATE TABLE inventory_matching_coverage_clocks (
 tenant TEXT NOT NULL, scope_id TEXT NOT NULL, facet TEXT NOT NULL CHECK(facet IN('source','receipt')),
 version INTEGER NOT NULL CHECK(version>0), PRIMARY KEY(tenant,scope_id,facet), FOREIGN KEY(tenant,scope_id) REFERENCES inventory_scopes(tenant,scope_id)
);
CREATE TRIGGER inventory_matching_coverage_identity BEFORE UPDATE ON inventory_coverage WHEN (NEW.tenant,NEW.scope_id,NEW.stream_id,NEW.facet,NEW.partition_id) IS NOT (OLD.tenant,OLD.scope_id,OLD.stream_id,OLD.facet,OLD.partition_id) BEGIN SELECT RAISE(ABORT,'immutable inventory coverage identity'); END;
CREATE TRIGGER inventory_matching_coverage_clock_insert AFTER INSERT ON inventory_coverage WHEN NEW.facet IN('source','receipt') BEGIN
 INSERT INTO inventory_matching_coverage_clocks(tenant,scope_id,facet,version) VALUES(NEW.tenant,NEW.scope_id,NEW.facet,1) ON CONFLICT(tenant,scope_id,facet) DO UPDATE SET version=inventory_matching_coverage_clocks.version+1;
END;
CREATE TRIGGER inventory_matching_coverage_clock_update AFTER UPDATE ON inventory_coverage WHEN NEW.facet IN('source','receipt') AND (NEW.state!=OLD.state OR NEW.kind!=OLD.kind OR NEW.published_run_id IS NOT OLD.published_run_id OR NEW.published_config_version IS NOT OLD.published_config_version) BEGIN
 INSERT INTO inventory_matching_coverage_clocks(tenant,scope_id,facet,version) VALUES(NEW.tenant,NEW.scope_id,NEW.facet,1) ON CONFLICT(tenant,scope_id,facet) DO UPDATE SET version=inventory_matching_coverage_clocks.version+1;
END;
CREATE TRIGGER inventory_matching_coverage_clock_monotonic BEFORE UPDATE ON inventory_matching_coverage_clocks WHEN (NEW.tenant,NEW.scope_id,NEW.facet) IS NOT (OLD.tenant,OLD.scope_id,OLD.facet) OR NEW.version!=OLD.version+1 BEGIN SELECT RAISE(ABORT,'inventory matching coverage clock regressed'); END;
CREATE TRIGGER inventory_matching_coverage_clock_delete BEFORE DELETE ON inventory_matching_coverage_clocks BEGIN SELECT RAISE(ABORT,'retained inventory matching coverage clock'); END;
ALTER TABLE inventory_match_scopes ADD COLUMN coverage_clock INTEGER CHECK(coverage_clock IS NULL OR coverage_clock>=0);
CREATE VIEW inventory_matching_stale_coverage_clocks AS
 SELECT s.tenant,s.set_id FROM inventory_match_scopes s LEFT JOIN inventory_matching_coverage_clocks c ON c.tenant=s.tenant AND c.scope_id=s.scope_id AND c.facet=CASE s.provider WHEN 'lofi' THEN 'source' ELSE 'receipt' END WHERE s.scope_id!='' AND (s.coverage_clock IS NULL OR s.coverage_clock!=coalesce(c.version,0));
CREATE TRIGGER inventory_matching_coverage_set_guard BEFORE INSERT ON inventory_match_guards BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_matching_stale_coverage_clocks WHERE tenant=NEW.tenant AND set_id=NEW.set_id) THEN RAISE(ABORT,'inventory matching coverage set changed') END;
END;
CREATE TRIGGER inventory_matching_coverage_set_commit BEFORE UPDATE ON inventory_match_sets WHEN NEW.state='committed' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_matching_stale_coverage_clocks WHERE tenant=NEW.tenant AND set_id=NEW.set_id) THEN RAISE(ABORT,'inventory matching coverage set changed') END;
END;
