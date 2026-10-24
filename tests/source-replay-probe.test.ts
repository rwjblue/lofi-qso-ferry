import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  haloOperationManifest,
  haloOperationManifestQuery,
  type OperationManifest,
  probeOperationReplay,
  type RetainedOperationSuspects,
} from "../scripts/source-replay-probe.ts";
import { LoFiClient } from "../src/lofi.ts";

const NOW = 1_800_000_000_000;
const credentials = {
  key: "browser:synthetic",
  secret: "private-secret",
  token: "private-token",
};
const record = (uuid = "q1", overrides = {}) => ({
  uuid,
  operation: "op1",
  syncedAtMillis: 100,
  updatedAtMillis: 90,
  band: "20m",
  ...overrides,
});
const manifest = (rows = [record()]): OperationManifest => ({
  origin: "independent-local-database",
  capturedAt: NOW,
  operation: {
    uuid: "op1",
    synced: true,
    deleted: false,
    purged: false,
    updatedAtMillis: 80,
    syncedAtMillis: 95,
  },
  members: rows.map((row) => ({
    uuid: row.uuid,
    operation: row.operation,
    isEvent: row.band === "event",
    deleted: false,
    purged: false,
    synced: true,
    updatedAtMillis: row.updatedAtMillis,
    syncedAtMillis: row.syncedAtMillis,
  })),
});
const page = (qsos: unknown[], left = 0, next?: number) =>
  new Response(
    JSON.stringify({
      qsos,
      meta: {
        qsos: {
          records_left: left,
          ...(next === undefined ? {} : { next_synced_until_millis: next }),
        },
      },
    }),
  );
const account = () =>
  new Response(JSON.stringify({ current_account: { uuid: "account1" } }));
function fixture(expected = manifest()) {
  let now = NOW;
  let reads = 0;
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  return {
    calls,
    setTime: (value: number) => {
      now = value;
    },
    options: {
      credentials,
      accountId: "account1",
      operationId: "op1",
      now: () => now,
      loadManifest: async () => structuredClone(expected),
      fetcher: async (input: string | URL | Request, init?: RequestInit) => {
        reads++;
        calls.push({ url: String(input), init });
        return reads === 1 ? account() : page([record()]);
      },
    },
  };
}
const baseRecord = (overrides = {}) => ({
  uuid: "op1",
  updatedAtMillis: 80,
  syncedAtMillis: 95,
  ...overrides,
});
const sync = (operations = [baseRecord()], overrides = {}) =>
  Response.json({
    account: { uuid: "account1" },
    operations,
    qsos: [],
    meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
    ...overrides,
  });
function baseFixture(expected = manifest()) {
  const h = fixture(expected);
  h.options.fetcher = async (input, init) => {
    h.calls.push({ url: String(input), init });
    return String(input).endsWith("/v1/sync") ? sync() : page([record()]);
  };
  return { ...h, options: { ...h.options, observeBaseOperation: true } };
}
const suspects = (rows = [record("suspect1")]): RetainedOperationSuspects => ({
  origin: "retained-ferry-metadata",
  capturedAt: NOW,
  operationId: "op1",
  members: rows.map((row) => ({
    uuid: row.uuid,
    operation: row.operation,
    isEvent: row.band === "event",
    deleted: false,
    purged: false,
    updatedAtMillis: row.updatedAtMillis,
    syncedAtMillis: row.syncedAtMillis,
  })),
});

test("independent SQLite manifest includes event and deletion rows without returning payloads", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE operations(uuid TEXT,data TEXT,deleted INTEGER,purged INTEGER,synced INTEGER,updated_at_millis INTEGER);
      CREATE TABLE qsos(uuid TEXT,operation TEXT,band TEXT,data TEXT,deleted INTEGER,purged INTEGER,synced INTEGER,updated_at_millis INTEGER);
      INSERT INTO operations VALUES('op1','{"syncedAtMillis":95,"secret":"private-payload"}',0,0,1,80);
      INSERT INTO qsos VALUES('event1','op1','event','{"syncedAtMillis":100}',0,0,1,90),
        ('q1','op1','20m','{"syncedAtMillis":100}',1,0,1,90),
        ('event-object','op1','20m','{"syncedAtMillis":100,"event":{}}',0,0,1,90),
        ('other','op2','20m','{}',0,0,1,90);`);
    const query = haloOperationManifestQuery("op1");
    const rows = db.prepare(query.sql).all(...query.params);
    const actual = haloOperationManifest(rows, NOW);
    assert.equal(actual.members.length, 3);
    assert.equal(actual.members.filter((row) => row.isEvent).length, 2);
    assert(actual.members.some((row) => row.isEvent));
    assert(actual.members.some((row) => row.deleted));
    assert(!JSON.stringify(rows).includes("private-payload"));
    assert.throws(() =>
      haloOperationManifest([...rows, ...Array(100).fill(rows[1])], NOW),
    );
    assert.throws(() =>
      haloOperationManifestQuery("op1'; DELETE FROM qsos; --"),
    );
  } finally {
    db.close();
  }
});

test("two complete reads match a stable independent snapshot but never assert server retention or base-operation coverage", async () => {
  const h = fixture();
  let loads = 0;
  h.options.loadManifest = async () => {
    loads++;
    return manifest();
  };
  const result = await probeOperationReplay(h.options);
  assert.equal(result.status, "observed_match");
  assert.equal(result.readAttempts, 3);
  assert.equal(result.completedPasses, 2);
  assert.equal(loads, 2);
  assert.equal(result.sourceBoundaryVerified, false);
  assert.equal(result.serverBaseOperationObserved, false);
  assert.equal(result.unknownHistoricalPurgesExcluded, false);
  assert.equal(result.independentSnapshotStable, true);
  assert(
    h.calls.every(
      ({ init }) =>
        init?.method === "GET" &&
        init.body === undefined &&
        init.redirect === "manual",
    ),
  );
  assert(!JSON.stringify(result).includes("q1"));
  assert(!JSON.stringify(result).includes("private-"));
});

test("event-object-only records use production classification in the remote comparison", async () => {
  const expected = manifest();
  expected.members[0].isEvent = true;
  const h = fixture(expected);
  let count = 0;
  h.options.fetcher = async () =>
    ++count === 1 ? account() : page([record("q1", { event: {} })]);
  const result = await probeOperationReplay(h.options);
  assert.equal(result.status, "observed_match");
  assert.equal(result.expectedEvents, 1);
  assert.equal(result.changedMembers, 0);
});

test("known tombstone or event omissions remain discrepancies even when both reads agree", async () => {
  const expected = manifest([
    record(),
    record("event1", { band: "event" }),
    record("deleted1"),
  ]);
  expected.members[2].deleted = true;
  const result = await probeOperationReplay(fixture(expected).options);
  assert.equal(result.completedPasses, 2);
  assert.equal(result.repeatedReadDifferences, 0);
  assert.equal(result.missingMembers, 2);
  assert.equal(result.status, "discrepancy");
});

test("independently known purge and deletion flags are compared, never inferred from absence", async () => {
  const expected = manifest();
  expected.members[0].deleted = true;
  expected.members[0].purged = true;
  const h = fixture(expected);
  let count = 0;
  h.options.fetcher = async () =>
    ++count === 1
      ? account()
      : page([record("q1", { deleted: "1", purged: true })]);
  const matching = await probeOperationReplay(h.options);
  assert.equal(matching.status, "observed_match");
  assert.equal(matching.expectedPurged, 1);
  count = 0;
  h.options.fetcher = async () => (++count === 1 ? account() : page([]));
  const missing = await probeOperationReplay(h.options);
  assert.equal(missing.status, "discrepancy");
  assert.equal(missing.missingMembers, 1);
  assert.equal(missing.unknownHistoricalPurgesExcluded, false);
});

test("timestamp ties across replayed pages do not hide a missing member", async () => {
  const h = fixture(manifest([record(), record("q2")]));
  let count = 0;
  h.options.fetcher = async (input) => {
    count++;
    if (count === 1) return account();
    if (count === 2) return page([record()], 1, 101);
    if (count === 3) {
      assert.equal(
        new URL(String(input)).searchParams.get("syncedUntilMillis"),
        "101",
      );
      return page([record("q2")]);
    }
    return page([record(), record("q2")]);
  };
  const result = await probeOperationReplay(h.options);
  assert.equal(result.status, "observed_match");
  assert.equal(result.tiedServerStamps, 1);
  assert.equal(result.readAttempts, 4);
});

test("partial and cooldown pages never establish membership, and the read cap cannot grow", async (t) => {
  await t.test("empty incomplete", async () => {
    const h = fixture();
    let count = 0;
    h.options.fetcher = async () => (++count === 1 ? account() : page([], 1));
    const result = await probeOperationReplay(h.options);
    assert.equal(result.status, "incomplete");
    assert.equal(result.stopReason, "empty_incomplete_page");
    assert.equal(result.missingMembers, 0);
  });
  await t.test("read cap", async () => {
    const h = fixture();
    let count = 0;
    h.options.fetcher = async () =>
      ++count === 1 ? account() : page([record(`q${count}`)], 1, 100 - count);
    const result = await probeOperationReplay(h.options);
    assert.equal(result.stopReason, "read_cap");
    assert.equal(count, 4);
    assert.equal(result.completedPasses, 0);
  });
});

test("authentication failure stops without renewal, permission or source requests", async () => {
  const h = fixture();
  let count = 0;
  h.options.fetcher = async () => {
    count++;
    return new Response("", { status: 401 });
  };
  const result = await probeOperationReplay(h.options);
  assert.equal(result.stopReason, "authentication_required");
  assert.equal(count, 1);
});

test("a server page exceeding the approved row limit is incomplete rather than silently widening the sample", async () => {
  const h = fixture();
  let count = 0;
  h.options.fetcher = async () =>
    ++count === 1
      ? account()
      : page(Array.from({ length: 26 }, (_, index) => record(`q${index}`)));
  const result = await probeOperationReplay(h.options);
  assert.equal(result.stopReason, "page_size_exceeded");
  assert.equal(result.status, "incomplete");
  assert.equal(result.readAttempts, 2);
  assert.equal(result.completedPasses, 0);
});

test("wrong account, redirect and malformed response fail before membership conclusions", async (t) => {
  for (const [name, response, reason] of [
    [
      "account",
      () =>
        new Response(JSON.stringify({ current_account: { uuid: "other" } })),
      "account_changed",
    ],
    [
      "redirect",
      () =>
        new Response("", {
          status: 302,
          headers: { location: "https://evil.invalid/private" },
        }),
      "vendor_unavailable",
    ],
    [
      "malformed",
      () => new Response("private-payload-not-json"),
      "protocol_error",
    ],
  ] as const)
    await t.test(name, async () => {
      const h = fixture();
      h.options.fetcher = async () => response();
      const result = await probeOperationReplay(h.options);
      assert.equal(result.stopReason, reason);
      assert.equal(result.readAttempts, 1);
      assert.equal(result.status, "unavailable");
    });
});

test("expired, unsynced and changed independent snapshots cannot produce a match", async (t) => {
  for (const kind of ["expired", "unsynced", "changed", "time"] as const)
    await t.test(kind, async () => {
      const expected = manifest();
      if (kind === "expired") expected.capturedAt = NOW - 300001;
      if (kind === "unsynced") expected.members[0].synced = false;
      const h = fixture(expected);
      if (kind === "changed") {
        let loads = 0;
        h.options.loadManifest = async () => {
          const copy = manifest();
          if (++loads === 2) copy.operation.updatedAtMillis = 81;
          return copy;
        };
      }
      if (kind === "time")
        h.options.fetcher = async () => {
          h.setTime(NOW + 120000);
          return account();
        };
      const result = await probeOperationReplay(h.options);
      assert.equal(
        result.stopReason,
        {
          expired: "manifest_expired",
          unsynced: "manifest_unsynced",
          changed: "manifest_changed",
          time: "time_cap",
        }[kind],
      );
      assert.notEqual(result.status, "observed_match");
      if (kind === "expired" || kind === "unsynced")
        assert.equal(result.readAttempts, 0);
    });
});

test("same UUID with conflicting page metadata stops; repeated read drift remains visible", async (t) => {
  await t.test("conflicting duplicate", async () => {
    const h = fixture();
    let count = 0;
    h.options.fetcher = async () =>
      ++count === 1
        ? account()
        : count === 2
          ? page([record()], 1, 101)
          : page([record("q1", { deleted: true })]);
    const result = await probeOperationReplay(h.options);
    assert.equal(result.stopReason, "conflicting_duplicate");
    assert.equal(result.status, "discrepancy");
  });
  await t.test("between reads", async () => {
    const h = fixture();
    let count = 0;
    h.options.fetcher = async () =>
      ++count === 1
        ? account()
        : count === 2
          ? page([record()])
          : page([record("q1", { updatedAtMillis: 91 })]);
    const result = await probeOperationReplay(h.options);
    assert.equal(result.repeatedReadDifferences, 1);
    assert.equal(result.changedMembers, 1);
    assert.equal(result.status, "discrepancy");
  });
});

test("unknown revisions and hostile callback errors are reported without fabricated evidence or private details", async () => {
  const expected = manifest();
  expected.members[0].updatedAtMillis = null;
  const result = await probeOperationReplay(fixture(expected).options);
  assert.equal(result.unknownVersions, 1);
  assert.equal(result.status, "incomplete");
  const missingServerStamp = manifest();
  missingServerStamp.members[0].syncedAtMillis = null;
  const unstamped = await probeOperationReplay(
    fixture(missingServerStamp).options,
  );
  assert.equal(unstamped.unknownVersions, 1);
  assert.equal(unstamped.status, "incomplete");
  const h = fixture();
  h.options.fetcher = async () => {
    throw new Error(
      "https://private.invalid/?token=private-secret q1 private-payload",
    );
  };
  const failed = await probeOperationReplay(h.options);
  assert.equal(failed.stopReason, "vendor_unavailable");
  assert(!JSON.stringify(failed).includes("private"));
  assert(!JSON.stringify(failed).includes("q1"));
});

test("opt-in base observations bracket complete members using only exact bounded read-only sync windows", async () => {
  const h = baseFixture();
  const result = await probeOperationReplay(h.options);
  assert.equal(result.status, "observed_match");
  assert.equal(result.readAttempts, 4);
  assert.equal(result.completedPasses, 2);
  assert.equal(result.baseOperationObservations, 2);
  assert.equal(result.baseOperationDifferences, 0);
  assert.equal(result.repeatedBaseDifferences, 0);
  assert.equal(result.serverBaseOperationObserved, true);
  assert.equal(result.sourceBoundaryVerified, false);
  assert.equal(result.unknownHistoricalPurgesExcluded, false);
  assert.deepEqual(
    h.calls.map(({ url, init }) => [new URL(url).pathname, init?.method]),
    [
      ["/v1/sync", "POST"],
      ["/v1/operations/op1/qsos", "GET"],
      ["/v1/operations/op1/qsos", "GET"],
      ["/v1/sync", "POST"],
    ],
  );
  for (const index of [0, 3]) {
    assert.equal(h.calls[index].init?.redirect, "manual");
    assert.deepEqual(JSON.parse(String(h.calls[index].init?.body)), {
      meta: {
        inboundSync: true,
        lastSyncAccountUUID: "account1",
        sync: {
          operations: { syncedUntilMillis: NOW, limit: 25, anyClient: true },
          qsos: { syncedUntilMillis: 0, limit: 25, anyClient: true },
        },
      },
    });
  }
  assert(!JSON.stringify(result).includes("op1"));
  assert(!JSON.stringify(result).includes("private-"));
});

test("unrelated base rows cannot stand in for the target, and missing targets never imply deletion", async (t) => {
  for (const complete of [true, false])
    await t.test(`target omitted, complete=${complete}`, async () => {
      const h = baseFixture();
      h.options.fetcher = async () =>
        sync([baseRecord({ uuid: "unrelated" })], {
          meta: {
            operations: {
              records_left: complete ? 0 : 1,
              ...(complete ? {} : { next_cursor: "opaque-not-reported" }),
            },
            qsos: { records_left: 0 },
          },
        });
      const result = await probeOperationReplay(h.options);
      assert.equal(result.status, "incomplete");
      assert.equal(result.stopReason, "base_operation_not_observed");
      assert.equal(result.readAttempts, 1);
      assert.equal(result.baseOperationObservations, 0);
      assert.equal(result.unrelatedBaseRows, 1);
      assert.equal(result.serverBaseOperationObserved, false);
      assert.equal(result.missingMembers, 0);
      assert(!JSON.stringify(result).includes("opaque"));
    });
  await t.test(
    "unrelated neighbor is counted but target is compared",
    async () => {
      const h = baseFixture();
      h.options.fetcher = async (input) =>
        String(input).endsWith("/v1/sync")
          ? sync([baseRecord({ uuid: "unrelated" }), baseRecord()])
          : page([record()]);
      const result = await probeOperationReplay(h.options);
      assert.equal(result.status, "observed_match");
      assert.equal(result.unrelatedBaseRows, 2);
      assert.equal(result.baseOperationObservations, 2);
    },
  );
});

test("duplicate targets and changed base versions, flags or account never establish stable base evidence", async (t) => {
  await t.test("duplicate target even with matching metadata", async () => {
    const h = baseFixture();
    h.options.fetcher = async () => sync([baseRecord(), baseRecord()]);
    const result = await probeOperationReplay(h.options);
    assert.equal(result.status, "discrepancy");
    assert.equal(result.stopReason, "duplicate_base_operation");
    assert.equal(result.serverBaseOperationObserved, false);
  });
  for (const change of [
    { updatedAtMillis: 81 },
    { syncedAtMillis: 96 },
    { deleted: true },
    { purged: true },
  ])
    await t.test(`final base ${Object.keys(change)[0]}`, async () => {
      const h = baseFixture();
      let bases = 0;
      h.options.fetcher = async (input) =>
        String(input).endsWith("/v1/sync")
          ? sync([baseRecord(++bases === 2 ? change : {})])
          : page([record()]);
      const result = await probeOperationReplay(h.options);
      assert.equal(result.status, "discrepancy");
      assert.equal(result.baseOperationDifferences, 1);
      assert.equal(
        result.baseFlagDifferences,
        Number("deleted" in change || "purged" in change),
      );
      assert.equal(
        result.baseApplicationRevisionDifferences,
        Number("updatedAtMillis" in change),
      );
      assert.equal(
        result.baseServerStampDifferences,
        Number("syncedAtMillis" in change),
      );
      assert.equal(result.repeatedBaseDifferences, 1);
      assert.equal(result.sourceBoundaryVerified, false);
    });
  await t.test("final sync account changes", async () => {
    const h = baseFixture();
    let bases = 0;
    h.options.fetcher = async (input) =>
      String(input).endsWith("/v1/sync")
        ? sync(undefined, {
            account: { uuid: ++bases === 2 ? "other" : "account1" },
          })
        : page([record()]);
    const result = await probeOperationReplay(h.options);
    assert.equal(result.stopReason, "account_changed");
    assert.equal(result.serverBaseOperationObserved, false);
    assert.equal(result.baseOperationObservations, 1);
  });
});

test("unknown base revisions cannot mask known flag changes or become complete freshness evidence", async (t) => {
  for (const deleted of [false, true])
    await t.test(`unknown base, deleted=${deleted}`, async () => {
      const expected = manifest();
      expected.operation.updatedAtMillis = null;
      const h = baseFixture(expected);
      h.options.fetcher = async (input) =>
        String(input).endsWith("/v1/sync")
          ? sync([baseRecord({ deleted })])
          : page([record()]);
      const result = await probeOperationReplay(h.options);
      assert.equal(result.unknownBaseVersions, 2);
      assert.equal(result.baseOperationDifferences, deleted ? 2 : 0);
      assert.equal(result.baseFlagDifferences, deleted ? 2 : 0);
      assert.equal(result.baseApplicationRevisionDifferences, 0);
      assert.equal(result.baseServerStampDifferences, 0);
      assert.equal(result.status, deleted ? "discrepancy" : "incomplete");
    });
  await t.test("missing independent base server stamp", async () => {
    const expected = manifest();
    expected.operation.syncedAtMillis = null;
    const result = await probeOperationReplay(baseFixture(expected).options);
    assert.equal(result.unknownBaseVersions, 2);
    assert.equal(result.baseServerStampDifferences, 0);
    assert.equal(result.status, "incomplete");
  });
});

test("stable repeated base differences identify the field class without revealing values or weakening status", async (t) => {
  for (const allFields of [false, true])
    await t.test(`all fields=${allFields}`, async () => {
      const h = baseFixture();
      h.options.fetcher = async (input) =>
        String(input).endsWith("/v1/sync")
          ? sync([
              baseRecord({
                syncedAtMillis: 96,
                ...(allFields
                  ? { deleted: true, purged: true, updatedAtMillis: 81 }
                  : {}),
              }),
            ])
          : page([record()]);
      const result = await probeOperationReplay(h.options);
      assert.equal(result.baseOperationObservations, 2);
      assert.equal(result.serverBaseOperationObserved, true);
      assert.equal(result.completedPasses, 2);
      assert.equal(result.changedMembers, 0);
      assert.equal(result.baseOperationDifferences, 2);
      assert.equal(result.baseFlagDifferences, allFields ? 2 : 0);
      assert.equal(
        result.baseApplicationRevisionDifferences,
        allFields ? 2 : 0,
      );
      assert.equal(result.baseServerStampDifferences, 2);
      assert.equal(result.repeatedBaseDifferences, 0);
      assert.equal(result.unknownBaseVersions, 0);
      assert.equal(result.status, "discrepancy");
      assert.equal(result.sourceBoundaryVerified, false);
      assert.equal(result.unknownHistoricalPurgesExcluded, false);
      assert(!JSON.stringify(result).includes("op1"));
      assert(!JSON.stringify(result).includes("syncedAtMillis"));
      assert(!JSON.stringify(result).includes("updatedAtMillis"));
    });
});

test("bracketing retains stream, request and time bounds without partial base success", async (t) => {
  for (const stream of ["operations", "qsos"] as const)
    await t.test(`${stream} row cap`, async () => {
      const h = baseFixture();
      h.options.fetcher = async () =>
        sync(undefined, {
          [stream]: Array.from({ length: 26 }, (_, i) =>
            stream === "operations"
              ? baseRecord({ uuid: `op${i}` })
              : record(`q${i}`),
          ),
        });
      const result = await probeOperationReplay(h.options);
      assert.equal(result.stopReason, "page_size_exceeded");
      assert.equal(result.status, "incomplete");
      assert.equal(result.readAttempts, 1);
      assert.equal(result.serverBaseOperationObserved, false);
    });
  await t.test(
    "member continuation consumes the final request slot",
    async () => {
      const h = baseFixture(manifest([record(), record("q2")]));
      let reads = 0;
      h.options.fetcher = async () => {
        reads++;
        if (reads === 1) return sync();
        if (reads === 2) return page([record()], 1, 101);
        if (reads === 3) return page([record("q2")]);
        return page([record(), record("q2")]);
      };
      const result = await probeOperationReplay(h.options);
      assert.equal(result.stopReason, "read_cap");
      assert.equal(result.completedPasses, 2);
      assert.equal(result.serverBaseOperationObserved, false);
      assert.equal(reads, 4);
    },
  );
  await t.test("expired final window", async () => {
    const h = baseFixture();
    let bases = 0;
    h.options.fetcher = async (input) => {
      if (!String(input).endsWith("/v1/sync")) return page([record()]);
      if (++bases === 2) h.setTime(NOW + 120_000);
      return sync();
    };
    const result = await probeOperationReplay(h.options);
    assert.equal(result.stopReason, "time_cap");
    assert.equal(result.serverBaseOperationObserved, false);
  });
});

test("base sync cannot renew credentials or dispatch altered write-shaped windows", async (t) => {
  await t.test("401 blocks renewal", async () => {
    const h = baseFixture();
    let calls = 0;
    h.options.fetcher = async () => {
      calls++;
      return new Response("", { status: 401 });
    };
    const result = await probeOperationReplay(h.options);
    assert.equal(result.stopReason, "authentication_required");
    assert.equal(calls, 1);
  });
  await t.test(
    "client body drift is rejected before transport",
    async (context) => {
      const original = LoFiClient.prototype.syncPage;
      context.mock.method(
        LoFiClient.prototype,
        "syncPage",
        function (
          this: LoFiClient,
          state: Parameters<LoFiClient["syncPage"]>[0],
          now: number,
          limit: number,
        ) {
          return original.call(this, { ...state, mode: "forward" }, now, limit);
        },
      );
      const h = baseFixture();
      let calls = 0;
      h.options.fetcher = async () => {
        calls++;
        return sync();
      };
      const result = await probeOperationReplay(h.options);
      assert.equal(result.stopReason, "transport_denied");
      assert.equal(calls, 0);
    },
  );
  await t.test(
    "source arrays are denied even on the expected sync endpoint",
    async (context) => {
      context.mock.method(
        LoFiClient.prototype,
        "syncPage",
        async function (this: LoFiClient) {
          const { fetcher } = this as unknown as { fetcher: typeof fetch };
          await fetcher("https://lofi.ham2k.net/v1/sync", {
            method: "POST",
            redirect: "manual",
            body: JSON.stringify({
              operations: [{ uuid: "op1", deleted: true }],
              qsos: [],
              meta: { inboundSync: true },
            }),
          });
          throw new Error("unexpected transport acceptance");
        },
      );
      const h = baseFixture();
      let calls = 0;
      h.options.fetcher = async () => {
        calls++;
        return sync();
      };
      const result = await probeOperationReplay(h.options);
      assert.equal(result.stopReason, "transport_denied");
      assert.equal(calls, 0);
    },
  );
});

test("thirteen Ferry-only suspects stay separate from an empty independent manifest in GET-only mode", async () => {
  const rows = Array.from({ length: 13 }, (_, i) => record(`suspect${i}`));
  const h = fixture(manifest([]));
  let calls = 0;
  let retainedLoads = 0;
  h.options.fetcher = async (input, init) => {
    h.calls.push({ url: String(input), init });
    return ++calls === 1 ? account() : page(rows);
  };
  const result = await probeOperationReplay({
    ...h.options,
    loadRetainedSuspects: async () => {
      retainedLoads++;
      return suspects(rows);
    },
  });
  assert.equal(result.status, "discrepancy");
  assert.equal(result.expectedMembers, 0);
  assert.equal(result.unexpectedMembers, 13);
  assert.equal(result.retainedSuspects, 13);
  assert.equal(result.retainedSuspectsObserved, 13);
  assert.equal(result.retainedSuspectsAbsent, 0);
  assert.equal(result.retainedSnapshotStable, true);
  assert.equal(retainedLoads, 2);
  assert.equal(result.readAttempts, 3);
  assert(h.calls.every(({ init }) => init?.method === "GET"));
  assert.equal(result.serverBaseOperationObserved, false);
  assert.equal(result.sourceBoundaryVerified, false);
  assert(!JSON.stringify(result).includes("suspect0"));
});

test("suspect absence, changes, instability and unknown versions remain distinct from deletion claims", async (t) => {
  for (const kind of ["absent", "changed", "unstable", "unknown"] as const)
    await t.test(kind, async () => {
      const h = fixture(manifest([]));
      const retained = suspects();
      if (kind === "unknown") retained.members[0].updatedAtMillis = null;
      let calls = 0;
      h.options.fetcher = async () => {
        if (++calls === 1) return account();
        return page(
          kind === "absent" || (kind === "unstable" && calls === 3)
            ? []
            : [record("suspect1", kind === "changed" ? { deleted: true } : {})],
        );
      };
      const result = await probeOperationReplay({
        ...h.options,
        loadRetainedSuspects: async () => structuredClone(retained),
      });
      assert.equal(result.retainedSuspectsObserved, 0);
      assert.equal(result.retainedSuspectsAbsent, Number(kind === "absent"));
      assert.equal(result.retainedSuspectsChanged, Number(kind === "changed"));
      assert.equal(
        result.retainedSuspectsUnstable,
        Number(kind === "unstable"),
      );
      assert.equal(
        result.retainedSuspectsUnknownVersions,
        Number(kind === "unknown"),
      );
      assert.equal(result.sourceBoundaryVerified, false);
      assert.equal(result.unknownHistoricalPurgesExcluded, false);
      assert.equal(result.status, "discrepancy");
    });
});

test("retained evidence rejects wrong origins, scope, overlap, oversized, expired and changing snapshots", async (t) => {
  for (const kind of [
    "origin",
    "scope",
    "overlap",
    "oversized",
    "expired",
    "changed",
  ] as const)
    await t.test(kind, async () => {
      const h = fixture();
      const retained = suspects();
      if (kind === "origin")
        (retained as { origin: string }).origin = "independent-local-database";
      if (kind === "scope") retained.operationId = "other";
      if (kind === "overlap") retained.members[0].uuid = "q1";
      if (kind === "oversized")
        retained.members = suspects(
          Array.from({ length: 14 }, (_, i) => record(`s${i}`)),
        ).members;
      if (kind === "expired") retained.capturedAt = NOW - 300_001;
      let loads = 0;
      const result = await probeOperationReplay({
        ...h.options,
        loadRetainedSuspects: async () => {
          const copy = structuredClone(retained);
          if (++loads === 2 && kind === "changed")
            copy.members[0].updatedAtMillis = 91;
          return copy;
        },
      });
      assert.equal(
        result.stopReason,
        kind === "changed"
          ? "retained_manifest_changed"
          : kind === "expired"
            ? "retained_manifest_expired"
            : "retained_manifest_invalid",
      );
      assert.equal(result.retainedSnapshotStable, false);
      assert.equal(result.retainedSuspectsObserved, 0);
      assert.equal(result.readAttempts, kind === "changed" ? 3 : 0);
    });
});
