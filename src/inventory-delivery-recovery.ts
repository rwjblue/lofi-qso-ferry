import { canonical } from "./security.ts";
import type { Lease, Store } from "./store.ts";

type Provider = "qrz" | "lotw";
type RecoveryQueue = Pick<Queue<unknown>, "sendBatch">;
type Readback = {
  store: Store;
  reconcileLeased(
    id: string,
    lease: Lease,
  ): Promise<{ kind: string; retryAt?: number }>;
};
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

export function isInventoryRecoveryWakeup(
  provider: Provider,
  value: unknown,
): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      "kind" in value &&
      value.kind === `inventory-${provider}-recovery`,
  );
}

const itemKey = (provider: Provider) =>
  provider === "qrz" ? "attempt" : "batch";
const leaseSql = (provider: Provider, alias: "a" | "j") =>
  provider === "qrz"
    ? `'inventory:qrz-delivery:'||${alias}.book_identity`
    : "'inventory:lotw-delivery'";

function wakeup(provider: Provider, value: unknown) {
  if (!isInventoryRecoveryWakeup(provider, value)) return null;
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

export async function publishInventoryRecoveryWakeups(
  store: Store,
  provider: Provider,
  queue: RecoveryQueue,
) {
  const column = `${itemKey(provider)}_id`;
  const now = Date.now();
  const rows = (
    await store
      .statement(
        `SELECT j.tenant,j.${column} AS id,j.version FROM inventory_${provider}_recovery_available j
         WHERE j.due_at<=?1 AND (j.published_version<j.version OR j.published_at<=?2)
         AND NOT EXISTS(SELECT 1 FROM leases l WHERE l.tenant=j.tenant AND l.scope=${leaseSql(provider, "j")} AND l.expires_at>?1)
         ORDER BY j.due_at,j.tenant,j.${column} LIMIT 16`,
        now,
        now - 60_000,
      )
      .all<{ tenant: string; id: string; version: number }>()
  ).results;
  if (!rows.length) return 0;
  await queue.sendBatch(
    rows.map((row) => ({
      body: {
        kind: `inventory-${provider}-recovery`,
        version: 1,
        tenant: row.tenant,
        [itemKey(provider)]: row.id,
        workVersion: row.version,
      },
      contentType: "json",
    })),
  );
  await store
    .statement(
      `UPDATE inventory_${provider}_recovery_jobs AS j SET published_version=version,published_at=max(published_at,?2)
       WHERE j.rowid IN(SELECT w.rowid FROM json_each(?1) x CROSS JOIN inventory_${provider}_recovery_jobs w
        WHERE (w.tenant,w.${column},w.version)=(json_extract(x.value,'$.tenant'),json_extract(x.value,'$.id'),json_extract(x.value,'$.version')))`,
      canonical(rows),
      now,
    )
    .run();
  return rows.length;
}

async function recover(
  readback: Readback,
  provider: Provider,
  message: { tenant: string; id: string; workVersion: number },
) {
  const { store } = readback;
  const { tenant, id, workVersion } = message;
  const column = `${itemKey(provider)}_id`;
  const job = await store
    .statement(
      `SELECT ${leaseSql(provider, "j")} AS scope,j.due_at,j.turns FROM inventory_${provider}_recovery_available j WHERE j.tenant=? AND j.${column}=? AND j.version=?`,
      tenant,
      id,
      workVersion,
    )
    .first<{ scope: string; due_at: number; turns: number }>();
  if (!job) return "stale";
  if (job.due_at > Date.now()) return "stale"; // Cron owns future delivery.
  const lease = await store.claim(tenant, job.scope, Date.now(), 90_000);
  if (!lease) return "busy";
  try {
    const delay = RETRY_DELAYS[job.turns];
    const saved = await store
      .statement(
        `UPDATE inventory_${provider}_recovery_jobs AS j SET version=version+1,turns=turns+1,due_at=?1
         WHERE (tenant,${column},version)=(?2,?3,?4) AND due_at<=unixepoch('subsec')*1000
         AND EXISTS(SELECT 1 FROM inventory_${provider}_recovery_available a WHERE a.tenant=j.tenant AND a.${column}=j.${column} AND ${leaseSql(provider, "a")}=?5)
         AND EXISTS(SELECT 1 FROM leases l WHERE l.tenant=j.tenant AND l.scope=?5 AND l.token=?6 AND l.fence=?7 AND l.expires_at>unixepoch('subsec')*1000)
         RETURNING version`,
        delay === null ? null : Date.now() + delay,
        tenant,
        id,
        workVersion,
        lease.scope,
        lease.token,
        lease.fence,
      )
      .first<{ version: number }>();
    if (!saved) return "stale";
    // Charge the turn before HTTP. A crash or a duplicate cannot bypass the cap.
    const result = await readback.reconcileLeased(id, lease);
    if (
      result.kind === "deferred" &&
      result.retryAt !== undefined &&
      delay !== null
    )
      await store
        .statement(
          `UPDATE inventory_${provider}_recovery_jobs SET due_at=max(due_at,?) WHERE tenant=? AND ${column}=? AND version=? AND due_at IS NOT NULL`,
          result.retryAt,
          tenant,
          id,
          saved.version,
        )
        .run();
    return "advanced";
  } finally {
    await store.release(lease);
  }
}

export async function consumeInventoryRecoveryWakeups(
  readback: Readback,
  provider: Provider,
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
    const job = wakeup(provider, message.body);
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
      if ((await recover(readback, provider, job)) === "busy") {
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
