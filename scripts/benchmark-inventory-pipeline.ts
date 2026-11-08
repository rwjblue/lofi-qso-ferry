import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  type ComparisonQueueMessage,
  consumeComparisonWakeups,
  publishComparisonWakeups,
} from "../src/inventory-comparison-continuations.ts";
import { InventoryComparisonPages } from "../src/inventory-comparison-pages.ts";
import {
  InventoryIngestion,
  type InventoryObservation,
} from "../src/inventory-ingestion.ts";
import { InventoryRuns } from "../src/inventory-runs.ts";
import { activateInventoryRuntime } from "../src/inventory-runtime.ts";
import {
  registerInventorySelection,
  startInventorySelections,
} from "../src/inventory-scheduler.ts";
import { Store } from "../src/store.ts";
import { applyMigration, database, seed } from "../tests/helpers.ts";
import { applyAdditionalMigrations } from "../tests/runtime-fixtures.ts";
import {
  type Counters,
  counters,
  difference,
  measureD1,
} from "./inventory-benchmark-metrics.ts";

const { values } = parseArgs({
  options: {
    contacts: { type: "string", default: "200" },
    remote: { type: "string", default: "empty" },
    "page-size": { type: "string", default: "1000" },
    schema: { type: "string", default: "current" },
  },
});
const contacts = Number(values.contacts),
  pageSize = Number(values["page-size"]);
assert.ok(
  Number.isSafeInteger(contacts) && contacts >= 1 && contacts <= 200000,
);
assert.ok(Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= 1000);
assert.ok(values.remote === "empty" || values.remote === "matched");
assert.ok(values.schema === "current" || values.schema === "74");
const remote = values.remote;
const base = await database();
try {
  if (values.schema === "current") await applyAdditionalMigrations(base.db);
  else
    for (const name of (
      await readdir(new URL("../migrations/", import.meta.url))
    )
      .filter(
        (name) =>
          name.endsWith(".sql") &&
          name !== "0001_foundation.sql" &&
          name < "0075_",
      )
      .sort())
      await applyMigration(base.db, name);
  await seed(base.store);
  const book = {
    bookId: "7",
    stationCallsign: "N1RWJ",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
  };
  await base.store
    .statement(
      "UPDATE connections SET config=? WHERE id='source'",
      JSON.stringify({ accountId: "source" }),
    )
    .run();
  await base.store
    .statement(
      "UPDATE connections SET config=? WHERE id='destination'",
      JSON.stringify(book),
    )
    .run();
  await base.store
    .statement("DELETE FROM private_data WHERE kind='credential'")
    .run();
  for (const [connection, value] of [
    [
      "source",
      { key: "browser:benchmark", secret: "synthetic", token: "synthetic" },
    ],
    ["destination", { apiKey: "synthetic" }],
  ] as const)
    await (
      await base.store.putPrivate("a", connection, "v1", "credential", value)
    ).run();
  const credentials = await base.db
    .prepare(
      "SELECT * FROM private_data WHERE kind='credential' ORDER BY connection",
    )
    .all();
  const initialBytes = (await base.db.prepare("SELECT 1").run()).meta
    .size_after;
  let phase: number | undefined;
  const meter = measureD1(base.db, (result) => {
    const row = result.results[0] as Record<string, unknown> | undefined;
    if (
      phase === undefined &&
      row &&
      typeof row.phase === "number" &&
      typeof row.phase_count === "number"
    )
      phase = row.phase;
  });
  const store = new Store(meter.database, base.store.keys);
  const inventory = new InventoryIngestion(
    store,
    new InventoryComparisonPages(store),
  );
  const runs = new InventoryRuns(inventory);
  const immediate: ComparisonQueueMessage[] = [],
    delayed: ComparisonQueueMessage[] = [];
  let queueSends = 0,
    queueMessages = 0,
    turns = 0,
    stage = "enrollment";
  const phaseTurns: Record<string, number> = {};
  const phaseDatabase: Record<string, Counters> = {};
  const queue: Pick<Queue<ComparisonQueueMessage>, "sendBatch"> = {
    async sendBatch(messages) {
      queueSends++;
      for (const message of messages) {
        queueMessages++;
        (message.delaySeconds ? delayed : immediate).push(
          structuredClone(message.body),
        );
      }
      return {
        metadata: {
          metrics: {
            backlogCount: immediate.length + delayed.length,
            backlogBytes: 0,
          },
        },
      };
    },
  };
  const started = performance.now();
  let before = { ...meter.totals },
    stageStarted = performance.now(),
    previousTurns = 0,
    previousMessages = 0;
  const stages: unknown[] = [];
  const checkpoint = () => {
    const result = {
      stage,
      wallMs: performance.now() - stageStarted,
      database: difference(meter.totals, before),
      queueTurns: turns - previousTurns,
      queueMessages: queueMessages - previousMessages,
    };
    stages.push(result);
    console.log(JSON.stringify({ event: "stage", ...result }));
    before = { ...meter.totals };
    previousTurns = turns;
    previousMessages = queueMessages;
    stageStarted = performance.now();
  };
  async function drain() {
    await publishComparisonWakeups(store, queue);
    while (immediate.length) {
      assert.ok(
        turns++ < contacts * 100 + 1000,
        "comparison turn bound exceeded",
      );
      const body = immediate.shift();
      assert.ok(body);
      let acknowledged = false;
      const message: Message<unknown> = {
        id: String(turns),
        timestamp: new Date(),
        attempts: 1,
        body,
        ack() {
          acknowledged = true;
        },
        retry() {
          assert.fail("synthetic comparison unexpectedly deferred");
        },
      };
      phase = undefined;
      const previous = { ...meter.totals };
      const result = await consumeComparisonWakeups(
        store,
        { messages: [message] },
        queue,
      );
      assert.equal(result.failed, 0);
      assert.ok(acknowledged);
      const key = phase === undefined ? "stale" : String(phase);
      phaseTurns[key] = (phaseTurns[key] ?? 0) + 1;
      phaseDatabase[key] ??= counters();
      const costs = phaseDatabase[key];
      const delta = difference(meter.totals, previous);
      for (const name of Object.keys(costs) as (keyof Counters)[])
        costs[name] += delta[name];
      if (turns % 250 === 0)
        console.log(
          JSON.stringify({
            event: "progress",
            stage,
            turns,
            phase,
            calls: meter.totals.calls,
          }),
        );
    }
  }
  const runtime = await activateInventoryRuntime(store);
  const sourceConnection = await store.connection("a", "source"),
    destinationConnection = await store.connection("a", "destination");
  assert.ok(sourceConnection && destinationConnection);
  const source = await registerInventorySelection(
    store,
    runtime,
    sourceConnection,
    { provider: "lofi", pageSize },
  );
  const destination = await registerInventorySelection(
    store,
    runtime,
    destinationConnection,
    {
      provider: "qrz",
      book,
      between: [book.startDate, book.endDate],
      pageSize: 250,
    },
  );
  assert.equal((await startInventorySelections(store)).started, 2);
  checkpoint();
  stage = "destination-baseline";

  const operationCount = Math.ceil(contacts / 100),
    stamp = Date.now() - contacts - 10000;
  const call = (i: number) =>
    `K${i % 10}B${Math.floor(i / 10)
      .toString(36)
      .toUpperCase()}`;
  const at = (i: number) => Date.UTC(2026, 0, 1, 13) + i * 60000;
  const sourceRows: InventoryObservation[] = Array.from(
    { length: contacts },
    (_, i) => ({
      family: "qso",
      subtype: "qso",
      key: `q${String(i).padStart(6, "0")}`,
      parentKey: `op${Math.floor(i / 100)}`,
      status: "active",
      order: stamp + i + 1,
      revision: String(stamp + i + 1),
      body: {
        uuid: `q${String(i).padStart(6, "0")}`,
        operation: `op${Math.floor(i / 100)}`,
        syncedAtMillis: stamp + i + 1,
        startAtMillis: at(i),
        their: { call: call(i) },
        our: { grid: "FN31" },
        band: "20m",
        mode: "CW",
        notes: "Synthetic pipeline narrative ".repeat(20),
      },
    }),
  );
  const operations: InventoryObservation[] = Array.from(
    { length: operationCount },
    (_, i) => ({
      family: "operation",
      subtype: "operation",
      key: `op${i}`,
      status: "active",
      order: stamp,
      revision: String(stamp),
      body: { uuid: `op${i}`, stationCall: "N1RWJ", syncedAtMillis: stamp },
    }),
  );
  const receipts: InventoryObservation[] =
    remote === "empty"
      ? []
      : sourceRows.map((_, i) => {
          const iso = new Date(at(i)).toISOString();
          return {
            family: "qso",
            subtype: "qso",
            key: String(i + 1),
            status: "active",
            order: null,
            revision: "r1",
            body: {
              APP_QRZLOG_LOGID: String(i + 1),
              STATION_CALLSIGN: "N1RWJ",
              CALL: call(i),
              QSO_DATE: iso.slice(0, 10).replaceAll("-", ""),
              TIME_ON: iso.slice(11, 19).replaceAll(":", ""),
              BAND: "20m",
              MODE: "CW",
              MY_GRIDSQUARE: "FN31",
            },
          };
        });
  async function runId(selection: { scope: string; stream: string }) {
    const row = await store
      .statement(
        "SELECT active_run_id AS id FROM inventory_stream_jobs WHERE tenant='a' AND scope_id=? AND stream_id=?",
        selection.scope,
        selection.stream,
      )
      .first<{ id: string }>();
    assert.ok(row?.id);
    return row.id;
  }
  async function append(
    id: string,
    rows: InventoryObservation[],
    complete: boolean,
  ) {
    const context = await runs.context("a", id);
    const lease = await store.claim(
      "a",
      `inventory:${context.run.scope}`,
      Date.now(),
      60000,
    );
    assert.ok(lease);
    try {
      const checkpoint =
        context.stream.provider === "lofi"
          ? {
              mode: "forward",
              accountId: context.stream.logicalIdentity,
              readerPolicy: "all-clients-v1",
              policyEpoch: id,
              operations: { watermark: stamp },
              qsos: { watermark: stamp + contacts },
            }
          : { synthetic: true };
      const requestBinding =
        context.run.phase === "catchup"
          ? context.run.catchupBinding
          : context.run.collectionBinding;
      assert.ok(requestBinding);
      await inventory.publish(
        await runs.preparePage(context, lease, {
          observations: rows,
          requestStartedAt: Date.now(),
          requestBinding,
          nextResume: context.stream.resume,
          observedComplete: complete,
          completedStreams: complete ? context.run.requiredStreams : [],
          proposedCheckpoint: complete ? checkpoint : undefined,
          nextDueAt: Date.now(),
        }),
      );
    } finally {
      await store.release(lease);
    }
  }
  async function finish(id: string) {
    for (let n = 0; n < contacts / 100 + 100; n++) {
      const run = await runs.load("a", id);
      assert.ok(run);
      if (run.phase === "complete") return;
      const context = await runs.context("a", id);
      if (context.run.phase === "catchup") await append(id, [], true);
      else if (
        context.run.phase === "quarantining" ||
        context.run.phase === "publishing"
      ) {
        const lease = await store.claim(
          "a",
          `inventory:${context.run.scope}`,
          Date.now(),
          60000,
        );
        assert.ok(lease);
        try {
          await inventory.publish(
            context.run.phase === "quarantining"
              ? await runs.prepareQuarantine(context, lease, { limit: 200 })
              : await runs.prepareComplete(context, lease),
          );
        } finally {
          await store.release(lease);
        }
      } else assert.fail(`unexpected unfinished phase: ${context.run.phase}`);
    }
    assert.fail("run did not finish");
  }
  const targetRun = await runId(destination);
  if (!receipts.length) await append(targetRun, [], true);
  for (let i = 0; i < receipts.length; i += 250) {
    await append(
      targetRun,
      receipts.slice(i, i + 250),
      i + 250 >= receipts.length,
    );
    await drain();
  }
  await finish(targetRun);
  await drain();
  checkpoint();
  stage = "source-backfill";
  const sourceRun = await runId(source);
  for (let i = 0; i < operations.length; i += pageSize) {
    await append(sourceRun, operations.slice(i, i + pageSize), false);
    await drain();
  }
  for (let i = 0; i < sourceRows.length; i += pageSize) {
    await append(
      sourceRun,
      sourceRows.slice(i, i + pageSize),
      i + pageSize >= sourceRows.length,
    );
    await drain();
  }
  checkpoint();
  stage = "source-completion-and-classification";
  await finish(sourceRun);
  await drain();
  checkpoint();
  assert.equal(
    delayed.length,
    0,
    "synthetic contacts require a capacity retry",
  );
  const expected =
    remote === "empty" ? "absent_at_inventory" : "matched_existing";
  const current = await base.db
    .prepare(
      "SELECT state,count(*) AS records FROM match_results_current GROUP BY state",
    )
    .all();
  assert.deepEqual(current.results, [{ state: expected, records: contacts }]);
  assert.deepEqual(
    (
      await base.db
        .prepare(
          "SELECT * FROM private_data WHERE kind='credential' ORDER BY connection",
        )
        .all()
    ).results,
    credentials.results,
  );
  assert.deepEqual(
    await base.db.prepare("SELECT count(*) AS n FROM attempts").first(),
    { n: 0 },
  );
  const tables = [
    "inventory_records",
    "inventory_payloads",
    "comparison_projection_payloads",
    "comparison_projections",
    "inventory_match_sets",
    "inventory_match_records",
    "inventory_match_tokens",
    "inventory_match_recovery",
    "inventory_matching_selected_jobs",
    "inventory_matching_selected_pages",
    "inventory_matching_selected_dependents",
    "matching_work",
  ];
  const storage = Object.fromEntries(
    await Promise.all(
      tables.map(async (table) => {
        const row = await base.db
          .prepare(`SELECT count(*) AS n FROM ${table}`)
          .first<{ n: number }>();
        assert.ok(row);
        return [table, row.n];
      }),
    ),
  );
  const size = await base.db.prepare("SELECT 1").run();
  const payloadBytes = await base.db
    .prepare(
      "SELECT (SELECT coalesce(sum(length(envelope)),0) FROM inventory_payloads) AS inventory,(SELECT coalesce(sum(encrypted_bytes),0) FROM comparison_projection_payloads) AS projections",
    )
    .first();
  assert.equal(meter.totals.metadataStatements, meter.totals.statements);
  console.log(
    JSON.stringify({
      event: "result",
      contacts,
      remote,
      pageSize,
      schema: values.schema,
      stages,
      database: meter.totals,
      queueSends,
      queueMessages,
      queueTurns: turns,
      phaseTurns,
      phaseDatabase,
      storage: {
        ...storage,
        initialSqliteBytes: initialBytes,
        sqliteBytes: size.meta.size_after,
        growthBytes: size.meta.size_after - initialBytes,
        encryptedPayloadBytes: payloadBytes,
      },
      wallMs: performance.now() - started,
      normalizedInput: true,
      adaptersVendorPacingAndProofsExcluded: true,
      execution: "node_with_native_d1",
      vendorRequests: 0,
      uploads: 0,
    }),
  );
} finally {
  await base.mf.dispose();
}
