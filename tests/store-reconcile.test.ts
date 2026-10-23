import test from "node:test";
import assert from "node:assert/strict";
import { database, seed } from "./helpers.ts";
import { canonicalLotwIdentity, lotwRemoteIdentity } from "../src/reconcile.ts";
import { LOTW_PRIOR_IDENTITY_NOTICE } from "../src/store.ts";
test("observed uncertain artifact preserves exact baseline across new source and fences replay", async () => {
  const { mf, store } = await database();
  try {
    const key = await seed(store);
    const version = await store.saveTemplate("a", "destination", {
      COMMENT: "frozen",
    });
    await store.observe(key, "g1", "h1", 30, false, 0);
    await store
      .statement("UPDATE ledger SET state='missing_current_identity'")
      .run();
    const id = await store.stage(
      key,
      "g1",
      { record: { CALL: "W1AW" } },
      "v1",
      version,
      1800001,
    );
    const send = (await store.claim("a", "send", 1800001, 100))!;
    assert(await store.claimAttempt("a", id, send, 1800002));
    await store.resolve("a", id, send, "uncertain", null, 1800003);
    await store.observe(key, "g2", "h2", 30, false, 1800004);
    const lease = (await store.claim("a", "reconcile", 1800005, 100))!;
    assert.equal(
      await store.resolveReconciled("other", id, lease, "123", 1800006),
      false,
    );
    assert.equal(
      await store.resolveReconciled("a", id, lease, "123", 1800106),
      false,
    );
    assert.equal(
      await store.resolveReconciled("a", id, lease, "123", 1800006),
      true,
    );
    assert.equal(
      await store.resolveReconciled("a", id, lease, "123", 1800007),
      false,
    );
    const row = (await store.ledger(key))!;
    assert.equal(row.state, "changed");
    assert.equal(row.baseline_hash, "h1");
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
  const { mf, store } = await database();
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
    const preparedAt = 1800011;
    const id = await store.stage(
      key,
      "g2",
      { kind: "lotw", signed: "private artifact" },
      "v1",
      null,
      preparedAt,
      "new-projection",
      correction.remoteId,
    );
    const expiredLease = (await store.claim(
      "a",
      "expired-dispatch",
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
      "crashing-dispatch",
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
  const { mf, store } = await database();
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
    for (let index = 1; index <= 2; index++) {
      const observedAt = index * 2000000;
      await store.observe(
        key,
        `g${index}`,
        `h${index}`,
        30,
        false,
        observedAt - 1900000,
      );
      if (index === 1)
        await store
          .statement("UPDATE ledger SET state='missing_current_identity'")
          .run();
      const id = await store.stage(
        key,
        `g${index}`,
        { revision: index },
        "v1",
        null,
        observedAt,
      );
      const lease = (await store.claim("a", `send${index}`, observedAt, 1000))!;
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
    const pending = await store.stage(
      key,
      "g3",
      { revision: 3 },
      "v1",
      null,
      6000001,
    );
    const lease = (await store.claim("a", "later-source", 6000001, 1000))!;
    assert(await store.claimAttempt("a", pending, lease, 6000002));
    await store.resolve(
      "a",
      pending,
      lease,
      "uncertain",
      null,
      6000003,
      identity,
    );
    await store.observe(key, "g4", "h4", 30, false, 6000004);
    assert(
      await store.resolveReconciled(
        "a",
        pending,
        lease,
        identity.remoteId,
        6000005,
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
