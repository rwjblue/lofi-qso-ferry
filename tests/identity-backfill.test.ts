import assert from "node:assert/strict";
import { test } from "node:test";
import { type AdifRecord, serializeAdifRecord } from "../src/adif.ts";
import { backfillLegacyQrzIdentity } from "../src/identity-backfill.ts";
import { destinationIdentityClaim } from "../src/identity-claims.ts";
import { createFailureDiagnostics } from "../src/failure-diagnostics.ts";
import { tick } from "../src/service.ts";
import type { Store } from "../src/store.ts";
import { database, seed } from "./helpers.ts";
import {
  applyAdditionalMigrations,
  fixtureEnvironment,
} from "./runtime-fixtures.ts";

const NOW = Date.parse("2027-01-01T00:00:00Z");
const RETRY = 300_000;
const remote: AdifRecord = {
  APP_QRZLOG_LOGID: "41",
  STATION_CALLSIGN: "W1AW",
  CALL: "K1OLD",
  QSO_DATE: "20261022",
  TIME_ON: "123456",
  BAND: "20m",
  MODE: "CW",
};
function response(records: AdifRecord[]) {
  return new Response(
    new URLSearchParams({
      RESULT: "OK",
      COUNT: String(records.length),
      ADIF: `<EOH>${records.map(serializeAdifRecord).join("")}`,
    }).toString(),
  );
}
async function addReservation(
  store: Store,
  qso = "q1",
  remoteId = "41",
  nextCheck = 0,
  checked = 0,
  tenant = "a",
) {
  await store
    .statement(
      "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,state,remote_id,due_at,updated_at) VALUES(?,'source',?,'destination','edited-generation','edited-source','adopted_existing',?,0,0)",
      tenant,
      qso,
      remoteId,
    )
    .run();
  const reservation = await store
    .statement(
      "UPDATE legacy_qrz_identity_reservations SET next_check_at=?,checked_at=? WHERE tenant=? AND destination='destination' AND source='source' AND qso=? AND remote_id=? RETURNING qso",
      nextCheck,
      checked,
      tenant,
      qso,
      remoteId,
    )
    .run();
  assert.deepEqual(reservation.results, [{ qso }]);
}
async function setup() {
  const h = await database();
  try {
    await applyAdditionalMigrations(h.db);
    await seed(h.store);
    await (
      await h.store.putPrivate("a", "destination", "qrz-v1", "credential", {
        apiKey: "synthetic-private-key",
      })
    ).run();
    await h.store
      .statement(
        "UPDATE connections SET credential_version='qrz-v1',config=? WHERE tenant='a' AND id='destination'",
        JSON.stringify({ bookId: "book", stationCallsign: "W1AW" }),
      )
      .run();
    await addReservation(h.store);
    return h;
  } catch (error) {
    await h.mf.dispose();
    throw error;
  }
}
async function counts(store: Store) {
  return store
    .statement(
      "SELECT (SELECT COUNT(*) FROM legacy_qrz_identity_reservations) reservations,(SELECT COUNT(*) FROM destination_identity_claims) claims,(SELECT COUNT(*) FROM attempts) attempts,(SELECT COUNT(*) FROM leases WHERE expires_at>0) leases",
    )
    .first<{
      reservations: number;
      claims: number;
      attempts: number;
      leases: number;
    }>();
}

test("legacy QRZ backfill binds exact retained identity after source edits and inactive source without vendor writes", async () => {
  const h = await setup();
  try {
    await h.store
      .statement("UPDATE connections SET status='disabled' WHERE id='source'")
      .run();
    const before = await h.store.statement("SELECT * FROM ledger").all();
    const actions: string[] = [];
    const result = await backfillLegacyQrzIdentity(h.store, {
      now: NOW,
      fetcher: async (_url, init) => {
        const body = new URLSearchParams(String(init?.body));
        actions.push(body.get("ACTION")!);
        assert.equal(body.get("KEY"), "synthetic-private-key");
        assert.match(body.get("OPTION")!, /(?:^|,)LOGIDS:41(?:,|$)/);
        return response([remote]);
      },
    });
    assert.deepEqual(result, {
      checked: 1,
      bound: 1,
      retained: 0,
      errors: 0,
      deferred: 0,
    });
    assert.deepEqual(actions, ["FETCH"]);
    assert.deepEqual(await counts(h.store), {
      reservations: 0,
      claims: 1,
      attempts: 0,
      leases: 0,
    });
    assert.deepEqual(
      (await h.store.statement("SELECT * FROM ledger").all()).results,
      before.results,
    );
    const claim = await h.store
      .statement(
        "SELECT identity_hash,source,qso FROM destination_identity_claims",
      )
      .first();
    assert.deepEqual(claim, {
      identity_hash: (await destinationIdentityClaim("qrz", remote)).hash,
      source: "source",
      qso: "q1",
    });
    assert.notEqual(
      (claim as { identity_hash: string }).identity_hash,
      (await destinationIdentityClaim("qrz", { ...remote, CALL: "K1NEW" }))
        .hash,
    );
    assert.deepEqual(
      await h.store
        .statement(
          "SELECT requests,background_requests FROM vendor_requests WHERE vendor='qrz'",
        )
        .first(),
      { requests: 1, background_requests: 1 },
    );
  } finally {
    await h.mf.dispose();
  }
});

test("legacy QRZ missing, mismatched and malformed responses retain reservations and rotate due rows", async () => {
  const h = await setup();
  try {
    await addReservation(h.store, "q2", "42", 0, 10);
    const options = {
      now: NOW,
      fetcher: async () => response([]),
    };
    assert.deepEqual(await backfillLegacyQrzIdentity(h.store, options), {
      checked: 1,
      bound: 0,
      retained: 1,
      errors: 0,
      deferred: 0,
    });
    assert.deepEqual(
      await h.store
        .statement(
          "SELECT checked_at,next_check_at FROM legacy_qrz_identity_reservations WHERE qso='q1'",
        )
        .first(),
      { checked_at: NOW, next_check_at: NOW + RETRY },
    );
    const logIds: string[] = [];
    const wrong = await backfillLegacyQrzIdentity(h.store, {
      now: NOW,
      fetcher: async (_url, init) => {
        logIds.push(new URLSearchParams(String(init?.body)).get("OPTION")!);
        return response([remote]);
      },
    });
    assert.equal(wrong.errors, 1);
    assert.equal(wrong.retained, 1);
    assert.match(logIds[0], /LOGIDS:42/);
    assert.equal(
      (await backfillLegacyQrzIdentity(h.store, options)).checked,
      0,
    );
    const retry = await backfillLegacyQrzIdentity(h.store, {
      now: NOW + RETRY,
      fetcher: async () => response([{ ...remote, TIME_ON: "1234" }]),
    });
    assert.equal(retry.errors, 1);
    assert.equal(retry.retained, 1);
    assert.deepEqual(await counts(h.store), {
      reservations: 2,
      claims: 0,
      attempts: 0,
      leases: 0,
    });
  } finally {
    await h.mf.dispose();
  }
});

test("legacy QRZ credential, ledger, book and lease races never clear reservations", async (t) => {
  for (const [name, mutation] of [
    [
      "credential",
      "UPDATE connections SET credential_version='renewed' WHERE id='destination'",
    ],
    [
      "revoked credential",
      "UPDATE private_data SET revoked_at=1 WHERE connection='destination'",
    ],
    ["generation", "UPDATE ledger SET generation='newer-generation'"],
    ["mapping", "UPDATE ledger SET remote_id='99'"],
    ["book", "UPDATE connections SET config='{}' WHERE id='destination'"],
    [
      "book identity",
      "UPDATE connections SET remote_identity='another-book' WHERE id='destination'",
    ],
    ["lease", "UPDATE leases SET fence=fence+1,expires_at=0"],
    ["account", "UPDATE accounts SET status='disabled'"],
  ] as const)
    await t.test(name, async () => {
      const h = await setup();
      try {
        const result = await backfillLegacyQrzIdentity(h.store, {
          now: NOW,
          fetcher: async () => {
            await h.store.statement(mutation).run();
            return response([remote]);
          },
        });
        assert.equal(result.bound, 0);
        assert.equal(result.retained, 1);
        assert.deepEqual(await counts(h.store), {
          reservations: 1,
          claims: 0,
          attempts: 0,
          leases: 0,
        });
      } finally {
        await h.mf.dispose();
      }
    });
});

test("legacy QRZ conflicting ownership and wrong station preserve exclusion", async () => {
  const h = await setup();
  try {
    await addReservation(h.store, "other", "42", NOW + 10 * RETRY);
    const claim = await destinationIdentityClaim("qrz", remote);
    await h.store
      .statement(
        "INSERT INTO destination_identity_claims VALUES('a','destination','qrz',?,'source','other',0)",
        claim.hash,
      )
      .run();
    const conflicted = await backfillLegacyQrzIdentity(h.store, {
      now: NOW,
      fetcher: async () => response([remote]),
    });
    assert.equal(conflicted.bound, 0);
    assert.equal(conflicted.retained, 1);
    const wrongStation = await backfillLegacyQrzIdentity(h.store, {
      now: NOW + RETRY,
      fetcher: async () => response([{ ...remote, STATION_CALLSIGN: "W2AW" }]),
    });
    assert.equal(wrongStation.errors, 1);
    assert.deepEqual(await counts(h.store), {
      reservations: 2,
      claims: 1,
      attempts: 0,
      leases: 0,
    });
  } finally {
    await h.mf.dispose();
  }
});

test("legacy QRZ overlapping invocations share destination lease and drain the active read", async () => {
  const h = await setup();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const watchdog = setTimeout(() => release(), 10_000);
  try {
    await addReservation(h.store, "q2", "42", 0, 10);
    let requests = 0;
    const first = backfillLegacyQrzIdentity(h.store, {
      now: NOW,
      fetcher: async () => {
        requests++;
        entered();
        await blocked;
        return response([remote]);
      },
    });
    await started;
    const second = await backfillLegacyQrzIdentity(h.store, {
      now: NOW,
      fetcher: async () => {
        requests++;
        return response([remote]);
      },
    });
    assert.equal(second.checked, 0);
    assert.equal(requests, 1);
    assert.equal((await counts(h.store))!.leases, 1);
    release();
    assert.equal((await first).bound, 1);
    assert.deepEqual(await counts(h.store), {
      reservations: 1,
      claims: 1,
      attempts: 0,
      leases: 0,
    });
  } finally {
    release();
    clearTimeout(watchdog);
    await h.mf.dispose();
  }
});

test("legacy QRZ background budget and read errors are bounded, redacted and do not abort maintenance", async () => {
  const h = await setup();
  try {
    const diagnostics = createFailureDiagnostics();
    const onFailure = (error: unknown) =>
      diagnostics.record(error, "history_read", "qrz");
    const failure = await backfillLegacyQrzIdentity(h.store, {
      now: NOW,
      onFailure,
      fetcher: async () => {
        throw new Error("synthetic-private-key contact-secret");
      },
    });
    assert.equal(failure.errors, 1);
    await h.store
      .statement(
        "UPDATE vendor_requests SET background_requests=24,requests=24,window_start=? WHERE vendor='qrz'",
        Math.floor((NOW + RETRY) / RETRY) * RETRY,
      )
      .run();
    const budget = await backfillLegacyQrzIdentity(h.store, {
      now: NOW + RETRY,
      onFailure,
      fetcher: async () => {
        assert.fail("budget must prevent vendor I/O");
      },
    });
    assert.equal(budget.deferred, 1);
    assert.equal(budget.errors, 0);
    assert.equal(budget.retained, 1);
    assert.doesNotMatch(
      JSON.stringify({ diagnostics: diagnostics.counts, failure, budget }),
      /synthetic-private-key|contact-secret/,
    );
    assert.deepEqual(Object.keys(diagnostics.counts).sort(), [
      "history_read:qrz:qrz_transient",
      "history_read:qrz:vendor_budget_deferred",
    ]);
    assert.deepEqual(await counts(h.store), {
      reservations: 1,
      claims: 0,
      attempts: 0,
      leases: 0,
    });
  } finally {
    await h.mf.dispose();
  }
});

test("legacy QRZ backfill yields before I/O and ignores inactive destinations", async () => {
  const h = await setup();
  try {
    const fetcher: typeof fetch = async () => {
      assert.fail("no vendor read expected");
    };
    const skipped = await backfillLegacyQrzIdentity(h.store, {
      now: NOW,
      shouldContinue: () => false,
      fetcher,
    });
    assert.equal(skipped.checked, 0);
    await h.store
      .statement(
        "UPDATE connections SET status='disabled' WHERE id='destination'",
      )
      .run();
    const disabled = await backfillLegacyQrzIdentity(h.store, {
      now: NOW,
      fetcher,
    });
    assert.equal(disabled.checked, 0);
    assert.deepEqual(await counts(h.store), {
      reservations: 1,
      claims: 0,
      attempts: 0,
      leases: 0,
    });
  } finally {
    await h.mf.dispose();
  }
});

test("legacy QRZ due selection is global and tenant fenced", async () => {
  const h = await setup();
  try {
    await seed(h.store, "b");
    await (
      await h.store.putPrivate("b", "destination", "qrz-v1", "credential", {
        apiKey: "other-tenant-key",
      })
    ).run();
    await h.store
      .statement(
        "UPDATE connections SET credential_version='qrz-v1',config=? WHERE tenant='b' AND id='destination'",
        JSON.stringify({ bookId: "other-book", stationCallsign: "W1AW" }),
      )
      .run();
    await h.store
      .statement(
        "UPDATE legacy_qrz_identity_reservations SET next_check_at=?",
        NOW - 100,
      )
      .run();
    await addReservation(h.store, "q1", "41", NOW - 200, 10, "b");
    const result = await backfillLegacyQrzIdentity(h.store, {
      now: NOW,
      fetcher: async (_url, init) => {
        assert.equal(
          new URLSearchParams(String(init?.body)).get("KEY"),
          "other-tenant-key",
        );
        return response([remote]);
      },
    });
    assert.equal(result.bound, 1);
    assert.deepEqual(
      (
        await h.store
          .statement("SELECT tenant FROM destination_identity_claims")
          .all()
      ).results,
      [{ tenant: "b" }],
    );
    assert.deepEqual(
      (
        await h.store
          .statement(
            "SELECT tenant,checked_at FROM legacy_qrz_identity_reservations",
          )
          .all()
      ).results,
      [{ tenant: "a", checked_at: 0 }],
    );
  } finally {
    await h.mf.dispose();
  }
});

test("scheduler runs one legacy backfill with exports disabled and isolates read failure", async () => {
  const h = await setup();
  try {
    await h.store
      .statement("UPDATE connections SET status='disabled' WHERE id='source'")
      .run();
    let requests = 0;
    const result = await tick(
      fixtureEnvironment(h.db),
      async (_url, init) => {
        requests++;
        assert.equal(
          new URLSearchParams(String(init?.body)).get("ACTION"),
          "FETCH",
        );
        throw new Error("synthetic vendor failure");
      },
      NOW,
    );
    assert.equal(requests, 1);
    assert.equal(result.errors, 1);
    assert.equal(result.exportsEnabled, false);
    assert.equal(result.contacts, 0);
    assert.deepEqual(result.throughput?.identityBackfill, {
      checked: 1,
      bound: 0,
      retained: 1,
      errors: 1,
      deferred: 0,
    });
    assert.deepEqual(await counts(h.store), {
      reservations: 1,
      claims: 0,
      attempts: 0,
      leases: 0,
    });
  } finally {
    await h.mf.dispose();
  }
});
