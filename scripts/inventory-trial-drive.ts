import { setTimeout as delay } from "node:timers/promises";
import { InventoryComparisonCoordinator } from "../src/inventory-comparison-coordinator.ts";
import {
  InventoryRunner,
  type InventoryRunWakeup,
} from "../src/inventory-runner.ts";
import type { InventoryRuns } from "../src/inventory-runs.ts";
import type { createInventoryTrialTransport } from "./inventory-trial-transport.ts";

export function inventoryTrialBounds(options: {
  maxRequests?: number;
  maxDurationMs?: number;
}) {
  const maxRequests = options.maxRequests ?? 120;
  const maxDurationMs = options.maxDurationMs ?? 20 * 60_000;
  if (
    !Number.isSafeInteger(maxRequests) ||
    maxRequests < 1 ||
    maxRequests > 5000 ||
    !Number.isSafeInteger(maxDurationMs) ||
    maxDurationMs < 1 ||
    maxDurationMs > 60 * 60_000
  )
    throw new Error("invalid_inventory_trial_bounds");
  return { maxRequests, maxDurationMs };
}

type Counts = {
  readTurns: number;
  comparisonTurns: number;
  remainingMs: number;
};
type Options = {
  tenant: string;
  maxRequests: number;
  maxDurationMs: number;
  sourcePaused?: boolean;
  continueWithoutSource?: boolean;
  progress?: (value: Counts) => Promise<void>;
};

/** Drive persisted baseline and comparison jobs without starting recurring polls. */
export async function driveInventoryTrial(
  runs: InventoryRuns,
  transport: ReturnType<typeof createInventoryTrialTransport>,
  options: Options,
) {
  const { tenant, maxRequests, maxDurationMs, progress } = options;
  const { store } = runs.inventory;
  const reader = new InventoryRunner(runs, transport.fetch, {
    scheduled: true,
  });
  const coordinator = new InventoryComparisonCoordinator(store);
  const deadline = Date.now() + maxDurationMs;
  let readTurns = 0;
  let comparisonTurns = 0;
  let lastProgress = 0;
  let sourcePaused = options.sourcePaused ?? false;
  let stopReason = "time_limit";
  const save = async () => {
    lastProgress = Date.now();
    await progress?.({
      readTurns,
      comparisonTurns,
      remainingMs: Math.max(0, deadline - lastProgress),
    });
  };
  await save();
  while (Date.now() < deadline) {
    const next = await store
      .statement(
        `SELECT j.scope_id AS scope,j.stream_id AS stream,j.active_run_id AS run,j.work_version AS workVersion,j.next_due_at AS due,r.phase,s.provider
         FROM inventory_stream_jobs j JOIN inventory_runs r ON r.tenant=j.tenant AND r.run_id=j.active_run_id
         JOIN inventory_scopes s ON (s.tenant,s.scope_id)=(j.tenant,j.scope_id)
         WHERE j.tenant=?1 AND j.state='ready'
           AND (?2=0 OR s.provider!='lofi' OR r.phase IN('quarantining','publishing'))
         ORDER BY j.next_due_at,j.scope_id,j.stream_id LIMIT 1`,
        tenant,
        Number(sourcePaused),
      )
      .first<
        Omit<InventoryRunWakeup, "tenant" | "version"> & {
          due: number;
          phase: string;
          provider: string;
        }
      >();
    const wake = await store
      .statement(
        "SELECT not_before FROM inventory_comparison_wakeups WHERE tenant=?",
        tenant,
      )
      .first<number>("not_before");
    if (Date.now() >= deadline) break;
    const requestLimited = transport.metrics.requests >= maxRequests;
    if (
      next &&
      next.due <= Date.now() &&
      (!requestLimited || ["quarantining", "publishing"].includes(next.phase))
    ) {
      let failed = false;
      try {
        await reader.step(
          {
            version: 1,
            tenant,
            scope: next.scope,
            stream: next.stream,
            run: next.run,
            workVersion: next.workVersion,
          },
          {
            signal: AbortSignal.timeout(
              Math.max(1, Math.min(90_000, deadline - Date.now())),
            ),
          },
        );
        readTurns++;
      } catch {
        failed = true;
      }
      if (
        next.provider === "lofi" &&
        transport.lofiAuthorizationRequired &&
        !sourcePaused
      ) {
        sourcePaused = true;
        if (!options.continueWithoutSource) {
          stopReason = "source_authentication_required";
          break;
        }
      } else if (failed) {
        stopReason = "read_turn_failed";
        break;
      }
    } else if (wake !== null && wake <= Date.now()) {
      try {
        await coordinator.step(tenant);
        comparisonTurns++;
      } catch {
        stopReason = "comparison_turn_failed";
        break;
      }
    } else if (next && next.due <= Date.now() && requestLimited) {
      stopReason = "request_limit";
      break;
    } else if (!next) {
      stopReason = sourcePaused
        ? "source_authentication_required"
        : wake
          ? "comparison_parked"
          : "quiescent";
      break;
    } else {
      await delay(
        Math.max(
          1,
          Math.min(1000, next.due - Date.now(), deadline - Date.now()),
        ),
      );
    }
    if (Date.now() - lastProgress >= 30_000) await save();
  }
  await save();
  return {
    stopReason,
    sourceAuthenticationRequired: sourcePaused,
    readTurns,
    comparisonTurns,
  };
}
