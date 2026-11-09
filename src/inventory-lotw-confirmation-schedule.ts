import {
  pollInventoryLotwConfirmations,
  savedLotwConfirmationLower,
} from "./inventory-lotw-confirmations.ts";
import { lotwRecurringDueAt } from "./inventory-lotw-schedule.ts";
import {
  type LotwConfirmationQuery,
  LotwLoginError,
  splitLotwQuery,
} from "./lotw.ts";
import { canonical } from "./security.ts";
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
const SPLIT_LIMIT = 4;

interface ScheduledConfirmation {
  tenant: string;
  scope_id: string;
  receipt_stream_id: string;
  scope_version: number;
  branch: string;
  start_date: string | null;
  end_date: string | null;
  initial_confirmed_since: string;
  version: number;
  plan: string;
  credential_version: string;
}

const scheduleRows = `SELECT q.*,t.plan,t.credential_version FROM inventory_lotw_confirmation_schedule q
 JOIN inventory_lotw_confirmation_targets t USING(tenant,scope_id,receipt_stream_id,scope_version)`;
const scheduleOrder = `ORDER BY q.next_due_at,q.tenant,q.scope_id,q.receipt_stream_id,q.scope_version,q.branch`;
const currentJob = `(q.tenant,q.scope_id,q.receipt_stream_id,q.scope_version,q.branch,q.version)=(?1,?2,?3,?4,?5,?6)`;
const activeJob = `${currentJob} AND EXISTS(SELECT 1 FROM inventory_lotw_confirmation_targets t
 WHERE (t.tenant,t.scope_id,t.receipt_stream_id,t.scope_version)=(?1,?2,?3,?4) AND t.credential_version=?7)`;

function jobKey(job: ScheduledConfirmation) {
  return [
    job.tenant,
    job.scope_id,
    job.receipt_stream_id,
    job.scope_version,
    job.branch,
  ] as const;
}

function jobSelection(job: ScheduledConfirmation): LotwConfirmationQuery {
  const { selection } = JSON.parse(job.plan) as {
    selection: Omit<LotwConfirmationQuery, "confirmedSince">;
  };
  return {
    ...selection,
    startDate: job.start_date ?? selection.startDate,
    endDate: job.end_date ?? selection.endDate,
    confirmedSince: job.initial_confirmed_since,
  };
}

/** Both child ranges and the parent's retirement commit together. */
async function splitHeldConfirmations(store: Store, now: number) {
  const held = await store
    .statement(
      `${scheduleRows} WHERE q.overflow=1 AND q.split_at IS NULL AND q.next_due_at<=?
       AND coalesce(q.start_date,json_extract(t.plan,'$.selection.startDate'))<
           coalesce(q.end_date,json_extract(t.plan,'$.selection.endDate'))
       ${scheduleOrder} LIMIT ?`,
      now,
      SPLIT_LIMIT,
    )
    .all<ScheduledConfirmation>();
  const result = { split: 0, failed: 0 };
  const parent = `${activeJob} AND q.overflow=1 AND q.split_at IS NULL`;
  for (const job of held.results) {
    const key = [...jobKey(job), job.version] as const;
    try {
      const selection = jobSelection(job);
      const ranges = splitLotwQuery(selection);
      if (!ranges) throw new Error("invalid_inventory_lotw_confirmation_split");
      const lower = await savedLotwConfirmationLower(
        store,
        job.tenant,
        job.scope_id,
        job.scope_version,
        selection,
      );
      const authority = [...key, job.credential_version, now] as const;
      const [, finished] = await store.db.batch([
        store.statement(
          `INSERT INTO inventory_lotw_confirmation_schedule(
            tenant,scope_id,receipt_stream_id,scope_version,branch,start_date,end_date,initial_confirmed_since,next_due_at
           )
           SELECT q.tenant,q.scope_id,q.receipt_stream_id,q.scope_version,q.branch||j.key,
                  json_extract(j.value,'$.startDate'),json_extract(j.value,'$.endDate'),?9,?8
           FROM inventory_lotw_confirmation_schedule q CROSS JOIN json_each(?10) j WHERE ${parent}`,
          ...authority,
          lower,
          canonical(
            ranges.map(({ startDate, endDate }) => ({ startDate, endDate })),
          ),
        ),
        store.statement(
          `UPDATE inventory_lotw_confirmation_schedule AS q SET split_at=?8,version=version+1 WHERE ${parent}`,
          ...authority,
        ),
      ]);
      result.split += finished.meta.changes;
    } catch {
      result.failed++;
      await store
        .statement(
          `UPDATE inventory_lotw_confirmation_schedule AS q SET next_due_at=?7 WHERE ${currentJob}`,
          ...key,
          now + HOUR,
        )
        .run();
    }
  }
  return result;
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
         WHERE (q.tenant,q.scope_id,q.receipt_stream_id,q.scope_version,q.branch)=(t.tenant,t.scope_id,t.receipt_stream_id,t.scope_version,''))
       ORDER BY t.tenant,t.scope_id,t.receipt_stream_id LIMIT ?3
       ON CONFLICT(tenant,scope_id,receipt_stream_id,scope_version,branch) DO NOTHING`,
      HOUR,
      now,
      ENROLL_LIMIT,
    )
    .run();
  const result = {
    registered: enrolled.meta.changes,
    ...(await splitHeldConfirmations(store, now)),
    polled: 0,
    added: 0,
    deferred: 0,
    held: 0,
  };
  const job = await store
    .statement(
      `${scheduleRows} WHERE q.overflow=0 AND q.next_due_at<=? ${scheduleOrder} LIMIT 1`,
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

  const key = jobKey(job);
  const claimed = await store
    .statement(
      `UPDATE inventory_lotw_confirmation_schedule AS q SET version=version+1,next_due_at=?8
       WHERE ${activeJob} AND q.overflow=0`,
      ...key,
      job.version,
      job.credential_version,
      now + SLOT,
    )
    .run();
  if (!claimed.meta.changes) return result;
  let nextDue = now + SLOT;
  let rejectedCredential: string | null = null;
  let overflow = 0;
  try {
    const poll = await pollInventoryLotwConfirmations(
      store,
      {
        tenant: job.tenant,
        scope: job.scope_id,
        selection: jobSelection(job),
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
      result.failed++;
      nextDue = Date.now() + HOUR;
    }
  }
  await store
    .statement(
      `UPDATE inventory_lotw_confirmation_schedule AS q SET next_due_at=?7,rejected_credential_version=?8,overflow=?9
       WHERE ${currentJob}`,
      ...key,
      job.version + 1,
      nextDue,
      rejectedCredential,
      overflow,
    )
    .run();
  return result;
}
