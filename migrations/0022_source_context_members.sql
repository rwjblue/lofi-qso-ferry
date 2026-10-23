-- Context projection and commit fences inspect only operation bases/events.
-- Avoid scanning every ordinary contact belonging to a large general log.
CREATE INDEX source_context_members ON source_work(tenant,source,operation_id)
WHERE kind='operation' OR is_event=1;
