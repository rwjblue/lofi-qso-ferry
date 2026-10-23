CREATE TABLE scheduler_background_accounts (
  tenant TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  eligible INTEGER NOT NULL DEFAULT 0 CHECK(eligible IN (0,1)),
  last_turn INTEGER NOT NULL DEFAULT 0 CHECK(last_turn>=0)
);
CREATE INDEX scheduler_background_accounts_due ON scheduler_background_accounts(eligible,last_turn,tenant);
CREATE TABLE scheduler_background_sources (
  tenant TEXT NOT NULL,
  source TEXT NOT NULL,
  eligible INTEGER NOT NULL DEFAULT 0 CHECK(eligible IN (0,1)),
  last_turn INTEGER NOT NULL DEFAULT 0 CHECK(last_turn>=0),
  PRIMARY KEY(tenant,source),
  FOREIGN KEY(tenant,source) REFERENCES connections(tenant,id) ON DELETE CASCADE
);
CREATE INDEX scheduler_background_sources_due ON scheduler_background_sources(tenant,eligible,last_turn,source);
CREATE TABLE scheduler_background_clock (
  id INTEGER PRIMARY KEY CHECK(id=1),
  turn INTEGER NOT NULL DEFAULT 0 CHECK(turn>=0),
  admission TEXT NOT NULL DEFAULT ''
);
INSERT INTO scheduler_background_clock(id) VALUES(1);
INSERT INTO scheduler_background_sources(tenant,source,eligible) SELECT c.tenant,c.id,CASE WHEN c.status='active' AND a.status='active' THEN 1 ELSE 0 END FROM connections c JOIN accounts a ON a.id=c.tenant WHERE c.kind='lofi';
INSERT INTO scheduler_background_accounts(tenant,eligible) SELECT tenant,MAX(eligible) FROM scheduler_background_sources GROUP BY tenant;
CREATE TRIGGER scheduler_background_connection_insert AFTER INSERT ON connections WHEN NEW.kind='lofi'
BEGIN
  INSERT INTO scheduler_background_sources(tenant,source,eligible) VALUES(NEW.tenant,NEW.id,CASE WHEN NEW.status='active' AND EXISTS(SELECT 1 FROM accounts WHERE id=NEW.tenant AND status='active') THEN 1 ELSE 0 END);
  INSERT INTO scheduler_background_accounts(tenant,eligible) VALUES(NEW.tenant,EXISTS(SELECT 1 FROM scheduler_background_sources WHERE tenant=NEW.tenant AND eligible=1)) ON CONFLICT(tenant) DO UPDATE SET eligible=excluded.eligible;
END;
CREATE TRIGGER scheduler_background_connection_update AFTER UPDATE OF status,kind ON connections
BEGIN
  INSERT INTO scheduler_background_sources(tenant,source,eligible) SELECT NEW.tenant,NEW.id,CASE WHEN NEW.status='active' AND EXISTS(SELECT 1 FROM accounts WHERE id=NEW.tenant AND status='active') THEN 1 ELSE 0 END WHERE NEW.kind='lofi' ON CONFLICT(tenant,source) DO UPDATE SET eligible=excluded.eligible;
  UPDATE scheduler_background_sources SET eligible=0 WHERE tenant=NEW.tenant AND source=NEW.id AND NEW.kind!='lofi';
  INSERT INTO scheduler_background_accounts(tenant,eligible) SELECT NEW.tenant,EXISTS(SELECT 1 FROM scheduler_background_sources WHERE tenant=NEW.tenant AND eligible=1) WHERE EXISTS(SELECT 1 FROM scheduler_background_sources WHERE tenant=NEW.tenant) ON CONFLICT(tenant) DO UPDATE SET eligible=excluded.eligible;
END;
CREATE TRIGGER scheduler_background_connection_delete AFTER DELETE ON connections
BEGIN
  UPDATE scheduler_background_accounts SET eligible=EXISTS(SELECT 1 FROM scheduler_background_sources WHERE tenant=OLD.tenant AND eligible=1) WHERE tenant=OLD.tenant;
END;
CREATE TRIGGER scheduler_background_account_update AFTER UPDATE OF status ON accounts
BEGIN
  UPDATE scheduler_background_sources SET eligible=CASE WHEN NEW.status='active' AND EXISTS(SELECT 1 FROM connections c WHERE c.tenant=NEW.id AND c.id=source AND c.kind='lofi' AND c.status='active') THEN 1 ELSE 0 END WHERE tenant=NEW.id;
  UPDATE scheduler_background_accounts SET eligible=EXISTS(SELECT 1 FROM scheduler_background_sources WHERE tenant=NEW.id AND eligible=1) WHERE tenant=NEW.id;
END;
