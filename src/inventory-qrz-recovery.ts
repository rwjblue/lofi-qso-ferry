import { InventoryQrzDispatch } from "./inventory-qrz-dispatch.ts";
import { inventoryQrzBookLeaseScope } from "./inventory-qrz-neighborhood.ts";
import { canonical } from "./security.ts";
import type { Store } from "./store.ts";

interface RecoveryWakeup {
  kind: "inventory-qrz-recovery";
  version: 1;
  tenant: string;
  attempt: string;
  workVersion: number;
}
type RecoveryQueue = Pick<Queue<RecoveryWakeup>, "sendBatch">;
// Six bounded readback turns. A parked claim still owns its identity.
const RETRY_DELAYS = [
  300_000,
  900_000,
  3_600_000,
  14_400_000,
  86_400_000,
  null,
];
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

export function isQrzRecoveryWakeup(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      "kind" in value &&
      value.kind === "inventory-qrz-recovery",
  );
}

function wakeup(value: unknown) {
  if (!isQrzRecoveryWakeup(value)) return null;
  const message = value as RecoveryWakeup;
  return message.version === 1 &&
    identifier(message.tenant) &&
    identifier(message.attempt) &&
    Number.isSafeInteger(message.workVersion) &&
    message.workVersion > 0
    ? message
    : null;
}

export async function publishQrzRecoveryWakeups(
  store: Store,
  queue: RecoveryQueue,
) {
  const now = Date.now();
  const rows = (
    await store
      .statement(
        `SELECT j.tenant,j.attempt_id,j.version FROM inventory_qrz_recovery_available j
         WHERE j.due_at<=?1 AND (j.published_version<j.version OR j.published_at<=?2)
         AND NOT EXISTS(SELECT 1 FROM leases l WHERE l.tenant=j.tenant AND l.scope='inventory:qrz-delivery:'||j.book_identity AND l.expires_at>?1)
         ORDER BY j.due_at,j.tenant,j.attempt_id LIMIT 16`,
        now,
        now - 60_000,
      )
      .all<{ tenant: string; attempt_id: string; version: number }>()
  ).results;
  if (!rows.length) return 0;
  await queue.sendBatch(
    rows.map((row) => ({
      body: {
        kind: "inventory-qrz-recovery",
        version: 1,
        tenant: row.tenant,
        attempt: row.attempt_id,
        workVersion: row.version,
      },
      contentType: "json",
    })),
  );
  await store
    .statement(
      `UPDATE inventory_qrz_recovery_jobs AS j SET published_version=version,published_at=max(published_at,?2)
       WHERE j.rowid IN(SELECT w.rowid FROM json_each(?1) x CROSS JOIN inventory_qrz_recovery_jobs w
        WHERE (w.tenant,w.attempt_id,w.version)=(json_extract(x.value,'$.tenant'),json_extract(x.value,'$.attempt_id'),json_extract(x.value,'$.version')))`,
      canonical(rows),
      now,
    )
    .run();
  return rows.length;
}

async function recover(
  dispatch: InventoryQrzDispatch,
  message: RecoveryWakeup,
) {
  const { store } = dispatch;
  const { tenant, attempt, workVersion } = message;
  const job = await store
    .statement(
      "SELECT book_identity,due_at,turns FROM inventory_qrz_recovery_available WHERE tenant=? AND attempt_id=? AND version=?",
      tenant,
      attempt,
      workVersion,
    )
    .first<{ book_identity: string; due_at: number; turns: number }>();
  if (!job) return "stale";
  if (job.due_at > Date.now()) return "stale"; // Cron owns future delivery.
  const lease = await store.claim(
    tenant,
    inventoryQrzBookLeaseScope(job.book_identity),
    Date.now(),
    90_000,
  );
  if (!lease) return "busy";
  try {
    const delay = RETRY_DELAYS[job.turns];
    const saved = await store
      .statement(
        `UPDATE inventory_qrz_recovery_jobs AS j SET version=version+1,turns=turns+1,due_at=?1
         WHERE (tenant,attempt_id,version)=(?2,?3,?4) AND due_at<=unixepoch('subsec')*1000
         AND EXISTS(SELECT 1 FROM inventory_qrz_recovery_available a WHERE a.tenant=j.tenant AND a.attempt_id=j.attempt_id AND a.book_identity=?5)
         AND EXISTS(SELECT 1 FROM leases l WHERE l.tenant=j.tenant AND l.scope=?6 AND l.token=?7 AND l.fence=?8 AND l.expires_at>unixepoch('subsec')*1000)
         RETURNING version`,
        delay === null ? null : Date.now() + delay,
        tenant,
        attempt,
        workVersion,
        job.book_identity,
        lease.scope,
        lease.token,
        lease.fence,
      )
      .first<{ version: number }>();
    if (!saved) return "stale";
    // Charge the turn before HTTP. A crash or a duplicate cannot bypass the cap.
    const result = await dispatch.reconcileLeased(attempt, lease);
    if (result.kind === "deferred" && delay !== null)
      await store
        .statement(
          "UPDATE inventory_qrz_recovery_jobs SET due_at=max(due_at,?) WHERE tenant=? AND attempt_id=? AND version=? AND due_at IS NOT NULL",
          result.retryAt,
          tenant,
          attempt,
          saved.version,
        )
        .run();
    return "advanced";
  } finally {
    await store.release(lease);
  }
}

export async function consumeQrzRecoveryWakeups(
  dispatch: InventoryQrzDispatch,
  messages: readonly Message<unknown>[],
) {
  const report = {
    processed: 0,
    acknowledged: 0,
    retried: 0,
    invalid: 0,
    failed: 0,
  };
  for (const message of messages) {
    const job = wakeup(message.body);
    if (!job) {
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
      if ((await recover(dispatch, job)) === "busy") {
        message.retry({ delaySeconds: 5 });
        report.retried++;
        continue;
      }
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
