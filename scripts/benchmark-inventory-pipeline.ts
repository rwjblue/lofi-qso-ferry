import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  type ComparisonQueueMessage,
  consumeComparisonWakeups,
  MAX_COMPARISON_STEPS_PER_WAKEUP,
  publishComparisonWakeups,
} from "../src/inventory-comparison-continuations.ts";
import { InventoryComparisonPages } from "../src/inventory-comparison-pages.ts";
import {
  InventoryIngestion,
  type InventoryObservation,
} from "../src/inventory-ingestion.ts";
import { planInventoryRun } from "../src/inventory-run-plans.ts";
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

type SyntheticObservation = InventoryObservation & {
  body: Record<string, unknown>;
};

const { values } = parseArgs({
  options: {
    contacts: { type: "string", default: "200" },
    remote: { type: "string", default: "empty" },
    "page-size": { type: "string", default: "1000" },
    schema: { type: "string", default: "current" },
    "source-comparison": { type: "string", default: "interleaved" },
    "comparison-steps-per-wakeup": { type: "string", default: "1" },
    "incremental-rounds": { type: "string", default: "0" },
  },
});
const contacts = Number(values.contacts),
  pageSize = Number(values["page-size"]),
  comparisonStepsPerWakeup = Number(values["comparison-steps-per-wakeup"]),
  incrementalRounds = Number(values["incremental-rounds"]);
assert.ok(
  Number.isSafeInteger(contacts) && contacts >= 1 && contacts <= 200000,
);
assert.ok(Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= 1000);
assert.ok(
  Number.isSafeInteger(comparisonStepsPerWakeup) &&
    comparisonStepsPerWakeup >= 1 &&
    comparisonStepsPerWakeup <= MAX_COMPARISON_STEPS_PER_WAKEUP,
);
assert.ok(values.remote === "empty" || values.remote === "matched");
const sourceComparison = values["source-comparison"];
assert.ok(
  sourceComparison === "interleaved" || sourceComparison === "after-coverage",
);
assert.ok(
  values.schema === "current" ||
    values.schema === "74" ||
    values.schema === "75",
);
assert.ok(
  Number.isSafeInteger(incrementalRounds) &&
    incrementalRounds >= 0 &&
    incrementalRounds <= 20,
);
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
          name < `${String(Number(values.schema) + 1).padStart(4, "0")}_`,
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
    comparisonSteps = 0,
    maxDeliveryD1Calls = 0,
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
    previousSteps = 0,
    previousMessages = 0;
  const stages: unknown[] = [];
  const checkpoint = () => {
    const result = {
      stage,
      wallMs: performance.now() - stageStarted,
      database: difference(meter.totals, before),
      queueTurns: turns - previousTurns,
      comparisonSteps: comparisonSteps - previousSteps,
      queueMessages: queueMessages - previousMessages,
    };
    stages.push(result);
    console.log(JSON.stringify({ event: "stage", ...result }));
    before = { ...meter.totals };
    previousTurns = turns;
    previousSteps = comparisonSteps;
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
        { maxStepsPerWakeup: comparisonStepsPerWakeup },
      );
      assert.equal(result.failed, 0);
      assert.ok(acknowledged);
      comparisonSteps += result.steps;
      const delta = difference(meter.totals, previous);
      maxDeliveryD1Calls = Math.max(maxDeliveryD1Calls, delta.calls);
      if (comparisonStepsPerWakeup === 1) {
        const key = phase === undefined ? "stale" : String(phase);
        phaseTurns[key] = (phaseTurns[key] ?? 0) + 1;
        phaseDatabase[key] ??= counters();
        const costs = phaseDatabase[key];
        for (const name of Object.keys(costs) as (keyof Counters)[])
          costs[name] += delta[name];
      }
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
  const sourceRows: SyntheticObservation[] = Array.from(
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
  const operations: SyntheticObservation[] = Array.from(
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
      const prior = context.stream.checkpoint as {
        policyEpoch?: string;
        operations?: { watermark: number };
        qsos?: { watermark: number };
      };
      const watermark = (family: string, floor: number) =>
        Math.max(
          floor,
          ...rows
            .filter((row) => row.family === family)
            .map((row) => Number(row.order)),
        );
      const checkpoint =
        context.stream.provider === "lofi"
          ? {
              mode: "forward",
              accountId: context.stream.logicalIdentity,
              readerPolicy: "all-clients-v1",
              policyEpoch: prior.policyEpoch ?? id,
              operations: {
                watermark: watermark(
                  "operation",
                  prior.operations?.watermark ?? stamp,
                ),
              },
              qsos: {
                watermark: watermark(
                  "qso",
                  prior.qsos?.watermark ?? stamp + contacts,
                ),
              },
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
          origin: context.run.mode === "delta" ? "forward" : "historical",
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
              ? await runs.prepareQuarantine(context, lease, {
                  limit: 200,
                  proveCurrent: values.schema === "current",
                })
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
    if (sourceComparison === "interleaved") await drain();
  }
  for (let i = 0; i < sourceRows.length; i += pageSize) {
    await append(
      sourceRun,
      sourceRows.slice(i, i + pageSize),
      i + pageSize >= sourceRows.length,
    );
    if (sourceComparison === "interleaved") await drain();
  }
  checkpoint();
  stage = "source-verification";
  await finish(sourceRun);
  checkpoint();
  stage = "source-classification";
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
      sourceComparison,
      stages,
      database: meter.totals,
      queueSends,
      queueMessages,
      queueTurns: turns,
      comparisonSteps,
      comparisonStepsPerWakeup,
      maxDeliveryD1Calls,
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
  if (incrementalRounds) {
    const baseline = { ...meter.totals },
      baselineTurns = turns,
      baselineSteps = comparisonSteps;
    const incrementalStarted = performance.now();
    const firstStage = stages.length;
    async function results() {
      return (
        await base.db
          .prepare(
            "SELECT record_key,version,set_id,state,reason FROM match_results_current ORDER BY record_key",
          )
          .all<{
            record_key: string;
            version: number;
            set_id: string;
            state: string;
            reason: string | null;
          }>()
      ).results;
    }
    async function retained() {
      const row = await base.db
        .prepare(
          "SELECT (SELECT count(*) FROM inventory_payloads) AS inventoryPayloads,(SELECT count(*) FROM comparison_projection_payloads) AS projectionPayloads,(SELECT count(*) FROM inventory_match_sets) AS matchSets,(SELECT count(*) FROM inventory_matching_selected_pages) AS selectedPages,(SELECT count(*) FROM inventory_matching_bucket_pages) AS bucketPages,(SELECT count(*) FROM inventory_matching_bucket_pages WHERE row_count=0) AS emptyBucketPages",
        )
        .first();
      assert.ok(row);
      return row;
    }
    async function delta(rows: InventoryObservation[]) {
      const stream = await inventory.snapshot("a", source.scope, source.stream);
      assert.ok(stream);
      const lease = await store.claim(
        "a",
        `inventory:${source.scope}`,
        Date.now(),
        60000,
      );
      assert.ok(lease);
      let id: string;
      try {
        id = (
          await runs.begin({
            stream,
            lease,
            definition: await planInventoryRun(
              stream,
              { provider: "lofi", pageSize },
              { mode: "delta" },
            ),
          })
        ).id;
      } finally {
        await store.release(lease);
      }
      await append(id, rows, true);
      await finish(id);
      await drain();
    }
    const incrementalSizeBefore = (await base.db.prepare("SELECT 1").run()).meta
      .size_after;
    const outcomes: unknown[] = [];
    let revision = stamp + contacts + 100;
    async function exercise(
      name: string,
      rows: InventoryObservation[],
      unchanged: boolean,
      scopeSize: number,
    ) {
      stage = name;
      const previous = await results(),
        storageBefore = await retained();
      assert.equal(previous.length, contacts);
      await delta(rows);
      const current = await results();
      assert.equal(current.length, contacts);
      const storageAfter = await retained();
      if (unchanged) {
        assert.deepEqual(
          current,
          previous,
          `${name} rewrote comparison results`,
        );
        assert.deepEqual(
          storageAfter,
          storageBefore,
          `${name} retained new bodies or match evidence`,
        );
      }
      for (let i = scopeSize; i < contacts; i++)
        assert.deepEqual(
          current[i],
          previous[i],
          `${name} changed an unrelated result`,
        );
      assert.deepEqual(
        await base.db
          .prepare(
            "SELECT (SELECT count(*) FROM matching_work WHERE completed_version<work_version) AS matching,(SELECT count(*) FROM inventory_matching_selected_jobs WHERE completed_version<work_version) AS selected,(SELECT count(*) FROM inventory_matching_bucket_jobs WHERE completed_version<work_version) AS buckets,(SELECT count(*) FROM inventory_comparison_wakeups WHERE not_before IS NOT NULL) AS wakeups",
          )
          .first(),
        { matching: 0, selected: 0, buckets: 0, wakeups: 0 },
      );
      outcomes.push({
        stage: name,
        changedResults: current.filter(
          (row, i) =>
            row.version !== previous[i]?.version ||
            row.set_id !== previous[i]?.set_id,
        ).length,
        storageBefore,
        storageAfter,
        states: Object.fromEntries(
          [...new Set(current.map((row) => row.state))].map((state) => [
            state,
            current.filter((row) => row.state === state).length,
          ]),
        ),
      });
      checkpoint();
    }
    function changed(
      row: InventoryObservation,
      body: Record<string, unknown>,
      status: "active" | "deleted" = "active",
    ): SyntheticObservation {
      revision++;
      return {
        ...row,
        body: { ...body, syncedAtMillis: revision },
        status,
        order: revision,
        revision: String(revision),
      };
    }
    for (let round = 1; round <= incrementalRounds; round++) {
      await exercise(`delta-empty-${round}`, [], true, 0);
      await exercise(
        `delta-stable-${round}`,
        sourceRows.slice(0, pageSize),
        true,
        0,
      );
      const original = sourceRows[0];
      assert.ok(original);
      const edit = changed(original, {
        ...original.body,
        their: { call: `N0ED${round}` },
      });
      await exercise(
        `delta-contact-edit-${round}`,
        [edit],
        false,
        Math.min(100, contacts),
      );
      const operation = operations[0];
      assert.ok(operation);
      operations[0] = changed(operation, {
        ...operation.body,
        grid: round % 2 ? "FN32" : "FN33",
      });
      await exercise(
        `delta-operation-edit-${round}`,
        [operations[0]],
        false,
        Math.min(100, contacts),
      );
      const retired = changed(edit, edit.body, "deleted");
      await exercise(
        `delta-retire-${round}`,
        [retired],
        false,
        Math.min(100, contacts),
      );
      sourceRows[0] = changed(original, original.body);
      await exercise(
        `delta-restore-${round}`,
        [sourceRows[0]],
        false,
        Math.min(100, contacts),
      );
    }
    const finalSize = (await base.db.prepare("SELECT 1").run()).meta.size_after;
    assert.equal(meter.totals.metadataStatements, meter.totals.statements);
    assert.equal(delayed.length, 0);
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
    console.log(
      JSON.stringify({
        event: "incremental-result",
        contacts,
        remote,
        pageSize,
        schema: values.schema,
        rounds: incrementalRounds,
        stages: stages.slice(firstStage),
        outcomes,
        database: difference(meter.totals, baseline),
        queueTurns: turns - baselineTurns,
        comparisonSteps: comparisonSteps - baselineSteps,
        storage: {
          sqliteBytesBefore: incrementalSizeBefore,
          sqliteBytesAfter: finalSize,
          growthBytes: finalSize - incrementalSizeBefore,
        },
        wallMs: performance.now() - incrementalStarted,
        normalizedInput: true,
        adaptersVendorPacingAndProofsExcluded: true,
        execution: "node_with_native_d1",
        vendorRequests: 0,
        uploads: 0,
      }),
    );
  }
} finally {
  await base.mf.dispose();
}
