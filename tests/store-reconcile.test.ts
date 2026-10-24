import assert from "node:assert/strict";
import test from "node:test";
import type { AdifRecord } from "../src/adif.ts";
import { destinationIdentityClaim } from "../src/identity-claims.ts";
import { adifInstant } from "../src/qrz.ts";
import { canonicalLotwIdentity, lotwRemoteIdentity } from "../src/reconcile.ts";
import type { LedgerKey, Store } from "../src/store.ts";
import { LOTW_PRIOR_IDENTITY_NOTICE } from "../src/store.ts";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";
import { mintFixtureSourceProofs } from "./source-proof-fixtures.ts";

async function currentDatabase() {
  const state = await database();
  try {
    await applyAdditionalMigrations(state.db);
    return state;
  } catch (error) {
    await state.mf.dispose();
    throw error;
  }
}
async function freshEvidence(
  store: Store,
  key: LedgerKey,
  record: AdifRecord,
  revision = 1,
) {
  if (!(await store.private("a", "source", "fixture-source", "credential"))) {
    await (
      await store.putPrivate("a", "source", "fixture-source", "credential", {
        key: "browser:fixture",
        secret: "fixture",
        token: "fixture",
      })
    ).run();
    await store
      .statement(
        "UPDATE connections SET config=?,credential_version='fixture-source' WHERE tenant='a' AND id='source'",
        JSON.stringify({ accountId: "source" }),
      )
      .run();
  }
  const source = (await store.connection("a", "source"))!;
  const destination = (await store.connection("a", "destination"))!;
  const evidence = await mintFixtureSourceProofs(store, {
    source,
    destinations: [destination],
    operations: [
      { uuid: "op", stationCall: record.STATION_CALLSIGN, syncedAtMillis: 100 },
    ],
    qsos: [
      {
        uuid: key.qso,
        operation: "op",
        syncedAtMillis: 100 + revision,
        startAtMillis: adifInstant(record),
        band: record.BAND,
        mode: record.MODE,
        their: { call: record.CALL },
        notes: `revision ${revision}`,
      },
    ],
  });
  await store
    .statement(
      "UPDATE ledger SET state='missing_current_identity',due_at=0 WHERE tenant=? AND source=? AND qso=? AND destination=?",
      key.tenant,
      key.source,
      key.qso,
      key.destination,
    )
    .run();
  return {
    authorization: evidence.authorizations[0],
    contact: evidence.snapshots[0].contact,
    sourceHash: (await store.ledger(key))!.source_hash,
    now: Date.now(),
  };
}
test("observed uncertain artifact preserves exact baseline across new source and fences replay", async () => {
  const { mf, store } = await currentDatabase();
  try {
    const key = await seed(store);
    const version = await store.saveTemplate("a", "destination", {
      COMMENT: "frozen",
    });
    await store.observe(key, "g1", "h1", 30, false, 0);
    await store
      .statement("UPDATE ledger SET state='missing_current_identity'")
      .run();
    const record = {
      STATION_CALLSIGN: "N0TEST",
      CALL: "W1AW",
      QSO_DATE: "20261022",
      TIME_ON: "120001",
      BAND: "20M",
      MODE: "CW",
    };
    const proof = await freshEvidence(store, key, record);
    const now = proof.now;
    const id = await store.stage(
      key,
      proof.contact.generation,
      { record },
      "v1",
      version,
      now + 0,
      undefined,
      undefined,
      undefined,
      {
        claim: await destinationIdentityClaim("qrz", record),
        sourceVersion: proof.authorization.reconciliationVersion,
      },
      proof.authorization,
    );
    const send = (await store.claim(
      "a",
      "delivery:destination",
      now + 0,
      100,
    ))!;
    assert(await store.claimAttempt("a", id, send, now + 1));
    await store.resolve("a", id, send, "uncertain", null, now + 2);
    await store.observe(key, "g2", "h2", 30, false, now + 3);
    const lease = (await store.claim("a", "reconcile", now + 4, 100))!;
    assert.equal(
      await store.resolveReconciled("other", id, lease, "123", now + 5),
      false,
    );
    assert.equal(
      await store.resolveReconciled("a", id, lease, "123", now + 105),
      false,
    );
    assert.equal(
      await store.resolveReconciled("a", id, lease, "123", now + 5),
      true,
    );
    assert.equal(
      await store.resolveReconciled("a", id, lease, "123", now + 6),
      false,
    );
    const row = (await store.ledger(key))!;
    assert.equal(row.state, "changed");
    assert.equal(row.baseline_hash, proof.sourceHash);
    assert.equal(row.source_hash, "h2");
    assert.equal(row.remote_id, "123");
    assert.equal(
      (await store
        .statement(
          "SELECT COUNT(*) n FROM attempt_events WHERE state='observed'",
        )
        .first<{ n: number }>())!.n,
      1,
    );
    assert.equal(await store.private("a", "destination", id, "outbox"), null);
  } finally {
    await mf.dispose();
  }
});
test("fenced LoTW dispatch retains possible identity across a crash and outbox expiry", async () => {
  const { mf, store } = await currentDatabase();
  try {
    const key = await seed(store);
    await store
      .statement("UPDATE connections SET kind='lotw' WHERE id='destination'")
      .run();
    const original = canonicalLotwIdentity({
      STATION_CALLSIGN: "N0TEST",
      CALL: "W1AW",
      QSO_DATE: "20261022",
      TIME_ON: "120001",
      BAND: "20m",
      MODE: "CW",
    });
    const originalIdentity = {
      remoteId: await lotwRemoteIdentity(original),
      identity: original,
    };
    await store.observe(key, "g1", "h1", 30, false, 0);
    await store.db.batch([
      store.statement(
        "UPDATE ledger SET state='adopted_existing',baseline_hash=source_hash,remote_id=?,confirmed=1",
        originalIdentity.remoteId,
      ),
      await store.lotwIdentityStatement(key, originalIdentity, "adopted", 1, {
        sql: "1",
        params: [],
      }),
    ]);
    const corrected = canonicalLotwIdentity({ ...original, CALL: "W2NEW" });
    const correction = {
      remoteId: await lotwRemoteIdentity(corrected),
      identity: corrected,
    };
    await store.observe(key, "g2", "h2", 30, false, 10);
    const proof = await freshEvidence(store, key, corrected, 2);
    const preparedAt = proof.now;
    const id = await store.stage(
      key,
      proof.contact.generation,
      { kind: "lotw", signed: "private artifact" },
      "v1",
      null,
      preparedAt,
      "new-projection",
      correction.remoteId,
      undefined,
      {
        claim: await destinationIdentityClaim("lotw", corrected),
        sourceVersion: proof.authorization.reconciliationVersion,
      },
      proof.authorization,
    );
    const expiredLease = (await store.claim(
      "a",
      "delivery:destination",
      preparedAt,
      1,
    ))!;
    assert.equal(
      await store.claimAttempt(
        "a",
        id,
        expiredLease,
        preparedAt + 2,
        correction,
      ),
      false,
    );
    assert.equal(
      await store.lotwPriorIdentityCount(key),
      0,
      "failed claim cannot record a possible submission",
    );
    const lease = (await store.claim(
      "a",
      "delivery:destination",
      preparedAt + 3,
      1000,
    ))!;
    assert(
      await store.claimAttempt("a", id, lease, preparedAt + 4, correction),
    );
    assert.equal(
      await store.claimAttempt("a", id, lease, preparedAt + 4, correction),
      false,
    );
    assert.equal(await store.lotwPriorIdentityCount(key), 1);
    await store.recover(preparedAt + 7 * 86400000 + 1);
    assert.equal(
      (await store
        .statement("SELECT state FROM attempt_state WHERE attempt=?", id)
        .first<{ state: string }>())!.state,
      "reconciliation_required",
    );
    assert.equal(await store.private("a", "destination", id, "outbox"), null);
    assert.equal((await store.ledger(key))!.confirmed, 0);
    assert.equal((await store.ledger(key))!.reason, LOTW_PRIOR_IDENTITY_NOTICE);
    const identities = await store.lotwIdentities(key);
    assert.deepEqual(
      identities.map((identity) => identity.identity.CALL).sort(),
      ["W1AW", "W2NEW"],
    );
    assert.equal(
      identities.find((identity) => identity.remoteId === correction.remoteId)!
        .firstEvidence,
      "uncertain",
    );
    assert.equal(await store.lotwPriorIdentityCount(key), 1);
  } finally {
    await mf.dispose();
  }
});
test("later revisions retain one confirmation projection and deduplicate canonical identity evidence", async () => {
  const { mf, store } = await currentDatabase();
  try {
    const key = await seed(store);
    await store
      .statement("UPDATE connections SET kind='lotw' WHERE id='destination'")
      .run();
    const identity = {
      remoteId: "same-identity",
      identity: {
        STATION_CALLSIGN: "N0TEST",
        CALL: "W1AW",
        QSO_DATE: "20261022",
        TIME_ON: "120001",
        BAND: "20M",
        MODE: "CW",
        PROP_MODE: "",
        SAT_NAME: "",
      },
    };
    identity.remoteId = await lotwRemoteIdentity(identity.identity);
    for (let index = 1; index <= 2; index++) {
      const priorAt = Date.now() - 1900000;
      await store.observe(key, `g${index}`, `h${index}`, 30, false, priorAt);
      if (index === 1)
        await store
          .statement("UPDATE ledger SET state='missing_current_identity'")
          .run();
      const proof = await freshEvidence(store, key, identity.identity, index);
      const observedAt = proof.now;
      const id = await store.stage(
        key,
        proof.contact.generation,
        { revision: index },
        "v1",
        null,
        observedAt,
        undefined,
        identity.remoteId,
        undefined,
        {
          claim: await destinationIdentityClaim("lotw", identity.identity),
          sourceVersion: proof.authorization.reconciliationVersion,
        },
        proof.authorization,
      );
      const lease = (await store.claim(
        "a",
        "delivery:destination",
        observedAt,
        1000,
      ))!;
      assert(await store.claimAttempt("a", id, lease, observedAt + 1));
      await assert.rejects(
        store.resolve(
          "a",
          id,
          lease,
          "uncertain",
          null,
          observedAt + 1001,
          identity,
        ),
        /lease lost/,
      );
      assert.equal((await store.lotwIdentities(key)).length, index - 1);
      await store.resolve(
        "a",
        id,
        lease,
        "uncertain",
        null,
        observedAt + 2,
        identity,
      );
      assert(
        await store.resolveReconciled(
          "a",
          id,
          lease,
          identity.remoteId,
          observedAt + 3,
          { confirmed: index === 2, data: { revision: index }, identity },
        ),
      );
      await store.release(lease);
    }
    assert.equal(
      (await store
        .statement(
          "SELECT COUNT(*) n FROM private_data WHERE kind='lotw_observation'",
        )
        .first<{ n: number }>())!.n,
      1,
    );
    assert.equal((await store.ledger(key))!.confirmed, 1);
    assert.equal((await store.lotwIdentities(key)).length, 1);
    assert.equal(await store.lotwPriorIdentityCount(key), 0);
    await store.observe(key, "g3", "h3", 30, false, 4100000);
    assert.equal((await store.ledger(key))!.confirmed, 0);
    const proof = await freshEvidence(store, key, identity.identity, 3);
    const now = proof.now;
    const pending = await store.stage(
      key,
      proof.contact.generation,
      { revision: 3 },
      "v1",
      null,
      now + 0,
      undefined,
      identity.remoteId,
      undefined,
      {
        claim: await destinationIdentityClaim("lotw", identity.identity),
        sourceVersion: proof.authorization.reconciliationVersion,
      },
      proof.authorization,
    );
    const lease = (await store.claim(
      "a",
      "delivery:destination",
      now + 0,
      1000,
    ))!;
    assert(await store.claimAttempt("a", pending, lease, now + 1));
    await store.resolve(
      "a",
      pending,
      lease,
      "uncertain",
      null,
      now + 2,
      identity,
    );
    await store.observe(key, "g4", "h4", 30, false, now + 3);
    assert(
      await store.resolveReconciled(
        "a",
        pending,
        lease,
        identity.remoteId,
        now + 4,
        { confirmed: true, data: { revision: 3 }, identity },
      ),
    );
    assert.equal((await store.ledger(key))!.state, "changed");
    assert.equal(
      (await store.ledger(key))!.confirmed,
      0,
      "late observation of old projection cannot confirm a newer source revision",
    );
  } finally {
    await mf.dispose();
  }
});
