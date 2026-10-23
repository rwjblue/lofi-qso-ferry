import assert from "node:assert/strict";
import test from "node:test";
import { contactReconciliationAdif, prepareDue } from "../src/delivery.ts";
import { projectContact, sourceFingerprint } from "../src/projection.ts";
import {
  adoptHistory,
  ADOPTION_CONFLICT_REASON,
  canonicalLotwIdentity,
  classifyHistory,
  lotwRemoteIdentity,
  reconcileQrzAttempt,
  type ReconciliationEvidence,
} from "../src/reconcile.ts";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";
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
test("fractional source times adopt only a unique seconds projection and cannot share one remote claim", async () => {
  for (const destination of ["qrz", "lotw"] as const) {
    const { mf, store } = await database();
    try {
      const first = await seed(store);
      await store
        .statement(
          "UPDATE connections SET kind=? WHERE id='destination'",
          destination,
        )
        .run();
      const contacts = await Promise.all(
        [123, 987].map((milliseconds, index) =>
          projectContact(
            {
              uuid: `q${index + 1}`,
              operation: null,
              startAtMillis: Date.parse("2026-10-22T12:00:01Z") + milliseconds,
              band: "20m",
              mode: "CW",
              their: { call: "W1AW" },
              our: { stationCall: "N0TEST/P", grid: "FN31" },
            },
            null,
          ),
        ),
      );
      const record = {
        ...contactReconciliationAdif(contacts[0]!),
        APP_QRZLOG_LOGID: "100",
      };
      for (const contact of contacts) {
        const key = { ...first, qso: contact.id };
        const projected = contactReconciliationAdif(contact);
        const currentEvidence = {
          ...evidence,
          destination,
          capturedGeneration: contact.generation,
          currentGeneration: contact.generation,
        };
        for (const candidates of [
          [{ ...record, TIME_ON: "1200" }],
          [{ ...record, TIME_ON: "120002" }],
          [record, { ...record, APP_QRZLOG_LOGID: "101" }],
        ])
          assert.equal(
            classifyHistory(projected, candidates, currentEvidence).state,
            "history_ambiguous",
          );
        const outcome = classifyHistory(projected, [record], currentEvidence);
        assert.equal(outcome.state, "adopted_existing");
        const fingerprint = await sourceFingerprint(contact, destination);
        await store.observe(key, contact.generation, fingerprint, 30, false, 0);
        assert.equal(
          (
            await adoptHistory(
              store,
              key,
              contact.generation,
              outcome,
              1,
              fingerprint,
            )
          ).applied,
          contact.id === "q1",
        );
      }
      assert((await store.ledger(first))!.remote_id);
      assert.equal(
        (await store.ledger({ ...first, qso: "q2" }))!.remote_id,
        null,
      );
      const reserved = (await store.ledger(first))!.remote_id;
      for (const contact of contacts) {
        const key = { ...first, qso: contact.id };
        const held = (await store.ledger(key))!;
        assert.equal(held.state, "history_ambiguous");
        assert.equal(held.provenance, "adoption_conflict");
        assert.equal(held.reason, ADOPTION_CONFLICT_REASON);
        const wholeSecond = await projectContact(
          {
            ...contact.context.qso,
            startAtMillis: Date.parse("2026-10-22T12:00:01Z"),
          },
          null,
        );
        await store.observe(
          key,
          wholeSecond.generation,
          await sourceFingerprint(wholeSecond, destination),
          30,
          false,
          10,
        );
        assert.equal((await store.ledger(key))!.state, "history_ambiguous");
        assert.equal(
          (await store.ledger(key))!.baseline_hash,
          held.baseline_hash,
        );
        assert.equal((await store.ledger(key))!.sent_hash, held.sent_hash);
        assert.equal(
          (
            await adoptHistory(
              store,
              key,
              wholeSecond.generation,
              classifyHistory(contactReconciliationAdif(wholeSecond), [], {
                ...evidence,
                destination,
                capturedGeneration: wholeSecond.generation,
                currentGeneration: wholeSecond.generation,
              }),
              20,
            )
          ).reason,
          "remote_identity_claim_conflict",
        );
        // Even a later route restoration must not turn the retained reservation
        // back into an actionable correction.
        await store
          .statement(
            "UPDATE ledger SET state='changed',reason=NULL WHERE tenant=? AND source=? AND qso=? AND destination=?",
            key.tenant,
            key.source,
            key.qso,
            key.destination,
          )
          .run();
        assert.equal(
          (
            await prepareDue(
              store,
              key,
              wholeSecond,
              {
                exportsEnabled: true,
                liveWriteAuthorized: true,
                sourceBoundaryVerified: true,
              },
              {
                now: 1800011,
                fetcher: async () =>
                  assert.fail("conflicted mapping made a vendor request"),
                sign: async () => assert.fail("conflicted mapping signed"),
              },
            )
          ).reason,
          "remote_identity_claim_conflict",
        );
      }
      assert.equal((await store.ledger(first))!.remote_id, reserved);
      assert.equal(
        (await store
          .statement("SELECT COUNT(*) n FROM attempts")
          .first<{ n: number }>())!.n,
        0,
      );
    } finally {
      await mf.dispose();
    }
  }
});
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
    await store.observe(conflicting, "g1", "other-input", 30, false, 0);
    const trustedOwner = await store.ledger(key);
    assert.equal(
      (await adoptHistory(store, conflicting, "g1", outcome, 1800016)).applied,
      false,
      "retained old identity stays associated with the original UUID after current mapping moves",
    );
    assert.equal((await store.ledger(conflicting))!.remote_id, null);
    assert.equal((await store.ledger(conflicting))!.state, "history_ambiguous");
    assert.deepEqual(await store.ledger(key), trustedOwner);
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
    assert.equal((await store.ledger(second))!.state, "history_ambiguous");
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
    const contender = { ...key, qso: "contender" };
    await store.observe(contender, "g1", "other-input", 30, false, 1);
    assert.equal(
      (
        await adoptHistory(
          store,
          contender,
          "g1",
          classifyHistory(source, [remote], evidence),
          2,
        )
      ).reason,
      "remote_identity_claim_conflict",
    );
    assert.equal((await store.ledger(contender))!.state, "history_ambiguous");
    assert.deepEqual(await store.ledger(key), ledger);
  } finally {
    await mf.dispose();
  }
});
test("competing adoption cancels only an unsent adopted correction and preserves receipts and uncertainty", async () => {
  for (const state of [
    "prepared",
    "dispatching",
    "uncertain",
    "delivered",
  ] as const) {
    const { mf, store } = await database();
    try {
      const owner = await seed(store);
      const contender = { ...owner, qso: "contender" };
      const outcome = classifyHistory(source, [remote], evidence);
      await store.observe(owner, "g1", "original-source", 30, false, 0);
      assert((await adoptHistory(store, owner, "g1", outcome, 1)).applied);
      await store.observe(owner, "g2", "corrected-source", 30, false, 10);
      const attempt = await store.stage(
        owner,
        "g2",
        { fixture: "correction" },
        "v1",
        null,
        1800011,
        "sent-projection",
      );
      if (state !== "prepared") {
        const lease = (await store.claim("a", "correction", 1800012, 1000))!;
        assert(await store.claimAttempt("a", attempt, lease, 1800013));
        if (state !== "dispatching")
          await store.resolve(
            "a",
            attempt,
            lease,
            state,
            state === "delivered" ? "100" : null,
            1800014,
          );
      }
      const ownerBefore = (await store.ledger(owner))!;
      const attemptBefore = await store
        .statement("SELECT * FROM attempt_state WHERE attempt=?", attempt)
        .first();
      await store.observe(contender, "g1", "contender-source", 30, false, 10);
      assert.equal(
        (await adoptHistory(store, contender, "g1", outcome, 1800015)).reason,
        "remote_identity_claim_conflict",
      );
      const heldContender = (await store.ledger(contender))!;
      assert.equal(heldContender.state, "history_ambiguous");
      assert.equal(heldContender.provenance, "adoption_conflict");
      assert.equal(heldContender.source_hash, "contender-source");
      assert.equal(heldContender.remote_id, null);
      const ownerAfter = (await store.ledger(owner))!;
      const attemptAfter = await store
        .statement("SELECT * FROM attempt_state WHERE attempt=?", attempt)
        .first();
      if (state === "prepared") {
        assert.deepEqual(ownerAfter, {
          ...ownerBefore,
          state: "history_ambiguous",
          provenance: "adoption_conflict",
          reason: ADOPTION_CONFLICT_REASON,
          updated_at: 1800015,
        });
        assert.deepEqual(attemptAfter, {
          ...attemptBefore,
          state: "cancelled",
          reason: ADOPTION_CONFLICT_REASON,
          updated_at: 1800015,
        });
        assert.equal(
          (await store
            .statement(
              "SELECT COUNT(*) n FROM attempt_events WHERE attempt=? AND state='cancelled' AND reason=?",
              attempt,
              ADOPTION_CONFLICT_REASON,
            )
            .first<{ n: number }>())!.n,
          1,
        );
        const lease = (await store.claim(
          "a",
          "after-conflict",
          1800016,
          1000,
        ))!;
        assert.equal(
          await store.claimAttempt("a", attempt, lease, 1800017),
          false,
        );
      } else {
        assert.deepEqual(ownerAfter, ownerBefore);
        assert.deepEqual(attemptAfter, attemptBefore);
      }
    } finally {
      await mf.dispose();
    }
  }
});
test("an unresolved contender attempt is not misclassified as an adoption identity conflict", async () => {
  const { mf, store } = await database();
  try {
    const owner = await seed(store);
    const contender = { ...owner, qso: "contender" };
    const outcome = classifyHistory(source, [remote], evidence);
    await store.observe(owner, "g1", "owner-source", 30, false, 0);
    assert((await adoptHistory(store, owner, "g1", outcome, 1)).applied);
    await store.observe(contender, "g1", "contender-source", 30, false, 0);
    await store
      .statement(
        "UPDATE ledger SET state='missing_current_identity',narrative='remote_preserved' WHERE qso='contender'",
      )
      .run();
    const attempt = await store.stage(
      contender,
      "g1",
      { fixture: "unsent" },
      "v1",
      null,
      1800001,
    );
    const ownerBefore = await store.ledger(owner);
    const contenderBefore = await store.ledger(contender);
    assert.equal(
      (await adoptHistory(store, contender, "g1", outcome, 1800002)).reason,
      "generation_mapping_or_attempt_conflict",
    );
    assert.deepEqual(await store.ledger(owner), ownerBefore);
    assert.deepEqual(await store.ledger(contender), contenderBefore);
    assert.equal(
      (await store
        .statement("SELECT state FROM attempt_state WHERE attempt=?", attempt)
        .first<{ state: string }>())!.state,
      "prepared",
    );
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
test("LoTW lower grid precision receives a review hold without truncating or adopting the source", () => {
  const scope = { ...evidence, destination: "lotw" as const };
  for (const [localGrid, remoteGrid] of [
    ["FN31PR12", "FN31PR"],
    ["FN31PR12", "FN31"],
    ["FN31PR", "FN31"],
    ["fn31pr12", "fn31pr"],
  ]) {
    const current = Object.freeze({
      ...source,
      MY_GRIDSQUARE: localGrid,
      FREQ: "14.074",
      MY_STATE: "CT",
      MODE: "MFSK",
      SUBMODE: "FT4",
    });
    const candidate = Object.freeze({
      ...remote,
      MY_GRIDSQUARE: remoteGrid,
      FREQ: "14.07400",
      MY_STATE: "CT",
      MODE: "DATA",
      APP_LOTW_MODE: "FT4",
    });
    const outcome = classifyHistory(current, [candidate], scope);
    assert.equal(outcome.state, "history_ambiguous");
    assert.equal(
      outcome.reason,
      "LoTW history has lower MY_GRIDSQUARE precision; review the station location before exporting",
    );
    assert.equal(outcome.remote, undefined);
    assert.equal(current.MY_GRIDSQUARE, localGrid);
    assert.equal(candidate.MY_GRIDSQUARE, remoteGrid);
  }
  const current = { ...source, MY_GRIDSQUARE: "FN31PR12" };
  const candidate = { ...remote, MY_GRIDSQUARE: "FN31PR" };
  assert.equal(
    classifyHistory(current, [candidate], evidence).state,
    "history_mismatch",
  );
  assert.equal(
    classifyHistory(
      current,
      [{ ...candidate, MY_GRIDSQUARE: "FN31PR12" }],
      scope,
    ).state,
    "adopted_existing",
  );
});
test("LoTW grid precision review requires valid nested grids and agreement on every other comparison", () => {
  const scope = { ...evidence, destination: "lotw" as const };
  const current = {
    ...source,
    MY_GRIDSQUARE: "FN31PR12",
    FREQ: "14.074",
    MY_STATE: "CT",
  };
  const candidate = {
    ...remote,
    MY_GRIDSQUARE: "FN31PR",
    FREQ: "14.074",
    MY_STATE: "CT",
  };
  for (const [expected, candidates, state] of [
    [current, [{ ...candidate, MY_GRIDSQUARE: "FN31PS" }], "history_mismatch"],
    [current, [{ ...candidate, MY_GRIDSQUARE: "FN31P?" }], "history_mismatch"],
    [current, [{ ...candidate, MY_GRIDSQUARE: "FN31P" }], "history_mismatch"],
    [current, [{ ...candidate, MY_GRIDSQUARE: "FN" }], "history_mismatch"],
    [current, [{ ...candidate, MY_GRIDSQUARE: "" }], "history_ambiguous"],
    [{ ...current, MY_GRIDSQUARE: "FN31PR1" }, [candidate], "history_mismatch"],
    [
      { ...current, MY_GRIDSQUARE: "FN31PRAB" },
      [candidate],
      "history_mismatch",
    ],
    [{ ...current, MY_GRIDSQUARE: "FN31" }, [candidate], "history_mismatch"],
    [current, [{ ...candidate, FREQ: "14.075" }], "history_mismatch"],
    [current, [{ ...candidate, FREQ: "" }], "history_ambiguous"],
    [current, [{ ...candidate, MY_STATE: "NY" }], "history_mismatch"],
    [current, [{ ...candidate, MODE: "SSB" }], "history_ambiguous"],
    [current, [{ ...candidate, TIME_ON: "1200" }], "history_ambiguous"],
    [current, [candidate, candidate], "history_ambiguous"],
  ] as const) {
    const outcome = classifyHistory(expected, [...candidates], scope);
    assert.equal(outcome.state, state);
    assert.doesNotMatch(outcome.reason ?? "", /lower MY_GRIDSQUARE precision/);
    assert.equal(outcome.remote, undefined);
  }
});
test("LoTW grid precision review ignores unrelated neighbors but requires one exact normalized identity", () => {
  const scope = { ...evidence, destination: "lotw" as const };
  const current = {
    ...source,
    MY_GRIDSQUARE: "FN31PR12",
    MODE: "MFSK",
    SUBMODE: "FT4",
  };
  const candidate = {
    ...remote,
    MY_GRIDSQUARE: "FN31PR",
    MODE: "DATA",
    APP_LOTW_MODE: "FT4",
  };
  const neighbor = { ...candidate, TIME_ON: "120002" };
  for (const candidates of [
    [candidate, neighbor],
    [neighbor, candidate],
  ]) {
    const outcome = classifyHistory(current, candidates, scope);
    assert.equal(outcome.state, "history_ambiguous");
    assert.equal(
      outcome.reason,
      "LoTW history has lower MY_GRIDSQUARE precision; review the station location before exporting",
    );
    assert.equal(outcome.remote, undefined);
  }
  const competing = classifyHistory(
    current,
    [candidate, neighbor, { ...candidate, MODE: "MFSK", SUBMODE: "FT4" }],
    scope,
  );
  assert.equal(competing.state, "history_ambiguous");
  assert.equal(
    competing.reason,
    "No unique exact identity, including time precision and mode",
  );
  assert.equal(competing.remote, undefined);
});
test("precision review outcomes persist as holds without a remote association or an attempt", async () => {
  const { mf, store } = await database();
  try {
    const baseKey = await seed(store);
    for (const destination of ["qrz", "lotw"] as const) {
      const key = { ...baseKey, qso: `${destination}-precision` };
      await store
        .statement(
          "UPDATE connections SET kind=? WHERE id='destination'",
          destination,
        )
        .run();
      const current = { ...source, MY_GRIDSQUARE: "FN31PR12" };
      const candidate =
        destination === "qrz"
          ? { ...remote, MY_GRIDSQUARE: "FN31PR12", TIME_ON: "1200" }
          : { ...remote, MY_GRIDSQUARE: "FN31PR" };
      const outcome = classifyHistory(current, [candidate], {
        ...evidence,
        destination,
      });
      await store.observe(key, "g1", "unchanged-source", 30, false, 0);
      assert((await adoptHistory(store, key, "g1", outcome, 1)).applied);
      const held = (await store.ledger(key))!;
      assert.equal(held.state, "history_ambiguous");
      assert.equal(held.reason, outcome.reason);
      assert.equal(held.remote_id, null);
      assert.equal(held.remote_hash, null);
      assert.equal(held.source_hash, "unchanged-source");
      assert.equal(held.provenance, "unknown");
      assert.deepEqual(await store.lotwIdentities(key), []);
    }
    assert.equal(
      (await store
        .statement("SELECT COUNT(*) n FROM attempts")
        .first<{ n: number }>())!.n,
      0,
    );
  } finally {
    await mf.dispose();
  }
});

test("complete retained inventory adopts positive matches but never establishes absence", async () => {
  const retained = {
    ...evidence,
    freshCheckComplete: false,
    inventoryPositiveOnly: true,
  };
  assert.equal(
    classifyHistory(source, [remote], retained).state,
    "adopted_existing",
  );
  assert.equal(
    classifyHistory(source, [], retained).state,
    "inventory_pending",
  );
  assert.equal(
    classifyHistory(source, [remote], { ...retained, inventoryComplete: false })
      .state,
    "inventory_pending",
  );
  assert.equal(
    classifyHistory(source, [remote], { ...retained, catchupComplete: false })
      .state,
    "inventory_pending",
  );
  assert.equal(
    classifyHistory(source, [remote], { ...retained, currentGeneration: "new" })
      .state,
    "inventory_pending",
  );
  const { mf, store } = await database();
  try {
    await applyAdditionalMigrations(store.db);
    const key = await seed(store);
    await store.observe(key, "g1", "hash", 30, false, 0);
    assert.equal(
      (
        await adoptHistory(
          store,
          key,
          "g1",
          {
            state: "missing_current_identity",
            reason: null,
            evidence: retained,
          },
          1,
        )
      ).applied,
      false,
    );
    assert.equal(
      (
        await adoptHistory(
          store,
          key,
          "g1",
          classifyHistory(source, [remote], retained),
          2,
        )
      ).reason,
      "inventory_commit_guard_required",
    );
    assert.equal(
      (
        await adoptHistory(
          store,
          key,
          "g1",
          classifyHistory(source, [remote], retained),
          2,
          undefined,
          { sql: "0", params: [] },
        )
      ).applied,
      false,
    );
    assert.equal(
      (
        await adoptHistory(
          store,
          key,
          "g1",
          classifyHistory(source, [remote], retained),
          2,
          undefined,
          { sql: "1", params: [] },
        )
      ).applied,
      true,
    );
    assert.equal((await store.ledger(key))?.remote_id, "100");
    assert.equal((await store.ledger(key))?.sent_hash, null);
  } finally {
    await mf.dispose();
  }
});
