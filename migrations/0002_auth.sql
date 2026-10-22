ALTER TABLE signups ADD COLUMN user_handle TEXT;
ALTER TABLE ceremonies ADD COLUMN signup_id TEXT REFERENCES signups(id);
CREATE TABLE local_mailbox (id TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, envelope TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE auth_guards (
 id TEXT PRIMARY KEY, ceremony TEXT, browser_hash TEXT NOT NULL, purpose TEXT NOT NULL,
 tenant TEXT, now INTEGER NOT NULL, session_hash TEXT, credential TEXT, expected_counter INTEGER, signup TEXT
);
CREATE TRIGGER auth_transition_guard BEFORE INSERT ON auth_guards BEGIN
 SELECT CASE WHEN NEW.ceremony IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ceremonies WHERE id=NEW.ceremony AND browser_hash=NEW.browser_hash AND purpose=NEW.purpose AND tenant IS NEW.tenant AND consumed_at IS NULL AND expires_at>NEW.now) THEN RAISE(ABORT,'ceremony unavailable') END;
 SELECT CASE WHEN NEW.credential IS NOT NULL AND NOT EXISTS(SELECT 1 FROM passkeys p JOIN accounts a ON a.id=p.tenant WHERE p.id=NEW.credential AND p.tenant=NEW.tenant AND p.counter=NEW.expected_counter AND p.revoked_at IS NULL AND a.status='active') THEN RAISE(ABORT,'credential changed') END;
 SELECT CASE WHEN NEW.session_hash IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sessions s JOIN passkeys p ON p.id=s.credential_id AND p.tenant=s.tenant JOIN accounts a ON a.id=s.tenant WHERE s.token_hash=NEW.session_hash AND s.tenant=NEW.tenant AND s.revoked_at IS NULL AND s.expires_at>NEW.now AND p.revoked_at IS NULL AND a.status='active' AND (NEW.purpose='reauth' OR s.verified_at>NEW.now-300000)) THEN RAISE(ABORT,'fresh authentication required') END;
 SELECT CASE WHEN NEW.signup IS NOT NULL AND NOT EXISTS(SELECT 1 FROM signups WHERE id=NEW.signup AND browser_hash=NEW.browser_hash AND verified_at IS NOT NULL AND consumed_at IS NULL AND expires_at>NEW.now AND (NEW.purpose='register' AND purpose='signup' AND tenant IS NULL OR NEW.purpose='email' AND purpose='email' AND tenant=NEW.tenant)) THEN RAISE(ABORT,'email proof unavailable') END;
 SELECT CASE WHEN NEW.signup IS NOT NULL AND NEW.ceremony IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ceremonies WHERE id=NEW.ceremony AND signup_id=NEW.signup) THEN RAISE(ABORT,'signup ceremony mismatch') END;
 UPDATE ceremonies SET consumed_at=NEW.now,winner=NEW.id WHERE id=NEW.ceremony;
 UPDATE signups SET consumed_at=NEW.now WHERE id=NEW.signup;
END;
CREATE TRIGGER retain_last_passkey BEFORE UPDATE OF revoked_at ON passkeys WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM passkeys WHERE tenant=OLD.tenant AND revoked_at IS NULL)<=1 THEN RAISE(ABORT,'last passkey cannot be revoked') END;
END;
CREATE INDEX signup_expiry ON signups(expires_at);
CREATE INDEX ceremony_expiry ON ceremonies(expires_at);
CREATE INDEX session_expiry ON sessions(expires_at);
