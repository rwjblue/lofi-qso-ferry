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
  const starts = await startInventorySelections(store);
  const runs = new InventoryRuns(new InventoryIngestion(store));
  const queued = await publishInventoryWakeups(runs, env.INVENTORY_QUEUE);
  return { mode: "inventory_read_only" as const, registration, starts, queued };
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
    new InventoryRuns(new InventoryIngestion(store)),
    fetcher,
    { scheduled: true },
  );
  return {
    mode: "inventory_read_only" as const,
    ...(await consumeInventoryWakeups(runner, batch, env.INVENTORY_QUEUE, {
      maxTurns: 1,
    })),
  };
}
