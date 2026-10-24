import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { pollSource } from "../src/intake.ts";
import type { SyncState } from "../src/lofi.ts";
import {
  resetSourceReadPolicy,
  sourceReadPolicy,
} from "../src/source-read-policy.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

function reply(
  options: {
    remaining?: number;
    cursor?: string;
    operationCursor?: string;
  } = {},
) {
  return new Response(
    JSON.stringify({
      account: { uuid: "source" },
      operations: [],
      qsos: [],
      meta: {
        operations: {
          records_left: options.operationCursor ? 1 : 0,
          ...(options.operationCursor
            ? { next_cursor: options.operationCursor }
            : {}),
        },
        qsos: {
          records_left: options.remaining ?? 0,
          ...(options.cursor ? { next_cursor: options.cursor } : {}),
        },
      },
    }),
  );
}

async function setup(t: TestContext) {
  const h = await database();
  t.after(() => h.mf.dispose());
  await applyAdditionalMigrations(h.db);
  await seed(h.store);
  await h.store
    .statement(
      "UPDATE connections SET credential_version='v2',config=? WHERE tenant='a' AND id='source'",
      JSON.stringify({ accountId: "source" }),
    )
    .run();
  await (
    await h.store.putPrivate("a", "source", "v2", "credential", {
      key: "browser:fixture",
      secret: "fixture-secret",
      token: "fixture-token",
    })
  ).run();
  const source = (await h.store.connection("a", "source"))!;
  const start = Date.now();
  let time = start;
  let calls = 0;
  const run = async (
    fetcher: typeof fetch = async () => reply(),
    stream = "sync",
  ) => {
    time = Math.max(time + 1000, Date.now());
    const readAt = time;
    const result = await pollSource(
      h.store,
      source,
      fetcher,
      readAt,
      stream,
      start + ++calls * 300_000,
    );
    return { result, readAt };
  };
  const cursor = async () => {
    const row = await h.store
      .statement(
        "SELECT cursor,generation,updated_at FROM cursors WHERE tenant='a' AND connection='source' AND stream='sync'",
      )
      .first<{ cursor: string; generation: number; updated_at: number }>();
    return row ? { ...row, state: JSON.parse(row.cursor) as SyncState } : null;
  };
  const ready = async () => {
    await run();
    await run();
    await run();
  };
  return { ...h, source, run, cursor, ready, now: () => time };
}

test("fresh empty canonical forward reads get conservative markers; backfill and side scans do not", async (t) => {
  const h = await setup(t);
  await h.run();
  const backfill = (await h.cursor())!;
  assert.equal(backfill.state.mode, "forward");
  assert.equal(backfill.state.completeReadStartedAt, undefined);
  let beforeResponse = 0;
  const { readAt } = await h.run(async () => {
    beforeResponse = Date.now();
    return reply();
  });
  const forward = (await h.cursor())!;
  assert.equal(typeof forward.state.completeReadStartedAt, "number");
  assert.ok(forward.state.completeReadStartedAt! >= readAt);
  assert.ok(forward.state.completeReadStartedAt! <= forward.updated_at);
  assert.ok(beforeResponse > 0);
  assert.equal(forward.state.readerPolicy, "all-clients-v1");
  assert.equal(forward.state.policyEpoch, backfill.state.policyEpoch);
  await h.run(async () => reply(), "repair");
  assert.deepEqual(await h.cursor(), forward);
  const repair = await h.store
    .statement(
      "SELECT cursor FROM cursors WHERE tenant='a' AND connection='source' AND stream='repair'",
    )
    .first<{ cursor: string }>();
  assert.equal(JSON.parse(repair!.cursor).completeReadStartedAt, undefined);
});

test("partial pages clear the marker, terminal continuations cannot renew it, and the next fresh poll qualifies", async (t) => {
  const h = await setup(t);
  await h.ready();
  const before = (await h.cursor())!;
  assert.equal(typeof before.state.completeReadStartedAt, "number");
  // An explicit incomplete empty page preserves its window but cannot retain
  // a prior complete-read marker.
  await h.run(async () => reply({ remaining: 1 }));
  assert.equal((await h.cursor())!.state.completeReadStartedAt, undefined);
  // Seed a valid opaque continuation in the canonical state, as an earlier
  // nonempty forward page would. No server cursor meaning is invented.
  const partial = (await h.cursor())!;
  await h.store
    .statement(
      "UPDATE cursors SET cursor=?,generation=generation+1 WHERE tenant='a' AND connection='source' AND stream='sync'",
      JSON.stringify({
        ...partial.state,
        qsos: { ...partial.state.qsos, cursor: "opaque-continuation" },
      }),
    )
    .run();
  await h.run(async (_url, init) => {
    assert.equal(
      JSON.parse(String(init?.body)).meta.sync.qsos.cursor,
      "opaque-continuation",
    );
    return reply();
  });
  const terminal = (await h.cursor())!;
  assert.equal(terminal.state.qsos.cursor, undefined);
  assert.equal(terminal.state.completeReadStartedAt, undefined);
  await h.run();
  const fresh = (await h.cursor())!;
  assert.ok(
    fresh.state.completeReadStartedAt! > before.state.completeReadStartedAt!,
  );
  assert.ok(fresh.generation > terminal.generation);
});

test("an operation-side continuation also prevents a terminal read from qualifying", async (t) => {
  const h = await setup(t);
  await h.ready();
  const prior = (await h.cursor())!;
  await h.store
    .statement(
      "UPDATE cursors SET cursor=?,generation=generation+1 WHERE tenant='a' AND connection='source' AND stream='sync'",
      JSON.stringify({
        ...prior.state,
        operations: {
          ...prior.state.operations,
          cursor: "operation-continuation",
        },
      }),
    )
    .run();
  await h.run();
  assert.equal((await h.cursor())!.state.completeReadStartedAt, undefined);
});

test("401 renewal and retry keep the conservative initial request time rather than the later response", async (t) => {
  const h = await setup(t);
  await h.ready();
  let count = 0;
  let initialWallTime = 0;
  let retryWallTime = 0;
  const { readAt } = await h.run(async (url) => {
    count++;
    if (count === 1) {
      initialWallTime = Date.now();
      // A small real delay makes the retry observably later without replacing
      // the global clock used by D1/Miniflare.
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(null, { status: 401 });
    }
    if (count === 2) {
      assert.equal(url, "https://lofi.ham2k.net/v1/client");
      return new Response(JSON.stringify({ token: "renewed-token" }));
    }
    retryWallTime = Date.now();
    return reply();
  });
  const current = (await h.cursor())!;
  assert.equal(count, 3);
  assert.ok(retryWallTime > initialWallTime);
  assert.ok(current.state.completeReadStartedAt! >= readAt);
  assert.ok(current.updated_at - current.state.completeReadStartedAt! >= 30);
  const saved = await h.store.private<{ token: string }>(
    "a",
    "source",
    "v2",
    "credential",
  );
  assert.equal(saved?.token, "renewed-token");
});

test("failed reads, admission denial and a busy poll lease publish no new marker or generation", async (t) => {
  const h = await setup(t);
  await h.ready();
  const before = await h.cursor();
  await assert.rejects(
    h.run(async () => {
      throw new Error("synthetic transport failure");
    }),
  );
  assert.deepEqual(await h.cursor(), before);
  await assert.rejects(
    h.run(async () => {
      throw new VendorDeferredError(h.now() + 300_000, false);
    }),
  );
  assert.deepEqual(await h.cursor(), before);
  const lease = await h.store.claim(
    "a",
    "poll:source:sync",
    h.now() + 1000,
    90_000,
  );
  assert.ok(lease);
  let requests = 0;
  const { result } = await h.run(async () => {
    requests++;
    return reply();
  });
  assert.equal(result.pages, 0);
  assert.equal(requests, 0);
  assert.deepEqual(await h.cursor(), before);
  await h.store.release(lease!);
});

test("scope and lease races roll back a new marker with the page checkpoint", async (t) => {
  for (const race of ["scope", "lease"] as const) {
    await t.test(race, async (t) => {
      const h = await setup(t);
      await h.ready();
      const before = await h.cursor();
      let raced = false;
      await assert.rejects(
        h.run(async () => {
          if (race === "scope")
            await h.store
              .statement(
                "UPDATE connections SET status='inactive' WHERE tenant='a' AND id='source'",
              )
              .run();
          else
            await h.store
              .statement(
                "UPDATE leases SET token='replacement',fence=fence+1 WHERE tenant='a' AND scope='poll:source:sync'",
              )
              .run();
          raced = true;
          return reply();
        }),
      );
      assert.equal(raced, true);
      assert.deepEqual(await h.cursor(), before);
    });
  }
});

test("a policy reset drops the previous complete-read marker", async (t) => {
  const h = await setup(t);
  await h.ready();
  const before = (await h.cursor())!;
  assert.equal(typeof before.state.completeReadStartedAt, "number");
  const policy = (await sourceReadPolicy(h.store, "a", "source"))!;
  const lease = (await h.store.claim(
    "a",
    "poll:source:sync",
    h.now(),
    90_000,
  ))!;
  const reset = await resetSourceReadPolicy(
    h.store,
    h.source,
    lease,
    { epoch: policy.epoch, generation: before.generation },
    "cursor_gap",
    h.now(),
  );
  assert.equal(reset.cursor.cursor.completeReadStartedAt, undefined);
  assert.equal((await h.cursor())!.state.completeReadStartedAt, undefined);
  await h.store.release(lease);
});
