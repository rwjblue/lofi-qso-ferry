import {
  type InventoryRunner,
  type InventoryRunWakeup,
  inventoryRunWakeup,
} from "./inventory-runner.ts";
import type { InventoryRuns } from "./inventory-runs.ts";

type InventoryQueue = Pick<Queue<InventoryRunWakeup>, "sendBatch">;
// Keep half the currently documented 24-hour Queue delay as a local horizon.
const MAX_DELAY_SECONDS = 43_200;
function delay(until: number, now: number) {
  return Math.max(
    1,
    Math.min(MAX_DELAY_SECONDS, Math.ceil((until - now) / 1000)),
  );
}

/** Safe to repeat after a lost send acknowledgement or a dead-lettered message. */
export async function publishInventoryWakeups(
  runs: InventoryRuns,
  queue: InventoryQueue,
  options: { limit?: number; now?: number; recoverAfterMs?: number } = {},
) {
  const now = options.now ?? Date.now();
  const recoverAfterMs = options.recoverAfterMs ?? 300_000;
  if (!Number.isSafeInteger(recoverAfterMs) || recoverAfterMs < 60_000)
    throw new Error("invalid_inventory_recovery_delay");
  const rows = await runs.pendingWakeups(
    now + MAX_DELAY_SECONDS * 1000,
    options.limit ?? 100,
    Math.max(1, now - recoverAfterMs),
  );
  if (!rows.length) return 0;
  await queue.sendBatch(
    rows.map((row) => ({
      body: {
        version: 1 as const,
        tenant: row.tenant,
        scope: row.scope_id,
        stream: row.stream_id,
        run: row.run_id,
        workVersion: row.work_version,
      },
      contentType: "json" as const,
      delaySeconds: Math.max(0, Math.ceil((row.not_before - now) / 1000)),
    })),
  );
  await runs.markWakeupsPublished(rows, now);
  return rows.length;
}

/** Await continuation publication before acknowledging successful messages. */
export async function consumeInventoryWakeups(
  runner: InventoryRunner,
  batch: Pick<MessageBatch<unknown>, "messages">,
  queue: InventoryQueue,
  options: { maxTurns?: number; afterPublish?: () => Promise<void> } = {},
) {
  const maxTurns = options.maxTurns ?? 2;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 4)
    throw new Error("invalid_inventory_turn_limit");
  const report = {
    processed: 0,
    acknowledged: 0,
    retried: 0,
    invalid: 0,
    failed: 0,
    queued: 0,
  };
  const completed: Message<unknown>[] = [];
  for (const message of batch.messages) {
    let wakeup: InventoryRunWakeup;
    try {
      wakeup = inventoryRunWakeup(message.body);
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
      const result = await runner.step(wakeup);
      if (result.kind === "skipped" && result.reason !== "stale") {
        message.retry({
          delaySeconds: delay(result.retryAt ?? Date.now() + 5000, Date.now()),
        });
        report.retried++;
      } else completed.push(message);
    } catch {
      // Never log arbitrary provider exceptions, URLs or decrypted bodies.
      message.retry({ delaySeconds: 60 });
      report.retried++;
      report.failed++;
    }
  }
  if (completed.length) {
    try {
      report.queued = await publishInventoryWakeups(runner.runs, queue);
      await options.afterPublish?.();
      for (const message of completed) {
        message.ack();
        report.acknowledged++;
      }
    } catch {
      // The committed outbox remains authoritative if Queue publication fails.
      for (const message of completed) {
        message.retry({ delaySeconds: 60 });
        report.retried++;
      }
      report.failed++;
    }
  }
  return report;
}
