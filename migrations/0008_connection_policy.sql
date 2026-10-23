-- A guarded API transaction enforces the current one-account-per-service UI.
-- Existing logical destinations and their history remain intact.
CREATE TABLE connection_kind_guards (
 id TEXT PRIMARY KEY, tenant TEXT NOT NULL, kind TEXT NOT NULL,
 remote_identity TEXT NOT NULL, replacing_id TEXT
);
CREATE TRIGGER connection_kind_guard BEFORE INSERT ON connection_kind_guards BEGIN
 SELECT CASE WHEN NEW.replacing_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM connections WHERE tenant=NEW.tenant AND id=NEW.replacing_id AND kind=NEW.kind AND status='approval_pending') THEN RAISE(ABORT,'pending connection changed') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM connections WHERE tenant=NEW.tenant AND kind=NEW.kind AND remote_identity=NEW.remote_identity AND status!='revoked') AND EXISTS(SELECT 1 FROM connections WHERE tenant=NEW.tenant AND kind=NEW.kind AND status!='revoked' AND id!=COALESCE(NEW.replacing_id,'')) THEN RAISE(ABORT,'service already connected') END;
END;
