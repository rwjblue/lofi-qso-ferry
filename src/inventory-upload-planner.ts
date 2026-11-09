import {
  INVENTORY_LOTW_BATCH_LIMIT,
  INVENTORY_QRZ_BATCH_LIMIT,
} from "./inventory-delivery-limits.ts";
import {
  InventoryPreparationShadow,
  inventoryPreparationReviewGuard,
} from "./inventory-preparation-shadow.ts";
import type { InventorySourceProofJobs } from "./inventory-source-proof-jobs.ts";
import {
  type InventoryDeliveryEnvironment,
  type InventoryUploadProvider,
  managedInventoryAuthorization,
} from "./inventory-upload-authorization.ts";
import { canonical } from "./security.ts";
import type { Lease } from "./store.ts";

type Provider = InventoryUploadProvider;
type Authorization = NonNullable<
  ReturnType<typeof managedInventoryAuthorization>
>;
interface Route {
  tenant: string;
  source_scope: string;
  destination: string;
  connection: string;
  provider: Provider;
  planned_at: number;
}
interface Turn {
  after_stamp: number | null;
  after_key: string | null;
  batch_limit: number;
  due_at: number;
  proof_id: string | null;
  record_keys: string | null;
}
interface ContactKey {
  key: string;
  stamp: number;
}
type Cursor = Pick<Turn, "after_stamp" | "after_key">;
const PROVIDERS = ["qrz", "lotw"] as const;
const batchLimit = (provider: Provider) =>
  provider === "lotw" ? INVENTORY_LOTW_BATCH_LIMIT : INVENTORY_QRZ_BATCH_LIMIT;
const MAX_ROUTES_PER_TURN = 4;
const RETRY_DELAY_MS = 60_000;
const SPLIT_PREPARATION_HOLDS = new Set([
  "lotw_batch_requires_partition",
  "lotw_batch_report_bound",
  "lotw_batch_byte_bound",
  "lotw_batch_identity_conflict",
  "lotw_station_route_mismatch",
  "lotw_certificate_selection_ambiguous_or_missing",
  "lotw_signing_fields_unavailable",
  "source_payload_unavailable",
  "projection_unavailable",
  "projection_changed",
]);
const keysJson = (values: string[] | null) =>
  values === null ? null : canonical(values);
const isAllowed = (list: string[] | null, value: string) =>
  list === null || list.includes(value);
const routeArgs = ({ tenant, source_scope, destination }: Route) =>
  [tenant, source_scope, destination] as const;
const cursorAt = ({ key, stamp }: ContactKey): Cursor => ({
  after_stamp: stamp,
  after_key: key,
});

const eligible = (provider: Provider) => `b.proof_not_before<=?1
  AND (?2 IS NULL OR b.record_key IN(SELECT value FROM json_each(?2)))
  AND ${inventoryPreparationReviewGuard[provider]}
  AND NOT EXISTS(SELECT 1 FROM inventory_match_stale_sets x WHERE (x.tenant,x.set_id)=(b.tenant,b.result_set))`;

// A new canonical proof drain must not interrupt unclaimed prepared sends for
// the same source. Held or expired work can yield to another route.
const idleSource = `NOT EXISTS(SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=s.tenant)
 AND NOT EXISTS(SELECT 1 FROM inventory_fresh_start_lock WHERE id=1)
 AND NOT EXISTS(SELECT 1 FROM inventory_upload_planner w WHERE (w.tenant,w.source_scope)=(s.tenant,s.scope_id) AND w.proof_id IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM inventory_source_proof_jobs j WHERE (j.tenant,j.scope_id)=(s.tenant,s.scope_id) AND j.phase IN('collecting','draining'))
 AND NOT EXISTS(
  SELECT 1 FROM inventory_qrz_preparations h JOIN inventory_qrz_attempts a USING(tenant,stage_id)
  JOIN inventory_source_proofs pr ON (pr.tenant,pr.proof_id)=(h.tenant,h.proof_id)
  WHERE (h.tenant,h.source_scope)=(s.tenant,s.scope_id) AND h.committed_at IS NOT NULL
  AND pr.expires_at>?1 AND a.cancelled_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM inventory_qrz_dispatches x WHERE (x.tenant,x.attempt_id)=(a.tenant,a.attempt_id))
  AND NOT EXISTS(SELECT 1 FROM inventory_qrz_send_jobs x WHERE (x.tenant,x.attempt_id)=(a.tenant,a.attempt_id) AND x.hold_reason IS NOT NULL))
 AND NOT EXISTS(
  SELECT 1 FROM inventory_lotw_batches h JOIN inventory_source_proofs pr ON (pr.tenant,pr.proof_id)=(h.tenant,h.proof_id)
  WHERE (h.tenant,h.source_scope)=(s.tenant,s.scope_id) AND h.committed_at IS NOT NULL
  AND pr.expires_at>?1 AND h.cancelled_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM inventory_lotw_dispatches x WHERE (x.tenant,x.batch_id)=(h.tenant,h.batch_id))
  AND NOT EXISTS(SELECT 1 FROM inventory_lotw_send_jobs x WHERE (x.tenant,x.batch_id)=(h.tenant,h.batch_id) AND x.hold_reason IS NOT NULL))`;

/** Choose a bounded turn from current native reviews. This planner owns only a
 * cursor and one in-progress proof per source. Preparation, dispatch and
 * reconciliation use their existing durable evidence and native guards. */
export class InventoryUploadPlanner {
  constructor(
    readonly env: InventoryDeliveryEnvironment,
    readonly jobs: InventorySourceProofJobs,
  ) {}

  private get store() {
    return this.jobs.runs.inventory.store;
  }

  private auth(provider: Provider) {
    return managedInventoryAuthorization(this.env, provider);
  }

  private async routes(provider: Provider, auth: Authorization) {
    return (
      await this.store
        .statement(
          `SELECT s.tenant,s.scope_id AS source_scope,d.scope_id AS destination,d.connection_id AS connection,d.provider,
              coalesce(p.planned_at,0) AS planned_at
       FROM inventory_source_proof_scope s JOIN inventory_scopes d ON d.tenant=s.tenant AND d.provider=?3 AND d.state='observing'
       LEFT JOIN inventory_upload_planner p ON (p.tenant,p.source_scope,p.destination)=(s.tenant,s.scope_id,d.scope_id)
       WHERE coalesce(p.due_at,0)<=?1
       AND (?4 IS NULL OR d.connection_id IN(SELECT value FROM json_each(?4)))
       AND ${idleSource}
       AND EXISTS(SELECT 1 FROM inventory_delivery_preparation_review b
        WHERE (b.tenant,b.source_scope,b.destination)=(s.tenant,s.scope_id,d.scope_id) AND ${eligible(provider)})
       ORDER BY planned_at,s.tenant,s.scope_id,d.scope_id LIMIT ${MAX_ROUTES_PER_TURN}`,
          Date.now(),
          keysJson(auth.keys),
          provider,
          keysJson(auth.destinations),
        )
        .all<Route>()
    ).results;
  }

  private turn(route: Route) {
    return this.store
      .statement(
        "SELECT after_stamp,after_key,batch_limit,due_at,proof_id,record_keys FROM inventory_upload_planner WHERE (tenant,source_scope,destination)=(?,?,?)",
        ...routeArgs(route),
      )
      .first<Turn>();
  }

  private async save(
    route: Route,
    turn: Omit<Turn, "record_keys">,
    keys: ContactKey[] | null,
    lease: Lease,
  ) {
    const saved = await this.store
      .statement(
        `INSERT INTO inventory_upload_planner(tenant,source_scope,destination,after_stamp,after_key,planned_at,due_at,batch_limit,proof_id,record_keys)
       SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM leases l WHERE (l.tenant,l.scope,l.token,l.fence)=(?,?,?,?)
         AND l.expires_at>unixepoch('subsec')*1000)
       ON CONFLICT(tenant,source_scope,destination) DO UPDATE SET
       after_stamp=excluded.after_stamp,after_key=excluded.after_key,planned_at=excluded.planned_at,due_at=excluded.due_at,batch_limit=excluded.batch_limit,
       proof_id=excluded.proof_id,record_keys=excluded.record_keys`,
        ...routeArgs(route),
        turn.after_stamp,
        turn.after_key,
        Date.now(),
        turn.due_at,
        turn.batch_limit,
        turn.proof_id,
        keys === null ? null : canonical(keys),
        lease.tenant,
        lease.scope,
        lease.token,
        lease.fence,
      )
      .run();
    if (!saved.meta.changes)
      throw new Error("inventory_upload_planner_lease_lost");
  }

  private async enrollRoute(route: Route) {
    const auth = this.auth(route.provider);
    if (!auth || !isAllowed(auth.destinations, route.connection)) return false;
    const lease = await this.store.claim(
      route.tenant,
      `inventory:upload-planner:${route.source_scope}`,
      Date.now(),
      90_000,
    );
    if (!lease) return false;
    let completed: string | null = null;
    try {
      const now = Date.now();
      const idle = await this.store
        .statement(
          `SELECT 1 FROM inventory_source_proof_scope s WHERE (s.tenant,s.scope_id)=(?2,?3) AND ${idleSource}`,
          now,
          route.tenant,
          route.source_scope,
        )
        .first();
      if (!idle) return false;
      const previous = await this.turn(route);
      if ((previous?.due_at ?? 0) > now) return false;
      const state = {
        after_stamp: previous?.after_stamp ?? null,
        after_key: previous?.after_key ?? null,
        batch_limit: previous?.batch_limit ?? batchLimit(route.provider),
      };
      // Adjacent accepted source stamps keep large proofs in a small number of
      // LoFi read pages, even when the UUIDs have no date order.
      const page = async (after: Cursor, end: Cursor | null, limit: number) =>
        (
          await this.store
            .statement(
              `SELECT f.record_key AS key,f.revision_order AS stamp
           FROM inventory_record_facets f INDEXED BY inventory_source_presence_anchor
           CROSS JOIN inventory_delivery_preparation_review b
            ON (b.tenant,b.source_scope,b.record_key)=(f.tenant,f.scope_id,f.record_key)
           WHERE (f.tenant,f.scope_id,f.entity_family,f.facet)=(?3,?4,'qso','source') AND f.revision_order IS NOT NULL
           AND b.destination=?5 AND ${eligible(route.provider)}
           AND (f.revision_order,f.record_key)>(?6,?7)
           ${end === null ? "" : "AND (f.revision_order,f.record_key)<=(?8,?9)"}
           ORDER BY f.revision_order,f.record_key LIMIT ?10`,
              now,
              keysJson(auth.keys),
              ...routeArgs(route),
              after.after_stamp ?? -1,
              after.after_key ?? "",
              end?.after_stamp ?? null,
              end?.after_key ?? null,
              limit,
            )
            .all<ContactKey>()
        ).results;
      const beginning = { after_stamp: null, after_key: null };
      let keys = await page(state, null, state.batch_limit);
      if (state.after_stamp !== null && !keys.length)
        keys = await page(beginning, state, state.batch_limit);
      if (!keys.length) return false;
      const result = await this.jobs.enqueue(
        route.tenant,
        route.source_scope,
        keys.map(({ key }) => key),
        { provider: route.provider, destination: route.destination },
      );
      if (result.kind === "queued" || result.kind === "complete") {
        await this.save(
          route,
          { ...state, due_at: now, proof_id: result.id },
          keys,
          lease,
        );
        if (result.kind === "complete") completed = result.id;
      } else if (result.kind === "held") {
        await this.retrySmaller(route, state, keys, lease);
      } else if (result.kind === "quiet") {
        await this.save(
          route,
          { ...state, due_at: result.retryAt, proof_id: null },
          null,
          lease,
        );
      } else return false;
    } finally {
      await this.store.release(lease);
    }
    if (completed)
      await this.stage(route.tenant, route.source_scope, completed);
    return true;
  }

  private retrySmaller(
    route: Route,
    turn: Cursor,
    keys: ContactKey[],
    lease: Lease,
  ) {
    return this.save(
      route,
      {
        ...(keys.length === 1
          ? cursorAt(keys[0])
          : { after_stamp: turn.after_stamp, after_key: turn.after_key }),
        batch_limit: Math.max(1, Math.floor(keys.length / 2)),
        due_at: Date.now() + RETRY_DELAY_MS,
        proof_id: null,
      },
      null,
      lease,
    );
  }

  async enroll() {
    const counts = { qrz: 0, lotw: 0 };
    const authorized = PROVIDERS.flatMap((provider) => {
      const auth = this.auth(provider);
      return auth ? [{ provider, auth }] : [];
    });
    if (!authorized.length) return counts;
    const pending = await this.store
      .statement(
        `SELECT p.tenant,p.source_scope,p.proof_id FROM inventory_upload_planner p
       JOIN inventory_scopes s ON (s.tenant,s.scope_id)=(p.tenant,p.destination)
       LEFT JOIN inventory_source_proof_jobs j ON (j.tenant,j.scope_id,j.job_id)=(p.tenant,p.source_scope,p.proof_id)
       WHERE p.proof_id IS NOT NULL AND p.due_at<=?
       AND (j.phase IN('complete','held') OR j.job_id IS NULL
         OR s.provider NOT IN(SELECT value FROM json_each(?)))
       ORDER BY p.due_at,p.tenant,p.source_scope LIMIT ${MAX_ROUTES_PER_TURN}`,
        Date.now(),
        canonical(authorized.map(({ provider }) => provider)),
      )
      .all<{ tenant: string; source_scope: string; proof_id: string }>();
    for (const { tenant, source_scope, proof_id } of pending.results) {
      const result = await this.stage(tenant, source_scope, proof_id);
      if (result.kind === "prepared" && result.provider)
        counts[result.provider]++;
    }
    const routes = (
      await Promise.all(
        authorized.map(({ provider, auth }) => this.routes(provider, auth)),
      )
    )
      .flat()
      .sort(
        (a, b) =>
          a.planned_at - b.planned_at ||
          a.tenant.localeCompare(b.tenant) ||
          a.source_scope.localeCompare(b.source_scope) ||
          a.provider.localeCompare(b.provider) ||
          a.destination.localeCompare(b.destination),
      );
    const selected = new Set<string>();
    for (const route of routes) {
      if (selected.size >= MAX_ROUTES_PER_TURN) break;
      const source = canonical([route.tenant, route.source_scope]);
      if (selected.has(source)) continue;
      if (await this.enrollRoute(route)) {
        selected.add(source);
        counts[route.provider]++;
      }
    }
    return counts;
  }

  async stage(
    tenant: string,
    sourceScope: string,
    proofId: string,
  ): Promise<{
    kind: string;
    provider?: Provider;
    retryAt?: number;
  }> {
    if (this.env.INVENTORY_RUNTIME_MODE !== "managed") return { kind: "idle" };
    const lease = await this.store.claim(
      tenant,
      `inventory:upload-planner:${sourceScope}`,
      Date.now(),
      90_000,
    );
    if (!lease) return { kind: "busy", retryAt: Date.now() + 5_000 };
    try {
      const plan = await this.store
        .statement(
          `SELECT p.*,d.connection_id AS connection,d.provider FROM inventory_upload_planner p
         JOIN inventory_scopes d ON (d.tenant,d.scope_id)=(p.tenant,p.destination)
         WHERE (p.tenant,p.source_scope,p.proof_id)=(?,?,?)
         AND NOT EXISTS(SELECT 1 FROM inventory_fresh_start_lock WHERE id=1)
         AND NOT EXISTS(SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=p.tenant)`,
          tenant,
          sourceScope,
          proofId,
        )
        .first<Route & Turn>();
      if (!plan?.record_keys) return { kind: "idle" };
      const { provider } = plan;
      const keys = JSON.parse(plan.record_keys) as ContactKey[];
      const auth = this.auth(provider);
      if (!auth || !isAllowed(auth.destinations, plan.connection)) {
        await this.save(
          plan,
          { ...plan, due_at: Date.now(), proof_id: null },
          null,
          lease,
        );
        return { kind: "idle", provider };
      }
      if (plan.due_at > Date.now())
        return { kind: "quiet", provider, retryAt: plan.due_at };
      const proof = await this.jobs.current(tenant, proofId);
      if (!proof) {
        const job = await this.jobs.load(tenant, sourceScope);
        if (
          job?.job_id === proofId &&
          (job.phase === "collecting" || job.phase === "draining")
        )
          return { kind: "waiting", provider };
        await this.retrySmaller(plan, plan, keys, lease);
        return { kind: "proof_held", provider };
      }
      if (proof.expires_at > auth.expiresAt) {
        await this.save(
          plan,
          { ...plan, due_at: auth.expiresAt, proof_id: null },
          null,
          lease,
        );
        return { kind: "proof_outside_rollout", provider };
      }
      let selected = keys.filter(({ key }) => isAllowed(auth.keys, key));
      if (!selected.length) {
        await this.save(
          plan,
          { ...plan, due_at: Date.now(), proof_id: null },
          null,
          lease,
        );
        return { kind: "idle", provider };
      }
      for (;;) {
        const result = await new InventoryPreparationShadow(
          this.jobs,
          {
            tenant,
            sourceScope,
            destinationScope: plan.destination,
            recordKeys: selected.map(({ key }) => key),
          },
          provider,
        ).stage(proofId);
        if (result.kind === "quiet" || result.kind === "deferred") {
          await this.save(
            plan,
            { ...plan, due_at: result.retryAt },
            keys,
            lease,
          );
          return { kind: result.kind, provider, retryAt: result.retryAt };
        }
        if (
          result.kind === "held" &&
          selected.length > 1 &&
          SPLIT_PREPARATION_HOLDS.has(result.reason)
        ) {
          selected = selected.slice(0, Math.floor(selected.length / 2));
          continue;
        }
        await this.save(
          plan,
          {
            ...cursorAt(selected[selected.length - 1]),
            batch_limit:
              result.kind === "prepared" && selected.length === keys.length
                ? Math.min(batchLimit(provider), plan.batch_limit * 2)
                : plan.batch_limit,
            due_at:
              result.kind === "prepared"
                ? Date.now()
                : Date.now() + RETRY_DELAY_MS,
            proof_id: null,
          },
          null,
          lease,
        );
        return { kind: result.kind, provider };
      }
    } finally {
      await this.store.release(lease);
    }
  }
}
