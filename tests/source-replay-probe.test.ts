import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  haloOperationManifest,
  haloOperationManifestQuery,
  type OperationManifest,
  probeOperationReplay,
} from "../scripts/source-replay-probe.ts";

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
