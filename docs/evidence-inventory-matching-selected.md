# Selected-input invalidation evidence

Status: local implementation and encrypted capture replay, 2026-11-08.
Runtime activation remains off. Nothing was pushed, deployed, reset in
production or uploaded to a vendor.

## Recovery boundary

The earlier edit audit exposed a liveness gap: editing one of 21 selected
contacts left only two current results after the coordinator parked. The
nineteen siblings still referenced a stale shared proof and had no pending work.
Candidate query buckets did not watch the directly selected source identities.

[Migration 0070](../migrations/0070_inventory_matching_selected_inputs.sql)
adds a current reverse map from selected `(scope, record_key)` identities to
cohorts and their current owner routes. This includes missing and retired inputs.
A selected contact remains a dependency of an old cohort after its own result
moves elsewhere, until the final current member on that route leaves.
Superseded proofs remain immutable; their unused scheduling entries are collected.
Native commit guards require all selected declarations on every current route.

Source index changes signal a versioned metadata job. Ingestion does not enumerate
sibling contacts. The signal clock is local to the selected identity, distinct
from candidate hashes and coverage clocks. New comparisons register the clock
they observed, so an old signal skips already refreshed cohorts.

[Migration 0071](../migrations/0071_inventory_matching_selected_pages.sql) and
[InventoryMatchingSelected](../src/inventory-matching-selected.ts) publish at
most ten current cohort/routes and two hundred current result references per
page. Ready and incomplete states both participate. Eligible route metadata
precedes bounded reverse-index probes; retained proof history is not traversed.
Queued work, the exact member census, the fair continuation turn, frontier and
immutable receipt commit together in six explicit statements.

Native guards reject missing members, omitted work, forged completion, changed
configuration, lease replacement and late signals. A lost acknowledgement
recovers the committed receipt without completing a newer job. Another pending
identity gets a turn before a large continuation resumes.

## Automatic coordination

[Migration 0072](../migrations/0072_inventory_selected_matching_coordinator.sql)
appends the eleventh coordinator phase. It preserves progress and wake counters,
the build cursor and retry deadline while resetting the idle streak. Account,
authentication, connection and credential records retain their identities.
Each committed selected-input page wakes the coordinator once.

The 21-contact reproduction now drains to 21 current results with zero pending
matching or selected-input jobs. The same test repeats retirement and restoration,
including proofs that captured an unavailable selected input.

The actual workerd handler automatically enrolls and compares 41 contacts,
recovers receipt coverage and then repairs a source edit. It calls no explicit
matching API, makes zero vendor requests, creates zero attempts and preserves
canonical source checkpoints and credential ciphertext during derived recovery.

## Measured cost and checks

| Native selected-input publication                |                           Measurement |
| ------------------------------------------------ | ------------------------------------: |
| Twenty sibling references                        |   6 statements, 906 reads, 107 writes |
| 190 references across ten cohorts                | 6 statements, 5,928 reads, 959 writes |
| One reference, each of 102 retained proofs/pages |              343–351 reads, 12 writes |

These are publication-only counts before the 0072 coordinator commit wake.
Selection, preparation, leases, matching and hosted execution are outside the
measurement. The history regression checks every publication against 400 reads
and twelve writes; the current reverse map remains one entry despite 103 retained
comparison proofs. It does not qualify peak storage for a large incomplete log.

Six declaration tests and 21 publisher cases pass. Focused coordinator and
Worker checks pass, including metadata migration and capacity deadline recovery.
The inventory regression passes **589 cases**, with the subsequently added
mixed-source owner-route test passing separately. TypeScript, lint, formatting
and the Worker dry-run build pass. The dry run deploys nothing.

Logs:
- `/tmp/lofi-ferry-selected-inputs.log`
- `/tmp/lofi-ferry-selected-pages.log`
- `/tmp/lofi-ferry-selected-pages-costs.log`
- `/tmp/lofi-ferry-selected-coordinator.log`
- `/tmp/lofi-ferry-selected-coordinator-restoration.log`
- `/tmp/lofi-ferry-selected-coordinator-worker.log`
- `/tmp/lofi-ferry-selected-mixed-routes.log`
- `/tmp/lofi-ferry-selected-inventory.log`
- `/tmp/lofi-ferry-selected-final-types.log`
- `/tmp/lofi-ferry-selected-final-lint.log`
- `/tmp/lofi-ferry-selected-final-format-current.log`
- `/tmp/lofi-ferry-selected-coordinator-build.log`

## Encrypted real-source replay

The three-provider replay through 0072 is
`4edb350b-bec7-4b87-87cb-9eb6ba282825`. It retains 20 selected-input dependencies
with zero missing or invalid references, zero pending selected-input jobs and no
selected-input pages. The idle publisher is expected: this bounded capture has
no later source edits. It is an integration and persistence check, not a positive
real-data edit-recovery trial.

A fresh process validates the dependency audit, 82 derived bodies, twenty
matching claims/results and 400 pair-enrollment references. The copy allocates
**16,343,040 bytes**. All 21 private directory entries have no group/world access.
Canonical inventory, checkpoints and credentials are unchanged; new vendor
requests and uploads are zero. The previous 0069 capture also reopens without
schema changes. Logs are `/tmp/lofi-ferry-selected-inputs-capture.log`,
`/tmp/lofi-ferry-selected-inputs-reopen.log` and
`/tmp/lofi-ferry-selected-inputs-compat.log`.

## Remaining work

### Completion when the final older dependent is collected

The managed real-service source run retained 678 empty selected-input
expansion pages. Migration 0075 completed signals observed by a replacement
cohort's own selected identities. It did not cover a different replacement
removing the last old sibling of an identity that had already moved.

[Migration 0077](../migrations/0077_inventory_matching_selected_collected.sql)
adds completion after deletion of that identity's final older current
dependent. The existing clock-leading index and native progress guard prove
the absence across all current owner routes. Work/signal clocks and cursor
frontiers stay unchanged. A later signal still requeues the identity; an
older prepared page cannot overwrite completion. The result replacement,
dependency collection and completion roll back together on late failure.

The focused regression replaces one member of a three-member cohort and
then replaces its two old siblings without selecting the first identity.
Its job completes without an empty page. Replacement consumed 788 rows
read before unrelated history and 784 after adding 4,000 completed jobs;
both must stay under a fixed 2,500-read ceiling. These are native
publication counts, not a complete-pipeline speedup measurement.

Four new native cases, the six earlier observed-completion regressions
under the new schema, and the actual read-only Worker pipeline passed as
one **11-test** selection. TypeScript, lint and formatting passed. The log
is `/tmp/lofi-ferry-selected-collected-qualified.log`. The running real
trial was opened through 0076 and was not migrated during execution;
elimination of its empty pages still needs a comparable replay.

### Integration still required

Durable hosted wakeups, bounded Queue turns and periodic retry/lost-message
recovery are implemented; see [hosted comparison evidence](evidence-inventory-hosted-comparison.md).
Automatic adoption scheduling,
ownership-aware planning, fresh source proofs and delivery integration remain
unfinished. Full real-source coverage, initial-sync timing, large-log storage,
garbage collection, restore quarantine and deployment cutover need their own
qualification. This change does not authorize a vendor write.
