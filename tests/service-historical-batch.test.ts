import assert from "node:assert/strict";
import test from "node:test";
import { pollSource } from "../src/intake.ts";
import { tick } from "../src/service.ts";
import { backfillSourceHistoricalIndex } from "../src/source-historical-index.ts";
import { FIXTURE_NOW, schedulerFixture } from "./runtime-fixtures.ts";

async function fixture() {
  const h = await schedulerFixture();
  h.changes.operations.length = 0;
  h.changes.qsos.length = 0;
  const qrz = { ...h.qrzRecords[0] };
  const lotw = { ...h.lotwRecords[0] };
  h.qrzRecords.length = 0;
  h.lotwRecords.length = 0;
  for (let index = 0; index < 11; index++) {
    const id = `batch-${String(index).padStart(2, "0")}`;
    const call = `K1BATCH${index}`;
    h.changes.qsos.push({
      ...h.qso,
      uuid: id,
      operation: null,
      their: { call },
      our: { stationCall: "W1AW", grid: "FN31AA", dxccCode: 291 },
      syncedAtMillis: 110 + index,
    });
    h.qrzRecords.push({
      ...qrz,
      CALL: call,
      APP_QRZLOG_LOGID: String(500 + index),
    });
    h.lotwRecords.push({ ...lotw, CALL: call });
  }
  return h;
}

// Keep the actual native transaction and bound statements. Only intercept the
// shared reverse-census header phase, never synthesize rows or comparison proof.
function interceptCensus(
  db: D1Database,
  before: (index: number) => void,
  after: (index: number) => void,
) {
  const statements = new WeakMap<D1PreparedStatement, string>();
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  let calls = 0;
  const wrap = (
    statement: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement => {
    const result = new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...params: unknown[]) => wrap(target.bind(...params), sql);
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    statements.set(result, sql);
    originals.set(result, statement);
    return result;
  };
  const database = new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch")
        return async (items: D1PreparedStatement[]) => {
          const census = items.some((item) => {
            const sql = statements.get(item) ?? "";
            return (
              sql.includes("source_read_policy_ready") &&
              sql.includes("context_cursor")
            );
          });
          const index = census ? ++calls : 0;
          if (census) before(index);
          const result = await target.batch(
            items.map((item) => originals.get(item) ?? item),
          );
          if (census) after(index);
          return result;
        };
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { database, calls: () => calls };
}

for (const failure of ["second_batch", "deadline"] as const) {
  test(`historical route batches preserve completed neighbors on ${failure}`, async () => {
    const h = await fixture();
    const realNow = Date.now;
    let elapsed = 0;
    try {
      const census = interceptCensus(
        h.env.DB,
        (index) => {
          if (failure === "second_batch" && index === 2)
            throw new Error(
              "synthetic reverse comparison failure with private marker",
            );
        },
        (index) => {
          if (failure === "deadline" && index === 1) elapsed = 91_000;
        },
      );
      Date.now = () => realNow() + elapsed;
      const result = await tick(
        { ...h.env, DB: census.database },
        h.fetcher,
        FIXTURE_NOW,
      );
      Date.now = realNow;
      assert.equal(census.calls(), failure === "deadline" ? 1 : 2);
      assert.equal(result.errors, failure === "deadline" ? 0 : 2);
      assert.equal(result.throughput?.adoptedDestinations, 20);
      assert.equal(result.throughput?.classifiedDestinations, 20);
      assert(!JSON.stringify(result).includes("private marker"));
      const ledgers = await h.store
        .statement(
          "SELECT qso,destination,state,remote_id,lotw_historical_association_id FROM ledger ORDER BY qso,destination",
        )
        .all<{
          qso: string;
          destination: string;
          state: string;
          remote_id: string | null;
          lotw_historical_association_id: string | null;
        }>();
      assert.equal(ledgers.results.length, 22);
      for (const ledger of ledgers.results) {
        if (ledger.qso === "batch-10") {
          assert.equal(ledger.state, "inventory_pending");
          assert.equal(ledger.remote_id, null);
          assert.equal(ledger.lotw_historical_association_id, null);
        } else {
          assert.equal(ledger.state, "adopted_existing");
          if (ledger.destination === "lotw") {
            assert.equal(ledger.remote_id, null);
            assert(ledger.lotw_historical_association_id);
          } else
            assert.equal(
              ledger.remote_id,
              String(500 + Number(ledger.qso.slice("batch-".length))),
              "aligned reverse results preserve the exact selected QRZ record",
            );
        }
      }
      const counts = await h.store
        .statement(
          `SELECT (SELECT COUNT(*) FROM historical_associations) qrz,
         (SELECT COUNT(*) FROM lotw_historical_associations) lotw,
         (SELECT COUNT(*) FROM reconciliation_checks WHERE qso='batch-10') held_checks,
         (SELECT COUNT(*) FROM attempts) attempts`,
        )
        .first<{
          qrz: number;
          lotw: number;
          held_checks: number;
          attempts: number;
        }>();
      assert.deepEqual(counts, {
        qrz: 10,
        lotw: 10,
        held_checks: 0,
        attempts: 0,
      });
      assert.equal(h.calls.qrzWrites, 0);
      assert.equal(h.calls.lotwUploads, 0);
    } finally {
      Date.now = realNow;
      await h.mf.dispose();
    }
  });
}

test("aggregate reverse-census overflow splits without holding individually complete routes", async () => {
  const h = await schedulerFixture();
  try {
    h.changes.operations.length = 0;
    h.changes.qsos.length = 0;
    const qrz = { ...h.qrzRecords[0] };
    const lotw = { ...h.lotwRecords[0] };
    h.qrzRecords.length = 0;
    h.lotwRecords.length = 0;
    // Each call has 45 retained candidates, but only one shares the remote band.
    // Every individual comparison fits; their union of 135 exceeds the shared
    // 128-body admission. Selection stays in the actual queue and canonical sync.
    for (let route = 0; route < 3; route++) {
      const call = `K1SPLIT${route}`;
      for (let index = 0; index < 45; index++) {
        h.changes.qsos.push({
          ...h.qso,
          uuid: index ? `z-other-${route}-${index}` : `a-selected-${route}`,
          operation: null,
          band: index ? "40m" : "20m",
          freq: index ? 7074 : 14074,
          their: { call },
          our: { stationCall: "W1AW", grid: "FN31AA", dxccCode: 291 },
          syncedAtMillis: 110 + route * 45 + index,
        });
      }
      h.qrzRecords.push({
        ...qrz,
        CALL: call,
        APP_QRZLOG_LOGID: String(800 + route),
      });
      h.lotwRecords.push({ ...lotw, CALL: call });
    }
    const sourcePages: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname !== "/v1/sync")
        return h.fetcher(input, init);
      h.calls.sourceSync++;
      return Response.json({
        account: { uuid: "account-fixture" },
        operations: h.changes.operations.splice(0, 100),
        qsos: h.changes.qsos.splice(0, 100),
        meta: {
          operations: { records_left: h.changes.operations.length },
          qsos: { records_left: h.changes.qsos.length },
        },
      });
    };
    const source = await h.store.connection("a", "source");
    assert(source);
    // Complete the real canonical baseline and its bounded index rebuild before
    // measuring comparison. Future queue scheduling does not exclude a retained
    // neighbor from the reverse census; all 135 source rows remain current.
    for (let phase = 0; phase < 4; phase++)
      await pollSource(h.store, source, sourcePages, FIXTURE_NOW);
    for (let pass = 0; pass < 2; pass++)
      await backfillSourceHistoricalIndex(h.store, "a", {
        limit: 100,
        now: FIXTURE_NOW,
      });
    await h.store
      .statement(
        "UPDATE reconciliation_work SET next_due_at=? WHERE qso LIKE 'z-other-%'",
        FIXTURE_NOW + 86_400_000,
      )
      .run();
    const census = interceptCensus(
      h.env.DB,
      () => {},
      () => {},
    );
    const result = await tick(
      { ...h.env, DB: census.database },
      sourcePages,
      FIXTURE_NOW,
    );
    assert.equal(result.errors, 0);
    assert.equal(result.exportsEnabled, false);
    assert.equal(result.throughput?.adoptedDestinations, 6);
    assert.equal(
      census.calls(),
      2,
      "the oversized parent never fetches bodies; its two complete child cohorts do",
    );
    for (let route = 0; route < 3; route++) {
      const key = { tenant: "a", source: "source", qso: `a-selected-${route}` };
      const qrzLedger = await h.store.ledger({
        ...key,
        destination: "destination",
      });
      const lotwLedger = await h.store.ledger({ ...key, destination: "lotw" });
      assert.equal(qrzLedger?.state, "adopted_existing");
      assert.equal(qrzLedger.remote_id, String(800 + route));
      assert.equal(lotwLedger?.state, "adopted_existing");
      assert.equal(lotwLedger.remote_id, null);
      assert(lotwLedger.lotw_historical_association_id);
    }
    const counts = await h.store
      .statement(
        `SELECT (SELECT COUNT(*) FROM source_historical_index WHERE dirty=0) published,
       (SELECT COUNT(*) FROM historical_associations) qrz,
       (SELECT COUNT(*) FROM lotw_historical_associations) lotw,
       (SELECT COUNT(*) FROM attempts) attempts`,
      )
      .first<{
        published: number;
        qrz: number;
        lotw: number;
        attempts: number;
      }>();
    assert.deepEqual(counts, { published: 135, qrz: 3, lotw: 3, attempts: 0 });
    assert.equal(h.calls.qrzWrites, 0);
    assert.equal(h.calls.lotwUploads, 0);
  } finally {
    await h.mf.dispose();
  }
});
