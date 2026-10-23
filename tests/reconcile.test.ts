import assert from "node:assert/strict";
import test from "node:test";
import {
  adoptHistory,
  canonicalLotwIdentity,
  classifyHistory,
  lotwRemoteIdentity,
  reconcileQrzAttempt,
  type ReconciliationEvidence,
} from "../src/reconcile.ts";
import { database, seed } from "./helpers.ts";
const source = {
  STATION_CALLSIGN: "N0TEST/P",
  CALL: "W1AW",
  QSO_DATE: "20261022",
  TIME_ON: "120001",
  BAND: "20m",
  MODE: "CW",
  MY_GRIDSQUARE: "FN31",
};
const remote = {
  ...source,
  COMMENT: "Historical narrative untouched",
  APP_QRZLOG_LOGID: "100",
};
const evidence: ReconciliationEvidence = {
  destination: "qrz",
  capturedGeneration: "g1",
  currentGeneration: "g1",
  readAccess: true,
  inventoryComplete: true,
  catchupComplete: true,
  freshCheckComplete: true,
};
test("partial/failed history coverage and source races never authorize backfill", () => {
  for (const flag of [
    "inventoryComplete",
    "catchupComplete",
    "freshCheckComplete",
  ] as const)
    assert.equal(
      classifyHistory(source, [], { ...evidence, [flag]: false }).state,
      "inventory_pending",
    );
  assert.equal(
    classifyHistory(source, [], { ...evidence, currentGeneration: "g2" }).state,
    "inventory_pending",
  );
  assert.equal(
    classifyHistory(source, [], evidence).state,
    "missing_current_identity",
  );
  assert.equal(
    classifyHistory(source, [], { ...evidence, readAccess: false }).state,
    "historical_unverified",
  );
  assert.equal(
    classifyHistory(source, [], {
      ...evidence,
      destination: "lotw",
      readAccess: false,
      provenNewAfterCutover: true,
    }).state,
    "live_new",
  );
});
test("read-only LoTW adoption retains only encrypted canonical identity and scopes it to its owner", async () => {
  const { mf, store } = await database();
  try {
    const key = await seed(store);
    await seed(store, "b");
    await store
      .statement("UPDATE connections SET kind='lotw' WHERE id='destination'")
      .run();
    const accepted = { ...remote, QSL_RCVD: "Y" };
    const outcome = classifyHistory(source, [accepted], {
      ...evidence,
      destination: "lotw",
    });
    await store.observe(key, "g1", "adopt-input", 30, false, 0);
    assert((await adoptHistory(store, key, "g1", outcome, 1)).applied);
    const identities = await store.lotwIdentities(key);
    assert.equal(identities.length, 1);
    assert.deepEqual(identities[0]!.identity, canonicalLotwIdentity(source));
    assert.equal(identities[0]!.remoteId, await lotwRemoteIdentity(source));
    assert.equal(identities[0]!.firstEvidence, "adopted");
    assert.equal(identities[0]!.recordedAt, 1);
    assert.equal((await store.ledger(key))!.confirmed, 1);
    assert.equal(await store.lotwPriorIdentityCount(key), 0);
    for (const other of [
      { ...key, tenant: "b" },
      { ...key, source: "other-source" },
      { ...key, qso: "another-contact" },
      { ...key, destination: "source" },
    ]) {
      assert.deepEqual(await store.lotwIdentities(other), []);
      assert.equal(await store.lotwPriorIdentityCount(other), 0);
    }
    const row = await store
      .statement("SELECT envelope FROM private_data WHERE kind='lotw_identity'")
      .first<{ envelope: string }>();
    assert(!row!.envelope.includes(source.CALL));
    assert(!row!.envelope.includes(remote.COMMENT));
    assert.equal(
      (await store
        .statement("SELECT COUNT(*) n FROM attempts")
        .first<{ n: number }>())!.n,
      0,
    );
    const conflicting = { ...key, qso: "duplicate" };
    await store.observe(conflicting, "g1", "other-input", 30, false, 0);
    assert.equal(
      (await adoptHistory(store, conflicting, "g1", outcome, 2)).applied,
      false,
    );
    assert.deepEqual(await store.lotwIdentities(conflicting), []);
    const next = canonicalLotwIdentity({ ...source, CALL: "W2NEW" });
    const nextIdentity = {
      remoteId: await lotwRemoteIdentity(next),
      identity: next,
    };
    await store.observe(key, "g2", "corrected-input", 30, false, 10);
    const attempt = await store.stage(
      key,
      "g2",
      { signed: "synthetic artifact" },
      "v1",
      null,
      1800011,
      "next-projection",
      nextIdentity.remoteId,
    );
    assert.equal((await store.ledger(key))!.confirmed, 0);
    const lease = (await store.claim("a", "correction", 1800012, 1000))!;
    assert(await store.claimAttempt("a", attempt, lease, 1800013));
    await store.resolve(
      "a",
      attempt,
      lease,
      "submitted",
      null,
      1800014,
      nextIdentity,
    );
    assert(
      await store.resolveReconciled(
        "a",
        attempt,
        lease,
        nextIdentity.remoteId,
        1800015,
        {
          confirmed: false,
          data: { compact: "new projection" },
          identity: nextIdentity,
        },
      ),
    );
    assert.equal(
      await store.private("a", "destination", attempt, "outbox"),
      null,
    );
    assert.equal(await store.lotwPriorIdentityCount(key), 1);
    assert.deepEqual(
      (await store.lotwIdentities(key))
        .map((identity) => identity.identity.CALL)
        .sort(),
      ["W1AW", "W2NEW"],
    );
    assert.notEqual(
      (await store.ledger(key))!.remote_id,
      await lotwRemoteIdentity(source),
    );
    assert.equal(
      (await adoptHistory(store, conflicting, "g1", outcome, 1800016)).applied,
      false,
      "retained old identity stays associated with the original UUID after current mapping moves",
    );
    assert.equal((await store.ledger(conflicting))!.remote_id, null);
    assert.deepEqual(await store.lotwIdentities(conflicting), []);
    const otherTenant = { ...key, tenant: "b" };
    await store.observe(otherTenant, "g1", "other-tenant-input", 30, false, 0);
    assert(
      (await adoptHistory(store, otherTenant, "g1", outcome, 1800017)).applied,
      "retained identity claims remain tenant isolated",
    );
  } finally {
    await mf.dispose();
  }
});
test("D1 adoption preserves narrative policy without a fabricated delivery or signing attempt", async () => {
  const { mf, store } = await database();
  try {
    const key = await seed(store);
    await store.observe(key, "g1", "source-input-hash", 30, false, 0);
    assert.equal(
      (
        await adoptHistory(
          store,
          key,
          "g1",
          classifyHistory(source, [remote], evidence),
          1,
        )
      ).applied,
      true,
    );
    const ledger = (await store.ledger(key))!;
    assert.equal(ledger.state, "adopted_existing");
    assert.equal(ledger.narrative, "remote_preserved");
    assert.equal(ledger.provenance, "adopted");
    assert.equal(ledger.baseline_hash, "source-input-hash");
    assert.equal(ledger.sent_hash, null);
    assert.equal(ledger.template_version, null);
    assert.equal(ledger.remote_id, "100");
    assert.equal(
      (await store
        .statement("SELECT COUNT(*) n FROM attempts")
        .first<{ n: number }>())!.n,
      0,
    );
    await store.observe(key, "g1", "source-input-hash", 30, false, 1000);
    assert.equal((await store.ledger(key))!.state, "adopted_existing");
  } finally {
    await mf.dispose();
  }
});
test("D1 generation CAS, remote uniqueness and tenant boundaries stop stale adoption", async () => {
  const { mf, store } = await database();
  try {
    const first = await seed(store);
    await seed(store, "b");
    const second = { ...first, qso: "q2" };
    for (const key of [first, second])
      await store.observe(key, "g1", "input", 30, false, 0);
    const outcome = classifyHistory(source, [remote], evidence);
    assert.equal(
      (await adoptHistory(store, first, "g1", outcome)).applied,
      true,
    );
    assert.equal(
      (await adoptHistory(store, second, "g1", outcome)).applied,
      false,
    );
    assert.equal((await store.ledger(second))!.state, "inventory_pending");
    await store.observe(second, "g2", "changed", 30, false, 10);
    assert.equal(
      (await adoptHistory(store, second, "g1", outcome)).reason,
      "source_generation_changed",
    );
    assert.equal(
      (await adoptHistory(store, { ...first, tenant: "other" }, "g1", outcome))
        .applied,
      false,
    );
    const other = { ...first, tenant: "b" };
    await store.observe(other, "g1", "input", 30, false, 0);
    assert.equal(
      (await adoptHistory(store, other, "g1", outcome)).applied,
      true,
    );
  } finally {
    await mf.dispose();
  }
});
test("trusted template mapping survives reconnect inventory", async () => {
  const { mf, store } = await database();
  try {
    const key = await seed(store);
    await store.observe(key, "g1", "input", 30, false, 0);
    const version = await store.saveTemplate("a", "destination", {
      COMMENT: "original",
    });
    await store
      .statement(
        "UPDATE ledger SET state='delivered',remote_id='100',sent_hash='sent',provenance='ferry_created',narrative='template_bound',template_version=?",
        version,
      )
      .run();
    assert.equal(
      (
        await adoptHistory(
          store,
          key,
          "g1",
          classifyHistory(source, [remote], evidence),
        )
      ).reason,
      "trusted_mapping_preserved",
    );
    const ledger = (await store.ledger(key))!;
    assert.equal(ledger.template_version, version);
    assert.equal(ledger.provenance, "ferry_created");
  } finally {
    await mf.dispose();
  }
});
test("uncertain QRZ outcome needs exact projection readback, not identity presence", () => {
  assert.equal(
    reconcileQrzAttempt({ ...source, COMMENT: "new" }, [remote]).state,
    "unresolved",
  );
  assert.equal(reconcileQrzAttempt(source, []).state, "unresolved");
  assert.equal(reconcileQrzAttempt(source, [remote]).state, "observed");
  assert.equal(
    reconcileQrzAttempt(source, [remote, remote]).state,
    "unresolved",
  );
});
test("LoTW individual mode mapping never substitutes modegroup and adopted mappings persist", () => {
  const lotwEvidence = { ...evidence, destination: "lotw" as const };
  const sourceFt4 = { ...source, MODE: "MFSK", SUBMODE: "FT4" };
  assert.equal(
    classifyHistory(
      sourceFt4,
      [{ ...source, MODE: "DATA", APP_LOTW_MODE: "FT4" }],
      lotwEvidence,
    ).state,
    "adopted_existing",
  );
  assert.equal(
    classifyHistory(
      sourceFt4,
      [{ ...source, MODE: "DATA", APP_LOTW_MODEGROUP: "DATA" }],
      lotwEvidence,
    ).state,
    "history_ambiguous",
  );
});
test("adopted and observed LoTW identity keys prevent a second source UUID from claiming the same contact", async () => {
  const { mf, store } = await database();
  try {
    const first = await seed(store);
    await store
      .statement("UPDATE connections SET kind='lotw' WHERE id='destination'")
      .run();
    const lotwRemote = { ...remote, QSL_RCVD: "N" };
    await store.observe(first, "g1", "h1", 30, false, 0);
    await store
      .statement("UPDATE ledger SET state='missing_current_identity'")
      .run();
    const id = await store.stage(
      first,
      "g1",
      { fixture: "signed" },
      "v1",
      null,
      1800001,
    );
    const lease = (await store.claim("a", "lotw-reconcile", 1800001, 1000))!;
    assert(await store.claimAttempt("a", id, lease, 1800002));
    await store.resolve("a", id, lease, "uncertain", null, 1800003);
    const identity = await lotwRemoteIdentity(lotwRemote);
    assert(await store.resolveReconciled("a", id, lease, identity, 1800004));
    const second = { ...first, qso: "q2" };
    await store.observe(second, "g1", "h2", 30, false, 0);
    const outcome = classifyHistory(source, [lotwRemote], {
      ...evidence,
      destination: "lotw",
    });
    assert.equal(outcome.state, "adopted_existing");
    assert.equal(
      (await adoptHistory(store, second, "g1", outcome, 1800005)).applied,
      false,
    );
    assert.equal((await store.ledger(first))!.remote_id, identity);
    assert.equal((await store.ledger(second))!.remote_id, null);
    assert.equal(
      await lotwRemoteIdentity({ ...lotwRemote, MODE: "SSB", SUBMODE: "USB" }),
      await lotwRemoteIdentity({ ...lotwRemote, MODE: "SSB" }),
    );
  } finally {
    await mf.dispose();
  }
});
test("LoTW adoption compares supported location only and requires meaningful frequency evidence", () => {
  const expected = {
    ...source,
    FREQ: "14.074",
    MY_LAT: "N041 00.000",
    MY_LON: "W072 00.000",
    RST_SENT: "59",
    TX_PWR: "5",
    OPERATOR: "N0OP",
  };
  const remoteLotw = { ...remote, FREQ: "14.07400", QSL_RCVD: "N" };
  const scope = { ...evidence, destination: "lotw" as const };
  assert.equal(
    classifyHistory(expected, [remoteLotw], scope).state,
    "adopted_existing",
  );
  assert.equal(
    classifyHistory(expected, [{ ...remoteLotw, FREQ: "14.07500" }], scope)
      .state,
    "history_mismatch",
  );
  assert.equal(
    classifyHistory({ ...expected, FREQ: "14.074001" }, [remoteLotw], scope)
      .state,
    "history_ambiguous",
  );
  assert.equal(
    classifyHistory(
      { ...expected, MODE: "SSB", SUBMODE: "USB" },
      [{ ...remoteLotw, MODE: "SSB" }],
      scope,
    ).state,
    "adopted_existing",
  );
});
