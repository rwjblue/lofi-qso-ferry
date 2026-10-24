import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { pollSource } from "../src/intake.ts";
import type { SourceRecord } from "../src/lofi.ts";
import { purgeResolvedSource } from "../src/maintenance.ts";
import { canonical, randomToken, sha256 } from "../src/security.ts";
import {
  backfillSourceHistoricalIndex,
  ensureSourceHistoricalIndex,
  lookupSourceHistoricalIndex,
  sourceHistoricalIndexGuard,
  sourceHistoricalIndexKey,
  sourceHistoricalPublication,
} from "../src/source-historical-index.ts";
import { Store } from "../src/store.ts";
import { applyMigration, database, keys, seed } from "./helpers.ts";

const AT = Date.parse("2026-10-24T12:00:01Z");
const qso = (id: string, override: SourceRecord = {}): SourceRecord => ({
  uuid: id,
  syncedAtMillis: 100,
  startAtMillis: AT,
  operation: null,
  their: { call: "W1AW" },
  our: { stationCall: "N0CALL" },
  band: "20m",
  mode: "CW",
  ...override,
});
async function fixture(t: TestContext) {
  const h = await database();
  t.after(() => h.mf.dispose());
  for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
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
  raw: SourceRecord,
  { tenant = "a", source = "source", kind = "qso", state = "pending" } = {},
) {
  const privateId = randomToken(),
    now = Date.now();
  const { syncedAtMillis: _stamp, ...inputs } = raw;
  const revision = await sha256(canonical(inputs));
  await store.db.batch([
    await store.putPrivate(
      tenant,
      source,
      privateId,
      "source",
      raw,
      now + 3600000,
    ),
    store.statement(
      `INSERT INTO source_work(tenant,source,id,kind,operation_id,private_id,revision,expires_at,synced_at,is_event,deleted,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant,source,id,kind) DO UPDATE SET operation_id=excluded.operation_id,private_id=excluded.private_id,revision=excluded.revision,expires_at=excluded.expires_at,synced_at=excluded.synced_at,is_event=excluded.is_event,deleted=excluded.deleted,state=excluded.state`,
      tenant,
      source,
      String(raw.uuid),
      kind,
      kind === "operation"
        ? String(raw.uuid)
        : typeof raw.operation === "string"
          ? raw.operation
          : null,
      privateId,
      revision,
      now + 3600000,
      Number(raw.syncedAtMillis),
      raw.band === "event" || raw.event ? 1 : 0,
      raw.deleted ? 1 : 0,
      state,
    ),
  ]);
  const body = await store
    .statement(
      "SELECT source_proof_version AS version FROM private_data WHERE tenant=? AND connection=? AND id=?",
      tenant,
      source,
      privateId,
    )
    .first<{ version: string }>();
  return {
    revision,
    syncedAt: Number(raw.syncedAtMillis),
    privateId,
    bodyVersion: body!.version,
  };
}
const lookup = (
  store: Store,
  workedCall = "W1AW",
  startMs = AT - 1800000,
  endMs = AT + 1800000,
  limit = 128,
) =>
  lookupSourceHistoricalIndex(store, "a", {
    workedCall,
    startMs,
    endMs,
    limit,
  });
async function guardCurrent(
  store: Store,
  s: Awaited<ReturnType<typeof ensureSourceHistoricalIndex>>,
) {
  const g = sourceHistoricalIndexGuard(s);
  return !!(await store
    .statement(`SELECT 1 WHERE ${g.sql}`, ...g.params)
    .first());
}

test("weak index is private, state-independent, tenant-separated and boundedly rebuilt", async (t) => {
  const { store } = await fixture(t);
  for (const state of [
    "pending",
    "processed",
    "blocked",
    "test",
    "archived",
    "missing_from_inventory",
  ])
    await retain(store, qso(state), { state });
  await retain(store, qso("other-call", { their: { call: "W2AW" } }));
  await retain(
    store,
    qso("event", { band: "event", event: { event: "start" } }),
  );
  await retain(store, qso("deleted", { deleted: true }));
  assert.equal((await lookup(store)).reason, "index_uninitialized");
  const first = await backfillSourceHistoricalIndex(store, "a", { limit: 2 });
  assert.equal(first.examined, 2);
  assert.equal(first.published, 2);
  assert.equal(first.rebuilding, true);
  assert.equal((await lookup(store)).reason, "index_incomplete");
  for (let i = 0; i < 4; i++)
    await backfillSourceHistoricalIndex(store, "a", { limit: 2 });
  const found = await lookup(store, " w1aw ");
  assert.equal(found.status, "ready");
  assert.equal(found.rows.length, 6);
  assert.equal(
    (await lookup(store, "W1AW", AT - 1800000, AT + 1800000, 5)).reason,
    "candidate_bound",
  );
  const persisted = await store
    .statement("SELECT * FROM source_historical_index")
    .all();
  const text = JSON.stringify(persisted.results);
  assert.ok(!text.includes("W1AW"));
  assert.ok(!text.includes(String(AT)));
  assert.ok(!text.includes(String(Math.floor(AT / 60000))));
  await seed(store, "b");
  const keyA = await sourceHistoricalIndexKey(store, "a"),
    keyB = await sourceHistoricalIndexKey(store, "b");
  assert.notEqual(keyA.keyId, keyB.keyId);
  assert.equal(await guardCurrent(store, found.snapshot!), true);
  await assert.rejects(
    () =>
      store
        .statement(
          "DELETE FROM source_historical_index WHERE tenant='a' AND source='source' AND qso='pending'",
        )
        .run(),
    /row retained/,
  );
  await assert.rejects(
    () =>
      store
        .statement(
          "UPDATE source_historical_state SET clock=0 WHERE tenant='a'",
        )
        .run(),
    /regression/,
  );
});

test("partial unknown keys remain in every relevant bounded cohort for current-context projection", async (t) => {
  const { store } = await fixture(t);
  await retain(store, qso("known"));
  await retain(store, qso("call-only", { startAtMillis: "invalid" }));
  await retain(store, qso("minute-only", { their: { call: "?" } }));
  await backfillSourceHistoricalIndex(store, "a");
  const both = await lookup(store);
  assert.equal(both.status, "ready");
  assert.deepEqual(both.rows.map((r) => r.scope).sort(), [
    "call",
    "exact",
    "minute",
  ]);
  assert.deepEqual(
    (await lookup(store, "W2AW")).rows.map((r) => r.scope),
    ["minute"],
  );
  assert.equal(
    (await lookup(store, "W2AW", AT + 86400000, AT + 86400001)).rows.length,
    0,
  );
  assert.deepEqual(
    (await lookup(store, "W1AW", AT + 86400000, AT + 86400001)).rows.map(
      (r) => r.scope,
    ),
    ["call"],
  );
  await retain(
    store,
    qso("fully-unknown", { startAtMillis: null, their: null }),
  );
  await backfillSourceHistoricalIndex(store, "a");
  assert.deepEqual(
    (await lookup(store, "W2AW", AT + 86400000, AT + 86400001)).rows.map(
      (r) => r.scope,
    ),
    ["unknown"],
  );
  assert.equal(
    (await lookup(store, "W1AW", AT - 1800000, AT + 1800000, 3)).reason,
    "candidate_bound",
  );
});

test("legacy source/body/context/connection races invalidate coverage but work-state and health churn do not", async (t) => {
  const { store } = await fixture(t);
  const raw = qso("q");
  await retain(store, raw);
  await backfillSourceHistoricalIndex(store, "a");
  let before = (await lookup(store)).snapshot!;
  await store
    .statement(
      "UPDATE source_work SET state='blocked',reason='reason',processed_at=123 WHERE tenant='a' AND id='q'",
    )
    .run();
  await store
    .statement(
      "UPDATE connections SET last_poll_at=100,config=json_set(config,'$.lastSuccessfulPollAt',100,'$.lastError','temporary','$.accountEmail','changed@example.test') WHERE tenant='a' AND id='source'",
    )
    .run();
  assert.equal(await guardCurrent(store, before), true);
  await retain(
    store,
    qso("q", { syncedAtMillis: 101, their: { call: "W2AW" } }),
  );
  assert.equal(await guardCurrent(store, before), false);
  assert.equal((await lookup(store)).reason, "index_incomplete");
  await backfillSourceHistoricalIndex(store, "a");
  assert.equal((await lookup(store)).rows.length, 0);
  assert.equal((await lookup(store, "W2AW")).rows.length, 1);
  before = (await lookup(store, "W2AW")).snapshot!;
  await retain(
    store,
    { uuid: "op", syncedAtMillis: 100, stationCall: "N0CALL" },
    { kind: "operation" },
  );
  assert.equal(await guardCurrent(store, before), false);
  before = (await lookup(store, "W2AW")).snapshot!;
  await store
    .statement(
      "INSERT INTO cursors(tenant,connection,stream,cursor,generation,updated_at) VALUES('a','source','context','{}',1,0)",
    )
    .run();
  assert.equal(await guardCurrent(store, before), false);
  before = (await lookup(store, "W2AW")).snapshot!;
  await store
    .statement(
      "UPDATE connections SET config=json_set(config,'$.stationCall','N1CALL') WHERE tenant='a' AND id='source'",
    )
    .run();
  assert.equal(await guardCurrent(store, before), false);
  before = (await lookup(store, "W2AW")).snapshot!;
  await store
    .statement(
      "UPDATE private_data SET revoked_at=1 WHERE tenant='a' AND connection='source' AND kind='source' AND id=(SELECT private_id FROM source_work WHERE tenant='a' AND source='source' AND id='q')",
    )
    .run();
  assert.equal(await guardCurrent(store, before), false);
  assert.equal((await lookup(store, "W2AW")).rows.length, 1);
  assert.equal((await lookup(store)).rows.length, 0);
  const blocked = await backfillSourceHistoricalIndex(store, "a");
  assert.equal(blocked.examined, 0);
});

test("publication CAS rejects changed bodies and rollback never clears dirty coverage", async (t) => {
  const { store } = await fixture(t);
  const raw = qso("q");
  const expected = await retain(store, raw);
  await ensureSourceHistoricalIndex(store, "a");
  const key = await sourceHistoricalIndexKey(store, "a");
  const prepared = await sourceHistoricalPublication(
    store,
    "a",
    "source",
    raw,
    expected,
    key,
    Date.now(),
  );
  await store
    .statement(
      "UPDATE private_data SET expires_at=expires_at+1000 WHERE tenant='a' AND connection='source' AND id=?",
      expected.privateId,
    )
    .run();
  const applied = await store.db.batch(prepared);
  assert.equal(applied[1].results.length, 0);
  assert.equal((await lookup(store)).reason, "index_incomplete");
  const fresh = await retain(store, raw);
  const atomic = await sourceHistoricalPublication(
    store,
    "a",
    "source",
    raw,
    fresh,
    key,
    Date.now(),
  );
  await assert.rejects(
    () =>
      store.db.batch([
        ...atomic,
        store.statement(
          "INSERT INTO source_export_proof_batch_guards VALUES('fail',1,0)",
        ),
      ]),
    /CHECK/,
  );
  assert.equal(
    (
      await store
        .statement("SELECT dirty FROM source_historical_index WHERE qso='q'")
        .first<{ dirty: number }>()
    )?.dirty,
    1,
  );
  await backfillSourceHistoricalIndex(store, "a");
  assert.equal((await lookup(store)).status, "ready");
  const before = (await lookup(store)).snapshot!;
  await store
    .statement(
      "DELETE FROM source_work WHERE tenant='a' AND source='source' AND id='q'",
    )
    .run();
  assert.equal(await guardCurrent(store, before), false);
  assert.equal((await lookup(store)).rows.length, 0);
});

test("stable tenant keys survive KEK rewrap, initialization races and older-worker overlap", async (t) => {
  const h = await fixture(t);
  const other = new Store(h.db, { ...keys, active: "2" });
  const [a, b] = await Promise.all([
    sourceHistoricalIndexKey(h.store, "a"),
    sourceHistoricalIndexKey(other, "a"),
  ]);
  assert.equal(a.keyId, b.keyId);
  await retain(h.store, qso("retained"));
  await backfillSourceHistoricalIndex(h.store, "a");
  const before = (await lookup(h.store)).snapshot!;
  const row = await h.store
    .statement("SELECT * FROM source_historical_index")
    .first();
  await h.store.statement("DELETE FROM private_data WHERE kind='source'").run();
  await sourceHistoricalIndexKey(other, "a");
  const after = (await lookup(other)).snapshot!;
  assert.equal(before.keyId, after.keyId);
  assert.equal(before.epoch, after.epoch);
  assert.equal(await guardCurrent(other, before), false);
  assert.deepEqual(
    await h.store.statement("SELECT * FROM source_historical_index").first(),
    row,
  );
  const onlyNew = new Store(h.db, {
    active: "2",
    keys: { "2": keys.keys["2"] },
  });
  assert.equal((await lookup(onlyNew)).rows.length, 1);
  // Older workers can rewrap the same secret but cannot reset/rebuild its identity.
  await sourceHistoricalIndexKey(h.store, "a");
  assert.equal((await lookup(h.store)).snapshot!.epoch, before.epoch);
  assert.equal((await lookup(onlyNew)).reason, "index_key_unavailable");
  await sourceHistoricalIndexKey(other, "a");
  assert.equal((await lookup(onlyNew)).rows.length, 1);
  await assert.rejects(
    () =>
      h.store
        .statement(
          "UPDATE source_historical_state SET key_id='other',key_envelope='{}',epoch=epoch+1,clock=clock+1,rebuilding=1,cursor_source=NULL,cursor_qso=NULL WHERE tenant='a'",
        )
        .run(),
    /regression/,
  );
});

test("late rows behind the incremental rebuild cursor remain globally dirty", async (t) => {
  const { store } = await fixture(t);
  await retain(store, qso("b"));
  await retain(store, qso("c"));
  await backfillSourceHistoricalIndex(store, "a", { limit: 1 });
  await retain(store, qso("a-late"));
  await backfillSourceHistoricalIndex(store, "a", { limit: 1 });
  await backfillSourceHistoricalIndex(store, "a", { limit: 1 });
  assert.equal((await lookup(store)).reason, "index_incomplete");
  await backfillSourceHistoricalIndex(store, "a", { limit: 1 });
  assert.equal((await lookup(store)).rows.length, 3);
});

test("canonical intake publishes weak keys in its real atomic checkpoint", async (t) => {
  const h = await fixture(t);
  await h.store
    .statement(
      "UPDATE connections SET config=?,remote_identity='source' WHERE tenant='a' AND id='source'",
      JSON.stringify({ accountId: "source" }),
    )
    .run();
  await (
    await h.store.putPrivate("a", "source", "new-credential", "credential", {
      key: "browser:fixture",
      secret: "fixture",
      token: "fixture",
    })
  ).run();
  await h.store
    .statement(
      "UPDATE connections SET credential_version='new-credential' WHERE tenant='a' AND id='source'",
    )
    .run();
  const source = (await h.store.connection("a", "source"))!;
  await backfillSourceHistoricalIndex(h.store, "a");
  const response = () =>
    new Response(
      JSON.stringify({
        account: { uuid: "source" },
        operations: [],
        qsos: [qso("canonical")],
        meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
      }),
    );
  await pollSource(
    h.store,
    source,
    async () => response(),
    Date.now(),
    "sync",
    Date.now() - 300000,
  );
  const result = await lookup(h.store);
  assert.equal(result.status, "ready");
  assert.equal(result.rows.length, 1);
});

test("same-revision later watermarks retain their original encrypted body and can rebuild", async (t) => {
  const { store } = await fixture(t);
  const raw = qso("unchanged");
  const original = await retain(store, raw);
  await backfillSourceHistoricalIndex(store, "a");
  await store
    .statement(
      "UPDATE source_work SET synced_at=101 WHERE tenant='a' AND source='source' AND id='unchanged'",
    )
    .run();
  assert.equal((await lookup(store)).status, "ready");
  // Force a real rebuild to cover a retained older plaintext watermark.
  await store
    .statement(
      "UPDATE source_historical_index SET dirty=1 WHERE qso='unchanged'",
    )
    .run();
  const outcome = await backfillSourceHistoricalIndex(store, "a");
  assert.equal(outcome.published, 1);
  const result = await lookup(store);
  assert.equal(result.status, "ready");
  assert.equal(result.rows[0].syncedAt, 101);
  assert.equal(result.rows[0].privateId, original.privateId);
});

test("resolved purge and TTL/revocation retain localized possible competitors", async (t) => {
  const { store } = await fixture(t);
  await retain(store, qso("resolved"));
  const expired = await retain(
    store,
    qso("expired", { their: { call: "W2AW" } }),
  );
  await retain(store, qso("untouched", { their: { call: "W3AW" } }));
  await backfillSourceHistoricalIndex(store, "a");
  const before = (await lookup(store)).snapshot!;
  await store
    .statement(
      "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,baseline_hash,state,due_at,updated_at) VALUES('a','source','resolved','destination','g','hash','hash','adopted_existing',0,0)",
    )
    .run();
  await purgeResolvedSource(store);
  assert.equal(await guardCurrent(store, before), false);
  const archived = await store
    .statement("SELECT state,expires_at FROM source_work WHERE id='resolved'")
    .first();
  assert.deepEqual(archived, { state: "archived", expires_at: 0 });
  assert.equal((await lookup(store)).rows[0].qso, "resolved");
  assert.equal((await lookup(store, "W3AW")).rows[0].qso, "untouched");
  assert.equal((await lookup(store, "W4AW")).rows.length, 0);
  await store
    .statement(
      "UPDATE private_data SET expires_at=0,revoked_at=1 WHERE id=?",
      expired.privateId,
    )
    .run();
  await store
    .statement("UPDATE source_work SET expires_at=0 WHERE id='expired'")
    .run();
  assert.equal((await lookup(store, "W2AW")).rows[0].qso, "expired");
  assert.equal((await lookup(store, "W3AW")).status, "ready");
  assert.equal((await backfillSourceHistoricalIndex(store, "a")).examined, 0);
  // A missing body with no verified bucket cannot be localized safely.
  const unknown = await retain(store, qso("unindexed"));
  await store
    .statement("DELETE FROM private_data WHERE id=?", unknown.privateId)
    .run();
  const blocked = await backfillSourceHistoricalIndex(store, "a");
  assert.equal(blocked.held, 1);
  assert.equal((await lookup(store, "W3AW")).reason, "index_incomplete");
});

test("global matching policy changes invalidate snapshots but identical values do not", async (t) => {
  const { store } = await fixture(t);
  await retain(store, qso("q"));
  await backfillSourceHistoricalIndex(store, "a");
  let before = (await lookup(store)).snapshot!;
  await store
    .statement(
      "INSERT INTO reconciliation_policy(id,value) VALUES('delivery','v1')",
    )
    .run();
  assert.equal(await guardCurrent(store, before), false);
  before = (await lookup(store)).snapshot!;
  await store
    .statement(
      "UPDATE reconciliation_policy SET value='v1' WHERE id='delivery'",
    )
    .run();
  assert.equal(await guardCurrent(store, before), true);
  await store
    .statement(
      "UPDATE reconciliation_policy SET value='v2' WHERE id='delivery'",
    )
    .run();
  assert.equal(await guardCurrent(store, before), false);
  before = (await lookup(store)).snapshot!;
  await store
    .statement("DELETE FROM reconciliation_policy WHERE id='delivery'")
    .run();
  assert.equal(await guardCurrent(store, before), false);
});

test("payload replacement dirties known localization, including same-ID delete/reinsert", async (t) => {
  const { store } = await fixture(t);
  const raw = qso("body"),
    expected = await retain(store, raw);
  await backfillSourceHistoricalIndex(store, "a");
  const old = await store
    .statement(
      "SELECT envelope FROM private_data WHERE id=?",
      expected.privateId,
    )
    .first<string>("envelope");
  await store
    .statement(
      "UPDATE private_data SET envelope=json_set(envelope,'$.ciphertext','changed') WHERE id=?",
      expected.privateId,
    )
    .run();
  assert.equal((await lookup(store)).reason, "index_incomplete");
  assert.equal((await backfillSourceHistoricalIndex(store, "a")).held, 1);
  await store
    .statement(
      "UPDATE private_data SET envelope=? WHERE id=?",
      old,
      expected.privateId,
    )
    .run();
  await backfillSourceHistoricalIndex(store, "a");
  assert.equal((await lookup(store)).status, "ready");
  await store
    .statement("DELETE FROM private_data WHERE id=?", expected.privateId)
    .run();
  assert.equal((await lookup(store)).status, "ready");
  await (
    await store.putPrivate(
      "a",
      "source",
      expected.privateId,
      "source",
      raw,
      Date.now() + 3600000,
    )
  ).run();
  assert.equal((await lookup(store)).reason, "index_incomplete");
  await backfillSourceHistoricalIndex(store, "a");
  assert.notEqual(
    (await lookup(store)).rows[0].bodyVersion,
    expected.bodyVersion,
  );
});

test("published rows ahead of the rebuild cursor retain localization after expiry", async (t) => {
  const { store } = await fixture(t);
  await retain(store, qso("a"));
  const raw = qso("z"),
    expected = await retain(store, raw);
  await backfillSourceHistoricalIndex(store, "a", { limit: 1 });
  await store.db.batch(
    await sourceHistoricalPublication(
      store,
      "a",
      "source",
      raw,
      expected,
      await sourceHistoricalIndexKey(store, "a"),
      Date.now(),
    ),
  );
  await store
    .statement("DELETE FROM private_data WHERE id=?", expected.privateId)
    .run();
  await backfillSourceHistoricalIndex(store, "a", { limit: 100 });
  assert.equal((await lookup(store)).rows.length, 2);
});

test("lookup seeks bounded opaque buckets despite 4000 unrelated retained index entries", async (t) => {
  const { store } = await fixture(t);
  await retain(store, qso("wanted"));
  await backfillSourceHistoricalIndex(store, "a");
  await store
    .statement(
      "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,config,created_at) VALUES('a','inactive','lofi','inactive','inactive','paused','{}',0)",
    )
    .run();
  await store
    .statement(
      "WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4000) INSERT INTO source_historical_index(tenant,source,qso,revision,synced_at,private_id,key_id,bucket_hash) SELECT 'a','inactive',CAST(x AS TEXT),'r',0,'p',?,? FROM n",
      (await sourceHistoricalIndexKey(store, "a")).keyId,
      "x".repeat(43),
    )
    .run();
  const queries: { sql: string; params: (string | number | null)[] }[] = [];
  const measured = new Proxy(store, {
    get(target, property, receiver) {
      if (property === "statement")
        return (sql: string, ...params: (string | number | null)[]) => {
          queries.push({ sql, params });
          return target.statement(sql, ...params);
        };
      return Reflect.get(target, property, receiver);
    },
  });
  const result = await lookup(measured);
  assert.equal(result.status, "ready");
  assert.equal(result.rows.length, 1);
  assert.equal(queries.length, 3); // State/key envelope, indexed candidates, exact snapshot recheck.
  const query = queries.find((q) => q.sql.includes("json_each(?1) requested"))!;
  const plan = await store
    .statement(`EXPLAIN QUERY PLAN ${query.sql}`, ...query.params)
    .all<{ detail: string }>();
  assert.ok(
    plan.results.some((r) =>
      r.detail.includes(
        "SEARCH i USING INDEX source_historical_bucket (tenant=? AND key_id=? AND bucket_hash=?)",
      ),
    ),
  );
  assert.ok(!plan.results.some((r) => r.detail.startsWith("SCAN i")));
  const read = await store.statement(query.sql, ...query.params).all();
  assert.ok(
    read.meta.rows_read < 140,
    `one candidate should not scan 4000 unrelated rows: ${read.meta.rows_read}`,
  );
  const captured = result.snapshot!;
  await store
    .statement(
      "UPDATE connections SET status='active' WHERE tenant='a' AND id='inactive'",
    )
    .run();
  assert.equal(await guardCurrent(store, captured), false);
  assert.equal((await lookup(store)).reason, "index_incomplete");
});

test("backfill caps ciphertext materialization and resumes overflowed rows without a coverage shortcut", async (t) => {
  const { store } = await fixture(t);
  for (const id of ["a", "b", "c"])
    await retain(store, qso(id, { notes: "x".repeat(1_700_000) }));
  const first = await backfillSourceHistoricalIndex(store, "a");
  assert.deepEqual(first, {
    examined: 3,
    published: 1,
    held: 2,
    rebuilding: false,
  });
  assert.equal((await lookup(store)).reason, "index_incomplete");
  const second = await backfillSourceHistoricalIndex(store, "a");
  assert.equal(second.published, 1);
  assert.equal((await lookup(store)).reason, "index_incomplete");
  assert.equal((await backfillSourceHistoricalIndex(store, "a")).published, 1);
  assert.equal((await lookup(store)).rows.length, 3);
});

test("normal repair recovers an unindexed purged body once, then preserves the resolved replay shortcut", async (t) => {
  const { store } = await fixture(t);
  await store
    .statement(
      "UPDATE connections SET config=?,remote_identity='source' WHERE tenant='a' AND id='source'",
      JSON.stringify({ accountId: "source" }),
    )
    .run();
  await (
    await store.putPrivate("a", "source", "repair-credential", "credential", {
      key: "browser:fixture",
      secret: "fixture",
      token: "fixture",
    })
  ).run();
  await store
    .statement(
      "UPDATE connections SET credential_version='repair-credential' WHERE tenant='a' AND id='source'",
    )
    .run();
  const source = (await store.connection("a", "source"))!;
  const raw = qso("legacy-resolved");
  await retain(store, raw);
  await store
    .statement(
      "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,baseline_hash,state,due_at,updated_at) VALUES('a','source','legacy-resolved','destination','g','hash','hash','adopted_existing',0,0)",
    )
    .run();
  await purgeResolvedSource(store);
  assert.equal((await backfillSourceHistoricalIndex(store, "a")).held, 1);
  const reply = async () =>
    new Response(
      JSON.stringify({
        account: { uuid: "source" },
        operations: [],
        qsos: [raw],
        meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
      }),
    );
  const now = Date.now();
  await pollSource(store, source, reply, now, "repair", now - 600000);
  assert.equal((await lookup(store)).rows[0].qso, "legacy-resolved");
  assert.equal(
    await store
      .statement("SELECT count(*) n FROM private_data WHERE kind='source'")
      .first<number>("n"),
    1,
  );
  await purgeResolvedSource(store);
  await pollSource(store, source, reply, Date.now(), "repair", now - 300000);
  assert.equal(
    await store
      .statement("SELECT count(*) n FROM private_data WHERE kind='source'")
      .first<number>("n"),
    0,
  );
  assert.equal((await lookup(store)).rows[0].qso, "legacy-resolved");
});
