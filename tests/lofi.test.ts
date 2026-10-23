import assert from "node:assert/strict";
import test from "node:test";
import { LoFiClient, LoFiError, type SyncState } from "../src/lofi.ts";

const initial: SyncState = {
  mode: "backfill",
  accountId: "account-1",
  operations: {},
  qsos: {},
};
const credentials = {
  key: "browser:synthetic",
  secret: "synthetic-secret",
  token: "synthetic-token",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const reply = (
  operations: unknown[],
  qsos: unknown[],
  opMeta: object,
  qsoMeta: object,
) => ({
  account: { uuid: "account-1" },
  operations,
  qsos,
  meta: { operations: opMeta, qsos: qsoMeta },
});
const fake = (
  handler: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch => handler;

test("LoFi pulls without mutations and resumes separate opaque cursors after restart", async () => {
  const requests: Record<string, unknown>[] = [];
  const fetcher = fake(async (input, init) => {
    assert.equal(String(input), "https://lofi.ham2k.net/v1/sync");
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    assert.deepEqual(Object.keys(body), ["meta"]);
    assert.equal(body.meta.inboundSync, true);
    if (requests.length === 1)
      return json(
        reply(
          [{ uuid: "op-1", syncedAtMillis: 900 }],
          [{ uuid: "qso-1", operation: null, syncedAtMillis: 800 }],
          { records_left: 1, next_cursor: "opaque-operation" },
          { records_left: 1, next_cursor: "opaque-qso" },
        ),
      );
    assert.equal(body.meta.sync.operations.cursor, "opaque-operation");
    assert.equal(body.meta.sync.qsos.cursor, "opaque-qso");
    return json(
      reply(
        [{ uuid: "op-2", syncedAtMillis: 899 }],
        [{ uuid: "qso-2", deleted: "1", syncedAtMillis: 800 }],
        { recordsLeft: 0, nextCursor: "operation-final" },
        { recordsLeft: 0, nextCursor: "qso-final" },
      ),
    );
  });
  const first = await new LoFiClient(credentials, fetcher).syncPage(
    initial,
    1000,
  );
  assert.equal(first.complete, false);
  assert.deepEqual(
    initial.operations,
    {},
    "caller checkpoint is immutable until committed",
  );
  const restored = JSON.parse(JSON.stringify(first.next)) as SyncState;
  const second = await new LoFiClient(credentials, fetcher).syncPage(
    restored,
    1100,
  );
  assert.equal(second.complete, true);
  assert.equal(second.next.mode, "forward");
  assert.equal(second.next.operations.watermark, 900);
  assert.equal(second.next.qsos.watermark, 800);
  assert.equal(second.coverage, "client-contract-only");
  assert.equal(second.qsos[0].deleted, "1");
});

test("empty page with records left does not declare completion or erase cursor", async () => {
  const state: SyncState = {
    ...initial,
    qsos: { cursor: "qso-cursor", watermark: 500 },
  };
  const client = new LoFiClient(
    credentials,
    fake(async () =>
      json(reply([], [], { records_left: 0 }, { records_left: 2 })),
    ),
  );
  const page = await client.syncPage(state, 1000);
  assert.equal(page.complete, false);
  assert.equal(page.next.qsos.cursor, "qso-cursor");
  assert.equal(page.next.qsos.watermark, 500);
});

test("sync exposes only the verified account's confirmed email and distinguishes omitted metadata", async () => {
  for (const [account, expected] of [
    [
      {
        uuid: "account-1",
        name: "iPad",
        email: " owner@example.test ",
        pending_email: "pending@example.test",
      },
      "owner@example.test",
    ],
    [{ uuid: "account-1", name: "iPad" }, undefined],
    [{ uuid: "account-1", email: null }, null],
    [{ uuid: "account-1", email: "iPad" }, null],
    [{ uuid: "account-1", pending_email: "pending@example.test" }, undefined],
  ] as const) {
    const client = new LoFiClient(
      credentials,
      fake(async () =>
        json({
          ...reply([], [], { records_left: 0 }, { records_left: 0 }),
          account,
        }),
      ),
    );
    assert.equal((await client.syncPage(initial, 1000)).accountEmail, expected);
    assert.equal(
      (await client.syncPage({ ...initial, accountId: undefined }, 1000))
        .accountEmail,
      undefined,
      "unverified account metadata cannot change the display identity",
    );
  }
});

test("repeated cursor, missing count, missing server timestamp and cursor refusal block checkpoint", async () => {
  for (const [code, response] of [
    [
      "repeated_cursor",
      reply(
        [],
        [{ uuid: "q", syncedAtMillis: 500 }],
        { records_left: 0 },
        { records_left: 1, next_cursor: "same" },
      ),
    ],
    ["missing_coverage_count", reply([], [], { records_left: 0 }, {})],
    [
      "missing_server_watermark",
      reply(
        [],
        [{ uuid: "q", updatedAtMillis: 500 }],
        { records_left: 0 },
        { records_left: 0 },
      ),
    ],
    [
      "cursor_or_record_reconciliation_required",
      {
        ...reply([], [], { records_left: 0 }, { records_left: 0 }),
        errors: { qsos: { pagination: { cursor: "invalid" } } },
      },
    ],
  ] as const) {
    const client = new LoFiClient(
      credentials,
      fake(async () => json(response)),
    );
    await assert.rejects(
      client.syncPage({ ...initial, qsos: { cursor: "same" } }, 1000),
      (error: unknown) => error instanceof LoFiError && error.code === code,
    );
  }
});

test("forward cursor fallback overlaps its last millisecond rather than skipping tied rows", async () => {
  const state: SyncState = {
    mode: "forward",
    accountId: "account-1",
    operations: {},
    qsos: { cursor: "old", watermark: 99 },
  };
  const client = new LoFiClient(
    credentials,
    fake(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.meta.sync.qsos.anyClient, false);
      return json(
        reply(
          [],
          [{ uuid: "q", syncedAtMillis: 200 }],
          { records_left: 0 },
          { records_left: 1, next_cursor: "new" },
        ),
      );
    }),
  );
  const page = await client.syncPage(state, 1000);
  assert.equal(page.next.qsos.watermark, 199);
  assert.equal(page.next.qsos.cursor, "new");
});

test("401 renews the original device identity once and never sends a bearer to redirects", async () => {
  const calls: string[] = [];
  const client = new LoFiClient(
    credentials,
    fake(async (input, init) => {
      calls.push(String(input));
      assert.equal(init?.redirect, "manual");
      if (calls.length === 1) return json({}, 401);
      if (String(input).endsWith("/client")) {
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body, {
          client: {
            name: "LoFi QSO Ferry",
            type: "browser",
            key: credentials.key,
            secret: credentials.secret,
          },
        });
        return json({ token: "renewed" });
      }
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer renewed",
      );
      return json({ current_account: { uuid: "account-1", call: "N0CALL" } });
    }),
  );
  assert.equal((await client.accounts()).uuid, "account-1");
  assert.equal(client.credentialsSnapshot().token, "renewed");
  assert.equal(calls.length, 3);
});

test("approval is the actual LoFi email permission flow, not account authentication", async () => {
  const client = new LoFiClient(
    credentials,
    fake(async (input, init) => {
      assert.equal(
        String(input),
        "https://lofi.ham2k.net/v1/client/permissions",
      );
      assert.deepEqual(JSON.parse(String(init?.body)), {
        email: "person@example.test",
        send_email: true,
      });
      return json({ success: true });
    }),
  );
  await client.requestApproval(" person@example.test ");
});

test("HTML, huge responses, changed accounts and vendor errors never establish coverage", async () => {
  for (const response of [
    new Response("<html>login required</html>"),
    new Response(" ".repeat(2 * 1024 * 1024 + 1)),
    json({ error: "synthetic rejection" }),
    json({
      ...reply([], [], { records_left: 0 }, { records_left: 0 }),
      account: { uuid: "other-account" },
    }),
  ]) {
    const client = new LoFiClient(
      credentials,
      fake(async () => response),
    );
    await assert.rejects(client.syncPage(initial, 1000), LoFiError);
  }
});

test("operation rereads retain since and resume bounded descending pages including events/tombstones", async () => {
  const requests: URL[] = [];
  const client = new LoFiClient(
    credentials,
    fake(async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      assert.equal(url.pathname, "/v1/operations/op-1/qsos");
      assert.equal(url.searchParams.get("syncedSinceMillis"), "100");
      if (requests.length === 1)
        return json({
          qsos: [{ uuid: "event-1", band: "event", syncedAtMillis: 900 }],
          meta: { qsos: { records_left: 2, next_synced_until_millis: 900 } },
        });
      assert.equal(url.searchParams.get("syncedUntilMillis"), "900");
      return json({
        qsos: [
          { uuid: "qso-1", operation: "op-1", deleted: 1, syncedAtMillis: 899 },
        ],
        meta: { qsos: { records_left: 0 } },
      });
    }),
  );
  const first = await client.operationQsosPage("op-1", { since: 100 });
  assert.equal(first.complete, false);
  assert.equal(first.qsos[0].operation, "op-1");
  const resumed = await client.operationQsosPage(
    "op-1",
    JSON.parse(JSON.stringify(first.next)),
  );
  assert.equal(resumed.complete, true);
  assert.equal(resumed.qsos[0].deleted, 1);
});

test("operation rereads cannot infer empty history, skip a stalled tie, or select another operation", async () => {
  for (const response of [
    { qsos: [], meta: { qsos: {} } },
    {
      qsos: [{ uuid: "q", syncedAtMillis: 100 }],
      meta: { qsos: { records_left: 1, next_synced_until_millis: 100 } },
    },
    {
      qsos: [{ uuid: "q", operation: "another", syncedAtMillis: 100 }],
      meta: { qsos: { records_left: 0 } },
    },
  ]) {
    const client = new LoFiClient(
      credentials,
      fake(async () => json(response)),
    );
    await assert.rejects(
      client.operationQsosPage("op-1", { cursor: 100 }),
      LoFiError,
    );
  }
  const client = new LoFiClient(
    credentials,
    fake(async () => json({ qsos: [], meta: { qsos: { records_left: 2 } } })),
  );
  const empty = await client.operationQsosPage("op-1", { cursor: 100 });
  assert.equal(empty.complete, false);
  assert.equal(empty.next.cursor, 100);
  await assert.rejects(client.operationQsosPage("../accounts"), LoFiError);
});

test("an empty forward tail preserves its server watermark instead of replaying from zero", async () => {
  const state: SyncState = {
    mode: "forward",
    accountId: "account-1",
    operations: { watermark: 200 },
    qsos: { watermark: 300 },
  };
  const client = new LoFiClient(
    credentials,
    fake(async () =>
      json(reply([], [], { records_left: 0 }, { records_left: 0 })),
    ),
  );
  const page = await client.syncPage(state, 1000);
  assert.equal(page.next.operations.watermark, 200);
  assert.equal(page.next.qsos.watermark, 300);
});
