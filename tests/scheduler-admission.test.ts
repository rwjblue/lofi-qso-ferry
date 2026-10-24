import assert from "node:assert/strict";
import test from "node:test";
import { database } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";
import { measuredDatabase } from "../src/database-metrics.ts";
import { Store } from "../src/store.ts";
import {
  admitBackgroundSource,
  backgroundSources,
  type BackgroundSource,
} from "../src/scheduler-admission.ts";

const now = Date.parse("2027-01-01T00:00:00Z");

async function account(store: Store, tenant: string, count = 1) {
  await store
    .statement(
      "INSERT INTO accounts(id,email,user_handle,verified_at) VALUES(?,?,?,0)",
      tenant,
      `${tenant}@example.test`,
      tenant,
    )
    .run();
  await store.db.batch(
    Array.from({ length: count }, (_, index) => {
      const id = `source-${index.toString().padStart(2, "0")}`;
      return store.statement(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,created_at) VALUES(?,?,'lofi',?,?,'active',0)",
        tenant,
        id,
        id,
        id,
      );
    }),
  );
}

async function fixture() {
  const h = await database();
  await applyAdditionalMigrations(h.db);
  return h;
}

async function turn(store: Store, source: BackgroundSource) {
  const lease = await store.claim(source.tenant, `cycle:${source.id}`, now);
  assert(lease);
  try {
    assert(await admitBackgroundSource(store, source, lease, now));
  } finally {
    await store.release(lease);
  }
}

test("100 accounts get independent background turns before repeats, including a many-source import account", async () => {
  const h = await fixture();
  try {
    for (let index = 0; index < 100; index++)
      await account(
        h.store,
        `a${index.toString().padStart(3, "0")}`,
        index === 0 ? 5 : 1,
      );
    await h.store
      .statement(
        "WITH RECURSIVE imported(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM imported WHERE n<2000) INSERT INTO source_work(tenant,source,id,kind,private_id,revision,expires_at) SELECT 'a000','source-00','import-'||n,'qso','private-'||n,'r1',? FROM imported",
        now + 86_400_000,
      )
      .run();
    // Canonical live polling can keep refreshing the same ordering without
    // changing background admission; all turns use the same injected clock.
    await h.store.statement("UPDATE connections SET last_poll_at=?", now).run();
    const visited: string[] = [];
    for (let index = 0; index < 100; index++) {
      const [source] = await backgroundSources(
        new Store(h.db, h.store.keys),
        now,
        1,
      );
      assert(source);
      visited.push(source.tenant);
      await turn(h.store, source);
      // A failed or deferred attempt has no success bookkeeping to perform.
    }
    assert.equal(new Set(visited).size, 100);
    const [next] = await backgroundSources(h.store, now, 1);
    assert.equal(next?.tenant, "a000");
    assert.equal(next?.id, "source-01");
    assert.equal(next?.account_turn, 1);
    assert.equal(next?.source_turn, 0);
    assert.equal(
      (
        await h.store
          .statement("SELECT COUNT(*) n FROM cursors")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    assert.equal(
      (
        await h.store
          .statement("SELECT COUNT(*) n FROM attempts")
          .first<{ n: number }>()
      )?.n,
      0,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("admission uses one fenced atomic RPC and stale account or source snapshots cannot consume a turn", async () => {
  const h = await fixture();
  try {
    await account(h.store, "a", 2);
    const [source] = await backgroundSources(h.store, now, 1);
    assert(source);
    const lease = await h.store.claim("a", `cycle:${source.id}`, now);
    assert(lease);
    const measured = measuredDatabase(h.db);
    const store = new Store(measured.database, h.store.keys);
    assert(await admitBackgroundSource(store, source, lease, now));
    assert.equal(measured.metrics.calls, 1);
    assert.equal(measured.metrics.statements, 3);
    assert.equal(await admitBackgroundSource(store, source, lease, now), false);
    await h.store.release(lease);
    const [next] = await backgroundSources(h.store, now, 1);
    assert(next);
    const nextLease = await h.store.claim("a", `cycle:${next.id}`, now);
    assert(nextLease);
    assert.equal(
      await admitBackgroundSource(
        h.store,
        { ...next, account_turn: 0 },
        nextLease,
        now,
      ),
      false,
    );
    assert.equal(
      await admitBackgroundSource(
        h.store,
        { ...next, source_turn: 1 },
        nextLease,
        now,
      ),
      false,
    );
    assert.equal(
      (
        await h.store
          .statement("SELECT turn FROM scheduler_background_clock")
          .first<{ turn: number }>()
      )?.turn,
      1,
    );
    assert(await admitBackgroundSource(h.store, next, nextLease, now));
  } finally {
    await h.mf.dispose();
  }
});

test("expired, replaced and cross-tenant cycle leases cannot advance admission", async () => {
  const h = await fixture();
  try {
    await account(h.store, "a");
    await account(h.store, "b");
    const [source] = await backgroundSources(h.store, now, 1);
    assert(source);
    const lease = await h.store.claim("a", `cycle:${source.id}`, now, 1);
    assert(lease);
    assert.equal(
      await admitBackgroundSource(h.store, source, lease, now + 1),
      false,
    );
    const replacement = await h.store.claim("a", lease.scope, now + 1);
    assert(replacement);
    assert.equal(
      await admitBackgroundSource(h.store, source, lease, now + 1),
      false,
    );
    assert.equal(
      await admitBackgroundSource(
        h.store,
        source,
        { ...replacement, tenant: "b" },
        now + 1,
      ),
      false,
    );
    assert.equal(
      await admitBackgroundSource(
        h.store,
        source,
        { ...replacement, scope: "poll:source-00:sync" },
        now + 1,
      ),
      false,
    );
    assert.equal(
      (
        await h.store
          .statement("SELECT turn FROM scheduler_background_clock")
          .first<{ turn: number }>()
      )?.turn,
      0,
    );
    assert(await admitBackgroundSource(h.store, source, replacement, now + 1));
  } finally {
    await h.mf.dispose();
  }
});

test("selection skips occupied sources without blocking other sources or accounts", async () => {
  const h = await fixture();
  try {
    await account(h.store, "a", 2);
    await account(h.store, "b");
    const first = await h.store.claim("a", "cycle:source-00", now);
    assert(first);
    assert.deepEqual(
      (await backgroundSources(h.store, now)).map(({ tenant, id }) => [
        tenant,
        id,
      ]),
      [
        ["a", "source-01"],
        ["b", "source-00"],
      ],
    );
    const second = await h.store.claim("a", "cycle:source-01", now);
    assert(second);
    assert.deepEqual(
      (await backgroundSources(h.store, now)).map(({ tenant }) => tenant),
      ["b"],
    );
    await h.store.release(first);
    assert.equal((await backgroundSources(h.store, now, 1))[0]?.tenant, "a");
  } finally {
    await h.mf.dispose();
  }
});

test("migration and lifecycle triggers preserve order while excluding paused, restored and deleted sources", async () => {
  const h = await database();
  try {
    await account(h.store, "a", 2);
    await account(h.store, "b");
    await h.store
      .statement("UPDATE accounts SET status='restore_locked' WHERE id='b'")
      .run();
    await applyAdditionalMigrations(h.db);
    const [source] = await backgroundSources(h.store, now);
    assert(source);
    await turn(h.store, source);
    const before = await h.store
      .statement(
        "SELECT tenant,source,last_turn FROM scheduler_background_sources ORDER BY tenant,source",
      )
      .all();
    await h.store
      .statement("UPDATE accounts SET status='paused' WHERE id='a'")
      .run();
    assert.deepEqual(await backgroundSources(h.store, now), []);
    await h.store
      .statement("UPDATE accounts SET status='active' WHERE id='a'")
      .run();
    assert.equal((await backgroundSources(h.store, now))[0]?.id, "source-01");
    await h.store
      .statement(
        "UPDATE connections SET status='disabled' WHERE tenant='a' AND id='source-01'",
      )
      .run();
    assert.equal((await backgroundSources(h.store, now))[0]?.id, "source-00");
    await h.store
      .statement(
        "UPDATE connections SET status='active' WHERE tenant='a' AND id='source-01'",
      )
      .run();
    assert.deepEqual(
      (
        await h.store
          .statement(
            "SELECT tenant,source,last_turn FROM scheduler_background_sources ORDER BY tenant,source",
          )
          .all()
      ).results,
      before.results,
    );
    await h.store.statement("DELETE FROM connections WHERE tenant='a'").run();
    assert.deepEqual(await backgroundSources(h.store, now), []);
    await h.store
      .statement("UPDATE accounts SET status='active' WHERE id='b'")
      .run();
    assert.equal((await backgroundSources(h.store, now))[0]?.tenant, "b");
    await h.store.statement("DELETE FROM connections WHERE tenant='b'").run();
    // Retained comparison-key state now protects account history even after
    // source connections are removed. Deletion cannot silently discard it.
    await assert.rejects(
      () => h.store.statement("DELETE FROM accounts WHERE id='b'").run(),
      /FOREIGN KEY/,
    );
    assert.equal(
      (
        await h.store
          .statement(
            "SELECT count(*) n FROM source_historical_state WHERE tenant='b'",
          )
          .first<{ n: number }>()
      )?.n,
      1,
    );
    assert.deepEqual(await backgroundSources(h.store, now), []);
  } finally {
    await h.mf.dispose();
  }
});

test("a selected source that becomes inactive cannot advance its account", async () => {
  const h = await fixture();
  try {
    await account(h.store, "a");
    const [source] = await backgroundSources(h.store, now);
    assert(source);
    const lease = await h.store.claim("a", `cycle:${source.id}`, now);
    assert(lease);
    await h.store
      .statement("UPDATE connections SET status='disabled' WHERE tenant='a'")
      .run();
    assert.equal(
      await admitBackgroundSource(h.store, source, lease, now),
      false,
    );
    await h.store
      .statement("UPDATE connections SET status='active' WHERE tenant='a'")
      .run();
    await h.store
      .statement("UPDATE accounts SET status='restore_locked' WHERE id='a'")
      .run();
    assert.equal(
      await admitBackgroundSource(h.store, source, lease, now),
      false,
    );
    assert.equal(
      (
        await h.store
          .statement("SELECT turn FROM scheduler_background_clock")
          .first<{ turn: number }>()
      )?.turn,
      0,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("bounded background selection uses account and source order indexes in one RPC", async () => {
  const h = await fixture();
  try {
    for (let index = 0; index < 30; index++)
      await account(h.store, `tenant-${index}`);
    let query = "";
    const captured = new Proxy(h.db, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            query = sql;
            return target.prepare(sql);
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const measured = measuredDatabase(captured);
    const rows = await backgroundSources(
      new Store(measured.database, h.store.keys),
      now,
      1000,
    );
    assert.equal(rows.length, 16);
    assert.equal(measured.metrics.calls, 1);
    const plan = await h.db
      .prepare(`EXPLAIN QUERY PLAN ${query}`)
      .bind(now, 16)
      .all<{ detail: string }>();
    const details = plan.results.map(({ detail }) => detail).join("\n");
    assert.match(details, /scheduler_background_accounts_due/);
    assert.match(details, /scheduler_background_sources_due/);
    assert.doesNotMatch(details, /SCAN c\b|USE TEMP B-TREE FOR ORDER BY/);
  } finally {
    await h.mf.dispose();
  }
});
