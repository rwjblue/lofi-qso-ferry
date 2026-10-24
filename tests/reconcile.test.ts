import assert from "node:assert/strict";
import test from "node:test";
import { measuredDatabase } from "../src/database-metrics.ts";
import { contactReconciliationAdif, prepareDue } from "../src/delivery.ts";
import { historicalGridsCompatible } from "../src/historical-location.ts";
import { destinationIdentityClaim } from "../src/identity-claims.ts";
import { observeLotwContact } from "../src/lotw.ts";
import { backfillLotwOwnership } from "../src/lotw-ownership.ts";
import { renewAttemptLotwOwnership } from "../src/lotw-ownership-bridge.ts";
import { projectContact, sourceFingerprint } from "../src/projection.ts";
import {
  ADOPTION_CONFLICT_REASON,
  adoptHistory,
  adoptHistoryBatch,
  canonicalLotwIdentity,
  classifyHistory,
  comparableRemote,
  type HistoryAdoptionInput,
  lotwRemoteIdentity,
  type ReconciliationEvidence,
  reconcileQrzAttempt,
} from "../src/reconcile.ts";
import {
  finishReconciliationWorkStatement,
  reconciliationCheckStatement,
  reconciliationPreflightBatch,
} from "../src/reconciliation-work.ts";
import { canonical, sha256 } from "../src/security.ts";
import { type LedgerKey, Store } from "../src/store.ts";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";
import { mintFixtureSourceProofs } from "./source-proof-fixtures.ts";

async function reconciliationDatabase() {
  const h = await database();
  try {
    await applyAdditionalMigrations(h.db);
    return h;
  } catch (error) {
    await h.mf.dispose();
    throw error;
  }
}
async function maintainOwnership(store: Store, tenant = "a") {
  for (let pass = 0; pass < 10; pass++) {
    const result = await backfillLotwOwnership(store, tenant);
    if (
      result.reason !== "examined" ||
      !(result.advanced || result.covered || result.ownersHashed)
    )
      break;
  }
}
async function reconciliationStageProof(
  store: Store,
  key: LedgerKey,
  call: string,
) {
  const connection = (await store.connection(key.tenant, key.source))!;
  await store
    .statement(
      "UPDATE connections SET config=? WHERE tenant=? AND id=?",
      JSON.stringify({ accountId: connection.remote_identity }),
      key.tenant,
      key.source,
    )
    .run();
  await store
    .statement(
      "DELETE FROM private_data WHERE tenant=? AND connection=? AND id=? AND kind='credential'",
      key.tenant,
      key.source,
      connection.credential_version!,
    )
    .run();
  await (
    await store.putPrivate(
      key.tenant,
      key.source,
      connection.credential_version!,
      "credential",
      {
        key: "browser:reconciliation-fixture",
        token: "fixture",
        secret: "fixture",
      },
    )
  ).run();
  const stamp = Date.now();
  const proof = await mintFixtureSourceProofs(store, {
    source: (await store.connection(key.tenant, key.source))!,
    qsos: [
      {
        uuid: key.qso,
        operation: "op1",
        startAtMillis: Date.parse("2026-10-22T12:00:01Z"),
        band: "20m",
        mode: "CW",
        their: { call },
        syncedAtMillis: stamp,
      },
    ],
    operations: [
      {
        uuid: "op1",
        stationCall: "N0TEST/P",
        grid: "FN31",
        syncedAtMillis: stamp,
      },
    ],
    destinations: [(await store.connection(key.tenant, key.destination))!],
  });
  await store
    .statement(
      "UPDATE ledger SET due_at=0 WHERE tenant=? AND source=? AND qso=? AND destination=?",
      key.tenant,
      key.source,
      key.qso,
      key.destination,
    )
    .run();
  return {
    generation: proof.snapshots[0]!.contact.generation,
    authorization: proof.authorizations[0]!,
    now: Date.now(),
  };
}
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
test("adoption loads its tenant-bound ledger and destination in one RPC", async () => {
  const h = await reconciliationDatabase();
  try {
    const key = await seed(h.store);
    const foreign = await seed(h.store, "b");
    await h.store.observe(key, "g1", "hash", 30);
    await h.store.observe(foreign, "g1", "foreign-hash", 30);
    await h.store
      .statement(
        "UPDATE connections SET kind='lotw' WHERE tenant='b' AND id='destination'",
      )
      .run();
    const measured = measuredDatabase(h.db);
    const store = new Store(measured.database, h.store.keys);
    const outcome = classifyHistory(source, [remote], evidence);
    const result = await adoptHistory(store, key, "g1", outcome);
    assert.equal(result.applied, true);
    assert.equal(measured.metrics.calls, 2);
    assert.equal((await h.store.ledger(key))?.remote_id, "100");
    assert.equal((await h.store.ledger(foreign))?.remote_id, null);
    assert.equal(
      (await adoptHistory(store, foreign, "g1", outcome)).reason,
      "tenant_or_destination_missing",
    );
    assert.equal(
      (await adoptHistory(store, { ...key, source: "missing" }, "g1", outcome))
        .reason,
      "tenant_or_destination_missing",
    );
  } finally {
    await h.mf.dispose();
  }
});

test("single adoption cannot clear a mapping established after its metadata read", async () => {
  const h = await reconciliationDatabase();
  try {
    const key = await seed(h.store);
    await h.store.observe(key, "g1", "hash", 30);
    let before: Awaited<ReturnType<Store["ledger"]>> = null;
    const db = new Proxy(h.db, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            await h.store
              .statement(
                "UPDATE ledger SET remote_id='concurrent-mapping',state='adopted_existing',provenance='adopted',baseline_hash=source_hash WHERE tenant='a' AND source='source' AND qso='q1'",
              )
              .run();
            before = await h.store.ledger(key);
            return target.batch(statements);
          };
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    const outcome = classifyHistory(source, [], {
      ...evidence,
      inventoryComplete: false,
    });
    const result = await adoptHistory(
      new Store(db, h.store.keys),
      key,
      "g1",
      outcome,
    );
    assert.equal(result.applied, false);
    assert.deepEqual(await h.store.ledger(key), before);
  } finally {
    await h.mf.dispose();
  }
});

test("forty route outcomes use seven bounded metadata, commit and completion RPCs", async () => {
  const h = await reconciliationDatabase();
  try {
    await seed(h.store);
    const foreign = await seed(h.store, "b");
    await h.store.observe(foreign, "g1", "foreign", 30);
    await h.store
      .statement(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,config,created_at) VALUES('a','lotw','lotw','synthetic-lotw','LoTW','active','{}',0)",
      )
      .run();
    const now = Date.now();
    const requests: { qso: string; destination: string; generation: string }[] =
      [];
    for (let index = 0; index < 20; index++) {
      const qso = `batch-${index}`;
      await h.store
        .statement(
          "INSERT INTO source_work(tenant,source,id,kind,private_id,revision,expires_at) VALUES('a','source',?,'qso',?,'r1',?)",
          qso,
          qso,
          now + 86_400_000,
        )
        .run();
      for (const destination of ["destination", "lotw"]) {
        requests.push({ qso, destination, generation: "g1" });
        await h.store.observe(
          { tenant: "a", source: "source", qso, destination },
          "g1",
          "hash",
          30,
        );
      }
    }
    const measured = measuredDatabase(h.db);
    const store = new Store(measured.database, h.store.keys);
    const sourceKey = { tenant: "a", id: "source" };
    const ledgers = await reconciliationPreflightBatch(
      store,
      sourceKey,
      requests,
      now,
    );
    assert.equal(ledgers.length, 40);
    assert.equal(measured.metrics.calls, 1);
    const items: HistoryAdoptionInput[] = ledgers.map((ledger) => ({
      key: ledger,
      generation: "g1",
      ledger,
      outcome: classifyHistory(source, [], {
        ...evidence,
        destination: ledger.destination_kind as "qrz" | "lotw",
        inventoryComplete: false,
      }),
      commitGuard: () => ({ sql: "1", params: [] }),
    }));
    const results = await adoptHistoryBatch(store, sourceKey, items, () => now);
    assert(results.every((result) => result.applied));
    assert.equal(measured.metrics.calls, 6);
    const completion: D1PreparedStatement[] = [];
    for (const item of items) {
      const memo = reconciliationCheckStatement(
        store,
        item.key,
        "g1",
        item.outcome,
        now,
        1,
      );
      assert(memo);
      completion.push(memo);
    }
    for (let index = 0; index < 20; index++) {
      const qso = `batch-${index}`;
      completion.push(
        store.statement(
          "UPDATE source_work SET state='waiting',processed_at=? WHERE tenant='a' AND source='source' AND id=? AND EXISTS(SELECT 1 FROM reconciliation_work WHERE tenant='a' AND source='source' AND qso=? AND version=1)",
          now,
          qso,
          qso,
        ),
      );
      const finish = finishReconciliationWorkStatement(
        store,
        sourceKey,
        qso,
        1,
        now,
      );
      assert(finish);
      completion.push(finish);
    }
    const completed = await store.db.batch(completion);
    assert.equal(completion.length, 80);
    assert.equal(
      completed.slice(0, 40).filter((row) => row.results.length === 1).length,
      40,
    );
    assert.equal(measured.metrics.calls, 7);
    assert.equal((await h.store.ledger(foreign))?.source_hash, "foreign");
    assert.equal(
      (
        await h.store
          .statement("SELECT COUNT(*) n FROM history_adoption_guards")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    assert.equal(
      (
        await h.store
          .statement("SELECT COUNT(*) n FROM attempts")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    await assert.rejects(
      () =>
        reconciliationPreflightBatch(
          store,
          sourceKey,
          [...requests, requests[0]!],
          now,
        ),
      /reconciliation_batch_too_large/,
    );
    await assert.rejects(
      () => adoptHistoryBatch(store, sourceKey, [...items, items[0]!]),
      /reconciliation_batch_too_large/,
    );
    await assert.rejects(
      () => adoptHistoryBatch(store, sourceKey, [items[0]!, items[0]!]),
      /duplicate_reconciliation_route/,
    );
    await assert.rejects(
      () => adoptHistoryBatch(store, { tenant: "b", id: "source" }, items),
      /invalid_reconciliation_scope/,
    );
    assert.equal(measured.metrics.calls, 7);
  } finally {
    await h.mf.dispose();
  }
});

test("batched adoption quarantines same-chunk and cross-chunk duplicate claims atomically", async () => {
  for (const destination of ["qrz", "lotw"] as const) {
    for (const collision of [1, 8]) {
      const h = await reconciliationDatabase();
      try {
        const key = await seed(h.store);
        await h.store
          .statement(
            "UPDATE connections SET kind=? WHERE tenant='a' AND id='destination'",
            destination,
          )
          .run();
        const requests = [];
        for (let index = 0; index <= Math.max(collision, 2); index++) {
          const qso = `collision-${index}`;
          requests.push({
            qso,
            destination: key.destination,
            generation: "g1",
          });
          await h.store.observe({ ...key, qso }, "g1", "hash", 30);
        }
        // Direct snapshots exercise collision behavior independently of selection.
        const ledgers = (
          await h.store
            .statement(
              "SELECT l.*,d.kind AS destination_kind FROM ledger l JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination WHERE l.tenant='a' ORDER BY l.qso",
            )
            .all<HistoryAdoptionInput["ledger"]>()
        ).results;
        const commitTimes: number[] = [];
        const items: HistoryAdoptionInput[] = ledgers.map((ledger, index) => {
          const call = index === collision ? source.CALL : `K1B${index}`;
          const record = { ...source, CALL: call };
          const ownerRecord = { ...source, CALL: "K1B0" };
          const current = index === collision ? ownerRecord : record;
          return {
            key: ledger,
            ledger,
            generation: "g1",
            outcome: classifyHistory(
              current,
              [
                {
                  ...current,
                  APP_QRZLOG_LOGID:
                    index === collision ? "100" : String(100 + index),
                },
              ],
              { ...evidence, destination },
            ),
            commitGuard: (now) => {
              commitTimes.push(now);
              return { sql: "1", params: [] };
            },
          };
        });
        if (destination === "lotw") await maintainOwnership(h.store);
        const began = Date.now();
        let commitTime = began;
        const results = await adoptHistoryBatch(
          h.store,
          { tenant: "a", id: "source" },
          items,
          () => ++commitTime,
        );
        assert.deepEqual(
          commitTimes,
          items.map((_, index) => began + Math.floor(index / 8) + 1),
        );
        const prospective = destination === "lotw" && collision === 1;
        assert.equal(
          results[collision]?.reason,
          prospective
            ? "lotw_ownership_unavailable"
            : "remote_identity_claim_conflict",
        );
        assert.equal(
          results[2]?.applied,
          true,
          "a fitting mapping neighbor keeps its independent authority",
        );
        for (const index of [0, collision]) {
          const row = await h.store.ledger({
            ...key,
            qso: `collision-${index}`,
          });
          if (prospective) {
            assert.equal(row?.remote_id, null);
            assert.notEqual(row?.provenance, "adopted");
          } else {
            assert.equal(row?.provenance, "adoption_conflict");
            assert.equal(row?.state, "history_ambiguous");
            assert.equal(row?.reason, ADOPTION_CONFLICT_REASON);
            assert.equal(row?.remote_id === null, index === collision);
          }
        }
        if (destination === "lotw") {
          assert.equal(
            (await h.store.lotwIdentities({ ...key, qso: "collision-0" }))
              .length,
            prospective ? 0 : 1,
          );
          assert.equal(
            (
              await h.store.lotwIdentities({
                ...key,
                qso: `collision-${collision}`,
              })
            ).length,
            0,
          );
        }
        assert.equal(
          (
            await h.store
              .statement("SELECT COUNT(*) n FROM history_adoption_guards")
              .first<{ n: number }>()
          )?.n,
          0,
        );
      } finally {
        await h.mf.dispose();
      }
    }
  }
});

test("batched adoption rejects stale proofs and snapshots without blocking valid neighbors", async () => {
  const h = await reconciliationDatabase();
  try {
    const key = await seed(h.store);
    const names = ["mapped", "changed", "generation", "proof", "valid"];
    for (const qso of names)
      await h.store.observe({ ...key, qso }, "g1", "hash", 30);
    const ledgers = (
      await h.store
        .statement(
          "SELECT l.*,d.kind AS destination_kind FROM ledger l JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination WHERE l.tenant='a' ORDER BY l.qso",
        )
        .all<HistoryAdoptionInput["ledger"]>()
    ).results;
    const outcome = classifyHistory(source, [remote], evidence);
    const items: HistoryAdoptionInput[] = ledgers.map((ledger) => ({
      key: ledger,
      ledger,
      generation: "g1",
      outcome,
      commitGuard: () => ({
        sql: ledger.qso === "proof" ? "0" : "1",
        params: [],
      }),
    }));
    await h.store
      .statement(
        "UPDATE ledger SET remote_id='trusted-concurrent',provenance='adopted' WHERE qso='mapped'",
      )
      .run();
    await h.store
      .statement("UPDATE ledger SET state='changed' WHERE qso='changed'")
      .run();
    await h.store
      .statement("UPDATE ledger SET generation='g2' WHERE qso='generation'")
      .run();
    const results = await adoptHistoryBatch(
      h.store,
      { tenant: "a", id: "source" },
      items,
    );
    assert.equal(results.filter((result) => result.applied).length, 1);
    assert.equal(
      (await h.store.ledger({ ...key, qso: "valid" }))?.remote_id,
      "100",
    );
    assert.equal(
      (await h.store.ledger({ ...key, qso: "mapped" }))?.remote_id,
      "trusted-concurrent",
    );
    assert.equal(
      (await h.store.ledger({ ...key, qso: "changed" }))?.state,
      "changed",
    );
    assert.equal(
      (await h.store.ledger({ ...key, qso: "generation" }))?.generation,
      "g2",
    );
    assert.equal(
      (await h.store.ledger({ ...key, qso: "proof" }))?.remote_id,
      null,
    );
    assert.equal(
      (
        await h.store
          .statement("SELECT COUNT(*) n FROM history_adoption_guards")
          .first<{ n: number }>()
      )?.n,
      0,
    );
  } finally {
    await h.mf.dispose();
  }
});
test("fractional source times adopt only a unique seconds projection and cannot share one remote claim", async () => {
  for (const destination of ["qrz", "lotw"] as const) {
    const { mf, store } = await reconciliationDatabase();
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
        if (destination === "lotw") await maintainOwnership(store);
        assert.equal(
          (
            await adoptHistory(
              store,
              key,
              contact.generation,
              outcome,
              Date.now(),
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
  const { mf, store } = await reconciliationDatabase();
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
    await maintainOwnership(store);
    const adoptedAt = Date.now();
    assert((await adoptHistory(store, key, "g1", outcome, adoptedAt)).applied);
    const identities = await store.lotwIdentities(key);
    assert.equal(identities.length, 1);
    assert.deepEqual(identities[0]!.identity, canonicalLotwIdentity(source));
    assert.equal(identities[0]!.remoteId, await lotwRemoteIdentity(source));
    assert.equal(identities[0]!.firstEvidence, "adopted");
    assert.equal(identities[0]!.recordedAt, adoptedAt);
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
    const proof = await reconciliationStageProof(store, key, "W2NEW");
    const payload = {
      kind: "lotw",
      station: { callsign: source.STATION_CALLSIGN },
      contact: {
        call: "W2NEW",
        date: "2026-10-22",
        time: "12:00:01Z",
        band: source.BAND,
        mode: source.MODE,
      },
      tq8: "fixture signed bytes",
    };
    const attempt = await store.stage(
      key,
      proof.generation,
      payload,
      "v1",
      null,
      proof.now,
      "next-projection",
      nextIdentity.remoteId,
      undefined,
      {
        claim: await destinationIdentityClaim("lotw", next),
        sourceVersion: proof.authorization.reconciliationVersion,
      },
      proof.authorization,
    );
    assert.equal((await store.ledger(key))!.confirmed, 0);
    const lease = (await store.claim(
      "a",
      "delivery:destination",
      proof.now + 1,
      120000,
    ))!;
    const ownership = await renewAttemptLotwOwnership(
      store,
      "a",
      attempt,
      payload,
    );
    try {
      assert(
        await store.claimAttempt(
          "a",
          attempt,
          lease,
          proof.now + 2,
          nextIdentity,
          { payload, lease: ownership.lease },
        ),
      );
    } finally {
      await store.release(ownership.lease);
    }
    await store.resolve(
      "a",
      attempt,
      lease,
      "submitted",
      null,
      proof.now + 3,
      nextIdentity,
    );
    assert(
      await store.resolveReconciled(
        "a",
        attempt,
        lease,
        nextIdentity.remoteId,
        proof.now + 4,
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
      (await adoptHistory(store, conflicting, "g1", outcome, proof.now + 5))
        .applied,
      false,
      "retained old identity stays associated with the original UUID after current mapping moves",
    );
    assert.equal((await store.ledger(conflicting))!.remote_id, null);
    assert.equal((await store.ledger(conflicting))!.state, "history_ambiguous");
    assert.deepEqual(await store.ledger(key), trustedOwner);
    assert.deepEqual(await store.lotwIdentities(conflicting), []);
    const otherTenant = { ...key, tenant: "b" };
    await store.observe(otherTenant, "g1", "other-tenant-input", 30, false, 0);
    await maintainOwnership(store, "b");
    assert(
      (await adoptHistory(store, otherTenant, "g1", outcome, proof.now + 6))
        .applied,
      "retained identity claims remain tenant isolated",
    );
  } finally {
    await mf.dispose();
  }
});
test("D1 adoption preserves narrative policy without a fabricated delivery or signing attempt", async () => {
  const { mf, store } = await reconciliationDatabase();
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
  const { mf, store } = await reconciliationDatabase();
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
  const { mf, store } = await reconciliationDatabase();
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
    const { mf, store } = await reconciliationDatabase();
    try {
      const owner = await seed(store);
      const contender = { ...owner, qso: "contender" };
      const outcome = classifyHistory(source, [remote], evidence);
      await store.observe(owner, "g1", "original-source", 30, false, 0);
      assert((await adoptHistory(store, owner, "g1", outcome, 1)).applied);
      await store.observe(owner, "g2", "corrected-source", 30, false, 10);
      const proof = await reconciliationStageProof(store, owner, source.CALL);
      const attempt = await store.stage(
        owner,
        proof.generation,
        { fixture: "correction" },
        "v1",
        null,
        proof.now,
        "sent-projection",
        undefined,
        undefined,
        {
          claim: await destinationIdentityClaim("qrz", source),
          sourceVersion: proof.authorization.reconciliationVersion,
        },
        proof.authorization,
      );
      if (state !== "prepared") {
        const lease = (await store.claim(
          "a",
          "delivery:destination",
          proof.now + 1,
          120000,
        ))!;
        assert(await store.claimAttempt("a", attempt, lease, proof.now + 2));
        if (state !== "dispatching")
          await store.resolve(
            "a",
            attempt,
            lease,
            state,
            state === "delivered" ? "100" : null,
            proof.now + 3,
          );
      }
      const ownerBefore = (await store.ledger(owner))!;
      const attemptBefore = await store
        .statement("SELECT * FROM attempt_state WHERE attempt=?", attempt)
        .first();
      await store.observe(contender, "g1", "contender-source", 30, false, 10);
      assert.equal(
        (await adoptHistory(store, contender, "g1", outcome, proof.now + 4))
          .reason,
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
          updated_at: proof.now + 4,
        });
        assert.deepEqual(attemptAfter, {
          ...attemptBefore,
          state: "cancelled",
          reason: ADOPTION_CONFLICT_REASON,
          updated_at: proof.now + 4,
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
          proof.now + 5,
          120000,
        ))!;
        assert.equal(
          await store.claimAttempt("a", attempt, lease, proof.now + 6),
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
  const { mf, store } = await reconciliationDatabase();
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
    const proof = await reconciliationStageProof(store, contender, "W2AW");
    await store
      .statement(
        "UPDATE ledger SET state='missing_current_identity',narrative='remote_preserved' WHERE qso='contender'",
      )
      .run();
    const attempt = await store.stage(
      contender,
      proof.generation,
      { fixture: "unsent" },
      "v1",
      null,
      proof.now,
      undefined,
      undefined,
      undefined,
      {
        claim: await destinationIdentityClaim("qrz", {
          ...source,
          CALL: "W2AW",
        }),
        sourceVersion: proof.authorization.reconciliationVersion,
      },
      proof.authorization,
    );
    const ownerBefore = await store.ledger(owner);
    const contenderBefore = await store.ledger(contender);
    assert.equal(
      (
        await adoptHistory(
          store,
          contender,
          proof.generation,
          {
            ...outcome,
            evidence: {
              ...outcome.evidence,
              capturedGeneration: proof.generation,
              currentGeneration: proof.generation,
            },
          },
          proof.now + 1,
        )
      ).reason,
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
  const { mf, store } = await reconciliationDatabase();
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
    const proof = await reconciliationStageProof(store, first, source.CALL);
    await store
      .statement("UPDATE ledger SET state='missing_current_identity'")
      .run();
    const payload = {
      kind: "lotw",
      station: { callsign: source.STATION_CALLSIGN },
      contact: {
        call: source.CALL,
        date: "2026-10-22",
        time: "12:00:01Z",
        band: source.BAND,
        mode: source.MODE,
      },
      tq8: "fixture signed bytes",
    };
    const retained = {
      remoteId: await lotwRemoteIdentity(lotwRemote),
      identity: canonicalLotwIdentity(lotwRemote),
    };
    const id = await store.stage(
      first,
      proof.generation,
      payload,
      "v1",
      null,
      proof.now,
      undefined,
      undefined,
      undefined,
      {
        claim: await destinationIdentityClaim("lotw", lotwRemote),
        sourceVersion: proof.authorization.reconciliationVersion,
      },
      proof.authorization,
    );
    const lease = (await store.claim(
      "a",
      "delivery:destination",
      proof.now,
      120000,
    ))!;
    const ownership = await renewAttemptLotwOwnership(
      store,
      "a",
      id,
      payload,
      proof.now + 1,
    );
    try {
      assert(
        await store.claimAttempt("a", id, lease, proof.now + 1, retained, {
          payload,
          lease: ownership.lease,
        }),
      );
    } finally {
      await store.release(ownership.lease);
    }
    await store.resolve(
      "a",
      id,
      lease,
      "uncertain",
      null,
      proof.now + 2,
      retained,
    );
    const identity = await lotwRemoteIdentity(lotwRemote);
    assert(
      await store.resolveReconciled("a", id, lease, identity, proof.now + 3, {
        identity: retained,
        confirmed: false,
        data: { fixture: "exact observed receipt" },
      }),
    );
    const second = { ...first, qso: "q2" };
    await store.observe(second, "g1", "h2", 30, false, 0);
    await maintainOwnership(store);
    const outcome = classifyHistory(source, [lotwRemote], {
      ...evidence,
      destination: "lotw",
    });
    assert.equal(outcome.state, "adopted_existing");
    assert.equal(
      (await adoptHistory(store, second, "g1", outcome, proof.now + 4)).applied,
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
test("LoTW historical association accepts nested grid regions in either direction without changing records", () => {
  const scope = { ...evidence, destination: "lotw" as const };
  for (const [localGrid, remoteGrid] of [
    ["FN31PR12", "FN31PR"],
    ["FN31PR12", "FN31"],
    ["FN31PR", "FN31"],
    ["FN31PR", "FN31PR12"],
    ["FN31", "FN31PR12"],
    ["FN31", "FN31PR"],
    ["fn31pr12", "fn31pr"],
    ["fn31", "fn31pr12"],
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
    assert.equal(outcome.state, "adopted_existing");
    assert.equal(outcome.reason, null);
    assert.equal(outcome.remote, candidate);
    assert.equal(current.MY_GRIDSQUARE, localGrid);
    assert.equal(candidate.MY_GRIDSQUARE, remoteGrid);
  }
  const current = { ...source, MY_GRIDSQUARE: "FN31PR12" };
  const candidate = { ...remote, MY_GRIDSQUARE: "FN31PR" };
  assert.equal(
    classifyHistory(current, [candidate], evidence).state,
    "adopted_existing",
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
test("LoTW grid association requires valid nested regions and agreement on every other comparison", () => {
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
    [current, [{ ...candidate, MY_GRIDSQUARE: "F" }], "history_mismatch"],
    [
      current,
      [{ ...candidate, MY_GRIDSQUARE: "FN31PR\n" }],
      "history_mismatch",
    ],
    [current, [{ ...candidate, MY_GRIDSQUARE: "" }], "history_ambiguous"],
    [{ ...current, MY_GRIDSQUARE: "FN31PR1" }, [candidate], "history_mismatch"],
    [
      { ...current, MY_GRIDSQUARE: "FN31PRAB" },
      [candidate],
      "history_mismatch",
    ],
    [
      { ...current, MY_GRIDSQUARE: "FN31PR12\n" },
      [candidate],
      "history_mismatch",
    ],
    [
      { ...current, MY_GRIDSQUARE: "", MY_STATE: "" },
      [candidate],
      "history_ambiguous",
    ],
    [current, [{ ...candidate, FREQ: "14.075" }], "history_mismatch"],
    [current, [{ ...candidate, FREQ: "" }], "history_ambiguous"],
    [current, [{ ...candidate, MY_STATE: "NY" }], "history_mismatch"],
    [current, [{ ...candidate, MODE: "SSB" }], "history_ambiguous"],
    [current, [{ ...candidate, TIME_ON: "1200" }], "history_ambiguous"],
    [
      { ...current, TIME_ON: "1200" },
      [{ ...candidate, TIME_ON: "1200" }],
      "history_mismatch",
    ],
    [
      { ...current, TIME_ON: "240000" },
      [{ ...candidate, TIME_ON: "240000" }],
      "history_mismatch",
    ],
    [current, [candidate, candidate], "history_ambiguous"],
  ] as const) {
    const outcome = classifyHistory(expected, [...candidates], scope);
    assert.equal(outcome.state, state);
    assert.equal(outcome.remote, undefined);
  }
});
test("historical grid subsets include valid two-character fields for both destinations without rewriting evidence", () => {
  for (const destination of ["qrz", "lotw"] as const)
    for (const [localGrid, remoteGrid] of [
      ["FN31PR12", "FN"],
      ["FN31PR", "FN"],
      ["FN31", "FN"],
      ["FN", "FN31PR12"],
      ["FN", "FN31PR"],
      ["FN", "FN31"],
      ["FN31PR12", "FN31"],
      ["FN31PR12", "FN31PR"],
      ["FN31PR", "FN31"],
      ["fn31pr12", "fn"],
      ["fn", "fn31pr12"],
    ]) {
      const current = Object.freeze({ ...source, MY_GRIDSQUARE: localGrid });
      const candidate = Object.freeze({ ...remote, MY_GRIDSQUARE: remoteGrid });
      const outcome = classifyHistory(current, [candidate], {
        ...evidence,
        destination,
      });
      assert.equal(outcome.state, "adopted_existing");
      assert.equal(outcome.reason, null);
      assert.equal(outcome.remote, candidate);
      assert.equal(current.MY_GRIDSQUARE, localGrid);
      assert.equal(candidate.MY_GRIDSQUARE, remoteGrid);
      assert.equal(candidate.COMMENT, remote.COMMENT);
      assert.equal(
        reconcileQrzAttempt(current, [candidate]).state,
        "unresolved",
      );
    }
});
test("historical nested-grid compatibility rejects invalid lengths and non-ASCII input", () => {
  for (const invalid of [
    undefined,
    "",
    "F",
    "FN3",
    "FN31P",
    "FN31PR1",
    "FN31PR123",
    "FN31PR1234",
    "SN",
    "FN31PY",
    "FN31PRAB",
    "FN\n",
    "FN31PR\n",
    "ＦＮ",
    "FN31Pſ",
    " FN",
    "FN ",
    "FN31PR12\u0000",
  ]) {
    assert.equal(historicalGridsCompatible("FN31PR12", invalid), false);
    assert.equal(historicalGridsCompatible(invalid, "FN31PR12"), false);
  }
  assert.equal(historicalGridsCompatible("FN31PR12", "FM"), false);
  assert.equal(historicalGridsCompatible("FN31PR12", "FN32"), false);
  assert.equal(historicalGridsCompatible("FN31PR12", "FN31PS"), false);
  for (const destination of ["qrz", "lotw"] as const)
    for (const grid of ["F", "FN3", "FN31Pſ", "ＦＮ", "FM", "FN32", "FN31PS"]) {
      const outcome = classifyHistory(
        { ...source, MY_GRIDSQUARE: "FN31PR12" },
        [{ ...remote, MY_GRIDSQUARE: grid }],
        { ...evidence, destination },
      );
      assert.equal(outcome.state, "history_mismatch");
      assert.equal(outcome.remote, undefined);
    }
});
test("QRZ nested-grid association retains exact time, unique identity, LOGID and other-field requirements", () => {
  const current = {
    ...source,
    MY_GRIDSQUARE: "FN31PR12",
    MY_STATE: "CT",
    FREQ: "14.074",
  };
  const candidate = {
    ...remote,
    MY_GRIDSQUARE: "FN",
    MY_STATE: "CT",
    FREQ: "14.074",
  };
  const neighbor = { ...candidate, TIME_ON: "120002", APP_QRZLOG_LOGID: "101" };
  assert.equal(
    classifyHistory(current, [neighbor, candidate], evidence).remote,
    candidate,
  );
  for (const [expected, candidates, state] of [
    [
      current,
      [candidate, { ...candidate, APP_QRZLOG_LOGID: "101" }],
      "history_ambiguous",
    ],
    [current, [{ ...candidate, APP_QRZLOG_LOGID: "" }], "history_ambiguous"],
    [
      current,
      [{ ...candidate, APP_QRZLOG_LOGID: "invalid" }],
      "history_ambiguous",
    ],
    [current, [{ ...candidate, TIME_ON: "1200" }], "history_ambiguous"],
    [
      { ...current, TIME_ON: "1200" },
      [{ ...candidate, TIME_ON: "1200" }],
      "history_mismatch",
    ],
    [
      { ...current, TIME_ON: "240000" },
      [{ ...candidate, TIME_ON: "240000" }],
      "history_mismatch",
    ],
    [current, [{ ...candidate, MODE: "SSB" }], "history_ambiguous"],
    [current, [{ ...candidate, MY_STATE: "NY" }], "history_mismatch"],
    [current, [{ ...candidate, MY_STATE: "" }], "history_mismatch"],
    [current, [{ ...candidate, FREQ: "14.075" }], "history_mismatch"],
    [current, [{ ...candidate, FREQ: "" }], "history_ambiguous"],
    [
      { ...current, MY_DXCC: "291" },
      [{ ...candidate, MY_DXCC: "1" }],
      "history_mismatch",
    ],
  ] as const) {
    const outcome = classifyHistory(expected, [...candidates], evidence);
    assert.equal(outcome.state, state);
    assert.equal(outcome.remote, undefined);
  }
  const { APP_QRZLOG_LOGID: _logId, ...withoutLogId } = candidate;
  const missingId = classifyHistory(current, [withoutLogId], evidence);
  assert.equal(missingId.state, "history_ambiguous");
  assert.equal(missingId.reason, "Matched QRZ record has no verified LOGID");
});
test("LoTW grid association ignores unrelated neighbors but requires one exact normalized identity", () => {
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
    assert.equal(outcome.state, "adopted_existing");
    assert.equal(outcome.reason, null);
    assert.equal(outcome.remote, candidate);
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
test("LoTW historical grid association does not relax exact upload receipt verification", () => {
  for (const [localGrid, remoteGrid] of [
    ["FN31PR12", "FN31PR"],
    ["FN31", "FN31PR12"],
  ]) {
    const current = { ...source, MY_GRIDSQUARE: localGrid, MY_DXCC: "291" };
    const candidate = {
      ...remote,
      MY_GRIDSQUARE: remoteGrid,
      MY_DXCC: "291",
      QSL_RCVD: "Y",
    };
    assert.equal(
      classifyHistory(current, [candidate], {
        ...evidence,
        destination: "lotw",
      }).state,
      "adopted_existing",
    );
    const observation = observeLotwContact(
      { callsign: source.STATION_CALLSIGN, dxcc: 291, grid: localGrid },
      {
        id: "q1",
        generation: "g1",
        call: source.CALL,
        date: "2026-10-22",
        time: "12:00:01Z",
        band: source.BAND,
        mode: source.MODE,
      },
      { records: [candidate], receivedThrough: null, complete: true },
    );
    assert.equal(observation.state, "projection_mismatch");
    assert.deepEqual(observation.differingFields, ["MY_GRIDSQUARE"]);
  }
});
test("QRZ grid association persists original evidence and quarantines competing owners without attempts", async () => {
  const { mf, store } = await reconciliationDatabase();
  try {
    const first = await seed(store);
    const candidate = Object.freeze({ ...remote, MY_GRIDSQUARE: "FN" });
    for (const [index, grid] of ["FN31PR12", "FN31PR34"].entries()) {
      const key = { ...first, qso: `grid-${index}` };
      const current = Object.freeze({ ...source, MY_GRIDSQUARE: grid });
      const fingerprint = await sha256(canonical(current));
      await store.observe(key, "g1", fingerprint, 30, false, 0);
      const outcome = classifyHistory(current, [candidate], evidence);
      assert.equal(outcome.state, "adopted_existing");
      assert.equal(outcome.remote, candidate);
      const result = await adoptHistory(store, key, "g1", outcome, 1);
      assert.equal(result.applied, index === 0);
      assert.equal(current.MY_GRIDSQUARE, grid);
      assert.equal(candidate.MY_GRIDSQUARE, "FN");
      if (index === 0) {
        const ledger = (await store.ledger(key))!;
        assert.equal(ledger.remote_id, "100");
        assert.equal(ledger.source_hash, fingerprint);
        assert.equal(ledger.baseline_hash, fingerprint);
        assert.equal(ledger.narrative, "remote_preserved");
        assert.equal(
          ledger.remote_hash,
          await sha256(canonical(comparableRemote(candidate))),
        );
        assert.equal(ledger.sent_hash, null);
        assert.equal(
          (await store
            .statement(
              "SELECT COUNT(*) n FROM legacy_qrz_identity_reservations",
            )
            .first<{ n: number }>())!.n,
          0,
        );
      } else {
        assert.equal(result.reason, "remote_identity_claim_conflict");
      }
    }
    for (const qso of ["grid-0", "grid-1"]) {
      const ledger = (await store.ledger({ ...first, qso }))!;
      assert.equal(ledger.provenance, "adoption_conflict");
      assert.equal(ledger.state, "history_ambiguous");
      assert.equal(ledger.sent_hash, null);
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
test("LoTW grid association retains exact source and remote evidence and quarantines competing owners", async () => {
  const { mf, store } = await reconciliationDatabase();
  try {
    const first = await seed(store);
    await store
      .statement("UPDATE connections SET kind='lotw' WHERE id='destination'")
      .run();
    const contacts = await Promise.all(
      ["FN31PR12", "FN31PR34"].map((grid, index) =>
        projectContact(
          {
            uuid: `q${index + 1}`,
            operation: null,
            startAtMillis: Date.parse("2026-10-22T12:00:01Z"),
            band: "20m",
            mode: "CW",
            their: { call: "W1AW" },
            our: { stationCall: "N0TEST/P", grid },
          },
          null,
        ),
      ),
    );
    const remoteRecord = Object.freeze({
      ...contactReconciliationAdif(contacts[0]!),
      MY_GRIDSQUARE: "FN31PR",
      QSL_RCVD: "Y",
    });
    for (const [index, contact] of contacts.entries()) {
      const key = { ...first, qso: contact.id };
      const projected = Object.freeze(contactReconciliationAdif(contact));
      const fingerprint = await sourceFingerprint(contact, "lotw");
      const outcome = classifyHistory(projected, [remoteRecord], {
        ...evidence,
        destination: "lotw",
        capturedGeneration: contact.generation,
        currentGeneration: contact.generation,
      });
      assert.equal(outcome.state, "adopted_existing");
      assert.equal(outcome.remote, remoteRecord);
      await store.observe(key, contact.generation, fingerprint, 30, false, 0);
      await maintainOwnership(store);
      const result = await adoptHistory(
        store,
        key,
        contact.generation,
        outcome,
        Date.now(),
      );
      assert.equal(result.applied, index === 0);
      assert.equal(projected.MY_GRIDSQUARE, contact.grid);
      assert.equal(remoteRecord.MY_GRIDSQUARE, "FN31PR");
      if (index === 0) {
        const ledger = (await store.ledger(key))!;
        assert.equal(ledger.state, "adopted_existing");
        assert.equal(ledger.provenance, "adopted");
        assert.equal(ledger.source_hash, fingerprint);
        assert.equal(ledger.baseline_hash, fingerprint);
        assert.equal(ledger.sent_hash, null);
        assert.equal(ledger.template_version, null);
        assert.equal(ledger.confirmed, 1);
        assert.equal(ledger.remote_id, await lotwRemoteIdentity(remoteRecord));
        assert.equal(
          ledger.remote_hash,
          await sha256(canonical(comparableRemote(remoteRecord))),
        );
        assert.deepEqual(
          (await store.lotwIdentities(key))[0]!.identity,
          canonicalLotwIdentity(remoteRecord),
        );
        assert.equal(
          (
            await prepareDue(
              store,
              key,
              contact,
              {
                exportsEnabled: true,
                liveWriteAuthorized: true,
                sourceBoundaryVerified: true,
              },
              {
                now: 1800001,
                fetcher: async () =>
                  assert.fail("adoption made a vendor request"),
                sign: async () => assert.fail("adoption signed an upload"),
              },
            )
          ).reason,
          "not_due_or_current",
        );
      } else {
        assert.equal(result.reason, "remote_identity_claim_conflict");
        assert.deepEqual(await store.lotwIdentities(key), []);
      }
    }
    for (const contact of contacts) {
      const ledger = (await store.ledger({ ...first, qso: contact.id }))!;
      assert.equal(ledger.state, "history_ambiguous");
      assert.equal(ledger.provenance, "adoption_conflict");
      assert.equal(ledger.reason, ADOPTION_CONFLICT_REASON);
      assert.equal(ledger.sent_hash, null);
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
test("unverifiable precision outcomes persist as holds without a remote association or an attempt", async () => {
  const { mf, store } = await reconciliationDatabase();
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
      const current = {
        ...source,
        MY_GRIDSQUARE: "FN31PR12",
        ...(destination === "lotw" ? { FREQ: "14.074001" } : {}),
      };
      const candidate =
        destination === "qrz"
          ? { ...remote, MY_GRIDSQUARE: "FN31PR12", TIME_ON: "1200" }
          : { ...remote, MY_GRIDSQUARE: "FN31PR", FREQ: "14.07400" };
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
  const { mf, store } = await reconciliationDatabase();
  try {
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
