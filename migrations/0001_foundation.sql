PRAGMA foreign_keys = ON;
CREATE TABLE accounts (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, user_handle TEXT NOT NULL UNIQUE,
 verified_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', quiet_minutes INTEGER NOT NULL DEFAULT 30 CHECK(quiet_minutes BETWEEN 20 AND 60)
);
CREATE TABLE passkeys (
 id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES accounts(id), public_key TEXT NOT NULL,
 counter INTEGER NOT NULL, metadata TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL,
 last_used_at INTEGER, revoked_at INTEGER, UNIQUE(tenant,id)
);
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES accounts(id), credential_id TEXT NOT NULL,
 created_at INTEGER NOT NULL, verified_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER,
 FOREIGN KEY(tenant,credential_id) REFERENCES passkeys(tenant,id)
);
CREATE TABLE signups (
 id TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, email TEXT NOT NULL, code_hash TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, verified_at INTEGER, consumed_at INTEGER,
 tenant TEXT REFERENCES accounts(id), purpose TEXT NOT NULL DEFAULT 'signup'
);
CREATE TABLE ceremonies (
 id TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, tenant TEXT REFERENCES accounts(id), purpose TEXT NOT NULL,
 challenge_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER, winner TEXT
);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
CREATE TABLE connections (
 tenant TEXT NOT NULL REFERENCES accounts(id), id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('lofi','qrz','lotw')),
 remote_identity TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'disabled',
 credential_version TEXT, config TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, last_poll_at INTEGER,
 cutover TEXT, PRIMARY KEY(tenant,id), UNIQUE(tenant,kind,remote_identity)
);
CREATE TABLE private_data (
 tenant TEXT NOT NULL, connection TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
 envelope TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER,
 PRIMARY KEY(tenant,connection,id,kind), FOREIGN KEY(tenant,connection) REFERENCES connections(tenant,id)
);
CREATE TABLE cursors (
 tenant TEXT NOT NULL, connection TEXT NOT NULL, stream TEXT NOT NULL, cursor TEXT NOT NULL,
 generation INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(tenant,connection,stream),
 FOREIGN KEY(tenant,connection) REFERENCES connections(tenant,id)
);
CREATE TABLE templates (
 tenant TEXT NOT NULL, destination TEXT NOT NULL, id TEXT NOT NULL, config TEXT NOT NULL,
 created_at INTEGER NOT NULL, PRIMARY KEY(tenant,destination,id),
 FOREIGN KEY(tenant,destination) REFERENCES connections(tenant,id)
);
CREATE TRIGGER templates_immutable BEFORE UPDATE ON templates BEGIN SELECT RAISE(ABORT,'immutable template'); END;
CREATE TABLE active_templates (
 tenant TEXT NOT NULL, destination TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY(tenant,destination),
 FOREIGN KEY(tenant,destination,version) REFERENCES templates(tenant,destination,id)
);
CREATE TABLE ledger (
 tenant TEXT NOT NULL, source TEXT NOT NULL, qso TEXT NOT NULL, destination TEXT NOT NULL,
 generation TEXT NOT NULL, source_hash TEXT NOT NULL, baseline_hash TEXT, remote_hash TEXT, sent_hash TEXT,
 state TEXT NOT NULL DEFAULT 'inventory_pending', reason TEXT,
 narrative TEXT NOT NULL DEFAULT 'unbound' CHECK(narrative IN ('unbound','template_bound','remote_preserved')),
 template_version TEXT, remote_id TEXT, provenance TEXT NOT NULL DEFAULT 'unknown',
 due_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant,source,qso,destination), UNIQUE(tenant,destination,remote_id),
 FOREIGN KEY(tenant,source) REFERENCES connections(tenant,id), FOREIGN KEY(tenant,destination) REFERENCES connections(tenant,id),
 FOREIGN KEY(tenant,destination,template_version) REFERENCES templates(tenant,destination,id),
 CHECK((narrative='template_bound' AND template_version IS NOT NULL) OR (narrative!='template_bound' AND template_version IS NULL))
);
CREATE TABLE leases (
 tenant TEXT NOT NULL, scope TEXT NOT NULL, token TEXT NOT NULL, fence INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, PRIMARY KEY(tenant,scope)
);
CREATE TABLE attempts (
 tenant TEXT NOT NULL, id TEXT NOT NULL, source TEXT NOT NULL, qso TEXT NOT NULL, destination TEXT NOT NULL,
 generation TEXT NOT NULL, payload_id TEXT NOT NULL, payload_hash TEXT NOT NULL, template_version TEXT,
 credential_version TEXT NOT NULL, created_at INTEGER NOT NULL, source_hash TEXT NOT NULL, PRIMARY KEY(tenant,id),
 FOREIGN KEY(tenant,source,qso,destination) REFERENCES ledger(tenant,source,qso,destination)
);
CREATE TRIGGER attempts_immutable BEFORE UPDATE ON attempts BEGIN SELECT RAISE(ABORT,'immutable attempt'); END;
CREATE TABLE attempt_state (
 tenant TEXT NOT NULL, attempt TEXT NOT NULL, state TEXT NOT NULL, due_at INTEGER NOT NULL,
 lease_token TEXT, fence INTEGER, dispatched_at INTEGER, updated_at INTEGER NOT NULL,
 reason TEXT, remote_id TEXT, PRIMARY KEY(tenant,attempt), FOREIGN KEY(tenant,attempt) REFERENCES attempts(tenant,id)
);
CREATE UNIQUE INDEX one_unresolved_attempt ON attempt_state(tenant,attempt);
CREATE TABLE attempt_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, attempt TEXT NOT NULL, state TEXT NOT NULL,
 at INTEGER NOT NULL, reason TEXT, FOREIGN KEY(tenant,attempt) REFERENCES attempts(tenant,id)
);
CREATE TRIGGER events_immutable BEFORE UPDATE ON attempt_events BEGIN SELECT RAISE(ABORT,'immutable event'); END;
CREATE TABLE partitions (
 tenant TEXT NOT NULL, source TEXT NOT NULL, destination TEXT NOT NULL, id TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'inventory_pending', evidence TEXT NOT NULL DEFAULT '{}', expires_at INTEGER NOT NULL,
 PRIMARY KEY(tenant,source,destination,id), FOREIGN KEY(tenant,source) REFERENCES connections(tenant,id),
 FOREIGN KEY(tenant,destination) REFERENCES connections(tenant,id)
);
CREATE INDEX private_expiry ON private_data(expires_at);
CREATE INDEX ledger_due ON ledger(tenant,destination,due_at);
CREATE INDEX attempt_due ON attempt_state(state,due_at);
CREATE TABLE checkpoint_guards(id TEXT PRIMARY KEY,tenant TEXT,scope TEXT,token TEXT,fence INTEGER,now INTEGER,connection TEXT,stream TEXT,expected INTEGER);
CREATE TRIGGER checkpoint_guard BEFORE INSERT ON checkpoint_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM leases WHERE tenant=NEW.tenant AND scope=NEW.scope AND token=NEW.token AND fence=NEW.fence AND expires_at>NEW.now) THEN RAISE(ABORT,'lease lost') END;
 SELECT CASE WHEN COALESCE((SELECT generation FROM cursors WHERE tenant=NEW.tenant AND connection=NEW.connection AND stream=NEW.stream),0)!=NEW.expected THEN RAISE(ABORT,'cursor changed') END;
END;
CREATE TABLE stage_guards(id TEXT PRIMARY KEY,tenant TEXT,source TEXT,qso TEXT,destination TEXT,generation TEXT,template_version TEXT,now INTEGER,credential_version TEXT);
CREATE TRIGGER stage_guard BEFORE INSERT ON stage_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ledger WHERE tenant=NEW.tenant AND source=NEW.source AND qso=NEW.qso AND destination=NEW.destination AND generation=NEW.generation AND due_at<=NEW.now AND state IN('missing_current_identity','changed','live_new') AND (narrative='remote_preserved' AND NEW.template_version IS NULL OR narrative='template_bound' AND template_version=NEW.template_version OR narrative='unbound' AND (NEW.template_version IS NULL OR NEW.template_version=(SELECT version FROM active_templates WHERE tenant=NEW.tenant AND destination=NEW.destination)))) THEN RAISE(ABORT,'stale or ineligible stage') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM connections WHERE tenant=NEW.tenant AND id=NEW.destination AND kind='qrz') AND NEW.template_version IS NULL AND NOT EXISTS(SELECT 1 FROM ledger WHERE tenant=NEW.tenant AND source=NEW.source AND qso=NEW.qso AND destination=NEW.destination AND narrative='remote_preserved') THEN RAISE(ABORT,'QRZ template required') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM connections WHERE tenant=NEW.tenant AND id=NEW.destination AND status='active' AND credential_version=NEW.credential_version) THEN RAISE(ABORT,'inactive credential') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE a.tenant=NEW.tenant AND a.source=NEW.source AND a.qso=NEW.qso AND a.destination=NEW.destination AND s.state NOT IN('delivered','observed','rejected','cancelled')) THEN RAISE(ABORT,'unresolved attempt') END;
END;
CREATE TABLE resolution_guards(id TEXT PRIMARY KEY,tenant TEXT,attempt TEXT,token TEXT,fence INTEGER,now INTEGER);
CREATE TRIGGER resolution_guard BEFORE INSERT ON resolution_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM attempt_state s JOIN leases l ON l.tenant=s.tenant AND l.token=s.lease_token AND l.fence=s.fence WHERE s.tenant=NEW.tenant AND s.attempt=NEW.attempt AND s.state='dispatching' AND s.lease_token=NEW.token AND s.fence=NEW.fence AND l.expires_at>NEW.now) THEN RAISE(ABORT,'dispatch lease lost') END;
END;
