# Comparison coordinator evidence

Status: local durable build/projection coordination and managed generation
activation, 2026-11-08. Hosted comparison Queue/cron wiring, durable matching work,
ownership-aware planning and delivery remain unfinished. Runtime activation is off;
nothing was pushed, deployed, uploaded or reset in production.

## Durable turns and wakeups

[InventoryComparisonCoordinator](../src/inventory-comparison-coordinator.ts) creates
a tenant's first comparison generation when needed and advances one bounded phase
per `step()`: index build, operation expansion, coverage recovery, projection, then
managed activation. Build turns rotate across incomplete generation/scope pairs;
a large source census cannot monopolize all build turns. Existing phase bounds
remain 200 index records, 200 operation/coverage references and twenty projections.
The child APIs retain their input/byte/lease guards and capacity splitting.

[Migration 0055](../migrations/0055_inventory_comparison_coordinator.sql) stores the
phase, build frontier, idle streak and separate wake/observed/progress versions.
Ingestion and projection commit, scope changes, generation creation and generation
state changes wake the control row atomically with their existing transactions.
The coordinator observes the latest wake version when recording its next phase;
new work arriving after the initial control read cannot become an old idle claim.

A tenant lease serializes coordinator turns. A contended child lease still leaves
the coordinator in the durable pending index, even near the end of an idle cycle.
After five idle phase turns it can park until another wakeup. `more=false` describes
immediate continuation demand, not complete vendor coverage or completed contact
sync. A pending generation without currently processable work reports waiting.
Caller/Queue error recovery and periodic lost-message recovery still need hosted
wiring; these APIs alone do not implement a deployed autonomous service.

Child publication and control advancement have separate transactions. If a child
commits but the coordinator loses its lease/acknowledgement before advancing the
control, a later turn can repeat selection safely: native child work versions and
receipts preserve the actual completed work. The control cursor supplies scheduling
fairness and never advances an inventory checkpoint or observation timestamp.

## Managed activation

Managed activation captures the pending/previous generation, domain/source-set
versions and current tenant lease in an immutable native receipt. Admission checks
every scope's index census/configuration and pending projection/operation/coverage
work for currently eligible scopes. Final commit repeats authority and work checks,
requires the exact generation/domain transition and preserves the source-set fence.

An activated generation may contain explicit held projections. Inactive scopes and
unregistered sources retain their existing matching uncertainty barriers. Activation
does not assert complete upstream source coverage, destination absence, ownership
or permission to upload. The lower-level index-only activation API remains available
for its existing comparison-index contract; coordinator activation uses the stricter
managed publication path.

Late account locks, newly linked sources, newly pending work and SQL errors roll
back the complete activation, including retirement of the previous active index.
Lost acknowledgements recover the old receipt without clearing newer operation
work or granting current authority to an old observation. Activation receipts have
a seven-day minimum retention; collection remains future work.

| Managed activation publication | Measurement |
| ------------------------------ | ----------: |
| Explicit statements            |           3 |
| Rows read                      |          41 |
| Rows written                   |          12 |

These counts are identical with three and 205 completed source contacts. The
publication validates pending metadata rather than scanning completed contact
history. Key/domain/debt lookups, coordinator/child leases, phase selection and
control advancement are outside that native batch measurement. It is not a
complete-turn RPC or hosted latency figure. Large retired/disabled-work histories
and many scopes still need selector/query-plan qualification before hosted use.

## Native verification

A 205-contact fixture rotates build pages as source-200, empty-destination-zero,
then source-five. It drains operation and coverage controls, publishes projections
in cohorts of at most twenty and activates only after eligible work is complete.
Constructing a fresh coordinator for every turn reproduces the persisted progress.
An idle coordinator wakes for new ingestion and explicit rebuild requests. A tenant
without an existing comparison domain gets a first generation automatically.

The tests cover account/scope isolation, contention, expired activation leases,
pending-work exclusion, late activation rollback, old-index preservation, new-source
visibility races and lost-acknowledgement recovery with newer operation debt. The
actual Worker processes one turn per request across multiple requests, drains 21
contacts, releases its leases and makes zero external requests. Source checkpoints
and credential ciphertext stay unchanged. No matching result, ledger mapping or
upload attempt is created by this coordinator.

The broad inventory regression passed **400 tests** with no failures, skips or
cancellations. After adding the activation-cost case, the final focused coordinator
selection passed **fourteen tests**; these selections overlap. TypeScript, lint,
formatting and the Worker dry-run build passed. Logs are
`/tmp/lofi-ferry-inventory-coordinator-final.log`,
`/tmp/lofi-ferry-coordinator-final-verified.log`,
`/tmp/lofi-ferry-coordinator-types-final-verified.log`,
`/tmp/lofi-ferry-coordinator-lint-verified.log`,
`/tmp/lofi-ferry-coordinator-format.log` and
`/tmp/lofi-ferry-coordinator-build-verified.log`.

## Encrypted capture replay

The [comparison trial](../scripts/inventory-comparison-trial.ts) applies migrations
through 0055, samples the existing projection jobs and then runs four persisted
coordinator turns before capturing matching results. Build/operation/coverage turns
are idle in this bounded sample. The projection turn publishes twenty additional
held source bodies and records the next phase as activation, with observed wake
version seven. The original source baseline remains incomplete; no contact becomes
ready or adoptable merely because the coordinator ran.

A fresh process recovers that exact control state, verifies the new projection
receipt and authenticates twenty coordinator bodies, twenty earlier job bodies and
the original 42 bodies: **82 distinct projections**. It also reproduces twenty
incomplete matching results and zero historical associations. An earlier capture
without coordinator tables still reopens. Canonical inventory, checkpoints and
credentials remain unchanged; vendor requests/uploads are zero.

The private directory ends in `7df042e7-50ef-4480-b4fb-d78b5bd95120`; database
allocation is 15,638,528 bytes. This includes a larger projection sample, control
schema and receipts, not a full-log storage density estimate. Logs are
`/tmp/lofi-ferry-coordinator-capture-verified.log`,
`/tmp/lofi-ferry-coordinator-reopen-verified.log` and
`/tmp/lofi-ferry-coordinator-compat-reopen.log`.

## Remaining work

Add durable matching invalidation/claim/completion, ownership-aware result selection
and conservative adoption to the coordinator. Connect bounded Queue/cron wakeups
with retry/fairness and lost-message recovery. Qualify full-turn D1/CPU/storage costs
and old-generation histories on the larger workloads. Then integrate fresh source
proofs, new delivery ownership, QRZ submission and member-aware LoTW recovery.
Retention/GC, restore quarantine and account-preserving cutover remain unfinished.
