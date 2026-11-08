# Bucket invalidation evidence

Status: local current-dependency indexing and bounded bucket invalidation,
2026-11-08. Scope/coverage/connection/ownership invalidation, initial enrollment
and coordinator/hosted integration remain unfinished. Runtime activation is off;
no production reset, vendor upload or deployment was performed.

## Current dependencies and clocks

[Migration 0059](../migrations/0059_inventory_live_bucket_dependencies.sql) tracks
current result references in `inventory_match_live_sets`. Each cohort registers
deduplicated forward/reverse bucket dependencies in
`inventory_matching_bucket_dependents`. Entries point to an exact captured probe
and token through tenant-scoped foreign keys. Native publication checks that every
captured bucket has an entry, including unknown and expected-empty domains.

Partial result replacement decrements the old cohort's reference count. Its
scheduling entries remain until its final current reference leaves, then are
removed atomically. The original immutable matching proof remains retained under
its existing receipt/association rules. Superseded proof history is not part of
the reverse scheduling index.

Bucket-version insertion/update signals current dependents of the old/new hashes.
Projection-version changes signal their bucket even when its logical hash and
semantic bucket version stay unchanged. A source retiring from the comparison
index queues its own selected key, since it may never publish another projection.

Signals coalesce in `inventory_matching_bucket_jobs`. They use a separate monotonic
work clock; current-generation clocks cannot be deleted and recreated. A signal
with no current dependents creates no job. This avoids queuing an empty continuation
for every hash during a fresh initial census. Expected-zero dependencies still
receive the first later signal when their first record appears.

A new comparison records the bucket job's current clock when registering its
dependencies. Pending invalidation processes only entries older than its captured
clock. A comparison already recomputed after that signal needs no additional work.
The reverse index orders the clock before the cohort ID, so skipping current
observations does not scan all newer cohorts.

These tables populate through new result publication. The fresh-database cutover
installs them before the first comparison. Existing derived results would require
an explicit rebuild; this migration does not perform an unbounded backfill.

## Bounded publication

[InventoryMatchingInvalidations](../src/inventory-matching-invalidations.ts) selects
one current eligible scope's indexed job head and takes a fenced bucket lease.
[Migration 0060](../migrations/0060_inventory_matching_bucket_pages.sql) publishes
at most ten dependent cohorts and **200 current result references** per page.
Only still-referenced members with currently eligible source/destination routes
are queued. Other members may already belong to a newer result cohort.

Six explicit statements share one native batch: choose/store the exact range,
stage current members and expected work versions, close admission, enqueue work,
advance the job frontier, then commit its immutable receipt. Native guards verify
the complete dependency range, routed member census, expected work versions and
each resulting increment. Lease, configuration, generation and job-clock checks
remain active through final commit. A complete prefix cannot omit its suffix.

The frontier is `(observed_clock, cohort_id)`. New result publication can remove
old entries, but cannot insert a newly current entry behind a running frontier:
it records the current clock and falls outside that older work range. A newer
signal resets the frontier and invalidates older preparations. Lost receipt
acknowledgements recover the old page without clearing or duplicating newer work.

This only schedules local comparison. It does not renew upstream evidence, adopt
history, grant ownership, prepare an attempt or authorize a vendor write.

## Native behavior and costs

The tests demonstrate an expected-empty destination becoming a historical match,
an existing destination moving out of the tolerance interval, and a reverse
competitor moving from 14:01 to 14:00 around a 13:30 receipt. That last change
requeues a different selected 13:00 source and changes its former unique match to
ambiguous. It cannot be detected by only watching the selected source's buckets.

A 220-contact fixture stores eleven current cohorts. One destination signal
expands as 200 references from ten cohorts, then twenty references from the last
cohort. A new API instance resumes from the stored frontier. An actual Worker
reproduces those turns across requests, releases its leases, preserves source
checkpoints/credential ciphertext and makes zero external requests. It creates
no ledger entries or upload attempts.

| Native operation                                               |                              Measurement |
| -------------------------------------------------------------- | ---------------------------------------: |
| Expand 200 references                                          | 6 statements, 14,301 reads, 1,007 writes |
| Signal before/after 100 retained superseded proofs             |              15 / 15 reads; 3 / 3 writes |
| Empty old-clock expansion with one/100 already-current cohorts |                            82 / 82 reads |
| Idle selector with/without 5,000 retired pending jobs          |                            15 / 15 reads |

These are local native D1 measurements, not hosted latency, complete-turn costs or
full-log throughput. Many-scope and date-partition qualification remain separate.

The reverse index adds real publication work. Twenty unique source/receipt pairs
deduplicate 320 captured tokens into 168 current entries. Replacing that cohort
uses approximately 13,100 reads and 1,808 writes, with the existing fourteen
explicit work/result statements. Its first publication uses 12,017 reads and
1,640 writes. The earlier comparison-only/current-work
measurements exclude these new scheduling entries. A first implementation scanned
captured tokens to validate each entry and used about 39,000 reads; exact probe/
token foreign keys eliminate that scan without another retained-token index.
The complete-cohort six-binding-call target remains unmet.

In the same encrypted sample, the first 2,000-record source index backfill rises
from 75,347 to 79,248 reads for the conditional dependency checks. It still uses
120 explicit statements across ten pages and 33,747 writes, with no empty bucket
jobs created. This is index-build publication, not a complete ingestion or sync
cost.

Native rejection tests cover omitted fallback dependencies, missing queued rows,
premature completion, forged/deleted live references, expired leases, scope changes,
late account locks, late signals, late work invalidation, SQL rollback and lost
acknowledgements. Source retirement also requeues a key without requiring another
source projection; the resulting missing source remains incomplete.

## Encrypted capture replay

The isolated three-provider replay installs migrations through 0060 before any
comparison publication. Its twenty incomplete results have two live cohorts and
twenty current references. Their unfinished source context produces no forward/
reverse probes, so there are zero bucket dependencies and zero pending bucket
jobs. The sampled invalidation turn is correctly idle. This is not evidence of
complete vendor coverage or a real-data positive bucket expansion.

The replay still validates 82 encrypted projection bodies and twenty captured work
completions, with 100 matching jobs pending. Canonical inventory, checkpoints and
credentials remain unchanged, and vendor requests/uploads are zero. Reopening also
checks current reference counts, committed set bindings and complete bucket-index
membership. Older captures without these tables remain readable.

The private directory ends in `0cda8d08-9884-4cd0-a8c4-69884f0a7e51` and allocates
**15,556,608 bytes**. Its empty bucket index cannot establish ready-log storage
density. Logs are `/tmp/lofi-ferry-matching-invalidation-capture.log`,
`/tmp/lofi-ferry-matching-invalidation-reopen.log` and
`/tmp/lofi-ferry-matching-invalidation-compat.log`.

## Verification

The final inventory regression passes **451 tests**, including the actual Worker,
with no failures, skips or cancellations. TypeScript, lint, formatting and the
Worker dry-run build pass. Logs are
`/tmp/lofi-ferry-matching-invalidation-inventory.log`,
`/tmp/lofi-ferry-matching-invalidation-types-verified.log`,
`/tmp/lofi-ferry-matching-invalidation-lint-verified.log`,
`/tmp/lofi-ferry-matching-invalidation-format-verified.log` and
`/tmp/lofi-ferry-matching-invalidation-build-verified.log`.

## Remaining work

Add bounded invalidation for scope/source-set/connection/coverage changes and
ownership-aware planning, plus initial enrollment for preexisting projections.
Then integrate fair invalidation/matching turns, due holds and conservative
historical adoption into coordinator/Queue/cron recovery. This bucket path alone
does not make reconciliation fully automatic.

Large ready-log storage and complete-turn throughput still need measurement.
The current reverse index consumes metadata space even if full payloads later
move to R2. Retention/GC, restore quarantine, source proofs, delivery ownership,
QRZ submission, LoTW member recovery and account-preserving cutover remain
unfinished.
