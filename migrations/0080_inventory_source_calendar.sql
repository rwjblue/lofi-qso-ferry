-- Source dates select receipt reads; they never establish receipt coverage.
-- Store only distinct UTC months per logical source, not a date/record index.
ALTER TABLE inventory_scopes ADD COLUMN source_calendar_format INTEGER NOT NULL DEFAULT 1 CHECK(source_calendar_format=1);
ALTER TABLE ingestion_pages ADD COLUMN lotw_calendar_months TEXT CHECK(lotw_calendar_months IS NULL OR (json_valid(lotw_calendar_months) AND json_type(lotw_calendar_months)='array' AND json_array_length(lotw_calendar_months)<=20000));
CREATE TABLE inventory_source_calendar_months (
 tenant TEXT NOT NULL, scope_id TEXT NOT NULL,
 month_start TEXT NOT NULL CHECK(length(month_start)=10 AND date(month_start,'start of month') IS month_start),
 first_sequence INTEGER NOT NULL CHECK(first_sequence>0), first_observed_at INTEGER NOT NULL CHECK(first_observed_at>0),
 PRIMARY KEY(tenant,scope_id,month_start), FOREIGN KEY(tenant,scope_id) REFERENCES inventory_scopes(tenant,scope_id)
);
CREATE TRIGGER inventory_source_calendar_page_binding BEFORE INSERT ON ingestion_pages WHEN (NEW.lotw_calendar_months IS NOT NULL)!=EXISTS(SELECT 1 FROM inventory_scopes s WHERE s.tenant=NEW.tenant AND s.scope_id=NEW.scope_id AND s.provider='lofi' AND s.source_calendar_format=1) BEGIN SELECT RAISE(ABORT,'inventory source calendar format changed'); END;
CREATE TRIGGER inventory_source_calendar_page_immutable BEFORE UPDATE OF lotw_calendar_months ON ingestion_pages WHEN NEW.lotw_calendar_months IS NOT OLD.lotw_calendar_months BEGIN SELECT RAISE(ABORT,'immutable inventory source calendar hints'); END;
CREATE TRIGGER inventory_source_calendar_admit BEFORE INSERT ON ingestion_page_guards WHEN EXISTS(SELECT 1 FROM ingestion_pages p WHERE p.tenant=NEW.tenant AND p.page_id=NEW.page_id AND json_array_length(p.lotw_calendar_months)>0) BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ingestion_pages p WHERE p.tenant=NEW.tenant AND p.page_id=NEW.page_id AND (json_array_length(p.lotw_calendar_months)>2*(SELECT count(*) FROM ingestion_page_rows r WHERE r.tenant=p.tenant AND r.page_id=p.page_id AND r.facet='source' AND r.entity_family='qso' AND r.subtype='qso' AND r.status='active' AND r.accepted=1) OR json_array_length(p.lotw_calendar_months)!=(SELECT count(DISTINCT value) FROM json_each(p.lotw_calendar_months)) OR EXISTS(SELECT 1 FROM json_each(p.lotw_calendar_months) m WHERE m.type!='text' OR length(m.value)!=10 OR date(m.value,'start of month') IS NOT m.value))) THEN RAISE(ABORT,'inventory source calendar hints invalid') END;
END;
CREATE TRIGGER inventory_source_calendar_commit AFTER UPDATE OF state ON ingestion_pages WHEN OLD.state='prepared' AND NEW.state='committed' AND json_array_length(NEW.lotw_calendar_months)>0 BEGIN
 INSERT INTO inventory_source_calendar_months(tenant,scope_id,month_start,first_sequence,first_observed_at)
 SELECT NEW.tenant,NEW.scope_id,value,NEW.expected_sequence+1,NEW.request_started_at FROM json_each(NEW.lotw_calendar_months) WHERE type='text'
 ON CONFLICT(tenant,scope_id,month_start) DO NOTHING;
END;
