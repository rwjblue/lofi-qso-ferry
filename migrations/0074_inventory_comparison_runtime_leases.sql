-- Read-only inventory owns derived comparison and historical-adoption leases.
-- Existing checkpoint, proof, staging and upload retirement guards still apply.
DROP TRIGGER inventory_retired_lease_insert;
DROP TRIGGER inventory_retired_lease_update;
CREATE TRIGGER inventory_retired_lease_insert BEFORE INSERT ON leases
 WHEN NEW.expires_at>unixepoch('subsec')*1000 AND EXISTS(SELECT 1 FROM inventory_runtime WHERE id=1 AND mode='inventory_read_only') AND NOT (substr(NEW.scope,1,10)='inventory:' OR (EXISTS(SELECT 1 FROM accounts a WHERE a.id=NEW.tenant AND a.status='active') AND (
 NEW.scope IN('inventory-comparison','inventory-ownership:qrz','inventory-ownership:lotw') OR NEW.scope GLOB 'comparison:*:*' OR NEW.scope GLOB 'projection:*:*' OR NEW.scope GLOB 'matching:*'
 OR CASE WHEN length(NEW.scope)<=16384 AND json_valid(NEW.scope) THEN json_type(NEW.scope)='array' AND (json_extract(NEW.scope,'$[0]'),json_array_length(NEW.scope)) IN(('projection-fanout',4),('projection-coverage',3),('matching-pair',4),('matching-bucket',5),('matching-coverage-event',5),('matching-coverage-node',5),('matching-selected-record',5)) ELSE 0 END
 )))
 BEGIN SELECT RAISE(ABORT,'legacy reader retired');
END;
CREATE TRIGGER inventory_retired_lease_update BEFORE UPDATE ON leases
 WHEN NEW.expires_at>unixepoch('subsec')*1000 AND EXISTS(SELECT 1 FROM inventory_runtime WHERE id=1 AND mode='inventory_read_only') AND NOT (substr(NEW.scope,1,10)='inventory:' OR (EXISTS(SELECT 1 FROM accounts a WHERE a.id=NEW.tenant AND a.status='active') AND (
 NEW.scope IN('inventory-comparison','inventory-ownership:qrz','inventory-ownership:lotw') OR NEW.scope GLOB 'comparison:*:*' OR NEW.scope GLOB 'projection:*:*' OR NEW.scope GLOB 'matching:*'
 OR CASE WHEN length(NEW.scope)<=16384 AND json_valid(NEW.scope) THEN json_type(NEW.scope)='array' AND (json_extract(NEW.scope,'$[0]'),json_array_length(NEW.scope)) IN(('projection-fanout',4),('projection-coverage',3),('matching-pair',4),('matching-bucket',5),('matching-coverage-event',5),('matching-coverage-node',5),('matching-selected-record',5)) ELSE 0 END
 )))
 BEGIN SELECT RAISE(ABORT,'legacy reader retired');
END;
