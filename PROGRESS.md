# Implementation progress

## Current production and export acceptance — 2026-10-25 UTC

Signed `0386af30312494bf31c2fd45f833e9c2a41534e9` serves production as Worker
`fbaf8af8-d51c-44e9-a5ca-53e29c2eb5c3`, deployment
`a909a390-1b0d-418b-8bfb-80a72949c9dd`, sole 100% traffic. All **1,653 tests**
and required checks pass in [exact-release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40154037329).
There are 36 installed migrations through `0037`; all eight export controls
remain closed. The release includes QRZ observation reuse/planning/re-entry and
LoTW signing profile 3. See [deployment evidence](docs/deployment.md).

The owner authorized the reviewed QRZ singleton with a fresh backup, at most one
INSERT, exact readback and recovery. Two preparations stopped before any attempt
or dispatch, independently verified by recovery. The corrected operator tool
then received **one QRZ INSERT acknowledgement** by **03:55:14.887 UTC**. The
normal runtime stored delivery and its LOGID; immediate exact readback remained
unresolved. No resend or additional INSERT occurred. The temporary preview was
disposed; automatic exports and LoTW remain disabled.

The **03:56 UTC** backup and isolated recovery verify exactly one delivered
attempt, accepted receipt, matching identity claim/source-proof pin and
decryption of the preserved original artifact after normal outbox purging.
Every baseline immutable row is unchanged; credential/key checks, integrity/FKs
and two isolated quarantines pass. Next: complete a read-only exact LOGID and
field/narrative comparison. Only after acceptance should small checked QRZ
batches and scheduled delivery precede automatic QRZ scope; LoTW follows its
own signing/upload/readback acceptance. The [roadmap](ROADMAP.md) and
[pilot guide](docs/qrz-pilot.md) carry the current status. Older observations
below retain their original release and instruction context.

## Previous production — ownership bootstrap and deletion status (f2c41cb3)

Signed `f2c41cb3a929ae3d3545e235894027b84fbf09fb` deployed read-only at
**2026-10-24 21:29:41.127501 UTC**, Worker
`fc1f2a5b-13e0-4509-ba03-9c93856c6464`, deployment
`5cd52bea-75ce-40ed-be6c-f847c904e36d`, at sole 100% traffic. All **1,617 tests**
and required checks passed in
[release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40132320522)
at **21:26:36 UTC**. Independent checks at **21:30:27.888** and **21:35:53.773 UTC**
confirmed all **eight export controls closed**, active KEK 1, healthy HTTPS and
matching assets. All **36 migrations through `0037`** remain installed.

This release prioritizes exact identity copies for newly hashed owners within
the existing bounded maintenance pass and recognizes authoritative LoFi
`status: "deleted"` as additional tombstone evidence. It retains the deployed
QRZ/LoTW historical association consumers, permanent association-only write
blocks, mandatory ownership bridge and shared source comparisons. Exact receipt
recovery remains separate; no historical association grants upload authority.

At **21:32:51.368 UTC**, all **19 aggregate checks** pass: **9,981 ownership
inputs covered**, zero pending/held inputs, zero unhashed owners and **3,327 exact
copies**. The **4,146-row source index** is clean, with **2,689 QRZ owners and
markers**. Raw references, attempts, cutovers, proofs and pins are zero.
Ownership bootstrap is complete at this checkpoint; this does not establish
fresh source/vendor evidence, completed exception review or export readiness.

The **21:28:43.196 UTC** PRE and **21:30:41.035 UTC** POST backups contain
identical **41,811,658-byte** SQL snapshots. Recovery verifies **3,294 populated
exact evidence envelopes**, three credentials, the tenant key, integrity/FKs and
two isolated quarantine passes. The **21:35:43.166 UTC** comparison preserves
all immutable claim, owner, marker and exact-evidence fields. The later
**21:36:47.379 UTC** backup contains **42,144,346 bytes**, verifies all **3,327
exact envelopes** and **2,702 QRZ owners/markers**, and passes the same restore,
crypto and quarantine checks. At **21:37:57.619 UTC**, comparison preserves every
prior immutable row, with **33 exact copies and 13 QRZ owners/markers added** and
zero prior rows changed or lost. Populated raw-reference recovery remains open
because that table is empty. No production restore or vendor mutation occurred.

The first f2c cron, **21:30:48.324–21:31:50.809 UTC**, made **220 contact turns /
380 classifications / zero adoptions**, with zero attempt turns and four
affected-route errors. Fixed-category readback at **21:37:23.816 UTC** identifies
one QRZ history-read event affecting those four routes. The exact-key audit
at **21:40:20.901 UTC** confirms stored `history_read:qrz:unknown`; its cause is
unresolved. The run took **62.485 seconds**, using **857 D1 RPCs / 6,865 SQL
statements**. An overlapping idle run took **9.962 seconds / 62 RPCs / 535 SQL**
with zero errors. These samples establish neither a causal speedup nor sustained
or 200,000-contact capacity; overlapping runs must not be summed as throughput.

The successful **21:10:12.733 UTC** same-contact cloud source-proof/QRZ observation
used the then-deployed `5a427a30` code. Its proof has expired; fresh exact evidence
on f2c, scheduled proof-path verification, exception review, populated raw-history
recovery and scoped first-write acceptance remain open. **Keep exports disabled**;
the owner must change that instruction before any trial. See the
[remaining actions](#next-action-and-rollout-boundaries) and
[deployment receipts](docs/deployment.md).

## Previous production — inventory diagnostics (c4f51de8)

Signed `c4f51de821d7d5867a19b1710fc188659b9d3771` deployed at
**17:28:57.761108 UTC**, Worker `7666c159-2a0b-463b-a08b-69295d8653a6`, deployment
`05e67989-f6bb-4a41-9ea9-d8c1a53d5a30` at 100% traffic. All **1,488 tests** and
release checks passed in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40114936899).
The **17:33:39.140 UTC** independent attestation confirmed all eight closed
controls, HTTPS/assets and active KEK 1. All 33 migrations through `0034` remain.
Fixed inventory error categories add detail without changing matching decisions.

The first cron, **17:30:42.737–17:31:25.276 UTC**, made 100 contact turns,
110 classifications and 72 adoptions, with zero errors/deferrals/attempt turns.
It stopped at the database budget after 42.539 seconds and 856 RPCs / 3,675 SQL
statements. This is one sample, not proof of a causal speedup or resolved errors.
All 13 aggregate checks passed at **17:33:38.015 UTC**: 797 QRZ owners/markers/
write blocks cover all mappings, the 4,141-row index is clean, 3,327 LoTW claims
cover their mappings, and 778 legitimate archives plus 3,722 retained bodies
account for source storage. Attempts/cutovers/proofs/pins/temp guards are zero.
At **17:34:16 UTC**, QRZ has 2,432 ambiguous, 135 mismatched and 469 pending routes;
2,423 ambiguous labels lack a current-generation memo. Nine post-index checks
report eight remote competitors and one location-detail hold. This is ongoing
reconciliation, not completed exception review or export readiness.

## Historical c4f follow-up checkpoint — subsequently deployed

The following records the implementation checkpoint before the `5a427a30`
release. Its foundation, write bridge, broader LoTW consumer and bounded retry
are now deployed; the current f2c coverage and recovery evidence is above.

The observation-only LoTW ownership foundation adds migration `0035`, permanent
owner/input metadata and encrypted exact evidence across old/inactive/reconnected
destinations. Twenty foundation/Store cases and four delivery/recovery cases pass.
An isolated rehearsal on the verified 17:04:57 backup preserved all 58 prior tables,
3,327 claims and 462 owners/markers through migration; repeated quarantine
preserved all new registry tables. Production had not applied this migration at
that checkpoint. The registry alone grants no adoption/write authority.
Staging/dispatch/mapping bridges and the broader LoTW classifier were subsequent
work; copied evidence still needs its referenced KEKs until a bounded rewrap
path exists.

Partition-local failed-read retry now suppresses later unsent cohorts for at most
15 minutes, without saving failed evidence or advancing a cursor. All 81 focused
cases and independent review pass. Combined validation passes 161 history/Store/
foundation cases plus the mixed-history integration, preserving 158 cohort /
262 total RPCs and 1,176 statements. Types, lint, format and Worker build pass;
full release CI and deployment were pending at that checkpoint. All exports
remain disabled.

## Comparison and coverage follow-up — deployed read-only

Four signed commits through `9aeab582149baa8af8fd6db8cc9cc318b2bc3739` deployed
at **2026-10-24 17:04:38.163667 UTC** as Worker
`950c081c-03b4-455f-8e31-b579fec56788`, deployment
`f4213a4e-e67e-4ef8-8581-41196f47f14f` at 100% traffic.
All **1,485 tests** and required checks passed in
[release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40112629290).
Independent verification at **17:04:50.692 UTC** confirmed healthy HTTPS,
matching assets and all **eight export controls closed**. This release excludes
permanent historical write blocks from
first-insert audit suggestions, combines the unchanged source-index candidate and
guard SELECTs in one D1 batch, and retains both required UTC date paths through
LoTW and accepted QRZ split inventory. Broader LoTW adoption is still separate.

Focused checks passed: 42 source-index/reverse/service cases, 122 history cases,
and all 11 audit cases, plus formatting, lint, types and the Worker build. The
20-contact fixture falls from 178 to **158 cohort RPCs** and 282 to **262 whole-tick
RPCs**, with the same 1,176 statements and guarded outcomes. This is a measured
local reduction; sustained production capacity remains unverified.

At **17:05:22.396 UTC**, all 13 aggregate checks passed: 33 migrations through
`0034`, 4,141 clean published index rows, 462 QRZ mappings with permanent owners,
association markers and write blocks, and all 3,327 LoTW exact mappings covered
by claims. There were no ownership gaps, attempts, cutovers, proofs, pins or
temporary write guards. All 453 missing ordinary bodies were legitimate resolved
archives; 4,047 retained bodies account for the remaining source rows.

The protected **17:04:57 UTC** backup retained 33,946,884 bytes and passed isolated
restore, integrity/foreign-key checks, three credential decryptions, tenant-key
decryption/HMAC-ID validation and repeated quarantine. Exact comparison at
**17:05:22.514 UTC** preserved all 3,327 prior claims and all 39 prior owners and
markers, including creation timestamps; 423 owners/markers were added and none
changed or disappeared. No production restore or vendor mutation occurred.

The **17:05:22 UTC** snapshot has QRZ 462 mapped / 2,810 ambiguous / 100 mismatched /
461 pending routes; LoTW has 3,327 / 7 / 160 / 339, with zero adoption conflicts.
It precedes the first completed new-release cron and is not a sustained capacity
result or completed exception review. The separate fixed-category history-error
patch and broader LoTW ownership foundation are not deployed in this revision.

The first completed new-release cron, **17:05:42.632–17:07:16.980 UTC**, made
80 contact turns, 47 classifications and 38 adoptions, with zero attempt turns
or deferrals. Its 15 affected-contact errors came from two diagnostic events:
missing time evidence affected one contact and generic partition-scope rejection
affected 14. Those contacts remain held; the old generic scope counter cannot
identify the cause. The run stopped at its deadline after 94.348 seconds,
552 D1 RPCs / 2,407 statements and 92.033 seconds of database wall time. This
unequal workload does not establish a production speedup.

At **17:07:28.689 UTC**, QRZ has 500 associations/owners, 2,765 ambiguous labels,
103 mismatches and 465 pending routes. Of the ambiguous labels, 2,760 lack a
current-ledger-generation memo; five have post-index checks identifying remote
competitors. These hints still do not prove current canonical projection or exact
matching-policy provenance. The index remains clean and attempts/cutovers remain
zero. Continue fresh revisits, diagnose the fixed inventory failures, and complete
the LoTW ownership/write bridges before enabling its broader classifier.
Independent verification at **17:08:02.184 UTC** reconfirmed the same sole Worker,
all eight closed controls, active KEK version 1, HTTPS and matching asset hashes.

The **16:27:05 UTC** aggregate separates processing backlog from established
exceptions: QRZ has 221 associations and 3,114 ambiguous labels; 3,110 ambiguous
routes lack a current-ledger-generation memo, while four have post-index checks
identifying competing remote records. Most labels still need a current revisit.
Memo time alone does not prove current canonical projection or exact policy
provenance. The index remains clean; attempts, cutovers and stage guards are zero.

A current-release SELECT-only planner succeeded at **16:34:42 UTC** for one fixed
contact, with two source dependencies and no events. Both destination metadata
checks passed, including zero historical write blocks. It made no source/vendor
requests, observations, proofs, stages or attempts. The same fixed contact then
passed the bounded source-proof and QRZ-read composition at **16:53:05.833 UTC**
against deployed `6ff685a7`: two normal source reads (dependency collection and
final canonical drain), two dependencies/no events, one immutable proof batch,
and three QRZ reads (targeted FETCH, STATUS and covering FETCH). The final proof,
route, credentials, ownership and eight closed controls remained current; QRZ
returned a complete empty neighborhood. No signing, staging, attempts, cutovers
or vendor mutations occurred. This finite host diagnostic used separately hashed
runtime/audit code; it is neither scheduled Worker execution nor write-acceptance
evidence. The proof had 287,448 ms remaining at the final check and must be renewed
for a future write; it grants no export authority or global source-completeness
claim.

## QRZ historical association integration — deployed and verified read-only

Signed revision `6ff685a7f4991dec0fd0b368552233330bf692bf` deployed read-only at
**2026-10-24 15:59:23.445021 UTC**, deployment
`6fee8987-3084-4519-809e-e4c943b9a524` at 100% traffic. Worker
`aa64f26f-e2b7-4638-8e04-542854a912b0` was created at
`2026-10-24T15:59:22.49107Z`. All **1,429 tests** and required release checks passed
in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40108165167).
Independent verification at **15:59:42.503 UTC** confirmed all **eight export
controls closed**, healthy HTTPS, matching hashes for all three assets and all
33 migrations through `0034`. No vendor writes occurred.

The wider QRZ historical matcher is now deployed.
Migrations `0033`/`0034` add the opaque source comparison index, durable book-scoped
LOGID ownership and association-only write restrictions. Reconciliation now
requires a unique candidate in both directions, current retained source/context
coverage and atomic inventory/ownership guards. Minute-only times remain intervals;
original source and remote values are preserved.

All QRZ historical adoptions made by this path, including exact-time matches,
are association-only. Source edits or reconnects cannot promote them to INSERT,
REPLACE or DELETE authority. Existing exact Ferry receipt verification and mapped
readback are unchanged. Broader LoTW time-window adoption remains separate work.

Index backfill completed at **16:02:36.319 UTC**: all **4,141** retained ordinary
contacts have published index entries, with zero dirty, rebuilding or unknown
entries and one initialized tenant key. Four bounded manual invocations and
scheduled work contributed; their publication counters can overlap and are not
added to derive the unique total. Manual backfill had zero held entries and made
no source, ledger, attempt or vendor writes. The index and matching policy version
4 passed all 13 aggregate checks at **16:03:00.447 UTC**. This verifies the retained
comparison index, not universal upstream completeness.

The first completed run on this release ran **16:00:42.898–16:02:17.635 UTC**,
before index completion: 105 contact turns, 89 destination classifications and
zero adoptions, errors or deferrals. It reported 1,000 index entries examined,
900 published and zero held. The run made 610 D1 RPCs / 4,474 statements in 94.737
seconds, with 91.754 seconds of database wall time. These are one-run measurements,
not sustained capacity or completed association verification.

The first post-index run, **16:05:42.889–16:06:38.147 UTC**, processed 82 contact
turns and 74 destination classifications, making **39 adoptions** with zero
attempt turns, errors or deferrals. It stopped at `database_budget` after 55.258
seconds: 916 D1 RPCs / 3,039 statements, 52.291 seconds of database wall time,
25 inventory fetches and 54 cache hits. This is a bounded successful observation,
not a sustained throughput or 200,000-contact capacity result.

The **16:07:37.591 UTC** aggregate passed all 13 checks: 39 QRZ mappings have
39 permanent owners, association-only markers and write blocks, with no
unreserved mappings, orphan associations or missing blocks. All 4,141 source-index
entries remain published and covered. All 3,327 LoTW exact claims cover their
mappings; QRZ outbound claims, attempts, cutovers, proofs, pins and temporary
write guards remain zero. After both destinations resolved, 36 source bodies
were legitimately archived; 4,464 remain and no missing body is unexplained.
Matching policy version 4 is active.

The **16:07:37.728 UTC** route snapshot has 3,833 QRZ routes: 39 mapped,
3,359 ambiguous, 16 mismatches, 419 pending and zero conflicts. LoTW has 3,327
mapped, seven ambiguous, 161 mismatches and 338 pending routes. The remaining
holds have not yet been established as manual exceptions.

The protected postdeployment backup started at **16:07:07 UTC** and verified
35,325,311 bytes with all 33 migrations. Isolated restore, integrity/foreign-key
checks, all three credential decryptions and repeated quarantine passed. The one
initialized index key decrypted and matched its HMAC-derived key ID; all 4,141
index rows and 39 owners/association markers survived quarantine. All 36 archived
body checks passed, with zero attempts/cutovers. At **16:08:10.506 UTC**, exact
comparison of all seven fields, including `created_at`, preserved every one of
the 3,176 predeployment claims: 3,327 postdeployment claims, 151 additions and
zero missing or changed claims. No production restore or vendor write occurred.

All eight controls, healthy HTTPS and asset hashes were reconfirmed at
**16:07:02.175 UTC**. QRZ deployment, index, ownership and backup verification are
complete for this rollout. Exports remain disabled; broader LoTW adoption,
remaining-history review, sustained throughput and the refreshed first-write
proof packet remain open. A trial also requires a changed owner instruction.

The 20-contact/two-destination fixture now uses **178 cohort D1 RPCs / 282 for the
whole tick**, versus 65 cohort RPCs previously. It verifies guarded associations,
not a throughput improvement or 200,000-contact capacity. The final predeployment
backup verified at **15:33:54 UTC** contains 4,141 ordinary retained contacts with
no missing or archived bodies. Isolated migration rehearsal preserved all 3,176
exact destination claims and passed integrity, foreign-key and repeated quarantine
checks. Preserve the new encrypted
tenant comparison-key envelopes and their wrapping KEKs in subsequent backups;
see [capacity and key lifecycle](docs/capacity-plan.md#historical-comparison-index-integration--deployed).

## Previous verified release (0dad1031)

Signed revision `0dad1031507bde4798bedef68e12c582f3af1889` deployed at **2026-10-24 09:43 EDT**, Worker
`6d745929-708d-40e3-bd00-d29c084185f3` at 100% traffic. All **1,373 tests** and required release checks
passed in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40098125350).
Independent version, HTTPS and asset checks confirm all **eight export controls
closed**. All 31 migrations and 32 mandatory guards remain verified; no migration
or vendor mutation occurred.

Historical grid compatibility now accepts valid nested **2/4/6/8-character**
regions for both QRZ and LoTW under the existing exact-identity, other-field and
ownership checks. Original source and remote precision remain intact; new exports
retain the most accurate supported source value. The separate published
**±30-minute candidate policy** is implemented and tested, including primary-mode
and LoTW mode-group comparisons, UTC precision, bounded inputs and unknown-data
holds. At this release it had no production reconciliation consumer and granted
no adoption, absence, correction or export authority.

The first completed run on this release ran **13:45:43–13:47:22 UTC**:
84 contact turns, 113 destination
classifications and 44 adoptions, with zero attempt turns,
0 errors and 0 deferrals; it stopped at
`deadline` after 98.845 seconds.
The aggregate snapshot at `2026-10-24T13:47:30.260Z` records
**1,360 LoTW adoptions** and
1,360 retained destination claims, with all mapped
LoTW identities covered. Export attempts, cutovers and temporary stage guards
remain zero. Policy version 3 is active. These are read-only reconciliation
measurements, not sustained capacity or completed cross-vendor contacts.

The next work at that checkpoint was the bounded source comparison index,
current source/remote uniqueness, durable historical ownership and association-only
stage/dispatch restrictions.
Extend LoTW retained coverage across UTC day/week boundaries before using the
wider window for adoption. Then review actual identity/location conflicts and
refresh exact source/vendor evidence for the separate export-readiness packet.
Exports remain disabled; no first-write trial is authorized by this release.

## Earlier matching correction release (ba8c982a)

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

### Earlier first-insert safeguards release (12f636b3)

Signed revision `12f636b312c9192b755188faf06d66171d485da5` deployed read-only at **2026-10-24 07:59 EDT**
(`2026-10-24T11:59:10.901859Z`), as Worker `bd6ff427-351d-463c-9b7d-4395e256117d` at 100% traffic.
All **1,338 tests** and required release checks passed in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40090915890).
Independent readback verified all **eight export controls closed**, healthy HTTPS,
and matching dashboard assets. All 31 migrations through `0032` are installed;
source membership is ready, all 4,500 retained rows have bodies/incarnations,
380 LoTW identity claims remain covered, and export attempts, cutovers, pins and
temporary write guards remain zero. Diagnostic source proofs are temporary and
are not write authorization.

Exports remain disabled. The separate QRZ and LoTW first-insert safeguards,
source collector expansion and bounded proof-clock admission are now deployed.
Next: refresh the exact contact's source proof and fresh QRZ evidence on this
release, then prepare its read-only trial packet. LoTW separately needs a complete
empty three-day report, current certificate checks, and eventual signed upload
and exact readback acceptance. No trial runs under the keep-disabled instruction.
Global source completeness, historical exception review and sustained capacity
remain separate unresolved work. Closed-gate cron continues reconciliation but
skips export proof creation; waiting for cron alone cannot close those checks.

The fresh 11:48 UTC protected backup passed isolated restore, three credential
decryptions and repeated recovery quarantine. The 11:49 migration rehearsal
preserved all 56 tables and 33,903 rows, with unchanged existing triggers and
clean integrity/foreign-key checks. Migration `0032` was then applied remotely
only by the guarded disabled deployment. No vendor write or production restore
occurred.

The first completed scheduled run after deployment ran from **08:01:51 to
08:03:23 EDT** (12:01:51–12:03:23 UTC): 63 contact turns and 42 destination
classifications in 92.154 seconds, with zero attempt turns. It stopped at the
soft deadline after 600 D1 calls/1,837 statements and 86.767 seconds of database
wall time. Nine affected-contact errors were two LoTW-unavailable, two QRZ
history-scope mismatches and five QRZ missing-ADIF-time results; 21 vendor-budget
deferrals were separate. These remain held rather than becoming absent or
exportable. This verifies scheduled reconciliation on the new release, not the
export-proof/signing path or sustained throughput.

A protected LoTW three-day diagnostic stopped at **08:03:26 EDT** before any
remote database or vendor call: the pre-deployment snapshot yielded zero
candidates satisfying the strict selection predicate. An isolated repeat confirmed
one selection read, zero inspected candidates and zero writes. No alternate
contact or weaker predicate was used. Thus fresh three-day LoTW evidence remains
outstanding, as does the final-release joint source/QRZ proof refresh. The helper
was independently reviewed against all 93 runtime file hashes and passed 16
focused offline tests; that is implementation evidence, not a successful live read.

## Earlier observations

Current checkpoint, 2026-10-24 UTC; independent QRZ first-insert authority and
bounded 100-record source baseline complete; cloud source/QRZ and LoTW reads passed:

Signed revision `02e3dc89b99a5d7428c01b6a09596a105784eb11` deployed read-only
at 06:09:06 UTC as Worker `da7b7b70-6b7e-4cab-b9f6-f4b88f38390d`, at 100% traffic.
All **1,178 tests** and required checks passed in [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40068069314).
Independent 06:09:17–18 checks confirm healthy service, matching hashes for all
three assets and all seven export controls closed. Health reports no active
export mode and `sourceBoundaryVerified:false`. All 30 migrations through `0031`
are applied. The 380 LoTW identity claims have no uncovered mappings; attempts,
cutovers, proofs, pins and temporary guards were zero at release verification.
All 4,500 source bodies had incarnations, and 2,155 positive observations had no
future or partial metadata.
The production baseline, forward drain and quarantine handoff completed at
**06:35:44.881 UTC**. The policy is `ready`: all 218 operations and 4,282 QSO-stream
records—4,500 retained rows—are members of the current epoch, with zero unseen
retained rows. The 4,130 eligible contacts are eligible for reconciliation
processing, not authorized exports.

The 06:35:43–06:36:10 run resumed normal reconciliation: 62 contact turns and
60 destination classifications in 27.187 seconds, with four errors and 50
deferrals before the `database_budget` stop. It made 871 D1 calls containing
2,179 statements; database wall time was 24.125 seconds. These are processing
turns and classifications, not unique completed contacts or sustained capacity.

At **09:20–09:21 UTC**, a temporary cloud comparison with the two committed
clock-admission modules minted one current source proof. Fresh QRZ reads then
found an empty neighborhood for that same contact; its exact proof was still
current after final checks, with 271,806 ms remaining. A separate, complete LoTW
query for the pinned contact returned zero records with stable scope. All seven
controls stayed closed, and attempts, cutovers, stage guards and vendor mutations
stayed zero. The comparison was disposed without changing production traffic.

The new clock check admitted the original proof after one database read, with D1
9 ms past creation; no timer wait occurred in this sample. Deterministic tests
separately reproduce a 40 ms lag and verify catch-up without changing evidence or
retrying a batch. The fix passed 43 focused checks and independent review. The combined unreleased
changes then passed all **1,233 tests** and the full release check: formatting,
lint, types and the Worker build. This is an unreleased two-module comparison over
`02e3dc89`, not scheduled production validation or vendor upload acceptance.

At **08:12:53 UTC**, exact deployed source code minted a current source proof
and observed fresh QRZ absence for the **same contact**. One positive collection
and a final canonical drain covered two dependencies, with no events. QRZ used
one targeted FETCH, one STATUS book verification and one complete covering FETCH.
Strict keyed eligibility and the exact proof passed again after QRZ and closed-gate
verification, with 291,986 ms of proof lifetime remaining. Attempts, stage guards,
cutovers and vendor mutations stayed zero.

This was a protected Node diagnostic against real source services and production
D1, not scheduled Worker or upload acceptance. The original proof guards and the
deployed 25-record response bound were unchanged. One diagnostic clock-admission
SELECT required no explicit wait and observed D1 49 ms past proof creation; its
extra I/O delays minting, so the earlier clock-failure hypothesis remains unproved.
The evidence expires and must be refreshed before any future authorized write.

At **09:05:45 UTC**, a temporary Cloudflare Worker preview reproduced the atomic
proof rejection after successful collection and final drain. The same deployed
code and original proof guards ran without a clock barrier. Later predicate
checks passed, with D1 observed 47 ms behind the Worker; clock ordering remains
an inference, not a confirmed transaction-time cause. QRZ and LoTW follow-ups
were skipped. The preview was disposed and the production version, assets and
seven closed controls were independently rechecked. See the
[cloud diagnostic evidence](docs/evidence-lofi.md) for bounds and limitations.

The prepared collector fix requests 25 records but accepts bounded timestamp
groups up to 100 per stream, with whole-page validation and unchanged proof/request
limits. Both collector changes later shipped in signed release `12f636b3`, whose
full release CI passes 1,338 tests. The 1,184-test checkpoint described here
predates that release.

A new protected SQL backup passed verification at **08:14:29 UTC** against all
30 installed migrations, with no pending migration applied. Isolated restore,
integrity/foreign-key checks, all three credential decryptions and two quarantine
passes succeeded. It preserves 4,500 source rows, 380 identity claims, one source
proof and its retention row, and zero attempts/cutovers. The deployed release,
assets and all seven closed controls were rechecked at 08:13:50. No production
restore or vendor write ran.

At 08:15:11, the [unsigned LoTW preflight](docs/evidence-lotw.md) validated one
retained contact's canonical fields, full eight-character grid and stored
certificate/date compatibility. The LoTW route remains `inventory_pending` with
no first-insert eligibility. No signing or fresh vendor request occurred;
separate LoTW authority and actual upload/readback acceptance remain open.

The subsequent LoTW review found that contradictory or malformed query records
could be discarded before an absence decision. The committed local fix validates
every record against the sent scope, preserves supported historical precision,
and gives rejected responses fixed diagnostic categories. The full 1,216-test
release check passed; the diagnostic follow-up passed six focused tests and
typecheck. Push and deployment remain blocked on 1Password signing. Production
remains on `02e3dc89`; this change grants no export authority.

The earlier 07:38:44 QRZ-only check observed absence without a source proof;
the 08:12:53 combined observation above closes that evidence gap for one sample.
The 06:55 candidate had a nearby record and remains unsuitable for absence-based
insertion. No historical association or precision hold was waived. All seven
export controls remain closed, and the owner's keep-disabled instruction applies.

The initial larger-page runs preserved the saved cursor and existing request
limits. Their variable page counts and D1 latency are recorded in the
[capacity measurements](docs/capacity-plan.md#bounded-100-record-baseline-follow-up-deployed-0609-utc).
Baseline completion does not establish sustained capacity, global purge retention
or permission to create cutovers.

The first scheduled run activated one all-client policy at 03:30:43.295 UTC.
At 03:31:37.477 it remained in backfill, with 25 operations and 25 QSOs marked
in the current epoch and no ready policy or eligible export. The run completed
in 2.263 seconds after two source pages and 50 records, with zero contact turns,
errors or deferrals; it stopped idle. It used 88 D1 calls, 295 statements and
86,150 reported rows read. This initial observation did not establish a
sustained baseline rate; the completed handoff is recorded above.

The preceding 01:59 release integrated bounded QRZ history covering reads,
separate fresh collision checks and explicit destination scope. At 02:03:58,
one QRZ cover was complete after matching reads of 98 records, with none in the
original target. Other gaps and real vendor acceptance remain unverified.

At 02:52:53 UTC, QRZ retained 35 complete and five pending history partitions.
The same single covering plan was complete, with 98 surrounding records and zero
target records. Its ledger held 3,438 ambiguous and 395 pending rows; attempts,
cutovers and temporary guards were zero. These are read-only classifications,
not deliveries or proof that the remaining gaps have recovered.

The protected source audit completed two full inventories at 02:41:09 UTC:
4,500 records each, comprising 218 operations, 4,154 contacts and 128 events,
with 60 deleted records. Both passes match each other and Ferry exactly. The
stable HaLo snapshot has 13 fewer contacts, 3,247 server-stamp differences and
180 unknown versions; no local UUID is missing remotely, and shared application
versions, flags, membership and known revisions agree. The report retains
`discrepancy` for those HaLo differences; it does not infer deletion or repair.

At 02:42:27 UTC, the bounded all-client forward probe completed two matching
passes over 20 known targets: ten operations and ten contacts, with no events
or tombstones in the sample. Two network reads found no missing, changed,
unexpected or repeat-different records. Current scope and positive delivery
were observed; account-wide membership, continuous coverage, writer provenance,
purge exclusion and source-boundary authority remain unproved. Neither probe
changed production source records or cursors. Local-only checkpoint resumes
cannot freshen remote evidence.

The versioned all-client baseline, runtime handoff and migration guards are
signed and pushed in five commits through `339590e08e229b411f411d3878e921d4a02265df`.
The [first release CI run](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40055506398)
was cancelled after a delivery test fixture leaked a `workerd` process. Fixture
fixes are signed and pushed as `ce238cdcfea72ed5cbc7b624ec6a7efc01978154`, and
[replacement CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40057488314)
passed before the 03:28 release. Migrations `0025`/`0026` preserve historical
births, quarantine unseen dependencies and fence old-worker checkpoints and
stale dispatch. During this phased rollout, policy fences are dormant when no
policy row exists; main exports must require a current ready policy for every
exporting source. Fresh-positive collection, canonical witness storage, completed-drain markers,
immutable per-contact proofs, indexed observation anchors and shared cohort
coordination are signed and pushed through `e16f987441fc84a65b517aac07ba67a235fe09e1`.
The corrected foundation passed [full CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40060259245)
and is deployed with migrations `0027`–`0029`. These building blocks grant no
stage or dispatch authority. Mandatory proof binding and scheduler integration
are deployed in `5a416de5`, verified at 05:11:28 UTC. Migration `0030` requires a current immutable proof at staging and
dispatch, including when policy or context is missing. Each attempt retains its
original proof ID. Final transport checks run after vendor admission; stale
known-unsent work can be cancelled and prepared again, while uncertain attempts
and permanent identity ownership remain intact.

The bounded coordinator shares up to four actual source requests, including
authentication and the final canonical drain. On collection-budget exhaustion,
only contacts with every required QSO/base/event observation may use the reserved
drain and receive proofs. Other contacts stay held. A prior request-budget hold
selects one contact on a later turn. If that singleton again exhausts collection
reads with no ready contact, an exact-version ten-minute retry delay yields to
neighbors on the ordinary five-minute schedule. A single contact needing more
than three collection reads still stays held; this is not general import capacity
acceptance. The workload UI labels these holds “Waiting for current source verification.”
The combined focused run passed 367 of 368 cases and exposed an anchor-index
query-plan regression. Fix `3d7b0cac782a` pins witness lookup to the exact source
identity key; its focused D1 regression, types, scoped checks and full release
CI pass.

At 03:55:42 UTC, current membership covered all 218 operations and 300 QSO-stream
records, including three events. The policy was then in backfill with no ready
source or eligible exports. QRZ has 37 complete and three pending history
partitions; the single complete covering plan still contains 98 surrounding
records and zero target records. Its ledger has 3,435 ambiguous and 398 pending
rows. Attempts, cutovers and temporary guards remain zero.

At 04:18:08 UTC, current membership covered all 218 operations and 800 QSO-stream
records, including five events. The policy was then in backfill with zero ready
sources or eligible exports. The 04:15 run processed four source pages and 110
records in 15.674 seconds, with no errors, one budget deferral, 138 D1 calls and
723 statements. Its SQL timings total 419 ms versus 14.573 seconds of D1 wall
time; this single run does not establish sustained throughput. No attempts or
cutovers were created.

The latest pre-release observation at 04:51:11 UTC has all 218 operations and
1,425 QSO-stream records in the current epoch, still in backfill with no ready
source or eligible exports. Attempts, cutovers and temporary guards remain zero.
QRZ has 36 complete and one pending partition, but no retained covering plan:
the earlier 98-record cover expired at 04:00:56 UTC. Its ledger remains at 3,435
ambiguous and 398 pending rows. Fewer partitions can reflect expiry cleanup;
they do not prove that a history gap was resolved. Fresh QRZ coverage is needed
for the exact trial contacts.
At approximately 04:58 UTC, the one pending partition was an expired, empty base
manifest awaiting cleanup or rebuilding, not evidence of an actively progressing
gap. The complete-partition count was not independently checked for freshness.

A fresh protected SQL backup was verified at 04:25 UTC before the mandatory-proof
release. Its isolated restore passed all 28 existing migrations plus pending
`0030`, integrity and foreign-key checks, three current credential decryptions
and repeated quarantine. It preserved 380 identity claims and zero attempts or
cutovers. No production restore or vendor mutation occurred. Retain the backup
and verification evidence before external changes; refresh it if intervening
state changes warrant it.

The earlier protected SQL backup completed at 03:50:46 UTC: 25 production migrations,
380 identity claims, zero attempts/cutovers, successful isolated application of
`0027`–`0029`, integrity and foreign-key checks, and decryption of three current
credentials. The migrations preserve existing counts and policy membership,
initialize no positive observation or proof, and assign source-body incarnation
versions. Repeated restore quarantine preserved attempts and claims. Production
was not restored.

The refreshed protected SQL backup completed at 02:48:09 UTC with all 23 current
migrations, 380 identity claims and zero attempts or cutovers. Its isolated restore
passed integrity and foreign-key checks, applied pending migrations `0025`/`0026`,
and decrypted all three current credentials. Repeated restore quarantine preserved
attempts and claims while disabling restored access and work. No production
restore occurred. The earlier authorization for one or two real contacts,
QRZ first then LoTW, is superseded by the latest instruction to keep exports
disabled. No actual trial may run until that instruction changes; no vendor write
has occurred.

Next: finish signing and deploying the bounded collector fix, then repeat the
successful same-contact source/QRZ check on that release and prepare its review
packet. The 08:12 diagnostic minted a valid proof without weakening its guard;
the earlier clock-failure hypothesis and scheduled Worker behavior remain open. The
production baseline/handoff is complete; waiting for more backfill is no longer
the prerequisite. Independent first-insert mode still excludes global cutover and
no-query effects, and exact fresh proofs do not establish universal UUID,
tombstone or purge coverage. All seven controls remain closed. No actual trial may
run under the current keep-disabled instruction. See the [roadmap](ROADMAP.md) and
[rollout checklist](docs/rollout-checklist.md).

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
- Per-contact destination reads have a structural scale limit: eight LoTW background queries per five minutes require at least 86.8 days for 200,000 contacts, even before retries or other tenants. The observed two-turn rate would take about 347 days if every turn completed a different contact. Shared partitions and local matching are required, alongside immediate database fixes. At that checkpoint, 25-contact LoFi background pages imposed a 6.9-day floor for one 200,000-contact source pass before rereads/rescans. The later 06:09 UTC release raises canonical baseline pages to 100; measured sustained capacity and shared source coverage remain open.

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

The deployed QRZ and LoTW historical association paths have complete ownership
bootstrap coverage at the f2c checkpoint above. Continue read-only reconciliation
and diagnose the one QRZ history-read failure before treating remaining holds as
established manual exceptions. Association-only ownership never permits a later
upload for the recognized contact.
1. Refresh the exact source-proof/QRZ packet on the deployed release. The finite
   21:10 `5a427a30` cloud observation is historical and its proof expired. Preserve
   every dependency, scope, generation and expiry guard; scheduled proof-path
   verification remains separate from the disabled cron's reconciliation work.
2. Keep all eight controls closed and `SOURCE_BOUNDARY_VERIFIED=false`. Finite
   source positives, complete inventories and the deletion decoder do not prove
   universal purge/replay guarantees. No trial may run until the owner changes
   the keep-disabled instruction and current evidence passes review.
3. Prepare the read-only [first-write packet](docs/rollout-checklist.md), QRZ first
   and then LoTW. LoTW still needs fresh complete three-day absence evidence and
   live signing/upload/readback acceptance; earlier one-day reads are insufficient.
4. Preserve the latest 21:36 protected backup, immutable comparisons, all registry
   envelopes and every referenced KEK. Populated raw-history recovery remains
   unverified; no key-retirement or rewrap authority is implied. Refresh backups
   before later external changes. Off-device key storage remains unconfirmed.
5. Measure initialization, first recognition and resolved idle work separately.
   Local batching improvements and a completed bootstrap do not prove sustained
   production throughput or 200,000-contact capacity.

Replacement and old-identity cleanup remain disabled until separately proven.
Staging remains undeployed. See [roadmap](ROADMAP.md),
[deployment](docs/deployment.md) and [rollout checklist](docs/rollout-checklist.md).

## Previous follow-up: LoFi connection freshness

- Initial tree clean at `8f122307852e`; upstream unchanged. Read-only production metadata confirmed the user's active session was beyond the five-minute recent-passkey window, with no LoFi connection saved. No source records or credentials were read or changed.
- Implemented automatic session/CSRF preflight and passkey assertion for protected connection/account actions; cancellation retains inputs and sends no protected request. Typed pre-dispatch auth errors permit one bounded retry; vendor, origin/CSRF and post-request failures never do. The original account and CSRF snapshot are pinned through concurrent refresh/retry.
- Focused client/backend checks pass; actual isolated Worker/Chromium verifies stale/fresh/canceled approval flows and real signature checks with contained vendor fixtures. Review added stale+invalid-CSRF ordering and preservation of an unverified add-passkey ceremony on a retryable freshness refusal.
- Full `mise run check` passes **180 tests**, formatting, strict lint, both TypeScript checks and Worker build (292.78 KiB gzip). Browser cancellation/retry, immutable CSRF/account snapshots, stale+invalid-CSRF precedence and add-key ceremony preservation have regression coverage.
- Signed/pushed `cbe9e63af1bf` and deployed it as Worker version `6a580035-ad08-4e35-9fa5-5d09fe5f9baf`. No migrations or secret changes. Live new-client asset, typed origin rejection, health and all closed export gates verified; no real vendor requests were made.
- Historical next action was to finish LoFi approval; the owner has since completed it. Existing account data/passkeys/connections remain intact.
