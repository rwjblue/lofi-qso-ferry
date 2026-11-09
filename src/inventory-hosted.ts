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
import {
  configuredInventoryShadow,
  InventoryPreparationShadow,
  inventoryShadowProviders,
} from "./inventory-preparation-shadow.ts";
import { InventoryQrzDispatch } from "./inventory-qrz-dispatch.ts";
import {
  consumeQrzRecoveryWakeups,
  isQrzRecoveryWakeup,
  publishQrzRecoveryWakeups,
} from "./inventory-qrz-recovery.ts";
import {
  type InventoryDeliveryEnvironment,
  InventoryQrzSendQueue,
  isQrzSendWakeup,
} from "./inventory-qrz-send.ts";
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
  if (value !== "off" && value !== "read_only" && value !== "selected_qrz")
    throw new Error("invalid_inventory_runtime_mode");
  return value;
}

/** Environment off pauses a handed-off database; it cannot restore its sender. */
export async function runHostedScheduled(
  env: InventoryDeliveryEnvironment,
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
  const shadows = { qrz: "off", lotw: "off" };
  for (const provider of inventoryShadowProviders) {
    const config = configuredInventoryShadow(env, provider);
    shadows[provider] = config.kind;
    if (config.kind !== "configured") continue;
    try {
      shadows[provider] = (
        await new InventoryPreparationShadow(
          proofJobs,
          config.selection,
          provider,
        ).enroll()
      ).kind;
    } catch {
      // Optional shadow work must not strand existing proof or recovery jobs.
      shadows[provider] = "failed";
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
  let qrzSendQueued = 0;
  let qrzSendFailed = 0;
  try {
    qrzSendQueued = await new InventoryQrzSendQueue(
      env,
      new InventoryQrzDispatch(store),
    ).schedule();
  } catch {
    qrzSendFailed = 1;
  }
  return {
    mode:
      mode === "selected_qrz"
        ? ("inventory_selected_qrz" as const)
        : ("inventory_read_only" as const),
    registration,
    calendarRegistration,
    overflowRegistration,
    starts,
    queued:
      inventoryQueued +
      comparisonQueued +
      sourceProofQueued +
      qrzRecoveryQueued +
      qrzSendQueued,
    inventoryQueued,
    comparisonQueued,
    sourceProofQueued,
    qrzRecoveryQueued,
    qrzSendQueued,
    qrzSendFailed,
    qrzShadow: shadows.qrz,
    lotwShadow: shadows.lotw,
  };
}

/** Reads and recovery remain available independently of the selected sender. */
export async function runHostedInventoryQueue(
  env: InventoryDeliveryEnvironment,
  batch: MessageBatch<unknown>,
  fetcher: typeof fetch = fetch,
) {
  const mode = configuredMode(env);
  const store = new Store(env.DB, keyring(env));
  const runtime = await inventoryRuntime(store);
  if (mode === "off" || runtime.mode !== "inventory_read_only") {
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
      !isQrzRecoveryWakeup(message.body) &&
      !isQrzSendWakeup(message.body),
  );
  const proofMessages = batch.messages.filter((message) =>
    isSourceProofWakeup(message.body),
  );
  const recoveryMessages = batch.messages.filter((message) =>
    isQrzRecoveryWakeup(message.body),
  );
  const sendMessages = batch.messages.filter((message) =>
    isQrzSendWakeup(message.body),
  );
  const dispatch = new InventoryQrzDispatch(store, fetcher);
  const sender = new InventoryQrzSendQueue(env, dispatch);
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
  const shadows: Record<
    (typeof inventoryShadowProviders)[number],
    string | null
  > = { qrz: null, lotw: null };
  const configured = proofMessages.length
    ? inventoryShadowProviders.map((provider) => {
        const config = configuredInventoryShadow(env, provider);
        if (config.kind === "invalid") shadows[provider] = "invalid";
        return { provider, selection: config.selection };
      })
    : [];
  let qrzSendAfterProof = 0;
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
      if (result.kind !== "complete" && result.kind !== "stale") return;
      let retryAt: number | undefined;
      for (const { provider, selection } of configured) {
        if (
          selection?.tenant !== wakeup.tenant ||
          selection.sourceScope !== wakeup.scope
        )
          continue;
        const staged = await new InventoryPreparationShadow(
          proofJobs,
          selection,
          provider,
        ).stage(wakeup.id);
        shadows[provider] = staged.kind;
        if (provider === "qrz") qrzSendAfterProof += await sender.schedule();
        if (staged.kind === "quiet" || staged.kind === "deferred")
          retryAt = Math.min(retryAt ?? staged.retryAt, staged.retryAt);
      }
      return retryAt;
    },
  );
  const recovery = await consumeQrzRecoveryWakeups(dispatch, recoveryMessages);
  const send = await sender.consume(sendMessages);
  const qrzSendQueued = qrzSendAfterProof + send.queued;
  const inventoryQueued =
    inventory.queued + inventoryAfterComparison + inventoryAfterProof;
  const comparisonQueued = comparison.queued + comparisonAfterInventory;
  return {
    mode:
      mode === "selected_qrz"
        ? ("inventory_selected_qrz" as const)
        : ("inventory_read_only" as const),
    processed:
      inventory.processed +
      comparison.processed +
      proof.processed +
      recovery.processed +
      send.processed,
    inventoryProcessed: inventory.processed,
    comparisonProcessed: comparison.processed,
    sourceProofProcessed: proof.processed,
    qrzRecoveryProcessed: recovery.processed,
    qrzSendProcessed: send.processed,
    qrzSendOutcome: send.outcome,
    qrzShadow: shadows.qrz,
    lotwShadow: shadows.lotw,
    acknowledged:
      inventory.acknowledged +
      comparison.acknowledged +
      proof.acknowledged +
      recovery.acknowledged +
      send.acknowledged,
    retried:
      inventory.retried +
      comparison.retried +
      proof.retried +
      recovery.retried +
      send.retried,
    invalid:
      inventory.invalid +
      comparison.invalid +
      proof.invalid +
      recovery.invalid +
      send.invalid,
    failed:
      inventory.failed +
      comparison.failed +
      proof.failed +
      recovery.failed +
      send.failed,
    queued:
      inventoryQueued + comparisonQueued + sourceProofQueued + qrzSendQueued,
    inventoryQueued,
    comparisonQueued,
    sourceProofQueued,
    qrzSendQueued,
  };
}
