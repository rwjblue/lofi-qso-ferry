import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { measuredDatabase } from "../src/database-metrics.ts";
import type { SourceRecord } from "../src/lofi.ts";
import { canonical, randomToken, sha256 } from "../src/security.ts";
import {
  backfillSourceHistoricalIndex,
  lookupSourceHistoricalIndex,
  lookupSourceHistoricalIndexBatch,
  type SourceHistoricalIndexLookupInput,
  sourceHistoricalIndexKey,
} from "../src/source-historical-index.ts";
import { Store } from "../src/store.ts";
import { applyMigration, database, keys, seed } from "./helpers.ts";

const AT = Date.parse("2026-10-24T12:00:01Z");
const query = (
  workedCall = "W1AW",
  changes: Partial<SourceHistoricalIndexLookupInput> = {},
): SourceHistoricalIndexLookupInput => ({
  workedCall,
  startMs: AT - 1800000,
  endMs: AT + 1800000,
  ...changes,
});
const qso = (uuid: string, changes: SourceRecord = {}): SourceRecord => ({
  uuid,
  syncedAtMillis: 100,
  startAtMillis: AT,
  their: { call: "W1AW" },
  band: "20m",
  mode: "CW",
  ...changes,
});
async function fixture(t: TestContext) {
  const h = await database();
  t.after(() => h.mf.dispose());
  for (const name of (await readdir(new URL("../migrations", import.meta.url)))
    .filter(
      (n) => n.endsWith(".sql") && n > "0001_foundation.sql" && n < "0034",
    )
    .sort())
    await applyMigration(h.db, name);
  await seed(h.store);
  return h;
}
async function retain(
  store: Store,
  raws: SourceRecord[],
  tenant = "a",
  source = "source",
) {
  for (let offset = 0; offset < raws.length; offset += 40) {
    const statements = await Promise.all(
      raws.slice(offset, offset + 40).map(async (raw) => {
        const privateId = randomToken(),
          now = Date.now();
        const { syncedAtMillis: _stamp, ...inputs } = raw;
        return [
          await store.putPrivate(
            tenant,
            source,
            privateId,
            "source",
            raw,
            now + 3600000,
          ),
          store.statement(
            "INSERT INTO source_work(tenant,source,id,kind,private_id,revision,expires_at,synced_at,is_event,deleted,state) VALUES(?,?,?,'qso',?,?,?,?,0,0,'pending')",
            tenant,
            source,
            String(raw.uuid),
            privateId,
            await sha256(canonical(inputs)),
            now + 3600000,
            Number(raw.syncedAtMillis),
          ),
        ];
      }),
    );
    await store.db.batch(statements.flat());
  }
}
async function index(store: Store, tenant = "a") {
  for (let pass = 0; pass < 20; pass++) {
    const result = await backfillSourceHistoricalIndex(store, tenant, {
      limit: 100,
    });
    assert.equal(result.held, 0);
    if (!result.rebuilding) return;
  }
  assert.fail("bounded fixture index did not complete");
}
function intercepted(store: Store, before: () => Promise<void>) {
  const db = new Proxy(store.db, {
    get(target, name) {
      if (name === "batch")
        return async (statements: D1PreparedStatement[]) => {
          await before();
          return target.batch(statements);
        };
      const value = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Store(db, store.keys);
}

test("twenty lookups share one key/snapshot and deduplicate keyed windows without sharing mutable results", async (t) => {
  const h = await fixture(t);
  await retain(h.store, [
    qso("normal"),
    qso("portable", { their: { call: "W1AW/P" } }),
    qso("later", { startAtMillis: AT + 86400000 }),
  ]);
  await index(h.store);
  const inputs = Array.from({ length: 20 }, (_, i) =>
    i % 3 === 0
      ? query(" w1aw/p ")
      : i % 3 === 1
        ? query()
        : query("W1AW", { startMs: AT + 86400000, endMs: AT + 86400001 }),
  );
  const meter = measuredDatabase(h.db),
    observed = new Store(meter.database, keys);
  const found = await lookupSourceHistoricalIndexBatch(observed, "a", inputs);
  assert.equal(meter.metrics.calls, 2);
  assert.equal(
    meter.metrics.statements,
    5,
    "state + three unique windows + shared final guard",
  );
  assert.equal(found.length, 20);
  for (const [i, input] of inputs.entries()) {
    const single = await lookupSourceHistoricalIndex(h.store, "a", input);
    assert.deepEqual(found[i], single);
    assert.deepEqual(found[i].snapshot, found[0].snapshot);
  }
  found[0].rows[0].qso = "changed by caller";
  found[0].snapshot!.clock = -1;
  assert.equal(found[3].rows[0].qso, "portable");
  assert.ok(found[3].snapshot!.clock >= 0);
  assert.equal(
    found[1].rows[0].qso,
    "normal",
    "portable calls remain a distinct scope",
  );
});

test("unknown scopes, active sources and tenant separation preserve every possible competitor", async (t) => {
  const h = await fixture(t);
  await h.store
    .statement(
      "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,created_at) VALUES('a','second','lofi','second','second','active',0)",
    )
    .run();
  await retain(h.store, [
    qso("exact"),
    qso("call-only", { startAtMillis: null }),
    qso("minute-only", { their: null }),
    qso("unknown", { startAtMillis: null, their: null }),
  ]);
  await retain(h.store, [qso("other-source")], "a", "second");
  await seed(h.store, "b");
  await retain(h.store, [qso("other-tenant")], "b");
  await index(h.store);
  await index(h.store, "b");
  const inputs = [
    query(),
    query("W2AW"),
    query("W1AW", { startMs: AT + 86400000, endMs: AT + 86400001 }),
  ];
  const result = await lookupSourceHistoricalIndexBatch(h.store, "a", inputs);
  assert.deepEqual(result[0].rows.map((r) => r.qso).sort(), [
    "call-only",
    "exact",
    "minute-only",
    "other-source",
    "unknown",
  ]);
  assert.deepEqual(result[1].rows.map((r) => r.scope).sort(), [
    "minute",
    "unknown",
  ]);
  assert.deepEqual(result[2].rows.map((r) => r.scope).sort(), [
    "call",
    "unknown",
  ]);
  assert.ok(
    result.every(
      (r) =>
        r.status === "ready" &&
        !r.rows.some((row) => row.qso === "other-tenant"),
    ),
  );
});

test("per-request overflow holds only that request even when the bucket SELECT is shared", async (t) => {
  const h = await fixture(t);
  await retain(h.store, [
    qso("one"),
    qso("two"),
    qso("neighbor", { their: { call: "W2AW" } }),
  ]);
  await index(h.store);
  const meter = measuredDatabase(h.db);
  const result = await lookupSourceHistoricalIndexBatch(
    new Store(meter.database, keys),
    "a",
    [query("W1AW", { limit: 1 }), query("W1AW", { limit: 2 }), query("W2AW")],
  );
  assert.equal(meter.metrics.statements, 4);
  assert.equal(result[0].reason, "candidate_bound");
  assert.deepEqual(result[0].rows, []);
  assert.equal(result[1].status, "ready");
  assert.equal(result[1].rows.length, 2);
  assert.equal(result[2].status, "ready");
  assert.equal(result[2].rows[0].qso, "neighbor");
});

test("inputs are captured before awaits and late clock, policy, active-source and body changes invalidate every result", async (t) => {
  const h = await fixture(t);
  await retain(h.store, [qso("one")]);
  await index(h.store);
  const inputs = [query(), query()];
  const pending = lookupSourceHistoricalIndexBatch(h.store, "a", inputs);
  inputs[0].workedCall = "W2AW";
  inputs[1].startMs = 1;
  assert.ok((await pending).every((r) => r.rows[0].qso === "one"));
  for (const mutation of [
    "UPDATE source_historical_state SET clock=clock+1 WHERE tenant='a'",
    "UPDATE source_historical_state SET epoch=epoch+1,clock=clock+1 WHERE tenant='a'",
    "UPDATE connections SET config=json_set(config,'$.stationCall','N1CALL') WHERE tenant='a' AND id='source'",
    "UPDATE private_data SET revoked_at=1 WHERE tenant='a' AND kind='source'",
  ]) {
    const raced = await lookupSourceHistoricalIndexBatch(
      intercepted(h.store, async () => {
        await h.store.statement(mutation).run();
      }),
      "a",
      [query(), query("W2AW")],
    );
    assert.ok(
      raced.every((r) => r.reason === "index_changed" && r.rows.length === 0),
    );
  }
  await h.store
    .statement(
      "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,created_at) VALUES('a','paused','lofi','paused','paused','paused',0)",
    )
    .run();
  await retain(h.store, [qso("dirty-paused")], "a", "paused");
  assert.equal(
    (await lookupSourceHistoricalIndexBatch(h.store, "a", [query()]))[0].status,
    "ready",
  );
  const activation = await lookupSourceHistoricalIndexBatch(
    intercepted(h.store, async () => {
      await h.store
        .statement("UPDATE connections SET status='active' WHERE id='paused'")
        .run();
    }),
    "a",
    [query()],
  );
  assert.equal(activation[0].reason, "index_changed");
  assert.equal(
    (await lookupSourceHistoricalIndexBatch(h.store, "a", [query()]))[0].reason,
    "index_incomplete",
  );
});

test("validation, incomplete coverage and key loss fail closed; native errors remain errors", async (t) => {
  const h = await fixture(t),
    meter = measuredDatabase(h.db),
    store = new Store(meter.database, keys);
  assert.deepEqual(await lookupSourceHistoricalIndexBatch(store, "a", []), []);
  for (const inputs of [
    Array.from({ length: 21 }, () => query()),
    [query("invalid")],
    [query("W1AW", { limit: 0 })],
    [query("W1AW", { endMs: AT + 123 * 60000 })],
  ])
    await assert.rejects(lookupSourceHistoricalIndexBatch(store, "a", inputs));
  assert.equal(meter.metrics.calls, 0);
  assert.equal(
    (await lookupSourceHistoricalIndexBatch(h.store, "a", [query()]))[0].reason,
    "index_uninitialized",
  );
  await retain(h.store, [qso("one"), qso("two")]);
  await backfillSourceHistoricalIndex(h.store, "a", { limit: 1 });
  assert.ok(
    (
      await lookupSourceHistoricalIndexBatch(h.store, "a", [
        query(),
        query("W2AW"),
      ])
    ).every((r) => r.reason === "index_incomplete"),
  );
  await index(h.store);
  const error = new Error("native batch failed");
  await assert.rejects(
    lookupSourceHistoricalIndexBatch(
      intercepted(h.store, async () => {
        throw error;
      }),
      "a",
      [query()],
    ),
    (e) => e === error,
  );
  const onlyNew = new Store(h.db, {
    active: "2",
    keys: { "2": keys.keys["2"] },
  });
  assert.ok(
    (
      await lookupSourceHistoricalIndexBatch(onlyNew, "a", [query(), query()])
    ).every((r) => r.reason === "index_key_unavailable"),
  );
});

test("rewrapped stable keys and archived or expired bodies remain localized metadata, never refreshed evidence", async (t) => {
  const h = await fixture(t);
  await retain(h.store, [
    qso("archived"),
    qso("expired", { their: { call: "W2AW" } }),
  ]);
  await index(h.store);
  const before = await lookupSourceHistoricalIndexBatch(h.store, "a", [
    query(),
    query("W2AW"),
  ]);
  await h.store
    .statement(
      "DELETE FROM private_data WHERE id=(SELECT private_id FROM source_work WHERE id='archived')",
    )
    .run();
  await h.store
    .statement(
      "UPDATE private_data SET expires_at=1 WHERE id=(SELECT private_id FROM source_work WHERE id='expired')",
    )
    .run();
  const rewrapped = new Store(h.db, { ...keys, active: "2" });
  await sourceHistoricalIndexKey(rewrapped, "a");
  const onlyNew = new Store(h.db, {
    active: "2",
    keys: { "2": keys.keys["2"] },
  });
  const result = await lookupSourceHistoricalIndexBatch(onlyNew, "a", [
    query(),
    query("W2AW"),
    query("W3AW"),
  ]);
  assert.equal(result[0].rows[0].qso, "archived");
  assert.equal(result[1].rows[0].qso, "expired");
  assert.deepEqual(result[2].rows, []);
  assert.equal(result[0].snapshot!.keyId, before[0].snapshot!.keyId);
  assert.notEqual(result[0].snapshot!.clock, before[0].snapshot!.clock);
  assert.deepEqual(result[0].rows, before[0].rows);
  // The reverse projector remains responsible for the body/expiry hold.
});

test("aggregate row and metadata bounds hold the cohort while complete smaller subsets remain usable", async (t) => {
  for (const wide of [false, true]) {
    const h = await fixture(t),
      count = wide ? 300 : 513;
    await retain(
      h.store,
      Array.from({ length: count }, (_, i) =>
        qso(`${wide ? "x".repeat(4096) : "q"}${i}`, {
          their: { call: i % 2 ? "W1AW" : "W2AW" },
        }),
      ),
    );
    await index(h.store);
    const meter = measuredDatabase(h.db),
      result = await lookupSourceHistoricalIndexBatch(
        new Store(meter.database, keys),
        "a",
        [query("W1AW", { limit: 300 }), query("W2AW", { limit: 300 })],
      );
    assert.equal(meter.metrics.calls, 2);
    assert.ok(
      result.every((r) => r.reason === "cohort_bound" && r.rows.length === 0),
    );
    for (const [workedCall, expected] of [
      ["W1AW", Math.floor(count / 2)],
      ["W2AW", Math.ceil(count / 2)],
    ] as const) {
      const [subset] = await lookupSourceHistoricalIndexBatch(h.store, "a", [
        query(workedCall, { limit: 300 }),
      ]);
      assert.equal(subset.status, "ready");
      assert.equal(subset.rows.length, expected);
    }
  }
});
