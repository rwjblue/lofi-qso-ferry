import {
  type InventoryScanPlan,
  planInventoryRun,
} from "./inventory-run-plans.ts";
import type { InventoryRuns } from "./inventory-runs.ts";
import type { InventorySourceProofScope } from "./inventory-source-proof-workspace.ts";
import { SOURCE_PRESENCE_MAX_AGE_MS } from "./source-presence-collector.ts";

export interface InventorySourceDrainReceipt {
  run_id: string;
  page_id: string;
  request_started_at: number;
  completed_at: number;
  checkpoint_version: number;
}

/** Start an early normal delta and recover its durable first-page receipt. */
export class InventorySourceProofDrain {
  constructor(readonly runs: InventoryRuns) {}

  async start(source: InventorySourceProofScope, collectionFinishedAt: number) {
    source = structuredClone(source);
    const now = Date.now();
    if (
      !Number.isSafeInteger(collectionFinishedAt) ||
      collectionFinishedAt > now ||
      collectionFinishedAt <= now - SOURCE_PRESENCE_MAX_AGE_MS
    )
      throw new Error("invalid_inventory_source_drain_time");
    const store = this.runs.inventory.store;
    const lease = await store.claim(
      source.tenant,
      `inventory:${source.scope_id}`,
      now,
      60_000,
    );
    if (!lease) return { kind: "busy" as const };
    try {
      const current = await store
        .statement(
          `SELECT p.plan,p.next_full_at FROM inventory_source_proof_scope s
           JOIN inventory_scheduled_selections p ON p.tenant=s.tenant AND p.scope_id=s.scope_id AND p.stream_id=s.stream_id
           WHERE (s.tenant,s.scope_id,s.stream_id,s.config_version,s.runtime_version,s.credential_version,s.connection_config,s.coverage_epoch,s.policy_epoch,s.checkpoint_version,s.work_version)=(?,?,?,?,?,?,?,?,?,?,?)`,
          source.tenant,
          source.scope_id,
          source.stream_id,
          source.config_version,
          source.runtime_version,
          source.credential_version,
          source.connection_config,
          source.coverage_epoch,
          source.policy_epoch,
          source.checkpoint_version,
          source.work_version,
        )
        .first<{ plan: string; next_full_at: number }>();
      if (!current) return { kind: "scope_changed" as const };
      if (current.next_full_at <= Date.now())
        return { kind: "full_verification_due" as const };
      const stream = await this.runs.inventory.snapshot(
        source.tenant,
        source.scope_id,
        source.stream_id,
      );
      if (
        !stream ||
        stream.version !== source.checkpoint_version ||
        stream.configVersion !== source.config_version ||
        stream.credentialVersion !== source.credential_version ||
        stream.connectionConfig !== source.connection_config
      )
        return { kind: "scope_changed" as const };
      const definition = await planInventoryRun(
        stream,
        JSON.parse(current.plan) as InventoryScanPlan,
        { mode: "delta" },
      );
      const run = await this.runs.begin({
        stream,
        lease,
        definition,
        expectedJobVersion: source.work_version,
      });
      return {
        kind: "started" as const,
        run: run.id,
        nextDueAt: run.nextDueAt,
      };
    } finally {
      await store.release(lease);
    }
  }

  async observed(
    source: InventorySourceProofScope,
    collectionFinishedAt: number,
  ) {
    if (
      !Number.isSafeInteger(collectionFinishedAt) ||
      collectionFinishedAt <= 0
    )
      throw new Error("invalid_inventory_source_drain_time");
    return this.runs.inventory.store
      .statement(
        `SELECT run_id,page_id,request_started_at,completed_at,checkpoint_version FROM inventory_source_proof_drain
         WHERE (tenant,scope_id,stream_id,config_version,runtime_version,credential_version,coverage_epoch,policy_epoch)=(?,?,?,?,?,?,?,?)
         AND connection_config=json_remove(?,'$.lastError','$.lastSuccessfulPollAt','$.accountEmail')
         AND request_started_at>=? AND checkpoint_version>?`,
        source.tenant,
        source.scope_id,
        source.stream_id,
        source.config_version,
        source.runtime_version,
        source.credential_version,
        source.coverage_epoch,
        source.policy_epoch,
        source.connection_config,
        collectionFinishedAt,
        source.checkpoint_version,
      )
      .first<InventorySourceDrainReceipt>();
  }
}
