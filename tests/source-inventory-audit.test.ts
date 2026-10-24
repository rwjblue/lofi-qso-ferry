import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceSourceInventoryAudit,
  type InventoryCheckpoint,
  type InventoryManifests,
  type InventoryRecord,
  type InventoryScope,
} from "../scripts/source-inventory-audit.ts";
import { LoFiClient } from "../src/lofi.ts";
import { canonical, sha256 } from "../src/security.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";

const NOW = 1_800_000_000_000;
const scope: InventoryScope = {
  tenant: "private-tenant",
  source: "private-source",
  accountId: "private-account",
  clientKey: "browser:private-reader",
  credentialVersion: "private-credential-version",
};
const credentials = {
  key: scope.clientKey,
  secret: "private-secret",
  token: "private-token",
};
const raw = (uuid = "private-q1", overrides = {}) => ({
  uuid,
  operation: "private-op1",
  band: "20m",
  updatedAtMillis: NOW - 500,
  syncedAtMillis: NOW - 100,
  notes: "private-QSON-must-not-persist",
  ...overrides,
});
const base = () => ({
  uuid: "private-op1",
  updatedAtMillis: NOW - 600,
  syncedAtMillis: NOW - 200,
  stationCall: "PRIVATE-PAYLOAD",
});
async function metadata(
  row: ReturnType<typeof raw>,
  kind: InventoryRecord["kind"] = "qso",
): Promise<InventoryRecord> {
  const { syncedAtMillis: _, ...inputs } = row;
  return {
    kind,
    uuid: row.uuid,
    operation: kind === "operation" ? null : row.operation,
    isEvent: row.band === "event",
    deleted: false,
    purged: false,
    updatedAtMillis: row.updatedAtMillis,
    syncedAtMillis: row.syncedAtMillis,
    revision: await sha256(canonical(inputs)),
  };
}
const page = (
  qsos: unknown[] = [raw()],
  operations: unknown[] = [base()],
  overrides = {},
) =>
  Response.json({
    account: { uuid: scope.accountId },
    operations,
    qsos,
    meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
    ...overrides,
  });
async function fixture() {
  let time = NOW;
  let saved: InventoryCheckpoint | undefined;
  const calls: { url: string; init?: RequestInit }[] = [];
  const saves: InventoryCheckpoint[] = [];
  const rows = [
    await metadata({ ...raw(), ...base() }, "operation"),
    await metadata(raw()),
  ];
  // The base hash must describe its actual wire body, without QSO-only fields.
  rows[0].revision = await sha256(
    canonical((({ syncedAtMillis: _, ...r }) => r)(base())),
  );
  const initial: InventoryManifests = {
    capturedAt: NOW,
    accountId: scope.accountId,
    halo: rows.map((r) => ({ ...r, revision: null })),
    ferry: rows.map((r) => ({ ...r, updatedAtMillis: null, purged: null })),
  };
  return {
    calls,
    saves,
    initial,
    setTime: (value: number) => {
      time = value;
    },
    get saved() {
      return saved;
    },
    options: {
      scope,
      credentials,
      now: () => time,
      loadScope: async () => ({ ...scope }) as InventoryScope | null,
      loadManifests: async () => ({
        ...structuredClone(initial),
        capturedAt: time,
      }),
      saveCheckpoint: async (value: InventoryCheckpoint) => {
        saved = structuredClone(value);
        saves.push(structuredClone(value));
      },
      fetcher: async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return page();
      },
    },
  };
}

test("two full all-client passes compare independent origins without granting authority", async () => {
  const h = await fixture();
  const result = await advanceSourceInventoryAudit(h.options);
  assert.equal(result.status, "observed_match");
  assert.equal(result.completedPasses, 2);
  assert.equal(result.totalAttempts, 2);
  assert.equal(result.pages, 2);
  assert.equal(result.haloSnapshotStable, true);
  assert.equal(result.ferrySnapshotStable, true);
  assert.equal(result.checkpointSaved, true);
  assert.equal(result.firstRecords, 2);
  assert.equal(result.operations, 1);
  assert.equal(result.contacts, 1);
  for (const flag of [
    result.sourceBoundaryVerified,
    result.writesAuthorized,
    result.accountMembershipVerified,
    result.unknownHistoricalPurgesExcluded,
    result.forwardCatchupObserved,
  ])
    assert.equal(flag, false);
  for (const c of h.calls) {
    assert.equal(c.url, "https://lofi.ham2k.net/v1/sync");
    assert.equal(c.init?.method, "POST");
    assert.equal(c.init?.redirect, "manual");
    assert.deepEqual(JSON.parse(String(c.init?.body)), {
      meta: {
        inboundSync: true,
        lastSyncAccountUUID: scope.accountId,
        sync: {
          operations: { syncedUntilMillis: NOW, limit: 200, anyClient: true },
          qsos: { syncedUntilMillis: NOW, limit: 200, anyClient: true },
        },
      },
    });
  }
  const checkpoint = JSON.stringify(h.saved);
  assert(!checkpoint.includes("private-token"));
  assert(!checkpoint.includes("private-secret"));
  assert(!checkpoint.includes("PRIVATE-PAYLOAD"));
  assert(!checkpoint.includes("private-QSON"));
  assert(!checkpoint.includes(scope.clientKey));
  assert(!JSON.stringify(result).includes("private-"));
});

test("paging resumes across bounded continuations with exact opaque cursors and independent sides", async () => {
  const h = await fixture();
  const qsos = [
    raw(),
    raw("private-q2", { syncedAtMillis: NOW - 101 }),
    raw("private-q3", { syncedAtMillis: NOW - 102 }),
  ];
  const known = await Promise.all(qsos.map((r) => metadata(r)));
  h.initial.halo.push(...known.slice(1).map((r) => ({ ...r, revision: null })));
  h.initial.ferry.push(...known.slice(1));
  let calls = 0;
  h.options.fetcher = async (input, init) => {
    h.calls.push({ url: String(input), init });
    const index = calls++ % 3;
    const request = JSON.parse(String(init?.body)).meta.sync;
    assert.equal(request.qsos.anyClient, true);
    assert.equal(
      request.qsos.cursor,
      index === 0 ? undefined : `private-cursor-${index}`,
    );
    return page([qsos[index]], index === 0 ? [base()] : [], {
      meta: {
        operations: { records_left: 0 },
        qsos:
          index === 2
            ? { records_left: 0 }
            : {
                records_left: 2 - index,
                next_cursor: `private-cursor-${index + 1}`,
              },
      },
    });
  };
  const first = await advanceSourceInventoryAudit(h.options);
  assert.equal(first.stopReason, "batch_limit");
  assert.equal(first.batchAttempts, 4);
  assert.equal(first.completedPasses, 1);
  assert.equal(h.saved?.pages, 4);
  assert.equal(h.saved?.state.qsos.cursor, "private-cursor-1");
  h.setTime(NOW + 300_000);
  const second = await advanceSourceInventoryAudit({
    ...h.options,
    checkpoint: JSON.parse(JSON.stringify(h.saved)),
  });
  assert.equal(second.status, "observed_match");
  assert.equal(second.totalAttempts, 6);
  assert.equal(second.batchAttempts, 2);
  assert.equal(second.completedPasses, 2);
  assert.equal(calls, 6);
});

test("shared budget admission deferral consumes no network attempt and preserves the last committed page", async () => {
  const h = await fixture();
  let calls = 0;
  h.options.fetcher = async () => {
    if (++calls === 2) throw new VendorDeferredError(NOW + 300_000);
    return page([raw()], [base()], {
      meta: {
        operations: { records_left: 0 },
        qsos: { records_left: 1, next_cursor: "private-next" },
      },
    });
  };
  const result = await advanceSourceInventoryAudit(h.options);
  assert.equal(result.stopReason, "budget_deferred");
  assert.equal(result.retryAt, NOW + 300_000);
  assert.equal(result.totalAttempts, 1);
  assert.equal(h.saved?.attempts, 1);
  assert.equal(h.saved?.pages, 1);
  assert.equal(h.saved?.state.qsos.cursor, "private-next");
  assert.equal(h.saved?.first.length, 2);
});

test("server cooldown is separate from budget admission and never renews", async () => {
  const h = await fixture();
  h.options.fetcher = async () => {
    throw new VendorDeferredError(NOW + 300_000, true);
  };
  const result = await advanceSourceInventoryAudit(h.options);
  assert.equal(result.stopReason, "vendor_deferred");
  assert.equal(result.totalAttempts, 1);
  assert.equal(h.saved?.attempts, 1);
  assert.equal(h.saved?.pages, 0);
});

test("all retained deleted contacts, events and base operations participate in comparisons", async () => {
  const h = await fixture();
  const event = await metadata(raw("private-event", { band: "event" }));
  const deleted = await metadata(raw("private-deleted"));
  deleted.deleted = true;
  deleted.purged = true;
  h.initial.ferry.push(event, deleted);
  h.initial.halo.push(
    { ...event, revision: null },
    { ...deleted, revision: null },
  );
  const result = await advanceSourceInventoryAudit(h.options);
  assert.equal(result.status, "discrepancy");
  assert.equal(result.ferry.expected, 4);
  assert.equal(result.ferry.missing, 2);
  assert.equal(result.halo.missing, 2);
  const missingBase = await fixture();
  missingBase.options.fetcher = async () => page([raw()], []);
  const second = await advanceSourceInventoryAudit(missingBase.options);
  assert.equal(second.ferry.missing, 1);
  assert.equal(second.status, "discrepancy");
});

test("server positives absent locally remain separate from retained Ferry agreement", async () => {
  const h = await fixture();
  h.initial.halo = h.initial.halo.filter((r) => r.kind === "operation");
  const result = await advanceSourceInventoryAudit(h.options);
  assert.equal(result.status, "discrepancy");
  assert.equal(result.halo.additional, 1);
  assert.equal(result.ferry.additional, 0);
  assert.equal(result.ferry.missing, 0);
  assert.equal(result.repeat.missing, 0);
});

test("repeat membership, deletion, event and body-version changes never become stable inventory", async (t) => {
  for (const change of ["missing", "deleted", "event", "body"] as const)
    await t.test(change, async () => {
      const h = await fixture();
      let calls = 0;
      h.options.fetcher = async () =>
        ++calls === 1
          ? page()
          : page(
              change === "missing"
                ? []
                : [
                    raw(
                      "private-q1",
                      change === "deleted"
                        ? { deleted: true }
                        : change === "event"
                          ? { event: {} }
                          : { notes: "changed-private-payload" },
                    ),
                  ],
            );
      const result = await advanceSourceInventoryAudit(h.options);
      assert.equal(result.status, "discrepancy");
      assert.equal(result.repeat.missing, change === "missing" ? 1 : 0);
      assert.equal(result.repeat.revisions, change === "missing" ? 0 : 1);
    });
});

test("independent snapshot changes during either pass and after completed resume cannot false-pass", async (t) => {
  for (const origin of ["halo", "ferry"] as const)
    await t.test(origin, async () => {
      const h = await fixture();
      let loads = 0;
      const original = h.options.loadManifests;
      h.options.loadManifests = async () => {
        const value = await original();
        if (++loads >= 2) value[origin][0].deleted = true;
        return value;
      };
      const result = await advanceSourceInventoryAudit(h.options);
      assert.equal(result.status, "discrepancy");
      assert.equal(
        result[
          origin === "halo" ? "haloSnapshotStable" : "ferrySnapshotStable"
        ],
        false,
      );
    });
  const h = await fixture();
  await advanceSourceInventoryAudit(h.options);
  h.initial.halo[0].deleted = true;
  const result = await advanceSourceInventoryAudit({
    ...h.options,
    checkpoint: h.saved,
  });
  assert.equal(result.status, "discrepancy");
  assert.equal(result.batchAttempts, 0);
  assert.equal(result.haloSnapshotStable, false);
});

test("scope revocation or credential/account changes after a page cannot checkpoint its records or cursor", async (t) => {
  for (const change of [
    null,
    { ...scope, credentialVersion: "replacement" },
    { ...scope, accountId: "replacement" },
  ])
    await t.test(
      change === null ? "revoked" : change.credentialVersion,
      async () => {
        const h = await fixture();
        let fetched = false;
        h.options.loadScope = async () => (fetched ? change : { ...scope });
        h.options.fetcher = async () => {
          fetched = true;
          return page();
        };
        const result = await advanceSourceInventoryAudit(h.options);
        assert.equal(result.stopReason, "scope_changed");
        assert.equal(result.checkpointSaved, false);
        assert.equal(result.totalAttempts, 1);
        assert.equal(h.saved?.pages, 0);
        assert.equal(h.saved?.first.length, 0);
        assert.equal(h.saved?.state.qsos.cursor, undefined);
      },
    );
});

test("checkpoint scope, schema and retained data validation reject drift before transport without leaking values", async (t) => {
  const h = await fixture();
  await advanceSourceInventoryAudit(h.options);
  const original = structuredClone(h.saved!);
  for (const change of [
    (c: InventoryCheckpoint) => {
      c.scopeDigest = "x".repeat(43);
    },
    (c: InventoryCheckpoint) => {
      c.attempts = "private-token" as never;
    },
    (c: InventoryCheckpoint) => {
      (c.first[0] as unknown as Record<string, unknown>).payload =
        "private-QSON";
    },
    (c: InventoryCheckpoint) => {
      c.state.accountId = "other-account";
    },
  ])
    await t.test(String(change), async () => {
      const c = structuredClone(original);
      change(c);
      let calls = 0;
      const result = await advanceSourceInventoryAudit({
        ...h.options,
        checkpoint: c,
        fetcher: async () => {
          calls++;
          return page();
        },
      });
      assert.equal(result.status, "unavailable");
      assert.equal(calls, 0);
      assert(!JSON.stringify(result).includes("private-"));
    });
});

test("bounded legal timestamp-tie expansion is accepted but oversized pages and unordered data stop", async (t) => {
  await t.test("legal expanded tie", async () => {
    const h = await fixture();
    h.options.fetcher = async () =>
      page(Array.from({ length: 201 }, (_, i) => raw(`row-${i}`)));
    const result = await advanceSourceInventoryAudit(h.options);
    assert.equal(result.completedPasses, 2);
    assert.equal(result.expandedPages, 2);
    assert.equal(result.stopReason, null);
    assert.equal(result.tiedRows, 400);
  });
  await t.test("bounded overflow", async () => {
    const h = await fixture();
    h.options.fetcher = async () =>
      page(Array.from({ length: 2001 }, (_, i) => raw(`row-${i}`)));
    const result = await advanceSourceInventoryAudit(h.options);
    assert.equal(result.stopReason, "page_overflow");
    assert.equal(h.saved?.pages, 0);
  });
  await t.test("out of order", async () => {
    const h = await fixture();
    h.options.fetcher = async () =>
      page([raw("older", { syncedAtMillis: NOW - 200 }), raw()]);
    const result = await advanceSourceInventoryAudit(h.options);
    assert.equal(result.stopReason, "out_of_order");
    assert.equal(h.saved?.pages, 0);
  });
  await t.test("conflicting duplicate", async () => {
    const h = await fixture();
    h.options.fetcher = async () =>
      page([raw(), raw("private-q1", { deleted: true })]);
    const result = await advanceSourceInventoryAudit(h.options);
    assert.equal(result.stopReason, "conflicting_duplicate");
    assert.equal(h.saved?.first.length, 0);
  });
});

test("explicit coverage, cursor refusal, stream errors and the parser byte cap remain mandatory", async (t) => {
  const cases: [string, () => Response, string][] = [
    [
      "empty partial",
      () =>
        page([], [], {
          meta: { operations: { records_left: 0 }, qsos: { records_left: 1 } },
        }),
      "empty_incomplete_page",
    ],
    [
      "missing count",
      () => page([raw()], [base()], { meta: { operations: {}, qsos: {} } }),
      "protocol_error",
    ],
    [
      "cursor rejected",
      () =>
        page([raw()], [base()], {
          errors: { qsos: { cursor: "private-error" } },
        }),
      "protocol_error",
    ],
    [
      "account changed",
      () => page([raw()], [base()], { account: { uuid: "other" } }),
      "account_changed",
    ],
    [
      "oversized body",
      () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
      "protocol_error",
    ],
    [
      "expired token",
      () => new Response("private", { status: 401 }),
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
      const result = await advanceSourceInventoryAudit(h.options);
      assert.equal(result.stopReason, reason);
      assert.equal(calls, 1);
      assert.equal(h.saved?.pages, 0);
      assert(!JSON.stringify(result).includes("private"));
    });
});

test("batch and overall age bounds retain usable progress rather than granting stale success", async () => {
  const h = await fixture();
  h.options.fetcher = async () => {
    h.setTime(NOW + 120_000);
    return page();
  };
  const result = await advanceSourceInventoryAudit(h.options);
  assert.equal(result.stopReason, "time_limit");
  assert.equal(h.saved?.pages, 0);
  assert.equal(h.saved?.attempts, 1);
  h.setTime(NOW + 90 * 60_000);
  const expired = await advanceSourceInventoryAudit({
    ...h.options,
    checkpoint: h.saved,
  });
  assert.equal(expired.stopReason, "run_expired");
  assert.equal(expired.batchAttempts, 0);
});

test("a failed boundary snapshot does not persist a forward-mode cursor under an incomplete pass", async () => {
  const h = await fixture();
  let loads = 0;
  const original = h.options.loadManifests;
  h.options.loadManifests = async () => {
    if (++loads === 2) throw new Error("private snapshot error");
    return original();
  };
  const result = await advanceSourceInventoryAudit(h.options);
  assert.equal(result.stopReason, "manifest_invalid");
  assert.equal(h.saved?.pass, 1);
  assert.equal(h.saved?.state.mode, "backfill");
  assert.equal(h.saved?.pages, 0);
  assert.equal(h.saved?.attempts, 1);
});

test("checkpoint write failures never report durable success", async () => {
  const h = await fixture();
  h.options.saveCheckpoint = async () => {
    throw new Error("private path");
  };
  const result = await advanceSourceInventoryAudit(h.options);
  assert.equal(result.stopReason, "checkpoint_not_saved");
  assert.equal(result.checkpointSaved, false);
  assert.equal(result.batchAttempts, 0);
  assert(!JSON.stringify(result).includes("private"));
});

test("unexpected mutation arrays and alternate routes fail the exact single-use transport allowlist", async () => {
  const original = LoFiClient.prototype.syncPage;
  try {
    LoFiClient.prototype.syncPage = async function () {
      const self = this as unknown as { fetcher: typeof fetch };
      await self.fetcher("https://lofi.ham2k.net/v1/sync", {
        method: "POST",
        redirect: "manual",
        body: JSON.stringify({ operations: [base()] }),
      });
      throw new Error("must stop");
    };
    const h = await fixture();
    const result = await advanceSourceInventoryAudit(h.options);
    assert.equal(result.stopReason, "transport_denied");
    assert.equal(h.calls.length, 0);
  } finally {
    LoFiClient.prototype.syncPage = original;
  }
});

test("repeated preflight deferrals preserve cursor and network counters across resumes", async () => {
  const h = await fixture();
  h.options.fetcher = async () => {
    throw new VendorDeferredError(NOW + 300_000);
  };
  for (let i = 0; i < 3; i++) {
    const result = await advanceSourceInventoryAudit({
      ...h.options,
      checkpoint: h.saved,
    });
    assert.equal(result.stopReason, "budget_deferred");
    assert.equal(result.batchAttempts, 0);
    assert.equal(result.totalAttempts, 0);
    assert.equal(result.pages, 0);
    assert.equal(result.completedPasses, 0);
    assert.deepEqual(h.saved?.state, {
      mode: "backfill",
      accountId: scope.accountId,
      operations: {},
      qsos: {},
    });
  }
});

test("a missing observed application revision cannot match an independently known version", async () => {
  const h = await fixture();
  h.options.fetcher = async () =>
    page([raw("private-q1", { updatedAtMillis: undefined })]);
  const result = await advanceSourceInventoryAudit(h.options);
  assert.equal(result.status, "discrepancy");
  assert.equal(result.halo.unknownVersions, 1);
  assert.equal(result.completedPasses, 2);
});

test("repository base64url identity tokens may begin with underscores or hyphens", async (t) => {
  for (const prefix of ["_", "-"]) {
    for (const field of ["tenant", "source", "credentialVersion"] as const) {
      await t.test(`${prefix} ${field}`, async () => {
        const h = await fixture();
        const tokenScope = { ...scope, [field]: prefix + "a".repeat(42) };
        const result = await advanceSourceInventoryAudit({
          ...h.options,
          scope: tokenScope,
          loadScope: async () => ({ ...tokenScope }),
        });
        assert.equal(result.status, "observed_match");
        assert.equal(result.completedPasses, 2);
      });
    }
  }
});

test("fractional independent server stamps are preserved exactly and never rounded into agreement", async () => {
  const h = await fixture();
  h.initial.halo[1].syncedAtMillis = NOW - 100.25;
  const result = await advanceSourceInventoryAudit(h.options);
  assert.equal(result.completedPasses, 2);
  assert.equal(result.status, "discrepancy");
  assert.equal(result.halo.serverVersions, 1);
  assert.equal(result.ferry.serverVersions, 0);
  assert.equal(h.saved?.initial.halo[1].syncedAtMillis, NOW - 100.25);
});

test("missing independent server stamps remain unknown despite complete repeated inventory", async () => {
  const h = await fixture();
  h.initial.halo[1].syncedAtMillis = null;
  const result = await advanceSourceInventoryAudit(h.options);
  assert.equal(result.completedPasses, 2);
  assert.equal(result.status, "incomplete");
  assert.equal(result.halo.unknownVersions, 1);
  assert.equal(result.ferry.unknownVersions, 0);
});

test("saved remote page metadata must retain integer application and server stamps", async (t) => {
  for (const field of ["updatedAtMillis", "syncedAtMillis"] as const) {
    await t.test(field, async () => {
      const h = await fixture();
      await advanceSourceInventoryAudit(h.options);
      const checkpoint = structuredClone(h.saved);
      assert(checkpoint);
      checkpoint.first[0][field] = NOW - 0.25;
      const before = h.calls.length;
      const result = await advanceSourceInventoryAudit({
        ...h.options,
        checkpoint,
      });
      assert.equal(result.stopReason, "checkpoint_invalid");
      assert.equal(result.checkpointSaved, false);
      assert.equal(h.calls.length, before);
    });
  }
});
