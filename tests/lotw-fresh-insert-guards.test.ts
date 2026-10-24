import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { destinationIdentityClaim } from "../src/identity-claims.ts";
import { canonical } from "../src/security.ts";
import {
  attemptSourceExportAuthorizationMode,
  attemptSourceExportProofCurrent,
  lotwFreshInsertCurrent,
  lotwFreshInsertEligibleGuard,
  type SourceExportAuthorization,
} from "../src/source-export-proofs.ts";
import { applyMigration, database, seed } from "./helpers.ts";
import { mintFixtureSourceProofs } from "./source-proof-fixtures.ts";

const migration = "0032_lotw_fresh_insert_authorization.sql";
async function fixture(
  t: TestContext,
  historicalAttempt = false,
  beforeMigration = false,
  extraQrz = false,
) {
  const h = await database();
  t.after(() => h.mf.dispose());
  const names = (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql") && name !== "0001_foundation.sql")
    .sort();
  for (const name of names.filter((name) => name < "0030_"))
    await applyMigration(h.db, name);
  const key = await seed(h.store);
  await h.store
    .statement(
      "UPDATE connections SET kind='lotw' WHERE tenant='a' AND id='destination'",
    )
    .run();
  if (historicalAttempt) {
    await h.store
      .statement(
        "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,due_at,updated_at) VALUES('a','source','q1','destination','old-generation','old-source',0,0)",
      )
      .run();
    await h.store
      .statement(
        "INSERT INTO attempts SELECT tenant,'old',source,qso,destination,generation,'old-payload','old-hash',NULL,'v1',0,source_hash FROM ledger WHERE tenant='a'",
      )
      .run();
    await h.store
      .statement(
        "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a','old','cancelled',0,0)",
      )
      .run();
  }
  for (const name of names.filter((name) => name >= "0030_" && name < "0032_"))
    await applyMigration(h.db, name);
  if (beforeMigration) {
    // Current canonical intake needs the independent comparison index. Keep
    // 0032 and its later ownership triggers out of this upgrade fixture.
    await applyMigration(h.db, "0033_source_historical_index.sql");
  } else {
    for (const name of names.filter((name) => name >= migration))
      await applyMigration(h.db, name);
  }
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
  if (extraQrz) {
    await h.store
      .statement(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at) VALUES('a','qrz-destination','qrz','qrz-book','QRZ','active','v1',0)",
      )
      .run();
    await (
      await h.store.putPrivate("a", "qrz-destination", "v1", "credential", {
        secret: "fixture",
      })
    ).run();
  }
  const source = (await h.store.connection("a", "source"))!;
  const destination = (await h.store.connection("a", "destination"))!;
  const evidence = await mintFixtureSourceProofs(h.store, {
    source,
    destinations: extraQrz
      ? [destination, (await h.store.connection("a", "qrz-destination"))!]
      : [destination],
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
  });
  const [snapshot] = evidence.snapshots;
  const template = null;
  await h.store
    .statement(
      "UPDATE ledger SET state='missing_current_identity',due_at=0 WHERE tenant='a' AND source='source' AND qso='q1'",
    )
    .run();
  const record = {
    STATION_CALLSIGN: "W1AW",
    CALL: "K1ABC",
    QSO_DATE: "20261022",
    TIME_ON: "120001",
    BAND: "20M",
    MODE: "FT8",
  };
  const claim = await destinationIdentityClaim("lotw", record);
  const fresh: SourceExportAuthorization = {
    ...evidence.authorizations[0],
    authorizationMode: "lotw_fresh_insert",
  };
  const stage = (proof = fresh) =>
    h.store.stage(
      key,
      snapshot.contact.generation,
      { kind: "lotw", record },
      "v1",
      template,
      Date.now(),
      undefined,
      undefined,
      undefined,
      { claim, sourceVersion: snapshot.contact.reconciliationVersion },
      proof,
    );
  const insertGuard = (id: string, proof: SourceExportAuthorization = fresh) =>
    h.store.statement(
      "INSERT INTO stage_guards(id,tenant,source,qso,destination,generation,template_version,now,credential_version,source_export_proof_id,source_export_scope,source_export_reconciliation_version,authorization_mode) VALUES(?,'a','source','q1','destination',?,?,?,'v1',?,?,?,?)",
      id,
      snapshot.contact.generation,
      template,
      Date.now(),
      proof.proofId,
      canonical(proof.scope),
      proof.reconciliationVersion,
      proof.authorizationMode ?? "source_boundary",
    );
  const claimAttempt = async (id: string) => {
    const lease = (await h.store.claim(
      "a",
      "delivery:destination",
      Date.now(),
      120000,
    ))!;
    assert.ok(lease);
    return {
      lease,
      claimed: await h.store.claimAttempt("a", id, lease, Date.now(), {
        remoteId: claim.hash,
        identity: record,
      }),
    };
  };
  return {
    ...h,
    key,
    evidence,
    fresh,
    stage,
    insertGuard,
    claimAttempt,
    record,
    claim,
  };
}

test("fresh LoTW pins preserve mode and current proof while excluding only their own attempt", async (t) => {
  const h = await fixture(t);
  assert.equal(await lotwFreshInsertCurrent(h.store, h.key), true);
  const id = await h.stage();
  assert.equal(
    await attemptSourceExportAuthorizationMode(h.store, "a", id),
    "lotw_fresh_insert",
  );
  assert.equal(
    await attemptSourceExportAuthorizationMode(h.store, "other", id),
    null,
  );
  // The 0031 Worker explicitly recognizes these two modes and returns null for
  // any other pin; a newly widened CHECK cannot promote its old dispatch path.
  const oldMode = await h.store
    .statement(
      "SELECT authorization_mode FROM attempt_source_export_proofs WHERE tenant='a' AND attempt=?",
      id,
    )
    .first<string>("authorization_mode");
  assert.equal(
    oldMode === "source_boundary" || oldMode === "qrz_fresh_insert"
      ? oldMode
      : null,
    null,
  );

  assert.equal(
    await lotwFreshInsertCurrent(h.store, h.key),
    false,
    "prepared work is not a new insertion opportunity",
  );
  assert.equal(await lotwFreshInsertCurrent(h.store, h.key, id), true);
  assert.equal(
    await attemptSourceExportProofCurrent(
      h.store,
      "a",
      id,
      Date.now(),
      "lotw_fresh_insert",
    ),
    true,
  );
  assert.equal(
    await attemptSourceExportProofCurrent(
      h.store,
      "a",
      id,
      Date.now(),
      "source_boundary",
    ),
    false,
  );
  assert.equal((await h.claimAttempt(id)).claimed, true);
  assert.equal(
    await attemptSourceExportProofCurrent(h.store, "a", id),
    true,
    "the current dispatch is not counted as its own prior uncertain mutation",
  );
  for (const sql of [
    "UPDATE attempt_source_export_proofs SET authorization_mode='source_boundary'",
    "UPDATE attempt_source_export_proofs SET authorization_mode='lotw_fresh_insert'",
    "DELETE FROM attempt_source_export_proofs",
  ])
    await assert.rejects(h.store.statement(sql).run(), /immutable/);
  assert.equal(
    await attemptSourceExportProofCurrent(
      h.store,
      "a",
      id,
      h.evidence.proofs[0].expiresAt,
    ),
    false,
  );
});

test("migration preserves boundary pins and never creates missing historical pins", async (t) => {
  const h = await fixture(t, true, true);
  const id = await h.stage(h.evidence.authorizations[0]);
  await applyMigration(h.db, migration);
  assert.equal(
    await attemptSourceExportAuthorizationMode(h.store, "a", id),
    "source_boundary",
  );
  assert.equal(
    await attemptSourceExportProofCurrent(
      h.store,
      "a",
      id,
      Date.now(),
      "lotw_fresh_insert",
    ),
    false,
  );
  assert.equal(
    await attemptSourceExportAuthorizationMode(h.store, "a", "old"),
    null,
  );
  assert.equal(
    await attemptSourceExportProofCurrent(h.store, "a", "old"),
    false,
  );
  await assert.rejects(
    h.store
      .statement(
        "UPDATE attempt_source_export_proofs SET authorization_mode='lotw_fresh_insert' WHERE attempt=?",
        id,
      )
      .run(),
    /immutable/,
  );
});

test("fresh structural guards reject mappings, accepted hashes, corrections and non-LoTW destinations", async (t) => {
  const h = await fixture(t);
  for (const [column, value, restored] of [
    ["baseline_hash", "accepted", null],
    ["remote_hash", "remote", null],
    ["sent_hash", "sent", null],
    ["confirmed", 1, 0],
    ["state", "changed", "missing_current_identity"],
    ["narrative", "remote_preserved", "unbound"],
    ["provenance", "adopted", "unknown"],
    ["provenance", "ferry_created", "unknown"],
    ["provenance", "adoption_conflict", "unknown"],
  ] as const) {
    await h.store
      .statement(`UPDATE ledger SET ${column}=? WHERE tenant='a'`, value)
      .run();
    assert.equal(await lotwFreshInsertCurrent(h.store, h.key), false, column);
    await assert.rejects(h.stage(), /LoTW fresh insert unavailable/, column);
    await h.store
      .statement(`UPDATE ledger SET ${column}=? WHERE tenant='a'`, restored)
      .run();
    assert.equal(
      await lotwFreshInsertCurrent(h.store, h.key),
      true,
      `restored ${column}`,
    );
  }
  await h.store
    .statement("UPDATE ledger SET baseline_hash=source_hash WHERE tenant='a'")
    .run();
  assert.equal(
    await lotwFreshInsertCurrent(h.store, h.key),
    true,
    "ordinary read-only classification records the current observational baseline",
  );
  await h.store
    .statement("UPDATE ledger SET baseline_hash=NULL WHERE tenant='a'")
    .run();
  await h.store
    .statement(
      "UPDATE connections SET kind='qrz' WHERE tenant='a' AND id='destination'",
    )
    .run();
  assert.equal(await lotwFreshInsertCurrent(h.store, h.key), false);
  await assert.rejects(h.stage(), /LoTW fresh insert unavailable/);
  await h.store
    .statement(
      "UPDATE connections SET kind='lotw' WHERE tenant='a' AND id='destination'",
    )
    .run();
  await h.store
    .statement("UPDATE ledger SET remote_id=? WHERE tenant='a'", h.claim.hash)
    .run();
  assert.equal(await lotwFreshInsertCurrent(h.store, h.key), false);
  await assert.rejects(h.stage(), /LoTW fresh insert unavailable/);
  assert.equal(
    await h.store.statement("SELECT count(*) FROM attempts").first("count(*)"),
    0,
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM stage_guards")
      .first("count(*)"),
    0,
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) FROM private_data WHERE kind='outbox'")
      .first("count(*)"),
    0,
  );
});

test("prior accepted, uncertain, unknown and missing attempt state remains an exclusion", async (t) => {
  const h = await fixture(t, true);
  for (const state of [
    "prepared",
    "dispatching",
    "uncertain",
    "submitted",
    "observed",
    "delivered",
    "reconciliation_required",
    "unknown",
  ]) {
    // Seed an old state's historical shape without the new dispatch UPDATE path.
    await h.store
      .statement("DELETE FROM attempt_state WHERE tenant='a' AND attempt='old'")
      .run();
    if (state === "prepared" || state === "dispatching") {
      assert.equal(
        await lotwFreshInsertCurrent(h.store, h.key),
        false,
        "missing state",
      );
      await assert.rejects(
        h.store
          .statement(
            "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a','old',?,0,0)",
            state,
          )
          .run(),
        /source export proof unavailable/,
      );
    } else {
      await h.store
        .statement(
          "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a','old',?,0,0)",
          state,
        )
        .run();
      assert.equal(await lotwFreshInsertCurrent(h.store, h.key), false, state);
    }
    await assert.rejects(h.stage(), /LoTW fresh insert unavailable/);
  }
  await h.store
    .statement(
      "UPDATE attempt_state SET state='cancelled' WHERE tenant='a' AND attempt='old'",
    )
    .run();
  assert.equal(await lotwFreshInsertCurrent(h.store, h.key), true);
  await h.store
    .statement(
      "INSERT INTO attempt_events(tenant,attempt,state,at) VALUES('a','old','uncertain',1)",
    )
    .run();
  assert.equal(
    await lotwFreshInsertCurrent(h.store, h.key),
    false,
    "cancelling state cannot erase earlier uncertainty",
  );
  await assert.rejects(h.stage(), /LoTW fresh insert unavailable/);
});

test("only explicit known-unsent history permits another fresh insert", async (t) => {
  const h = await fixture(t, true);
  for (const state of ["cancelled", "rejected"]) {
    await h.store
      .statement(
        "UPDATE attempt_state SET state=?,dispatched_at=NULL,remote_id=NULL,updated_at=10 WHERE tenant='a' AND attempt='old'",
        state,
      )
      .run();
    assert.equal(await lotwFreshInsertCurrent(h.store, h.key), true, state);
  }
  await h.store
    .statement(
      "UPDATE attempt_state SET dispatched_at=5 WHERE tenant='a' AND attempt='old'",
    )
    .run();
  assert.equal(
    await lotwFreshInsertCurrent(h.store, h.key),
    false,
    "a terminal state alone does not prove no mutation",
  );
  await h.store
    .statement(
      "INSERT INTO attempt_events(tenant,attempt,state,at) VALUES('a','old','retry_scheduled',4)",
    )
    .run();
  assert.equal(
    await lotwFreshInsertCurrent(h.store, h.key),
    false,
    "a receipt before the last dispatch cannot authorize retry",
  );
  await h.store
    .statement(
      "INSERT INTO attempt_events(tenant,attempt,state,at) VALUES('a','old','retry_scheduled',6)",
    )
    .run();
  assert.equal(await lotwFreshInsertCurrent(h.store, h.key), true);
  await h.store
    .statement(
      "UPDATE attempt_state SET remote_id='receipt' WHERE tenant='a' AND attempt='old'",
    )
    .run();
  assert.equal(await lotwFreshInsertCurrent(h.store, h.key), false);
  await h.store
    .statement(
      "UPDATE attempt_state SET remote_id=NULL WHERE tenant='a' AND attempt='old'",
    )
    .run();
  const id = await h.stage();
  assert.equal(await attemptSourceExportProofCurrent(h.store, "a", id), true);
});

test("fresh eligibility races fail atomically between guard and attempt insertion", async (t) => {
  const h = await fixture(t);
  await h.store
    .statement(
      "CREATE TRIGGER fixture_mapping_race AFTER INSERT ON stage_guards WHEN NEW.authorization_mode='lotw_fresh_insert' BEGIN UPDATE ledger SET baseline_hash='raced' WHERE tenant=NEW.tenant AND source=NEW.source AND qso=NEW.qso AND destination=NEW.destination; END;",
    )
    .run();
  await assert.rejects(h.stage(), /LoTW fresh insert unavailable/);
  assert.equal(
    (await h.store.ledger(h.key))?.baseline_hash,
    null,
    "all raced updates roll back",
  );
  for (const table of [
    "attempts",
    "attempt_source_export_proofs",
    "stage_guards",
    "destination_identity_claims",
  ])
    assert.equal(
      await h.store.statement(`SELECT count(*) n FROM ${table}`).first("n"),
      0,
      table,
    );
  assert.equal(
    await h.store
      .statement("SELECT count(*) n FROM private_data WHERE kind='outbox'")
      .first("n"),
    0,
  );
});

test("mapped or uncertain prior evidence appearing after preparation blocks dispatch", async (t) => {
  const h = await fixture(t, true);
  const id = await h.stage();
  assert.equal(await attemptSourceExportProofCurrent(h.store, "a", id), true);
  await h.store
    .statement("UPDATE ledger SET baseline_hash='accepted' WHERE tenant='a'")
    .run();
  assert.equal(await attemptSourceExportProofCurrent(h.store, "a", id), false);
  await assert.rejects(h.claimAttempt(id), /source export proof unavailable/);
  await h.store
    .statement("UPDATE ledger SET baseline_hash=NULL WHERE tenant='a'")
    .run();
  assert.equal(await attemptSourceExportProofCurrent(h.store, "a", id), true);
  await h.store
    .statement(
      "UPDATE attempt_state SET state='uncertain' WHERE tenant='a' AND attempt='old'",
    )
    .run();
  assert.equal(await attemptSourceExportProofCurrent(h.store, "a", id), false);
  await assert.rejects(
    h.store
      .statement(
        "UPDATE attempt_state SET state='dispatching' WHERE tenant='a' AND attempt=?",
        id,
      )
      .run(),
    /source export proof unavailable|lease lost/,
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
});

test("direct guards cannot promote a mode or bypass the existing proof", async (t) => {
  const h = await fixture(t);
  await assert.rejects(
    h.insertGuard("missing", { ...h.fresh, proofId: "absent" }).run(),
    /source export proof unavailable/,
  );
  await h.insertGuard("held", h.evidence.authorizations[0]).run();
  await assert.rejects(
    h.store
      .statement(
        "UPDATE stage_guards SET authorization_mode='lotw_fresh_insert' WHERE id='held'",
      )
      .run(),
    /mode is immutable/,
  );
  await h.store.statement("DELETE FROM stage_guards WHERE id='held'").run();
  await h.store
    .statement("UPDATE ledger SET context_generation=NULL WHERE tenant='a'")
    .run();
  await assert.rejects(h.stage(), /source export proof unavailable/);
  assert.equal(
    await h.store.statement("SELECT count(*) FROM attempts").first("count(*)"),
    0,
  );
});

test("fresh eligibility is tenant-keyed and queries use contact indexes", async (t) => {
  const h = await fixture(t, true);
  assert.equal(
    await lotwFreshInsertCurrent(h.store, { ...h.key, tenant: "other" }),
    false,
  );
  const guard = lotwFreshInsertEligibleGuard(h.key);
  const plan = await h.store
    .statement(`EXPLAIN QUERY PLAN SELECT ${guard.sql}`, ...guard.params)
    .all<{ detail: string }>();
  const details = plan.results.map((row) => row.detail).join("\n");
  assert.match(details, /SEARCH l USING INDEX sqlite_autoindex_ledger_1/);
  assert.match(details, /SEARCH a USING INDEX admin_attempt_contact/);
  assert.match(
    details,
    /SEARCH e USING COVERING INDEX attempt_authorization_events/,
  );
  assert.doesNotMatch(details, /SCAN (?:l|a|e)\b/);
});

test("the current-attempt exception never resets an uncertain or accepted mutation", async (t) => {
  const h = await fixture(t);
  const id = await h.stage();
  const { lease, claimed } = await h.claimAttempt(id);
  assert.equal(claimed, true);
  await h.store.resolve("a", id, lease, "uncertain");
  assert.equal(await attemptSourceExportProofCurrent(h.store, "a", id), false);
  await assert.rejects(
    h.store
      .statement(
        "UPDATE attempt_state SET state='dispatching' WHERE tenant='a' AND attempt=?",
        id,
      )
      .run(),
    /LoTW fresh insert unavailable|source export proof unavailable/,
  );
  // Even an incorrect mutable-state reset cannot erase immutable uncertainty.
  await h.store
    .statement(
      "UPDATE attempt_state SET state='prepared',due_at=0 WHERE tenant='a' AND attempt=?",
      id,
    )
    .run();
  assert.equal(await attemptSourceExportProofCurrent(h.store, "a", id), false);
  await assert.rejects(
    h.store.claimAttempt("a", id, lease),
    /source export proof unavailable/,
  );
  await h.store
    .statement("DELETE FROM attempt_state WHERE tenant='a' AND attempt=?", id)
    .run();
  assert.equal(await attemptSourceExportProofCurrent(h.store, "a", id), false);
  for (const state of ["prepared", "dispatching"])
    await assert.rejects(
      h.store
        .statement(
          "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a',?,?,0,0)",
          id,
          state,
        )
        .run(),
      /LoTW fresh insert unavailable|source export proof unavailable/,
    );
  assert.equal(
    await attemptSourceExportAuthorizationMode(h.store, "a", id),
    "lotw_fresh_insert",
    "the original pin and permanent ownership remain",
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) n FROM destination_identity_claims")
      .first("n"),
    1,
  );
});

test("known-unsent claimed work retries and can cancel/reprepare with the same retained identity", async (t) => {
  const h = await fixture(t);
  const id = await h.stage();
  const { lease, claimed } = await h.claimAttempt(id);
  assert.equal(claimed, true);
  assert.equal((await h.store.lotwIdentities(h.key)).length, 1);
  await h.store.retryUnsent("a", id, lease, "fixture_no_mutation");
  assert.equal(await attemptSourceExportProofCurrent(h.store, "a", id), true);
  await h.store
    .statement(
      "UPDATE attempt_state SET state='cancelled',updated_at=? WHERE tenant='a' AND attempt=?",
      Date.now(),
      id,
    )
    .run();
  assert.equal(await attemptSourceExportProofCurrent(h.store, "a", id), false);
  assert.equal(await lotwFreshInsertCurrent(h.store, h.key), true);
  const next = await h.stage();
  assert.notEqual(next, id);
  assert.equal(await attemptSourceExportProofCurrent(h.store, "a", next), true);
  assert.equal(
    await h.store
      .statement("SELECT count(*) n FROM attempt_source_export_proofs")
      .first("n"),
    2,
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) n FROM destination_identity_claims")
      .first("n"),
    1,
  );
});

test("populated upgrade preserves every old pin, guard, foreign key and original trigger", async (t) => {
  const h = await fixture(t, true, true, true);
  await h
    .insertGuard("in-flight-old-guard", h.evidence.authorizations[0])
    .run();
  const boundaryAttempt = await h.stage(h.evidence.authorizations[0]);
  const qrzKey = { ...h.key, destination: "qrz-destination" };
  const template = await h.store.saveTemplate("a", qrzKey.destination, {});
  const qrzAttempt = await h.store.stage(
    qrzKey,
    h.evidence.snapshots[0].contact.generation,
    { kind: "qrz", operation: "insert", mappedLogId: null, record: h.record },
    "v1",
    template,
    Date.now(),
    undefined,
    undefined,
    undefined,
    {
      claim: await destinationIdentityClaim("qrz", h.record),
      sourceVersion: h.fresh.reconciliationVersion,
    },
    { ...h.fresh, authorizationMode: "qrz_fresh_insert" },
  );
  const tables = [
    "stage_guards",
    "attempt_source_export_proofs",
    "attempts",
    "attempt_state",
    "attempt_events",
    "destination_identity_claims",
    "attempt_identity_claims",
    "source_export_proofs",
    "source_export_proof_retention",
    "ledger",
  ];
  const rows = async () =>
    Promise.all(
      tables.map(async (table) => ({
        table,
        rows: (
          await h.store.statement(`SELECT * FROM ${table} ORDER BY rowid`).all()
        ).results,
      })),
    );
  const before = await rows();
  const triggers = (
    await h.store
      .statement(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
      )
      .all<{ name: string; sql: string }>()
  ).results;
  const foreignKeys = (
    await h.store
      .statement("PRAGMA foreign_key_list(attempt_source_export_proofs)")
      .all()
  ).results;
  const columnsBefore = (
    await h.store.statement("PRAGMA table_info(stage_guards)").all()
  ).results;
  await applyMigration(h.db, migration);
  assert.deepEqual(
    await rows(),
    before,
    "upgrade copies all populated audit and guard rows byte-for-byte",
  );
  assert.deepEqual(
    (
      await h.store
        .statement("PRAGMA foreign_key_list(attempt_source_export_proofs)")
        .all()
    ).results,
    foreignKeys,
  );
  assert.deepEqual(
    (await h.store.statement("PRAGMA table_info(stage_guards)").all()).results,
    columnsBefore,
  );
  for (const original of triggers)
    assert.equal(
      await h.store
        .statement(
          "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",
          original.name,
        )
        .first("sql"),
      original.sql,
      original.name,
    );
  assert.equal(
    await h.store.statement("PRAGMA quick_check").first("quick_check"),
    "ok",
  );
  assert.deepEqual(
    (await h.store.statement("PRAGMA foreign_key_check").all()).results,
    [],
  );
  assert.equal(
    await attemptSourceExportAuthorizationMode(h.store, "a", boundaryAttempt),
    "source_boundary",
  );
  assert.equal(
    await attemptSourceExportAuthorizationMode(h.store, "a", qrzAttempt),
    "qrz_fresh_insert",
  );
  assert.equal(
    await attemptSourceExportProofCurrent(h.store, "a", boundaryAttempt),
    true,
  );
  assert.equal(
    await attemptSourceExportProofCurrent(h.store, "a", qrzAttempt),
    true,
  );
  assert.equal(
    await attemptSourceExportAuthorizationMode(h.store, "a", "old"),
    null,
  );
  await assert.rejects(
    h.store
      .statement(
        "UPDATE attempt_source_export_proofs SET authorization_mode='lotw_fresh_insert'",
      )
      .run(),
    /immutable/,
  );
  await assert.rejects(
    h.store.statement("DELETE FROM attempt_source_export_proofs").run(),
    /immutable/,
  );
  await assert.rejects(
    h.store
      .statement(
        "UPDATE stage_guards SET authorization_mode='lotw_fresh_insert' WHERE id='in-flight-old-guard'",
      )
      .run(),
    /immutable/,
  );
  await h.store
    .statement("DELETE FROM stage_guards WHERE id='in-flight-old-guard'")
    .run();
  assert.equal(
    await h.store
      .statement(
        "SELECT count(*) n FROM sqlite_master WHERE type='index' AND name='attempt_source_export_proof_retention'",
      )
      .first("n"),
    1,
  );
});

test("rebuilt mode constraints reject unknown modes and old callers retain boundary default", async (t) => {
  const h = await fixture(t);
  await h.insertGuard("old-shape", h.evidence.authorizations[0]).run();
  const columns = (
    await h.store
      .statement("PRAGMA table_info(stage_guards)")
      .all<{ name: string }>()
  ).results.map((row) => row.name);
  await assert.rejects(
    h.store
      .statement(
        `INSERT INTO stage_guards(${columns.join(",")}) SELECT ${columns.map((column) => (column === "id" ? "'invalid-mode'" : column === "authorization_mode" ? "'lotw_cleanup'" : column)).join(",")} FROM stage_guards WHERE id='old-shape'`,
      )
      .run(),
    /CHECK constraint failed/,
  );
  const oldColumns = columns.filter(
    (column) => column !== "authorization_mode",
  );
  await h.store
    .statement(
      `INSERT INTO stage_guards(${oldColumns.join(",")}) SELECT ${oldColumns.map((column) => (column === "id" ? "'legacy-default'" : column)).join(",")} FROM stage_guards WHERE id='old-shape'`,
    )
    .run();
  assert.equal(
    await h.store
      .statement(
        "SELECT authorization_mode FROM stage_guards WHERE id='legacy-default'",
      )
      .first("authorization_mode"),
    "source_boundary",
  );
  await h.store.statement("DELETE FROM stage_guards").run();
  const id = await h.stage(h.evidence.authorizations[0]);
  assert.equal(
    await attemptSourceExportAuthorizationMode(h.store, "a", id),
    "source_boundary",
  );
  assert.equal(
    await attemptSourceExportProofCurrent(
      h.store,
      "a",
      id,
      Date.now(),
      "lotw_fresh_insert",
    ),
    false,
  );
});

test("failed atomic migration restores the old populated schema and authorization guards", async (t) => {
  const h = await fixture(t, true, true);
  await h.insertGuard("old-guard", h.evidence.authorizations[0]).run();
  const id = await h.stage(h.evidence.authorizations[0]);
  const schema = async () =>
    (
      await h.store
        .statement(
          "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
        )
        .all()
    ).results;
  const data = async () =>
    Promise.all(
      [
        "stage_guards",
        "attempt_source_export_proofs",
        "attempts",
        "attempt_state",
        "attempt_events",
        "destination_identity_claims",
        "attempt_identity_claims",
        "source_export_proofs",
      ].map(async (table) => ({
        table,
        rows: (
          await h.store.statement(`SELECT * FROM ${table} ORDER BY rowid`).all()
        ).results,
      })),
    );
  const beforeSchema = await schema(),
    beforeData = await data();
  const statements: string[] = [];
  let current = "";
  for (const line of (
    await readFile(
      new URL(`../migrations/${migration}`, import.meta.url),
      "utf8",
    )
  ).split("\n")) {
    current += `${line}\n`;
    const trimmed = current.replace(/^\s*(?:--[^\n]*\n\s*)*/, "");
    if (
      line.trimEnd().endsWith(";") &&
      (!trimmed.startsWith("CREATE TRIGGER") ||
        line.trim() === "END;" ||
        /^CREATE TRIGGER[^\n]*\bEND;$/.test(trimmed.trim()))
    ) {
      statements.push(current);
      current = "";
    }
  }
  assert.equal(current.trim(), "");
  await assert.rejects(
    h.db.batch([
      ...statements.map((sql) => h.db.prepare(sql)),
      h.store.statement(
        "INSERT INTO accounts(id,email,user_handle,verified_at) VALUES('a','duplicate@example.test','duplicate',0)",
      ),
    ]),
    /UNIQUE constraint/,
  );
  assert.deepEqual(await schema(), beforeSchema);
  assert.deepEqual(await data(), beforeData);
  assert.equal(
    await attemptSourceExportAuthorizationMode(h.store, "a", id),
    "source_boundary",
  );
  assert.equal(await attemptSourceExportProofCurrent(h.store, "a", id), true);
  await assert.rejects(
    h.store
      .statement(
        "UPDATE attempt_source_export_proofs SET authorization_mode='qrz_fresh_insert'",
      )
      .run(),
    /immutable/,
  );
  assert.deepEqual(
    (await h.store.statement("PRAGMA foreign_key_check").all()).results,
    [],
  );
});
