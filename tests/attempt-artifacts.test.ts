import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  type DeliveryGates,
  dispatchAttempt,
  type PreparedPayload,
  prepareDue,
} from "../src/delivery.ts";
import { rotatePrivateData } from "../src/maintenance.ts";
import { lockRestoredDatabase, RESTORE_LOCK_SQL } from "../src/restore.ts";
import {
  canonical,
  type Envelope,
  type Keyring,
  open,
  sha256,
} from "../src/security.ts";
import { Store } from "../src/store.ts";
import { applyMigration, database, keys, seed } from "./helpers.ts";
import { schedulerFixture } from "./runtime-fixtures.ts";
import { mintFixtureSourceProofs } from "./source-proof-fixtures.ts";

const migration = "0038_attempt_artifacts.sql";
const week = 7 * 86_400_000;
const gates: DeliveryGates = {
  exportsEnabled: true,
  liveWriteAuthorized: true,
  sourceBoundaryVerified: false,
  qrzFreshInsertsEnabled: true,
  allowedQsoIds: ["q1"],
  allowedDestinationIds: ["destination"],
};
interface Artifact {
  tenant: string;
  attempt: string;
  connection: string;
  id: string;
  kind: string;
  envelope: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  source_proof_version: string;
}
function decrypt(row: Artifact, keyring: Keyring = keys) {
  return open<PreparedPayload>(
    JSON.parse(row.envelope) as Envelope,
    {
      tenant: row.tenant,
      connection: row.connection,
      id: row.id,
      kind: row.kind,
      purpose: "storage",
    },
    keyring,
  );
}
async function fixture(t: TestContext) {
  const h = await schedulerFixture();
  t.after(() => h.mf.dispose());
  h.qrzRecords.length = 0;
  h.operation.grid = "FN31AA12";
  const source = (await h.store.connection("a", "source"))!;
  const proof = await mintFixtureSourceProofs(h.store, {
    source,
    qsos: [h.qso],
    operations: [h.operation],
    destinations: (await h.store.connections("a")).filter(
      (c) => c.kind !== "lofi",
    ),
  });
  await h.store
    .statement(
      "UPDATE ledger SET state='missing_current_identity',due_at=0 WHERE tenant='a' AND source='source' AND qso='q1'",
    )
    .run();
  const key = {
    tenant: "a",
    source: "source",
    qso: "q1",
    destination: "destination",
  };
  const prepare = () =>
    prepareDue(h.store, key, proof.snapshots[0]!.contact, gates, {
      fetcher: h.fetcher,
      sourceProof: proof.authorizations[0]!,
    });
  const artifact = (id: string) =>
    h.store
      .statement(
        "SELECT * FROM attempt_artifacts WHERE tenant='a' AND attempt=?",
        id,
      )
      .first<Artifact>();
  const count = (table: string) =>
    h.store.statement(`SELECT count(*) n FROM ${table}`).first<number>("n");
  return { ...h, key, prepare, artifact, count };
}

test("normal QRZ staging retains exact encrypted bytes through an acknowledged INSERT and outbox purge", async (t) => {
  const h = await fixture(t);
  const prepared = await h.prepare();
  assert.equal(prepared.state, "prepared");
  const id = prepared.attemptId!;
  const artifact = (await h.artifact(id))!;
  assert(artifact);
  const { attempt, ...original } = artifact;
  assert.equal(attempt, id);
  assert.deepEqual(
    original,
    await h.store
      .statement(
        "SELECT * FROM private_data WHERE tenant='a' AND connection='destination' AND id=? AND kind='outbox'",
        id,
      )
      .first(),
  );
  const immutable = await h.store
    .statement("SELECT * FROM attempts WHERE tenant='a' AND id=?", id)
    .first<{ created_at: number; payload_hash: string }>();
  assert(immutable);
  assert.equal(artifact.expires_at, immutable.created_at + week);
  const payload = await decrypt(artifact);
  assert.equal(payload.kind, "qrz");
  if (payload.kind !== "qrz") throw new Error("expected QRZ");
  assert.equal(await sha256(canonical(payload.record)), immutable.payload_hash);
  assert.equal(payload.record.MY_GRIDSQUARE, "FN31AA12");
  assert.equal(
    (await dispatchAttempt(h.store, "a", id, gates, { fetcher: h.fetcher }))
      .state,
    "delivered",
  );
  assert.equal(h.calls.qrzWrites, 1);
  assert.equal(await h.store.private("a", "destination", id, "outbox"), null);
  assert.deepEqual(await h.artifact(id), artifact);
  assert.deepEqual(await decrypt((await h.artifact(id))!), payload);
  assert.deepEqual(
    await h.store
      .statement("SELECT * FROM attempts WHERE tenant='a' AND id=?", id)
      .first(),
    immutable,
  );
});

test("a known rejection purges the active outbox but keeps its original recovery artifact", async (t) => {
  const h = await fixture(t);
  const prepared = await h.prepare();
  const id = prepared.attemptId!;
  const artifact = await h.artifact(id);
  h.qrzRecords.push({ ...h.initial, APP_QRZLOG_LOGID: "501" });
  assert.equal(
    (await dispatchAttempt(h.store, "a", id, gates, { fetcher: h.fetcher }))
      .state,
    "rejected",
  );
  assert.equal(h.calls.qrzWrites, 0);
  assert.equal(await h.store.private("a", "destination", id, "outbox"), null);
  assert.deepEqual(await h.artifact(id), artifact);
});

test("lost INSERT acknowledgement retains both bodies and never grants another dispatch", async (t) => {
  const h = await fixture(t);
  const prepared = await h.prepare();
  const id = prepared.attemptId!;
  const artifact = await h.artifact(id);
  const fetcher: typeof fetch = async (input, init) => {
    const response = await h.fetcher(input, init);
    if (
      init?.body instanceof URLSearchParams &&
      init.body.get("ACTION") === "INSERT"
    )
      throw new Error("synthetic lost acknowledgement");
    return response;
  };
  assert.equal(
    (await dispatchAttempt(h.store, "a", id, gates, { fetcher })).state,
    "uncertain",
  );
  await dispatchAttempt(h.store, "a", id, gates, { fetcher });
  assert.equal(h.calls.qrzWrites, 1);
  assert(await h.store.private("a", "destination", id, "outbox"));
  assert.deepEqual(await h.artifact(id), artifact);
});

for (const failure of ["capture", "later staging statement"] as const) {
  test(`${failure} failure rolls back the native stage, artifact, outbox and proof pin`, async (t) => {
    const h = await fixture(t);
    const target =
      failure === "capture" ? "attempt_artifacts" : "attempt_events";
    await h.store
      .statement(
        `CREATE TRIGGER fixture_abort BEFORE INSERT ON ${target} BEGIN SELECT RAISE(ABORT,'synthetic stage abort'); END;`,
      )
      .run();
    await assert.rejects(h.prepare(), /synthetic stage abort/);
    for (const table of [
      "attempts",
      "attempt_state",
      "attempt_artifacts",
      "attempt_source_export_proofs",
      "stage_guards",
    ])
      assert.equal(await h.count(table), 0, table);
    assert.equal(
      await h.store
        .statement("SELECT count(*) n FROM private_data WHERE kind='outbox'")
        .first<number>("n"),
      0,
    );
    assert.equal(h.calls.qrzWrites, 0);
  });
}

test("copied envelope is immutable and cannot be rebound to another tenant, attempt or AAD", async (t) => {
  const h = await fixture(t);
  const id = (await h.prepare()).attemptId!;
  const artifact = (await h.artifact(id))!;
  await assert.rejects(
    h.store
      .statement("UPDATE attempt_artifacts SET expires_at=expires_at+1")
      .run(),
    /immutable attempt artifact/,
  );
  await assert.rejects(
    h.store.statement("UPDATE attempt_artifacts SET envelope='{}'").run(),
    /immutable attempt artifact/,
  );
  for (const [tenant, attempt, connection] of [
    ["other", id, "destination"],
    ["a", "different", "destination"],
    ["a", id, "source"],
  ])
    await assert.rejects(
      h.store
        .statement(
          "INSERT INTO attempt_artifacts SELECT ?,?, ?,id,kind,envelope,created_at,expires_at,revoked_at,source_proof_version FROM attempt_artifacts WHERE tenant='a' AND attempt=?",
          tenant!,
          attempt!,
          connection!,
          id,
        )
        .run(),
      /original attempt artifact unavailable/,
    );
  await assert.rejects(decrypt({ ...artifact, connection: "source" }));
  assert.deepEqual(await h.artifact(id), artifact);
});

test("original expiry deletes only the retained bytes while keeping durable attempt and proof facts", async (t) => {
  const h = await fixture(t);
  const id = (await h.prepare()).attemptId!;
  const artifact = (await h.artifact(id))!;
  await dispatchAttempt(h.store, "a", id, gates, { fetcher: h.fetcher });
  await h.store.recover(artifact.expires_at - 1);
  assert.deepEqual(await h.artifact(id), artifact);
  await h.store.recover(artifact.expires_at);
  assert.equal(await h.artifact(id), null);
  assert.equal(await h.count("attempts"), 1);
  assert.equal(await h.count("attempt_source_export_proofs"), 1);
  assert.equal(
    await h.store
      .statement("SELECT state FROM attempt_state WHERE attempt=?", id)
      .first<string>("state"),
    "delivered",
  );
  const plan = await h.store
    .statement(
      "EXPLAIN QUERY PLAN DELETE FROM attempt_artifacts WHERE expires_at<=?",
      artifact.expires_at,
    )
    .all<{ detail: string }>();
  assert(
    plan.results.some((row) => row.detail.includes("attempt_artifacts_expiry")),
  );
});

test("rotation and repeated restore quarantine retain original ciphertext and require its original KEK", async (t) => {
  const h = await fixture(t);
  const id = (await h.prepare()).attemptId!;
  const artifact = (await h.artifact(id))!;
  const payload = await decrypt(artifact);
  const rotated = new Store(h.db, { ...keys, active: "2" });
  await rotatePrivateData(rotated, 50);
  assert.deepEqual(await h.artifact(id), artifact);
  assert.notEqual(
    await h.store
      .statement(
        "SELECT envelope FROM private_data WHERE tenant='a' AND connection='destination' AND id=? AND kind='outbox'",
        id,
      )
      .first<string>("envelope"),
    artifact.envelope,
  );
  await assert.rejects(
    decrypt(artifact, { active: "2", keys: { "2": keys.keys["2"] } }),
  );
  await lockRestoredDatabase(h.db);
  await lockRestoredDatabase(h.db);
  assert.deepEqual(await h.artifact(id), artifact);
  assert.deepEqual(await decrypt(artifact), payload);
  assert.equal(
    await h.store
      .statement("SELECT state FROM attempt_state WHERE attempt=?", id)
      .first<string>("state"),
    "reconciliation_required",
  );
  await dispatchAttempt(h.store, "a", id, gates, { fetcher: h.fetcher });
  assert.equal(h.calls.qrzWrites, 0);
});

test("actual local D1 SQL export restores terminal artifacts without outboxes before reinstalling capture triggers", async (t) => {
  const h = await fixture(t);
  const id = (await h.prepare()).attemptId!;
  const artifact = (await h.artifact(id))!;
  const payload = await decrypt(artifact);
  await dispatchAttempt(h.store, "a", id, gates, { fetcher: h.fetcher });
  assert.equal(await h.store.private("a", "destination", id, "outbox"), null);
  // This is Wrangler's installed local-export operation, not a hand-written
  // schema/data dump. It emits table data before indexes, triggers and views.
  const [statements] = await h.db
    .prepare("PRAGMA miniflare_d1_export(?,?,?);")
    .bind(false, false)
    .raw<string[]>();
  assert(statements);
  const dump = statements.join("\n");
  assert(
    dump.indexOf('INSERT INTO "attempt_artifacts"') <
      dump.indexOf("CREATE TRIGGER attempt_artifact_capture"),
  );
  const restored = new DatabaseSync(":memory:");
  t.after(() => restored.close());
  // Full backup restore uses an isolated empty database and restores schema
  // after data. Never import a data-only dump into active capture triggers.
  restored.exec("PRAGMA foreign_keys=OFF;");
  restored.exec(dump);
  restored.exec("PRAGMA foreign_keys=ON;");
  const read = () =>
    ({
      ...restored
        .prepare(
          "SELECT * FROM attempt_artifacts WHERE tenant='a' AND attempt=?",
        )
        .get(id),
    }) as unknown as Artifact;
  assert.deepEqual(read(), artifact);
  assert.deepEqual(await decrypt(read()), payload);
  restored.exec(RESTORE_LOCK_SQL);
  restored.exec(RESTORE_LOCK_SQL);
  assert.deepEqual(read(), artifact);
  assert.deepEqual(restored.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(restored.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
  assert.throws(
    () => restored.exec("UPDATE attempt_artifacts SET envelope='{}'"),
    /immutable attempt artifact/,
  );
});

test("migration copies only available unexpired legacy outboxes and captures old-worker staging atomically", async (t) => {
  const h = await database();
  t.after(() => h.mf.dispose());
  // Explicitly model legacy staging before mandatory source proofs, then apply
  // the independent artifact schema. No legacy body is invented on upgrade.
  await h.store
    .statement(
      "ALTER TABLE private_data ADD COLUMN source_proof_version TEXT NOT NULL DEFAULT ''",
    )
    .run();
  const key = await seed(h.store);
  const template = await h.store.saveTemplate("a", "destination", {});
  const now = Date.now();
  const stage = async (qso: string, at = now) => {
    const k = { ...key, qso };
    await h.store.observe(k, "g1", "source-hash", 20, false, at - 20 * 60_000);
    await h.store
      .statement(
        "UPDATE ledger SET state='missing_current_identity' WHERE qso=?",
        qso,
      )
      .run();
    return h.store.stage(k, "g1", { original: qso }, "v1", template, at);
  };
  const present = await stage("present");
  await stage("expired", now - week - 1);
  const revoked = await stage("revoked");
  const purged = await stage("purged");
  await h.store
    .statement("UPDATE private_data SET revoked_at=? WHERE id=?", now, revoked)
    .run();
  await h.store.statement("DELETE FROM private_data WHERE id=?", purged).run();
  const before = (
    await h.store.statement("SELECT * FROM attempts ORDER BY id").all()
  ).results;
  await applyMigration(h.db, migration);
  assert.deepEqual(
    (await h.store.statement("SELECT attempt FROM attempt_artifacts").all())
      .results,
    [{ attempt: present }],
  );
  assert.deepEqual(
    (await h.store.statement("SELECT * FROM attempts ORDER BY id").all())
      .results,
    before,
  );
  const added = await stage("old-worker-after-migration");
  assert(
    await h.store
      .statement("SELECT 1 found FROM attempt_artifacts WHERE attempt=?", added)
      .first(),
  );
  // An attempt insert without its original body cannot commit, even for a
  // legacy writer that does not know about the new table.
  await assert.rejects(
    h.store
      .statement(
        "INSERT INTO attempts SELECT tenant,'missing-artifact',source,qso,destination,generation,'missing-body',payload_hash,template_version,credential_version,created_at,source_hash FROM attempts WHERE id=?",
        present,
      )
      .run(),
    /original attempt artifact unavailable/,
  );
  assert.equal(
    await h.store
      .statement("SELECT 1 found FROM attempts WHERE id='missing-artifact'")
      .first(),
    null,
  );
  const cohort = ["cohort-first", "cohort-second"];
  for (const qso of cohort) {
    await h.store.observe(
      { ...key, qso },
      "g1",
      "source-hash",
      20,
      false,
      now - 20 * 60_000,
    );
    await h.store
      .statement(
        "UPDATE ledger SET state='missing_current_identity' WHERE qso=?",
        qso,
      )
      .run();
  }
  const outboxesBefore = await h.store
    .statement("SELECT count(*) n FROM private_data WHERE kind='outbox'")
    .first<number>("n");
  await h.store
    .statement(
      "CREATE TRIGGER fixture_second_capture BEFORE INSERT ON attempt_artifacts WHEN EXISTS(SELECT 1 FROM attempts WHERE tenant=NEW.tenant AND id=NEW.attempt AND qso='cohort-second') BEGIN SELECT RAISE(ABORT,'second capture failed'); END;",
    )
    .run();
  await assert.rejects(
    h.store.stageBatch(
      cohort.map((qso) => ({
        key: { ...key, qso },
        generation: "g1",
        payload: { original: qso },
        credentialVersion: "v1",
        expectedTemplate: template,
        now,
      })),
    ),
    /second capture failed/,
  );
  assert.equal(
    await h.store
      .statement(
        "SELECT count(*) n FROM attempts WHERE qso IN('cohort-first','cohort-second')",
      )
      .first<number>("n"),
    0,
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) n FROM private_data WHERE kind='outbox'")
      .first<number>("n"),
    outboxesBefore,
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) n FROM stage_guards")
      .first<number>("n"),
    0,
  );
  // Explicit erasure of an otherwise unreferenced immutable attempt also erases
  // its retained ciphertext; the new table adds no permanent deletion obstacle.
  await h.store
    .statement("DELETE FROM attempt_events WHERE attempt=?", added)
    .run();
  await h.store
    .statement("DELETE FROM attempt_state WHERE attempt=?", added)
    .run();
  await h.store.statement("DELETE FROM attempts WHERE id=?", added).run();
  assert.equal(
    await h.store
      .statement("SELECT 1 found FROM attempt_artifacts WHERE attempt=?", added)
      .first(),
    null,
  );
});
