import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { destinationIdentityClaim } from "../src/identity-claims.ts";
import { canonical } from "../src/security.ts";
import {
  attemptSourceExportProofCurrent,
  loadCurrentSourceExportProofs,
  loadCurrentSourcePresenceScope,
  mintSourceExportProofs,
  purgeExpiredSourceExportProofs,
  type SourceExportAuthorization,
  sourceExportProofGuard,
} from "../src/source-export-proofs.ts";
import { applyMigration, database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";
import { mintFixtureSourceProofs } from "./source-proof-fixtures.ts";

async function fixture(t: TestContext, observedAt?: number) {
  const h = await database();
  t.after(() => h.mf.dispose());
  await applyAdditionalMigrations(h.db);
  const key = await seed(h.store);
  await h.store
    .statement(
      "UPDATE connections SET config=?,credential_version='source-v2' WHERE tenant='a' AND id='source'",
      JSON.stringify({ accountId: "source" }),
    )
    .run();
  await (
    await h.store.putPrivate("a", "source", "source-v2", "credential", {
      key: "browser:fixture",
      secret: "fixture",
      token: "fixture",
    })
  ).run();
  const source = (await h.store.connection("a", "source"))!;
  const destination = (await h.store.connection("a", "destination"))!;
  const input = {
    source,
    destinations: [destination],
    operations: [
      { uuid: "op", syncedAtMillis: 100, stationCall: "W1AW", grid: "FN31AA" },
    ],
    qsos: [
      {
        uuid: "q1",
        operation: "op",
        syncedAtMillis: 101,
        startAtMillis: 1_792_670_401_000,
        band: "20m",
        mode: "FT8",
        freq: 14074,
        their: { call: "K1ABC" },
      },
    ],
    events: [
      {
        uuid: "event",
        operation: "op",
        syncedAtMillis: 102,
        band: "event",
        event: { event: "note", text: "not effective" },
      },
    ],
  };
  const evidence = await mintFixtureSourceProofs(h.store, {
    ...input,
    observedAt,
  });
  const [snapshot] = evidence.snapshots;
  const template = await h.store.saveTemplate("a", "destination", {});
  await h.store
    .statement(
      "UPDATE ledger SET state='missing_current_identity',due_at=0 WHERE tenant='a' AND source='source' AND qso='q1'",
    )
    .run();
  const record = {
    STATION_CALLSIGN: snapshot.contact.stationCall,
    CALL: snapshot.contact.call,
    QSO_DATE: "20261022",
    TIME_ON: "120001",
    BAND: snapshot.contact.band,
    MODE: snapshot.contact.mode,
  };
  const claim = await destinationIdentityClaim("qrz", record);
  const stage = (
    proof: SourceExportAuthorization | undefined = evidence.authorizations[0],
    identity = true,
  ) =>
    h.store.stage(
      key,
      snapshot.contact.generation,
      { record },
      "v1",
      template,
      Date.now(),
      undefined,
      undefined,
      undefined,
      identity
        ? { claim, sourceVersion: snapshot.contact.reconciliationVersion }
        : undefined,
      proof,
    );
  return { ...h, key, input, evidence, stage, claim };
}

test("current source proofs are pinned atomically and shared current views fit D1 depth", async (t) => {
  const h = await fixture(t);
  const scope = await loadCurrentSourcePresenceScope(h.store, h.input.source);
  assert.deepEqual(scope, h.evidence.scope);
  const [proof] = h.evidence.proofs;
  assert.deepEqual(
    await loadCurrentSourceExportProofs(h.store, scope!, [
      {
        qso: proof.qso,
        generation: proof.generation,
        reconciliationVersion: proof.reconciliationVersion,
      },
    ]),
    [proof],
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM source_export_proof_retention")
      .first("count(*)"),
    1,
  );
  const id = await h.stage();
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM source_export_proof_retention")
      .first("count(*)"),
    0,
    "pin creation removes its retention candidate in the same transaction",
  );
  assert.equal(await attemptSourceExportProofCurrent(h.store, "a", id), true);
  assert.deepEqual(
    await h.store
      .statement(
        "SELECT * FROM attempt_source_export_proofs WHERE tenant='a' AND attempt=?",
        id,
      )
      .first(),
    {
      tenant: "a",
      attempt: id,
      proof_id: proof.id,
      authorization_mode: "source_boundary",
    },
  );
  for (const sql of [
    "UPDATE attempt_source_export_proofs SET proof_id=proof_id",
    "DELETE FROM attempt_source_export_proofs",
  ])
    await assert.rejects(h.store.statement(sql).run(), /immutable/);
  await assert.rejects(
    h.store
      .statement(
        "INSERT OR REPLACE INTO attempt_source_export_proofs(tenant,attempt,proof_id) VALUES('a',?,?)",
        id,
        proof.id,
      )
      .run(),
    /source export proof unavailable/,
  );
  const lease = (await h.store.claim(
    "a",
    "delivery:destination",
    Date.now(),
    120000,
  ))!;
  assert.ok(lease);
  assert.equal(await h.store.claimAttempt("a", id, lease, Date.now()), true);
  assert.equal(await attemptSourceExportProofCurrent(h.store, "a", id), true);
  await purgeExpiredSourceExportProofs(h.store, proof.expiresAt);
  assert.ok(
    await h.store
      .statement(
        "SELECT id FROM source_export_proofs WHERE tenant='a' AND id=?",
        proof.id,
      )
      .first(),
    "pinned evidence survives cleanup for audit",
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM stage_guards")
      .first("count(*)"),
    0,
  );
});

test("missing proof, null context, wrong scope and old direct inserts cannot stage", async (t) => {
  const h = await fixture(t);
  const p = h.evidence.authorizations[0];
  for (const proof of [
    undefined,
    { ...p, proofId: "missing" },
    { ...p, scope: { ...p.scope, policyEpoch: "other" } },
    { ...p, reconciliationVersion: p.reconciliationVersion + 1 },
  ]) {
    // Explicitly call stage without a proof rather than the fixture default.
    await assert.rejects(
      h.store.stage(
        h.key,
        h.evidence.snapshots[0].contact.generation,
        {},
        "v1",
        null,
        Date.now(),
        undefined,
        undefined,
        undefined,
        undefined,
        proof,
      ),
      /source export proof unavailable/,
    );
  }
  await h.store
    .statement("UPDATE ledger SET context_generation=NULL WHERE tenant='a'")
    .run();
  await assert.rejects(h.stage(), /source export proof unavailable/);
  await assert.rejects(
    h.store
      .statement(
        "INSERT INTO attempts SELECT tenant,'unbound',source,qso,destination,generation,'payload','hash',NULL,'v1',0,source_hash FROM ledger WHERE tenant='a'",
      )
      .run(),
    /source export proof unavailable/,
  );
  assert.equal(
    await h.store.statement("SELECT count(*) FROM attempts").first("count(*)"),
    0,
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM private_data WHERE kind='outbox'")
      .first("count(*)"),
    0,
  );
});

test("a later drain invalidates the identical pinned proof before dispatch without rebinding", async (t) => {
  const h = await fixture(t);
  const id = await h.stage();
  const newer = await mintFixtureSourceProofs(h.store, h.input);
  assert.notEqual(newer.proofs[0].id, h.evidence.proofs[0].id);
  assert.equal(await attemptSourceExportProofCurrent(h.store, "a", id), false);
  const lease = (await h.store.claim(
    "a",
    "delivery:destination",
    Date.now(),
    120000,
  ))!;
  await assert.rejects(
    h.store.claimAttempt("a", id, lease, Date.now()),
    /source export proof unavailable/,
  );
  await assert.rejects(
    h.store
      .statement(
        "UPDATE attempt_source_export_proofs SET proof_id=? WHERE tenant='a' AND attempt=?",
        newer.proofs[0].id,
        id,
      )
      .run(),
    /immutable/,
  );
  assert.equal(
    await h.store
      .statement(
        "SELECT state FROM attempt_state WHERE tenant='a' AND attempt=?",
        id,
      )
      .first("state"),
    "prepared",
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM destination_identity_claims")
      .first("count(*)"),
    1,
  );
});

test("a pre-migration prepared attempt cannot dispatch or acquire a replacement pin", async (t) => {
  const h = await database();
  t.after(() => h.mf.dispose());
  for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter(
      (name) =>
        name.endsWith(".sql") &&
        name !== "0001_foundation.sql" &&
        name < "0030",
    )
    .sort())
    await applyMigration(h.db, name);
  const key = await seed(h.store);
  const template = await h.store.saveTemplate("a", "destination", {});
  await h.store.observe(key, "legacy", "hash", 20, false, Date.now() - 60000);
  await h.store
    .statement("UPDATE ledger SET state='missing_current_identity',due_at=0")
    .run();
  const id = await h.store.stage(key, "legacy", {}, "v1", template);
  const retained = {
    id: "foundation-proof",
    scope: { tenant: "a", source: "source" },
    qso: "q1",
    createdAt: 1,
    expiresAt: 2,
  };
  await h.store
    .statement(
      "INSERT INTO source_export_proofs(tenant,id,source,qso,created_at,expires_at,proof) VALUES('a','foundation-proof','source','q1',1,2,?)",
      canonical(retained),
    )
    .run();
  await applyMigration(h.db, "0030_source_export_guards.sql");
  assert.deepEqual(
    await h.store
      .statement("SELECT * FROM source_export_proof_retention")
      .all()
      .then((result) => result.results),
    [{ tenant: "a", id: "foundation-proof", expires_at: 2 }],
    "migration indexes existing unpinned foundation evidence",
  );
  assert.equal(await attemptSourceExportProofCurrent(h.store, "a", id), false);
  const lease = (await h.store.claim(
    "a",
    "delivery:destination",
    Date.now(),
    120000,
  ))!;
  await assert.rejects(
    h.store.claimAttempt("a", id, lease, Date.now()),
    /source export proof unavailable/,
  );
  await assert.rejects(
    h.store
      .statement(
        "UPDATE attempt_state SET state='dispatching' WHERE tenant='a' AND attempt=?",
        id,
      )
      .run(),
    /source export proof unavailable/,
  );
  await h.store
    .statement("DELETE FROM attempt_state WHERE tenant='a' AND attempt=?", id)
    .run();
  await assert.rejects(
    h.store
      .statement(
        "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a',?,'dispatching',0,0)",
        id,
      )
      .run(),
    /source export proof unavailable/,
  );
  await assert.rejects(
    h.store
      .statement(
        "INSERT INTO attempt_source_export_proofs(tenant,attempt,proof_id) VALUES('a',?,'invented')",
        id,
      )
      .run(),
    /source export proof unavailable/,
  );
  // Readback states remain representable; the migration grants no new write.
  await h.store
    .statement(
      "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a',?,'uncertain',0,0)",
      id,
    )
    .run();
  assert.ok(
    await h.store
      .statement("SELECT id FROM attempts WHERE tenant='a' AND id=?", id)
      .first(),
  );
});

test("no policy and null context never recover legacy source authority", async (t) => {
  const h = await fixture(t);
  await h.store
    .statement(
      "DELETE FROM source_read_policies WHERE tenant='a' AND source='source'",
    )
    .run();
  await h.store
    .statement("UPDATE ledger SET context_generation=NULL WHERE tenant='a'")
    .run();
  assert.equal(
    await loadCurrentSourcePresenceScope(h.store, h.input.source),
    null,
  );
  await assert.rejects(
    h.stage(undefined, false),
    /source export proof unavailable/,
  );
});

test("actual database time rejects future and expired evidence regardless of caller time", async (t) => {
  const h = await fixture(t, Date.now() - 240000);
  const original = h.evidence.proofs[0];
  assert.ok(
    original.expiresAt < Date.now() + 60000,
    "expiry derives from original positive, not mint time",
  );
  const id = await h.stage();
  assert.equal(
    await attemptSourceExportProofCurrent(h.store, "a", id, original.expiresAt),
    false,
  );
  for (const [name, change] of [
    ["future", { createdAt: Date.now() + 5_000 }],
    ["expired", { expiresAt: Date.now() + 500 }],
  ] as const) {
    const proof = { ...original, ...change, id: name };
    await h.store
      .statement(
        "INSERT INTO source_export_proofs(tenant,id,source,qso,created_at,expires_at,proof) VALUES(?,?,?,?,?,?,?)",
        proof.scope.tenant,
        proof.id,
        proof.scope.source,
        proof.qso,
        proof.createdAt,
        proof.expiresAt,
        canonical(proof),
      )
      .run();
    if (name === "expired")
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, proof.expiresAt - Date.now()) + 10),
      );
    const guard = sourceExportProofGuard(
      proof.scope,
      proof.id,
      {
        qso: proof.qso,
        generation: proof.generation,
        reconciliationVersion: proof.reconciliationVersion,
      },
      proof.createdAt,
    );
    assert.equal(
      await h.store
        .statement(`SELECT ${guard.sql} AS current`, ...guard.bindings)
        .first("current"),
      0,
      name,
    );
  }
  const snapshot = h.evidence.snapshots[0];
  const lease = (await h.store.claim("a", "cycle:source", Date.now(), 90000))!;
  const witnesses = original.dependencies.map((dependency) => ({
    scope: original.scope,
    target: dependency.target,
    requestStartedAt: dependency.requestStartedAt,
  }));
  await assert.rejects(
    mintSourceExportProofs(
      h.store,
      [
        {
          snapshot,
          witnesses,
          collectionFinishedAt: original.collectionFinishedAt,
        },
      ],
      lease,
      Date.now() + 30000,
    ),
    /source_export_proof_admission_deadline/,
  );
});

test("retention indexes only unpinned proofs and a failed stage restores its candidate", async (t) => {
  const h = await fixture(t);
  const original = h.evidence.proofs[0];
  await h.store
    .statement(
      "CREATE TRIGGER fixture_fail_stage_event BEFORE INSERT ON attempt_events WHEN NEW.state='prepared' BEGIN SELECT RAISE(ABORT,'fixture stage event failure'); END",
    )
    .run();
  await assert.rejects(h.stage(), /fixture stage event failure/);
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM attempt_source_export_proofs")
      .first("count(*)"),
    0,
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM source_export_proof_retention")
      .first("count(*)"),
    1,
    "candidate deletion rolls back with the failed attempt",
  );
  await h.store.statement("DROP TRIGGER fixture_fail_stage_event").run();
  await h.stage();
  const lease = (await h.store.claim("a", "cycle:source", Date.now(), 90000))!;
  const request = {
    snapshot: h.evidence.snapshots[0],
    collectionFinishedAt: original.collectionFinishedAt,
    witnesses: original.dependencies.map((d) => ({
      scope: original.scope,
      target: d.target,
      requestStartedAt: d.requestStartedAt,
    })),
  };
  for (let i = 0; i < 3; i++)
    await mintSourceExportProofs(h.store, [request], lease);
  const plan = await h.store
    .statement(
      "EXPLAIN QUERY PLAN SELECT tenant,id FROM source_export_proof_retention WHERE expires_at<=? ORDER BY expires_at,tenant,id LIMIT ?",
      original.expiresAt + 10000,
      2,
    )
    .all<{ detail: string }>();
  assert.ok(
    plan.results.some((row) =>
      row.detail.includes(
        "SEARCH source_export_proof_retention USING COVERING INDEX source_export_proof_retention_expiry (expires_at<?)",
      ),
    ),
  );
  assert.ok(
    plan.results.every(
      (row) => !row.detail.includes("attempt_source_export_proofs"),
    ),
    "cleanup does not scan pinned history to find candidates",
  );
  await purgeExpiredSourceExportProofs(h.store, original.expiresAt + 10000, 2);
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM source_export_proof_retention")
      .first("count(*)"),
    1,
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM source_export_proofs")
      .first("count(*)"),
    2,
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM attempt_source_export_proofs")
      .first("count(*)"),
    1,
  );
});
