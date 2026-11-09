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
