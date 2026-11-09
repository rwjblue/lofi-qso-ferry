-- An empty scan from the beginning settles the observed generation. Changes
-- that can introduce a gap invalidate it, even during a paginated scan.
ALTER TABLE inventory_calendar_registration_progress ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE inventory_calendar_registration_progress ADD COLUMN checked_generation INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER inventory_calendar_month_insert AFTER INSERT ON inventory_source_calendar_months BEGIN
 UPDATE inventory_calendar_registration_progress SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER inventory_calendar_month_change AFTER UPDATE OF tenant,scope_id,month_start ON inventory_source_calendar_months
 WHEN (NEW.tenant,NEW.scope_id,NEW.month_start) IS NOT (OLD.tenant,OLD.scope_id,OLD.month_start) BEGIN
 UPDATE inventory_calendar_registration_progress SET generation=generation+1 WHERE id=1;
END;

CREATE TRIGGER inventory_calendar_account_change AFTER UPDATE OF status ON accounts
 WHEN NEW.status IS NOT OLD.status BEGIN
 UPDATE inventory_calendar_registration_progress SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER inventory_calendar_connection_insert AFTER INSERT ON connections
 WHEN NEW.kind IN('qrz','lotw') AND NEW.status='active' BEGIN
 UPDATE inventory_calendar_registration_progress SET generation=generation+1 WHERE id=1;
END;
-- Successful poll bookkeeping also updates config. Compare the read settings
-- so regular polling does not wake discovery.
CREATE TRIGGER inventory_calendar_connection_change AFTER UPDATE OF kind,status,remote_identity,credential_version,config ON connections
 WHEN (NEW.kind,NEW.status,NEW.remote_identity,NEW.credential_version) IS NOT (OLD.kind,OLD.status,OLD.remote_identity,OLD.credential_version)
 OR (NEW.kind IN('qrz','lotw') AND (
   json_valid(NEW.config)!=json_valid(OLD.config)
   OR CASE WHEN json_valid(NEW.config) AND json_valid(OLD.config) THEN
    (json_extract(NEW.config,'$.bookId'),json_extract(NEW.config,'$.stationCallsign'),json_extract(NEW.config,'$.startDate'),json_extract(NEW.config,'$.endDate'),json_extract(NEW.config,'$.readAccess'))
    IS NOT (json_extract(OLD.config,'$.bookId'),json_extract(OLD.config,'$.stationCallsign'),json_extract(OLD.config,'$.startDate'),json_extract(OLD.config,'$.endDate'),json_extract(OLD.config,'$.readAccess'))
   END
 )) BEGIN
 UPDATE inventory_calendar_registration_progress SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER inventory_calendar_credential_insert AFTER INSERT ON private_data
 WHEN NEW.kind='credential' BEGIN
 UPDATE inventory_calendar_registration_progress SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER inventory_calendar_credential_change AFTER UPDATE OF revoked_at,expires_at ON private_data
 WHEN NEW.kind='credential' AND (NEW.revoked_at,NEW.expires_at) IS NOT (OLD.revoked_at,OLD.expires_at) BEGIN
 UPDATE inventory_calendar_registration_progress SET generation=generation+1 WHERE id=1;
END;

CREATE TRIGGER inventory_calendar_scope_change AFTER UPDATE OF connection_id,provider,logical_identity,config_version,runtime_version,state ON inventory_scopes
 WHEN (NEW.connection_id,NEW.provider,NEW.logical_identity,NEW.config_version,NEW.runtime_version,NEW.state)
 IS NOT (OLD.connection_id,OLD.provider,OLD.logical_identity,OLD.config_version,OLD.runtime_version,OLD.state) BEGIN
 UPDATE inventory_calendar_registration_progress SET generation=generation+1 WHERE id=1;
END;

CREATE TRIGGER inventory_calendar_policy_insert AFTER INSERT ON inventory_sync_scopes BEGIN
 UPDATE inventory_calendar_registration_progress SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER inventory_calendar_policy_change AFTER UPDATE OF mode,since ON inventory_sync_scopes
 WHEN (NEW.mode,NEW.since) IS NOT (OLD.mode,OLD.since) BEGIN
 UPDATE inventory_calendar_registration_progress SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER inventory_calendar_policy_delete AFTER DELETE ON inventory_sync_scopes BEGIN
 UPDATE inventory_calendar_registration_progress SET generation=generation+1 WHERE id=1;
END;

-- An inserted window only closes gaps. A removed window or one that no longer
-- matches its scope's version can create a gap.
CREATE TRIGGER inventory_calendar_schedule_change AFTER UPDATE OF config_version ON inventory_scheduled_selections
 WHEN NEW.config_version IS NOT OLD.config_version BEGIN
 UPDATE inventory_calendar_registration_progress SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER inventory_calendar_schedule_delete AFTER DELETE ON inventory_scheduled_selections BEGIN
 UPDATE inventory_calendar_registration_progress SET generation=generation+1 WHERE id=1;
END;
