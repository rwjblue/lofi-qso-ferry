# Workload investigation, 2026-10-23

Read-only production queries at approximately 13:13–13:17 UTC explain the
768 blocked source records shown in the original admin screenshot:

| Stored reason                       | Records at first inspection | Interpretation                                                                                                                          |
| ----------------------------------- | --------------------------: | --------------------------------------------------------------------------------------------------------------------------------------- |
| `operation_context_unavailable`     |                         767 | The operation read has not finished, so the contact cannot yet be interpreted safely.                                                   |
| `missing_or_ambiguous_station_call` |                           1 | A worked or station callsign is missing or fails validation. The shared validator does not distinguish those fields in this error code. |

At 13:17 UTC the context count had fallen to 765. All 765 had retained,
unexpired source payloads and belonged to 56 nondeleted operations whose state
was still `pending`. There were no missing or deleted operation rows in that
group. The application had completed 117 operation rereads; 41 reread cursors
were incomplete, and two destination-triggered rescans were still in backfill.
The global context cursor was complete and the main source cursor was in
forward mode. These are different checkpoints: completing the operation list
does not finish reading every operation's contacts and events.

The context cases are held dependencies, not 767 malformed contacts. Completing
an operation reread already returns its observed contacts to `pending` for
processing. The falling count demonstrates some progress; it does not establish
that the import is keeping up or give a completion estimate. No manual requeue,
cursor reset, source edit, or production data repair was performed.

The one callsign case remains a source-data issue requiring review. It should
not be repaired by guessing a callsign or weakening validation. Inspect the
worked and own-station callsign in the source contact and its effective operation
context, correct the source if needed, and let normal synchronization reprocess
the changed record.

Other evidence from the same inspection:
- The old pending count was 3,366: 3,106 rows in `pending` and 260 in `waiting`.
  Five waiting rows reported no matching QRZ or LoTW route. This mixed count was
  not a count of uploads ready to send.
- Destination ledger rows included 506 `inventory_pending` rows reporting
  unavailable destination readback, two other inventory rows, one ambiguous
  history match, and one history mismatch. A ledger row is a contact at one
  destination; those counts must not be added to source-contact counts.
- No delivery attempts were recorded. Export gates were closed, so zero
  completed deliveries was expected. Destination readback can still make
  progress while exports are disabled.
- Several recent scheduler runs reached their time budget; others stopped idle
  or lacked a finish checkpoint. Idle is not proof of an empty queue, and a
  missing checkpoint is not proof that the invocation is still executing.

The improved panel separates runnable processing from known holds and invalid
source data, exposes sanitized reason counts, persists comparable backlog
samples, and counts completed destination-contact versions from durable attempt
events. New samples are required for the new breakdown; old pending samples
cannot be retroactively interpreted as ready work.

A read-only run of the new classification query at 13:23 UTC classified the
4,134 retained source records as follows:

| Category                | Records | Explanation                                                                             |
| ----------------------- | ------: | --------------------------------------------------------------------------------------- |
| Ready                   |   1,423 | Eligible for further processing, including inventory retries; not permission to upload. |
| Held: operation context |   2,704 | Includes dependencies hidden inside the former pending count.                           |
| Held: routing           |       5 | No configured destination route matches the contact.                                    |
| Held: history review    |       1 | Destination history needs review.                                                       |
| Blocked: callsign       |       1 | Source callsign validation failed.                                                      |

All were background work. The query wrote zero rows and took approximately
281 ms, reading 161,586 rows in the approximately 20 MB production database.
This is an initial measurement, not a capacity guarantee. Watch query cost as
retained source and delivery history grow.

Counts here are time-specific diagnostic evidence. Current counts belong in the
admin console. The investigation used aggregate metadata; this document contains
no contact payloads, account identifiers, credentials, or vendor response bodies.
