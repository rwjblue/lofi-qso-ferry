import type { InventoryQrzDispatch } from "./inventory-qrz-dispatch.ts";
import {
  configuredInventoryShadow,
  type InventoryShadowEnvironment,
} from "./inventory-preparation-shadow.ts";
import { canonical } from "./security.ts";
import { deliveryGates, routeDeliveryMode } from "./service.ts";

export type InventoryDeliveryEnvironment = InventoryShadowEnvironment & {
  QRZ_FRESH_INSERT_EXPIRES_AT?: string;
};

function authorization(env: InventoryDeliveryEnvironment) {
  if (env.INVENTORY_RUNTIME_MODE !== "selected_qrz") return null;
  const shadow = configuredInventoryShadow(env, "qrz");
  if (shadow.kind !== "configured") return null;
  let gates: ReturnType<typeof deliveryGates>;
  try {
    gates = deliveryGates(env);
  } catch {
    return null;
  }
  const destination = gates.allowedDestinationIds?.[0];
  const expiresAt = gates.qrzFreshInsertExpiresAt;
  if (!destination || !expiresAt || !gates.allowedQsoIds?.length) return null;
  const recordKeys = shadow.selection.recordKeys.filter(
    (key) =>
      routeDeliveryMode(gates, key, { id: destination, kind: "qrz" }) ===
      "qrz_fresh_insert",
  );
  if (!recordKeys.length) return null;
  return { ...shadow.selection, recordKeys, destination, expiresAt, gates };
}

interface SendWakeup {
  kind: "inventory-qrz-send";
  version: 1;
  tenant: string;
  attempt: string;
  workVersion: number;
}
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

export function isQrzSendWakeup(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      "kind" in value &&
      value.kind === "inventory-qrz-send",
  );
}

function sendWakeup(value: unknown) {
  if (!isQrzSendWakeup(value)) return null;
  const message = value as SendWakeup;
  return message.version === 1 &&
    identifier(message.tenant) &&
    identifier(message.attempt) &&
    Number.isSafeInteger(message.workVersion) &&
    message.workVersion > 0
    ? message
    : null;
}

const selected = `WITH selected AS MATERIALIZED(
 SELECT c.tenant,c.attempt_id,c.expires_at,a.book_identity
 FROM json_each(?1) k CROSS JOIN inventory_scopes s CROSS JOIN inventory_scopes d
 CROSS JOIN inventory_qrz_attempts a INDEXED BY inventory_qrz_active_source
 CROSS JOIN inventory_qrz_send_candidates c
 WHERE s.tenant=?2 AND s.scope_id=?3 AND d.tenant=?2 AND d.scope_id=?4
 AND (a.tenant,a.book_identity,a.source_identity,a.record_key)=(?2,d.logical_identity,s.logical_identity,k.value)
 AND a.cancelled_at IS NULL AND (c.tenant,c.attempt_id)=(?2,a.attempt_id)
 AND (c.source_scope,c.destination,c.destination_connection)=(?3,?4,?5) AND c.expires_at<=?6
)`;

const MAX_TURNS = 3;

/** A scoped outbox for current prepared artifacts. A Queue delivery only
 * debits a pre-claim turn. Dispatch still owns the sole may-send boundary. */
export class InventoryQrzSendQueue {
  constructor(
    readonly env: InventoryDeliveryEnvironment,
    readonly dispatch: InventoryQrzDispatch,
  ) {}

  async schedule() {
    const auth = authorization(this.env);
    if (!auth) return 0;
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
      attempt_id: string;
      version: number;
      due_at: number;
    }>([
      store.statement(
        `${selected}
         INSERT INTO inventory_qrz_send_jobs(tenant,attempt_id,due_at)
         SELECT tenant,attempt_id,?7 FROM selected WHERE true
         ON CONFLICT(tenant,attempt_id) DO NOTHING`,
        ...args,
        now,
      ),
      store.statement(
        `${selected}
         SELECT j.tenant,j.attempt_id,j.version,j.due_at FROM selected s
         JOIN inventory_qrz_send_jobs j USING(tenant,attempt_id)
         WHERE j.due_at<s.expires_at AND j.turns<${MAX_TURNS}
         AND (j.published_version<j.version OR (j.due_at<=?7 AND j.published_at<=?8))
         AND NOT EXISTS(SELECT 1 FROM leases l WHERE l.tenant=j.tenant AND l.scope='inventory:qrz-delivery:'||s.book_identity AND l.expires_at>?7)
         ORDER BY j.due_at,j.attempt_id LIMIT 1`,
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
          kind: "inventory-qrz-send",
          version: 1,
          tenant: job.tenant,
          attempt: job.attempt_id,
          workVersion: job.version,
        } satisfies SendWakeup,
        contentType: "json",
        delaySeconds: Math.max(0, Math.ceil((job.due_at - now) / 1000)),
      },
    ]);
    await store
      .statement(
        `UPDATE inventory_qrz_send_jobs SET published_version=version,published_at=max(published_at,?)
         WHERE (tenant,attempt_id,version)=(?,?,?)`,
        now,
        job.tenant,
        job.attempt_id,
        job.version,
      )
      .run();
    return 1;
  }

  private async advance(message: SendWakeup) {
    const auth = authorization(this.env);
    if (!auth || auth.tenant !== message.tenant) return "stale";
    const { store } = this.dispatch;
    const { tenant, attempt, workVersion } = message;
    const job = await store
      .statement(
        `UPDATE inventory_qrz_send_jobs AS j
         SET version=version+1,turns=turns+1,due_at=?1
         WHERE (j.tenant,j.attempt_id,j.version)=(?2,?3,?4)
         AND j.due_at<=unixepoch('subsec')*1000 AND j.turns<${MAX_TURNS}
         AND EXISTS(SELECT 1 FROM inventory_qrz_send_candidates c
          WHERE (c.tenant,c.attempt_id,c.source_scope,c.destination,c.destination_connection)=(?2,?3,?5,?6,?7)
          AND c.expires_at<=?8 AND c.record_key IN(SELECT value FROM json_each(?9)))
         RETURNING version,turns,(SELECT a.record_key FROM inventory_qrz_attempts a WHERE a.tenant=?2 AND a.attempt_id=?3) AS record_key`,
        Date.now() + 90_000,
        tenant,
        attempt,
        workVersion,
        auth.sourceScope,
        auth.destinationScope,
        auth.destination,
        auth.expiresAt,
        canonical(auth.recordKeys),
      )
      .first<{ version: number; turns: number; record_key: string }>();
    if (!job) return "stale";
    const result = await this.dispatch.send(tenant, attempt, () => {
      const current = authorization(this.env);
      return current?.tenant === tenant &&
        current.sourceScope === auth.sourceScope &&
        current.destinationScope === auth.destinationScope &&
        current.destination === auth.destination &&
        current.expiresAt === auth.expiresAt &&
        current.recordKeys.includes(job.record_key)
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
      else if (result.reason === "attempt_or_book_unavailable")
        retryAt = Date.now() + 5000;
    }
    const reason = result.kind === "held" ? result.reason : "send_turn_limit";
    await store
      .statement(
        `UPDATE inventory_qrz_send_jobs SET version=version+1,due_at=?,hold_reason=?
         WHERE (tenant,attempt_id,version)=(?,?,?)`,
        retryAt,
        retryAt === null ? reason : null,
        tenant,
        attempt,
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
      const wakeup = sendWakeup(message.body);
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
