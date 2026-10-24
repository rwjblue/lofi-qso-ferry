import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { type AdifRecord, serializeAdifRecord } from "../src/adif.ts";
import { measuredDatabase } from "../src/database-metrics.ts";
import { contactReconciliationAdif } from "../src/delivery.ts";
import { historicalSourceCandidates } from "../src/historical-source-candidates.ts";
import {
  type HistoryInventoryResult,
  historyCandidates,
} from "../src/history-inventory.ts";
import { observeContact, pendingContacts, pollSource } from "../src/intake.ts";
import {
  type LotwHistoricalAssociationMember,
  lookupLotwHistoricalOwnership,
  lotwHistoricalSnapshotGuard,
  prepareLotwHistoricalAssociations,
} from "../src/lotw-historical-associations.ts";
import { backfillLotwOwnership } from "../src/lotw-ownership.ts";
import { canonicalLotwIdentity, lotwRemoteIdentity } from "../src/reconcile.ts";
import { type Envelope, open, seal } from "../src/security.ts";
import { reconciliationCommitGuard, routeMatches } from "../src/service.ts";
import {
  backfillSourceHistoricalIndex,
  sourceHistoricalIndexKey,
} from "../src/source-historical-index.ts";
import { type LedgerKey, Store } from "../src/store.ts";
import { applyMigration, database, keys, seed } from "./helpers.ts";

const record = (changes: AdifRecord = {}): AdifRecord => ({
  STATION_CALLSIGN: "N0CALL",
  CALL: "W1AW",
  QSO_DATE: "20261024",
  TIME_ON: "1200",
  BAND: "20M",
  MODE: "DATA",
  APP_LOTW_MODEGROUP: "DATA",
  MY_GRIDSQUARE: "FN31",
  ...changes,
});
async function fixture(t: TestContext, exact = false) {
  const h = await database();
  t.after(() => h.mf.dispose());
  for (const name of (await readdir(new URL("../migrations", import.meta.url)))
    .filter(
      (n) => n.endsWith(".sql") && n > "0001_foundation.sql" && n < "0036",
    )
    .sort())
    await applyMigration(h.db, name);
  await seed(h.store);
  for (const [id, remote, status] of [
    ["query", "query:operator", "active"],
    ["signing", "station:N0CALL:291", "revoked"],
    ["portable", "station:N0CALL/P:291", "active"],
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
  const first = await owner(h.store, "q1");
  if (exact) {
    const older = await owner(h.store, "old", "signing"),
      identity = canonicalLotwIdentity(
        record({ TIME_ON: "120001", MODE: "FT8" }),
      );
    await (
      await h.store.lotwIdentityStatement(
        older,
        { identity, remoteId: await lotwRemoteIdentity(identity) },
        "observed",
        Date.now(),
        { sql: "1", params: [] },
      )
    ).run();
  }
  await backfillLotwOwnership(h.store, "a");
  await backfillLotwOwnership(h.store, "a");
  await applyMigration(h.db, "0036_lotw_ownership_write_bridge.sql");
  await applyMigration(h.db, "0037_lotw_historical_associations.sql");
  return { ...h, first };
}
async function owner(store: Store, qso: string, destination = "query") {
  const key = { tenant: "a", source: "source", qso, destination };
  await store
    .statement(
      "INSERT INTO ledger(tenant,source,qso,destination,generation,source_hash,due_at,updated_at) VALUES(?,?,?,?,'g1','h1',0,?)",
      key.tenant,
      key.source,
      key.qso,
      key.destination,
      Date.now(),
    )
    .run();
  return key;
}
const member = (
  key: LedgerKey,
  raw = record(),
): LotwHistoricalAssociationMember => ({
  key,
  record: raw,
  generation: "g1",
  sourceHash: "h1",
  guard: { sql: "1", params: [] },
});
async function publish(
  store: Store,
  members: LotwHistoricalAssociationMember[],
) {
  const p = await prepareLotwHistoricalAssociations(store, members);
  try {
    const results = await store.db.batch([
      ...p.begin,
      ...p.publications,
      ...p.finish,
    ]);
    return { p, results };
  } finally {
    await p.release();
  }
}
async function count(store: Store, table: string) {
  return store.statement(`SELECT COUNT(*) n FROM ${table}`).first<number>("n");
}

test("minute-only raw evidence stays encrypted and blocks every LoTW route without exact identities", async (t) => {
  const h = await fixture(t),
    raw = record({ COMMENT: "original report" }),
    before = await h.store
      .statement("SELECT clock FROM lotw_ownership_state WHERE tenant='a'")
      .first<number>("clock");
  const { p, results } = await publish(h.store, [member(h.first, raw)]);
  assert.equal(results[p.ledgerResultOffsets[0]].results.length, 1);
  const row = await h.store
    .statement("SELECT * FROM lotw_historical_associations")
    .first<{
      id: string;
      envelope: string;
      book_identity: string;
      namespace: string;
      bucket: string;
    }>();
  assert.ok(row);
  assert.equal(row.book_identity, "query:operator");
  assert.ok(!row.envelope.includes("W1AW"));
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
    raw,
  );
  const ledger = await h.store
    .statement(
      "SELECT remote_id,lotw_historical_association_id FROM ledger WHERE qso='q1'",
    )
    .first();
  assert.deepEqual(ledger, {
    remote_id: null,
    lotw_historical_association_id: row.id,
  });
  for (const table of [
    "attempts",
    "destination_identity_claims",
    "lotw_ownership_evidence",
  ])
    assert.equal(await count(h.store, table), 0);
  assert.equal(
    await h.store
      .statement(
        "SELECT comparison_policy FROM lotw_ownership_state WHERE tenant='a'",
      )
      .first("comparison_policy"),
    2,
  );
  assert.equal(
    await h.store
      .statement("SELECT clock FROM lotw_ownership_state WHERE tenant='a'")
      .first("clock"),
    (before ?? 0) + 2,
  );
  const result = await lookupLotwHistoricalOwnership(h.store, "a", [
    record({ TIME_ON: "1230", MODE: "FT8" }),
  ]);
  assert.equal(result.state, "observed");
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].record, raw);
  assert.equal(result.candidates[0].kind, "historical");
  assert.equal(result.authoritative, false);
  assert.equal(
    (
      await lookupLotwHistoricalOwnership(h.store, "a", [
        record({ STATION_CALLSIGN: "N0CALL/P" }),
      ])
    ).candidates.length,
    0,
  );
  for (const destination of ["query", "signing", "portable"])
    assert.equal(
      await h.store.historicalAssociationOnly({ ...h.first, destination }),
      true,
    );
  assert.equal(
    await h.store.historicalAssociationOnly({
      ...h.first,
      destination: "destination",
    }),
    false,
  );
  await h.store
    .statement(
      "UPDATE connections SET remote_identity='query:changed',config='{}' WHERE id='query'",
    )
    .run();
  await h.store
    .statement(
      "UPDATE ledger SET generation='g2',source_hash='h2',state='pending' WHERE qso='q1'",
    )
    .run();
  assert.equal(await h.store.historicalAssociationOnly(h.first), true);
  await h.store
    .statement(
      "UPDATE connections SET kind='qrz' WHERE tenant='a' AND id='query'",
    )
    .run();
  assert.equal(
    await h.store.historicalAssociationOnly(h.first),
    false,
    "LoTW history never blocks a QRZ route",
  );
  assert.equal(
    await h.store.historicalAssociationOnly({
      ...h.first,
      destination: "signing",
    }),
    true,
  );
  for (const sql of [
    "UPDATE lotw_historical_associations SET envelope='{}'",
    "DELETE FROM lotw_historical_associations",
    "UPDATE ledger SET lotw_historical_association_id=NULL WHERE qso='q1'",
  ])
    await assert.rejects(h.store.statement(sql).run(), /historical/);
  assert.equal(await count(h.store, "lotw_historical_guards"), 0);
});

test("one native cohort publishes multiple noncompeting owners and rejects prospective collisions", async (t) => {
  const h = await fixture(t),
    second = await owner(h.store, "q2");
  await backfillLotwOwnership(h.store, "a");
  await assert.rejects(
    prepareLotwHistoricalAssociations(h.store, [
      member(h.first),
      member(second, record({ TIME_ON: "1229", MODE: "RTTY" })),
    ]),
    /competing_owner/,
  );
  assert.equal(await count(h.store, "lotw_historical_associations"), 0);
  const { p, results } = await publish(h.store, [
    member(h.first),
    member(second, record({ CALL: "K1ABC" })),
  ]);
  assert.equal(p.begin.length, 2);
  assert.equal(await count(h.store, "lotw_historical_associations"), 2);
  for (const offset of p.ledgerResultOffsets)
    assert.equal(results[offset].results.length, 1);
});

test("exact inactive receipt and raw evidence share bounded comparisons without rewriting exact receipt hashes", async (t) => {
  const h = await fixture(t, true),
    before = await h.store
      .statement("SELECT exact_hash,envelope FROM lotw_ownership_evidence")
      .all();
  await assert.rejects(
    prepareLotwHistoricalAssociations(h.store, [member(h.first)]),
    /competing_owner/,
  );
  const observed = await lookupLotwHistoricalOwnership(h.store, "a", [
    record(),
  ]);
  assert.equal(observed.candidates[0].kind, "exact");
  assert.equal(observed.candidates[0].destination, "signing");
  assert.equal(observed.candidates[0].record.TIME_ON, "120001");
  await publish(h.store, [member(h.first, record({ CALL: "K1ABC" }))]);
  const mixed = await lookupLotwHistoricalOwnership(h.store, "a", [
    record(),
    record({ CALL: "K1ABC" }),
  ]);
  assert.equal(mixed.candidates.length, 2);
  assert.deepEqual(
    new Set(mixed.candidates.map((c) => c.kind)),
    new Set(["exact", "historical"]),
  );
  assert.deepEqual(
    (
      await h.store
        .statement("SELECT exact_hash,envelope FROM lotw_ownership_evidence")
        .all()
    ).results,
    before.results,
  );
});

test("all admissions and final source/inventory checks roll back every raw member and reference", async (t) => {
  const h = await fixture(t),
    second = await owner(h.store, "q2");
  await backfillLotwOwnership(h.store, "a");
  const entries = [member(h.first), member(second, record({ CALL: "K1ABC" }))];
  entries[1].guard = {
    sql: "EXISTS(SELECT 1 FROM ledger WHERE tenant='a' AND qso='q2' AND generation='g1')",
    params: [],
  };
  const p = await prepareLotwHistoricalAssociations(h.store, entries);
  try {
    await assert.rejects(
      h.db.batch([
        ...p.begin,
        ...p.publications,
        h.store.statement("UPDATE ledger SET generation='late' WHERE qso='q2'"),
        ...p.finish,
      ]),
      /CHECK|historical/,
    );
  } finally {
    await p.release();
  }
  assert.equal(await count(h.store, "lotw_historical_associations"), 0);
  assert.equal(await count(h.store, "lotw_historical_guards"), 0);
  assert.equal(
    await h.store
      .statement(
        "SELECT COUNT(*) n FROM ledger WHERE lotw_historical_association_id IS NOT NULL",
      )
      .first("n"),
    0,
  );
  assert.equal(
    await h.store
      .statement("SELECT generation FROM ledger WHERE qso='q2'")
      .first("generation"),
    "g1",
  );
  const failed = await prepareLotwHistoricalAssociations(h.store, [
    member(h.first),
    { ...entries[1], guard: { sql: "0", params: [] } },
  ]);
  try {
    await assert.rejects(
      h.db.batch([...failed.begin, ...failed.publications, ...failed.finish]),
      /historical/,
    );
  } finally {
    await failed.release();
  }
  assert.equal(await count(h.store, "lotw_historical_associations"), 0);
});

test("clock, ledger, route and lease races cannot leave a phantom permanent block", async (t) => {
  const h = await fixture(t);
  for (const mutation of [
    "UPDATE lotw_ownership_state SET clock=clock+1 WHERE tenant='a'",
    "UPDATE ledger SET generation='g2' WHERE qso='q1'",
    "UPDATE connections SET credential_version='v2' WHERE id='query'",
    "UPDATE leases SET expires_at=0 WHERE scope='lotw-ownership'",
  ]) {
    const p = await prepareLotwHistoricalAssociations(h.store, [
      member(h.first),
    ]);
    await h.store.statement(mutation).run();
    try {
      await assert.rejects(
        h.db.batch([...p.begin, ...p.publications, ...p.finish]),
        /historical/,
      );
    } finally {
      await p.release();
    }
    assert.equal(await count(h.store, "lotw_historical_associations"), 0);
    await h.store
      .statement("UPDATE ledger SET generation='g1' WHERE qso='q1'")
      .run();
    await h.store
      .statement(
        "UPDATE connections SET credential_version='v1' WHERE id='query'",
      )
      .run();
  }
});

test("caller input is captured before awaits; unavailable keys and invalid raw evidence hold", async (t) => {
  const h = await fixture(t),
    raw = record(),
    entry = member(h.first, raw),
    pending = prepareLotwHistoricalAssociations(h.store, [entry]);
  raw.TIME_ON = "000000";
  entry.key.qso = "mutated";
  entry.guard.sql = "0";
  const p = await pending;
  try {
    await h.db.batch([...p.begin, ...p.publications, ...p.finish]);
  } finally {
    await p.release();
  }
  assert.equal(
    (await lookupLotwHistoricalOwnership(h.store, "a", [record()]))
      .candidates[0].record.TIME_ON,
    "1200",
  );
  const unavailable = new Store(h.db, {
    active: "2",
    keys: { "2": keys.keys["2"] },
  });
  assert.equal(
    (await lookupLotwHistoricalOwnership(unavailable, "a", [record()])).reason,
    "key_unavailable",
  );
  for (const bad of [
    record({ TIME_ON: "1261" }),
    record({ MODE: "UNKNOWN" }),
    record({ COMMENT: "x".repeat(65536) }),
  ])
    assert.equal(
      (await lookupLotwHistoricalOwnership(h.store, "a", [bad])).state,
      "held",
    );
  await h.store
    .statement(
      "UPDATE lotw_ownership_state SET comparison_policy=3 WHERE tenant='a'",
    )
    .run();
  assert.equal(
    (await lookupLotwHistoricalOwnership(h.store, "a", [record()])).reason,
    "comparison_policy_unavailable",
  );
});

test("raw insertion invalidates prior snapshots and exact-only bridge admission cannot renew", async (t) => {
  const h = await fixture(t),
    before = await lookupLotwHistoricalOwnership(h.store, "a", [record()]);
  assert.ok(before.snapshot);
  const guard = lotwHistoricalSnapshotGuard(before.snapshot);
  await publish(h.store, [member(h.first)]);
  assert.equal(
    await h.store
      .statement(`SELECT 1 current WHERE ${guard.sql}`, ...guard.params)
      .first(),
    null,
  );
  await assert.rejects(
    h.store
      .statement(
        "UPDATE lotw_ownership_state SET comparison_policy=1 WHERE tenant='a'",
      )
      .run(),
    /cannot regress/,
  );
  const lease = await h.store.claim("a", "lotw-ownership");
  assert.ok(lease);
  const state = await h.store
    .statement("SELECT key_id,clock FROM lotw_ownership_state WHERE tenant='a'")
    .first<{ key_id: string; clock: number }>();
  assert.ok(state);
  const plan = JSON.stringify([
    {
      source: "source",
      qso: "q1",
      destination: "query",
      identityHash: "x".repeat(43),
      namespace: "x".repeat(43),
      evidenceId: "not-receipt",
      generation: "g1",
      sourceHash: "h1",
    },
  ]);
  try {
    await assert.rejects(
      h.store
        .statement(
          "INSERT INTO lotw_ownership_write_guards(id,tenant,phase,key_id,clock,comparison_policy,plan,lease_token,lease_fence,checked_at,expires_at) VALUES('old','a','mapping',?,?,1,?,?,?,?,?)",
          state.key_id,
          state.clock,
          plan,
          lease.token,
          lease.fence,
          Date.now(),
          lease.expires_at,
        )
        .run(),
      /LoTW ownership unavailable/,
    );
  } finally {
    await h.store.release(lease);
  }
});

test("twenty-member native batch stays bounded and an unknown commit outcome never retries", async (t) => {
  const h = await fixture(t),
    members = [member(h.first)];
  for (let i = 1; i < 20; i++)
    members.push(
      member(await owner(h.store, `q${i + 1}`), record({ CALL: `K${i}ABC` })),
    );
  await backfillLotwOwnership(h.store, "a");
  const p = await prepareLotwHistoricalAssociations(h.store, members),
    statements = [...p.begin, ...p.publications, ...p.finish];
  assert.equal(statements.length, 82);
  let calls = 0;
  try {
    await assert.rejects(
      (async () => {
        calls++;
        await h.db.batch(statements);
        throw new Error("lost acknowledgement");
      })(),
      /lost acknowledgement/,
    );
  } finally {
    await p.release();
  }
  assert.equal(calls, 1);
  assert.equal(await count(h.store, "lotw_historical_associations"), 20);
  assert.equal(await count(h.store, "lotw_historical_guards"), 0);
  await assert.rejects(
    prepareLotwHistoricalAssociations(h.store, [...members, members[0]]),
    /invalid_lotw_historical_cohort/,
  );
  assert.equal(
    (
      await lookupLotwHistoricalOwnership(
        h.store,
        "a",
        members.map((m) => m.record),
      )
    ).candidates.length,
    20,
  );
});

test("combined exact plus raw candidate cap precedes sort and unrelated population does not add reads", async (t) => {
  const h = await fixture(t, true);
  await publish(h.store, [member(h.first, record({ CALL: "K1ABC" }))]);
  for (let n = 0; n < 127; n++)
    await h.store
      .statement(
        "INSERT INTO lotw_ownership_evidence SELECT tenant,?,destination,source,?,exact_hash,key_id,bucket,envelope,created_at FROM lotw_ownership_evidence WHERE source='source' AND qso='old'",
        `near${n}`,
        `near${n}`,
      )
      .run();
  let before = 0;
  for (const extra of [false, true]) {
    if (extra)
      await h.store
        .statement(
          "WITH RECURSIVE n(x) AS(VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<999) INSERT INTO lotw_ownership_evidence SELECT e.tenant,'far'||n.x,e.destination,e.source,'far'||n.x,e.exact_hash,e.key_id,'unrelated'||n.x,e.envelope,e.created_at FROM n CROSS JOIN lotw_ownership_evidence e WHERE e.qso='old'",
        )
        .run();
    const meter = measuredDatabase(h.db),
      queries: string[] = [],
      db = Object.create(meter.database) as D1Database;
    db.prepare = (q) => {
      queries.push(q);
      return meter.database.prepare(q);
    };
    db.batch = meter.database.batch.bind(meter.database);
    const result = await lookupLotwHistoricalOwnership(
      new Store(db, keys),
      "a",
      [record(), record({ CALL: "K1ABC" })],
    );
    assert.equal(result.reason, "candidate_bound");
    assert.deepEqual(result.candidates, []);
    assert.equal(meter.metrics.calls, 2);
    assert.ok(meter.metrics.rowsRead < 2500, `${meter.metrics.rowsRead} rows`);
    if (extra)
      assert.ok(
        meter.metrics.rowsRead <= before + 2,
        "only constant B-tree height overhead, not an unrelated-row scan",
      );
    else before = meter.metrics.rowsRead;
    const query = queries.find((q) =>
      q.startsWith("WITH requested AS MATERIALIZED"),
    );
    assert.ok(query);
    const rows = await h.store
      .statement(
        "SELECT key_id,bucket FROM lotw_ownership_evidence WHERE qso='old' UNION ALL SELECT key_id,bucket FROM lotw_historical_associations",
      )
      .all<{ key_id: string; bucket: string }>();
    const plan = await h.store
      .statement(
        `EXPLAIN QUERY PLAN ${query}`,
        JSON.stringify(rows.results.map((r) => r.bucket)),
        "a",
        rows.results[0].key_id,
        "a",
        rows.results[0].key_id,
        129,
        4194304,
        4194304,
      )
      .all<{ detail: string }>();
    assert.ok(
      plan.results.some(
        (r) =>
          r.detail.includes("lotw_ownership_bucket") &&
          r.detail.includes("bucket=?"),
      ),
    );
    assert.ok(
      plan.results.some(
        (r) =>
          r.detail.includes("lotw_historical_bucket") &&
          r.detail.includes("bucket=?"),
      ),
    );
    const bounded = plan.results.findIndex(
        (r) => r.detail === "MATERIALIZE bounded",
      ),
      sized = plan.results.findIndex((r) => r.detail.includes("SCAN bounded"));
    assert.ok(bounded >= 0 && sized > bounded);
    assert.ok(
      !plan.results
        .slice(bounded, sized)
        .some((r) => r.detail.includes("TEMP B-TREE")),
    );
  }
});

test("coverage snapshots seek pending statuses instead of scanning covered inputs", async (t) => {
  const h = await fixture(t);
  const result = await lookupLotwHistoricalOwnership(h.store, "a", [record()]);
  assert.ok(result.snapshot);
  const guard = lotwHistoricalSnapshotGuard(result.snapshot);
  const plan = await h.store
    .statement(`EXPLAIN QUERY PLAN SELECT (${guard.sql})`, ...guard.params)
    .all<{ detail: string }>();
  assert.ok(
    plan.results.some(
      (r) =>
        r.detail.includes("lotw_ownership_pending") &&
        r.detail.includes("tenant=? AND status=?"),
    ),
    JSON.stringify(plan.results),
  );
  await h.store
    .statement(
      "INSERT INTO lotw_ownership_inputs(tenant,kind,destination,reference,source,qso,status) VALUES('a','legacy','query','unknown','source','unknown','held')",
    )
    .run();
  assert.equal(
    (await lookupLotwHistoricalOwnership(h.store, "a", [record()])).state,
    "held",
  );
  assert.equal(
    await h.store
      .statement(`SELECT (${guard.sql}) AS valid`, ...guard.params)
      .first("valid"),
    0,
  );
});

test("actual midnight two-leaf inventory, reconciliation and reverse guards compose below100 binds and fail atomically", async (t) => {
  const h = await fixture(t);
  await h.store
    .statement(
      "UPDATE connections SET config=?,credential_version='v2' WHERE id='source'",
      JSON.stringify({ accountId: "source" }),
    )
    .run();
  await (
    await h.store.putPrivate("a", "source", "v2", "credential", {
      key: "fixture",
      secret: "fixture",
      token: "fixture",
    })
  ).run();
  await h.store
    .statement(
      "UPDATE connections SET config=? WHERE id='query'",
      JSON.stringify({ stations: [{ callsign: "N0CALL", dxcc: 291 }] }),
    )
    .run();
  await (
    await h.store.putPrivate("a", "query", "v1", "credential", {
      query: { username: "operator", password: "fixture" },
    })
  ).run();
  const source = await h.store.connection("a", "source"),
    destination = await h.store.connection("a", "query");
  assert.ok(source);
  assert.ok(destination);
  const raw = {
    uuid: "q1",
    syncedAtMillis: 100,
    operation: null,
    startAtMillis: Date.UTC(2026, 9, 22, 0, 0),
    their: { call: "W1AW" },
    our: { call: "N0CALL", grid: "FN31AA" },
    mode: "CW",
    band: "20m",
    freq: 14030,
  };
  for (let i = 0; i < 3; i++)
    await pollSource(
      h.store,
      source,
      async () =>
        Response.json({
          account: { uuid: "source" },
          qsos: i ? [] : [raw],
          operations: [],
          meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
        }),
      Date.now(),
      "sync",
      (i + 1) * 300000,
    );
  await backfillSourceHistoricalIndex(h.store, "a");
  const contact = (await pendingContacts(h.store, source, 1))[0];
  assert.ok(contact);
  await observeContact(h.store, source, contact, Date.now(), [destination]);
  const remote = { ...contactReconciliationAdif(contact), TIME_ON: "0000" };
  let history: HistoryInventoryResult | undefined;
  const now = Date.now();
  for (let turn = 0; turn < 4; turn++) {
    history = await historyCandidates(
      h.store,
      {
        source,
        destination,
        qso: contact.id,
        generation: contact.generation,
        record: contactReconciliationAdif(contact),
      },
      {
        now,
        vendorNow: now + turn * 300000,
        fetcher: async (input) => {
          const p = new URL(String(input)).searchParams;
          const rows =
            p.get("qso_startdate")! <= "2026-10-22" &&
            p.get("qso_enddate")! >= "2026-10-22"
              ? [remote]
              : [];
          return new Response(
            `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:${String(rows.length).length}>${rows.length}<EOH>${rows.map((r) => serializeAdifRecord({ ...r, QSL_RCVD: "N" })).join("")}<APP_LOTW_EOF>`,
          );
        },
      },
    );
    if (history.state === "ready") break;
  }
  assert.equal(history?.state, "ready", history?.reason);
  assert.equal(history.fence?.partitions.length, 2);
  assert.equal(history.freshCheckComplete, false);
  const reverse = await historicalSourceCandidates(h.store, {
    tenant: "a",
    destination,
    remote,
    selected: {
      source: source.id,
      qso: contact.id,
      generation: contact.generation,
    },
    vendor: "lotw",
    routeMatches,
  });
  assert.equal(
    reverse.state,
    "unique",
    reverse.state === "held" ? reverse.reason : reverse.state,
  );
  assert.ok(reverse.state === "unique");
  const at = Date.now(),
    normal = reconciliationCommitGuard(h.first, contact, history, at),
    census = reverse.commitGuard(at),
    guard = {
      sql: `(${normal.sql}) AND (${census.sql})`,
      params: [...normal.params, ...census.params],
    };
  assert.ok(
    guard.params.length === 59,
    `${guard.params.length} guard bindings`,
  );
  assert.ok(
    await h.store
      .statement(`SELECT 1 WHERE ${guard.sql}`, ...guard.params)
      .first(),
  );
  const row = await h.store.ledger(h.first);
  assert.ok(row);
  const original = h.store.statement.bind(h.store),
    binds: number[] = [];
  h.store.statement = (sql, ...args) => {
    binds.push(args.length);
    return original(sql, ...args);
  };
  const p = await prepareLotwHistoricalAssociations(h.store, [
    {
      key: h.first,
      record: remote,
      generation: row.generation,
      sourceHash: row.source_hash,
      guard,
    },
  ]);
  assert.ok(
    Math.max(...binds) <= 100,
    `${Math.max(...binds)} maximum bindings`,
  );
  // Second leaf expires after guarded publication but before final checks.
  try {
    await assert.rejects(
      h.db.batch([
        ...p.begin,
        ...p.publications,
        original(
          "UPDATE partitions SET expires_at=0 WHERE tenant='a' AND id=?",
          history.fence!.partitions[1].id,
        ),
        ...p.finish,
      ]),
      /CHECK|historical/,
    );
  } finally {
    await p.release();
  }
  assert.equal(await count(h.store, "lotw_historical_associations"), 0);
  assert.equal((await h.store.ledger(h.first))?.remote_id, null);
  // Capture a legitimate short retention deadline before preparing the plan.
  // No row, clock, evidence token or guard is changed during the actual wait.
  const leaf = history.fence!.partitions[1].id;
  const originalExpiry = await h.store
    .statement(
      "SELECT expires_at FROM partitions WHERE tenant='a' AND id=?",
      leaf,
    )
    .first<number>("expires_at");
  assert.ok(originalExpiry);
  const expiresAt = Date.now() + 1800;
  await h.store
    .statement(
      "UPDATE partitions SET expires_at=? WHERE tenant='a' AND id=?",
      expiresAt,
      leaf,
    )
    .run();
  const preparedAt = Date.now(),
    timedNormal = reconciliationCommitGuard(
      h.first,
      contact,
      history,
      preparedAt,
    ),
    timedReverse = reverse.commitGuard(preparedAt),
    timedGuard = {
      sql: `(${timedNormal.sql}) AND (${timedReverse.sql})`,
      params: [...timedNormal.params, ...timedReverse.params],
    };
  const delayed = await prepareLotwHistoricalAssociations(h.store, [
    {
      key: h.first,
      record: remote,
      generation: row.generation,
      sourceHash: row.source_hash,
      guard: timedGuard,
    },
  ]);
  const unchangedClock = await h.store
    .statement("SELECT clock FROM lotw_ownership_state WHERE tenant='a'")
    .first("clock");
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 60)),
  );
  try {
    await assert.rejects(
      h.db.batch([
        ...delayed.begin,
        ...delayed.publications,
        ...delayed.finish,
      ]),
      /historical/,
    );
  } finally {
    await delayed.release();
  }
  assert.equal(await count(h.store, "lotw_historical_associations"), 0);
  assert.equal(
    await h.store
      .statement("SELECT clock FROM lotw_ownership_state WHERE tenant='a'")
      .first("clock"),
    unchangedClock,
  );
  await h.store
    .statement(
      "UPDATE partitions SET expires_at=? WHERE tenant='a' AND id=?",
      originalExpiry,
      leaf,
    )
    .run();
  const committed = await publish(h.store, [
    {
      key: h.first,
      record: remote,
      generation: row.generation,
      sourceHash: row.source_hash,
      guard,
    },
  ]);
  assert.equal(
    committed.results[committed.p.ledgerResultOffsets[0]].results.length,
    1,
  );
});

test("stable index-key rewrap keeps raw buckets and requires old evidence KEKs", async (t) => {
  const h = await fixture(t);
  await publish(h.store, [member(h.first)]);
  const before = await h.store
    .statement(
      "SELECT key_id,namespace,bucket,envelope FROM lotw_historical_associations",
    )
    .all();
  const both = new Store(h.db, { active: "2", keys: keys.keys });
  await sourceHistoricalIndexKey(both, "a");
  assert.equal(
    (await lookupLotwHistoricalOwnership(both, "a", [record()])).state,
    "observed",
  );
  const currentOnly = new Store(h.db, {
    active: "2",
    keys: { "2": keys.keys["2"] },
  });
  assert.equal(
    (await lookupLotwHistoricalOwnership(currentOnly, "a", [record()])).reason,
    "evidence_unavailable",
  );
  assert.deepEqual(
    (
      await h.store
        .statement(
          "SELECT key_id,namespace,bucket,envelope FROM lotw_historical_associations",
        )
        .all()
    ).results,
    before.results,
  );
});

test("combined byte cap, reserved evidence and encrypted-key loss are conservative", async (t) => {
  const h = await fixture(t, true),
    original = await h.store
      .statement("SELECT * FROM lotw_ownership_evidence WHERE qso='old'")
      .first<{ id: string; exact_hash: string; envelope: string }>();
  assert.ok(original);
  const value = await open<{
    identity: AdifRecord;
    remoteId: string;
    firstEvidence: string;
    recordedAt: number;
  }>(
    JSON.parse(original.envelope) as Envelope,
    {
      tenant: "a",
      connection: "a",
      id: original.id,
      kind: "lotw-ownership",
      purpose: "storage",
    },
    keys,
  );
  const envelope = JSON.stringify(
    await seal(
      { ...value, firstEvidence: "reserved" },
      {
        tenant: "a",
        connection: "a",
        id: "reserved",
        kind: "lotw-ownership",
        purpose: "storage",
      },
      keys,
    ),
  );
  await h.store
    .statement(
      "INSERT INTO lotw_ownership_evidence SELECT tenant,'reserved',destination,source,'reserved-owner',exact_hash,key_id,bucket,?,created_at FROM lotw_ownership_evidence WHERE qso='old'",
      envelope,
    )
    .run();
  const result = await lookupLotwHistoricalOwnership(h.store, "a", [record()]);
  assert.equal(result.state, "observed");
  assert.ok(result.candidates.some((c) => c.kind === "reserved"));
  await assert.rejects(
    prepareLotwHistoricalAssociations(h.store, [member(h.first)]),
    /competing_owner/,
  );
  // Synthetic metadata only: SQL must stop returning ciphertext after the
  // shared4MiB cap, before trying to decrypt any intentionally invalid padding.
  await h.store
    .statement(
      "WITH RECURSIVE n(x) AS(VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<49) INSERT INTO lotw_ownership_evidence SELECT e.tenant,'large'||n.x,e.destination,e.source,'large'||n.x,e.exact_hash,e.key_id,e.bucket,replace(hex(zeroblob(45000)),'0','x'),e.created_at FROM n CROSS JOIN lotw_ownership_evidence e WHERE e.qso='old'",
    )
    .run();
  assert.equal(
    (await lookupLotwHistoricalOwnership(h.store, "a", [record()])).reason,
    "byte_bound",
  );
});
