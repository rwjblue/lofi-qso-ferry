CREATE TABLE invitations (
 email TEXT PRIMARY KEY,
 invited_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 claimed_at INTEGER
);
ALTER TABLE auth_guards ADD COLUMN invited_email TEXT;
CREATE TRIGGER invitation_transition_guard BEFORE INSERT ON auth_guards WHEN NEW.invited_email IS NOT NULL BEGIN
 SELECT CASE WHEN NEW.purpose!='register' OR NOT EXISTS(SELECT 1 FROM signups WHERE id=NEW.signup AND email=NEW.invited_email AND purpose='signup' AND tenant IS NULL) THEN RAISE(ABORT,'invitation proof mismatch') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM invitations WHERE email=NEW.invited_email AND claimed_at IS NULL AND expires_at>NEW.now) THEN RAISE(ABORT,'invitation unavailable') END;
 UPDATE invitations SET claimed_at=NEW.now WHERE email=NEW.invited_email;
END;
CREATE INDEX invitation_expiry ON invitations(expires_at);
