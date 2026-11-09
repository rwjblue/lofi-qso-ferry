-- Alternate matching and adoption within the existing comparison slot.
-- Keep existing phase numbers, wake clocks, cursors and retry deadlines.
ALTER TABLE inventory_comparison_coordinators ADD COLUMN match_activity INTEGER NOT NULL DEFAULT 0 CHECK(match_activity IN(0,1));
DROP TRIGGER inventory_comparison_control_update;
CREATE TRIGGER inventory_comparison_control_update BEFORE UPDATE ON inventory_comparison_coordinators BEGIN
 SELECT CASE WHEN NEW.tenant!=OLD.tenant OR NEW.phase_count!=OLD.phase_count OR NEW.version<OLD.version OR NEW.work_version<OLD.work_version OR NEW.observed_version<OLD.observed_version THEN RAISE(ABORT,'comparison coordinator regressed') END;
 SELECT CASE WHEN NEW.work_version!=OLD.work_version AND (NEW.work_version!=OLD.work_version+1 OR (NEW.version,NEW.observed_version,NEW.phase,NEW.idle_turns,NEW.next_due_at,NEW.build_generation,NEW.build_scope,NEW.updated_at,NEW.match_activity) IS NOT (OLD.version,OLD.observed_version,OLD.phase,OLD.idle_turns,OLD.next_due_at,OLD.build_generation,OLD.build_scope,OLD.updated_at,OLD.match_activity)) THEN RAISE(ABORT,'comparison wakeup changed progress') END;
 SELECT CASE WHEN NEW.work_version=OLD.work_version AND (NEW.version!=OLD.version+1 OR NEW.observed_version!=NEW.work_version OR NOT EXISTS(SELECT 1 FROM leases l JOIN accounts a ON a.id=l.tenant AND a.status='active' WHERE l.tenant=OLD.tenant AND l.scope='inventory-comparison' AND l.expires_at>unixepoch('subsec')*1000)) THEN RAISE(ABORT,'comparison coordinator lease missing') END;
 SELECT CASE WHEN NEW.work_version=OLD.work_version AND NEW.match_activity!=CASE WHEN OLD.phase=9 AND NEW.phase=10 THEN 1-OLD.match_activity ELSE OLD.match_activity END THEN RAISE(ABORT,'comparison match activity out of turn') END;
END;
UPDATE inventory_comparison_coordinators SET work_version=work_version+1 WHERE EXISTS(SELECT 1 FROM inventory_adoption_work w WHERE w.tenant=inventory_comparison_coordinators.tenant);
