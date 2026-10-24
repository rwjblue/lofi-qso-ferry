import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import {
  contactReconciliationAdif,
  type DeliveryGates,
  dispatchAttempt,
  prepareDue,
  reconcileAttempt,
} from "../src/delivery.ts";
import {
  backfillLotwOwnership,
  lookupLotwOwnership,
} from "../src/lotw-ownership.ts";
import {
  attemptLotwOwnershipCurrent,
  attemptLotwOwnershipWrite,
  lotwPayloadIdentity,
  prepareLotwOwnershipBatch,
  renewAttemptLotwOwnership,
} from "../src/lotw-ownership-bridge.ts";
import {
  adoptHistoryBatch,
  canonicalLotwIdentity,
  classifyHistory,
  type HistoryAdoptionInput,
  lotwRemoteIdentity,
} from "../src/reconcile.ts";
import { tick } from "../src/service.ts";
import { type StageInput, Store } from "../src/store.ts";
import { applyMigration, database, seed } from "./helpers.ts";
import { schedulerFixture } from "./runtime-fixtures.ts";
import { mintFixtureSourceProofs } from "./source-proof-fixtures.ts";

const gates: DeliveryGates = {
  exportsEnabled: true,
  liveWriteAuthorized: true,
  sourceBoundaryVerified: false,
  lotwFreshInsertsEnabled: true,
  allowedQsoIds: ["q1"],
  allowedDestinationIds: ["lotw"],
};
async function fixture(t: TestContext, count = 1, alias = false) {
  t.mock.method(globalThis, "fetch", async () =>
    assert.fail("unmocked network"),
  );
  const h = await schedulerFixture();
  t.after(() => h.mf.dispose());
  h.qrzRecords.length = 0;
  h.lotwRecords.length = 0;
  if (alias) {
    await h.store
      .statement(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,config,created_at) SELECT tenant,'lotw-other',kind,'query:other','Other route',status,credential_version,config,created_at FROM connections WHERE tenant='a' AND id='lotw'",
      )
      .run();
    await (
      await h.store.putPrivate(
        "a",
        "lotw-other",
        "fixture-lotw",
        "credential",
        await h.store.private("a", "lotw", "fixture-lotw", "credential"),
      )
    ).run();
  }
  const source = (await h.store.connection("a", "source"))!;
  const proof = await mintFixtureSourceProofs(h.store, {
    source,
    qsos: Array.from({ length: count }, (_, i) => ({
      ...h.qso,
      uuid: `q${i + 1}`,
      startAtMillis: Number(h.qso.startAtMillis) + i * 3600000,
      syncedAtMillis: 101 + i,
    })),
    operations: [h.operation],
    destinations: (await h.store.connections("a")).filter(
      (c) => c.kind !== "lofi",
    ),
  });
  await h.store
    .statement(
      "UPDATE ledger SET state='missing_current_identity',due_at=0 WHERE tenant='a'",
    )
    .run();
  await backfillLotwOwnership(h.store, "a");
  const key = { tenant: "a", source: "source", qso: "q1", destination: "lotw" };
  const prepare = () =>
    prepareDue(h.store, key, proof.snapshots[0]!.contact, gates, {
      fetcher: h.fetcher,
      sourceProof: proof.authorizations[0],
    });
  return { ...h, key, proof, prepare };
}
test("ownership bridge keeps reservation, claim, upload and exact receipt coherent", async (t) => {
  const h = await fixture(t);
  const prepared = await h.prepare();
  assert.equal(prepared.state, "prepared", prepared.reason);
  assert.ok(prepared.attemptId);
  assert.equal(
    await h.store
      .statement("SELECT COUNT(*) n FROM attempt_lotw_ownership_pins")
      .first("n"),
    1,
  );
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM lotw_ownership_inputs WHERE status!='covered'",
      )
      .first("n"),
    0,
  );
  assert.equal(
    (
      await dispatchAttempt(h.store, "a", prepared.attemptId, gates, {
        fetcher: h.fetcher,
      })
    ).state,
    "submitted",
  );
  assert.equal(h.calls.lotwUploads, 1);
  assert.equal(
    (
      await reconcileAttempt(h.store, "a", prepared.attemptId, {
        fetcher: h.fetcher,
      })
    ).state,
    "observed",
  );
  assert.equal(h.calls.lotwUploads, 1);
  assert.ok(
    (await h.store.ledger(h.key))?.remote_id,
    "ownership-current receipt must map",
  );
});
async function artifact(h: Awaited<ReturnType<typeof fixture>>, id: string) {
  const a = await h.store
    .statement("SELECT payload_id FROM attempts WHERE tenant='a' AND id=?", id)
    .first<{ payload_id: string }>();
  assert.ok(a);
  return h.store.private("a", "lotw", a.payload_id, "outbox");
}
async function inputFor(
  h: Awaited<ReturnType<typeof fixture>>,
  index = 0,
  destination = "lotw",
) {
  let input: StageInput | undefined;
  const store = new Proxy(h.store, {
    get(target, p) {
      if (p === "stage")
        return async (...a: Parameters<Store["stage"]>) => {
          const [
            key,
            generation,
            payload,
            credentialVersion,
            expectedTemplate,
            now,
            transmittedHash,
            lotwIdentityId,
            priority,
            identity,
            sourceProof,
          ] = a;
          input = {
            key,
            generation,
            payload,
            credentialVersion,
            expectedTemplate,
            now,
            transmittedHash,
            lotwIdentityId,
            priority,
            identity,
            sourceProof,
          };
          return "plan-only";
        };
      const value = Reflect.get(target, p, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const qso = `q${index + 1}`;
  const result = await prepareDue(
    store,
    { ...h.key, qso, destination },
    h.proof.snapshots[index]!.contact,
    { ...gates, allowedQsoIds: [qso], allowedDestinationIds: [destination] },
    { fetcher: h.fetcher, sourceProof: h.proof.authorizations[index] },
  );
  assert.equal(result.state, "prepared", result.reason);
  assert.ok(input);
  return input;
}
async function count(h: Awaited<ReturnType<typeof fixture>>, table: string) {
  assert.ok(
    [
      "attempts",
      "attempt_lotw_ownership_pins",
      "lotw_ownership_evidence",
      "destination_identity_claims",
      "lotw_ownership_write_guards",
      "lotw_ownership_planned",
    ].includes(table),
  );
  return h.store
    .statement(`SELECT COUNT(*) n FROM ${table}`)
    .first<number>("n");
}
async function conflict(
  h: Awaited<ReturnType<typeof fixture>>,
  raw: Record<string, string>,
) {
  await h.store
    .statement(
      "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,due_at,updated_at) VALUES('a','source','other','lotw','old','old',0,0)",
    )
    .run();
  const identity = canonicalLotwIdentity({ ...raw, TIME_ON: "120101" });
  await (
    await h.store.lotwIdentityStatement(
      { ...h.key, qso: "other" },
      { identity, remoteId: await lotwRemoteIdentity(identity) },
      "uncertain",
      Date.now(),
      { sql: "1", params: [] },
    )
  ).run();
  for (let i = 0; i < 3; i++) await backfillLotwOwnership(h.store, "a");
  assert.equal(
    (await lookupLotwOwnership(h.store, "a", raw)).state,
    "observed",
  );
}
async function unknown(h: Awaited<ReturnType<typeof fixture>>) {
  await h.store
    .statement(
      "INSERT INTO lotw_ownership_inputs(tenant,kind,destination,reference) VALUES('a','legacy','lotw','unrecoverable-old-receipt')",
    )
    .run();
}
test("one atomic stage cohort preserves both pins and rejects overlapping prospective owners", async (t) => {
  const h = await fixture(t, 2),
    one = await inputFor(h, 0),
    two = await inputFor(h, 1);
  const ids = await h.store.stageBatch([one, two]);
  assert.equal(ids.length, 2);
  assert.equal(await count(h, "attempt_lotw_ownership_pins"), 2);
  assert.equal(await count(h, "lotw_ownership_write_guards"), 0);
  for (const id of ids)
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
test("prospective overlap aborts an entire native stage batch without provisional evidence", async (t) => {
  const h = await fixture(t, 2),
    one = await inputFor(h, 0),
    two = await inputFor(h, 1);
  two.payload = structuredClone(one.payload);
  two.lotwIdentityId = one.lotwIdentityId;
  await assert.rejects(() => h.store.stageBatch([one, two]), /LoTW ownership/);
  for (const table of [
    "attempts",
    "attempt_lotw_ownership_pins",
    "lotw_ownership_evidence",
    "destination_identity_claims",
  ])
    assert.equal(await count(h, table), 0, table);
});
test("a failed mapping CAS rolls back its encrypted reservation and exact accounting", async (t) => {
  const h = await fixture(t),
    input = await inputFor(h),
    identity = await lotwPayloadIdentity(input.payload),
    ledger = (await h.store.ledger(h.key))!;
  const plan = await prepareLotwOwnershipBatch(h.store, "mapping", [
    {
      ...h.key,
      identity,
      generation: ledger.generation,
      sourceHash: ledger.source_hash,
    },
  ]);
  try {
    await assert.rejects(
      () =>
        h.store.db.batch([
          ...plan.begin,
          h.store.statement(
            "UPDATE ledger SET remote_id=? WHERE tenant='a' AND qso='q1' AND generation='lost-race'",
            identity.remoteId,
          ),
          ...plan.finish,
        ]),
      /mapping changed/,
    );
  } finally {
    await plan.release();
  }
  assert.equal(await count(h, "lotw_ownership_evidence"), 0);
  assert.equal((await h.store.ledger(h.key))?.remote_id, null);
  assert.equal(await count(h, "lotw_ownership_write_guards"), 0);
});
test("real receipt facts survive a new cross-owner overlap while ledger mapping stays held", async (t) => {
  const h = await fixture(t),
    p = await h.prepare();
  assert.ok(p.attemptId);
  const payload = await artifact(h, p.attemptId),
    identity = await lotwPayloadIdentity(payload);
  assert.equal(
    (
      await dispatchAttempt(h.store, "a", p.attemptId, gates, {
        fetcher: h.fetcher,
      })
    ).state,
    "submitted",
  );
  await conflict(h, identity.identity);
  assert.equal(
    (await reconcileAttempt(h.store, "a", p.attemptId, { fetcher: h.fetcher }))
      .state,
    "observed",
  );
  assert.equal((await h.store.ledger(h.key))?.remote_id, null);
  assert.equal(
    await h.store
      .statement(
        "SELECT state FROM attempt_state WHERE tenant='a' AND attempt=?",
        p.attemptId,
      )
      .first("state"),
    "observed",
  );
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM private_data WHERE kind='lotw_observation'",
      )
      .first("n"),
    1,
  );
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM attempt_events WHERE attempt=? AND state='observed'",
        p.attemptId,
      )
      .first("n"),
    1,
  );
  assert.equal(h.calls.lotwUploads, 1);
});
test("unknown legacy coverage cannot erase an exact receipt or grant a mapping", async (t) => {
  const h = await fixture(t),
    p = await h.prepare();
  assert.ok(p.attemptId);
  assert.equal(
    (
      await dispatchAttempt(h.store, "a", p.attemptId, gates, {
        fetcher: h.fetcher,
      })
    ).state,
    "submitted",
  );
  await unknown(h);
  assert.equal(
    (await reconcileAttempt(h.store, "a", p.attemptId, { fetcher: h.fetcher }))
      .state,
    "observed",
  );
  assert.equal((await h.store.ledger(h.key))?.remote_id, null);
  assert.equal(h.calls.lotwUploads, 1);
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM private_data WHERE kind='lotw_observation'",
      )
      .first("n"),
    1,
  );
});
test("old or malformed plans cannot stage, pin, directly dispatch, or map", async (t) => {
  const h = await fixture(t),
    input = await inputFor(h);
  await assert.rejects(
    () =>
      h.store
        .statement(
          "UPDATE ledger SET remote_id=? WHERE tenant='a' AND qso='q1' AND destination='lotw'",
          "x".repeat(43),
        )
        .run(),
    /LoTW ownership mapping/,
  );
  const p = await h.prepare();
  assert.ok(p.attemptId);
  const attemptId = p.attemptId;
  await assert.rejects(
    () =>
      h.store
        .statement(
          "UPDATE attempt_lotw_ownership_pins SET artifact_hash='changed' WHERE attempt=?",
          attemptId,
        )
        .run(),
    /immutable/,
  );
  await assert.rejects(
    () =>
      h.store
        .statement(
          "UPDATE attempt_state SET state='dispatching' WHERE attempt=?",
          attemptId,
        )
        .run(),
    /LoTW ownership/,
  );
  const original = await artifact(h, p.attemptId);
  (original as { kind: string }).kind = "qrz";
  await assert.rejects(
    () => renewAttemptLotwOwnership(h.store, "a", attemptId, original),
    /LoTW ownership/,
  );
  const plan = await prepareLotwOwnershipBatch(h.store, "mapping", [
    {
      ...h.key,
      generation: input.generation,
      sourceHash: (await h.store.ledger(h.key))!.source_hash,
      identity: await lotwPayloadIdentity(input.payload),
    },
  ]);
  // Capture the real prepared guard, then replace only its JSON with an incomplete member.
  const lease = plan.lease;
  const state = await h.store
    .statement("SELECT * FROM lotw_ownership_state WHERE tenant='a'")
    .first<{ clock: number; key_id: string }>();
  assert.ok(state);
  try {
    await assert.rejects(
      () =>
        h.store
          .statement(
            "INSERT INTO lotw_ownership_write_guards VALUES('bad','a','stage',?,?,1,?,?,?,?,?)",
            state.key_id,
            state.clock,
            JSON.stringify([
              { source: "source", qso: "q1", destination: "lotw" },
            ]),
            lease.token,
            lease.fence,
            Date.now(),
            Date.now() + 1000,
          )
          .run(),
      /invalid LoTW ownership plan/,
    );
  } finally {
    await plan.release();
  }
});
test("inactive signing/query reroute cannot resend its same-owner submitted artifact", async (t) => {
  const h = await fixture(t, 1, true),
    input = await inputFor(h, 0, "lotw-other"),
    p = await h.prepare();
  assert.ok(p.attemptId);
  assert.equal(
    (
      await dispatchAttempt(h.store, "a", p.attemptId, gates, {
        fetcher: h.fetcher,
      })
    ).state,
    "submitted",
  );
  await h.store
    .statement(
      "UPDATE connections SET status='revoked',remote_identity='station:W1AW:291' WHERE tenant='a' AND id='lotw'",
    )
    .run();
  h.lotwRecords.length = 0;
  h.proof = await mintFixtureSourceProofs(h.store, {
    source: (await h.store.connection("a", "source"))!,
    qsos: [h.qso],
    operations: [h.operation],
    destinations: (await h.store.connections("a")).filter(
      (c) => c.kind !== "lofi" && c.status === "active",
    ),
  });
  await h.store
    .statement(
      "UPDATE ledger SET state='missing_current_identity',due_at=0 WHERE tenant='a' AND destination='lotw-other'",
    )
    .run();
  const blocked = await prepareDue(
    h.store,
    { ...h.key, destination: "lotw-other" },
    h.proof.snapshots[0]!.contact,
    { ...gates, allowedDestinationIds: ["lotw-other"] },
    {
      fetcher: h.fetcher,
      sourceProof: h.proof.authorizations[0],
      sign: async () => assert.fail("unsafe reroute signed"),
    },
  );
  assert.equal(blocked.reason, "lotw_ownership_unavailable");
  await assert.rejects(
    () => h.store.stageBatch([input]),
    /LoTW ownership prior route/,
  );
  assert.equal(await count(h, "attempts"), 1);
  assert.equal(h.calls.lotwUploads, 1);
});
test("permanent old-route mapping blocks a duplicate even after clearing the ledger reference", async (t) => {
  const h = await fixture(t, 1, true),
    input = await inputFor(h, 0, "lotw-other"),
    identity = await lotwPayloadIdentity(input.payload),
    ledger = (await h.store.ledger(h.key))!;
  const plan = await prepareLotwOwnershipBatch(h.store, "mapping", [
    {
      ...h.key,
      generation: ledger.generation,
      sourceHash: ledger.source_hash,
      identity,
    },
  ]);
  try {
    await h.store.db.batch([
      ...plan.begin,
      h.store.statement(
        "UPDATE ledger SET remote_id=?,state='adopted_existing' WHERE tenant='a' AND qso='q1' AND destination='lotw'",
        identity.remoteId,
      ),
      ...plan.finish,
    ]);
  } finally {
    await plan.release();
  }
  await h.store
    .statement(
      "UPDATE ledger SET remote_id=NULL WHERE tenant='a' AND qso='q1' AND destination='lotw'",
    )
    .run();
  await assert.rejects(
    () => h.store.stageBatch([input]),
    /LoTW ownership prior route/,
  );
  assert.equal(await count(h, "attempts"), 0);
});
test("a cancelled known-unsent reservation permits a later route without releasing its durable identity", async (t) => {
  const h = await fixture(t, 1, true),
    p = await h.prepare();
  assert.ok(p.attemptId);
  await h.store
    .statement(
      "UPDATE attempt_state SET state='cancelled' WHERE tenant='a' AND attempt=? AND state='prepared'",
      p.attemptId,
    )
    .run();
  const input = await inputFor(h, 0, "lotw-other");
  assert.equal((await h.store.stageBatch([input])).length, 1);
  assert.equal(await count(h, "attempts"), 2);
  assert.equal(await count(h, "attempt_lotw_ownership_pins"), 2);
  assert.equal(h.calls.lotwUploads, 0);
});
function afterUploadAdmission(
  store: Store,
  change: () => Promise<void>,
): Store {
  let reservations = 0;
  return new Proxy(store, {
    get(target, property) {
      if (property === "statement")
        return (...args: Parameters<Store["statement"]>) => {
          const statement = target.statement(...args);
          if (
            !args[0].includes("INSERT INTO vendor_requests") ||
            args[1] !== "lotw"
          )
            return statement;
          return new Proxy(statement, {
            get(inner, name) {
              const value = Reflect.get(inner, name, inner);
              if (name === "first")
                return async (...values: unknown[]) => {
                  const result = await Reflect.apply(value, inner, values);
                  if (++reservations === 3) await change();
                  return result;
                };
              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
test("post-budget ownership coverage race makes no upload and preserves known-unsent state", async (t) => {
  const h = await fixture(t),
    p = await h.prepare();
  assert.ok(p.attemptId);
  const result = await dispatchAttempt(
    afterUploadAdmission(h.store, () => unknown(h)),
    "a",
    p.attemptId,
    gates,
    { fetcher: h.fetcher },
  );
  assert.equal(result.state, "blocked");
  assert.equal(h.calls.lotwUploads, 0);
  assert.equal(
    await h.store
      .statement(
        "SELECT state FROM attempt_state WHERE tenant='a' AND attempt=?",
        p.attemptId,
      )
      .first("state"),
    "prepared",
  );
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM attempt_events WHERE attempt=? AND state='retry_scheduled'",
        p.attemptId,
      )
      .first("n"),
    1,
  );
  assert.equal(await count(h, "destination_identity_claims"), 1);
});
test("new LoTW ownership expiry does not block the independent QRZ transport", async (t) => {
  const h = await fixture(t),
    key = { ...h.key, destination: "destination" };
  const qrzGates = {
    ...gates,
    lotwFreshInsertsEnabled: false,
    qrzFreshInsertsEnabled: true,
    allowedDestinationIds: ["destination"],
  };
  const p = await prepareDue(
    h.store,
    key,
    h.proof.snapshots[0]!.contact,
    qrzGates,
    { fetcher: h.fetcher, sourceProof: h.proof.authorizations[0] },
  );
  assert.equal(p.state, "prepared", p.reason);
  assert.ok(p.attemptId);
  const result = await dispatchAttempt(h.store, "a", p.attemptId, qrzGates, {
    fetcher: h.fetcher,
  });
  assert.equal(result.state, "delivered", result.reason);
  assert.equal(h.calls.qrzWrites, 1);
  assert.equal(h.calls.lotwUploads, 0);
});
test("ownership race between receipt preparation and commit retains facts in one bounded fallback", async (t) => {
  const h = await fixture(t),
    p = await h.prepare();
  assert.ok(p.attemptId);
  assert.equal(
    (
      await dispatchAttempt(h.store, "a", p.attemptId, gates, {
        fetcher: h.fetcher,
      })
    ).state,
    "submitted",
  );
  const guards = new WeakSet<object>(),
    originalBatch = h.store.db.batch.bind(h.store.db);
  let injected = false,
    guardedBatches = 0;
  const db = new Proxy(h.store.db, {
    get(target, property) {
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (statements.some((s) => guards.has(s))) {
            guardedBatches++;
            if (!injected) {
              injected = true;
              await unknown(h);
            }
          }
          return originalBatch(statements);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const receiptStore = new Store(db, h.store.keys),
    originalStatement = receiptStore.statement.bind(receiptStore);
  t.mock.method(
    receiptStore,
    "statement",
    (sql: string, ...params: (string | number | null)[]) => {
      const statement = originalStatement(sql, ...params);
      if (sql.startsWith("INSERT INTO lotw_ownership_write_guards"))
        guards.add(statement);
      return statement;
    },
  );
  assert.equal(
    (
      await reconcileAttempt(receiptStore, "a", p.attemptId, {
        fetcher: h.fetcher,
      })
    ).state,
    "observed",
  );
  assert.ok(injected);
  assert.equal(guardedBatches, 1);
  assert.equal((await h.store.ledger(h.key))?.remote_id, null);
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM attempt_events WHERE attempt=? AND state='observed'",
        p.attemptId,
      )
      .first("n"),
    1,
  );
  assert.equal(await count(h, "lotw_ownership_write_guards"), 0);
  assert.equal(h.calls.lotwUploads, 1);
});
test("lost upload response stays uncertain and only exact receipt recovery observes it", async (t) => {
  const h = await fixture(t),
    p = await h.prepare();
  assert.ok(p.attemptId);
  const lost: typeof fetch = async (url, init) => {
    const response = await h.fetcher(url, init);
    if (new URL(String(url)).pathname === "/lotw/upload")
      throw new Error("synthetic lost response");
    return response;
  };
  const result = await dispatchAttempt(h.store, "a", p.attemptId, gates, {
    fetcher: lost,
  });
  assert.equal(result.state, "uncertain");
  assert.equal(h.calls.lotwUploads, 1);
  await dispatchAttempt(h.store, "a", p.attemptId, gates, {
    fetcher: h.fetcher,
  });
  assert.equal(h.calls.lotwUploads, 1);
  assert.equal(
    (await reconcileAttempt(h.store, "a", p.attemptId, { fetcher: h.fetcher }))
      .state,
    "observed",
  );
  assert.equal(h.calls.lotwUploads, 1);
  assert.ok((await h.store.ledger(h.key))?.remote_id);
});
test("original exact receipt can map after source proof invalidation without granting resend", async (t) => {
  const h = await fixture(t),
    p = await h.prepare();
  assert.ok(p.attemptId);
  assert.equal(
    (
      await dispatchAttempt(h.store, "a", p.attemptId, gates, {
        fetcher: h.fetcher,
      })
    ).state,
    "submitted",
  );
  await h.store
    .statement(
      "UPDATE ledger SET source_hash='newer-source',generation='newer-generation',state='changed' WHERE tenant='a' AND qso='q1' AND destination='lotw'",
    )
    .run();
  assert.equal(
    (await reconcileAttempt(h.store, "a", p.attemptId, { fetcher: h.fetcher }))
      .state,
    "observed",
  );
  const ledger = await h.store.ledger(h.key);
  assert.equal(ledger?.state, "changed");
  assert.equal(ledger?.source_hash, "newer-source");
  assert.ok(ledger.remote_id);
  assert.equal(h.calls.lotwUploads, 1);
});
test("a later stage CAS failure rolls back the whole otherwise-valid cohort", async (t) => {
  const h = await fixture(t, 2),
    one = await inputFor(h, 0),
    two = await inputFor(h, 1);
  two.credentialVersion = "revoked-missing";
  await assert.rejects(() => h.store.stageBatch([one, two]));
  for (const table of [
    "attempts",
    "attempt_lotw_ownership_pins",
    "lotw_ownership_evidence",
    "destination_identity_claims",
    "lotw_ownership_write_guards",
  ])
    assert.equal(await count(h, table), 0, table);
});
test("pre-bridge missing state may be quarantined but cannot gain a pin or dispatch authority", async (t) => {
  const h = await database();
  t.after(() => h.mf.dispose());
  await seed(h.store);
  await h.store
    .statement(
      "UPDATE connections SET kind='lotw' WHERE tenant='a' AND id='destination'",
    )
    .run();
  await h.store
    .statement(
      "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,due_at,updated_at) VALUES('a','source','q1','destination','old','old',0,0)",
    )
    .run();
  await h.store
    .statement(
      "INSERT INTO attempts VALUES('a','legacy','source','q1','destination','old','payload','hash',NULL,'v1',0,'old')",
    )
    .run();
  for (const file of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((x) => x.endsWith(".sql") && x > "0001_foundation.sql")
    .sort())
    await applyMigration(h.db, file);
  for (const state of ["prepared", "dispatching", "submitted", "observed"])
    await assert.rejects(() =>
      h.store
        .statement(
          "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a','legacy',?,0,0)",
          state,
        )
        .run(),
    );
  await h.store
    .statement(
      "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a','legacy','reconciliation_required',0,0)",
    )
    .run();
  const quarantine = (
    await readFile(new URL("../ops/lock-restored.sql", import.meta.url), "utf8")
  )
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  for (let pass = 0; pass < 2; pass++)
    await h.db.batch(quarantine.map((sql) => h.store.statement(sql)));
  assert.equal(
    await h.store
      .statement("SELECT state FROM attempt_state WHERE attempt='legacy'")
      .first("state"),
    "reconciliation_required",
  );
  assert.equal(
    await h.store
      .statement("SELECT COUNT(*) n FROM attempt_lotw_ownership_pins")
      .first("n"),
    0,
  );
  assert.equal(
    await h.store
      .statement("SELECT remote_id FROM ledger WHERE tenant='a' AND qso='q1'")
      .first("remote_id"),
    null,
  );
  await assert.rejects(() =>
    h.store
      .statement(
        "UPDATE attempt_state SET state='dispatching' WHERE attempt='legacy'",
      )
      .run(),
  );
});
test("scheduled ownership maintenance makes bounded progress then stops on held-only work", async (t) => {
  const h = await fixture(t);
  for (let start = 0; start < 230; start += 25)
    await h.store.db.batch(
      Array.from({ length: Math.min(25, 230 - start) }, (_, i) =>
        h.store.statement(
          "INSERT INTO lotw_ownership_inputs(tenant,kind,destination,reference) VALUES('a','legacy','lotw',?)",
          `legacy-${start + i}`,
        ),
      ),
    );
  const result = await tick(h.env, h.fetcher);
  assert.equal(result.throughput?.lotwOwnershipPasses, 4);
  assert.equal(result.throughput?.lotwOwnershipExamined, 400);
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM lotw_ownership_inputs WHERE status='held'",
      )
      .first("n"),
    230,
  );
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM lotw_ownership_inputs WHERE status='pending'",
      )
      .first("n"),
    0,
  );
  assert.equal(h.calls.lotwUploads, 0);
  assert.equal(h.calls.qrzWrites, 0);
});
test("expired maintenance admission performs no registry reads or writes", async (t) => {
  const h = await fixture(t);
  let statements = 0;
  const original = h.store.statement.bind(h.store);
  t.mock.method(
    h.store,
    "statement",
    (...args: Parameters<Store["statement"]>) => {
      statements++;
      return original(...args);
    },
  );
  const result = await backfillLotwOwnership(h.store, "a", {
    shouldContinue: () => false,
  });
  assert.equal(result.reason, "stopped");
  assert.equal(statements, 0);
  assert.equal(result.examined, 0);
});
test("a newer comparison policy invalidates current checks and rejects an old exact-only renewal", async (t) => {
  const h = await fixture(t),
    p = await h.prepare();
  assert.ok(p.attemptId);
  const id = p.attemptId,
    payload = await artifact(h, id);
  const current = await renewAttemptLotwOwnership(h.store, "a", id, payload);
  try {
    assert.equal(await attemptLotwOwnershipCurrent(h.store, "a", id), true);
    const heldPlan = await prepareLotwOwnershipBatch(
      h.store,
      "check",
      [await attemptLotwOwnershipWrite(h.store, "a", id, payload)],
      Date.now(),
      current.lease,
    );
    await h.store.db.batch(heldPlan.begin);
    assert.equal(await count(h, "lotw_ownership_planned"), 1);
    await h.store
      .statement(
        "UPDATE lotw_ownership_state SET comparison_policy=2 WHERE tenant='a'",
      )
      .run();
    assert.equal(await attemptLotwOwnershipCurrent(h.store, "a", id), false);
    assert.equal(
      await count(h, "lotw_ownership_planned"),
      0,
      "an admitted old policy plan cannot be reused after policy advancement",
    );
    await assert.rejects(
      () =>
        renewAttemptLotwOwnership(
          h.store,
          "a",
          id,
          payload,
          Date.now(),
          current.lease,
        ),
      /LoTW ownership/,
    );
    await assert.rejects(
      () =>
        h.store
          .statement(
            "UPDATE lotw_ownership_state SET comparison_policy=1 WHERE tenant='a'",
          )
          .run(),
      /cannot regress/,
    );
    assert.equal(h.calls.lotwUploads, 0);
  } finally {
    await h.store.release(current.lease);
  }
});
test("known-unsent report failure may retry the same immutable pin without another reservation", async (t) => {
  const h = await fixture(t),
    p = await h.prepare();
  assert.ok(p.attemptId);
  h.errors.lotw = true;
  const first = await dispatchAttempt(h.store, "a", p.attemptId, gates, {
    fetcher: h.fetcher,
  });
  assert.equal(first.state, "retry_scheduled");
  assert.equal(h.calls.lotwUploads, 0);
  h.errors.lotw = false;
  await h.store
    .statement(
      "UPDATE attempt_state SET due_at=0 WHERE tenant='a' AND attempt=?",
      p.attemptId,
    )
    .run();
  assert.equal(
    (
      await dispatchAttempt(h.store, "a", p.attemptId, gates, {
        fetcher: h.fetcher,
      })
    ).state,
    "submitted",
  );
  assert.equal(await count(h, "attempt_lotw_ownership_pins"), 1);
  assert.equal(await count(h, "lotw_ownership_evidence"), 1);
  assert.equal(h.calls.lotwUploads, 1);
});
test("a tenant maintenance phase yields after ten passes and still permits QRZ read work", async (t) => {
  const h = await fixture(t);
  for (let start = 0; start < 1230; start += 25)
    await h.store.db.batch(
      Array.from({ length: Math.min(25, 1230 - start) }, (_, i) =>
        h.store.statement(
          "INSERT INTO lotw_ownership_inputs(tenant,kind,destination,reference) VALUES('a','legacy','lotw',?)",
          `legacy-${start + i}`,
        ),
      ),
    );
  const result = await tick(h.env, h.fetcher);
  assert.equal(result.throughput?.lotwOwnershipPasses, 10);
  assert.equal(result.throughput?.lotwOwnershipExamined, 1000);
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM lotw_ownership_inputs WHERE status='pending'",
      )
      .first("n"),
    230,
  );
  assert.ok(h.calls.qrzReads > 0);
  assert.equal(h.calls.qrzWrites, 0);
  assert.equal(h.calls.lotwUploads, 0);
});
test("maintenance budget exhaustion discards a prepared encrypted publication before its batch", async (t) => {
  const h = await fixture(t),
    input = await inputFor(h),
    identity = await lotwPayloadIdentity(input.payload);
  await (
    await h.store.lotwIdentityStatement(
      h.key,
      identity,
      "adopted",
      Date.now(),
      { sql: "1", params: [] },
    )
  ).run();
  let checks = 0;
  const result = await backfillLotwOwnership(h.store, "a", {
    shouldContinue: () => ++checks <= 5,
  });
  assert.equal(result.reason, "stopped");
  assert.equal(result.examined, 0);
  assert.equal(await count(h, "lotw_ownership_evidence"), 0);
  assert.equal(
    await h.store
      .statement(
        "SELECT status FROM lotw_ownership_inputs WHERE kind='identity'",
      )
      .first("status"),
    "pending",
  );
});
test("an unknown batch acknowledgement containing ownership text is never retried", async (t) => {
  const h = await fixture(t),
    p = await h.prepare();
  assert.ok(p.attemptId);
  assert.equal(
    (
      await dispatchAttempt(h.store, "a", p.attemptId, gates, {
        fetcher: h.fetcher,
      })
    ).state,
    "submitted",
  );
  const guards = new WeakSet<object>(),
    originalBatch = h.store.db.batch.bind(h.store.db);
  let guarded = 0;
  const db = new Proxy(h.store.db, {
    get(target, name) {
      if (name === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (statements.some((x) => guards.has(x))) {
            guarded++;
            throw new Error(
              "unknown batch acknowledgement: LoTW ownership unavailable",
            );
          }
          return originalBatch(statements);
        };
      const value = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const store = new Store(db, h.store.keys),
    statement = store.statement.bind(store);
  t.mock.method(
    store,
    "statement",
    (sql: string, ...params: (string | number | null)[]) => {
      const s = statement(sql, ...params);
      if (sql.startsWith("INSERT INTO lotw_ownership_write_guards"))
        guards.add(s);
      return s;
    },
  );
  await assert.rejects(
    () => reconcileAttempt(store, "a", p.attemptId!, { fetcher: h.fetcher }),
    /unknown batch acknowledgement/,
  );
  assert.equal(guarded, 1);
  assert.equal(
    await h.store
      .statement("SELECT state FROM attempt_state WHERE attempt=?", p.attemptId)
      .first("state"),
    "submitted",
  );
  assert.equal(h.calls.lotwUploads, 1);
});

test("current ownership coverage uses indexed status seeks with thousands of covered obligations", async (t) => {
  const h = await fixture(t);
  const p = await h.prepare();
  assert.ok(p.attemptId);
  const attemptId = p.attemptId;
  const payload = await artifact(h, attemptId);
  const admission = await renewAttemptLotwOwnership(
    h.store,
    "a",
    attemptId,
    payload,
  );
  const query =
    "SELECT 1 AS current FROM attempt_lotw_ownership_current WHERE tenant=? AND attempt=?";
  try {
    const before = await h.store.statement(query, "a", attemptId).all();
    assert.equal(before.results.length, 1);
    await h.store
      .statement(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<3000)
      INSERT INTO lotw_ownership_inputs(tenant,kind,destination,reference,source,qso,exact_hash,status,checked_at,evidence_id)
      SELECT e.tenant,'claim',e.destination,'covered-plan-'||n.x,e.source,e.qso,e.exact_hash,'covered',0,e.id
      FROM n CROSS JOIN lotw_ownership_evidence e WHERE e.tenant='a' LIMIT 3000`)
      .run();
    await renewAttemptLotwOwnership(
      h.store,
      "a",
      attemptId,
      payload,
      Date.now(),
      admission.lease,
    );
    const after = await h.store.statement(query, "a", attemptId).all();
    assert.equal(after.results.length, 1);
    assert.ok(
      after.meta.rows_read <= before.meta.rows_read + 16,
      `covered obligations changed reads from ${before.meta.rows_read} to ${after.meta.rows_read}`,
    );
    const plan = await h.store
      .statement(`EXPLAIN QUERY PLAN ${query}`, "a", attemptId)
      .all<{ detail: string }>();
    assert.ok(
      plan.results.some((row) =>
        /lotw_ownership_pending.*tenant=\?.*status=\?/.test(row.detail),
      ),
      JSON.stringify(plan.results),
    );
    await h.store
      .statement(
        "INSERT INTO lotw_ownership_inputs(tenant,kind,destination,reference) VALUES('a','identity','lotw','unavailable')",
      )
      .run();
    assert.equal(
      await attemptLotwOwnershipCurrent(h.store, "a", attemptId),
      false,
    );
    await assert.rejects(
      () =>
        renewAttemptLotwOwnership(
          h.store,
          "a",
          attemptId,
          payload,
          Date.now(),
          admission.lease,
        ),
      /LoTW ownership/,
    );
  } finally {
    await h.store.release(admission.lease);
  }
});

test("maximum twenty-member stage cohort commits 203 native statements with 20 immutable pins", async (t) => {
  const h = await fixture(t, 20);
  const inputs: StageInput[] = [];
  for (let index = 0; index < 20; index++)
    inputs.push(await inputFor(h, index));
  const sizes: number[] = [];
  const db = new Proxy(h.store.db, {
    get(target, property) {
      if (property === "batch")
        return (statements: D1PreparedStatement[]) => {
          sizes.push(statements.length);
          return target.batch(statements);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const ids = await new Store(db, h.store.keys).stageBatch(inputs);
  assert.equal(ids.length, 20);
  assert.equal(sizes.at(-1), 203);
  assert.ok(
    sizes.slice(0, -1).every((size) => size === 2),
    "other batches are read-only captured lookups",
  );
  assert.equal(await count(h, "attempt_lotw_ownership_pins"), 20);
  assert.equal(await count(h, "lotw_ownership_evidence"), 20);
  assert.equal(await count(h, "lotw_ownership_write_guards"), 0);
  assert.equal(
    await h.store
      .statement("SELECT count(*) n FROM attempt_state WHERE state='prepared'")
      .first("n"),
    20,
  );
  assert.equal(h.calls.lotwUploads, 0);
});

test("maximum eight-member exact adoption cohort commits 90 native statements including collision guards", async (t) => {
  const h = await fixture(t, 8);
  const items: HistoryAdoptionInput[] = [];
  for (let index = 0; index < 8; index++) {
    const key = { ...h.key, qso: `q${index + 1}` };
    const ledger = (await h.store.ledger(key))!;
    const raw = contactReconciliationAdif(h.proof.snapshots[index]!.contact);
    const outcome = classifyHistory(raw, [raw], {
      destination: "lotw",
      capturedGeneration: ledger.generation,
      currentGeneration: ledger.generation,
      readAccess: true,
      inventoryComplete: true,
      catchupComplete: true,
      freshCheckComplete: false,
      inventoryPositiveOnly: true,
    });
    assert.equal(outcome.state, "adopted_existing", outcome.reason ?? "");
    items.push({
      key,
      generation: ledger.generation,
      outcome,
      ledger: { ...ledger, destination_kind: "lotw" },
      commitGuard: () => ({
        sql: "EXISTS(SELECT 1 FROM source_export_proofs_current WHERE tenant=? AND id=?)",
        params: [key.tenant, h.proof.proofs[index]!.id],
      }),
    });
  }
  const sizes: number[] = [];
  const db = new Proxy(h.store.db, {
    get(target, property) {
      if (property === "batch")
        return (statements: D1PreparedStatement[]) => {
          sizes.push(statements.length);
          return target.batch(statements);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const result = await adoptHistoryBatch(
    new Store(db, h.store.keys),
    { tenant: "a", id: "source" },
    items,
  );
  assert.equal(
    result.filter((row) => row.applied).length,
    8,
    JSON.stringify(result),
  );
  assert.equal(sizes[0], 8, "bounded current-source preflight");
  assert.equal(sizes.at(-1), 90);
  assert.ok(
    sizes.slice(1, -1).every((size) => size === 2),
    "other batches are read-only captured lookups",
  );
  assert.equal(await count(h, "lotw_ownership_evidence"), 8);
  assert.equal(await count(h, "destination_identity_claims"), 8);
  assert.equal(await count(h, "lotw_ownership_write_guards"), 0);
  assert.equal(await count(h, "attempts"), 0);
  assert.equal(
    await h.store
      .statement(
        "SELECT count(*) n FROM ledger WHERE destination='lotw' AND remote_id IS NOT NULL",
      )
      .first("n"),
    8,
  );
});
