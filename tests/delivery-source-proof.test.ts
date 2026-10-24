import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  cancelStalePreparedSourceProof,
  type DeliveryGates,
  dispatchAttempt,
  prepareDue,
} from "../src/delivery.ts";
import {
  claimedAttemptCurrent,
  destinationIdentityClaim,
} from "../src/identity-claims.ts";
import { buildSignedTq8, type SigningCredential } from "../src/signing.ts";
import { attemptSourceExportProofCurrent } from "../src/source-export-proofs.ts";
import type { Store } from "../src/store.ts";
import { schedulerFixture } from "./runtime-fixtures.ts";
import { mintFixtureSourceProofs } from "./source-proof-fixtures.ts";

const gates: DeliveryGates = {
  exportsEnabled: true,
  liveWriteAuthorized: true,
  sourceBoundaryVerified: true,
};

async function setup(t: TestContext, oldPresence = false) {
  const h = await schedulerFixture();
  t.after(() => h.mf.dispose());
  h.qso.startAtMillis = Number(h.qso.startAtMillis) + 123;
  h.operation.grid = "FN31AA12";
  h.qrzRecords.length = 0;
  h.lotwRecords.length = 0;
  const source = (await h.store.connection("a", "source"))!;
  const destinations = await Promise.all(
    ["destination", "lotw"].map(async (id) => {
      const destination = await h.store.connection("a", id);
      assert.ok(destination);
      return destination;
    }),
  );
  const mint = async (observedAt?: number) => {
    const evidence = await mintFixtureSourceProofs(h.store, {
      source,
      qsos: [h.qso],
      operations: [h.operation],
      destinations,
      observedAt,
    });
    await h.store
      .statement(
        "UPDATE ledger SET state='missing_current_identity',due_at=0 WHERE tenant='a' AND source='source' AND qso='q1'",
      )
      .run();
    return {
      contact: evidence.snapshots[0]!.contact,
      proof: evidence.proofs[0]!,
      sourceProof: evidence.authorizations[0]!,
    };
  };
  const evidence = await mint(oldPresence ? Date.now() - 240_000 : undefined);
  const key = (destination = "destination") => ({
    tenant: "a",
    source: "source",
    qso: "q1",
    destination,
  });
  const state = (id: string) =>
    h.store
      .statement(
        "SELECT state FROM attempt_state WHERE tenant='a' AND attempt=?",
        id,
      )
      .first<string>("state");
  const claims = () =>
    h.store
      .statement("SELECT count(*) AS n FROM destination_identity_claims")
      .first<number>("n");
  return { ...h, ...evidence, mint, key, state, claims };
}

test("source proof is mandatory before either vendor read or signature, with no missing-policy shortcut", async (t) => {
  const h = await setup(t);
  for (const destination of ["destination", "lotw"]) {
    const forbidden = async () =>
      assert.fail("Missing proof reached vendor transport");
    assert.deepEqual(
      await prepareDue(h.store, h.key(destination), h.contact, gates, {
        fetcher: forbidden,
        sign: async () => assert.fail("Missing proof reached signing"),
      }),
      { state: "blocked", reason: "source_export_proof_unavailable" },
    );
    assert.deepEqual(
      await prepareDue(h.store, h.key(destination), h.contact, gates, {
        fetcher: forbidden,
        sourceProof: {
          ...h.sourceProof,
          scope: { ...h.sourceProof.scope, tenant: "another-tenant" },
        },
      }),
      { state: "blocked", reason: "source_export_proof_unavailable" },
    );
  }
  assert.equal(await h.claims(), 0);
  assert.equal(
    await h.store
      .statement("SELECT count(*) AS n FROM attempts")
      .first<number>("n"),
    0,
  );
});

test("both vendors pin a genuine proof while preserving fractional source time and full grid", async (t) => {
  const h = await setup(t);
  for (const destination of ["destination", "lotw"]) {
    const prepared = await prepareDue(
      h.store,
      h.key(destination),
      h.contact,
      gates,
      {
        sourceProof: h.sourceProof,
        fetcher: h.fetcher,
      },
    );
    assert.equal(prepared.state, "prepared");
    assert.ok(prepared.attemptId);
    assert.equal(
      await attemptSourceExportProofCurrent(h.store, "a", prepared.attemptId),
      true,
    );
    const pin = await h.store
      .statement(
        "SELECT proof_id FROM attempt_source_export_proofs WHERE tenant='a' AND attempt=?",
        prepared.attemptId,
      )
      .first<string>("proof_id");
    assert.equal(pin, h.proof.id);
    assert.equal(
      (
        await dispatchAttempt(h.store, "a", prepared.attemptId, gates, {
          fetcher: h.fetcher,
        })
      ).state,
      destination === "destination" ? "delivered" : "submitted",
    );
  }
  assert.equal(h.calls.qrzWrites, 1);
  assert.equal(h.calls.lotwUploads, 1);
  assert.equal(h.contact.startAtMillis % 1000, 123);
  assert.equal(h.contact.grid, "FN31AA12");
  assert.equal(h.qrzMutations[0]?.MY_GRIDSQUARE, "FN31AA12");
  assert.match(h.tq8Texts[0]!, /<GRIDSQUARE:8>FN31AA12/);
});

test("expiry during signing advances an injected clock and cannot stage the resulting artifact", async (t) => {
  const h = await setup(t, true);
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  let signed = 0;
  const prepared = await prepareDue(h.store, h.key("lotw"), h.contact, gates, {
    now: clock,
    sourceProof: h.sourceProof,
    fetcher: h.fetcher,
    sign: async (...args) => {
      const artifact = await buildSignedTq8(...args);
      signed++;
      clock = h.proof.expiresAt + 1;
      return artifact;
    },
  });
  assert.equal(signed, 1);
  assert.deepEqual(prepared, {
    state: "blocked",
    reason: "source_export_proof_unavailable",
  });
  assert.equal(await h.claims(), 0);
  assert.equal(
    await h.store
      .statement("SELECT count(*) AS n FROM attempts")
      .first<number>("n"),
    0,
  );
  assert.equal(h.calls.lotwUploads, 0);
});

function delayAdmission(
  store: Store,
  vendor: "qrz" | "lotw",
  delayed: () => void,
): Store {
  let reservations = 0;
  return new Proxy(store, {
    get(target, property) {
      if (property === "statement")
        return (...args: Parameters<Store["statement"]>) => {
          const statement = target.statement(...args);
          if (
            !args[0].includes("INSERT INTO vendor_requests") ||
            args[1] !== vendor
          )
            return statement;
          return new Proxy(statement, {
            get(inner, name) {
              const value = Reflect.get(inner, name, inner);
              if (name === "first")
                return async (...values: unknown[]) => {
                  const result = await Reflect.apply(value, inner, values);
                  if (++reservations === 2) delayed();
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

test("proof expiry during mutation budget admission cancels only known-unsent work for both vendors", async (t) => {
  for (const vendor of ["qrz", "lotw"] as const)
    await t.test(vendor, async (t) => {
      const h = await setup(t, true);
      const destination = vendor === "qrz" ? "destination" : "lotw";
      const prepared = await prepareDue(
        h.store,
        h.key(destination),
        h.contact,
        gates,
        {
          sourceProof: h.sourceProof,
          fetcher: h.fetcher,
        },
      );
      assert.equal(prepared.state, "prepared");
      assert.ok(prepared.attemptId);
      let clock = Date.now();
      assert.ok(
        h.proof.expiresAt - clock < 120_000,
        "proof expires inside the delivery lease",
      );
      t.mock.method(Date, "now", () => clock);
      const delayed = delayAdmission(h.store, vendor, () => {
        clock = h.proof.expiresAt + 1;
      });
      assert.deepEqual(
        await dispatchAttempt(delayed, "a", prepared.attemptId, gates, {
          now: clock,
          fetcher: h.fetcher,
        }),
        { state: "blocked", reason: "source_export_proof_unavailable" },
      );
      assert.equal(await h.state(prepared.attemptId), "cancelled");
      assert.equal(await h.claims(), 1);
      assert.equal(h.calls.qrzWrites, 0);
      assert.equal(h.calls.lotwUploads, 0);
      assert.equal(
        await h.store
          .statement("SELECT count(*) AS n FROM attempt_source_export_proofs")
          .first<number>("n"),
        1,
      );
    });
});

test("a stale prepared pin can be retired and rebuilt, while a dispatched uncertain pin never rebinds", async (t) => {
  const h = await setup(t);
  const first = await prepareDue(h.store, h.key(), h.contact, gates, {
    sourceProof: h.sourceProof,
    fetcher: h.fetcher,
  });
  assert.ok(first.attemptId);
  const refreshed = await h.mint();
  assert.equal(
    await attemptSourceExportProofCurrent(h.store, "a", first.attemptId),
    false,
  );
  const second = await prepareDue(h.store, h.key(), refreshed.contact, gates, {
    sourceProof: refreshed.sourceProof,
    fetcher: h.fetcher,
  });
  assert.equal(second.state, "prepared");
  assert.ok(second.attemptId);
  assert.notEqual(first.attemptId, second.attemptId);
  assert.equal(await h.state(first.attemptId), "cancelled");
  assert.equal(await h.claims(), 1);
  const unknown: typeof fetch = async (input, init) => {
    if (new URLSearchParams(String(init?.body)).get("ACTION") === "INSERT")
      throw new Error("synthetic transport outcome unknown");
    return h.fetcher(input, init);
  };
  assert.equal(
    (
      await dispatchAttempt(h.store, "a", second.attemptId, gates, {
        fetcher: unknown,
      })
    ).state,
    "uncertain",
  );
  const final = await h.mint();
  assert.equal(
    await cancelStalePreparedSourceProof(h.store, "a", second.attemptId),
    false,
  );
  assert.equal(await h.state(second.attemptId), "uncertain");
  assert.deepEqual(
    await prepareDue(h.store, h.key(), final.contact, gates, {
      sourceProof: final.sourceProof,
      fetcher: h.fetcher,
    }),
    { state: "skipped", reason: "unresolved_attempt" },
  );
  const pins = await h.store
    .statement(
      "SELECT proof_id FROM attempt_source_export_proofs WHERE tenant='a' ORDER BY attempt",
    )
    .all<{ proof_id: string }>();
  assert.deepEqual(
    new Set(pins.results.map((pin) => pin.proof_id)),
    new Set([h.proof.id, refreshed.proof.id]),
  );
  assert.equal(await h.claims(), 1);
});

test("final identity authorization also requires the pinned source proof after a dependency is revoked", async (t) => {
  const h = await setup(t);
  const prepared = await prepareDue(h.store, h.key(), h.contact, gates, {
    sourceProof: h.sourceProof,
    fetcher: h.fetcher,
  });
  assert.ok(prepared.attemptId);
  const claim = await destinationIdentityClaim("qrz", {
    STATION_CALLSIGN: h.contact.stationCall,
    CALL: h.contact.call,
    QSO_DATE: "20261022",
    TIME_ON: "120001",
    BAND: h.contact.band,
    MODE: h.contact.mode,
  });
  assert.equal(
    await claimedAttemptCurrent(
      h.store,
      "a",
      prepared.attemptId,
      claim,
      Date.now(),
    ),
    true,
  );
  await h.store
    .statement(
      "UPDATE private_data SET revoked_at=? WHERE tenant='a' AND connection='source' AND id=(SELECT private_id FROM source_work WHERE tenant='a' AND source='source' AND kind='operation' AND id='op-fixture')",
      Date.now(),
    )
    .run();
  assert.equal(
    await claimedAttemptCurrent(
      h.store,
      "a",
      prepared.attemptId,
      claim,
      Date.now(),
    ),
    false,
  );
  assert.deepEqual(
    await dispatchAttempt(h.store, "a", prepared.attemptId, gates, {
      fetcher: async () => assert.fail("Revoked dependency reached transport"),
    }),
    { state: "blocked", reason: "source_export_proof_unavailable" },
  );
  assert.equal(await h.state(prepared.attemptId), "cancelled");
  assert.equal(await h.claims(), 1);
});

test("LoTW certificate expiry during final source authorization cannot reach upload transport", async (t) => {
  const h = await setup(t);
  const credential = await h.store.private<{
    signingCredentials: SigningCredential[];
    query: { username: string; password: string };
  }>("a", "lotw", "fixture-lotw", "credential");
  assert(credential);
  const expiresAt = Date.now() + 60_000;
  credential.signingCredentials[0]!.validTo = new Date(expiresAt).toISOString();
  await h.store
    .statement(
      "DELETE FROM private_data WHERE tenant='a' AND connection='lotw' AND id='fixture-lotw' AND kind='credential'",
    )
    .run();
  await (
    await h.store.putPrivate(
      "a",
      "lotw",
      "fixture-lotw",
      "credential",
      credential,
    )
  ).run();
  const evidence = await h.mint();
  const prepared = await prepareDue(
    h.store,
    h.key("lotw"),
    evidence.contact,
    gates,
    { sourceProof: evidence.sourceProof, fetcher: h.fetcher },
  );
  assert.equal(prepared.state, "prepared");
  assert(prepared.attemptId);
  let clock = Date.now();
  assert(expiresAt > clock);
  assert(expiresAt < evidence.proof.expiresAt);
  t.mock.method(Date, "now", () => clock);
  let mutationAdmitted = false;
  let advanced = false;
  const admitted = delayAdmission(h.store, "lotw", () => {
    mutationAdmitted = true;
  });
  const delayed = new Proxy(admitted, {
    get(target, property) {
      if (property === "statement")
        return (...args: Parameters<Store["statement"]>) => {
          const statement = target.statement(...args);
          if (!args[0].startsWith("SELECT 1 current FROM ledger"))
            return statement;
          return new Proxy(statement, {
            get(inner, name) {
              const value = Reflect.get(inner, name, inner);
              if (name === "first")
                return async (...values: unknown[]) => {
                  const result = await Reflect.apply(value, inner, values);
                  if (mutationAdmitted) {
                    advanced = true;
                    clock = expiresAt + 1;
                  }
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
  assert.deepEqual(
    await dispatchAttempt(delayed, "a", prepared.attemptId, gates, {
      now: clock,
      fetcher: h.fetcher,
    }),
    { state: "blocked", reason: "authorization_changed_before_transport" },
  );
  assert.equal(
    advanced,
    true,
    "expiry occurs after the final async source check, after mutation budget admission",
  );
  assert.equal(h.calls.lotwUploads, 0);
  assert.equal(await h.state(prepared.attemptId), "prepared");
  assert.equal(await h.claims(), 1);
  assert.equal(
    await attemptSourceExportProofCurrent(
      h.store,
      "a",
      prepared.attemptId,
      clock,
    ),
    true,
    "proof and lease are still current; only the certificate expired",
  );
});
