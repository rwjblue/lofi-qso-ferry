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
import { InventoryQrzDispatch } from "./inventory-qrz-dispatch.ts";
import {
  consumeQrzRecoveryWakeups,
  isQrzRecoveryWakeup,
  publishQrzRecoveryWakeups,
} from "./inventory-qrz-recovery.ts";
import {
  configuredQrzShadow,
  InventoryQrzShadow,
  type InventoryShadowEnvironment,
} from "./inventory-qrz-shadow.ts";
import { InventoryRunner } from "./inventory-runner.ts";
import { InventoryRuns } from "./inventory-runs.ts";
import {
  activateInventoryRuntime,
  inventoryRuntime,
} from "./inventory-runtime.ts";
import {
  registerKnownInventoryConnections,
  registerOverflowSelections,
  registerSourceCalendarSelections,
  startInventorySelections,
} from "./inventory-scheduler.ts";
import { InventorySourceProofJobs } from "./inventory-source-proof-jobs.ts";
import {
  consumeSourceProofWakeups,
  isSourceProofWakeup,
  publishSourceProofWakeups,
} from "./inventory-source-proof-wakeups.ts";
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
  env: InventoryShadowEnvironment,
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
  const overflowRegistration = await registerOverflowSelections(store, runtime);
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
  const proofJobs = new InventorySourceProofJobs(runs);
  const config = configuredQrzShadow(env);
  let qrzShadow: string = config.kind;
  if (config.kind === "configured") {
    try {
      qrzShadow = (
        await new InventoryQrzShadow(proofJobs, config.selection).enroll()
      ).kind;
    } catch {
      // Optional shadow work must not strand existing proof or recovery jobs.
      qrzShadow = "failed";
    }
  }
  const sourceProofQueued = await publishSourceProofWakeups(
    proofJobs,
    env.INVENTORY_QUEUE,
  );
  const qrzRecoveryQueued = await publishQrzRecoveryWakeups(
    store,
    env.INVENTORY_QUEUE,
  );
  return {
    mode: "inventory_read_only" as const,
    registration,
    calendarRegistration,
    overflowRegistration,
    starts,
    queued:
      inventoryQueued +
      comparisonQueued +
      sourceProofQueued +
      qrzRecoveryQueued,
    inventoryQueued,
    comparisonQueued,
    sourceProofQueued,
    qrzRecoveryQueued,
    qrzShadow,
  };
}

/** Queue handlers run managed reads and evidence work under read-only mode. */
export async function runHostedInventoryQueue(
  env: InventoryShadowEnvironment,
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
    (message) =>
      !isComparisonMessage(message.body) &&
      !isSourceProofWakeup(message.body) &&
      !isQrzRecoveryWakeup(message.body),
  );
  const proofMessages = batch.messages.filter((message) =>
    isSourceProofWakeup(message.body),
  );
  const recoveryMessages = batch.messages.filter((message) =>
    isQrzRecoveryWakeup(message.body),
  );
  let comparisonAfterInventory = 0,
    inventoryAfterComparison = 0,
    inventoryAfterProof = 0,
    sourceProofQueued = 0;
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
  const proofJobs = new InventorySourceProofJobs(runner.runs, fetcher);
  const config = proofMessages.length ? configuredQrzShadow(env) : null;
  const selection = config?.selection;
  let qrzShadow: string | null = config?.kind === "invalid" ? "invalid" : null;
  const proof = await consumeSourceProofWakeups(
    proofJobs,
    proofMessages,
    async (wakeup, result) => {
      inventoryAfterProof += await publishInventoryWakeups(
        runner.runs,
        env.INVENTORY_QUEUE,
      );
      sourceProofQueued += await publishSourceProofWakeups(
        proofJobs,
        env.INVENTORY_QUEUE,
      );
      if (
        selection?.tenant === wakeup.tenant &&
        selection.sourceScope === wakeup.scope &&
        (result.kind === "complete" || result.kind === "stale")
      ) {
        const staged = await new InventoryQrzShadow(proofJobs, selection).stage(
          wakeup.id,
        );
        qrzShadow = staged.kind;
        if (staged.kind === "quiet") return staged.retryAt;
      }
      return undefined;
    },
  );
  const recovery = await consumeQrzRecoveryWakeups(
    new InventoryQrzDispatch(store, fetcher),
    recoveryMessages,
  );
  const inventoryQueued =
    inventory.queued + inventoryAfterComparison + inventoryAfterProof;
  const comparisonQueued = comparison.queued + comparisonAfterInventory;
  return {
    mode: "inventory_read_only" as const,
    processed:
      inventory.processed +
      comparison.processed +
      proof.processed +
      recovery.processed,
    inventoryProcessed: inventory.processed,
    comparisonProcessed: comparison.processed,
    sourceProofProcessed: proof.processed,
    qrzRecoveryProcessed: recovery.processed,
    qrzShadow,
    acknowledged:
      inventory.acknowledged +
      comparison.acknowledged +
      proof.acknowledged +
      recovery.acknowledged,
    retried:
      inventory.retried + comparison.retried + proof.retried + recovery.retried,
    invalid:
      inventory.invalid + comparison.invalid + proof.invalid + recovery.invalid,
    failed:
      inventory.failed + comparison.failed + proof.failed + recovery.failed,
    queued: inventoryQueued + comparisonQueued + sourceProofQueued,
    inventoryQueued,
    comparisonQueued,
    sourceProofQueued,
  };
}
