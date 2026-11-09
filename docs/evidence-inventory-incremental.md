# Incremental inventory comparison evidence

Status: local normalized delta-run qualification through migration 0076,
2026-11-08. Repository runtime activation and exports remain configured off.
The isolated fixtures use native read-only handoff. No deployment, production
reset or vendor upload was performed.

## Workload and boundary

The [pipeline benchmark](../scripts/benchmark-inventory-pipeline.ts) can run up
to twenty incremental rounds after its source and destination baselines finish.
Each round publishes real delta-run begin/page/completion transactions and
drains the real comparison continuation/coordinator through an in-memory Queue.
It retains the prior LoFi policy epoch, advances operation/QSO watermarks
independently and marks delta observations forward. Provider parsing, requests,
pacing, source proofs, adoption and delivery remain outside the measurement.
This is Node application code with native D1/workerd, not billed Worker CPU or
production latency. See the [baseline measurement boundary](evidence-inventory-pipeline.md).

The sequence is an empty poll, an unchanged overlapping source page, one contact
edit, one operation edit, retirement and restoration. Operations contain one
hundred contacts; all contacts have distinct candidate identities. The contact
edit changes a callsign. The operation edit changes a grid overridden by the
QSO's own grid: its input context changes while the resulting operating details
still match. This measures context invalidation, not a correction upload.

The benchmark asserts a current result for every contact after every step, zero
pending matching/selected-input/bucket jobs and no scheduled comparison wakeup.
Empty/stable steps must preserve exact result versions/set IDs and payload/proof
counts. Edits must leave results outside their operation unchanged. Retirement
holds the retired source as incomplete; restoration recovers it automatically.
All runs preserve credential envelopes and create zero delivery attempts.

## Measured work

These are complete normalized delta ingestion-to-comparison costs. Diagnostic
storage/result queries are outside the counters. Every measured explicit SQL
statement includes native row metadata; trigger/index work is included.

| Workload                                                 | Contacts in log | D1 calls | Statements | Rows read | Rows written | Queue turns | Changed results |
| -------------------------------------------------------- | --------------- | -------- | ---------- | --------- | ------------ | ----------- | --------------- |
| Empty poll                                               | 200 / 1,000     | 155      | 205        | 1,493     | 177          | 12          | 0               |
| Unchanged 200-record overlap                             | 200             | 156      | 217        | 12,908    | 1,980        | 12          | 0               |
| Unchanged 1,000-record overlap                           | 1,000           | 156      | 217        | 58,508    | 9,180        | 12          | 0               |
| One contact edit, empty destination                      | 200 / 1,000     | 412      | 523        | 15,076    | 1,604        | 31          | 20              |
| Operation edit affecting 100 contacts, empty destination | 200             | 886      | 1,067      | 85,069    | 8,117        | 66          | 100             |
| Same operation edit                                      | 1,000           | 886      | 1,067      | 85,118    | 8,117        | 66          | 100             |

The unchanged overlap refreshes observation/membership bookkeeping without new
encrypted bodies, projections or match sets. Its row work grows with the supplied
page, while call count stays fixed. The single-contact and operation edit costs
stay close across 200- and 1,000-contact logs. The matcher intentionally replaces
whole captured cohorts, so a one-contact change can rewrite twenty result pointers.
These are individual measurements; small native read-count variation occurs.

## Bucket job amplification and correction

The matched-destination profile exposed an additional problem after the earlier
selected-input fix. Replacement cohorts could observe a projection change before
its bucket job ran. The pending job then needed an empty page and another
eleven-phase coordinator cycle. The 100-contact operation edit published
**96 empty bucket pages**, even though all affected results were already current.

[Migration 0076](../migrations/0076_inventory_matching_bucket_observed.sql)
completes a bucket job when its last older current dependency is collected during
result replacement. The existing reverse index leads with the bucket identity
and observed clock, so the absence check is bounded. It also handles an old
bucket omitted from the replacement's probes after an identity moves.

Only completion advances. The job's work clock and frontier remain intact.
Any surviving older cohort prevents this shortcut and still requires guarded
bounded expansion. Dependency declarations/census and result publication remain
atomic; a late failure restores both old dependencies and pending completion.
An old prepared page or committed receipt cannot finish a newer signal.

| 100-contact operation edit, matched destination | D1 calls | Statements | Rows read | Rows written | Queue turns | Empty bucket pages |
| ----------------------------------------------- | -------- | ---------- | --------- | ------------ | ----------- | ------------------ |
| Through 0075                                    | 12,736   | 13,417     | 237,259   | 22,332       | 1,097       | 96                 |
| Through 0076                                    | 926      | 1,137      | 137,004   | 13,116       | 66          | 0                  |

Calls fall about 93% and Queue turns about 94%, while exactly the same hundred
results are replaced. Useful bucket expansion remains enabled. Two rounds against
a 200-contact matched inventory finish in **4,218 calls and 308 Queue turns**,
with zero empty bucket pages, unchanged unrelated results and all contacts matched
again after restoration. This is not a legacy-sender or complete-delivery comparison.

## Storage, recovery and remaining costs

Without collection, one empty-destination round against 200 contacts allocates
872,448 additional bytes; two rounds against 1,000 allocate 2,203,648 bytes.
Two matched-destination rounds against 200 allocate 2,691,072 bytes through 0076.
This includes accepted-page/run metadata, superseded bodies/projections and
retained comparison proofs. Removing empty jobs improves execution without making
all retained storage disappear. A bounded collector must preserve current and
pinned inputs, receipt recovery horizons and future adoption/delivery references.
These snapshots do not qualify indefinite retention or sustained daily growth.

Through 0076, an empty poll cost 155 D1 calls and twelve comparison Queue turns
even with no changed results. The later [checkpoint-only delta measurements](#checkpoint-only-deltas)
separate the cost of publishing the reader state from the comparison work.

Seven new native cases cover full/partial cohort replacement, a disappeared old
bucket, old prepared pages, late rollback, later signals and committed-receipt
recovery. Publication remains below 2,000 reads with or without 4,000 unrelated
completed jobs. The combined bucket/selected-input/actual Worker regression passes
14 cases. TypeScript, lint, formatting, task validation and the dry-run build pass.

The private encrypted replay through 0076 is
`c823947a-042f-4c60-9814-0c653f2d0870`. It reopens in a fresh process with canonical
inventory, checkpoints and credentials unchanged, zero new HTTP requests/uploads
and a valid retained comparison wakeup. It allocates 17,285,120 bytes. Its source
and QRZ baselines remain partial, so it does not establish full real-service timing.

## Checkpoint-only deltas

[Migration 0107](../migrations/0107_inventory_delta_comparison_wakeups.sql)
keeps the comparison queue parked for empty or unchanged deltas that have no
recovery work. The same transactions publish reader checkpoints, run state and
coverage. Semantic edits, topology and source membership changes still signal
comparison. Restored coverage also signals when a matching recovery event or
projection recovery job is pending.

A 200-contact matched-destination benchmark compared the same coordinator with
and without the migration. Both runs preserved current results and retained
payload and match-set counts for empty and stable polls. The later edits,
retirement and restoration still drained to current results.

| Delta             | D1 calls | SQL statements | Rows written  | Comparison Queue turns |
| ----------------- | -------- | -------------- | ------------- | ---------------------- |
| Empty             | 76 → 23  | 126 → 73       | 106 → 72      | 3 → 0                  |
| Unchanged overlap | 73 → 24  | 134 → 85       | 2,109 → 2,075 | 3 → 0                  |

With 1,000 unchanged records and an empty destination, publication still took
24 D1 calls, 85 statements and zero comparison turns. Observation and membership
bookkeeping grew to 10,075 row writes.

The benchmark used synthetic normalized records and made zero provider calls.
Native tests also interleaved a projection turn with a collecting LoFi delta.
The projection held while coverage was unavailable and recovered once the
retained full selection became ready again. A separate LoTW test confirmed that
an empty delta can wake matching recovery for the retained full selection.

## Reproduction

The [saved measurements](benchmarks/inventory-incremental-2026-11-08.json) retain
stage costs, result changes and storage censuses for six profiles. Earlier profiles
predate the extra bucket-page census; the matched 100-contact pair includes it.

```sh
mise run benchmark-inventory-pipeline --contacts 200 --remote empty --incremental-rounds 1
mise run benchmark-inventory-pipeline --contacts 1000 --remote empty --incremental-rounds 2
mise run benchmark-inventory-pipeline --contacts 100 --remote matched --schema 75 --incremental-rounds 1
mise run benchmark-inventory-pipeline --contacts 100 --remote matched --incremental-rounds 1
mise run benchmark-inventory-pipeline --contacts 200 --remote matched --incremental-rounds 2
```

The `75` option reproduces the bucket-amplification baseline; `74` retains the
earlier selected-input baseline. Default `current` follows the current migrations.
Local wall times are diagnostics affected by concurrent jobs and Node/D1 IPC.
Complete managed real-source trials, retention/GC, larger/dense receipt inventories,
automatic adoption/planning and member-aware delivery remain unfinished.
