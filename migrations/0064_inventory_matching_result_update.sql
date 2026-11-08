-- An update must consume this result's newly admitted set, never a different
-- prepared set for the same contact. The exact key also avoids proof-history scans.
DROP TRIGGER inventory_match_result_update;
CREATE TRIGGER inventory_match_result_update BEFORE UPDATE ON match_results BEGIN
 SELECT CASE WHEN NEW.tenant!=OLD.tenant OR NEW.destination!=OLD.destination OR NEW.source_scope!=OLD.source_scope OR NEW.record_key!=OLD.record_key OR NEW.version!=OLD.version+1 OR NOT EXISTS(SELECT 1 FROM inventory_match_rows q JOIN inventory_match_sets h ON h.tenant=q.tenant AND h.set_id=q.set_id AND h.state='prepared' JOIN inventory_match_guards g ON g.tenant=h.tenant AND g.set_id=h.set_id WHERE q.tenant=NEW.tenant AND q.set_id=NEW.set_id AND q.source_scope=NEW.source_scope AND q.record_key=NEW.record_key AND h.destination=NEW.destination AND q.expected_version=OLD.version AND NEW.state=q.state AND NEW.reason IS q.reason AND NEW.remote_key IS q.remote_key AND NEW.derived_at=h.prepared_at) THEN RAISE(ABORT,'inventory match result version changed') END;
END;
