import { InventoryComparisonCoordinator } from "./inventory-comparison-coordinator.ts";
import {
  COMPARISON_QUEUE_HORIZON_MS,
  InventoryComparisonWakeups,
} from "./inventory-comparison-wakeups.ts";
import type { Store } from "./store.ts";

export interface ComparisonQueueMessage {
  kind: "comparison";
  version: 1;
  tenant: string;
  runtimeVersion: number;
  wakeupVersion: number;
  controlVersion: number;
  workVersion: number;
}
type ComparisonQueue = Pick<Queue<ComparisonQueueMessage>, "sendBatch">;
export const MAX_COMPARISON_STEPS_PER_WAKEUP = 4;
const COMPARISON_WAKEUP_SLICE_MS = 5_000;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
export function isComparisonMessage(value: unknown) {
  return (
    !!value &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "comparison"
  );
}
export function comparisonQueueMessage(value: unknown): ComparisonQueueMessage {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("kind" in value) ||
    value.kind !== "comparison" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("tenant" in value) ||
    !identifier(value.tenant) ||
    !("runtimeVersion" in value) ||
    !positive(value.runtimeVersion) ||
    !("wakeupVersion" in value) ||
    !positive(value.wakeupVersion) ||
    !("controlVersion" in value) ||
    !positive(value.controlVersion) ||
    !("workVersion" in value) ||
    !positive(value.workVersion)
  )
    throw new Error("invalid_comparison_queue_message");
  return {
    kind: "comparison",
    version: 1,
    tenant: value.tenant,
    runtimeVersion: value.runtimeVersion,
    wakeupVersion: value.wakeupVersion,
    controlVersion: value.controlVersion,
    workVersion: value.workVersion,
  };
}

export async function publishComparisonWakeups(
  store: Store,
  queue: ComparisonQueue,
  options: Parameters<InventoryComparisonWakeups["pending"]>[0] = {},
) {
  const wakeups = new InventoryComparisonWakeups(store);
  const rows = await wakeups.pending(options);
  if (!rows.length) return 0;
  const now = options.now ?? Date.now();
  await queue.sendBatch(
    rows.map((row) => ({
      body: {
        kind: "comparison" as const,
        version: 1 as const,
        tenant: row.tenant,
        runtimeVersion: row.runtime_version,
        wakeupVersion: row.version,
        controlVersion: row.control_version,
        workVersion: row.work_version,
      },
      contentType: "json" as const,
      delaySeconds: Math.max(0, Math.ceil((row.not_before - now) / 1000)),
    })),
  );
  await wakeups.markPublished(rows);
  return rows.length;
}

/** A message is a scheduling hint. Each child still captures and validates its
 * current generation, configurations, inputs and lease under native guards. */
export async function stepComparisonWakeup(
  store: Store,
  input: ComparisonQueueMessage,
) {
  const wakeup = comparisonQueueMessage(input);
  const current = await store
    .statement(
      `SELECT w.*,r.version AS runtime_version FROM inventory_runtime r CROSS JOIN inventory_comparison_wakeups w CROSS JOIN inventory_comparison_coordinators c WHERE r.id=1 AND r.mode='inventory_read_only' AND w.tenant=? AND c.tenant=w.tenant AND c.version=w.control_version AND c.work_version=w.work_version`,
      wakeup.tenant,
    )
    .first<{
      version: number;
      control_version: number;
      work_version: number;
      not_before: number | null;
      runtime_version: number;
    }>();
  if (
    !current ||
    current.runtime_version !== wakeup.runtimeVersion ||
    current.not_before === null ||
    wakeup.wakeupVersion > current.version ||
    wakeup.controlVersion > current.control_version ||
    wakeup.workVersion > current.work_version
  )
    return { kind: "stale" as const };
  if (current.not_before > Date.now())
    return { kind: "deferred" as const, retryAt: current.not_before };
  const turn = await new InventoryComparisonCoordinator(store).step(
    wakeup.tenant,
  );
  if (turn.kind === "deferred")
    return { kind: "deferred" as const, retryAt: Date.now() + 1000 };
  return { kind: "completed" as const, turn };
}

export async function consumeComparisonWakeups(
  store: Store,
  batch: Pick<MessageBatch<unknown>, "messages">,
  queue: ComparisonQueue,
  options: {
    maxTurns?: number;
    maxStepsPerWakeup?: number;
    afterPublish?: () => Promise<void>;
  } = {},
) {
  const maxTurns = options.maxTurns ?? 1;
  const maxStepsPerWakeup = options.maxStepsPerWakeup ?? 1;
  if (
    !positive(maxTurns) ||
    !positive(maxStepsPerWakeup) ||
    maxTurns * maxStepsPerWakeup > MAX_COMPARISON_STEPS_PER_WAKEUP
  )
    throw new Error("invalid_comparison_queue_turn_limit");
  const report = {
    processed: 0,
    steps: 0,
    acknowledged: 0,
    retried: 0,
    invalid: 0,
    failed: 0,
    queued: 0,
  };
  const completed: Message<unknown>[] = [];
  for (const message of batch.messages) {
    let wakeup: ComparisonQueueMessage;
    try {
      wakeup = comparisonQueueMessage(message.body);
    } catch {
      message.ack();
      report.acknowledged++;
      report.invalid++;
      continue;
    }
    if (report.processed >= maxTurns) {
      message.retry({ delaySeconds: 1 });
      report.retried++;
      continue;
    }
    report.processed++;
    try {
      const deadline = Date.now() + COMPARISON_WAKEUP_SLICE_MS;
      const stepLimit = message.attempts > 1 ? 1 : maxStepsPerWakeup;
      let result: Awaited<ReturnType<typeof stepComparisonWakeup>>;
      // Each step re-admits the original hint against the current durable
      // frame. Publish the last frame once before acknowledging the message.
      for (let step = 1; ; step++) {
        result = await stepComparisonWakeup(store, wakeup);
        if (result.kind !== "completed") break;
        report.steps++;
        if (!result.turn.more || step >= stepLimit || Date.now() >= deadline)
          break;
      }
      if (result.kind === "deferred") {
        message.retry({
          delaySeconds: Math.max(
            1,
            Math.min(
              COMPARISON_QUEUE_HORIZON_MS / 1000,
              Math.ceil((result.retryAt - Date.now()) / 1000),
            ),
          ),
        });
        report.retried++;
      } else completed.push(message);
    } catch {
      message.retry({ delaySeconds: 60 });
      report.retried++;
      report.failed++;
    }
  }
  if (completed.length) {
    try {
      report.queued = await publishComparisonWakeups(store, queue);
      await options.afterPublish?.();
      for (const message of completed) {
        message.ack();
        report.acknowledged++;
      }
    } catch {
      for (const message of completed) {
        message.retry({ delaySeconds: 60 });
        report.retried++;
      }
      report.failed++;
    }
  }
  return report;
}
