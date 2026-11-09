# Inventory delivery review

## Work and authority

[Migration 0083](../migrations/0083_inventory_delivery_review.sql)
creates one review row per current inventory absence. Match publication
requires the exact row and replaces it when a newer comparison arrives.
A result that changes to a match, ambiguity, exclusion or other
non-absence retires its review. Review rows leave historical associations
and comparison facts intact.

The [review worker](../src/inventory-delivery-review.ts) selects up to
twenty members of one current comparison set. It checks the active
account, route, encrypted credential versions, historical owners, unresolved
provider holds and legacy delivery evidence. For LoTW, it also reads the
bounded, encrypted station/call/time ownership neighborhood across linked
accounts. For QRZ, historical ownership follows the destination book and
the logical source contact. An absence supplies no LOGID for a new claim.

Publication rechecks the shared comparison proof once and atomically
compares the result version, lease fence, source and destination credential
versions, and ownership clock. A stale proof receives a retry decision.
Superseded claims leave no clear review. Ownership changes invalidate the
review without changing the corresponding comparison result. The current
review view verifies those same inputs when read.

`source_proof_required` means the contact can enter the next planning
stage. That stage still needs a fresh LoFi dependency witness, a complete
forward drain, delivery routing and quiet-period checks, and final
destination evidence. Review creates neither source proofs nor attempts.

[Migration 0085](../migrations/0085_inventory_delivery_review_coordinator.sql)
rotates review with matching and historical adoption in the existing
coordinator slot. The turn preference survives restarts. Current
work and the earliest retry deadline use the existing durable outbox.
Match, credential and ownership changes coalesce wakeups while the
coordinator is already signaled.

## Personal-log replay

The trial copied the quiescent encrypted database from the
[real calendar and QRZ run](evidence-inventory-adoption-scheduling.md).
It enrolled work from 1,112 retained absences. All 366 QRZ and 746 LoTW
members reached `source_proof_required`. The planner created zero
attempts, performed zero HTTP requests and preserved the original
comparison results, historical associations and credential ciphertext.
A fresh reopen recovered the decisions and validated a current sample.

A query plan from this capture showed that the projection proof used the
operation-parent index to find an already identified contact. It could
read many siblings of that contact. [Migration 0084](../migrations/0084_inventory_projection_record_lookup.sql)
forces the existing QSO primary-key lookup and preserves the rest of the
projection predicate. Repeating the same bounded standalone replay after
the change reduced rows read by 95%. Neither run includes witness
collection or vendor I/O.

| Standalone replay | D1 calls | SQL statements |  Rows read | Rows written | SQL time | Elapsed |
| ----------------- | -------: | -------------: | ---------: | -----------: | -------: | ------: |
| Schema 0083       |    2,811 |          3,005 | 15,274,084 |        4,072 |    7.4 s |  24.5 s |
| Schema 0084       |    2,811 |          3,005 |    768,658 |        4,072 |    3.5 s |  23.0 s |

The schema 0085 replay used the full comparison coordinator against
native D1. It reached the same decisions and parked after 4,059 turns
in 192.9 seconds. The measured turns used 35,654 D1 calls, 35,848
statements, 1,056,701 rows read and 33,573 rows written. This measures
coordinator and native outbox work locally. Hosted Queue transport is
covered separately by the Worker test. Cycling through the other
coordinator phases adds durable progress work between review cohorts.

The 1,112 provider reviews represent 747 distinct source contacts.
Both providers need evidence for 365 of those contacts. The cohort
touches 30 operations and 14 active events, with at most six active
events in one operation. All 747 contacts are historical in this
capture. These are closure census counts from retained inventory;
they measure sharing potential before any fresh witness collection.
The [sanitized benchmark](benchmarks/inventory-delivery-review-2026-11-08.json)
retains the measured counters.

## Qualification and remaining work

Native cases cover comparison supersession, omitted-work rollback,
credential rotation, ownership invalidation, and a hold inserted
between review preparation and publication. An actual Worker cron and
Queue test produced a clear review beside a historical association,
then woke the review after an ownership hold. Neither review made a
vendor request. Existing matching/adoption alternation and retry
deadline tests also passed. The focused hosted, review and coordinator
suites passed 26 tests. TypeScript, lint, formatting and the Worker
dry-run build passed.

The review uses a provider-wide ownership clock and one comparison set
per positive turn. Those choices conservatively reopen reviews after an
unrelated ownership change and can produce small cohorts where most
members of a set are already matched. Fresh source proofs and their
request budget, quiet-period and exact routing checks, native delivery
attempts and QRZ/LoTW submission remain open.
