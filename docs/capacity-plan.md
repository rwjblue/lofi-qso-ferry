# Capacity plan

The broader LoTW historical association consumer, mandatory ownership write bridge,
bounded ownership maintenance and shared source-comparison reads are deployed in
signed `f2c41cb3a929ae3d3545e235894027b84fbf09fb`, including the ownership
initialization follow-up. All **1,617 tests** and required checks passed; all
eight export controls remain closed. The local cached 40-route
fixture measures **118 cohort / 222 whole-tick D1 RPCs / 1,123 SQL statements**;
the minute-precision fixture measures **124 / 312 / 1,379**. These are local
same-work measurements, not production speedup or capacity claims. See the
[initial-recognition and idle measurements](#integrated-lotw-historical-recognition--local-measurements).

## Current read-only release — f2c41cb3

[Release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40132320522)
passed **1,617 tests** and required checks at **2026-10-24 21:26:36 UTC**.
Deployment at **21:29:41.127501 UTC** installed Worker
`fc1f2a5b-13e0-4509-ba03-9c93856c6464`, deployment
`5cd52bea-75ce-40ed-be6c-f847c904e36d`, at sole 100% traffic. Independent
**21:30:27.888 UTC** attestation confirmed all eight controls closed. The schema
is unchanged at **36 migrations through 0037**.

The **21:28:43.196 UTC** PRE and **21:30:41.035 UTC** POST backups have identical
**41,811,658-byte** SQL, SHA256
`5a41e911c628ccdd3a2f60b0bf90a5f7fd6d9ee35ad3bb1e9ce277f784169b36`.
Recovery validates all **3,294 populated exact ownership ciphertext records**,
three credentials and the tenant key, plus integrity/FKs and two isolated
quarantines. The snapshot retains 3,327 claims and 2,689 QRZ owners/markers.
These are exact-evidence recovery checks; populated raw-history recovery remains
open. No production restore or vendor mutation occurred.

At **21:32:51.368 UTC**, all **19 aggregate checks** pass, with **9,981 covered
ownership inputs / zero pending / zero held / zero unhashed owners** and
**3,327 exact copies**. The source index is clean at **4,146 entries** and QRZ
has **2,689 owners/markers**. Raw references, attempts, cutovers, pins and proofs
are zero. Ownership bootstrap is complete at this checkpoint. This is a coverage
observation, not fresh absence, export authority or a sustained throughput result.

| Completed f2c run (UTC)   | Contact turns / classifications / adoptions | Errors / attempt turns |  Elapsed | D1 RPCs / SQL statements |
| ------------------------- | ------------------------------------------: | ---------------------: | -------: | -----------------------: |
| 21:30:48.324–21:31:50.809 |                               220 / 380 / 0 |                  4 / 0 | 62.485 s |              857 / 6,865 |

An overlapping idle run, **21:31:18.620–21:31:28.582 UTC**, took **9.962 seconds**
and used **62 D1 RPCs / 535 SQL statements**, with zero errors.

Fixed-category readback at **21:37:23.816 UTC** identifies one
`history_read:qrz:unknown` event affecting four routes. A separate exact-key
audit at **21:40:20.901 UTC** confirms that stored category; the precise cause
remains unknown. The completed coverage snapshot and these
runs do not identify their exact live cause or establish that the scheduling
change caused a production speedup. Measure initialization, useful recognition
and resolved idle work separately; overlapping runs must not be summed as a
single throughput sample. No active 200,000-contact capacity is established.

The **21:36:47.379 UTC** protected backup verifies all **3,327 populated exact
evidence envelopes**, complete bootstrap coverage and 2,702 QRZ owners/markers.
Its 42,144,346-byte snapshot passes credential/key decryption, exact AAD/HMAC and
ownership checks, integrity/FKs and two isolated quarantines. The separate
**21:37:57.619 UTC** immutable comparison preserves every prior claim, owner,
marker and evidence field; additions are 33 exact copies and 13 QRZ
owners/markers, with zero prior rows changed or lost. Raw references remain
empty, so populated raw-reference recovery is still open. Neither check restores
production or grants export authority.

The earlier **21:10 UTC** same-contact cloud proof/QRZ absence packet ran exact
`5a427a30` code; its proof has expired. Fresh current-release source/vendor proof,
scheduled proof-path verification, first-write acceptance, exception review and
populated raw recovery remain open. Exports remain disabled.

## Previous read-only release — 5a427a30

[Release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40127593520)
passed at **2026-10-24 20:24:10 UTC**. Deployment at **20:27:06.855761 UTC**
installed Worker `1e3a63b8-eceb-47dc-86d5-b4c64dd79a48`, deployment
`9abe3b85-f5c4-4250-9d26-45d9b53bd332`, at sole 100% traffic. Independent
**20:27:28.292 UTC** checks confirmed eight closed controls, active KEK version 1,
healthy HTTPS and matching assets. All **36 migrations through 0037** are applied.

The initial **20:27:46.782 UTC** production backup records **3,833 unhashed LoTW
owners / 9,981 pending inputs / zero held inputs or copied evidence**. This is
unfinished bootstrap before the first 20:30 cron. The existing 4,141-row source
index does not establish complete LoTW ownership coverage.

The **39,123,981-byte / 36-migration** backup passed isolated restore, three
credential and tenant-key decryptions, integrity/FKs and repeated quarantine,
including every bridge/raw/source/inventory/receipt table. It retains 2,549 QRZ
owners/markers, 3,327 claims, 4,141 index rows, 4,500 source rows and 2,465 legitimate
archives; attempts, cutovers, proofs, pins, transient guards and raw references
are zero. At **20:28:34.534 UTC**, the exact comparison against the refreshed
20:25 PRE snapshot preserved all 3,327 claims and all 2,549 owners/markers,
including creation time, with zero additions, missing or changed rows. No
production restore occurred. Historical association grants no upload authority;
sustained throughput and active 200,000-contact capacity remain unproven.

| First completed 5a cron, 20:30:43.485–20:32:18.599 UTC |                   Observation |
| ------------------------------------------------------ | ----------------------------: |
| Contact turns / classifications / adoptions            |                   22 / 21 / 4 |
| Errors / deferrals / attempt turns                     |                     1 / 0 / 0 |
| Elapsed / D1 wall / reported SQL time                  | 95.114 s / 85.250 s / 1.868 s |
| D1 RPCs / SQL statements                               |                   359 / 2,878 |
| Inventory fetches / cache hits                         |                       12 / 13 |
| Ownership passes / examined inputs / covered inputs    |                10 / 1,000 / 0 |
| Owners hashed / ownership phase                        |              1,000 / 20.832 s |
| Stop reason                                            |                    `deadline` |

The **20:31:23.628 UTC** snapshot, taken during that run, passed all **19**
aggregate checks with matching policy v5. It showed 2,833 unhashed owners,
8,981 pending inputs and 1,000 held claim inputs, with no copied evidence or raw
references. Claims encountered before their exact identity copies remain held;
this is unfinished coverage, not absence or a new upload permission. The run's
single error is `history_read:lotw:lotw_unavailable`; coverage remains incomplete
and the exact HTTP cause is unknown. These are bounded bootstrap observations,
not a steady-state comparison or production speedup.
Measure ownership initialization, first recognition and resolved idle work
separately; the 20:27 backup predates this progress.

The later 5a sample, **20:45:43.988–20:47:18.571 UTC**, makes 123 contact
turns, 89 classifications and 29 adoptions, with zero errors, deferrals or attempt
turns. It stops at the deadline after 94.583 seconds: 740 D1 RPCs / 6,496 SQL,
81.010 seconds D1 wall time and 4.664 seconds reported SQL time. Ten ownership
passes hash 834 owners, examine 1,000 inputs and cover 640 in 17.432 seconds.
The **20:50:15.919 UTC** aggregate passes all 19 checks with 640 covered,
5,981 pending and 3,360 held inputs. A later backup independently validates all
640 encrypted exact ownership records; bootstrap is still unfinished.

An isolated scheduling follow-up prioritizes identity metadata for owners just
hashed in the same bounded pass. On the identical verified 20:27 snapshot, it
reduces complete bootstrap from **135 to 103 passes**, **925 to 773 adapter RPCs**,
**24,602 to 21,230 SQL statements**, and **13,407 to 10,228 examined inputs**.
Both runs finish with 9,981 covered inputs, 3,327 cryptographically validated
exact copies, zero held inputs and unchanged protected tables. The actual
selection query reads 19 rows with either zero or 200,000 unrelated covered
inputs, using existing keyed indexes. This is a local bounded-query result,
not a 200,000-contact bootstrap or Worker capacity result. Independent review and
the full isolated check pass: **1,613 tests**, formatting, lint, both TypeScript
projects and the Worker build. Signed `59c320af` is included in the deployed
`f2c41cb3` release above. The complete live coverage checkpoint is separate from
these identical-snapshot local measurements; it does not prove their exact live
ordering or a causal speedup.

## Previous diagnostic release and bounded run — c4f51de8

Signed `c4f51de8` deployed at **2026-10-24 17:28:57.761108 UTC**, after
[full release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40114936899).
Independent **17:33:39.140 UTC** checks confirmed the sole deployment, eight
closed controls, active KEK version 1, healthy HTTPS and matching assets. All 33
migrations through `0034` are unchanged. See the [release receipt](deployment.md#fixed-history-scope-diagnostics-release-c4f51de8).

| First completed c4f cron, 17:30:42.737–17:31:25.276 UTC |                   Observation |
| ------------------------------------------------------- | ----------------------------: |
| Contact turns / classifications / adoptions             |                100 / 110 / 72 |
| Errors / deferrals / attempt turns                      |                     0 / 0 / 0 |
| Elapsed / D1 wall / reported SQL time                   | 42.539 s / 41.624 s / 6.863 s |
| D1 RPCs / SQL statements                                |                   856 / 3,675 |
| Inventory fetches / cache hits                          |                       3 / 107 |
| Stop reason                                             |             `database_budget` |

The release changes fixed diagnostic labels only. No new taxonomy failure was
observed in this run; neither its shorter duration nor zero errors establishes a
causal speedup, resolution of prior failures or sustained capacity. At
**17:33:38 UTC**, all 13 aggregate checks passed: 797 QRZ associations with complete
owners/markers/write blocks, 4,141 clean index rows, 3,327 covered LoTW exact claims,
778 legitimate archives and 3,722 retained bodies with no unexplained gaps. Attempts,
cutovers, proofs and pins were zero. The later **17:51:44.635 UTC** protected
backup of this same release contains 33 migrations and passes isolated restore,
credential/key decryption and repeated quarantine. It retains 3,327 LoTW claims
and 1,061 QRZ owners/markers; the dated 17:04 receipt remains separate evidence.

The ownership-evidence foundation, guarded write bridge, broader adoption and
partition-local read retry were not part of c4f or these run metrics. They are now
included in 5a427a30. Copied immutable envelopes still require their original KEKs
until guarded rewrap exists. The retry implementation retains only prior valid
pages, without advancing coverage after failures. Neither the historical runs nor
these changes establish active 200,000-contact coverage or export authority.

The later **19:43:59 UTC** read-only snapshot has 2,132 QRZ associations, 775
ambiguous, 437 mismatched and 489 pending routes; 754 ambiguous labels lack a
current-generation memo. All six sampled completed runs report zero errors,
deferrals and attempt turns. The latest run makes 40 contact turns / 33
classifications / 24 adoptions, taking 94.746 seconds and 323 RPCs / 1,343 SQL.
Its 93.807 seconds of D1 wall time includes only 2.385 seconds of reported SQL
execution; the remainder is not a measured query CPU cost. The 19:43 release
readback reconfirms c4f and all eight controls closed. This ongoing progress
does not measure the shared-read implementation deployed later in 5a427a30.

### Ownership bootstrap cost — isolated current-data rehearsal

At **2026-10-24 17:54:43 UTC**, the exact `11ea450a` foundation completed an
isolated in-memory backfill of the verified **17:51 UTC** production snapshot.
All **3,833 owners** were hashed and **9,981 inputs** were covered: 3,327 each of
identity, claim and mapping obligations. All 3,327 copied encrypted tuples passed
exact identity, owner, key and HMAC-bucket validation; zero inputs remained pending
or held. Existing claims, QRZ owners/markers, ledger, source/private data, cursors
and proofs stayed unchanged. No production or vendor calls occurred.

The original implementation needed **135 bounded passes**, **27,528 local adapter
calls** and **34,649 member statements**. Its 4.123-second SQLite runtime excludes
remote RPC latency and is not Worker capacity evidence. Repeating one such pass
per five-minute tick would require 135 ticks for this unchanged snapshot.

The reviewed batching implementation, now deployed in 5a427a30, completes the identical
snapshot in the same 135 passes with **925 calls / 24,602 member statements**,
zero held inputs and unchanged protected tables. Its native-D1 30-contact fixture
falls from **188 to 11 RPCs** and 248 to 188 statements. All 25 owned/Store cases,
types and scoped formatting pass. This preserves 100-owner/100-input and 4 MiB
bounds, version/ciphertext/key checks, missing-evidence holds and atomic two-query
publication; native batches contain at most 100 statements. Failed or unknown
acknowledgements propagate without an in-call retry. The first 5a scheduled
bootstrap sample is recorded above; complete coverage is verified in the later
f2c checkpoint. Sustained production cost remains unverified. Do not use a
synchronous full-tenant scan or raise vendor budgets to hide this cost.

### Integrated LoTW historical recognition — local measurements

Before source-read batching, the consumer's native-D1 fixture
processes 20 minute-time contacts across QRZ and LoTW, producing **40 read-only
associations** (20 per vendor),
zero attempts/uploads and no fabricated exact LoTW remote IDs or outbound claims.
These are local implementation measurements, not production capacity:

| Phase                                              | Contact turns / classifications / associations | Cohort RPCs | Whole-tick RPCs / SQL |
| -------------------------------------------------- | ---------------------------------------------: | ----------: | --------------------: |
| Initial recognition before shared source reads     |                                   20 / 40 / 40 |         315 |           503 / 1,628 |
| Initial recognition with shared source reads       |                                   20 / 40 / 40 |         124 |           312 / 1,379 |
| After all routes resolve and source bodies archive |                                      0 / 0 / 0 |           0 |             144 / 168 |

The first run makes three inventory fetches and shares at least 38 cache hits;
it is not the entirely pre-cached mixed-week fixture. The idle run has no cache
hits because no reconciliation work is selected. Its 144 RPCs remain scheduler
and maintenance cost, not zero-cost operation.

The minute fixture's former ceiling was 190 cohort RPCs for 20 completed QRZ
associations while LoTW remained held: **9.5 RPCs per association was a budget**.
The pre-batching measured ratio is **315 / 40 = 7.875**, and the integrated batched
run measures **124 / 40 = 3.1**. Both complete the same 40 associations with three
inventory fetches and at least 38 cache hits. The older 190-call ceiling alone
does not establish a same-work speedup. Separately, the pre-cached mixed-week fixture
already completed 40 associations at 158 cohort / 262 tick RPCs / 1,176 SQL. Its
existing **220-cohort-RPC ceiling remains a same-work acceptance guard** for the
new consumer, independent of the minute fixture's normalization.

Before shared reads, reverse-source comparison runs separately for each positive
route.
A successful comparison costs five RPCs / eight SQL statements without an
operation, or six / nine with the complete operation/event closure. This fixture's
one operation contact and 19 operationless contacts therefore account for about
**202 of 315 cohort RPCs** across both vendors. Raw LoTW publication already uses
one ownership lookup per at-most-eight-member adoption chunk. Bounded ownership
bootstrap is separate from this repeated source-read cost.

The shared-read implementation now passes that **unchanged 220-call limit**:

| Cached 40-route fixture                     | Cohort RPCs | Whole-tick RPCs | SQL statements |
| ------------------------------------------- | ----------: | --------------: | -------------: |
| Guarded consumer before shared source reads |         309 |             413 |          1,372 |
| Same consumer with shared source reads      |         118 |             222 |          1,123 |

Both runs complete the same 40 associations with zero inventory fetches, 40 cache
hits and zero attempts/uploads. The final repeat also passes. This is a local
same-work reduction; sustained throughput and 200,000-contact import capacity
remain unproven. See the implemented batch design and acceptance evidence below.

The integrated local check and release CI pass **all 1,610 tests**, formatting,
lint, both TypeScript projects and the Worker build. The signed implementation is
deployed with all eight controls closed; production throughput remains to be
measured independently of these local fixtures.

A separate native-D1 regression checks the actual exact-ownership finish/account
UPDATE used by stage and mapping winners. Its indexed pending/held predicate reads
**18 → 19 rows** after adding 4,000 unrelated covered obligations, and a late
unplanned pending input rolls back the mapping batch. Both focused cases pass;
this removes a tenant-wide accounting scan without changing winner or hold rules.

### Previous lookup and coverage release — 9aeab582

Signed `9aeab582149baa8af8fd6db8cc9cc318b2bc3739` deployed at
**2026-10-24 17:04:38.163667 UTC** as Worker
`950c081c-03b4-455f-8e31-b579fec56788`, at 100% traffic after
[full release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40112629290).
Independent **17:04:50.692 UTC** checks confirmed eight closed controls, healthy
HTTPS and matching assets, with all 33 migrations through `0034` installed.
The same 20-contact fixture saves 20 RPCs, with unchanged SQL count and guards.
The LoTW coverage-only change and QRZ retained-split correction pass all **122
history tests**; neither enables broader LoTW adoption or exports.

Earlier source-readiness checkpoint, 2026-10-24 UTC: baseline/drain/quarantine completed at 06:35:44
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

## QRZ first-insert request demand — exact-f2c local measurement

At **2026-10-24 23:00:21.504 UTC**, a protected native-D1 experiment ran the normal
`tick` path against fake vendors with exact `f2c41cb3` runtime and fixture parity.
It reused the [source-proof scheduler fixture](../tests/source-export-service.test.ts),
with QRZ-only exact contact/destination scopes, the normal quiet period, and
unchanged default budgets and guards. Source-boundary and LoTW capabilities stayed
false. Initial disabled-source/history setup is outside the measured turns.

| Measured enabled turn | Contacts considered | Preparations / successful fake INSERTs | LoFi requests / accepted admissions | QRZ requests / accepted admissions | Whole-tick D1 RPCs / SQL |
| --------------------- | ------------------: | -------------------------------------: | ----------------------------------: | ---------------------------------: | -----------------------: |
| Singleton             |                   1 |                                  1 / 1 |                               3 / 3 |                              4 / 4 |                217 / 290 |
| Small cohort          |                   3 |                                  2 / 2 |                               3 / 3 |                              9 / 9 |                307 / 435 |

Each turn used two LoFi forward syncs with limit 100 (canonical poll and final
drain), plus one backward collection with limit 25. The singleton used three
fresh targeted QRZ FETCHes and one INSERT. The small cohort used seven targeted
FETCHes and two INSERTs: the third contact received its history collision read
but did not pass the ordinary two-attempt background admission. Both turns had
zero errors or denied reservations. Inventory was already complete and cached,
with one cache hit per contact and no inventory FETCH. No STATUS, covering FETCH,
LOGID readback, renewal, operation reread or LoTW request occurred.

All measured QRZ admissions were background priority, subject to both the shared
**120 requests/five minutes** total and **24/five minutes** background allowance.
The fake vendor returned unambiguous successful empty selections. The separate
live-observed ambiguous-empty path needs targeted FETCH, STATUS and a complete
positive covering FETCH for each neighborhood; with one covering page, the three
current neighborhoods plus INSERT imply **10 requests/contact**. That is a static
request model, not a measured ten-request tick. Generic FAIL is never absence.

At 100 users × 100 new contacts/day, even the optimistic measured four-request
path needs **40,000 requests/day**, or **138.889 per five minutes**. The current
total allowance is **34,560/day**, an ideal ceiling of **8,640 contacts/day** before
inventory, retries, recovery or other work. The ten-request fallback model needs
100,000/day and has an ideal ceiling of 3,456 contacts/day. Background work has
only 6,912 requests/day, or at most 1,728 four-request contacts/day. These are
configured application-budget bounds, not upstream QRZ quotas or demonstrated
sustained capacity. Source collection can be shared, so its three requests in
these turns must not be extrapolated as a fixed per-contact cost.

Normal clean-ACK delivery does not include exact post-ACK readback; requiring that
adds a request. Local D1 timing does not measure production latency. This
experiment made no production/vendor calls, changed no runtime or limit, and
created no approval. Its protected aggregate receipt is
`ferry-qrz-demand-f2c-xyqyje03/result.json`. The separately authorized
[first live QRZ acceptance trial](qrz-pilot.md) remains the priority; the larger
usage target is not a new prerequisite for that singleton trial.

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

| Vendor | Current total requests / five minutes | Consequence at 100 accounts                                                                                                                                                                                                                                                                  |
| ------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LoFi   | 24, including at most 4 background    | Five-minute polling needs 100 requests. Equal polling takes at least about 21 minutes, or 25 minutes when all four background slots are used.                                                                                                                                                |
| QRZ    | 120, including at most 24 background  | The measured direct-empty first-insert path needs four calls: classifier read, preparation read, dispatch read and INSERT. 40,000 calls/day exceeds the 34,560/day total before maintenance or retries; see [request demand](#qrz-first-insert-request-demand--exact-f2c-local-measurement). |
| LoTW   | 40, including at most 8 background    | A new query-enabled contact currently needs at least six calls through observed receipt: classifier read, preparation read, two certificate checks, upload and readback. 60,000 calls/day exceeds the 11,520/day budget.                                                                     |

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

#### Planned QRZ request reduction

No part of this reduction is implemented. Preserve the final write-adjacent
duplicate query, immutable attempt and all after-budget source-proof, credential,
book, scope, lease, identity/ownership and exact request-body checks.
1. **Reuse the immediate history observation during preparation.** Return a
   short-lived in-memory empty observation from `service.reconcileContact` only
   after its complete query and successful guarded classification. Carry it
   through `prepareExportCohort` to the unmapped `qrz_fresh_insert` branch of
   `delivery.prepareDue`. Bind tenant/source/QSO/destination, query identity/range,
   contact semantics, credential/book/config and original read times. After the
   coordinator's final drain, require the refreshed semantics to agree and the
   normal source proof to be current. Expiry or changed bindings require the
   existing fresh read or a hold; never refresh observation timestamps. Do not
   persist/reuse it across invocations, corrections or unresolved attempts.
   `dispatchAttempt` still performs its own new neighborhood query. The best
   direct-empty path falls **4→3 requests/contact**, and the one-page fallback
   path **10→7**. Three requests would consume 30,000/day at the target load,
   leaving just 4,560/day for all other demand; this is an unmeasured design model.
2. **Share earlier same-book planning coverage only when useful.** A bounded
   group may share one fresh STATUS and complete positive cover when the same
   valid range contains every target. Keep existing date/page/byte/deadline bounds
   and independent filtering and commit guards for each contact. For N one-page
   fallback candidates, retaining N initial targeted reads but sharing planning
   STATUS/cover changes 7N requests to **5N+2**. Selecting a fresh planning cover
   directly could reach **4N+2**; neither solves the fallback-heavy target alone.
   Every serial INSERT retains a new final neighborhood and, when needed, its
   own fresh STATUS/cover. Do not share final absence across writes. A separate
   later cover-first strategy could avoid known-doomed targeted FETCHes, but
   still needs fresh complete coverage per write and its own measurement.

Acceptance requires native scheduler tests measuring the proposed 4→3 and 10→7
fast paths without budget changes. A neighbor added after the reused observation
must stop the final INSERT. Source changes during final drain, expired observations
or proofs, and late credential/book/template/route/mapping/claim changes must hold
or use the existing guarded read. Cross-contact/book reuse, prior-invocation tokens
and incomplete scans must never authorize preparation. Shared-cover tests must
include a neighbor relevant only to a later member, midnight coverage, changed
page anchors, scope changes and overflow with no partial absence. Lost INSERT
acknowledgements remain uncertain and cannot trigger replay or REPLACE.

The [QRZ API guide](https://www.qrz.com/docs/logbook/QRZLogbookAPI.html) does not
provide an empty-specific FAIL guarantee, a transactional read/write snapshot
fence or a numerical quota. Keep the existing ambiguous-empty fallback; MAX:0 or
a failed targeted query is not a shortcut to absence. Any further protocol-based
reduction needs scoped evidence for empty/count-only responses, pagination during
changes, book/key reassignment and the API's duplicate/time/mode behavior. A final
fresh query preserves today's protection but cannot exclude an external insertion
between that query and INSERT. Do not claim atomic vendor concurrency protection.

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

## Historical comparison index integration — deployed

Signed revision `6ff685a7f4991dec0fd0b368552233330bf692bf` deployed at
**2026-10-24 15:59:23.445021 UTC** as Worker
`aa64f26f-e2b7-4638-8e04-542854a912b0`, at 100% traffic. All **1,429 tests** and
required checks passed in [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40108165167).
Independent verification at **15:59:42.503 UTC** confirmed 33 migrations through
`0034`, all eight export controls closed, healthy HTTPS and matching browser assets.
The opaque source index, reverse comparison and association-only QRZ integration
are active. Production index coverage completed at **16:02:36.319 UTC**: all
**4,141** ordinary contacts were published, with zero dirty, rebuilding or unknown
entries and one initialized tenant key. The first post-index run and the
initialized-key backup/restore verification subsequently passed as described below.

Four protected index-maintenance invocations completed 35 passes and reported 3,441
publications. They took **41.834 seconds** in total and used **224 D1 RPCs / 7,150
statements**, with zero held rows and no vendor calls or source, ledger or attempt
writes; only index/state writes were permitted. Concurrent cron reported 1,000 rows
examined and 900 publications. These CAS publication counters can overlap and must
not be summed as distinct contacts; the final unique index count was 4,141. This
measures the initial backfill of this approximately 4,000-contact retained source
inventory, not a 200,000-contact import, historical reconciliation completion or
sustained throughput.

The first new scheduled run, **16:00:42.898–16:02:17.635 UTC**, preceded index
completion. It processed 105 contact turns and 89 classifications, with zero
adoptions, errors or deferrals, using **610 D1 RPCs / 4,474 statements** in
94.737 seconds (91.754 seconds of D1 wall time). It is not a post-coverage adoption
sample. At **16:03:00.447 UTC**, independent checks verified the index shape,
matching policy v4 and all 13 checks, with one initialized key and zero dirty,
rebuilding, unknown or missing index entries.

The first post-index run, **16:05:42.889–16:06:38.147 UTC**, processed **82 contact
turns / 74 classifications / 39 QRZ adoptions**, with zero attempt turns, errors
or deferrals. It took **55.258 seconds**, including **52.291 seconds of D1 wall
time**, and reported **916 D1 RPCs / 3,039 statements**, 25 inventory fetches and
54 cache hits. It stopped at `database_budget`. This confirms guarded historical
adoption on the deployed release; it is neither a steady-state capacity sample
nor a measured speedup over a comparable workload.

At **16:07:37.591 UTC**, all 13 aggregate checks passed: 39 QRZ mappings had matching
owners, association markers and write blocks, with zero orphaned mappings,
unreserved owners or missing blocks. All 4,141 index entries were present with
zero dirty, rebuilding, unknown or missing entries. All 3,327 LoTW exact claims
were covered, and QRZ outbound claims remained zero. Ordinary retention had
legitimately archived 36 resolved source bodies, leaving 4,464 retained bodies and
zero unexplained missing bodies; the opaque index survived those archives.
Eight closed controls, healthy HTTPS and matching assets were reconfirmed at
**16:07:02.175 UTC**. No vendor writes or production restore occurred.

The **16:27 UTC** production aggregate reached 221 QRZ associations, still with
zero attempts or exports. Of 3,114 persisted ambiguous QRZ outcomes, 3,110 lacked
a memo for the current ledger generation; these are not evidence that the new
reverse comparison rejected those current versions. The qualified post-index
outcomes included four remote-competitor ambiguities and 57 mismatches (56 plus
one in the aggregate categories). A protected **16:34 UTC** readiness plan found
one candidate with two source dependencies and no events, without source or
destination HTTP requests.
That plan collected neither a source proof nor fresh QRZ absence evidence.

At **2026-10-24 16:53:05.833 UTC**, the protected same-contact Node/D1 diagnostic
completed against frozen `6ff685a7` modules and the attested `aa64f26f` deployment.
It used **two source reads** (collection plus final drain), **two dependencies / zero
events**, one original atomic proof batch and **three QRZ reads** (targeted,
STATUS and successful covering fallback). The neighborhood was complete and
empty; strict final candidate, current-proof, audit, eight-control and zero-attempt
safety checks passed. It took **16.247 seconds / 110 D1 RPCs / 136 SQL statements**,
with **287,448 ms** of proof lifetime remaining at the final check. Normal guarded
source/proof checkpoints occurred, with no credential renewals, staging, attempts
or vendor mutations. This is one finite diagnostic observation, not Worker
execution, write acceptance, sustained throughput or export authority. Its proof
can expire or be invalidated by subsequent source progress; it also does not
verify execution of the later `9aeab582` runtime deployment.

In deployed `6ff685a7`, the weak worked-call/UTC-minute lookup uses three D1 RPCs and keyed
`(tenant, key_id, bucket_hash)` searches. A real-D1 regression with 4,000 unrelated
rows reads fewer than 140 rows for one candidate without scanning source
ciphertexts. Reverse comparison caps each cohort at 128 candidate QSOs, 256 distinct
retained dependencies and 4 MiB of ciphertext. Twenty one-contact mixed-week reverse
cohorts measured **120 RPCs / 160 statements / 2,919 rows read**, with zero writes.

The deployed baseline's complete 20-contact/two-destination fixture uses **178 cohort D1 RPCs / 282
whole-tick RPCs**, compared with **65 cohort RPCs** before reverse proof integration.
It verifies 20 QRZ associations and zero attempts/vendor writes. The extra key,
coverage, projection and commit checks are a measured cost; shared bounded metadata
and cohort work should be evaluated before broader rollout. Binding calls, SQL
statements and vendor requests are separate metrics. No request budget was raised.

Index backfill handles at most 100 rows and 4 MiB of encrypted bodies per
advancement, leaving omitted rows dirty for bounded continuation. The helper's
default is 50 rows; the service requests 100. Several advancements may occur in
one scheduler invocation, so this is not a 100-row-per-cron guarantee. Canonical
intake can publish accepted raw versions in its existing atomic checkpoint.
Unpublished or semantically changed rows block comparison until coverage is
restored; ordinary retention preserves known opaque buckets, holding only relevant
unavailable competitors. A legacy archived row without a published bucket needs
normal upstream replay before it can be localized safely.

### Local lookup scale experiment (2026-10-24)

A protected local Miniflare/D1 experiment ran the actual
`lookupSourceHistoricalIndex` implementation and migrations at `737eeca3`, using
a real encrypted candidate, stable tenant key and guarded backfill publication.
Unrelated opaque index rows belonged to a **paused synthetic source**, matching
the existing 4,000-row regression. They did not represent complete active-source
coverage or retained bodies for 200,000 contacts. Five native lookups per scale gave:

| Unrelated index rows | RPCs / SQL per lookup | Candidate rows read | Median elapsed | Maximum elapsed |
| -------------------: | --------------------: | ------------------: | -------------: | --------------: |
|                4,000 |                 3 / 3 |                 127 |      17.245 ms |       19.995 ms |
|              200,000 |                 3 / 3 |                 127 |      18.976 ms |       49.468 ms |

Both plans used the full `(tenant, key_id, bucket_hash)` seek without scanning
the index. Native metadata covered only the candidate `all()` statement;
the two `first()` calls do not expose metadata. Separate replays of all three
SELECTs read **133 rows** at each scale (3 state/key + 127 candidates + 3 guard).
Those replay calls and timings are excluded from the native lookup measurements.

Fixture construction was measured separately: schema plus the real candidate
took 1.538 seconds, 4,000 synthetic rows took 22.624 ms, and adding the remaining
196,000 took 1.390 seconds. This is metadata fixture construction, **not** a full
cryptographic source import or backfill. The complete experiment took 5.303 seconds.
The 200,000-row database occupied 81.7 MB; final Node RSS was 436 MB. Node RSS is
not the combined Node/workerd peak, and these are local resource observations.

Real published partial call-only, minute-only and fully unknown records remained
in their relevant candidate sets. A dense cohort of 128 exact records plus one
unknown returned `candidate_bound` with no candidate rows, still using three RPCs;
its separate all-SELECT replay read 455 rows. Activating the paused dirty source
invalidated the captured guard and held the next lookup as `index_incomplete`.

This supports bounded keyed lookup behavior at the tested index sizes. It does
not establish 200,000-contact active coverage, source ingestion, remote D1 latency,
complete historical reconciliation or end-to-end throughput. No production or
vendor calls were made, and no request limit or export permission changed.

### Lookup and coverage follow-up — deployed 9aeab582

Four signed commits form deployed `9aeab582`; all 1,485 release tests and required
checks passed:
- `dd544316` makes durable historical write blocks visible in metadata-only trial
  audits, including original routes and same-book aliases.
- `805952c6` combines the candidate SELECT and unchanged index guard in one native
  D1 batch: **two RPCs for the same three SQL statements**. All later commit guards
  remain mandatory. Forty-two source-index/reverse/service cases pass, including
  pre/post-batch races, incomplete coverage, unavailable keys and overflow.
- `07b26b8b` adds LoTW precision-aware neighboring-date coverage, resolving both
  weekly/split paths and retaining at most two complete current leaf guards.
  It changes neither the LoTW classifier nor ownership or exact receipt rules.
- `9aeab582` preserves both QRZ UTC date paths until split-leaf resolution, with
  the existing ±30m59s radius and shared 512-candidate bound. Four native-D1
  regressions fail before and pass after; all 122 history cases pass. QRZ currently
  has no split writer, and production has no split QRZ partitions. This corrects
  accepted retained-manifest coverage, not a demonstrated live scope-error cause.

The identical 20-contact fixture now measures **158 cohort / 262 whole-tick RPCs /
1,176 SQL statements**, versus **178 / 282** on `6ff685a7`. Twenty standalone reverse
cohorts use **100 RPCs / 160 statements**, versus 120 RPCs. Native metadata now
includes the guard SELECTs: 2,979 reported rows versus 2,919 reflects 60 newly
visible rows, not changed SQL work. These are local fixture results, not a
production speedup or sustained-capacity result.

The **17:05:22.396 UTC** production verification passed all 13 checks: 4,141 clean
published index rows, 462 QRZ mappings with permanent owners/markers/write blocks
and no gaps, and 3,327 covered LoTW exact claims. All 453 legitimate archives were
verified; 4,047 source bodies remain, with no unexplained missing bodies. Attempts,
cutovers, proofs, pins and temporary guards were zero. This is before the first
completed new-runtime cron. The last completed 17:00 old-runtime run had five
adoptions and 53 affected-contact errors; neither is evidence of this release's
performance. See the [dated deployment receipt](deployment.md#lookup-and-coverage-release-verification-9aeab582).

The first completed new-runtime cron, **17:05:42.632–17:07:16.980 UTC**, processed
**80 contact turns / 47 classifications / 38 adoptions**, with zero attempt turns
or deferrals. It stopped at `deadline` after **94.348 seconds**, using **552 D1
RPCs / 2,407 SQL statements / 92.033 seconds D1 wall time**, six inventory fetches
and 42 cache hits. Two diagnostic events affected 15 contacts: missing ADIF time
affected one; generic history-scope mismatch affected 14. Their causes remain
unresolved at this checkpoint; category refinement was deployed later in c4f. At
**17:07:28.689 UTC**, QRZ had 500 associations/owners and the index remained clean.
Of 2,765 ambiguous routes, 2,760 lacked a current-generation memo and five had
explicit post-index remote competitors; 103 were mismatched and 465 pending.
This is one workload sample, not a controlled speedup or sustained-capacity result.
Final **17:08:02.184 UTC** attestation reconfirmed the same sole deployment, eight
closed controls, active KEK version 1 and healthy matching HTTPS assets.

A separate protected repeat used the actual optimized implementation, whose
durable commit is `805952c6` and source-file SHA-256 is
`c3adff23561447feaf0f1f69b67c8c55f337ed8ced8ece2bd0ba9ba5eed18f9a`.
It retained the earlier experiment's real candidate/key/publication and paused
synthetic filler design. Five native samples per scale measured:

| Unrelated index rows | RPCs / SQL | Median local lookup | Maximum local lookup |
| -------------------: | ---------: | ------------------: | -------------------: |
|                4,000 |      2 / 3 |           13.442 ms |            20.107 ms |
|              200,000 |      2 / 3 |           14.795 ms |            18.517 ms |

The full-key seek is unchanged. Native batch metadata reports **130 rows**
(127 candidate-query + 3 guard-query); a separate replay including state/key still
reads **133 rows**. Partial/unknown buckets remain candidates, dense 129-row
cohorts hold without truncation, and source activation invalidates the old guard.
The five-sample timings are separate local runs, not a controlled remote-latency
comparison with the original `737eeca3` experiment above. Paused synthetic filler
does not establish 200,000 active-source coverage, import/backfill or end-to-end
reconciliation capacity. No production or vendor calls were made.

### Batched source comparisons — deployed, local measurements

The implementation introduced in `75cd3350` and deployed in `5a427a30` provides
`historicalSourceCandidatesBatch` in
`historical-source-candidates.ts`, supported by a batched index lookup in
`source-historical-index.ts`. It accepts one tenant and at most **20 route
requests**, returns results in input order, and keeps the singleton API as a
one-item wrapper. Service first gathers pure forward matches, then compares
bounded groups before adoption. This is not a general Store cache or reusable
authorization result. QRZ and LoTW still receive independent comparisons even
when their source reads overlap.

Its bounded phases are:
1. Capture and validate all request, destination and remote-record primitives
   before awaiting. Load one stable tenant key and covered index snapshot.
2. Derive and deduplicate weak call/minute bucket queries. Use a native read batch
   for keyed candidate SELECTs (each with its 129th-row overflow sentinel) and the
   unchanged captured-index guard. The index admits at most 512 distinct metadata
   rows and 1 MiB of metadata across the group. Never truncate candidates to
   permit a match.
3. Load union QSO metadata, all active source headers and exact destination
   snapshots together. Load every relevant base operation and retained live event,
   including events that do not change the effective projection.
4. Admit the **whole batch**, not each route, under 128 distinct candidate QSOs,
   256 distinct dependencies and **4 MiB total ciphertext**. Fetch, decrypt and
   project each unique body once. Global overflow returns `cohort_bound` before
   publication; service sequentially splits only that result, down to singleton
   if needed, with at most 39 calls for an original 20-route group and admission
   before every call. Intrinsic overflow, incomplete evidence and database errors
   never trigger splitting. Process larger route sets sequentially and release
   envelope/decoded caches between calls,
   rather than accumulating 40 separate 4 MiB allowances.
5. Compare each request independently against its complete relevant candidate set,
   then check all proposed unique results in one native read batch. Each result
   retains its own index/header, body-incarnation, operation-closure, destination
   and current-retention commit guard. Adoption still adds the independent
   inventory and selected source/reconciliation/context guards. A shared snapshot
   change invalidates results; sharing reads never supplies authority.

Unknown and unavailable archived competitors remain in the appropriate request's
candidate set. They cannot disappear because another route projected successfully.
Only the existing proven-noncontact exception may exclude a test operation.

The 20-route / ten-shared-body native fixture measures **five source-comparison
RPCs / 36 SQL / 1,736 rows read**. The index layer separately measures two RPCs
for 20 requests over three distinct windows. Complete operation closure adds a
bounded read phase. The full cached 40-route service result is the measured
118/222/1,123 table above; no vendor or service budget was increased.

Focused acceptance passes singleton/batch parity for both vendors and differing UTC
midnight windows; independent route/mode outcomes; complete shared event closure;
localized unavailable/unknown competitors; global byte/dependency/candidate
bounds; caller-input immutability; and key, source activation, body, credential,
policy or context races. Eight new candidate cases, 21 existing singleton cases,
seven index cases and the focused service cases pass. Native service tests also
cover failure/deadline isolation and a 135-row union that safely completes through
two smaller censuses without truncation. The full 1,610-case local and release CI
checks pass. Measure first recognition separately from resolved idle scheduling
and ownership bootstrap;
none establishes active 200,000-contact capacity.

### Comparison-key backup and rotation

The dated **17:04:57 UTC** postdeployment backup contains **33,946,884 bytes** and
33 migrations. Isolated restore decrypted the initialized comparison key and all
three current credentials, verified the HMAC key ID, and passed integrity/FK and
twice-quarantine checks. All 4,141 index rows, 462 owners/markers and 453 legitimate
archives were verified, with no attempts, cutovers, proofs or pins. Exact comparison
at **17:05:22.514 UTC** preserved all 3,327 claims and 39 owners/markers from the
prior 16:07 backup, including creation timestamps; 423 owners/markers were added,
with no changed or missing prior row. This recovery check supplies no export
authority, and no production restore or vendor mutation occurred.

Each tenant has a stable random HMAC secret encrypted in
`source_historical_state.key_envelope`. Initialization and rewrap use CAS; changing
the active KEK does not replace the secret or churn buckets. Preserve the full
state table and encrypted envelopes in backups, and verify restoration after key
initialization. The final **15:33 UTC** protected predeployment backup/rehearsal
included 4,141 ordinary retained contact bodies and preserved all **3,176**
destination claims through isolated `0033`/`0034` application, with clean
integrity/foreign-key checks and repeated recovery quarantine.

The **16:07 UTC** post-deployment protected backup contained **35,325,311 bytes**
and all 33 migrations. Isolated restoration, integrity/foreign-key checks, three
credential decryptions and repeated recovery quarantine passed. The initialized
tenant comparison key decrypted and matched its key ID; all 4,141 index rows,
39 historical owners and 39 association markers survived quarantine. All 36
legitimately archived-body checks passed, with zero attempts or cutovers. A
**16:08:10.506 UTC** comparison verified that all 3,176 full predeployment claim
rows, including `created_at`, were unchanged: the post-backup had 3,327 claims,
151 additions and zero missing prior claims. This was isolated restore validation,
not a production restore.

Retain old KEKs until every retained comparison-key envelope, including inactive
tenants, is rewrapped. Existing `private_data` rotation does not enumerate these
envelopes; intake/backfill rewrap on access, while lookup only decrypts. A missing
KEK holds wider QRZ comparison. The typed key-unavailable path lets canonical
source intake continue and leaves index rows dirty; it does not swallow SQL,
schema or CAS failures. Published archived buckets must not be discarded merely
because their source body is no longer retained.

### Earlier prototype and production baseline (2026-10-24)

The first completed run of deployed revision `0dad1031` at 13:45:43–13:47:22 UTC
processed 84 contact turns, classified 113 destinations and adopted 44, with zero
errors, deferrals or attempt turns. It stopped at the deadline after 98.845
seconds, reporting 419 D1 calls, 2,590 statements, 1,876,280 rows read and 97.938
seconds of database wall time. This preceded the new index integration and does
not measure its deployed cost.

A protected in-memory SQLite prototype seeded 200,000 synthetic source contacts,
10,000 remote records, 10,000 operation versions and 100 coverage scopes. Candidate,
reverse-competitor, dirty-context and unknown-scope queries used keyed index
searches without a source-table or ciphertext scan. Warm local medians were
0.0035–0.0050 ms, with 40–118 SQLite VM instructions for the tested lookups.
Seven scenarios covered a unique pair, competing arrivals, body and context
changes, localized unknown scope, incomplete coverage and overflow at 101 rows.
The entire synthetic run took about 2.34 seconds and made no live calls or writes.

That prototype validated a lookup shape, not production D1 latency or a complete
200,000-contact import. It retained synthetic timestamps rather than the final
opaque representation. The new implementation adds privacy, incremental coverage,
legacy-write invalidation, exact dependency guards and historical ownership, but
still needs construction-cost, dense-cohort, full-import and sustained workload
measurements. Neither the prototype nor the focused integration fixtures prove
end-to-end 200,000-contact capacity. See the
[historical matching contract](bootstrap.md#historical-association-and-vendor-matching).

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
