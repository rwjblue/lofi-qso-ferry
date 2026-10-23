-- Only aggregate operational metadata; never source payloads or vendor errors.
CREATE TABLE scheduler_runs_next (
 id TEXT PRIMARY KEY,
 started_at INTEGER NOT NULL,
 finished_at INTEGER,
 duration_ms INTEGER,
 status TEXT NOT NULL CHECK(status IN('running','completed','failed')),
 rounds INTEGER,
 stop_reason TEXT CHECK(stop_reason IS NULL OR stop_reason IN('idle','deadline','database_budget')),
 source_pages INTEGER NOT NULL DEFAULT 0,
 contact_turns INTEGER NOT NULL DEFAULT 0,
 attempt_turns INTEGER NOT NULL DEFAULT 0,
 errors INTEGER NOT NULL DEFAULT 0,
 deferred INTEGER NOT NULL DEFAULT 0,
 failure TEXT CHECK(failure IS NULL OR failure='scheduled_processing_failed'),
 source_live INTEGER,
 source_background INTEGER,
 attempts_due_live INTEGER,
 attempts_due_background INTEGER,
 work_live_ready INTEGER,
 work_live_held INTEGER,
 work_live_blocked INTEGER,
 work_background_ready INTEGER,
 work_background_held INTEGER,
 work_background_blocked INTEGER,
 throughput_json TEXT NOT NULL DEFAULT '{}'
);
INSERT INTO scheduler_runs_next SELECT *, '{}' FROM scheduler_runs;
DROP TABLE scheduler_runs;
ALTER TABLE scheduler_runs_next RENAME TO scheduler_runs;
CREATE INDEX scheduler_runs_started ON scheduler_runs(started_at DESC);
