-- Work and its queue acknowledgement share the same versioned row.
ALTER TABLE inventory_source_proof_jobs ADD COLUMN published_version INTEGER NOT NULL DEFAULT 0 CHECK(published_version BETWEEN 0 AND version);
ALTER TABLE inventory_source_proof_jobs ADD COLUMN published_at INTEGER NOT NULL DEFAULT 0 CHECK(published_at>=0);
