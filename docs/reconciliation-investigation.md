# Reconciliation exceptions and capacity

Investigation date: 2026-10-23. Production revision at investigation start:
`634517d0`. Exports remain disabled. This report separates observed evidence,
implementation work and remaining acceptance checks; it does not authorize
logbook writes or treat a partial inventory as absence.

## Implementation status

The larger throughput implementation is deployed in signed revision `bbc2346c`
as Worker `c592733f-171f-406e-bb8d-827b7ffd7fd9` at 16:12 UTC. Batched
intake/context access, indexed due-work selection, durable exception retries,
shared encrypted history and scheduler telemetry are implemented. All 452 tests
and required checks passed in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39983716440).
Independent readback confirms nineteen migrations, closed export gates and zero
attempts/cutovers. This deployment also includes test-operation exclusion from
`0000073`. The earlier observations below predate this release; sustained
production throughput still needs measurement. Exports remain disabled.

The earlier immediate repairs are signed on `main`: canonical general-log station
projection and scoped reprojection migration `32758f5`, precision review
explanations `789d652`, and cleanup query repair `fa822ba`. Local full checks
passed 391 tests; a final LoTW diagnostic correction for an unrelated neighbor
then passed the 35-test QRZ/reconciliation suite and TypeScript/lint checks.
Release [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39974178346) passed all 392 tests and required checks. Revision `cf34ac0a82e4f3f845b058684a04128f91c0b147` was deployed at `2026-10-23T15:04:09.293Z` as Worker `40a3c20e-81f8-45a7-9350-2e99767c241c`, with 100% traffic and every export gate independently verified closed. At 15:04:50 UTC, all fifteen migrations were applied, the one affected source row was pending with its old diagnostic cleared, and export attempts remained zero. Existing history holds are not automatically approved by these changes.

Durable queue continuations, larger production-verified source pages, complete
exception review and end-to-end capacity acceptance remain open. No claim of
completed reconciliation, a 200,000-contact SLA or first-write readiness follows
from the local results.

### Locally validated throughput changes

Source-page processing reads prior metadata and resolution state in batches,
then preserves one atomic checkpoint. A bounded contact batch shares retained
operation/event data while still validating complete context and each contact's
projection. The comparable local D1 RPC counts are:

| Fixture                                             | Previous calls | Batched calls |
| --------------------------------------------------- | -------------: | ------------: |
| Poll one operation and 25 contacts                  |             32 |             7 |
| Reread 25 operation contacts                        |             33 |             9 |
| Replay 25 contacts                                  |             56 |             7 |
| Project 20 contacts sharing operation/event context |            102 |             5 |

Indexed due-work metadata replaces the backlog-wide sort. Successful
per-destination classifications are remembered against the source generation and
work version. Stable review holds wait 24 hours; incomplete inventories and
loading work retry after five minutes. Relevant source/context, route,
credential and eligibility-policy changes invalidate the affected decisions.
Retention-only extensions and routine credential rewraps do not clear holds.
Live priority, tenant fencing, expiry, processing cutoff and stale-version
rejection remain covered by local tests. These scheduling hints do not replace
the full source, route, evidence and export guards.

`mise run benchmark-reconciliation` builds local synthetic D1 fixtures and
selects 100 contacts without vendor calls:

| Contacts | Rows read | Selection | Selection after almost all background work is held |
| -------- | --------: | --------: | -------------------------------------------------: |
| 4,000    |       200 |   7.68 ms |                                            5.95 ms |
| 200,000  |       200 |   7.63 ms |                                            6.22 ms |

Both held-work selections also read 200 rows. This is a repeatable query-level
measurement, not a full source import, history reconciliation or production
throughput benchmark.

Destination history is now shared through encrypted four-hour partitions
covering up to a week. QRZ inventories use a base scan plus modification catch-up
and replace indexed identities as newer evidence arrives. LoTW splits oversized
date ranges down to a day and holds a still-oversized day for targeted review.
Retention is bounded to 2 MiB per partition, 128 MiB per source/destination and
2,048 partitions per source/destination, with bounded pages and candidate reads.
Incomplete, expired or revoked coverage cannot produce usable completed
inventory. Cached absence retains a hold; it never supplies the fresh targeted
identity check required before a future export. Completion of an inventory does
not currently wake an older stable hold; its 24-hour retry is the backstop.

The local scheduler integration fixture classifies 20 contacts into 40 stable
destination review holds with three history requests: two QRZ requests for
base/catch-up and one LoTW query. The next tick processes zero contacts and makes
zero additional history reads. Both ticks create zero attempts and perform zero
vendor writes. This proves reuse and suppression of unchanged work for that
fixture, without approving any exception.

A separate local 20-contact, same-week measurement isolates the remaining
database cost. The cold pass made 40 classifications using three history
requests, 519 metered D1 RPCs and 1,147 statements in 4,979 ms. Forcing those
synthetic contacts due again while retaining valid inventory made the same 40
classifications with 40 cache hits and zero vendor reads, but still required
467 RPCs / 939 statements in 3,626 ms. Of those warm RPCs, 400 were per-contact
work: observation 40, preflight 40, inventory 160, adoption metadata/commit 80,
remembered checks 40, source status 20 and queue completion 20. The other 67
were scheduler/source/selection overhead. One auth-cleanup request precedes
the meter in each run. These local synthetic results identify why shared
partition comparison and guarded bulk result commits are the next throughput
step; the timings are not production capacity measurements.

Background processing selects batches of 20; live processing remains one
contact at a time to reserve write capacity. The scheduler yields at a
90-second or 850-D1-call soft budget; already-started work may finish afterward.
Telemetry records stage duration, D1 RPC and SQL-statement counts, destination
classifications, inventory fetches and cache hits. Vendor request allowances
are unchanged. New queue triggers also required direct `RETURNING` results for
guarded update counts, because D1 aggregate change counts include trigger writes;
the affected delivery, verification, maintenance and restore paths have local
regression coverage.

## First throughput release: production bottlenecks and follow-up

The first new run, **16:15:43–16:17:17 UTC**, processed four contacts in
**93.7 seconds**, with four destination classifications, one adoption and four
QRZ errors. It recorded 289 database requests / 414 SQL statements, with
**73.4 seconds** of cumulative database wait and 67.5 seconds in history work.
It populated four complete LoTW partitions; four QRZ partitions remained in
catch-up. This cold-cache result is insufficient capacity, not a successful
4,000/200,000-contact throughput acceptance.

One bounded background-budget diagnostic identified QRZ's catch-up response as
HTTP 200, `RESULT=FAIL`, `COUNT=0`, without ADIF or a reason. It completed in
276 ms. Credentials and raw contact data were not persisted; there were no
vendor writes or application ledger/cache/cursor changes. Generic rejection
still cannot prove empty coverage.

The follow-up implementation discards incomplete first-pass QRZ evidence on a
rejected catch-up, then performs a bounded full verification scan. Only valid,
complete responses become reusable positive evidence. It also reduces
observation from five to two database requests, preflight from three to one,
and adoption metadata from two to one. LoTW inventory fixtures use thirteen
requests cold and four cached. Up to four read-only background contacts overlap
database latency; live and export-enabled work remain sequential. Contacts
sharing a destination/week wait for the preceding history turn, and the source
cycle lease remains held until every started worker settles. These follow-up
changes pass all 465 tests and required local checks. They deployed at 16:37 UTC
in `471e8620` as Worker `5d667922-2d09-4020-8fbd-46594a537750`; all 465 tests
and required checks also passed in
[CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39988135604).

The first follow-up run, **16:40:49–16:42:24 UTC**, processed **20 contacts**
and made **29 destination classifications**, including one adoption, in
**95.3 seconds**. It recorded three errors, eight deferrals, 25 inventory fetches
and 14 cache hits. The 16:43 snapshot contains six completed QRZ partitions and
17 completed LoTW partitions. All nineteen migrations remain applied, with zero
attempts, cutovers or temporary guard rows. This is one run's improvement from
the earlier two-contact baseline, not sustained unique-contact completion.

Database wall time was **92.9 seconds**, across 667 RPCs / 1,171 statements;
summed RPC latency was 234.0 seconds because requests overlapped. Source polling
read one empty canonical page, but neither historical rescan nor operation
reread advanced. Inspection confirms the ready batch can consume every turn's
deadline before background source recovery runs. A durable fair rotation of
background processing lanes is the correction described below; simply waiting longer does
not fix this ordering defect.

Read-only metadata localizes the three failures to two QRZ initial scans and
one LoTW initial scan. Both QRZ partitions had zero pages; the corresponding
LoTW partitions had valid, completed zero-record reports. This suggests QRZ
rejected empty initial selections, but does not prove its response or absence.
The LoTW failure coincided with a persisted cooldown ending at 16:42:54 UTC,
consistent with a temporary service response. Exact HTTP statuses were not
retained. Add fixed-category aggregate error counters before relying on these
inferences for further changes; never retain error messages or raw responses.

The next run, **16:45:45–16:47:16 UTC**, processed 21 contacts and made 24
destination classifications, including two adoptions, in 91.6 seconds. It
advanced one rescan page and one context reread page, returning 30 source
records, with seven errors and three deferrals. Database wall time was 78.5
seconds over 545 RPCs / 1,203 statements. The 16:48 snapshot had 77 remembered
destination checks spanning 57 contacts, nine complete QRZ partitions and
eighteen complete LoTW partitions. Attempts, cutovers and guard residue remained
zero. Context can progress when the ready batch leaves time, but the deadline
ordering still permits starvation; durable rotation addresses that risk.

The scheduler correction rotates the first background lane across retained
contacts, historical rescan and context reread. It persists the next turn before
starting work under the exact unexpired source-cycle lease. A slow or failed
lane therefore yields first position next time. Canonical polling remains first,
live work remains ordered, and the new metadata cursor cannot satisfy source
coverage or cutover proofs. It adds one database request per background turn
without a migration or vendor-budget change. Virtual-time regressions exercise
all three lanes across deadline exhaustion and a history failure; additional
races reject expired or replaced cycle leases. All 467 tests and required local
checks pass. Signed revision `cb9ea362` deployed at 16:53 UTC as Worker
`aea20af6-c08d-4718-bc41-2e450d8cc2e4`. CI stopped at a documentation-format
error corrected in the release-note update; a rerun and production observation
are pending. All gates, assets and health were independently verified, with nineteen
migrations and zero attempts/cutovers/guard residue.

Cumulative stage/database durations may overlap under concurrency. The new
`database.wallMs` reports elapsed time with any database request in flight;
`durationMs` continues to sum individual request latency. Neither measures
billed CPU. All export gates remain closed.

## Earlier production observation (before throughput changes)

At 15:08:05 UTC, the first completed post-release run (started 15:05:50) took
96,730 ms, with two contact turns, one canonical source page, zero errors and
zero deferrals. The immediately preceding run took 132,572 ms for two turns.
This one-run comparison is consistent with less cleanup overhead; contact
throughput was still two turns per run and sustained draining was not established.
Classified work was 1,820 ready, 2,314 held and zero blocked. The cleared callsign
hold was requeued, not independently proven reconciled. New precision-specific
reasons were stored for one QRZ and two LoTW rows, all still review holds.
Export attempts and source cutovers both remained zero.

## Exception findings

Four independent investigations covered QRZ, LoTW, source/routing exceptions and
throughput. Production source payloads and credentials were decrypted only in
memory. The destination probes used normal shared background request budgets:
three QRZ FETCH requests and two LoTW queries, with no vendor mutations,
signatures, adoption changes or cursor resets. Personal contact identifiers and
raw responses are excluded from this repository report.

| Area                    | Observed evidence                                                                                                                                                                                                                                                       | Resolution boundary                                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| QRZ timestamp precision | Ten ambiguous rows were inspected locally. Three representative reads each returned one candidate with all other identity fields agreeing; source seconds were absent from the four-digit destination time. This also occurred for a source with no fractional seconds. | Explain the lower precision separately from competing candidates. Keep the hold. A source timestamp must not be changed to force a match. The other seven cases were not remotely sampled.       |
| LoTW grid precision     | All eight current grid-mismatch sources had eight-character operation grids and current, complete context. Two reads returned the matching six-character prefix, one exact contact identity and agreement on every other compared location field.                       | Explain compatible lower grid precision as review work. Do not automatically adopt or truncate source data. The other six cases and the older overwritten diagnostic remain unverified remotely. |
| General-log station     | The one callsign hold contains canonical `our.call`; Ferry only consumed explicit station aliases or operation context.                                                                                                                                                 | Fix the narrow null-operation projection path and requeue affected held inputs. No source edit should be requested for this compatibility defect.                                                |
| Station routing         | Five contacts project successfully but use stations outside the connected personal station routes: four contacts under two other station callsigns and one test-suffix station. All dates fit the QRZ route.                                                            | Leave them held unless the owner chooses legitimate matching destination coverage or identifies incorrect source data. An operator callsign does not replace the transmitting station.           |

The [QRZ API guide](https://www.qrz.com/docs/logbook/QRZLogbookAPI.html) contains
minute-format examples but does not establish that every fetched record loses
seconds. Missing seconds are unknown precision, not a measured value of `00`.
The strict identity helper is also used by correction guards and must not be
globally relaxed to make history adoption pass.

The [ARRL query contract](https://lotw.arrl.org/lotw-help/developer-query-qsos-qsls/)
describes the uploaded station location but does not establish a universal
six-character grid reporting ceiling. The probe cannot distinguish vendor
truncation from an earlier exporter supplying six characters. Any future
precision-aware association needs explicit semantics, source uniqueness and
durable collision protection. The outbound signer currently accepts only four-
or six-character station grids; eight-character source locations are a separate
pre-export requirement, not fixed by a read-only comparison diagnostic.

HaLo's pinned QSON importer/model evidence is recorded in
[LoFi evidence](evidence-lofi.md). Own-call fallback must remain narrow: operation
and segment station context is authoritative, explicit station clears remain
meaningful, and `operatorCall` is never inferred as the transmitting station.

At 14:38 UTC, canonical source sync was already in forward mode, while 42
operation rereads and both destination-triggered source rescans remained
unfinished. There were 134 completed operation contexts and 734 unexpired
context-held contacts. Cron can advance those dependencies, but cannot resolve
the station-coverage decisions or establish missing precision evidence.

## Investigation baseline and remaining source limits

The five completed runs from 14:05 through 14:25 UTC each examined two contacts.
They took 128.8–140.7 seconds, exceeding the scheduler's 90-second soft deadline
because in-flight work and cleanup can continue afterward. Two of those runs
recorded one error; none recorded a vendor-budget deferral. A separate
overlapping invocation examined no contacts yet took 53.1 seconds. These are
contact-processing turns, not verified unique reconciliations.

The 14:25 window used all four configured LoFi background requests, but only two
of 24 QRZ and two of eight LoTW background requests. These are application
budgets shared by all tenants, not published vendor quotas. The QRZ probe's
network requests took 104–301 ms. The two complete LoTW probe calls, including
their database budget reservation, took 2.1–2.2 seconds. Those samples do not
establish production stage latency, but do not support blaming slow vendor
responses for the whole run.

| Optimistic first-pass model                  | 4,000 contacts | 200,000 contacts |
| -------------------------------------------- | -------------: | ---------------: |
| Two distinct contacts every five minutes     |       6.9 days |         347 days |
| Eight distinct LoTW reads every five minutes |       1.7 days |        86.8 days |

These calculations assume no repeats, errors, dependency holds, other tenants
or additional vendor requests. They are architectural bounds, not completion
estimates. Current source-contact payloads expire after seven days, so the
observed rate risks reread/expiry churn even for the owner's log. Increasing a
cron deadline or request allowance alone is not an adequate scaling plan.

At investigation time the service read destination history separately for each
source contact. A 200,000-contact log therefore needed at least 200,000 LoTW
queries under that design. The new shared partitions and local matching remove
that per-contact request requirement for reusable retained history; production
reuse and complete source/destination capacity still need measurement.

## Reproduced database costs

Production `EXPLAIN QUERY PLAN` for the actual cleanup `DELETE` confirmed a
private-payload scan containing a correlated source lookup by tenant/source,
without an indexed payload-ID lookup. An earlier SELECT-equivalent plan was
misleading because SQLite optimized it differently. The explain probe wrote
zero rows; no production cleanup query was executed manually.

The replacement deletes by the resolved `(tenant, source, private_id)` tuple,
using the private-data primary key. It preserves the existing resolution test,
transaction and subsequent archive checkpoint without adding an index or
migration. On local synthetic SQLite fixtures:

| Cleanup query                            | 4,000 contacts |                      200,000 contacts |
| ---------------------------------------- | -------------: | ------------------------------------: |
| Previous correlated DELETE               |       1,240 ms | Stopped; no completion timing claimed |
| Same query with a candidate lookup index |        5.13 ms |                                340 ms |
| Selected tuple-key rewrite               |        2.74 ms |                                172 ms |

These are query-level local measurements, not production drain-rate claims.
An additional Miniflare/D1 experiment on the same 4,000 unresolved contacts
measured 16,016,002 rows read and 3,547 ms SQL for the old DELETE versus 12,001
rows and 6 ms for the rewrite; both changed zero rows. The regression requires
fewer than 80,000 rows read and fails against the original query.
A real-D1 regression checks bounded rows read for 4,000 unresolved contacts;
semantic tests preserve unresolved/mixed-destination work, stale baselines,
outstanding attempts, operations/events and tenant/source boundaries.

Before batching, production functions exercised against local Miniflare showed a new
25-contact source page uses 31 sequential database calls, and an unchanged
unresolved 25-contact rescan uses 56 calls, including 25 prior-row reads and 25
resolution checks. A one-contact exception fixture used 90 calls on the first
scheduler tick and 79 on the next; both vendors were queried again without a
source change. With a real backlog, oldest-processed ordering rotates these
holds behind other contacts, but there was no durable review/retry condition to
prevent later unnecessary reads. The new comparable intake and stable-hold
measurements are recorded above.

The previous ready-contact selector scanned/sorted eligible work to return one row:
local 4,000-contact queries took 21–51 ms and 200,000-contact queries took
1.36–1.58 seconds per selection. The indexed selector now has bounded local
rows-read evidence at both sizes; it still needs production validation alongside
the rest of the pipeline.

Source ingestion also has a structural floor: current background pages contain
25 contacts and share four LoFi requests per five minutes. Even one pass over
200,000 contacts therefore needs at least 6.9 days before operation rereads and
two destination-triggered source rescans. The adapter allows requesting up to
200 records, but the configured source page size remains 25. Database batching is
implemented; the larger page size still needs live verification. At 200 records
and the same request budget, one pass alone still
needs about 20.8 hours. Shared source coverage must replace redundant full
passes where the source contract permits; a one-day end-to-end target cannot
be claimed from destination batching alone.

## Remaining implementation and acceptance order

1. **Correct and explain the discovered exceptions.** Support canonical own-call
   data for the affected general-log shape. Distinguish lower timestamp/grid
   precision from conflicting identity/location, while retaining review holds
   and exact outbound guards. Those narrow code changes are implemented; the
   complete review interface remains needed. Provide paginated, tenant-scoped review with full
   contact identifiers and the relevant source/candidate differences; the
   current recent-activity list is not a complete review workflow.
2. **Deploy and measure the implemented throughput path.** Keep every export
   gate closed. Verify sustained classification progress, inventory reuse,
   stable-hold retry suppression, source freshness and live fairness using the
   new stage/D1/classification telemetry. Record the deployed revision,
   migrations, release checks and production samples separately from earlier
   evidence. Track unique completed outcomes rather than counting repeated
   contact turns as progress.
3. **Remove the remaining source-capacity floor.** Validate larger LoFi pages
   against the live contract and share source coverage across destinations where
   safe. Background pages remain 25 contacts; batching alone does not remove the
   6.9-day lower bound for one 200,000-contact source pass. Preserve generation
   checks, fences, canonical freshness polling and live reservations.
4. **Batch classification for contacts sharing inventory.** After source-lane
   fairness, reduce the remaining per-contact D1 round trips by comparing a
   bounded group against one validated partition and batching guarded result
   commits. Preserve individual source generations, collision reservations,
   account/credential checks and commit-time evidence fences. Increasing
   concurrency or enqueueing the current per-contact function does not remove
   those round trips. Measure both cold and warm inventories before expanding
   parallelism. An initial local acceptance target is no more than 30 database
   RPCs for 20 cached contacts across two destinations, excluding scheduler
   housekeeping, versus the measured 400. This is a target, not an implemented
   result.
5. **Add durable continuations and targeted inventory wakeups.** Shared
   partitions and durable indexed due-work metadata are implemented, but
   Cloudflare Queue jobs are not. Move bounded page/partition continuations to a
   durable queue with idempotent, fenced commits and fair live reserves; retain
   cron as a watchdog. Wake only contacts covered by newly completed inventory
   rather than clearing every stable hold for a destination. The current
   24-hour retry remains the backstop. Queue redelivery must not duplicate vendor
   work, as [Cloudflare delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
   specify at-least-once delivery.
6. **Prove complete capacity before broader rollout.** The indexed-selection
   benchmark and 20-contact integration fixture are complete; full 4,000 and
   200,000-contact end-to-end benchmarks remain open. Exercise
   synthetic contacts with realistic operation/event density, repeated calls,
   precision differences, edits, tombstones, failures and multiple tenants.
   Measure first-pass completion, unique classifications per minute, live-work
   delay, database rows/calls, memory/CPU and vendor requests. Initial engineering
   targets are a 4,000-contact first classification within one hour and 200,000
   within one day under a documented available-vendor workload; these are
   proposed acceptance targets, not demonstrated service guarantees. The source
   page/budget floor must be resolved before adopting the one-day target as a
   service commitment; otherwise record the verified upstream limit and adjust
   the target explicitly. Test
   interruption/resume, overlap, expiry and credential revocation, with zero
   export attempts while all gates are closed.

The worker's five-minute schedule can continue during this work. Complete
source replay/cutover evidence, durable outbound identity claims, precision
policy, owner-history review and explicitly authorized exact-contact canary
writes remain separate gates in the [roadmap](../ROADMAP.md) and
[rollout checklist](rollout-checklist.md).
