import {
  deliveryGates,
  routeDeliveryMode,
  type ScheduledDeliveryGates,
} from "./delivery-gates.ts";
import { configuredInventoryShadow } from "./inventory-preparation-shadow.ts";
import {
  type InventoryDeliveryEnvironment,
  managedInventoryAuthorization,
} from "./inventory-upload-authorization.ts";
import { canonical } from "./security.ts";
import type { Store } from "./store.ts";

type Provider = "qrz" | "lotw";
type Dispatch = {
  store: Store;
  send(
    tenant: string,
    id: string,
    loadGates: () => ScheduledDeliveryGates,
  ): Promise<
    | { kind: "held"; reason: string }
    | { kind: "deferred"; retryAt: number }
    | {
        kind: "delivered" | "observed" | "submitted" | "rejected" | "uncertain";
      }
  >;
};

export type { InventoryDeliveryEnvironment } from "./inventory-upload-authorization.ts";

function authorization(env: InventoryDeliveryEnvironment, provider: Provider) {
  if (env.INVENTORY_RUNTIME_MODE !== `selected_${provider}`) return null;
  const shadow = configuredInventoryShadow(env, provider);
  if (shadow.kind !== "configured") return null;
  let gates: ReturnType<typeof deliveryGates>;
  try {
    gates = deliveryGates(env);
  } catch {
    return null;
  }
  const destinations = gates.allowedDestinationIds;
  if (destinations?.length !== 1 || !gates.allowedQsoIds?.length) return null;
  const destination = destinations[0];
  const lotwExpiry = env.LOTW_FRESH_INSERT_EXPIRES_AT;
  const expiresAt =
    provider === "qrz"
      ? gates.qrzFreshInsertExpiresAt
      : typeof lotwExpiry === "string" && /^\d{13}$/.test(lotwExpiry)
        ? Number(lotwExpiry)
        : 0;
  if (!expiresAt || expiresAt <= Date.now()) return null;
  const recordKeys = shadow.selection.recordKeys.filter(
    (key) =>
      routeDeliveryMode(gates, key, { id: destination, kind: provider }) ===
      `${provider}_fresh_insert`,
  );
  if (!recordKeys.length) return null;
  return { ...shadow.selection, recordKeys, destination, expiresAt, gates };
}

export function inventoryWriteStatus(env: InventoryDeliveryEnvironment) {
  const allowed = (provider: Provider) =>
    Boolean(
      managedInventoryAuthorization(env, provider) ??
        authorization(env, provider),
    );
  const qrz = allowed("qrz");
  const lotw = allowed("lotw");
  return {
    exportsEnabled: qrz || lotw,
    exportMode: qrz
      ? lotw
        ? ("fresh_inserts" as const)
        : ("qrz_fresh_insert" as const)
      : lotw
        ? ("lotw_fresh_insert" as const)
        : null,
  };
}

const itemKey = (provider: Provider) =>
  provider === "qrz" ? "attempt" : "batch";
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

export function isInventorySendWakeup(
  provider: Provider,
  value: unknown,
): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      "kind" in value &&
      value.kind === `inventory-${provider}-send`,
  );
}

function sendWakeup(provider: Provider, value: unknown) {
  if (!isInventorySendWakeup(provider, value)) return null;
  const message = value as Record<string, unknown>;
  const id = message[itemKey(provider)];
  const { tenant, workVersion } = message;
  return message.version === 1 &&
    identifier(tenant) &&
    identifier(id) &&
    typeof workVersion === "number" &&
    Number.isSafeInteger(workVersion) &&
    workVersion > 0
    ? { tenant, id, workVersion }
    : null;
}

const allowedLotwMembers = (keys: string, batch = "c") => `NOT EXISTS(
 SELECT 1 FROM inventory_lotw_batch_members m WHERE (m.tenant,m.batch_id)=(${batch}.tenant,${batch}.batch_id)
 AND m.record_key NOT IN(SELECT value FROM json_each(${keys})))`;

const reservations: Record<Provider, string> = {
  qrz: `WITH reserved AS MATERIALIZED(
 SELECT a.attempt_id AS id,a.stage_id,a.record_key,'inventory:qrz-delivery:'||a.book_identity AS lease_scope
 FROM json_each(?1) k CROSS JOIN inventory_scopes s CROSS JOIN inventory_scopes d
 CROSS JOIN inventory_qrz_attempts a INDEXED BY inventory_qrz_active_source
 WHERE s.tenant=?2 AND s.scope_id=?3 AND d.tenant=?2 AND d.scope_id=?4
 AND (a.tenant,a.book_identity,a.source_identity,a.record_key)=(?2,d.logical_identity,s.logical_identity,k.value)
 AND a.cancelled_at IS NULL
)`,
  lotw: `WITH reserved AS MATERIALIZED(
 SELECT DISTINCT m.batch_id AS id,'inventory:lotw-delivery' AS lease_scope
 FROM json_each(?1) k CROSS JOIN inventory_scopes s
 CROSS JOIN inventory_lotw_batch_members m INDEXED BY inventory_lotw_active_source
 WHERE (s.tenant,s.scope_id)=(?2,?3) AND (m.tenant,m.source_identity,m.record_key)=(?2,s.logical_identity,k.value)
 AND m.cancelled_at IS NULL
)`,
};

const expiration = {
  qrz: {
    table: "inventory_qrz_attempts",
    header: "inventory_qrz_preparations",
    headerKey: "stage_id",
    historyHold: "qrz_neighborhood_has_candidate",
    inventoryMatch: `SELECT 1 FROM match_results r
      WHERE (r.tenant,r.destination,r.source_scope,r.record_key)=(?2,?4,?3,b.record_key)
      AND r.state='matched_existing'`,
  },
  lotw: {
    table: "inventory_lotw_batches",
    header: "inventory_lotw_batches",
    headerKey: "batch_id",
    historyHold: "lotw_batch_existing_history",
    inventoryMatch: `SELECT 1 FROM inventory_lotw_batch_members m JOIN match_results r
      ON (r.tenant,r.destination,r.source_scope,r.record_key)=(m.tenant,?4,?3,m.record_key)
      WHERE (m.tenant,m.batch_id)=(?2,b.id) AND r.state='matched_existing'`,
  },
};

const memberKeys: Record<Provider, string> = {
  qrz: "(SELECT json_array(a.record_key) FROM inventory_qrz_attempts a WHERE (a.tenant,a.attempt_id)=(?2,?3))",
  lotw: "(SELECT json_group_array(m.record_key) FROM inventory_lotw_batch_members m WHERE (m.tenant,m.batch_id)=(?2,?3))",
};

type ManagedAuthorization = NonNullable<
  ReturnType<typeof managedInventoryAuthorization>
>;
const allowedManagedMembers = (provider: Provider, keys: string, row: string) =>
  `(${keys} IS NULL OR ${provider === "lotw" ? allowedLotwMembers(keys, row) : `${row}.record_key IN(SELECT value FROM json_each(${keys}))`})`;
const managedBindings = (auth: ManagedAuthorization) =>
  [
    auth.keys === null ? null : canonical(auth.keys),
    auth.destinations === null ? null : canonical(auth.destinations),
    auth.expiresAt,
  ] as const;

const MAX_TURNS = 3;

/** A scoped outbox for current prepared artifacts. A Queue delivery only
 * debits a pre-claim turn. Dispatch still owns the sole may-send boundary. */
export class InventorySendQueue {
  constructor(
    readonly env: InventoryDeliveryEnvironment,
    readonly provider: Provider,
    readonly dispatch: Dispatch,
  ) {}

  async retireExpired() {
    const { provider } = this;
    const managed = managedInventoryAuthorization(this.env, provider);
    if (managed) return this.retireManaged(managed);
    const auth = authorization(this.env, provider);
    if (!auth) return 0;
    const column = `${itemKey(provider)}_id`;
    const { table, header, headerKey, historyHold, inventoryMatch } =
      expiration[provider];
    const completeSelection =
      provider === "lotw" ? allowedLotwMembers("?1", "h") : "true";
    const result = await this.dispatch.store
      .statement(
        `${reservations[provider]}, expired AS MATERIALIZED(
         SELECT b.id FROM reserved b CROSS JOIN ${header} h
         JOIN inventory_source_proofs p ON (p.tenant,p.proof_id)=(h.tenant,h.proof_id)
         WHERE (h.tenant,h.${headerKey},h.source_scope,h.destination,h.destination_connection)
            =(?2,b.${provider === "lotw" ? "id" : "stage_id"},?3,?4,?5)
         AND h.committed_at IS NOT NULL AND p.expires_at<=unixepoch('subsec')*1000
         AND ${completeSelection}
         AND NOT EXISTS(SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=?2)
         AND NOT EXISTS(SELECT 1 FROM inventory_fresh_start_lock WHERE id=1)
         AND NOT EXISTS(SELECT 1 FROM inventory_${provider}_dispatches d WHERE (d.tenant,d.${column})=(?2,b.id))
         AND NOT EXISTS(SELECT 1 FROM leases l WHERE (l.tenant,l.scope)=(?2,b.lease_scope) AND l.expires_at>unixepoch('subsec')*1000)
         AND (NOT EXISTS(SELECT 1 FROM inventory_${provider}_send_jobs j
            WHERE (j.tenant,j.${column},j.hold_reason)=(?2,b.id,?6)) OR EXISTS(${inventoryMatch}))
        )
        UPDATE ${table} SET cancelled_at=CAST(unixepoch('subsec')*1000 AS INTEGER)
        WHERE tenant=?2 AND ${column} IN(SELECT id FROM expired)
        RETURNING 1 AS retired`,
        canonical(auth.recordKeys),
        auth.tenant,
        auth.sourceScope,
        auth.destinationScope,
        auth.destination,
        historyHold,
      )
      .all();
    return result.results.length;
  }

  private async retireManaged(auth: ManagedAuthorization) {
    const { provider } = this;
    const column = `${itemKey(provider)}_id`;
    const { table, header, headerKey, historyHold } = expiration[provider];
    const identity = provider === "qrz" ? "a.stage_id" : "a.batch_id";
    const lease =
      provider === "qrz"
        ? "'inventory:qrz-delivery:'||a.book_identity"
        : "'inventory:lotw-delivery'";
    const records =
      provider === "qrz"
        ? `SELECT a.record_key`
        : `SELECT m.record_key FROM inventory_lotw_batch_members m WHERE (m.tenant,m.batch_id)=(a.tenant,a.batch_id)`;
    const result = await this.dispatch.store
      .statement(
        `WITH expired AS MATERIALIZED(
        SELECT a.tenant,a.${column} AS id
        FROM inventory_${provider}_retirement_candidates q
        CROSS JOIN ${table} a ON (a.tenant,a.${column})=(q.tenant,q.${column})
        CROSS JOIN ${header} h ON (h.tenant,h.${headerKey})=(a.tenant,${identity})
        CROSS JOIN inventory_source_proofs p ON (p.tenant,p.proof_id)=(h.tenant,h.proof_id)
        WHERE p.expires_at<=unixepoch('subsec')*1000 AND a.cancelled_at IS NULL
        AND h.committed_at IS NOT NULL
        AND (?2 IS NULL OR h.destination_connection IN(SELECT value FROM json_each(?2)))
        AND ${allowedManagedMembers(provider, "?1", "a")}
        AND NOT EXISTS(SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=a.tenant)
        AND NOT EXISTS(SELECT 1 FROM inventory_fresh_start_lock WHERE id=1)
        AND NOT EXISTS(SELECT 1 FROM inventory_${provider}_dispatches d WHERE (d.tenant,d.${column})=(a.tenant,a.${column}))
        AND NOT EXISTS(SELECT 1 FROM leases l WHERE (l.tenant,l.scope)=(a.tenant,${lease}) AND l.expires_at>unixepoch('subsec')*1000)
        AND (NOT EXISTS(SELECT 1 FROM inventory_${provider}_send_jobs j WHERE (j.tenant,j.${column},j.hold_reason)=(a.tenant,a.${column},?3))
        OR EXISTS(SELECT 1 FROM match_results_current r WHERE (r.tenant,r.destination,r.source_scope)=(a.tenant,h.destination,h.source_scope)
         AND r.record_key IN(${records}) AND r.state='matched_existing'))
        ORDER BY p.expires_at,a.tenant,a.${column} LIMIT 16
       )
       UPDATE ${table} SET cancelled_at=CAST(unixepoch('subsec')*1000 AS INTEGER)
       WHERE (tenant,${column}) IN(SELECT tenant,id FROM expired)
       RETURNING 1 AS retired`,
        auth.keys === null ? null : canonical(auth.keys),
        auth.destinations === null ? null : canonical(auth.destinations),
        historyHold,
      )
      .all();
    return result.results.length;
  }

  async schedule() {
    const provider = this.provider;
    const managed = managedInventoryAuthorization(this.env, provider);
    if (managed) return this.scheduleManaged(managed);
    const auth = authorization(this.env, provider);
    if (!auth) return 0;
    const column = `${itemKey(provider)}_id`;
    const completeSelection =
      provider === "lotw" ? allowedLotwMembers("?1") : "true";
    const selected = `${reservations[provider]}, selected AS MATERIALIZED(
     SELECT c.tenant,b.id,c.expires_at,b.lease_scope
     FROM reserved b CROSS JOIN inventory_${provider}_send_candidates c
     WHERE (c.tenant,c.${column},c.source_scope,c.destination,c.destination_connection)=(?2,b.id,?3,?4,?5)
     AND c.expires_at<=?6 AND ${completeSelection}
    )`;
    const { store } = this.dispatch;
    const now = Date.now();
    const args = [
      canonical(auth.recordKeys),
      auth.tenant,
      auth.sourceScope,
      auth.destinationScope,
      auth.destination,
      auth.expiresAt,
    ] as const;
    const [, wakeups] = await store.db.batch<{
      tenant: string;
      id: string;
      version: number;
      due_at: number;
    }>([
      store.statement(
        `${selected}
         INSERT INTO inventory_${provider}_send_jobs(tenant,${column},due_at)
         SELECT tenant,id,?7 FROM selected WHERE true
         ON CONFLICT(tenant,${column}) DO NOTHING`,
        ...args,
        now,
      ),
      store.statement(
        `${selected}
         SELECT j.tenant,s.id,j.version,j.due_at FROM selected s
         JOIN inventory_${provider}_send_jobs j ON (j.tenant,j.${column})=(s.tenant,s.id)
         WHERE j.due_at<s.expires_at AND j.turns<${MAX_TURNS}
         AND (j.published_version<j.version OR (j.due_at<=?7 AND j.published_at<=?8))
         AND NOT EXISTS(SELECT 1 FROM leases l WHERE l.tenant=j.tenant AND l.scope=s.lease_scope AND l.expires_at>?7)
         ORDER BY j.due_at,s.id LIMIT 1`,
        ...args,
        now,
        now - 60_000,
      ),
    ]);
    return this.publish(wakeups.results[0], now);
  }

  private async scheduleManaged(auth: ManagedAuthorization) {
    const { provider } = this;
    const column = `${itemKey(provider)}_id`;
    const { store } = this.dispatch;
    const now = Date.now();
    const artifacts =
      provider === "qrz"
        ? `inventory_qrz_preparations h ON (h.tenant,h.proof_id)=(p.tenant,p.proof_id)
         CROSS JOIN inventory_qrz_attempts a USING(tenant,stage_id)
         CROSS JOIN inventory_qrz_send_candidates c USING(tenant,attempt_id)`
        : `inventory_lotw_batches h ON (h.tenant,h.proof_id)=(p.tenant,p.proof_id)
         CROSS JOIN inventory_lotw_send_candidates c USING(tenant,batch_id)`;
    const selected = `WITH selected AS MATERIALIZED(
     SELECT c.tenant,c.${column} AS id,c.expires_at
     FROM inventory_source_proofs p INDEXED BY inventory_source_proofs_expiry CROSS JOIN ${artifacts}
     WHERE p.expires_at>?4 AND ${allowedManagedMembers(provider, "?1", "c")}
     AND (?2 IS NULL OR c.destination_connection IN(SELECT value FROM json_each(?2)))
     AND p.expires_at<=?3
     AND NOT EXISTS(SELECT 1 FROM inventory_${provider}_send_jobs j WHERE (j.tenant,j.${column})=(c.tenant,c.${column}))
     ORDER BY p.expires_at,c.tenant,c.${column} LIMIT 16
    )`;
    const lease =
      provider === "qrz"
        ? `(SELECT 'inventory:qrz-delivery:'||a.book_identity FROM inventory_qrz_attempts a WHERE (a.tenant,a.attempt_id)=(c.tenant,c.attempt_id))`
        : "'inventory:lotw-delivery'";
    const [, wakeups] = await store.db.batch<{
      tenant: string;
      id: string;
      version: number;
      due_at: number;
    }>([
      store.statement(
        `${selected} INSERT INTO inventory_${provider}_send_jobs(tenant,${column},due_at)
         SELECT tenant,id,?4 FROM selected WHERE true ON CONFLICT(tenant,${column}) DO NOTHING`,
        ...managedBindings(auth),
        now,
      ),
      store.statement(
        `SELECT j.tenant,j.${column} AS id,j.version,j.due_at FROM inventory_${provider}_send_jobs j
         JOIN inventory_${provider}_send_candidates c USING(tenant,${column})
         WHERE j.due_at<c.expires_at AND j.turns<${MAX_TURNS} AND c.expires_at<=?3
         AND ${allowedManagedMembers(provider, "?1", "c")}
         AND (?2 IS NULL OR c.destination_connection IN(SELECT value FROM json_each(?2)))
         AND (j.published_version<j.version OR (j.due_at<=?4 AND j.published_at<=?5))
         AND NOT EXISTS(SELECT 1 FROM leases l WHERE l.tenant=j.tenant AND l.scope=${lease} AND l.expires_at>?4)
         ORDER BY j.due_at,j.tenant,j.${column} LIMIT 1`,
        ...managedBindings(auth),
        now,
        now - 60_000,
      ),
    ]);
    return this.publish(wakeups.results[0], now);
  }

  private async publish(
    job:
      | { tenant: string; id: string; version: number; due_at: number }
      | undefined,
    now: number,
  ) {
    if (!job) return 0;
    const { provider } = this;
    const { store } = this.dispatch;
    const column = `${itemKey(provider)}_id`;
    await this.env.INVENTORY_QUEUE.sendBatch([
      {
        body: {
          kind: `inventory-${provider}-send`,
          version: 1,
          tenant: job.tenant,
          [itemKey(provider)]: job.id,
          workVersion: job.version,
        },
        contentType: "json",
        delaySeconds: Math.max(0, Math.ceil((job.due_at - now) / 1000)),
      },
    ]);
    await store
      .statement(
        `UPDATE inventory_${provider}_send_jobs SET published_version=version,published_at=max(published_at,?)
         WHERE (tenant,${column},version)=(?,?,?)`,
        now,
        job.tenant,
        job.id,
        job.version,
      )
      .run();
    return 1;
  }

  private async advance(message: {
    tenant: string;
    id: string;
    workVersion: number;
  }) {
    const provider = this.provider;
    const managed = managedInventoryAuthorization(this.env, provider);
    if (managed) return this.advanceManaged(message, managed);
    const auth = authorization(this.env, provider);
    if (!auth || auth.tenant !== message.tenant) return "stale";
    const column = `${itemKey(provider)}_id`;
    const { store } = this.dispatch;
    const { tenant, id, workVersion } = message;
    const allowed =
      provider === "qrz"
        ? "c.record_key IN(SELECT value FROM json_each(?9))"
        : allowedLotwMembers("?9");
    const job = await store
      .statement(
        `UPDATE inventory_${provider}_send_jobs AS j
         SET version=version+1,turns=turns+1,due_at=?1
         WHERE (j.tenant,j.${column},j.version)=(?2,?3,?4)
         AND j.due_at<=unixepoch('subsec')*1000 AND j.turns<${MAX_TURNS}
         AND EXISTS(SELECT 1 FROM inventory_${provider}_send_candidates c
          WHERE (c.tenant,c.${column},c.source_scope,c.destination,c.destination_connection)=(?2,?3,?5,?6,?7)
          AND c.expires_at<=?8 AND ${allowed})
         RETURNING version,turns,${memberKeys[provider]} AS member_keys`,
        Date.now() + 90_000,
        tenant,
        id,
        workVersion,
        auth.sourceScope,
        auth.destinationScope,
        auth.destination,
        auth.expiresAt,
        canonical(auth.recordKeys),
      )
      .first<{ version: number; turns: number; member_keys: string }>();
    if (!job) return "stale";
    const keys: string[] = JSON.parse(job.member_keys);
    const result = await this.dispatch.send(tenant, id, () => {
      const current = authorization(this.env, provider);
      return current?.tenant === tenant &&
        current.sourceScope === auth.sourceScope &&
        current.destinationScope === auth.destinationScope &&
        current.destination === auth.destination &&
        current.expiresAt === auth.expiresAt &&
        keys.length > 0 &&
        keys.every((key) => current.recordKeys.includes(key))
        ? current.gates
        : { ...auth.gates, exportsEnabled: false };
    });
    return this.finishTurn(tenant, id, job, result);
  }

  private async advanceManaged(
    {
      tenant,
      id,
      workVersion,
    }: { tenant: string; id: string; workVersion: number },
    auth: ManagedAuthorization,
  ) {
    const { provider } = this;
    const { store } = this.dispatch;
    const column = `${itemKey(provider)}_id`;
    const job = await store
      .statement(
        `UPDATE inventory_${provider}_send_jobs AS j SET version=version+1,turns=turns+1,due_at=?1
       WHERE (j.tenant,j.${column},j.version)=(?2,?3,?4)
       AND j.due_at<=unixepoch('subsec')*1000 AND j.turns<${MAX_TURNS}
       AND EXISTS(SELECT 1 FROM inventory_${provider}_send_candidates c
        WHERE (c.tenant,c.${column})=(?2,?3) AND c.expires_at<=?7
        AND ${allowedManagedMembers(provider, "?5", "c")}
        AND (?6 IS NULL OR c.destination_connection IN(SELECT value FROM json_each(?6))))
       RETURNING version,turns,${memberKeys[provider]} AS member_keys,
       (SELECT c.destination_connection FROM inventory_${provider}_send_candidates c WHERE (c.tenant,c.${column})=(?2,?3)) AS destination`,
        Date.now() + 90_000,
        tenant,
        id,
        workVersion,
        ...managedBindings(auth),
      )
      .first<{
        version: number;
        turns: number;
        member_keys: string;
        destination: string;
      }>();
    if (!job) return "stale";
    const keys: string[] = JSON.parse(job.member_keys);
    const result = await this.dispatch.send(tenant, id, () => {
      const current = managedInventoryAuthorization(this.env, provider);
      return current?.expiresAt === auth.expiresAt &&
        (current.destinations === null ||
          current.destinations.includes(job.destination)) &&
        keys.length > 0 &&
        (current.keys === null ||
          keys.every((key) => current.keys?.includes(key)))
        ? current.gates
        : { ...auth.gates, exportsEnabled: false };
    });
    return this.finishTurn(tenant, id, job, result);
  }

  private async finishTurn(
    tenant: string,
    id: string,
    job: { version: number; turns: number },
    result: Awaited<ReturnType<Dispatch["send"]>>,
  ) {
    const { provider } = this;
    const { store } = this.dispatch;
    const column = `${itemKey(provider)}_id`;
    // A possible send retires this job and creates readback work atomically.
    if (result.kind !== "deferred" && result.kind !== "held")
      return result.kind;
    let retryAt: number | null = null;
    if (job.turns < MAX_TURNS) {
      if (result.kind === "deferred")
        retryAt = Math.max(Date.now() + 1000, result.retryAt);
      else if (
        result.reason === "attempt_or_book_unavailable" ||
        result.reason === "lotw_delivery_busy"
      )
        retryAt = Date.now() + 5000;
    }
    const reason = result.kind === "held" ? result.reason : "send_turn_limit";
    await store
      .statement(
        `UPDATE inventory_${provider}_send_jobs SET version=version+1,due_at=?,hold_reason=?
         WHERE (tenant,${column},version)=(?,?,?)`,
        retryAt,
        retryAt === null ? reason : null,
        tenant,
        id,
        job.version,
      )
      .run();
    return result.kind;
  }

  async consume(messages: readonly Message<unknown>[]) {
    const report = {
      processed: 0,
      acknowledged: 0,
      retried: 0,
      invalid: 0,
      failed: 0,
      queued: 0,
      outcome: null as string | null,
    };
    for (const message of messages) {
      const wakeup = sendWakeup(this.provider, message.body);
      if (!wakeup) {
        message.ack();
        report.acknowledged++;
        report.invalid++;
        continue;
      }
      if (report.processed >= 1) {
        message.retry({ delaySeconds: 1 });
        report.retried++;
        continue;
      }
      report.processed++;
      try {
        report.outcome = await this.advance(wakeup);
        // Re-publication also repairs a lost acknowledgement for a prior turn.
        report.queued += await this.schedule();
        message.ack();
        report.acknowledged++;
      } catch {
        message.retry({ delaySeconds: 5 });
        report.retried++;
        report.failed++;
      }
    }
    return report;
  }
}
