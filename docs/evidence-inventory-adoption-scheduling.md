# Automatic historical adoption and calendar scope evidence

Status: local implementation, native Worker qualification and private
real-data replay. Nothing was pushed, deployed, reset in production or
uploaded. The read-only runtime remains configured off for deployment.

## Durable adoption work

[Migration 0078](../migrations/0078_inventory_adoption_work.sql) and
[InventoryAdoptionWork](../src/inventory-adoption-work.ts) enqueue only a
`matched_existing` result without a permanent association in the same
logical source/book namespace. The job captures the exact result version,
proof set, generation and route configurations. Match publication rejects
an omitted job. Nonmatching replacement results cancel the old hint;
existing associations survive the replacement.

Each turn chooses the oldest due work on a live route and loads at most
twenty members of one shared proof set. The existing association publisher
still validates source and receipt evidence, ownership, account, credential
and lease authority. A newer result cannot substitute for a captured
claim. The job has no export authority.

The permanent association is the completion receipt. Job acknowledgement
can be retried after a crash without creating a second association. There
is no retained completed-job table. Stale comparison, uncertain ownership,
prior delivery evidence and singleton capacity bounds defer under the
provider ownership lease; a newer result replaces the old deadline.
Capacity can split a larger cohort without consuming the remaining claims.
A conflict already observed in the prepared cohort remains held.

[Migration 0079](../migrations/0079_inventory_adoption_coordinator.sql)
alternates matching and adoption inside the existing coordinator slot.
If the preferred activity is idle the other can proceed. Native progress
guards retain the alternation across restart and preserve existing phase
numbers. The earlier of the two activities' live retry deadlines is
published through the existing hosted wakeup outbox. This leaves comparison
facts independent from the ownership records they produce.

## Complete real QRZ adoption replay

The [managed real-service trial](evidence-inventory-managed-trial.md)
had 2,957 current QRZ matches and forty manually preserved associations.
The follow-up copied that quiescent encrypted database, applied migrations
0077–0079 to the copy, and enrolled the remaining 2,917 already captured
matches in fifteen metadata pages of at most 200 rows. That enrollment
is trial setup for existing facts. In a fresh runtime, new result
transactions enqueue their own work.

The actual comparison coordinator ran against native D1 in Node. It
automatically adopted all **2,917** remaining matches in **211** positive
turns and then parked with no pending adoption jobs. The final 2,957
associations and 2,957 encrypted evidence rows include the original forty
unchanged mappings. All current comparison classifications, canonical
inventory/checkpoint metadata and encrypted credentials stayed unchanged.
The original capture and original captured access were fingerprinted
again and matched. Zero provider HTTP requests and zero attempts occurred.

| Measured phase                            | D1 calls | Statements |  Rows read | Rows written | Elapsed |
| ----------------------------------------- | -------: | ---------: | ---------: | -----------: | ------: |
| Replay enrollment                         |       31 |         46 |     79,133 |       11,728 |  15.0 s |
| All coordinator turns                     |   22,350 |     23,827 | 41,550,790 |       67,366 | 119.2 s |
| Positive adoption turns within that total |    5,592 |      7,069 | 41,422,583 |       52,542 |       — |

The 2,332 coordinator turns include ordinary idle phase checks between
adoption cohorts. Positive cohorts had seven to nineteen members, with a
mean of 13.8. These counts exclude initial schema migration, file copy,
final audits, hosted Queue delivery and production CPU. Actual Queue
integration is qualified separately by the Worker test. Full-cohort
proof costs and idle orchestration remain larger than the original
throughput target.

A fresh process verified the 2,957 associations, zero pending work and
zero attempts, and decrypted a retained ownership sample. Another reopen
verified the 8,502 current comparison results. Both performed zero
provider requests.

## Storage census

The replay increased D1's reported size from 275,439,616 to **285,364,224
bytes**. A local read-only SQLite page census attributes table and index
pages as follows:

| Category                                     | Allocated bytes |
| -------------------------------------------- | --------------: |
| Comparison work, indexes and current results |     110,702,592 |
| Retained matching proofs                     |     103,096,320 |
| Inventory and projection payload tables      |      32,415,744 |
| Other schema and state                       |      29,032,448 |
| Historical association and ownership state   |      10,117,120 |

Comparison work and proofs account for about 75% of allocation. Moving
only payloads to R2 would leave most of this footprint in D1. The bucket
dependency table and its indexes alone occupy about 49.1 MB. Of 974
retained proof sets, 437 were referenced by the measured current result,
matching/adoption work or historical association pointers. None of the
remaining sets had passed the seven-day retention horizon. The census
does not establish collector eligibility or estimate reclaimed pages.

## Real LoTW range evidence

[ARRL's receipt query documentation](https://lotw.arrl.org/lotw-help/developer-query-qsos-qsls/)
supports contact-date bounds separately from an explicit receive-time
checkpoint. A diagnostic used a wide fixed contact-date range, explicit
receive lower bound and the existing strict read-only transport. The
HTTP 200 response delivered 557,042 bytes before the invocation's
30-second body deadline, below the two-MiB byte ceiling. It supplied no
complete report or coverage. This is evidence against assuming one
account-sized request fits the current reader deadline, not evidence of
a vendor record cap.

A separate 31-day selection on a private copy went through the existing
native runner. It completed in 1.65 seconds and one request, accepted
nine receipts (5,304 response bytes), and published ready selection
coverage. It preserved all QRZ associations and linked credentials. Local
comparison quiesced in twenty turns without another provider request.
The LoTW classification totals did not change in this selected month;
it is neither full account coverage nor positive LoTW adoption evidence.

The source date census read 4,243 ready encrypted projections in bounded
groups. Their contact windows, including the matching tolerance, need
fourteen calendar months. The largest month contains 691 source contacts;
the top three contain 1,821. The other eight active source contacts are
excluded or held. Only actual successful receipt selections establish
coverage; source-derived dates just select work.

## Complete source-calendar LoTW trial

A separate private copy registered the fourteen unfiltered calendar
selections through the existing native scheduler. It carried two recent
diagnostic reads into the local admission window conservatively and
respected the existing eight-background-requests/five-minute policy. The
trial completed its independent reads before draining comparisons, so
monthly readiness changes could accumulate before the local pass.

All **fourteen** selections published ready coverage after **fourteen
LoTW requests** and 78 read/control turns in 237.1 seconds. The reports
transferred 2,429,746 bytes and established 4,080 calendar membership
entries. The database retained 4,082 active LoTW receipts, including two
earlier records. There were no new LoFi or QRZ requests. The scope covers
the saved source contact windows; it is not the whole LoTW account.

| Measured phase                    | D1 calls | Statements |  Rows read | Rows written | Elapsed |
| --------------------------------- | -------: | ---------: | ---------: | -----------: | ------: |
| Calendar census and registration  |      317 |        583 |    138,112 |          561 |       — |
| LoTW reader and coverage controls |    1,054 |      2,676 |    474,960 |      167,532 | 237.1 s |
| Local comparisons and adoption    |   70,788 |     82,897 | 73,382,835 |      960,712 | 422.4 s |

The comparison and adoption pass quiesced after 6,798 native turns. It
retained **3,303 LoTW historical associations** and classified **746**
contacts as absent at inventory. It also retained 159 detail mismatches,
19 ambiguous results, 19 incomplete results and five exclusions. There
were no pending adoption jobs, upload attempts or further HTTP requests.
The 2,957 QRZ associations and QRZ classifications stayed unchanged.
Read and comparison time together was about eleven minutes, excluding
setup, final audit and reopen; hosted Queue/CPU costs were not measured.

A fresh process revalidated the fourteen coverage selections, checked
the classifications, decrypted a LoTW ownership sample and recovered all
6,260 historical associations across both destinations. Credential
ciphertext and the original captured access matched. The reopen made
zero requests. D1's reported size after both destinations was **392,892,416
bytes** before collection. The corresponding page census attributes
283,967,488 bytes to comparison proofs/work/indexes and 41,119,744 bytes
to inventory/projection payload tables. This again favors proof retention
and index density work before a payload backend change.

## Durable source month hints

[Migration 0080](../migrations/0080_inventory_source_calendar.sql)
records distinct UTC month hints from accepted active ordinary LoFi
contacts, including the matching tolerance at a month boundary. The
prepared page binds the aggregate months; native shape/count guards and
publication put their first observation in the same transaction as the
source bodies and checkpoint. Events, deletions, stale variants and
receipt pages add no months. Overlap does not refresh the first witness.
No plaintext QSO date/record index or per-record SQL statement is added.
Old committed receipts still recover without re-observing their contents.

An otherwise identical 1,000-record native source page covering fourteen
months still publishes in thirteen statements. Publication reads moved
from 21,035 to 22,080 and writes from 14,010 to 14,038, including the new
month table and its index. These are publication-only counters, excluding
request admission, preparation and later scheduling. Transient LoFi
admission pages carry an empty hint list and publish nothing.

The real source-calendar trial above used explicit registration on schema
0079. The new hints supply durable input for automatic registration;
consuming them and recovering split selections are subsequent work.

The [sanitized measurements](benchmarks/inventory-adoption-2026-11-08.json)
retain the replay, reopen, page censuses and LoTW trial summaries.
No raw contacts, credentials or private directory locations are included.

## Qualification and remaining integration

Nine native adoption-work cases cover both providers, matched-only
enqueue, exact claims, supersession, capacity, uncertain ownership,
shared proof selection and lost acknowledgement. Two native coordinator
cases cover busy-queue fairness and the hosted retry deadline. The
actual Worker cron/Queue case demonstrates both a verified historical
association and an unassociated absence, with unchanged credential
ciphertext and no requests beyond the independent service scans. Six
earlier coordinator regressions and seven managed/access/audit regressions
also passed. Twenty-seven native ingestion/calendar cases passed; the
actual Worker test passed again with source month publication and the
transient admission format enabled. TypeScript, lint, formatting and the
Worker dry-run build passed.

Ownership-aware delivery planning, fresh source proofs, new delivery
ownership/uncertainty, QRZ dispatch, LoTW batch recovery, collection,
restore quarantine and account-preserving cutover remain open. Historical
adoption never creates a delivery attempt or authorizes a vendor write.
