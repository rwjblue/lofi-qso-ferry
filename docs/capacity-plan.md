# Capacity plan

Current status, 2026-10-24 UTC: baseline/drain/quarantine completed at 06:35:44
for all 4,500 retained rows. At 08:12:53, a protected exact-deployed-code diagnostic
minted one source proof and verified fresh QRZ absence for the same contact, using
two source and three QRZ reads. That bounded sample does not establish sustained
capacity or scheduled Worker/write acceptance. The collector refinement and independent LoTW authority are deployed in
`12f636b3`; all eight export controls remain closed.

## Cost of the LoTW first-insert path

The default-off LoTW capability repeats a complete three-day history query and
certificate-status query before signing and before upload. One successful contact
therefore needs at least six LoTW requests: two preparation reads, two dispatch
reads, one upload and one later acceptance readback. Ordinary inventory/targeted
reconciliation, certificate maintenance, retries and delayed acceptance add work.
This is a code-derived lower bound, not measured production throughput.

The current application budget is 40 LoTW requests per five-minute window across
all tenants, including at most eight background requests. Even with no other work,
the six-request minimum gives optimistic ceilings of 1,920 contacts/day overall
and 384/day for background work. Actual throughput will be lower. These limits leave room for a small controlled trial, but they cannot establish the
100-users × 100-new-contacts/day target or fast 200,000-contact imports.

Before broader rollout, measure requests per completed contact, queue age and
fairness on the final release. Then evaluate bounded shared history/certificate
checks and separately reviewed multi-contact signing/upload, retaining per-contact
source proofs, durable ownership and uncertain-delivery protection. Revisit the
application budget only with vendor evidence and measured resource headroom;
raising it alone is not a throughput result. No budget was increased here.

## First scheduled run of `12f636b3`

The first completed scheduled run after deployment ran from **08:01:51 to
08:03:23 EDT** (12:01:51–12:03:23 UTC): 63 contact turns and 42 destination
classifications in 92.154 seconds, with zero attempt turns. It stopped at the
soft deadline after 600 D1 calls/1,837 statements and 86.767 seconds of database
wall time. Nine affected-contact errors were two LoTW-unavailable, two QRZ
history-scope mismatches and five QRZ missing-ADIF-time results; 21 vendor-budget
deferrals were separate. These remain held rather than becoming absent or
exportable. This verifies scheduled reconciliation on the new release, not the
export-proof/signing path or sustained throughput.

The new vendor-policy field invalidates prior reconciliation fingerprints once.
This run is a release follow-up, not a steady-state capacity sample.

## Release and earlier throughput observations

Signed revision `02e3dc89b99a5d7428c01b6a09596a105784eb11` deployed read-only
at 06:09:06 UTC as Worker `da7b7b70-6b7e-4cab-b9f6-f4b88f38390d`, at 100% traffic.
All **1,178 tests** and required checks passed in [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40068069314).
Independent 06:09:17–18 checks confirm healthy service, matching hashes for all
three assets and all seven export controls closed. Health reports no active
export mode and `sourceBoundaryVerified:false`. All 30 migrations through `0031`
are applied. The 380 LoTW identity claims have no uncovered mappings; attempts,
cutovers, proofs, pins and temporary guards were zero at release. All 4,500 source bodies
have incarnations, and 2,155 positive observations have no future or partial metadata.
At 06:13:06, the all-client policy remains in backfill with 218 operations and
2,950 QSO-stream records in the current epoch, zero ready sources and zero eligible
source members. The first larger-page tick advanced the saved cursor twice and
added 100 QSO-stream members in 2.977 seconds, without errors or vendor writes.
The 398 structurally eligible QRZ routes are not ready exports: source completion,
fresh proofs, current QRZ checks and explicit future authorization remain required.

The 04:51:11 UTC snapshot has 218 operations and 1,425 QSO-stream records in the
current epoch, still in backfill with zero ready sources, eligible exports,
attempts, cutovers or temporary guards. QRZ has 36 complete partitions and one
pending, but no retained covering plan: the earlier 98-record cover expired at
04:00:56 UTC. Partition-count reductions can include retention cleanup and do not
prove reconciliation completion. The 04:25 UTC protected backup and isolated
`0030` restore passed; [release evidence](deployment.md#mandatory-source-proof-release-2026-10-24-0511-utc)
records the checks. Production source handoff, refreshed exact trial evidence and
live acceptance remain outstanding. No sustained capacity target below is met
by these implementation or diagnostic results.
At approximately 04:58 UTC the pending QRZ partition was an expired, empty base
manifest awaiting cleanup or rebuilding; the complete count was not independently
verified for freshness.
The five baseline runs from 04:35 through 04:55 each committed four source pages,
with zero contact turns/errors and one budget deferral, in 9.635–31.143 seconds.
This shows ongoing read-limited baseline progress, not completed-contact throughput.

Historical retry release: signed revision `32e25b0ebc4d2ef5716bc3e60e166561a5b0931a` deployed
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

The signed follow-up first enlarges canonical policy-baseline backfill to 100
records per stream; full CI and production deployment are pending. Live forward
polling already uses 100 and remains unchanged; final drains, quarantine,
operation rereads and independent repair/destination rescans stay at 25. The
protected 200-record inventory established transport behavior, not runtime
checkpoint headroom. The bounded baseline follow-up adds explicit work limits
and same-cursor fallback as described below. Larger reread/rescan pages remain
separate work.

Shared source coverage needs explicit scan subscribers and atomic progress;
retained rows alone cannot replace destination cutover evidence or justify
merging divergent scan cursors. Even 100 QSO records per request leave an ideal
200,000-record canonical source pass at about 1.7 days with four background
requests per five minutes, before context, rescans, other accounts or retries.
Larger pages alone do not meet the proposed one-day import target.

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

#### Implemented: versioned all-client source baseline and handoff

This slice is **deployed read-only** in signed revision
`ce238cdcfea72ed5cbc7b624ec6a7efc01978154`, including the five baseline commits
through `339590e08e229b411f411d3878e921d4a02265df`.
The [first release CI run](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40055506398)
was cancelled after a delivery test fixture leaked `workerd`. Fixture fixes are
signed and pushed in `ce238cdcfea72ed5cbc7b624ec6a7efc01978154`;
[replacement CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40057488314)
passed all 1,031 tests and required checks. Worker `aabdd51c-1665-480a-8806-fe993967bc27`
deployed at 03:28:48 UTC; 03:29 checks confirm 25 migrations and all six gates
closed. The [LoFi evidence](evidence-lofi.md#all-client-inventory-audit-and-remaining-read-policy-work-2026-10-24-utc)
identifies a NULL-writer exclusion under `anyClient:false`. Switching only the
flag while retaining filtered opaque cursors could miss old rows or label
recovered history as new. Exports and `SOURCE_BOUNDARY_VERIFIED` remain disabled;
neither a successful audit nor a completed policy phase opens a gate.
1. **Versioned, fenced reader.** [Migration 0025](../migrations/0025_source_read_policy.sql)
   and the [policy helper](../src/source-read-policy.ts) retain logical account,
   epoch, phase and baseline generation, separately from operation-reread
   membership. Activation under the source poll lease archives the old cursor,
   increments its generation and installs tagged all-client backfill with
   incomplete context. Missing/wrong tags abort an old Worker's entire canonical
   checkpoint. Receipts, claims, immutable births and destination cutovers remain.
2. **Baseline and drain.** [Intake](../src/intake.ts) uses [all-client reads](../src/lofi.ts)
   in backfill and forward modes, marking exact current versions even when their
   bodies are unchanged. Baseline, drain and quarantine use background admission;
   newly discovered rows remain historical throughout these phases. Complete
   empty phase transitions may continue within the same invocation, subject to
   the shared request, lease and deadline limits.
3. **Quarantine and handoff.** Unseen QSO/base/event metadata is held in bounded
   batches, never inferred deleted. Only prepared attempts are cancelled; sent
   uncertainty and identity ownership remain. Current complete forward coverage,
   no unclassified old dependency and the atomic checkpoint establish the ready
   phase. Positive unchanged reappearance can release a membership hold. Reset
   and expiry paths preserve tags or start a new baseline; ordinary bearer renewal
   does not change the logical source epoch.
4. **Membership and provenance guards.** [Migration 0026](../migrations/0026_source_read_guards.sql)
   and the final attempt check require current contact/base/event membership for
   activated policies. Legacy rows without context generation must be reobserved.
   Semantic or server-version changes by an old noncanonical reader clear
   membership; identical-version ciphertext renewal preserves it.
   [Cutover proof](../src/cutover.ts) requires a new birth after both the destination
   cutover and policy baseline. Old immutable births cannot regain eligibility
   merely because the policy resets.

**Transition limitation of `0025`/`0026`:** their stage/dispatch and cutover policy
fences are dormant when no policy row exists. Scheduler/intake selects unactivated
sources for baseline work. Deployed migration `0030`
adds mandatory current ready policy and per-contact proof requirements to staging
and dispatch, including old-worker and null-context paths. This closes the local
write-authority gap; it does not establish the upstream source boundary or narrow
the global gate's cutover/no-query effects.

Focused validation covers old/new Worker overlap, rollback, phase resumption,
historical drain discoveries, stale leases/account changes, missing dependencies,
independent rereads, prepared versus uncertain work, reappearance and expiry/gap
resets. Service fixtures preserve the shared vendor limits and reject responses
that outlive their leases. Production phase completion and resource measurements
remain unproved. The first scheduled run activated a policy at 03:30:43.295 UTC;
the 03:31:37.477 snapshot showed backfill with 25 operations and 25 QSOs in the
current epoch and no ready policy. That run completed in 2.263 seconds, with two
source pages, 50 records, zero contact turns/errors/deferrals, 88 D1 calls,
295 statements and 86,150 reported rows read. It stopped idle; the reason for
stopping after two pages needs confirmation before extrapolating a rate.
The 02:48:09 UTC protected
backup passed an isolated restore with both pending migrations, integrity and
foreign-key checks, three current credential decryptions and repeated quarantine.
Fresh-positive collection, witness storage, canonical completed-drain markers,
immutable proofs, indexed observation anchors and shared cohort coordination are
signed and pushed through `e16f987441fc`, with exact-key lookup correction
`3d7b0cac782a`. All 1,098 tests pass and the foundation deployed read-only at
04:13 UTC with migrations `0027`–`0029`. Mandatory database proof binding,
last-moment dispatch validation and scheduler integration deployed in `5a416de5`
at 05:11 UTC, as described below.

The 04:18:08 UTC production snapshot has all 218 operations and 800 QSO-stream
records in the current epoch, still in backfill with zero eligible exports.
The 04:15 run processed four source pages and 110 records in 15.674 seconds,
with 138 D1 calls, 723 statements, 14.573 seconds of D1 wall time and 419 ms of
reported SQL time. No errors or attempts occurred; one vendor-budget deferral
was recorded. This is an individual baseline run, not sustained capacity acceptance.
The later 04:51:11 UTC snapshot has 218 operations and 1,425 QSO-stream records,
still in backfill with no ready source or eligible export. Phase completion and
handoff must be observed before selecting a production export cohort.

At the initial 03:28 baseline deployment, background pages used **25 rows** with at most **four shared LoFi
background requests per five minutes**. A QSO pass alone therefore has ideal
lower bounds of about **3.3 hours for 4,000 rows** and **6.9 days for 200,000**;
forward drain, context, competing accounts and retries add time. The protected
[inventory audit](../scripts/source-inventory-audit.ts) requests 200 rows per
stream, but it neither changes runtime page size nor establishes production
checkpoint capacity. The later bounded 100-record follow-up below is a separate change.

The 03:42:54 UTC snapshot had current membership for 100 operations and 100
QSO-stream records, including three events. The 03:35 run committed three source
checkpoints and 100 records; the 03:40 run committed two checkpoints and 50 records.
Thus the first run does not establish a fixed one-useful-page pattern. At a
hypothetical one useful 25-row QSO page per five minutes, the QSO pass alone takes
13 hours 20 minutes for 4,000 rows or 27 days 18 hours 40 minutes for 200,000.
Two useful pages halve those times; four give the ideal lower bounds above.
These are arithmetic scenarios, not observed sustained rates; events and tombstones
also occupy the QSO stream.

HaLo's inspected `eb1a54ced637bfdd3c5b361a31df0e843edf9867` client distinguishes
[page-loop delay from idle check period](https://github.com/ham2k/halo/blob/eb1a54ced637bfdd3c5b361a31df0e843edf9867/packages/halo_core/lib/src/sync/sync_engine.dart#L119).
Its [response parser](https://github.com/ham2k/halo/blob/eb1a54ced637bfdd3c5b361a31df0e843edf9867/packages/halo_core/lib/src/sync/sync_engine.dart#L1204)
reads camelCase metadata, snake_case metadata, then `meta.flags` snake_case; loop
delay is milliseconds and permits zero. This is primary client evidence, not proof
of the deployed server's current values or the cause of Ferry's empty responses.
Ferry does not yet honor these knobs. Next measure validated numeric timing/batch
hints, per-stream useful/empty-incomplete counts, cursor-advanced booleans, response
bytes and maximum checkpoint wall/SQL time. Do not log raw cursors or records.
Then evaluate bounded per-source pacing and a separately measured page-size change
without raising shared vendor limits or splitting atomic checkpoints.

With witness storage, the local 100-operation/100-QSO fixture uses nine D1 binding
calls and 1,508 statements in one atomic checkpoint, versus 1,308 statements in the
deployed baseline. This proves a bounded local transaction, not production headroom
under D1's execution limits.

#### Bounded 100-record baseline follow-up (deployed 06:09 UTC)

Signed `b98bf8e50602` selects 100 records per stream only for canonical policy
backfill. Shared LoFi allowance remains four background requests per five minutes.
The existing 2 MiB response cap is supplemented by at most 100 rows per side,
1 MiB aggregate serialized record bytes, 1,800 checkpoint statements including
guards, and 60 seconds for preparation under the 90-second poll lease. Every body,
membership, birth, context change and cursor still commits in one guarded batch.

A deterministic response/record/byte/statement size failure can retry once at 25
from the identical original cursor, only before any checkpoint and with 30 seconds
of preparation time remaining. Both requests consume the same shared budget.
Deadline, protocol, lease or uncertain checkpoint failures never enter this retry.
No response is truncated and no cursor is advanced for discarded preparation.

The new nine-case fixture covers restart continuation, fallback, overflow on the
last budget slot, lease rollback of 200 rows and a lost checkpoint acknowledgment.
The 100-base/100-event case commits 1,708 statements in one local batch (389 ms in
the recorded run). The combined intake/policy/baseline suite passes 78 tests, and
22 adapter/drain-marker tests pass. The first full suite exposed one scheduler
fixture expecting the old size; that fixture is corrected. All 1,178 tests and
required checks pass on deployed `02e3dc89b99a`.

The first production tick, 06:10:43–46 UTC, committed two pages and 105 raw
records in 2.977 seconds, adding 100 QSO-stream members and advancing the saved
cursor generation from 461 to 463. It had no errors or deferrals and stopped idle,
with 84 D1 calls, 631 statements, 2.671 seconds of D1 wall time and 447 ms reported
SQL time. Policy membership reached 218 operations and 2,950 QSO-stream records;
1,332 QSO-stream records remain outside the current epoch. Attempts, cutovers and
temporary guards remain zero. This verifies real continuation but not a sustained
speedup: the run used two pages despite a four-request ceiling. Investigate that
idle stop and measure further ticks before claiming throughput acceptance.

The second larger-page tick, 06:15:44–06:16:07 UTC, committed four pages and
410 raw records, adding 400 QSO-stream members under the unchanged shared request
allowance. At 06:18:24, current membership reached 218 operations and 3,350
QSO-stream records, with 932 QSO-stream rows still outside the epoch. The run had
zero errors and one budget deferral; its 23.252 seconds included 21.925 seconds
of D1 wall time across 141 calls and 2,226 statements (1,061 ms reported SQL time).
No attempt, cutover or temporary guard remained. The first tick was not evidence
of a fixed two-page cap; empty-incomplete responses can intentionally yield, but
current aggregate telemetry cannot prove the specific cause of that first stop.
Two runs do not establish sustained import capacity or completed source handoff.

The next tick, 06:21:04–06:22:39, reached the soft deadline after three pages,
310 raw records and 300 new QSO-stream members. It had no errors or deferrals.
D1 RPC wall time was 86.520 seconds across 96 calls/1,670 statements; 877 ms of
SQL timing was available for 1,625 statements. The 06:25:43–58 tick then returned
to four pages/410 records and 400 new members in 15.419 seconds, with no errors
and one budget deferral. At 06:26:33, 4,050 QSO-stream rows were current members
and 232 remained. These runs show useful larger-page progress and substantial
latency variation, not a fixed service rate.

The 06:30:44–06:31:05 run committed four pages and 237 raw records, adding
232 QSO-stream members and reaching quarantine. At 06:35:44.881 the normal
forward drain and quarantine handoff reached `ready`, with all 218 operations
and 4,282 QSO-stream rows in the current epoch and zero unseen retained rows.
The same scheduler turn resumed reconciliation: 62 contact turns and 60
destination classifications in 27.187 seconds, with four errors and 50 deferrals
before the database budget stop. It made 871 D1 calls/2,179 statements and spent
24.125 seconds in D1 wall time. This completes the baseline observation; it does
not establish a sustained classification rate or export readiness.

Post-handoff reconciliation continued on the normal schedule. The 06:40, 06:45,
06:50 and 06:55 ticks processed 63, 84, 120 and 140 contact turns respectively,
with 49, 88, 151 and 186 destination classifications. Durations were 32.703,
89.968, 56.121 and 94.336 seconds. The first three stopped at the database budget;
the last stopped at the deadline. The 06:55 tick made 830 D1 calls containing
3,997 statements, with 85.142 seconds of database wall time, three errors and
41 deferrals. These are processing turns, not unique completed contacts.
The 06:59 snapshot still had 3,922 due background contacts, and the remaining
vendor and precision exceptions require their own resolution.

Next attribute D1 latency by operation (`batch`, `first`, `all`, `run`, `raw`),
including aggregate count, wall time, maximum and fixed latency buckets, and time
scheduler selection/admission/lease work. No SQL, parameters or identifiers are
needed. The slow tick spent only 22.243 seconds in source polling; roughly 48.7
seconds sat outside named stage timers. Statement counts are not network-call
counts, and missing SQL metadata prevents labeling all RPC wall time as network
latency. Simply enabling [Worker placement](https://developers.cloudflare.com/workers/configuration/placement/#review-limitations)
does not accelerate the scheduled handler: placement applies to fetch handlers.

At four full 100-row QSO pages per five minutes, the ideal single-stream floor
would be 50 minutes for 4,000 rows or 41 hours 40 minutes for 200,000 (about 1.7
days). These are arithmetic lower bounds, not measured service guarantees; events,
operations, empty pages, drain, other accounts and retries consume capacity.

The before-change snapshot at 05:48:38 UTC has 218 operations and 2,450 QSO-stream
members, with 1,832 retained QSO-stream rows still outside the current epoch. Five
completed ticks from 05:25 through 05:45 each committed four pages and 110 raw
records, zero contact turns/errors and one budget deferral. Their total durations
were 6.733–28.968 seconds (median 8.248); the latest used 139 D1 calls, 724 SQL
statements and 7.518 seconds of D1 wall time. Compare membership progress as well
as elapsed time after deployment; raw source records include repeats and events.

#### Deployed mandatory source proofs and bounded progress

The deployed implementation requires short-lived positive evidence for the
selected QSO, base operation and every retained live event, even an event that
does not change the effective projection. A hard purge may leave no tombstone;
all-client forward completion alone cannot prove continued upstream presence.
Proofs bind current logical scope, credentials, policy epoch, source and
reconciliation versions, and post-drain sync/context generations. A fresh complete
canonical drain must follow collection; reloading the exact dependency set checks
both supplied and newly present members. Immutable attempt pins and final
post-admission validation enforce the same proof at staging and dispatch.
Expiry is bounded by the oldest original positive request start plus five minutes.
Neither a retained body nor an empty drain renews that clock.

Normal service can select up to six live contacts for shared evidence while
dispatch remains sequential; background preparation shares two attempt slots.
Each source turn permits at most **four actual source HTTP attempts**, including
authentication/renewal and the reserved final drain. Only the collector's exact
`request_budget` outcome permits a fully witnessed subset to proceed through that
drain, dependency reload and atomic mint. Other read, scope, freshness or drain
failures publish no proofs. Local real-D1 tests demonstrate a non-prefix subset
of three out of six contacts progressing in four requests, then the remaining
three on a later turn; this is bounded correctness evidence, not a service rate.

Prior budget-held contacts receive a singleton turn. If that attempted singleton
again reaches the collection budget with zero ready contacts, an exact-version
ten-minute queue delay yields to neighbors on the ordinary five-minute schedule.
This prevents one large closure repeatedly occupying the first slot. A single
contact whose dependency closure needs more than **three collection reads** still
remains held; incremental collection across turns is future work. These changes
raise neither shared vendor budgets nor positive-proof collection page sizes, and
do not open any gate. Canonical baseline page sizing is a separate change above.

Production baseline/drain/quarantine handoff is observed. The 08:12:53 protected
diagnostic also minted a current proof and verified fresh QRZ absence for the same
contact. Before live acceptance, refresh those expiring checks for the exact
source/contact/destination cohort. The protected 08:14 UTC backup passed isolated
restore with all 30 migrations, integrity/foreign-key checks, three current
credential decryptions and repeated quarantine, preserving 380 claims, one source
proof and its retention row, and zero attempts/cutovers. No external write
has occurred. Exact small-cohort acceptance, 100-account steady-state capacity and
200,000-contact end-to-end completion remain unproved; later work includes
incremental evidence collection, pacing and separately measured larger source pages.

The collector compatibility fix is deployed in `12f636b3`: nominal
requests remain 25, while responses may contain up to 100 records per stream to
accommodate complete timestamp groups. A combined 1 MiB parsed-record cap and the
existing 2 MiB transport cap bound each response. Every returned row validates
before new witnesses publish. The four-request budget, reserved final drain and
120-second collection deadline remain unchanged; larger ties still hold. All
1,338 tests and required release CI checks pass. Deployment alone supplies no
new sustained production throughput measurement.

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

## Historical comparison index prototype (2026-10-24)

The first completed run of deployed revision `0dad1031` at 13:45:43–13:47:22 UTC
processed 84 contact turns, classified 113 destinations and adopted 44, with zero
errors, deferrals or attempt turns. It stopped at the deadline after 98.845
seconds, reporting 419 D1 calls, 2,590 statements, 1,876,280 rows read and 97.938
seconds of database wall time. This confirms continued read-only draining, while
database work remains the main throughput limit; it does not validate sustained
capacity or the not-yet-integrated comparison index below.

A protected in-memory SQLite prototype seeded 200,000 synthetic source contacts,
10,000 remote records, 10,000 operation versions and 100 coverage scopes. Candidate,
reverse-competitor, dirty-context and unknown-scope queries used keyed index
searches without a source-table or ciphertext scan. Warm local medians were
0.0035–0.0050 ms, with 40–118 SQLite VM instructions for the tested lookups.
Seven scenarios covered a unique pair, competing arrivals, body and context
changes, localized unknown scope, incomplete coverage and overflow at 101 rows.
The entire synthetic run took about 2.34 seconds and made no live calls or writes.

This validates a bounded lookup shape, not production D1 latency or a complete
200,000-contact import. The synthetic prototype retains timestamps for comparison;
production still needs its privacy-preserving index representation, incremental
backfill, old-worker invalidation, exact dependency/coverage fences, permanent
historical ownership and atomic competitor rechecks. Measure construction cost,
dense cohorts and real D1 binding/SQL work before claiming end-to-end capacity.
Code review supports a smaller production index: projected worked call and time
come only from raw QSO fields, so versioned HMAC call/minute keys can find a bounded
cohort whose current contexts are then projected on demand. Operation changes
invalidate a comparison clock without rebuilding those weak keys. Unknown or
unprojectable competitors and elapsed retention expiry still require explicit
holds and final transaction checks. No production implementation is claimed.
See the [historical matching rollout](bootstrap.md#historical-association-and-vendor-matching).

## Platform constraints informing this plan

[D1 batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
reduce client round trips and execute transactionally; reducing RPCs does not
eliminate SQL work or [D1 database limits](https://developers.cloudflare.com/d1/platform/limits/).
Batch members are not separate binding RPCs: Cloudflare's
[D1 binding implementation](https://github.com/cloudflare/workerd/blob/main/src/cloudflare/internal/d1-api.ts)
sends the statements together in one request. Ferry therefore budgets binding
calls and retains SQL-statement counts separately. The D1 limits table still
lists 1,000 queries and links to Workers subrequests, while the
[February 2026 platform change](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/)
and [current Workers limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests)
set the paid default at 10,000 subrequests. Retain Ferry's conservative 850-call
soft budget. D1 still limits the **entire batch to 30 seconds**, and applies
100 bound parameters and 100 KB SQL to each member. The 1,308-statement fixture
does not establish production batch duration; measure it before increasing
background pages, preserving the atomic page checkpoint on any failure.

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
