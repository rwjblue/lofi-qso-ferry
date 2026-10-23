-- Only aggregate operational metadata; never source payloads or vendor errors.
CREATE TABLE scheduler_runs (
 id TEXT PRIMARY KEY,
 started_at INTEGER NOT NULL,
 finished_at INTEGER,
 duration_ms INTEGER,
 status TEXT NOT NULL CHECK(status IN('running','completed','failed')),
 rounds INTEGER,
 stop_reason TEXT CHECK(stop_reason IS NULL OR stop_reason IN('idle','deadline')),
 source_pages INTEGER NOT NULL DEFAULT 0,
 contact_turns INTEGER NOT NULL DEFAULT 0,
 attempt_turns INTEGER NOT NULL DEFAULT 0,
 errors INTEGER NOT NULL DEFAULT 0,
 deferred INTEGER NOT NULL DEFAULT 0,
 failure TEXT CHECK(failure IS NULL OR failure='scheduled_processing_failed'),
 source_live INTEGER,
 source_background INTEGER,
 attempts_due_live INTEGER,
 attempts_due_background INTEGER
);
CREATE INDEX scheduler_runs_started ON scheduler_runs(started_at DESC);
CREATE INDEX admin_source_work ON source_work(priority,state,expires_at,tenant,source,private_id)
 WHERE kind='qso' AND is_event=0 AND deleted=0 AND state IN('pending','waiting','blocked','expired','missing_from_reread');
CREATE INDEX admin_attempt_backlog ON attempt_state(priority,state,due_at,tenant,attempt)
 WHERE state IN('prepared','dispatching','uncertain','submitted','reconciliation_required','rejected');
CREATE INDEX admin_ledger_candidates ON ledger(state,due_at)
 WHERE state IN('missing_current_identity','changed','live_new');
CREATE INDEX admin_ledger_attention ON ledger(state)
 WHERE state IN('history_mismatch','history_ambiguous','historical_unverified');
CREATE INDEX admin_connections_created ON connections(created_at DESC,tenant,id);
CREATE INDEX admin_accounts_verified ON accounts(verified_at DESC,id);
