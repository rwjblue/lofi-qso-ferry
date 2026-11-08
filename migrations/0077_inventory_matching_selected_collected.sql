-- A replacement can remove the last older selected-input dependent without
-- selecting that identity itself. Finish its job in the same transaction.
CREATE TRIGGER inventory_matching_selected_collected AFTER DELETE ON inventory_matching_selected_dependents BEGIN
 UPDATE inventory_matching_selected_jobs SET completed_version=work_version
 WHERE tenant=OLD.tenant AND generation_id=OLD.generation_id AND scope_id=OLD.scope_id AND facet=OLD.facet AND record_key=OLD.record_key AND completed_version<work_version
 AND NOT EXISTS(SELECT 1 FROM inventory_matching_selected_dependents d INDEXED BY inventory_matching_selected_dependents_clock WHERE d.tenant=OLD.tenant AND d.generation_id=OLD.generation_id AND d.scope_id=OLD.scope_id AND d.facet=OLD.facet AND d.record_key=OLD.record_key AND d.seen_clock<inventory_matching_selected_jobs.work_version);
END;
