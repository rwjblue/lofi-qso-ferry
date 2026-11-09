import type { InventoryRuns } from "./inventory-runs.ts";
import { InventorySourceProofDrain } from "./inventory-source-proof-drain.ts";
import {
  type InventorySourceProofRequest,
  type InventorySourceProofScope,
  type InventorySourceProofSnapshot,
  InventorySourceProofWorkspace,
} from "./inventory-source-proof-workspace.ts";
import {
  inventorySourcePacing,
  inventoryVendorFetch,
} from "./inventory-vendor-admission.ts";
import { canonical } from "./security.ts";
import { openSourceCredentials } from "./source-credentials.ts";
import {
  collectSourcePresence,
  SOURCE_PRESENCE_COLLECTION_MS,
  SOURCE_PRESENCE_MAX_AGE_MS,
  type SourcePresenceContinuation,
  type SourcePresenceWitness,
} from "./source-presence-collector.ts";
import type { Lease } from "./store.ts";

type Phase = "collecting" | "draining" | "held" | "complete";
interface Job {
  tenant: string;
  scope_id: string;
  job_id: string;
  version: number;
  phase: Phase;
  snapshot: string;
  witnesses: string;
  continuation: string | null;
  started_at: number;
  collection_deadline: number;
  due_at: number;
  attempts: number;
  collection_finished_at: number | null;
  expires_at: number | null;
  drain_run: string | null;
  reason: string | null;
}
const PROOF_ATTEMPTS = 4;
const leaseSql = `EXISTS(SELECT 1 FROM leases l WHERE l.tenant=? AND l.scope=? AND l.token=? AND l.fence=? AND l.expires_at>unixepoch('subsec')*1000)`;
const leaseArgs = ({ tenant, scope, token, fence }: Lease) =>
  [tenant, scope, token, fence] as const;
const sameRoute = (
  left: InventorySourceProofRequest,
  right: InventorySourceProofRequest,
) =>
  left.provider === right.provider &&
  left.destination === right.destination &&
  left.purpose === right.purpose;

/** Durable collection, canonical drain, and proof publication. */
export class InventorySourceProofJobs {
  constructor(
    readonly runs: InventoryRuns,
    readonly fetcher: typeof fetch = fetch,
  ) {}

  private get store() {
    return this.runs.inventory.store;
  }

  private async boundSource(source: InventorySourceProofScope, lease: Lease) {
    return this.store
      .statement(
        `SELECT 1 AS current FROM inventory_source_proof_scope s
         WHERE (s.tenant,s.scope_id,s.stream_id,s.config_version,s.runtime_version,s.credential_version,s.connection_config,s.coverage_epoch,s.policy_epoch,s.checkpoint_version,s.work_version,s.generation_id)=(?,?,?,?,?,?,?,?,?,?,?,?)
         AND ${leaseSql}`,
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
        source.generation_id,
        ...leaseArgs(lease),
      )
      .first();
  }

  load(tenant: string, scope: string) {
    return this.store
      .statement(
        "SELECT * FROM inventory_source_proof_jobs WHERE tenant=? AND scope_id=?",
        tenant,
        scope,
      )
      .first<Job>();
  }

  current(tenant: string, id: string) {
    return this.store
      .statement(
        "SELECT proof_id,scope_id,drain_run,drain_started_at,expires_at FROM inventory_source_proof_current WHERE tenant=? AND proof_id=?",
        tenant,
        id,
      )
      .first<{
        proof_id: string;
        scope_id: string;
        drain_run: string;
        drain_started_at: number;
        expires_at: number;
      }>();
  }

  async enqueue(
    tenant: string,
    scope: string,
    keys: readonly string[],
    route?: InventorySourceProofRequest,
  ) {
    const selected = [...keys];
    const covers = (snapshot: InventorySourceProofSnapshot) =>
      selected.every((key) =>
        snapshot.contacts.some(
          (contact) =>
            contact.key === key &&
            contact.routes.some((value) =>
              route ? sameRoute(value, route) : value.purpose === undefined,
            ),
        ),
      );
    const lease = await this.store.claim(
      tenant,
      `inventory:${scope}`,
      Date.now(),
      60_000,
    );
    if (!lease) return { kind: "busy" as const };
    try {
      const old = await this.load(tenant, scope);
      if (old?.phase === "collecting" || old?.phase === "draining")
        return { kind: "existing" as const, id: old.job_id };
      if (old?.phase === "complete" && selected.length) {
        const snapshot = JSON.parse(
          old.snapshot,
        ) as InventorySourceProofSnapshot;
        if (covers(snapshot)) {
          const proof = await this.current(tenant, old.job_id);
          if (proof)
            return {
              kind: "complete" as const,
              id: old.job_id,
              expiresAt: proof.expires_at,
            };
        }
      }
      const result = await new InventorySourceProofWorkspace(
        this.store,
      ).capture(tenant, scope, selected, Date.now(), route);
      if (result.kind === "held") return result;
      const snapshot = result.snapshot;
      if (route && !covers(snapshot))
        return { kind: "held" as const, reason: "review_unavailable" as const };
      const now = Date.now();
      const eligibleAt = Math.max(
        ...snapshot.contacts.map((c) => c.eligibleAfter),
      );
      if (eligibleAt > now)
        return { kind: "quiet" as const, retryAt: eligibleAt };
      if (!(await this.boundSource(snapshot.source, lease)))
        return { kind: "changed" as const };
      const id = crypto.randomUUID();
      const saved = await this.store
        .statement(
          `INSERT INTO inventory_source_proof_jobs(tenant,scope_id,job_id,snapshot,witnesses,started_at,collection_deadline,due_at)
           SELECT ?,?,?,?,?,?,?,? WHERE ${leaseSql}
           ON CONFLICT(tenant,scope_id) DO UPDATE SET job_id=excluded.job_id,version=inventory_source_proof_jobs.version+1,phase='collecting',
             snapshot=excluded.snapshot,witnesses=excluded.witnesses,continuation=NULL,started_at=excluded.started_at,
             collection_deadline=excluded.collection_deadline,due_at=excluded.due_at,attempts=0,collection_finished_at=NULL,expires_at=NULL,drain_run=NULL,reason=NULL
           WHERE inventory_source_proof_jobs.phase IN('held','complete')`,
          tenant,
          scope,
          id,
          canonical(snapshot),
          canonical(snapshot.cachedWitnesses),
          now,
          now + SOURCE_PRESENCE_COLLECTION_MS,
          now,
          ...leaseArgs(lease),
        )
        .run();
      return saved.meta.changes === 1
        ? { kind: "queued" as const, id }
        : { kind: "changed" as const };
    } finally {
      await this.store.release(lease);
    }
  }

  async step(
    tenant: string,
    scope: string,
    id: string,
    expectedVersion?: number,
  ) {
    const lease = await this.store.claim(
      tenant,
      `inventory:${scope}`,
      Date.now(),
      90_000,
    );
    if (!lease) return { kind: "busy" as const };
    try {
      const job = await this.load(tenant, scope);
      if (
        !job ||
        job.job_id !== id ||
        (expectedVersion !== undefined && job.version !== expectedVersion)
      )
        return { kind: "stale" as const };
      if (job.phase === "held" || job.phase === "complete")
        return { kind: job.phase, reason: job.reason };
      const now = Date.now();
      if (job.due_at > now)
        return { kind: "not_due" as const, retryAt: job.due_at };
      const snapshot = JSON.parse(job.snapshot) as InventorySourceProofSnapshot;
      if (job.phase === "draining")
        return await this.drain(job, snapshot, lease, now);
      return await this.collect(job, snapshot, lease, now);
    } finally {
      await this.store.release(lease);
    }
  }

  private async collect(
    job: Job,
    snapshot: InventorySourceProofSnapshot,
    lease: Lease,
    now: number,
  ) {
    if (job.collection_deadline <= now)
      return this.hold(job, lease, "collection_expired");
    const { source, presence } = snapshot;
    if (!(await this.boundSource(source, lease)))
      return this.hold(job, lease, "scope_changed");
    const store = this.store;
    const stream = await this.runs.inventory.snapshot(
      job.tenant,
      job.scope_id,
      source.stream_id,
    );
    const connection = await store.connection(job.tenant, source.connection_id);
    if (
      !stream ||
      stream.version !== source.checkpoint_version ||
      !connection ||
      connection.credential_version !== source.credential_version ||
      connection.config !== source.connection_config
    )
      return this.hold(job, lease, "scope_changed");
    const session = await openSourceCredentials(store, connection);
    const pacing = await inventorySourcePacing(store, stream);
    const fetcher = inventoryVendorFetch(store, stream, lease, this.fetcher, {
      priority: "background",
      sourceDelayMs: pacing.loopDelayMs,
      guard: () => ({
        before: [
          store.statement(
            "INSERT INTO inventory_source_proof_admissions(tenant,scope_id,job_id,version,lease_token,lease_fence) VALUES(?,?,?,?,?,?)",
            job.tenant,
            job.scope_id,
            job.job_id,
            job.version,
            lease.token,
            lease.fence,
          ),
        ],
        after: [
          store.statement(
            "DELETE FROM inventory_source_proof_admissions WHERE tenant=? AND scope_id=?",
            job.tenant,
            job.scope_id,
          ),
        ],
      }),
    });
    const result = await collectSourcePresence(
      {
        scope: presence,
        credentials: session.credentials,
        targets: snapshot.dependencies.map(({ target }) => target),
        selectedContacts: snapshot.contacts.map(({ key }) => key),
        observedAnchors: snapshot.anchors,
        cachedWitnesses: JSON.parse(job.witnesses) as SourcePresenceWitness[],
        ...(job.continuation
          ? {
              continuation: JSON.parse(
                job.continuation,
              ) as SourcePresenceContinuation,
            }
          : {}),
        remainingRequests: PROOF_ATTEMPTS - job.attempts,
        collectionStartedAt: job.started_at,
        collectionDeadline: job.collection_deadline,
      },
      {
        fetcher,
        currentScope: async () =>
          (await this.boundSource(source, lease)) ? presence : null,
      },
    );
    await session.persistRenewal(result.credentials);
    const finishedAt = Date.now();
    if (result.status === "observed") {
      const expiresAt =
        Math.min(...result.witnesses.map((w) => w.requestStartedAt)) +
        SOURCE_PRESENCE_MAX_AGE_MS;
      if (
        result.witnesses.length !== snapshot.dependencies.length ||
        finishedAt >= job.collection_deadline ||
        expiresAt <= finishedAt
      )
        return this.hold(job, lease, "witness_expired");
      const saved = await store
        .statement(
          `UPDATE inventory_source_proof_jobs SET phase='draining',version=version+1,witnesses=?,continuation=NULL,
             collection_finished_at=?,expires_at=?,due_at=?,drain_run=?
           WHERE (tenant,scope_id,job_id,version,phase)=(?,?,?,?,'collecting') AND ${leaseSql}`,
          canonical(result.witnesses),
          finishedAt,
          expiresAt,
          finishedAt,
          `proof-${job.job_id}`,
          job.tenant,
          job.scope_id,
          job.job_id,
          job.version,
          ...leaseArgs(lease),
        )
        .run();
      return {
        kind: saved.meta.changes ? ("draining" as const) : ("stale" as const),
      };
    }
    if (
      result.reason === "vendor_deferred" &&
      result.retryAt &&
      result.retryAt < job.collection_deadline &&
      result.remainingRequests > 1
    ) {
      const saved = await store
        .statement(
          `UPDATE inventory_source_proof_jobs SET version=version+1,witnesses=?,continuation=?,due_at=?
           WHERE (tenant,scope_id,job_id,version,phase)=(?,?,?,?,'collecting') AND ${leaseSql}`,
          canonical(result.witnesses),
          result.continuation ? canonical(result.continuation) : null,
          result.retryAt,
          job.tenant,
          job.scope_id,
          job.job_id,
          job.version,
          ...leaseArgs(lease),
        )
        .run();
      return saved.meta.changes
        ? { kind: "deferred" as const, retryAt: result.retryAt }
        : { kind: "stale" as const };
    }
    return this.hold(job, lease, result.reason ?? "read_failed");
  }

  private async drain(
    job: Job,
    snapshot: InventorySourceProofSnapshot,
    lease: Lease,
    now: number,
  ) {
    const {
      drain_run: runId,
      collection_finished_at: finishedAt,
      expires_at: expiry,
    } = job;
    if (!runId || !finishedAt || !expiry || expiry <= now)
      return this.hold(job, lease, "witness_expired");
    const drain = new InventorySourceProofDrain(this.runs);
    const run = await this.runs.load(job.tenant, runId);
    if (!run) {
      const started = await drain.start(snapshot.source, finishedAt, {
        runId,
        lease,
      });
      if (started.kind !== "started")
        return this.hold(job, lease, started.kind);
      return this.waitForDrain(job, lease, started.nextDueAt);
    }
    if (run.phase === "held") return this.hold(job, lease, "drain_held");
    if (run.phase !== "complete")
      return this.waitForDrain(job, lease, run.nextDueAt);
    const receipt = await drain.observed(snapshot.source, finishedAt);
    if (!receipt || receipt.run_id !== runId)
      return this.hold(job, lease, "drain_unqualified");
    const route = snapshot.contacts[0]?.routes.find(
      (route) => route.purpose === "lotw_grid_correction",
    );
    const refreshed = await new InventorySourceProofWorkspace(
      this.store,
    ).capture(
      job.tenant,
      job.scope_id,
      snapshot.contacts.map(({ key }) => key),
      now,
      route,
    );
    if (
      refreshed.kind !== "captured" ||
      canonical(refreshed.snapshot.dependencies) !==
        canonical(snapshot.dependencies) ||
      snapshot.contacts.some((original, i) => {
        const current = refreshed.snapshot.contacts[i];
        return (
          !current ||
          original.key !== current.key ||
          original.operation !== current.operation ||
          original.projectionVersion !== current.projectionVersion ||
          original.projectionPayload !== current.projectionPayload ||
          original.topologyVersion !== current.topologyVersion ||
          !original.routes.some((route) =>
            current.routes.some((value) => sameRoute(route, value)),
          )
        );
      })
    )
      return this.hold(job, lease, "dependencies_changed");
    try {
      const saved = await this.store
        .statement(
          `INSERT INTO inventory_source_proofs(tenant,proof_id,scope_id,snapshot,witnesses,drain_run,drain_page,collection_finished_at,drain_started_at,created_at,expires_at,lease_token,lease_fence)
           SELECT tenant,job_id,scope_id,snapshot,witnesses,drain_run,?,collection_finished_at,?,CAST(unixepoch('subsec')*1000 AS INTEGER),expires_at,?,?
           FROM inventory_source_proof_jobs WHERE (tenant,scope_id,job_id,version,phase)=(?,?,?,?,'draining')`,
          receipt.page_id,
          receipt.request_started_at,
          lease.token,
          lease.fence,
          job.tenant,
          job.scope_id,
          job.job_id,
          job.version,
        )
        .run();
      if (saved.meta.changes)
        return { kind: "complete" as const, expiresAt: expiry };
      return { kind: "stale" as const };
    } catch (error) {
      if (await this.current(job.tenant, job.job_id))
        return { kind: "complete" as const, expiresAt: expiry };
      if (
        error instanceof Error &&
        /inventory source proof (inputs|witnesses)/.test(error.message)
      )
        return this.hold(
          job,
          lease,
          expiry <= Date.now() ? "witness_expired" : "dependencies_changed",
        );
      throw error;
    }
  }

  private async waitForDrain(job: Job, lease: Lease, dueAt: number) {
    const retryAt = Math.min(
      job.expires_at ?? dueAt,
      Math.max(Date.now() + 1000, dueAt),
    );
    const saved = await this.store
      .statement(
        `UPDATE inventory_source_proof_jobs SET version=version+1,due_at=?
         WHERE (tenant,scope_id,job_id,version,phase)=(?,?,?,?,'draining') AND ${leaseSql}`,
        retryAt,
        job.tenant,
        job.scope_id,
        job.job_id,
        job.version,
        ...leaseArgs(lease),
      )
      .run();
    return saved.meta.changes
      ? { kind: "deferred" as const, retryAt }
      : { kind: "stale" as const };
  }

  private async hold(job: Job, lease: Lease, reason: string) {
    const saved = await this.store
      .statement(
        `UPDATE inventory_source_proof_jobs SET phase='held',version=version+1,reason=?,continuation=NULL
         WHERE (tenant,scope_id,job_id,version,phase)=(?,?,?,?,?) AND ${leaseSql}`,
        reason,
        job.tenant,
        job.scope_id,
        job.job_id,
        job.version,
        job.phase,
        ...leaseArgs(lease),
      )
      .run();
    return saved.meta.changes
      ? { kind: "held" as const, reason }
      : { kind: "stale" as const };
  }
}
