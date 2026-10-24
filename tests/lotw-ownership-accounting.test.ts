import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { type DeliveryGates, prepareDue } from "../src/delivery.ts";
import { backfillLotwOwnership } from "../src/lotw-ownership.ts";
import { prepareLotwOwnershipBatch } from "../src/lotw-ownership-bridge.ts";
import { canonicalLotwIdentity, lotwRemoteIdentity } from "../src/reconcile.ts";
import { Store } from "../src/store.ts";
import { schedulerFixture } from "./runtime-fixtures.ts";
import { mintFixtureSourceProofs } from "./source-proof-fixtures.ts";

const gates: DeliveryGates = {
  exportsEnabled: true,
  liveWriteAuthorized: true,
  sourceBoundaryVerified: false,
  lotwFreshInsertsEnabled: true,
  allowedQsoIds: ["q1", "q2"],
  allowedDestinationIds: ["lotw"],
};
async function fixture(t: TestContext) {
  t.mock.method(globalThis, "fetch", async () =>
    assert.fail("unmocked network"),
  );
  const h = await schedulerFixture();
  t.after(() => h.mf.dispose());
  h.qrzRecords.length = 0;
  h.lotwRecords.length = 0;
  const source = (await h.store.connection("a", "source"))!;
  const proof = await mintFixtureSourceProofs(h.store, {
    source,
    qsos: [0, 1].map((i) => ({
      ...h.qso,
      uuid: `q${i + 1}`,
      startAtMillis: Number(h.qso.startAtMillis) + i * 3600000,
      syncedAtMillis: 101 + i,
    })),
    operations: [h.operation],
    destinations: (await h.store.connections("a")).filter(
      (c) => c.kind !== "lofi",
    ),
  });
  await h.store
    .statement(
      "UPDATE ledger SET state='missing_current_identity',due_at=0 WHERE tenant='a'",
    )
    .run();
  await backfillLotwOwnership(h.store, "a");
  return {
    ...h,
    proof,
    key: { tenant: "a", source: "source", qso: "q1", destination: "lotw" },
  };
}
function instrument(raw: Store) {
  const statements = new WeakMap<
    D1PreparedStatement,
    { sql: string; params: unknown[] }
  >();
  const accounting: {
    sql: string;
    params: unknown[];
    reads: number;
    writes: number;
  }[] = [];
  const db = Object.create(raw.db) as D1Database;
  db.prepare = (sql) =>
    new Proxy(raw.db.prepare(sql), {
      get(target, property) {
        if (property === "bind")
          return (...params: unknown[]) => {
            const bound = target.bind(...params);
            statements.set(bound, { sql, params });
            return bound;
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  db.batch = async <T>(batch: D1PreparedStatement[]) => {
    const rows = await raw.db.batch<T>(batch);
    for (const [i, s] of batch.entries()) {
      const entry = statements.get(s);
      if (entry?.sql.startsWith("UPDATE lotw_ownership_inputs AS i"))
        accounting.push({
          ...entry,
          reads: rows[i].meta.rows_read,
          writes: rows[i].meta.rows_written,
        });
    }
    return rows;
  };
  return { store: new Store(db, raw.keys), accounting };
}
async function filler(store: Store) {
  await store
    .statement(`WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4000)
    INSERT INTO lotw_ownership_inputs(tenant,kind,destination,reference,source,qso,exact_hash,status,checked_at,evidence_id)
    SELECT e.tenant,'claim',e.destination,'unrelated-covered-'||n.x,e.source,'unrelated-'||n.x,e.exact_hash,'covered',0,e.id
    FROM n CROSS JOIN lotw_ownership_evidence e WHERE e.tenant='a' LIMIT 4000`)
    .run();
}
async function assertIndexed(
  store: Store,
  entry: { sql: string; params: unknown[] },
) {
  const plan = await store.db
    .prepare(`EXPLAIN QUERY PLAN ${entry.sql}`)
    .bind(...entry.params)
    .all<{ detail: string }>();
  assert.ok(
    plan.results.some((r) =>
      /SEARCH i USING INDEX lotw_ownership_pending \(tenant=\? AND status=\?\)/.test(
        r.detail,
      ),
    ),
    JSON.stringify(plan.results),
  );
}

test("actual stage accounting seeks only pending inputs despite thousands of covered obligations", async (t) => {
  const h = await fixture(t),
    meter = instrument(h.store);
  const prepare = (i: number) =>
    prepareDue(
      meter.store,
      { ...h.key, qso: `q${i + 1}` },
      h.proof.snapshots[i].contact,
      gates,
      { fetcher: h.fetcher, sourceProof: h.proof.authorizations[i] },
    );
  assert.equal((await prepare(0)).state, "prepared");
  const before = meter.accounting.at(-1);
  assert.ok(before);
  assert.ok(before.writes > 0);
  await filler(h.store);
  assert.equal((await prepare(1)).state, "prepared");
  const after = meter.accounting.at(-1);
  assert.ok(after);
  assert.notEqual(after, before);
  assert.ok(after.writes > 0);
  assert.ok(
    after.reads <= before.reads + 24,
    `accounting reads ${before.reads} -> ${after.reads}`,
  );
  await assertIndexed(h.store, after);
  assert.equal(
    await h.store.statement("SELECT COUNT(*) n FROM attempts").first("n"),
    2,
  );
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM lotw_ownership_inputs WHERE status IN('pending','held')",
      )
      .first("n"),
    0,
  );
  assert.equal(
    await h.store
      .statement("SELECT COUNT(*) n FROM attempt_lotw_ownership_pins")
      .first("n"),
    2,
  );
  t.diagnostic(
    `exact stage accounting reads ${before.reads} -> ${after.reads} with 4,000 unrelated covered inputs`,
  );
});

test("mapping accounting retains its winner and rolls back a late unplanned pending input", async (t) => {
  const h = await fixture(t),
    meter = instrument(h.store);
  const identity = canonicalLotwIdentity({
    STATION_CALLSIGN: "W1AW",
    CALL: "K1ABC",
    QSO_DATE: "20261024",
    TIME_ON: "120000",
    BAND: "20M",
    MODE: "FT8",
  });
  const remoteId = await lotwRemoteIdentity(identity),
    ledger = (await h.store.ledger(h.key))!;
  const first = await prepareLotwOwnershipBatch(meter.store, "mapping", [
    {
      ...h.key,
      identity: { identity, remoteId },
      generation: ledger.generation,
      sourceHash: ledger.source_hash,
    },
  ]);
  try {
    const rows = await meter.store.db.batch([
      ...first.begin,
      meter.store.statement(
        "UPDATE ledger SET remote_id=?,state='adopted_existing' WHERE tenant=? AND source=? AND qso=? AND destination=? AND generation=? RETURNING qso",
        remoteId,
        h.key.tenant,
        h.key.source,
        h.key.qso,
        h.key.destination,
        ledger.generation,
      ),
      ...first.finish,
    ]);
    assert.equal(rows[first.begin.length].results.length, 1);
  } finally {
    await first.release();
  }
  const before = meter.accounting.at(-1);
  assert.ok(before);
  await assertIndexed(h.store, before);
  await filler(h.store);
  const key = { ...h.key, qso: "q2" },
    nextLedger = (await h.store.ledger(key))!,
    nextIdentity = { ...identity, CALL: "K2ABC" },
    nextId = await lotwRemoteIdentity(nextIdentity);
  const next = await prepareLotwOwnershipBatch(meter.store, "mapping", [
    {
      ...key,
      identity: { identity: nextIdentity, remoteId: nextId },
      generation: nextLedger.generation,
      sourceHash: nextLedger.source_hash,
    },
  ]);
  try {
    const update = meter.store.statement(
      "UPDATE ledger SET remote_id=?,state='adopted_existing' WHERE tenant=? AND source=? AND qso=? AND destination=? AND generation=? RETURNING qso",
      nextId,
      key.tenant,
      key.source,
      key.qso,
      key.destination,
      nextLedger.generation,
    );
    await assert.rejects(
      meter.store.db.batch([
        ...next.begin,
        update,
        meter.store.statement(
          "INSERT INTO lotw_ownership_inputs(tenant,kind,destination,reference) VALUES('a','legacy','lotw','late-unknown')",
        ),
        ...next.finish,
      ]),
      /LoTW ownership changed/,
    );
    assert.equal((await h.store.ledger(key))!.remote_id, null);
    assert.equal(
      await h.store
        .statement(
          "SELECT COUNT(*) n FROM lotw_ownership_inputs WHERE reference='late-unknown'",
        )
        .first("n"),
      0,
    );
    assert.equal(
      await h.store
        .statement(
          "SELECT COUNT(*) n FROM lotw_ownership_evidence WHERE qso='q2'",
        )
        .first("n"),
      0,
    );
    // Rollback retained the original lease/clock, so the same frozen statements
    // can be exercised once without the intentionally injected failed input.
    const rows = await meter.store.db.batch([
      ...next.begin,
      update,
      ...next.finish,
    ]);
    assert.equal(rows[next.begin.length].results.length, 1);
  } finally {
    await next.release();
  }
  const after = meter.accounting.at(-1);
  assert.ok(after);
  assert.ok(
    after.reads <= before.reads + 24,
    `mapping reads ${before.reads} -> ${after.reads}`,
  );
  await assertIndexed(h.store, after);
  assert.equal((await h.store.ledger(key))!.remote_id, nextId);
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM lotw_ownership_inputs WHERE status IN('pending','held')",
      )
      .first("n"),
    0,
  );
  t.diagnostic(
    `exact mapping accounting reads ${before.reads} -> ${after.reads} with 4,000 unrelated covered inputs`,
  );
});
