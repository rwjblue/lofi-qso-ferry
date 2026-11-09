import { pollInventoryLotwConfirmations } from "./inventory-lotw-confirmations.ts";
import { lotwRecurringDueAt } from "./inventory-lotw-schedule.ts";
import { type LotwConfirmationQuery, LotwLoginError } from "./lotw.ts";
import type { Store } from "./store.ts";
import {
  VENDOR_POLICIES,
  VendorDeferredError,
  vendorRequestsAvailable,
} from "./vendor-requests.ts";

const WEEK = 7 * 86_400_000;
const HOUR = 3_600_000;
const SLOT = VENDOR_POLICIES.lotw.windowMs;
const ENROLL_LIMIT = 16;

interface ScheduledConfirmation {
  tenant: string;
  scope_id: string;
  receipt_stream_id: string;
  scope_version: number;
  initial_confirmed_since: string;
  version: number;
  plan: string;
  credential_version: string;
}

/** The optional QSL roster consumes at most one LoTW background turn per window. */
export async function runLotwConfirmationSchedule(
  store: Store,
  fetcher: typeof fetch = fetch,
) {
  const now = Date.now();
  const enrolled = await store
    .statement(
      `INSERT INTO inventory_lotw_confirmation_schedule(tenant,scope_id,receipt_stream_id,scope_version,initial_confirmed_since,next_due_at)
       SELECT t.tenant,t.scope_id,t.receipt_stream_id,t.scope_version,
              strftime('%Y-%m-%d %H:%M:%S',max(t.created_at-?1,0)/1000,'unixepoch'),?2
       FROM inventory_lotw_confirmation_targets t
       WHERE NOT EXISTS(SELECT 1 FROM inventory_lotw_confirmation_schedule q
         WHERE (q.tenant,q.scope_id,q.receipt_stream_id,q.scope_version)=(t.tenant,t.scope_id,t.receipt_stream_id,t.scope_version))
       ORDER BY t.tenant,t.scope_id,t.receipt_stream_id LIMIT ?3
       ON CONFLICT(tenant,scope_id,receipt_stream_id,scope_version) DO NOTHING`,
      HOUR,
      now,
      ENROLL_LIMIT,
    )
    .run();
  const result = {
    registered: enrolled.meta.changes,
    polled: 0,
    added: 0,
    deferred: 0,
    held: 0,
    failed: 0,
  };
  const job = await store
    .statement(
      `SELECT q.*,t.plan,t.credential_version FROM inventory_lotw_confirmation_schedule q
       JOIN inventory_lotw_confirmation_targets t USING(tenant,scope_id,receipt_stream_id,scope_version)
       WHERE q.overflow=0 AND q.next_due_at<=?
       ORDER BY q.next_due_at,q.tenant,q.scope_id,q.receipt_stream_id,q.scope_version LIMIT 1`,
      now,
    )
    .first<ScheduledConfirmation>();
  if (!job) return result;
  if (!(await vendorRequestsAvailable(store, "lotw", "background", now))) {
    result.deferred = 1;
    return result;
  }
  const slot = Math.floor(now / SLOT);
  const owned = await store
    .statement(
      "UPDATE inventory_lotw_confirmation_slot SET last_slot=?1 WHERE id=1 AND last_slot<?1",
      slot,
    )
    .run();
  if (!owned.meta.changes) return result;

  const key = [
    job.tenant,
    job.scope_id,
    job.receipt_stream_id,
    job.scope_version,
  ] as const;
  const claimed = await store
    .statement(
      `UPDATE inventory_lotw_confirmation_schedule AS q SET version=version+1,next_due_at=?1
       WHERE (q.tenant,q.scope_id,q.receipt_stream_id,q.scope_version,q.version)=(?2,?3,?4,?5,?6)
         AND EXISTS(SELECT 1 FROM inventory_lotw_confirmation_targets t
           WHERE (t.tenant,t.scope_id,t.receipt_stream_id,t.scope_version)=(?2,?3,?4,?5) AND t.credential_version=?7)`,
      now + SLOT,
      ...key,
      job.version,
      job.credential_version,
    )
    .run();
  if (!claimed.meta.changes) return result;
  let nextDue = now + SLOT;
  let rejectedCredential: string | null = null;
  let overflow = 0;
  try {
    const { selection } = JSON.parse(job.plan) as {
      selection: Omit<LotwConfirmationQuery, "confirmedSince">;
    };
    const poll = await pollInventoryLotwConfirmations(
      store,
      {
        tenant: job.tenant,
        scope: job.scope_id,
        selection: {
          ...selection,
          confirmedSince: job.initial_confirmed_since,
        },
        expected: {
          scopeVersion: job.scope_version,
          credentialVersion: job.credential_version,
        },
      },
      fetcher,
    );
    if (poll.state === "busy") {
      result.deferred = 1;
    } else {
      result.polled = 1;
      result.added = poll.added;
      nextDue = await lotwRecurringDueAt(
        Date.now(),
        [job.tenant, job.scope_id, poll.streamId],
        WEEK,
      );
    }
  } catch (error) {
    if (error instanceof VendorDeferredError) {
      result.deferred = 1;
      nextDue = Math.max(nextDue, error.retryAt);
    } else if (
      error instanceof LotwLoginError &&
      error.reason === "credentials"
    ) {
      result.held = 1;
      rejectedCredential = job.credential_version;
    } else if (
      error instanceof Error &&
      (error.message === "Too many ADIF records" ||
        error.message ===
          "Vendor response exceeds bounded partition; split the date range")
    ) {
      result.held = 1;
      overflow = 1;
    } else {
      result.failed = 1;
      nextDue = Date.now() + HOUR;
    }
  }
  await store
    .statement(
      `UPDATE inventory_lotw_confirmation_schedule SET next_due_at=?,rejected_credential_version=?,overflow=?
       WHERE (tenant,scope_id,receipt_stream_id,scope_version,version)=(?,?,?,?,?)`,
      nextDue,
      rejectedCredential,
      overflow,
      ...key,
      job.version + 1,
    )
    .run();
  return result;
}
