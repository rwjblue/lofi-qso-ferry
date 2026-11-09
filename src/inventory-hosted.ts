import {
  consumeComparisonWakeups,
  isComparisonMessage,
  publishComparisonWakeups,
} from "./inventory-comparison-continuations.ts";
import { InventoryComparisonPages } from "./inventory-comparison-pages.ts";
import {
  consumeInventoryWakeups,
  publishInventoryWakeups,
} from "./inventory-continuations.ts";
import {
  consumeInventoryRecoveryWakeups,
  isInventoryRecoveryWakeup,
  publishInventoryRecoveryWakeups,
} from "./inventory-delivery-recovery.ts";
import {
  type InventoryDeliveryEnvironment,
  InventorySendQueue,
  isInventorySendWakeup,
} from "./inventory-delivery-send.ts";
import { InventoryIngestion } from "./inventory-ingestion.ts";
import { InventoryLotwDispatch } from "./inventory-lotw-dispatch.ts";
import { InventoryLotwReadback } from "./inventory-lotw-readback.ts";
import { collectInventoryMatchProofs } from "./inventory-match-retention.ts";
import { collectInventoryPayloads } from "./inventory-payload-retention.ts";
import {
  configuredInventoryShadow,
  InventoryPreparationShadow,
  inventoryShadowProviders,
} from "./inventory-preparation-shadow.ts";
import { InventoryQrzDispatch } from "./inventory-qrz-dispatch.ts";
import { InventoryRunner } from "./inventory-runner.ts";
import { InventoryRuns } from "./inventory-runs.ts";
import {
  activateInventoryRuntime,
  inventoryRuntime,
} from "./inventory-runtime.ts";
import {
  registerKnownInventoryConnections,
  registerLotwAccountFeeds,
  registerOverflowSelections,
  registerSourceCalendarSelections,
  restoreLotwDatedPolls,
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

const hostedMode = {
  read_only: "inventory_read_only",
  selected_qrz: "inventory_selected_qrz",
  selected_lotw: "inventory_selected_lotw",
} as const;

function configuredMode(env: Env) {
  const value = env.INVENTORY_RUNTIME_MODE ?? "off";
  if (
    value !== "off" &&
    value !== "read_only" &&
    value !== "selected_qrz" &&
    value !== "selected_lotw"
  )
    throw new Error("invalid_inventory_runtime_mode");
  return value;
}

/** Environment off pauses a handed-off database; it cannot restore its sender. */
export async function runHostedScheduled(
  env: InventoryDeliveryEnvironment & { INVENTORY_LOTW_ACCOUNT_FEEDS?: string },
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
  const lotwAccountRegistration =
    env.INVENTORY_LOTW_ACCOUNT_FEEDS === "true"
      ? await registerLotwAccountFeeds(store, runtime)
      : { registered: 0, failed: 0 };
  const overflowRegistration = await registerOverflowSelections(store, runtime);
  const lotwDatedPollsRestored = await restoreLotwDatedPolls(store);
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
  const sendProvider =
    mode === "selected_qrz" ? "qrz" : mode === "selected_lotw" ? "lotw" : null;
  const sender = sendProvider
    ? new InventorySendQueue(
        env,
        sendProvider,
        sendProvider === "qrz"
          ? new InventoryQrzDispatch(store)
          : new InventoryLotwDispatch(store),
      )
    : null;
  const sends = {
    qrz: { queued: 0, failed: 0, retired: 0 },
    lotw: { queued: 0, failed: 0, retired: 0 },
  };
  if (sender && sendProvider) {
    try {
      sends[sendProvider].retired = await sender.retireExpired();
    } catch {
      sends[sendProvider].failed = 1;
    }
  }
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
  const qrzRecoveryQueued = await publishInventoryRecoveryWakeups(
    store,
    "qrz",
    env.INVENTORY_QUEUE,
  );
  const lotwRecoveryQueued = await publishInventoryRecoveryWakeups(
    store,
    "lotw",
    env.INVENTORY_QUEUE,
  );
  if (sender && sendProvider) {
    try {
      sends[sendProvider].queued = await sender.schedule();
    } catch {
      sends[sendProvider].failed = 1;
    }
  }
  let matchProofsCollected = 0;
  let matchProofCollectionFailed = 0;
  try {
    matchProofsCollected = await collectInventoryMatchProofs(store);
  } catch {
    matchProofCollectionFailed = 1;
  }
  let rawPayloadsCollected = 0;
  let rawPayloadCollectionFailed = 0;
  try {
    rawPayloadsCollected = await collectInventoryPayloads(store);
  } catch {
    rawPayloadCollectionFailed = 1;
  }
  return {
    mode: hostedMode[mode],
    registration,
    calendarRegistration,
    lotwAccountRegistration,
    overflowRegistration,
    lotwDatedPollsRestored,
    starts,
    queued:
      inventoryQueued +
      comparisonQueued +
      sourceProofQueued +
      qrzRecoveryQueued +
      lotwRecoveryQueued +
      sends.qrz.queued +
      sends.lotw.queued,
    inventoryQueued,
    comparisonQueued,
    sourceProofQueued,
    qrzRecoveryQueued,
    lotwRecoveryQueued,
    qrzSendQueued: sends.qrz.queued,
    qrzSendFailed: sends.qrz.failed,
    qrzExpiredRetired: sends.qrz.retired,
    lotwSendQueued: sends.lotw.queued,
    lotwSendFailed: sends.lotw.failed,
    lotwExpiredRetired: sends.lotw.retired,
    matchProofsCollected,
    matchProofCollectionFailed,
    rawPayloadsCollected,
    rawPayloadCollectionFailed,
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
      !isInventoryRecoveryWakeup("qrz", message.body) &&
      !isInventoryRecoveryWakeup("lotw", message.body) &&
      !isInventorySendWakeup("qrz", message.body) &&
      !isInventorySendWakeup("lotw", message.body),
  );
  const proofMessages = batch.messages.filter((message) =>
    isSourceProofWakeup(message.body),
  );
  const qrzRecoveryMessages = batch.messages.filter((message) =>
    isInventoryRecoveryWakeup("qrz", message.body),
  );
  const lotwRecoveryMessages = batch.messages.filter((message) =>
    isInventoryRecoveryWakeup("lotw", message.body),
  );
  const dispatch = new InventoryQrzDispatch(store, fetcher);
  const senders = {
    qrz: new InventorySendQueue(env, "qrz", dispatch),
    lotw: new InventorySendQueue(
      env,
      "lotw",
      new InventoryLotwDispatch(store, fetcher),
    ),
  };
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
  const sendAfterProof = { qrz: 0, lotw: 0 };
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
        sendAfterProof[provider] += await senders[provider].schedule();
        if (staged.kind === "quiet" || staged.kind === "deferred")
          retryAt = Math.min(retryAt ?? staged.retryAt, staged.retryAt);
      }
      return retryAt;
    },
  );
  const qrzRecovery = await consumeInventoryRecoveryWakeups(
    dispatch,
    "qrz",
    qrzRecoveryMessages,
  );
  const lotwRecovery = await consumeInventoryRecoveryWakeups(
    new InventoryLotwReadback(store, fetcher),
    "lotw",
    lotwRecoveryMessages,
  );
  const qrzSend = await senders.qrz.consume(
    batch.messages.filter((message) =>
      isInventorySendWakeup("qrz", message.body),
    ),
  );
  const lotwSend = await senders.lotw.consume(
    batch.messages.filter((message) =>
      isInventorySendWakeup("lotw", message.body),
    ),
  );
  const reports = [
    inventory,
    comparison,
    proof,
    qrzRecovery,
    lotwRecovery,
    qrzSend,
    lotwSend,
  ];
  const total = (field: keyof typeof proof) =>
    reports.reduce((sum, report) => sum + report[field], 0);
  const qrzSendQueued = sendAfterProof.qrz + qrzSend.queued;
  const lotwSendQueued = sendAfterProof.lotw + lotwSend.queued;
  const inventoryQueued =
    inventory.queued + inventoryAfterComparison + inventoryAfterProof;
  const comparisonQueued = comparison.queued + comparisonAfterInventory;
  return {
    mode: hostedMode[mode],
    processed: total("processed"),
    inventoryProcessed: inventory.processed,
    comparisonProcessed: comparison.processed,
    sourceProofProcessed: proof.processed,
    qrzRecoveryProcessed: qrzRecovery.processed,
    lotwRecoveryProcessed: lotwRecovery.processed,
    qrzSendProcessed: qrzSend.processed,
    qrzSendOutcome: qrzSend.outcome,
    lotwSendProcessed: lotwSend.processed,
    lotwSendOutcome: lotwSend.outcome,
    qrzShadow: shadows.qrz,
    lotwShadow: shadows.lotw,
    acknowledged: total("acknowledged"),
    retried: total("retried"),
    invalid: total("invalid"),
    failed: total("failed"),
    queued:
      inventoryQueued +
      comparisonQueued +
      sourceProofQueued +
      qrzSendQueued +
      lotwSendQueued,
    inventoryQueued,
    comparisonQueued,
    sourceProofQueued,
    qrzSendQueued,
    lotwSendQueued,
  };
}
