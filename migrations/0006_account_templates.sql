CREATE TABLE account_templates (
 tenant TEXT NOT NULL REFERENCES accounts(id), id TEXT NOT NULL,
 config TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(tenant,id)
);
CREATE TRIGGER account_templates_immutable BEFORE UPDATE ON account_templates BEGIN SELECT RAISE(ABORT,'immutable account template'); END;
CREATE TABLE active_account_templates (
 tenant TEXT PRIMARY KEY REFERENCES accounts(id), version TEXT NOT NULL,
 FOREIGN KEY(tenant,version) REFERENCES account_templates(tenant,id)
);
