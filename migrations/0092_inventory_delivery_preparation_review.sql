-- Share the same eligibility predicate with preparation and rechecks. Validate
-- each distinct matching set after selecting the bounded member cohort.
CREATE VIEW inventory_delivery_preparation_review AS
 SELECT b.tenant,b.destination,b.source_scope,b.record_key,b.provider,b.generation_id,b.result_set,b.result_version,
        b.reviewed_at,b.proof_not_before,b.source_config_version,b.destination_config_version,
        b.source_identity,b.book_identity,b.ownership_version,b.source_credential,b.destination_credential,
        b.projection_version,b.projection_payload,d.connection_id AS destination_connection,
        json_remove(c.config,'$.lastError','$.lastSuccessfulPollAt') AS destination_config
 FROM inventory_delivery_review_basis b
 JOIN inventory_scopes d ON d.tenant=b.tenant AND d.scope_id=b.destination
 JOIN connections c ON c.tenant=d.tenant AND c.id=d.connection_id
 WHERE b.decision='source_proof_required' AND b.blocker IS NULL
 AND b.ownership_version=b.current_ownership_version AND b.source_credential=b.current_source_credential
 AND b.destination_credential=b.current_destination_credential;
