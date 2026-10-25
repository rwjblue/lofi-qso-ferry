# Production deployment and rollout evidence

Verified 2026-10-25 UTC at [https://ferry.n1rwj.com](https://ferry.n1rwj.com). The owner selected this permanent hostname. QRZ’s automatic trial remains accepted with thirteen ACKs assessed at known-ACK minute/sideband precision. LoTW trial C establishes accepted processing for one native upload; QSL confirmation is false. Later LoTW pair D held before signing/staging and made zero new attempts/uploads. All fourteen prior accepted attempts and thirteen artifacts pass POST recovery. All eight controls are closed; the history-read failure and unfinished invocation require diagnosis before another write window. Earlier dated holds and literal QRZ comparison limits remain unchanged.

## LoTW pair D: history hold, closed recovery and unfinished invocation (2026-10-25 UTC)

Pair D opened at **15:42:16.940 UTC** on signed runtime
`dd173803dc81096115eb554d55da4a5a2eb0f701`, Worker
`9da4e39b-368e-4916-8467-45eba5fa126e`, for two exact LoTW contacts and one
destination. QRZ and source-boundary writes stayed disabled. This runtime passes
all **1,701 tests and required checks**, including
[exact-release CI 40203904797](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40203904797).
Both selected routes remained `inventory_pending` with the public reason
**“Destination history read failed; bounded retry is scheduled”**, before
signing or staging. There were **zero new attempts or uploads**.

Scheduler run `8e0109b8-979f-4096-b294-aec0b25283c1` began at
**15:46:03.522 UTC**, recorded its heartbeat at **15:46:04.025 UTC**, and remains
unfinalized. Its default counters do not prove zero work. The public ledger
reason can describe a retained shared-partition retry, so it does not identify
the failing request or prove a fresh request in this run. The native cause is
not established as a vendor fault, D1 quota or CPU limit.

The operator closed the scope at **15:50:59.337 UTC** on Worker
`847fcc91-e284-4db0-b019-192b4b4cf204`. The supervisor's defensive second
all-disabled deployment completed at **15:51:11.920 UTC**, leaving current
Worker **`3c8cb733-2605-41fd-9c36-a7e9d4ee3db2`**, deployment
`3958a66d-999f-419e-920b-7c5248f87ea4`. Independent **15:58 UTC** attestation
confirms all eight controls closed. No future closure timer remains pending.
The latest **16:02 UTC** check found zero active leases; the unfinished run
still prevents a completed interval-accounting claim.

Full POST recovery completed at **15:59:40.327 UTC**, verifying
**41,415,257 SQL bytes**, all **37 migrations**, integrity, zero foreign-key
violations, full cryptography, proof/ownership pins and signatures, and both
isolated quarantines. All **fourteen prior accepted attempts (thirteen QRZ and
one LoTW)** remain unchanged, with **thirteen retained artifacts**. Receipt
`ferry-lotw-mixed-backup-dd173803-result-2026-10-25T15-59-17-708Z-e6a907ea.json`
has SHA256
`e3dc9773c4166113fa9d0625b64f8d5d7af81864875ccf9d295bc80c2a336171`.

This verifies recovery, not pair acceptance or completed interval accounting.
Diagnose the history-read failure and unfinished invocation before further write
windows. General recovery and ordinary activation helpers remain private,
offline-reviewed tooling; ordinary activation has not been used.

At **16:17:32.423 UTC**, a separate root-operated diagnostic completed one
native LoTW history query for a selected contact's weekly range. The normal
shared background budget admitted exactly one GET (one reservation, no
cooldown); three D1 calls covered admission and current-scope checks. LoTW
returned **HTTP 200**, an ADIF response and **107 records** that passed native
complete-report validation. All eight controls were independently verified
closed before and after; credentials, account identity and the fresh current
configuration remained bound. No raw report was retained, source read,
signature, upload or application write occurred. This establishes readability
from the diagnostic host at that time, not absence evidence, a retry permission,
the earlier Worker's failure cause or completed trial accounting. Receipt
`ferry-lotw-history-http-diagnostic-dd173803-ab41ad7b-8667-4e11-b28d-2a6a2c7e52ff.json`
has SHA256
`724cc43e50c37e5533dc65f391db088a30b9b53984d1881d55271d4e5b011911`.

## Earlier closed diagnostic release (2026-10-25, 15:13 UTC)

Signed `dd173803dc81096115eb554d55da4a5a2eb0f701` passed all **1,701 tests**
and required local checks plus [exact-release CI 40203904797](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40203904797).
Independent verification at **15:13:03.263 UTC** confirms Worker
`3500b478-f241-4a8a-b5b5-d9968ef324c9`, deployment
`b320ad00-ee77-44f8-bbcc-83c7c2f5d55d`, sole 100% traffic, healthy HTTPS,
matching homepage/application/admin assets, KEK version 1 and **all eight controls
closed**. Schema remains 37; no production migration or restore was performed.

The three commits add scheduler lifecycle/run correlation, fixed D1 provider and
native-guard failure categories, and bounded source-proof failure phases. They
do not change matching, cryptography, budgets, admission windows or retries.
The earlier generic proof hold remains undiagnosed; new diagnostics do not
retroactively identify its cause.

A fresh complete recovery before deployment preserved all fourteen accepted
attempts and thirteen artifacts. A second recovery on the new closed runtime
completed at **15:14:13.517 UTC**, verifying **42,271,821 bytes**, the same exact
fourteen members and thirteen artifacts, original historical LoTW capture at its
original source/Worker, crypto/signature/proof/ownership checks, full in-memory
restore, both quarantines, integrity and zero foreign-key violations. Its report
SHA256 is `aff1bd3f4f3efc8b694bf1015e207f311e5b0720ad955138b4b5b0da6af60bd4`.
This was a PRE checkpoint for the then-prospective checked LoTW pair; the later
pair-D hold and recovery are recorded above.

## LoTW trial C: accepted processing and mixed recovery (2026-10-25 UTC)

Trial C activated at **14:17:56.497 UTC** on exact signed runtime
`7738f7d7d733e67ef1fa9567eb3c2683d1a5f382`, Worker
`de0b0828-f1a7-4ae1-b9e3-211c745afae1`, deployment
`fe02d6f8-7bff-4305-b4e0-884866565025`. Its scope was one exact LoTW contact and
route, at most one actual upload, with QRZ off and native source-proof,
absence, certificate, ownership and dispatch checks intact. Activation
preserved all thirteen prior attempts and created none.

After **one actual upload and queue ACK**, independent closure was attested at
**14:23:06.526 UTC** on Worker `0f72b254-16b1-4d91-8bbb-6ecce2ee5e27`;
closure completed at **14:23:08.080 UTC**. All eight controls remain closed.
The fsynced closer-done marker prevented another scheduled closure deployment.
At closure, the complete census showed thirteen prior attempts and one retained,
dispatched LoTW attempt, still submitted rather than observed. No unapproved
attempt or changed scope/review binding was found. The scheduler row from
14:21:30.260 to 14:23:01.514 UTC recorded 21 contact turns, two attempt turns,
zero errors/deferrals and a 91.254-second deadline stop. Attempt turns are not
upload counts; no provider-event correlation is inferred.

After closure and drain, the read-only observer made **one LoTW GET and six D1
calls**, with all eight controls verified closed before and after. Native strict
report parsing and contact matching found the accepted contact. **Accepted
processing is verified; QSL confirmation is false.**

The standard recovery completed at **14:37:53.975 UTC**. Its **42,018,673-byte**
full SQL backup preserves **fourteen accepted attempts and thirteen retained
artifacts**, including all thirteen prior QRZ attempts unchanged. Original
artifact decryption, signatures, source-proof and identity/ownership claims,
full in-memory restore, two quarantines, integrity and foreign-key checks pass.
The LoTW native observed count is one and strict accepted-raw-report verification
is true. The initial acquisition wrapper held because its descriptor referenced
the wrong legacy file; pointing it to the original retained, byte-identical
legacy packet allowed the unchanged frozen verifier to pass. No cryptographic
check or guard was relaxed, and no upload was resent.

| Trial-C receipt                                                                                              | SHA256                                                             |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| PRE recovery report, 14:17:10 UTC filename                                                                   | `42a09156b6a1340689e323990e81d53156ca9c963a937fa4e15dc6fd3cdbc282` |
| Unsigned review                                                                                              | `bd353cd485d69ccb8e0e7e41eaab33dded7085373ae6c7c99703eb8a2fa06f7e` |
| Actual reviewed input                                                                                        | `ddbb4f3a972dc1b5eaa94535f457b9f4eff03cf497b56051cc2759b73d3859fb` |
| Standard accepted recovery: `ferry-lotw-pilot-backup-7738f7d7-result-2026-10-25T14-37-38-588Z-defabbbe.json` | `421923970a696bca2d548034ceba26b56990388ee48901280aa5be1a1b86bd8f` |
| Accepted-observer summary                                                                                    | `742685d6e3a0db98bd0f03d8be42f1e07342271811d9344ca8b7f3ad2792389f` |
| Protected raw accepted-report capture                                                                        | `66a3fe065ea7a9a4b0a2079c46af97a5fd777f2389ef61d480b0c8fe3c6e4256` |

At the accepted trial-C checkpoint, production remained on `7738f7d7` with its
1,688-test CI qualification and schema 37.
Candidate `dd173803dc81096115eb554d55da4a5a2eb0f701` is signed and GitHub-verified;
its three commits change observability only. All 1,701 local tests and required
checks pass; [CI 40203904797](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40203904797)
also passes. At this checkpoint it is **not deployed**. Native cryptography and schema remain
byte-compatible with the pinned `890f714c` contract. The next two-contact LoTW
packet is under offline preparation, with no activation. Further checked batches,
small automatic scope and sustained scale remain separate acceptance work.

## LoTW trial A: source-proof hold and closed recovery (2026-10-25 UTC)

The one-contact normal-cron LoTW trial A activated on unchanged signed runtime
`7738f7d7` and Worker `49d9c771-7553-40d0-a5f2-7ad7a39e5822`. The normal 14:00
scheduled invocation ran on the active Worker; delayed tail delivery reports
provider outcome `ok`, 282 ms CPU and 95,427 ms wall time. Native counters are
16 contact turns, zero attempts/errors, one deferral, one round and 93,730 ms
elapsed, stopping at `deadline`. A later D1 scheduler row has similar counters
but no run-ID correlation; it is not equated with that provider event.

The selected contact was live, eligible, context-ready and unexpired. Its LoTW
route remained in `lotw_fresh_insert_eligible`, with ledger state
`missing_current_identity` and reason `source_export_proof_proof_unavailable`.
This establishes a source-proof hold after selection. The generic reason does
not distinguish clock admission, database/guard failures, or another proof
failure; it is not proof of request exhaustion or a provider fault.

The independent supervisor attested all eight controls closed at
**14:02:46.080 UTC**, Worker `40991304-8c5e-422e-bb41-61deb79b08c7`. Actual POST
recovery completed **14:08:52.990 UTC**: full restore, both quarantines and exact
preservation of all thirteen prior attempts pass; there are zero new attempts,
zero unfinished window invocations, 31 inherited unfinished rows and no LoTW
proof pins. No LoTW attempt or upload occurred. Zero attempts alone does not
establish whether signing ran. Trial B
preparation stopped at **14:12:54 UTC** with `settled_margin_not_available`,
before any input, intent or activation. The latest completed cycle was 14:05;
no 14:10 scheduler row was present at that check. This does not establish a
missed cron or its cause. At that checkpoint all eight controls remained closed on Worker `40991304`,
with thirteen total attempts. Trial A's precise proof failure remains under
diagnosis. The subsequent trial-C activation is recorded above.

| Trial-A receipt                                | SHA256                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| PRE recovery report                            | `6eca7c967ae8d0e58b07ef01f142787eb3951b423858f973a2701dd06de12ee9` |
| Unsigned V5 review                             | `b801f21e464a20fa336a3fb92f396636047f322b6bf9cf22036217bf10900ebf` |
| Actual reviewed input, issued 13:57:50.611 UTC | `4898eb1f94d95e892e68578a0c680240fa54c5e55289e77da8cb53d9145820b6` |
| POST recovery report                           | `09d8445cec249ab5ee03c3f2b6f1dc00b402001f1a264d0fc285075a9d2bb5a1` |

## Accepted persistent QRZ trial and temporary closure (2026-10-25 UTC)

The 13:15 and 13:20 normal active cycles made **32 and 38 contact turns**, one
attempt each, zero errors and two deferrals each, both stopping at
`database_budget`. No cause is inferred from the deferrals. QRZ was temporarily
closed for independent observation and LoTW preparation. Independent
**13:25:46.975 UTC** attestation confirms all eight controls closed on Worker
`d3df1bb6-39d2-4bb5-b1c2-ce268ed22744`, deployment
`0eb59b3a-8c88-4259-a688-f3e559084855`. Runtime remains signed `7738f7d7`, with
unchanged 1,688-test CI qualification and 37 migrations. The closed 13:25 cycle
made **84 turns, zero attempts and zero errors**, with no other new QRZ attempts.

Actual POST recovery completed **13:29:39.418 UTC**, containing **41,654,630
bytes, thirteen attempts and twelve retained artifacts**. It verifies both new
attempts and all prior eleven exactly, with crypto, original proof pins/claims,
immutable rows, integrity/FKs and both isolated quarantines passing. Accounting
finds zero unfinished window invocations and **31 inherited unfinished rows**.
Report SHA256:
`0005426c5dd73eaf6176ffce845d58dd1671129455ad6b167571c4c791e4627d`.

The independent pair observer used **five QRZ reads**, with all eight controls
closed before/after. Combined assessment is
`complete_all_deliveries_consistent`: two new/two consistent members, zero held,
missing or unresolved members. Assessment SHA256:
`ddc4fd9e9f27303ffba3e80e0af7406e69282428952731400fd4b10606312106`.
**All thirteen records are accepted at known-ACK minute/sideband precision**.
Exact seconds remain unverified; original source values, literal-held summaries
and uncertain-result matching are unchanged. The automatic QRZ trial is accepted;
its temporary closure is for the next phase, not a trial failure or a sustained-
scale claim.

LoTW unsigned helper V4 held all first 20 candidates under
`unsigned_source_time_precision`. V5 removes only the helper's modulo-zero
requirement, aligning it with deployed native ISO whole-second projection and
durable claims while preserving raw milliseconds/fingerprints. Twenty-three
checks and peer reviews pass; actual offline V5 selection found one candidate
without signing or network. The reviewed recovery bootstrap bridge passes eleven
native checks and both peer reviews; it derives signed-artifact facts from saved
SQL before unchanged full recovery. This is offline implementation evidence and
grants no authority. At that **13:54 UTC** checkpoint no actual LoTW input,
activation, signing or upload had occurred. The later trial-A hold and verified
closed recovery are recorded above.

## Persistent QRZ activation B (2026-10-25 UTC)

Independent active attestation at **13:10:58.762 UTC** verifies Worker
`242c1aa6-aa79-4f46-9ef2-dc033971bdac`, deployment
`472f153d-d9b8-42e7-861e-635bc19bcd8b`, at sole 100% traffic, with healthy
responses, matching assets and KEK 1. Runtime remains signed
`7738f7d7d733e67ef1fa9567eb3c2683d1a5f382`; exact-release
[CI 40184837953](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40184837953)
passed all **1,688 tests and required checks**. Exports, rollout checks and QRZ
fresh inserts are true, with **one exact existing QRZ destination and wildcard
contacts**. LoTW fresh inserts and source-boundary authority remain false;
the expiry is empty for ordinary persistent mode. Normal per-contact source
proofs, fresh vendor absence checks and durable ownership remain required.

The reviewed persistent host V2 passes **16 focused cases** and independent
peer review; manifest SHA256:
`33f2035954665d9ee5d0896a114c2643396918ddb963628cf411a81cf9fb984a`.
Activation A had stopped before intent/deployment: its backup age was
**909,311 ms**, exceeding the 900,000 ms maximum at closed attestation. It made
no external write. Activation B used a new backup/input, not a blind active retry.

The fresh **13:09:53.227 UTC** PRE recovery contains **42,245,796 bytes**, eleven
prior attempts and ten artifacts, with zero new attempts and passing crypto,
proof/claim, integrity/FK and repeated-quarantine checks. Its explicit
**12:53:27–13:09 closed-period follow-up** has zero unfinished rows; this is not
an activation-window count or a resolution of older inherited unfinished rows.
Report SHA256:
`b1320347bc7ad6329fa437db31538e7588b66221c03b387cee49077567004959`.

Activation started with **eleven total attempts, all predating persistent
automatic QRZ, and zero new attempts**. The first full active cycle was the normal
**13:15 cron**, received **13:15:42.570 UTC** on Worker `242c1aa6`. Provider outcome
was `ok`, CPU **910 ms** and wall time **80,004 ms**. The tick recorded **32 contact
turns, one attempt, zero errors, two deferrals and two rounds**, with **78,861 ms**
elapsed and stop reason `database_budget`. The two deferrals alone establish no
database fault or vendor cause.

The **13:18 UTC** complete monitor confirms **one new delivered QRZ ACK and twelve
total**, with all prior eleven attempts exactly preserved and scope/schema
unchanged. It finds zero unknown or rejected attempts, zero running invocations
and zero leases; `stopRequired=false`. Active Worker remains `242c1aa6`, with
QRZ automatic fresh inserts were then on and LoTW off. At this checkpoint the
twelfth native ACK still awaited independent readback/recovery and the assessed
count was eleven. The later thirteen-record acceptance and temporary closure
are recorded above; neither is sustained-scale acceptance. LoTW has no actual signing/upload. Its unsigned offline scan held all first 20 projected contacts
from 200 queued; a separate read-only snapshot has 373 structurally eligible/due
routes. Those counts establish neither complete eligibility nor fresh absence.

<a id="accepted-window-h-and-current-closed-state-2026-10-25-utc"></a>

## Accepted window H and earlier closed state (2026-10-25 UTC)

The monitored normal-cron window H ran on unchanged signed runtime
`7738f7d7d733e67ef1fa9567eb3c2683d1a5f382`, qualified by
[CI 40184837953](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40184837953)
with all **1,688 tests and required checks** passing. Its native absolute
`expiresAt` was **12:12:30 UTC**. The tick recorded **six contact turns, four
attempts and zero errors**, with four new delivered QRZ INSERT ACKs. The
independent closer verified all eight controls closed at **12:12:40.617 UTC**,
Worker `30c3c0b3-0e11-4858-8f41-211a7882fb2e`, deployment
`4313866b-1832-472b-a2aa-444b5aa5f375`; fresh 12:40 UTC attestation retained
the closed state. Persistent automatic QRZ was off at this checkpoint;
LoTW has no actual attempt or upload and remains disabled.

Actual POST recovery completed **12:40:34.456 UTC**, containing **41,768,036
bytes, 37 migrations, eleven QRZ attempts and ten retained table artifacts**.
Every prior one of the seven attempts is preserved exactly. Artifact crypto,
claims, proof pins, integrity/FKs and both isolated quarantines pass. Complete
accounting finds **zero unfinished window invocations and 31 inherited
unfinished rows**; the latter are not silently treated as completed.

| Verified receipt | SHA256                                                             |
| ---------------- | ------------------------------------------------------------------ |
| Recovery report  | `b8e53bd14215170a9ff02363e691cbf992b24b3dc409b5a2f709ad38ee7e80ed` |
| SQL snapshot     | `484043caf1d178ba01b04d567d23f42249c9d43e8260c38fd3823258f09e737f` |

Earlier recovery checks held first for an overlapping closed read cycle, then
for diagnostic-only source configuration drift. Reviewed recovery V4 excludes
exactly the top-level source fields `lastSuccessfulPollAt`, `lastSyncFailureAt`
and `lastError` from configuration equality; every other source and destination
field remains checked. All **26 offline checks** and both peer reviews pass.
These source diagnostics do not establish source health. No production restore
or recovery-time vendor write occurred.

Two disjoint pair observations each used **five QRZ reads and 24 D1 calls**,
with all eight controls closed before and after. Aggregate replay covers all
four new members: `complete_all_deliveries_consistent`,
`fullMemberAssessmentComplete=true`, four consistent native ACKs and zero held,
missing or unresolved members. Aggregate summary SHA256:
`27c2cc8f504aaec7e6bbcacee508bc5a6588b527d7817513988b0bba543e9dd5`.
**Window H is accepted at known-ACK minute/sideband precision**, bringing the
complete assessed trial set to **eleven records**. Exact seconds remain
unverified; original literal-held summaries and uncertain-result matching are
unchanged. Persistent automatic QRZ was still off at that checkpoint; activation B follows above.

Later closed cycles recorded intermittent `db_d1` categories: three at 12:15 UTC
and five at 12:25; 12:20, 12:30 and 12:35 were clean. This classifier also covers
deliberate native guard aborts; it does not establish a provider fault. The root
cause remains unresolved. These observations do not establish sustained capacity.

## Accepted F4 pair and earlier closed state (2026-10-25 UTC)

F4 activated on time at the reviewed two-contact scope on signed `7738f7d7`.
The **11:40 UTC** normal cron completed **two exports, 16 contact turns and zero
errors/deferrals**, with no active leases afterward. Both actual payload hashes
match the prior review. Its independent closer verified all eight controls
closed at **11:43:12.107 UTC**, Worker
`bfdb4768-1018-4b38-a01d-bac7f7d662c1`, deployment
`ddba232c-baab-4829-bbc5-98faa2f4a41d` (installed 11:43:07.648636 UTC).

After at least 180 seconds, POST recovery completed **11:46:41.112 UTC**. It
contains **41,648,643 bytes**, exactly **seven delivered QRZ attempts and six
retained artifacts**, with both new payloads decrypted and original proof pins,
claims, immutable rows, integrity/FKs, isolated restore and repeated quarantine
passing. Report
`ferry-scheduled-batch-backup-7738f7d7-result-2026-10-25T11-46-27-222Z-98ee6103.json`,
SHA256 `2e2f0594bb9898efceaba2a63228289f36afd9b0d17e7bfb19d812e4811ad8b9`.
No production restore or recovery-time vendor mutation occurred.

The read-only observer used **five QRZ reads** and verified both exact ACK LOGIDs
and complete unique neighborhoods. One source record has SSB/USB and the other
SSB/LSB; QRZ returns flat USB/LSB and minute-level time. Every other transmitted
field matches literally, including their eight-character grids. The separate
**11:48:57.488 UTC** assessment accepts these representations while retaining
`literalExact=false` and `exactSeconds=false`. Assessment SHA256:
`00080ce037cb025e2e910ff8229aa86123b7e7524fd9246b3d105691a1afcd6d`.
Original literal holds and uncertain-result matching remain unchanged.

The subsequent closed **11:45 UTC** run completed 168 turns with zero errors and
zero attempts. Late finite-host observation returned an imprecise failure phase;
full recovery and a separate fixed metadata query independently verify the
seven-attempt ledger and completed post-close cycle. This host diagnostic issue
does not invalidate those receipts. The later window-H activation, closure and
recovery are recorded above; all four new records also pass all-member readback
and aggregate acceptance.
LoTW remains separate and disabled.

## Closed scheduler and QRZ deadline release (2026-10-25 UTC)

Signed `7738f7d7d733e67ef1fa9567eb3c2683d1a5f382` deployed with all eight
controls closed at **10:34:26.259635 UTC**, Worker
`661afffe-a4f1-48ea-90ad-94572c8afea0`, deployment
`a517e3e7-5263-4877-904d-6948c0ad074e`. GitHub verifies all four pushed commit
signatures with reason `valid`. The runtime changes are scheduler result/failure
preservation and the optional QRZ proof-expiry bound. No migration was needed;
all 37 migrations through `0038` remain installed.

Independent **10:35:00.183 UTC** attestation confirms sole 100% traffic, healthy
HTTPS, matching assets, KEK 1 and all eight controls closed. The optional expiry
binding is absent. Automatic QRZ and LoTW exports remain disabled. All **1,688
local tests**, formatting, lint, both type checks and the Worker dry build pass.
[CI 40184837953](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40184837953)
passed all **1,688 tests and required checks** at **10:56:43 UTC**. Its test phase
took **1,723,459.995668 ms**.

Fresh PRE recovery completed at **10:31:35.981 UTC**, followed by POST recovery
at **10:35:35.019 UTC**. Both contain **42,295,682 bytes**, SQL SHA256
`4122c32e087f78e50898e73405a2499d9e262a64f15ea7ee05ed3e7e157dccec`.
The complete set remains **five delivered QRZ attempts and four retained
artifacts**, with zero new attempts. Original keys, AAD/artifacts, proof pins,
claims and prior immutable rows pass decryption, integrity/FK and two isolated
quarantines. No production restore occurred.

| Recovery | Report                                                                                | Report SHA256                                                      |
| -------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| PRE      | `ferry-scheduled-batch-backup-c88d413e-result-2026-10-25T10-31-23-706Z-f82b5930.json` | `0cd574fa231f029103732d80339626e1f8f8c9c298797457e58e0bb3d98e91ee` |
| POST     | `ferry-scheduled-batch-backup-7738f7d7-result-2026-10-25T10-35-22-382Z-da73d103.json` | `970839eb651dade1433b521209b41c8b9b110ea63ffafc48ea5440a69a9b63ae` |

The first new scheduled run was idle and completed cleanly. Later provider-`ok`
cycles processed **56 / 51 / 30 contact turns**, with **0 / 6 / 3** handled
errors and zero export attempts. The six-error cycle records two
`history_read:qrz:history_identity_missing` events affecting six routes; its
completed status and throughput were retained. There were no scheduler-failure
phase logs in these observed cycles. These samples do not establish sustained
capacity or explain the old initiating exception. The old **10:30 UTC** run
remains unfinalized; no active lease or default-zero counters prove completion.

The first prospective pair passed local inspection but never activated; its
backup aged out while CI continued. The subsequent F2 scope activated at
11:01 UTC but created **zero attempts**. It closed at **11:09:28.973 UTC**, as
Worker `17c17e12-db38-48da-9773-ca8df18268ef`, deployment
`a00abbc3-dde4-4478-a4bf-5bafe9e839b4` (installed 11:09:24.874248 UTC).
Independent **11:22:46.092 UTC** attestation confirms sole 100% traffic, all
eight controls closed, matching assets and KEK 1.

F2 POST recovery completed **11:14:21.734 UTC**, containing **40,751,978 bytes**
and exactly the prior **five QRZ attempts/four artifacts**. All artifact/key,
proof/claim, immutable-row, integrity/FK, isolated restore and repeated-quarantine
checks pass. Report
`ferry-scheduled-batch-backup-7738f7d7-result-2026-10-25T11-14-09-503Z-aaeb7fda.json`,
SHA256 `305dc3d863d331b2d797e5048eb79034353ebe23b967fdc0c9a8b03d071c30cc`.
No vendor mutation or production restore occurred during recovery.

The original **11:00:57.934 UTC** scheduler row remains unfinalized. A distinct
invocation received at **11:15:50.284 UTC**, with scheduled time
**11:00:42.021 UTC**, ran on closed Worker `17c17e12` and completed a new row
with 105 turns, zero attempts/errors and one deferral. This establishes later
delivery associated with the old schedule, not recovery of the original row
or a proven deployment-interruption cause. The 11:20 closed cycle completed
42 turns with zero errors; the 11:25 cycle completed 144 turns with five handled
LoTW history errors and 13 budget deferrals. Neither is a capacity measurement.

Take fresh release-bound backup/review and completed-cycle/lease evidence for
the next finite pair. Preserve expired inputs and unfinalized rows. A scheduling
margin cannot exclude delayed events; finite native authority and full accounting
remain required. Window H subsequently supplied actual capture and recovery;
all-member readback and acceptance now pass. Persistent automatic activation
remains the next decision, followed by separate LoTW acceptance.

## Accepted Trial D2 and earlier closed state (2026-10-25 UTC)

At this earlier checkpoint production remained on signed `c88d413e52c8d3ebd5ed7bff4eab10ec6fbf2dd7`,
with all **37 migrations through `0038`**. The closed deployment at
**07:28:17.57008 UTC** is Worker `0d70f4c8-e136-429b-a540-58ecca58c931`,
deployment `26717a85-e1c7-458f-a305-7418d876160b`. The **07:28:21.817 UTC**
closure packet verifies all eight controls closed. Automatic QRZ exports and
LoTW remain disabled. Exact c88 source passed **1,667 tests and required checks**
in [CI 40168290537](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40168290537);
the test-only `738fea2527c3fb714faa326f130b496eed7da5ed` follow-up also passed
[CI 40169168017](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40169168017).

Trial D2 produced **two new delivered QRZ attempts with INSERT ACKs**. The
three prior attempts are unchanged: the complete approved set is now **five
attempts and four retained encrypted artifacts**. After at least **180 seconds**
of drain, accounting found **zero new unresolved attempts and zero running
trial invocations**. This does not assert that every unrelated scheduler row
has completed.

The **07:34:45.497 UTC** POST recovery contains **41,300,020 bytes**. It verifies
the exact five-attempt set, original artifacts and keys, source-proof pins,
claims, prior immutable rows, integrity and foreign keys through two isolated
quarantines. Report:
`ferry-scheduled-batch-backup-c88d413e-result-2026-10-25T07-34-34-137Z-a13be64f.json`.
Report SHA256:
`eb83e468f96314302c586294deda5c569717d698cb97a6f09cc11be9aa948ea8`.

The **07:35:26.384 UTC** read-only observer used **five QRZ reads and 24 D1
calls**. Exact-LOGID readback and complete neighborhoods both contain precisely
the acknowledged record. Both contacts transmitted six-digit `TIME_ON`, which
QRZ returned at four-digit minute precision; one transmitted `MODE=SSB,SUBMODE=LSB` returned flat `MODE=LSB`.
Every other transmitted field matches literally, including the selected contacts'
full eight-character grids. This is evidence for those records; other valid
user grid precisions remain supported.

The separate append-only assessment at **07:36:22.631 UTC** records both as
`representationConsistent=true`, with **`literalExact=false` and
`exactSeconds=false`**. Its SHA256 is
`7a8d591e73f9afd0de778c2a6c7d232dbe007e893a780fbe3efda6811f521bf8`.
**Trial D2 is accepted only at the observed minute/sideband representation.**
The original held literal report, source seconds, historical singleton/Trial C
receipts and uncertain-result matcher remain unchanged. This assessment does
not authorize another INSERT or infer a general vendor normalization contract.

The separate **D and E preflights stopped before activation intent**, so neither
preflight made a write or deployment. E's **07:35:55.394 UTC** closed-state check
found an unfinished scheduler row; its default zero counters do not prove zero
work. The provider reported `scriptThrewException` for **07:35:42 UTC**, with
cause still unknown. The next closed run at **07:40 UTC** completed **147 contact
turns in 91.494 seconds with zero errors**. That recovery does not identify the
previous exception's cause or establish sustained throughput.

At **07:45 UTC**, a later closed invocation failed while writing the scheduler's
FAILED status: the native D1 error points to `scheduler-history.ts:26:5`.
The provider recorded an exception with **46 ms CPU / 10,135 ms wall time**.
The old catch discarded the original tick error before this status-write failure,
so the evidence does **not** establish that the original error was D1-related.
The two-stage failure mechanism is known; its initiating cause remains unknown.
The **07:50 UTC** closed cycle was idle, with zero attempts and provider outcome
`ok`; this is not resumed export acceptance.

At this checkpoint, the local scheduler follow-up contained the reviewed diagnostic preservation and
completed-before-sampler fix. The subsequent optional QRZ window deadline caps
native source proofs and the final pre-INSERT admission check. The combined
local source passes **all 1,688 tests**, formatting, lint, both TypeScript checks
and the Worker dry build. Its push was then blocked by 1Password's failed
fill-buffer operation. The later signed 7738f7d7 release and actual window-H
execution are recorded above; the c88 receipt remains historical.

Pair E stopped before activation. At this earlier checkpoint wider QRZ window
recovery and an observer covering every new member were still offline. Recovery retains ten passing native/host cases and adds a passing
native capped-proof cancellation and repeated-quarantine case. Its source and
complete protected inventory pass independent review. The selected-member observer
retains 13 native and 33 host/selection cases with independent review. Mechanical
dependency successors pass static, import and TypeScript checks; their inherited
native receipts are not new live runs. The observer retains
the complete window census while observing one or two native ACKs at a time;
no report alone claims that every member is accepted. Window H now has actual
capture and recovery above; its all-member readback and aggregate acceptance
now pass. Persistent automatic QRZ and LoTW signing/upload remain disabled. See [the pilot](qrz-pilot.md) for the continuing boundaries.

## Historical receiver-fix deployment and accepted Trial C

Signed `c88d413e52c8d3ebd5ed7bff4eab10ec6fbf2dd7` deployed with all eight
controls closed at **06:29:17.891099 UTC** as Worker
`a948328a-6098-4cbb-957f-9813f5383e4b`, deployment
`b0efece0-a12f-46c0-95e2-fb5161234adf`. Independent **06:29:31.791 UTC**
attestation confirms healthy HTTPS, matching assets, KEK 1 and closed controls.
All **37 migrations through `0038`** remain installed. This release binds the
source coordinator's native fetch receiver with `.call(globalThis, ...)`;
Trial C below supplies actual scheduled source-proof and QRZ delivery evidence.

The full local run completed **1,667 cases: 1,666 passed, one failed**. The
failure was a privacy-test assertion that searched random ciphertext for the
literal `W1AW`, not a runtime failure. Signed test-only follow-up
`738fea2527c3fb714faa326f130b496eed7da5ed` corrects that assertion; the complete
history file passes **62/62** and the build passes. The actual-coordinator
regression and 42 focused cases already pass. [CI for c88d413e](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40168290537)
subsequently passed all **1,667 tests and required checks** at approximately
**06:37 UTC**. That CI result is separate from the earlier local failure.

The **06:26:18.568 UTC PRE** recovery contains **41,687,430 bytes**, with 37
migrations, exactly the prior singleton, zero new attempts/artifacts, all
immutable prior evidence preserved and repeated quarantine passing. The
**06:29:50.913 UTC POST** recovery also passes with **41,687,430 bytes**, the
same expected singleton and zero new attempts/artifacts. The later Trial C
results and subsequent closed state are recorded below.

PRE report: `ferry-scheduled-batch-backup-87e87b2d-result-2026-10-25T06-26-04-782Z-84c9535a.json`.
Report SHA256: `27bf2d7478670f422a17228e0caa3216bcc0b13e1a0a9c989b8b98a0d7428905`.
POST report: `ferry-scheduled-batch-backup-c88d413e-result-2026-10-25T06-29-40-071Z-2b8e29ca.json`.
Report SHA256: `9dcab6fbc87acff52cceb9086577aeec7ce40b7b3abfd87c8d73154422c99276`.
The equal PRE/POST byte counts do not assert identical SQL contents.

Trial C activated exactly two QRZ contacts at **06:37:46.525 UTC** as Worker
`dd1a74fc-0bad-4391-aabf-ae2f35533555`. The ordinary scheduled turn created two
attempts at **06:41:13.566 / 06:41:15.969 UTC**; both received INSERT ACKs and
are delivered, with two retained encrypted artifacts. Actual record, template,
credential and source hashes match the preliminary review. The original
singleton is unchanged; the global attempt count is now **three**.

All eight controls closed at **06:41:42.213147 UTC** as Worker
`297b7d45-4fc3-4c0d-af79-d1e0dde1b4b4`; independent attestation passed at
**06:41:46.035 UTC**, with closure recorded at **06:41:46.124 UTC**. After at
least 180 seconds of drain, there are **zero running invocations, two new
delivered attempts and zero unresolved attempts**. The **06:45:24.184 UTC**
recovery contains **40,811,177 bytes**, verifies all three expected attempts and
two new retained artifacts, and passes pins/claims/decryption, integrity/FKs and
two quarantines.

The **06:46:10.218 UTC** read-only observer completed five QRZ reads and 24 D1
calls with book/current scope and closed controls verified. Both complete
neighborhoods contain exactly one candidate and one occurrence of the accepted
LOGID, matching exact-LOGID readback. Its literal result remains **held**:
the 14-field contact matches 13 fields, with only six-digit `TIME_ON` returned
as the same UTC minute; the 15-field contact matches 12 fields, with the same
minute reduction plus transmitted `MODE=SSB,SUBMODE=LSB` returned as `MODE=LSB`
and no `SUBMODE`. Both full eight-character grids are retained. No further
INSERT or retry occurred.

Post-Trial C report:
`ferry-scheduled-batch-backup-c88d413e-result-2026-10-25T06-45-12-927Z-8f062365.json`.
Report SHA256: `cbf14f588b7a765d516b81fff9be708c1e907efcaf9869f5a11db4fc713a7ef4`.
The provider's scheduled event at **06:40:42.817 UTC** reported outcome `ok`,
no exceptions, one source, **28 contact turns**, two attempts, zero errors or
deferrals, two rounds and **79,533 ms** elapsed, stopping at `database_budget`.
The turn count is not a count of unique contacts or sustained-capacity evidence.

At **06:55:09.986 UTC**, a separate append-only offline assessment verified both
known ACKs against the hash-bound captures and reloaded retained artifacts,
including crypto, claims, proof pins and the original reviewed records. **Trial C
is accepted at returned minute precision and the observed sideband
representation only.** Both results have `representationConsistent=true`, while
`literalExact=false` and `exactSeconds=false`; source seconds remain preserved
but unverified at QRZ. Every other transmitted field matches literally.

The assessor permits only exact `SSB+LSB` ↔ flat `LSB` (or the corresponding USB
form) and valid same-date minute reduction. Its **53 focused cases**, strict
TypeScript and independent review pass. This records the actual QRZ observations,
not a general vendor conversion guarantee. The original held literal report and
uncertain/no-ACK matcher remain unchanged. Assessment made no additional vendor,
source or database calls and grants no retry authority. Further checked QRZ
batches remain required before automatic scope; all eight controls are closed,
and LoTW signing/upload acceptance remains unproved.

The append-only assessment report is `qrz-batch-assessment-c88d413e-trial-c-20261025-a/summary.json`,
SHA256 `69639254aa46f3ee75b895e813f5ad35fa1aab121bf695a28c51f389375a787b`.
The original literal observer summary remains unchanged at SHA256
`5f59563763415a6a3cacacbb97ae48d88908826b45ac78733c0f1e6820ea985d`.
The later test-only `738fea25` follow-up also passed all **1,667 tests and
required checks** in [CI 40169168017](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40169168017).
The deployed source remains c88; that follow-up changes only the test assertion.

## Previous scoped-selection release and Trial B (87e87b2d)

Signed revision `87e87b2d9f02f4534a914789a9e4487f35703a43` deployed closed at
**2026-10-25 05:50:40.674521 UTC** (initial Worker prefix `ba80`, deployment
prefix `85ba0473`). All **1,666 tests** and required checks pass in
[exact-release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40165603166).
One earlier Cloudflare `10500` preflight failed without changing the old `8122`
Worker. Independent **05:51:15.649 UTC** attestation confirmed the successful
closed deployment. All **37 migrations through `0038`** remain installed.

Trial B's exact two-contact QRZ activation intent was recorded at
**05:59:23.886 UTC** (Worker prefix `3e6748a8`). Both contacts reached live
selection at **06:01:30 / 06:01:45 UTC**. The first held for incomplete history;
the second for `source_export_proof_read_failed`. There were **zero new attempts
or vendor writes**. Closure deployed the same signed source at
**06:05:54.576653 UTC** as Worker `7aaf4d15-66e8-48d4-ab6a-b771b02000ad`,
deployment `0765e455-aafd-45ab-b79a-c9306a3560aa`. Independent
**06:11:34.594 UTC** attestation confirms all eight controls closed. At least
180 seconds of drain observation found zero new attempts and **one unfinalized
scheduler row**; that row is not reported as a completed run.

| Recovery checkpoint   | Completed UTC |  SQL bytes | Report SHA256                                                      |
| --------------------- | ------------- | ---------: | ------------------------------------------------------------------ |
| PRE                   | 05:46:13.212  | 41,598,715 | `77e5756f469e07b161d907c6e694629fd5aa726dfce9aa6300ea2924bc6af32b` |
| POST                  | 05:52:02.914  | 41,600,106 | `35a88778189cfc8196b45098477afbf69b1c6234e696119f7afe734daa20bff5` |
| After Trial B closure | 06:12:54.606  | 41,555,300 | `ea885a69c875f92fd6785c45e0da48a013eb97bdbd57e00c79e134b72f525436` |

The final protected report is
`ferry-scheduled-batch-backup-87e87b2d-result-2026-10-25T06-12-25-647Z-5c0c43ef.json`.
It verifies 37 migrations, exactly the expected original singleton, zero new
attempts/artifacts, every prior immutable row, integrity/FKs and repeated
quarantine. No production restore occurred. The singleton's purged body remains
preserved in its original protected host packet.

Native Workerd proves that the coordinator called native `fetch` with an invalid
receiver, throwing `Illegal invocation` before outbound transport. Signed,
pushed fix `c88d413e52c8d3ebd5ed7bff4eab10ec6fbf2dd7` changes only the call to
`.call(globalThis, ...)`. The actual-coordinator regression and 42 focused cases
pass; full checks and [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40168290537)
were running at that checkpoint. The receiver correction subsequently deployed
closed at 06:29 UTC, with its validation and recovery status recorded above.

The 05:50 UTC idle run waited for the ordinary cycle lease to expire at
05:51:00.023 UTC. The 05:55 UTC closed run completed 189 turns in 31.837 seconds
with zero errors. These samples do not establish sustained capacity.

The release retains the mandatory LoTW ownership write bridge, permanent encrypted
raw historical references and the guarded **±30-minute LoTW association path**.
Comparison uses current forward/reverse uniqueness and retained ownership across
inactive, signing-only and reconnected destinations. Minute-only times and valid
nested grid precision remain unchanged. Raw historical references are separate
from exact receipt identities and `ledger.remote_id`; they permanently block
uploads for that source contact across every LoTW destination. Exact Ferry
receipt recovery remains separate. QRZ retains its book-scoped LOGID ownership
and association-only write blocks.

The current release includes immediate QRZ history-observation reuse, bounded planning
allowances and deferred-key re-entry without removing the final duplicate query.
LoTW signing profile `ferry-lotw-v2-us-ca-3` holds unverified FST4W signing and
stale prepared profiles; stable exact identities and uncertain-result recovery
remain intact. Shared source comparisons, bounded ownership maintenance and
partition-local history retry delays remain in place. At **02:44:16.072 UTC**,
policy 6 is active: **9,981 covered inputs, zero pending or held inputs and zero
unhashed owners**. The comparison index is clean at **4,161 rows**. This aggregate
does not validate ciphertext or grant export authority; protected recovery
evidence is recorded below.
The later QRZ checked batches and automatic trial passed observed-precision
assessment. LoTW trial C subsequently passed native accepted-report readback and
full mixed recovery. Pair D made zero new attempts/uploads and remains held;
diagnosis of its history retry and unfinished invocation precedes another write
window. Broader exception review, LoTW batch/automatic acceptance and sustained
capacity remain open. All eight controls are currently closed as recorded above.

| Resource                  | Current value                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| Cloudflare account        | `478f5e15ae2afa01364d19f42a3e06f2` (existing account)                                       |
| Worker                    | `lofi-qso-ferry`, environment `production`                                                  |
| Deployed source revision  | `dd173803dc81096115eb554d55da4a5a2eb0f701`                                                  |
| Worker version            | `3c8cb733-2605-41fd-9c36-a7e9d4ee3db2`                                                      |
| Closure attestation       | 2026-10-25 15:58 UTC; all eight controls closed                                             |
| Origin / passkey RP       | `https://ferry.n1rwj.com` / `ferry.n1rwj.com`                                               |
| Dedicated D1              | `ferry-production`, `45ad64ad-92bb-491a-b6e6-1d2b17450144`, ENAM                            |
| Migrations                | All 37 migrations through `0038_attempt_artifacts`; independently verified after deployment |
| Sender                    | Native Cloudflare `EMAIL`, restricted to `signup@ferry.n1rwj.com`                           |
| Sending domain            | `ferry.n1rwj.com`, tag `e69af8ef82a140b38eeaef98d417ef30`, content previews disabled        |
| Schedule                  | `*/5 * * * *`                                                                               |
| Alternate origins         | workers.dev and version previews disabled                                                   |
| Historical 05:00 artifact | 2,093.85 KiB raw / 410.43 KiB gzip; reported startup 30 ms                                  |

The existing account and native email pattern were reused. Ferry has its own database and secrets; unrelated Worker databases were not modified. Sending DNS is isolated to the new subdomain and its bounce/authentication records; existing `n1rwj.com` Fastmail MX records were checked unchanged. No subscription or billing-plan changes were made. The account Email Sending API reported an existing quota of 200 messages/day; this deployment did not change that limit.

## Retained-artifact release and first scheduled trial (890f714c)

Signed revision `890f714c39390b71f0d4222eb03ef864981e5f98` deployed at
**2026-10-25 05:00:29.106103 UTC**, initially Worker
`8a1e9a6f-12a8-49de-be65-1be1ca4f8a52`. All **1,663 tests** and required checks
pass in [exact-release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40162836106).
The source and evidence commits are signed. Migration `0038` atomically retains
original encrypted attempt artifacts through terminal outbox cleanup, preserving
their original AAD and seven-day expiry. All **37 migrations through `0038`**
are installed. The 04:58 UTC PRE and 05:03 UTC POST recovery checks pass, preserving
all prior immutable evidence and the original delivered singleton.

A restricted two-contact QRZ scope was opened for a real scheduled trial. The
05:10 UTC run completed 27 contact turns/22 cached classifications in 93.097
seconds, with zero attempts, errors or vendor writes. The policy change woke the
whole backlog, leaving the scoped contacts behind unrelated due work. Successful
scheduled delivery remained unproved. The later `87e87b2d` release corrected
finite-scope selection, as recorded above.

Closure deployed the same signed source at **05:13:15.292286 UTC**, Worker
`8122bc6c-87eb-46d0-8b2e-5e13e5cd16e3`, deployment
`b1542925-2e7d-4a0f-a76e-2dfd978ebc26`, at sole 100% traffic. Independent
**05:17:40.088 UTC** verification confirms all **eight export controls closed**,
KEK 1, healthy HTTPS and matching assets. Both recorded runs are complete.
The 05:17 UTC backup passes isolated recovery/quarantine with exactly the original
one attempt, zero new scheduled attempts and zero table artifacts. The singleton's
purged body remains preserved only in its original protected host packet.

## QRZ request reuse and LoTW profile 3 release (0386af30)

The standard `deploy-readonly` task ran from an exact signed-release checkout.
No migration, credential or export-control change was required, and no new
assets were uploaded. The **02:32:22.968 UTC** attestation verified that release’s
actual Worker, deployment, revision, assets and closed controls independently of
build labels.

The **02:30:14.652 UTC PRE** snapshot contains **40,422,594 bytes**, SQL SHA256
`0773b9369aa7312d37212d8d4b91d993ee9f583f31718b5cb4840c576f618fdc`.
The **02:33:12.483 UTC POST** contains **40,449,296 bytes**, SQL SHA256
`22180ca1ff35bdcadcba60272dd2579341ec2c96821edf6cdeb7631ebc1de109`.
Both retain all 36 migrations and validate **3,327 populated exact ownership
envelopes**, their original AAD/HMAC/owner bindings, all three credentials and
the tenant comparison key. Isolated restore, integrity/FKs and two quarantines
pass. Raw historical references, attempts, proofs, pins, cutovers and staging
guards are zero. New intake left two unhashed owners in the POST snapshot;
normal bounded maintenance processed them before the later 02:44 aggregate.

The separate **02:39:24.873 UTC** PRE→POST comparison preserves every column of
all **3,327 claims, 2,895 QRZ owners, 2,895 association markers and 3,327 exact
evidence records**, plus the tenant comparison-key binding. These immutable
projections have zero changed, missing or added rows. Mutable intake, bootstrap
and scheduler state are outside that comparison. The SQL snapshots were restored
only in memory; production was never restored. Empty raw-reference tables do
not establish populated raw-reference recovery.

The first two completed runs started after the confirmed deployment:

| UTC start–finish          | Contact turns / classifications | D1 RPCs / SQL statements | Duration | Errors / deferrals |
| ------------------------- | ------------------------------: | -----------------------: | -------: | -----------------: |
| 02:35:42.675–02:37:13.709 |                        126 / 96 |              852 / 3,355 | 91.034 s |              4 / 4 |
| 02:40:43.094–02:41:39.113 |                       148 / 156 |              856 / 3,810 | 56.019 s |              3 / 9 |

Both stop at `database_budget`, with zero adoptions and zero attempt turns.
The **02:44:16.072 UTC** fixed-category readback identifies respectively two/one
`history_read:lotw:lotw_unavailable` events affecting four/three routes, and
four/three `vendor_budget_deferred` events affecting four/nine routes. Shared
read failures can affect multiple contacts; affected-route totals are not HTTP
request counts. Unavailable or budget-denied reads remain held and do not prove
absence. These aggregates do not identify the precise upstream response, a
matching regression or sustained export capacity. Policy 6 is active and
attempts, cutovers and staging guards remain zero.

## Bounded bootstrap and authoritative deletion release (f2c41cb3)

No migration was needed for this release. The protected **21:28:43.196 UTC** PRE
and **21:30:41.035 UTC** POST snapshots contain identical **41,811,658-byte SQL**
exports. Both pass isolated restore, all three credential decryptions, comparison
key verification, integrity/FK checks and two quarantine passes. The POST verifies
all 3,294 then-populated exact evidence envelopes and their AAD, retained keys,
HMAC buckets and ownership bindings. At **21:35:43.166 UTC**, the separate
immutable comparison preserves every field, ciphertext and creation time of all
3,327 claims, 2,689 QRZ owners, 2,689 markers and 3,294 prior LoTW evidence rows.
No rows are missing, changed or added across these immediate snapshots. Mutable
bootstrap state is deliberately excluded from that immutable comparison.

The first run, **21:30:48.324–21:31:50.809 UTC**, processed 220 contact turns and
380 classifications, with zero adoptions or attempt turns, four errors and zero
deferrals. It stopped at the database budget after 62.485 seconds, using 857 D1
RPCs / 6,865 SQL statements. An overlapping completed idle run,
**21:31:18.620–21:31:28.582 UTC**, used 62 RPCs / 535 statements in 9.962 seconds,
with zero contact turns, errors or attempts. Their ownership phases covered the
remaining 1,392 inputs. These samples do not establish sustained capacity or the
cause of the errors. Fixed-category readback at **21:37:23.816 UTC** identifies
one QRZ history-read event affecting four routes. The **21:40:20.901 UTC**
exact-key audit confirms stored `history_read:qrz:unknown`; its exact cause is
unknown. At **21:32:51.368 UTC**, raw references, attempts, cutovers,
proofs and pins remain zero; populated raw-reference recovery remains open.

The **21:36:47.379 UTC** protected backup verifies all **3,327 populated exact
evidence envelopes**, complete bootstrap coverage and 2,702 QRZ owners/markers.
Its 42,144,346-byte snapshot passes credential/key decryption, exact AAD/HMAC and
ownership checks, integrity/FKs and two isolated quarantines. The separate
**21:37:57.619 UTC** immutable comparison preserves every prior claim, owner,
marker and evidence field; additions are 33 exact copies and 13 QRZ
owners/markers, with zero prior rows changed or lost. Raw references remain
empty, so populated raw-reference recovery is still open. Neither check restores
production or grants export authority.

## LoTW ownership and historical association release (5a427a30)

The then-sole deployment was `9abe3b85-f5c4-4250-9d26-45d9b53bd332`, at 100% traffic,
with the exact signed source, Worker version and eight closed controls verified
independently at **20:27:28.292 UTC**. Applying `0035`–`0037` advances production
from 33 to 36 migrations. The bundle is 2,093.87 KiB raw / 407.82 KiB gzip, with
reported startup of 32 ms.

The protected predeployment backup completed at **20:25:52.291 UTC** and contains
**33,029,891 bytes**, all 33 then-installed migrations, 2,549 QRZ owners/markers,
3,327 exact claims, 4,141 comparison-index rows and all 4,500 source rows. Its
2,465 missing ordinary bodies are legitimate resolved archives. All three current
credentials and the initialized comparison key decrypted; integrity, foreign-key
and twice-quarantine checks passed, with zero attempts, proofs or pins. The final
**20:26:17.941 UTC** isolated rehearsal applied `0035`–`0037`, preserved all 12
checked original tables and all five ownership/history registries, and retained
their encryption and ownership boundaries through repeated quarantine. No
production restore or vendor mutation occurred.

The protected POST backup completed at **20:27:46.782 UTC**: **39,123,981 bytes**,
all 36 migrations, 2,549 QRZ owners and markers, 3,327 exact claims, 4,141 index
rows and all 4,500 source rows, including 2,465 legitimate archives. Isolated
restore decrypted all three credentials and the tenant comparison key, passed
integrity/FK checks, and preserved the ownership bridge, raw-reference schema,
source, inventory and receipt evidence through twice quarantine. Attempts,
cutovers, proofs, pins, temporary guards and raw historical references were zero.
The new registry had **3,833 unhashed owners and 9,981 pending inputs**, with zero
held inputs or copied evidence: this is unfinished bootstrap, not authority.
Because new exact/raw evidence tables were empty, this snapshot does not verify
recovery of populated new ciphertext.

The **20:28:34.534 UTC** isolated PRE→POST comparison retained all **3,327 claims,
2,549 owners and 2,549 markers**, including every field and creation timestamp,
with zero missing, changed or added rows. No production restore or vendor write
occurred.

The first completed scheduler run, **20:30:43.485–20:32:18.599 UTC**, processed
22 contact turns, 21 classifications and four adoptions, with zero attempt turns,
one error and zero deferrals. It stopped at the deadline after **95.114 seconds**:
359 D1 RPCs / 2,878 SQL statements, 85.250 seconds D1 wall time and 1.868 seconds
reported SQL time, with 12 inventory fetches and 13 hits. Its ownership phase
took **20.832 seconds**: ten bounded passes examined 1,000 inputs, covered none
and hashed 1,000 owners. Fixed-category readback identifies one
`history_read:lotw:lotw_unavailable` event affecting one route. That path rejects
non-success or untrusted reports without establishing absence; the exact HTTP
cause was not retained. Coverage remains incomplete and bounded partition retry
applies.

The **20:31:23.628 UTC** aggregate, captured during that run, passed all **19
checks** with matching policy v5 active. It recorded **2,833 unhashed owners,
8,981 pending inputs and 1,000 held claim inputs**. None of the 3,327 retained
identity inputs or 3,327 mapping inputs had been copied yet; new evidence, raw
references and attempts remained zero. These results verify bounded maintenance
starting, not completed coverage, a speedup, sustained capacity or export
authority. Retain every KEK referenced by permanent exact/raw ownership evidence
until a separate rewrap path is implemented. Fresh same-contact source/vendor
proof, exception review and first-write acceptance remain open.

### Populated ownership recovery and later progress

Independent **20:50:37.114 UTC** attestation confirms the same sole signed Worker,
all eight closed controls, active KEK version 1, healthy HTTPS and matching
assets. The **20:50:15.919 UTC** aggregate passes all 19 checks, with 640 copied
exact records, 640 covered inputs, 5,981 pending inputs, 3,360 held inputs and
two unhashed owners. It retains 2,635 QRZ owners/markers and a clean 4,144-row
source index. Attempts, cutovers, proofs, pins and raw LoTW references are zero.

The fresh backup completed at **20:50:59.570 UTC**: **38,728,270 bytes**, all 36
migrations, 4,507 source rows, 4,145 index rows, 3,327 exact claims and 2,635 QRZ
owners/markers. Counts can advance between the aggregate and backup through
normal intake. All **640 populated exact ownership envelopes** decrypt and pass
original-AAD, retained-KEK, owner, record and HMAC-bucket checks. Isolated
integrity/FKs, three credential decryptions, tenant-key verification and repeated
quarantine preserve all bridge/raw/source/inventory/receipt tables. No production
restore occurs. Raw historical references remain empty; their populated recovery
still needs verification after historical association begins.

The **20:51:08.635 UTC** immutable comparison against the exact final 20:25 PRE
snapshot retains every field and creation time of all 3,327 claims and 2,549 prior
QRZ owners/markers. There are zero changed or missing prior rows and 86 additional
guarded QRZ associations. Private manifest SHA256:
`158cd49ad7f528fd1eec2f75bf006351d31297c1bcf6e1d59b15e998760facd1`;
SQL SHA256: `081dcfdf203bfcd004eea0be5974c0a2782cb44e2fd01312b9bc9577ade16a69`.

The latest completed cron, **20:45:43.988–20:47:18.571 UTC**, takes 123 contact
turns, classifies 89 destinations and adopts 29, with zero errors, deferrals or
attempt turns. Ten ownership passes hash 834 owners, examine 1,000 inputs and
cover 640. It stops at the deadline after 94.583 seconds, using 740 D1 RPCs /
6,496 SQL statements. This is continued bootstrap and reconciliation, not
steady-state capacity or export readiness.

## Fixed history-scope diagnostics release (c4f51de8)

This release distinguishes missing identity, missing station, wrong station and
out-of-partition date failures using fixed categories. The validation predicates,
retained evidence, matching and export permissions are unchanged; invalid reports
still fail closed. No migration or vendor mutation occurred. At that checkpoint, the partition-local
retry patch and LoTW ownership foundation were separate, undeployed work.

The first completed cron, **17:30:42.737–17:31:25.276 UTC**, processed 100 contact
turns, 110 classifications and 72 adoptions, with zero errors, deferrals or attempt
turns. It stopped at `database_budget` after 42.539 seconds: 856 D1 RPCs, 3,675 SQL
statements, 41.624 seconds D1 wall time and 6.863 seconds reported SQL time; three
inventory fetches and 107 cache hits. No new category appeared in this sample.
This is not evidence that diagnostic wording fixed prior failures or improved
sustained throughput.

At **17:33:38 UTC**, all 13 aggregate checks passed: 797 QRZ mappings had matching
owners/markers/write blocks with no gaps; all 4,141 index rows were clean; all
3,327 LoTW exact claims were covered. There were 778 legitimate source archives,
3,722 retained bodies and no unexplained missing bodies. Attempts, cutovers,
proofs and pins were zero. The **17:34:16.158 UTC** fixed-query aggregate recorded
797 mapped / 2,432 ambiguous / 135 mismatched / 469 pending QRZ routes. Of the
ambiguous routes, 2,423 had no current-generation memo; nine post-index checks
reported eight remote-competitor holds and one location-detail hold.
The aggregate helper's expected-version labels are not attestation; the independent
17:33:39.140 UTC receipt establishes the deployed Worker and closed controls.

The dated **17:04:57 UTC** backup and exact ownership-preservation checks below
cover that earlier 33-migration snapshot; their counts do not include later
adoptions. The current release and recovery status are recorded above.

## Lookup and coverage release verification (9aeab582)

Signed `9aeab582149baa8af8fd6db8cc9cc318b2bc3739` deployed at
**17:04:38.163667 UTC** as Worker `950c081c-03b4-455f-8e31-b579fec56788`
(created 17:04:37.205834 UTC), deployment `f4213a4e-e67e-4ef8-8581-41196f47f14f`,
at 100% traffic. All **1,485 tests** and required checks passed in
[CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40112629290).
Initial independent verification was at **17:04:50.692 UTC**. The bundle was
1,992.86 KiB raw / 389.79 KiB gzip, with reported startup of 25 ms.

The first deployment attempt stopped at the D1 migrations API error `7403`, before
changing the Worker. A read-only migrations recheck succeeded with nothing to
apply; the same guarded deployment then completed. No credentials or export
controls changed. Independent attestation confirmed active KEK version 1 alongside
the exact release, sole deployment, health and assets.

At **17:05:22.396 UTC**, all 13 aggregate checks passed: **4,141 published index
rows**, zero dirty/rebuilding/unknown entries, and **462 QRZ mappings**, each with
a permanent owner, association marker and write block, with no gaps. All **3,327
LoTW exact claims** covered their mappings. **453 legitimate archives / 4,047
retained source bodies** accounted for all 4,500 source rows, with no unexplained
missing bodies. Attempts, cutovers, diagnostic proofs, pins and temporary guards
were zero.

The **17:05:22.426 UTC** route snapshot was:

| Destination | Mapped | Ambiguous | Mismatched | Pending | Adoption conflicts |
| ----------- | -----: | --------: | ---------: | ------: | -----------------: |
| QRZ         |    462 |     2,810 |        100 |     461 |                  0 |
| LoTW        |  3,327 |         7 |        160 |     339 |                  0 |

These checks precede the first completed new-runtime cron. They verify preserved
state, not a measured production speedup or finished exception review. The latest
completed 17:00 run used the old runtime; its five adoptions and 53 affected-contact
errors must not be attributed to this release. The fixed-category scope telemetry
patch and broader LoTW ownership/classification are not included in `9aeab582`.

The first completed `9aeab582` cron ran **17:05:42.632–17:07:16.980 UTC**:
80 contact turns, 47 classifications and **38 adoptions**, with zero attempt turns
or deferrals. It stopped at the deadline after **94.348 seconds**, using **552 D1
RPCs / 2,407 SQL statements**, 92.033 seconds of D1 wall time, six inventory fetches
and 42 cache hits. Two diagnostic events affected 15 contacts: one missing ADIF
time and 14 generic history-scope mismatches. Their causes remain unresolved.
At **17:07:28.689 UTC**, QRZ had **500 associations/owners**, with the 4,141-row index
still clean; 2,765 routes were ambiguous, 103 mismatched and 465 pending. Of those
ambiguous outcomes, 2,760 lacked a current-generation memo and five had explicit
post-index remote competitors. This single run is not sustained capacity or a
controlled performance comparison. Runtime identity comes from independent release
attestation, not the aggregate query's older matching-policy baseline label.
Final **17:08:02.184 UTC** attestation reconfirmed the same sole Worker/deployment,
all eight closed controls, active KEK version 1, healthy HTTPS and matching assets.

The protected **17:04:57 UTC** postdeployment backup contains **33,946,884 bytes**
and all 33 migrations. Isolated restore decrypted all three current credentials
and the initialized comparison key, verified its HMAC key ID, and passed integrity,
foreign-key and twice-quarantine checks. All 4,141 index rows, 462 owners/markers
and 453 archived-body checks passed. No attempts, cutovers, proofs or pins were
present. At **17:05:22.514 UTC**, exact comparison with the prior 16:07 backup
preserved all **3,327 claim rows and 39 prior owners/markers**, including every
field and creation timestamp; **423 owners/markers were added**, with no missing
or changed prior rows. No production restore or vendor mutation occurred.

Before this deployment, the **16:53:05.833 UTC** protected Node/D1 diagnostic on
frozen `6ff685a7` modules established a current source proof and complete empty QRZ
neighborhood for one contact. It used two source reads, two dependencies/no events,
one original proof batch and three QRZ reads, with final proof/audit/closed-control
checks passing. This transient observation does not verify execution of the new
Worker, write acceptance or export authority. See [bootstrap evidence](bootstrap.md#historical-association-and-vendor-matching)
and [capacity measurements](capacity-plan.md#lookup-and-coverage-follow-up--deployed-9aeab582).

## QRZ historical association release verification (6ff685a7)

The protected pre-deployment backup at **15:33:54 UTC** retained 36,243,073 bytes,
31 then-installed migrations, 4,500 source rows, 7,666 ledger rows and 3,176 exact
destination claims. Isolated restore, integrity/foreign-key checks, all three
credential decryptions and repeated recovery quarantine passed. Applying
`0033`/`0034` to that verified snapshot only in memory preserved every exact
claim; its 4,141 ordinary contacts had no missing or archived bodies.

Production migration and deployment were followed by independent verification of
33 migration names, 43 mandatory authorization guards and 39 historical-index/
association guards. At **16:03:00.447 UTC**, all 13 aggregate checks passed:
4,141 source index rows were published with zero dirty, rebuilding, unknown,
missing, orphan or invalid-key rows; matching policy version 4 and complete
current source/context membership were active. All 3,327 LoTW claims covered
their mapped owners. Attempts, cutovers, proofs, pins and temporary guards were
zero. Source-index coverage does not establish universal upstream completeness,
absence or export authority.

Four bounded index-maintenance invocations completed by **16:02:36.319 UTC**.
Each used at most 100 contacts/4 MiB per pass, ten passes per invocation, 100 D1
calls and a 45-second admission deadline. They made no source, ledger, attempt
or vendor writes. The scheduler also indexed records concurrently; publication
counters can overlap and must not be summed into distinct contacts.

The first completed new-runtime cron ran **16:00:42.898–16:02:17.635 UTC**,
before index completion: 105 contact turns, 89 destination classifications,
zero adoptions, errors, deferrals or attempt turns. It examined 1,000 index rows
and reported 900 publications, with zero held rows. It stopped at the deadline
after 94.737 seconds, using 610 D1 RPCs/4,474 statements and 91.754 seconds of
D1 wall time. This is an initial-backfill observation, not steady-state capacity.

The first pass after index completion ran **16:05:42.889–16:06:38.147 UTC**:
82 contact turns, 74 destination classifications and **39 QRZ associations**,
with zero attempt turns, errors or deferrals. It stopped at the database admission
budget after 55.258 seconds, using 916 RPCs/3,039 statements and 52.291 seconds of
D1 wall time. It recorded 25 inventory fetches and 54 cache hits. Started bounded
work can finish beyond the soft RPC threshold; this observation does not establish
steady-state throughput or 200,000-contact capacity.

At **16:07:37.591 UTC**, all 13 aggregate checks still passed. Each of the 39 QRZ
mappings had a permanent owner, association-only marker and write block, with zero
unreserved mappings, orphan associations or missing write blocks. All 4,141 index
rows remained published and clean. Ordinary retention archived 36 fully resolved
source bodies; every missing body satisfied the published-index and permanent-owner/
exact-claim checks, with zero unexplained missing bodies. Attempts, cutovers,
proofs, pins and temporary guards remained zero. At **16:07:02.175 UTC**, the
independent version, HTTPS and asset attestation reconfirmed the same sole Worker
and all eight closed controls.

The **16:07 UTC** protected postdeployment backup retained 35,325,311 bytes and
all 33 migrations. Its isolated restore passed integrity, foreign-key checks,
three credential decryptions and repeated recovery quarantine. The one initialized
tenant comparison key decrypted successfully and its derived key ID verified;
quarantine preserved the key envelope, 39 historical owners and 39 association
markers. All 36 archived-body checks passed. No production restore or vendor write
occurred. A separate exact comparison at **16:08:10.506 UTC** verified that all
**3,176 complete predeployment claim rows, including creation timestamps**, remain
unchanged in the 3,327-claim backup; 151 additional claims are present and none are
missing.

The **16:07:37.728 UTC** route snapshot has 39 mapped, 3,359 ambiguous, 16 mismatched
and 419 inventory-pending QRZ routes, with zero adoption conflicts. LoTW has 3,327
mapped, seven ambiguous, 161 mismatched and 338 pending routes. These counts cover
3,833 routes per vendor; they are not completed exception review. Reconciliation
continues under policy version 4, and remaining holds must be reassessed before
being treated as a manual exception queue. Broader LoTW association, reduced
comparison cost and the separate first-write evidence packet remain open.

## Previous vendor-matching release verification (0dad1031)

The first completed run on the previous `0dad1031` release ran **13:45:43–13:47:22 UTC**:
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

## Matching release verification (2026-10-24, 12:51 UTC)

The 12:29 UTC current-schema backup retained 27,953,415 bytes, all 31 migrations,
4,500 source bodies, 7,666 destination rows and 380 durable identities. Isolated
restore, integrity/foreign-key checks, all three current credential decryptions
and repeated recovery quarantine passed. No production restore occurred.

The 12:51:38 UTC aggregate readback independently verified all 31 migrations,
32 mandatory authorization guards, complete ready source membership, all 4,500
body incarnations and coverage of all 380 mapped identities. Export attempts,
cutovers, pins and temporary write guards were zero. The HTTPS/version/asset
attestation completed at 12:51:39 UTC. No vendor mutation occurred.

The first matching-release cron completed **12:55:44–12:57:13 UTC** with
147 contact turns, 262 destination classifications and **99 LoTW adoptions** in
88.756 seconds. It stopped at the database budget: 878 D1 calls, 5,018 statements
and 80.687 seconds of database wall time. Three affected-contact errors and 21
deferrals remain; this sample does not establish sustained capacity. The 12:58:08
snapshot has 479 LoTW adoptions and identity claims (up from 380), with no uncovered
mapped identities, export attempts, cutovers or temporary stage guards. Matching
policy version 2 is active. QRZ remains held for the separate association work.

## Gate verification

Read back from the deployed Worker settings, independently of the local configuration:

```text
EXPORTS_ENABLED=false
ROLLOUT_CHECKS_PASSED=false
SOURCE_BOUNDARY_VERIFIED=false
QRZ_FRESH_INSERTS_ENABLED=false
LOTW_FRESH_INSERTS_ENABLED=false
LIVE_WRITE_AUTHORIZATION=
ROLLOUT_QSO_IDS_JSON=[]
ROLLOUT_DESTINATION_IDS_JSON=[]
```

[Health](https://ferry.n1rwj.com/health) returns `{"status":"ok","exportsEnabled":false,"exportMode":null,"sourceBoundaryVerified":false}`. No contact or destination scope is enabled. The scheduled service can poll and adopt configured history after the owner connects accounts; it cannot sign, insert, replace, delete or upload contacts with these gates closed. Signup email and LoFi approval/client renewal are separate provider interactions.

## Historical live checks

- HTTPS UI and static assets load in Chromium with no console errors; secure context confirmed. At 375×812 there is no horizontal overflow.
- Session endpoint returns unauthenticated state with `signupAllowed=false`. The public landing shows an invite-only notice and passkey sign-in; the signup form is hidden. A live uninvited signup probe returned 403 before proof creation or sending.
- Following the invitation link stays at `/join`, serves the app without the asset-canonicalization redirect, reveals invited enrollment and focuses its email field. Both confirmation inputs expose six-digit numeric/one-time-code attributes.
- Remote settings independently confirm every closed gate, exact origin/RP, dedicated D1 and sender allowlist. Production local-mailbox and alternate workers.dev endpoints return 404. Email-content previews remain disabled, and no secrets were rotated.
- The earlier association release passed **1,429 tests** and all required checks in [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40108165167). Current `0386af30` qualification and its 1,653-test result are recorded above.
- Read-only remote D1 probes verified that the invite task must use query results, rather than bulk-file import summaries, to establish an exact email/deadline grant. Existing OAuth includes Email Sending write access. No real invitation grant/send was performed; CLI sends still require recipient-specific delivery confirmation.
- The initial deployment delivered one real verification message to the owner's inbox through the same native provider path; only fixed delivery metadata was inspected. That smoke test enrolled no production account and initially observed zero account/connection/ledger/attempt rows. These are historical counts, not a claim about subsequent personal use. New branded mail was rendered/tested locally; email-client/device autofill remains unverified.

The reported startup is deployment evidence, not per-request billed CPU or peak memory. No representative monthly workload/cost has been measured. Physical and synced passkey behavior remains for the owner to verify at this permanent origin. See [rollout acceptance](rollout-checklist.md) for the remaining vendor checks.

## Disabled release and backup (2026-10-24, 07:48–07:59 EDT)

The signed release passed all 1,338 tests in CI; its test phase took 973,565 ms.
The guarded deployment applied only migration `0032` (57 statements, reported
75.40 ms), uploaded the two changed JavaScript assets and preserved the existing
secrets, hostname and five-minute schedule. Independent checks at 11:59:21 UTC
verified the sole deployed version at 100% traffic and all eight disabled controls.

A fresh protected SQL backup completed at **07:48:34 EDT (11:48:34 UTC)** before
migration. Its 26,590,819 bytes restored only in memory with all 30 then-installed
migrations, clean integrity and foreign-key checks, successful decryption of all
three current credentials, and two recovery-quarantine passes. It contains 4,500
source rows, 7,666 ledger rows, 380 identity claims and zero attempts, cutovers,
proofs or pins. Expired diagnostic proofs had already been removed by retention.
The private manifest records its hash, bookmark and the old deployed Worker;
`0032` was recorded as pending rather than claimed installed in that snapshot.

At 07:49:27 EDT, applying `0032` to that hash-verified snapshot only in memory
preserved all 56 tables and 33,903 rows, every existing trigger definition, and
clean integrity/foreign keys. It added four LoTW guards. The later production D1
readback verified all 31 migration names, the QRZ and LoTW views, 32 required
proof/policy/identity guards, covered mappings and zero export activity. Source
policy remains ready with 218 operation and 4,282 QSO-stream records, zero unseen
members and 4,130 contacts eligible for reconciliation. The 340 QRZ and 335 LoTW
structural candidates are not authorized exports and lack a current source proof.
No production restore or vendor write occurred.

## Earlier scheduled run and bounded read follow-up (12f636b3, 2026-10-24)

Final independent checks at **08:08:17 EDT (12:08:17 UTC)** reconfirmed the
same deployed version at 100% traffic, all eight closed controls, healthy HTTPS
and matching assets. Attempts, cutovers, stage guards and attempt-proof pins
remained zero after the scheduled run and stopped diagnostic.

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

## Current-schema backup verification (2026-10-24, 07:56 UTC)

A second backup completed at **08:14:29.433 UTC**, after the successful joint
source/QRZ check. The 31,870,982-byte snapshot passed the same 30-migration,
integrity, foreign-key, three-credential and repeated-quarantine checks below.
It preserves one immutable source proof and one retention row, alongside 380
identity claims and zero attempts, cutovers or attempt-proof pins. This exercises
nonempty source-proof/retention preservation, but not nonempty attempt-proof pins.
The private manifest retains its SQL hash and pre-export bookmark. Gates, assets
and deployed version were rechecked at 08:13:50; no production restore occurred.

At 07:56:04 UTC, independent version, deployment, health and asset readback
confirmed the same deployed release at 100% traffic and all seven controls closed.
A new protected SQL export completed and passed isolated verification at
**07:56:18.407 UTC**. All 30 migrations through `0031` are installed; none was
applied during the rehearsal. SQLite integrity and foreign-key checks passed,
and the protected encryption key decrypted all three current credentials.

The snapshot contains 4,500 source rows, 7,666 ledger rows, 380 permanent identity
claims and zero attempts, cutovers, source proofs or proof pins. Two quarantine
passes ran only in memory, leaving accounts, connections, sessions, credentials
and leases inactive while preserving ledger rows and identity fields, ownership and
immutable proof/attempt records. The synthetic restore test exercises nonempty
attempts, claims and cutovers; this backup does not verify nonempty proof/pin
preservation.

The private SQL file is 31,487,578 bytes. Its private manifest records its SHA-256,
the pre-export Time Travel bookmark and the independently attested Worker version.
The helper's local Git revision is recorded separately and is not deployment
evidence. SQL and manifests remain outside Git in protected storage. No production
restore, migration, source/cursor write or vendor mutation occurred. Keep this
snapshot and its key available; refresh it before any later external changes if
the state has changed. Off-device key storage remains unconfirmed.

## Bounded baseline pages and policy-aware audit (2026-10-24, 06:09 UTC)

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

The prepared collector fix requests 25 records but accepts bounded timestamp
groups up to 100 per stream, with whole-page validation and unchanged proof/request
limits. Both collector changes later shipped in signed release `12f636b3`, whose
full release CI passes 1,338 tests. The 1,184-test checkpoint described here
predates that release.

The earlier 07:38:44 QRZ-only check observed absence without a source proof;
the 08:12:53 combined observation above closes that evidence gap for one sample.
The 06:55 candidate had a nearby record and remains unsuitable for absence-based
insertion. No historical association or precision hold was waived. All seven
export controls remain closed, and the owner's keep-disabled instruction applies.

Canonical all-client backfill now requests up to 100 records per stream with
strict response, preparation and atomic checkpoint bounds. A deterministic size
failure can retry once at 25 using the original cursor and shared request budget;
lease, protocol, deadline and uncertain checkpoint failures cannot. Drain,
quarantine, repair and destination-rescan pages retain their existing size.
The review audit requires current ready policy membership and can inspect a
structurally eligible `inventory_pending` QRZ first insert without export authority.
No new migration was required.

The first scheduled run, 06:10:43–46 UTC, processed two pages and 105 raw records,
with 84 D1 calls, 631 statements, 2.671 seconds of database wall time and 447 ms
reported SQL time. It stopped idle without errors or budget deferrals. This
confirmed saved-cursor continuation, not four-page sustained throughput. The
subsequent source handoff is recorded above; fresh source-proof minting and exact
QRZ checks remain required. No attempt or cutover was created.

The initial larger-page runs preserved the saved cursor and existing request
limits. Their variable page counts and D1 latency are recorded in the
[capacity measurements](capacity-plan.md#bounded-100-record-baseline-follow-up-deployed-0609-utc).
Baseline completion does not establish sustained capacity, global purge retention
or permission to create cutovers.

## Independent QRZ first-insert authority (2026-10-24, 05:40 UTC)

Signed revision `32a62951e0fc96b94835573de36c854ef3b1b7f7` deployed read-only
at 05:40:28 UTC as Worker `0a110eae-4198-4e2d-b0a9-8a542c731866`, at 100% traffic.
All **1,165 tests** and required checks passed in [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40066174166).
Independent 05:40:45–46 checks confirm healthy service, matching hashes for all
three assets and all seven export controls closed. Health reports no active
export mode and `sourceBoundaryVerified:false`. All 30 migrations through `0031`
are applied. The 380 LoTW identity claims have no uncovered mappings; attempts,
cutovers, proofs, pins and temporary guards remain zero. All 4,500 source bodies
have incarnations, and 1,555 positive observations have no future or partial metadata.
The all-client policy is still in backfill with 218 operations and 2,250 QSO-stream
records in the current epoch, zero ready sources and zero eligible source members.
The 398 structurally eligible QRZ routes are not ready exports: source completion,
fresh proofs, current QRZ checks and explicit future authorization remain required.

Migration `0031` pins authorization mode immutably and guards first-insert history.
The new mode cannot grant LoTW, replacement, correction, cutover or no-query
permissions. Final dispatch checks the exact QRZ INSERT request after vendor
admission. Uncertain attempts retain read-only recovery when gates close.

The protected pre-release backup completed at 05:20:29 UTC. Its isolated restore
passed all 29 production migrations plus `0031`, integrity and foreign-key checks,
three current credential decryptions and repeated quarantine. It preserved 380
claims and zero attempts/cutovers. No production restore or vendor mutation occurred.

The first scheduled run on this release, 05:40:42–05:41:11 UTC, completed four
source pages and 110 records in 28.968 seconds, with no contact turns or errors
and one request-budget deferral. It used 139 D1 calls and 724 statements;
27.465 seconds of D1 wall time versus 513 ms reported SQL time remain latency
observations, not a sustained throughput result. Attempts and cutovers stayed zero.

The source baseline and fresh QRZ evidence remain outstanding. The 36 retained
complete QRZ cache rows and 398 structural first-insert candidates are not current
absence evidence or export readiness. Source policy completion comes first, then
one exact contact's current checks with all gates still closed.

## Mandatory source-proof release (2026-10-24, 05:11 UTC)

Signed revision `5a416de5898657a6b12b60fd900d787f60341d51` deployed read-only
at 05:11:14 UTC as Worker `a16f8d42-d039-437e-8fee-44116ddb5195`, at 100% traffic.
All **1,131 tests** and required checks passed in [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40064363238).
Independent 05:11:28 checks confirm healthy service, all three asset hashes
matching, all six export gates closed, 29 migrations through `0030`, 380 LoTW
identity claims and zero uncovered mappings, attempts, cutovers or temporary
guards. Mandatory preparation/dispatch proof binding and bounded scheduler
integration are deployed. No proof, attempt pin or retention candidate exists
while exports are closed. All 4,500 retained source bodies have incarnations;
1,055 positive observations have no future or partially populated metadata.
The all-client policy remains in backfill with 218 operations and 1,750 QSO-stream
records in the current epoch, zero ready sources and zero eligible exports.

The first deployment attempt failed the D1 access check before applying migrations.
A read-only authorization check succeeded, and the same read-only deployment
then completed. No export gate was changed and no production restore occurred.

Migration `0030` makes current source proof mandatory independently of legacy
identity or null-context shortcuts. Each attempt pins an immutable proof; missing
policy, stale dependency membership, changed source/credential/context or expired
evidence cannot authorize staging or dispatch. Final transport authorization runs
after vendor admission, with proof, lease and certificate deadlines checked before
mutation begins. Known-unsent stale artifacts may be cancelled and rebuilt;
uncertain artifacts and permanent identity claims are retained. Indexed cleanup
removes bounded unpinned proof candidates while preserving pinned audit evidence.

Shared collection keeps the four-request cap, including authentication and the
final canonical drain. A budget-limited cohort can publish only fully witnessed
contacts after that drain and exact dependency reload. Previously budget-held
contacts receive a later singleton turn. An unsuccessful budget-limited singleton
gets an exact-version ten-minute retry delay, allowing neighbors their ordinary
five-minute turns. A single contact requiring more than three collection reads
remains held. This does not establish sustained capacity or open any gate.

A fresh protected production SQL backup completed and was verified at 04:25:27 UTC
before this release. Its isolated restore passed all 28 existing migrations plus
pending `0030`, integrity checks and zero foreign-key violations. All three current
credentials decrypted; repeated quarantine preserved 380 permanent identity claims
and zero attempts/cutovers. No production restore or vendor mutation occurred.
Preserve that backup and its verification evidence before external changes.

The latest pre-release aggregate at 04:51:11 UTC has all 218 operations and
1,425 QSO-stream records in the policy epoch, still in backfill with zero ready
sources or eligible exports. Attempts, cutovers and temporary guards are zero.
QRZ has 36 complete and one pending partition, with 3,435 ambiguous and 398 pending
ledger rows. No covering plan remains retained: the prior 98-record plan expired
at 04:00:56. Partition cleanup can reduce counts without resolving a gap. Fresh
coverage for the exact trial cohort and live vendor acceptance remain outstanding.
At approximately 04:58 UTC, the pending partition was an expired, empty base
manifest awaiting cleanup or rebuilding. The complete-partition count was not
independently verified for freshness. By 05:11:28 the expired pending row had
been removed; the remaining 36 complete cache rows are not new absence evidence.

## Source-proof foundation (2026-10-24, 04:13 UTC)

Signed `3d7b0cac782af45bcd6684129f77da4cd8f159e2` was deployed at 100% traffic as
Worker `4a8c5a8b-8eb1-4569-b0b5-33a7acd2a043`. Independent 04:18:07–04:18:08 UTC
checks confirm all six gates closed, healthy service, matching hashes for all
three static assets, 28 migrations, 380 LoTW identity claims and zero attempts,
cutovers, uncovered mappings or temporary guards. The all-client policy remains
in backfill with all 218 operations and 800 QSO-stream records in the current
epoch; no source is ready and no contact has export membership.

Migrations `0027`–`0029` and the read-only foundation add canonical positive
observations, completed-drain markers, immutable exact-dependency proofs and
indexed anchors for bounded shared collection. They grant no export authority.
Mandatory attempt proof binding and scheduler integration remain in progress.
The 03:50:46 UTC protected backup passed isolated restore, all three pending
migrations, integrity/foreign-key checks, three current credential decryptions
and repeated quarantine before deployment. Production was not restored. An
initial deployment failed during D1 authentication before applying migrations;
Wrangler refreshed its OAuth credentials, a read-only query succeeded and the
retry applied all three migrations and deployed successfully.

## Versioned all-client baseline (2026-10-24, 03:28 UTC)

Signed `ce238cdcfea72ed5cbc7b624ec6a7efc01978154` deployed at 100% traffic as
Worker `aabdd51c-1665-480a-8806-fe993967bc27`. The 03:29:43.001 UTC verification
confirmed all six gates closed, healthy service with `exportsEnabled:false`, and
matching hashes for all three static assets. The 03:29:42.840 D1 read confirmed
25 migrations, 380 LoTW identity claims, zero uncovered mappings and zero attempts,
cutovers or stage/history guards. The 03:29:42.839 policy read found one active
source and no policy row before the first scheduled poll. The first run activated
one all-client policy at 03:30:43.295. At 03:31:37.477, it was in backfill with
25 operations and 25 QSOs in the current epoch and no ready policy or eligible
export; attempts, cutovers and guards remained zero. The 03:30:42.584–03:30:44.847
run completed in 2.263 seconds, with two source pages, 50 records, zero contact
turns/errors/deferrals and an idle stop. Continued baseline progress and handoff
still need observation.

The release migrates canonical source reads to a versioned all-client baseline,
preserves historical births, quarantines unseen dependencies and fences old
checkpoints and stale dispatch after policy activation. It does not establish
global source-boundary authority. Fresh-positive collection, witness storage and
proof foundation, indexed observation anchors and shared cohort coordination are
signed and pushed through `e16f987441fc`, followed by exact-key lookup correction
`3d7b0cac782a` and the successful 04:13 foundation deployment above. Mandatory
stage/dispatch integration remains in progress. No real vendor write occurred.

## Integrated QRZ coverage and destination scope (2026-10-24, 01:59 UTC)

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

The 02:01 UTC aggregate still has 3,493 QRZ ambiguous and 340 pending rows;
LoTW has 380 adopted, 2,957 ambiguous, 161 mismatched and 335 pending rows.
Destination counts overlap. The first new run completed at 02:02:16 UTC after
43 contact turns and 35 destination classifications. It reached its deadline,
with two affected LoTW read errors and 39 budget deferrals across both vendors.
At 02:03:58 one QRZ covering plan was complete: 98 validated surrounding records
and zero target records after matching base/verification reads. QRZ then had
3,474 ambiguous and 359 pending rows; this movement is reclassification, not
delivery. Attempts, cutovers and transient guards remained zero. Other gaps and
sustained throughput still need observation.

The later 02:52:53 UTC aggregate has 35 complete and five pending QRZ history
partitions and the same single complete covering plan (98 surrounding records,
zero target records). QRZ ledger states are 3,438 ambiguous and 395 pending;
attempts, cutovers and temporary guards remain zero. These are read-only
classification counts, not delivery evidence.

The separately protected source audit completed both 4,500-record inventories
at 02:41:09 UTC, matching each other and Ferry exactly. A separate 02:42:27
all-client forward probe matched 20 known targets twice. These observations
performed no source mutation or production cursor write and do not establish
continuous coverage, purge exclusion or write authority. The versioned reader
and guards were signed through `339590e08e229b411f411d3878e921d4a02265df`.
The [first release CI run](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40055506398)
was cancelled after a delivery test fixture leaked `workerd`. Fixture fixes are
signed and pushed as `ce238cdcfea72ed5cbc7b624ec6a7efc01978154`, and
[replacement CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40057488314)
passed before the later 03:28 baseline deployment documented above. Fresh-positive
enforcement remains separate work outside that release.
The refreshed 02:48:09 protected database backup passed isolated restore with all
23 current migrations and both pending migrations `0025`/`0026`, integrity and
foreign-key checks, all three current credential decryptions and repeated quarantine.
It retained 380 identity claims and zero attempts or cutovers. No live
restore or real logbook write occurred. See [source evidence](evidence-lofi.md#all-client-inventory-audit-and-remaining-read-policy-work-2026-10-24-utc)
and [rollout prerequisites](rollout-checklist.md).

## Source and QRZ evidence tooling (2026-10-24, 01:06 UTC)

Signed source `4fefd2ae3941f68cd07af22743df478a95976a5c` deployed with all five
export gates closed. All 829 tests and required checks passed in release CI;
focused local tests and static/build checks passed. The guarded deployment found
no migration to apply. Independent checks at 01:07:32 UTC confirmed the exact
Worker at 100% traffic, healthy service and matching assets. The 01:07:37 UTC
database audit confirmed all twenty-three migrations, 380 LoTW ownership claims,
zero uncovered mappings, and zero attempts, cutovers, legacy holds or temporary
guards. No source mutation or vendor write was performed by these diagnostics.

The release adds bounded QRZ covering reads, fixes neighborhood date bounds at
both UTC-midnight edges, extends source replay comparison to retained suspects
and fresh base operations, and adds a known-positive forward replay probe.
Ordinary web-deletion regressions preserve cancellation and durable ownership
fences. The forward probe still needs independently verified last-writer evidence
before live execution; automatic QRZ covering fallback is not integrated.

Fresh LoFi observations confirmed all thirteen additional Ferry contacts on the
server. A separate four-read sample matched all 23 members and Ferry's exact
base-body revision and server timestamp; HaLo differed only in its local server
timestamp. These observations do not establish global source completeness,
forward delivery or historical deletion retention. See the [source packet](evidence-lofi.md#current-server-positives-and-base-operation-checks-2026-10-24-utc)
and [QRZ packet](evidence-qrz.md#bounded-covering-reads-2026-10-24-utc).

At 01:09:35 UTC a protected QRZ probe completed a fresh 35-day cover in two pages:
467 records, zero in its seven-day pending target, stable book/credential/scope
checks and three vendor reads including STATUS. It changed no ledger, cache or
cursor state. This demonstrates one successful gap observation; automatic history
fallback, other gaps and fresh pre-write coverage still need work.

At 01:07 UTC, QRZ retained 3,493 ambiguous and 340 inventory-pending rows. LoTW
retained 380 adopted, 2,957 ambiguous, 161 mismatched and 335 inventory-pending
rows. Destination counts overlap and cannot be summed into unique contacts.
The 01:05 invocation started before deployment and is not evidence for the new
Worker. The older 00:40 invocation still lacks a completion record; its default
zero counters are not measured work. Later completed runs establish continued
processing. This telemetry row does not own a source lease; retained provider
logs are the follow-up for its unknown outcome. Bundle size is 1,805.84 KiB raw / 349.52 KiB gzip, with 31 ms reported
startup; these do not establish production signing cost or sustained capacity.

## QRZ retry and readiness evidence (2026-10-24, 00:00 UTC)

Signed source `32e25b0ebc4d2ef5716bc3e60e166561a5b0931a` deployed at 00:00 UTC
with all gates closed. All **675 tests** and required checks passed locally and
in [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40041632962).
The guarded deployment required no migration. Independent checks at 00:01:17 UTC
confirmed the exact Worker at 100% traffic, healthy service, matching assets and
all twenty-three migrations through `0024`. There were 380 LoTW identity claims,
zero uncovered mappings, and zero attempts, cutovers, legacy holds or temporary
guards. Secrets were preserved; no source mutation or vendor write occurred.

The runtime now identifies the exact ambiguous-empty QRZ response and stores a
fifteen-minute partition retry delay without advancing coverage. Bounded read-only
diagnostic, independent source replay and exact-contact trial audit tools were
also added. The [source evidence](evidence-lofi.md#observed-local-and-live-comparisons)
records the independent membership comparison, thirteen unexplained additional
Ferry contacts, ordinary tombstone replay and a separate event replay sample.
The sampled trial contact remains first-insert-ineligible on both routes.
Per-contact 4/6/8-character grids remain unchanged by the audits.

The 00:00:43 scheduled invocation began before this deployment; its results
belong to the previous Worker and do not verify the new retry behavior.
The first new run, 00:05:43.050–00:07:13.538 UTC, processed 265 contact turns and
244 destination classifications, with zero adoptions, 21 affected-route errors
and no deferrals. Its four diagnostic events were all
`qrz_ambiguous_empty_selection`; these counters are not physical request counts.
At 00:06:18.955 UTC, four pending QRZ partitions had retry holds, with zero
invalid-complete or excessive holds. The settled 00:07:15.222 UTC audit retained
380 LoTW claims and zero attempts, cutovers, uncovered mappings, legacy holds
or temporary guards. The run reached its deadline in 90.488 seconds, including
89.336 seconds of D1 wall time. These observations verify deployed retry behavior,
not completed reconciliation or sustained throughput.
Bundle size is 1,800.85 KiB raw / 348.25 KiB gzip with 29 ms reported startup;
these are not signing CPU, peak memory or sustained-capacity measurements.

## Identity ownership across deployments (2026-10-23)

Signed revision `a8b592bead90a22e4e7fe36f005e390727002df9` deployed at 22:42 UTC with all
export gates closed. All **606 tests**, formatting, lint, both TypeScript checks
and the Worker build pass locally; [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40034841991) also passed.
Migration `0024` backfills the observed overlap gap and reserves later mapping
writes at the database boundary, even when an older Worker finishes after deploy.
QRZ historical adoption clears only its exact proof-bound reservation; an exact
completed receipt must also link to its immutable identity claim to bypass a hold.
New tests cover old-style inserts/updates, collision rollback, repeated adoption,
linked/unlinked receipts and the real delivered/observed resolution order.

The guarded task applied only `0024`. Independent checks at 22:43:14.131 UTC
confirmed twenty-three migrations and 370 LoTW claims, with zero unclaimed LoTW
mappings or unreserved QRZ mappings. Attempts, cutovers, legacy holds and temporary
guards remain zero. At 22:43:14.299 UTC, live version/HTTPS checks confirmed 100%
traffic, every gate closed, healthy service and matching assets. Bundle size is
1,798.63 KiB raw / 347.74 KiB gzip, with 23 ms reported startup. These are release
measurements, not signing CPU, memory, sustained throughput or cost acceptance.

The first new scheduled run completed at 22:46:04.921 UTC after 21.966 seconds,
processing 204 contact turns and 186 classifications, including eight adoptions.
It stopped at the database budget with 70 QRZ rejected-read affected routes and
four vendor-budget-deferred routes. The run used 856 RPCs / 5,058 statements,
with 21.372 seconds of database wall time. No identity-backfill error occurred.
This single mixed-work sample does not establish sustained throughput or completed
reconciliation. At 22:47:21.247 UTC, 378 LoTW claims covered every mapping; the
uncovered-mapping counts, attempts, cutovers, legacy holds and temporary guards
were all zero after scheduled work settled.

## Export readiness safeguards (2026-10-23)

The 22:26 UTC release deploys signed source `1182c47ac50f58b562185f12f419813114706163` with
all vendor export gates closed. It adds permanent QRZ/LoTW identity ownership,
immutable attempt links, whole-second outbound projection under those guards,
lossless eight-character LoTW grids, bounded legacy QRZ binding and a source audit.
All **598 tests**, formatting, lint, both TypeScript checks and the Worker build
pass locally; [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40033047750) also passed.

The guarded task applied only migration `0023`. At 22:26:16.838 UTC, D1 retained
355 LoTW ownership claims with zero unclaimed LoTW mappings or unreserved QRZ
mappings. There were zero attempts, cutovers, legacy QRZ/outbound holds or temporary
stage/adoption/inventory guards. Independent version/health checks at 22:26:17.102
UTC confirmed 100% traffic, all five closed gates, healthy service and matching
root/dashboard/admin assets. No application secrets were replaced. The deployed
bundle is 1,797.75 KiB raw / 347.60 KiB gzip with 33 ms reported startup; these
figures do not measure deployed signing CPU, peak memory or operating cost.

A second check at 22:27:35.373 UTC found three LoTW mappings without new claims.
The scheduler run begun at 22:25:42.778 UTC under the previous Worker finished at
22:27:13.575 UTC, after migration `0023` had copied existing mappings. Exports
stayed disabled and attempts stayed zero. This deployment-overlap observation
led to migration `0024`, which reserves legacy mapping changes as they occur
and repairs the initial gap. Initial migration verification alone is
not sufficient evidence that older in-flight work has settled.

Both destination rescans completed by the 22:19 UTC source audit. Local birth and
payload coverage is consistent, with two deleted-operation dependency holds.
Exhaustive replay/deletion/retention semantics remain unproved. Backup access,
exact-contact review and explicit vendor-write authorization are also outstanding;
see the [personal rollout checklist](rollout-checklist.md). No first write occurred.

## Reproduce deployment

```sh
mise run check
mise run deploy-readonly
```

The deploy task builds the dashboard, refuses any open export gate, validates the permanent origin and D1 configuration, applies pending migrations to the dedicated production database, then deploys. It preserves provisioned secrets. Staging is intentionally a placeholder and remains undeployed.

Independent `KEK_V1`, `AUTH_SECRET` and `EMAIL_CODE_SECRET` are installed as Worker secrets. A protected local backup is at `~/.config/lofi-qso-ferry/production.secrets.json`, file mode 0600 in a 0700 directory outside Git. Preserve it until archived in the operator's secret manager; 1Password CLI was signed out during deployment. Do not print it, commit it, reuse local development secrets or rotate the KEK without preserving encrypted-data access. See [operations](operations.md) for rotation and restore quarantine.

## Owner's next step

The owner has enrolled and connected LoFi, QRZ and LoTW. Keep exports disabled while QRZ absence evidence, source replay/retention evidence and an eligible exact-contact trial are reviewed. Actionable operation rereads and destination rescans are complete; the two contacts tied to deleted operations remain held. Follow the [roadmap](../ROADMAP.md).

Existing users sign in with their passkey. To enroll someone new, run `mise run invite -- person@example.com`; they follow `/join`, confirm the exact invited address and create a passkey. An independent backup passkey is recommended; manual operator recovery is available for the owner pilot. Connect only the services you use. Settings and account-default templates need no connections. LoTW connection import requires the personal P12 and its export password, if set. Ferry checks the certificate/private key, dates, serial status and optional website login, then leaves certificate-authority validation to LoTW during upload processing. See [certificate checks](lotw-certificates.md); there is no root configuration or updater. Keep all vendor exports disabled throughout this review; deployment authorization does not grant live-write authorization.

## Connection passkey freshness fix

Deployed `cbe9e63af1bf` after a stale signed-in session exposed a missing passkey prompt on LoFi approval. Protected buttons now verify freshness automatically; cancellation retains form data and sends no connection request. Typed precondition errors permit one bounded retry, while vendor, CSRF/origin and ambiguous failures do not. Account/CSRF snapshots stay pinned during another-tab refreshes.

All 180 local tests and deployed-code CI pass. Actual local Worker/Chromium checks use real virtual-passkey signatures and contained LoFi fixtures, including stale/fresh/canceled requests and native click activation. Production serves the new client, rejects a bad-origin auth request with its explicit code, and independently reads back all export gates closed. There were no pending migrations, secret changes or real vendor requests. The owner's actual passkey and LoFi email approval remain for them to complete after refreshing Ferry.

## Retained-source review follow-up

Deployed signed revision `1b7e2d4b2b08` as Worker `14faa523-c4a8-4b77-b92b-1fe8a378cf32`, applying only migration0008. The owner has completed LoFi linking; its display name comes from the vendor account name. New links now permit one current connection per optional service, including guarded concurrent saves, same-identity renewal and conservative pause/resume. Existing history is preserved.

The dashboard top counts now describe source ingestion, with destination activity separately below. Read-only review exposes scan/context progress, retained contact samples and effective station/location/reference/current-comment predictions. Complete context is required for a preview; existing pinned and adopted narrative policies are explicit. Review never calls vendors, changes a database row, prepares an attempt or signs a payload. Refresh review preserves unsaved forms.

All 196 tests plus strict lint/format/types/build pass. Actual isolated Worker/D1/Chromium resident/UV-passkey signup/link/pause/resume verifies the expected saved COMMENT prediction, duplicate409 before a second approval request, zero attempts/outbox, retained unsaved edits and 375px without overflow or console errors. Independent review fixed a stale diagnostic race using exact lease fencing. Deleted operations are skipped and failed/partial operation reads yield fairly. These fixture results do not prove live replay guarantees or vendor writes.

Live HTTPS serves the new review HTML and separate delivery metrics; unauthenticated review returns401/no-store. Cloudflare settings independently confirm all export gates closed, exact RP/origin, dedicated D1 and disabled alternate origins. Seven migrations are applied. Aggregate metadata at verification shows one active LoFi, 492 contacts, 176 live operations and initial backfill generation 5; the scan is still in progress. With no destination connected there are zero ledger rows and attempts, and no connection-guard residue. Operator verification read aggregate metadata only; it did not inspect source contents or credentials or edit real log entries. The first-page counts recorded earlier are historical; dashboard counts advance with cron.

## Vendor budgets and live-priority deployment

Deployed signed main revision `8c3f66cd81e39e174cf6e214ce93c965351b3342` as Worker `c2d31e84-8af7-484e-88f1-f1c41ba46885`. The guarded task verified all export gates closed, confirmed migrations 0009 and 0010 were already applied, and deployed the five-minute production schedule. The dedicated database now has all nine migrations. No application secrets were changed.

Persistent per-vendor request budgets and `Retry-After` cooldowns cover hosted reads and uploads. New contacts and corrections receive live priority; initial history uses smaller page/contact/attempt budgets, a bounded prepared outbox and independent repair scans for expired retained inputs. Initial source-context and cutover requirements remain enforced. The deployment also includes the separate LoTW password help and scrubbed certificate-versus-login errors.

The active deployment reports 100% on this Worker version. Public HTTPS checks returned health `status=ok` with exports disabled. Root HTML, dashboard JavaScript and CSS matched the locally built SHA-256 hashes, including the latest LoTW import-password help. Unauthenticated review returned `401` with `Cache-Control: no-store`, the session reported unauthenticated/invite-only, and production local-mailbox returned `404`. Version metadata independently confirmed every closed export gate, exact origin/RP, dedicated D1 and native sender allowlist. Verification read only public endpoints and deployment/schema metadata; it did not request vendor uploads or account messages.

The full isolated check passed all 232 tests, lint, formatting, types and Worker build. The deployed artifact is 1,587.34 KiB raw / 301.72 KiB gzip with reported startup 29 ms; these figures are not billed CPU or peak-memory measurements.

## Time-budgeted drain deployment

Verified 2026-10-23 UTC. The guarded read-only task deployed clean signed main revision `8066d25050462eaf001f0a25944d2225beebf791` as Worker `46c8523e-9e5d-42e3-a330-0073f5be4ceb`. The deployment includes scheduler commit `c353183` and intake commit `aa928cd`. There were no pending migrations. Deployment output confirmed the custom domain `ferry.n1rwj.com` and cron `*/5 * * * *`; independent deployment-status JSON reports this version receiving 100% of traffic.

The scheduler drains repeated fair rounds within a 90-second soft deadline instead of stopping after one fixed batch. Each selected source gets one contact turn per traffic class per round, with live polling and contacts before live delivery and saved historical attempts before further history inventory. Persistent vendor request caps, cooldowns, source-context requirements and export gates remain in force. Aggregate `ferry_tick` logs now include `rounds`, `elapsedMs` and `stopReason`. These counters support later throughput measurement; this deployment verification did not measure representative deployed capacity or billed CPU.

Version JSON independently confirmed all five closed export gates, exact production origin/RP, dedicated D1 `45ad64ad-92bb-491a-b6e6-1d2b17450144`, and the native `EMAIL` sender restriction to `signup@ferry.n1rwj.com`. Public health returned HTTP 200 with `{"status":"ok","exportsEnabled":false}`. Unauthenticated `/api/review` returned 401 with `Cache-Control: no-store`; `/api/auth/session` reported unauthenticated state with `signupAllowed=false`; `/api/auth/local-mailbox` returned 404. The SHA-256 hashes for `/`, `/app.js` and `/style.css` each matched the locally built files. Verification directly invoked no vendor uploads or account messages.

All 292 tests, formatting, lint, types and Worker build passed before the focused commits. The uploaded artifact is 1,605.00 KiB raw / 305.51 KiB gzip. This deployment reported no startup measurement; the earlier 29 ms result belongs to the previous version.

## Historical managed LoTW trust deployment

Deployed signed main revision `8f371eb5deaa2c28eee77249b49f2adc3b3860a8`
as Worker `521a1920-fc03-49d2-aa4e-24a0b9287ab5`. The guarded deployment applied
migrations 0011 and 0012 from the already landed admin work, then deployed the
latest tested main tree. All eleven migrations are applied. Every export gate
remains closed, and the trust setting is `LOTW_TRUST_ROOTS_JSON=bundled`.

The [former trust bundle](lotw-certificates.md) includes the current ARRL root obtained
independently from ARRL's authenticated HTTPS certificate download. The actual
imported certificate chain verified against that root in memory. No private key,
website password or user certificate was saved as release data. Existing
credentials were neither rotated nor reimported.

The first deployed scheduled refresh at `2026-10-23T04:45:43.159Z` automatically
changed the saved LoTW connection from unverified to active, with issuer trust
verified and ARRL status unrevoked. Its scheduler turn completed with zero errors.
Live health returns `status=ok` and `exportsEnabled=false`; deployment metadata
confirms the exact version receives 100% of traffic and every write gate remains
closed. The full release check passed all 333 tests, formatting, lint, types and
build, including trust withdrawal between preparation and dispatch. No real
logbook entry was uploaded or changed.

[GitHub CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39901830697)
passed for this deployed revision.

## Historical automatic LoTW trust discovery deployment

Deployed signed main revision `a20660b41f9aea4adb20798820ea1e2638705020`
as Worker `5b6e738c-dfb6-42f3-bc7c-f825712e2338`, receiving 100% of traffic.
Migration 0013 adds the shared public-root cache; all twelve migrations are
applied. No application secrets changed, and every export gate remains closed.

At `2026-10-23T12:31:11.057Z`, the live scheduler fetched and cached one current
root from ARRL's fixed HTTPS certificate download. Its next normal attempt is
24 hours later. The saved LoTW connection remains active, trusted and unrevoked;
no certificate reimport or private-key rewrite was needed. Failed refreshes
retain known anchors, and uploaded certificate chains cannot establish trust.
An unfamiliar issuer can request an earlier refresh subject to shared cooldowns.
See [current certificate checks](lotw-certificates.md) for source provenance and explicit overrides.

The full release check passed all 358 tests, formatting, lint, types and Worker
build. [GitHub CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39953556943)
passed for the deployed revision. Public health returns `status=ok` with exports
disabled, and deployment metadata independently confirms every write gate is
closed. Verification performed authenticated certificate reads only; no real
logbook entry was uploaded or changed.

## LoTW preflight simplification deployment

Deployed signed main revision `de6259ee8bc7b69e66b983926659e2bd154c1995`
as Worker `e712842f-71c4-4ec6-b807-69ab9fb1d112` at
`2026-10-23T13:00:26.989Z`, receiving 100% of traffic. Migration 0014 removes only
the obsolete public-root cache; all thirteen migrations are applied. Production
schema inspection confirms the cache is absent, and version metadata confirms
there is no root-policy binding. No application secrets changed.

Ferry now follows the direct-signing model described in
[certificate and login checks](lotw-certificates.md). Local checks retain P12
integrity, matching keys, certificate/QSO dates, station constraints, fresh ARRL
serial status and separate website-login verification. LoTW determines certificate
authority and signed-upload acceptance. The earlier trust-deployment sections are
historical evidence for functionality that has now been removed.

The saved LoTW connection remains active with unrevoked serial status. Existing
encrypted credentials need no reimport; regression tests prove legacy local trust
flags are ignored and maintenance leaves encrypted keys and versions unchanged.
The full release check passed 328 tests, formatting, lint, both typechecks and the
Worker build. Independent review found no blocking issues.

Public health reports `status=ok` with exports disabled. Deployed HTML and client
JavaScript exactly match the release files; unauthenticated review remains 401
with no-store and the production local mailbox remains absent. Deployment metadata
independently confirms every export gate is closed. Verification submitted no
contacts and changed no real logbook entries.

## Classified admin workload deployment

Deployed signed main revision `9eef564af80d449a99227ae1099bd11fc8bff64a`
as Worker `ca6bc362-f675-4b96-9831-8c466391aa49` at
`2026-10-23T13:39:13.890Z`, receiving 100% of traffic. The guarded deployment
applied migration `0015_admin_workload.sql` before deploying; all fourteen
migrations are applied. Its six nullable scheduler columns preserve missing
historical breakdowns as unknown, and its indexes support workload and delivery
summaries. No application secrets changed.

The admin console now distinguishes ready processing, known holds, invalid
source records, and expired inputs. It shows sanitized reasons, hourly backlog
trends with coverage and gaps, and completed destination-contact versions derived
from durable attempt events. Repeated processing, LoTW submission acknowledgements,
and adopted existing history do not inflate delivery throughput. See the
[workload investigation](admin-workload-investigation.md) and
[metric definitions](admin.md).

Live `/admin`, `/admin.js`, `/admin.css`, and `/app.js` exactly match the release
files. Health reports `status=ok` with exports disabled. Unauthenticated admin
overview and invitation requests return 401 with no-store, the session remains
invite-only, and the production local mailbox returns 404. Independent version
metadata confirms all export gates closed, the existing origin/RP, and the
dedicated production D1. New classified samples accumulate on normal scheduled
runs; the pre-deployment history cannot supply their breakdown.

All 344 tests, formatting, lint, both typechecks, and the Worker build passed.
[GitHub CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39961544700)
passed for the deployed revision. Desktop and mobile layouts were verified
with synthetic data before release. The uploaded artifact is 1,648.91 KiB raw /
316.66 KiB gzip with reported startup 47 ms, not a measurement of billed CPU.
Verification performed no invitation sends or real logbook uploads.

## Reconciliation backlog repair deployment

Deployed signed main revision `1679f749aa7f13f76219375386867005afcf507b`
as Worker `1eaf7657-686a-471c-9f8b-0760f7b624f1`, created
`2026-10-23T13:40:34.062Z`. The release includes the linked-account email and
actionable admin workload changes already landed on main. The guarded deployment
found no pending migrations; an independent D1 query confirms all fourteen are
applied, including 0015. No application secrets or export settings changed.

All twelve sampled generic readback failures contained nonzero source
milliseconds. Source projection succeeded, but the strict outbound ADIF converter
rejected them before vendor access. Read-only reconciliation now uses the
PoLo/HaLo whole-second projection while preserving source precision. A bounded
live diagnostic successfully read both vendors and returned conservative QRZ
ambiguity and LoTW mismatch outcomes; it made no vendor mutations. Fractional
exports remained blocked until the later durable outbound identity-claim release.

Renewed LoFi session tokens are now retained with credential/identity race
guards. This was a confirmed implementation defect; its contribution to live
backlog delays was not measured. Closed export gates no longer replace history
review reasons, and fixed error categories distinguish source conversion, saved
credentials and destination readback failures without retaining private errors.
Competing history claims quarantine untransmitted adoptions and their contender;
identity reservations and trusted or dispatched evidence are preserved.

The full integration check and added admin regression passed locally.
[GitHub CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39963134190)
passed all 371 tests, formatting, lint, both TypeScript checks and build for
the deployed revision. Identity review holds remain visible after route/state
changes and under open synthetic gates.

Independent deployed-version metadata confirms every export gate remains closed.
Public health reports `status=ok` and `exportsEnabled=false`; deployed app and
admin JavaScript exactly match the release files. At 13:41:45 UTC, production
still contained zero delivery attempts and zero cutovers. Its first observed run at 13:42:35 UTC completed with zero errors but
zero contact turns; the scheduling follow-up below addresses that remaining
bottleneck.

## Reconciliation scheduling follow-up

Deployed signed main revision `634517d0de72002c585da4815bf728ccbd182b13`
as Worker `bb37da72-5aad-42a5-a5b7-29503787b0c8`, created
`2026-10-23T13:59:38.831Z`. Every independently read-back export gate remains
closed, health reports exports disabled, and all fourteen migrations remain
applied. The release did not change secrets or vendor request budgets.

The 13:42:35 UTC run took 130,398 ms, completed two rounds, and hit its soft
deadline without reconciling a contact. Cursor timestamps show normal sync at
13:42:40, historical rescans at 13:42:48 and 13:43:42, and an operation reread
at 13:43:17. The contact selected at 13:43:31 lacked operation context even
though the workload sample contained 1,465 ready contacts. These timestamps
locate wasted scheduling opportunities without attributing all elapsed time to
network I/O; end-of-run cleanup also contributes to the duration.

A bounded read-only production comparison found available operation-base
context for two of the first ten oldest contacts, versus ten of ten when
prioritizing available context. The query wrote zero rows. Selection now prefers
retained contacts with available context within each traffic class, while the
full payload/event/generation checks remain mandatory. A ready background
contact gets its turn after canonical polling and before additional historical
rescan/reread work. When none is ready, the scheduler retries after the context
read, preserving same-run recovery. Live context ordering is unchanged.

The full local check passed 377 tests, formatting, lint, both TypeScript checks
and build. New tests prove slow historical reads cannot prevent an already
ready contact from reconciling first, and known context holds remain available
for later recovery without bypassing validation. Independent review found no
blocking issues. [GitHub CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39965786804)
passed for this exact deployed revision. Deployment metadata confirms it receives
100% of traffic.

At 14:04:02 UTC, the run that started at 14:00:46 had completed in 132,058 ms
with one source page, one contact turn, zero errors and zero deferrals. Both
vendor reads completed: QRZ retained a precise ambiguous-identity reason, and
LoTW retained an operating-grid mismatch. No contact was guessed to match or
made eligible for export. The overlapping run at 14:00:55 completed without
source/contact work; lease fencing prevented it from duplicating the active turn.

The completed working run sampled 1,509 contacts ready for further processing,
2,624 held and one invalid source contact, compared with 1,486/2,647/1 before the
follow-up. Operation context progressed to 129 complete and 47 pending operations.
These changes demonstrate processing, not complete recovery or a sustainable
throughput measurement. Total retained source contacts remained 4,134: 3,097
pending, 761 blocked on context, one callsign validation failure, 270 waiting,
and five routing holds. The old generic readback reason still appeared on 264
ledger rows at each destination until those rows are revisited; one newer QRZ
retry failure also remained. Review exceptions and sustained catch-up are still
required before enabling exports.

Production still had zero attempts and zero cutovers, every export gate stayed
closed, and all verification queries wrote zero rows. No real QSO was signed,
inserted, replaced, deleted or uploaded.

## Reconciliation investigation release (2026-10-23)

Deployed signed revision `cf34ac0a82e4f3f845b058684a04128f91c0b147` as Worker
`40a3c20e-81f8-45a7-9350-2e99767c241c`, created at `2026-10-23T15:04:09.293Z`.
Deployment `4e6b6270-2424-4a2d-b642-fecae559a7a2` assigns it 100% of traffic.
The [CI run](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39974178346) passed all 392 tests and required checks.
Local full validation passed 391 tests before a final diagnostic refinement;
all 35 focused QRZ/reconciliation tests and TypeScript/lint then passed.

This release contains the narrow canonical general-log station fix and migration
`32758f5`, precision-specific review reasons `789d652`, cleanup optimization
`fa822ba`, and the capacity investigation/roadmap `cf34ac0`. Independent review
checked migration/deletion scope and caught an unrelated-neighbor diagnostic
case, fixed before release. Existing history is still held where precision or
coverage is insufficient; no comparison or outbound identity guard was relaxed.

`mise run deploy-readonly` applied migration 0016 and deployed the Worker without
changing secrets. Preflight SELECT found exactly one eligible source hold; the
15:04:50 UTC readback confirms fifteen migrations, that input pending with no
old callsign reason, and zero export attempts. Version readback confirms all
five gates closed, with healthy `/health` and `exportsEnabled=false`. Bundle
size is 1,659.23 KiB raw / 318.87 KiB gzip; reported startup is 32 ms.

The [investigation](reconciliation-investigation.md) records local cleanup and
4,000/200,000-contact scale measurements, request-budget floors, source/context
amplification and remaining batching/inventory work. These are not production
throughput or completed reconciliation claims. No real QSO was signed,
inserted, replaced, deleted or uploaded.

At 15:08:05 UTC, the first completed post-release run (started 15:05:50) took
96,730 ms, with two contact turns, one canonical source page, zero errors and
zero deferrals. The immediately preceding run took 132,572 ms for two turns.
This one-run comparison is consistent with less cleanup overhead; contact
throughput remains two turns per run and sustained draining is not established.
Classified work was 1,820 ready, 2,314 held and zero blocked. The cleared callsign
hold was requeued, not independently proven reconciled. New precision-specific
reasons were stored for one QRZ and two LoTW rows, all still review holds.
Export attempts and source cutovers both remained zero.

## Reconciliation throughput and test-operation release (2026-10-23)

Deployed signed source revision `bbc2346c0e4da2754a7a1971697ce5d7eccf7a13`,
including test-operation commit `0000073e7bd6a79f873c6609fba500739179f1de`, as
Worker `c592733f-171f-406e-bb8d-827b7ffd7fd9`. The Worker was created at
`2026-10-23T16:12:02.575537Z`; deployment
`45d4360c-cd35-414d-9dc7-32ce92ab9420` at `2026-10-23T16:12:03.659075Z`
assigns it 100% of traffic. The
[release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39983716440)
passed all 452 tests and required checks. Local validation also passed 452 tests
and the focused final event-race checks.

The combined release adds batched source/context access, indexed durable
reconciliation scheduling, quiet retries for stable review holds, shared
positive history inventory and aggregate scheduler throughput telemetry. It
also includes test-operation review and export guards. Background contact
batches are 20, live processing remains one contact at a time, and the scheduler
yields at its 90-second or 850-D1-RPC soft budget. Vendor allowances and every
export gate remain unchanged. Local performance evidence and remaining source
capacity work are recorded in the [investigation](reconciliation-investigation.md).

The guarded deployment applied migrations 0017–0020. Independent D1 readback
at `2026-10-23T16:12:41.646Z` confirmed all 19 migrations, zero attempts, zero
source cutovers and zero guard residue. No application secrets changed.
Deployed-version readback independently confirmed all five export gates closed.
Health returned `status=ok` and `exportsEnabled=false`; SHA-256 hashes for `/`,
`/app.js` and `/admin.js` matched the local build. The uploaded bundle is
1,715.07 KiB raw / 331.10 KiB gzip, with reported startup of 34 ms.

Sustained production throughput remains unmeasured for this release. A scheduler
run that started before the 16:12:03 UTC deployment belongs to the previous
version even if it finishes afterward; its duration and missing new telemetry
must not be treated as results from this implementation. Observe newly started
runs and multiple windows before claiming a drain rate, complete reconciliation
or 200,000-contact capacity. Deployment and local checks do not authorize
exports or resolve precision/routing exceptions.

## Reconciliation round-trip and QRZ catch-up follow-up (2026-10-23)

Deployed signed source revision `471e8620e227c35adf2cb5c91a31765fdc7fa04a` as
Worker `5d667922-2d09-4020-8fbd-46594a537750`, created at
`2026-10-23T16:37:08.807799Z`. Deployment
`18c2ecd3-a9ef-4c6e-8b28-1712c65d41fa` at `2026-10-23T16:37:10.435132Z`
assigns it 100% of traffic. Full local validation passed 465 tests and all
required checks. [Release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39988135604)
passed all 465 tests and required checks.

A rejected QRZ modification catch-up no longer leaves a repeatedly failing
partial inventory. The worker atomically discards its partial pages, index and
ciphertext, then requires a fresh, fully verified date-range scan with valid
response framing. The fallback supplies positive evidence only; rejected or
incomplete responses never establish absence. Metadata reads in intake,
reconciliation and inventory are combined into fewer D1 round trips while
retaining the source, credential, generation, lease and commit-time evidence
guards.

Read-only background reconciliation can process up to four contacts concurrently,
with work for the same destination/week serialized to share partition progress.
Live processing and every batch with exports effectively enabled remain
sequential. The scheduler waits for all started tasks to settle before releasing
its source lease, including on a task failure. The existing vendor budgets,
90-second/850-D1-RPC soft thresholds and closed export gates are unchanged.

Telemetry now distinguishes `database.wallMs`, the union of time with at least
one D1 RPC in flight, from `database.durationMs`, the sum of RPC durations.
Concurrent stage durations are also cumulative and may exceed elapsed wall time;
do not add overlapping durations to infer invocation time or billed CPU.

The first deployment attempt stopped at the preflight API error `7403` before
changing the Worker. Read-only identity and migration checks then succeeded,
and a retry of the guarded deployment completed. No new migrations were
required. Independent readback at `2026-10-23T16:37:39.690Z` confirmed all 19
migrations, zero attempts, zero cutovers and zero guard residue. Secrets were
preserved. Deployed-version settings confirm every export gate closed; health
returns `status=ok` and `exportsEnabled=false`. The `/`, `/app.js` and
`/admin.js` hashes match the local build. The bundle is 1,718.88 KiB raw /
331.87 KiB gzip, with reported startup of 35 ms.

The first follow-up run, 16:40:49–16:42:24 UTC, processed 20 contacts and made 29 destination classifications in 95.3 seconds, with three errors and eight deferrals. It recorded 25 inventory fetches, 14 cache hits and 92.9 seconds of D1 wall time across 667 RPCs / 1,171 statements. No historical rescan or operation reread page advanced, exposing background scheduling starvation. At 16:43 UTC, six QRZ and seventeen LoTW partitions were complete; attempts, cutovers and temporary guard rows remained zero. Sustained capacity and source freshness remain unverified. Runs started
before the 16:37:10 UTC deployment remain evidence for their earlier version,
even if they finish afterward. Observe new runs and multiple windows before
claiming sustained throughput, backlog completion or 200,000-contact capacity.
No export gate was opened by this release.

## Background lane fairness follow-up (2026-10-23)

Deployed signed source revision `cb9ea362e2a03e29b7d53793bae95276de7d7341` as
Worker `aea20af6-c08d-4718-bc41-2e450d8cc2e4`, created at
`2026-10-23T16:53:26.165896Z`. Deployment
`383eb991-f7ff-4dc7-97cd-f8834332f431` at `2026-10-23T16:53:28.594528Z`
assigns it 100% of traffic. Full local validation passed 467 tests and all
required checks. [Initial release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39990488592)
failed only formatting after a documentation edit. Signed documentation revision
`7252cad4` corrects that formatting with code identical to the deployed revision;
its [CI rerun](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39991118470)
passed all 467 tests and required checks.

The scheduler now rotates which background lane runs first after canonical
polling: retained contacts, historical rescan or context reread. The isolated
`scheduler:background` cursor advances before executing the lane under the exact
active source-cycle lease. A slow or failed lane therefore cannot repeatedly
keep the other lanes behind it. Live context and contact processing keep their
existing priority. The rotation cursor is scheduling metadata, not source
coverage or cutover evidence. No schema, vendor allowance, batch size or
90-second/850-D1-RPC soft budget changed.

Independent D1 readback at `2026-10-23T16:53:42.060Z` confirmed all 19
migrations, zero attempts, zero cutovers and zero guard residue. No migration
was required and secrets were preserved. At `2026-10-23T16:53:56.840Z`,
deployed-version settings independently confirmed every export gate closed,
health returned `status=ok` and `exportsEnabled=false`, and the `/`, `/app.js`
and `/admin.js` hashes matched the local build. The bundle is 1,720.10 KiB raw /
332.17 KiB gzip, with reported startup of 32 ms.

The first fairness run, `16:55:48.291–16:57:28.171 UTC`, processed 23 contact
turns and made 31 destination classifications in 99.880 seconds. It processed
55 source records and advanced two historical rescan pages and two context
reread pages, with six errors and five deferrals. History recorded 14 fetches
and 22 cache hits. D1 recorded 662 RPCs / 1,495 statements, 203.490 seconds of
cumulative duration and 93.964 seconds of wall time; overlapping work explains
why cumulative duration exceeds elapsed time.

The `16:57:52.155 UTC` snapshot showed rotation generation 2 after two
background rounds, 125 destination checks covering 87 distinct contacts, and
12 completed QRZ plus 21 completed LoTW partitions. Attempts, cutovers and
temporary guard rows remained zero. This first run demonstrates resumed rescan
and context progress alongside reconciliation; it does not establish a sustained
completion rate across larger accounts.

The second fairness run, `17:01:30.009–17:03:19.475 UTC`, advanced rotation
generation 3 and one context reread page before processing 15 contacts. It made
17 destination classifications, including one adoption, with four errors and
zero deferrals. No rescan page advanced; the context page returned zero source
records. D1 wall time was 96.214 seconds across 337 RPCs / 751 statements in
109.466 seconds elapsed. At `17:03:59.338 UTC`, 142 remembered checks covered
97 contacts, fifteen QRZ and twenty-three LoTW partitions were complete, and
attempts/cutovers/guard residue remained zero. All three first positions have
now been exercised across the two runs. The observed 15–23 contact turns remain
insufficient evidence for complete reconciliation or the larger capacity goals.

The preceding 16:50 UTC run used revision `471e862` and processed 15 contacts
with 17 classifications in 117.6 seconds, with ten errors, no deferrals and no
context or rescan progress. Across three observed runs of that earlier release,
15–21 contact turns per invocation did not establish a sustained completion
rate. Runs started before this deployment remain evidence for the earlier
version even if they finish afterward. Exports remain disabled; neither release
validation nor scheduling fairness completes exception review or establishes
200,000-contact capacity.

## Guarded reconciliation cohorts (2026-10-23)

Deployed signed main revision `bca137b1a38ceb7ab0601e1db53136d69cce9c9c`, with
application code `b23e563a4104bd16b8bb9ce0cd6d356ddfad9d3f`, as Worker
`1f481a97-7e78-443a-a180-ea488822f78b`, created at
`2026-10-23T19:45:28.295064Z`. Deployment
`df1b5117-8f4e-43ae-933d-e697c0baeae3` at `2026-10-23T19:45:29.359227Z`
assigns it 100% of traffic. All six logical commits were signed and their
signatures independently verified. Full local validation passed all 512 tests
and required checks; [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40013802909)
passed all 512 tests and required checks.

Read-only background groups now share observation snapshots, encrypted history
reads and bounded guarded outcome commits. Individual source generations,
credentials, retained evidence, remote identity reservations and queue versions
remain checked. Failed partitions isolate dependent contacts; collision
quarantine preserves competing claims. Small groups and live preparation retain
the existing path. There is no cross-request plaintext cache, new write permission,
change to vendor allowances or change to the 90-second/850-RPC soft budget.

The local warm 20-contact/two-destination fixture falls from 400 to 19 cohort
RPCs, 467 to 86 whole-tick RPCs and 939 to 556 SQL statements. All 40 destination
classifications remain, with zero vendor history requests and zero exports.
Cold whole-tick calls fall from 519 to 170 while retaining three history fetches.
These measurements establish lower database amplification, not sustained
production capacity. `reconciliationBatchCalls` includes all cohort work rather
than inventory reads alone.

The deploy task found no pending migrations and preserved secrets. Independent
D1 readback at `2026-10-23T19:45:46.663Z` confirms nineteen migrations, zero
attempts, zero cutovers and zero temporary proof-guard rows. Live version
settings confirm all five export gates closed; health returns `status=ok` and
`exportsEnabled=false`. The root, `/app.js` and `/admin.js` hashes match the
local build. The bundle is 1,758.87 KiB raw / 339.42 KiB gzip, with reported
startup of 46 ms.

The first new cron run, `19:45:43–19:47:15 UTC`, processed 80 contact turns and
made 121 destination classifications, including five adoptions, with 39 errors
and three deferrals. Inventory recorded 121 cache hits and zero successful
advances; `inventoryFetches` does not count failed vendor requests. The run
used 384 whole-run RPCs / 2,643 SQL statements, 208 reconciliation cohort RPCs
and 83.49 seconds of database wall time, reaching its deadline after 92.209
seconds. The preceding old-code run processed 40 turns / 60 classifications
using 862 RPCs / 1,900 statements in 64.118 seconds and stopped at its database
budget. The first new sample doubled contact turns and reduced RPCs per turn
by approximately 78% (4.8 versus 21.55). It also ran longer and processed mixed
work; these are not unique completed reconciliations or a sustained capacity SLA.
Warm inventory reuse leaves cold-inventory behavior unmeasured in this sample.

The second new run, `19:50:42–19:52:09 UTC`, processed 137 contact turns and
249 destination classifications, including 29 adoptions, with 13 errors and
three deferrals. It recorded five successful inventory advances and 244 cache
hits. Whole-run cost was 861 RPCs / 4,842 SQL statements, including 569 cohort
RPCs, with 85.067 seconds of database wall time in 86.646 seconds total. It
stopped at the 850-RPC soft admission budget; bounded work already started and
cleanup can finish beyond that threshold. RPCs per turn were 6.28. Both new
samples improve on the preceding 40-turn run, but still contain errors and
different work mixes. The second sample includes some inventory advancement;
it is not a full cold-inventory or sustained-capacity test.

The `19:52:36 UTC` snapshot still confirms nineteen migrations, zero attempts,
zero cutovers and zero temporary guards. Earlier runs and progress accumulated
before deployment belong to the previous release. Errors and sustained
classification/context progress remain under observation. Exports remain
disabled; full history reconciliation, fair account admission, source capacity,
delivery identity claims and workload acceptance remain open.

## Independent background admission and diagnostics (2026-10-23)

Signed revision `8863bd9439681122e71bc3c2a31174a72aa30bb2` deployed at
20:44:21 UTC as Worker `004edefd-d2a5-462c-b079-1cf8d04e6b05`, with 100%
traffic. The guarded task applied additive migration `0021`; twenty migrations
are now present. The five signed commits add fixed failure counters, mixed-date
scope sharing, independent background account/source turns and bounded cold
partition concurrency, plus a JSON persistence assertion correction.

All 531 tests and required local checks pass. Independent readback at 20:44:30
confirms all five export gates closed, health `ok`, matching browser assets and
zero attempts, cutovers or temporary guards. Secrets and request allowances were
unchanged. The first scheduled run with the new diagnostics is recorded below.

The warm 20-contact/20-week fixture uses 57 cohort RPCs, 128 whole-run RPCs and
716 statements while preserving all 40 outcomes without vendor requests or
writes. Cold reads remain bounded to four; failures and deadlines stop new
advances, and started peers finish before lease release. The 100-account fixture
proves background turn order across restarts, including slow failures and
multiple sources; it does not establish full live/vendor fairness or sustained
capacity. Full workload verification and the export-readiness requirements
remain open in the [capacity plan](capacity-plan.md).

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

## QRZ response and D1 timing diagnostics (2026-10-23)

Signed revision `57a64b02285f55f3dee25fdf52674ac54cd3893f` deployed at
21:03:35 UTC as Worker `25628683-a870-40e5-835f-e697adbc7f44`, at 100%
traffic. No migration was needed. Both new commits have verified signatures.
All 548 local tests and required checks pass; release CI passed all 548 tests and required checks.
Independent 21:05:18 UTC checks confirm all five gates closed, healthy service
and matching browser assets.

Read-only QRZ failures now preserve only fixed framing, entity, form, result,
size, UTF-8 and body-read categories. Raw responses and error causes are not
retained. Malformed write responses remain uncertain, and a rejected FETCH
never becomes empty-history evidence. D1 metrics add bounded SQL timing,
row/retry totals, metadata coverage and known database-region counts. Query
behavior and first/raw methods are unchanged. Reported SQL/row metadata covers
the last attempt only; its difference from binding wait is not pure network
latency.

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

## Context lookup index and QRZ Unicode compatibility (2026-10-23)

Current checkpoint, 2026-10-23 21:29 UTC: signed revision
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
