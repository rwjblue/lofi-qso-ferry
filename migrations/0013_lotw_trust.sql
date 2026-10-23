-- Only public ARRL roots and safe refresh metadata belong in this global cache.
CREATE TABLE lotw_trust_cache (
 id TEXT PRIMARY KEY CHECK(id='arrl'),
 roots_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(roots_json)),
 source TEXT NOT NULL DEFAULT 'https://lotw.arrl.org/lotwuser/certs.tq6'
  CHECK(source='https://lotw.arrl.org/lotwuser/certs.tq6'),
 last_success_at INTEGER,
 last_attempt_at INTEGER,
 next_attempt_at INTEGER NOT NULL DEFAULT 0,
 last_status TEXT NOT NULL DEFAULT 'unconfigured'
  CHECK(last_status IN('updated','cached','unavailable','deferred','unconfigured')),
 lease_token TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0
);
