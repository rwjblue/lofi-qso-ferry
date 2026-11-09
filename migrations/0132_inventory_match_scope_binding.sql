-- Keep the user's sync policy version with the immutable comparison. Contact
-- dates remain encrypted; the marker distinguishes policy from source exclusion.
ALTER TABLE inventory_match_sets ADD COLUMN sync_scope_version INTEGER NOT NULL DEFAULT 0 CHECK(sync_scope_version>=0);
ALTER TABLE inventory_match_rows ADD COLUMN scope_excluded INTEGER NOT NULL DEFAULT 0 CHECK(scope_excluded IN(0,1) AND (scope_excluded=0 OR state='excluded'));
CREATE TRIGGER inventory_match_scope_version_immutable
 BEFORE UPDATE OF sync_scope_version ON inventory_match_sets
 WHEN NEW.sync_scope_version!=OLD.sync_scope_version BEGIN
 SELECT RAISE(ABORT,'immutable inventory match sync scope');
END;
CREATE TRIGGER inventory_match_scope_version_current
 BEFORE INSERT ON inventory_match_guards WHEN EXISTS(
 SELECT 1 FROM inventory_match_sets h JOIN inventory_scopes d ON (d.tenant,d.scope_id)=(h.tenant,h.destination)
 LEFT JOIN inventory_sync_scopes p ON (p.tenant,p.destination)=(d.tenant,d.connection_id)
 WHERE (h.tenant,h.set_id)=(NEW.tenant,NEW.set_id) AND h.sync_scope_version!=coalesce(p.version,0)
) BEGIN
 SELECT RAISE(ABORT,'inventory match sync scope changed');
END;
