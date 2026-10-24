import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { destinationIdentityClaim } from "../src/identity-claims.ts";
import { canonical } from "../src/security.ts";
import {
  attemptSourceExportAuthorizationMode,
  attemptSourceExportProofCurrent,
  qrzFreshInsertCurrent,
  qrzFreshInsertEligibleGuard,
  type SourceExportAuthorization,
} from "../src/source-export-proofs.ts";
import { applyMigration, database, seed } from "./helpers.ts";
import { mintFixtureSourceProofs } from "./source-proof-fixtures.ts";

const migration = "0031_qrz_fresh_insert_authorization.sql";
async function fixture(
  t: TestContext,
  historicalAttempt = false,
  beforeMigration = false,
) {
  const h = await database();
  t.after(() => h.mf.dispose());
  const names = (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql") && name !== "0001_foundation.sql")
    .sort();
  for (const name of names.filter((name) => name < "0030_"))
    await applyMigration(h.db, name);
  const key = await seed(h.store);
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
  for (const name of names.filter((name) => name >= "0030_" && name < "0031_"))
    await applyMigration(h.db, name);
  if (beforeMigration) {
    // Current canonical intake publishes the comparison index, but this fixture
    // must still exercise the authorization schema before 0031 is applied.
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
  const source = (await h.store.connection("a", "source"))!;
  const destination = (await h.store.connection("a", "destination"))!;
  const evidence = await mintFixtureSourceProofs(h.store, {
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
  });
  const [snapshot] = evidence.snapshots;
  const template = await h.store.saveTemplate("a", "destination", {});
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
  const claim = await destinationIdentityClaim("qrz", record);
  const fresh: SourceExportAuthorization = {
    ...evidence.authorizations[0],
    authorizationMode: "qrz_fresh_insert",
  };
  const stage = (proof = fresh) =>
    h.store.stage(
      key,
      snapshot.contact.generation,
      { kind: "qrz", operation: "insert", mappedLogId: null, record },
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
    return { lease, claimed: await h.store.claimAttempt("a", id, lease) };
  };
  return { ...h, key, evidence, fresh, stage, insertGuard, claimAttempt };
}

test("fresh QRZ pins preserve mode and current proof while excluding only their own attempt", async (t) => {
  const h = await fixture(t);
  assert.equal(await qrzFreshInsertCurrent(h.store, h.key), true);
  const id = await h.stage();
  assert.equal(
    await attemptSourceExportAuthorizationMode(h.store, "a", id),
    "qrz_fresh_insert",
  );
  assert.equal(
    await attemptSourceExportAuthorizationMode(h.store, "other", id),
    null,
  );
  assert.equal(
    await qrzFreshInsertCurrent(h.store, h.key),
    false,
    "prepared work is not a new insertion opportunity",
  );
  assert.equal(await qrzFreshInsertCurrent(h.store, h.key, id), true);
  assert.equal(
    await attemptSourceExportProofCurrent(
      h.store,
      "a",
      id,
      Date.now(),
      "qrz_fresh_insert",
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
    "UPDATE attempt_source_export_proofs SET authorization_mode='qrz_fresh_insert'",
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

test("migration defaults old pins to boundary authority and never creates missing pins", async (t) => {
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
      "qrz_fresh_insert",
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
        "UPDATE attempt_source_export_proofs SET authorization_mode='qrz_fresh_insert' WHERE attempt=?",
        id,
      )
      .run(),
    /immutable/,
  );
});

test("fresh structural guards reject mappings, accepted hashes, corrections and non-QRZ destinations", async (t) => {
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
    assert.equal(await qrzFreshInsertCurrent(h.store, h.key), false, column);
    await assert.rejects(h.stage(), /QRZ fresh insert unavailable/, column);
    await h.store
      .statement(`UPDATE ledger SET ${column}=? WHERE tenant='a'`, restored)
      .run();
    assert.equal(
      await qrzFreshInsertCurrent(h.store, h.key),
      true,
      `restored ${column}`,
    );
  }
  await h.store
    .statement("UPDATE ledger SET baseline_hash=source_hash WHERE tenant='a'")
    .run();
  assert.equal(
    await qrzFreshInsertCurrent(h.store, h.key),
    true,
    "ordinary read-only classification records the current observational baseline",
  );
  await h.store
    .statement("UPDATE ledger SET baseline_hash=NULL WHERE tenant='a'")
    .run();
  await h.store
    .statement(
      "UPDATE connections SET kind='lotw' WHERE tenant='a' AND id='destination'",
    )
    .run();
  assert.equal(await qrzFreshInsertCurrent(h.store, h.key), false);
  await assert.rejects(h.stage(), /QRZ fresh insert unavailable/);
  await h.store
    .statement(
      "UPDATE connections SET kind='qrz' WHERE tenant='a' AND id='destination'",
    )
    .run();
  await h.store
    .statement("UPDATE ledger SET remote_id='100' WHERE tenant='a'")
    .run();
  assert.equal(await qrzFreshInsertCurrent(h.store, h.key), false);
  await assert.rejects(h.stage(), /QRZ fresh insert unavailable/);
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
        await qrzFreshInsertCurrent(h.store, h.key),
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
      assert.equal(await qrzFreshInsertCurrent(h.store, h.key), false, state);
    }
    await assert.rejects(h.stage(), /QRZ fresh insert unavailable/);
  }
  await h.store
    .statement(
      "UPDATE attempt_state SET state='cancelled' WHERE tenant='a' AND attempt='old'",
    )
    .run();
  assert.equal(await qrzFreshInsertCurrent(h.store, h.key), true);
  await h.store
    .statement(
      "INSERT INTO attempt_events(tenant,attempt,state,at) VALUES('a','old','uncertain',1)",
    )
    .run();
  assert.equal(
    await qrzFreshInsertCurrent(h.store, h.key),
    false,
    "cancelling state cannot erase earlier uncertainty",
  );
  await assert.rejects(h.stage(), /QRZ fresh insert unavailable/);
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
    assert.equal(await qrzFreshInsertCurrent(h.store, h.key), true, state);
  }
  await h.store
    .statement(
      "UPDATE attempt_state SET dispatched_at=5 WHERE tenant='a' AND attempt='old'",
    )
    .run();
  assert.equal(
    await qrzFreshInsertCurrent(h.store, h.key),
    false,
    "a terminal state alone does not prove no mutation",
  );
  await h.store
    .statement(
      "INSERT INTO attempt_events(tenant,attempt,state,at) VALUES('a','old','retry_scheduled',4)",
    )
    .run();
  assert.equal(
    await qrzFreshInsertCurrent(h.store, h.key),
    false,
    "a receipt before the last dispatch cannot authorize retry",
  );
  await h.store
    .statement(
      "INSERT INTO attempt_events(tenant,attempt,state,at) VALUES('a','old','retry_scheduled',6)",
    )
    .run();
  assert.equal(await qrzFreshInsertCurrent(h.store, h.key), true);
  await h.store
    .statement(
      "UPDATE attempt_state SET remote_id='receipt' WHERE tenant='a' AND attempt='old'",
    )
    .run();
  assert.equal(await qrzFreshInsertCurrent(h.store, h.key), false);
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
      "CREATE TRIGGER fixture_mapping_race AFTER INSERT ON stage_guards WHEN NEW.authorization_mode='qrz_fresh_insert' BEGIN UPDATE ledger SET baseline_hash='raced' WHERE tenant=NEW.tenant AND source=NEW.source AND qso=NEW.qso AND destination=NEW.destination; END;",
    )
    .run();
  await assert.rejects(h.stage(), /QRZ fresh insert unavailable/);
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
        "UPDATE stage_guards SET authorization_mode='qrz_fresh_insert' WHERE id='held'",
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
    await qrzFreshInsertCurrent(h.store, { ...h.key, tenant: "other" }),
    false,
  );
  const guard = qrzFreshInsertEligibleGuard(h.key);
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
    /QRZ fresh insert unavailable|source export proof unavailable/,
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
      /QRZ fresh insert unavailable|source export proof unavailable/,
    );
  assert.equal(
    await attemptSourceExportAuthorizationMode(h.store, "a", id),
    "qrz_fresh_insert",
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
  assert.equal(await qrzFreshInsertCurrent(h.store, h.key), true);
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
