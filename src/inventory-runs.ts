import type {
  InventoryIngestion,
  InventoryObservation,
  InventoryPageInput,
  InventoryStream,
  PreparedInventoryPage,
} from "./inventory-ingestion.ts";
import { inventoryRunQuery } from "./inventory-run-plans.ts";
import type {
  InventoryRunDefinition,
  InventoryRunPhase,
  InventoryRunPublication,
} from "./inventory-run-publication.ts";
import type { InventoryPacingHints } from "./inventory-vendor-admission.ts";
import { canonical, randomToken, sha256 } from "./security.ts";
import type { Lease } from "./store.ts";

export interface InventoryRun
  extends Omit<InventoryRunDefinition, "initialResume"> {
  tenant: string;
  scope: string;
  streamId: string;
  configVersion: number;
  phase: InventoryRunPhase;
  version: number;
  jobVersion: number;
  jobState: "idle" | "ready" | "held";
  reason: InventoryRunReason | null;
  nextDueAt: number;
  activeRun: string | null;
  expectedStreamVersion: number;
  startSequence: number;
  startedAt: number;
  phaseStartedAt: number;
  inputDigest: string;
  proposedCheckpoint: unknown | undefined;
  cursor: { family: string; key: string } | null;
}
export interface InventoryRunContext {
  run: InventoryRun;
  stream: InventoryStream;
}
export interface InventoryRunPage {
  observations: InventoryObservation[];
  requestStartedAt: number;
  requestBinding: string;
  nextResume: unknown;
  observedComplete: boolean;
  completedStreams: string[];
  proposedCheckpoint?: unknown;
  nextDueAt: number;
  pageId?: string;
  origin?: "historical" | "forward";
  pacingDelayMs?: number;
  pacingHints?: InventoryPacingHints;
}
export type InventoryRunReason = Extract<
  InventoryRunPublication,
  { action: "defer" | "hold" }
>["reason"];
function requireValue(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
function id(value: string) {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}
function time(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}

/** Full and delta runs share persistence; only a full run can establish coverage. */
export class InventoryRuns {
  constructor(readonly inventory: InventoryIngestion) {}

  async load(
    tenant: string,
    runId: string,
    scopePolicies = false,
  ): Promise<InventoryRun | null> {
    const row = await this.inventory.store
      .statement(
        `SELECT r.*,j.work_version AS job_version,j.active_run_id,j.state AS job_state,j.next_due_at FROM inventory_runs r JOIN inventory_stream_jobs j ON j.tenant=r.tenant AND j.scope_id=r.scope_id AND j.stream_id=r.stream_id WHERE r.tenant=? AND r.run_id=? ${scopePolicies ? "AND EXISTS(SELECT 1 FROM inventory_scoped_schedule p WHERE (p.tenant,p.scope_id,p.stream_id)=(r.tenant,r.scope_id,r.stream_id))" : ""}`,
        tenant,
        runId,
      )
      .first<{
        tenant: string;
        run_id: string;
        scope_id: string;
        stream_id: string;
        facet: "source" | "receipt";
        partition_id: string;
        partition_binding: string;
        mode: "full" | "delta";
        config_version: number;
        collection_binding: string;
        catchup_binding: string | null;
        fixed_query: string;
        required_streams: string;
        phase: InventoryRunPhase;
        version: number;
        job_version: number;
        job_state: "idle" | "ready" | "held";
        reason: InventoryRunReason | null;
        next_due_at: number;
        active_run_id: string | null;
        expected_stream_version: number;
        start_sequence: number;
        started_at: number;
        phase_started_at: number;
        input_digest: string;
        proposed_checkpoint: string | null;
        cursor_family: string | null;
        cursor_key: string | null;
      }>();
    if (!row) return null;
    return {
      id: row.run_id,
      tenant: row.tenant,
      scope: row.scope_id,
      streamId: row.stream_id,
      facet: row.facet,
      partition: row.partition_id,
      partitionBinding: row.partition_binding,
      mode: row.mode,
      configVersion: row.config_version,
      collectionBinding: row.collection_binding,
      ...(row.catchup_binding ? { catchupBinding: row.catchup_binding } : {}),
      fixedQuery: JSON.parse(row.fixed_query),
      requiredStreams: JSON.parse(row.required_streams),
      phase: row.phase,
      version: row.version,
      jobVersion: row.job_version,
      jobState: row.job_state,
      reason: row.reason,
      nextDueAt: row.next_due_at,
      activeRun: row.active_run_id,
      expectedStreamVersion: row.expected_stream_version,
      startSequence: row.start_sequence,
      startedAt: row.started_at,
      phaseStartedAt: row.phase_started_at,
      inputDigest: row.input_digest,
      proposedCheckpoint:
        row.proposed_checkpoint === null
          ? undefined
          : JSON.parse(row.proposed_checkpoint),
      cursor:
        row.cursor_family === null
          ? null
          : { family: row.cursor_family, key: row.cursor_key ?? "" },
    };
  }

  /** Capture this before the network read. A CAS failure requires a fresh read. */
  async context(tenant: string, runId: string): Promise<InventoryRunContext> {
    const run = await this.load(tenant, runId);
    requireValue(
      run &&
        run.activeRun === runId &&
        run.jobState === "ready" &&
        !["complete", "held"].includes(run.phase),
      "inventory_run_not_active",
    );
    const stream = await this.inventory.snapshot(
      tenant,
      run.scope,
      run.streamId,
    );
    requireValue(
      stream &&
        stream.version === run.expectedStreamVersion &&
        stream.configVersion === run.configVersion,
      "inventory_run_context_changed",
    );
    return { run, stream };
  }

  async begin(options: {
    stream: InventoryStream;
    lease: Lease;
    definition: InventoryRunDefinition;
    now?: number;
    replaceHeld?: boolean;
    expectedJobVersion?: number;
  }): Promise<InventoryRun> {
    options = structuredClone(options);
    const { stream, lease, definition: d } = options;
    requireValue(
      [
        d.id,
        d.partition,
        d.partitionBinding,
        d.collectionBinding,
        ...(d.catchupBinding ? [d.catchupBinding] : []),
      ].every(id),
      "invalid_inventory_run_binding",
    );
    requireValue(
      d.mode === "full" || !d.catchupBinding,
      "delta_cannot_quarantine",
    );
    requireValue(
      (stream.provider === "lofi") === (d.facet === "source"),
      "inventory_run_facet_changed",
    );
    const required =
      stream.provider === "lofi" ? ["operations", "qsos"] : ["selection"];
    requireValue(
      canonical([...new Set(d.requiredStreams)].sort()) ===
        canonical(required.sort()) &&
        d.requiredStreams.length === required.length,
      "invalid_inventory_completion_vector",
    );
    requireValue(
      d.mode !== "full" || stream.provider !== "lofi" || d.catchupBinding,
      "source_inventory_requires_catchup",
    );
    if (options.replaceHeld && d.mode === "delta") {
      const query =
        stream.provider === "lotw" && inventoryRunQuery(d.fixedQuery);
      requireValue(
        query && query.provider === "lotw" && "kind" in query.query,
        "held_run_requires_full_restart",
      );
    }
    const digest = await sha256(
      canonical([
        stream,
        d,
        options.replaceHeld === true,
        options.expectedJobVersion ?? null,
      ]),
    );
    const existing = await this.load(stream.tenant, d.id);
    if (existing) {
      requireValue(existing.inputDigest === digest, "inventory_run_id_reused");
      return existing;
    }
    const job = await this.inventory.store
      .statement(
        "SELECT work_version FROM inventory_stream_jobs WHERE tenant=? AND scope_id=? AND stream_id=?",
        stream.tenant,
        stream.scope,
        stream.stream,
      )
      .first<{ work_version: number }>();
    const now = options.now ?? Date.now();
    requireValue(
      options.expectedJobVersion === undefined ||
        (Number.isSafeInteger(options.expectedJobVersion) &&
          options.expectedJobVersion >= 0),
      "invalid_inventory_job_version",
    );
    const input: InventoryPageInput = {
      pageId: `run:${d.id}:begin`,
      stream,
      lease,
      facet: d.facet,
      requestStartedAt: now,
      origin: "historical",
      observations: [],
      nextResume: d.initialResume,
      run: {
        action: "begin",
        phase: "collecting",
        id: d.id,
        version: 0,
        jobVersion: options.expectedJobVersion ?? job?.work_version ?? 0,
        nextDueAt: now,
        definition: d,
        inputDigest: digest,
        replaceHeld: options.replaceHeld,
      },
    };
    await this.inventory.publish(await this.inventory.prepare(input));
    const committed = await this.load(stream.tenant, d.id);
    requireValue(committed, "inventory_run_publication_missing");
    return committed;
  }

  preparePage(
    context: InventoryRunContext,
    lease: Lease,
    page: InventoryRunPage,
  ): Promise<PreparedInventoryPage> {
    context = structuredClone(context);
    page = structuredClone(page);
    const { run, stream } = context;
    requireValue(
      run.activeRun === run.id && ["collecting", "catchup"].includes(run.phase),
      "inventory_run_not_reading",
    );
    requireValue(
      id(page.requestBinding) &&
        time(page.nextDueAt) &&
        Array.isArray(page.completedStreams),
      "invalid_inventory_run_progress",
    );
    return this.inventory.prepare({
      pageId: page.pageId ?? randomToken(),
      stream,
      lease,
      facet: run.facet,
      requestStartedAt: page.requestStartedAt,
      origin: page.origin ?? "historical",
      observations: page.observations,
      nextResume: page.nextResume,
      run: {
        action: "page",
        phase: run.phase,
        id: run.id,
        version: run.version,
        jobVersion: run.jobVersion,
        nextDueAt: page.nextDueAt,
        requestBinding: page.requestBinding,
        observedComplete: page.observedComplete,
        completedStreams: page.completedStreams,
        proposedCheckpoint: page.proposedCheckpoint,
        ...(page.pacingDelayMs === undefined
          ? {}
          : { pacingDelayMs: page.pacingDelayMs }),
        ...(page.pacingHints === undefined
          ? {}
          : { pacingHints: page.pacingHints }),
      },
    });
  }

  async prepareQuarantine(
    context: InventoryRunContext,
    lease: Lease,
    options: { limit?: number; pageId?: string; proveCurrent?: boolean } = {},
  ): Promise<PreparedInventoryPage> {
    context = structuredClone(context);
    const { run } = context;
    requireValue(
      run.mode === "full" && run.phase === "quarantining",
      "inventory_run_not_quarantining",
    );
    const limit = options.limit ?? 200;
    requireValue(
      Number.isSafeInteger(limit) && limit > 0 && limit <= 500,
      "invalid_inventory_quarantine_limit",
    );
    const currentTail =
      options.proveCurrent && run.facet === "source" && run.cursor === null
        ? await this.inventory.store
            .statement(
              "SELECT family,record_key AS key FROM inventory_source_quarantine_current WHERE (tenant,run_id)=(?,?)",
              run.tenant,
              run.id,
            )
            .first<{ family: string; key: string }>()
        : null;
    const rows = currentTail
      ? []
      : (
          await this.inventory.store
            .statement(
              `SELECT entity_family AS family,record_key AS key,row_version AS version FROM inventory_partition_membership WHERE tenant=? AND scope_id=? AND stream_id=? AND facet=? AND partition_id=? AND (entity_family,record_key)>(?,?) ORDER BY entity_family,record_key LIMIT ?`,
              run.tenant,
              run.scope,
              run.streamId,
              run.facet,
              run.partition,
              run.cursor?.family ?? "",
              run.cursor?.key ?? "",
              limit,
            )
            .all<{ family: string; key: string; version: number }>()
        ).results;
    const last = currentTail ?? rows.at(-1);
    return this.control(
      context,
      lease,
      {
        action: "quarantine",
        phase: run.phase,
        id: run.id,
        version: run.version,
        jobVersion: run.jobVersion,
        nextDueAt: Date.now(),
        rows,
        nextCursor: last ? { family: last.family, key: last.key } : null,
        exhausted: rows.length === 0,
      },
      options.pageId ?? `run:${run.id}:quarantine:${run.version}`,
    );
  }

  prepareComplete(
    context: InventoryRunContext,
    lease: Lease,
    nextRunAt = Date.now() + 300_000,
  ): Promise<PreparedInventoryPage> {
    context = structuredClone(context);
    const { run } = context;
    requireValue(
      run.phase === "publishing" && time(nextRunAt),
      "inventory_run_not_publishable",
    );
    return this.control(
      context,
      lease,
      {
        action: "complete",
        phase: run.phase,
        id: run.id,
        version: run.version,
        jobVersion: run.jobVersion,
        nextDueAt: nextRunAt,
      },
      `run:${run.id}:complete`,
      run.proposedCheckpoint,
    );
  }

  prepareDefer(
    context: InventoryRunContext,
    lease: Lease,
    retryAt: number,
    reason: InventoryRunReason = "vendor_deferred",
  ) {
    const { run } = context;
    requireValue(time(retryAt), "invalid_inventory_retry_time");
    return this.control(
      context,
      lease,
      {
        action: "defer",
        phase: run.phase,
        id: run.id,
        version: run.version,
        jobVersion: run.jobVersion,
        nextDueAt: Math.max(Date.now() + 1_000, retryAt),
        reason,
      },
      `run:${run.id}:defer:${run.version}`,
    );
  }

  prepareHold(
    context: InventoryRunContext,
    lease: Lease,
    reason: InventoryRunReason,
  ) {
    const { run } = context;
    return this.control(
      context,
      lease,
      {
        action: "hold",
        phase: run.phase,
        id: run.id,
        version: run.version,
        jobVersion: run.jobVersion,
        nextDueAt: Number.MAX_SAFE_INTEGER,
        reason,
      },
      `run:${run.id}:hold:${run.version}`,
    );
  }

  private control(
    context: InventoryRunContext,
    lease: Lease,
    run: InventoryRunPublication,
    pageId: string,
    checkpoint?: unknown,
  ) {
    return this.inventory.prepare({
      pageId,
      stream: context.stream,
      lease,
      facet: context.run.facet,
      requestStartedAt: Date.now(),
      origin: "historical",
      observations: [],
      nextResume: context.stream.resume,
      ...(checkpoint === undefined ? {} : { nextCheckpoint: checkpoint }),
      run,
    });
  }

  coverage(
    tenant: string,
    scope: string,
    stream: string,
    facet: "source" | "receipt",
    partition: string,
  ) {
    return this.inventory.store
      .statement(
        "SELECT * FROM inventory_coverage WHERE tenant=? AND scope_id=? AND stream_id=? AND facet=? AND partition_id=?",
        tenant,
        scope,
        stream,
        facet,
        partition,
      )
      .first<{
        state: "partial" | "collecting" | "ready" | "held";
        kind: "positive_only" | "observed_selection";
        version: number;
        epoch: number;
        published_run_id: string | null;
        completed_at: number | null;
      }>();
  }

  /** Re-enable the same verified logical account; old runs stay held. */
  async resumeHeldScope(
    tenant: string,
    scope: string,
    expectedLogicalIdentity: string,
  ) {
    const result = await this.inventory.store
      .statement(
        `UPDATE inventory_scopes SET state='observing',config_version=config_version+1 WHERE tenant=? AND scope_id=? AND logical_identity=? AND state='held' AND EXISTS(SELECT 1 FROM connections c JOIN accounts a ON a.id=c.tenant JOIN private_data p ON p.tenant=c.tenant AND p.connection=c.id AND p.id=c.credential_version AND p.kind='credential' WHERE c.tenant=inventory_scopes.tenant AND c.id=inventory_scopes.connection_id AND c.kind=inventory_scopes.provider AND c.remote_identity=inventory_scopes.logical_identity AND c.status='active' AND a.status='active' AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>unixepoch('subsec')*1000))`,
        tenant,
        scope,
        expectedLogicalIdentity,
      )
      .run();
    return result.meta.changes > 0;
  }

  async pendingWakeups(
    before = Date.now() + 43_200_000,
    limit = 100,
    recoverBefore?: number,
    scopePolicies = false,
    now = Date.now(),
  ) {
    requireValue(
      time(now) &&
        time(before) &&
        Number.isSafeInteger(limit) &&
        limit > 0 &&
        limit <= 100 &&
        (recoverBefore === undefined || time(recoverBefore)),
      "invalid_inventory_wakeup_limit",
    );
    const current = `(j.tenant,j.scope_id,j.stream_id,j.work_version)=(w.tenant,w.scope_id,w.stream_id,w.work_version)
      AND j.state IN ('idle','ready') AND j.next_due_at<=?1
      ${scopePolicies ? "AND EXISTS(SELECT 1 FROM inventory_scoped_schedule p WHERE (p.tenant,p.scope_id,p.stream_id)=(j.tenant,j.scope_id,j.stream_id))" : ""}`;
    return (
      await this.inventory.store
        .statement(
          `WITH fresh AS MATERIALIZED (
             SELECT w.* FROM inventory_wakeups w INDEXED BY inventory_wakeup_pending
             CROSS JOIN inventory_stream_jobs j
             WHERE w.publishable=1 AND w.published_at IS NULL AND w.not_before<=?1 AND ${current}
             ORDER BY w.not_before,w.tenant,w.scope_id,w.stream_id LIMIT ?4
           ), recoverable AS MATERIALIZED (
             SELECT w.* FROM inventory_wakeups w INDEXED BY inventory_wakeup_recovery
             CROSS JOIN inventory_stream_jobs j
             WHERE ?2>=0 AND w.publishable=1 AND w.published_at IS NOT NULL
             AND w.published_at<=?2 AND w.not_before<=min(?1,?3) AND j.next_due_at<=?3 AND ${current}
             ORDER BY w.not_before,w.tenant,w.scope_id,w.stream_id LIMIT ?4
           )
           SELECT * FROM fresh UNION ALL SELECT * FROM recoverable
           ORDER BY not_before,tenant,scope_id,stream_id LIMIT ?4`,
          before,
          recoverBefore ?? -1,
          now,
          limit,
        )
        .all<{
          tenant: string;
          wakeup_id: string;
          scope_id: string;
          stream_id: string;
          run_id: string;
          work_version: number;
          not_before: number;
        }>()
    ).results;
  }

  /** Keep the current wakeup and the preceding fences used to prove a source drain. */
  async pruneWakeups(now = Date.now()) {
    const result = await this.inventory.store
      .statement(
        `DELETE FROM inventory_wakeups WHERE rowid IN (
           SELECT w.rowid FROM inventory_wakeups w INDEXED BY inventory_wakeup_retirement
           CROSS JOIN inventory_stream_jobs j
           WHERE w.publishable=0 AND w.not_before<=?1
           AND (j.tenant,j.scope_id,j.stream_id)=(w.tenant,w.scope_id,w.stream_id)
           AND w.work_version<j.work_version
           AND NOT EXISTS(
             SELECT 1 FROM inventory_wakeup_proof_pins p
             WHERE (p.tenant,p.scope_id,p.stream_id,p.work_version)=(w.tenant,w.scope_id,w.stream_id,w.work_version)
           )
           ORDER BY w.not_before,w.tenant,w.wakeup_id LIMIT 256
         )`,
        now - 86_400_000,
      )
      .run();
    return result.meta.changes;
  }

  /** One bulk acknowledgement after Queue durably accepts an outbox cohort. */
  async markWakeupsPublished(
    wakeups: { tenant: string; wakeup_id: string; work_version: number }[],
    now = Date.now(),
  ) {
    requireValue(
      time(now) &&
        wakeups.length <= 100 &&
        wakeups.every(
          (w) =>
            id(w.tenant) &&
            id(w.wakeup_id) &&
            Number.isSafeInteger(w.work_version) &&
            w.work_version > 0,
        ),
      "invalid_inventory_wakeup_ack",
    );
    if (wakeups.length === 0) return 0;
    return (
      await this.inventory.store
        .statement(
          "UPDATE inventory_wakeups SET published_at=? WHERE (tenant,wakeup_id,work_version) IN (SELECT json_extract(value,'$.tenant'),json_extract(value,'$.wakeup_id'),json_extract(value,'$.work_version') FROM json_each(?)) AND (published_at IS NULL OR published_at<?)",
          now,
          canonical(
            wakeups.map((w) => ({
              tenant: w.tenant,
              wakeup_id: w.wakeup_id,
              work_version: w.work_version,
            })),
          ),
          now,
        )
        .run()
    ).meta.changes;
  }

  async markWakeupPublished(
    tenant: string,
    wakeupId: string,
    version: number,
    now = Date.now(),
  ) {
    requireValue(
      time(now) && Number.isSafeInteger(version) && version > 0,
      "invalid_inventory_wakeup_ack",
    );
    return (
      (
        await this.inventory.store
          .statement(
            "UPDATE inventory_wakeups SET published_at=? WHERE tenant=? AND wakeup_id=? AND work_version=? AND published_at IS NULL",
            now,
            tenant,
            wakeupId,
            version,
          )
          .run()
      ).meta.changes > 0
    );
  }
}
