-- Each LoTW scope has one account receipt stream, distinct from its dated
-- selections. A receive-time report cannot replace a published epoch.
CREATE UNIQUE INDEX inventory_lotw_account_receipt_stream
 ON inventory_scheduled_selections(tenant,scope_id)
 WHERE json_extract(plan,'$.provider')='lotw' AND json_extract(plan,'$.selection.kind')='account_received';

CREATE TRIGGER inventory_lotw_account_receipt_delta BEFORE INSERT ON inventory_runs
 WHEN json_extract(NEW.fixed_query,'$.query.kind')='account_received' AND (
  json_extract(NEW.fixed_query,'$.provider') IS NOT 'lotw' OR NEW.mode!='delta' OR NEW.requires_catchup!=0 OR NEW.facet!='receipt'
  OR EXISTS(SELECT 1 FROM inventory_coverage c WHERE (c.tenant,c.scope_id,c.stream_id)=(NEW.tenant,NEW.scope_id,NEW.stream_id) AND c.published_run_id IS NOT NULL)
 ) BEGIN
 SELECT RAISE(ABORT,'LoTW account receipt runs require a positive-only stream');
END;
