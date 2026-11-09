CREATE INDEX inventory_overflow_jobs ON inventory_stream_jobs(tenant,scope_id,stream_id)
 WHERE state='held' AND reason='overflow';
