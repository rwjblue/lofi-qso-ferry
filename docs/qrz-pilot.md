# QRZ first-insert pilot

The reviewed **one-contact QRZ trial** is acknowledged and accepted at returned
minute precision, with seconds unverified and populated recovery passing. Its
one-INSERT allowance is exhausted. Trials A and B made zero attempts. Trial C
then delivered two contacts through the normal scheduler and passed populated
recovery. Its separate known-ACK assessment accepts returned minute/sideband
representation; literal readback holds and unverified seconds remain recorded.
Its scope is closed. **Automatic exports and LoTW remain disabled**. The broader goal is to validate checked QRZ
batches before automatic QRZ activation, then evaluate
LoTW separately. This document records evidence; it does not itself grant write
authority.

## What the restricted mode permits

The deployed `qrz_fresh_insert` capability permits a first INSERT only after
normal source-proof, fresh QRZ neighborhood, identity, ownership, route and
credential checks. It does not permit replacement, correction, deletion, LoTW
delivery, source-wide cutover or inference of absence without a query.
`SOURCE_BOUNDARY_VERIFIED` remains false.

For the initial trial, both the source QSO and QRZ destination must be explicit
singletons. Historical associations, existing mappings, unresolved attempts and
competing owners cannot be converted into trial candidates by clearing data.

The deployed `c88d413e` implementation, its exact validation scope, completed
ownership bootstrap and populated exact-evidence recovery are recorded in
[deployment evidence](deployment.md). The dated prior-release cloud observation
in [QRZ evidence](evidence-qrz.md) exercises source collection, final drain, proof
creation and fresh absence for one contact. Such a proof expires normally; it is
not write acceptance or standing permission to export.

## Current closed receiver-fix release — 2026-10-25 UTC

The coordinator receiver fix `c88d413e52c8d3ebd5ed7bff4eab10ec6fbf2dd7`
deployed closed at **06:29:17.891099 UTC** as Worker
`a948328a-6098-4cbb-957f-9813f5383e4b`, deployment
`b0efece0-a12f-46c0-95e2-fb5161234adf`. Independent **06:29:31.791 UTC**
attestation verifies healthy HTTPS/assets, KEK 1 and all eight closed controls.
Schema remains at 37 migrations. The **06:26:18.568 UTC PRE** recovery passes
with exactly the original singleton and zero new attempts/artifacts. The
**06:29:50.913 UTC POST** also passes with **41,687,430 bytes**, schema 37,
all prior immutable evidence preserved and repeated quarantine passing. Trial C
subsequently produced the two acknowledgements recorded below.

The local full run completed 1,667 cases with 1,666 passing and one random
ciphertext privacy-assertion failure. Test-only signed `738fea2527c3fb714faa326f130b496eed7da5ed`
corrects that assertion; the history file passes 62/62 and the build passes.
The 42 focused coordinator cases pass. [c88d413e CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40168290537)
subsequently passed all **1,667 tests and required checks** at approximately
**06:37 UTC**, separately from the earlier local failure. See
[current deployment](deployment.md) for the exact recovery and validation scope.

A new offline projection review from the verified c88 POST snapshot found 88
eligible queue-head candidates and selected two at positions 2 and 3. Their
expected records contain 15 and 14 fields (one includes `SUBMODE`), both with
eight-character grids. This is preliminary expected-payload evidence only: no
fresh proof or vendor absence was claimed. The frozen runner's local inspection
passed. After c88 CI succeeded, that exact scope became Trial C, recorded below.

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

## Scheduled Trial B — selected contacts held, 2026-10-25 UTC

The finite-scope scheduling correction is deployed in signed `87e87b2d`, with
**1,666 tests** and [exact-release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40165603166)
passing. Trial B's two exact QRZ contacts both reached live selection at
**06:01:30 / 06:01:45 UTC**. One held for incomplete history and the other for
`source_export_proof_read_failed`; **zero attempts or vendor writes** occurred.
The scope closed at **06:05:54.576653 UTC**; independent **06:11:34.594 UTC**
attestation verifies all eight controls closed. After at least 180 seconds of
drain observation, zero new attempts and **one unfinalized scheduler row** remain.
The **06:12:54.606 UTC**, **41,555,300-byte** recovery snapshot preserves the
original singleton and all immutable prior rows, with zero new artifacts and
passing integrity/FK/repeated-quarantine checks. See [deployment evidence](deployment.md).

Native Workerd reproduces the coordinator's invalid receiver on native `fetch`:
`options.rawFetcher(...)` throws `Illegal invocation` before outbound transport.
Signed fix `c88d413e52c8d3ebd5ed7bff4eab10ec6fbf2dd7` binds `globalThis`; the
actual-coordinator regression and 42 focused cases pass. Full checks and
[CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40168290537) were running;
the fix was not deployed at that checkpoint. It subsequently deployed closed at
06:29 UTC. Trial C subsequently passed scheduled delivery, populated artifact
recovery and the separate known-ACK assessment above. The earlier singleton's
minute-consistent acceptance and unverified seconds are unchanged.

## Earlier scheduled Trial A — zero attempts, 2026-10-25 UTC

Migration `0038` now retains original encrypted artifacts through normal ACK
cleanup, with original AAD and seven-day expiry. The signed release, full CI and
37-migration PRE/POST recovery pass; all prior immutable evidence is preserved.
Two contacts were reviewed from the normal queue head without minting a proof
or claiming fresh absence. The broader goal authorized their current validated
payloads; the rollout flags enforce contact/destination scope, not frozen bytes.

The actual 05:10 UTC scheduled invocation stopped at its deadline after 27 contact
turns and 22 cached classifications, with zero attempts or vendor writes. The
gate/scope policy change woke the whole backlog; the selected contacts remained
eligible but sat behind unrelated due work. This does not prove scheduled export
acceptance. The scope was closed at 05:13:15 UTC. Independent checks after the drain
period confirm all eight closed controls, completed runs and only the original
singleton attempt. The 05:17 UTC recovery snapshot passes with no new artifacts.

That finite-scope correction subsequently deployed in `87e87b2d` and reached
both Trial B contacts. No queue reset, claim clearing or vendor retry was used.

## Historical one-contact packet preparation

1. Pin the signed runtime and independently verify its Worker, healthy origin,
   matching assets and all eight closed controls. Verify a protected current
   database/key backup and isolated restore covering every populated evidence
   table.
2. Select one genuine source contact and one QRZ book through normal eligibility.
   Review the private projected identity, actual location precision, frequency,
   reports and complete narrative. Retain the exact expected ADIF and hashes.
3. Use normal source collection and the final canonical drain to mint a proof.
   Verify the exact book and a complete fresh QRZ neighborhood, then require the
   same proof and candidate to remain current. Partial, rejected, busy or stale
   checks defer; they do not justify wider limits or a substitute candidate.
4. Finish and independently review the concrete one-shot execution and recovery
   packet. Its prepare phase must durably preserve the encrypted outbox,
   immutable attempt, identity claim and source-proof facts before dispatch can
   make a mutating request. Current delivered/rejected resolution can purge the
   outbox, so an expected-record hash alone is not a recovery copy.
5. Bind the actual owner instruction to that exact contact, destination,
   reviewed payload, execution window and at most one mutating transport
   attempt. The owner has authorized this singleton; automatic exports and
   LoTW remain disabled.

The protected operator packet now passes **22 native offline cases** for review,
normal preparation/dispatch and stopped/uncertain outcomes. Its separate
recovery verifier passes **21 lifecycle and isolated-restore cases**. Independent
source, producer/consumer, protected-file and deterministic-bundle reviews found
no material blocker. These local tools do not change the deployed scheduler or
authorize a write.

The packet was regenerated for signed `0386af30312494bf31c2fd45f833e9c2a41534e9`
and actual Worker `fbaf8af8-d51c-44e9-a5ca-53e29c2eb5c3`, independently verified
after the disabled deployment. Fresh offline checks pass **22 native execution
cases, 92 supporting cases and 21 recovery cases**. The 127 trial and 32 source
SQL permissions are unchanged; all 123 observed SQL templates match the prior
packet. Independent review verifies 105 protected artifacts, 290 exact Git
archive files, 413 unique physical bundle inputs and 86 unchanged originals.
Combined manifest SHA256:
`7c39915bb1ba7a1588247699367097161e04ec9c9380933c378ed6f25f5f6bc0`.
Old reviews and proofs retain their original release binding and expiry. This
regeneration creates neither a new live proof nor trial authorization.

Launch the protected host entry from a saved script with its reviewed outer
timeout and diagnostic suppression. Do not use an eval with
`--input-type=module`: Wrangler's Node worker threads inherit that flag, which
rejects file-based worker startup. The read-only host check passed when launched
from a saved `.mts` file; this changes no application guard or permission.

The SELECT-only payload review succeeded at **2026-10-24 22:36:54.773 UTC** for
the same selected contact, using **52 D1 RPCs / 58 SQL statements**. It retained
the exact record, serialized ADIF, template/book binding and hashes in protected
local files, with all eight production controls closed before and after. It made
no source/vendor request and created no attempt. Earlier binding changes stopped
before saving a review; the later review explicitly re-read that same contact,
without substituting another. Current context still needs the normal refresh,
so its metadata/proof/readiness flags remained false. At that checkpoint the
specific owner instruction was pending and no acknowledgement or readback
acceptance had occurred. Later authorization and acceptance are recorded below.

The exact-`0386af30` SELECT-only review succeeded at **2026-10-25 02:56:37.961
UTC**, again using **52 D1 RPCs / 58 SQL statements**. It independently re-read
the original contact and confirms the same book, credential version, template,
every transmitted field, canonical record hash and exact serialized ADIF bytes.
The new protected review packet SHA256 is
`c4fc7203222276277b0b585fd720723d96b12f4a89e69b7dd3b5bf38a2877e80`.
Independent before/after attestations verify the actual deployed release and
all eight closed controls, last checked at **02:56:39.484 UTC**. No source/vendor
request, attempt, approval or write was created.

This is still a preliminary payload review: context refresh is required and
metadata/proof/readiness flags remain false. It does not renew the earlier source
proof or establish QRZ absence. Fresh normal checks belong immediately before
the separately authorized trial. The reviewed helper preserves both original
hashes and exact ADIF bytes across canonical JSON storage; its separate 12-case
suite and strict TypeScript checks pass. Helper manifest SHA256:
`43f638a68c9431b20785d0ab34d98aef0dbf22877649d1c3ab3e63e0f6cf99ce`.

## Authorized preparation and verified zero-attempt recovery — 2026-10-25 UTC

The owner authorized the exact reviewed payload and at most one INSERT. The
**03:15:59.683 UTC** pretrial backup contains 42,106,608 bytes, SQL SHA256
`ea7f0ad99f11ff7c43d2a1027616954519c13cfb32c4136b1ecfae5cd3592768`.
It passes populated evidence/credential/key checks, integrity/FKs and two
isolated quarantines, with zero attempts and no unhashed ownership inputs.

The actual invocation stopped during PREPARE at **03:20:29.264 UTC**. No
prepared-packet acknowledgement, dispatch intent or outcome was returned. The
host correctly recorded uncertainty and did not retry. The fixed launch burn,
original approval, prepare intent and failure journal remain preserved.

Independent **03:22:23.152 UTC** failed-prepare recovery verifies zero attempts,
attempt identity claims, source/LoTW pins, cutovers and staging guards. The
42,301,034-byte SQL snapshot has SHA256
`0cb41a2ce9bcaa22703fe005082c955a9889f019f14a652d206b66a86d712d5f`.
All 3,327 baseline claims, 2,895 QRZ owners/markers, 3,860 LoTW owners and 3,327
exact evidence rows are unchanged. All crypto, integrity/FK and repeated
quarantine checks pass. One unpinned diagnostic proof and retention row remain.
This establishes no dispatch and no INSERT; it is not write acceptance. The
historical unknown-outcome journal remains unchanged.

The original tool discarded the specific preparation hold, so its cause cannot
be reconstructed from that journal. Later context and catch-up changes occurred
after the failure and do not establish its cause. A separate source-proof/QRZ
diagnostic completed at **03:29:02.518 UTC** with two source and three QRZ reads,
109 D1 RPCs / 135 SQL statements, no write capability and a disposed preview.
All eight production controls remained closed. Fresh evidence is still required
for a continuation; the original nonce, approval and launch burn cannot be reused.

## Acknowledged INSERT and populated recovery — 2026-10-25 UTC

The corrected operator packet completed normal preparation and one INSERT by
**03:55:14.887 UTC**. QRZ returned a valid acknowledgement and LOGID, and the
normal runtime stored delivery. The immediate exact readback remained
unresolved; no retry or second INSERT occurred. All eight production controls
stayed closed, and the temporary preview was disposed.

The **03:56 UTC** recovery snapshot contains 42,499,980 bytes and verifies
exactly one expected delivered QRZ attempt, accepted receipt, identity claim and
source-proof pin. Its original encrypted payload remains preserved in the host
packet and decrypts correctly after normal ACK outbox purging. All 3,327
baseline claims, 2,895 QRZ owners/markers, 3,860 LoTW owners and 3,327 exact
evidence rows are unchanged; crypto, integrity/FKs and two isolated quarantines
pass. The singleton's INSERT allowance is exhausted; no resend is permitted.

## Acknowledged readback and duplicate check — 2026-10-25 UTC

The independent exact-LOGID read verifies the acknowledged record in the intended
book. All 13 other transmitted fields are literal-exact, including the full grid,
coordinates and narrative. QRZ returns four-digit `TIME_ON` matching the first
four of the six transmitted digits on the same UTC date. Seconds remain
unverified; preserve the original six-digit value rather than padding readback.
[ADIF allows both precisions](https://www.adif.org/316/ADIF_316_annotated.htm#Time).

A separate offline assessment binds this observation to the delivered receipt,
permanent QRZ owner, exact claims and source-proof pin. It permits only this
same-minute reduction, with every other transmitted field literal-exact. This
does not alter the original unresolved literal-readback outcome or the stricter
production uncertain-attempt matcher. Its 21 focused cases and strict types pass.

A complete bounded CALL/band/date FETCH independently finds one record and one
normal ±30-minute neighborhood candidate, the acknowledged LOGID. Pagination
ambiguity holds the check rather than establishing absence. The 10 focused
neighborhood cases, types and bundle pass. Both read-only previews are disposed;
all eight controls remain closed. No further INSERT occurred.

The singleton is accepted at returned minute precision, with seconds unverified.
Migration `0038` now preserves encrypted artifacts through normal ACK cleanup.
The later Trial C supplied two-contact scheduled delivery and populated live
artifact recovery. The runtime supports two QSO IDs and one QRZ destination
without wider authority; each later batch still needs fresh evidence.

## Readback and recovery for later checked batches

Use the normal guarded preparation and dispatch functions with exact authorized
scope. Preserve all late source, proof, credential, lease, ownership and request
checks after vendor-budget admission. Permit only the expected QRZ INSERT body;
do not retry a lost preparation or dispatch acknowledgement blindly.

A clean QRZ acknowledgement is necessary but insufficient: the runtime marks a
valid acknowledgement delivered without automatic exact post-ACK verification.
FETCH the acknowledged LOGID within the verified book, require that exact LOGID
and one record, and compare every transmitted field and full narrative against
the privately frozen expected record. Assess any normalization explicitly.
Confirm the resulting ledger mapping and absence of a duplicate neighbor.

On uncertainty, retain the original artifact, attempt, claim and proof pin and
use read-only reconciliation. Empty readback does not authorize resubmission.
Stop writes, account for requests already admitted, and independently verify the
closed controls. Do not DELETE/REPLACE the contact or restore production D1 as a
rollback. Verify a post-attempt backup against the actual nonzero attempt,
receipt, ownership and pin state; the pretrial zero-attempt verifier is
insufficient. Repeat isolated quarantine without losing immutable evidence.

## Expanding to one or two users

After checked scheduled batches pass, the owner’s authorized gradual expansion
can use the existing scope parsing for `ROLLOUT_QSO_IDS_JSON=["*"]` with exact QRZ destination IDs. This includes
eligible older missing contacts as well as future arrivals. It is not a
future-only cutoff. Use explicit QSO IDs if that backfill scope is unwanted.
Empty or missing scopes authorize nothing.

The normal cron path already reconciles, collects a proof and immediately
prepares/dispatches within the same source turn. It bounds a proof cohort to
20 contacts and 64 dependencies, with four source requests and ordinary tick
budgets. Stale known-unsent work is cancelled and rebuilt with a new proof;
uncertain/submitted work instead enters read-only reconciliation. Thirteen
targeted native scheduler/delivery and gate cases passed in the later audit.
Trial C now proves two successful normal scheduled preparations/deliveries,
retained-artifact recovery and assessed post-ACK readback. Further checked
batches remain required before broadening QSO scope. The protected observers
supply the additional field comparison; normal clean-ACK delivery does not
automatically perform it.

Keep the universal source-boundary and LoTW capabilities false, and corrections
and deletion unavailable. Measure modest live delay/cost and review per-user
routing, held competitors and source edits before expanding further.

Every unrelated historical exception, an empty LoTW raw-reference table and a
200,000-contact capacity result are not prerequisites for this restricted QRZ
pilot. Contradictory location evidence remains held under the current policy.
LoTW needs its own fresh three-day history, signing, upload/readback acceptance
and recovery of any populated raw historical evidence. General corrections and
source-wide cutovers require their separate source-boundary work.
