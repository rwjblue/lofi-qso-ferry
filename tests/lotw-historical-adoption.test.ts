import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { AdifRecord } from "../src/adif.ts";
import { adoptLotwHistoricalBatch } from "../src/lotw-historical-adoption.ts";
import { backfillLotwOwnership } from "../src/lotw-ownership.ts";
import {
  adoptHistory,
  adoptHistoryBatch,
  comparableRemote,
  type HistoryAdoptionInput,
} from "../src/reconcile.ts";
import {
  type ReconciliationLedger,
  reconciliationPreflight,
  reconciliationPreflightBatch,
} from "../src/reconciliation-work.ts";
import { canonical, type Envelope, open, sha256 } from "../src/security.ts";
import { Store } from "../src/store.ts";
import { applyMigration, database, keys, seed } from "./helpers.ts";

const source = { tenant: "a", id: "source" };
const raw = (changes: AdifRecord = {}): AdifRecord => ({
  STATION_CALLSIGN: "N0CALL",
  CALL: "W1AW",
  QSO_DATE: "20261024",
  TIME_ON: "2359",
  BAND: "20M",
  MODE: "DATA",
  APP_LOTW_MODEGROUP: "DATA",
  MY_GRIDSQUARE: "FN31",
  QSL_RCVD: "Y",
  COMMENT: "original raw report",
  ...changes,
});
async function fixture(t: TestContext, size = 1, legacyState?: string | null) {
  const h = await database();
  t.after(() => h.mf.dispose());
  await seed(h.store);
  for (const [id, remote, status] of [
    ["query", "query:operator", "active"],
    ["signing", "station:N0CALL:291", "revoked"],
  ])
    await h.store
      .statement(
        "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at) VALUES('a',?,'lotw',?,?,?,'v1',0)",
        id,
        remote,
        id,
        status,
      )
      .run();
  for (let n = 0; n < size; n++)
    await h.store
      .statement(
        "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,due_at,updated_at) VALUES('a','source',?,'query','g1',?,0,0)",
        `q${n}`,
        `full-source-${n}`,
      )
      .run();
  if (legacyState !== undefined) {
    await h.store
      .statement(
        "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,due_at,updated_at) VALUES('a','source','q0','signing','g1','full-source-0',0,0)",
      )
      .run();
    await h.store
      .statement(
        "INSERT INTO attempts(tenant,id,source,qso,destination,generation,payload_id,payload_hash,credential_version,created_at,source_hash) VALUES('a','legacy','source','q0','signing','g1','missing','hash','v1',0,'full-source-0')",
      )
      .run();
    if (legacyState !== null)
      await h.store
        .statement(
          "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at) VALUES('a','legacy',?,0,0)",
          legacyState,
        )
        .run();
  }
  for (const name of (await readdir(new URL("../migrations", import.meta.url)))
    .filter((n) => n.endsWith(".sql") && n > "0001_foundation.sql")
    .sort())
    await applyMigration(h.db, name);
  await backfillLotwOwnership(h.store, "a");
  await backfillLotwOwnership(h.store, "a");
  await h.store
    .statement(
      "CREATE TABLE adoption_test_fences(qso TEXT PRIMARY KEY,inventory INTEGER,reverse INTEGER)",
    )
    .run();
  for (let n = 0; n < size; n++)
    await h.store
      .statement("INSERT INTO adoption_test_fences VALUES(?,1,1)", `q${n}`)
      .run();
  const items: HistoryAdoptionInput[] = [];
  for (let n = 0; n < size; n++) {
    const key = {
      tenant: "a",
      source: "source",
      qso: `q${n}`,
      destination: "query",
    };
    const ledger = await h.store
      .statement(
        "SELECT l.*,d.kind AS destination_kind FROM ledger l JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination WHERE l.tenant=? AND l.source=? AND l.qso=? AND l.destination=?",
        key.tenant,
        key.source,
        key.qso,
        key.destination,
      )
      .first<ReconciliationLedger>();
    assert.ok(ledger);
    items.push({
      key,
      generation: "g1",
      ledger,
      outcome: {
        state: "adopted_existing",
        reason: null,
        associationOnly: true,
        remote: raw({ CALL: `K${n}ABC` }),
        evidence: {
          destination: "lotw",
          capturedGeneration: "g1",
          currentGeneration: "g1",
          readAccess: true,
          inventoryComplete: true,
          catchupComplete: true,
          freshCheckComplete: false,
          inventoryPositiveOnly: true,
        },
        associationProof: {
          bookIdentity: "query:operator",
          commitGuard: () => ({
            sql: "EXISTS(SELECT 1 FROM adoption_test_fences WHERE qso=? AND reverse=1)",
            params: [key.qso],
          }),
        },
      },
      commitGuard: () => ({
        sql: "EXISTS(SELECT 1 FROM adoption_test_fences WHERE qso=? AND inventory=1)",
        params: [key.qso],
      }),
    });
  }
  return { ...h, items };
}
async function assertClean(store: Store) {
  for (const table of [
    "lotw_historical_associations",
    "lotw_historical_guards",
    "lotw_historical_commit_checks",
  ])
    assert.equal(
      await store.statement(`SELECT COUNT(*) AS n FROM ${table}`).first("n"),
      0,
      table,
    );
  assert.equal(
    await store
      .statement(
        "SELECT COUNT(*) AS n FROM ledger WHERE lotw_historical_association_id IS NOT NULL",
      )
      .first("n"),
    0,
  );
  assert.equal(
    await store
      .statement(
        "SELECT COUNT(*) AS n FROM leases WHERE scope='lotw-ownership' AND expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)",
      )
      .first("n"),
    0,
  );
}
function wrapped(
  store: Store,
  hook: (
    statements: D1PreparedStatement[],
    sql: string[],
    real: D1Database,
  ) => Promise<D1Result[]>,
) {
  const db = Object.create(store.db) as D1Database,
    texts = new WeakMap<D1PreparedStatement, string>();
  db.prepare = (sql) => {
    const statement = store.db.prepare(sql);
    texts.set(statement, sql);
    return new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => {
            const result = target.bind(...values);
            texts.set(result, sql);
            return result;
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  db.batch = async <T>(statements: D1PreparedStatement[]) =>
    (await hook(
      statements,
      statements.map((s) => texts.get(s) ?? ""),
      store.db,
    )) as D1Result<T>[];
  return new Store(db, store.keys);
}
const publication = (sql: string[]) =>
  sql.some((s) => s.startsWith("INSERT INTO lotw_historical_guards"));

test("minute raw reports adopt atomically without exact receipt IDs or source precision changes", async (t) => {
  const h = await fixture(t, 2);
  h.items[1].outcome.remote = raw({
    CALL: "K1ABC",
    QSL_RCVD: "y",
    TIME_ON: "0000",
    QSO_DATE: "20261025",
  });
  assert.deepEqual(await adoptHistoryBatch(h.store, source, h.items), [
    { applied: true },
    { applied: true },
  ]);
  for (const [n, item] of h.items.entries()) {
    const row = await h.store
      .statement(
        "SELECT * FROM ledger WHERE tenant='a' AND source='source' AND qso=? AND destination='query'",
        item.key.qso,
      )
      .first<
        ReconciliationLedger & { lotw_historical_association_id: string }
      >();
    assert.ok(row?.lotw_historical_association_id);
    assert.equal(row.state, "adopted_existing");
    assert.equal(row.provenance, "adopted");
    assert.equal(row.reason, null);
    assert.equal(row.source_hash, item.ledger.source_hash);
    assert.equal(row.baseline_hash, item.ledger.source_hash);
    assert.equal(
      row.remote_hash,
      await sha256(canonical(comparableRemote(item.outcome.remote!))),
    );
    assert.equal(row.remote_id, null);
    assert.equal(row.sent_hash, null);
    assert.equal(row.confirmed, n === 0 ? 1 : 0);
    const evidence = await h.store
      .statement(
        "SELECT envelope FROM lotw_historical_associations WHERE id=?",
        row.lotw_historical_association_id,
      )
      .first<string>("envelope");
    assert.ok(evidence);
    assert.deepEqual(
      await open(
        JSON.parse(evidence) as Envelope,
        {
          tenant: "a",
          connection: "a",
          id: row.lotw_historical_association_id,
          kind: "lotw-historical",
          purpose: "storage",
        },
        keys,
      ),
      item.outcome.remote,
    );
    assert.equal(
      await h.store.historicalAssociationOnly({
        ...item.key,
        destination: "signing",
      }),
      true,
    );
    assert.equal(
      await h.store.historicalAssociationOnly({
        ...item.key,
        destination: "destination",
      }),
      false,
    );
  }
  for (const table of [
    "attempts",
    "destination_identity_claims",
    "lotw_ownership_evidence",
    "lotw_historical_guards",
    "lotw_historical_commit_checks",
  ])
    assert.equal(
      await h.store.statement(`SELECT COUNT(*) n FROM ${table}`).first("n"),
      0,
      table,
    );
  assert.equal(
    (await adoptLotwHistoricalBatch(h.store, source, h.items))[0].applied,
    false,
    "stale caller cannot rebind durable history",
  );
});

test("public reconciliation preserves mixed-result order and historical references after source edits", async (t) => {
  const h = await fixture(t, 3);
  h.items[1].outcome = {
    state: "inventory_pending",
    reason: "Waiting for current source",
    evidence: { ...h.items[1].outcome.evidence, capturedGeneration: "older" },
  };
  assert.deepEqual(await adoptHistoryBatch(h.store, source, h.items), [
    { applied: true },
    { applied: false, reason: "source_generation_changed" },
    { applied: true },
  ]);
  const item = h.items[0];
  const before = await h.store.ledger(item.key);
  assert.ok(before?.lotw_historical_association_id);
  assert.equal(
    await reconciliationPreflight(h.store, item.key, "g1", Date.now()),
    null,
  );
  assert.deepEqual(
    await reconciliationPreflightBatch(
      h.store,
      source,
      [
        {
          qso: item.key.qso,
          destination: item.key.destination,
          generation: "g1",
        },
      ],
      Date.now(),
    ),
    [],
  );
  assert.deepEqual(
    await adoptHistory(
      h.store,
      item.key,
      "g1",
      item.outcome,
      Date.now(),
      undefined,
      item.commitGuard(Date.now()),
    ),
    { applied: false, reason: "trusted_mapping_preserved" },
  );
  await h.store.observation(item.key, "g2", "edited-source-hash", 20).run();
  const changed = await h.store.ledger(item.key);
  assert.equal(changed?.state, "changed");
  assert.equal(
    changed?.lotw_historical_association_id,
    before.lotw_historical_association_id,
  );
  assert.equal(changed?.remote_id, null);
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM historical_association_write_blocks WHERE tenant='a' AND source='source' AND qso=?",
        item.key.qso,
      )
      .first("n"),
    2,
  );
  assert.equal(
    await h.store.statement("SELECT COUNT(*) n FROM attempts").first("n"),
    0,
  );
});

test("validation rejects incomplete proofs, changed generations and manufactured source hashes before publication", async (t) => {
  const h = await fixture(t);
  const mutations: ((item: HistoryAdoptionInput) => void)[] = [
    (i) => {
      i.outcome.evidence.inventoryComplete = false;
    },
    (i) => {
      i.outcome.evidence.catchupComplete = false;
    },
    (i) => {
      i.outcome.evidence.inventoryPositiveOnly = false;
    },
    (i) => {
      i.outcome.evidence.currentGeneration = "changed";
    },
    (i) => {
      delete i.outcome.associationOnly;
    },
    (i) => {
      delete i.outcome.associationProof;
    },
    (i) => {
      i.outcome.remote!.TIME_ON = "invalid";
    },
    (i) => {
      i.outcome.remote!.COMMENT = "x".repeat(65537);
    },
    (i) => {
      i.adoptedSourceHash = "fabricated";
    },
    (i) => {
      i.ledger.state = "changed";
    },
    (i) => {
      i.ledger.sent_hash = "sent";
    },
    (i) => {
      i.ledger.template_version = "template";
    },
    (i) => {
      i.ledger.provenance = "ferry_created";
    },
    (i) => {
      i.ledger.provenance = "adoption_conflict";
    },
    (i) => {
      i.ledger.remote_id = "accepted";
    },
  ];
  for (const change of mutations) {
    const original = h.items[0],
      item = {
        ...original,
        key: { ...original.key },
        ledger: { ...original.ledger },
        outcome: {
          ...original.outcome,
          evidence: { ...original.outcome.evidence },
          remote: { ...original.outcome.remote },
          associationProof: { ...original.outcome.associationProof! },
        },
      };
    change(item);
    assert.equal(
      (await adoptLotwHistoricalBatch(h.store, source, [item]))[0].applied,
      false,
    );
  }
  await assertClean(h.store);
  await assert.rejects(
    adoptLotwHistoricalBatch(h.store, source, Array(9).fill(h.items[0])),
    /batch_too_large/,
  );
  await assert.rejects(
    adoptLotwHistoricalBatch(h.store, source, [h.items[0], h.items[0]]),
    /duplicate_reconciliation_owner/,
  );
  const over = {
    ...h.items[0],
    commitGuard: () => ({ sql: "1", params: Array(73).fill(1) }),
  };
  await assert.rejects(
    adoptLotwHistoricalBatch(h.store, source, [over]),
    /guard_bound/,
  );
});

test("overlapping siblings hold together while an independent owner can be adopted", async (t) => {
  const h = await fixture(t, 3);
  h.items[1].outcome.remote = { ...h.items[0].outcome.remote! };
  assert.deepEqual(await adoptLotwHistoricalBatch(h.store, source, h.items), [
    { applied: false, reason: "remote_identity_claim_conflict" },
    { applied: false, reason: "remote_identity_claim_conflict" },
    { applied: true },
  ]);
  assert.equal(
    await h.store
      .statement("SELECT COUNT(*) n FROM lotw_historical_associations")
      .first("n"),
    1,
  );
});

test("expected lease, coverage, competing-owner and stale-scope holds are distinct from transport failures", async (t) => {
  const h = await fixture(t, 2),
    lease = await h.store.claim("a", "lotw-ownership", Date.now(), 60000);
  assert.ok(lease);
  assert.deepEqual(
    await adoptLotwHistoricalBatch(h.store, source, [h.items[0]]),
    [{ applied: false, reason: "lotw_historical_lease_unavailable" }],
  );
  await h.store.release(lease);
  h.items[0].outcome.associationProof!.bookIdentity = "query:wrong";
  assert.equal(
    (await adoptLotwHistoricalBatch(h.store, source, [h.items[0]]))[0].applied,
    false,
  );
  h.items[0].outcome.associationProof!.bookIdentity = "query:operator";
  assert.deepEqual(
    await adoptLotwHistoricalBatch(h.store, source, [h.items[0]]),
    [{ applied: true }],
  );
  h.items[1].outcome.remote = { ...h.items[0].outcome.remote! };
  assert.deepEqual(
    await adoptLotwHistoricalBatch(h.store, source, [h.items[1]]),
    [{ applied: false, reason: "lotw_historical_competing_owner" }],
  );
  await h.store
    .statement(
      "INSERT INTO lotw_ownership_inputs(tenant,kind,destination,reference,source,qso,status) VALUES('a','legacy','query','opaque','source','opaque','held')",
    )
    .run();
  assert.deepEqual(
    await adoptLotwHistoricalBatch(h.store, source, [h.items[1]]),
    [{ applied: false, reason: "lotw_historical_coverage_incomplete" }],
  );
  const error = new Error("lotw_historical_competing_owner");
  await assert.rejects(
    adoptLotwHistoricalBatch(
      wrapped(h.store, async (statements, sql, real) => {
        if (sql.some((s) => s.startsWith("SELECT s.clock,s.key_id")))
          throw error;
        return real.batch(statements);
      }),
      source,
      [h.items[1]],
    ),
    (e) => e === error,
    "matching text is not a typed known hold",
  );
});

test("caller mutation during the first await cannot alter raw report, source hash, scope or guards", async (t) => {
  const h = await fixture(t),
    original = structuredClone(h.items[0].outcome.remote),
    store = wrapped(h.store, async (statements, sql, real) => {
      if (sql[0]?.startsWith("SELECT EXISTS(SELECT 1 FROM ledger")) {
        h.items[0].key.qso = "other";
        h.items[0].ledger.source_hash = "fabricated";
        h.items[0].outcome.remote!.TIME_ON = "000001";
        h.items[0].outcome.evidence.currentGeneration = "other";
        h.items[0].outcome.associationProof!.bookIdentity = "query:other";
        h.items[0].commitGuard = () => ({ sql: "0", params: [] });
      }
      return real.batch(statements);
    });
  assert.deepEqual(await adoptLotwHistoricalBatch(store, source, h.items), [
    { applied: true },
  ]);
  const row = await h.store
    .statement("SELECT id,envelope FROM lotw_historical_associations")
    .first<{ id: string; envelope: string }>();
  assert.ok(row);
  assert.deepEqual(
    await open(
      JSON.parse(row.envelope) as Envelope,
      {
        tenant: "a",
        connection: "a",
        id: row.id,
        kind: "lotw-historical",
        purpose: "storage",
      },
      keys,
    ),
    original,
  );
  assert.equal(
    await h.store
      .statement(
        "SELECT source_hash FROM ledger WHERE qso='q0' AND destination='query'",
      )
      .first("source_hash"),
    "full-source-0",
  );
});

test("a losing ledger UPDATE rolls back every raw owner, write block and sibling adoption", async (t) => {
  const h = await fixture(t, 2);
  let batches = 0;
  const store = wrapped(h.store, async (statements, sql, real) => {
    if (publication(sql)) {
      batches++;
      const update = sql.findIndex((s) =>
        s.startsWith("UPDATE ledger SET state='adopted_existing'"),
      );
      return real.batch([
        ...statements.slice(0, update),
        real.prepare(
          "UPDATE ledger SET state='changed' WHERE qso='q1' AND destination='query'",
        ),
        ...statements.slice(update),
      ]);
    }
    return real.batch(statements);
  });
  await assert.rejects(
    adoptLotwHistoricalBatch(store, source, h.items),
    /CHECK constraint failed/,
  );
  assert.equal(batches, 1);
  await assertClean(h.store);
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM ledger WHERE state='adopted_existing' OR state='changed'",
      )
      .first("n"),
    0,
  );
});

test("late inventory and reverse failures roll back publication without refreshing guards", async (t) => {
  const h = await fixture(t, 2);
  for (const column of ["inventory", "reverse"]) {
    const store = wrapped(h.store, async (statements, sql, real) => {
      if (publication(sql)) {
        const finish = sql.findIndex((s) =>
          s.startsWith("DELETE FROM lotw_historical_guards"),
        );
        return real.batch([
          ...statements.slice(0, finish - 2),
          real.prepare(
            `UPDATE adoption_test_fences SET ${column}=0 WHERE qso='q1'`,
          ),
          ...statements.slice(finish - 2),
        ]);
      }
      return real.batch(statements);
    });
    await assert.rejects(
      adoptLotwHistoricalBatch(store, source, h.items),
      /CHECK constraint failed/,
    );
    await assertClean(h.store);
    assert.equal(
      await h.store
        .statement(`SELECT ${column} FROM adoption_test_fences WHERE qso='q1'`)
        .first(column),
      1,
    );
  }
});

test("native commit rechecks active tenant/source/route and exact ledger generation", async (t) => {
  for (const [sql, restore] of [
    [
      "UPDATE accounts SET status='paused' WHERE id='a'",
      "UPDATE accounts SET status='active' WHERE id='a'",
    ],
    [
      "UPDATE connections SET status='revoked' WHERE id='source'",
      "UPDATE connections SET status='active' WHERE id='source'",
    ],
    [
      "UPDATE connections SET status='revoked' WHERE id='query'",
      "UPDATE connections SET status='active' WHERE id='query'",
    ],
    [
      "UPDATE ledger SET generation='g2' WHERE qso='q0'",
      "UPDATE ledger SET generation='g1' WHERE qso='q0'",
    ],
  ]) {
    const h = await fixture(t),
      store = wrapped(h.store, async (statements, texts, real) => {
        if (publication(texts)) await real.prepare(sql).run();
        return real.batch(statements);
      });
    await assert.rejects(adoptLotwHistoricalBatch(store, source, h.items));
    await assertClean(h.store);
    await h.store.statement(restore).run();
  }
});

test("inactive aliases with unresolved or unknown-state attempts prevent historical adoption", async (t) => {
  for (const state of [null, "uncertain", "submitted", "unknown_state"]) {
    const h = await fixture(t, 1, state);
    assert.equal(
      (await adoptLotwHistoricalBatch(h.store, source, h.items))[0].applied,
      false,
    );
    await assertClean(h.store);
  }
});

test("one eight-member publication batch and an unknown acknowledgement never retry or release ownership", async (t) => {
  const h = await fixture(t, 8),
    error = new Error("lost acknowledgement");
  let batches = 0,
    size = 0;
  const store = wrapped(h.store, async (statements, sql, real) => {
    const results = await real.batch(statements);
    if (publication(sql)) {
      batches++;
      size = statements.length;
      throw error;
    }
    return results;
  });
  await assert.rejects(
    adoptLotwHistoricalBatch(store, source, h.items),
    (e) => e === error,
  );
  assert.equal(batches, 1);
  assert.equal(size, 51);
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM ledger WHERE state='adopted_existing' AND lotw_historical_association_id IS NOT NULL AND remote_id IS NULL",
      )
      .first("n"),
    8,
  );
  assert.equal(
    await h.store
      .statement("SELECT COUNT(*) n FROM lotw_historical_associations")
      .first("n"),
    8,
  );
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM leases WHERE scope='lotw-ownership' AND expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)",
      )
      .first("n"),
    0,
  );
  assert.ok(
    (await adoptLotwHistoricalBatch(h.store, source, h.items)).every(
      (r) => !r.applied,
    ),
    "caller must reload; stale inputs cannot create another owner",
  );
});
