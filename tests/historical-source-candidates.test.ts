import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { AdifRecord } from "../src/adif.ts";
import { measuredDatabase } from "../src/database-metrics.ts";
import { contactReconciliationAdif } from "../src/delivery.ts";
import {
  HISTORICAL_SOURCE_CANDIDATE_LIMIT,
  type HistoricalSourceCandidateResult,
  historicalSourceCandidates,
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
const route = (destination: Connection, contact: { stationCall: string }) =>
  JSON.parse(destination.config).stationCallsign === contact.stationCall;

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
) {
  const h = await database();
  t.after(() => h.mf.dispose());
  await applyAdditionalMigrations(h.db);
  await seed(h.store);
  await h.store
    .statement(
      "UPDATE connections SET config=? WHERE tenant='a' AND id='destination'",
      JSON.stringify({
        stationCallsign: "N0CALL",
        startDate: "2020-01-01",
        endDate: "2030-01-01",
      }),
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
    APP_QRZLOG_LOGID: "123",
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
      vendor: "qrz",
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

test("a sole retained source owner preserves minute precision and supplies a current bounded commit guard", async (t) => {
  const h = await setup(t);
  const result = await h.compare({ remote: { ...h.remote, TIME_ON: "1200" } });
  assert.equal(result.state, "unique");
  assert.equal(result.competitors, 1);
  assert.equal(result.inspected, 1);
  assert.equal(result.authoritative, false);
  assert.equal(result.coverage, "retained_sources");
  if (result.state === "unique") {
    assert.deepEqual(result.owner, { source: "source", qso: "q1" });
    assert.equal(result.contact.generation, h.selected.generation);
    assert.equal(result.candidate.record.TIME_ON, "1200");
  }
  assert.equal(await guardCurrent(h.store, result), true);
});

test("reverse window is centered on the remote, including a competitor sixty minutes from the original source", async (t) => {
  const h = await setup(t, [
    qso("q1", { startAtMillis: at - 30 * 60_000 }),
    qso("q2", {
      startAtMillis: at + 30 * 60_000,
      our: { call: "N0CALL", grid: "JO22AA" },
    }),
  ]);
  const result = await h.compare({
    remote: { ...h.remote, TIME_ON: "120000" },
  });
  assert.equal(result.state, "ambiguous");
  assert.equal(
    result.competitors,
    2,
    "conflicting location does not hide another identity candidate",
  );
});

test("HHMM reverse intervals cross UTC midnight without truncating the last minute", async (t) => {
  const before = Date.UTC(2026, 9, 23, 23, 45);
  const h = await setup(t, [
    qso("q1", { startAtMillis: before }),
    qso("q2", { startAtMillis: Date.UTC(2026, 9, 24, 0, 45, 59) }),
  ]);
  const result = await h.compare({
    remote: { ...h.remote, QSO_DATE: "20261024", TIME_ON: "0015" },
  });
  assert.equal(result.state, "ambiguous");
  assert.equal(result.competitors, 2);
});

test("all active source connections participate and a late arrival invalidates the captured guard", async (t) => {
  const h = await setup(t);
  const prior = await h.compare();
  assert.equal(await guardCurrent(h.store, prior), true);
  const other = await h.prepareSource("other-source");
  await h.initialize(other, [qso("other-qso")]);
  assert.equal(await guardCurrent(h.store, prior), false);
  await index(h.store);
  const result = await h.compare();
  assert.equal(result.state, "ambiguous");
  assert.equal(result.competitors, 2);
});

test("changed context, new events, and body expiry cannot use an earlier unique result", async (t) => {
  const h = await setup(
    t,
    [qso("q1", { operation: "op", our: {} })],
    [operation],
  );
  const prior = await h.compare();
  assert.equal(await guardCurrent(h.store, prior), true);
  await h.poll(h.source, [
    {
      uuid: "event",
      operation: "op",
      band: "event",
      event: { event: "note" },
      syncedAtMillis: 101,
    },
  ]);
  assert.equal(await guardCurrent(h.store, prior), false);
  await rereadOperation(
    h.store,
    h.source,
    async () =>
      Response.json({
        account: { uuid: "source" },
        qsos: [
          qso("q1", { operation: "op", our: {} }),
          {
            uuid: "event",
            operation: "op",
            band: "event",
            event: { event: "note" },
            syncedAtMillis: 101,
          },
        ],
        meta: { qsos: { records_left: 0 } },
      }),
    Date.now(),
    undefined,
    99 * 300_000,
  );
  await index(h.store);
  const after = await h.compare();
  assert.equal(
    after.state,
    "unique",
    "new note is projected with the complete retained event set",
  );
  assert.equal(await guardCurrent(h.store, after), true);
  await h.store
    .statement(
      "UPDATE private_data SET expires_at=? WHERE tenant='a' AND connection='source' AND id IN(SELECT private_id FROM source_work WHERE tenant='a' AND source='source' AND id='event')",
      Date.now() - 1,
    )
    .run();
  assert.equal(await guardCurrent(h.store, after), false);
  assert.equal((await h.compare()).state, "held");
});

test("a relevant failed projection holds the whole cohort, while an unrelated call does not", async (t) => {
  const h = await setup(t, [qso("q1"), qso("bad", { freq: 7000 })]);
  const result = await h.compare();
  assert.equal(result.state, "held");
  if (result.state === "held")
    assert.equal(result.reason, "source_projection_unavailable");
  await h.poll(h.source, [
    qso("bad", { freq: 7000, their: { call: "W2AW" }, syncedAtMillis: 102 }),
  ]);
  await index(h.store);
  assert.equal((await h.compare()).state, "unique");
});

test("unknown call/time buckets and a 129-contact overflow cannot yield subset uniqueness", async (t) => {
  const h = await setup(t, [qso("q1"), qso("unknown", { their: {} })]);
  assert.equal((await h.compare()).state, "held");
  await h.poll(h.source, [
    qso("unknown", { their: { call: "W2AW" }, syncedAtMillis: 102 }),
  ]);
  const additions = Array.from(
    { length: HISTORICAL_SOURCE_CANDIDATE_LIMIT },
    (_, i) => qso(`dense-${i}`, { syncedAtMillis: 200 + i }),
  );
  for (let offset = 0; offset < additions.length; offset += 25)
    await h.poll(h.source, additions.slice(offset, offset + 25));
  await index(h.store);
  const result = await h.compare();
  assert.equal(result.state, "held");
  assert.equal(result.inspected, 0);
});

test("selected generation, destination route, and coverage changes fail closed", async (t) => {
  const h = await setup(t);
  const wrong = await h.compare({
    selected: { source: "source", qso: "q1", generation: "old" },
  });
  assert.equal(wrong.state, "held");
  if (wrong.state === "held")
    assert.equal(wrong.reason, "selected_source_changed");
  const result = await h.compare();
  assert.equal(await guardCurrent(h.store, result), true);
  await h.store
    .statement(
      "UPDATE connections SET config='{}' WHERE tenant='a' AND id='destination'",
    )
    .run();
  assert.equal(await guardCurrent(h.store, result), false);
  assert.equal((await h.compare()).state, "held");
});

test("valid exclusions never skip unknown routes or source context", async (t) => {
  const h = await setup(t, [
    qso("q1"),
    qso("other-station", { our: { call: "N1CALL", grid: "FN31AA" } }),
  ]);
  assert.equal((await h.compare()).state, "unique");
  const unknown = await h.compare({
    routeMatches: () => {
      throw new Error("unknown route");
    },
  });
  assert.equal(unknown.state, "held");
  if (unknown.state === "held") assert.equal(unknown.reason, "unknown_route");
  const result = await h.compare();
  await h.store
    .statement(
      "UPDATE cursors SET generation=generation+1,cursor=? WHERE tenant='a' AND connection='source' AND stream='context'",
      JSON.stringify({ complete: false, syncComplete: false }),
    )
    .run();
  assert.equal(await guardCurrent(h.store, result), false);
  assert.equal((await h.compare()).state, "held");
});

test("unknown keys may exclude only a currently proven test operation with fenced dependencies", async (t) => {
  const testOp = { ...operation, stationCall: "N0CALL/test" };
  const h = await setup(
    t,
    [qso("q1"), qso("test-contact", { operation: "op", their: {}, our: {} })],
    [testOp],
  );
  const result = await h.compare();
  assert.equal(result.state, "unique");
  assert.equal(result.inspected, 2);
  assert.equal(await guardCurrent(h.store, result), true);
  await h.poll(h.source, [], [{ ...operation, syncedAtMillis: 200 }]);
  assert.equal(await guardCurrent(h.store, result), false);
  assert.equal(
    (await h.compare()).state,
    "held",
    "changed operation cannot reuse prior test exclusion",
  );
});

test("commit-time body expiry and payload replacement invalidate a sole owner", async (t) => {
  const h = await setup(t);
  const result = await h.compare();
  assert.equal(await guardCurrent(h.store, result), true);
  const row = await h.store
    .statement(
      "SELECT private_id,expires_at FROM source_work WHERE tenant='a' AND source='source' AND kind='qso' AND id='q1'",
    )
    .first<{ private_id: string; expires_at: number }>();
  assert.ok(row);
  assert.equal(await guardCurrent(h.store, result, row.expires_at), false);
  await h.store
    .statement(
      "UPDATE private_data SET revoked_at=? WHERE tenant='a' AND connection='source' AND id=?",
      Date.now(),
      row.private_id,
    )
    .run();
  assert.equal(await guardCurrent(h.store, result), false);
  assert.equal((await h.compare()).state, "held");
});

test("the JSON guard composes in the actual adoption-guard INSERT and rejects a late competitor", async (t) => {
  const h = await setup(t);
  const result = await h.compare();
  assert.equal(result.state, "unique");
  if (result.state !== "unique") return;
  const guard = result.commitGuard(Date.now());
  await h.store
    .statement(
      `INSERT INTO history_adoption_guards(id) SELECT ? WHERE (${guard.sql}) AND EXISTS(SELECT 1 FROM accounts WHERE id=? AND status='active')`,
      "first",
      ...guard.params,
      "a",
    )
    .run();
  assert.equal(
    (
      await h.store
        .statement("SELECT COUNT(*) n FROM history_adoption_guards")
        .first<{ n: number }>()
    )?.n,
    1,
  );
  await h.poll(h.source, [qso("late", { syncedAtMillis: 201 })]);
  await h.store
    .statement(
      `INSERT INTO history_adoption_guards(id) SELECT ? WHERE ${guard.sql}`,
      "second",
      ...guard.params,
    )
    .run();
  assert.equal(
    (
      await h.store
        .statement("SELECT COUNT(*) n FROM history_adoption_guards")
        .first<{ n: number }>()
    )?.n,
    1,
  );
});

test("twenty mixed-week reverse lookups load bounded indexed cohorts without source-wide bodies", async (t) => {
  const records = Array.from({ length: 20 }, (_, i) =>
    qso(`week-${i}`, { startAtMillis: at - i * 7 * 86400000 }),
  );
  const h = await setup(t, records);
  const measured = measuredDatabase(h.db);
  const store = new Store(measured.database, h.store.keys);
  for (const record of records) {
    const contact = await projectContact(record, null, [], {
      operationComplete: true,
    });
    const result = await historicalSourceCandidates(store, {
      tenant: "a",
      destination: h.destination,
      remote: {
        ...contactReconciliationAdif(contact),
        APP_QRZLOG_LOGID: "123",
      },
      selected: {
        source: "source",
        qso: contact.id,
        generation: contact.generation,
      },
      vendor: "qrz",
      routeMatches: route,
    });
    assert.equal(result.state, "unique");
    assert.equal(result.inspected, 1);
  }
  assert.equal(measured.metrics.rowsWritten, 0);
  assert.ok(measured.metrics.calls <= 120);
  t.diagnostic(
    `20 indexed one-contact reverse cohorts: ${measured.metrics.calls} D1 calls, ${measured.metrics.statements} statements, ${measured.metrics.rowsRead} measured rows read; local SQL fixture only`,
  );
});

test("ciphertext and dependency overflow hold before any partial projection", async (t) => {
  const h = await setup(t, [qso("q1"), qso("q2"), qso("q3")]);
  // Valid retained encrypted bodies can carry old optional envelope metadata.
  // The ciphertext admission limit must apply before those envelopes are read.
  await h.store
    .statement(
      `UPDATE private_data SET envelope=json_set(envelope,'$.legacyPadding',?) WHERE tenant='a' AND connection='source' AND kind='source'`,
      "x".repeat(1_400_000),
    )
    .run();
  await index(h.store);
  const measured = measuredDatabase(h.db);
  const result = await historicalSourceCandidates(
    new Store(measured.database, h.store.keys),
    {
      tenant: "a",
      destination: h.destination,
      remote: h.remote,
      selected: {
        source: "source",
        qso: "q1",
        generation: h.selected.generation,
      },
      vendor: "qrz",
      routeMatches: route,
    },
  );
  assert.equal(result.state, "held");
  if (result.state === "held") assert.equal(result.reason, "dependency_bound");
  assert.equal(result.inspected, 0);
  assert.equal(
    measured.metrics.calls,
    4,
    "index metadata and bounded row metadata only; no envelope query",
  );
});

test("more than 256 retained dependencies cannot authorize a truncated event closure", async (t) => {
  const h = await setup(
    t,
    [qso("q1", { operation: "op", our: {} })],
    [operation],
  );
  const events = Array.from({ length: 256 }, (_, i) => ({
    uuid: `event-${i}`,
    operation: "op",
    band: "event",
    event: { event: "note" },
    syncedAtMillis: 200 + i,
  }));
  for (let offset = 0; offset < events.length; offset += 25)
    await h.poll(h.source, events.slice(offset, offset + 25));
  const result = await h.compare();
  assert.equal(result.state, "held");
  if (result.state === "held") assert.equal(result.reason, "dependency_bound");
  assert.equal(result.inspected, 0);
});

test("an archived body holds only a potentially overlapping source cohort", async (t) => {
  const archived = qso("archived", { their: { call: "W2AW" } });
  const h = await setup(t, [qso("q1"), archived]);
  await h.store
    .statement(
      "DELETE FROM private_data WHERE tenant='a' AND connection='source' AND id IN(SELECT private_id FROM source_work WHERE tenant='a' AND source='source' AND id='archived' AND kind='qso')",
    )
    .run();
  assert.equal(
    (await h.compare()).state,
    "unique",
    "preserved opaque key excludes unrelated missing ciphertext",
  );
  const contact = await projectContact(archived, null, [], {
    operationComplete: true,
  });
  const overlap = await h.compare({
    remote: { ...contactReconciliationAdif(contact), APP_QRZLOG_LOGID: "124" },
    selected: {
      source: "source",
      qso: "archived",
      generation: contact.generation,
    },
  });
  assert.equal(
    overlap.state,
    "held",
    "missing ciphertext cannot disappear from its matching cohort",
  );
});
