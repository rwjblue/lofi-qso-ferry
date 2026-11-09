-- Admission looks up each new ownership envelope by evidence ID. Completion
-- counts just the durable associations from the current adoption page.
CREATE INDEX inventory_adoption_new_evidence
 ON inventory_adoption_rows(tenant,evidence_id) WHERE existing_evidence=0;
CREATE INDEX inventory_historical_adoption_page
 ON inventory_historical_associations(tenant,adoption_page);
