import { purgeAuth } from "./auth.ts";
import type { InventoryBodyArchive } from "./inventory-body-archive.ts";
import { stepInventoryBodyReplay } from "./inventory-body-replay.ts";
import {
  consumeComparisonWakeups,
  isComparisonMessage,
  MAX_COMPARISON_STEPS_PER_WAKEUP,
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
import { runLotwConfirmationSchedule } from "./inventory-lotw-confirmation-schedule.ts";
import { InventoryLotwDispatch } from "./inventory-lotw-dispatch.ts";
import { InventoryLotwReadback } from "./inventory-lotw-readback.ts";
import { collectInventoryMatchProofs } from "./inventory-match-retention.ts";
import {
  collectInventoryColdBodies,
  collectInventoryPayloads,
} from "./inventory-payload-retention.ts";
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
  registerInventorySources,
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
import { InventoryUploadPlanner } from "./inventory-upload-planner.ts";
import { rotatePrivateData } from "./maintenance.ts";
import { keyring } from "./security.ts";
import { Store } from "./store.ts";

const hostedMode = {
  read_only: "inventory_read_only",
  selected_qrz: "inventory_selected_qrz",
  selected_lotw: "inventory_selected_lotw",
  managed: "inventory_managed",
} as const;

type InventoryHostedEnvironment = InventoryDeliveryEnvironment & {
  INVENTORY_BODY_ARCHIVE?: InventoryBodyArchive;
};

function configuredMode(env: Env) {
  const value = env.INVENTORY_RUNTIME_MODE ?? "off";
  if (
    value !== "off" &&
    value !== "read_only" &&
    value !== "selected_qrz" &&
    value !== "selected_lotw" &&
    value !== "managed"
  )
    throw new Error("invalid_inventory_runtime_mode");
  return value;
}

export async function runHostedScheduled(
  env: InventoryHostedEnvironment & {
    INVENTORY_LOTW_ACCOUNT_FEEDS?: string;
    INVENTORY_LOTW_CONFIRMATIONS?: string;
  },
  options: {
    inventoryFetch?: typeof fetch;
    lotwConfirmationFetch?: typeof fetch;
  } = {},
) {
  const mode = configuredMode(env);
  await purgeAuth(env);
  if (mode === "off") return { mode: "inventory_paused" as const, queued: 0 };
  const store = new Store(env.DB, keyring(env), env.INVENTORY_BODY_ARCHIVE);
  const runtime = await activateInventoryRuntime(store);
  const registration = await registerInventorySources(store, runtime);
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
  const sendProviders = inventoryShadowProviders.filter(
    (provider) => mode === "managed" || mode === `selected_${provider}`,
  );
  const senders = {
    qrz: new InventorySendQueue(env, "qrz", new InventoryQrzDispatch(store)),
    lotw: new InventorySendQueue(env, "lotw", new InventoryLotwDispatch(store)),
  };
  const sends = {
    qrz: { queued: 0, failed: 0, retired: 0 },
    lotw: { queued: 0, failed: 0, retired: 0 },
  };
  for (const provider of sendProviders) {
    try {
      sends[provider].retired = await senders[provider].retireExpired();
    } catch {
      sends[provider].failed = 1;
    }
  }
  let uploadPlanner = { qrz: 0, lotw: 0, failed: 0 };
  if (mode === "managed") {
    try {
      const enrolled = await new InventoryUploadPlanner(
        env,
        proofJobs,
      ).enroll();
      uploadPlanner = { ...enrolled, failed: 0 };
    } catch {
      uploadPlanner.failed = 1;
    }
  }
  const shadows = { qrz: "off", lotw: "off" };
  for (const provider of inventoryShadowProviders) {
    const config = configuredInventoryShadow(env, provider);
    shadows[provider] = config.kind;
    if (config.kind !== "configured" || mode === "managed") continue;
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
  for (const provider of sendProviders) {
    try {
      sends[provider].queued = await senders[provider].schedule();
    } catch {
      sends[provider].failed = 1;
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
  let coldBodiesCollected = 0;
  let coldBodyCollectionFailed = 0;
  try {
    coldBodiesCollected = await collectInventoryColdBodies(store);
  } catch {
    coldBodyCollectionFailed = 1;
  }
  const credentialsRotation = await rotatePrivateData(store).catch(() => ({
    rotated: 0,
    blocked: 1,
  }));
  const bodyReplay = await stepInventoryBodyReplay(
    store,
    options.inventoryFetch,
  ).catch(() => ({ kind: "failed" as const }));
  const lotwConfirmations =
    env.INVENTORY_LOTW_CONFIRMATIONS === "true"
      ? await runLotwConfirmationSchedule(
          store,
          options.lotwConfirmationFetch,
        ).catch(() => ({ failed: 1 }))
      : null;
  return {
    mode: hostedMode[mode],
    registration,
    calendarRegistration,
    lotwAccountRegistration,
    lotwConfirmations,
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
    coldBodiesCollected,
    coldBodyCollectionFailed,
    credentialsRotation,
    bodyReplay,
    qrzShadow: shadows.qrz,
    lotwShadow: shadows.lotw,
    uploadPlanner,
  };
}

/** Reads and recovery remain available independently of the selected sender. */
export async function runHostedInventoryQueue(
  env: InventoryHostedEnvironment,
  batch: MessageBatch<unknown>,
  fetcher: typeof fetch = fetch,
) {
  const mode = configuredMode(env);
  const store = new Store(env.DB, keyring(env), env.INVENTORY_BODY_ARCHIVE);
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
      maxStepsPerWakeup: MAX_COMPARISON_STEPS_PER_WAKEUP,
      async afterPublish() {
        inventoryAfterComparison += await publishInventoryWakeups(
          runner.runs,
          env.INVENTORY_QUEUE,
        );
      },
    },
  );
  const proofJobs = new InventorySourceProofJobs(runner.runs, fetcher);
  const planner =
    mode === "managed" ? new InventoryUploadPlanner(env, proofJobs) : null;
  const shadows: Record<
    (typeof inventoryShadowProviders)[number],
    string | null
  > = { qrz: null, lotw: null };
  const configured =
    proofMessages.length && !planner
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
      if (planner) {
        if (
          result.kind !== "complete" &&
          result.kind !== "stale" &&
          result.kind !== "held"
        )
          return;
        const staged = await planner.stage(
          wakeup.tenant,
          wakeup.scope,
          wakeup.id,
        );
        if (staged.provider)
          sendAfterProof[staged.provider] +=
            await senders[staged.provider].schedule();
        return staged.retryAt;
      }
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
  if (planner && (qrzSend.processed || lotwSend.processed)) {
    await planner.enroll();
    sourceProofQueued += await publishSourceProofWakeups(
      proofJobs,
      env.INVENTORY_QUEUE,
    );
    sendAfterProof.qrz += await senders.qrz.schedule();
    sendAfterProof.lotw += await senders.lotw.schedule();
  }
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
    comparisonSteps: comparison.steps,
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
