import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import {
  destinationIdentityClaim,
  lotwRemoteIdentity,
} from "../src/destination-receipts.ts";
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
    };
    const ledger = (qso: string) =>
      h.store
        .statement(
          "SELECT remote_id,reason FROM ledger WHERE (tenant,source,destination,qso)=('a','source','destination',?)",
          qso,
        )
        .first<{ remote_id: string | null; reason: string | null }>();
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
      add,
      claims,
      ledger,
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
    const contender = await h.ledger("contender");
    assert.equal(contender?.remote_id, null);
    assert.equal(contender?.reason, null);
    await assert.rejects(
      h.add("insert-contender", first),
      /outbound identity claim conflict/,
    );
    assert.equal(await h.ledger("insert-contender"), null);
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

test("the overlap migration reserves exact QRZ LOGIDs despite an older outbound claim", async () => {
  const h = await setup("qrz");
  try {
    await h.add("overlap", "41");
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
    assert.equal((await h.ledger("overlap"))?.remote_id, "41");
    await assert.rejects(
      h.store
        .statement("UPDATE ledger SET remote_id='42' WHERE qso='overlap'")
        .run(),
      /legacy QRZ identity reservation conflict/,
    );
    assert.deepEqual(await h.reservations(), [
      { qso: "overlap", remote_id: "41" },
    ]);
  } finally {
    await h.mf.dispose();
  }
});
