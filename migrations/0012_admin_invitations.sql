ALTER TABLE invitations ADD COLUMN revoked_at INTEGER;
ALTER TABLE invitations ADD COLUMN last_sent_at INTEGER;
ALTER TABLE invitations ADD COLUMN mail_status TEXT NOT NULL DEFAULT 'unknown' CHECK(mail_status IN ('unknown','sending','accepted','uncertain'));
ALTER TABLE invitations ADD COLUMN send_id TEXT;
ALTER TABLE invitations ADD COLUMN action_id TEXT;
CREATE INDEX invitation_recent ON invitations(invited_at DESC,email);
CREATE TABLE admin_audit (
 id TEXT PRIMARY KEY,
 actor TEXT NOT NULL,
 actor_email TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('invite','revoke')),
 email TEXT NOT NULL,
 at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('sending','accepted','uncertain','revoked'))
);
CREATE INDEX admin_audit_recent ON admin_audit(at DESC,id);
