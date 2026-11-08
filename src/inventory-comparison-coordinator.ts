import { InventoryComparisonBuilds } from "./inventory-comparison-builds.ts";
import { InventoryComparisonGenerations } from "./inventory-comparison-generations.ts";
import { InventoryMatchingCoverage } from "./inventory-matching-coverage.ts";
import { InventoryMatchingCoverageEvents } from "./inventory-matching-coverage-events.ts";
import { InventoryMatchingInvalidations } from "./inventory-matching-invalidations.ts";
import { InventoryMatchingPairs } from "./inventory-matching-pairs.ts";
import { InventoryMatchingWork } from "./inventory-matching-work.ts";
import { InventoryProjectionCoverageJobs } from "./inventory-projection-coverage-jobs.ts";
import { InventoryProjectionJobs } from "./inventory-projection-jobs.ts";
import type { Lease, Store } from "./store.ts";

interface Control {
  version: number;
  work_version: number;
  observed_version: number;
  phase: number;
  idle_turns: number;
  phase_count: number;
  next_due_at: number;
  build_generation: string;
  build_scope: string;
}
const phases = [
  "build",
  "operation",
  "coverage",
  "project",
  "activate",
  "pair",
  "bucket",
  "coverage-events",
  "coverage-match",
  "match",
] as const;
export const INVENTORY_COMPARISON_PHASE_COUNT = phases.length;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;

/** Durable fair turns over derived comparison work. Child publishers retain
 * native input/lease guards. This coordinator never reads or writes a vendor. */
export class InventoryComparisonCoordinator {
  constructor(readonly store: Store) {}
  private async activationReceipt(
    tenant: string,
    generation: string,
    id: string,
  ) {
    const row = await this.store
      .statement(
        "SELECT generation_id,state FROM inventory_comparison_activations WHERE tenant=? AND activation_id=?",
        tenant,
        id,
      )
      .first<{ generation_id: string; state: string }>();
    if (!row) return null;
    if (row.generation_id !== generation || row.state !== "committed")
      throw new Error("comparison_activation_receipt_conflict");
    return { kind: "activated" as const, generation, recovered: true };
  }
  async activate(
    tenant: string,
    generation: string,
    lease: Lease,
    id: string = crypto.randomUUID(),
  ) {
    lease = structuredClone(lease);
    if (
      ![tenant, generation, id].every(identifier) ||
      lease.tenant !== tenant ||
      lease.scope !== "inventory-comparison"
    )
      throw new Error("invalid_comparison_activation");
    const receipt = await this.activationReceipt(tenant, generation, id);
    if (receipt) return receipt;
    const domain = await new InventoryComparisonGenerations(this.store).domain(
      tenant,
    );
    if (!domain || domain.pending_generation !== generation)
      return { kind: "idle" as const };
    const debt = await this.store
      .statement(
        "SELECT 1 FROM inventory_comparison_generation_debt WHERE tenant=? AND generation_id=? LIMIT 1",
        tenant,
        generation,
      )
      .first();
    if (debt) return { kind: "waiting" as const };
    let publication: D1Result[];
    try {
      publication = await this.store.db.batch([
        this.store.statement(
          "INSERT INTO inventory_comparison_activations(tenant,activation_id,generation_id,previous_generation,domain_version,source_set_version,lease_token,lease_fence,prepared_at) VALUES(?,?,?,?,?,?,?,?,?)",
          tenant,
          id,
          generation,
          domain.active_generation,
          domain.version,
          domain.source_set_version,
          lease.token,
          lease.fence,
          Date.now(),
        ),
        this.store.statement(
          "UPDATE index_generations SET state='active' WHERE tenant=? AND generation_id=? AND state='building'",
          tenant,
          generation,
        ),
        this.store.statement(
          "UPDATE inventory_comparison_activations SET state='committed' WHERE tenant=? AND activation_id=?",
          tenant,
          id,
        ),
      ]);
    } catch (error) {
      const recovered = await this.activationReceipt(
        tenant,
        generation,
        id,
      ).catch(() => null);
      if (recovered) return recovered;
      throw error;
    }
    return {
      kind: "activated" as const,
      generation,
      recovered: false,
      statements: publication.length,
      rowsRead: publication.reduce((n, row) => n + row.meta.rows_read, 0),
      rowsWritten: publication.reduce((n, row) => n + row.meta.rows_written, 0),
    };
  }
  private async finish(
    tenant: string,
    control: Control,
    lease: Lease,
    progress: boolean,
    nextPhase: number,
    build?: { generation_id: string; scope_id: string },
    nextDueAt?: number,
  ) {
    return this.store
      .statement(
        `UPDATE inventory_comparison_coordinators SET version=version+1,observed_version=work_version,phase=?,idle_turns=CASE WHEN ?=1 OR observed_version!=work_version THEN 0 ELSE min(phase_count,idle_turns+1) END,next_due_at=coalesce(?,next_due_at),build_generation=?,build_scope=?,updated_at=?
WHERE tenant=? AND version=? AND EXISTS(SELECT 1 FROM leases l JOIN accounts a ON a.id=l.tenant AND a.status='active' WHERE l.tenant=? AND l.scope='inventory-comparison' AND l.token=? AND l.fence=? AND l.expires_at>unixepoch('subsec')*1000) RETURNING idle_turns,work_version,observed_version,next_due_at`,
        nextPhase,
        Number(progress),
        nextDueAt ?? null,
        build?.generation_id ?? control.build_generation,
        build?.scope_id ?? control.build_scope,
        Date.now(),
        tenant,
        control.version,
        tenant,
        lease.token,
        lease.fence,
      )
      .first<{
        idle_turns: number;
        next_due_at: number;
        work_version: number;
        observed_version: number;
      }>();
  }
  async step(tenant: string) {
    if (!identifier(tenant))
      throw new Error("invalid_comparison_coordinator_tenant");
    const eligible = await this.store
      .statement(
        "SELECT 1 FROM accounts a WHERE a.id=? AND a.status='active' AND EXISTS(SELECT 1 FROM inventory_scopes s WHERE s.tenant=a.id)",
        tenant,
      )
      .first();
    if (!eligible) return { kind: "idle" as const, more: false };
    const lease = await this.store.claim(
      tenant,
      "inventory-comparison",
      Date.now(),
      60000,
    );
    if (!lease) return { kind: "deferred" as const, more: true };
    try {
      await this.store
        .statement(
          "INSERT INTO inventory_comparison_coordinators(tenant) VALUES(?) ON CONFLICT DO NOTHING",
          tenant,
        )
        .run();
      let control = await this.store
        .statement(
          "SELECT * FROM inventory_comparison_coordinators WHERE tenant=?",
          tenant,
        )
        .first<Control>();
      if (!control || control.phase_count !== phases.length)
        throw new Error("comparison_coordinator_unavailable");
      if (
        control.next_due_at > 0 &&
        control.next_due_at <= Date.now() &&
        control.idle_turns === control.phase_count &&
        control.work_version === control.observed_version
      ) {
        const resumed = await this.store
          .statement(
            `UPDATE inventory_comparison_coordinators SET version=version+1,observed_version=work_version,idle_turns=0,next_due_at=0,updated_at=? WHERE tenant=? AND version=? AND EXISTS(SELECT 1 FROM leases l WHERE l.tenant=? AND l.scope='inventory-comparison' AND l.token=? AND l.fence=? AND l.expires_at>unixepoch('subsec')*1000) RETURNING *`,
            Date.now(),
            tenant,
            control.version,
            tenant,
            lease.token,
            lease.fence,
          )
          .first<Control>();
        if (!resumed) return { kind: "deferred" as const, more: true };
        control = resumed;
      }
      const generations = new InventoryComparisonGenerations(this.store);
      let domain = await generations.domain(tenant);
      if (!domain?.active_generation && !domain?.pending_generation) {
        domain = await generations.begin(tenant);
        const saved = await this.finish(tenant, control, lease, true, 0);
        return {
          kind: saved ? ("initialized" as const) : ("deferred" as const),
          more: true,
          generation: domain.pending_generation,
        };
      }
      const phase = phases[control.phase];
      let progress = false;
      let deferred = false;
      let build: { generation_id: string; scope_id: string } | undefined;
      let records = 0;
      let pageId: string | undefined;
      let nextDueAt: number | undefined;
      if (phase === "build") {
        const candidate = await this.store
          .statement(
            `SELECT b.generation_id,b.scope_id FROM comparison_domains d CROSS JOIN index_generations g CROSS JOIN comparison_builds b
WHERE d.tenant=? AND g.tenant=d.tenant AND g.generation_id IN(d.active_generation,d.pending_generation) AND g.state IN('active','building') AND b.tenant=g.tenant AND b.generation_id=g.generation_id AND b.complete=0
ORDER BY (b.generation_id,b.scope_id)<=(?,?),b.generation_id,b.scope_id LIMIT 1`,
            tenant,
            control.build_generation,
            control.build_scope,
          )
          .first<{ generation_id: string; scope_id: string }>();
        if (candidate) {
          build = candidate;
          const result = await new InventoryComparisonBuilds(this.store).step(
            tenant,
            build.generation_id,
            build.scope_id,
          );
          deferred = "deferred" in result;
          progress = !deferred;
          records = "records" in result ? result.records : 0;
        }
      } else if (phase === "operation") {
        const result = await new InventoryProjectionJobs(this.store).expandNext(
          tenant,
        );
        progress = result.kind === "expanded";
        pageId = "pageId" in result ? result.pageId : undefined;
        deferred = result.kind === "deferred";
        records = "records" in result ? result.records : 0;
      } else if (phase === "coverage") {
        const result = await new InventoryProjectionCoverageJobs(
          this.store,
        ).step(tenant);
        progress = result.kind === "queued";
        pageId = "pageId" in result ? result.pageId : undefined;
        deferred = result.kind === "deferred";
        records = "records" in result ? result.records : 0;
      } else if (phase === "project") {
        const result = await new InventoryProjectionJobs(
          this.store,
        ).projectNext(tenant);
        progress = result.kind === "projected";
        pageId = "pageId" in result ? result.pageId : undefined;
        deferred = result.kind === "deferred";
        records = "records" in result ? result.records : 0;
      } else if (
        phase === "pair" ||
        phase === "bucket" ||
        phase === "coverage-events" ||
        phase === "coverage-match" ||
        phase === "match"
      ) {
        const result =
          phase === "pair"
            ? await new InventoryMatchingPairs(this.store).step(tenant)
            : phase === "bucket"
              ? await new InventoryMatchingInvalidations(this.store).step(
                  tenant,
                )
              : phase === "coverage-events"
                ? await new InventoryMatchingCoverageEvents(this.store).step(
                    tenant,
                  )
                : phase === "coverage-match"
                  ? await new InventoryMatchingCoverage(this.store).step(tenant)
                  : await new InventoryMatchingWork(this.store).step(tenant);
        progress = result.kind !== "idle" && result.kind !== "deferred";
        deferred = result.kind === "deferred";
        records = "records" in result ? (result.records ?? 0) : 0;
        pageId =
          "pageId" in result
            ? result.pageId
            : "dispatchId" in result
              ? result.dispatchId
              : "setId" in result
                ? result.setId
                : undefined;
        if (phase === "match") {
          const retry = await this.store
            .statement(
              `WITH routes AS MATERIALIZED(SELECT * FROM inventory_matching_coverage_live_routes WHERE tenant=?1),heads AS MATERIALIZED(SELECT (SELECT w.due_at FROM matching_work w INDEXED BY matching_work_scope_pending WHERE w.tenant=r.tenant AND w.generation_id=r.generation_id AND w.destination=r.destination AND w.source_scope=r.source_scope AND w.source_config_version=r.source_config_version AND w.destination_config_version=r.destination_config_version AND w.completed_version<w.work_version ORDER BY w.due_at,w.record_key LIMIT 1) AS due_at FROM routes r) SELECT coalesce(min(due_at),0) AS due_at FROM heads`,
              tenant,
            )
            .first<{ due_at: number }>();
          nextDueAt = retry?.due_at ?? 0;
        }
      } else if (domain.pending_generation) {
        const result = await this.activate(
          tenant,
          domain.pending_generation,
          lease,
        );
        progress = result.kind === "activated";
      }
      const saved = await this.finish(
        tenant,
        control,
        lease,
        progress || deferred,
        (control.phase + 1) % phases.length,
        build,
        nextDueAt,
      );
      return {
        kind:
          !saved || deferred
            ? ("deferred" as const)
            : progress
              ? ("advanced" as const)
              : domain.pending_generation
                ? ("waiting" as const)
                : ("idle" as const),
        phase,
        records,
        pageId,
        more: !saved || deferred || saved.idle_turns < phases.length,
        nextDueAt: saved?.next_due_at ?? 0,
      };
    } finally {
      await this.store.release(lease);
    }
  }
}
