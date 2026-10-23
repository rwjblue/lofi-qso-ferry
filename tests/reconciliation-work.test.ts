import assert from "node:assert/strict";
import test from "node:test";
import { database, keys, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";
import { Store } from "../src/store.ts";
import { lockRestoredDatabase } from "../src/restore.ts";
import { measuredDatabase } from "../src/database-metrics.ts";
import {
  finishReconciliationWork,
  reconciliationCheckDue,
  reconciliationPreflight,
  reconciliationPreflightBatch,
  reconciliationCheckStatement,
  finishReconciliationWorkStatement,
  recordReconciliationCheck,
  selectReconciliationWork,
  syncReconciliationPolicy,
  wakeReconciliationWork,
} from "../src/reconciliation-work.ts";

const now = Date.now();
const source = { tenant: "a", id: "source" };
const key = {
  tenant: "a",
  source: "source",
  qso: "q1",
  destination: "destination",
};
async function fixture() {
  const h = await database();
  await applyAdditionalMigrations(h.db);
  await seed(h.store);
  return h;
}
async function qso(
  store: Store,
  id: string,
  options: {
    operation?: string;
    priority?: "live" | "background";
    tenant?: string;
  } = {},
) {
  const tenant = options.tenant ?? "a";
  await store
    .statement(
      "INSERT INTO source_work(tenant,source,id,kind,operation_id,private_id,revision,expires_at,priority) VALUES(?,'source',?,'qso',?,?,'r1',?,?)",
      tenant,
      id,
      options.operation ?? null,
      `private-${id}`,
      now + 86400000,
      options.priority ?? "background",
    )
    .run();
}
async function version(store: Store, id = "q1") {
  const row = await store
    .statement(
      "SELECT version FROM reconciliation_work WHERE tenant='a' AND source='source' AND qso=?",
      id,
    )
    .first<{ version: number }>();
  assert(row);
  return row.version;
}
async function hold(store: Store) {
  await store.observe(key, "generation", "hash", 30);
  await store
    .statement(
      "UPDATE ledger SET state='history_ambiguous' WHERE tenant='a' AND source='source' AND qso='q1'",
    )
    .run();
  const v = await version(store);
  assert(
    await recordReconciliationCheck(
      store,
      key,
      "generation",
      { state: "history_ambiguous" },
      now,
      v,
    ),
  );
  assert(await finishReconciliationWork(store, source, "q1", v, now));
  return v;
}

test("one-query reconciliation preflight preserves generation, memo, attempt and tenant fences", async () => {
  const h = await fixture();
  try {
    await qso(h.store, "q1");
    await h.store.observe(key, "generation", "hash", 30);
    const measured = measuredDatabase(h.db);
    const store = new Store(measured.database, h.store.keys);
    const candidate = await reconciliationPreflight(
      store,
      key,
      "generation",
      now,
    );
    assert.equal(candidate?.source_hash, "hash");
    assert.equal(measured.metrics.calls, 1);
    assert.equal(measured.metrics.statements, 1);
    assert.equal(
      await reconciliationPreflight(store, key, "stale-generation", now),
      null,
    );
    for (const changed of [
      { tenant: "other" },
      { source: "other" },
      { qso: "other" },
      { destination: "other" },
    ])
      assert.equal(
        await reconciliationPreflight(
          store,
          { ...key, ...changed },
          "generation",
          now,
        ),
        null,
      );
    await h.store
      .statement(
        "UPDATE ledger SET state='history_ambiguous' WHERE tenant='a' AND source='source' AND qso='q1'",
      )
      .run();
    await recordReconciliationCheck(
      h.store,
      key,
      "generation",
      { state: "history_ambiguous" },
      now,
      await version(h.store),
    );
    assert.equal(
      await reconciliationPreflight(store, key, "generation", now),
      null,
    );
    assert(
      await reconciliationPreflight(store, key, "generation", now + 86400000),
    );
    await h.store
      .statement("UPDATE reconciliation_checks SET generation='old'")
      .run();
    assert(await reconciliationPreflight(store, key, "generation", now));
    await h.store.db.batch([
      h.store.statement(
        "INSERT INTO attempts(tenant,id,source,qso,destination,generation,payload_id,payload_hash,credential_version,created_at,source_hash) VALUES('a','attempt','source','q1','destination','generation','payload','hash','v1',0,'hash')",
      ),
      h.store.statement(
        "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a','attempt','prepared',0,0)",
      ),
    ]);
    for (const state of [
      "prepared",
      "uncertain",
      "submitted",
      "reconciliation_required",
    ]) {
      await h.store.statement("UPDATE attempt_state SET state=?", state).run();
      assert.equal(
        await reconciliationPreflight(store, key, "generation", now),
        null,
      );
    }
    for (const state of ["delivered", "observed", "rejected", "cancelled"]) {
      await h.store.statement("UPDATE attempt_state SET state=?", state).run();
      assert(await reconciliationPreflight(store, key, "generation", now));
    }
    for (const values of [
      ["changed", "unknown", null],
      ["inventory_pending", "adoption_conflict", null],
      ["inventory_pending", "unknown", "mapped"],
    ] as const) {
      await h.store
        .statement(
          "UPDATE ledger SET state=?,provenance=?,remote_id=?",
          ...values,
        )
        .run();
      assert.equal(
        await reconciliationPreflight(store, key, "generation", now),
        null,
      );
    }
  } finally {
    await h.mf.dispose();
  }
});

test("batched preflight isolates tenants and excludes stale, mapped, attempted and remembered routes", async () => {
  const h = await fixture();
  try {
    await seed(h.store, "b");
    const names = [
      "ready",
      "changed",
      "mapped",
      "quarantined",
      "memo",
      "attempt",
      "stale",
    ];
    for (const id of names) {
      await qso(h.store, id);
      await h.store.observe({ ...key, qso: id }, "g1", "hash", 30);
    }
    await h.store.observe(
      { ...key, tenant: "b", qso: "ready" },
      "g1",
      "other-tenant",
      30,
    );
    await h.store.db.batch([
      h.store.statement(
        "UPDATE ledger SET state='changed' WHERE tenant='a' AND qso='changed'",
      ),
      h.store.statement(
        "UPDATE ledger SET remote_id='already-mapped' WHERE tenant='a' AND qso='mapped'",
      ),
      h.store.statement(
        "UPDATE ledger SET provenance='adoption_conflict' WHERE tenant='a' AND qso='quarantined'",
      ),
      h.store.statement(
        "INSERT INTO reconciliation_checks VALUES('a','source','memo','destination','g1',?,?)",
        now,
        now + 300000,
      ),
      h.store.statement(
        "INSERT INTO attempts(tenant,id,source,qso,destination,generation,payload_id,payload_hash,credential_version,created_at,source_hash) VALUES('a','batch-attempt','source','attempt','destination','g1','payload','hash','v1',0,'hash')",
      ),
      h.store.statement(
        "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a','batch-attempt','uncertain',0,0)",
      ),
    ]);
    const measured = measuredDatabase(h.db);
    const store = new Store(measured.database, h.store.keys);
    const rows = await reconciliationPreflightBatch(
      store,
      source,
      names.map((id) => ({
        qso: id,
        destination: "destination",
        generation: id === "stale" ? "old" : "g1",
      })),
      now,
    );
    assert.equal(measured.metrics.calls, 1);
    assert.deepEqual(
      rows.map((row) => [
        row.tenant,
        row.qso,
        row.source_hash,
        row.destination_kind,
      ]),
      [["a", "ready", "hash", "qrz"]],
    );
    assert.deepEqual(
      await reconciliationPreflightBatch(store, source, [], now),
      [],
    );
    assert.equal(measured.metrics.calls, 1);
  } finally {
    await h.mf.dispose();
  }
});

test("batched completion cannot memoize changed outcomes or park newer work", async () => {
  const h = await fixture();
  try {
    for (const id of ["valid", "reason", "state", "version"]) {
      await qso(h.store, id);
      await h.store.observe({ ...key, qso: id }, "g1", "hash", 30);
      await h.store
        .statement(
          "UPDATE ledger SET state='history_ambiguous',reason='review' WHERE qso=?",
          id,
        )
        .run();
    }
    const pending: D1PreparedStatement[] = [];
    for (const id of ["valid", "reason", "state", "version"]) {
      const memo = reconciliationCheckStatement(
        h.store,
        { ...key, qso: id },
        "g1",
        { state: "history_ambiguous", reason: "review" },
        now,
        1,
      );
      const finish = finishReconciliationWorkStatement(
        h.store,
        source,
        id,
        1,
        now,
      );
      assert(memo && finish);
      pending.push(memo, finish);
    }
    await h.store.db.batch([
      h.store.statement(
        "UPDATE ledger SET reason='new review' WHERE qso='reason'",
      ),
      h.store.statement(
        "UPDATE ledger SET state='inventory_pending' WHERE qso='state'",
      ),
      h.store.statement(
        "UPDATE source_work SET revision='r2' WHERE id='version'",
      ),
    ]);
    const rows = await h.store.db.batch(pending);
    assert.deepEqual(
      rows.map((row) => row.results.length),
      [1, 1, 0, 1, 0, 1, 0, 0],
    );
    assert.equal(
      (
        await h.store
          .statement("SELECT COUNT(*) n FROM reconciliation_checks")
          .first<{ n: number }>()
      )?.n,
      1,
    );
    assert.equal(
      (
        await h.store
          .statement(
            "SELECT next_due_at FROM reconciliation_work WHERE qso='version'",
          )
          .first<{ next_due_at: number }>()
      )?.next_due_at,
      0,
    );
    assert.equal(
      reconciliationCheckStatement(
        h.store,
        key,
        "g1",
        { state: "inventory_pending" },
        now,
      ),
      null,
    );
    assert.equal(
      finishReconciliationWorkStatement(
        h.store,
        source,
        "valid",
        undefined,
        now,
      ),
      null,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("indexed scheduling preserves live priority, context preference, cutoff and tenant fences", async () => {
  const h = await fixture();
  try {
    await seed(h.store, "b");
    await qso(h.store, "q1");
    await qso(h.store, "live", { priority: "live" });
    await qso(h.store, "waiting-context", { operation: "missing" });
    await qso(h.store, "foreign", { tenant: "b" });
    assert.deepEqual(
      (await selectReconciliationWork(h.store, source, { limit: 3, now })).map(
        (x) => x.id,
      ),
      ["live", "q1", "waiting-context"],
    );
    assert.deepEqual(
      (
        await selectReconciliationWork(h.store, source, {
          limit: 3,
          now,
          priority: "background",
          readyContextOnly: true,
        })
      ).map((x) => x.id),
      ["q1"],
    );
    await h.store
      .statement(
        "UPDATE source_work SET processed_at=? WHERE tenant='a' AND id='q1'",
        now,
      )
      .run();
    assert.equal(
      (
        await selectReconciliationWork(h.store, source, {
          limit: 3,
          now,
          priority: "background",
          readyContextOnly: true,
          processedBefore: now,
        })
      ).length,
      0,
    );
    await h.store
      .statement(
        "UPDATE source_work SET state='blocked' WHERE tenant='a' AND id='q1'",
      )
      .run();
    assert.equal(
      (
        await selectReconciliationWork(h.store, source, {
          limit: 3,
          now,
          priority: "background",
          readyContextOnly: true,
        })
      ).length,
      0,
    );
    await h.store
      .statement(
        "UPDATE source_work SET state='pending' WHERE tenant='a' AND id='q1'",
      )
      .run();
    assert.equal(
      (
        await selectReconciliationWork(h.store, source, {
          limit: 3,
          now,
          priority: "background",
          readyContextOnly: true,
        })
      ).length,
      1,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("ready hints follow base context state, ciphertext revocation and expiration", async () => {
  const h = await fixture();
  try {
    await qso(h.store, "q1", { operation: "op" });
    const select = () =>
      selectReconciliationWork(h.store, source, {
        limit: 10,
        now,
        readyContextOnly: true,
      });
    assert.equal((await select()).length, 0);
    await h.db.batch([
      h.store.statement(
        "INSERT INTO private_data(tenant,connection,id,kind,envelope,created_at,expires_at) VALUES('a','source','op-private','source','{}',0,?)",
        now + 86400000,
      ),
      h.store.statement(
        "INSERT INTO source_work(tenant,source,id,kind,operation_id,private_id,revision,state,expires_at) VALUES('a','source','op','operation','op','op-private','r1','context',?)",
        now + 86400000,
      ),
    ]);
    assert.equal((await select()).length, 1);
    await h.store
      .statement("UPDATE private_data SET revoked_at=1 WHERE id='op-private'")
      .run();
    assert.equal((await select()).length, 0);
    await h.store
      .statement(
        "UPDATE private_data SET revoked_at=NULL,expires_at=? WHERE id='op-private'",
        now - 1,
      )
      .run();
    assert.equal((await select()).length, 0);
    await h.store
      .statement(
        "UPDATE private_data SET expires_at=? WHERE id='op-private'",
        now + 86400000,
      )
      .run();
    assert.equal((await select()).length, 1);
    await h.store
      .statement(
        "UPDATE source_work SET state='pending' WHERE id='op' AND kind='operation'",
      )
      .run();
    assert.equal((await select()).length, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("stable exceptions park, source edits wake, and stale completions cannot hide edits", async () => {
  const h = await fixture();
  try {
    await qso(h.store, "q1");
    const old = await hold(h.store);
    assert.equal(
      await reconciliationCheckDue(h.store, key, "generation", now + 300000),
      false,
    );
    assert.equal(
      (
        await selectReconciliationWork(h.store, source, {
          limit: 10,
          now: now + 300000,
        })
      ).length,
      0,
    );
    assert.equal(
      (
        await selectReconciliationWork(h.store, source, {
          limit: 10,
          now: now + 300000,
          qso: "q1",
        })
      ).length,
      1,
    );
    await h.store
      .statement("UPDATE source_work SET revision='r2' WHERE id='q1'")
      .run();
    assert.equal(
      await reconciliationCheckDue(h.store, key, "generation", now + 300000),
      true,
    );
    assert.equal(
      await recordReconciliationCheck(
        h.store,
        key,
        "generation",
        { state: "history_ambiguous" },
        now,
        old,
      ),
      false,
    );
    assert.equal(
      await finishReconciliationWork(h.store, source, "q1", old, now),
      false,
    );
    assert.equal(
      (
        await selectReconciliationWork(h.store, source, {
          limit: 10,
          now: now + 300000,
        })
      ).length,
      1,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("retention extension and credential rewrapping do not requeue stable reviews", async () => {
  const h = await fixture();
  try {
    await qso(h.store, "q1", { operation: "op" });
    await h.db.batch([
      h.store.statement(
        "INSERT INTO private_data(tenant,connection,id,kind,envelope,created_at,expires_at) VALUES('a','source','op-private','source','{}',0,?)",
        now + 86_400_000,
      ),
      h.store.statement(
        "INSERT INTO source_work(tenant,source,id,kind,operation_id,private_id,revision,state,expires_at) VALUES('a','source','op','operation','op','op-private','r1','context',?)",
        now + 86_400_000,
      ),
    ]);
    const held = await hold(h.store);
    await h.db.batch([
      h.store.statement(
        "UPDATE source_work SET expires_at=? WHERE id='op'",
        now + 2 * 86_400_000,
      ),
      h.store.statement(
        "UPDATE private_data SET expires_at=? WHERE id='op-private'",
        now + 2 * 86_400_000,
      ),
      h.store.statement(
        "UPDATE private_data SET envelope='{}' WHERE kind='credential'",
      ),
    ]);
    assert.equal(await version(h.store), held);
    assert.equal(
      await reconciliationCheckDue(h.store, key, "generation", now + 300_000),
      false,
    );
    assert.equal(
      (
        await selectReconciliationWork(h.store, source, {
          limit: 10,
          now: now + 300_000,
        })
      ).length,
      0,
    );
    await h.store
      .statement("UPDATE source_work SET revision='r2' WHERE id='op'")
      .run();
    assert.equal(
      await reconciliationCheckDue(h.store, key, "generation", now),
      true,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("connection routing and credentials, explicit inventory and gate changes invalidate checks", async () => {
  const h = await fixture();
  try {
    await qso(h.store, "q1");
    await syncReconciliationPolicy(h.store, "closed");
    await hold(h.store);
    const held = await version(h.store);
    await syncReconciliationPolicy(h.store, "closed");
    assert.equal(await version(h.store), held);
    await h.store
      .statement(
        "UPDATE connections SET config=json_set(config,'$.lastSuccessfulPollAt',1) WHERE id='destination'",
      )
      .run();
    assert.equal(
      await reconciliationCheckDue(h.store, key, "generation", now),
      false,
    );
    await h.store
      .statement(
        "UPDATE connections SET config=json_set(config,'$.stationCallsign','W1AW') WHERE id='destination'",
      )
      .run();
    assert.equal(
      await reconciliationCheckDue(h.store, key, "generation", now),
      true,
    );
    await hold(h.store);
    await h.store
      .statement(
        "UPDATE connections SET credential_version='v2' WHERE id='destination'",
      )
      .run();
    assert.equal(
      await reconciliationCheckDue(h.store, key, "generation", now),
      true,
    );
    await hold(h.store);
    await wakeReconciliationWork(h.store, source, ["q1"], "destination");
    assert.equal(
      await reconciliationCheckDue(h.store, key, "generation", now),
      true,
    );
    await hold(h.store);
    await syncReconciliationPolicy(h.store, "boundary-verified");
    assert.equal(
      await reconciliationCheckDue(h.store, key, "generation", now),
      true,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("unresolved inventory retries next run without repeatedly reading stable destinations", async () => {
  const h = await fixture();
  try {
    await qso(h.store, "q1");
    await h.store.observe(key, "generation", "hash", 30);
    const v = await version(h.store);
    await recordReconciliationCheck(
      h.store,
      key,
      "generation",
      { state: "inventory_pending" },
      now,
      v,
    );
    await finishReconciliationWork(h.store, source, "q1", v, now);
    assert.equal(
      await reconciliationCheckDue(h.store, key, "generation", now + 299999),
      false,
    );
    assert.equal(
      (
        await selectReconciliationWork(h.store, source, {
          limit: 10,
          now: now + 299999,
        })
      ).length,
      0,
    );
    assert.equal(
      (
        await selectReconciliationWork(h.store, source, {
          limit: 10,
          now: now + 300000,
        })
      ).length,
      1,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("selecting a bounded batch reads only indexed candidates in a large backlog", async () => {
  const h = await fixture();
  try {
    await h.store
      .statement(
        "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<4000) INSERT INTO source_work(tenant,source,id,kind,private_id,revision,expires_at) SELECT 'a','source','q'||n,'qso','p'||n,'r1',? FROM seq",
        now + 86400000,
      )
      .run();
    const reads: number[] = [];
    const measured = new Store(h.db, keys);
    const statement = measured.statement.bind(measured);
    measured.statement = (sql, ...params) =>
      new Proxy(statement(sql, ...params), {
        get(target, property) {
          if (property === "all")
            return async () => {
              const result = await target.all();
              reads.push(result.meta.rows_read);
              return result;
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const rows = await selectReconciliationWork(measured, source, {
      limit: 25,
      now,
      priority: "background",
      readyContextOnly: true,
    });
    assert.equal(rows.length, 25);
    assert.equal(reads.length, 1);
    assert(reads[0]! < 200, JSON.stringify(reads));
  } finally {
    await h.mf.dispose();
  }
});

test("ledger changes promote queued work while direct mutation receipts exclude trigger updates", async () => {
  const h = await fixture();
  try {
    await qso(h.store, "q1");
    await hold(h.store);
    const result = await h.store
      .statement(
        "UPDATE ledger SET state='changed' WHERE tenant='a' AND source='source' AND qso='q1' RETURNING qso",
      )
      .run();
    assert.equal(result.results.length, 1);
    assert(
      result.meta.changes > 1,
      "D1 includes scheduling trigger updates in meta.changes",
    );
    assert.equal(
      (
        await selectReconciliationWork(h.store, source, {
          limit: 10,
          now,
          priority: "live",
        })
      ).length,
      1,
    );
    const locked = await lockRestoredDatabase(h.db);
    assert.equal(locked.lockedAccounts, 1);
    assert.equal(locked.disabledConnections, 2);
    assert.equal(locked.blockedAttempts, 0);
  } finally {
    await h.mf.dispose();
  }
});
