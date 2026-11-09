import { canonical, sha256, unb64 } from "./security.ts";

const HOUR = 3_600_000;

/** Spread successful recurring reads across stable, independent stream phases. */
export async function lotwRecurringDueAt(
  now: number,
  identity: readonly [tenant: string, scope: string, stream: string],
  pollPeriodMs: number,
  verification?: { periodMs: number; existingDeadline?: number },
) {
  const bytes = unb64(
    await sha256(canonical(["lotw-recurrence-v1", identity])),
  );
  const phaseSeed = Number(new DataView(bytes.buffer).getBigUint64(0) >> 11n);
  if (!verification) {
    // Align to the next phase after half a period. Even a newly aligned
    // feed leaves half a period of slack before its two-period health expires.
    const earliest = now + Math.ceil(pollPeriodMs / 2);
    const offset = (phaseSeed % pollPeriodMs) - (earliest % pollPeriodMs);
    return earliest + ((offset + pollPeriodMs) % pollPeriodMs);
  }

  const period = Math.max(pollPeriodMs, verification.periodMs);
  const deadline = Math.max(
    now,
    Math.min(now + period, verification.existingDeadline || now + period),
  );
  const offset = (deadline % period) - (phaseSeed % period);
  const aligned = deadline - ((offset + period) % period);
  // A new schedule may verify early, with room for the ordinary poll and
  // without extending the deadline already set by the last full scan.
  return aligned >= now + Math.max(HOUR, pollPeriodMs) ? aligned : deadline;
}
