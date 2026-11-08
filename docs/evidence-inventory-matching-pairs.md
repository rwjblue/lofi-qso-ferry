# Scope and initial matching enrollment evidence

Status: local bounded pair enrollment, 2026-11-08. Coverage-range recovery,
ownership-aware planning, coordinator phases and hosted comparison wakeups still
need integration. Runtime activation remains off; no production reset, deployment
or vendor upload occurred.

## Metadata signals

[Migration 0062](../migrations/0062_inventory_matching_pair_jobs.sql) enrolls
source/destination/generation pairs in `inventory_matching_pair_jobs`. Scope
configuration, source-set visibility, destination reactivation and account
recovery reset a job's cursor and advance its work clock. New generations enroll
their own pairs without restarting the active generation's census. Enrollment
requires an eligible source/destination route but not a completed index build.

A source linked before its scope is registered still advances source visibility
and requeues the remaining eligible pairs. Reclassifying a former source also
advances that visibility version. Reopening an account enrolls its current routes,
covering metadata changes made while the account was locked. Query-unrelated
destination labels and template changes do not enqueue a new census.

Unresolved membership uses a separate scope-wide boolean. The first unresolved
source member signals all eligible source pairs; the final resolution signals
them again. Receipt uncertainty signals that destination's pairs. Intermediate
changes while uncertainty remains true do not repeatedly signal a whole log.
The trigger probes at most two entries in the existing unresolved-membership
partial index; confirmation changes do not signal receipt/source enrollment.

Signals only write pair/coordinator metadata. In the native fixture, changing a
source configuration with either one or 205 retained contacts uses **60 reads and
12 writes**, creates no `matching_work` rows and preserves the source checkpoint
and credential envelope. This is one source/destination pair, not a many-scope or
complete-turn capacity measurement. The setup cost scales with eligible pair
count rather than retained contact count.

## Bounded expansion

[Migration 0063](../migrations/0063_inventory_matching_pair_pages.sql) and
`InventoryMatchingPairs` publish at most 200 distinct keys per native transaction.
The keyset merges current non-retired source index entries with current result
references for that exact source/destination pair. Those result references may
come from an older generation or a now-retired/missing source key; they still need
replacement. Queuing such a key does not grant source availability or absence.

The source census has a partial index by tenant, generation, scope, configuration
and record key. Each input contributes at most 201 keys to the bounded merge.
Expansion only selects active-generation pairs whose source and destination
index builds are complete and current. Pending generations retain their jobs
until activation. An incomplete upstream inventory may still produce incomplete
comparisons; an index build is not vendor-coverage proof.

Each page binds its job clock, configuration and source-set versions, prior
cursor, fenced lease and exact key census. One batch stages the page and prior
matching-work versions, admits its complete membership, queues the keys, advances
the cursor and commits an immutable receipt. Native checks reject missing rows,
premature completion, stale authority and newer work at both admission and final
publication. A lost acknowledgement recovers that receipt without finishing a
newer signal or queuing the same page twice.

Pair selection uses a logical last-served turn, retained across signals. Its
maximum comes from an indexed metadata lookup. Two 205-contact destinations take
turns as **200, 200, 5, 5**, rather than requiring one entire census to finish first.
A new signal resets the affected cursor but preserves this fairness position.

An actual Worker reproduces 200/5/idle across three requests, releases its leases,
preserves canonical inventory and credential ciphertext, and creates no ledger
entries or attempts. The publisher does not load or decrypt contact bodies and
makes no external requests.

## Costs and retained history

| Native operation                                                         |                             Measurement |
| ------------------------------------------------------------------------ | --------------------------------------: |
| First 200-key expansion                                                  | 6 statements, 6,352 reads, 1,008 writes |
| One-key warm expansion before/after 5,000 retired keys and 100 old pages |         198 / 198 reads, 12 / 12 writes |
| Configuration signal with one/205 retained contacts                      |           60 / 60 reads, 12 / 12 writes |

These publication counts exclude selector, lease, preparation and receipt reads.
They are local native D1 measurements, not hosted latency or initial-sync duration.
Queued matching-work rows and staging/receipt rows contribute real billed writes.

The first implementation materialized a union of retained page candidates and
looked for progress among historical pages. The history fixture exposed growing
read costs. Separate source/result candidate ranges and a partial index over only
prepared pages keep current publication independent of that retained history.

The new source-census index adds storage and writes during index backfill. In the
encrypted 2,000-record source sample, 1,949 ordinary entries add 1,949 writes:
source backfill now uses 120 statements, 79,254 reads and **35,696 writes** across
ten pages. The previous coverage-clock capture used 33,747 writes. This comparison
is index-build publication, not the entire ingestion or reconciliation pipeline.

## Encrypted replay and recovery

The isolated replay through 0063 ends in
`23d8c1cd-e2d9-4ac0-9caa-8150093a9d96`. Two fair turns queue 200 source keys for each
destination. Each mixed insert/update page uses six statements, 7,012 reads and
948 writes. The native fresh-row fixture above has a different write mix.

There are 400 matching-work rows: twenty sampled claims complete and 380 remain
pending. Both pair jobs retain their partial frontiers. The private manifest
binds their full job state, two committed page receipts and all 400 staged keys.
A fresh-process reopen reproduces that manifest and validates the guarded work
references alongside 82 projection bodies and the twenty matching claims/results.
The older 0061 capture still reopens without modifying its schema.

The database allocates **16,044,032 bytes**. The increase includes the census
index, additional matching work, pair metadata and publication receipts; it is
not a ready-log storage-density estimate. All 21 private directory entries have
zero group/world access. Credentials, canonical observations and stream
checkpoints remain unchanged; vendor requests and uploads are zero.

The original capture has partial source/context coverage, so the twenty sampled
results remain incomplete and no historical associations are created. This does
not prove complete real-source classification, complete baseline timing or
positive matching against a fully inventoried destination.

Logs are `/tmp/lofi-ferry-matching-pairs-capture.log`,
`/tmp/lofi-ferry-matching-pairs-reopen.log` and
`/tmp/lofi-ferry-matching-pairs-compat.log`. The focused native regression is
`/tmp/lofi-ferry-matching-pairs-focused-final.log`.

## Verification

The inventory regression passes **478 tests**, with no failures, skips or
cancellations, including native Worker execution. TypeScript, lint, formatting
and the Worker dry-run build pass. Logs are
`/tmp/lofi-ferry-matching-pairs-inventory.log`,
`/tmp/lofi-ferry-matching-pairs-types-verified.log`,
`/tmp/lofi-ferry-matching-pairs-lint-verified.log`,
`/tmp/lofi-ferry-matching-pairs-format-verified.log` and
`/tmp/lofi-ferry-matching-pairs-build.log`.

## Remaining work

[Coverage wait points and readiness journaling](evidence-inventory-matching-coverage.md)
now retain the selective recovery input. Complete the event dispatcher and bounded
rematching publisher so a LoTW day wakes affected blocked comparisons without a
whole-log sweep. Coverage-set clocks already reject preparations that missed a
newly added partition; the new input tables do not themselves dispatch work.

Then integrate fair pair/bucket/matching/adoption phases into the durable
coordinator and hosted Queue/cron path. Ownership changes, due holds, source
proofs, new delivery ownership, submission, member recovery, retention/GC,
restore quarantine, storage qualification and the account-preserving cutover
remain unfinished. These isolated pair APIs do not activate automatic exports.
