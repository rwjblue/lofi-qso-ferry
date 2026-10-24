import assert from "node:assert/strict";
import test from "node:test";
import type { SourceRecord } from "../src/lofi.ts";
import { isEventRecord, isSourceDeleted } from "../src/projection.ts";
import { canonical, sha256 } from "../src/security.ts";
import {
  collectSourcePresence,
  SOURCE_PRESENCE_COLLECTION_MS,
  SOURCE_PRESENCE_MAX_AGE_MS,
  type SourcePresenceInput,
  type SourcePresenceResult,
  type SourcePresenceScope,
  type SourcePresenceTarget,
  type SourcePresenceWitness,
} from "../src/source-presence-collector.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";

const clock = 1_000_000;
const scope: SourcePresenceScope = {
  tenant: "tenant",
  source: "source",
  accountId: "account",
  credentialVersion: "credential",
  readerPolicy: "all-clients-v1",
  policyEpoch: "epoch",
};
const credentials = {
  key: "client-key",
  secret: "synthetic-secret",
  token: "synthetic-token",
};
const operation = { uuid: "op", syncedAtMillis: 100, our: { call: "W1AW" } };
const contact = {
  uuid: "q",
  operation: "op",
  syncedAtMillis: 80,
  band: "20m",
  their: { call: "W1AW" },
};
const event = {
  uuid: "event",
  operation: "op",
  syncedAtMillis: 60,
  event: { grid: "FN31" },
};

async function target(
  kind: "operation" | "qso",
  raw: SourceRecord,
): Promise<SourcePresenceTarget> {
  const { syncedAtMillis, ...inputs } = raw;
  return {
    kind,
    id: String(raw.uuid),
    operationId:
      kind === "operation"
        ? String(raw.uuid)
        : typeof raw.operation === "string"
          ? raw.operation
          : null,
    revision: await sha256(canonical(inputs)),
    syncedAtMillis: Number(syncedAtMillis),
    deleted: isSourceDeleted(raw),
    isEvent: kind === "qso" && isEventRecord(raw),
  };
}

async function input(
  overrides: Partial<SourcePresenceInput> = {},
): Promise<SourcePresenceInput> {
  return {
    scope,
    credentials,
    targets: [
      await target("operation", operation),
      await target("qso", contact),
    ],
    selectedContacts: ["q"],
    remainingRequests: 4,
    collectionStartedAt: clock,
    collectionDeadline: clock + SOURCE_PRESENCE_COLLECTION_MS,
    ...overrides,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
function page(
  operations: SourceRecord[] = [operation],
  qsos: SourceRecord[] = [contact],
  opMeta: object = { records_left: 0 },
  qsoMeta: object = { records_left: 0 },
): Response {
  return json({
    account: { uuid: scope.accountId },
    operations,
    qsos,
    meta: { operations: opMeta, qsos: qsoMeta },
  });
}

function noAuthority(result: SourcePresenceResult) {
  assert.equal(result.requiresFinalDrain, true);
  assert.equal(result.requiresDependencyReload, true);
  assert.equal(result.targetedWindowCoverageVerified, false);
  assert.equal(result.sourceBoundaryVerified, false);
  assert.equal(result.writesAuthorized, false);
}

test("exact scoped cached positives avoid transport and never refresh their original time", async () => {
  const fixture = await input({ remainingRequests: 1 });
  const cachedWitnesses = fixture.targets.map((target) => ({
    scope,
    target,
    requestStartedAt: clock - 1000,
  }));
  let checks = 0;
  const result = await collectSourcePresence(
    { ...fixture, cachedWitnesses },
    {
      now: () => clock,
      currentScope: async () => {
        checks++;
        return scope;
      },
      fetcher: async () => {
        throw new Error("must not fetch");
      },
    },
  );
  assert.equal(result.status, "observed");
  assert.equal(checks, 2);
  assert.equal(result.actualAttempts, 0);
  assert.equal(result.remainingRequests, 1);
  assert.deepEqual(
    result.witnesses.map((w) => w.requestStartedAt),
    [clock - 1000, clock - 1000],
  );
  assert.notEqual(result.witnesses[0], cachedWitnesses[0]);
  noAuthority(result);
});

test("independent observed greater anchors bound both streams without inventing stamp plus one", async () => {
  const fixture = await input({
    observedAnchors: [
      { kind: "operation", syncedAtMillis: 150 },
      { kind: "operation", syncedAtMillis: 120 },
      { kind: "qso", syncedAtMillis: 90 },
    ],
  });
  let calls = 0;
  const result = await collectSourcePresence(fixture, {
    now: () => clock,
    currentScope: async () => scope,
    fetcher: async (url, init) => {
      calls++;
      assert.equal(url, "https://lofi.ham2k.net/v1/sync");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "manual");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        meta: {
          inboundSync: true,
          lastSyncAccountUUID: "account",
          sync: {
            operations: { syncedUntilMillis: 120, limit: 25, anyClient: true },
            qsos: { syncedUntilMillis: 90, limit: 25, anyClient: true },
          },
        },
      });
      // Unrelated older rows remain: positive collection is not range coverage.
      return page(
        [operation],
        [contact],
        { records_left: 99 },
        { records_left: 99 },
      );
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "observed");
  assert.equal(result.remainingRequests, 3);
  assert.equal(result.witnesses.length, 2);
  noAuthority(result);
});

test("fallback ceiling is the normal current time and exact duplicate dependencies are shared", async () => {
  const fixture = await input();
  fixture.targets = [
    ...fixture.targets,
    fixture.targets[0],
    await target("qso", event),
  ];
  const result = await collectSourcePresence(fixture, {
    now: () => clock,
    currentScope: async () => scope,
    fetcher: async (_url, init) => {
      const windows = JSON.parse(String(init?.body)).meta.sync;
      assert.equal(windows.operations.syncedUntilMillis, clock);
      assert.equal(windows.qsos.syncedUntilMillis, clock);
      return page([operation], [contact, event]);
    },
  });
  assert.equal(result.status, "observed");
  assert.equal(result.witnesses.length, 3);
  assert.equal(
    result.witnesses.find((w) => w.target.id === "event")?.target.isEvent,
    true,
  );
});

test("opaque tie continuation finds a missing equal-stamp member without arithmetic seeking", async () => {
  let calls = 0;
  const result = await collectSourcePresence(await input(), {
    now: () => clock,
    currentScope: async () => scope,
    fetcher: async (_url, init) => {
      calls++;
      if (calls === 1)
        return page(
          [operation],
          [{ ...contact, uuid: "neighbor" }],
          { records_left: 0 },
          { records_left: 1, next_cursor: "opaque-next" },
        );
      assert.deepEqual(JSON.parse(String(init?.body)).meta.sync.qsos, {
        syncedUntilMillis: 80,
        cursor: "opaque-next",
        limit: 25,
        anyClient: true,
      });
      return page([], [contact]);
    },
  });
  assert.equal(result.status, "observed");
  assert.equal(calls, 2);
  assert.equal(result.remainingRequests, 2);
});

test("401, same-client registration and retry consume three attempts; timestamp starts at retry", async () => {
  let time = clock;
  const routes: string[] = [];
  const result = await collectSourcePresence(await input(), {
    now: () => time,
    currentScope: async () => scope,
    fetcher: async (url, init) => {
      routes.push(String(url));
      time += 1000;
      if (routes.length === 1) return new Response(null, { status: 401 });
      if (routes.length === 2) {
        assert.equal(
          JSON.parse(String(init?.body)).client.key,
          credentials.key,
        );
        return json({ token: "new-token" });
      }
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer new-token",
      );
      return page();
    },
  });
  assert.equal(result.status, "observed");
  assert.deepEqual(routes, [
    "https://lofi.ham2k.net/v1/sync",
    "https://lofi.ham2k.net/v1/client",
    "https://lofi.ham2k.net/v1/sync",
  ]);
  assert.equal(result.actualAttempts, 3);
  assert.equal(result.remainingRequests, 1);
  assert.ok(result.witnesses.every((w) => w.requestStartedAt === clock + 2000));
  assert.equal(result.credentials.token, "new-token");
  noAuthority(result);
});

test("authentication cannot consume the reserved drain request", async () => {
  let calls = 0;
  const result = await collectSourcePresence(
    await input({ remainingRequests: 3 }),
    {
      now: () => clock,
      currentScope: async () => scope,
      fetcher: async () =>
        ++calls === 1
          ? new Response(null, { status: 401 })
          : json({ token: "renewed" }),
    },
  );
  assert.equal(result.reason, "request_budget");
  assert.equal(calls, 2);
  assert.equal(result.remainingRequests, 1);
  assert.equal(result.witnesses.length, 0);
});

test("unbounded history does not exceed three actual reads or consume final drain allowance", async () => {
  let calls = 0;
  const result = await collectSourcePresence(await input(), {
    now: () => clock,
    currentScope: async () => scope,
    fetcher: async () => {
      calls++;
      return page(
        [operation],
        [
          {
            ...contact,
            uuid: `neighbor-${calls}`,
            syncedAtMillis: 100 - calls,
          },
        ],
        { records_left: 0 },
        { records_left: 100, next_cursor: `cursor-${calls}` },
      );
    },
  });
  assert.equal(result.reason, "request_budget");
  assert.equal(calls, 3);
  assert.equal(result.remainingRequests, 1);
  noAuthority(result);
});

test("budget-admission deferrals consume no transport attempts and preserve immutable collection clock", async () => {
  const fixture = await input();
  for (const time of [clock, clock + 10_000]) {
    const result = await collectSourcePresence(fixture, {
      now: () => time,
      currentScope: async () => scope,
      fetcher: async () => {
        throw new VendorDeferredError(clock + 60_000, false);
      },
    });
    assert.equal(result.reason, "vendor_deferred");
    assert.equal(result.actualAttempts, 0);
    assert.equal(result.remainingRequests, 4);
    assert.equal(result.retryAt, clock + 60_000);
    assert.equal(result.collectionDeadline, fixture.collectionDeadline);
    assert.equal(result.collectionStartedAt, clock);
  }
  const sent = await collectSourcePresence(fixture, {
    now: () => clock,
    currentScope: async () => scope,
    fetcher: async () => {
      throw new VendorDeferredError(clock + 60_000, true);
    },
  });
  assert.equal(sent.actualAttempts, 1);
  assert.equal(sent.remainingRequests, 3);
});

test("cache scope, revision, member flags, future time and exact expiry must all match", async () => {
  const fixture = await input();
  const original: SourcePresenceWitness = {
    scope,
    target: fixture.targets[1],
    requestStartedAt: clock - 1000,
  };
  const invalid: SourcePresenceWitness[] = [
    { ...original, scope: { ...scope, tenant: "other" } },
    { ...original, scope: { ...scope, policyEpoch: "old" } },
    { ...original, scope: { ...scope, credentialVersion: "old" } },
    { ...original, target: { ...original.target, revision: "x".repeat(43) } },
    { ...original, target: { ...original.target, syncedAtMillis: 79 } },
    { ...original, target: { ...original.target, operationId: "other" } },
    { ...original, target: { ...original.target, isEvent: true } },
    { ...original, target: { ...original.target, deleted: true } },
    { ...original, requestStartedAt: clock + 1 },
    { ...original, requestStartedAt: clock - SOURCE_PRESENCE_MAX_AGE_MS },
  ];
  for (const bad of invalid) {
    let calls = 0;
    const result = await collectSourcePresence(
      { ...fixture, cachedWitnesses: [bad] },
      {
        now: () => clock,
        currentScope: async () => scope,
        fetcher: async () => {
          calls++;
          return page();
        },
      },
    );
    assert.equal(result.status, "observed");
    assert.equal(calls, 1);
    assert.equal(
      result.witnesses.find((w) => w.target.id === "q")?.requestStartedAt,
      clock,
    );
  }
});

test("logical account, policy and credential changes invalidate even collected positives", async () => {
  for (const field of [
    "tenant",
    "source",
    "accountId",
    "credentialVersion",
    "policyEpoch",
  ] as const) {
    let read = false;
    const result = await collectSourcePresence(await input(), {
      now: () => clock,
      currentScope: async () =>
        read ? { ...scope, [field]: "changed" } : scope,
      fetcher: async () => {
        read = true;
        return page();
      },
    });
    assert.equal(result.reason, "scope_changed");
    assert.equal(result.actualAttempts, 1);
    assert.equal(result.witnesses.length, 0);
  }
});

test("deadline covers transport, parsed body and local scope checks; resume cannot renew it", async () => {
  const fixture = await input({ collectionDeadline: clock + 1000 });
  let time = clock;
  const late = await collectSourcePresence(fixture, {
    now: () => time,
    currentScope: async () => scope,
    fetcher: async () => {
      time = clock + 1000;
      return page();
    },
  });
  assert.equal(late.reason, "deadline");
  assert.equal(late.witnesses.length, 0);
  let calls = 0;
  const resumed = await collectSourcePresence(fixture, {
    now: () => clock + 1000,
    currentScope: async () => scope,
    fetcher: async () => {
      calls++;
      return page();
    },
  });
  assert.equal(resumed.reason, "deadline");
  assert.equal(calls, 0);
  assert.equal(resumed.collectionDeadline, clock + 1000);
});

test("fresh cache expiring during collection stays held without local freshness extension", async () => {
  const fixture = await input();
  fixture.cachedWitnesses = [
    {
      scope,
      target: fixture.targets[0],
      requestStartedAt: clock - SOURCE_PRESENCE_MAX_AGE_MS + 1,
    },
  ];
  let time = clock;
  const result = await collectSourcePresence(fixture, {
    now: () => time,
    currentScope: async () => scope,
    fetcher: async () => {
      time += 2;
      return page([], [contact]);
    },
  });
  assert.equal(result.reason, "witness_expired");
  assert.equal(
    result.witnesses[0].requestStartedAt,
    clock - SOURCE_PRESENCE_MAX_AGE_MS + 1,
  );
});

test("missing, hard-purged, moved and changed required records cannot become observations", async () => {
  const variants: [Response, string][] = [
    [page([operation], []), "missing_target"],
    [page([operation], [{ ...contact, purged: true }]), "changed_target"],
    [page([operation], [{ ...contact, deleted: true }]), "changed_target"],
    [
      page([operation], [{ ...contact, operation: "elsewhere" }]),
      "changed_target",
    ],
    [page([operation], [{ ...contact, band: "event" }]), "changed_target"],
    [page([operation], [{ ...contact, syncedAtMillis: 81 }]), "changed_target"],
    [
      page([operation], [{ ...contact, our: { grid: "FN32" } }]),
      "changed_target",
    ],
  ];
  for (const [response, reason] of variants) {
    const result = await collectSourcePresence(await input(), {
      now: () => clock,
      currentScope: async () => scope,
      fetcher: async () => response,
    });
    assert.equal(result.reason, reason);
    assert.equal(result.status, "held");
    noAuthority(result);
  }
});

test("unknown live events in selected operations force dependency reload; unrelated neighbors are harmless", async () => {
  for (const [row, expected] of [
    [event, "held"],
    [{ ...event, operation: "unrelated" }, "observed"],
    [{ ...event, deleted: true }, "observed"],
    [{ ...contact, uuid: "unrelated", syncedAtMillis: 60 }, "observed"],
  ] as const) {
    const result = await collectSourcePresence(await input(), {
      now: () => clock,
      currentScope: async () => scope,
      fetcher: async () => page([operation], [contact, row]),
    });
    assert.equal(result.status, expected);
    if (expected === "held") assert.equal(result.reason, "dependency_changed");
    noAuthority(result);
  }
});

test("empty partial, tied without cursor, oversized and non-descending pages remain held", async () => {
  const cases: [Response, string][] = [
    [
      page([operation], [], { records_left: 0 }, { records_left: 1 }),
      "partial_page",
    ],
    [
      page(
        [operation],
        [{ ...contact, uuid: "neighbor" }],
        { records_left: 0 },
        { records_left: 1 },
      ),
      "partial_page",
    ],
    [
      page(
        [operation],
        Array.from({ length: 26 }, (_, i) => ({ ...contact, uuid: `n${i}` })),
      ),
      "page_bound",
    ],
    [
      page(
        [operation],
        [{ ...contact, uuid: "neighbor", syncedAtMillis: 70 }, contact],
      ),
      "invalid_page",
    ],
    [
      page(
        [operation],
        [{ ...contact, uuid: "older", syncedAtMillis: 70 }],
        { records_left: 0 },
        { records_left: 1, next_cursor: "next" },
      ),
      "missing_target",
    ],
  ];
  for (const [response, reason] of cases) {
    const result = await collectSourcePresence(await input(), {
      now: () => clock,
      currentScope: async () => scope,
      fetcher: async () => response,
    });
    assert.equal(result.status, "held");
    assert.equal(result.reason, reason);
  }
});

test("conflicting same-page duplicate cannot preserve the earlier matching witness", async () => {
  const result = await collectSourcePresence(await input(), {
    now: () => clock,
    currentScope: async () => scope,
    fetcher: async () =>
      page([operation], [contact, { ...contact, band: "40m" }]),
  });
  assert.equal(result.reason, "changed_target");
  assert.equal(
    result.witnesses.some((w) => w.target.id === "q"),
    false,
  );
});

test("a rejected later stream publishes no witnesses that a cache-only resume could accept", async () => {
  const fixture = await input();
  const rejected = await collectSourcePresence(fixture, {
    now: () => clock,
    currentScope: async () => scope,
    fetcher: async () =>
      page(
        [operation],
        [
          contact,
          { ...contact, uuid: "newer-after-older", syncedAtMillis: 90 },
        ],
      ),
  });
  assert.equal(rejected.reason, "invalid_page");
  assert.deepEqual(rejected.witnesses, []);
  const resumed = await collectSourcePresence(
    {
      ...fixture,
      cachedWitnesses: rejected.witnesses,
      remainingRequests: 1,
    },
    {
      now: () => clock,
      currentScope: async () => scope,
      fetcher: async () => {
        throw new Error("reserved request must remain unused");
      },
    },
  );
  assert.equal(resumed.reason, "request_budget");
  assert.equal(resumed.status, "held");
});

test("previously accepted page positives survive a later transport failure with their original timestamp", async () => {
  let calls = 0;
  const result = await collectSourcePresence(await input(), {
    now: () => clock,
    currentScope: async () => scope,
    fetcher: async () => {
      calls++;
      if (calls > 1) throw new Error("later read failed");
      return page(
        [operation],
        [{ ...contact, uuid: "neighbor", syncedAtMillis: 90 }],
        { records_left: 0 },
        { records_left: 1, next_cursor: "next" },
      );
    },
  });
  assert.equal(result.reason, "read_failed");
  assert.equal(result.witnesses.length, 1);
  assert.equal(result.witnesses[0].target.id, "op");
  assert.equal(result.witnesses[0].requestStartedAt, clock);
});

test("older missing dependencies seek independently below an actual nearer observed anchor", async () => {
  const olderEvent = { ...event, syncedAtMillis: 20 };
  const fixture = await input({
    observedAnchors: [
      { kind: "qso", syncedAtMillis: 90 },
      { kind: "qso", syncedAtMillis: 30 },
    ],
  });
  fixture.targets = [...fixture.targets, await target("qso", olderEvent)];
  let calls = 0;
  const result = await collectSourcePresence(fixture, {
    now: () => clock,
    currentScope: async () => scope,
    fetcher: async (_url, init) => {
      calls++;
      const window = JSON.parse(String(init?.body)).meta.sync.qsos;
      if (calls === 1) {
        assert.equal(window.syncedUntilMillis, 90);
        return page(
          [operation],
          [contact],
          { records_left: 0 },
          { records_left: 100, next_cursor: "unrelated-old-history" },
        );
      }
      assert.equal(window.syncedUntilMillis, 30);
      assert.equal(window.cursor, undefined);
      return page([], [olderEvent]);
    },
  });
  assert.equal(result.status, "observed");
  assert.equal(calls, 2);
  assert.equal(result.witnesses.length, 3);
});

test("a clock moving backwards during a read cannot produce a future-dated positive witness", async () => {
  let time = clock + 100;
  const result = await collectSourcePresence(await input(), {
    now: () => time,
    currentScope: async () => scope,
    fetcher: async () => {
      time = clock + 99;
      return page();
    },
  });
  assert.equal(result.reason, "deadline");
  assert.deepEqual(result.witnesses, []);
});

test("input bounds and impossible seek windows fail without a transport call", async () => {
  const fixture = await input();
  const cases: Partial<SourcePresenceInput>[] = [
    { targets: Array.from({ length: 65 }, () => fixture.targets[0]) },
    { selectedContacts: Array.from({ length: 21 }, () => "q") },
    {
      targets: [
        ...fixture.targets,
        { ...fixture.targets[0], syncedAtMillis: 99 },
      ],
    },
    { remainingRequests: 5 },
    { collectionDeadline: clock + SOURCE_PRESENCE_COLLECTION_MS + 1 },
    {
      targets: [
        { ...fixture.targets[0], syncedAtMillis: clock },
        fixture.targets[1],
      ],
    },
  ];
  for (const overrides of cases) {
    let calls = 0;
    const result = await collectSourcePresence(
      { ...fixture, ...overrides },
      {
        now: () => clock,
        currentScope: async () => scope,
        fetcher: async () => {
          calls++;
          return page();
        },
      },
    );
    assert.equal(result.status, "held");
    assert.equal(calls, 0);
  }
});

test("hostile transport error details never enter fixed outcome diagnostics", async () => {
  const secret = "https://private.example/?token=do-not-report";
  const result = await collectSourcePresence(await input(), {
    now: () => clock,
    currentScope: async () => scope,
    fetcher: async () => {
      throw new Error(secret);
    },
  });
  assert.equal(result.reason, "read_failed");
  assert.equal(result.actualAttempts, 1);
  assert.equal(JSON.stringify(result).includes(secret), false);
  noAuthority(result);
});
