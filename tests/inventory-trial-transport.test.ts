import assert from "node:assert/strict";
import { test } from "node:test";
import { createInventoryTrialTransport } from "../scripts/inventory-trial-transport.ts";
import { LoFiClient } from "../src/lofi.ts";

const LOFI = "https://lofi.ham2k.net";
const QRZ = "https://logbook.qrz.com/api";
const LOTW =
  "https://lotw.arrl.org/lotwuser/lotwreport.adi?login=fixture&password=fixture&qso_query=1&qso_qsl=no";
function packet(): Record<string, unknown> {
  return {
    meta: {
      inboundSync: true,
      lastSyncAccountUUID: "fixture-account",
      sync: {
        operations: { syncedSinceMillis: 0, limit: 1000, anyClient: true },
        qsos: {
          syncedUntilMillis: 123,
          cursor: "opaque",
          limit: 1000,
          anyClient: true,
        },
      },
    },
  };
}
function sync(value: unknown = packet()): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
    redirect: "follow",
  };
}

test("trial transport admits only the four read shapes and counts consumed UTF-8 bytes", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const trial = createInventoryTrialTransport(
    async (input, init) => {
      calls.push({ url: String(input), init });
      assert.equal(init?.redirect, "error");
      return new Response("☃", { headers: { "X-Fixture": "retained" } });
    },
    { minLoFiIntervalMs: 0 },
  );
  for (const [url, init] of [
    [`${LOFI}/v1/accounts`, undefined],
    [`${LOFI}/v1/sync`, sync()],
    [QRZ, { method: "POST", body: new URLSearchParams({ ACTION: "STATUS" }) }],
    [QRZ, { method: "POST", body: new URLSearchParams({ ACTION: "FETCH" }) }],
    [LOTW, undefined],
  ] as const) {
    const response = await trial.fetch(url, init);
    assert.equal(response.headers.get("X-Fixture"), "retained");
    assert.equal(await response.text(), "☃");
  }
  assert.deepEqual(trial.metrics, {
    requests: 5,
    byProvider: { lofi: 2, qrz: 2, lotw: 1 },
    responseBytes: 15,
  });
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), packet());
});

test("trial transport blocks mutations, alternate endpoints, URL credentials and unsafe query shapes before network", async () => {
  let calls = 0;
  const trial = createInventoryTrialTransport(
    async () => {
      calls++;
      return new Response("fixture");
    },
    { minLoFiIntervalMs: 0 },
  );
  for (const [url, init] of [
    [`${LOFI}/v1/client`, { method: "POST" }],
    [`${LOFI}/v1/client/permissions`, { method: "POST" }],
    [`${LOFI}/v1/operations/fixture/qsos`, undefined],
    [`${LOFI}/v1/accounts?token=private`, undefined],
    ["https://user:private@lofi.ham2k.net/v1/accounts", undefined],
    [`${LOFI}/v1/accounts#fragment`, undefined],
    [`${LOFI}/v1/accounts`, { method: "DELETE" }],
    [`${LOFI}/v1/sync`, { ...sync(), method: "GET" }],
    ["https://example.invalid/v1/accounts", undefined],
    [QRZ, { method: "POST", body: new URLSearchParams({ ACTION: "INSERT" }) }],
    [QRZ, { method: "POST", body: new URLSearchParams({ ACTION: "DELETE" }) }],
    [
      QRZ,
      {
        method: "POST",
        body: new URLSearchParams([
          ["ACTION", "FETCH"],
          ["ACTION", "INSERT"],
        ]),
      },
    ],
    [
      QRZ,
      {
        method: "POST",
        body: new URLSearchParams({ ACTION: "FETCH", ADIF: "mutation" }),
      },
    ],
    [`${QRZ}?KEY=private`, { method: "POST", body: "ACTION=FETCH" }],
    ["https://lotw.arrl.org/lotw/upload", { method: "POST" }],
    [LOTW.replace("qso_qsl=no", "qso_qsl=yes"), undefined],
    [`${LOTW}&qso_qsl=yes`, undefined],
    [`${LOTW}&ACTION=UPLOAD`, undefined],
    [LOTW, { method: "POST", body: "mutation" }],
  ] as const)
    await assert.rejects(trial.fetch(url, init));
  assert.equal(calls, 0);
  assert.equal(trial.metrics.requests, 0);
});

test("metadata-only LoFi JSON rejects every mutation field and invalid read window", async () => {
  let calls = 0;
  const trial = createInventoryTrialTransport(
    async () => {
      calls++;
      return new Response("fixture");
    },
    { minLoFiIntervalMs: 0 },
  );
  const invalid: unknown[] = [
    null,
    [],
    { ...packet(), qsos: [] },
    { meta: { ...(packet().meta as Record<string, unknown>), operations: [] } },
  ];
  for (const mutation of [
    (value: Record<string, unknown>) => {
      (value.meta as Record<string, unknown>).inboundSync = false;
    },
    (value: Record<string, unknown>) => {
      const meta = value.meta as Record<string, unknown>;
      (meta.sync as Record<string, unknown>).claims = {};
    },
    ...[
      { anyClient: false },
      { limit: 1001 },
      { limit: 0 },
      { limit: 1.5 },
      { syncedSinceMillis: -1 },
      { syncedSinceMillis: "0" },
      { syncedUntilMillis: 1 },
      { cursor: [] },
      { qsos: [] },
    ].map((fields) => (value: Record<string, unknown>) => {
      const meta = value.meta as { sync: { operations: object } };
      Object.assign(meta.sync.operations, fields);
    }),
  ]) {
    const value = packet();
    mutation(value);
    invalid.push(value);
  }
  for (const value of invalid)
    await assert.rejects(trial.fetch(`${LOFI}/v1/sync`, sync(value)));
  await assert.rejects(
    trial.fetch(`${LOFI}/v1/sync`, { ...sync(), body: "invalid-json" }),
  );
  await assert.rejects(
    trial.fetch(`${LOFI}/v1/sync`, {
      ...sync(),
      headers: { "Content-Type": "text/plain" },
    }),
  );
  assert.equal(calls, 0);
});

test("global request cap includes concurrent providers and transport failures", async () => {
  let calls = 0;
  const trial = createInventoryTrialTransport(
    async () => {
      calls++;
      throw new Error("private=https://private.invalid?password=secret");
    },
    { maxRequests: 2, minLoFiIntervalMs: 0 },
  );
  const result = await Promise.allSettled([
    trial.fetch(`${LOFI}/v1/accounts`),
    trial.fetch(LOTW),
    trial.fetch(QRZ, {
      method: "POST",
      body: new URLSearchParams({ ACTION: "FETCH" }),
    }),
  ]);
  assert.equal(calls, 2);
  assert.ok(result.every((value) => value.status === "rejected"));
  assert.ok(!JSON.stringify(result).includes("private.invalid"));
  trial.metrics.requests = 0;
  await assert.rejects(
    trial.fetch(LOTW),
    /inventory_trial_request_budget_exhausted/,
  );
  assert.equal(calls, 2);
});

test("returned redirect responses are rejected without following them", async () => {
  const trial = createInventoryTrialTransport(async (_input, init) => {
    assert.equal(init?.redirect, "error");
    return new Response(null, {
      status: 302,
      headers: { Location: "https://private.invalid/mutation" },
    });
  });
  await assert.rejects(
    trial.fetch(`${LOFI}/v1/accounts`),
    /inventory_trial_redirect_blocked/,
  );
  assert.equal(trial.metrics.requests, 1);
});

test("a LoFi 401 cannot register or renew an identity", async () => {
  const requests: string[] = [];
  const trial = createInventoryTrialTransport(async (input) => {
    requests.push(String(input));
    return new Response(null, { status: 401 });
  });
  const client = new LoFiClient(
    { key: "fixture", secret: "fixture", token: "fixture" },
    trial.fetch,
  );
  await assert.rejects(client.accounts());
  assert.deepEqual(requests, [`${LOFI}/v1/accounts`]);
  assert.equal(trial.metrics.requests, 1);
});

test("Request JSON is snapshotted and canonicalized before network", async () => {
  const trial = createInventoryTrialTransport(async (_input, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), packet());
    return new Response(null, { status: 204 });
  });
  const response = await trial.fetch(new Request(`${LOFI}/v1/sync`, sync()));
  assert.equal(response.status, 204);
  assert.equal(trial.metrics.responseBytes, 0);
});

test("LoFi pacing has a five-second floor and larger hints cannot be lowered", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  try {
    let calls = 0;
    const trial = createInventoryTrialTransport(
      async () => {
        calls++;
        return new Response(null, { status: 204 });
      },
      { minLoFiIntervalMs: 1 },
    );
    await trial.fetch(`${LOFI}/v1/accounts`);
    const second = trial.fetch(`${LOFI}/v1/accounts`);
    await Promise.resolve();
    t.mock.timers.tick(4_999);
    await Promise.resolve();
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    await second;
    assert.equal(calls, 2);
    trial.setLoFiDelay(8_000);
    trial.setLoFiDelay(1);
    const third = trial.fetch(`${LOFI}/v1/accounts`);
    await Promise.resolve();
    assert.equal(calls, 2);
    t.mock.timers.tick(7_999);
    await Promise.resolve();
    assert.equal(calls, 2);
    t.mock.timers.tick(1);
    await third;
    assert.equal(calls, 3);
  } finally {
    t.mock.timers.reset();
  }
});

test("a caller timeout during LoFi spacing aborts before another network request", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  try {
    let calls = 0;
    const trial = createInventoryTrialTransport(async () => {
      calls++;
      return new Response(null, { status: 204 });
    });
    await trial.fetch(`${LOFI}/v1/accounts`);
    const controller = new AbortController();
    const second = trial.fetch(`${LOFI}/v1/accounts`, {
      signal: controller.signal,
    });
    await Promise.resolve();
    setTimeout(() => controller.abort(), 15_000);
    t.mock.timers.tick(15_000);
    await assert.rejects(second, /inventory_trial_request_aborted/);
    assert.equal(calls, 1);
    assert.equal(trial.metrics.requests, 1);
  } finally {
    t.mock.timers.reset();
  }
});
