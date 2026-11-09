import type { InventoryRuns } from "./inventory-runs.ts";
import {
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

/** Durable positive collection. A complete collection still needs its drain. */
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

  async enqueue(tenant: string, scope: string, keys: readonly string[]) {
    const selected = [...keys];
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
      const result = await new InventorySourceProofWorkspace(
        this.store,
      ).capture(tenant, scope, selected);
      if (result.kind === "held") return result;
      const snapshot = result.snapshot;
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

  async step(tenant: string, scope: string, id: string) {
    const lease = await this.store.claim(
      tenant,
      `inventory:${scope}`,
      Date.now(),
      90_000,
    );
    if (!lease) return { kind: "busy" as const };
    try {
      const job = await this.load(tenant, scope);
      if (!job || job.job_id !== id) return { kind: "stale" as const };
      if (job.phase === "held" || job.phase === "complete")
        return { kind: job.phase, reason: job.reason };
      const now = Date.now();
      if (job.due_at > now)
        return { kind: "deferred" as const, retryAt: job.due_at };
      const snapshot = JSON.parse(job.snapshot) as InventorySourceProofSnapshot;
      if (job.phase === "draining") return { kind: "draining" as const };
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
