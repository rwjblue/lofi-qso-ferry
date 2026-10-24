import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { pollSource } from "../src/intake.ts";
import type { SourceRecord, SyncState } from "../src/lofi.ts";
import { sourceReadPolicy } from "../src/source-read-policy.ts";
import { Store } from "../src/store.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";
import { applyMigration, database, seed } from "./helpers.ts";

const row = (uuid: string, syncedAtMillis = 1000): SourceRecord => ({
  uuid,
  syncedAtMillis,
  operation: null,
  notes: "synthetic",
});
const response = (
  operations: SourceRecord[] = [],
  qsos: SourceRecord[] = [],
  next?: string,
) =>
  new Response(
    JSON.stringify({
      account: { uuid: "source" },
      operations,
      qsos,
      meta: {
        operations: {
          records_left: next ? 1 : 0,
          ...(next ? { next_cursor: `op-${next}` } : {}),
        },
        qsos: {
          records_left: next ? 1 : 0,
          ...(next ? { next_cursor: `qso-${next}` } : {}),
        },
      },
    }),
  );
type Window = {
  limit: number;
  cursor?: string;
  anyClient: boolean;
  syncedUntilMillis?: number;
};
type Windows = { operations: Window; qsos: Window };

async function fixture(t: TestContext) {
  const h = await database();
  t.after(() => h.mf.dispose());
  for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((name) => /^\d{4}_.*\.sql$/.test(name) && !name.startsWith("0001_"))
    .sort())
    await applyMigration(h.db, name);
  await seed(h.store);
  await h.store
    .statement(
      "UPDATE connections SET config=?,credential_version='v2' WHERE tenant='a' AND id='source'",
      JSON.stringify({ accountId: "source" }),
    )
    .run();
  await (
    await h.store.putPrivate("a", "source", "v2", "credential", {
      key: "browser:synthetic",
      secret: "synthetic-secret",
      token: "synthetic-token",
    })
  ).run();
  const source = (await h.store.connection("a", "source"))!;
  const now = Date.now();
  let turn = 0;
  const requests: Windows[] = [];
  const batches: { statements: number; elapsed: number }[] = [];
  const store = new Store(
    new Proxy(h.db, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const start = Date.now();
            try {
              return await target.batch(statements);
            } finally {
              batches.push({
                statements: statements.length,
                elapsed: Date.now() - start,
              });
            }
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    h.store.keys,
  );
  const run = (
    handler: (windows: Windows) => Promise<Response> | Response,
    options: { stream?: string; vendorNow?: number; store?: Store } = {},
  ) =>
    pollSource(
      options.store ?? store,
      source,
      async (input, init) => {
        assert.equal(String(input), "https://lofi.ham2k.net/v1/sync");
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(Object.keys(body), ["meta"]);
        const windows = body.meta.sync as Windows;
        requests.push(windows);
        return handler(windows);
      },
      now + ++turn * 1000,
      options.stream ?? "sync",
      options.vendorNow ?? now + turn * 300_000,
    );
  const cursor = () =>
    h.store
      .statement(
        "SELECT cursor,generation FROM cursors WHERE tenant='a' AND connection='source' AND stream='sync'",
      )
      .first<{ cursor: string; generation: number }>();
  const count = () =>
    h.store
      .statement(
        "SELECT count(*) AS n FROM source_work WHERE tenant='a' AND source='source'",
      )
      .first<number>("n");
  await run(() => response([], [], "initial"));
  requests.length = 0;
  batches.length = 0;
  return { ...h, store, source, now, run, cursor, count, requests, batches };
}

test("baseline100 checkpoints a full bounded page atomically and retains historical handoff", async (t) => {
  const h = await fixture(t);
  const operations = Array.from({ length: 100 }, (_, index) =>
    row(`op-${index}`),
  );
  const qsos = Array.from({ length: 100 }, (_, index) => ({
    ...row(`event-${index}`),
    operation: `op-${index}`,
    event: { grid: "FN31AA" },
  }));
  const first = await h.run((windows) => {
    assert.equal(windows.operations.limit, 100);
    assert.equal(windows.qsos.limit, 100);
    assert.equal(windows.operations.anyClient, true);
    assert.equal(windows.qsos.anyClient, true);
    return response(operations, qsos, "full");
  });
  assert.equal(first.records, 200);
  assert.equal(first.complete, false);
  assert.equal(await h.count(), 200);
  assert.equal(
    h.batches.length,
    1,
    "all row, membership and cursor writes share one checkpoint",
  );
  assert.equal(h.batches[0].statements, 1708);
  t.diagnostic(
    `baseline100: ${h.batches[0].statements} statements, ${h.batches[0].elapsed}ms local atomic batch`,
  );
  assert.equal(
    await h.store
      .statement(
        "SELECT count(*) AS n FROM source_births WHERE phase='history'",
      )
      .first<number>("n"),
    100,
  );
  const before = (await h.cursor())!;
  const second = await h.run((windows) => {
    assert.equal(windows.operations.cursor, "op-full");
    assert.equal(windows.qsos.cursor, "qso-full");
    assert.equal(windows.qsos.limit, 100);
    return response();
  });
  assert.equal(second.complete, false);
  assert.equal(
    (await sourceReadPolicy(h.store, "a", "source"))?.phase,
    "drain",
  );
  assert.equal((await h.cursor())!.generation, before.generation + 1);
  assert.equal(
    JSON.parse((await h.cursor())!.cursor).completeReadStartedAt,
    undefined,
  );
  assert.equal(
    (
      await h.run((w) => {
        assert.equal(w.qsos.limit, 25);
        return response();
      })
    ).complete,
    false,
  );
  assert.equal(
    (
      await h.run((w) => {
        assert.equal(w.qsos.limit, 25);
        return response();
      })
    ).complete,
    true,
  );
  await h.run((w) => {
    assert.equal(w.qsos.limit, 100);
    return response();
  });
  await h.run(
    (w) => {
      assert.equal(w.qsos.limit, 25);
      return response();
    },
    { stream: "repair" },
  );
});

test("a rejected large baseline page retries only the original cursor at25 before any writes", async (t) => {
  const h = await fixture(t);
  await h.run(() =>
    response([row("anchor-op", 500)], [row("anchor-qso", 500)], "saved"),
  );
  h.requests.length = 0;
  const before = (await h.cursor())!;
  const result = await h.run(async (windows) => {
    assert.equal(windows.operations.cursor, "op-saved");
    assert.equal(windows.qsos.cursor, "qso-saved");
    if (windows.qsos.limit === 100)
      return response(
        [],
        [{ ...row("uncommitted"), notes: "x".repeat(1024 * 1024) }],
        "discard",
      );
    assert.equal(await h.count(), 2);
    assert.deepEqual(await h.cursor(), before);
    return response([], [row("accepted", 400)], "accepted");
  });
  assert.equal(result.records, 1);
  assert.deepEqual(
    h.requests.map((r) => r.qsos.limit),
    [100, 25],
  );
  assert.equal(await h.count(), 3);
  assert.equal(
    await h.store
      .statement("SELECT count(*) AS n FROM source_work WHERE id='uncommitted'")
      .first<number>("n"),
    0,
  );
  assert.equal(
    JSON.parse((await h.cursor())!.cursor).qsos.cursor,
    "qso-accepted",
  );
});

for (const kind of ["records", "bytes", "transport-bytes"] as const)
  test(`baseline ${kind} overflow leaves all source data and cursor unchanged after bounded fallback`, async (t) => {
    const h = await fixture(t);
    const before = await h.cursor();
    await assert.rejects(
      h.run((windows) =>
        kind === "records"
          ? response(
              [],
              Array.from({ length: windows.qsos.limit + 1 }, (_, i) =>
                row(`overflow-${i}`),
              ),
            )
          : response(
              [],
              [
                {
                  ...row("oversized"),
                  notes: "x".repeat(
                    kind === "bytes" ? 1024 * 1024 : 2 * 1024 * 1024,
                  ),
                },
              ],
            ),
      ),
      new RegExp(
        kind === "records"
          ? "source_page_record_limit"
          : kind === "bytes"
            ? "source_page_byte_limit"
            : "response_too_large",
      ),
    );
    assert.deepEqual(
      h.requests.map((r) => r.qsos.limit),
      [100, 25],
    );
    assert.deepEqual(await h.cursor(), before);
    assert.equal(await h.count(), 0);
    assert.equal(h.batches.length, 0);
  });

test("baseline requests keep the shared four-request cap and resume the last committed continuation", async (t) => {
  const h = await fixture(t);
  const window = h.now + 10 * 300_000;
  for (let index = 0; index < 4; index++)
    await h.run(
      () =>
        response([], [row(`accepted-${index}`, 1000 - index)], `page-${index}`),
      { vendorNow: window },
    );
  const before = (await h.cursor())!;
  await assert.rejects(
    h.run(
      () => {
        throw new Error("budget admission must stop transport");
      },
      { vendorNow: window },
    ),
    VendorDeferredError,
  );
  assert.deepEqual(await h.cursor(), before);
  assert.equal(h.requests.length, 4);
  await h.run(
    (w) => {
      assert.equal(w.qsos.cursor, "qso-page-3");
      return response([], [row("continued", 900)], "continued");
    },
    { vendorNow: window + 300_000 },
  );
  assert.equal(await h.count(), 5);
});

test("fallback admission deferral preserves the cursor and consumes no fifth transport", async (t) => {
  const h = await fixture(t);
  const window = h.now + 10 * 300_000;
  for (let i = 0; i < 3; i++)
    await h.run(
      () => response([], [row(`saved-${i}`, 1000 - i)], `saved-${i}`),
      { vendorNow: window },
    );
  const before = await h.cursor();
  await assert.rejects(
    h.run(
      () => response([], [{ ...row("large"), notes: "x".repeat(1024 * 1024) }]),
      { vendorNow: window },
    ),
    VendorDeferredError,
  );
  assert.equal(h.requests.length, 4);
  assert.deepEqual(await h.cursor(), before);
  assert.equal(await h.count(), 3);
});

test("deadline and expired lease failures cannot publish or retry a baseline page", async (t) => {
  const h = await fixture(t);
  const before = await h.cursor();
  const originalNow = Date.now;
  try {
    await assert.rejects(
      h.run(() => {
        const advanced = originalNow() + 60_000;
        Date.now = () => advanced;
        return response([], [row("late")]);
      }),
      /source_page_deadline_exceeded/,
    );
  } finally {
    Date.now = originalNow;
  }
  assert.equal(h.requests.length, 1);
  assert.deepEqual(await h.cursor(), before);
  assert.equal(await h.count(), 0);
  h.requests.length = 0;
  try {
    await assert.rejects(
      h.run(() => {
        const advanced = originalNow() + 31_000;
        Date.now = () => advanced;
        return response(
          [],
          [{ ...row("too-late-for-fallback"), notes: "x".repeat(1024 * 1024) }],
        );
      }),
      /source_page_byte_limit/,
    );
  } finally {
    Date.now = originalNow;
  }
  assert.equal(
    h.requests.length,
    1,
    "size fallback cannot consume the remaining lease reserve",
  );
  assert.deepEqual(await h.cursor(), before);
  assert.equal(await h.count(), 0);
  h.requests.length = 0;
  await assert.rejects(
    h.run(async () => {
      await h.store
        .statement(
          "UPDATE leases SET expires_at=0 WHERE tenant='a' AND scope='poll:source:sync'",
        )
        .run();
      return response(
        Array.from({ length: 100 }, (_, i) => row(`op-${i}`)),
        Array.from({ length: 100 }, (_, i) => row(`q-${i}`)),
      );
    }),
  );
  assert.equal(h.requests.length, 1);
  assert.deepEqual(await h.cursor(), before);
  assert.equal(await h.count(), 0);
});

test("an uncertain checkpoint outcome never retries the network or replays the same page", async (t) => {
  const h = await fixture(t);
  const original = h.store.checkpoint.bind(h.store);
  h.store.checkpoint = async (...args) => {
    await original(...args);
    throw new Error("synthetic lost checkpoint acknowledgement");
  };
  await assert.rejects(
    h.run(() => response([], [row("committed")], "committed")),
    /lost checkpoint acknowledgement/,
  );
  assert.equal(h.requests.length, 1);
  assert.equal(await h.count(), 1);
  assert.equal(
    (JSON.parse((await h.cursor())!.cursor) as SyncState).qsos.cursor,
    "qso-committed",
  );
});
