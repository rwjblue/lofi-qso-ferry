-- Add review to the existing matching slot without changing phase numbers.
ALTER TABLE inventory_comparison_coordinators ADD COLUMN review_activity INTEGER NOT NULL DEFAULT 0 CHECK(review_activity BETWEEN 0 AND 2);
DROP TRIGGER inventory_comparison_control_update;
CREATE TRIGGER inventory_comparison_control_update BEFORE UPDATE ON inventory_comparison_coordinators BEGIN
 SELECT CASE WHEN NEW.tenant!=OLD.tenant OR NEW.phase_count!=OLD.phase_count OR NEW.version<OLD.version OR NEW.work_version<OLD.work_version OR NEW.observed_version<OLD.observed_version THEN RAISE(ABORT,'comparison coordinator regressed') END;
 SELECT CASE WHEN NEW.work_version!=OLD.work_version AND (NEW.work_version!=OLD.work_version+1 OR (NEW.version,NEW.observed_version,NEW.phase,NEW.idle_turns,NEW.next_due_at,NEW.build_generation,NEW.build_scope,NEW.updated_at,NEW.match_activity,NEW.review_activity) IS NOT (OLD.version,OLD.observed_version,OLD.phase,OLD.idle_turns,OLD.next_due_at,OLD.build_generation,OLD.build_scope,OLD.updated_at,OLD.match_activity,OLD.review_activity)) THEN RAISE(ABORT,'comparison wakeup changed progress') END;
 SELECT CASE WHEN NEW.work_version=OLD.work_version AND (NEW.version!=OLD.version+1 OR NEW.observed_version!=NEW.work_version OR NOT EXISTS(SELECT 1 FROM leases l JOIN accounts a ON a.id=l.tenant AND a.status='active' WHERE l.tenant=OLD.tenant AND l.scope='inventory-comparison' AND l.expires_at>unixepoch('subsec')*1000)) THEN RAISE(ABORT,'comparison coordinator lease missing') END;
 SELECT CASE WHEN NEW.work_version=OLD.work_version AND (NEW.match_activity,NEW.review_activity) IS NOT (CASE WHEN OLD.phase=9 AND NEW.phase=10 THEN 1-OLD.match_activity ELSE OLD.match_activity END,CASE WHEN OLD.phase=9 AND NEW.phase=10 THEN (OLD.review_activity+1)%3 ELSE OLD.review_activity END) THEN RAISE(ABORT,'comparison match activity out of turn') END;
END;

CREATE INDEX inventory_delivery_review_provider ON inventory_delivery_review(tenant,provider) WHERE reviewed_at IS NOT NULL;
CREATE TRIGGER inventory_delivery_review_wake_match AFTER UPDATE OF state ON inventory_match_sets
 WHEN NEW.state='committed' AND EXISTS(SELECT 1 FROM inventory_delivery_review w WHERE w.tenant=NEW.tenant AND w.result_set=NEW.set_id)
 BEGIN
 INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant)
 ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1 WHERE observed_version=work_version;
END;
CREATE TRIGGER inventory_delivery_review_wake_domain AFTER INSERT ON inventory_ownership_domains
 WHEN EXISTS(SELECT 1 FROM inventory_delivery_review w WHERE w.tenant=NEW.tenant AND w.provider=NEW.provider AND w.reviewed_at IS NOT NULL)
 BEGIN
 INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant)
 ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1 WHERE observed_version=work_version;
END;
CREATE TRIGGER inventory_delivery_review_wake_ownership AFTER UPDATE OF version ON inventory_ownership_domains
 WHEN NEW.version!=OLD.version AND EXISTS(SELECT 1 FROM inventory_delivery_review w WHERE w.tenant=NEW.tenant AND w.provider=NEW.provider AND w.reviewed_at IS NOT NULL)
 BEGIN
 INSERT INTO inventory_comparison_coordinators(tenant) VALUES(NEW.tenant)
 ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1 WHERE observed_version=work_version;
END;
DROP TRIGGER inventory_delivery_review_credential_changed;
CREATE TRIGGER inventory_delivery_review_credential_changed AFTER UPDATE OF credential_version ON connections WHEN NEW.credential_version IS NOT OLD.credential_version BEGIN
 UPDATE inventory_delivery_review SET due_at=CAST(unixepoch('subsec')*1000 AS INTEGER),reviewed_at=NULL,decision=NULL,ownership_version=-1,source_credential=NULL,destination_credential=NULL
 WHERE tenant=NEW.tenant AND decision IS NOT NULL AND EXISTS(SELECT 1 FROM inventory_scopes s WHERE s.tenant=NEW.tenant AND s.connection_id=NEW.id AND s.scope_id IN(inventory_delivery_review.source_scope,inventory_delivery_review.destination));
 INSERT INTO inventory_comparison_coordinators(tenant) SELECT NEW.tenant WHERE changes()>0
 ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1 WHERE observed_version=work_version;
END;
INSERT INTO inventory_comparison_coordinators(tenant) SELECT DISTINCT tenant FROM inventory_delivery_review WHERE true
 ON CONFLICT(tenant) DO UPDATE SET work_version=inventory_comparison_coordinators.work_version+1 WHERE observed_version=work_version;
