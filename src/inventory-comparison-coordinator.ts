import { InventoryAdoptionWork } from "./inventory-adoption-work.ts";
import { InventoryComparisonBuilds } from "./inventory-comparison-builds.ts";
import {
  type InventoryComparisonDomain,
  InventoryComparisonGenerations,
} from "./inventory-comparison-generations.ts";
import { InventoryDeliveryReview } from "./inventory-delivery-review.ts";
import { InventoryMatchingCoverage } from "./inventory-matching-coverage.ts";
import { InventoryMatchingCoverageEvents } from "./inventory-matching-coverage-events.ts";
import { InventoryMatchingInvalidations } from "./inventory-matching-invalidations.ts";
import { InventoryMatchingPairs } from "./inventory-matching-pairs.ts";
import { InventoryMatchingSelected } from "./inventory-matching-selected.ts";
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
  // Older local captures and comparison benchmarks predate adoption work.
  match_activity?: 0 | 1;
  review_activity?: 0 | 1 | 2;
}
type ControlSnapshot = Control &
  Pick<InventoryComparisonDomain, "active_generation" | "pending_generation">;
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
  "selected",
] as const;
export const INVENTORY_COMPARISON_PHASE_COUNT = phases.length;
const matchPhase = phases.indexOf("match");
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;

function matchingMaintenance(store: Store) {
  return {
    jobs: {
      pair: new InventoryMatchingPairs(store),
      bucket: new InventoryMatchingInvalidations(store),
      "coverage-events": new InventoryMatchingCoverageEvents(store),
      "coverage-match": new InventoryMatchingCoverage(store),
      selected: new InventoryMatchingSelected(store),
    },
    ready: undefined as ReadonlySet<string> | undefined,
  };
}

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
    turn: {
      progress: boolean;
      nextPhase: number;
      checked?: number;
      build?: { generation_id: string; scope_id: string };
      nextDueAt?: number;
    },
  ) {
    const { progress, nextPhase, checked = 1, build, nextDueAt } = turn;
    const { match_activity: activity, review_activity: review } = control;
    const advanceActivity =
      control.phase === matchPhase && nextPhase === matchPhase + 1;
    return this.store
      .statement(
        `UPDATE inventory_comparison_coordinators SET ${activity === undefined ? "" : "match_activity=?,"}${review === undefined ? "" : "review_activity=?,"}version=version+1,observed_version=work_version,phase=?,idle_turns=CASE WHEN ?=1 OR observed_version!=work_version THEN 0 ELSE min(phase_count,idle_turns+?) END,next_due_at=coalesce(?,next_due_at),build_generation=?,build_scope=?,updated_at=?
WHERE tenant=? AND version=? AND EXISTS(SELECT 1 FROM leases l JOIN accounts a ON a.id=l.tenant AND a.status='active' WHERE l.tenant=? AND l.scope='inventory-comparison' AND l.token=? AND l.fence=? AND l.expires_at>unixepoch('subsec')*1000) RETURNING *`,
        ...(activity === undefined
          ? []
          : [advanceActivity ? 1 - activity : activity]),
        ...(review === undefined
          ? []
          : [advanceActivity ? (review + 1) % 3 : review]),
        nextPhase,
        Number(progress),
        checked,
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
      .first<Control>();
  }
  private async checkPhase(
    tenant: string,
    control: Control,
    lease: Lease,
    phase: (typeof phases)[number],
    pendingGeneration: string | null,
    maintenance: ReturnType<typeof matchingMaintenance>,
  ) {
    let progress = false;
    let deferred = false;
    let build: { generation_id: string; scope_id: string } | undefined;
    let records = 0;
    let pageId: string | undefined;
    let nextDueAt: number | undefined;
    let activity: "match" | "adopt" | "review" | undefined;
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
      const result = await new InventoryProjectionCoverageJobs(this.store).step(
        tenant,
      );
      progress = result.kind === "queued";
      pageId = "pageId" in result ? result.pageId : undefined;
      deferred = result.kind === "deferred";
      records = "records" in result ? result.records : 0;
    } else if (phase === "project") {
      const result = await new InventoryProjectionJobs(this.store).projectNext(
        tenant,
      );
      progress = result.kind === "projected";
      pageId = "pageId" in result ? result.pageId : undefined;
      deferred = result.kind === "deferred";
      records = "records" in result ? result.records : 0;
    } else if (phase === "match") {
      const matching = new InventoryMatchingWork(this.store);
      const adoption =
        control.match_activity === undefined
          ? null
          : new InventoryAdoptionWork(this.store);
      const review =
        control.review_activity === undefined
          ? null
          : new InventoryDeliveryReview(this.store);
      const turns = [
        { activity: "match", run: () => matching.step(tenant) },
        ...(adoption
          ? [{ activity: "adopt" as const, run: () => adoption.step(tenant) }]
          : []),
        ...(review
          ? [{ activity: "review" as const, run: () => review.step(tenant) }]
          : []),
      ] as const;
      const preferred = control.review_activity ?? control.match_activity ?? 0;
      for (let offset = 0; offset < turns.length; offset++) {
        const turn = turns[(preferred + offset) % turns.length];
        const result = await turn.run();
        if (turns.length > 1) activity = turn.activity;
        if (result.kind === "idle") continue;
        deferred = result.kind === "deferred";
        progress = !deferred;
        records = "records" in result ? (result.records ?? 0) : 0;
        pageId = "setId" in result ? result.setId : undefined;
        break;
      }
      const retry = await this.store
        .statement(
          `WITH routes AS MATERIALIZED(SELECT * FROM inventory_matching_coverage_live_routes WHERE tenant=?1),heads AS MATERIALIZED(SELECT (SELECT w.due_at FROM matching_work w INDEXED BY matching_work_scope_pending WHERE w.tenant=r.tenant AND w.generation_id=r.generation_id AND w.destination=r.destination AND w.source_scope=r.source_scope AND w.source_config_version=r.source_config_version AND w.destination_config_version=r.destination_config_version AND w.completed_version<w.work_version ORDER BY w.due_at,w.record_key LIMIT 1) AS due_at${adoption ? ",(SELECT w.due_at FROM inventory_adoption_work w INDEXED BY inventory_adoption_work_due WHERE w.tenant=r.tenant AND w.generation_id=r.generation_id AND w.destination=r.destination AND w.source_scope=r.source_scope AND w.source_config_version=r.source_config_version AND w.destination_config_version=r.destination_config_version ORDER BY w.due_at,w.record_key LIMIT 1) AS adoption_due" : ""} FROM routes r) SELECT coalesce(min(due_at),0) AS due_at FROM (SELECT due_at FROM heads${adoption ? " UNION ALL SELECT adoption_due FROM heads" : ""})`,
          tenant,
        )
        .first<{ due_at: number }>();
      nextDueAt = retry?.due_at ?? 0;
      const reviewDueAt = review ? await review.nextDueAt(tenant) : 0;
      if (reviewDueAt)
        nextDueAt = Math.min(nextDueAt || reviewDueAt, reviewDueAt);
    } else if (
      phase === "pair" ||
      phase === "bucket" ||
      phase === "coverage-events" ||
      phase === "coverage-match" ||
      phase === "selected"
    ) {
      if (!maintenance.ready) {
        const jobs = Object.entries(maintenance.jobs);
        const heads = await this.store.db.batch(
          jobs.map(([, job]) => job.headStatement(tenant)),
        );
        maintenance.ready = new Set(
          jobs.flatMap(([name], index) =>
            heads[index].results.length ? [name] : [],
          ),
        );
      }
      // Positive hints still use the current selector and native lease.
      // Signals after this snapshot reset the idle sweep at finish.
      if (maintenance.ready.has(phase)) {
        const result = await maintenance.jobs[phase].step(tenant);
        progress = result.kind !== "idle" && result.kind !== "deferred";
        deferred = result.kind === "deferred";
        records = "records" in result ? (result.records ?? 0) : 0;
        pageId =
          "pageId" in result
            ? result.pageId
            : "dispatchId" in result
              ? result.dispatchId
              : undefined;
      }
    } else if (pendingGeneration) {
      const result = await this.activate(tenant, pendingGeneration, lease);
      progress = result.kind === "activated";
    }
    return { progress, deferred, build, records, pageId, nextDueAt, activity };
  }

  async step(tenant: string) {
    if (!identifier(tenant))
      throw new Error("invalid_comparison_coordinator_tenant");
    const eligible =
      "a.id=? AND a.status='active' AND EXISTS(SELECT 1 FROM inventory_scopes s WHERE s.tenant=a.id)";
    const readControl = () =>
      this.store.statement(
        `SELECT c.*,d.active_generation,d.pending_generation
         FROM accounts a LEFT JOIN inventory_comparison_coordinators c ON c.tenant=a.id
         LEFT JOIN comparison_domains d ON d.tenant=a.id
         WHERE ${eligible}`,
        tenant,
      );
    const [claimed, loaded] = await this.store.db.batch([
      this.store.claimStatement(
        tenant,
        "inventory-comparison",
        Date.now(),
        60000,
        {
          sql: `EXISTS(SELECT 1 FROM accounts a WHERE ${eligible})`,
          params: [tenant],
        },
      ),
      readControl(),
    ]);
    const lease = claimed.results[0] as Lease | undefined;
    let current = loaded.results[0] as
      | ControlSnapshot
      | { version: null }
      | undefined;
    if (!lease)
      return current
        ? { kind: "deferred" as const, more: true }
        : { kind: "idle" as const, more: false };
    try {
      if (!current?.version) {
        const [, initialized] = await this.store.db.batch<ControlSnapshot>([
          this.store.statement(
            `INSERT INTO inventory_comparison_coordinators(tenant)
             SELECT a.id FROM accounts a WHERE ${eligible} ON CONFLICT DO NOTHING`,
            tenant,
          ),
          readControl(),
        ]);
        current = initialized.results[0];
      }
      if (!current?.version || current.phase_count !== phases.length)
        throw new Error("comparison_coordinator_unavailable");
      let control: Control = current;
      if (
        control.next_due_at > 0 &&
        control.next_due_at <= Date.now() &&
        control.idle_turns === control.phase_count &&
        control.work_version === control.observed_version
      ) {
        const resumed = await this.store
          .statement(
            `UPDATE inventory_comparison_coordinators SET version=version+1,observed_version=work_version,idle_turns=0,next_due_at=0,updated_at=? WHERE tenant=? AND version=? AND work_version=? AND EXISTS(SELECT 1 FROM leases l WHERE l.tenant=? AND l.scope='inventory-comparison' AND l.token=? AND l.fence=? AND l.expires_at>unixepoch('subsec')*1000) RETURNING *`,
            Date.now(),
            tenant,
            control.version,
            control.work_version,
            tenant,
            lease.token,
            lease.fence,
          )
          .first<Control>();
        if (!resumed) return { kind: "deferred" as const, more: true };
        control = resumed;
      }
      const pendingGeneration = current.pending_generation;
      if (!current.active_generation && !pendingGeneration) {
        const domain = await new InventoryComparisonGenerations(
          this.store,
        ).begin(tenant);
        const saved = await this.finish(tenant, control, lease, {
          progress: true,
          nextPhase: 0,
        });
        return {
          kind: saved ? ("initialized" as const) : ("deferred" as const),
          more: true,
          generation: domain.pending_generation,
        };
      }
      const maintenance = matchingMaintenance(this.store);
      for (;;) {
        let cursor = control.phase;
        let checked = 0;
        let phase: (typeof phases)[number];
        let result: Awaited<
          ReturnType<InventoryComparisonCoordinator["checkPhase"]>
        >;
        do {
          phase = phases[cursor];
          result = await this.checkPhase(
            tenant,
            control,
            lease,
            phase,
            pendingGeneration,
            maintenance,
          );
          checked++;
          cursor = (cursor + 1) % phases.length;
        } while (
          !result.progress &&
          !result.deferred &&
          phase !== "match" &&
          cursor !== matchPhase
        );
        const {
          progress,
          deferred,
          build,
          records,
          pageId,
          nextDueAt,
          activity,
        } = result;
        const saved = await this.finish(tenant, control, lease, {
          progress: progress || deferred,
          nextPhase: cursor,
          checked,
          build,
          nextDueAt,
        });
        // Keep the durable match boundary and use the same lease for the
        // following match turn when the preceding sweep found no work.
        if (
          saved &&
          cursor === matchPhase &&
          !progress &&
          !deferred &&
          saved.idle_turns < phases.length
        ) {
          control = saved;
          continue;
        }
        return {
          kind:
            !saved || deferred
              ? ("deferred" as const)
              : progress
                ? ("advanced" as const)
                : pendingGeneration
                  ? ("waiting" as const)
                  : ("idle" as const),
          phase,
          ...(activity ? { activity } : {}),
          records,
          pageId,
          more: !saved || deferred || saved.idle_turns < phases.length,
          nextDueAt: saved?.next_due_at ?? 0,
        };
      }
    } finally {
      await this.store.release(lease);
    }
  }
}
