import assert from "node:assert/strict";
import test from "node:test";
import { probeAllClientForwardReplay } from "../scripts/source-all-client-forward-probe.ts";
import type {
  InventoryCheckpoint,
  InventoryRecord,
  InventoryScope,
} from "../scripts/source-inventory-audit.ts";
import { LoFiClient, type SourceRecord } from "../src/lofi.ts";
import { isEventRecord, sourceFlag } from "../src/projection.ts";
import { canonical, sha256 } from "../src/security.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";
const NOW = 1_800_000_000_000;
const scope: InventoryScope = {
  tenant: "_private-tenant",
  source: "-private-source",
  credentialVersion: "_private-version",
  accountId: "private-account",
  clientKey: "private-client",
};
const credentials = {
  key: scope.clientKey,
  secret: "private-secret",
  token: "private-token",
};
const operation = (
  uuid = "private-op-new",
  time = NOW - 300,
): SourceRecord => ({
  uuid,
  stationCall: "PRIVATE",
  updatedAtMillis: NOW - 1000,
  syncedAtMillis: time,
});
const contact = (
  uuid = "private-qso",
  time = NOW - 300,
  extra = {},
): SourceRecord => ({
  uuid,
  operation: "private-op-new",
  band: "20m",
  updatedAtMillis: NOW - 1000,
  syncedAtMillis: time,
  notes: "private-QSON",
  ...extra,
});
const operations = [operation("private-op-old", NOW - 400), operation()];
const members = [
  contact("private-qso-old", NOW - 400),
  contact(),
  contact("private-event", NOW - 200, { event: { kind: "break" } }),
  contact("private-deleted", NOW - 100, { deleted: true }),
];
async function metadata(
  raw: SourceRecord,
  kind: InventoryRecord["kind"],
): Promise<InventoryRecord> {
  const { syncedAtMillis: _, ...body } = raw;
  return {
    kind,
    uuid: raw.uuid as string,
    operation:
      kind === "operation" ? null : ((raw.operation || null) as string | null),
    isEvent: kind === "qso" && isEventRecord(raw),
    deleted: sourceFlag(raw.deleted) || sourceFlag(raw.purged),
    purged: sourceFlag(raw.purged),
    updatedAtMillis: raw.updatedAtMillis as number,
    syncedAtMillis: raw.syncedAtMillis as number,
    revision: await sha256(canonical(body)),
  };
}
const page = (ops = operations.slice(1), qsos = members.slice(1), extra = {}) =>
  Response.json({
    account: { uuid: scope.accountId },
    operations: ops,
    qsos,
    meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
    ...extra,
  });
async function fixture() {
  let time = NOW;
  const first = await Promise.all([
    ...operations.map((r) => metadata(r, "operation")),
    ...members.map((r) => metadata(r, "qso")),
  ]);
  const baseline: InventoryCheckpoint = {
    schema: 1,
    scopeDigest: await sha256(
      canonical([
        scope.tenant,
        scope.source,
        scope.accountId,
        scope.clientKey,
        scope.credentialVersion,
      ]),
    ),
    startedAt: NOW - 90,
    updatedAt: NOW - 1000,
    lastRemoteReadAt: NOW - 50,
    pass: 3,
    passStartedAt: NOW - 75,
    state: {
      mode: "forward",
      accountId: scope.accountId,
      operations: { watermark: NOW - 300 },
      qsos: { watermark: NOW - 100 },
    },
    lastStamps: { operations: NOW - 400, qsos: NOW - 400 },
    attempts: 2,
    pages: 2,
    duplicateRows: 0,
    tiedRows: 0,
    expandedPages: 0,
    haloStable: true,
    ferryStable: true,
    initial: {
      capturedAt: NOW - 60000,
      accountId: scope.accountId,
      halo: [],
      ferry: [],
    },
    first,
    second: structuredClone(first),
  };
  // The completed baseline must postdate its actual server observations.
  baseline.updatedAt = NOW - 50;
  const calls: { url: string; init?: RequestInit }[] = [];
  return {
    baseline,
    calls,
    setTime: (value: number) => {
      time = value;
    },
    options: {
      scope,
      credentials,
      now: () => time,
      loadScope: async () => ({ ...scope }) as InventoryScope | null,
      loadBaseline: async () => structuredClone(baseline),
      fetcher: async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return page();
      },
    },
  };
}
test("all-client forward reads repeat a completed independent server suffix without granting authority", async () => {
  const h = await fixture();
  const result = await probeAllClientForwardReplay(h.options);
  assert.equal(result.status, "observed_match");
  assert.equal(result.readAttempts, 2);
  assert.equal(result.completedPasses, 2);
  assert.equal(result.completedOperationPasses, 2);
  assert.equal(result.completedMemberPasses, 2);
  assert.equal(result.expectedRecords, 4);
  assert.equal(result.observedRecords, 4);
  assert.equal(result.expectedOperations, 1);
  assert.equal(result.expectedContacts, 2);
  assert.equal(result.expectedEvents, 1);
  assert.equal(result.expectedDeleted, 1);
  assert.equal(result.positiveDeliveryObserved, true);
  assert.equal(result.currentScopeVerified, true);
  for (const value of [
    result.sourceBoundaryVerified,
    result.writesAuthorized,
    result.accountMembershipVerified,
    result.unknownHistoricalPurgesExcluded,
    result.continuousForwardCoverageVerified,
    result.writerProvenanceVerified,
  ])
    assert.equal(value, false);
  for (const call of h.calls) {
    assert.equal(call.url, "https://lofi.ham2k.net/v1/sync");
    assert.equal(call.init?.method, "POST");
    assert.equal(call.init?.redirect, "manual");
    assert.deepEqual(JSON.parse(String(call.init?.body)), {
      meta: {
        inboundSync: true,
        lastSyncAccountUUID: scope.accountId,
        sync: {
          operations: {
            syncedSinceMillis: NOW - 400,
            limit: 25,
            anyClient: true,
          },
          qsos: { syncedSinceMillis: NOW - 400, limit: 25, anyClient: true },
        },
      },
    });
  }
  assert(!JSON.stringify(result).includes("private"));
  assert(!JSON.stringify(result).includes("PRIVATE"));
});
test("empty complete windows cannot turn missing known positives into source completeness", async () => {
  const h = await fixture();
  h.options.fetcher = async () => page([], []);
  const r = await probeAllClientForwardReplay(h.options);
  assert.equal(r.completedPasses, 2);
  assert.equal(r.status, "discrepancy");
  assert.equal(r.missingRecords, 4);
  assert.equal(r.positiveDeliveryObserved, false);
});
test("boundary equality is optional and does not supply positive delivery evidence", async () => {
  const h = await fixture();
  h.options.fetcher = async () => page(operations, members);
  const r = await probeAllClientForwardReplay(h.options);
  assert.equal(r.status, "observed_match");
  assert.equal(r.boundaryRecords, 2);
  assert.equal(r.observedRecords, 4);
  assert.equal(r.unexpectedRecords, 0);
});
test("partial, drifting, malformed and expired baselines never dispatch", async (t) => {
  const cases: [string, (c: InventoryCheckpoint) => void, string][] = [
    [
      "partial",
      (c) => {
        c.pass = 2;
      },
      "baseline_incomplete",
    ],
    [
      "backfill",
      (c) => {
        c.state.mode = "backfill";
      },
      "baseline_incomplete",
    ],
    [
      "local drift",
      (c) => {
        c.haloStable = false;
      },
      "baseline_incomplete",
    ],
    [
      "ferry drift",
      (c) => {
        c.ferryStable = false;
      },
      "baseline_incomplete",
    ],
    [
      "scope",
      (c) => {
        c.scopeDigest = "x".repeat(43);
      },
      "baseline_invalid",
    ],
    [
      "account",
      (c) => {
        c.state.accountId = "other";
      },
      "baseline_invalid",
    ],
    [
      "fractional remote",
      (c) => {
        c.first[0].syncedAtMillis = NOW - 400.25;
      },
      "baseline_invalid",
    ],
    [
      "missing version",
      (c) => {
        c.first[0].revision = null;
      },
      "baseline_invalid",
    ],
    [
      "duplicate",
      (c) => {
        c.first.push({ ...c.first[0] });
      },
      "baseline_invalid",
    ],
    [
      "unexpected body",
      (c) => {
        (c.first[0] as unknown as Record<string, unknown>).raw = "private-QSON";
      },
      "baseline_invalid",
    ],
    [
      "record newer than baseline window",
      (c) => {
        c.first[0].syncedAtMillis = NOW - 60;
        c.second[0].syncedAtMillis = NOW - 60;
      },
      "baseline_invalid",
    ],
    [
      "missing remote freshness",
      (c) => {
        delete c.lastRemoteReadAt;
      },
      "baseline_invalid",
    ],
    [
      "local-only freshness",
      (c) => {
        c.startedAt = NOW - 600000;
        c.passStartedAt = NOW - 500000;
        c.lastRemoteReadAt = NOW - 300001;
        c.updatedAt = NOW;
      },
      "baseline_expired",
    ],
    [
      "changed repeat",
      (c) => {
        c.second[0].deleted = true;
      },
      "baseline_changed",
    ],
    [
      "expired",
      (c) => {
        c.startedAt = NOW - 600000;
        c.passStartedAt = NOW - 500000;
        c.updatedAt = NOW - 300001;
        c.lastRemoteReadAt = NOW - 300001;
      },
      "baseline_expired",
    ],
  ];
  for (const [name, change, reason] of cases)
    await t.test(name, async () => {
      const h = await fixture();
      change(h.baseline);
      const r = await probeAllClientForwardReplay(h.options);
      assert.equal(r.stopReason, reason);
      assert.equal(h.calls.length, 0);
    });
});
test("each stream needs a separately observed older stamp and a bounded positive cohort", async (t) => {
  for (const kind of ["operation", "qso"] as const)
    await t.test(kind, async () => {
      const h = await fixture();
      for (const row of h.baseline.first)
        if (row.kind === kind) row.syncedAtMillis = NOW - 400;
      h.baseline.second = structuredClone(h.baseline.first);
      const r = await probeAllClientForwardReplay(h.options);
      assert.equal(r.stopReason, "window_unavailable");
      assert.equal(h.calls.length, 0);
    });
  const h = await fixture();
  const tied = await Promise.all(
    Array.from({ length: 26 }, (_, i) =>
      metadata(contact(`private-tie-${i}`, NOW - 100), "qso"),
    ),
  );
  h.baseline.first.push(...tied);
  h.baseline.second = structuredClone(h.baseline.first);
  const r = await probeAllClientForwardReplay(h.options);
  assert.equal(r.stopReason, "window_unavailable");
  assert.equal(h.calls.length, 0);
});
test("changed versions, membership, deletion and newly arriving records remain discrepancies", async (t) => {
  for (const kind of [
    "body",
    "membership",
    "deleted",
    "missing",
    "unexpected",
    "event",
  ] as const)
    await t.test(kind, async () => {
      const h = await fixture();
      let count = 0;
      h.options.fetcher = async () => {
        count++;
        const rows = structuredClone(members.slice(1));
        if (kind === "missing") rows.shift();
        else if (kind === "unexpected")
          rows.push(contact("private-unexpected", NOW - 25));
        else
          Object.assign(
            rows[0],
            kind === "body"
              ? { notes: "changed-private-QSON" }
              : kind === "membership"
                ? { operation: "private-other" }
                : kind === "deleted"
                  ? { deleted: true }
                  : { event: { kind: "start" } },
          );
        return count === 1 ? page() : page(operations.slice(1), rows);
      };
      const r = await probeAllClientForwardReplay(h.options);
      assert.equal(r.status, "discrepancy");
      assert(r.repeatedReadDifferences > 0);
      if (kind === "missing") assert.equal(r.missingRecords, 1);
      else if (kind === "unexpected") assert.equal(r.unexpectedRecords, 1);
      else assert.equal(r.changedRecords, 1);
    });
});
test("scope and baseline changes after reads never report fresh stable evidence", async (t) => {
  for (const change of ["scope", "baseline"] as const)
    await t.test(change, async () => {
      const h = await fixture();
      let reads = 0;
      h.options.fetcher = async () => {
        reads++;
        return page();
      };
      if (change === "scope")
        h.options.loadScope = async () => (reads ? null : { ...scope });
      else
        h.options.loadBaseline = async () => {
          const b = structuredClone(h.baseline);
          if (reads >= 2) {
            b.first[0].deleted = true;
            b.second[0].deleted = true;
          }
          return b;
        };
      const r = await probeAllClientForwardReplay(h.options);
      assert.equal(
        r.stopReason,
        change === "scope" ? "scope_changed" : "baseline_changed",
      );
      assert.equal(r.currentScopeVerified, false);
      assert.equal(r.baselineStable, false);
    });
});
test("two-page windows preserve opaque cursors and reset both passes independently", async () => {
  const h = await fixture();
  let reads = 0;
  h.options.fetcher = async (input, init) => {
    h.calls.push({ url: String(input), init });
    const index = reads++ % 2;
    const request = JSON.parse(String(init?.body)).meta.sync;
    assert.equal(request.qsos.anyClient, true);
    assert.equal(
      request.qsos.cursor,
      index === 0 ? undefined : "private-opaque",
    );
    return index === 0
      ? page(operations.slice(1), members.slice(1, 2), {
          meta: {
            operations: { records_left: 0 },
            qsos: { records_left: 2, next_cursor: "private-opaque" },
          },
        })
      : page([], members.slice(2));
  };
  const r = await probeAllClientForwardReplay(h.options);
  assert.equal(r.status, "observed_match");
  assert.equal(r.readAttempts, 4);
  assert.equal(r.pages, 4);
  assert.equal(r.completedOperationPasses, 2);
  assert.equal(r.completedMemberPasses, 2);
});
test("identical overlaps are counted and conflicting repeated identities stop", async (t) => {
  for (const conflict of [false, true])
    await t.test(String(conflict), async () => {
      const h = await fixture();
      h.options.fetcher = async () =>
        page(operations.slice(1), [
          ...members.slice(1),
          contact(
            "private-qso",
            NOW - 300,
            conflict ? { notes: "changed" } : {},
          ),
        ]);
      const r = await probeAllClientForwardReplay(h.options);
      assert.equal(r.status, conflict ? "discrepancy" : "observed_match");
      assert.equal(r.stopReason, conflict ? "conflicting_duplicate" : null);
      assert(r.duplicateRows > 0);
    });
});
test("explicit stream completion, cursor integrity and page/body bounds are mandatory", async (t) => {
  const cases: [string, () => Response, string][] = [
    [
      "missing count",
      () =>
        page(undefined, undefined, {
          meta: { operations: {}, qsos: { records_left: 0 } },
        }),
      "protocol_error",
    ],
    [
      "empty incomplete",
      () =>
        page([], [], {
          meta: { operations: { records_left: 0 }, qsos: { records_left: 1 } },
        }),
      "empty_incomplete_page",
    ],
    [
      "cursor rejected",
      () => page(undefined, undefined, { errors: { qsos: { cursor: "bad" } } }),
      "protocol_error",
    ],
    [
      "account changed",
      () => page(undefined, undefined, { account: { uuid: "other" } }),
      "account_changed",
    ],
    [
      "row overflow",
      () =>
        page(
          operations.slice(1),
          Array.from({ length: 26 }, (_, i) => contact(`private-over-${i}`)),
        ),
      "page_size_exceeded",
    ],
    [
      "body overflow",
      () =>
        page(undefined, undefined, { padding: "x".repeat(2 * 1024 * 1024) }),
      "protocol_error",
    ],
    [
      "out of window",
      () => page(operations.slice(1), [contact("private-too-old", NOW - 401)]),
      "protocol_error",
    ],
    [
      "fractional live",
      () => page(operations.slice(1), [contact("private-qso", NOW - 300.25)]),
      "protocol_error",
    ],
    [
      "expired credential",
      () => new Response("private-auth-error", { status: 401 }),
      "authentication_required",
    ],
  ];
  for (const [name, response, reason] of cases)
    await t.test(name, async () => {
      const h = await fixture();
      let calls = 0;
      h.options.fetcher = async () => {
        calls++;
        return response();
      };
      const r = await probeAllClientForwardReplay(h.options);
      assert.equal(r.stopReason, reason);
      assert.equal(calls, 1);
      assert.equal(r.sourceBoundaryVerified, false);
    });
});
test("budget denial consumes no network attempt and exposes only a fixed retry timestamp", async (t) => {
  for (const sent of [false, true])
    await t.test(String(sent), async () => {
      const h = await fixture();
      h.options.fetcher = async () => {
        throw new VendorDeferredError(NOW + 300000, sent);
      };
      const r = await probeAllClientForwardReplay(h.options);
      assert.equal(r.readAttempts, sent ? 1 : 0);
      assert.equal(r.retryAt, NOW + 300000);
      assert.equal(r.stopReason, sent ? "vendor_deferred" : "budget_deferred");
      assert.equal(r.status, "incomplete");
    });
});
test("request and wall-clock limits stop continuations without new authority", async (t) => {
  await t.test("read cap", async () => {
    const h = await fixture();
    let n = 0;
    h.options.fetcher = async () =>
      page(operations.slice(1), [members[1]], {
        meta: {
          operations: { records_left: 0 },
          qsos: { records_left: 1, next_cursor: `private-cursor-${++n}` },
        },
      });
    const r = await probeAllClientForwardReplay(h.options);
    assert.equal(r.stopReason, "read_cap");
    assert.equal(r.readAttempts, 4);
    assert.equal(r.completedPasses, 0);
  });
  await t.test("time cap", async () => {
    const h = await fixture();
    h.options.fetcher = async () => {
      h.setTime(NOW + 120000);
      return page();
    };
    const r = await probeAllClientForwardReplay(h.options);
    assert.equal(r.stopReason, "time_cap");
    assert.equal(r.readAttempts, 1);
    assert.equal(r.pages, 0);
  });
});
test("the adapter wrapper denies mutation bodies, alternate hosts and renewal before transport", async (t) => {
  const original = LoFiClient.prototype.syncPage;
  try {
    for (const mutation of ["body", "host", "renewal"] as const)
      await t.test(mutation, async () => {
        LoFiClient.prototype.syncPage = async function () {
          const self = this as unknown as { fetcher: typeof fetch };
          await self.fetcher(
            mutation === "host"
              ? "https://example.invalid/v1/sync"
              : mutation === "renewal"
                ? "https://lofi.ham2k.net/v1/client"
                : "https://lofi.ham2k.net/v1/sync",
            {
              method: "POST",
              redirect: "manual",
              body: JSON.stringify({ operations: [operation()] }),
            },
          );
          throw new Error("must stop");
        };
        const h = await fixture();
        const r = await probeAllClientForwardReplay(h.options);
        assert.equal(
          r.stopReason,
          mutation === "renewal"
            ? "authentication_required"
            : "transport_denied",
        );
        assert.equal(h.calls.length, 0);
      });
  } finally {
    LoFiClient.prototype.syncPage = original;
  }
});

test("many distinct partial pages hit the bounded in-memory record cap", async () => {
  const h = await fixture();
  let n = 0;
  h.options.fetcher = async () => {
    n++;
    return page(
      Array.from({ length: 25 }, (_, i) =>
        operation(`private-op-${n}-${i}`, NOW - 100),
      ),
      Array.from({ length: 25 }, (_, i) =>
        contact(`private-contact-${n}-${i}`, NOW - 100),
      ),
      {
        meta: {
          operations: {
            records_left: 1,
            next_cursor: `private-op-cursor-${n}`,
          },
          qsos: { records_left: 1, next_cursor: `private-qso-cursor-${n}` },
        },
      },
    );
  };
  const result = await probeAllClientForwardReplay(h.options);
  assert.equal(result.stopReason, "record_cap");
  assert.equal(result.readAttempts, 3);
  assert.equal(result.completedPasses, 0);
  assert.equal(result.positiveDeliveryObserved, false);
});
