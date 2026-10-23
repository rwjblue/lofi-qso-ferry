-- Compact UUID births survive source-buffer expiry and restoration. No contact data.
CREATE TABLE source_births (
 tenant TEXT NOT NULL, source TEXT NOT NULL, qso TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN('history','forward_new')),
 first_seen_at INTEGER NOT NULL, first_cursor_generation INTEGER NOT NULL,
 first_stream TEXT NOT NULL,
 PRIMARY KEY(tenant,source,qso), FOREIGN KEY(tenant,source) REFERENCES connections(tenant,id)
);
CREATE TRIGGER source_births_immutable BEFORE UPDATE ON source_births BEGIN SELECT RAISE(ABORT,'immutable source birth'); END;
CREATE TABLE source_inventory_epochs (
 tenant TEXT NOT NULL, source TEXT NOT NULL, epoch TEXT NOT NULL, started_at INTEGER NOT NULL,
 first_generation INTEGER NOT NULL, PRIMARY KEY(tenant,source),
 FOREIGN KEY(tenant,source) REFERENCES connections(tenant,id)
);
CREATE TRIGGER source_inventory_epoch AFTER INSERT ON cursors WHEN NEW.stream='sync' BEGIN
 INSERT OR IGNORE INTO source_inventory_epochs(tenant,source,epoch,started_at,first_generation) SELECT NEW.tenant,NEW.connection,lower(hex(randomblob(16))),NEW.updated_at,NEW.generation WHERE EXISTS(SELECT 1 FROM connections WHERE tenant=NEW.tenant AND id=NEW.connection AND kind='lofi');
END;
CREATE TRIGGER source_inventory_epochs_immutable BEFORE UPDATE ON source_inventory_epochs BEGIN SELECT RAISE(ABORT,'immutable inventory epoch'); END;
CREATE TABLE source_cutovers (
 tenant TEXT NOT NULL, source TEXT NOT NULL, destination TEXT NOT NULL,
 epoch TEXT NOT NULL, inventory_epoch TEXT, source_generation INTEGER NOT NULL,
 source_cursor TEXT NOT NULL, evidence_kind TEXT NOT NULL CHECK(evidence_kind IN('initial_inventory','destination_rescan')),
 evidence_generation INTEGER NOT NULL, evidence_cursor TEXT, created_at INTEGER NOT NULL,
 PRIMARY KEY(tenant,source,destination), FOREIGN KEY(tenant,source) REFERENCES connections(tenant,id),
 FOREIGN KEY(tenant,destination) REFERENCES connections(tenant,id)
);
CREATE TRIGGER source_cutovers_immutable BEFORE UPDATE ON source_cutovers BEGIN SELECT RAISE(ABORT,'immutable source cutover'); END;
CREATE INDEX source_birth_phase ON source_births(tenant,source,phase,first_cursor_generation);
