import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import {
  bindLegacyQrzIdentity,
  destinationIdentityClaim,
} from "../src/identity-claims.ts";
import {
  adoptHistory,
  classifyHistory,
  lotwRemoteIdentity,
} from "../src/reconcile.ts";
import { applyMigration, database, seed } from "./helpers.ts";

const migration = "0024_identity_mapping_overlap.sql";
const now = Date.parse("2027-01-01T00:00:00Z");
const record = {
  STATION_CALLSIGN: "W1AW",
  CALL: "K1OLD",
  QSO_DATE: "20261022",
  TIME_ON: "120001",
  BAND: "20m",
  MODE: "FT8",
  MY_GRIDSQUARE: "FN31AA12",
};
async function setup(vendor: "qrz" | "lotw") {
  const h = await database();
  try {
    for (const name of (
      await readdir(new URL("../migrations/", import.meta.url))
    )
      .filter(
        (name) =>
          name.endsWith(".sql") &&
          name > "0001_foundation.sql" &&
          name < migration,
      )
      .sort())
      await applyMigration(h.db, name);
    await seed(h.store);
    await h.store
      .statement("UPDATE connections SET kind=? WHERE id='destination'", vendor)
      .run();
    const key = (qso: string) => ({
      tenant: "a",
      source: "source",
      qso,
      destination: "destination",
    });
    const add = async (qso: string, remoteId: string | null = null) => {
      await h.store
        .statement(
          "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,state,narrative,remote_id,due_at,updated_at) VALUES('a','source',?,'destination','g1','hash',?,'remote_preserved',?,0,?)",
          qso,
          remoteId ? "adopted_existing" : "missing_current_identity",
          remoteId,
          now,
        )
        .run();
      return key(qso);
    };
    const claims = async () =>
      (
        await h.store
          .statement(
            "SELECT identity_hash,source,qso FROM destination_identity_claims ORDER BY qso,identity_hash",
          )
          .all()
      ).results;
    const reservations = async () =>
      (
        await h.store
          .statement(
            "SELECT qso,remote_id FROM legacy_qrz_identity_reservations ORDER BY qso",
          )
          .all()
      ).results;
    return {
      ...h,
      key,
      add,
      claims,
      reservations,
      migrate: () => applyMigration(h.db, migration),
    };
  } catch (error) {
    await h.mf.dispose();
    throw error;
  }
}

test("overlap migration backfills old-job LoTW adoption and protects later mapping inserts and updates", async () => {
  const h = await setup("lotw");
  try {
    const first = await lotwRemoteIdentity(record);
    await h.add("overlap", first);
    assert.equal((await h.claims()).length, 0);
    await h.migrate();
    assert.deepEqual(await h.claims(), [
      { identity_hash: first, source: "source", qso: "overlap" },
    ]);
    const second = await lotwRemoteIdentity({ ...record, CALL: "K2OLD" });
    await h.add("insert", second);
    const third = await lotwRemoteIdentity({ ...record, CALL: "K3OLD" });
    await h.add("update");
    await h.store
      .statement(
        "UPDATE ledger SET remote_id=?,state='adopted_existing' WHERE qso='update'",
        third,
      )
      .run();
    await h.store
      .statement("UPDATE ledger SET remote_id=NULL WHERE qso='overlap'")
      .run();
    const fourth = await lotwRemoteIdentity({ ...record, CALL: "K4OLD" });
    await h.store
      .statement("UPDATE ledger SET remote_id=? WHERE qso='overlap'", fourth)
      .run();
    assert.equal((await h.claims()).length, 4);
    await h.add("contender");
    await assert.rejects(
      h.store.db.batch([
        h.store.statement(
          "UPDATE ledger SET reason='should roll back' WHERE qso='contender'",
        ),
        h.store.statement(
          "UPDATE ledger SET remote_id=?,state='adopted_existing' WHERE qso='contender'",
          first,
        ),
      ]),
      /outbound identity claim conflict/,
    );
    const contender = await h.store.ledger(h.key("contender"));
    assert.equal(contender?.remote_id, null);
    assert.equal(contender?.reason, null);
    await assert.rejects(
      h.add("insert-contender", first),
      /outbound identity claim conflict/,
    );
    assert.equal(await h.store.ledger(h.key("insert-contender")), null);
    assert.equal((await h.claims()).length, 4);
  } finally {
    await h.mf.dispose();
  }
});

test("overlap backfill fails closed when an old-job mapping conflicts with an existing owner", async () => {
  const h = await setup("lotw");
  try {
    const identity = await lotwRemoteIdentity(record);
    await h.add("owner");
    await h.store
      .statement(
        "INSERT INTO destination_identity_claims(tenant,destination,vendor,identity_hash,source,qso,created_at) VALUES('a','destination','lotw',?,'source','owner',?)",
        identity,
        now,
      )
      .run();
    await h.add("old-job", identity);
    await assert.rejects(h.migrate(), /outbound identity claim conflict/);
    assert.deepEqual(await h.claims(), [
      { identity_hash: identity, source: "source", qso: "owner" },
    ]);
  } finally {
    await h.mf.dispose();
  }
});

test("old QRZ mappings reserve exact LOGIDs despite prior owner claims and never overwrite an unresolved reservation", async () => {
  const h = await setup("qrz");
  try {
    const key = await h.add("overlap", "41");
    const prior = await destinationIdentityClaim("qrz", {
      ...record,
      CALL: "K1PRIOR",
    });
    await h.store
      .statement(
        "INSERT INTO destination_identity_claims(tenant,destination,vendor,identity_hash,source,qso,created_at) VALUES('a','destination','qrz',?,'source','overlap',?)",
        prior.hash,
        now,
      )
      .run();
    await h.migrate();
    assert.deepEqual(await h.reservations(), [
      { qso: "overlap", remote_id: "41" },
    ]);
    assert.equal(
      await bindLegacyQrzIdentity(
        h.store,
        key,
        { ...record, APP_QRZLOG_LOGID: "41" },
        "g1",
        "v1",
        now,
      ),
      true,
    );
    assert.deepEqual(await h.reservations(), []);
    await h.store
      .statement("UPDATE ledger SET remote_id='42' WHERE qso='overlap'")
      .run();
    await assert.rejects(
      h.store
        .statement("UPDATE ledger SET remote_id='43' WHERE qso='overlap'")
        .run(),
      /legacy QRZ identity reservation conflict/,
    );
    assert.equal((await h.store.ledger(key))?.remote_id, "42");
    assert.deepEqual(await h.reservations(), [
      { qso: "overlap", remote_id: "42" },
    ]);
    await h.store
      .statement("UPDATE ledger SET remote_id=NULL WHERE qso='overlap'")
      .run();
    assert.deepEqual(await h.reservations(), [
      { qso: "overlap", remote_id: "42" },
    ]);
    await h.add("insert", "50");
    assert.deepEqual(await h.reservations(), [
      { qso: "insert", remote_id: "50" },
      { qso: "overlap", remote_id: "42" },
    ]);
  } finally {
    await h.mf.dispose();
  }
});

test("current QRZ history adoption atomically clears only its exact reservation, including an already-owned identity", async () => {
  const h = await setup("qrz");
  try {
    await h.migrate();
    // Current reconciliation also checks durable LOGID ownership. The other
    // cases deliberately retain the historical 0024 old-worker contract.
    await applyMigration(h.db, "0034_historical_associations.sql");
    const key = await h.add("current");
    const outcome = classifyHistory(
      record,
      [{ ...record, APP_QRZLOG_LOGID: "71" }],
      {
        destination: "qrz",
        capturedGeneration: "g1",
        currentGeneration: "g1",
        readAccess: true,
        inventoryComplete: true,
        catchupComplete: true,
        freshCheckComplete: true,
      },
    );
    assert.equal(outcome.state, "adopted_existing");
    assert.equal(
      (await adoptHistory(h.store, key, "g1", outcome, now)).applied,
      true,
    );
    assert.deepEqual(await h.reservations(), []);
    assert.equal((await h.claims()).length, 1);
    await h.store
      .statement(
        "UPDATE ledger SET remote_id=NULL,state='inventory_pending' WHERE qso='current'",
      )
      .run();
    assert.equal(
      (await adoptHistory(h.store, key, "g1", outcome, now + 1)).applied,
      true,
    );
    assert.deepEqual(await h.reservations(), []);
    assert.equal((await h.claims()).length, 1);
    const other = await h.add("competing");
    const competing = classifyHistory(
      record,
      [{ ...record, APP_QRZLOG_LOGID: "72" }],
      outcome.evidence,
    );
    assert.equal(
      (await adoptHistory(h.store, other, "g1", competing, now + 2)).applied,
      false,
    );
    assert.equal((await h.store.ledger(other))?.state, "history_ambiguous");
    assert.deepEqual(await h.reservations(), []);
  } finally {
    await h.mf.dispose();
  }
});

test("current QRZ delivered and observed receipt mappings do not create legacy holds", async (t) => {
  for (const path of ["delivered", "observed"] as const)
    await t.test(path, async () => {
      const h = await setup("qrz");
      try {
        await h.migrate();
        const key = await h.add("current");
        const claim = await destinationIdentityClaim("qrz", record);
        const attempt = await h.store.stage(
          key,
          "g1",
          { kind: "qrz", record },
          "v1",
          null,
          now,
          undefined,
          undefined,
          "live",
          { claim },
        );
        const lease = await h.store.claim(
          "a",
          "delivery:destination",
          now,
          60000,
        );
        assert(lease);
        assert(await h.store.claimAttempt("a", attempt, lease, now));
        if (path === "delivered")
          await h.store.resolve(
            "a",
            attempt,
            lease,
            "delivered",
            "81",
            now + 1,
          );
        else {
          await h.store.resolve(
            "a",
            attempt,
            lease,
            "uncertain",
            null,
            now + 1,
          );
          assert(
            await h.store.resolveReconciled("a", attempt, lease, "81", now + 2),
          );
        }
        assert.equal((await h.store.ledger(key))?.remote_id, "81");
        assert.deepEqual(await h.reservations(), []);
        await h.store
          .statement(
            "UPDATE ledger SET remote_id='82',source_hash='edited' WHERE qso='current'",
          )
          .run();
        assert.deepEqual(await h.reservations(), [
          { qso: "current", remote_id: "82" },
        ]);
      } finally {
        await h.mf.dispose();
      }
    });
});

test("a receipt without an immutable claim link cannot suppress a QRZ mapping reservation", async () => {
  const h = await setup("qrz");
  try {
    await h.migrate();
    const key = await h.add("old-job");
    const attempt = await h.store.stage(
      key,
      "g1",
      { kind: "qrz", record },
      "v1",
      null,
      now,
    );
    await h.store
      .statement(
        "UPDATE attempt_state SET state='delivered',remote_id='91' WHERE attempt=?",
        attempt,
      )
      .run();
    await h.store
      .statement(
        "UPDATE ledger SET remote_id='91',state='delivered' WHERE qso='old-job'",
      )
      .run();
    assert.deepEqual(await h.reservations(), [
      { qso: "old-job", remote_id: "91" },
    ]);
  } finally {
    await h.mf.dispose();
  }
});
