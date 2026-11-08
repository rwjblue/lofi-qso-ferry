# Matching coverage wait-point evidence

Status: local coverage wait points and readiness journaling, 2026-11-08. The
dispatcher and bounded rematching publisher are still missing; this is not yet
automatic coverage recovery. Runtime activation remains off. No deployment,
production reset or vendor upload occurred.

## Current wait points

[Migration 0065](../migrations/0065_inventory_matching_coverage_recovery.sql)
stores immutable `inventory_match_recovery` declarations with each comparison
cohort. Only current incomplete results materialize their declarations in
`inventory_matching_coverage_dependents`. Replacing the last incomplete result
for a cohort/source route removes those current entries while retaining the
original proof. Permanent source-shape/operating-detail holds do not subscribe to
unrelated successful coverage polls.

A receipt comparison subscribes to one currently missing UTC day. Covering a
historical time window requires every day in its precision-aware interval, so
the comparison cannot become complete until this chosen day completes. A fresh
comparison then observes the entire window again and subscribes to any remaining
gap. Near-midnight contacts therefore need one active day wait point rather than
two. Tests cover both completion orders and moving the current wait point to the
remaining gap when the subscribed day completes first.

A source wildcard handles a different case: collecting coverage can temporarily
hide a formerly ready projection. An unchanged full scan or delta can restore it
without publishing another projection version. A missing full census of another
registered source also needs a wildcard, even when that other log is empty and
never produces a contact projection. Source configuration/visibility and global
membership-uncertainty transitions remain the separate pair-job mechanism.

The namespace uses the stable tenant comparison key, logical scope and a
versioned calendar prefix. It is separate from QSO-candidate hashes and does not
depend on a comparison generation or a credential/KEK version. A day has 23 opaque
ancestor hashes. An inclusive range over years 0001–9999 decomposes into at most
44 disjoint prefix hashes, with no per-day range enumeration. Dates and calendar
coordinates remain in memory; only opaque paths and selected-record references
enter comparison manifests.

Shared ancestors deduplicate within each cohort/source route. The reverse index
starts with tenant, generation, interest scope/facet and node hash, then
destination/source route, captured coverage clock and set ID. The next publisher
must enumerate eligible routes before probing that index so disabled/retired
history does not become a current-data scan.

## Native publication and scope clocks

[Migration 0064](../migrations/0064_inventory_matching_result_update.sql)
also binds result updates to their exact newly admitted set. A separate
interrupted preparation for the same contact cannot lend its authorization to
an older committed result. Native tests preserve such an admitted preparation,
reject the mismatched update and keep the original result unchanged.

New comparisons declare their recovery count, including zero. Admission requires
coverage-gap declarations for the relevant incomplete rows and missing source
censuses, validates subjects, provider/facet bindings and path shapes, and closes
the declarations. Each current index entry points to an exact declaration and
path position and carries the matching scope's captured coverage clock.

Final commit verifies every required current entry. Native tests reject omitted
or malformed declarations, missing materialized nodes, altered header counts and
late coverage changes, with complete rollback. Read-only legacy snapshots cannot
publish against this schema. The trusted encrypted projection/matching processor
computes the calendar hashes; SQL enforces their declared shape, references and
publication boundaries rather than recomputing HMACs over plaintext dates.

The existing coverage-set clock fences a new partition appearing after
preparation, including when no wait point existed at the readiness edge. It is
still not part of ready-result invalidation. Unchanged successful verification
can restore the original valid ready result without forcing a full rematch.

## Readiness journal

`inventory_matching_coverage_events` coalesces ready transitions by scope,
stream, facet and query partition. It records the published full run, current
configuration and coverage version, without enumerating contacts. It journals
only when current interests exist or an older event still needs completion.
Confirmation coverage and ordinary page bookkeeping do not create these events.

A delta restoring readiness retains the original published full run. In the
native LoTW test, recovery refers to that full selection rather than the delta's
receive filter. Source events require a complete operations/QSO full census;
receipt events require a complete provider selection with the relevant catch-up
contract.

The future dispatcher must read the post-transaction scope clock and validate it
at publication. The journal deliberately does not infer that clock from the
order of independent AFTER triggers. Event completion is currently rejected by
a native guard until the fenced dispatcher is installed.

## Costs and verification

| Native comparison operation                             |                               Measurement |
| ------------------------------------------------------- | ----------------------------------------: |
| One blocked receipt day                                 |      11 statements, 546 reads, 133 writes |
| Twenty blocked days                                     |    11 statements, 7,088 reads, 859 writes |
| Shared paths in that twenty-day cohort                  | 460 declared prefixes, 62 current entries |
| Warm single-day replacement before/after 100 old proofs |         654 / 654 reads, 155 / 155 writes |

These are publication costs without matching-work claims or bucket dependency
maps, not complete-turn or hosted latency measurements. A separate 500-proof
audit confirmed the same bounded warm behavior before the final guard
optimization. The native source-requirement query plan uses indexed searches;
its remaining scans visit only the small required-stream JSON arrays.

The first final guard repeated each receipt path check for every selected row
from the same source. Binding it directly to its declared subject reduces the
twenty-day publication from 24,968 to 7,088 reads. This changes no coverage rule.
The index adds real storage/write cost during partial coverage. These small
fixtures do not qualify peak incomplete-log storage for 200,000 contacts.

An actual Worker creates the 62 current entries for twenty incomplete contacts.
After a complete date selection, a second explicit matching request produces
twenty inventory-absence observations and collects the entries. It preserves
source inventory/credential ciphertext, creates no attempts and makes no vendor
requests. This test explicitly rematches; it does not prove automatic dispatch.

The inventory regression passes **503 tests**, including calendar range geometry,
cross-midnight ordering, empty reverse-source census, unchanged source/delta
restoration, permanent-shape holds, native rollback and Worker execution.
TypeScript, lint, formatting and the Worker dry-run build pass. Logs are
`/tmp/lofi-ferry-coverage-recovery-inventory.log`,
`/tmp/lofi-ferry-coverage-recovery-focused-verified.log`,
`/tmp/lofi-ferry-coverage-recovery-midnight-orders.log`,
`/tmp/lofi-ferry-coverage-recovery-types-checked.log`,
`/tmp/lofi-ferry-coverage-recovery-lint-checked.log`,
`/tmp/lofi-ferry-coverage-recovery-format-checked.log` and
`/tmp/lofi-ferry-coverage-recovery-build.log`.

## Encrypted replay

The isolated three-provider replay through 0065 ends in
`6e3308c2-6fcc-47a7-9beb-21cec803f408`. Its two cohorts declare recovery tracking,
but their twenty source-context holds require projection recovery rather than
date wait points. There are zero declarations, current nodes or pending coverage
events and zero invalid current references. This is not a positive real-data
coverage-dispatch trial.

The replay retains the 400-reference pair-enrollment sample, twenty completed
matching claims and 380 pending items. It preserves canonical inventory,
checkpoints and credentials, makes zero vendor requests/uploads, and allocates
**16,093,184 bytes**. All 21 private directory entries have zero group/world
access. Older 0063 captures still reopen without changing their schemas.

Logs are `/tmp/lofi-ferry-coverage-recovery-capture.log`,
`/tmp/lofi-ferry-coverage-recovery-reopen.log` and
`/tmp/lofi-ferry-coverage-recovery-compat.log`. Full real-source coverage,
initial-sync timing and ready-log storage density remain unproved.

## Remaining work

Implement a fenced event dispatcher and coalesced prefix jobs, then a bounded
publisher over eligible current routes/cohorts. An old event must skip
comparisons prepared at or after its captured scope clock; late signals and lost
acknowledgements must leave newer work pending. Whole-log recovery per completed
LoTW day remains disallowed.

Also separate projections held for missing full-source coverage from those held
for missing/unresolved operation/event context. The existing projection-coverage
job currently uses the same reason for both and can revisit permanent context
holds after an unchanged full scan. Narrow that recovery before activation.

Then integrate coverage, pair, bucket, matching and conservative adoption phases
with the durable coordinator/hosted wakeups. Ownership-aware planning, source
proofs, delivery ownership/submission, member recovery, GC, restore quarantine,
storage qualification and the account-preserving cutover remain unfinished.
