# Durable matching work evidence

Status: local guarded matching-work lifecycle, 2026-11-08. Full bucket/scope
invalidation, coordinator/hosted integration, ownership-aware planning and delivery
remain unfinished. Runtime activation is off; no production reset or vendor upload
was performed.

## Work and publication

[Migration 0058](../migrations/0058_inventory_matching_work.sql) adds
`matching_work` keyed by generation with source/destination configuration bindings, monotonic
work/completed versions, due time, capacity hold and last completed dependency set.
Source projection insert/update enqueues its source key for eligible QRZ/LoTW
scopes in the same native transaction. This is bounded by the projection cohort
and linked destinations; it does not enumerate an operation's children. The
explicit enqueue API accepts at most 200 selected references and reports how many
eligible routes were queued.

[InventoryMatchingWork](../src/inventory-matching-work.ts) selects an indexed head
per current eligible source/destination pair, then claims the destination matching
lease and captures at most twenty due keys. Pending/retired generations, obsolete
configurations and disabled scopes cannot create a global pending-history walk.
The existing workspace still enforces its shared candidate/body/context limits and
current source roster, coverage and reverse uniqueness rules.

[Result publication](../src/inventory-matching-results.ts) optionally includes
immutable `inventory_match_work_claims` and typed `inventory_match_work_rows`.
The receipt digest binds both the prepared matching snapshot and exact captured
work versions. Native admission checks the complete claimed cohort, configuration,
due time and current work versions. Result pointers and work completion publish
together; final commit verifies both using claimed-key point reads. Existing
native dependency and account/lease fences remain in force.

A newer invalidation cannot be marked complete by an older preparation. Losing an
acknowledgement recovers the original receipt without incrementing result versions
or clearing newer work. Reusing its ID with different work claims fails. Ordinary
manual result publication remains available and cannot complete queued work by
itself. Claim relations retain the existing seven-day minimum receipt horizon;
collection is still future work.

Completed work means that a comparison was processed against its captured facts.
Its result can be incomplete, ambiguous, excluded or mismatched. Completion does
not assert complete service coverage, adopt history, acquire ownership, prepare an
attempt or authorize a vendor write.

## Capacity and recovery

The worker halves a cohort on a deterministic workspace capacity failure. A real
twenty-source/120-receipt fixture exceeds the shared 128-record union and drains
as ten comparisons followed by the remaining ten. No unprocessed key completes
when the first half publishes.

A single comparison with 129 receipt candidates cannot be split further. It stays
pending with a fixed `capacity` reason and a five-minute due delay, creates no
matching result, and allows other due work to proceed. This delay is a local
retry policy, not a vendor rate limit. A new source projection or explicit
invalidation clears the delay and increments its work version. Corrupt data and
unexpected errors remain errors rather than being relabeled as capacity holds.

The native tests also cover omitted claim rows, future-due work, source/target
configuration changes, expired leases, late account locks, late invalidation,
SQL rollback, bare-result completion forgery and lost-acknowledgement replay.
An actual Worker resumes 21 comparisons across separate requests as 20, one and
idle, releases its leases, preserves source checkpoints/credential ciphertext and
makes zero external requests. It creates no ledger entries or upload attempts.

## Native costs

Twenty unique source/receipt pairs publish their first results and work completion
in fourteen explicit statements, **8,779 reads and 1,115 writes**. Preparation,
receipt/version reads and lease work remain outside that publication boundary.
This does not meet the complete-cohort six-binding-call target.

The retained-history benchmark initially found a final commit join that added
exactly 5,000 reads for 5,000 unrelated pending jobs. Driving the check from its
claimed rows fixes that traversal: warm twenty-key publication uses 8,967 reads
and 1,095 writes both before and after the unrelated jobs are added. The idle
selector uses twenty reads with and without 5,000 retired pending jobs. These are
small native D1 fixtures, not hosted latency or full-sync throughput estimates;
many-scope and large date-partition costs still require qualification.

Source projection publication now pays for real matching-work enrollment. That
additional index/table write cost must remain included in projection and complete
turn measurements. In the encrypted replay, publishing twenty held source
projections with two destinations rises from 288 to **408 writes**, still in twelve
explicit statements. Destination projection writes remain unchanged. The queue is
not free simply because it uses native triggers.

## Encrypted capture replay

The [comparison trial](../scripts/inventory-comparison-trial.ts) applies migration
0058 to an isolated copy of the original three-provider capture. Its sixty held
source projections enqueue 120 source/destination jobs. Ten selected comparisons
per destination complete twenty captured work versions; 100 jobs remain pending.
The twenty results remain incomplete because the captured source baseline is
unfinished, and historical associations remain zero.

The private work manifest binds each committed receipt to its original matching
digest and captured versions. Reopening checks exact claim rows, receipt digests,
completed job pointers and the total/pending/completed counts, alongside the
existing encrypted-body and matching-snapshot checks. Older captures without
matching-work tables remain readable through their existing optional report shape.
Vendor requests/uploads remain zero and canonical inventory, credentials and
checkpoints remain unchanged.

The latest private directory ends in `e165f7a2-fc58-4460-8a3c-eab7c65af945`;
database allocation is **15,454,208 bytes**. This includes only a small projection
and matching sample, not a full-log storage-density estimate. Reopening validates
82 distinct projection bodies, twenty matching results and twenty completed work
claims. The earlier 0057 capture without matching-work tables also reopens.
Logs are `/tmp/lofi-ferry-matching-work-capture-verified.log`,
`/tmp/lofi-ferry-matching-work-reopen-verified.log` and
`/tmp/lofi-ferry-matching-work-compat-verified.log`.

## Verification

The final inventory regression passes **424 tests** with no failures, skips or
cancellations, including the native Worker and large retained-work fixtures.
TypeScript, lint, formatting and the Worker dry-run build pass. Logs are
`/tmp/lofi-ferry-matching-work-inventory-verified.log`,
`/tmp/lofi-ferry-matching-work-types-final-verified.log`,
`/tmp/lofi-ferry-matching-work-lint-final-verified.log`,
`/tmp/lofi-ferry-matching-work-format-final-verified.log` and
`/tmp/lofi-ferry-matching-work-build-verified.log`.

## Remaining work

Source projection enrollment is not comprehensive matching invalidation. Add
bounded old/new bucket and reverse-dependency continuations, source-set/scope/
coverage/routing/ownership changes and initial enrollment for preexisting source
projections. Immediate current-result dependency checks already hide stale facts;
the new continuations must reliably schedule their replacement without intake
fan-out or a whole-log scan for each ordinary change.

Then integrate matching turns and due holds into durable coordinator/Queue/cron
recovery, select current results with ownership, and conservatively adopt history.
Source proofs, new delivery ownership, QRZ submission, LoTW member-aware recovery,
GC/restore and account-preserving deployment cutover remain unfinished.
