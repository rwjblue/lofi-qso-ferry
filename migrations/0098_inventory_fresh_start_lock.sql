-- An account-only rehearsal has no evidence that its previous sender stopped.
-- Inventory and preparation may run, but this copy cannot claim a send.
CREATE TABLE inventory_fresh_start_lock (
 id INTEGER PRIMARY KEY CHECK(id=1),locked_at INTEGER NOT NULL CHECK(locked_at>0),
 prior_legacy_unsettled INTEGER NOT NULL CHECK(prior_legacy_unsettled>=0),
 prior_qrz_unsettled INTEGER NOT NULL CHECK(prior_qrz_unsettled>=0)
);
CREATE TRIGGER inventory_fresh_start_lock_update BEFORE UPDATE ON inventory_fresh_start_lock BEGIN SELECT RAISE(ABORT,'immutable inventory fresh start lock'); END;
CREATE TRIGGER inventory_fresh_start_lock_delete BEFORE DELETE ON inventory_fresh_start_lock BEGIN SELECT RAISE(ABORT,'inventory fresh start requires an audited cutover'); END;
CREATE TRIGGER inventory_fresh_start_no_qrz_dispatch BEFORE INSERT ON inventory_qrz_dispatch_guards
 WHEN EXISTS(SELECT 1 FROM inventory_fresh_start_lock WHERE id=1) BEGIN
 SELECT RAISE(ABORT,'inventory fresh start requires an audited cutover');
END;
