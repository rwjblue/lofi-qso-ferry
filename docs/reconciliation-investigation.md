# Reconciliation exceptions and capacity

## Precision matching investigation (2026-10-24)

The matching corrections deployed read-only at **2026-10-24 08:51 EDT** as signed revision
`ba8c982a0b67b97e354f1bcb4acc8efe50729097`, Worker `6b07bcf7-ac24-4bcb-abf4-be43766c8938` at 100% traffic.
All **1,353 tests** and required release checks passed in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40094384509).
Independent readback confirms all eight export controls closed, healthy HTTPS
and matching assets. There was no migration or vendor write. The grid-compatible
LoTW association, exact decimal frequency conversion and valid numeric zone
comparison are now available to normal reconciliation. Their policy version wakes
held work once; the 2,858 grid and 87 artifact-related frequency counts describe
the investigation cohorts, not a claim that every row has already reconciled.


The first matching-release cron completed **12:55:44–12:57:13 UTC** with
147 contact turns, 262 destination classifications and **99 LoTW adoptions** in
88.756 seconds. It stopped at the database budget: 878 D1 calls, 5,018 statements
and 80.687 seconds of database wall time. Three affected-contact errors and 21
deferrals remain; this sample does not establish sustained capacity. The 12:58:08
snapshot has 479 LoTW adoptions and identity claims (up from 380), with no uncovered
mapped identities, export attempts, cutovers or temporary stage guards. Matching
policy version 2 is active. QRZ remains held for the separate association work.

The 08:16 EDT production reason histogram identifies a systematic matching-policy
problem. `history_ambiguous` combines competing identities with ordinary differences
in recorded precision. It must not be interpreted as a count of duplicate contacts
or contacts that each require manual review.

| Destination | Held reason                                | Destination rows |
| ----------- | ------------------------------------------ | ---------------: |
| LoTW        | Compatible lower grid precision            |            2,858 |
| LoTW        | Frequency finer than the query's precision |               93 |
| LoTW        | Other ambiguity or unavailable location    |                6 |
| LoTW        | Grid differs or is absent                  |              161 |
| QRZ         | Minute-only destination time               |            1,578 |
| QRZ         | Generic nonunique/exact-identity failure   |            1,853 |
| QRZ         | Other ambiguity or unavailable location    |               26 |

These are per-destination rows at one snapshot, not disjoint source-contact counts.
The query classifies persisted reasons; it does not independently revalidate every
source/remote pair. Earlier protected observations already reproduced an exact
LoTW identity with a matching shorter grid prefix and QRZ records with minute-only
times. The generic QRZ category still needs a comparison-field breakdown.

The implementation used the same full-detail expectations for historical
association and proof of a submitted payload. A valid shorter Maidenhead grid
describes a region containing its longer extension; it does not establish an
identical full station projection. Those distinctions matter for upload receipts,
but compatible grid precision alone should not prevent recognizing a uniquely
identified existing LoTW contact. See the [ADIF grid type](https://adif.org/316/ADIF_316.htm#GridSquare)
and [LoTW query fields](https://lotw.arrl.org/lotw-help/developer-query-qsos-qsls/).

The narrow correction requires one exact normalized LoTW identity, a valid
six-digit time, valid four-, six- or eight-character grids with either value a
prefix of the other, and agreement on every other currently compared field.
It retains the original source and remote values, source baseline and remote hash,
and the existing atomic ownership/collision protections. It establishes a
read-only historical association. Exact signing, submission observation and
first-insert checks retain their existing requirements. A matcher-policy version
wakes held work once so the normal worker can reconsider it.

A protected offline audit of all 93 frequency-held contacts in the hash-verified
11:48 UTC backup found 87 binary-conversion artifacts and six genuine finer-
precision values. The numeric kHz-to-MHz division can stringify a one-decimal
kHz input with 15 or 16 MHz decimal places. Decimal unit shifting restores the
source's meaningful precision without rounding: 79 cases have four MHz decimals,
eight have five, and six retain six. All 93 source projections matched their
saved ledger generations. No remote request or production write occurred.
The correction must retain those six genuine precision holds.

A separate offline QRZ audit projected 20 evenly spaced generic-identity holds
successfully against their saved source generations. Every source time had six
digits; 18 grids had eight characters and two had six. The snapshot contained no
retained history pages or scoped partitions, so it could not reconstruct remote
candidate comparisons. A generic reason can hide compound differences: the
minute-only diagnostic currently applies only if every operating field also
matches. It does not establish that multiple candidates were actually found.

A newer verified 12:29 UTC backup contains 24 retained QRZ pages. A bounded
repeat on the same 20 sampled contacts opened seven relevant pages, totaling
376,255 encrypted-payload bytes. Ten contacts had comparable records and unchanged
saved source generations: all ten reproduced generic holds with six-digit source
and four-digit remote times in the same minute. Eight also had matching-prefix
eight-to-six-character grids, one had coordinate differences, and one had an
additional neighboring record at another time. No frequency differences occurred
in those ten comparisons. Seven samples had no retained matching candidate (not
evidence of absence); three were excluded because their source generation changed
with the corrected frequency projection. These observations establish compound
precision holds in the bounded sample, not a backlog-wide adoption or uniqueness
claim. The audit made zero vendor calls or production writes.

QRZ minute precision needs a separate historical-association design. Appending
seconds would fabricate precision, and the outbound identity-claim helper correctly
rejects four-digit times. The future path must preserve the actual LOGID and
timestamp precision, exclude competing source and remote candidates, and reserve
the historical association durably without granting insert/correction authority.
The generic identity category and incomplete field evidence remain investigation
work. No production flag or held row was changed by the histogram query.

### Published vendor rules and revised implementation plan (2026-10-24)

The owner requested vendor-standard time tolerances and accepts a valid shorter
historical grid as a subset of the more precise LoFi grid. Research changes the
next slice from same-minute-only matching to the published **±30-minute** windows.

| Service and purpose                                                                      | Published rules                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [QRZ confirmation](https://www.qrz.com/docs/logbook30/confirmations-how)                 | Same two calls, UTC timestamps within ±30 minutes, same band and primary mode; submodes use their parent. Other fields may matter for awards.                                        |
| [QRZ own-log ADIF duplicates](https://www.qrz.com/docs/logbook30/adif-import)            | Matching callsigns, mode and band within ±30 minutes. Import replaces duplicates except confirmed records. The API's replacement contract is different.                              |
| [LoTW confirmation](https://lotw.arrl.org/lotw-help/frequently-asked-questions/)         | Reciprocal signing calls, starts within 30 minutes, same band, exact mode or mode group; satellite records require matching satellite and SAT.                                       |
| [LoTW logger reconciliation](https://lotw.arrl.org/lotw-help/developer-query-qsos-qsls/) | Compare date/time, band and worked call; modes may have been mapped. ARRL suggests mode only when needed to resolve multiple local matches, without defining a local time tolerance. |
| [eQSL confirmation](https://www.eqsl.cc/qslcard/FAQDisplay.cfm?Topic=1058)               | Its official FAQ permits time differences up to ±1 hour. This is a separate service's confirmation policy, not Ferry's selected window.                                              |

Implement a historical-only ±30-minute candidate policy, including adjacent UTC
dates and recorded minute intervals. Keep exact raw times and modes and require
uniqueness in both source-to-remote and remote-to-source directions; no closest-time
tie-break. Frequency, location detail and mode mapping are not interchangeable
with durable upload identity. Report any supplied contradictory location field.
The [ADIF grid definition](https://adif.org/316/ADIF_316.htm#GridSquare) permits
2/4/6/8-character locators, so the next shared historical location helper includes
valid two-character containing cells as well as the deployed 4/6/8 precision policy.
New exports retain all supported source precision.

The broader policy needs a bounded opaque source comparison index with current
body/context/policy coverage, and separate durable historical remote ownership.
Reverse uniqueness must inspect the window around each remote candidate, which
can reach approximately 60 minutes from the original source. Widen LoTW's retained
inventory across day/week boundaries before relying on those candidates. Keep
outbound claims, first-insert absence, upload receipts and corrections on their
existing exact contracts. QRZ's API guide does not establish the import page's
replacement rules for API writes. These remain implementation tasks, not claims
that ±30-minute production adoption is already active.

### Next QRZ association slice

Treat a four-digit time as its UTC minute interval and retain the original value.
Require a unique compatible source-to-remote association in both directions before
recording a match. An exact candidate plus a competing coarse-time candidate must
remain held. A selected processing batch alone cannot establish source uniqueness.

Build a bounded, incrementally maintained source comparison index tied to current
source policy, body incarnations, projection version and operation/event context.
Its opaque keys should locate possible competitors without retaining another copy
of private logbook fields. Unknown or stale possible competitors prevent an
association; incomplete retained history prevents any absence claim.

Reserve the actual historical QRZ LOGID independently of the exact-second outbound
identity namespace, preserving tenant/destination scope and ownership through
retention, reconnects and source edits. The existing mapping-uniqueness constraint
and competing-owner quarantine remain additional defenses. Never manufacture `00`
seconds to fit the outbound claim helper.

Separate association evidence from full projection agreement. Preserve minute and
grid precision and missing/conflicting field explanations. An association can
establish that history is already present while corrections, replacement, insert
authority and upload acceptance still require their own current checks. Validate
new-source arrivals, context changes, competing source UUIDs, duplicate LOGIDs,
partial inventories, midnight boundaries and concurrent claims before rollout.

An offline prototype over the newer backup projected 3,833 QRZ-routed sources
and read 24 retained QRZ pages. Among 2,610 usable distinct remote records, it
found 2,012 conditionally compatible one-to-one pairs in both directions; 1,948
also retained their saved source generation. Every pair needs minute-level
association, and 814 additionally use nested grids. This is evidence that an
interval-based association design can address a substantial part of the backlog.
It is not permission to adopt these pairs: three source records were unprojectable,
44 remote rows were unusable, and retained coverage was incomplete. Unknown
possible competitors must be scoped and checked before runtime uniqueness can be
established. No vendor request or production write occurred.

The follow-up localized those unknowns using only independently valid worked
callsigns and UTC-minute scopes, with station, band, mode and route left unknown.
All three unprojectable sources and 44 excluded remote rows retained that partial
scope; none overlapped the 2,012 compatible pairs or their 1,948 unchanged-source
subset. The remote exclusions came from the prototype's deliberately narrow mode
set, not an assertion that the vendor records were invalid. This supports checking
unknown competitors within affected cohorts instead of blocking every contact
because an unrelated projection failed. Runtime-fenced uniqueness and authority
remain unproved by an offline retained subset. Five focused prototype tests pass.

A second offline prototype applies the published ±30-minute window and verified
QRZ primary-mode aliases to the same 3,833 routed sources and 24 retained pages.
It finds 2,007 conditionally compatible bidirectionally unique pairs, including
1,943 unchanged source generations, versus 2,012/1,948 with same-minute association.
Two pairs become unique and seven formerly unique pairs gain competitors. Before
frequency/location filtering, eight competing components contain 14 sources and
16 remote records. Widening the window therefore reveals repeated-contact
ambiguity; it does not simply turn every hold into a match.

The wider partial scope of one unprojectable source can overlap eight otherwise
unique pairs. Excluding those, and requiring uniqueness before field-compatibility
filtering, leaves 1,994 conditional pairs / 1,930 unchanged generations. No unique
pair requires nonoverlapping recorded time intervals or a two-character grid in
this retained sample. All 44 earlier remote-mode exclusions resolve as explicit
legacy primary-mode aliases. Five prototype tests pass. These are incomplete
retained-snapshot estimates, not runtime-fenced adoption, current vendor evidence
or export authority. No live request or production write occurred.

A separate static LoTW reproduction also found that normalizing an unrelated
unsupported-mode neighbor can block an otherwise exact match. That finding is
tracked separately from the deployed grid/frequency corrections; its production
prevalence has not been established. Any fix must isolate clearly unrelated
neighbors without treating unknown overlapping mode evidence as absence.

## Earlier investigation (2026-10-23)

Investigation date: 2026-10-23. Production revision at investigation start:
`634517d0`. Exports remain disabled. This report separates observed evidence,
implementation work and remaining acceptance checks; it does not authorize
logbook writes or treat a partial inventory as absence.

## Implementation status

The source-context index and QRZ decoding fixes deployed read-only in signed
revision `cec488febcad419ff55a4aa677619a1aef61fcd5`, including index commit
`3719f43979fffd1b5890d6d10b653720f8eb188e`. Worker
`3c1f615e-bf2d-403f-9d54-1aed519da582` was created at
`2026-10-23T21:29:17.720637Z` and activated at `21:29:18.881251 UTC`, receiving
100% of traffic. All 553 tests and required checks passed locally and in
[release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40025951354).
Independent 21:29:45 UTC verification confirms all five gates closed, HTTP 200
health and matching assets. The 21:29:44.834 UTC D1 snapshot confirms twenty-one
migrations through `0022` and zero attempts, cutovers or temporary guards.
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

The preceding diagnostic follow-up deployed read-only at 21:03:35 UTC in signed revision
`57a64b02285f55f3dee25fdf52674ac54cd3893f` (including QRZ change `8b1cdcc`),
Worker `25628683-a870-40e5-835f-e697adbc7f44`, then at 100% traffic. All 548 tests
and required checks passed locally and in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40023892103).
Independent 21:05:18 UTC verification confirmed closed gates, HTTP 200 health and
matching assets. No new migrations were needed; twenty were then applied through
`0021`. The following refined-counter run belongs to that earlier release.

This follow-up changes diagnostics, not scheduler behavior or write uncertainty.
QRZ errors distinguish fixed parse/body categories without retaining private
response content. D1 telemetry aggregates reported SQL duration, metadata
coverage, rows and retry attempts, with only allowlisted database regions.
`first()` and `raw()` behavior is unchanged. SQL duration describes the last
attempt only; missing metadata, earlier retry work and overlapping requests mean
the difference from observed database wall time is not a pure network-delay
measurement.

The first refined-counter run, 21:05:42–21:07:13 UTC, completed 104 contact
turns and 158 destination classifications, including ten adoptions, in 91.239
seconds. It recorded 33 errors and four deferrals. QRZ entity decoding accounts
for eleven diagnostic events affecting twenty history routes; ten separate QRZ
rejection events affected twelve routes. One LoTW unavailable event and four
budget-deferral events account for the remaining categories. Events are not
physical request counts. This run localized the entity failure to numeric Unicode
validation; the bounded probe below subsequently established a specific input shape.

D1 used 702 RPCs and 3,624 statements, with 84.089 seconds of wall time and
97.357 seconds of cumulative request time. Metadata covered 3,395 statements:
1.425 seconds of reported SQL execution, 1,004,089 rows read, 5,818 rows written,
zero additional statement retries, and ENAM service for all covered statements.
The uncovered 229 statements and last-attempt-only SQL reporting prevent
attributing the wait gap purely to network latency. This points to further
round-trip reduction and query profiling, not a reason to raise budgets.
The 21:08:59 UTC snapshot confirms zero attempts, cutovers or temporary guards.

The source-context index and QRZ decoding follow-up deployed at 21:29 UTC in
`cec488f`, after all 553 tests and required local/CI checks passed.
Migration `0022_source_context_members.sql` adds an index on
`(tenant, source, operation_id)` restricted to `kind='operation' OR is_event=1`.
On 4,000 contacts, the exact context fence reads **4,003→3 rows** and the context
query **4,004→4 rows**. Regressions preserve deleted-event filtering and rejection
of missing current-event ciphertext, revoked payloads and expired context.
This is a local scan reduction, not a demonstrated fix for
the 84.089-second production database wait.

One budgeted read-only QRZ FETCH on 2026-10-23 observed 22 numeric entities:
seven high surrogates, seven low surrogates and seven adjacent valid pairs, with
zero out-of-range values. QRZ's read decoder now combines those valid adjacent
UTF-16 pairs once, losslessly; lone, reversed, separated or out-of-range entities
remain errors. A field-boundary check rejects a declared ADIF length that splits
the resulting character. Generic ADIF length rules, ASCII export encoding and
exact identity checks remain unchanged.

One post-patch probe still produced an unlocalized generic protocol failure.
A later single full-client FETCH parsed 121 records with all fields well formed
and the same aggregate entity/pair counts. No raw private payload is recorded
here. These bounded samples do not establish that the same inventory partition
was revisited, that every QRZ parser failure is repaired, or that any history
association/export is authorized. Production exception counts still need review.

Before attributing another production scan reduction, add bounded counters by
fixed query family: projection/adoption guards, inventory reads/saves, source
invalidation and cleanup. Record statement metadata coverage, rows and SQL time
without retaining SQL text, parameters or returned data. Attribute binding wall
time once per RPC family, not once per statement in a batch. The first new run
read 9,555 rows per contact turn versus 9,401 in the preceding run, with seventeen
successful inventory advances versus three; changed workload prevents causal
attribution from these aggregate samples.

The next round-trip reduction is bounded leaf-read batching, not implemented yet.
Up to four leaves per RPC could turn 40 leaf reads into ten and reduce the
mixed-date fixture from about 57 to 27 cohort RPCs. This estimate requires one
request-wide **8 MiB budget for encrypted and index reads**, one shared candidate
cap, SQL payload caps and retained per-leaf epoch/evidence guards. Naively
combining four maximum-size leaves is unsafe once index data is included.
Acceptance must cover budget exhaustion, expiry/revocation/replacement races,
concurrent epochs, deadline/failure draining and unchanged classifications, while
incomplete reads remain unable to establish absence. Measure bytes, SQL work,
RPCs and production database time independently before claiming a speedup.

The second slice deployed read-only at 20:44:21 UTC in signed revision
`8863bd9439681122e71bc3c2a31174a72aa30bb2`, Worker
`004edefd-d2a5-462c-b079-1cf8d04e6b05`, at 100% traffic. All 531 tests and required
checks pass locally; [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40021495718)
passed all 531 tests and required checks. Independent verification at 20:44:30 UTC confirms all five gates
closed, HTTP 200 health, matching assets, twenty migrations through `0021` and
zero attempts, cutovers or temporary guards. The first new cron result follows below.

The final integrated local mixed-date fixture covers
20 contacts in 20 distinct weeks across both destinations: **57 cohort RPCs**,
**128 whole-tick RPCs** and **716 SQL statements**, with all 40 classifications
preserved and zero vendor reads or writes. Outcome and evidence-fence regressions
pass. This extends the database-amplification evidence beyond a same-week cohort;
sustained production measurement for this slice remains open.

Cold history still permits at most four concurrent partition advances across
cohorts. Deadline and invariant failures stop new work, while started saves and
lease releases finish before returning. Bounded-cold concurrency, deduplication,
deadline and failure-draining regressions pass.

Fixed failure categories now distinguish shared diagnostic events from affected
routes. `throughput.failures` uses fixed `stage:vendor:code` keys and separate
`events`/`affected` counts. The same error object reused within one category
counts once as an event and once for each affected route; separate error objects
count separately. These counts are not physical network-call counts. Five helper
tests and three scheduler diagnostic regressions pass, with TypeScript/scoped
Biome checks. Only fixed codes serialize; arbitrary messages, stacks, causes,
private contact data and credentials do not. `inventoryFetches` continues to count
successful progress, so zero does not prove zero attempted vendor requests.

Independent background account/source admission and migration `0021` are
deployed. Lifecycle-maintained eligibility and indexed bounded
selection choose one oldest unleased source per least-recently-admitted account.
A monotonic turn sequence and one atomic three-statement batch advance account
and source before work, fenced by active state, exact snapshots and the current
source-cycle lease token, fence and expiry. Seven module tests pass, including
100 accounts with 2,000 import rows, multiple sources, restart/same-clock turns,
lifecycle changes, stale leases and index use. Six focused service regressions
also pass: slow imports rotate across fresh invocations, a paired backfill follows
slow forward history, and an early admitted source is not polled again in its
later live turn. Existing lane rotation, lost-lease and idle behavior remain
covered. Startup or the initial live pair can exhaust the deadline before
background admission; this does not establish general phase fairness.
Full live fairness, adaptive polling, targeted dependency parking and the
complete workload matrix remain open. This account/source admission is distinct
from the earlier source-lane rotation. The next three production measurements
belong to this admission release, before the 21:03:35 diagnostic follow-up.

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

A separate aggregate check at 20:52:23 UTC found 177 completed operation
contexts and 41 deleted operation records. All 41 raw pending operation rows
were tombstones; zero operations were eligible for rereading. The dashboard
already excludes those tombstones from pending reads. They are not a stalled
context backlog, and forcing rereads would not resolve the remaining history
exceptions.

At 20:54:24 UTC, current workload metadata separates 2,429 ready source
contacts (2,422 background and seven live), 1,500 contacts held for history
review, 203 held for routing, two held for unavailable operation context, and
one blocked by a frequency/band mismatch. Ready means eligible for processing,
not permission to export. Among destination review rows, 655 QRZ holds identify
minute-only time precision, 904 lack a unique exact identity, 1,597 LoTW holds
identify lower grid precision, and 109 LoTW mismatches identify missing or
different location fields. Destination counts overlap across source contacts
and must not be added to the workload counts. These require review policies
and source/route corrections where appropriate; waiting for cron cannot
approve them. The two context-held contacts require separate source review;
zero eligible operation rereads does not imply every contact has valid context.

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
deployed in the 21:03:35 UTC follow-up; its separate first run is recorded above.

The shared-history cohort slice deployed read-only at 19:45 UTC in signed
revision `bca137b1` (application code `b23e563a`) as Worker
`1f481a97-7e78-443a-a180-ea488822f78b`. All 512 tests and required checks pass
locally; [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40013802909)
passed all 512 tests and required checks. Independent version, health and asset checks confirm 100% traffic
and all five gates closed. D1 at 19:45:46 UTC confirms nineteen migrations and
zero attempts, cutovers or temporary guard residue.
For 20 contacts with warm history at both destinations, cohort work falls from
400 to **19 D1 RPCs**; complete-tick calls fall **467→86**, with SQL statements
**939→556**. All 40 classifications are retained, with zero vendor history calls
and zero exports. Observation snapshots, individual evidence commits, identity
collisions, failed date leaves and stale queue completion are covered by focused
regressions. The [capacity plan](capacity-plan.md) records the reproducible
benchmark, workload targets and the separate live-delivery work still needed.
The first new run, 19:45:43–19:47:15 UTC, processed 80 contact turns and made
121 destination classifications, including five adoptions, with 39 errors and
three deferrals. It recorded 121 inventory cache hits and zero successful
inventory advances; failed vendor requests are not included in `inventoryFetches`. Whole-run
cost was 384 RPCs, 2,643 SQL statements and 83.49 seconds of database wall time;
`reconciliationBatchCalls` was 208. The run reached its deadline in 92.209 seconds.
The preceding run processed 40 turns and 60 classifications using 862 RPCs and
1,900 statements in 64.118 seconds, stopping at its database budget. The new
sample doubled contact turns with approximately 78% fewer RPCs per turn
(4.8 versus 21.55), but its mixed work, longer elapsed time and warm inventory do
not establish unique completion rate, cold-inventory behavior or a capacity SLA.
At 19:49:24 UTC, nineteen migrations and zero attempts, cutovers or temporary
guards remained verified. Older release evidence below remains historical.

The second new run processed 137 contact turns and 249 classifications,
including 29 adoptions, with 13 errors and three deferrals in 86.646 seconds.
It recorded five successful inventory advances and 244 cache hits, using
861 RPCs / 4,842 statements (569 cohort RPCs) and 85.067 seconds of database
wall time before stopping at the soft database budget. At 19:52:36 UTC,
attempts, cutovers and temporary guards remained zero. This strengthens the
initial efficiency evidence; errors, sustained progress and full cold-inventory
capacity remain open. See [deployment evidence](deployment.md#guarded-reconciliation-cohorts-2026-10-23).

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
not currently wake dependent contacts directly. Incomplete inventory/loading
already retries after five minutes; the 24-hour timer applies to stable completed
review outcomes. A completion wakeup alone can remove that five-minute retry
timer, while cron, admission and vendor budgets may add delay. Suppressing
repeated dependency checks requires an explicit shared inventory leader/job,
durable dependent membership and completion wakeups; that lifecycle is not yet
implemented.

The local scheduler integration fixture classifies 20 contacts into 40 stable
destination review holds with three history requests: two QRZ requests for
base/catch-up and one LoTW query. The next tick processes zero contacts and makes
zero additional history reads. Both ticks create zero attempts and perform zero
vendor writes. This proves reuse and suppression of unchanged work for that
fixture, without approving any exception.

A separate local 20-contact, same-week baseline measurement isolated the
pre-cohort database cost. The cold pass made 40 classifications using three history
requests, 519 metered D1 RPCs and 1,147 statements in 4,979 ms. Forcing those
synthetic contacts due again while retaining valid inventory made the same 40
classifications with 40 cache hits and zero vendor reads, but still required
467 RPCs / 939 statements in 3,626 ms. Of those warm RPCs, 400 were per-contact
work: observation 40, preflight 40, inventory 160, adoption metadata/commit 80,
remembered checks 40, source status 20 and queue completion 20. The other 67
were scheduler/source/selection overhead. One auth-cleanup request precedes
the meter in each run. The first-slice shared comparison and guarded outcome
path reduced warm costs to 19 cohort RPCs, 86 whole-tick RPCs and 556 statements;
cold whole-tick calls fell from 519 to 170 with the same three history fetches.
The timings are not production capacity measurements. `reconciliationBatchCalls`
measures all cohort work, including observations, evidence reads, guarded outcomes
and completion; it is not an inventory-only counter.

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
error corrected in documentation revision `7252cad4`; all 467 tests and required
checks then passed in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39991118470)
with application code identical to the deployed revision. Sustained production
capacity remains unverified. All gates, assets and health were independently verified, with nineteen
migrations and zero attempts/cutovers/guard residue.

The first fairness-release run, **16:55:48–16:57:28 UTC**, processed 23 contacts
and made 31 destination classifications in 99.9 seconds. It advanced **two
rescan pages and two context reread pages**, returning 55 source records, with
six errors and five deferrals. The persisted rotation advanced twice. Database
wall time was 94.0 seconds across 662 RPCs / 1,495 statements; summed RPC time
was 203.5 seconds. The 16:57:52 snapshot had 125 remembered checks spanning 87
contacts, twelve completed QRZ partitions and twenty-one completed LoTW
partitions. Export attempts, cutovers and temporary guard rows remained zero.
This confirms source recovery and contact processing both advanced in the first
run; it does not establish complete reconciliation or large-account capacity.

The second fairness-release run, **17:01:30–17:03:19 UTC**, advanced the third
rotation position and one context page before processing 15 contacts. It made
17 destination classifications, including one adoption, with four errors and
zero deferrals. The context page returned no source records; no rescan page ran
before the deadline. It took 109.5 seconds, including 96.2 seconds of D1 wall
time across 337 RPCs / 751 statements. At 17:03:59 UTC, 142 remembered checks
covered 97 contacts, with fifteen QRZ and twenty-three LoTW partitions complete.
Attempts, cutovers and temporary guard rows remained zero. Both new runs
advanced context recovery, and the rotation reached all three first positions;
the measured 15–23 contact turns still fall short of the capacity targets.

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
2. **Measure and validate the deployed throughput path.** Keep every export
   gate closed. Verify sustained classification progress, inventory reuse,
   stable-hold retry suppression, source freshness and live fairness using the
   new stage/D1/classification telemetry. Record the deployed revision,
   migrations, release checks and production samples separately from earlier
   evidence. Track unique completed outcomes rather than counting repeated
   contact turns as progress.
3. **Schedule accounts fairly, wake dependencies and remove the source floor.**
   Source-lane rotation is deployed; independent background account/source
   admission with migration `0021` and lease checks deployed at 20:44 UTC, with
   seven module and six focused service checks passing. The full local release
   passes 531 tests; CI also passed; the first production observation is recorded above.
   Initial live work can still consume the deadline
   before background admission. Full live fairness, adaptive polling and vendor
   admission remain open. Wake only contacts covered by newly completed inventory;
   incomplete/loading holds
   already retry after five minutes, while stable completed reviews wait 24 hours.
   Meaningful dependency parking needs a shared inventory leader/job and durable
   dependent membership. Validate larger LoFi pages against the live contract and
   share source coverage across destinations where safe. Background pages remain 25
   contacts; batching alone does not remove the 6.9-day lower bound for one
   200,000-contact source pass. Preserve generation checks, fences, canonical
   freshness polling and live reservations.
4. **Make delivery fit vendor budgets.** Shared-history classification and
   guarded result batches are deployed, meeting the local 30-RPC cohort target
   with 19 RPCs. Delivery remains separate work: implement durable outbound
   identity claims for both vendors and immutable per-member LoTW attempt
   tracking before grouping signed uploads. Bound coalescing delay for sparse
   accounts and preserve final write-adjacent checks, uncertain-submission
   reconciliation and individual source validation. See the [capacity plan](capacity-plan.md)
   for the daily request model and acceptance criteria.
5. **Add durable continuations.** Shared partitions and durable indexed due-work
   metadata are implemented, but Cloudflare Queue jobs are not. Persist runnable
   work and an outbox before publishing bounded page/partition continuations;
   use idempotent, fenced commits and fair account/vendor admission, retaining
   cron as a watchdog. Queue redelivery must not duplicate vendor work, as
   [Cloudflare delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
   specify at-least-once delivery.
6. **Prove complete capacity before broader rollout.** The indexed-selection
   benchmark and 20-contact integration fixture are complete; full 4,000 and
   200,000-contact end-to-end benchmarks remain open, as does the 100-account,
   10,000-contact daily workload alongside a large import. Exercise
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
