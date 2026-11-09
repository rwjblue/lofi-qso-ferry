import type { InventorySourceProofJobs } from "./inventory-source-proof-jobs.ts";
import { canonical } from "./security.ts";

interface ProofWakeup {
  kind: "inventory-source-proof";
  version: 1;
  tenant: string;
  scope: string;
  id: string;
  workVersion: number;
}
type ProofQueue = Pick<Queue<ProofWakeup>, "sendBatch">;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

export function isSourceProofWakeup(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      "kind" in value &&
      value.kind === "inventory-source-proof",
  );
}

function proofWakeup(value: unknown) {
  if (!isSourceProofWakeup(value))
    throw new Error("invalid_inventory_source_proof_wakeup");
  const message = value as ProofWakeup;
  if (
    message.version !== 1 ||
    ![message.tenant, message.scope, message.id].every(identifier) ||
    !Number.isSafeInteger(message.workVersion) ||
    message.workVersion < 1
  )
    throw new Error("invalid_inventory_source_proof_wakeup");
  return message;
}

export async function publishSourceProofWakeups(
  jobs: InventorySourceProofJobs,
  queue: ProofQueue,
) {
  const store = jobs.runs.inventory.store;
  const now = Date.now();
  const rows = (
    await store
      .statement(
        `SELECT tenant,scope_id,job_id,version,due_at FROM inventory_source_proof_jobs
         WHERE phase IN('collecting','draining')
           AND (published_version<version OR (published_at<=? AND due_at<=?))
         ORDER BY due_at,tenant,scope_id LIMIT 16`,
        now - 60_000,
        now,
      )
      .all<{
        tenant: string;
        scope_id: string;
        job_id: string;
        version: number;
        due_at: number;
      }>()
  ).results;
  if (!rows.length) return 0;
  await queue.sendBatch(
    rows.map((row) => ({
      body: {
        kind: "inventory-source-proof",
        version: 1,
        tenant: row.tenant,
        scope: row.scope_id,
        id: row.job_id,
        workVersion: row.version,
      },
      contentType: "json",
      delaySeconds: Math.max(0, Math.ceil((row.due_at - now) / 1000)),
    })),
  );
  await store
    .statement(
      `UPDATE inventory_source_proof_jobs AS j SET published_version=version,published_at=max(published_at,?2)
       WHERE j.rowid IN(SELECT w.rowid FROM json_each(?1) x CROSS JOIN inventory_source_proof_jobs w
        WHERE (w.tenant,w.scope_id,w.job_id,w.version)=(json_extract(x.value,'$.tenant'),json_extract(x.value,'$.scope_id'),json_extract(x.value,'$.job_id'),json_extract(x.value,'$.version'))
        AND w.phase IN('collecting','draining'))`,
      canonical(rows),
      now,
    )
    .run();
  return rows.length;
}

export async function consumeSourceProofWakeups(
  jobs: InventorySourceProofJobs,
  messages: readonly Message<unknown>[],
  afterProgress: () => Promise<void>,
) {
  const report = {
    processed: 0,
    acknowledged: 0,
    retried: 0,
    invalid: 0,
    failed: 0,
  };
  for (const message of messages) {
    let wakeup: ProofWakeup;
    try {
      wakeup = proofWakeup(message.body);
    } catch {
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
      const result = await jobs.step(
        wakeup.tenant,
        wakeup.scope,
        wakeup.id,
        wakeup.workVersion,
      );
      if (result.kind === "busy" || result.kind === "not_due") {
        const seconds =
          result.kind === "busy"
            ? 5
            : Math.ceil((result.retryAt - Date.now()) / 1000);
        message.retry({ delaySeconds: Math.max(1, seconds) });
        report.retried++;
        continue;
      }
      await afterProgress();
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
