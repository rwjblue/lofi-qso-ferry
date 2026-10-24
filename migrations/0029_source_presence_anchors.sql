-- Bound targeted positive reads by actual canonical server observations.
-- A boundary is a seek hint, never evidence that its interval is complete.
CREATE INDEX source_presence_anchor ON source_work(tenant,source,policy_seen_epoch,kind,synced_at);
