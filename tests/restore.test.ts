import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  lockRestoredDatabase,
  RESTORE_LOCK_SQL,
  restoreLockStatements,
} from "../src/restore.ts";
import { database, seed } from "./helpers.ts";

async function restoredFixture() {
  const context = await database();
  // Restore lock targets the complete v1 schema; base helper intentionally isolates foundation tests.
  const schema = ["0002_auth.sql", "0007_invitations.sql"]
    .map((file) =>
      readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"),
    )
    .join("\n");
  let sql = "";
  for (const line of schema.split("\n")) {
    sql += `${line}\n`;
    const trigger = sql.trimStart().startsWith("CREATE TRIGGER");
    if (line.trimEnd().endsWith(";") && (!trigger || line.trim() === "END;")) {
      await context.db.prepare(sql).run();
      sql = "";
    }
  }
  await seed(context.store, "a");
  await seed(context.store, "b");
  const store = context.store;
  const now = Date.now();
  await store
    .statement(
      "INSERT INTO invitations(email,invited_at,expires_at) VALUES('restored-invite@example.test',?,?)",
      now,
      now + 86_400_000,
    )
    .run();
  await store
    .statement("UPDATE accounts SET status='revoked' WHERE id='b'")
    .run();
  await store
    .statement(
      "INSERT INTO passkeys(id,tenant,public_key,counter,metadata,label,created_at) VALUES('active-key','a','fixture',0,'{}','fixture',0),('known-revoked-key','a','fixture',0,'{}','fixture',0)",
    )
    .run();
  await store
    .statement(
      "UPDATE passkeys SET revoked_at=123 WHERE id='known-revoked-key'",
    )
    .run();
  await store
    .statement(
      "INSERT INTO sessions(token_hash,tenant,credential_id,created_at,verified_at,expires_at,revoked_at) VALUES('snapshot-session','a','active-key',0,0,?,NULL),('known-revoked-session','a','known-revoked-key',0,0,?,123)",
      now + 86400000,
      now + 86400000,
    )
    .run();
  await store
    .statement(
      "UPDATE connections SET status='revoked' WHERE tenant='b' AND id='destination'",
    )
    .run();
  await store
    .statement(
      "UPDATE private_data SET revoked_at=123 WHERE tenant='b' AND connection='destination'",
    )
    .run();
  await store.saveTemplate("a", "destination", {
    profile: "ferry-liquid-v1",
    fields: { NOTES: "Pinned old narrative" },
    fallbackNotes: true,
  });
  const template = await store
    .statement(
      "SELECT version FROM active_templates WHERE tenant='a' AND destination='destination'",
    )
    .first<{ version: string }>();
  for (const [index, state] of [
    "prepared",
    "dispatching",
    "submitted",
    "uncertain",
    "delivered",
    "observed",
  ].entries()) {
    const qso = `qso-${index}`;
    await store.observe(
      { tenant: "a", source: "source", qso, destination: "destination" },
      "generation",
      `source-${index}`,
      30,
      false,
      0,
    );
    await store
      .statement(
        "UPDATE ledger SET state=?,remote_id=?,provenance='ferry_created',narrative='template_bound',template_version=? WHERE tenant='a' AND qso=?",
        state === "delivered" || state === "observed"
          ? state
          : "missing_current_identity",
        state === "delivered" || state === "observed"
          ? `remote-${index}`
          : null,
        template!.version,
        qso,
      )
      .run();
    const id = `attempt-${index}`;
    await store
      .statement(
        "INSERT INTO attempts(tenant,id,source,qso,destination,generation,payload_id,payload_hash,template_version,credential_version,created_at,source_hash) VALUES('a',?,'source',?,'destination','generation',?,'immutable-payload',?,'v1',0,?)",
        id,
        qso,
        id,
        template!.version,
        `source-${index}`,
      )
      .run();
    await store
      .statement(
        "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a',?,?,0,0)",
        id,
        state,
      )
      .run();
    await (
      await store.putPrivate("a", "destination", id, "outbox", {
        immutable: id,
      })
    ).run();
  }
  await store
    .statement(
      "INSERT INTO leases(tenant,scope,token,fence,expires_at) VALUES('a','delivery:destination','old-lease',4,?)",
      now + 60000,
    )
    .run();
  await store
    .statement(
      "INSERT INTO cursors VALUES('a','source','context','{\"complete\":true}',1,0)",
    )
    .run();
  const attempts = (
    await store.statement("SELECT * FROM attempts ORDER BY id").all()
  ).results;
  const templates = (
    await store.statement("SELECT * FROM templates ORDER BY id").all()
  ).results;
  return { ...context, attempts, templates };
}

test("exported restore SQL is exactly the runtime quarantine contract", () => {
  assert.equal(
    readFileSync(
      new URL("../ops/lock-restored.sql", import.meta.url),
      "utf8",
    ).trim(),
    RESTORE_LOCK_SQL.trim(),
  );
});
test("restored D1 is locked without reviving revoked access, replaying attempts or changing mappings/templates", async (t) => {
  const { store, db, mf, attempts, templates } = await restoredFixture();
  t.after(() => mf.dispose());
  const result = await lockRestoredDatabase(db);
  assert.equal(result.lockedAccounts, 1);
  assert.equal(result.blockedAttempts, 4);
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) n FROM invitations")
        .first<{ n: number }>()
    )?.n,
    0,
  );
  assert.deepEqual(
    (await store.statement("SELECT id,status FROM accounts ORDER BY id").all())
      .results,
    [
      { id: "a", status: "restore_locked" },
      { id: "b", status: "revoked" },
    ],
  );
  assert.equal(
    (
      await store
        .statement(
          "SELECT revoked_at FROM sessions WHERE token_hash='known-revoked-session'",
        )
        .first<{ revoked_at: number }>()
    )?.revoked_at,
    123,
  );
  assert.ok(
    (await store
      .statement(
        "SELECT revoked_at FROM sessions WHERE token_hash='snapshot-session'",
      )
      .first<{ revoked_at: number }>())!.revoked_at > 0,
  );
  assert.equal(
    (
      await store
        .statement(
          "SELECT revoked_at FROM passkeys WHERE id='known-revoked-key'",
        )
        .first<{ revoked_at: number }>()
    )?.revoked_at,
    123,
  );
  assert.equal((await store.connection("b", "destination"))?.status, "revoked");
  assert.equal(
    (await store.connection("a", "destination"))?.status,
    "disabled",
  );
  assert.equal(
    await store.private("a", "destination", "v1", "credential"),
    null,
  );
  assert.equal(
    (
      await store
        .statement(
          "SELECT revoked_at FROM private_data WHERE tenant='b' AND connection='destination'",
        )
        .first<{ revoked_at: number }>()
    )?.revoked_at,
    123,
  );
  const states = (
    await store
      .statement("SELECT state FROM attempt_state ORDER BY attempt")
      .all<{ state: string }>()
  ).results.map((row) => row.state);
  assert.deepEqual(states, [
    "reconciliation_required",
    "reconciliation_required",
    "reconciliation_required",
    "reconciliation_required",
    "delivered",
    "observed",
  ]);
  assert.deepEqual(
    (await store.statement("SELECT * FROM attempts ORDER BY id").all()).results,
    attempts,
  );
  assert.deepEqual(
    (await store.statement("SELECT * FROM templates ORDER BY id").all())
      .results,
    templates,
  );
  const mapped = await store
    .statement(
      "SELECT remote_id,provenance,narrative,template_version FROM ledger WHERE tenant='a' AND qso='qso-4'",
    )
    .first<{
      remote_id: string;
      provenance: string;
      narrative: string;
      template_version: string;
    }>();
  assert.equal(mapped?.remote_id, "remote-4");
  assert.equal(mapped?.provenance, "ferry_created");
  assert.equal(mapped?.narrative, "template_bound");
  assert.ok(mapped?.template_version);
  const lease = await store.claim("a", "delivery:destination");
  assert.ok(lease);
  assert.equal(
    await store.claimAttempt("a", "attempt-0", lease!),
    false,
    "even a fresh lease cannot replay restored work",
  );
  assert.equal(
    (
      await store
        .statement(
          "SELECT cursor FROM cursors WHERE tenant='a' AND stream='context'",
        )
        .first<{ cursor: string }>()
    )?.cursor,
    '{"complete":0}',
  );
  assert.deepEqual(
    await store.private("a", "destination", "attempt-2", "outbox"),
    { immutable: "attempt-2" },
  );
  const again = await lockRestoredDatabase(db);
  assert.equal(again.blockedAttempts, 0);
  assert.equal(
    (
      await store
        .statement("SELECT count(*) n FROM attempt_events")
        .first<{ n: number }>()
    )?.n,
    4,
  );
});
test("operator SQL locks the same real D1 state as the runtime helper", async (t) => {
  const { store, db, mf } = await restoredFixture();
  t.after(() => mf.dispose());
  const exported = readFileSync(
    new URL("../ops/lock-restored.sql", import.meta.url),
    "utf8",
  )
    .trim()
    .split(/;\s*/)
    .filter(Boolean);
  assert.deepEqual(exported, restoreLockStatements());
  await db.batch(exported.map((sql) => db.prepare(sql)));
  assert.equal(
    (
      await store
        .statement("SELECT count(*) n FROM connections WHERE status='active'")
        .first<{ n: number }>()
    )?.n,
    0,
  );
  assert.equal(
    (
      await store
        .statement("SELECT count(*) n FROM accounts WHERE status='active'")
        .first<{ n: number }>()
    )?.n,
    0,
  );
  assert.equal(
    (
      await store
        .statement(
          "SELECT count(*) n FROM attempt_state WHERE state IN('prepared','dispatching','submitted','uncertain')",
        )
        .first<{ n: number }>()
    )?.n,
    0,
  );
});
