# Reconciliation exceptions and capacity

Investigation date: 2026-10-23. Production revision at investigation start:
`634517d0`. Exports remain disabled. This report separates observed evidence,
implementation work and remaining acceptance checks; it does not authorize
logbook writes or treat a partial inventory as absence.

## Implementation status

The immediate repairs are signed on `main`: canonical general-log station
projection and scoped reprojection migration `32758f5`, precision review
explanations `789d652`, and cleanup query repair `fa822ba`. Local full checks
passed 391 tests; a final LoTW diagnostic correction for an unrelated neighbor
then passed the 35-test QRZ/reconciliation suite and TypeScript/lint checks.
Release [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39974178346) passed all 392 tests and required checks. Revision `cf34ac0a82e4f3f845b058684a04128f91c0b147` was deployed at `2026-10-23T15:04:09.293Z` as Worker `40a3c20e-81f8-45a7-9350-2e99767c241c`, with 100% traffic and every export gate independently verified closed. At 15:04:50 UTC, all fifteen migrations were applied, the one affected source row was pending with its old diagnostic cleared, and export attempts remained zero. Existing history holds are not automatically approved by these changes.

The batching, indexed ready-work selection, shared inventory, durable jobs and
capacity acceptance work below remain unimplemented. No claim of completed
reconciliation or 200,000-contact readiness follows from the cleanup benchmark.

## First production observation

At 15:08:05 UTC, the first completed post-release run (started 15:05:50) took
96,730 ms, with two contact turns, one canonical source page, zero errors and
zero deferrals. The immediately preceding run took 132,572 ms for two turns.
This one-run comparison is consistent with less cleanup overhead; contact
throughput remains two turns per run and sustained draining is not established.
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

## Observed throughput and structural limits

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

The current service reads destination history separately for each source
contact. A 200,000-contact log therefore needs at least 200,000 LoTW queries
under that design. Shared, bounded destination partitions and local matching
are required to make request count depend on inventory pages/date partitions
rather than contact count.

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

Production functions exercised against local Miniflare also show a new
25-contact source page uses 31 sequential database calls, and an unchanged
unresolved 25-contact rescan uses 56 calls, including 25 prior-row reads and 25
resolution checks. A one-contact exception fixture uses 90 calls on the first
scheduler tick and 79 on the next; both vendors are queried again without a
source change. With a real backlog, oldest-processed ordering rotates these
holds behind other contacts, but no durable review/retry condition prevents
later unnecessary reads.

The ready-contact selector still scans/sorts eligible work to return one row:
local 4,000-contact queries took 21–51 ms and 200,000-contact queries took
1.36–1.58 seconds per selection. Removing the cleanup problem does not remove
that scaling cost or the per-contact vendor request floor.

Source ingestion also has a structural floor: current background pages contain
25 contacts and share four LoFi requests per five minutes. Even one pass over
200,000 contacts therefore needs at least 6.9 days before operation rereads and
two destination-triggered source rescans. The adapter allows requesting up to
200 records, but that larger page size needs live verification and database
batching first. At 200 records and the same request budget, one pass alone still
needs about 20.8 hours. Shared source coverage must replace redundant full
passes where the source contract permits; a one-day end-to-end target cannot
be claimed from destination batching alone.

## Implementation order and acceptance

1. **Correct and explain the discovered exceptions.** Support canonical own-call
   data for the affected general-log shape. Distinguish lower timestamp/grid
   precision from conflicting identity/location, while retaining review holds
   and exact outbound guards. Those narrow code changes are implemented; the
   complete review interface remains needed. Provide paginated, tenant-scoped review with full
   contact identifiers and the relevant source/candidate differences; the
   current recent-activity list is not a complete review workflow.
2. **Measure and remove database amplification.** Record bounded per-stage
   durations, database call/row counts, source records/pages, and unique
   per-destination classifications. Batch page metadata reads and checkpoint
   writes, validate larger LoFi pages, share source coverage across destinations,
   reuse operation context within a bounded processing batch, and
   separate maintenance from fair contact work. Preserve generation checks,
   fences, canonical freshness polling and live-traffic reservations.
3. **Stop retrying unchanged review decisions as ordinary work.** Persist
   evidence version, last outcome and next retry/invalidation condition.
   Source/context/route/credential changes must invalidate the right decisions;
   transient failures back off independently. A stable precision or routing
   hold must not consume a vendor read every scheduler pass.
4. **Reconcile shared encrypted inventory partitions.** Page QRZ history and
   query bounded LoTW date/station partitions once, then match many retained
   sources locally. Split oversized partitions, checkpoint progress atomically,
   distinguish incomplete coverage from absence, preserve neighboring collision
   coverage and catch-up reads, and retain a fresh targeted check before any
   future first write. Purge temporary indexes after durable results; preserve
   compact exception evidence and durable identity claims. Move bounded page and
   partition jobs to a durable queue with idempotent, fenced commits and fair
   live reserves; retain cron as a watchdog. Queue redelivery must not duplicate
   vendor work, as [Cloudflare delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
   specify at-least-once delivery.
5. **Prove capacity before broader rollout.** Benchmark 4,000 and 200,000
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
