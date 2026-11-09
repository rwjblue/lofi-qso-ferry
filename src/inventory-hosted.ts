import { InventoryComparisonPages } from "./inventory-comparison-pages.ts";
import {
  consumeComparisonWakeups,
  isComparisonMessage,
  publishComparisonWakeups,
} from "./inventory-comparison-continuations.ts";
import {
  consumeInventoryWakeups,
  publishInventoryWakeups,
} from "./inventory-continuations.ts";
import { InventoryIngestion } from "./inventory-ingestion.ts";
import { InventoryRunner } from "./inventory-runner.ts";
import { InventoryRuns } from "./inventory-runs.ts";
import {
  activateInventoryRuntime,
  inventoryRuntime,
} from "./inventory-runtime.ts";
import {
  registerKnownInventoryConnections,
  registerSourceCalendarSelections,
  startInventorySelections,
} from "./inventory-scheduler.ts";
import { runScheduledTick } from "./scheduler-history.ts";
import { keyring } from "./security.ts";
import { Store } from "./store.ts";

function configuredMode(env: Env) {
  const value = env.INVENTORY_RUNTIME_MODE ?? "off";
  if (value !== "off" && value !== "read_only")
    throw new Error("invalid_inventory_runtime_mode");
  return value;
}

/** Environment off pauses a handed-off database; it cannot restore its sender. */
export async function runHostedScheduled(
  env: Env,
  options: { scheduledTime?: number; legacy?: typeof runScheduledTick } = {},
) {
  const mode = configuredMode(env);
  const store = new Store(env.DB, keyring(env));
  const current = await inventoryRuntime(store);
  if (current.mode === "legacy" && mode === "off")
    return {
      mode: "legacy" as const,
      ...(await (options.legacy ?? runScheduledTick)(env, {
        scheduledTime: options.scheduledTime,
      })),
    };
  if (mode === "off") return { mode: "inventory_paused" as const, queued: 0 };
  const runtime = await activateInventoryRuntime(store);
  const registration = await registerKnownInventoryConnections(store, runtime);
  const calendarRegistration = await registerSourceCalendarSelections(
    store,
    runtime,
  );
  const starts = await startInventorySelections(store);
  const runs = new InventoryRuns(
    new InventoryIngestion(store, new InventoryComparisonPages(store)),
  );
  const inventoryQueued = await publishInventoryWakeups(
    runs,
    env.INVENTORY_QUEUE,
  );
  const comparisonQueued = await publishComparisonWakeups(
    store,
    env.INVENTORY_QUEUE,
  );
  return {
    mode: "inventory_read_only" as const,
    registration,
    calendarRegistration,
    starts,
    queued: inventoryQueued + comparisonQueued,
    inventoryQueued,
    comparisonQueued,
  };
}

/** Queue handlers never invoke legacy intake, proofs or delivery preparation. */
export async function runHostedInventoryQueue(
  env: Env,
  batch: MessageBatch<unknown>,
  fetcher: typeof fetch = fetch,
) {
  const mode = configuredMode(env);
  const store = new Store(env.DB, keyring(env));
  const runtime = await inventoryRuntime(store);
  if (mode !== "read_only" || runtime.mode !== "inventory_read_only") {
    batch.retryAll({ delaySeconds: 300 });
    return { mode: "inventory_paused" as const, processed: 0 };
  }
  const runner = new InventoryRunner(
    new InventoryRuns(
      new InventoryIngestion(store, new InventoryComparisonPages(store)),
    ),
    fetcher,
    { scheduled: true },
  );
  const comparisonMessages = batch.messages.filter((message) =>
    isComparisonMessage(message.body),
  );
  const inventoryMessages = batch.messages.filter(
    (message) => !isComparisonMessage(message.body),
  );
  let comparisonAfterInventory = 0,
    inventoryAfterComparison = 0;
  const inventory = await consumeInventoryWakeups(
    runner,
    { messages: inventoryMessages },
    env.INVENTORY_QUEUE,
    {
      maxTurns: 1,
      async afterPublish() {
        comparisonAfterInventory += await publishComparisonWakeups(
          store,
          env.INVENTORY_QUEUE,
        );
      },
    },
  );
  const comparison = await consumeComparisonWakeups(
    store,
    { messages: comparisonMessages },
    env.INVENTORY_QUEUE,
    {
      maxTurns: 1,
      async afterPublish() {
        inventoryAfterComparison += await publishInventoryWakeups(
          runner.runs,
          env.INVENTORY_QUEUE,
        );
      },
    },
  );
  const inventoryQueued = inventory.queued + inventoryAfterComparison;
  const comparisonQueued = comparison.queued + comparisonAfterInventory;
  return {
    mode: "inventory_read_only" as const,
    processed: inventory.processed + comparison.processed,
    inventoryProcessed: inventory.processed,
    comparisonProcessed: comparison.processed,
    acknowledged: inventory.acknowledged + comparison.acknowledged,
    retried: inventory.retried + comparison.retried,
    invalid: inventory.invalid + comparison.invalid,
    failed: inventory.failed + comparison.failed,
    queued: inventoryQueued + comparisonQueued,
    inventoryQueued,
    comparisonQueued,
  };
}
