# QRZ first-insert pilot

Current instruction: complete the reviewed **one-contact QRZ trial**, with a
fresh backup, at most one INSERT, exact readback and recovery. **Automatic
exports and LoTW remain disabled** during that trial. The broader goal is to
validate checked QRZ batches before automatic QRZ activation, then evaluate
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

The deployed `0386af30` implementation, 1,653-test release checks, completed ownership
bootstrap and populated exact-evidence recovery are recorded in
[deployment evidence](deployment.md). The dated prior-release cloud observation
in [QRZ evidence](evidence-qrz.md) exercises source collection, final drain, proof
creation and fresh absence for one contact. Such a proof expires normally; it is
not write acceptance or standing permission to export.

## Complete the one-contact packet while disabled

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
so its metadata/proof/readiness flags remain false. A specific owner instruction
for the actual trial is pending. No vendor acknowledgement or readback acceptance
has occurred.

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

## Acceptance after the authorized attempt

Use the normal guarded preparation and dispatch functions with exact singleton
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

After real acceptance and explicit expansion approval, existing scope parsing
supports `ROLLOUT_QSO_IDS_JSON=["*"]` with exact QRZ destination IDs. This includes
eligible older missing contacts as well as future arrivals. It is not a
future-only cutoff. Use explicit QSO IDs if that backfill scope is unwanted.
Empty or missing scopes authorize nothing.

The normal cron path already reconciles, collects a proof and immediately
prepares/dispatches within the same source turn. It bounds a proof cohort to
20 contacts and 64 dependencies, with four source requests and ordinary tick
budgets. Stale known-unsent work is cancelled and rebuilt with a new proof;
uncertain/submitted work instead enters read-only reconciliation. Thirteen
targeted native scheduler/delivery and gate cases passed in the later audit.
Actual successful scheduled preparation/dispatch remains unobserved while
exports are disabled. Observe a singleton scheduled turn before broadening QSO
scope. The one-contact operator trial separately supplies durable expected bytes
and exact post-ACK readback; normal clean-ACK delivery does not automatically
perform that extra field comparison.

Keep the universal source-boundary and LoTW capabilities false, and corrections
and deletion unavailable. Measure modest live delay/cost and review per-user
routing, held competitors and source edits before expanding further.

Every unrelated historical exception, an empty LoTW raw-reference table and a
200,000-contact capacity result are not prerequisites for this restricted QRZ
pilot. Contradictory location evidence remains held under the current policy.
LoTW needs its own fresh three-day history, signing, upload/readback acceptance
and recovery of any populated raw historical evidence. General corrections and
source-wide cutovers require their separate source-boundary work.
