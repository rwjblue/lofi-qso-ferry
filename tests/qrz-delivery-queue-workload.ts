import assert from "node:assert/strict";
import { measuredDatabase } from "../src/database-metrics.ts";
import {
  type DeliveryGates,
  dispatchAttemptBatch,
  prepareDueBatch,
  QrzEmptyObservationScope,
} from "../src/delivery.ts";
import { Store } from "../src/store.ts";
import { schedulerFixture } from "./runtime-fixtures.ts";
import { mintFixtureSourceProofs } from "./source-proof-fixtures.ts";

/** An already-observed queue, with genuine canonical proofs and planning reads.
 * Setup is reported separately: this measures the preparation/dispatch work unit,
 * not a scheduler invocation or the cost of acquiring source/vendor evidence. */
export async function qrzDeliveryQueueFixture(
  t: { after(fn: () => Promise<void>): void },
  count: 10 | 20,
  createStore = (db: D1Database, original: Store) =>
    new Store(db, original.keys),
) {
  const h = await schedulerFixture();
  t.after(() => h.mf.dispose());
  h.qrzRecords.length = 0;
  let source = await h.store.connection("a", "source");
  let destination = await h.store.connection("a", "destination");
  assert(source && destination);
  const qsos = Array.from({ length: count }, (_, index) => ({
    ...structuredClone(h.qso),
    uuid: `queued-${index}`,
    their: { call: `K${index + 1}QUEUE` },
    startAtMillis: Number(h.qso.startAtMillis) + index * 120_000,
    syncedAtMillis: Number(h.qso.syncedAtMillis) + index,
  }));
  const evidence = await mintFixtureSourceProofs(h.store, {
    source,
    qsos,
    operations: [h.operation],
    destinations: [destination],
  });
  await h.store
    .statement(
      "UPDATE ledger SET state='missing_current_identity',due_at=0 WHERE destination='destination'",
    )
    .run();
  source = await h.store.connection("a", "source");
  destination = await h.store.connection("a", "destination");
  assert(source && destination);
  const meter = measuredDatabase(h.env.DB);
  const store = createStore(meter.database, h.store);
  const scope = new QrzEmptyObservationScope(store);
  t.after(async () => scope.close());
  const members = [];
  for (const [index, snapshot] of evidence.snapshots.entries()) {
    const key = {
      tenant: "a",
      source: "source",
      qso: snapshot.contact.id,
      destination: "destination",
    };
    const read = await scope.read(
      { key, contact: snapshot.contact, source, destination },
      { apiKey: "synthetic-qrz" },
      { fetcher: h.fetcher },
    );
    assert(read.observation);
    members.push({
      key,
      contact: snapshot.contact,
      deps: {
        fetcher: h.fetcher,
        priority: "live" as const,
        sourceProof: {
          ...evidence.authorizations[index],
          authorizationMode: "qrz_fresh_insert" as const,
        },
        qrzEmptyObservation: read.observation,
      },
    });
  }
  const gates: DeliveryGates = {
    exportsEnabled: true,
    liveWriteAuthorized: true,
    sourceBoundaryVerified: false,
    qrzFreshInsertsEnabled: true,
    allowedQsoIds: qsos.map((row) => row.uuid),
    allowedDestinationIds: ["destination"],
  };
  return { ...h, store, members, gates, meter };
}

export async function qrzDeliveryQueueWorkload(count: 10 | 20) {
  const cleanups: (() => Promise<void>)[] = [];
  try {
    const h = await qrzDeliveryQueueFixture(
      { after: (fn) => cleanups.push(fn) },
      count,
    );
    const planning = structuredClone(h.meter.metrics);
    const prepared = await prepareDueBatch(h.store, h.members, h.gates);
    const preparation = h.meter.metrics.calls - planning.calls;
    const queue = prepared.map((outcome, index) => {
      assert.equal(outcome.status, "fulfilled");
      assert(
        outcome.status === "fulfilled" &&
          outcome.value.state === "prepared" &&
          outcome.value.attemptId,
      );
      return {
        id: outcome.value.attemptId,
        deps: {
          ...h.members[index].deps,
          sourceContact: h.members[index].contact,
        },
      };
    });
    const results = await dispatchAttemptBatch(h.store, "a", queue, h.gates);
    for (const outcome of results) {
      assert.equal(outcome.status, "fulfilled");
      assert(
        outcome.status === "fulfilled" && outcome.value.state === "delivered",
      );
    }
    const calls = h.meter.metrics.calls - planning.calls;
    return {
      scenario: `queue-${count}`,
      scope: "preparation_and_dispatch",
      uploads: h.calls.qrzWrites,
      contacts: count,
      database: {
        calls,
        statements: h.meter.metrics.statements - planning.statements,
        callsPerContact: calls / count,
        preparationCalls: preparation,
      },
      planningDatabase: {
        calls: planning.calls,
        statements: planning.statements,
      },
      sourceProofSetupIncluded: false,
    };
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
}
