# QRZ first-insert pilot

Current instruction: **keep exports disabled**. This document describes the
remaining acceptance work; it does not authorize activation or a vendor write.

## What the restricted mode permits

The deployed `qrz_fresh_insert` capability permits a first INSERT only after
normal source-proof, fresh QRZ neighborhood, identity, ownership, route and
credential checks. It does not permit replacement, correction, deletion, LoTW
delivery, source-wide cutover or inference of absence without a query.
`SOURCE_BOUNDARY_VERIFIED` remains false.

For the initial trial, both the source QSO and QRZ destination must be explicit
singletons. Historical associations, existing mappings, unresolved attempts and
competing owners cannot be converted into trial candidates by clearing data.

The deployed implementation, 1,617-test release checks, completed ownership
bootstrap and populated exact-evidence recovery are recorded in
[deployment evidence](deployment.md). The dated current-release cloud observation
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
5. Obtain a changed owner instruction for that exact contact, destination,
   reviewed payload, execution window and at most one mutating transport
   attempt. No actual trial runs under the present keep-disabled instruction.

The execution/recovery wrapper remains under preparation. A template or a
successful read-only proof is not a completed trial packet.

## Acceptance after a separately authorized attempt

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

Keep the universal source-boundary and LoTW capabilities false, and corrections
and deletion unavailable. Measure modest live delay/cost and review per-user
routing, held competitors and source edits before expanding further.

Every unrelated historical exception, an empty LoTW raw-reference table and a
200,000-contact capacity result are not prerequisites for this restricted QRZ
pilot. Contradictory location evidence remains held under the current policy.
LoTW needs its own fresh three-day history, signing, upload/readback acceptance
and recovery of any populated raw historical evidence. General corrections and
source-wide cutovers require their separate source-boundary work.
