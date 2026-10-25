import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { AdifRecord } from "../src/adif.ts";
import {
  type DeliveryGates,
  deliveryMode,
  dispatchAttempt,
  prepareDue,
  QrzEmptyObservationScope,
  reconcileAttempt,
} from "../src/delivery.ts";
import { observeContact, pollSource } from "../src/intake.ts";
import { QrzClient, QrzError } from "../src/qrz.ts";
import {
  loadCurrentSourcePresenceScope,
  loadSourceExportSnapshots,
} from "../src/source-export-proofs.ts";
import type { Store } from "../src/store.ts";
import { schedulerFixture } from "./runtime-fixtures.ts";
import { mintFixtureSourceProofs } from "./source-proof-fixtures.ts";

const fresh: DeliveryGates = {
  exportsEnabled: true,
  liveWriteAuthorized: true,
  sourceBoundaryVerified: false,
  qrzFreshInsertsEnabled: true,
  allowedQsoIds: ["q1"],
  allowedDestinationIds: ["destination"],
};
const boundary: DeliveryGates = {
  ...fresh,
  sourceBoundaryVerified: true,
  qrzFreshInsertsEnabled: false,
};

async function fixture(t: TestContext) {
  const h = await schedulerFixture();
  t.after(() => h.mf.dispose());
  h.qrzRecords.length = 0;
  h.lotwRecords.length = 0;
  h.qso.startAtMillis = Number(h.qso.startAtMillis) + 123;
  h.operation.grid = "FN31AA12";
  const source = (await h.store.connection("a", "source"))!;
  const destinations = (await h.store.connections("a")).filter(
    (c) => c.kind !== "lofi",
  );
  const evidence = await mintFixtureSourceProofs(h.store, {
    source,
    qsos: [h.qso],
    operations: [h.operation],
    destinations,
  });
  await h.store
    .statement(
      "UPDATE ledger SET state='missing_current_identity',due_at=0 WHERE tenant='a' AND source='source' AND qso='q1'",
    )
    .run();
  const contact = evidence.snapshots[0]!.contact;
  const sourceProof = evidence.authorizations[0]!;
  const key = (destination = "destination") => ({
    tenant: "a",
    source: "source",
    qso: "q1",
    destination,
  });
  const prepare = (gates = fresh) =>
    prepareDue(h.store, key(), contact, gates, {
      fetcher: h.fetcher,
      sourceProof,
    });
  const state = (id: string) =>
    h.store
      .statement(
        "SELECT state FROM attempt_state WHERE tenant='a' AND attempt=?",
        id,
      )
      .first<string>("state");
  const count = (table: string) =>
    h.store.statement(`SELECT count(*) AS n FROM ${table}`).first<number>("n");
  return { ...h, contact, sourceProof, key, prepare, state, count };
}

async function emptyObservation(h: Awaited<ReturnType<typeof fixture>>) {
  const scope = new QrzEmptyObservationScope(h.store);
  const read = await scope.read(
    {
      key: h.key(),
      contact: h.contact,
      source: (await h.store.connection("a", "source"))!,
      destination: (await h.store.connection("a", "destination"))!,
    },
    { apiKey: "synthetic-qrz" },
    { fetcher: h.fetcher },
  );
  assert(read.observation);
  return { scope, observation: read.observation };
}

test("same-turn QRZ absence skips only preparation; a final neighbor still prevents INSERT", async (t) => {
  const h = await fixture(t);
  const { scope, observation } = await emptyObservation(h);
  t.after(() => scope.close());
  assert.equal(h.calls.qrzReads, 1);
  const prepared = await prepareDue(h.store, h.key(), h.contact, fresh, {
    fetcher: h.fetcher,
    sourceProof: h.sourceProof,
    qrzEmptyObservation: observation,
  });
  assert.equal(prepared.state, "prepared");
  assert(prepared.attemptId);
  assert.equal(
    h.calls.qrzReads,
    1,
    "preparation consumed the actual empty scan",
  );
  scope.close();
  h.qrzRecords.push({
    ...h.initial,
    TIME_ON: "120030",
    APP_QRZLOG_LOGID: "501",
  });
  const result = await dispatchAttempt(
    h.store,
    "a",
    prepared.attemptId,
    fresh,
    {
      fetcher: h.fetcher,
      qrzEmptyObservation: observation,
    },
  );
  assert.equal(result.state, "rejected");
  assert.equal(
    h.calls.qrzReads,
    2,
    "dispatch cannot consume a preparation capability",
  );
  assert.equal(h.calls.qrzWrites, 0);
  assert.notEqual(await h.state(prepared.attemptId), "uncertain");
});

test("same-turn QRZ absence cannot replace a current post-drain source proof", async (t) => {
  const h = await fixture(t);
  const { scope, observation } = await emptyObservation(h);
  t.after(() => scope.close());
  const missing = await prepareDue(h.store, h.key(), h.contact, fresh, {
    fetcher: h.fetcher,
    qrzEmptyObservation: observation,
  });
  assert.equal(missing.reason, "source_export_proof_unavailable");
  // A real canonical drain changes the proof's captured source generation.
  await pollSource(
    h.store,
    (await h.store.connection("a", "source"))!,
    async () =>
      Response.json({
        account: { uuid: "account-fixture" },
        qsos: [],
        operations: [],
        meta: { qsos: { records_left: 0 }, operations: { records_left: 0 } },
      }),
  );
  const source = (await h.store.connection("a", "source"))!;
  const currentScope = await loadCurrentSourcePresenceScope(h.store, source);
  assert(currentScope);
  const [refreshed] = await loadSourceExportSnapshots(h.store, currentScope, [
    "q1",
  ]);
  assert(refreshed);
  await observeContact(h.store, source, refreshed.contact, Date.now(), [
    (await h.store.connection("a", "destination"))!,
  ]);
  const stale = await prepareDue(h.store, h.key(), refreshed.contact, fresh, {
    fetcher: h.fetcher,
    sourceProof: h.sourceProof,
    qrzEmptyObservation: observation,
  });
  assert.equal(stale.reason, "source_export_proof_unavailable");
  assert.equal(h.calls.qrzReads, 1);
  assert.equal(h.calls.qrzWrites, 0);
  assert.equal(await h.count("attempts"), 0);
});

test("fresh QRZ capability requires common consent and never grants LoTW or boundary authority", () => {
  assert.equal(deliveryMode(fresh, "qrz"), "qrz_fresh_insert");
  assert.equal(deliveryMode(fresh, "lotw"), null);
  assert.equal(deliveryMode(boundary, "qrz"), "source_boundary");
  assert.equal(deliveryMode(boundary, "lotw"), "source_boundary");
  for (const flag of [
    "exportsEnabled",
    "liveWriteAuthorized",
    "qrzFreshInsertsEnabled",
  ] as const)
    assert.equal(deliveryMode({ ...fresh, [flag]: false }, "qrz"), null);
  assert.equal(
    deliveryMode({ ...fresh, qrzFreshInsertsEnabled: undefined }, "qrz"),
    null,
  );
});

test("a genuine first QRZ insert pins fresh authority without source boundary or cutovers", async (t) => {
  const h = await fixture(t);
  // Empty inventory records the current source baseline without accepting a
  // destination record; this remains a first insertion, not a correction.
  await h.store
    .statement(
      "UPDATE ledger SET baseline_hash=source_hash WHERE destination='destination'",
    )
    .run();
  const prepared = await h.prepare();
  assert.equal(prepared.state, "prepared");
  assert(prepared.attemptId);
  assert.equal(
    await h.store
      .statement(
        "SELECT authorization_mode FROM attempt_source_export_proofs WHERE attempt=?",
        prepared.attemptId,
      )
      .first<string>("authorization_mode"),
    "qrz_fresh_insert",
  );
  assert.equal(
    (
      await dispatchAttempt(h.store, "a", prepared.attemptId, fresh, {
        fetcher: h.fetcher,
      })
    ).state,
    "delivered",
  );
  assert.equal(h.calls.qrzWrites, 1);
  assert.equal(h.calls.lotwUploads, 0);
  assert.equal(await h.count("source_cutovers"), 0);
  assert.equal(h.qrzMutations[0]?.MY_GRIDSQUARE, "FN31AA12");
  assert.equal(h.contact.startAtMillis % 1000, 123);
  assert.equal(h.contact.grid, "FN31AA12");
});

test("fresh authority preserves scope, proof, baseline and first-insert exclusions before vendor reads", async (t) => {
  const h = await fixture(t);
  const forbidden: typeof fetch = async () =>
    assert.fail("Unauthorized preparation reached vendor");
  for (const gates of [
    { ...fresh, allowedQsoIds: [] },
    { ...fresh, allowedDestinationIds: [] },
    { ...fresh, allowedQsoIds: undefined },
    { ...fresh, allowedDestinationIds: undefined },
    { ...fresh, qrzFreshInsertsEnabled: false },
  ])
    assert.equal(
      (
        await prepareDue(h.store, h.key(), h.contact, gates, {
          fetcher: forbidden,
          sourceProof: h.sourceProof,
        })
      ).state,
      "blocked",
    );
  assert.equal(
    (
      await prepareDue(h.store, h.key(), h.contact, fresh, {
        fetcher: forbidden,
      })
    ).reason,
    "source_export_proof_unavailable",
  );
  assert.equal(
    (
      await prepareDue(
        h.store,
        h.key("lotw"),
        h.contact,
        { ...fresh, allowedDestinationIds: ["lotw"] },
        {
          fetcher: forbidden,
          sign: async () => assert.fail("Fresh capability reached signer"),
          sourceProof: h.sourceProof,
        },
      )
    ).state,
    "blocked",
  );
  for (const update of [
    "baseline_hash='old'",
    "sent_hash='old'",
    "remote_hash='old'",
    "confirmed=1",
    "state='changed'",
  ]) {
    await h.store
      .statement(`UPDATE ledger SET ${update} WHERE destination='destination'`)
      .run();
    assert.equal(
      (
        await prepareDue(h.store, h.key(), h.contact, fresh, {
          fetcher: forbidden,
          sourceProof: h.sourceProof,
        })
      ).reason,
      "qrz_fresh_insert_unavailable",
    );
    await h.store
      .statement(
        "UPDATE ledger SET baseline_hash=NULL,sent_hash=NULL,remote_hash=NULL,confirmed=0,state='missing_current_identity' WHERE destination='destination'",
      )
      .run();
  }
  await h.store
    .statement(
      "UPDATE ledger SET remote_id='prior-mapping' WHERE destination='destination'",
    )
    .run();
  assert.equal(
    (
      await prepareDue(h.store, h.key(), h.contact, fresh, {
        fetcher: forbidden,
        sourceProof: h.sourceProof,
      })
    ).reason,
    "qrz_fresh_insert_unavailable",
  );
  assert.equal(await h.count("attempts"), 0);
});

test("immutable boundary and fresh modes cannot be promoted by toggling current capabilities", async (t) => {
  for (const mode of ["boundary", "fresh"] as const)
    await t.test(mode, async (t) => {
      const h = await fixture(t);
      const prepared = await h.prepare(mode === "boundary" ? boundary : fresh);
      assert(prepared.attemptId);
      const changed = mode === "boundary" ? fresh : boundary;
      assert.equal(
        (
          await dispatchAttempt(h.store, "a", prepared.attemptId, changed, {
            fetcher: async () => assert.fail("Wrong pin mode reached vendor"),
          })
        ).reason,
        "source_export_authorization_unavailable",
      );
      assert.equal(await h.state(prepared.attemptId), "prepared");
      assert.equal(h.calls.qrzWrites, 0);
    });
});

function afterMutationAdmission(
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
            args[1] !== "qrz"
          )
            return statement;
          return new Proxy(statement, {
            get(inner, name) {
              const value = Reflect.get(inner, name, inner);
              if (name === "first")
                return async (...values: unknown[]) => {
                  const result = await Reflect.apply(value, inner, values);
                  if (++reservations === 2) await change();
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

test("mapping and capability races after vendor admission cannot start a fresh mutation", async (t) => {
  for (const race of [
    "mapping",
    "capability",
    "credential",
    "missing_qso_scope",
    "missing_destination_scope",
  ] as const)
    await t.test(race, async (t) => {
      const h = await fixture(t);
      const gates = { ...fresh };
      const prepared = await h.prepare(gates);
      assert(prepared.attemptId);
      let changed = false;
      const intercepted = afterMutationAdmission(h.store, async () => {
        changed = true;
        if (race === "mapping")
          await h.store
            .statement(
              "UPDATE ledger SET remote_id='concurrent-mapping' WHERE destination='destination'",
            )
            .run();
        else if (race === "credential")
          await h.store
            .statement(
              "UPDATE private_data SET revoked_at=? WHERE connection='destination' AND kind='credential'",
              Date.now(),
            )
            .run();
        else if (race === "missing_qso_scope") gates.allowedQsoIds = undefined;
        else if (race === "missing_destination_scope")
          gates.allowedDestinationIds = undefined;
        else gates.qrzFreshInsertsEnabled = false;
      });
      const outcome = await dispatchAttempt(
        intercepted,
        "a",
        prepared.attemptId,
        gates,
        { fetcher: h.fetcher },
      );
      assert(changed);
      assert.equal(outcome.state, "blocked");
      assert.equal(h.calls.qrzWrites, 0);
      assert.notEqual(await h.state(prepared.attemptId), "uncertain");
      assert.equal(await h.count("destination_identity_claims"), 1);
      assert.equal(await h.count("attempt_source_export_proofs"), 1);
    });
});

test("fresh raw transport rejects replacement and deletion even if an adapter emits them", async (t) => {
  for (const action of ["replace", "delete"] as const)
    await t.test(action, async (t) => {
      const h = await fixture(t);
      const prepared = await h.prepare();
      assert(prepared.attemptId);
      t.mock.method(
        QrzClient.prototype,
        "insert",
        async function (this: QrzClient, record: AdifRecord) {
          if (action === "replace")
            return Reflect.apply(Reflect.get(this, "writeRecord"), this, [
              record,
              true,
            ]);
          return Reflect.apply(Reflect.get(this, "request"), this, [
            "DELETE",
            { LOGIDS: "1" },
          ]);
        },
      );
      assert.equal(
        (
          await dispatchAttempt(h.store, "a", prepared.attemptId, fresh, {
            fetcher: h.fetcher,
          })
        ).state,
        "blocked",
      );
      assert.equal(h.calls.qrzWrites, 0);
      assert.equal(await h.state(prepared.attemptId), "prepared");
      assert.equal(await h.count("destination_identity_claims"), 1);
    });
});

test("a lost fresh insert response remains uncertain and closed gates preserve read-only recovery", async (t) => {
  const h = await fixture(t);
  const prepared = await h.prepare();
  assert(prepared.attemptId);
  const lost: typeof fetch = async (input, init) => {
    const response = await h.fetcher(input, init);
    if (new URLSearchParams(String(init?.body)).get("ACTION") === "INSERT")
      throw new Error("synthetic lost receipt");
    return response;
  };
  assert.equal(
    (
      await dispatchAttempt(h.store, "a", prepared.attemptId, fresh, {
        fetcher: lost,
      })
    ).state,
    "uncertain",
  );
  assert.equal((await h.prepare()).reason, "unresolved_attempt");
  assert.equal(
    (
      await dispatchAttempt(h.store, "a", prepared.attemptId, fresh, {
        fetcher: h.fetcher,
      })
    ).state,
    "skipped",
  );
  assert.equal(
    (
      await dispatchAttempt(
        h.store,
        "a",
        prepared.attemptId,
        {
          ...fresh,
          exportsEnabled: false,
          liveWriteAuthorized: false,
          qrzFreshInsertsEnabled: false,
        },
        { fetcher: h.fetcher },
      )
    ).reason,
    "exports_disabled",
  );
  assert.equal(
    (
      await reconcileAttempt(h.store, "a", prepared.attemptId, {
        fetcher: h.fetcher,
      })
    ).state,
    "observed",
  );
  assert.equal(h.calls.qrzWrites, 1);
  assert.equal(await h.count("destination_identity_claims"), 1);
});

for (const cancellation of ["pending", "rejected"] as const)
  test(`QRZ ${cancellation} response cleanup preserves native no-attempt and uncertain lifecycle`, async (t) => {
    const h = await fixture(t);
    const failedResponse = () => {
      let release!: () => void;
      let started!: () => void;
      let cancellations = 0;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const cancellationStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([65]));
          },
          cancel() {
            cancellations++;
            started();
            return cancellation === "pending"
              ? gate
              : Promise.reject(new Error("synthetic cleanup failure"));
          },
        }),
        { status: 500 },
      );
      return {
        response,
        release,
        cancellationStarted,
        cancelled: () => cancellations,
      };
    };
    const beforeCleanup = async <T>(
      task: Promise<T>,
      cleanup: ReturnType<typeof failedResponse>,
    ): Promise<T> => {
      const observed = task.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const completed = await Promise.race([
          observed,
          // DB/crypto/admission before cancellation have no test deadline.
          cleanup.cancellationStarted.then(
            () =>
              new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), 10_000);
              }),
          ),
        ]);
        cleanup.release();
        const final = await observed;
        assert.notEqual(completed, null, "cleanup delayed the native outcome");
        assert.equal(cleanup.cancelled(), 1);
        if (!final.ok) throw final.error;
        return final.value;
      } finally {
        clearTimeout(timer);
        cleanup.release();
      }
    };

    const failedRead = failedResponse();
    let failedFetches = 0;
    await assert.rejects(
      beforeCleanup(
        prepareDue(h.store, h.key(), h.contact, fresh, {
          sourceProof: h.sourceProof,
          fetcher: async (_input, init) => {
            assert.equal(
              new URLSearchParams(String(init?.body)).get("ACTION"),
              "FETCH",
            );
            failedFetches++;
            return failedRead.response;
          },
        }),
        failedRead,
      ),
      (error: unknown) =>
        error instanceof QrzError && error.kind === "transient",
    );
    assert.equal(failedFetches, 1);
    for (const table of [
      "attempts",
      "attempt_artifacts",
      "attempt_source_export_proofs",
      "destination_identity_claims",
    ])
      assert.equal(await h.count(table), 0);
    assert.equal(h.calls.qrzWrites, 0);

    const prepared = await h.prepare();
    assert(prepared.attemptId);
    const attemptId = prepared.attemptId;
    const immutable = async () => {
      const rows: Record<string, unknown> = {};
      for (const table of [
        "attempts",
        "attempt_artifacts",
        "attempt_source_export_proofs",
        "attempt_identity_claims",
        "destination_identity_claims",
      ])
        rows[table] = (
          await h.store.statement(`SELECT * FROM ${table}`).all()
        ).results;
      return rows;
    };
    const before = await immutable();
    const failedWrite = failedResponse();
    let inserts = 0;
    const outcome = await beforeCleanup(
      dispatchAttempt(h.store, "a", attemptId, fresh, {
        fetcher: async (input, init) => {
          const response = await h.fetcher(input, init);
          const form = new URLSearchParams(String(init?.body));
          if (form.get("ACTION") === "INSERT") {
            inserts++;
            assert.equal(form.has("OPTION"), false);
            return failedWrite.response;
          }
          return response;
        },
      }),
      failedWrite,
    );
    assert.equal(outcome.state, "uncertain");
    assert.equal(await h.state(attemptId), "uncertain");
    assert.equal(inserts, 1);
    assert.equal(h.calls.qrzWrites, 1);
    assert.deepEqual(await immutable(), before);
    const events = (
      await h.store
        .statement(
          "SELECT state FROM attempt_events WHERE tenant='a' AND attempt=? ORDER BY id",
          attemptId,
        )
        .all<{ state: string }>()
    ).results.map((row) => row.state);
    assert.equal(events.at(-1), "uncertain");
    assert(!events.includes("retry_scheduled"));
    assert(!events.includes("delivered"));
    assert.equal((await h.prepare()).reason, "unresolved_attempt");
    assert.equal(
      (
        await dispatchAttempt(h.store, "a", attemptId, fresh, {
          fetcher: async () => assert.fail("uncertain attempt was resent"),
        })
      ).state,
      "skipped",
    );
    assert.equal(h.calls.qrzWrites, 1);
    assert.deepEqual(await immutable(), before);
  });

test("a known-unsent admission hold reuses its immutable fresh attempt", async (t) => {
  const h = await fixture(t);
  const gates = { ...fresh };
  const prepared = await h.prepare(gates);
  assert(prepared.attemptId);
  const intercepted = afterMutationAdmission(h.store, async () => {
    gates.qrzFreshInsertsEnabled = false;
  });
  assert.equal(
    (
      await dispatchAttempt(intercepted, "a", prepared.attemptId, gates, {
        fetcher: h.fetcher,
      })
    ).state,
    "blocked",
  );
  assert.equal(await h.state(prepared.attemptId), "prepared");
  gates.qrzFreshInsertsEnabled = true;
  await h.store
    .statement(
      "UPDATE attempt_state SET due_at=0 WHERE attempt=?",
      prepared.attemptId,
    )
    .run();
  assert.equal(
    (
      await dispatchAttempt(h.store, "a", prepared.attemptId, gates, {
        fetcher: h.fetcher,
      })
    ).state,
    "delivered",
  );
  assert.equal(h.calls.qrzWrites, 1);
  assert.equal(await h.count("attempts"), 1);
  assert.equal(await h.count("attempt_source_export_proofs"), 1);
});
