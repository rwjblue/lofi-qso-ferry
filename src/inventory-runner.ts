import {
  createLoFiInventoryAdapter,
  createLotwInventoryAdapter,
  createQrzInventoryAdapter,
  type InventoryQueryBinding,
  type InventoryReadContext,
  type InventoryReadResult,
  type InventoryReadUsage,
  type QrzInventoryResume,
} from "./inventory-adapters.ts";
import type { InventoryReceipt } from "./inventory-ingestion.ts";
import {
  inventoryReadAdmission,
  inventoryReadGuardStatements,
} from "./inventory-read-guards.ts";
import {
  type InventoryRunQuery,
  inventoryRunQuery,
  planInventoryRun,
  qrzRunCheckpoint,
} from "./inventory-run-plans.ts";
import type {
  InventoryRun,
  InventoryRunContext,
  InventoryRunReason,
  InventoryRuns,
} from "./inventory-runs.ts";
import {
  INVENTORY_DEFAULT_SOURCE_DELAY_MS,
  INVENTORY_MIN_SOURCE_DELAY_MS,
  inventorySourcePacing,
  inventoryVendorFetch,
} from "./inventory-vendor-admission.ts";
import type { SyncState } from "./lofi.ts";
import { canonical, sha256 } from "./security.ts";
import { openSourceCredentials } from "./source-credentials.ts";
import type { Lease } from "./store.ts";
import { vendorFetch } from "./vendor-requests.ts";

const QRZ_COVERING_POLL_MS = 24 * 60 * 60_000;

/** Queue payloads carry identity and a fence, never credentials or raw pages. */
export interface InventoryRunWakeup {
  version: 1;
  tenant: string;
  scope: string;
  stream: string;
  run: string;
  workVersion: number;
}
export function inventoryRunWakeup(value: unknown): InventoryRunWakeup {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "invalid_inventory_wakeup",
  );
  const row = value as Record<string, unknown>;
  requireValue(
    row.version === 1 &&
      [row.tenant, row.scope, row.stream, row.run].every(
        (value) =>
          typeof value === "string" && value.length > 0 && value.length <= 128,
      ) &&
      Number.isSafeInteger(row.workVersion) &&
      Number(row.workVersion) > 0,
    "invalid_inventory_wakeup",
  );
  return {
    version: 1,
    tenant: String(row.tenant),
    scope: String(row.scope),
    stream: String(row.stream),
    run: String(row.run),
    workVersion: Number(row.workVersion),
  };
}
export type InventoryTurnResult =
  | {
      kind: "skipped";
      reason: "stale" | "not_due" | "busy";
      retryAt?: number;
    }
  | {
      kind: "started";
      run: string;
      workVersion: number;
      phase: InventoryRun["phase"];
      nextDueAt: number;
    }
  | {
      kind: "advanced" | "deferred" | "held" | "complete";
      run: string;
      workVersion: number;
      phase: InventoryRun["phase"];
      nextDueAt: number;
      receipt: InventoryReceipt;
      usage?: InventoryReadUsage;
    };

function requireValue(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
function matches(
  run: InventoryRun | null,
  wakeup: InventoryRunWakeup,
): run is InventoryRun {
  return Boolean(
    run &&
      run.scope === wakeup.scope &&
      run.streamId === wakeup.stream &&
      run.jobVersion === wakeup.workVersion &&
      ((run.jobState === "ready" && run.activeRun === wakeup.run) ||
        (run.jobState === "idle" &&
          run.activeRun === null &&
          run.phase === "complete")),
  );
}
function binding(context: InventoryRunContext): InventoryQueryBinding {
  const { run, stream } = context;
  const queryBinding =
    run.phase === "catchup" ? run.catchupBinding : run.collectionBinding;
  requireValue(queryBinding, "inventory_run_not_reading");
  return {
    scope: stream.scope,
    configVersion: stream.configVersion,
    queryBinding,
  };
}
function resumeObject(value: unknown) {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "invalid_inventory_resume",
  );
  return value as Record<string, unknown>;
}

/** One page or bounded control step. No sleeping or detached continuations. */
export class InventoryRunner {
  constructor(
    readonly runs: InventoryRuns,
    readonly fetcher: typeof fetch = fetch,
    readonly options: { scheduled?: boolean } = {},
  ) {}

  async step(
    wakeup: InventoryRunWakeup,
    options: { signal?: AbortSignal } = {},
  ): Promise<InventoryTurnResult> {
    wakeup = inventoryRunWakeup(wakeup);
    const store = this.runs.inventory.store;
    const first = await this.runs.load(wakeup.tenant, wakeup.run);
    if (!matches(first, wakeup)) return { kind: "skipped", reason: "stale" };
    if (first.nextDueAt > Date.now())
      return { kind: "skipped", reason: "not_due", retryAt: first.nextDueAt };
    const lease = await store.claim(
      wakeup.tenant,
      `inventory:${wakeup.scope}`,
      Date.now(),
      90_000,
    );
    if (!lease)
      return { kind: "skipped", reason: "busy", retryAt: Date.now() + 5000 };
    try {
      // The lease and message may both have become stale while being acquired.
      const current = await this.runs.load(wakeup.tenant, wakeup.run);
      if (!matches(current, wakeup))
        return { kind: "skipped", reason: "stale" };
      if (current.nextDueAt > Date.now())
        return {
          kind: "skipped",
          reason: "not_due",
          retryAt: current.nextDueAt,
        };
      if (current.jobState === "idle")
        return await this.startNext(current, wakeup, lease);
      const context = await this.runs.context(wakeup.tenant, wakeup.run);
      if (!matches(context.run, wakeup))
        return { kind: "skipped", reason: "stale" };
      let query: InventoryRunQuery;
      try {
        query = inventoryRunQuery(context.run.fixedQuery);
        requireValue(
          query.provider === context.stream.provider,
          "invalid_inventory_scan_plan",
        );
      } catch {
        return await this.hold(context, lease, "verification_required");
      }
      if (context.run.phase === "quarantining")
        return await this.published(
          context,
          await this.runs.inventory.publish(
            await this.runs.prepareQuarantine(context, lease),
          ),
        );
      if (context.run.phase === "publishing") {
        const pacing =
          query.provider === "lofi"
            ? await inventorySourcePacing(store, context.stream)
            : undefined;
        const schedule = await this.schedulePolicy(context.run);
        const qrzCoveredMultiplePages =
          query.provider === "qrz" &&
          context.run.mode === "delta" &&
          (context.stream.resume as QrzInventoryResume | null)
            ?.coveringDateSelection === true;
        const next =
          Date.now() +
          Math.max(
            schedule?.poll_period_ms ?? 300_000,
            pacing?.checkPeriodMs ?? 0,
            qrzCoveredMultiplePages ? QRZ_COVERING_POLL_MS : 0,
          );
        return await this.published(
          context,
          await this.runs.inventory.publish(
            await this.runs.prepareComplete(context, lease, next),
          ),
        );
      }
      const result = await this.read(context, lease, query, options.signal);
      requireValue(
        canonical(result.binding) === canonical(binding(context)),
        "inventory_read_binding_changed",
      );
      const coverRetry = context.run.reason === "qrz_cover_retry";
      if (result.kind === "deferred")
        return await this.published(
          context,
          await this.runs.inventory.publish(
            await this.runs.prepareDefer(
              context,
              lease,
              result.retryAt,
              coverRetry ? "qrz_cover_retry" : "vendor_deferred",
            ),
          ),
          "deferred",
          result.usage,
        );
      if (result.kind === "blocked" && result.recovery === "retry")
        return await this.published(
          context,
          await this.runs.inventory.publish(
            await this.runs.prepareDefer(
              context,
              lease,
              Date.now() + 60_000,
              coverRetry ? "qrz_cover_retry" : "read_unavailable",
            ),
          ),
          "deferred",
          result.usage,
        );
      if (
        query.provider === "qrz" &&
        (context.stream.resume as QrzInventoryResume | null)
          ?.coveringDateSelection === true &&
        !coverRetry &&
        result.kind === "blocked" &&
        (result.code === "invalid_response" ||
          result.code === "ambiguous_empty")
      )
        return await this.published(
          context,
          await this.runs.inventory.publish(
            await this.runs.prepareDefer(
              context,
              lease,
              Date.now() + 60_000,
              "qrz_cover_retry",
            ),
          ),
          "deferred",
          result.usage,
        );
      if (result.kind !== "page") {
        const reason: InventoryRunReason =
          result.kind === "split" ||
          (query.provider === "lotw" &&
            result.kind === "blocked" &&
            result.recovery === "review" &&
            ["response_budget", "record_budget", "deadline"].includes(
              result.code,
            ))
            ? "overflow"
            : result.kind === "unsupported"
              ? "unsupported"
              : result.code === "cursor_refused"
                ? "cursor_refused"
                : "verification_required";
        return await this.hold(context, lease, reason, result.usage);
      }
      const observedComplete = result.progress.kind === "observed_complete";
      // The full QRZ selection and MODSINCE catch-up have different query keys.
      // The catch-up must start at LOGID zero, even after a full baseline page.
      const nextResume =
        query.provider === "qrz" &&
        context.run.phase === "collecting" &&
        context.run.catchupBinding &&
        observedComplete
          ? {}
          : result.progress.resume;
      let proposedCheckpoint =
        result.progress.kind === "observed_complete"
          ? result.progress.proposedCheckpoint
          : undefined;
      if (observedComplete && query.provider === "qrz")
        proposedCheckpoint = qrzRunCheckpoint(query, context.run.startedAt);
      const retained =
        query.provider === "lofi"
          ? await inventorySourcePacing(store, context.stream)
          : undefined;
      const loopDelayMs =
        query.provider === "lofi"
          ? Math.max(
              INVENTORY_MIN_SOURCE_DELAY_MS,
              result.pacing?.loopDelayMs ??
                retained?.loopDelayMs ??
                INVENTORY_DEFAULT_SOURCE_DELAY_MS,
            )
          : 0;
      const receipt = await this.runs.inventory.publish(
        await this.runs.preparePage(context, lease, {
          observations: result.observations,
          requestStartedAt: result.requestStartedAt,
          requestBinding: result.binding.queryBinding,
          nextResume,
          observedComplete,
          completedStreams: result.completedStreams,
          proposedCheckpoint,
          nextDueAt: Math.max(
            result.completedAt + loopDelayMs,
            retained?.nextAllowedAt ?? 0,
          ),
          // Discovery remains historical until the explicit cutover policy exists.
          origin: "historical",
          ...(query.provider === "lofi"
            ? {
                pacingDelayMs: loopDelayMs,
                pacingHints: {
                  ...result.pacing,
                  observedAt: result.completedAt,
                },
              }
            : {}),
        }),
      );
      return await this.published(context, receipt, "advanced", result.usage);
    } finally {
      await store.release(lease);
    }
  }

  private async startNext(
    previous: InventoryRun,
    wakeup: InventoryRunWakeup,
    lease: Lease,
  ): Promise<InventoryTurnResult> {
    const inventory = this.runs.inventory;
    // The current generation's immutable outbox identifies the completed run.
    // An older run joined to today's idle job cannot choose its next selection.
    const owned = await inventory.store
      .statement(
        "SELECT 1 owned FROM inventory_wakeups WHERE tenant=? AND scope_id=? AND stream_id=? AND work_version=? AND run_id=?",
        wakeup.tenant,
        wakeup.scope,
        wakeup.stream,
        wakeup.workVersion,
        wakeup.run,
      )
      .first();
    if (!owned) return { kind: "skipped", reason: "stale" };
    const stream = await inventory.snapshot(
      wakeup.tenant,
      wakeup.scope,
      wakeup.stream,
    );
    requireValue(stream, "inventory_stream_unavailable");
    const query = inventoryRunQuery(previous.fixedQuery);
    const plan =
      query.provider === "lofi"
        ? { provider: query.provider, pageSize: query.pageSize }
        : query.provider === "qrz"
          ? {
              provider: query.provider,
              book: query.book,
              between: query.selection.between,
              pageSize: query.pageSize,
              repeatSelectionCatchup: query.repeatSelectionCatchup,
            }
          : {
              provider: query.provider,
              selection: (({ receivedSince: _lower, ...selection }) =>
                selection)(query.query),
            };
    const checkpoint = resumeObject(stream.checkpoint);
    const schedule = await this.schedulePolicy(previous);
    const definition = await planInventoryRun(stream, plan, {
      id: await sha256(canonical(["inventory-next-run-v1", wakeup])),
      mode:
        Object.keys(checkpoint).length === 0 ||
        (schedule && schedule.next_full_at <= Date.now())
          ? "full"
          : "delta",
      now: previous.nextDueAt,
    });
    const run = await this.runs.begin({
      stream,
      lease,
      definition,
      expectedJobVersion: wakeup.workVersion,
    });
    return {
      kind: "started",
      run: run.id,
      phase: run.phase,
      workVersion: run.jobVersion,
      nextDueAt: run.nextDueAt,
    };
  }

  private async schedulePolicy(run: InventoryRun) {
    if (!this.options.scheduled) return null;
    const policy = await this.runs.inventory.store
      .statement(
        "SELECT p.poll_period_ms,p.next_full_at FROM inventory_scheduled_selections p JOIN inventory_scopes s ON s.tenant=p.tenant AND s.scope_id=p.scope_id WHERE p.tenant=? AND p.scope_id=? AND p.stream_id=? AND p.config_version=? AND s.config_version=p.config_version AND s.state='observing'",
        run.tenant,
        run.scope,
        run.streamId,
        run.configVersion,
      )
      .first<{ poll_period_ms: number; next_full_at: number }>();
    requireValue(policy, "inventory_schedule_changed");
    return policy;
  }

  private async hold(
    context: InventoryRunContext,
    lease: Lease,
    reason: InventoryRunReason,
    usage?: InventoryReadUsage,
  ) {
    return this.published(
      context,
      await this.runs.inventory.publish(
        await this.runs.prepareHold(context, lease, reason),
      ),
      "held",
      usage,
    );
  }

  private async published(
    context: InventoryRunContext,
    receipt: InventoryReceipt,
    kind: "advanced" | "deferred" | "held" = "advanced",
    usage?: InventoryReadUsage,
  ): Promise<InventoryTurnResult> {
    const run = await this.runs.load(context.run.tenant, context.run.id);
    requireValue(run, "inventory_run_publication_missing");
    return {
      kind: run.phase === "complete" ? "complete" : kind,
      run: run.id,
      phase: run.phase,
      workVersion: run.jobVersion,
      nextDueAt: run.nextDueAt,
      receipt,
      ...(usage ? { usage } : {}),
    };
  }

  private async read(
    context: InventoryRunContext,
    lease: Lease,
    query: InventoryRunQuery,
    signal?: AbortSignal,
  ): Promise<InventoryReadResult> {
    const store = this.runs.inventory.store;
    const connection = await store.connection(
      context.stream.tenant,
      context.stream.connection,
    );
    requireValue(
      connection &&
        connection.kind === query.provider &&
        connection.status === "active" &&
        connection.credential_version === context.stream.credentialVersion &&
        connection.config === context.stream.connectionConfig &&
        connection.remote_identity === context.stream.remoteIdentity,
      "inventory_connection_changed",
    );
    const readContext: InventoryReadContext = {
      transport: this.fetcher,
      limits: {
        maxRequests: 3,
        maxResponseBytes: 8 * 1024 * 1024,
        maxRecords: 10000,
        deadlineAt: Date.now() + 45_000,
      },
      ...(signal ? { signal } : {}),
    };
    const requestBinding = binding(context);
    if (query.provider === "lofi") {
      const pacing = await inventorySourcePacing(store, context.stream);
      const session = await openSourceCredentials(store, connection);
      const adapter = createLoFiInventoryAdapter(session.credentials, {
        allowLargePages: true,
      });
      readContext.transport = inventoryVendorFetch(
        store,
        context.stream,
        lease,
        this.fetcher,
        {
          priority: context.run.mode === "full" ? "bootstrap" : "background",
          sourceDelayMs: pacing.loopDelayMs,
          guard: () => inventoryReadGuardStatements(store, context, lease),
        },
      );
      try {
        return await adapter.readStep(readContext, {
          binding: requestBinding,
          resume: context.stream.resume as SyncState,
          fixedUpperBound: query.fixedUpperBound,
          pageSize: query.pageSize,
        });
      } finally {
        await session.persistTokenState(adapter.credentialsSnapshot());
      }
    }
    const credential = await store.private<{
      apiKey?: string;
      query?: { username: string; password: string };
    }>(
      connection.tenant,
      connection.id,
      context.stream.credentialVersion,
      "credential",
    );
    requireValue(credential, "inventory_credential_unavailable");
    readContext.transport = vendorFetch(store, query.provider, this.fetcher, {
      priority: "background",
      admit: inventoryReadAdmission(store, context, lease),
    });
    if (query.provider === "qrz") {
      requireValue(
        typeof credential.apiKey === "string" && credential.apiKey.length > 0,
        "inventory_credential_unavailable",
      );
      const config = JSON.parse(connection.config) as Record<string, unknown>;
      requireValue(
        ["bookId", "stationCallsign", "startDate", "endDate"].every(
          (key) => config[key] === query.book[key as keyof typeof query.book],
        ),
        "inventory_book_changed",
      );
      const resume = resumeObject(context.stream.resume);
      const selection =
        context.run.phase === "catchup"
          ? query.catchupSelection
          : query.selection;
      requireValue(selection, "invalid_inventory_scan_plan");
      return createQrzInventoryAdapter(credential.apiKey, query.book).readStep(
        readContext,
        {
          binding: requestBinding,
          selection,
          ...(Object.keys(resume).length
            ? { resume: context.stream.resume as QrzInventoryResume }
            : {}),
          pageSize: query.pageSize,
          ...(context.run.mode === "delta"
            ? { verifyAmbiguousDelta: true }
            : {}),
        },
      );
    }
    requireValue(
      credential.query &&
        typeof credential.query.username === "string" &&
        typeof credential.query.password === "string",
      "inventory_credential_unavailable",
    );
    return createLotwInventoryAdapter(credential.query).readStep(readContext, {
      binding: requestBinding,
      query: query.query,
    });
  }
}
