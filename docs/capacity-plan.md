# Capacity plan

Status: signed revision `32e25b0ebc4d2ef5716bc3e60e166561a5b0931a` deployed
read-only at 2026-10-24 00:00 UTC as Worker
`076adec3-eeb7-4dc9-bcd8-f6b04ce75318`, at 100% traffic. All **675 tests** and
required checks passed locally and in
[release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40041632962).
Independent 00:01 UTC verification confirms healthy service, matching assets,
all five gates closed and twenty-three migrations through `0024`. Attempts,
cutovers, temporary guards and uncovered identity mappings remain zero.

The release adds a fifteen-minute shared QRZ partition retry delay for the exact
ambiguous empty-selection response, reducing repeated vendor reads while retaining
incomplete evidence. It does not establish absence or complete reconciliation.
Read-only diagnostics and source/trial audits improve the evidence available for
the owner pilot; they do not prove the growth workload below. No vendor budget
or concurrency limit was raised. Sustained capacity remains unverified.

The first new run, 00:05:43–00:07:13 UTC, processed 265 contact turns and 244
classifications, with zero adoptions, 21 affected-route errors and no deferrals.
Four fixed ambiguous-empty QRZ diagnostic events were recorded. The 00:06:18 UTC
snapshot found four pending partitions with bounded retry holds and no invalid
or excessive hold. The run used 737 D1 RPCs / 5,624 statements and stopped at
the deadline after 90.488 seconds. D1 wall time was 89.336 seconds; metadata for
5,448 statements reported 2.126 seconds of SQL, 1,698,263 rows read and 7,426
rows written. This verifies the retry mechanism, not unique completion throughput
or a cleared backlog; database round trips and scan attribution still need work.
At 00:07:15 UTC, attempts, cutovers, uncovered mappings and guards remained zero.

Historical source-context index and QRZ decoding release deployed read-only at
21:29:18.881251 UTC on 2026-10-23, signed revision
`cec488febcad419ff55a4aa677619a1aef61fcd5`, Worker
`3c1f615e-bf2d-403f-9d54-1aed519da582`, at 100% traffic. All 553 tests and required
checks passed locally and in [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40025951354).
Independent verification at 21:29:45 UTC confirms all five gates closed, HTTP 200
health and matching assets. D1 at 21:29:44.834 UTC confirms twenty-one migrations
through `0022` and zero attempts, cutovers or temporary guards. Sustained
capacity remains unverified; exports remain disabled.

The first new run, 21:30:42–21:32:15 UTC, completed 117 contact turns and
166 destination classifications, including eighteen adoptions, in 92.576 seconds.
It advanced seventeen history inventories and four source rescan pages, with
twenty errors and one deferral. No entity-decoding failures were recorded in this
sample. QRZ still reported eight rejected routes, nine scope-mismatch routes,
one invalid/repeated log-ID route and two uncategorized failed routes. The LoFi
rescan contributed the budget deferral. These are affected routes, not requests.

The run used 838 RPCs and 4,135 statements; metadata covered 3,856 statements,
reporting 1.812 seconds of SQL, 1,117,936 rows read, 9,990 rows written and no
additional retries. Database wall time was 86.934 seconds. It still reached the
deadline: this mixed-work sample establishes neither a sustained speedup nor a
whole-run scan reduction. The local context-index result remains valid, but the
production scan attribution needs query-level profiling. Remaining QRZ failures
must stay held until their scope, identity and parse evidence is understood.
At 21:32:48 UTC, attempts, cutovers and temporary guards remain zero.

The earlier diagnostic follow-up deployed read-only at 21:03:35 UTC,
signed revision `57a64b02285f55f3dee25fdf52674ac54cd3893f`, Worker
`25628683-a870-40e5-835f-e697adbc7f44`, then at 100% traffic. All 548 tests and
required checks passed locally and in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40023892103).
Independent 21:05:18 UTC verification confirmed closed gates, HTTP 200 health and
matching assets. That release required no migration and retained twenty through
`0021`. Its first refined-counter run is historical evidence below.
This plan extends the [reconciliation investigation](reconciliation-investigation.md)
to ongoing delivery across accounts. Targets below are engineering acceptance
criteria, not demonstrated service guarantees.

The preceding admission release `8863bd9` deployed at 20:44:21 UTC and passed
all 531 tests and required checks locally and in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40021495718).
It added mixed-date cohort batching and independent background account/source
admission with migration `0021`. The diagnostic follow-up refines fixed QRZ
parse/body categories and D1 response metadata; scheduler behavior and write
uncertainty rules are unchanged. The three production runs below belong to the
admission release. The earlier 19:45 UTC first-slice measurements remain separate.

The first new run, 20:46:52–20:48:32 UTC, completed 22 contact turns and
27 destination classifications, including two adoptions, with 11 errors and
two deferrals. It used 254 RPCs and 880 SQL statements in 100.130 seconds;
97.563 seconds were database wall time. It stopped at the soft deadline after
in-flight work settled. This sample does not establish a production speedup.
The new fixed categories identify QRZ rejected responses (four events affecting
six routes across the single-contact and shared-history paths), QRZ invalid
responses (two events affecting four routes), one LoTW unavailable event and
one LoTW budget-deferral event affecting two routes. Diagnostic events are not
physical request counts. The exact QRZ parser cause and the source of variable
D1 latency still need investigation. The 20:48:44 UTC snapshot confirms zero
attempts, cutovers or temporary guards.

The following runs confirm variable progress rather than a settled service rate:

| Run start (UTC) | Contact turns | Classifications |  Duration | D1 RPCs | D1 wall time | Errors |
| --------------- | ------------: | --------------: | --------: | ------: | -----------: | -----: |
| 20:46:52        |            22 |              27 | 100.130 s |     254 |     97.563 s |     11 |
| 20:50:44        |           103 |             118 |  91.845 s |     681 |     81.143 s |     23 |
| 20:55:45        |           137 |             190 |  68.887 s |     868 |     65.353 s |     33 |

The latter two runs adopted five and fourteen destination records, respectively,
and each advanced four source rescan pages. QRZ invalid/rejected responses
persisted, alongside LoTW unavailable responses and shared budget deferrals.
These are contact turns and destination outcomes, not unique fully reconciled
contacts. Zero attempts, cutovers and temporary guards remain verified at
20:57:00 UTC. More precise QRZ response categories and D1 SQL/coverage metadata
deployed in the 21:03:35 UTC diagnostic follow-up.

The first refined-counter run, 21:05:42–21:07:13 UTC, completed 104 contact
turns and 158 destination classifications, including ten adoptions, in 91.239
seconds. It recorded 33 errors and four deferrals. QRZ entity decoding accounts
for eleven diagnostic events affecting twenty history routes; ten separate QRZ
rejection events affected twelve routes. One LoTW unavailable event and four
budget-deferral events account for the remaining categories. Events are not
physical request counts. This run localized the entity failure to numeric Unicode
validation; the subsequent bounded probe and compatibility fix are recorded below.

D1 used 702 RPCs and 3,624 statements, with 84.089 seconds of wall time and
97.357 seconds of cumulative request time. Metadata covered 3,395 statements:
1.425 seconds of reported SQL execution, 1,004,089 rows read, 5,818 rows written,
zero additional statement retries, and ENAM service for all covered statements.
The uncovered 229 statements and last-attempt-only SQL reporting prevent
attributing the wait gap purely to network latency. This points to further
round-trip reduction and query profiling, not a reason to raise budgets.
The 21:08:59 UTC snapshot confirms zero attempts, cutovers or temporary guards.

## Workloads and success criteria

The first growth workload is 100 accounts creating 100 contacts each per day:
10,000 new contacts and up to 20,000 destination deliveries daily. That averages
about 35 new contacts every five minutes, but averages hide bursts, outages and
large initial imports. A 200,000-contact import must coexist with daily traffic.

Test these separately, with fake vendor adapters and actual D1/workerd:

| Workload                                                            | Proposed acceptance                                                                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 100 accounts, 100 new contacts each daily, both destinations        | Arrival rate remains below measured completion rate; queue age does not grow over a simulated week; at least 2× sustained capacity headroom            |
| Tenfold arrival burst for one hour                                  | Bounded memory and queue growth; drain within the following day while normal arrivals continue                                                         |
| One account importing 200,000 contacts alongside normal traffic     | Small accounts continue receiving turns; first classification within one day is a target to validate, with external service delays reported separately |
| Existing 4,000-contact backlog                                      | Target first classification within one hour after required context is available; explicit review holds count as classified, not delivered              |
| Vendor outage, 429/503, duplicate jobs, worker crash and restart    | No duplicate writes, no lost work, bounded retries, persisted cooldown, other vendors/accounts continue                                                |
| Expiry, edits, removal, credential rotation and identity collisions | Stale evidence cannot authorize an association or dispatch; uncertain submissions remain unresolved until readback                                     |

Track first classification, review-required, prepared, submitted and observed
separately. Vendor processing time and human exception review cannot be counted
as worker capacity. Proposed live discovery/delivery freshness must be chosen
against the vendor budgets below; five-minute polling is not currently feasible
for 100 accounts.

## Current limits and measurements

The deployed worker uses a five-minute cron, a 90-second soft execution budget,
850 D1 RPC budget, background batches of 20 and a live batch of one. The first
cohort-release run processed 80 contact turns and 121 destination classifications
in 92.209 seconds with 384 RPCs, 39 errors and three deferrals. Its 4.8 RPCs per
turn compare with 21.55 in the preceding 40-turn run (862 RPCs, 64.118 seconds).
That is approximately 78% fewer RPCs per turn for this mixed workload. It recorded
121 inventory cache hits and zero successful inventory advances; failed vendor
requests do not increment that latter counter. Contact turns are not unique
completed classifications or live delivery capacity. Cold-inventory behavior,
sustained progress and error outcomes still need measurement.

The second run processed 137 contact turns and 249 classifications in 86.646
seconds, using 861 RPCs and 4,842 statements, with 13 errors and three deferrals.
It stopped at the database budget and recorded five successful inventory
advances plus 244 cache hits. These two runs support initial improvement across
different work mixes; neither is a sustained or fully cold-inventory benchmark.

A local 20-contact, same-week, two-destination baseline fixture made 467 D1 RPCs and
939 SQL statements with fully cached history, zero vendor reads and 40 review
classifications. Of those RPCs, 160 reread the same history, 40 observed contacts,
40 checked eligibility, 80 applied outcomes, and 80 saved checks/source status/
queue completion. The first-slice cohort implementation reduced this fixture to
86 whole-tick RPCs and 556 SQL statements, of which 19 RPCs are cohort work.
Local elapsed time does not predict remote D1 latency.

Current vendor limits are application policy shared across all accounts, not
verified vendor quotas. They reserve capacity for live work and enforce shared
Retry-After cooldowns. They must not be raised merely to make a benchmark pass.

| Vendor | Current total requests / five minutes | Consequence at 100 accounts                                                                                                                                                                                              |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LoFi   | 24, including at most 4 background    | Five-minute polling needs 100 requests. Equal polling takes at least about 21 minutes, or 25 minutes when all four background slots are used.                                                                            |
| QRZ    | 120                                   | A new contact currently needs at least four calls through INSERT: classifier read, preparation read, dispatch read and INSERT. 40,000 calls/day exceeds the 34,560/day budget before maintenance or retries.             |
| LoTW   | 40, including at most 8 background    | A new query-enabled contact currently needs at least six calls through observed receipt: classifier read, preparation read, two certificate checks, upload and readback. 60,000 calls/day exceeds the 11,520/day budget. |

The LoTW signer already accepts multiple contacts, but the attempt lifecycle
currently represents one contact. Combining signed input alone would bypass
per-member source validation, cancellation and outcome tracking. Sparse daily
traffic also cannot assume every account fills a 100-contact upload quickly.

## Ordered implementation

### 1. Reduce repeated reconciliation database work — deployed, sustained production measurement pending

Share complete encrypted history reads and decryption within a bounded source/
destination/station cohort. Keep per-contact generation checks, current account
and credential validation, retention checks and commit-time evidence guards.
There is no cross-request plaintext cache. Cold partitions retain leased progress;
missing, expired or malformed evidence never becomes proof of absence.

Read observation and eligibility metadata for a cohort, then submit bounded
transactions containing individually guarded outcomes. Preserve route changes,
attempt cancellation, remote identity ownership and collision quarantine even
when competing contacts occur in the same batch. Queue completion and review
memos must reflect the final ledger state, including collisions discovered later
in the batch.

The local acceptance target was to reduce the warm fixture's per-contact portion
from 400 RPCs to at most 30, excluding source selection and housekeeping. That
target is met. Integration/race regressions pass and live dispatch remains
sequential. Production acceptance still requires comparison of actual
classification rate and database wall time before increasing cohort size.

The first slice's local warm fixture used **19 RPCs** for cohort work, down from
400; whole-tick calls fell **467→86** and SQL statements **939→556**. All 40
classifications remained, with 40 cache hits, zero vendor history calls and zero
exports. Cold whole-tick calls fell **519→170**, still using three history fetches.
These are fixture-specific amplification measurements, not a service-rate SLA.

Reproduce without production access:

```sh
mise exec -- npx tsx scripts/benchmark-reconciliation-cohort.ts
```

The scheduler uses this path for read-only background cohorts of at least four
contacts, with at most four history cohorts active. Small batches and live
preparation retain their existing path. New `reconciliationBatchCalls` telemetry
separates cohort RPC cost from selection and housekeeping. A failed date leaf
holds only dependent contacts; healthy history can still be classified.

The second slice's local warm fixture covers **20 contacts in 20 distinct
weeks**, across both destinations. It uses **57 cohort RPCs**, **128 whole-tick
RPCs** and **716 SQL statements**, retaining all 40 classifications with zero
vendor reads and writes. Outcome and evidence-fence regressions pass. This
tests mixed-date database amplification; it does not demonstrate production
throughput or a full import.

Mixed-date grouping retains up to four concurrent cold-partition advances
across the active cohorts. A deadline stops new advances; an invariant failure
also stops queued work, and every started save and lease release settles before
the batch returns. Bounded-cold regressions covering concurrency, deduplication,
deadline and failure draining pass.

Private-safe diagnostics separate a shared failure event from its affected
routes. `throughput.failures` uses fixed `stage:vendor:code` keys with `events`
and `affected` counts. Reuse of the same error object in one category counts
one event while each affected route is counted; separate error objects count
separately. These are diagnostic events, not physical network-call counts.
Only fixed codes are retained, without arbitrary messages, stacks, causes,
contact identifiers or credentials. The existing `inventoryFetches` counter
still records successful progress and cannot establish that no request failed.

The index and QRZ decoding fixes deployed in `cec488f` at 21:29 UTC, after all
553 tests and required checks passed locally and in CI. Migration `0022_source_context_members.sql`
indexes `(tenant, source, operation_id)` only for operation bases and event rows.
In a 4,000-contact fixture, the exact context fence reads **4,003→3 rows** and
the context query **4,004→4 rows**. Deleted-event filtering is preserved; missing
current-event ciphertext and revoked/expired context still fail the guards.
This removes a measured scan; it does not explain
or resolve the observed 84.089 seconds of database wall time.

A budgeted read-only QRZ FETCH on 2026-10-23 found 22 numeric entities, including
seven high and seven low UTF-16 surrogates forming seven adjacent valid pairs,
with no out-of-range values. The narrow decoder now combines only valid adjacent
pairs without losing Unicode or decoding twice, and rejects ADIF field boundaries
that split a character. Generic ADIF lengths, ASCII exports and exact identity
guards are unchanged. One post-patch probe still returned an unlocalized protocol
failure; a subsequent full-client FETCH parsed 121 records with well-formed fields
and the same aggregate pair counts. These samples do not prove that the same
partition was revisited or that all QRZ failures are fixed.

Before attributing another production scan reduction, add bounded counters by
fixed query family: projection/adoption guards, inventory reads/saves, source
invalidation and cleanup. Record statement metadata coverage, rows and SQL time
without retaining SQL text, parameters or returned data. Attribute binding wall
time once per RPC family, not once per statement in a batch. The first new run
read 9,555 rows per contact turn versus 9,401 in the preceding run, with seventeen
successful inventory advances versus three; changed workload prevents causal
attribution from these aggregate samples.

The next performance acceptance task is **bounded history-leaf batching**, not
implemented yet. Combining up to four leaves per RPC could reduce 40 leaf-read
calls to ten in the mixed-date fixture, taking cohort calls from about 57 to 27.
That is a design estimate, not a measured result. The implementation must share
one **8 MiB encrypted/index read budget** and candidate cap across the request,
bound SQL payloads, and retain each leaf's epoch and evidence guards. Four
maximum-size leaves plus index data cannot simply be materialized together.
Test budget exhaustion, expired/revoked/replaced leaves, concurrent epochs,
deadline/failure draining and unchanged outcomes before accepting the reduction.
Partial or over-budget reads must remain incomplete evidence. Measure retained
bytes, SQL/RPC costs and production database time separately; do not increase
vendor allowances to reach the target.

### 2. Wake eligible work and schedule accounts fairly

Incomplete inventory and loading reconciliation checks normally retry after
**five minutes**; an ambiguous-empty QRZ partition now shares a separate
**fifteen-minute** read cooldown. Stable completed review outcomes wait
**24 hours**. A targeted completion wakeup removes the reconciliation timer
only after the dependency succeeds; it must respect an active partition cooldown.
Cron timing, admission and vendor budgets can add
further delay. Avoiding repeated dependency checks requires parking contacts
against a shared inventory leader/job and waking only its dependents when the
required evidence completes. Persist that dependency without plaintext contact
data. The leader/job lifecycle is still needed.

Migration `0021` and the admission module now maintain eligible account/source
order through lifecycle triggers. A bounded indexed selector chooses one oldest
unleased source per least-recently-admitted account. A monotonic sequence avoids
clock ties. One atomic three-statement batch advances both turns before selected
work, including its canonical refresh, under exact account/source snapshots and
the current source-cycle lease token, fence and expiry. Seven module tests pass,
including 100 accounts with 2,000 pending import rows, multiple sources, restart
and same-clock turns, lifecycle changes, stale leases and the index plan.

The service now selects its background roster independently of canonical polling;
six focused integration regressions pass, including slow imports across restarts
and an early admitted source reaching its later live turn without duplicate
polling. Slow forward history yields to a paired backfill on the next turn, and
three slow failed imports rotate across fresh invocations. Startup or the initial
live pair can still consume the deadline before background admission. General
phase fairness, adaptive polling and production capacity remain unverified. The
2,000-row module fixture does not complete the 100-account daily workload or
200,000-contact import test.

Validate larger LoFi page sizes against real responses before changing them;
repeated context and destination rescans must share retained source work where
its proof allows reuse.

The next source-page slice should begin with 100-record operation rereads, then
100-record sync/rescan streams, under the existing request allowances. The
adapter accepts up to 200 and the pinned HaLo client defaults to 100, but Ferry's
recorded live probe requested only five records per stream. The existing local
100-operation/100-contact checkpoint uses eight RPCs and 1,307 SQL statements;
measure encrypted bytes and complete checkpoint time before enabling larger
background pages. Preserve the cursor on failure and defer any smaller retry
to a later scheduled turn. Shared source coverage needs explicit scan
subscribers and atomic progress; retained rows alone cannot replace each
destination's cutover evidence or justify merging divergent scan cursors.
Even 100 contacts per request would leave an ideal 200,000-contact source pass
at about 1.7 days with four background requests per five minutes, before context,
rescans, other accounts or retries. Larger pages alone do not meet the proposed
one-day import target.

Complete indexed due work and bounded account turns across the service.
Separate live arrivals, history imports, readback and maintenance. Reserve live
capacity and measure bounded background wait; the full live fairness and
vendor-admission policy remains open beyond the background slice. Use adaptive
polling for idle accounts, with explicit measured discovery latency and retry
jitter. The deployed background change does not establish 100-account fairness or
remove the shared vendor limits.

Acceptance: deterministic multi-account tests demonstrate bounded wait and
progress under bursts, cooldowns and a 200,000-contact import. Report actual
poll age and oldest eligible work, not just completed turns.

### 3. Make live delivery economical without weakening write safety

Durable outbound identity claims are implemented for both vendors, including
fractional timestamps, collisions, edits and retained uncertain attempts.
Lossless eight-character LoTW station grids are also implemented. These remove
implementation blockers; historical precision associations, source proof and
scoped live vendor acceptance remain separate prerequisites for exports.

Introduce immutable attempt membership before enabling multi-contact LoTW
artifacts. Group only compatible tenant/account, certificate, station location
and signing policy. Bound member count, serialized bytes and signing CPU, with
a maximum coalescing delay so sparse accounts are not held indefinitely.

Every member needs pinned source/version/identity, artifact membership and
readback state. Any invalid member before dispatch invalidates the saved
artifact; rebuild an unsent replacement from still-valid members. Once dispatch
may have occurred, retain the exact artifact and reconcile every member without
blind resubmission. An upload receipt does not prove every member was observed.
Share certificate validation only within its validated scope and dispatch turn.

For QRZ, retain the final write-adjacent duplicate check and immutable write
intent. Determine which earlier readbacks can be safely coalesced using the
durable identity claims. Batch readback neighborhoods where responses prove complete
coverage; do not treat cached absence as authority to write. Model required
calls for sparse and bursty accounts before deciding whether vendor-approved
budget changes are needed.

Acceptance: request demand fits the configured budgets with retry/maintenance
headroom in both sparse and burst tests. Member cancellation, crash recovery,
partial readback and collisions pass with zero duplicate writes.

### 4. Add durable continuations around bounded work

Persist runnable work and a transactional outbox before queue publication. Queue
messages identify work, not credentials or contact payloads. At-least-once
delivery requires idempotent processing, fenced leases and checkpointed progress;
cron remains a recovery sweep. A queue consumer must call the bounded operations
above rather than multiply the original per-contact database/vendor requests.

Account and vendor admission apply before dispatch. Use bounded concurrency,
dead-letter handling and operational retry controls that cannot repeat uncertain
external writes. Benchmark one D1 database before considering partitioning;
queues cannot remove a database serialization or vendor budget bottleneck.

### 5. Prove capacity and rollout readiness

Run the full workload matrix, publish reproducible commands and record maximum
queue age, completion rate, RPC/SQL counts, vendor calls, CPU/memory, retries and
cost estimates. Separate a simulation of time from real Worker/runtime latency.
Observe read-only production after each runtime release and retain a rollback
revision. Do not label an index microbenchmark as a 200,000-contact capacity test.

Exports stay disabled until source replay/cutover evidence, identity claims,
precision policy, exception review and the existing
[rollout checklist](rollout-checklist.md) are satisfied. First writes need exact
scoped canary authorization and observed results. Capacity work itself does not
provide that authorization or evidence.

## Platform constraints informing this plan

[D1 batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
reduce client round trips and execute transactionally; reducing RPCs does not
eliminate SQL work or [D1 database limits](https://developers.cloudflare.com/d1/platform/limits/).
[Cloudflare Queues delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
is at least once, which is why leases, idempotency and the outbox precede queue
adoption. [LoTW signed submission](https://lotw.arrl.org/lotw-help/developer-submit-qsos/)
accepts signed files; safe multi-contact lifecycle handling remains application
work, not a signer-only change.

[Worker placement](https://developers.cloudflare.com/workers/configuration/placement/#review-limitations-1)
affects fetch handlers, not scheduled handlers, so enabling placement does not
directly solve cron-to-D1 latency. [D1 response metadata](https://developers.cloudflare.com/d1/worker-api/return-object/)
reports SQL timing, rows and retry attempts. SQL timing describes the last
attempt and excludes network; methods without metadata and earlier retry
attempts leave coverage gaps. Compare these counters with binding wait time
without labeling the entire difference as network latency.
