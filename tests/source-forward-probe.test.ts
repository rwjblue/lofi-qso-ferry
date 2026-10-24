import assert from "node:assert/strict";
import test from "node:test";
import {
  type ForwardManifest,
  probeForwardReplay,
} from "../scripts/source-forward-probe.ts";
import { LoFiClient, type SyncState } from "../src/lofi.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";

const NOW = 1_800_000_000_000;
const credentials = {
  key: "browser:reader-private",
  secret: "private-secret",
  token: "private-token",
};
const record = (uuid = "q1", overrides = {}) => ({
  uuid,
  operation: "op1",
  band: "20m",
  updatedAtMillis: NOW - 500,
  syncedAtMillis: NOW - 100,
  ...overrides,
});
const operation = (uuid = "op1", overrides = {}) => ({
  uuid,
  updatedAtMillis: NOW - 600,
  syncedAtMillis: NOW - 200,
  ...overrides,
});
type ManifestRecord = ForwardManifest["records"][number];
const known = (
  raw = record(),
  overrides: Partial<ManifestRecord> = {},
): ManifestRecord => ({
  kind: "qso",
  uuid: raw.uuid,
  operation: raw.operation,
  isEvent: false,
  deleted: false,
  purged: false,
  synced: true,
  updatedAtMillis: raw.updatedAtMillis,
  syncedAtMillis: raw.syncedAtMillis,
  writerClientKey: "browser:independent-writer-private",
  ...overrides,
});
const manifest = (records = [known()]): ForwardManifest => ({
  origin: "independent-client-metadata",
  capturedAt: NOW,
  accountId: "account1",
  readerClientKey: credentials.key,
  records,
});
const page = (
  qsos: unknown[] = [record()],
  operations: unknown[] = [],
  overrides = {},
) =>
  Response.json({
    account: { uuid: "account1" },
    operations,
    qsos,
    meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
    ...overrides,
  });
function fixture(expected = manifest()) {
  let time = NOW;
  const calls: { url: string; init?: RequestInit }[] = [];
  return {
    calls,
    setTime(value: number) {
      time = value;
    },
    options: {
      credentials,
      accountId: "account1",
      watermarks: { operations: NOW - 300, qsos: NOW - 150 },
      loadManifest: async () => structuredClone(expected),
      now: () => time,
      fetcher: async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return page();
      },
    },
  };
}

test("known other-client forward delivery is observed twice without authorizing a boundary or writes", async () => {
  const h = fixture();
  let loads = 0;
  h.options.loadManifest = async () => {
    loads++;
    return manifest();
  };
  const result = await probeForwardReplay(h.options);
  assert.equal(result.status, "observed_match");
  assert.equal(result.completedPasses, 2);
  assert.equal(result.readAttempts, 2);
  assert.equal(result.observedRecords, 1);
  assert.equal(result.positiveDeliveryObserved, true);
  assert.equal(result.independentSnapshotStable, true);
  assert.equal(result.distinctWriterEvidenceProvided, true);
  assert.equal(loads, 2);
  assert.equal(result.sourceBoundaryVerified, false);
  assert.equal(result.accountMembershipVerified, false);
  assert.equal(result.unknownHistoricalPurgesExcluded, false);
  assert.equal(result.writesAuthorized, false);
  for (const { url, init } of h.calls) {
    assert.equal(url, "https://lofi.ham2k.net/v1/sync");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "manual");
    assert(init?.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      meta: {
        inboundSync: true,
        lastSyncAccountUUID: "account1",
        sync: {
          operations: {
            syncedSinceMillis: NOW - 300,
            limit: 25,
            anyClient: false,
          },
          qsos: { syncedSinceMillis: NOW - 150, limit: 25, anyClient: false },
        },
      },
    });
  }
  const serialized = JSON.stringify(result);
  for (const privateValue of ["q1", "op1", "account1", "private", String(NOW)])
    assert(!serialized.includes(privateValue));
});

test("base, tombstone and event positives compare flags without requiring application revision advancement", async () => {
  const base = operation();
  const tombstone = record("deleted1", { deleted: "1" });
  const event = record("event1", { event: {}, purged: true });
  const expected = manifest([
    known(
      { ...record(), ...base },
      { kind: "operation", uuid: base.uuid, operation: null },
    ),
    known(tombstone, { deleted: true }),
    known(event, { isEvent: true, purged: true }),
  ]);
  const h = fixture(expected);
  h.options.fetcher = async () => page([tombstone, event], [base]);
  const result = await probeForwardReplay(h.options);
  assert.equal(result.status, "observed_match");
  assert.equal(result.expectedOperations, 1);
  assert.equal(result.expectedEvents, 1);
  assert.equal(result.expectedDeleted, 1);
  assert.equal(result.expectedPurged, 1);
  assert.equal(result.observedRecords, 3);
});

test("independent side cursors preserve ties and both passes restart from the pinned watermarks", async () => {
  const expected = manifest([
    known(
      { ...record(), ...operation() },
      { kind: "operation", uuid: "op1", operation: null },
    ),
    known(
      { ...record(), ...operation("op2") },
      { kind: "operation", uuid: "op2", operation: null },
    ),
    known(),
    known(record("q2")),
  ]);
  const h = fixture(expected);
  let calls = 0;
  h.options.fetcher = async (input, init) => {
    h.calls.push({ url: String(input), init });
    const sync = JSON.parse(String(init?.body)).meta.sync;
    if (++calls % 2 === 1) {
      assert.equal(sync.operations.syncedSinceMillis, NOW - 300);
      assert.equal(sync.qsos.syncedSinceMillis, NOW - 150);
      assert.equal(sync.operations.cursor, undefined);
      assert.equal(sync.qsos.cursor, undefined);
      return page([record()], [operation()], {
        meta: {
          operations: {
            records_left: 1,
            next_cursor: "operation-private-cursor",
          },
          qsos: { records_left: 1, next_cursor: "qso-private-cursor" },
        },
      });
    }
    assert.equal(sync.operations.cursor, "operation-private-cursor");
    assert.equal(sync.qsos.cursor, "qso-private-cursor");
    assert.equal(sync.operations.syncedSinceMillis, NOW - 200);
    assert.equal(sync.qsos.syncedSinceMillis, NOW - 100);
    return page([record("q2")], [operation("op2")]);
  };
  const result = await probeForwardReplay(h.options);
  assert.equal(result.status, "observed_match");
  assert.equal(result.readAttempts, 4);
  assert.equal(result.observedRecords, 4);
  assert.equal(result.tiedServerStamps, 4);
  assert(!JSON.stringify(result).includes("cursor"));
});

test("two empty complete windows cannot establish positive delivery or account completeness", async () => {
  const h = fixture();
  h.options.fetcher = async () => page([]);
  const result = await probeForwardReplay(h.options);
  assert.equal(result.completedPasses, 2);
  assert.equal(result.status, "discrepancy");
  assert.equal(result.missingRecords, 1);
  assert.equal(result.positiveDeliveryObserved, false);
  assert.equal(result.accountMembershipVerified, false);
});

test("incidental stable rows do not become independent membership evidence", async () => {
  const h = fixture();
  h.options.fetcher = async () => page([record(), record("incidental")]);
  const result = await probeForwardReplay(h.options);
  assert.equal(result.status, "observed_match");
  assert.equal(result.expectedRecords, 1);
  assert.equal(result.observedRecords, 1);
  assert.equal(result.incidentalRecords, 1);
  assert.equal(result.accountMembershipVerified, false);
});

test("changed known flags, event classification, operation membership and versions remain discrepancies", async (t) => {
  for (const change of [
    { deleted: true },
    { purged: true },
    { event: {} },
    { operation: "other-op" },
    { updatedAtMillis: NOW - 400 },
    { syncedAtMillis: NOW - 50 },
  ])
    await t.test(JSON.stringify(change), async () => {
      const h = fixture();
      h.options.fetcher = async () => page([record("q1", change)]);
      const result = await probeForwardReplay(h.options);
      assert.equal(result.status, "discrepancy");
      assert.equal(result.changedRecords, 1);
      assert.equal(result.observedRecords, 0);
    });
});

test("unknown application revisions do not become an observed match", async (t) => {
  for (const localUnknown of [true, false])
    await t.test(String(localUnknown), async () => {
      const h = fixture(
        manifest([
          known(record(), { updatedAtMillis: localUnknown ? null : NOW - 500 }),
        ]),
      );
      h.options.fetcher = async () =>
        page([record("q1", localUnknown ? {} : { updatedAtMillis: null })]);
      const result = await probeForwardReplay(h.options);
      assert.equal(result.status, "incomplete");
      assert.equal(result.unknownVersions, 1);
      assert.equal(result.positiveDeliveryObserved, false);
    });
});

test("a changed incidental row or missing positive in one pass exposes a moving window", async (t) => {
  for (const incidental of [true, false])
    await t.test(String(incidental), async () => {
      const h = fixture();
      let calls = 0;
      h.options.fetcher = async () => {
        calls++;
        return incidental
          ? page([record(), record("incidental", { deleted: calls === 2 })])
          : page(calls === 1 ? [record()] : []);
      };
      const result = await probeForwardReplay(h.options);
      assert.equal(result.status, "discrepancy");
      assert.equal(result.repeatedReadDifferences, 1);
      assert.equal(result.missingRecords, incidental ? 0 : 1);
    });
});

test("input scope, independent writer evidence and recent windows fail closed before transport", async (t) => {
  const cases: [
    string,
    (h: ReturnType<typeof fixture>, m: ForwardManifest) => void,
    string,
  ][] = [
    [
      "empty manifest",
      (_h, m) => {
        m.records = [];
      },
      "manifest_invalid",
    ],
    [
      "account mismatch",
      (_h, m) => {
        m.accountId = "another";
      },
      "manifest_invalid",
    ],
    [
      "reader mismatch",
      (_h, m) => {
        m.readerClientKey = "another";
      },
      "manifest_invalid",
    ],
    [
      "same writer",
      (_h, m) => {
        m.records[0].writerClientKey = credentials.key;
      },
      "writer_not_distinct",
    ],
    [
      "missing writer",
      (_h, m) => {
        m.records[0].writerClientKey = "";
      },
      "writer_not_distinct",
    ],
    [
      "unsynced",
      (_h, m) => {
        m.records[0].synced = false;
      },
      "manifest_unsynced",
    ],
    [
      "expired",
      (_h, m) => {
        m.capturedAt = NOW - 300_001;
      },
      "manifest_expired",
    ],
    [
      "future manifest",
      (_h, m) => {
        m.capturedAt = NOW + 1;
      },
      "manifest_expired",
    ],
    [
      "duplicate known row",
      (_h, m) => {
        m.records.push(m.records[0]);
      },
      "manifest_invalid",
    ],
    [
      "outside window",
      (_h, m) => {
        m.records[0].syncedAtMillis = NOW - 151;
      },
      "manifest_invalid",
    ],
    [
      "unknown server version",
      (_h, m) => {
        m.records[0].syncedAtMillis = null as never;
      },
      "manifest_invalid",
    ],
    [
      "old window",
      (h) => {
        h.options.watermarks.operations = NOW - 86_400_001;
      },
      "window_invalid",
    ],
    [
      "future window",
      (h) => {
        h.options.watermarks.qsos = NOW + 1;
      },
      "window_invalid",
    ],
    [
      "missing second watermark",
      (h) => {
        h.options.watermarks.qsos = undefined as never;
      },
      "window_invalid",
    ],
  ];
  for (const [name, change, reason] of cases)
    await t.test(name, async () => {
      const expected = manifest();
      const h = fixture();
      change(h, expected);
      h.options.loadManifest = async () => expected;
      const result = await probeForwardReplay(h.options);
      assert.equal(result.stopReason, reason);
      assert.equal(result.status, "unavailable");
      assert.equal(h.calls.length, 0);
    });
});

test("manifest version and writer changes after replay invalidate the observation", async (t) => {
  for (const writer of [true, false])
    await t.test(String(writer), async () => {
      const h = fixture();
      let loads = 0;
      h.options.loadManifest = async () => {
        const value = manifest();
        if (++loads === 2) {
          if (writer)
            value.records[0].writerClientKey = "different-independent-writer";
          else value.records[0].deleted = true;
        }
        return value;
      };
      const result = await probeForwardReplay(h.options);
      assert.equal(result.stopReason, "manifest_changed");
      assert.equal(result.status, "discrepancy");
      assert.equal(result.independentSnapshotStable, false);
    });
});

test("partial coverage, rejected and repeated cursors, missing stamps and malformed flags never complete", async (t) => {
  const cases: [string, () => Response, string][] = [
    [
      "missing coverage",
      () => page([record()], [], { meta: { operations: {}, qsos: {} } }),
      "protocol_error",
    ],
    [
      "cursor rejected",
      () =>
        page([record()], [], {
          errors: { qsos: { cursor: "private rejection" } },
        }),
      "protocol_error",
    ],
    [
      "empty partial",
      () =>
        page([], [], {
          meta: { operations: { records_left: 0 }, qsos: { records_left: 1 } },
        }),
      "empty_incomplete_page",
    ],
    [
      "missing server stamp",
      () => page([record("q1", { syncedAtMillis: undefined })]),
      "protocol_error",
    ],
    [
      "malformed flag",
      () => page([record("q1", { deleted: "unknown" })]),
      "protocol_error",
    ],
    [
      "old unrelated record",
      () => page([record("q1", { syncedAtMillis: NOW - 1000 })]),
      "protocol_error",
    ],
  ];
  for (const [name, response, reason] of cases)
    await t.test(name, async () => {
      const h = fixture();
      h.options.fetcher = async () => response();
      const result = await probeForwardReplay(h.options);
      assert.equal(result.stopReason, reason);
      assert.equal(result.completedPasses, 0);
    });
  const h = fixture();
  h.options.fetcher = async () =>
    page([record()], [], {
      meta: {
        operations: { records_left: 0 },
        qsos: { records_left: 1, next_cursor: "same-private-cursor" },
      },
    });
  const result = await probeForwardReplay(h.options);
  assert.equal(result.stopReason, "protocol_error");
  assert.equal(result.readAttempts, 2);
});

test("page rows and total request attempts are bounded independently of claimed coverage", async (t) => {
  await t.test("over-returned stream", async () => {
    const h = fixture();
    h.options.fetcher = async () =>
      page(Array.from({ length: 26 }, (_, i) => record(`q${i}`)));
    const result = await probeForwardReplay(h.options);
    assert.equal(result.stopReason, "page_size_exceeded");
    assert.equal(result.readAttempts, 1);
  });
  await t.test("four attempts", async () => {
    const h = fixture();
    let calls = 0;
    h.options.fetcher = async () =>
      page([record(`q${++calls}`, { syncedAtMillis: NOW - 100 + calls })], [], {
        meta: {
          operations: { records_left: 0 },
          qsos: { records_left: 1, next_cursor: `cursor${calls}` },
        },
      });
    const result = await probeForwardReplay(h.options);
    assert.equal(result.stopReason, "read_cap");
    assert.equal(result.readAttempts, 4);
    assert.equal(calls, 4);
  });
});

test("conflicting duplicates are rejected while identical overlap remains visible", async (t) => {
  for (const conflict of [true, false])
    await t.test(String(conflict), async () => {
      const h = fixture();
      h.options.fetcher = async () =>
        page([record(), record("q1", conflict ? { deleted: true } : {})]);
      const result = await probeForwardReplay(h.options);
      assert.equal(result.status, conflict ? "discrepancy" : "observed_match");
      assert.equal(
        result.stopReason,
        conflict ? "conflicting_duplicate" : null,
      );
      assert.equal(result.duplicateRows, conflict ? 1 : 2);
    });
});

test("time limits also apply after network responses and the final independent manifest load", async (t) => {
  for (const finalLoad of [false, true])
    await t.test(String(finalLoad), async () => {
      const h = fixture();
      let loads = 0;
      if (finalLoad)
        h.options.loadManifest = async () => {
          if (++loads === 2) h.setTime(NOW + 120_000);
          return manifest();
        };
      else
        h.options.fetcher = async () => {
          h.setTime(NOW + 120_000);
          return page();
        };
      const result = await probeForwardReplay(h.options);
      assert.equal(result.stopReason, "time_cap");
      assert.equal(result.status, "incomplete");
      assert.equal(result.positiveDeliveryObserved, false);
    });
});

test("account switches, missing tokens, authentication failures and cooldowns never renew credentials", async (t) => {
  const cases: [string, Response, string][] = [
    [
      "account switch",
      page([record()], [], { account: { uuid: "another-account" } }),
      "account_changed",
    ],
    [
      "unauthorized",
      new Response("private upstream error", { status: 401 }),
      "authentication_required",
    ],
    [
      "cooldown",
      new Response("private upstream error", { status: 429 }),
      "vendor_deferred",
    ],
    [
      "server unavailable",
      new Response("private upstream error", { status: 503 }),
      "vendor_unavailable",
    ],
    [
      "redirect",
      new Response(null, {
        status: 302,
        headers: { Location: "https://hostile.example" },
      }),
      "vendor_unavailable",
    ],
  ];
  for (const [name, response, reason] of cases)
    await t.test(name, async () => {
      const h = fixture();
      let calls = 0;
      h.options.fetcher = async () => {
        calls++;
        return response;
      };
      const result = await probeForwardReplay(h.options);
      assert.equal(result.stopReason, reason);
      assert.equal(calls, 1);
      assert(!JSON.stringify(result).includes("private"));
    });
  const h = fixture();
  const result = await probeForwardReplay({
    ...h.options,
    credentials: { ...credentials, token: undefined },
  });
  assert.equal(result.stopReason, "authentication_required");
  assert.equal(h.calls.length, 0);
  assert.equal(credentials.token, "private-token");
});

test("vendor budget failures and hostile transport errors remain fixed redacted outcomes", async (t) => {
  for (const error of [
    new Error("private-token https://private.example/contact/q1"),
    new VendorDeferredError(NOW + 1000),
  ])
    await t.test(error.constructor.name, async () => {
      const h = fixture();
      h.options.fetcher = async () => {
        throw error;
      };
      const result = await probeForwardReplay(h.options);
      assert.equal(
        result.stopReason,
        error instanceof VendorDeferredError
          ? "vendor_deferred"
          : "vendor_unavailable",
      );
      assert(!JSON.stringify(result).includes("private"));
    });
});

test("unexpected client routes, query parameters, mutation bodies and backfill requests are blocked before transport", async (t) => {
  const original = LoFiClient.prototype.syncPage;
  const expectedBody = {
    meta: {
      inboundSync: true,
      lastSyncAccountUUID: "account1",
      sync: {
        operations: {
          syncedSinceMillis: NOW - 300,
          limit: 25,
          anyClient: false,
        },
        qsos: { syncedSinceMillis: NOW - 150, limit: 25, anyClient: false },
      },
    },
  };
  for (const [url, body, method] of [
    ["https://hostile.example/v1/sync", expectedBody, "POST"],
    ["https://lofi.ham2k.net/v1/accounts", undefined, "GET"],
    ["https://lofi.ham2k.net/v1/sync?extra=1", expectedBody, "POST"],
    [
      "https://lofi.ham2k.net/v1/sync",
      { ...expectedBody, qsos: [record()] },
      "POST",
    ],
    [
      "https://lofi.ham2k.net/v1/sync",
      { ...expectedBody, operations: [] },
      "POST",
    ],
  ] as const)
    await t.test(`${url} ${String(body && Object.keys(body))}`, async () => {
      const h = fixture();
      try {
        LoFiClient.prototype.syncPage = async function () {
          const client = this as unknown as { fetcher: typeof fetch };
          await client.fetcher(url, {
            method,
            redirect: "manual",
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          throw new Error("transport should have been rejected");
        };
        const result = await probeForwardReplay(h.options);
        assert.equal(result.stopReason, "transport_denied");
        assert.equal(h.calls.length, 0);
      } finally {
        LoFiClient.prototype.syncPage = original;
      }
    });
  try {
    LoFiClient.prototype.syncPage = function (
      state: SyncState,
      now: number,
      limit?: number,
    ) {
      return original.call(this, { ...state, mode: "backfill" }, now, limit);
    };
    const h = fixture();
    const result = await probeForwardReplay(h.options);
    assert.equal(result.stopReason, "transport_denied");
    assert.equal(h.calls.length, 0);
  } finally {
    LoFiClient.prototype.syncPage = original;
  }
});

test("oversized response bodies retain the production parser bound", async () => {
  const h = fixture();
  h.options.fetcher = async () => new Response("x".repeat(2 * 1024 * 1024 + 1));
  const result = await probeForwardReplay(h.options);
  assert.equal(result.stopReason, "protocol_error");
  assert.equal(result.readAttempts, 1);
});
