# Matching coverage recovery evidence

Status: local coverage wait points, readiness journaling, guarded prefix dispatch,
bounded rematching publication and automatic local coordinator recovery,
2026-11-08. Hosted comparison Queue/cron wiring remains unfinished. Runtime
activation remains off. No deployment, production reset or vendor upload occurred.
The [selected-input audit](#selected-input-invalidation-gap) below exposes a
separate edit-recovery gap that must be fixed before activation.

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

The dispatcher reads the post-transaction scope clock and validates it at
publication. The journal deliberately does not infer that clock from the order
of independent AFTER triggers. Event completion requires a fenced native
dispatch receipt.

## Guarded prefix dispatch

[Migration 0067](../migrations/0067_inventory_matching_coverage_dispatch.sql) and
[InventoryMatchingCoverageEvents](../src/inventory-matching-coverage-events.ts)
turn a ready selection into at most 44 coalesced prefix jobs. Source recovery uses
one wildcard. Receipt recovery hashes the original full run's date range; delta
receive filters never replace that range. A date prefix may select contacts with
other station/worked-call restrictions. These are scheduling hints: fresh
comparison still enforces the exact selection and never inherits write authority.

Dispatch enumerates eligible active-generation source/destination routes before
probing current dependencies with their destination/source prefix. A node needs
work only if a current interest predates the captured scope clock. Overlapping
events at the same clock share the existing job. A later clock advances its work
version and resets its frontier while preserving prior completion.

One explicit INSERT admits the event, queues the exact needed prefixes, completes
only its captured event version and commits an immutable receipt. Admission and
final guards bind the account/connections, configuration, ready scope builds,
active generation/key, domain/source roster, full selection, coverage version,
scope clock and lease. Missing jobs and late authority changes roll back the
entire transaction. Lost acknowledgements recover the original job count without
completing newer events. Native event/job progress cannot bypass these guards.

Twenty distinct blocked days dispatch six prefixes with **one statement, 831
reads and 29 writes**, with zero contact work changes. A warm single-day dispatch
uses **198 reads and eight writes** both before and after 100 retained receipts;
there remains one current coalesced job. Query-plan checks require the reverse
map lookup to include destination/source equality before its clock range.

The focused suite passes 26 tests across QRZ catch-up, LoTW full/delta selections,
unchanged source restoration, overlapping events, disabled routes, native races,
suppressed jobs, SQL rollback, lost acknowledgements and an actual Worker. The
Worker dispatches prefix jobs before an explicit second matching request; it
does not prove automatic rematching. No vendor requests or attempts occur.
Logs are `/tmp/lofi-ferry-coverage-dispatch-verified.log`,
`/tmp/lofi-ferry-coverage-dispatch-history.log` and
`/tmp/lofi-ferry-coverage-dispatch-worker.log`.

## Bounded prefix expansion

[Migration 0068](../migrations/0068_inventory_matching_coverage_pages.sql) and
[InventoryMatchingCoverage](../src/inventory-matching-coverage.ts) queue at most ten
current incomplete cohort/routes and 200 contact references per native batch.
The frontier is `(destination, source_scope, seen_clock, set_id)`. Each eligible
route probes at most eleven indexed dependencies before the results are merged;
a global sort cannot first enumerate a whole current log. Native range and
remaining-work guards use the corresponding route and clock bounds.

Admission, exact row/configuration census, queued-work versions, fair job turn,
frontier advancement and immutable receipt share one transaction. Row validation
point-probes the exact current match/dependency reference. Configuration is checked
once per distinct route. Prepared-page guards have a partial index and cannot
walk committed proof history. Missing/forged members, ignored work and late
account/configuration/roster/signal changes roll back the entire publication.
Lost acknowledgements recover the original receipt without finishing newer work.

A 205-reference fixture publishes 200 then five references. The first publication
uses **six statements, 6,231 reads and 1,010 writes** before coordinator commit
wakeups. The initial row guard repeatedly enumerated cohorts and used 57,187
reads; exact reference validation and distinct-route checks remove that repeated
work without weakening the census. Single-reference publication before/after 100
retained pages uses **367 / 367 reads and twelve / twelve writes**.
With the 0069 commit wake included, the 200-reference publication uses **6,233
reads and 1,012 writes**, still six statements. These are publication-only native
counts, excluding selection, preparation and leases; they are not hosted latency
or initial-sync measurements. Log:
`/tmp/lofi-ferry-matching-coordinator-publication-cost.log`.

An old job with one versus 101 current observed cohorts reads **348 / 352 rows**
and queues only the older reference. New comparisons at or after its signal clock
are skipped. Disabled routes are excluded before dependency probes. A second
pending node gets a turn before a large node's continuation. Query-plan checks
require destination/source reverse-index predicates and exact-set row validation.
The focused native and Worker tests cover 28 cases. Logs are
`/tmp/lofi-ferry-coverage-pages-verified.log` and
`/tmp/lofi-ferry-coverage-pages-history.log`.

## Automatic local coordination

[Migration 0069](../migrations/0069_inventory_matching_coordinator.sql) widens the
metadata control to ten phases. Pair enrollment, bucket invalidation, coverage
dispatch, prefix expansion and matching now run alongside index/projection work.
One bulk enqueue or committed cohort wakes the coordinator once, including a
200-reference prefix publication. Individual contacts do not each update the
control row. Capacity holds retain their next retry deadline when the control
parks; a due deadline restarts its phase cycle. See
[coordinator evidence](evidence-inventory-coordinator.md#unified-matching-coordination).

An actual Worker initially enrolls and compares 41 inventoried contacts without
an explicit comparison request. Completing their missing receipt selection wakes
the parked control, dispatches the prefix, expands the incomplete cohorts and
produces 41 inventory-absence results with zero pending work/nodes. It preserves
source checkpoints and credential ciphertext and creates zero attempts/vendor
requests. This proves local coordinator recovery, not hosted Queue/cron delivery
or complete real-source inventory. Logs are
`/tmp/lofi-ferry-matching-coordinator-focused.log` and
`/tmp/lofi-ferry-matching-coordinator-worker.log`.

## Selected-input invalidation gap

**Resolved locally by migrations 0070–0072.** See
[selected-input invalidation evidence](evidence-inventory-matching-selected.md)
for automatic edit, retirement and restoration recovery, bounded publication,
current dependency retention, native guards and encrypted replay. The original
failure below explains why this additional scheduling family is required.

An additional edit-after-comparison audit starts with 21 current inventory-absence
results, split into cohorts of twenty and one. Editing the first source contact
and draining the coordinator leaves 21 stored results but only **two current
results**, zero pending matching work and zero pending bucket jobs. The nineteen
siblings in the original cohort stay hidden by their stale shared proof. This is
a recovery/liveness failure; the current-result view does not expose a false
valid result.

Current bucket dependencies cover forward/reverse query probes. They do not
separately index every directly selected source input, including selected keys
that are missing or retired. A source projection wakes its own key, which cannot
repair all remaining result references to its old shared proof. Coverage prefix
recovery deliberately visits incomplete results and does not repair this ready
cohort case.

The correction retains a current reverse map for selected
`(scope, record_key)` inputs, signals changes with bounded metadata, and requeues
all current members of affected cohorts through a guarded publisher. These
identities remain separate from QSO-candidate buckets; no query probe is fabricated.
Missing/retired inputs and cohorts with a member already moved to a newer set
have regression coverage as well. Ingestion signals bounded metadata rather than
fanning out contacts.

The isolated diagnostic is `/tmp/lofi-ferry-selected-cohort-edit-audit.log`.
The expectation that all 21 results recover is reproduced in
`/tmp/lofi-ferry-selected-cohort-edit-regression.log`; it is not covered by the
561 passing repository cases from before the correction. It is now covered by
the selected-input and coordinator regressions.

## Costs and verification

| Native comparison operation                    |                               Measurement |
| ---------------------------------------------- | ----------------------------------------: |
| One blocked receipt day                        |      11 statements, 546 reads, 133 writes |
| Twenty blocked days                            |    11 statements, 7,088 reads, 859 writes |
| Shared paths in that twenty-day cohort         | 460 declared prefixes, 62 current entries |
| Blocked-day replacement across 500 old proofs  |            621–654 reads, 155 writes each |
| Ready-result replacement across 500 old proofs |             484–515 reads, 64 writes each |

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

The result-cost regressions originally compared two individual samples and
failed at 484 versus 515 ready-result reads and 621 versus 654 blocked-day reads.
Statement-level audits across six independent
fixtures reproduced that fixed variation without continuing history growth.
The replacement tests check every publication through 500 superseded proofs
against fixed ceilings: 550 reads/64 writes for one ready result and 700 reads/155
writes for one blocked day. This checks bounded cost without requiring two
samples to take the same successful native path. Leases are renewed between
completed operations so slower machines retain the same test.
Logs are `/tmp/lofi-ferry-result-cost-audit.log` and
`/tmp/lofi-ferry-result-cost-budget-verified.log`, plus
`/tmp/lofi-ferry-coverage-cost-budget-verified.log`.

An actual Worker creates the 62 current entries for twenty incomplete contacts.
After a complete date selection, a second explicit matching request produces
twenty inventory-absence observations and collects the entries. It preserves
source inventory/credential ciphertext, creates no attempts and makes no vendor
requests. This test explicitly rematches; it does not prove automatic dispatch.

The inventory regression passes **561 tests**, including calendar range geometry,
cross-midnight ordering, empty reverse-source census, unchanged source/delta
restoration, projection hold recovery, guarded prefix dispatch/expansion, automatic coordinator recovery, retained-history
cost bounds, native rollback and Worker execution. TypeScript, lint, formatting
and the Worker dry-run build pass. Logs are
`/tmp/lofi-ferry-matching-coordinator-inventory.log`,
`/tmp/lofi-ferry-matching-coordinator-types-current.log`,
`/tmp/lofi-ferry-matching-coordinator-lint.log`,
`/tmp/lofi-ferry-matching-coordinator-format.log` and
`/tmp/lofi-ferry-matching-coordinator-build.log`.

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

The later replay through 0067 is
`2afe419b-dcc9-426a-a871-413505408748`. Its dispatcher remains idle, with zero
receipts/jobs and zero invalid dispatch bindings; the partial source baseline
still requires projection coverage recovery. This is an integration check rather
than a positive real-data dispatch or full initial-sync trial.

A fresh process validates 42 manually prepared/published bodies, twenty projection
job bodies, twenty coordinator bodies, twenty matching results/claims and all 400
pair references. Both coverage state audits recover exactly. The copy allocates
**16,146,432 bytes**, preserves canonical inventory/checkpoints/credentials and
makes zero vendor requests/uploads. Its 21 private entries have no group/world
access. The older 0065 capture still reopens without schema changes. Logs are
`/tmp/lofi-ferry-coverage-dispatch-capture.log`,
`/tmp/lofi-ferry-coverage-dispatch-reopen.log` and
`/tmp/lofi-ferry-coverage-dispatch-compat.log`.

The replay through 0069 is `fd09a2cb-ce7d-4efa-82ec-becc1d014c43`. It preserves the
400-reference pair sample, twenty completed matching claims and 380 pending items.
The four sampled coordinator turns leave a ten-phase control at phase four;
subsequent sampled publications leave wake version 15 versus observed version nine.
The captured control therefore records the final pending signal rather than an
older snapshot taken before those publishers committed.

Coverage dispatch and expansion remain idle because the partial source baseline
still needs projection recovery. Their state audits contain zero invalid bindings
or receipts and recover in a fresh process, alongside 82 derived bodies, twenty
matching results/claims and 400 pair references. This is not a positive real-data
coverage recovery or full initial-sync trial. The copy allocates **16,240,640
bytes**, preserves canonical inventory/checkpoints/credentials and makes zero
vendor requests/uploads. Its 21 private entries have no group/world access. The
0067 capture still reopens without changing its schema. Logs are
`/tmp/lofi-ferry-matching-coordinator-capture.log`,
`/tmp/lofi-ferry-matching-coordinator-reopen.log` and
`/tmp/lofi-ferry-matching-coordinator-compat.log`.

## Projection recovery holds

Projection recovery is now narrowed by
[migration 0066](../migrations/0066_inventory_projection_coverage_holds.sql).
Missing full-source coverage uses `source_coverage_incomplete`; missing/unresolved
operation/event context retains `operation_context_incomplete`. Only the former
enters the partial recovery index. An actual Worker recovers 22 baseline-held
contacts into 21 ready projections and one missing-operation hold. An unchanged
full scan then queues zero contacts and preserves all projection work versions;
later operation arrival still repairs context through the operation job.
Old ambiguous derived holds are rebuilt with fresh state; migration 0066 does
not guess whether the old reason represented missing coverage or context.
The focused native/Worker/projection suite passes 27 tests. Logs are
`/tmp/lofi-ferry-projection-coverage-holds-focused.log` and
`/tmp/lofi-ferry-projection-coverage-holds-types.log`.


## Remaining work

Selected-input invalidation is implemented locally. Connect the coordinator to durable
hosted wakeups, bounded Queue execution and
periodic retry/lost-message recovery. Automatic adoption scheduling and
ownership-aware planning remain separate work. Qualify existing bucket expansion
against large disabled-route maps; its current cohort selection does not yet use
the same route-first reverse index.

Fresh source proofs, delivery ownership/submission, LoTW date discovery/member
recovery, GC, restore quarantine, storage/initial-sync qualification and the
account-preserving cutover remain unfinished.
