import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { AdifRecord } from "../src/adif.ts";
import { measuredDatabase } from "../src/database-metrics.ts";
import { contactReconciliationAdif } from "../src/delivery.ts";
import type { HistoricalVendor } from "../src/historical-matching.ts";
import {
  type HistoricalSourceCandidateBatchRequest,
  type HistoricalSourceCandidateResult,
  historicalSourceCandidates,
  historicalSourceCandidatesBatch,
} from "../src/historical-source-candidates.ts";
import { pollSource, rereadOperation } from "../src/intake.ts";
import type { SourceRecord } from "../src/lofi.ts";
import { projectContact } from "../src/projection.ts";
import { backfillSourceHistoricalIndex } from "../src/source-historical-index.ts";
import { sourceReadPolicy } from "../src/source-read-policy.ts";
import { type Connection, Store } from "../src/store.ts";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

const at = Date.UTC(2026, 9, 24, 12);
const qso = (id: string, changes: SourceRecord = {}): SourceRecord => ({
  uuid: id,
  syncedAtMillis: 100,
  operation: null,
  startAtMillis: at,
  their: { call: "W1AW" },
  our: { call: "N0CALL", grid: "FN31AA" },
  mode: "CW",
  band: "20m",
  freq: 14030,
  ...changes,
});
const operation: SourceRecord = {
  uuid: "op",
  syncedAtMillis: 99,
  stationCall: "N0CALL",
  grid: "FN31AA",
};
const route = (destination: Connection, contact: { stationCall: string }) => {
  const config = JSON.parse(destination.config);
  return destination.kind === "lotw"
    ? config.stations.some(
        (station: { callsign: string }) =>
          station.callsign === contact.stationCall,
      )
    : config.stationCallsign === contact.stationCall;
};

async function index(store: Store) {
  for (let i = 0; i < 10; i++) {
    const result = await backfillSourceHistoricalIndex(store, "a", {
      limit: 100,
    });
    assert.equal(result.held, 0, "fixture source metadata can be indexed");
    if (!result.rebuilding && result.examined < 100) return;
  }
  throw new Error("fixture index did not finish");
}

async function setup(
  t: TestContext,
  records = [qso("q1")],
  ops: SourceRecord[] = [],
  vendor: HistoricalVendor = "qrz",
) {
  const h = await database();
  t.after(() => h.mf.dispose());
  await applyAdditionalMigrations(h.db);
  await seed(h.store);
  await h.store
    .statement(
      "UPDATE connections SET kind=?,config=? WHERE tenant='a' AND id='destination'",
      vendor,
      JSON.stringify(
        vendor === "lotw"
          ? {
              stations: [
                { callsign: "N0CALL", dxcc: 291 },
                { callsign: "N0CALL/P", dxcc: 291 },
              ],
            }
          : {
              stationCallsign: "N0CALL",
              startDate: "2020-01-01",
              endDate: "2030-01-01",
            },
      ),
    )
    .run();
  let window = 0;
  const prepareSource = async (id: string) => {
    if (id !== "source") {
      await h.store
        .statement(
          "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,created_at) VALUES('a',?,'lofi',?,?,'active','v1',0)",
          id,
          id,
          id,
        )
        .run();
      await (
        await h.store.putPrivate("a", id, "v1", "credential", {
          key: "fixture",
          secret: "fixture",
          token: "fixture",
        })
      ).run();
    } else {
      await h.store
        .statement(
          "UPDATE connections SET credential_version='v2' WHERE tenant='a' AND id='source'",
        )
        .run();
      await (
        await h.store.putPrivate("a", id, "v2", "credential", {
          key: "fixture",
          secret: "fixture",
          token: "fixture",
        })
      ).run();
    }
    await h.store
      .statement(
        "UPDATE connections SET config=? WHERE tenant='a' AND id=?",
        JSON.stringify({ accountId: id }),
        id,
      )
      .run();
    const source = await h.store.connection("a", id);
    assert.ok(source);
    return source;
  };
  const reply = (
    source: Connection,
    qsos: SourceRecord[],
    operations: SourceRecord[],
  ) =>
    Response.json({
      account: { uuid: source.id },
      qsos,
      operations,
      meta: { operations: { records_left: 0 }, qsos: { records_left: 0 } },
    });
  const poll = async (
    source: Connection,
    qsos: SourceRecord[] = [],
    operations: SourceRecord[] = [],
  ) =>
    pollSource(
      h.store,
      source,
      async () => reply(source, qsos, operations),
      Date.now(),
      "sync",
      ++window * 300_000,
    );
  const initialize = async (
    source: Connection,
    qsos: SourceRecord[],
    operations: SourceRecord[] = [],
  ) => {
    for (let offset = 0; offset < qsos.length; offset += 100)
      await poll(
        source,
        qsos.slice(offset, offset + 100),
        offset ? [] : operations,
      );
    for (
      let i = 0;
      i < 3 &&
      (await sourceReadPolicy(h.store, "a", source.id))?.phase !== "ready";
      i++
    )
      await poll(source);
    assert.equal(
      (await sourceReadPolicy(h.store, "a", source.id))?.phase,
      "ready",
    );
    if (operations.length)
      await rereadOperation(
        h.store,
        source,
        async () =>
          reply(
            source,
            qsos.filter((record) => record.operation === operations[0]?.uuid),
            [],
          ),
        Date.now(),
        undefined,
        ++window * 300_000,
      );
  };
  const source = await prepareSource("source");
  await initialize(source, records, ops);
  await index(h.store);
  const destination = await h.store.connection("a", "destination");
  assert.ok(destination);
  const selected = await projectContact(
    records[0],
    ops.find((op) => op.uuid === records[0].operation) ?? null,
    [],
    {
      operationComplete: true,
    },
  );
  const remote: AdifRecord = {
    ...contactReconciliationAdif(selected),
    ...(vendor === "qrz" ? { APP_QRZLOG_LOGID: "123" } : {}),
  };
  const compare = (
    changes: Partial<Parameters<typeof historicalSourceCandidates>[1]> = {},
  ) =>
    historicalSourceCandidates(h.store, {
      tenant: "a",
      destination,
      remote,
      selected: {
        source: source.id,
        qso: selected.id,
        generation: selected.generation,
      },
      vendor,
      routeMatches: route,
      ...changes,
    });
  return {
    ...h,
    source,
    destination,
    selected,
    remote,
    compare,
    poll,
    prepareSource,
    initialize,
  };
}

async function guardCurrent(
  store: Store,
  result: HistoricalSourceCandidateResult,
  now = Date.now(),
) {
  assert.equal(result.state, "unique");
  if (result.state !== "unique") throw new Error("fixture expected unique");
  const guard = result.commitGuard(now);
  assert.ok(guard.params.length < 50);
  return Boolean(
    await store
      .statement(`SELECT 1 AS current WHERE ${guard.sql}`, ...guard.params)
      .first(),
  );
}

async function secondDestination(store: Store) {
  await store
    .statement(
      `INSERT INTO connections(tenant,id,kind,remote_identity,label,status,config,created_at)
     VALUES('a','lotw','lotw','query:fixture','LoTW','active',?,0)`,
      JSON.stringify({ stations: [{ callsign: "N0CALL", dxcc: 291 }] }),
    )
    .run();
  const destination = await store.connection("a", "lotw");
  assert.ok(destination);
  return destination;
}
async function requestFor(
  destination: Connection,
  record: SourceRecord,
  op: SourceRecord | null = null,
): Promise<HistoricalSourceCandidateBatchRequest> {
  const contact = await projectContact(record, op, [], {
    operationComplete: true,
  });
  return {
    destination,
    vendor: destination.kind as HistoricalVendor,
    remote: {
      ...contactReconciliationAdif(contact),
      ...(destination.kind === "qrz" ? { APP_QRZLOG_LOGID: "123" } : {}),
    },
    selected: {
      source: "source",
      qso: contact.id,
      generation: contact.generation,
    },
    routeMatches: route,
  };
}
function observeReads(
  db: D1Database,
  after: (sql: string[], results: D1Result[]) => Promise<void> = async () => {},
) {
  const queries = new WeakMap<D1PreparedStatement, string>();
  const envelopeSizes: number[] = [];
  const wrap = (
    statement: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (key === "all" || key === "first")
          return async (...args: unknown[]) => {
            const result = await Reflect.apply(
              Reflect.get(target, key),
              target,
              args,
            );
            if (sql.includes("AS key,p.envelope"))
              envelopeSizes.push(result.results.length);
            await after([sql], key === "all" ? [result] : []);
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    queries.set(proxy, sql);
    return proxy;
  };
  const database = new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          await after(
            statements.map((statement) => queries.get(statement) ?? ""),
            results,
          );
          return results;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database, envelopeSizes };
}
function outcome(result: HistoricalSourceCandidateResult) {
  const { state, inspected, competitors } = result;
  return {
    state,
    inspected,
    competitors,
    ...(state === "held" ? { reason: result.reason } : {}),
    ...(state === "unique"
      ? {
          owner: result.owner,
          generation: result.contact.generation,
          candidate: result.candidate,
        }
      : {}),
  };
}

test("twenty mixed vendor requests share five read RPCs while retaining singleton outcomes and guards", async (t) => {
  const records = Array.from({ length: 10 }, (_, i) =>
    qso(`batch-${i}`, {
      their: { call: `W${i + 1}AW` },
      startAtMillis: at - i * 7 * 86400000,
    }),
  );
  const h = await setup(t, records);
  const lotw = await secondDestination(h.store);
  const requests = (
    await Promise.all(
      records.map(async (record) => [
        await requestFor(h.destination, record),
        await requestFor(lotw, record),
      ]),
    )
  ).flat();
  for (const request of requests)
    request.remote.TIME_ON = request.remote.TIME_ON.slice(0, 4);
  const expected = [];
  for (const request of requests)
    expected.push(
      await historicalSourceCandidates(h.store, { tenant: "a", ...request }),
    );
  const read = observeReads(h.db);
  const meter = measuredDatabase(read.database);
  const results = await historicalSourceCandidatesBatch(
    new Store(meter.database, h.store.keys),
    "a",
    requests,
  );
  assert.deepEqual(results.map(outcome), expected.map(outcome));
  assert.equal(results.filter((r) => r.state === "unique").length, 20);
  assert.equal(meter.metrics.calls, 5);
  assert.equal(meter.metrics.rowsWritten, 0);
  assert.deepEqual(
    read.envelopeSizes,
    [10],
    "one body load for each distinct candidate, not each route",
  );
  t.diagnostic(
    `20 routes/10 shared candidates: ${meter.metrics.calls} RPCs / ${meter.metrics.statements} SQL / ${meter.metrics.rowsRead} rows read`,
  );
  for (const result of results)
    assert.equal(await guardCurrent(h.store, result), true);
  await h.store
    .statement(
      "UPDATE connections SET remote_identity='changed' WHERE tenant='a' AND id='lotw'",
    )
    .run();
  assert.equal(
    await guardCurrent(h.store, results[0]),
    false,
    "shared comparison clock conservatively fences any logical connection change",
  );
  assert.equal(await guardCurrent(h.store, results[1]), false);
  await assert.rejects(
    historicalSourceCandidatesBatch(h.store, "a", [...requests, requests[0]]),
    /historical_source_batch_bound/,
  );
});

test("shared reads preserve separate vendor mode rules and minute windows across UTC midnight", async (t) => {
  const records = [
    qso("ft8", { mode: "FT8", startAtMillis: Date.UTC(2026, 9, 23, 23, 45) }),
    qso("rtty", {
      mode: "RTTY",
      startAtMillis: Date.UTC(2026, 9, 24, 0, 45, 59),
    }),
  ];
  const h = await setup(t, records);
  const lotw = await secondDestination(h.store);
  const qrz = await requestFor(h.destination, records[0]);
  const lotwRequest = await requestFor(lotw, records[0]);
  for (const request of [qrz, lotwRequest])
    Object.assign(request.remote, { QSO_DATE: "20261024", TIME_ON: "0015" });
  const results = await historicalSourceCandidatesBatch(h.store, "a", [
    qrz,
    lotwRequest,
  ]);
  assert.equal(
    results[0].state,
    "unique",
    "QRZ FT8 does not collapse a distinct RTTY mode",
  );
  assert.equal(
    results[1].state,
    "ambiguous",
    "LoTW DATA modes retain both owners in the full minute interval",
  );
  assert.equal(results[1].competitors, 2);
  const narrow = { ...qrz, remote: { ...qrz.remote, TIME_ON: "001500" } };
  const narrowed = await historicalSourceCandidatesBatch(h.store, "a", [
    narrow,
    { ...lotwRequest, remote: narrow.remote },
  ]);
  assert.deepEqual(
    narrowed.map((r) => r.state),
    ["unique", "unique"],
  );
});

test("an archived overlapping body holds its own request without disappearing or poisoning an unrelated request", async (t) => {
  const records = [
    qso("available"),
    qso("archived", { their: { call: "W2AW" } }),
  ];
  const h = await setup(t, records);
  const requests = await Promise.all(
    records.map((record) => requestFor(h.destination, record)),
  );
  await h.store
    .statement(
      "DELETE FROM private_data WHERE tenant='a' AND connection='source' AND id IN(SELECT private_id FROM source_work WHERE id='archived' AND kind='qso')",
    )
    .run();
  const results = await historicalSourceCandidatesBatch(h.store, "a", requests);
  assert.equal(results[0].state, "unique");
  assert.equal(results[1].state, "held");
  assert.equal(await guardCurrent(h.store, results[0]), true);
  await h.poll(h.source, [qso("unknown", { their: {}, syncedAtMillis: 200 })]);
  await index(h.store);
  const unknown = await historicalSourceCandidatesBatch(h.store, "a", requests);
  assert(
    unknown.every((result) => result.state === "held"),
    "unknown matching bucket is not discarded from either request",
  );
});

test("shared operation closure is read once and all independent guards reject a later non-effective event", async (t) => {
  const records = [
    qso("q1", { operation: "op", our: {} }),
    qso("q2", { operation: "op", their: { call: "W2AW" }, our: {} }),
  ];
  const note = {
    uuid: "note",
    operation: "op",
    band: "event",
    event: { event: "note" },
    syncedAtMillis: 101,
  };
  const h = await setup(t, [...records, note], [operation]);
  const requests = await Promise.all(
    records.map((record) => requestFor(h.destination, record, operation)),
  );
  const read = observeReads(h.db),
    meter = measuredDatabase(read.database);
  const results = await historicalSourceCandidatesBatch(
    new Store(meter.database, h.store.keys),
    "a",
    requests,
  );
  assert.deepEqual(
    results.map((r) => r.state),
    ["unique", "unique"],
  );
  assert.equal(meter.metrics.calls, 6);
  assert.deepEqual(
    read.envelopeSizes,
    [4],
    "two QSOs, one shared base and one retained note",
  );
  for (const result of results)
    assert.equal(await guardCurrent(h.store, result), true);
  await h.poll(h.source, [
    { ...note, uuid: "later-note", syncedAtMillis: 102 },
  ]);
  for (const result of results)
    assert.equal(await guardCurrent(h.store, result), false);
});

test("captured inputs are immutable and source changes during shared reads prevent unique results", async (t) => {
  const records = [qso("q1"), qso("q2", { their: { call: "W2AW" } })];
  const h = await setup(t, records);
  const requests = await Promise.all(
    records.map((record) => requestFor(h.destination, record)),
  );
  let changed = false;
  const read = observeReads(h.db, async (sql) => {
    if (
      !changed &&
      sql[0]?.includes("source_historical_state h WHERE tenant")
    ) {
      changed = true;
      requests[0].remote.CALL = "W9WRONG";
      requests[0].destination.config = "{}";
      requests[0].selected.generation = "mutated";
    }
  });
  const results = await historicalSourceCandidatesBatch(
    new Store(read.database, h.store.keys),
    "a",
    requests,
  );
  assert(changed);
  assert(results.every((r) => r.state === "unique"));
  const currentRequests = await Promise.all(
    records.map((record) => requestFor(h.destination, record)),
  );
  // requestFor shares its caller's destination; restore the deliberately changed
  // caller object, never any production state, before the second invocation.
  const currentDestination = await h.store.connection("a", "destination");
  assert.ok(currentDestination);
  for (const request of currentRequests)
    request.destination = currentDestination;
  let raced = false;
  const race = observeReads(h.db, async (sql) => {
    if (!raced && sql.some((query) => query.includes("AS key,p.envelope"))) {
      raced = true;
      await h.store
        .statement(
          "UPDATE cursors SET generation=generation+1 WHERE tenant='a' AND connection='source' AND stream='context'",
        )
        .run();
    }
  });
  const stale = await historicalSourceCandidatesBatch(
    new Store(race.database, h.store.keys),
    "a",
    currentRequests,
  );
  assert(raced);
  assert(
    stale.every((r) => r.state === "held" && r.reason === "source_changed"),
  );
});

test("combined disjoint candidate overflow holds before body reads even when each request fits", async (t) => {
  const records = Array.from({ length: 130 }, (_, i) =>
    qso(`q${i}`, {
      their: { call: i < 65 ? "W1AW" : "W2AW" },
      mode: i % 65 === 0 ? "CW" : "SSB",
    }),
  );
  const h = await setup(t, records);
  const requests = await Promise.all(
    [records[0], records[65]].map((record) =>
      requestFor(h.destination, record),
    ),
  );
  const read = observeReads(h.db),
    meter = measuredDatabase(read.database);
  const results = await historicalSourceCandidatesBatch(
    new Store(meter.database, h.store.keys),
    "a",
    requests,
  );
  assert(
    results.every(
      (r) =>
        r.state === "held" && r.reason === "cohort_bound" && r.inspected === 0,
    ),
  );
  assert.equal(meter.metrics.calls, 2);
  assert.deepEqual(read.envelopeSizes, []);
  for (const request of requests) {
    const [subset] = await historicalSourceCandidatesBatch(h.store, "a", [
      request,
    ]);
    assert.equal(
      subset.state,
      "unique",
      "smaller complete scope makes progress without truncating65 candidates",
    );
    assert.equal(subset.inspected, 65);
    assert.equal(await guardCurrent(h.store, subset), true);
  }
});

test("ciphertext admission is global across disjoint requests and fetches no partial envelopes", async (t) => {
  const records = [
    qso("q1"),
    qso("q2", { their: { call: "W2AW" } }),
    qso("q3", { their: { call: "W3AW" } }),
  ];
  const h = await setup(t, records);
  await h.store
    .statement(
      "UPDATE private_data SET envelope=json_set(envelope,'$.legacyPadding',?) WHERE tenant='a' AND connection='source' AND kind='source'",
      "x".repeat(1_400_000),
    )
    .run();
  for (let i = 0; i < 3; i++)
    assert.equal(
      (await backfillSourceHistoricalIndex(h.store, "a", { limit: 1 }))
        .published,
      1,
    );
  const requests = await Promise.all(
    records.map((record) => requestFor(h.destination, record)),
  );
  const read = observeReads(h.db),
    meter = measuredDatabase(read.database);
  const results = await historicalSourceCandidatesBatch(
    new Store(meter.database, h.store.keys),
    "a",
    requests,
  );
  assert(
    results.every(
      (r) =>
        r.state === "held" && r.reason === "cohort_bound" && r.inspected === 0,
    ),
  );
  assert.equal(meter.metrics.calls, 3);
  assert.deepEqual(read.envelopeSizes, []);
});

test("combined operation closures respect the global dependency cap without dropping live events", async (t) => {
  const ops = [
    { ...operation, uuid: "op1" },
    { ...operation, uuid: "op2" },
  ];
  const records = [
    qso("q1", { operation: "op1", our: {} }),
    qso("q2", { operation: "op2", their: { call: "W2AW" }, our: {} }),
  ];
  const h = await setup(t, records, ops);
  const events = Array.from({ length: 254 }, (_, i) => ({
    uuid: `note-${i}`,
    operation: i < 127 ? "op1" : "op2",
    band: "event",
    event: { event: "note" },
    syncedAtMillis: 200 + i,
  }));
  for (let offset = 0; offset < events.length; offset += 25)
    await h.poll(h.source, events.slice(offset, offset + 25));
  // Canonical event arrivals correctly make their operations pending. Complete
  // both ordinary rereads before asking smaller scopes to authorize recognition.
  for (let i = 0; i < 2; i++) {
    const reread = await rereadOperation(
      h.store,
      h.source,
      async (input) => {
        const id = new URL(String(input)).pathname.split("/")[3];
        assert(ops.some((operation) => operation.uuid === id));
        return Response.json({
          qsos: [...records, ...events].filter(
            (record) => record.operation === id,
          ),
          meta: { qsos: { records_left: 0 } },
        });
      },
      Date.now(),
      undefined,
      (100 + i) * 300_000,
    );
    assert.equal(reread.complete, true);
  }
  const requests = await Promise.all(
    records.map((record, i) => requestFor(h.destination, record, ops[i])),
  );
  const read = observeReads(h.db),
    meter = measuredDatabase(read.database);
  const results = await historicalSourceCandidatesBatch(
    new Store(meter.database, h.store.keys),
    "a",
    requests,
  );
  assert(
    results.every(
      (r) =>
        r.state === "held" && r.reason === "cohort_bound" && r.inspected === 0,
    ),
  );
  assert.deepEqual(read.envelopeSizes, []);
  for (const request of requests) {
    const [subset] = await historicalSourceCandidatesBatch(h.store, "a", [
      request,
    ]);
    assert.equal(
      subset.state,
      "unique",
      "129 complete dependencies fit separately without omitting events",
    );
    assert.equal(await guardCurrent(h.store, subset), true);
  }
});
