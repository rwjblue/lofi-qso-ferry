import {
  configuredInventoryShadow,
  type InventoryShadowEnvironment,
} from "./inventory-preparation-shadow.ts";
import { canonical } from "./security.ts";
import {
  deliveryGates,
  routeDeliveryMode,
  type ScheduledDeliveryGates,
} from "./service.ts";
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

export type InventoryDeliveryEnvironment = InventoryShadowEnvironment & {
  QRZ_FRESH_INSERT_EXPIRES_AT?: string;
  LOTW_FRESH_INSERT_EXPIRES_AT?: string;
};

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

const allowedLotwMembers = (keys: string) => `NOT EXISTS(
 SELECT 1 FROM inventory_lotw_batch_members m WHERE (m.tenant,m.batch_id)=(c.tenant,c.batch_id)
 AND m.record_key NOT IN(SELECT value FROM json_each(${keys})))`;

const selections: Record<Provider, string> = {
  qrz: `WITH selected AS MATERIALIZED(
 SELECT c.tenant,c.attempt_id AS id,c.expires_at,'inventory:qrz-delivery:'||a.book_identity AS lease_scope
 FROM json_each(?1) k CROSS JOIN inventory_scopes s CROSS JOIN inventory_scopes d
 CROSS JOIN inventory_qrz_attempts a INDEXED BY inventory_qrz_active_source
 CROSS JOIN inventory_qrz_send_candidates c
 WHERE s.tenant=?2 AND s.scope_id=?3 AND d.tenant=?2 AND d.scope_id=?4
 AND (a.tenant,a.book_identity,a.source_identity,a.record_key)=(?2,d.logical_identity,s.logical_identity,k.value)
 AND a.cancelled_at IS NULL AND (c.tenant,c.attempt_id)=(?2,a.attempt_id)
 AND (c.source_scope,c.destination,c.destination_connection)=(?3,?4,?5) AND c.expires_at<=?6
)`,
  lotw: `WITH possible AS MATERIALIZED(
 SELECT DISTINCT m.batch_id FROM json_each(?1) k CROSS JOIN inventory_scopes s
 CROSS JOIN inventory_lotw_batch_members m INDEXED BY inventory_lotw_active_source
 WHERE (s.tenant,s.scope_id)=(?2,?3) AND (m.tenant,m.source_identity,m.record_key)=(?2,s.logical_identity,k.value)
 AND m.cancelled_at IS NULL
), selected AS MATERIALIZED(
 SELECT c.tenant,c.batch_id AS id,c.expires_at,'inventory:lotw-delivery' AS lease_scope
 FROM possible b CROSS JOIN inventory_lotw_send_candidates c
 WHERE (c.tenant,c.batch_id,c.source_scope,c.destination,c.destination_connection)=(?2,b.batch_id,?3,?4,?5)
 AND c.expires_at<=?6 AND ${allowedLotwMembers("?1")}
)`,
};
const memberKeys: Record<Provider, string> = {
  qrz: "(SELECT json_array(a.record_key) FROM inventory_qrz_attempts a WHERE (a.tenant,a.attempt_id)=(?2,?3))",
  lotw: "(SELECT json_group_array(m.record_key) FROM inventory_lotw_batch_members m WHERE (m.tenant,m.batch_id)=(?2,?3))",
};

const MAX_TURNS = 3;

/** A scoped outbox for current prepared artifacts. A Queue delivery only
 * debits a pre-claim turn. Dispatch still owns the sole may-send boundary. */
export class InventorySendQueue {
  constructor(
    readonly env: InventoryDeliveryEnvironment,
    readonly provider: Provider,
    readonly dispatch: Dispatch,
  ) {}

  async schedule() {
    const provider = this.provider;
    const auth = authorization(this.env, provider);
    if (!auth) return 0;
    const column = `${itemKey(provider)}_id`;
    const selected = selections[provider];
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
    const [job] = wakeups.results;
    if (!job) return 0;
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
