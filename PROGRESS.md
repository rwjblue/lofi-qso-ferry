# Implementation progress

Current checkpoint, 2026-10-24 02:11 UTC:

Signed revision `d575e21ca0b8f803c91bb2029c7c2246949483bc` deployed read-only
at 01:59 UTC as Worker `a0c6a5a8-b062-43a0-a06b-789d6345954f`. All **925 tests**
and required checks passed in [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40051457580).
Independent 02:00–02:01 UTC checks confirm healthy service, matching assets,
all six export gates closed, all 23 migrations, 380 LoTW identity claims and
zero uncovered mappings, attempts, cutovers, legacy holds or temporary guards.
No new migration was needed. The release integrates bounded QRZ history
covering reads, separate fresh collision checks and explicit destination scope.
The first new scheduler run completed at 02:02:16 UTC. At 02:03:58, one
QRZ cover was complete after matching reads of 98 records, with none in the
original target. Other gaps and real vendor acceptance remain unverified.

The protected source audit completed its first full inventory at 02:10 UTC:
4,500 records, comprising 218 operations, 4,154 contacts and 128 events, with
60 deleted records. All 4,500 identities and versions match Ferry. HaLo has
13 fewer contacts, 3,247 server-stamp differences and 180 unknown versions;
application versions, flags and membership agree for shared records. The second
pass has 400 records and remains incomplete. A prior empty-incomplete response
did not advance its checkpoint; later reads resumed. Production source cursors and
source records remain unchanged. Complete both inventories before claiming
membership agreement. All-client forward tooling is implemented with strict
remote-observation freshness and 116 focused audit/probe tests; it has not run
against production. Independent local resumes cannot freshen remote evidence.

The protected SQL backup completed at 01:23 UTC and passed isolated integrity,
foreign-key, migration and credential-decryption checks. Applying restore
quarantine twice preserved claims while disabling restored access and work.
No production restore occurred. The owner authorized one or two real contacts,
QRZ first then LoTW, after sufficient evidence; no vendor write has occurred.

Next: observe the deployed QRZ fallback, complete both source inventory passes
and the fresh forward probe, then implement the reviewed all-client baseline
handoff and positive source/context validation. Main exports remain disabled;
a sampled agreement is not a global source-boundary proof. See the [roadmap](ROADMAP.md)
and [rollout checklist](docs/rollout-checklist.md).

Previous checkpoint, 2026-10-24 01:06 UTC: signed revision
`4fefd2ae3941f68cd07af22743df478a95976a5c` is deployed as Worker
`7bffe640-e86d-4d54-bb7c-24ca6ded7cd2` at 100% traffic. The release adds bounded
QRZ covering reads, correct neighborhood date bounds across UTC midnight,
source replay comparisons for retained suspects and fresh base operations, and
a known-positive forward replay probe. Ordinary web-deletion regressions retain
delivery cancellation, uncertainty and permanent identity fences.
All **829 tests** and required checks passed in
[release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40046763351).
Focused regressions and static/build checks also passed locally; the full local
run was not completed after a Miniflare fixture-setup transport failure. The
bounded fixture repair passed its focused rerun and the full CI suite.

Independent 01:07 UTC checks confirmed all five export gates closed, healthy
service, matching assets and all twenty-three migrations through `0024`.
There are 380 LoTW claims and zero uncovered mappings, attempts, cutovers,
legacy holds or temporary guards. No migration was needed. No source mutation
or vendor write was performed by the probes or this release.

Two complete fresh LoFi reads found all thirteen additional Ferry contacts
unchanged; HaLo's local omission remains unexplained. A separate four-read
sample matched all 23 members and Ferry's exact base-body revision hash and
server timestamp against both remote observations. Its local discrepancy was
only HaLo's stored server stamp. These samples establish current agreement for
the observed records, not source-wide completeness or historical purge exclusion.
See the [source evidence](docs/evidence-lofi.md#current-server-positives-and-base-operation-checks-2026-10-24-utc).

At 01:09 UTC a fresh QRZ 35-day covering read returned 467 records over two
complete pages, with zero records in one seven-day pending gap. Book, credentials
and target scope remained valid. This resolves the failed-empty-response problem
for that observation without adopting cached evidence or changing ledger state.
The other gaps and fresh pre-write coverage still need validation.

Next: integrate bounded QRZ coverage with normal history verification and commit
fences; obtain independent writer provenance for the bounded forward probe and
resolve cursor/retention and source-completeness evidence; then review an exact
contact/destination trial packet. Automatic QRZ fallback is not integrated.
The global source gate remains closed, including its source-wide cutover effect.
The trial must preserve each contact's actual 4/6/8-character grid. Exports stay
disabled, and no first-write trial is authorized. See the [roadmap](ROADMAP.md)
and [rollout checklist](docs/rollout-checklist.md).

Previous checkpoint, 2026-10-24 00:00 UTC: signed revision
`32e25b0ebc4d2ef5716bc3e60e166561a5b0931a` is deployed as Worker
`076adec3-eeb7-4dc9-bcd8-f6b04ce75318` at 100% traffic. The release adds fixed,
redacted QRZ read diagnostics and a guarded fifteen-minute retry delay for
ambiguous empty selections. Incomplete reads remain incomplete; no absence or
export permission is inferred. Read-only source replay and exact-contact trial
audits now provide reproducible evidence without changing delivery state.
All **675 tests** and required checks pass locally and in
[release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40041632962).

Independent 00:01:17 UTC checks confirm all five gates closed, healthy service,
matching assets and twenty-three migrations through `0024`. The database has
380 LoTW claims, zero uncovered mappings, and zero attempts, cutovers, legacy
holds or temporary guards. No migration, source mutation or vendor write was
performed by this release. The 00:00 scheduled invocation started before the
deployment and is not evidence for the new retry behavior.

The first new run, 00:05:43–00:07:13 UTC, processed 265 contact turns and 244
classifications, with zero adoptions, 21 affected-route errors and no deferrals.
Four fixed ambiguous-empty diagnostic events replaced generic QRZ failures.
At 00:06:18 UTC, all four pending QRZ partitions had bounded retry holds, with
zero invalid or excessive holds. The run still reached its 90-second deadline;
89.336 seconds were database wall time. This verifies the retry mechanism, not
completed reconciliation or sustained capacity. The settled 00:07:15 UTC audit
retained zero attempts, cutovers, uncovered mappings, legacy holds and guards.

The independent HaLo comparison found all 218 operations and 4,269 QSO/event
UUIDs in Ferry, without shared membership/deletion/event disagreement. Thirteen
additional Ferry contacts remain unexplained. Bounded live replay matched two
ordinary tombstones and, separately, ten members including four events. These
samples do not prove purge/forward delivery, base-operation freshness or retention.
The sampled new contact passed current metadata and ownership checks but remained
ineligible for a first insert on both routes. Its six-character grid was preserved;
supported 4/6/8-character grids remain specific to each contact.

Next: resolve QRZ absence evidence, complete the source evidence and review an
eligible exact-contact trial. The protected local key backup decrypted current
credentials; off-device storage is unconfirmed. A second passkey is recommended,
not an owner-pilot export gate: manual operator account recovery is possible.
See the [rollout checklist](docs/rollout-checklist.md). Exports remain disabled;
sustained large-scale capacity and live vendor acceptance remain unproved.

Previous checkpoint, 2026-10-23 22:42 UTC: signed revision
`a8b592bead90a22e4e7fe36f005e390727002df9` is deployed as Worker
`fd752a85-83e5-4afd-810c-1f4a2c4e3633` at 100% traffic. Migration `0024` repairs and
prevents identity gaps when an older scheduled invocation finishes after a new
migration: LoTW mapping writes acquire ownership atomically, and QRZ mappings
retain exact reservations unless linked receipt or guarded adoption evidence
establishes ownership. Conflicts roll back; old reservations cannot be overwritten.
All **606 tests** and required checks pass locally; [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40034841991) also passed.

At 22:43:14 UTC, all five export gates remain closed, service/assets match, and
all twenty-three migrations are applied. There are 370 LoTW claims, zero uncovered
mappings, zero attempts/cutovers and no temporary or legacy reservation residue.
The earlier 22:26 release initially had complete coverage, but a subsequent audit
caught three mappings added by the old cron after its migration seed. This
follow-up preserves ownership at the database boundary as well as in the Worker.
No real QRZ mutation or LoTW upload occurred.

The first new scheduled run, 22:45:42.955–22:46:04.921 UTC, processed 204 contact
turns and 186 destination classifications, including eight adoptions. It stopped
at the database budget after 21.966 seconds. All 70 failed routes were categorized
QRZ rejected reads; four additional routes were vendor-budget deferred. This is
one mixed-work sample, not unique completion throughput or a cleared backlog.
At 22:47:21.247 UTC, 378 LoTW claims cover every mapped identity; attempts,
cutovers, temporary guards and legacy holds remain zero.

Both destination rescans are complete. Source replay/deletion/retention proof,
the two deleted-operation holds and exact-contact first-write review were the
next work. Key-backup access has since been verified; see the
[rollout checklist](docs/rollout-checklist.md). A larger capacity claim still needs
its separate workload acceptance evidence.

Previous checkpoint, 2026-10-23 22:26 UTC: signed revision
`1182c47ac50f58b562185f12f419813114706163` is deployed as Worker
`edd20bdf-af0c-46c9-9c6b-37e72af92705` at 100% traffic. Durable identity claims now
protect adoption, preparation and dispatch, including fractional source timestamps,
uncertain outcomes and current source/dependency/lease fences. The release also
preserves eight-character LoTW grids, adds bounded read-only legacy QRZ binding,
and supplies the aggregate source audit. All **598 tests** and required checks
pass locally; [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40033047750) also passed.

Independent checks at 22:26:17 UTC confirm closed export gates, healthy service
and matching assets. Twenty-two migrations are applied. The new migration retained
355 LoTW claims, with zero unclaimed LoTW mappings or unreserved QRZ mappings.
Attempts, cutovers, legacy outbound/QRZ holds and temporary guards are all zero.
No real QRZ mutation or LoTW upload was performed.

Both destination rescans completed by the 22:19 UTC audit. Current payloads and
retained birth evidence are locally consistent; two contacts tied to deleted
operations remain held. Server replay, tombstone and retention guarantees remain
unproved, so `SOURCE_BOUNDARY_VERIFIED` stays false. The account had one active
passkey. The recovery prerequisites recorded at that checkpoint are superseded
by the current owner-pilot guidance above. The [personal checklist](docs/rollout-checklist.md) records the exact
contact/destination packet required before any live-write authorization.

Previous checkpoint, 2026-10-23 21:29 UTC: signed revision
`cec488febcad419ff55a4aa677619a1aef61fcd5` is deployed as Worker
`3c1f615e-bf2d-403f-9d54-1aed519da582` at 100% traffic. The follow-up adds
migration `0022` to keep context/event lookups independent of ordinary contact
counts, and lossless decoding of QRZ's observed adjacent Unicode surrogate
entities. Invalid pairs and split ADIF fields still fail closed. All **553 tests**
and required checks pass locally and in [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40025951354).
Independent 21:29:45 UTC checks confirm closed export gates, healthy service
and matching assets. D1 has twenty-one migrations, with zero attempts,
cutovers or temporary guards.

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

The exact context fence reads 4,003→3 rows and the context query 4,004→4 in a
local 4,000-contact fixture. A bounded live QRZ read with the new parser returned
121 records with well-formed Unicode. An earlier post-patch probe still failed
with a generic protocol error; these samples do not prove complete QRZ recovery.
The next larger performance task is memory-bounded history-leaf batching, followed
by dependency parking, larger measured source pages and full workload acceptance.
Review holds and export-readiness requirements remain open.

Previous checkpoint, 2026-10-23 21:03 UTC: signed revision
`57a64b02285f55f3dee25fdf52674ac54cd3893f` deployed as Worker
`25628683-a870-40e5-835f-e697adbc7f44` at 100% traffic. The diagnostic
follow-up preserves fixed QRZ read-response failure categories and measures
D1 server SQL time, row counts, retry attempts and metadata coverage. It retains
write uncertainty, query behavior, existing request budgets and all export gates.
All **548 tests** and required checks pass locally; [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40023892103)
passed all 548 tests and required checks. Independent verification at 21:05:18 UTC confirms closed gates,
healthy read-only service and matching assets. No new migration was required;
the database remains at twenty migrations. The first refined-counter run follows.

The first refined-counter run, 21:05:42–21:07:13 UTC, completed 104 contact
turns and 158 destination classifications, including ten adoptions, in 91.239
seconds. It recorded 33 errors and four deferrals. QRZ entity decoding accounts
for eleven diagnostic events affecting twenty history routes; ten separate QRZ
rejection events affected twelve routes. One LoTW unavailable event and four
budget-deferral events account for the remaining categories. Events are not
physical request counts. This diagnostic run localized the entity failure to numeric Unicode
validation; the later 21:29 UTC follow-up addresses the observed valid pairs.

D1 used 702 RPCs and 3,624 statements, with 84.089 seconds of wall time and
97.357 seconds of cumulative request time. Metadata covered 3,395 statements:
1.425 seconds of reported SQL execution, 1,004,089 rows read, 5,818 rows written,
zero additional statement retries, and ENAM service for all covered statements.
The uncovered 229 statements and last-attempt-only SQL reporting prevent
attributing the wait gap purely to network latency. This points to further
round-trip reduction and query profiling, not a reason to raise budgets.
The 21:08:59 UTC snapshot confirms zero attempts, cutovers or temporary guards.

Previous checkpoint, 2026-10-23 20:44 UTC: signed revision
`8863bd9439681122e71bc3c2a31174a72aa30bb2` deployed as Worker
`004edefd-d2a5-462c-b079-1cf8d04e6b05` at 100% traffic. Five small signed
commits add safe failure diagnostics, mixed-date history sharing, independent
background account/source admission and bounded cold-history concurrency.
All **531 tests**, formatting, lint, both TypeScript checks and the Worker build
pass locally. [Release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40021495718)
passed all 531 tests and required checks; the first scheduled-run measurement follows.

Independent verification at 20:44:30 UTC confirms all five gates closed, healthy
read-only service, matching assets, twenty migrations through `0021` and zero
attempts, cutovers or temporary guards. The warm 20-contact/20-week fixture uses
**57 cohort RPCs / 128 whole-run RPCs / 716 SQL statements**, preserving all 40
outcomes without vendor reads or writes. Cold history retains four-way
concurrency and drains started work before releasing leases. Background
admission tests cover 100 accounts, multiple sources, restart, slow failures,
lifecycle changes and stale leases; the complete growth workload remains open.

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

The next two runs processed 103 and 137 contact turns, respectively; the
latter classified 190 destinations in 68.887 seconds, with 33 errors and
65.353 seconds of database wait. More precise QRZ response categories and
D1 SQL/coverage metadata are deployed in the 21:03 UTC follow-up.

Next: diagnose production retry categories, finish source-context/rescan work,
measure larger source pages and checkpoints, park dependencies, complete
live/vendor fairness and safe multi-contact delivery, then exercise the full
workload matrix. Exports remain disabled until the independent source,
identity, exception-review and scoped canary requirements are met. See the
[capacity plan](docs/capacity-plan.md).

Previous checkpoint, 2026-10-23 19:45 UTC: the reconciliation cohort slice deployed
in six signed logical commits and passes **512 tests**, formatting, lint, types and
the Worker build. It shares observation/history reads and guarded outcomes while
preserving per-contact source/evidence fences, collision quarantine and failed
partition isolation. The warm 20-contact fixture uses **19 cohort RPCs** instead
of 400 and **86 complete-tick RPCs** instead of 467; SQL falls from 939 to 556.
Reproduce with `mise exec -- npx tsx scripts/benchmark-reconciliation-cohort.ts`.
Signed revision `bca137b1a38ceb7ab0601e1db53136d69cce9c9c` (application code
`b23e563a4104bd16b8bb9ce0cd6d356ddfad9d3f`) deployed as Worker
`1f481a97-7e78-443a-a180-ea488822f78b` at 100% traffic. Independent live checks
confirm all five gates closed, healthy read-only service, matching browser assets,
nineteen migrations and zero attempts, cutovers or temporary guard residue.
[Release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40013802909)
passed all 512 tests and required checks. The first new run processed 80 contact turns and 121
destination classifications in 92.209 seconds, including five adoptions,
39 errors and three deferrals. It used 384 whole-run RPCs (4.8 per turn),
compared with 862 RPCs for 40 turns (21.55 per turn) in the preceding run.
This approximately 78% lower RPC cost per turn comes from one mixed-work
observation with warm inventory; it is not unique completed reconciliation
or sustained capacity. The 19:49:24 UTC snapshot still confirms nineteen
migrations and zero attempts, cutovers or temporary guards. See the [capacity plan](docs/capacity-plan.md) for
remaining work at that checkpoint, including fair account admission, economical live delivery and
full workload acceptance.

The second run, 19:50:42–19:52:09 UTC, processed 137 contact turns and 249
destination classifications, including 29 adoptions, with 13 errors and three
deferrals. It used 861 RPCs and 4,842 statements in 86.646 seconds, stopping at
the database budget; five inventory advances and 244 cache hits were recorded.
These two samples establish initial improvement, not sustained capacity or a
cleared backlog. At 19:52:36 UTC, attempts, cutovers and temporary guards remained
zero. See [deployment evidence](docs/deployment.md#guarded-reconciliation-cohorts-2026-10-23).

Previous checkpoint: 2026-10-23 17:05 UTC. The source-lane fairness correction deployed as signed revision `cb9ea362e2a03e29b7d53793bae95276de7d7341`, Worker `aea20af6-c08d-4718-bc41-2e450d8cc2e4`, at 100% traffic. It rotates contact processing, historical scans and context recovery so a slow batch cannot repeatedly starve other background work. The initial batching/shared-history release and QRZ/concurrency follow-up are also deployed. All **467 tests** and required checks passed locally and in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39991118470), after correcting a documentation-format error. That CI revision changes only documentation from the deployed code. Nineteen migrations are applied. Independent deployed settings and health confirm all five export gates closed; zero attempts and cutovers were verified again at 17:03:59 UTC. The first two fairness runs processed 23 and 15 contacts, respectively, while advancing source context; all three rotation positions were exercised. Full reconciliation and end-to-end capacity remain unfinished. The owner authorizes signed logical commits directly to `origin/main`; no PRs. Backlog repair and deployment do not authorize real logbook writes.

Current follow-up: measure sustained production classification/context progress and remaining bottlenecks before planning exact-contact first writes. The owner has enrolled and linked LoFi, QRZ and LoTW. The pre-repair production snapshot found **4,134 source contacts**, including **3,106 pending** and **767 context-unavailable** contacts. Separately, each destination had **255 ledger rows**: **253 generic readback errors**, one pending row, and one QRZ-ambiguous or LoTW-mismatched row. There were **zero export attempts**. These are the historical diagnostic baseline; the dated snapshots below show limited recovery before the throughput work, not a cleared backlog.

## Deployed throughput implementation

The source-lane fairness correction deployed at 16:53 UTC: retained contact
processing, historical rescan and context reread rotate first position under a
persisted source-cycle lease fence. All **467 tests**, formatting, lint, types
and the Worker build pass locally. Deadline/failure and lost-lease regressions
pass; canonical freshness polling and all export gates remain unchanged.
- Batched intake/checkpoints and shared context reads reduce local D1 calls from **32→7** for an operation plus 25 contacts, **33→9** for a 25-contact operation reread, **56→7** for a 25-contact replay, and **102→5** for projecting 20 contacts sharing operation/event context. Full projection, tenant boundaries and atomic checkpoint rollback remain tested.
- Durable indexed work scheduling selects 100 contacts with **200 rows read** at both 4,000 and 200,000 contacts: **7.68 ms** and **7.63 ms** locally. With nearly all background rows held, the same selection takes **5.95/6.22 ms**, again reading 200 rows. Reproduce with `mise run benchmark-reconciliation`. These measure local selection only, not full reconciliation throughput.
- Successful stable review outcomes wait **24 hours**; incomplete inventory/loading reconciliation checks retry after **five minutes**. The latest release adds a separate **fifteen-minute** shared read cooldown for ambiguous-empty QRZ partitions. Relevant source, context, routing, credential and policy changes invalidate checks. Retention extensions and routine credential rewraps preserve holds. Inventory completion does not currently wake dependent contacts directly; eliminating repeated dependency checks requires shared inventory jobs and durable dependent membership.
- Shared history uses encrypted **four-hour** partitions covering up to a week, QRZ base/modification catch-up pages and LoTW splitting when a date range is too large. Retention is bounded to **2 MiB per partition**, **128 MiB per source/destination** and **2,048 partitions per source/destination**. Incomplete, expired or revoked evidence cannot establish coverage. Cached absence retains a hold and never substitutes for the fresh targeted check required before exporting.
- A local scheduler fixture classifies **20 contacts into 40 stable destination holds using three history requests** (two QRZ, one LoTW). The following tick processes zero contacts and makes zero additional history reads. Both ticks produce zero attempts or vendor writes. This verifies reuse and repeat suppression on that fixture; it does not demonstrate a 200,000-contact drain rate.
- Background selection uses **20-contact batches**, live selection remains **one contact** to reserve write capacity, and the scheduler yields at its **90-second or 850-D1-call soft budget**. Stage durations, D1 RPC/SQL-statement counts, destination classifications and inventory fetch/cache activity are retained in scheduler telemetry. In-flight work may finish after a soft threshold.
- Full local release checks passed **452 tests**, formatting, lint, TypeScript and the Worker build. Final focused races additionally cover expired/revoked/deleted event evidence, with a valid-event adoption control. Queue coverage includes stable-hold invalidation, expiry, tenant fencing, stale-version rejection and direct update counts despite queue triggers. The initial throughput release also passed all 452 tests in CI and is deployed; the 392-test result below belongs to the previous release.

The first new production run processed only four contacts in 93.7 seconds, with four QRZ errors and 73.4 seconds of cumulative database wait. That observation exposed a rejected QRZ modification query and excessive sequential round trips. A follow-up now adds a full verification fallback, further batched reads and at most four concurrent read-only background contacts; all 465 tests and required local checks pass, and the follow-up deployed at 16:37 UTC. The first follow-up run processed **20 contacts and 29 destination classifications in 95.3 seconds**, with three errors, eight deferrals and zero attempts. Historical rescan/context pages did not advance: background lane starvation is corrected in the 16:53 release, with its first run advancing two rescan pages, two context pages and 23 contacts. This is a first-run improvement, not sustained capacity acceptance. See the [measured bottleneck and follow-up](docs/reconciliation-investigation.md#first-throughput-release-production-bottlenecks-and-follow-up).

Remaining capacity work: measure the deployed cohort/admission path and resource use, complete general live/vendor fairness and dependency parking, validate larger LoFi source pages, share source coverage where safe, build on the completed outbound identity claims with safe multi-member delivery, add durable queue continuations and run the full 100-account/10,000-contact daily workload alongside 4,000/200,000-contact interruption/fairness/import scenarios. Source pages remain **25 contacts** under the existing vendor budgets. Neither a full 200,000-contact benchmark nor the proposed one-day target is complete. See the [measurement details and acceptance plan](docs/reconciliation-investigation.md).

The separate [workload investigation](docs/admin-workload-investigation.md) shows the context backlog is held work awaiting pending operation rereads, not 767 malformed contacts. At 13:23 UTC, the new read-only classification found **1,423 ready for processing**, **2,704 held for operation context**, **five held for routing**, **one held for history review** and **one blocked by callsign validation**. All were background work. LoFi history and context reads share four background requests per five-minute window. A completed operation-list scan does not finish every operation's contacts/events; normal bounded reads must continue, and the historical callsign hold was traced to canonical `our.call` parsing and corrected in deployed revision `32758f5`, without changing owner data. These counts are time-specific and do not establish upload eligibility or a completion estimate.

Observation after the first repair exposed a second scheduling bottleneck. The 13:42:35 UTC run took 130,398 ms and completed zero contact processing turns with zero errors: canonical sync finished quickly, but historical reads consumed the turn before contacts ran. A selected contact was a known context hold despite available ready work. The 13:55 UTC run, still before the follow-up deployment, recorded one contact processing turn, one error and three deferrals, with **1,486 ready**, **2,647 held** and **one blocked** source record. These are evidence for the scheduling change, not verified post-fix recovery.

## Earlier production evidence: exceptions and capacity

At 15:08:05 UTC, before the larger throughput implementation, the first completed
post-release run (started 15:05:50) took
96,730 ms, with two contact turns, one canonical source page, zero errors and
zero deferrals. The immediately preceding run took 132,572 ms for two turns.
This one-run comparison is consistent with less cleanup overhead; contact
throughput was still two turns per run and sustained draining was not established.
Classified work was 1,820 ready, 2,314 held and zero blocked. The cleared callsign
hold was requeued, not independently proven reconciled. New precision-specific
reasons were stored for one QRZ and two LoTW rows, all still review holds.
Export attempts and source cutovers both remained zero.

Immediate fixes are signed on `main`: `32758f5` (general-log projection and scoped migration), `789d652` (precision review reasons), and `fa822ba` (cleanup). Local checks passed 391 tests; the final unrelated-neighbor correction passed all 35 focused QRZ/reconciliation tests and TypeScript/lint. Release [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39974178346) passed all 392 tests after the roadmap formatting correction, and `cf34ac0` is deployed. Live readback confirms all gates closed and the affected source row requeued.

The owner requested four individual investigations. Results and the ordered implementation/acceptance plan are recorded in [reconciliation exceptions and capacity](docs/reconciliation-investigation.md).
- Three QRZ FETCH samples each returned one otherwise matching candidate with only minute precision; the generic ambiguity reason conceals this distinction. Keep a review hold and exact write guards.
- Two LoTW queries returned six-character grids matching the prefix of the source's eight-character grid, with one exact identity and all other compared location fields agreeing. Do not call this conflicting geography or silently adopt it. Historical precision policy remains open; the later eight-character outbound signer preserves the full supported source grid.
- The general-log callsign hold contains canonical `our.call`; the narrow parser compatibility fix is implemented with a scoped reprojection migration. The five station-route holds correctly exclude other transmitting stations, including a test suffix. No owner log edits or new routes were made.
- The five completed runs from 14:05–14:25 UTC each examined two contacts in 128.8–140.7 seconds. At 14:38, 134 operation contexts were complete and 42 pending, with 734 unexpired context-held contacts and both rescans unfinished. Canonical sync was forward. These are processing/dependency observations, not completed reconciliation.
- Exact production DELETE query plans and local fixtures identified a correlated cleanup scan. The tuple-key rewrite preserves resolution/tenant boundaries and reduces local cleanup from 1,240 ms to 2.74 ms at 4,000 contacts; at 200,000 it takes 172 ms. These are local query measurements, not a deployed throughput claim. Before the new batching work, a 25-record unchanged rescan made 56 sequential database calls and the 200,000-row one-contact selector took 1.36–1.58 seconds locally. The new local measurements above supersede those costs for the implemented paths.
- Per-contact destination reads have a structural scale limit: eight LoTW background queries per five minutes require at least 86.8 days for 200,000 contacts, even before retries or other tenants. The observed two-turn rate would take about 347 days if every turn completed a different contact. Shared partitions and local matching are required, alongside immediate database fixes. Current 25-contact LoFi background pages also impose a 6.9-day floor for one 200,000-contact source pass before rereads/rescans; larger verified pages and shared source coverage are part of the capacity work.

The probes used three QRZ and two LoTW background budget reservations, with zero vendor mutations, signatures or adoption/cursor changes. Raw source/vendor payloads and credentials were not persisted or committed.

## First observed run after the scheduling repair

The read-only D1 snapshot at **2026-10-23 14:04:02 UTC** confirms that the 14:00:46 run completed in 132,058 ms with one source page, one contact processing turn, zero errors and zero deferrals. Classified background work was **1,509 ready**, **2,624 held** and **one blocked**. Compared with the pre-follow-up 13:55 sample, 23 records moved from held to ready as context became available; this is read-only classification progress, not a net reduction in the total backlog or 23 completed reconciliations. One run does not establish sustained throughput.

Source metadata still totals **4,134 contacts**: **3,097 pending**, **761 blocked on operation context**, **one blocked on callsign validation**, **270 ordinary waiting** and **five held for routing**. Both destination adapters now reach actual vendor reads and return specific outcomes: QRZ reports `history_ambiguous` because no unique exact identity matches its time precision/mode evidence; LoTW reports `history_mismatch` because `MY_GRIDSQUARE` differs or is absent. These require review, not automatic clearing. **264 old generic readback-reason rows per destination** still await revisit, plus one generic QRZ retry-error row recorded at 13:55 before the scheduling follow-up. The snapshot confirms **zero export attempts**, **zero cutovers** and **fourteen migrations**.

## Deployed repair evidence

- A retained production sample of 12 generic reconciliation failures contained nonzero milliseconds in all 12 contacts. Projection succeeded for each; strict outbound ADIF conversion rejected the timestamp before vendor requests. The sample establishes this failure path, not the cause of every error or unavailable operation context.
- Added `contactReconciliationAdif` for read-only identity lookup, matching PoLo/HaLo whole-second truncation while preserving raw source milliseconds and the source fingerprint. At that checkpoint outbound preparation remained blocked for fractional timestamps with `subsecond_export_requires_identity_claim`; the later identity-claim release replaces that blanket restriction while preserving all rollout gates.
- Adoption collision quarantine is implemented and tested. If a second source contact claims an already adopted remote identity, both its untransmitted adopted owner and contender become `history_ambiguous`, the existing reservation remains, and later source edits cannot auto-export either contact. This does not grant new timestamp-precision write eligibility.
- Persist renewed LoFi bearer credentials using a guarded compare-and-set, so stale work cannot overwrite a newer credential version. This fixes a local persistence defect; its contribution to the production context backlog is unconfirmed.
- Preserve actual history diagnostics while exports are disabled. Projection, credential and preparation errors are distinguished from destination-readback failures instead of being collapsed into a generic reconciliation failure.
- The initial repair `1679f749` passed **371 tests**, formatting, lint, types and build in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39963134190). Admin workload classification, backlog trends and completed-delivery history shipped with it. Independent D1 verification at 13:41:45 UTC confirmed all fourteen migrations, zero export attempts and zero cutovers. No live export was performed.
- The follow-up keeps canonical source sync first, processes a retained background contact before historical rescan/reread work, and prefers contacts with available base operation context over known context holds. Complete context, routing, history, source-proof and export checks remain enforced. A pre-deployment read-only selection experiment found available base context for only two of the first ten contacts under the old ordering versus all ten under the new ordering; it wrote zero rows. This does not establish complete event coverage for every selected contact.
- Follow-up `634517d0` passed **377 tests**, formatting, lint, types and build locally and in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39965786804). Concurrent upstream documentation revision `854259b` was integrated and preserved. The first observed production run confirms contact processing and specific readback outcomes; sustained draining and complete history acceptance remain outstanding.

## Previous production deployment (2026-10-23 21:29 UTC)

- Deployment at that checkpoint: revision `cec488febcad419ff55a4aa677619a1aef61fcd5`, Worker `3c1f615e-bf2d-403f-9d54-1aed519da582`, created at `2026-10-23T21:29:17.720637Z` and confirmed at 100% traffic. Host/RP remains `https://ferry.n1rwj.com` / `ferry.n1rwj.com`, with five-minute cron. Independent version readback confirms all gates closed and health `status=ok`, `exportsEnabled=false`; root HTML and both browser bundles match the local build. See [deployment evidence](docs/deployment.md).
- Dedicated D1 `ferry-production` has all twenty-one migrations independently verified at 21:29:44 UTC. The initial throughput deployment applied migrations 0017–0020; independent background admission adds 0021 and bounded context lookups add 0022. Attempts, cutovers and temporary inventory/adoption guard rows remain zero. No application secrets changed.
- Every export gate is closed: `EXPORTS_ENABLED=false`, `ROLLOUT_CHECKS_PASSED=false`, `SOURCE_BOUNDARY_VERIFIED=false`, empty `LIVE_WRITE_AUTHORIZATION` and `ROLLOUT_QSO_IDS_JSON=[]`. There is no LoTW root-policy binding or root updater; LoTW validates certificate authority during upload processing.
- The saved LoTW connection is active with unrevoked serial status. Existing encrypted credentials do not need reimport because local trust flags were removed. Successful preflight and login are not signed-upload acceptance evidence.
- Native `EMAIL` sender restricted to `signup@ferry.n1rwj.com`; sending DNS verified, existing Fastmail MX preserved, email-content previews disabled. Existing Wrangler OAuth includes Email Sending write access; no new credentials are needed for invites.
- Independent Worker secrets are preserved. Backup: `~/.config/lofi-qso-ferry/production.secrets.json`, mode 0600 inside 0700, outside Git. It was created while 1Password CLI was signed out; archive it securely before removing it. Never print or casually regenerate the keys.

## Implemented and committed

- Worker/D1 service with encrypted tenant credentials/bounded payloads, durable immutable outbox/leases, atomic intake checkpoints, conservative read-only adoption, per-contact quiet periods and real LoFi/QRZ/LoTW adapters.
- Persistent vendor request budgets/cooldowns, reserved live capacity, smaller historical work limits, bounded prepared imports and resumable expired-history repair.
- Fair scheduler drain rounds within a 90-second soft deadline; live work precedes historical work while shared vendor budgets remain enforced. Admin overview exposes scheduler history, actionable workload/holds, backlog trends, completed-delivery history, source health, vendor budgets and closed export gates, plus audited invitation controls. Remaining admin work is queue age and opt-in alerts, support drill-down, measured capacity tuning, then controlled operations.
- Effective operation/segment location handling, cursor gap/restart recovery, tombstones, source-birth/cutover proofs and forward-only templates pinned at first durable preparation; adopted QRZ narrative is preserved.
- In-Worker LoTW signing, P12/key/date/station/serial-status preflight, separate website-login verification, submitted/observed/confirmed states, retained prior identities, encrypted KEK rotation and tested restore quarantine. One-contact immutable TQ8 artifacts are the v1 batch size; ARRL decides certificate authority and upload acceptance.
- Email-confirmed, passkey-only accounts with tenant/session/recent-assertion guards; no inbox reset. Hosted signup now requires an exact-email seven-day invitation claimed atomically with the first passkey. Local signup retains its encrypted fixture mailbox.
- Styled HTML/plain-text verification and invitation messages; six-digit code subject, configured-host final line, one-time-code/numeric/paste/focus hints. Operator command: `mise run invite -- person@example.com`; `--dry-run` previews without granting access or sending.
- Mobile dashboard, optional independent connections and settings. Requested reference-labels/contact-notes COMMENT default, immutable account preferences saved without QRZ, new-book-only inheritance and existing-book version selection.
- Follow-up signed commits: settings `0f4a8c1a33bf`, adapter runtime fixes `d44e74f9cd3f`, invite/mail/UI `58a965d7c54d`. The runtime fixes use manual redirects and the global fetch receiver; Node-only mocks had hidden both failures.

## Verification and evidence

- Previous release validation (15:04 UTC): local full checks passed 391 tests; the final diagnostic refinement passed 35 focused tests plus TypeScript/lint. All **392 tests** and required checks passed in [CI for `cf34ac0`](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39974178346). Live version/health confirmed that release, all gates closed and 100% traffic. At 15:04:50 UTC, D1 had fifteen migrations, zero attempts and the affected source row pending. These results predate the larger throughput work and do not establish completed reconciliation, sustained throughput, billed CPU, peak memory or monthly cost.
- Actual workerd/D1 tests cover isolation, passkey cryptography, invitation expiry/atomic races, zero-write adoption, immutable templates, segment changes, retries/crashes, uncertain readback, signing vectors, revocation and restore. Native global-fetch adapter tests exercise successful requests plus redirect/opaque rejection through contained fixtures; no live vendors are contacted.
- Actual isolated Wrangler/D1 + Chromium virtual resident/UV passkey signup, sign-out/sign-in and zero-connection saves pass. Quiet period 40 and COMMENT preference persisted after reload. `/join` asset canonicalization was found and fixed. Mobile 375×812 has no horizontal overflow.
- Deployed Chromium confirms invite-only home, uninvited signup 403, `/join` retained/focused, code hints and no console errors. Health reports exports=false; local mailbox/alternate workers.dev return 404. All gates/RP/D1/sender/preview restrictions were independently checked through Cloudflare settings.
- Read-only remote D1 experiments show `--file` returns bulk-import summaries, while `--command --json` returns query rows. The invite task uses query results and validates the exact granted email/deadline before sending. Local D1 fixtures cover quoting, existing/claimed rejection and uncertain-send behavior. No live invitations were granted or sent during this follow-up.
- Initial deployment delivered a real verification email through the native provider; only fixed receipt metadata was inspected. New branded HTML was visually checked locally, not in real mail clients. Domain-bound formatting is documented by Apple for SMS; email-client/device autofill remains unverified.
- Earlier bounded live read-only LoFi/QRZ/LoTW probes passed; limits remain in `docs/evidence-*.md`. They do not prove complete history or safe writes. Signing matches independent OpenSSL vectors in workerd; no ARRL acceptance claim.
- The signing evidence records GHSA-86w9-cpqp-85rv against node-forge 1.4.0 with no patched release at investigation time. Production uses Forge for ASN.1/P12 MAC/decryption and key extraction, never its RSA/certificate signature verifier; signing uses platform WebCrypto. Dependency audit is not clean. See [signing evidence](docs/evidence-signing.md).

## Next action and rollout boundaries

1. Complete both independent source inventory passes and the fresh all-client forward probe. Implement the versioned all-client baseline and fresh positive source/context validation before claiming main-export readiness. Contacts attached to deleted or unverified operations stay held; zero pending rereads does not establish eligibility.
2. Observe the remaining QRZ gaps after the first successful automatic covering read, then review the exact trial contacts and destinations, including fractional timestamps, full station grids, certificates, identity claims and fresh remote checks. Historical minute-only time, lower grid precision, location mismatch and routing holds require explicit evidence; cron does not approve them.
3. Prepare the exact first-write packet in the [rollout checklist](docs/rollout-checklist.md). The protected SQL backup passed isolated restore and current credential-decryption checks; refresh it before external changes if needed. Off-device key storage remains unconfirmed. A second independent passkey is recommended, not a hard export requirement for this owner-operated pilot; manual operator recovery can register a new credential for the existing account.
4. The owner has already authorized a one- or two-contact trial, QRZ first then LoTW, after the evidence prerequisites. Bind it to exact contact and destination scopes, verify QRZ receipt/readback and LoTW observed acceptance, then close the gates and review before broader scope.

All six gates remain closed. Unrelated historical exceptions may remain isolated during an explicitly scoped trial; broad automatic coverage needs its own review. Replacement and old-identity cleanup remain disabled until separately proven. Continue resource/cost, restore/revocation, browser/passkey and full workload acceptance before expansion. Staging remains undeployed. See [roadmap](ROADMAP.md), [deployment](docs/deployment.md) and [rollout checklist](docs/rollout-checklist.md).

## Previous follow-up: LoFi connection freshness

- Initial tree clean at `8f122307852e`; upstream unchanged. Read-only production metadata confirmed the user's active session was beyond the five-minute recent-passkey window, with no LoFi connection saved. No source records or credentials were read or changed.
- Implemented automatic session/CSRF preflight and passkey assertion for protected connection/account actions; cancellation retains inputs and sends no protected request. Typed pre-dispatch auth errors permit one bounded retry; vendor, origin/CSRF and post-request failures never do. The original account and CSRF snapshot are pinned through concurrent refresh/retry.
- Focused client/backend checks pass; actual isolated Worker/Chromium verifies stale/fresh/canceled approval flows and real signature checks with contained vendor fixtures. Review added stale+invalid-CSRF ordering and preservation of an unverified add-passkey ceremony on a retryable freshness refusal.
- Full `mise run check` passes **180 tests**, formatting, strict lint, both TypeScript checks and Worker build (292.78 KiB gzip). Browser cancellation/retry, immutable CSRF/account snapshots, stale+invalid-CSRF precedence and add-key ceremony preservation have regression coverage.
- Signed/pushed `cbe9e63af1bf` and deployed it as Worker version `6a580035-ad08-4e35-9fa5-5d09fe5f9baf`. No migrations or secret changes. Live new-client asset, typed origin rejection, health and all closed export gates verified; no real vendor requests were made.
- Historical next action was to finish LoFi approval; the owner has since completed it. Existing account data/passkeys/connections remain intact.
