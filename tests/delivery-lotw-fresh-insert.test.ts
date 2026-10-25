import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import {
  type DeliveryGates,
  deliveryMode,
  dispatchAttempt,
  prepareDue,
  type PreparedPayload,
  reconcileAttempt,
} from "../src/delivery.ts";
import { LotwClient } from "../src/lotw.ts";
import { canonicalLotwIdentity, lotwRemoteIdentity } from "../src/reconcile.ts";
import { canonical, sha256 } from "../src/security.ts";
import {
  buildSignedTq8,
  SIGNING_CONFIGURATION,
  type SigningCredential,
} from "../src/signing.ts";
import type { Store } from "../src/store.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";
import { schedulerFixture } from "./runtime-fixtures.ts";
import { mintFixtureSourceProofs } from "./source-proof-fixtures.ts";

const fresh: DeliveryGates = {
  exportsEnabled: true,
  liveWriteAuthorized: true,
  sourceBoundaryVerified: false,
  lotwFreshInsertsEnabled: true,
  allowedQsoIds: ["q1"],
  allowedDestinationIds: ["lotw"],
};
const boundary: DeliveryGates = {
  ...fresh,
  sourceBoundaryVerified: true,
  lotwFreshInsertsEnabled: false,
};
const previousSigningConfiguration = "ferry-lotw-v2-us-ca-2";

async function deliverySnapshot(store: Store) {
  return Promise.all(
    [
      "ledger",
      "attempts",
      "attempt_state",
      "attempt_events",
      "private_data",
      "destination_identity_claims",
      "attempt_identity_claims",
      "attempt_source_export_proofs",
      "attempt_lotw_ownership_pins",
      "lotw_ownership_checks",
      "lotw_ownership_inputs",
      "lotw_ownership_evidence",
      "leases",
      "vendor_requests",
    ].map(async (table) => [
      table,
      (await store.statement(`SELECT * FROM ${table}`).all()).results,
    ]),
  );
}

async function fixture(t: TestContext, oldPresence = false) {
  t.mock.method(globalThis, "fetch", async () =>
    assert.fail("Unexpected unmocked vendor transport"),
  );
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
    observedAt: oldPresence ? Date.now() - 240_000 : undefined,
  });
  await h.store
    .statement(
      "UPDATE ledger SET state='missing_current_identity',due_at=0 WHERE tenant='a' AND source='source' AND qso='q1'",
    )
    .run();
  const contact = evidence.snapshots[0]!.contact;
  const sourceProof = evidence.authorizations[0]!;
  const key = (destination = "lotw") => ({
    tenant: "a",
    source: "source",
    qso: "q1",
    destination,
  });
  const prepare = (gates = fresh, fetcher = h.fetcher) =>
    prepareDue(h.store, key(), contact, gates, { fetcher, sourceProof });
  const state = (id: string) =>
    h.store
      .statement(
        "SELECT state FROM attempt_state WHERE tenant='a' AND attempt=?",
        id,
      )
      .first<string>("state");
  const count = (table: string) =>
    h.store.statement(`SELECT count(*) AS n FROM ${table}`).first<number>("n");
  return {
    ...h,
    contact,
    sourceProof,
    proof: evidence.proofs[0]!,
    key,
    prepare,
    state,
    count,
  };
}

test("LoTW capability is separately authorized and never supplies source boundary or QRZ authority", () => {
  assert.equal(deliveryMode(fresh, "lotw"), "lotw_fresh_insert");
  assert.equal(deliveryMode(fresh, "qrz"), null);
  assert.equal(deliveryMode(boundary, "lotw"), "source_boundary");
  for (const flag of [
    "exportsEnabled",
    "liveWriteAuthorized",
    "lotwFreshInsertsEnabled",
  ] as const)
    assert.equal(deliveryMode({ ...fresh, [flag]: false }, "lotw"), null);
  assert.equal(
    deliveryMode({ ...fresh, lotwFreshInsertsEnabled: undefined }, "lotw"),
    null,
  );
});

test("first LoTW upload requires two complete three-day reads, pins its mode, and only later becomes observed", async (t) => {
  const h = await fixture(t);
  await h.store
    .statement(
      "UPDATE ledger SET baseline_hash=source_hash WHERE destination='lotw'",
    )
    .run();
  const queries: URLSearchParams[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/lotwuser/lotwreport.adi")
      queries.push(url.searchParams);
    return h.fetcher(input, init);
  };
  const prepared = await h.prepare(fresh, fetcher);
  assert.equal(prepared.state, "prepared");
  assert(prepared.attemptId);
  assert.equal(
    await h.store
      .statement(
        "SELECT authorization_mode FROM attempt_source_export_proofs WHERE attempt=?",
        prepared.attemptId,
      )
      .first("authorization_mode"),
    "lotw_fresh_insert",
  );
  assert.equal(
    (
      await dispatchAttempt(h.store, "a", prepared.attemptId, fresh, {
        fetcher,
      })
    ).state,
    "submitted",
  );
  assert.equal(await h.state(prepared.attemptId), "submitted");
  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.equal(query.get("qso_startdate"), "2026-10-21");
    assert.equal(query.get("qso_enddate"), "2026-10-23");
    assert.equal(query.get("qso_owncall"), "W1AW");
    assert.equal(query.get("qso_callsign"), "K1ABC");
    assert.equal(query.has("qso_band"), false);
    assert.equal(query.has("qso_mode"), false);
  }
  assert.equal(h.calls.certificateStatus, 2);
  assert.equal(h.calls.lotwUploads, 1);
  assert.equal(h.calls.qrzWrites, 0);
  assert.equal(await h.count("source_cutovers"), 0);
  assert.equal(h.contact.startAtMillis % 1000, 123);
  assert.equal(h.contact.grid, "FN31AA12");
  assert.match(h.tq8Texts[0]!, /<GRIDSQUARE:8>FN31AA12/);
  assert.equal(
    (
      await dispatchAttempt(h.store, "a", prepared.attemptId, fresh, {
        fetcher: async () => assert.fail("Submitted artifact resent"),
      })
    ).state,
    "skipped",
  );
  // Receipt recovery remains independent of both capabilities and write gates.
  assert.equal(
    (await reconcileAttempt(h.store, "a", prepared.attemptId, { fetcher }))
      .state,
    "observed",
  );
  assert.equal(h.calls.lotwUploads, 1);
});

test("a prepared prior signing profile is held before claims or vendor admission without changing its artifact", async (t) => {
  const h = await fixture(t);
  const prepared = await prepareDue(h.store, h.key(), h.contact, fresh, {
    sourceProof: h.sourceProof,
    fetcher: h.fetcher,
    sign: async (...args) => {
      const artifact = await buildSignedTq8(...args);
      // TQSL_IDENT is outside the signed canonical contact. Model a retained
      // profile-2 artifact without changing its signature or staging guards.
      assert.notEqual(SIGNING_CONFIGURATION, previousSigningConfiguration);
      const text = artifact.text.replace(
        SIGNING_CONFIGURATION,
        previousSigningConfiguration,
      );
      assert.notEqual(text, artifact.text);
      return {
        ...artifact,
        text,
        bytes: gzipSync(text),
        configurationVersion: previousSigningConfiguration,
      };
    },
  });
  assert.equal(prepared.state, "prepared");
  assert(prepared.attemptId);
  const before = await deliverySnapshot(h.store);
  const calls = { ...h.calls };
  const result = await dispatchAttempt(
    h.store,
    "a",
    prepared.attemptId,
    fresh,
    { fetcher: async () => assert.fail("Old profile reached a vendor") },
  );
  assert.deepEqual(result, {
    state: "blocked",
    reason: "lotw_signing_configuration_changed",
  });
  assert.equal(await h.state(prepared.attemptId), "prepared");
  assert.deepEqual(await deliverySnapshot(h.store), before);
  assert.deepEqual(h.calls, calls);
  assert.equal(h.calls.lotwUploads, 0);
});

async function legacyFst4wFixture(
  t: TestContext,
  state: "prepared" | "submitted" | "uncertain",
  configurationVersion = previousSigningConfiguration,
) {
  t.mock.method(globalThis, "fetch", async () =>
    assert.fail("Unexpected unmocked vendor transport"),
  );
  const id = `legacy-fst4w-${state}`;
  let retained!: Extract<PreparedPayload, { kind: "lotw" }>;
  let remoteId = "";
  const h = await schedulerFixture(async (legacy, records) => {
    records.qso.mode = "FST4W";
    records.lotwRecords[0]!.MODE = "FST4W";
    // These are retained prior-worker facts, not a new current projection.
    // Today's source projection also rejects FST4W before signing.
    const generation = await sha256(canonical(records.qso));
    const sourceHash = await sha256(
      canonical({ qso: records.qso, operation: records.operation }),
    );
    const identity = canonicalLotwIdentity(records.lotwRecords[0]!);
    remoteId = await lotwRemoteIdentity(identity);
    const station = {
      callsign: "W1AW",
      dxcc: 291,
      grid: "FN31AA",
      state: "CT",
      county: "Tolland",
      cqZone: 5,
      ituZone: 8,
    };
    const contact = {
      id: "q1",
      generation,
      call: "K1ABC",
      band: "20m",
      mode: "FST4W",
      date: "2026-10-22",
      time: "12:00:01Z",
      frequencyMHz: "14.074",
    };
    const at = Date.now() - 86400000;
    const projectionHash = await sha256(canonical({ station, contact }));
    retained = {
      kind: "lotw",
      // Recovery treats previous encrypted artifacts as opaque. This models
      // already-sent bytes, never constructs a newly signable FST4W artifact.
      tq8: Buffer.from("opaque prior-profile FST4W artifact").toString(
        "base64",
      ),
      station,
      contact,
      members: [{ id: "q1", generation }],
      projectionHash,
      preparedAt: new Date(at).toISOString(),
      certificateVersion: "scheduler-signing-v1",
      configurationVersion,
    };
    await legacy.store
      .statement(
        "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,state,provenance,due_at,updated_at) VALUES('a','source','q1','lotw',?,?,'missing_current_identity','unknown',0,?)",
        generation,
        sourceHash,
        at,
      )
      .run();
    await legacy.store
      .statement(
        "INSERT INTO attempts(tenant,id,source,qso,destination,generation,payload_id,payload_hash,credential_version,created_at,source_hash) VALUES('a',?,'source','q1','lotw',?,?,?,'fixture-lotw',?,?)",
        id,
        generation,
        id,
        projectionHash,
        at,
        sourceHash,
      )
      .run();
    await legacy.store
      .statement(
        "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a',?,?,0,?)",
        id,
        state,
        at,
      )
      .run();
    await legacy.store
      .statement(
        "INSERT INTO destination_identity_claims VALUES('a','lotw','lotw',?,'source','q1',?)",
        remoteId,
        at,
      )
      .run();
    await legacy.store
      .statement(
        "INSERT INTO attempt_identity_claims(tenant,attempt,destination,vendor,identity_hash,source,qso) VALUES('a',?,'lotw','lotw',?,'source','q1')",
        id,
        remoteId,
      )
      .run();
    await legacy.store
      .statement(
        "INSERT INTO attempt_events(tenant,attempt,state,at) VALUES('a',?,?,?)",
        id,
        state,
        at,
      )
      .run();
    await (
      await legacy.store.putPrivate("a", "lotw", id, "outbox", retained)
    ).run();
    if (state !== "prepared")
      await (
        await legacy.store.lotwIdentityStatement(
          { tenant: "a", source: "source", qso: "q1", destination: "lotw" },
          { identity, remoteId },
          state,
          at,
          { sql: "1", params: [] },
        )
      ).run();
    // schedulerFixture applies all current migrations after this legacy seed.
  });
  t.after(() => h.mf.dispose());
  return { ...h, id, retained, remoteId };
}

test("legacy submitted and uncertain FST4W identities remain readable without signing or resending", async (t) => {
  for (const state of ["submitted", "uncertain"] as const)
    await t.test(state, async (t) => {
      const h = await legacyFst4wFixture(t, state);
      const claims = (
        await h.store
          .statement("SELECT * FROM destination_identity_claims")
          .all()
      ).results;
      const identities = (
        await h.store
          .statement("SELECT * FROM private_data WHERE kind='lotw_identity'")
          .all()
      ).results;
      const before = await deliverySnapshot(h.store);
      assert.deepEqual(
        await h.store.private("a", "lotw", h.id, "outbox"),
        h.retained,
      );
      assert.equal(
        (
          await dispatchAttempt(h.store, "a", h.id, fresh, {
            fetcher: async () => assert.fail("Legacy receipt resent"),
          })
        ).reason,
        "attempt_not_claimable",
      );
      assert.deepEqual(await deliverySnapshot(h.store), before);
      const observed = await reconcileAttempt(h.store, "a", h.id, {
        fetcher: async (input, init) => {
          assert.equal(
            new URL(String(input)).pathname,
            "/lotwuser/lotwreport.adi",
          );
          return h.fetcher(input, init);
        },
        sign: async () => assert.fail("Legacy receipt signed again"),
      });
      assert.equal(observed.state, "observed");
      assert.deepEqual(
        await h.store
          .statement(
            "SELECT state,remote_id FROM attempt_state WHERE attempt=?",
            h.id,
          )
          .first(),
        { state: "observed", remote_id: h.remoteId },
      );
      assert.deepEqual(
        (
          await h.store
            .statement("SELECT * FROM destination_identity_claims")
            .all()
        ).results,
        claims,
      );
      assert.deepEqual(
        (
          await h.store
            .statement("SELECT * FROM private_data WHERE kind='lotw_identity'")
            .all()
        ).results,
        identities,
      );
      assert.equal(h.calls.lotwQueries, 1);
      assert.equal(h.calls.certificateStatus, 0);
      assert.equal(h.calls.lotwUploads, 0);
      assert.equal(h.calls.qrzWrites, 0);
      assert.equal(
        (
          await dispatchAttempt(h.store, "a", h.id, fresh, {
            fetcher: async () => assert.fail("Observed receipt resent"),
          })
        ).reason,
        "attempt_or_connection_unavailable",
      );
      // Successful exact recovery retains its identity/observation and performs
      // the existing outbox purge; there is no remaining dispatchable payload.
      assert.equal(await h.store.private("a", "lotw", h.id, "outbox"), null);
    });
});

test("a current profile label cannot dispatch unsupported legacy signing fields", async (t) => {
  const h = await legacyFst4wFixture(t, "prepared", SIGNING_CONFIGURATION);
  const before = await deliverySnapshot(h.store);
  assert.deepEqual(
    await dispatchAttempt(h.store, "a", h.id, fresh, {
      fetcher: async () =>
        assert.fail("Unsupported signing fields reached vendor"),
    }),
    { state: "blocked", reason: "lotw_signing_fields_unavailable" },
  );
  assert.deepEqual(await deliverySnapshot(h.store), before);
  assert.equal(
    h.calls.lotwQueries + h.calls.certificateStatus + h.calls.lotwUploads,
    0,
  );
});

test("fresh LoTW requires defined scopes, proof and no accepted/correction baseline before reads or signing", async (t) => {
  const h = await fixture(t);
  const forbidden: typeof fetch = async () =>
    assert.fail("Ineligible preparation reached vendor");
  const sign: typeof buildSignedTq8 = async () =>
    assert.fail("Ineligible preparation reached signer");
  for (const gates of [
    { ...fresh, allowedQsoIds: [] },
    { ...fresh, allowedDestinationIds: [] },
    { ...fresh, allowedQsoIds: undefined },
    { ...fresh, allowedDestinationIds: undefined },
    { ...fresh, lotwFreshInsertsEnabled: false },
  ])
    assert.equal(
      (
        await prepareDue(h.store, h.key(), h.contact, gates, {
          fetcher: forbidden,
          sign,
          sourceProof: h.sourceProof,
        })
      ).state,
      "blocked",
    );
  assert.equal(
    (
      await prepareDue(h.store, h.key(), h.contact, fresh, {
        fetcher: forbidden,
        sign,
      })
    ).reason,
    "source_export_proof_unavailable",
  );
  assert.equal(
    (
      await prepareDue(
        h.store,
        h.key("destination"),
        h.contact,
        { ...fresh, allowedDestinationIds: ["destination"] },
        { fetcher: forbidden, sign, sourceProof: h.sourceProof },
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
    "provenance='adopted'",
  ]) {
    await h.store
      .statement(`UPDATE ledger SET ${update} WHERE destination='lotw'`)
      .run();
    assert.equal(
      (
        await prepareDue(h.store, h.key(), h.contact, fresh, {
          fetcher: forbidden,
          sign,
          sourceProof: h.sourceProof,
        })
      ).reason,
      "lotw_fresh_insert_unavailable",
    );
    await h.store
      .statement(
        "UPDATE ledger SET baseline_hash=NULL,sent_hash=NULL,remote_hash=NULL,confirmed=0,state='missing_current_identity',provenance='unknown' WHERE destination='lotw'",
      )
      .run();
  }
  assert.equal(await h.count("attempts"), 0);
  // Explicit wildcard remains supported, unlike omitted direct API scopes.
  assert.equal(
    (
      await h.prepare({
        ...fresh,
        allowedQsoIds: null,
        allowedDestinationIds: null,
      })
    ).state,
    "prepared",
  );
});

test("any three-day history blocks signing and newly appearing history returns dispatch to known-unsent", async (t) => {
  const h = await fixture(t);
  const neighbor = {
    STATION_CALLSIGN: "W1AW",
    CALL: "K1ABC",
    QSO_DATE: "20261021",
    TIME_ON: "235900",
    BAND: "40m",
    MODE: "CW",
    QSL_RCVD: "N",
  };
  h.lotwRecords.push(neighbor);
  const held = await prepareDue(h.store, h.key(), h.contact, fresh, {
    fetcher: h.fetcher,
    sourceProof: h.sourceProof,
    sign: async () => assert.fail("Nonempty history reached signer"),
  });
  assert.equal(held.reason, "lotw_fresh_insert_history_present");
  assert.equal(await h.count("attempts"), 0);
  h.lotwRecords.length = 0;
  const prepared = await h.prepare();
  assert(prepared.attemptId);
  h.lotwRecords.push(neighbor);
  const result = await dispatchAttempt(
    h.store,
    "a",
    prepared.attemptId,
    fresh,
    { fetcher: h.fetcher },
  );
  assert.equal(result.reason, "lotw_fresh_insert_history_present");
  assert.equal(await h.state(prepared.attemptId), "prepared");
  assert.equal(h.calls.lotwUploads, 0);
  assert.equal(await h.count("destination_identity_claims"), 1);
});

test("query failures, malformed reports and query budget deferrals never become uncertain writes", async (t) => {
  const h = await fixture(t);
  const prepared = await h.prepare();
  assert(prepared.attemptId);
  for (const kind of ["transport", "malformed", "deferred"] as const) {
    const fetcher: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname === "/lotwuser/lotwreport.adi") {
        if (kind === "transport")
          throw new Error("synthetic transport failure");
        if (kind === "deferred")
          throw new VendorDeferredError(Date.now() + 1_000);
        return new Response("<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:1>0<EOH>");
      }
      return h.fetcher(input, init);
    };
    const result = await dispatchAttempt(
      h.store,
      "a",
      prepared.attemptId,
      fresh,
      { fetcher },
    );
    assert.equal(result.state, "retry_scheduled");
    assert.equal(
      result.reason,
      kind === "deferred"
        ? "vendor_request_deferred"
        : "lotw_fresh_insert_history_unavailable",
    );
    assert.equal(await h.state(prepared.attemptId), "prepared");
    await h.store
      .statement(
        "UPDATE attempt_state SET due_at=0 WHERE attempt=?",
        prepared.attemptId,
      )
      .run();
  }
  assert.equal(h.calls.lotwUploads, 0);
  assert.equal(await h.count("attempt_source_export_proofs"), 1);
  assert.equal(await h.count("destination_identity_claims"), 1);
  assert.equal(
    (
      await dispatchAttempt(h.store, "a", prepared.attemptId, fresh, {
        fetcher: h.fetcher,
      })
    ).state,
    "submitted",
  );
  assert.equal(h.calls.lotwUploads, 1);
});

test("fresh preparation requires query credentials, complete history and a single signed member", async (t) => {
  const h = await fixture(t);
  const credential = await h.store.private<{
    signingCredentials: SigningCredential[];
    query: { username: string; password: string };
  }>("a", "lotw", "fixture-lotw", "credential");
  assert(credential);
  await h.store.db.batch([
    h.store.statement(
      "DELETE FROM private_data WHERE tenant='a' AND connection='lotw' AND id='fixture-lotw' AND kind='credential'",
    ),
    await h.store.putPrivate("a", "lotw", "fixture-lotw", "credential", {
      signingCredentials: credential.signingCredentials,
    }),
  ]);
  const forbidden: typeof fetch = async () =>
    assert.fail("No-query fresh preparation read vendor");
  assert.equal(
    (
      await prepareDue(h.store, h.key(), h.contact, fresh, {
        sourceProof: h.sourceProof,
        fetcher: forbidden,
        sign: async () => assert.fail("No-query fresh preparation signed"),
      })
    ).reason,
    "lotw_query_required_for_fresh_insert",
  );
  await h.store.db.batch([
    h.store.statement(
      "DELETE FROM private_data WHERE tenant='a' AND connection='lotw' AND id='fixture-lotw' AND kind='credential'",
    ),
    await h.store.putPrivate(
      "a",
      "lotw",
      "fixture-lotw",
      "credential",
      credential,
    ),
  ]);
  assert.equal(
    (
      await prepareDue(h.store, h.key(), h.contact, fresh, {
        sourceProof: h.sourceProof,
        fetcher: async () =>
          new Response("<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:1>0<EOH>"),
        sign: async () => assert.fail("Incomplete history signed"),
      })
    ).reason,
    "lotw_fresh_insert_history_unavailable",
  );
  assert.equal(
    (
      await prepareDue(h.store, h.key(), h.contact, fresh, {
        sourceProof: h.sourceProof,
        fetcher: h.fetcher,
        sign: async (...args) => {
          const artifact = await buildSignedTq8(...args);
          return {
            ...artifact,
            members: [
              ...artifact.members,
              { id: "another", generation: "another" },
            ],
          };
        },
      })
    ).reason,
    "lotw_fresh_insert_unavailable",
  );
  assert.equal(await h.count("attempts"), 0);
  assert.equal(h.calls.lotwUploads, 0);
});

test("capability revoked during certificate read cannot sign or turn a prepared upload into uncertainty", async (t) => {
  const h = await fixture(t);
  const gates = { ...fresh };
  const revokeAfterStatus: typeof fetch = async (input, init) => {
    const response = await h.fetcher(input, init);
    if (new URL(String(input)).pathname === "/lotw/crl")
      gates.lotwFreshInsertsEnabled = false;
    return response;
  };
  assert.equal(
    (
      await prepareDue(h.store, h.key(), h.contact, gates, {
        sourceProof: h.sourceProof,
        fetcher: revokeAfterStatus,
        sign: async () => assert.fail("Revoked capability signed"),
      })
    ).state,
    "blocked",
  );
  gates.lotwFreshInsertsEnabled = true;
  const prepared = await h.prepare(gates);
  assert(prepared.attemptId);
  assert.equal(
    (
      await dispatchAttempt(h.store, "a", prepared.attemptId, gates, {
        fetcher: revokeAfterStatus,
      })
    ).state,
    "blocked",
  );
  assert.equal(await h.state(prepared.attemptId), "prepared");
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

test("fresh LoTW repeats capability, scope, mapping, credential, proof and certificate checks after upload admission", async (t) => {
  for (const race of [
    "capability",
    "scope",
    "mapping",
    "credential",
    "proof",
    "certificate",
  ] as const)
    await t.test(race, async (t) => {
      const h = await fixture(t, race === "proof");
      const gates = { ...fresh };
      const prepared = await h.prepare(gates);
      assert(prepared.attemptId);
      let clock = Date.now();
      t.mock.method(Date, "now", () => clock);
      if (race === "certificate") {
        const original = h.store.private.bind(h.store);
        t.mock.method(
          h.store,
          "private",
          async (...args: Parameters<Store["private"]>) => {
            const value = await original(...args);
            if (args[1] === "lotw" && args[3] === "credential" && value) {
              const copy = structuredClone(value) as {
                signingCredentials: SigningCredential[];
              };
              copy.signingCredentials[0]!.validTo = new Date(
                clock + 2_000,
              ).toISOString();
              return copy;
            }
            return value;
          },
        );
      }
      let changed = false;
      const intercepted = afterUploadAdmission(h.store, async () => {
        changed = true;
        if (race === "capability") gates.lotwFreshInsertsEnabled = false;
        if (race === "scope") gates.allowedDestinationIds = undefined;
        if (race === "mapping")
          await h.store
            .statement(
              "UPDATE ledger SET sent_hash='accepted' WHERE destination='lotw'",
            )
            .run();
        if (race === "credential")
          await h.store
            .statement(
              "UPDATE private_data SET revoked_at=? WHERE connection='lotw' AND kind='credential'",
              clock,
            )
            .run();
        if (race === "proof") clock = h.proof.expiresAt + 1;
        if (race === "certificate") clock += 3_000;
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
      assert.equal(h.calls.lotwUploads, 0);
      assert.notEqual(await h.state(prepared.attemptId), "uncertain");
      assert.equal(await h.count("destination_identity_claims"), 1);
    });
});

test("fresh raw upload rejects altered bytes, extra fields and alternate endpoints", async (t) => {
  for (const malformed of ["bytes", "field", "endpoint", "method"] as const)
    await t.test(malformed, async (t) => {
      const h = await fixture(t);
      const prepared = await h.prepare();
      assert(prepared.attemptId);
      t.mock.method(
        LotwClient.prototype,
        "submit",
        async function (this: LotwClient, bytes: Uint8Array) {
          const form = new FormData();
          form.set(
            "upfile",
            new Blob(
              [new Uint8Array(malformed === "bytes" ? [0x1f, 0x8b, 0] : bytes)],
              { type: "application/octet-stream" },
            ),
            "lofi-qso-ferry.tq8",
          );
          if (malformed === "field") form.set("extra", "forbidden");
          try {
            await Reflect.apply(Reflect.get(this, "request"), globalThis, [
              malformed === "endpoint"
                ? "https://lotw.arrl.org/lotw/delete"
                : "https://lotw.arrl.org/lotw/upload",
              {
                method: malformed === "method" ? "PUT" : "POST",
                body: form,
                redirect: "manual",
              },
            ]);
          } catch {
            /* Match the normal adapter's uncertain response; transport tracks unsent. */
          }
          return {
            state: "uncertain" as const,
            code: "transport_after_dispatch",
          };
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
      assert.equal(h.calls.lotwUploads, 0);
      assert.equal(await h.state(prepared.attemptId), "prepared");
    });
});

test("lost upload response stays uncertain and cannot be retried even with fresh mode enabled", async (t) => {
  const h = await fixture(t);
  const prepared = await h.prepare();
  assert(prepared.attemptId);
  const fetcher: typeof fetch = async (input, init) => {
    const response = await h.fetcher(input, init);
    if (new URL(String(input)).pathname === "/lotw/upload")
      throw new Error("response lost after acceptance");
    return response;
  };
  assert.equal(
    (
      await dispatchAttempt(h.store, "a", prepared.attemptId, fresh, {
        fetcher,
      })
    ).state,
    "uncertain",
  );
  assert.equal(
    (
      await dispatchAttempt(h.store, "a", prepared.attemptId, fresh, {
        fetcher: async () => assert.fail("Uncertain upload resent"),
      })
    ).state,
    "skipped",
  );
  assert.equal(
    (
      await reconcileAttempt(h.store, "a", prepared.attemptId, {
        fetcher: h.fetcher,
      })
    ).state,
    "observed",
  );
  assert.equal(h.calls.lotwUploads, 1);
});

test("LoTW proof capability remains immutable across flag changes", async (t) => {
  for (const original of [fresh, boundary])
    await t.test(
      original.sourceBoundaryVerified ? "boundary" : "fresh",
      async (t) => {
        const h = await fixture(t);
        const prepared = await h.prepare(original);
        assert(prepared.attemptId);
        const changed = original === fresh ? boundary : fresh;
        assert.equal(
          (
            await dispatchAttempt(h.store, "a", prepared.attemptId, changed, {
              fetcher: async () => assert.fail("Immutable mode promoted"),
            })
          ).reason,
          "source_export_authorization_unavailable",
        );
        assert.equal(await h.state(prepared.attemptId), "prepared");
      },
    );
});
