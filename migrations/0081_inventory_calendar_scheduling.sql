CREATE TABLE inventory_calendar_registration_progress(
 id INTEGER PRIMARY KEY CHECK(id=1),
 last_tenant TEXT NOT NULL,last_connection TEXT NOT NULL,last_month TEXT NOT NULL
);
INSERT INTO inventory_calendar_registration_progress VALUES(1,'','','');
CREATE INDEX inventory_source_calendar_roster ON inventory_source_calendar_months(tenant,month_start,scope_id);
CREATE INDEX inventory_scheduled_lotw_plan ON inventory_scheduled_selections(tenant,scope_id,config_version,plan) WHERE json_extract(plan,'$.provider')='lotw';
