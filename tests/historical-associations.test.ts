import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { dispatchAttempt, prepareDue } from "../src/delivery.ts";
import {
  clearHistoricalAssociationLegacyReservation,
  historicalAssociationAvailable,
  historicalAssociationStatements,
  historicalQrzLogId,
} from "../src/historical-associations.ts";
import {
  claimedAttemptCurrent,
  destinationIdentityClaim,
  type IdentityGuard,
} from "../src/identity-claims.ts";
import { adoptHistory, classifyHistory } from "../src/reconcile.ts";
import type { LedgerKey } from "../src/store.ts";
import { applyMigration, database, seed } from "./helpers.ts";
import { mintFixtureSourceProofs } from "./source-proof-fixtures.ts";

const MIGRATION = "0034_historical_associations.sql";
const gates = {
  exportsEnabled: true,
  liveWriteAuthorized: true,
  sourceBoundaryVerified: true,
  allowedQsoIds: null,
  allowedDestinationIds: null,
};

async function fixture(t: TestContext, migrate = true) {
  const h = await database();
  t.after(() => h.mf.dispose());
  // Ownership does not depend on the separately implemented source index.
  for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((name) => name > "0001_foundation.sql" && name < "0033_")
    .sort())
    await applyMigration(h.db, name);
  const key = await seed(h.store);
  if (migrate) await applyMigration(h.db, MIGRATION);
  async function ledger(
    qso = "q1",
    source = "source",
    destination = "destination",
  ) {
    const next = { ...key, qso, source, destination };
    await h.store
      .statement(
        "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,state,due_at,updated_at) VALUES(?,?,?,?,'g1','s1','inventory_pending',0,1)",
        next.tenant,
        next.source,
        next.qso,
        next.destination,
      )
      .run();
    return next;
  }
  const identity = (remoteId = "42", bookIdentity = "destination") => ({
    vendor: "qrz" as const,
    remoteId,
    bookIdentity,
  });
  const adopted = (key: LedgerKey, remoteId = "42"): IdentityGuard => ({
    sql: "EXISTS(SELECT 1 FROM ledger WHERE tenant=? AND source=? AND qso=? AND destination=? AND generation='g1' AND state='adopted_existing' AND remote_id=? AND provenance='adopted')",
    params: [key.tenant, key.source, key.qso, key.destination, remoteId],
  });
  async function associate(
    key: LedgerKey,
    remoteId = "42",
    bookIdentity = "destination",
    extra: IdentityGuard = { sql: "1", params: [] },
  ) {
    const available = historicalAssociationAvailable(
      key,
      remoteId,
      bookIdentity,
    );
    const guard = adopted(key, remoteId);
    guard.sql += ` AND (${extra.sql})`;
    guard.params.push(...extra.params);
    return h.db.batch([
      h.store.statement(
        `UPDATE ledger SET state='adopted_existing',provenance='adopted',remote_id=?,baseline_hash=source_hash,remote_hash='observed',narrative='remote_preserved' WHERE tenant=? AND source=? AND qso=? AND destination=? AND generation='g1' AND remote_id IS NULL AND (${available.sql}) AND (${extra.sql}) RETURNING qso`,
        remoteId,
        key.tenant,
        key.source,
        key.qso,
        key.destination,
        ...available.params,
        ...extra.params,
      ),
      ...historicalAssociationStatements(
        h.store,
        key,
        identity(remoteId, bookIdentity),
        Date.now(),
        guard,
      ),
      clearHistoricalAssociationLegacyReservation(
        h.store,
        key,
        identity(remoteId, bookIdentity),
        guard,
      ),
    ]);
  }
  async function counts() {
    return h.store
      .statement(
        "SELECT (SELECT COUNT(*) FROM historical_remote_owners) owners,(SELECT COUNT(*) FROM historical_associations) associations,(SELECT COUNT(*) FROM legacy_qrz_identity_reservations) legacy,(SELECT COUNT(*) FROM attempts) attempts,(SELECT COUNT(*) FROM stage_guards) guards",
      )
      .first();
  }
  return { ...h, key, ledger, identity, adopted, associate, counts };
}

test("QRZ LOGIDs remain precise decimal identifiers without inventing timestamps", () => {
  assert.equal(historicalQrzLogId("00042"), "42");
  assert.equal(
    historicalQrzLogId("90071992547409931234"),
    "90071992547409931234",
  );
  for (const id of ["", "42\n", "-1", "4.2", "４２", "1".repeat(65)])
    assert.throws(() => historicalQrzLogId(id), /Invalid/);
});

test("migration reserves existing and retained legacy LOGIDs without restricting strict adoptions", async (t) => {
  const h = await fixture(t, false);
  await h.ledger();
  await h.store
    .statement(
      "UPDATE ledger SET remote_id='00042',state='adopted_existing' WHERE qso='q1'",
    )
    .run();
  await h.store
    .statement(
      "UPDATE ledger SET remote_id=NULL,state='source_deleted' WHERE qso='q1'",
    )
    .run();
  await applyMigration(h.db, MIGRATION);
  assert.deepEqual(await h.counts(), {
    owners: 1,
    associations: 0,
    legacy: 1,
    attempts: 0,
    guards: 0,
  });
  assert.equal(await h.store.historicalAssociationOnly(h.key), false);
  const other = await h.ledger("other");
  await assert.rejects(
    h.store
      .statement("UPDATE ledger SET remote_id='42' WHERE qso=?", other.qso)
      .run(),
    /historical remote ownership conflict/,
  );
  assert.equal((await h.store.ledger(other))?.remote_id, null);
  await assert.rejects(
    h.store.statement("DELETE FROM historical_remote_owners").run(),
    /explicit review/,
  );
  await assert.rejects(
    h.store
      .statement("UPDATE historical_remote_owners SET source='source'")
      .run(),
    /immutable/,
  );
  await assert.rejects(
    h.store
      .statement(
        "INSERT OR REPLACE INTO historical_remote_owners SELECT tenant,vendor,book_identity,remote_id,source,'other',destination,created_at FROM historical_remote_owners",
      )
      .run(),
    /ownership conflict/,
  );
});

test("guarded association is atomic, time-precision independent and clears only its exact legacy reservation", async (t) => {
  const h = await fixture(t);
  const key = await h.ledger();
  await h.associate(key, "42", "destination", { sql: "0", params: [] });
  assert.deepEqual(await h.counts(), {
    owners: 0,
    associations: 0,
    legacy: 0,
    attempts: 0,
    guards: 0,
  });
  const available = historicalAssociationAvailable(key, "42", "destination");
  await assert.rejects(
    h.db.batch([
      h.store.statement(
        `UPDATE ledger SET remote_id='42',state='adopted_existing',provenance='adopted' WHERE qso='q1' AND (${available.sql})`,
        ...available.params,
      ),
      ...historicalAssociationStatements(
        h.store,
        key,
        h.identity(),
        Date.now(),
        h.adopted(key),
      ),
      h.store.statement(
        "INSERT INTO accounts(id,email,user_handle,verified_at) VALUES('a','duplicate@example.test','duplicate',0)",
      ),
    ]),
    /UNIQUE/,
  );
  assert.deepEqual(await h.counts(), {
    owners: 0,
    associations: 0,
    legacy: 0,
    attempts: 0,
    guards: 0,
  });
  assert.equal((await h.store.ledger(key))?.remote_id, null);
  await h.associate(key);
  assert.deepEqual(await h.counts(), {
    owners: 1,
    associations: 1,
    legacy: 0,
    attempts: 0,
    guards: 0,
  });
  assert.equal(await h.store.historicalAssociationOnly(key), true);
  // No six-digit timestamp/outbound identity is fabricated for this association.
  assert.equal(
    await h.store
      .statement("SELECT COUNT(*) n FROM destination_identity_claims")
      .first("n"),
    0,
  );
  await h.db.batch(
    historicalAssociationStatements(
      h.store,
      key,
      h.identity(),
      Date.now(),
      h.adopted(key),
    ),
  );
  assert.equal((await h.counts())?.associations, 1);
  await h.store
    .statement(
      "INSERT INTO legacy_qrz_identity_reservations(tenant,destination,source,qso,remote_id) VALUES('a','destination','source','q1','43')",
    )
    .run();
  await clearHistoricalAssociationLegacyReservation(
    h.store,
    key,
    h.identity(),
    h.adopted(key),
  ).run();
  assert.equal(
    await h.store
      .statement("SELECT remote_id FROM legacy_qrz_identity_reservations")
      .first("remote_id"),
    "43",
  );
});

test("unrepresentable legacy mappings stay held without fabricated LOGID ownership", async (t) => {
  const h = await fixture(t, false);
  await h.ledger();
  await h.store
    .statement("UPDATE ledger SET remote_id='remote-1' WHERE qso='q1'")
    .run();
  await applyMigration(h.db, MIGRATION);
  assert.deepEqual(await h.counts(), {
    owners: 0,
    associations: 0,
    legacy: 1,
    attempts: 0,
    guards: 0,
  });
  assert.throws(
    () => historicalAssociationAvailable(h.key, "remote-1"),
    /Invalid historical QRZ LOGID/,
  );
  assert.equal((await h.store.ledger(h.key))?.remote_id, "remote-1");
  await h.ledger("later");
  await h.store
    .statement("UPDATE ledger SET remote_id='' WHERE qso='later'")
    .run();
  assert.equal((await h.counts())?.owners, 0);
  assert.equal((await h.counts())?.legacy, 2);
});

test("competing sources cannot acquire one LOGID and deleted mappings never release its owner", async (t) => {
  const h = await fixture(t);
  await h.store
    .statement(
      "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,created_at) VALUES('a','source2','lofi','source2','Other','active',0)",
    )
    .run();
  const first = await h.ledger();
  const second = await h.ledger("q1", "source2");
  const result = await Promise.allSettled([
    h.associate(first),
    h.associate(second),
  ]);
  assert.equal(
    result.filter(
      (r) => r.status === "fulfilled" && r.value[0].results.length === 1,
    ).length,
    1,
  );
  assert.deepEqual(await h.counts(), {
    owners: 1,
    associations: 1,
    legacy: 0,
    attempts: 0,
    guards: 0,
  });
  const owner = await h.store
    .statement("SELECT source FROM historical_remote_owners")
    .first<string>("source");
  const loser = owner === first.source ? second : first;
  await h.store
    .statement(
      "UPDATE ledger SET remote_id=NULL,state='source_deleted' WHERE source=?",
      owner!,
    )
    .run();
  await assert.rejects(
    h.store
      .statement(
        "UPDATE ledger SET remote_id='00042' WHERE source=?",
        loser.source,
      )
      .run(),
    /ownership conflict/,
  );
  assert.equal((await h.store.ledger(loser))?.remote_id, null);
});

test("strict collisions quarantine retained LOGID owners after identity edits, including same-book connections", async (t) => {
  for (const differentConnection of [false, true]) {
    await t.test(
      differentConnection
        ? "same book, different connection"
        : "same connection",
      async (t) => {
        const h = await fixture(t);
        const owner = await h.ledger();
        const record = {
          STATION_CALLSIGN: "W1AW",
          CALL: "K1ABC",
          QSO_DATE: "20261022",
          TIME_ON: "120001",
          BAND: "20M",
          MODE: "FT8",
          MY_GRIDSQUARE: "FN31AA",
          APP_QRZLOG_LOGID: "00042",
        };
        const evidence = {
          destination: "qrz" as const,
          capturedGeneration: "g1",
          currentGeneration: "g1",
          readAccess: true,
          inventoryComplete: true,
          catchupComplete: true,
          freshCheckComplete: true,
        };
        const first = classifyHistory(record, [record], evidence);
        assert.equal(first.state, "adopted_existing");
        assert.equal(first.associationOnly, undefined);
        assert.equal(
          (await adoptHistory(h.store, owner, "g1", first)).applied,
          true,
        );
        await h.store
          .statement(
            "UPDATE ledger SET remote_id=NULL,generation='edited',source_hash='edited',state='changed' WHERE tenant=? AND source=? AND qso=? AND destination=?",
            owner.tenant,
            owner.source,
            owner.qso,
            owner.destination,
          )
          .run();
        let destination = owner.destination;
        if (differentConnection) {
          destination = "reconnected";
          await h.store
            .statement(
              "UPDATE connections SET remote_identity='different-book' WHERE tenant=? AND id=?",
              owner.tenant,
              owner.destination,
            )
            .run();
          await h.store
            .statement(
              "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,created_at) SELECT tenant,?,kind,'destination','Reconnected',status,created_at FROM connections WHERE tenant=? AND id=?",
              destination,
              owner.tenant,
              owner.destination,
            )
            .run();
        }
        const contender = await h.ledger("contender", "source", destination);
        // The retained exact identity differs too; only permanent LOGID ownership
        // can connect this collision with the old owner's current edited row.
        const changed = {
          ...record,
          CALL: "K9XYZ",
          TIME_ON: "120002",
          APP_QRZLOG_LOGID: "42",
        };
        const second = classifyHistory(changed, [changed], evidence);
        assert.equal(second.state, "adopted_existing");
        const result = await adoptHistory(h.store, contender, "g1", second);
        assert.equal(result.applied, false);
        assert.equal(result.reason, "remote_identity_claim_conflict");
        for (const key of [owner, contender]) {
          const row = (await h.store.ledger(key))!;
          assert.equal(row.state, "history_ambiguous");
          assert.equal(row.provenance, "adoption_conflict");
          assert.equal(row.remote_id, null);
        }
        assert.equal((await h.counts())?.owners, 1);
        assert.equal((await h.counts())?.associations, 0);
      },
    );
  }
});

test("book and tenant scopes remain isolated, and reconnecting cannot evade an association-only owner", async (t) => {
  const h = await fixture(t);
  await h.ledger();
  await h.associate(h.key);
  const otherTenant = await seed(h.store, "b");
  await h.store
    .statement(
      "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,due_at,updated_at) VALUES('b','source','q1','destination','g1','s1',0,1)",
    )
    .run();
  await h.associate(otherTenant);
  await h.store
    .statement(
      "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at) VALUES('a','other-book','qrz','other-book','Other','active','v1',0)",
    )
    .run();
  const other = await h.ledger("q1", "source", "other-book");
  assert.equal(await h.store.historicalAssociationOnly(other), false);
  await h.associate(other, "42", "other-book");
  assert.equal((await h.counts())?.owners, 3);
  await h.store
    .statement(
      "UPDATE connections SET remote_identity='relinked' WHERE tenant='a' AND id='destination'",
    )
    .run();
  assert.equal(
    await h.store.historicalAssociationOnly(h.key),
    true,
    "original route stays blocked after relink",
  );
  await h.store
    .statement(
      "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,created_at) VALUES('a','reconnected','qrz','destination','Reconnected','active',0)",
    )
    .run();
  const reconnected = await h.ledger("q1", "source", "reconnected");
  assert.equal(
    await h.store.historicalAssociationOnly(reconnected),
    true,
    "same logical book stays blocked through a new connection",
  );
  await assert.rejects(
    h.store
      .statement(
        "INSERT OR REPLACE INTO historical_associations SELECT tenant,vendor,book_identity,remote_id,source,qso,'reconnected',created_at FROM historical_associations WHERE tenant='a' AND book_identity='destination'",
      )
      .run(),
    /immutable historical association/,
  );
  assert.equal(await h.store.historicalAssociationOnly(h.key), true);
});

async function preparedFixture(t: TestContext) {
  const h = await fixture(t, false);
  // Current canonical intake publishes index rows while constructing real proof.
  for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((name) => name >= "0033_" && name < MIGRATION)
    .sort())
    await applyMigration(h.db, name);
  await applyMigration(h.db, MIGRATION);
  await h.store
    .statement(
      "UPDATE connections SET config=? WHERE tenant='a' AND id='source'",
      JSON.stringify({ accountId: "source" }),
    )
    .run();
  await h.store
    .statement("UPDATE private_data SET revoked_at=1 WHERE connection='source'")
    .run();
  await h.store
    .statement(
      "UPDATE connections SET credential_version='v2' WHERE tenant='a' AND id='source'",
    )
    .run();
  await (
    await h.store.putPrivate("a", "source", "v2", "credential", {
      key: "browser:test",
      secret: "test",
      token: "test",
    })
  ).run();
  const source = (await h.store.connection("a", "source"))!;
  const evidence = await mintFixtureSourceProofs(h.store, {
    source,
    destinations: [(await h.store.connection("a", "destination"))!],
    operations: [
      { uuid: "op", syncedAtMillis: 100, stationCall: "W1AW", grid: "FN31AA" },
    ],
    qsos: [
      {
        uuid: "q1",
        operation: "op",
        syncedAtMillis: 101,
        startAtMillis: Date.parse("2026-10-22T12:00:01Z"),
        band: "20m",
        mode: "FT8",
        freq: 14074,
        their: { call: "K1ABC" },
      },
    ],
  });
  const contact = evidence.snapshots[0].contact;
  const record = {
    STATION_CALLSIGN: contact.stationCall,
    CALL: contact.call,
    QSO_DATE: "20261022",
    TIME_ON: "120001",
    BAND: contact.band,
    MODE: contact.mode,
  };
  const claim = await destinationIdentityClaim("qrz", record);
  const template = await h.store.saveTemplate("a", "destination", {});
  await h.store
    .statement(
      "UPDATE ledger SET state='missing_current_identity',due_at=0 WHERE qso='q1'",
    )
    .run();
  const id = await h.store.stage(
    h.key,
    contact.generation,
    { kind: "qrz", record },
    "v1",
    template,
    Date.now(),
    undefined,
    undefined,
    undefined,
    { claim, sourceVersion: contact.reconciliationVersion },
    evidence.authorizations[0],
  );
  const marker = () =>
    h.db.batch(
      historicalAssociationStatements(
        h.store,
        h.key,
        h.identity(),
        Date.now(),
        { sql: "1", params: [] },
      ),
    );
  return { ...h, contact, record, claim, id, marker };
}

test("an association blocks genuine prepared work, signing, old-worker direct stage/attempt and later source edits", async (t) => {
  const h = await preparedFixture(t);
  assert.equal(
    await claimedAttemptCurrent(h.store, "a", h.id, h.claim, Date.now()),
    true,
  );
  const noTransport = async () => {
    throw new Error("must not call vendor");
  };
  const claimAttempt = h.store.claimAttempt.bind(h.store);
  let raced = false;
  h.store.claimAttempt = async (...args) => {
    raced = true;
    await h.marker();
    return claimAttempt(...args);
  };
  try {
    assert.deepEqual(
      await dispatchAttempt(h.store, "a", h.id, gates, {
        fetcher: noTransport,
        sourceContact: h.contact,
      }),
      { state: "blocked", reason: "historical_association_read_only" },
    );
  } finally {
    h.store.claimAttempt = claimAttempt;
  }
  assert.equal(
    raced,
    true,
    "association arrives after dispatch preflight but before the atomic claim",
  );
  assert.equal(
    await claimedAttemptCurrent(h.store, "a", h.id, h.claim, Date.now()),
    false,
  );
  const lease = (await h.store.claim(
    "a",
    "delivery:destination",
    Date.now(),
    120_000,
  ))!;
  await assert.rejects(
    h.store.claimAttempt("a", h.id, lease),
    /historical association is read only/,
  );
  assert.deepEqual(
    await dispatchAttempt(h.store, "a", h.id, gates, { fetcher: noTransport }),
    { state: "blocked", reason: "historical_association_read_only" },
  );
  await h.store
    .statement(
      "UPDATE ledger SET generation='edited',source_hash='changed',state='changed',remote_id=NULL WHERE qso='q1'",
    )
    .run();
  assert.deepEqual(
    await prepareDue(
      h.store,
      h.key,
      { ...h.contact, generation: "edited" },
      gates,
      {
        fetcher: noTransport,
        sign: async () => {
          throw new Error("must not sign");
        },
      },
    ),
    { state: "blocked", reason: "historical_association_read_only" },
  );
  await assert.rejects(
    h.store
      .statement(
        "INSERT INTO stage_guards(id,tenant,source,qso,destination) VALUES('raw','a','source','q1','destination')",
      )
      .run(),
    /historical association is read only/,
  );
  await assert.rejects(
    h.store
      .statement(
        "INSERT INTO attempts SELECT tenant,'raw',source,qso,destination,generation,'raw',payload_hash,template_version,credential_version,created_at,source_hash FROM attempts WHERE id=?",
        h.id,
      )
      .run(),
    /historical association is read only/,
  );
  await assert.rejects(
    h.store
      .statement(
        "UPDATE attempt_state SET state='dispatching' WHERE attempt=?",
        h.id,
      )
      .run(),
    /historical association is read only/,
  );
  await assert.rejects(
    h.store.statement("UPDATE historical_associations SET qso=qso").run(),
    /immutable/,
  );
  await assert.rejects(
    h.store.statement("DELETE FROM historical_associations").run(),
    /explicit review/,
  );
  assert.equal(
    await h.store
      .statement("SELECT state FROM attempt_state WHERE attempt=?", h.id)
      .first("state"),
    "prepared",
  );
});

test("claim-first race rejects association and preserves uncertain receipt recovery", async (t) => {
  const h = await preparedFixture(t);
  const lease = (await h.store.claim(
    "a",
    "delivery:destination",
    Date.now(),
    120_000,
  ))!;
  assert.equal(await h.store.claimAttempt("a", h.id, lease), true);
  await assert.rejects(h.marker(), /historical association has prior delivery/);
  assert.equal(
    (await h.counts())?.owners,
    0,
    "owner insertion rolls back with rejected marker",
  );
  await h.store.resolve("a", h.id, lease, "uncertain", null);
  await assert.rejects(h.marker(), /historical association has prior delivery/);
  assert.equal(
    await h.store
      .statement("SELECT state FROM attempt_state WHERE attempt=?", h.id)
      .first("state"),
    "uncertain",
  );
  assert.equal(
    await h.store.resolveReconciled("a", h.id, lease, "42", Date.now()),
    true,
  );
  assert.equal(
    await h.store
      .statement("SELECT state FROM attempt_state WHERE attempt=?", h.id)
      .first("state"),
    "observed",
  );
  assert.deepEqual(await h.counts(), {
    owners: 1,
    associations: 0,
    legacy: 0,
    attempts: 1,
    guards: 0,
  });
  await assert.rejects(h.marker(), /historical association has prior delivery/);
});

test("association availability and write-block lookups use keyed indexes", async (t) => {
  const h = await fixture(t);
  await h.ledger();
  await h.associate(h.key);
  const guard = historicalAssociationAvailable(h.key, "42", "destination");
  const plans = await h.db.batch<{ detail: string }>([
    h.store.statement(
      `EXPLAIN QUERY PLAN SELECT 1 WHERE ${guard.sql}`,
      ...guard.params,
    ),
    h.store.statement(
      "EXPLAIN QUERY PLAN SELECT 1 FROM historical_association_write_blocks WHERE tenant=? AND source=? AND qso=? AND destination=? LIMIT 1",
      "a",
      "source",
      "q1",
      "destination",
    ),
  ]);
  for (const result of plans) {
    const details = result.results.map((row) => String(row.detail)).join("\n");
    assert.match(details, /SEARCH .* (?:INDEX|PRIMARY KEY)/);
    assert.doesNotMatch(
      details,
      /SCAN (?:historical_remote_owners|historical_associations|h)\b/,
    );
  }
});
