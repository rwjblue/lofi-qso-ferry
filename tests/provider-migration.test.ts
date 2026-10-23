import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

test("provider catalog migration preserves populated connection relationships and guards in D1", async (t) => {
  const { mf, db, store } = await database();
  t.after(() => mf.dispose());
  await applyAdditionalMigrations(db, "0015_admin_workload.sql");
  assert.equal(
    await db
      .prepare("SELECT name FROM sqlite_schema WHERE name='lotw_trust_cache'")
      .first(),
    null,
  );
  await seed(store);
  const inserts = [
    "INSERT INTO cursors VALUES('a','source','sync','{}',3,100)",
    "INSERT INTO templates VALUES('a','destination','template','{}',100)",
    "INSERT INTO active_templates VALUES('a','destination','template')",
    "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,baseline_hash,remote_hash,sent_hash,state,narrative,template_version,remote_id,due_at,updated_at,confirmed) VALUES('a','source','q1','destination','generation','hash','baseline','remote','sent','observed','template_bound','template','remote-1',100,100,1)",
    "INSERT INTO attempts(tenant,id,source,qso,destination,generation,payload_id,payload_hash,template_version,credential_version,created_at,source_hash) VALUES('a','attempt','source','q1','destination','generation','payload','bytes','template','v1',100,'hash')",
    "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at,remote_id) VALUES('a','attempt','observed',100,100,'remote-1')",
    "INSERT INTO attempt_events(tenant,attempt,state,at,reason) VALUES('a','attempt','observed',100,'fixture')",
    "INSERT INTO partitions VALUES('a','source','destination','partition','verified','{}',999999)",
    "INSERT INTO source_work(tenant,source,id,kind,private_id,revision,expires_at) VALUES('a','source','q1','qso','qso-payload','generation',999999)",
    "INSERT INTO source_births VALUES('a','source','q1','history',100,1,'sync')",
    "INSERT INTO source_cutovers VALUES('a','source','destination','epoch','inventory',3,'{}','initial_inventory',3,'{}',100)",
    "INSERT INTO vendor_requests VALUES('qrz',100,5,2,900)",
    "INSERT INTO scheduler_runs(id,started_at,status) VALUES('legacy-sample',100,'completed')",
    "INSERT INTO scheduler_runs(id,started_at,status,work_live_ready,work_live_held,work_live_blocked,work_background_ready,work_background_held,work_background_blocked) VALUES('classified-sample',200,'completed',1,2,3,4,5,6)",
  ];
  await db.batch(inserts.map((sql) => db.prepare(sql)));
  const tables = [
    "connections",
    "private_data",
    "cursors",
    "templates",
    "active_templates",
    "ledger",
    "attempts",
    "attempt_state",
    "attempt_events",
    "partitions",
    "source_work",
    "source_births",
    "source_inventory_epochs",
    "source_cutovers",
    "vendor_requests",
    "scheduler_runs",
  ];
  const snapshot = async () =>
    Promise.all(
      tables.map(
        async (table) =>
          (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
            .results,
      ),
    );
  const before = await snapshot();
  const schema = async () =>
    (
      await db
        .prepare(
          "SELECT name,sql FROM sqlite_schema WHERE type IN('trigger','index') AND sql IS NOT NULL ORDER BY name",
        )
        .all()
    ).results;
  const triggers = await schema();
  const migration = await readFile(
    new URL("../migrations/0016_providers.sql", import.meta.url),
    "utf8",
  );
  const statements: D1PreparedStatement[] = [];
  let current = "";
  for (const line of migration.split("\n")) {
    current += `${line}\n`;
    if (line.trimEnd().endsWith(";") && !line.trimStart().startsWith("--")) {
      statements.push(db.prepare(current));
      current = "";
    }
  }
  await db.batch(statements);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(
    (await db.prepare("PRAGMA foreign_key_check").all()).results,
    [],
  );
  assert.deepEqual(await schema(), triggers);
  await db
    .prepare(
      "INSERT INTO connections(tenant,id,kind,remote_identity,label,created_at) VALUES('a','club','clublog','account:fixture','Club Log W1AW',0)",
    )
    .run();
  await db
    .prepare("INSERT INTO vendor_requests VALUES('clublog',100,1,0,0)")
    .run();
  await assert.rejects(
    db
      .prepare(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,created_at) VALUES('a','unknown','unknown','unknown','unknown',0)",
      )
      .run(),
    /FOREIGN KEY/,
  );
  await assert.rejects(
    db
      .prepare("DELETE FROM connections WHERE tenant='a' AND id='destination'")
      .run(),
    /FOREIGN KEY/,
  );
  await assert.rejects(
    db
      .prepare(
        "UPDATE attempts SET payload_hash='changed' WHERE tenant='a' AND id='attempt'",
      )
      .run(),
    /immutable attempt/,
  );
  await assert.rejects(
    db
      .prepare(
        "INSERT INTO connection_kind_guards VALUES('guard','a','clublog','different',NULL)",
      )
      .run(),
    /service already connected/,
  );
});
