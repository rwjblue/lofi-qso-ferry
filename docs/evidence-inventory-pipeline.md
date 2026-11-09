# Inventory pipeline cost evidence

Initial native D1 qualification used migration 0075 on 2026-11-08.
Follow-up comparisons used migrations 0114 and 0115.
Repository configuration keeps runtime activation off and exports disabled.
Isolated benchmarks/replays perform the read-only runtime handoff. No deployment,
production reset or vendor upload was performed.

## Measurement boundary

The [pipeline benchmark](../scripts/benchmark-inventory-pipeline.ts) starts with
normalized synthetic observations. It includes read-only runtime handoff,
registered source/destination selections, full-run ingestion, membership,
catch-up, quarantine, coverage publication, index construction, encrypted
projection, matching and durable comparison Queue publication/consumption.
Schema installation, fixture credentials and diagnostic storage queries are
outside the counters; runtime enrollment is inside them.

Application code runs in Node against native D1/workerd. Queue messages use an
in-memory transport and the real continuation/coordinator functions. The
separate [actual Worker/Queue test](evidence-inventory-hosted-comparison.md)
checks the hosted boundary with mocked providers. Neither measurement establishes
production latency, billed Worker CPU or actual vendor pacing. Adapters, provider
I/O, authentication renewal, source proofs, adoption and delivery are excluded.

The destination baseline completes before the source baseline. The benchmark
drains comparison after every normalized page, then completes source catch-up
and coverage. This exercises background comparison while source coverage is
incomplete, followed by automatic reprojection and classification. Source pages
contain at most 1,000 records; operations are paged separately, with one operation
per 100 contacts. Destination pages contain at most 250 receipts. Each contact
has a distinct candidate identity and 580 bytes of synthetic notes.

All SQL calls report native `rows_read` and `rows_written`, including trigger
and index work. The shared meter routes `first()` through `all()` on the original
statement, unwraps prepared statements before batches and asserts that every
explicit statement has result metadata. No contact bodies or credentials appear
in benchmark output. Vendor requests, uploads and delivery attempts are zero;
credential envelopes are checked unchanged.

## Empty invalidation amplification

The first complete 200-contact run found 200 empty selected-input publication
pages. Replacement match cohorts had already observed their source changes, but
the coordinator still visited one pending selected-input job per eleven-phase
cycle. That produced 2,388 Queue turns and 27,953 D1 calls.

[Migration 0075](../migrations/0075_inventory_matching_selected_observed.sql)
completes an observed job in the matching publication transaction when no current
dependent has an older signal clock. It probes only the committed cohort's
selected keys, at most twenty. A clock-leading reverse index bounds the absence
check across every current route, including routes that are not presently
eligible. The route-first index remains available for the bounded publisher.

Native guards allow this metadata-only completion only when the work clock,
frontier and fair-turn counter remain unchanged and no older dependent exists.
Partial replacement leaves the old cohort pending. Any older dependent still
uses the existing guarded page publisher. New signals retain their clocks and
requeue normally. Completing a job does not make an upstream observation fresh.

For 200 contacts and an empty destination, this reduces Queue turns from 2,388
to 297 and D1 calls from 27,953 to 3,952, about an 86% call reduction. Empty
selected-input pages fall from 200 to zero. This compares two versions of the
new inventory pipeline, not the legacy sender's complete delivery cost.

## Results

All rows use 1,000-record source pages and one destination. These are complete
normalized ingestion-to-comparison totals, not isolated ingestion statements.

| Contacts | Destination               | D1 calls | Explicit statements | Rows read | Rows written | Queue turns | Allocated growth |
| -------- | ------------------------- | -------- | ------------------- | --------- | ------------ | ----------- | ---------------- |
| 200      | Empty, through 0074       | 27,953   | 29,710              | 529,450   | 52,931       | 2,388       | 3,461,120 bytes  |
| 200      | Empty, through 0075       | 3,952    | 4,709               | 300,964   | 33,803       | 297         | 3,309,568 bytes  |
| 200      | All matched, through 0075 | 5,207    | 6,106               | 484,177   | 52,468       | 396         | 5,328,896 bytes  |
| 1,000    | Empty, through 0075       | 16,700   | 19,359              | 1,479,750 | 165,421      | 1,265       | 16,310,272 bytes |
| 4,000    | Empty, through 0075       | 64,898   | 74,802              | 5,945,852 | 659,335      | 4,928       | 67,334,144 bytes |

The [saved JSON measurements](benchmarks/inventory-pipeline-2026-11-08.json)
retain every stage/phase counter and storage census. At 4,000 contacts, the
benchmark publishes 4,000 current absence results with no empty selected-input
pages. Calls and row work per contact remain close to the 1,000-contact case.

Small read-count variation can occur between native fixtures; exact counts are
individual observations, not universal per-contact constants. The source-first
incomplete/ready transition retains two matching cohorts per twenty contacts
and two source projection bodies per contact. An all-matched destination also
retains receipt payloads and reverse matching evidence. No retention collector
runs in these measurements.

The 1,000-contact case retains 1,010 source records/payloads, 2,000 projection
payloads with 1,000 current projections, 100 match sets, 2,000 captured match
records, 8,000 probe tokens, 1,000 selected dependencies and 1,000 matching-work
rows. All 1,000 current results are `absent_at_inventory`; every selected-input
job is completed without an empty page. The matching-destination case asserts
all results are `matched_existing`, not new delivery ownership.

The initialized schema/fixture occupies 2,658,304 bytes through 0075. The
1,000-contact case allocates an additional 16.3 MB, about 15.9 KiB/contact before
collection. Encrypted inventory and projection envelopes account for 2,419,000
bytes of that growth. Moving envelopes to R2 would leave substantial relational,
index and retained-proof cost. This is a baseline snapshot, not a steady-state
growth forecast or a qualified 200,000-contact density. The all-matched
200-contact case is denser still; receipt and reverse-proof storage matter.
The 4,000-contact empty case allocates 67.3 MB of growth, about 16.4 KiB/contact,
including 9.7 MB of encrypted envelopes. This exceeds the upper edge of the
earlier 4–16 KiB sensitivity range and makes collection a measured requirement.

For budget sensitivity, the paid [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
checked on November 8 includes 25 billion reads and 50 million writes/month,
plus 5 GB storage. Write overage is $1/million. Paid
[Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
includes one million operations/month plus $0.40/million; a successful small
message normally uses three operations. These are shared account allowances.

Uniformly multiplying the 1,000-contact empty baseline by 200 gives about
33.1 million writes, 296 million reads and 759,000 comparison Queue operations
for 200,000 contacts. That is an extrapolated one-time baseline, not a measured
import or a monthly incoming-contact model. It excludes read-continuation
messages, actual provider handling, retries, collection, ownership, proofs,
delivery and Worker CPU. Storage, latency and the
[10 GB per-database limit](https://developers.cloudflare.com/d1/platform/limits/)
need separate qualification even when row-operation allowances appear adequate.

## Comparison timing during a first source scan

The same native fixture ran twice through migration 0114 with 1,000
synthetic contacts and an empty QRZ selection. Both published 1,000
current absence classifications. One run drained comparison after
every source page. The other drained source comparison after the full
LoFi selection had completed catch-up and published coverage.

| Source comparison starts | D1 calls | SQL statements | Rows read | Rows written | Queue turns | Allocated growth |
| ------------------------ | -------: | -------------: | --------: | -----------: | ----------: | ---------------: |
| After each page          |   11,053 |         14,187 | 1,350,886 |      180,319 |         547 | 18,300,928 bytes |
| After coverage           |    5,811 |          7,420 |   838,955 |      127,257 |         274 | 15,314,944 bytes |

Deferring comparison in the fixture reduced projection payloads from
2,000 to 1,000 and match sets from 100 to 50. The interleaved run
materialized incomplete operation context and replaced it when source
coverage became ready. These counts isolate the amount of work
associated with that transition. Deferring comparison also delays
visibility of partial results, which the final-result check does not
measure.

```sh
mise run benchmark-inventory-pipeline --contacts 1000 --remote empty \
  --source-comparison interleaved
mise run benchmark-inventory-pipeline --contacts 1000 --remote empty \
  --source-comparison after-coverage
```

### Automatic deferral for the first LoFi scan

The native projection selectors now leave ordinary LoFi work and
operation fan-out queued until the first full source run publishes
coverage. The publication signals the comparison coordinator through
its existing durable wakeup. Destination projections and work for a
source with already published coverage remain eligible.

Both arms used the schema through migration 0117, the same 1,000-contact
fixture with an empty QRZ selection, and a Queue drain after every
source page. Both published 1,000 current absence classifications.

| Native work                      | Before | With deferral |
| -------------------------------- | -----: | ------------: |
| Source backfill D1 calls         |  2,628 |            94 |
| Source backfill SQL statements   |  3,748 |           164 |
| Source backfill Queue turns      |    103 |             4 |
| Total D1 calls                   |  8,112 |         4,279 |
| Total SQL statements             | 11,052 |         5,684 |
| Total Queue turns                |    364 |           165 |
| Encrypted projection payloads    |  2,000 |         1,000 |
| Match sets                       |    100 |            50 |
| Allocated growth                 | 18,280,448 bytes | 15,376,384 bytes |

Deferral delays provisional source results during the first scan.
The local benchmark counts database and Queue work and excludes vendor
requests and pacing. A separate 200-contact matched fixture passed two
rounds of empty and stable deltas, contact and operation edits,
retirement, and restoration with the same selectors.

### Operation pages without indexed contacts

During the 200,000-contact interleaved run, the first two source pages
created 2,000 operation jobs before the first QSO page. A live audit
found 1,562 completed fan-out receipts with zero children and 438
pending jobs. Each empty job took a lease, an indexed probe and a
guarded receipt. The benchmark drained these jobs between pages.

[Migration 0115](../migrations/0115_inventory_projection_childless_context.sql)
checks for an indexed child in the corresponding generation before
enqueuing an operation context change. Later children receive their own
projection work and use current topology. A topology change still
refreshes any pending operation job, including jobs retained across
the migration.

In the patched 200,000-contact run, the same two operation pages
created zero fan-out jobs. The following audit found 33,000 QSOs
already accepted while source coverage was still collecting. In
the complete 1,000-contact interleaved replay, source backfill used
155 Queue turns and 3,453 D1 calls, down from 185 and 3,951 before the
migration. Both runs classified all 1,000 contacts as absent from
inventory. The large-run observations cover operation enrollment and
early ingestion.

### 200,000-contact source coverage

The migration 0115 run with comparison deferred accepted 200,000 QSOs
and 2,000 operations in 202 normalized source pages. Collection took
196.9 seconds and used 1,815 D1 calls and 9,875 explicit statements.
Native metadata recorded 43,284,543 rows read and 9,066,675 rows
written during collection.

Ready coverage published 338.1 seconds after source enrollment, with
all 202,000 members present at epoch 1. The interval after collection
included catch-up, 1,010 membership pages of 200 rows and terminal
publication. The first ready sample allocated 1.19 GB in SQLite as
comparison began. This qualifies local source coverage on normalized
synthetic pages. Classification was still in progress at the sample.
The timing excludes adapter processing and live provider pacing.

#### Completed deferred comparison

The migration 0115 run finished verification and classification in
8,521.9 seconds after collection. The stage used 50,004 Queue turns,
1,058,170 D1 calls and 1,317,510 explicit statements. D1 recorded
242,066,565 rows read and 16,227,737 rows written. The final SQLite
file occupied 3.21 GB.

The initial final-count query lost its D1 connection after the work
drained. A read-only audit of the retained SQLite file checked freshness
once per match set and confirmed all 200,000 classifications as current
`absent_at_inventory`. Both source and receipt coverage were ready,
and the run recorded zero dispatches. The benchmark now pages that
audit in groups of up to 64 sets for baseline and incremental checks.
The paged query verified the retained database in 157 pages and 22.6
seconds. Its largest page returned 1,280 rows. A fresh 1,300-contact
benchmark and a 100-contact incremental round also passed.

These timings describe synthetic normalized pages and an empty
destination on the migration 0115 pipeline. They exclude live reads and
uploads. The source-coverage timing and the cost of classifying the full
log are separate measurements.

#### Verification when every member is current

[Migration 0116](../migrations/0116_inventory_current_source_quarantine.sql)
lets a full LoFi run finish verification at the partition's final key
when every member agrees with both that run's witness and the current
source facet. The native publication transaction repeats the proof
before advancing the cursor. A missing member or a newer overlapping
observation selects the existing bounded membership pass.

The original 202,000-member run committed 1,011 quarantine receipts.
The interval from catch-up to ready coverage was 137.5 seconds.
A coverage-only rerun through migration 0116 used one quarantine turn,
published all 202,000 members at epoch 1 and passed the foreign-key
check. Catch-up, verification and terminal publication together used
25 D1 calls, 75 statements, 1,212,459 rows read and 82 rows written in
3.9 seconds. Collection took 323.4 seconds in that run under different
concurrent local work. The measured improvement is in the verification
stage.

### Comparison Queue work after source coverage

A coordinator can check several idle phases before reaching matching.
It now commits the matching checkpoint and continues under the same
lease when that sweep found no work. SQLite still validates the
matching, adoption and delivery review rotation. An intervening work
signal resets the idle counter, so the new work gets another sweep.

An established coordinator also reads its control row and generation
pointer together under the lease. The insert is needed only during
initialization. A wake from an overdue deadline checks the observed
work version so a racing signal stays pending.

On the same 1,000-contact normalized fixture through migration 0116,
all runs published 1,000 current absence classifications and retained
50 match sets. These counters cover classification after source
coverage.

| Classification path              | Queue deliveries | D1 calls | SQL statements | Rows read | Rows written |
| -------------------------------- | ---------------: | -------: | -------------: | --------: | -----------: |
| Separate idle and matching turns |              254 |    5,317 |          6,467 |   664,022 |       78,010 |
| Matching after an idle sweep     |              153 |    4,408 |          5,558 |   658,862 |       77,606 |
| Shared lease and control read    |              153 |    4,102 |          5,252 |   659,578 |       77,606 |
| Combined projection selection    |              153 |    4,052 |          5,202 |   659,146 |       77,606 |
| Wrapped key in writer snapshot    |              153 |    3,952 |          5,102 |   659,154 |       77,606 |

The runs had different concurrent local workloads. The measurements
compare database and Queue work.

The projection selector now chooses the due scope and its page in
one query. An SQLite plan from the large benchmark used the ordered
pending-work index for the 20-contact page. The sort covered one
head per eligible scope. Native tests also verified that retained
retired and disabled work did not increase selector reads.

The writer lookup also reads the wrapped comparison key in the same
snapshot as the generation pointers and format. Key identity and
rewrapping tests passed, along with the existing publication fences.

### Native match admission

[Migration 0117](../migrations/0117_inventory_match_guard_indexed_checks.sql)
counts each probe's token classes in one indexed pass. It also seeks
required coverage by the complete partition key and checks the exact
stored reference. Candidate closure and the commit-time authority
check still run. The admission trigger keeps the recovery, coverage
and work checks ahead of the general authority check.

Two private copies of the captured comparison generation republished
the same 400 classifications. Each provider contributed five matched
cohorts and five absence cohorts of 20 contacts. Classification,
selected remote record, statement count and rows written matched
between copies. The credential, coverage and historical association
audits passed, with zero external requests and uploads.

| Captured publication | Original rows read | Indexed rows read |
| -------------------- | -----------------: | ----------------: |
| LoTW                 |            111,391 |           107,263 |
| QRZ                  |            115,128 |           111,468 |

In the separate 1,000-contact fully matched synthetic fixture, the
native admission statement read 227,871 rows before the migration
and 203,558 after it. The full classification stage read 1,234,841
and 1,209,786 rows respectively. Both runs published all 1,000
matches using 4,738 D1 calls and 6,288 statements. The figures
measure local database work.

### Bounded projection body reads

Matching preparation now reads current projection metadata and the
admitted ciphertext in one D1 call. The native query materializes
only metadata to compute the aggregate byte limit. A dense request
returns no ciphertext. The same read snapshot supplies projection
versions, payload identities and envelopes, and the caller still
validates envelope and plaintext sizes.

The two readers prepared the same ten cohorts per provider on a
private copy of the captured log. Each provider contributed 100
matches and 100 absences. The complete matching evidence and selected
remote records agreed for all 400 classifications. Credential and
coverage audits passed with zero external requests or writes.

| Captured preparation | Body queries before → after | Total D1 calls before → after | Rows read before → after |
| -------------------- | -------------------------: | ----------------------------: | -----------------------: |
| LoTW                 |                    36 → 18 |                       94 → 76 |          21,227 → 21,861 |
| QRZ                  |                    40 → 20 |                       99 → 79 |          19,109 → 19,753 |

In the 1,000-contact synthetic matched fixture, the source classification
stage used 4,738 D1 calls before the change and 4,588 after. Rows read
increased from 1,210,564 to 1,219,430. Both runs wrote 131,195 rows,
took 152 Queue turns, and published all 1,000 matches. These are local
counts for the classification stage after source coverage.

### Comparison steps per Queue delivery

The hosted consumer can run up to four durable comparison steps on a
new delivery. It rechecks the wakeup before every step and sends the
final continuation before acknowledging the incoming message. A
redelivery runs at most one step from the latest committed frame.

Both native runs used the same 1,000-contact fixture with an empty QRZ
selection and produced all 1,000 final absence classifications. The
table isolates classification after source coverage.

| Maximum steps per delivery | Durable steps | Deliveries | D1 calls | SQL statements | Rows written |
| -------------------------- | ------------: | ---------: | -------: | -------------: | -----------: |
| 1                          |           153 |        153 |    3,902 |          5,052 |       77,606 |
| 4                          |           153 |         39 |    3,674 |          4,824 |       77,378 |

The Queue fixture counts sends and deliveries without hosted Queue
latency or Worker billing. Run with `--comparison-steps-per-wakeup 1`
or `--comparison-steps-per-wakeup 4` to reproduce. Phase-specific
counters apply to single-step deliveries. A repeat of the four-step
run measured a peak of 120 D1 calls in one comparison delivery. The
profile uses the [Workers Paid D1 invocation budget](https://developers.cloudflare.com/d1/platform/limits/).

### Batched matching maintenance lookups

The comparison coordinator now reads the heads of five maintenance
queues in one D1 batch. Pair enrollment, bucket invalidation, coverage
readiness, coverage expansion and selected-input invalidation each keep
their existing selector. A positive hint still runs the current selector
and uses the child publisher's existing lease and guards. A work signal
after the snapshot resets the coordinator's idle sweep. The native
race fixture queued selected-input work at that boundary and processed
it on the next turn.

In the same 1,000-contact fixture with four steps per delivery, both
runs produced 1,000 final absence classifications in 153 steps and
39 deliveries after source coverage. Classification calls fell from
3,674 to 3,320. Earlier probing and reselecting positive work increased
SQL statements from 4,824 to 5,074 and rows read from 646,296 to 651,225.
Rows written stayed at 77,378. Across the full run the peak fell from
120 to 104 D1 calls in a single delivery. A 200-contact matched fixture
also completed two incremental rounds including contact and operation
edits, retirement and restoration.

### Matching publication preflight

A match publisher now reads the receipt and expected result versions
in one statement. A committed receipt bypasses version lookup. For new
work the guarded publication still checks the captured result and work
versions. A lost acknowledgement can still recover the committed receipt.
The native race test commits a new result after preflight and verifies
that the stale publication rolls back.

Two private copies of the captured log republished 20 cohorts across
LoTW and QRZ. Both produced the same 400 classifications and selected
remote records. New publications used 40 D1 calls in total, down from
60, including their write batches. All 20 receipt replays took one read
each. Write-batch statement and row counts were identical for both
providers. The audit preserved credential envelopes, checkpoints,
coverage and historical associations. The replay made zero external
requests and created zero dispatches.

The 1,000-contact synthetic fixture saved one D1 call for each of its
50 new cohorts. The full classification stage used 3,270 calls, down
from 3,320, and both runs produced all 1,000 results in 39 deliveries.

### Comparison coordinator admission

The coordinator now acquires its lease and reads the control and
generation pointers in one D1 batch. The lease statement checks the
active account and inventory scope. A busy lease still defers the turn.
The fixture checks that ineligible and contended turns leave lease
state intact. [D1 batch semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)

Both 1,000-contact synthetic profiles used one durable step per Queue
delivery. The tables measure classification after source coverage.

| Destination | Turns | D1 calls before → after | SQL statements before → after |
| --- | ---: | ---: | ---: |
| Empty | 153 | 3,498 → 3,192 | 5,252 → 5,099 |
| Matched | 152 | 4,184 → 3,880 | 6,338 → 6,186 |

With the hosted four-step budget, the empty profile classified all
1,000 contacts in 39 deliveries and used 2,964 D1 calls. Its largest
delivery used 93 calls.

Two private copies of the captured log also republished the same 160
classifications in 17 coordinator turns. Each of QRZ and LoTW supplied
40 matches and 40 absences. Both copies retained the same state, reason
and selected remote record for every contact. D1 calls fell from 403
to 369 and statements from 577 to 560. The audit verified credential
envelopes, checkpoints, coverage and historical associations. The replay
made zero external requests and uploads.

### One coordinator lease per comparison delivery

The Queue consumer claims the lease with its first wakeup snapshot.
Later steps reread the durable wakeup, control and generation and
check the same lease before advancing. Each step still commits its
own progress. The worker publishes the last continuation before
acknowledging the delivery. A replacement-lease fixture verifies
that the original delivery retries and leaves the successor intact.

| 1,000-contact profile | Steps | Deliveries | D1 calls before → after | SQL statements before → after |
| --- | ---: | ---: | ---: | ---: |
| Empty, up to four steps per delivery | 153 | 39 | 2,964 → 2,697 | 4,871 → 4,490 |
| Matched, one step per delivery | 152 | 152 | 3,880 → 3,728 | 6,186 → 6,034 |

The four-step fixture peaked at 86 D1 calls in one delivery. A paired
replay on private copies of the captured log republished the same
160 QRZ and LoTW classifications in 17 steps and five deliveries.
D1 calls fell from 397 to 368. The states, reasons and selected records
agreed for all 160 results. Receipt coverage, checkpoints, linked
credentials and historical associations passed the audit. The replay
made zero provider calls and uploads.

### Projection input snapshot

Projection preparation loads the wrapped generation key, then reads the
scope, coverage, selected records, operation and event dependencies, and
admitted payloads in one D1 statement. SQLite measures the deduplicated
ciphertext union before returning any payloads. A context overflow leaves
only the selected bodies eligible for loading. The existing publication
guards still check every captured dependency.

On a private copy of the captured log, both readers prepared the same
400 projections. Their decrypted bodies, states, reasons, dependency
metadata and byte accounting agreed. The audit preserved account
bindings, credential envelopes, checkpoints and coverage. Preparation
made zero writes or provider requests.

| Captured inputs | Records | D1 calls before → after | Rows read before → after |
| --- | ---: | ---: | ---: |
| LoFi | 200 | 60 → 20 | 6,442 → 11,396 |
| LoTW | 100 | 20 → 10 | 850 → 1,505 |
| QRZ | 100 | 20 → 10 | 850 → 1,505 |

Both 1,000-contact pipeline fixtures retained their classifications
and Queue delivery counts. The figures cover the classification stage
after source coverage.

| Destination | D1 calls before → after | Rows read before → after |
| --- | ---: | ---: |
| Empty, up to four steps per delivery | 2,697 → 2,497 | 650,123 → 660,116 |
| Matched, one step per delivery | 3,728 → 3,528 | 1,223,724 → 1,233,373 |

The byte-bound fixture recorded zero ciphertext rows for an oversized
cohort and one for a smaller eligible cohort.

### Matching metadata snapshot

Matching preparation now batches the bounded scope and selected-record
reads against the same comparison domain version. The native publication
guards still check the prepared dependencies.

A paired replay prepared 80 LoTW and 80 QRZ decisions from a write-locked
copy of the personal log, split evenly between matches and absences
for each provider. Both readers produced identical decisions, proof
dependencies and input statistics. The replay preserved the account
bindings, credential envelopes, checkpoints and coverage. It made zero
database writes during preparation and zero provider requests.

| Captured inputs | Records | D1 calls before → after | SQL statements | Rows read |
| --- | ---: | ---: | ---: | ---: |
| LoTW | 80 | 32 → 28 | 32 | 8,881 |
| QRZ | 80 | 35 → 31 | 35 | 8,118 |

The native 1,000-contact profiles retained all classifications and
their delivery counts. The figures cover classification after source
coverage.

| Destination | D1 calls before → after | SQL statements | Queue deliveries |
| --- | ---: | ---: | ---: |
| Empty, up to four steps per delivery | 2,497 → 2,447 | 4,290 | 39 |
| Matched, one step per delivery | 3,528 → 3,478 | 5,834 | 152 |

### Matching work admission

One native batch claims the destination lease and reads up to 20 due
work rows under its token. A contested claim returns neither a lease nor
work rows. The existing holder can release its lease and the next turn
can publish the pending work. Matching still uses the same native
publication and release guards.

On two write-locked copies of the captured personal log, both runners
republished the same 160 QRZ and LoTW classifications with identical
reasons and selected receipt identities. Eight cohort publications and
an idle check used 107 D1 calls before batching and 99 after. Both used
217 statements and wrote 13,410 rows. The updated runner read eight
additional lease rows. Credentials, checkpoints, coverage and historical
associations passed the audit. The replay made zero provider requests.

| 1,000-contact profile | D1 calls before → after | SQL statements | Queue deliveries |
| --- | ---: | ---: | ---: |
| Empty, up to four steps per delivery | 2,447 → 2,397 | 4,290 | 39 |
| Matched, one step per delivery | 3,478 → 3,428 | 5,834 | 152 |

### Adoption checks during result publication

Historical adoption triggers now skip inserts and replacements outside
the matched state. Replacing a matched result still reconciles its
pending adoption. The native commit guard checks eligible work for the
current set directly. A missing matched job still rolls back the set.

The 1,000-contact empty-destination profile read 656,787 rows during
classification, down from 660,166. The result upserts and set commits
accounted for 3,241 of the saved reads. Both profiles published 1,000
current absences with 2,397 D1 calls and 4,290 statements. The matched
profile published 1,000 matches and read 1,232,740 rows, down from
1,233,861, with the same 3,428 calls and 5,834 statements. Wall-clock
samples ran with different concurrent local workloads.

The paired captured-log replay republished 160 decisions on private
write-locked copies. It preserved every state, reason and selected
receipt, plus credentials, checkpoints, coverage and historical
associations. Reads fell from 110,633 to 110,241 with the same calls,
statements and writes. The replay made zero provider requests or
uploads.

### 20,000-contact local pipeline

The build before matching metadata batching ran 20,000 normalized
contacts against an empty destination with comparison deferred until
source coverage. Source backfill and verification used 193 D1 calls,
1,073 statements and 11.8 seconds. Classification then used 49,281 D1
calls, 85,036 statements and 507.1 seconds. It took 3,003 steps across
751 deliveries. The largest delivery used 86 D1 calls.

The final paged audit checked 20,000 current absence classifications.
SQLite allocated 322,732,032 bytes. The benchmark made zero provider
requests or uploads. The timing describes the local fixture under
concurrent workloads and excludes vendor pacing and hosted latency.

Repeating the same profile after metadata and lease batching, through
migration 0121, verified the same 20,000 current classifications.
Classification used 47,281 D1 calls and 85,036 statements across the
same 751 deliveries. The largest delivery used 80 D1 calls. The
instrumented classification stage took 514.1 seconds and recorded
13,197,007 rows read and 1,542,363 rows written.

| Statement family | Executions | Rows read |
| --- | ---: | ---: |
| Match result upsert and triggers | 1,000 | 2,257,334 |
| Match admission guard | 1,000 | 2,097,672 |
| Match set commit and triggers | 1,000 | 1,560,888 |
| Delivery review publication | 1,000 | 1,188,972 |

Native SQL time was 48.4 seconds across classification. Timing also
includes workerd binding overhead, Queue coordination and application
preparation in the local runner. Both audits used 16 result pages and
recorded zero provider requests and uploads.

### Bucket freshness read order

The shared freshness view now seeks the set and reads its probes before
looking up their tokens. Each probe's search scope is loaded once. The
bucket version comparison, including version zero for missing buckets,
still runs for every token at admission and commit. The same view also
protects current-result reads.

Two private copies of the captured log republished the same 160 LoTW
and QRZ classifications. The updated view read 107,277 rows, down from
110,241, across the same 99 calls and 217 statements. Every result state,
reason and selected receipt agreed. Credentials, checkpoints, coverage
and historical associations passed the audit. The replay made zero
provider requests or uploads.

The two 1,000-contact profiles verified all current classifications
with the same calls, statements, writes and Queue deliveries. The
matched profile also benefits when adoption rechecks the proof.

| Destination | Classification rows read before → after |
| --- | ---: |
| Empty, up to four steps per delivery | 656,787 → 638,628 |
| Matched, one step per delivery | 1,232,740 → 1,172,080 |

### Selected source projection snapshot

The selected-record snapshot also admits its source projection bodies.
SQLite sums the encrypted sizes before returning ciphertext. The shared
decoder verifies the envelope size, encryption binding, body state and
remaining plaintext budget. Candidate reads spend the remaining cohort
budget, and the native publication checks the same dependencies.

The native twenty-pair fixture prepares in seven SQL statements with
forty decryptions and 2,271 data rows read. That row count excludes
comparison key setup.

On the captured personal log, both readers prepared the same 160 QRZ
and LoTW decisions, dependency records and byte totals. The updated
reader used 51 D1 calls and 59 statements, down from 59 and 67, and
14,279 row reads, down from 16,999. The preparation made zero database
writes or provider requests.

Both 1,000-contact profiles verified all current classifications and
saved one call and statement per matching cohort. Delivery counts stayed
at 39 for the empty profile and 152 for the matched profile.

| Destination | D1 calls before → after | SQL statements before → after | Rows read before → after |
| --- | ---: | ---: | ---: |
| Empty, up to four steps per delivery | 2,397 → 2,347 | 4,290 → 4,240 | 638,628 → 621,915 |
| Matched, one step per delivery | 3,428 → 3,378 | 5,834 → 5,784 | 1,172,080 → 1,154,767 |

### Matching generation snapshot

Matching now reads the wrapped comparison key, scope metadata and
selected inputs in one batch. Both input statements use the active
generation from that snapshot. Later probes and publication still
check the captured domain and generation.

The twenty-pair fixture prepares in five D1 calls and seven SQL
statements. On the captured personal log, both readers prepared the
same 160 decisions, proof dependencies and input byte counts. D1
calls fell from 51 to 43, with 59 SQL statements and 14,279 row reads
in both runs. Preparation made zero database writes or provider
requests.

The empty 1,000-contact profile used 2,297 D1 calls for classification,
down from 2,347. The matched profile used 3,328, down from 3,378.
Both retained their classifications, statement counts and Queue delivery
counts.

## Recovery and boundedness

Six new native cases cover complete replacement, a surviving old sibling cohort,
old prepared pages, a later signal, late transaction rollback and recovery of a
committed match receipt after a newer signal. A publication reading 1,091 rows
continues to read 1,091 after adding 4,000 unrelated completed jobs. The existing
selected-input publisher/map suite covers bounded expansion and missing/retired
identities; the combined selected-input regression passes 33 cases. The actual
hosted Worker test passes through the new migration. TypeScript, project lint,
formatting, task validation and the Worker dry-run build pass.

The encrypted real-source replay through 0075 is
`4982f3ee-d7e6-486f-8801-55d36b2da5b4`. A fresh process reopens its private copy,
with canonical inventories, checkpoints and credential envelopes unchanged. It
allocates 17,268,736 bytes and retains the valid read-only comparison wakeup.
The original captured source and QRZ baselines remain partial. Replaying them
makes zero vendor requests and does not qualify complete real-source throughput.

## Reproduction and remaining work

```sh
mise run benchmark-inventory-pipeline --contacts 200 --remote empty --schema 74
mise run benchmark-inventory-pipeline --contacts 200 --remote empty
mise run benchmark-inventory-pipeline --contacts 200 --remote matched
mise run benchmark-inventory-pipeline --contacts 1000 --remote empty
mise run benchmark-inventory-pipeline --contacts 4000 --remote empty
```

The `74` option pins the pre-optimization migrations. The default follows the
current migration set. JSON output includes phase costs, stage costs, storage
counts, allocated bytes and the boundary exclusions. Local wall time is a
diagnostic only; parallel local jobs and Node-to-D1 IPC affect it.

Next qualify larger matching receipt inventories, repeated incremental
edits, dense/shared candidate buckets and retention. A larger complete managed
read-only service trial must then include real adapter requests and pacing.
Automatic adoption scheduling, ownership-aware planning, fresh source proofs
and member-aware delivery remain separate implementation milestones.

[Incremental qualification](evidence-inventory-incremental.md) now covers
empty/stable polls, contact/operation edits and retirement/restoration through
0076. It found and removed a second empty bucket-job amplification. Larger and
complete real-source qualification, retention and delivery remain open.
