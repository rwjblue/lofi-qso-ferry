# Encrypted comparison projections

Status: local preparation, native publication, bounded bulk loading, encrypted capture replay, durable operation projection jobs and coverage recovery, 2026-11-08. The later [matching evidence](evidence-inventory-matching.md) adds bounded forward/reverse collection and native comparison-result publication; [ownership evidence](evidence-inventory-ownership.md) covers historical adoption. Hosted comparison scheduling and delivery integration remain unfinished. Nothing was pushed, deployed, uploaded or reset in production.

The [workspace](../src/inventory-projection-workspace.ts) prepares up to twenty source or receipt projections. It captures the comparison generation/configuration, index/projection/work versions, semantic inputs, current operation topology, source membership versions and applicable source coverage. The index census must already be complete for that scope. It admits the union of at most 256 references against four-MiB ciphertext and plaintext budgets, loads immutable payload IDs in bulk and decrypts shared dependencies once.

Source projections reuse [projectContact](../src/projection.ts) and the extracted [ADIF serializer](../src/contact-adif.ts). Complete operation/event context must have observed full source coverage and present membership. A retained unresolved event cannot disappear from the effective operation. Missing, incomplete or oversized context produces a held preparation. Reducing a cohort can resolve a soft union overflow; an individual oversized closure stays held. No truncated event set is projected.

Source comparison ADIF retains UTC seconds without rounding, while its encrypted source metadata retains the original millisecond timestamp and precision. Full QRZ, remote-preserved QRZ and LoTW source fingerprints remain encrypted alongside the record. Receipt projections retain literal time precision and LoTW individual/group mode fields, omit narrative/name fields and hold unsupported matching evidence. Ready projections are checked against the existing HMAC hint, so the full projection cannot silently move to a different call/time search bucket.

Reliable test-operation exclusions are explicit preparations with their context dependencies. Their candidate hashes remain available. Publication must retain those hashes: removing a context-dependent exclusion from lookup would hide a later operation change that makes it relevant again. Matching must retain dependencies for excluded and currently irrelevant candidates as well as eventual matches.

The returned preparations contain only opaque metadata and envelope-encrypted bodies, with a digest over the complete preparation. `inventory_comparison_projection` has its own tenant/connection/payload authenticated identity. Preparation changes no inventory/checkpoint, observation freshness or completed work. The preparations do not authorize adoption or export and are not published ready state in `comparison_index`.

## Verification

- Twenty source contacts sharing one operation/event used **seven D1 reads and twenty-two distinct body decryptions**. Source timestamps retained milliseconds; ADIF kept seconds. The preparation contained no plaintext source narrative or ADIF record.
- Thirteen focused tests passed, including the four context-membership cases and nine workspace cases. They cover incomplete collection/catch-up, unresolved events, changing test exclusions, shared union admission, byte admission before decryption, receipt precision/modes and source UUID/input ownership.
- A separate [native workerd test](../tests/inventory-projection-worker.test.ts) prepared, encrypted and decrypted the twenty-contact cohort with the actual Worker WebCrypto implementation, validated its digest and left canonical state/credentials unchanged. It made no vendor HTTP request.
- The final inventory selection passed **248 tests**, including hosted Queue execution and the native projection test. The preceding full regression checkpoint passed 2,054 tests; the serializer extraction separately passed 59 delivery/precision/signing tests. These overlapping counts should not be added.
- TypeScript, repository lint/formatting and the Worker dry-run build passed. Logs are `/tmp/lofi-ferry-projection-workspace.log`, `/tmp/lofi-ferry-projection-worker.log`, `/tmp/lofi-ferry-inventory-projections-final.log` and `/tmp/lofi-ferry-projections-build.log`.

These preparation checkpoints precede native publication. The later full inventory selection passed **271 tests**, including publication guards, metadata lookup, hosted Queue execution and native Worker checks. Its log is `/tmp/lofi-ferry-inventory-publication-regression.log`. The subsequent shared-body reader passed **28 focused publication/reader/Worker tests**, recorded in `/tmp/lofi-ferry-projection-bulk-read-final.log`. TypeScript passed after that change. Counts overlap and should not be added.

After the shared reader and relation pass, repository lint/formatting, TypeScript, all 29 mise task definitions and the Worker dry-run build passed. The final dry-run log is `/tmp/lofi-ferry-projection-bulk-final-build.log`; inventory runtime and export activation remain off.

## Encrypted real-data replay

The [capture trial](../scripts/inventory-comparison-trial.ts) now retains private `projection-preparations.json` artifacts as well as its count-only report. It still copies the original encrypted run capture into a new private directory, preserving credential identities and checking that canonical facets/timestamps and stream checkpoints remain unchanged. No vendor request or upload was made.

| Provider | Prepared | Ready preparations | Held preparations | Distinct bodies decrypted |
| -------- | -------: | -----------------: | ----------------: | ------------------------: |
| LoFi     |       20 |                  0 |                20 |                        20 |
| LoTW     |        2 |                  2 |                 0 |                         2 |
| QRZ      |       20 |                 20 |                 0 |                        20 |

LoFi's capture still has incomplete full source coverage, so its twenty samples stayed held. The receipt samples were independently projectable; that does not make the limited destination capture complete. The index remained pending, and no matching result or ready projection was published. A separate process authenticated and decrypted all **42 preparations**, recovered the active index generation and reproduced one stored hint from each provider's original encrypted body.

This replay's database occupied **14,012,416 bytes**, in addition to the private sealed preparation artifact. An earlier run of the same index/membership schema measured 14,028,800 bytes. These small fixture allocation measurements do not establish full-log storage or throughput. The earlier [comparison evidence](evidence-inventory-comparison.md) records its publication statement/row boundaries.

## Native publication and current reads

[Migration 0048](../migrations/0048_inventory_projection_publication.sql) and [InventoryProjections](../src/inventory-projections.ts) implement one guarded publication batch. Native admission and final commit checks cover the active/pending generation, scope configuration, current lease/account/connection, exact index/projection/work versions, every immutable input reference, semantic and membership versions, operation topology and captured coverage. Ready/excluded source rows with a parent require a complete, present operation/event closure. Native checks reject omitted dependencies and raced event additions independently of a recomputed application digest. Admission alone cannot authorize a later commit after authority changes.

Encrypted bodies live separately from versioned projection metadata. Publication advances index readiness/projection versions and completes only the captured work version atomically. Context-dependent exclusions retain their hashes. Lost acknowledgements recover immutable receipts without incrementing versions twice. Newer work stays pending. Late SQL failure rolls the entire body/metadata/work publication back. Twenty ready source projections sharing one operation use **12 publication statements, 1,672 rows read and 269 rows written**; lease, preparation and receipt lookup are outside that boundary.

Current reads reject changed semantic/topology/membership/configuration inputs and collecting source coverage. Bulk candidate lookup keeps those records visible as pending with no usable body reference. Unchanged full verification restores the existing ready projection without rebuilding it or changing its derivation time. Source membership and scan coverage still need separate matching checks; body availability does not grant current upstream membership or absence authority.

The bulk body reader accepts at most 128 distinct immutable references across the complete forward/reverse union. Repeated references load and decrypt once. A metadata query admits total encrypted bytes against four MiB before loading ciphertext; decoding also enforces the plaintext bound. Missing or stale references remain explicit. Twenty shared bodies use **two reads, 360 rows read and twenty decryptions**; adding 5,000 unrelated projection/index rows leaves those metrics unchanged. The actual Worker WebCrypto test also bulk-loads the published cohort without external requests.

Soft multi-contact capacity failures must be split before publication; they cannot permanently complete otherwise projectable work. The native publisher rejects such mixed capacity holds. Bounded operation-child reprojection and pending-work selection are now implemented below. Coverage-completion wakeups are now implemented below; hosted scheduling and payload/receipt collection remain unfinished.

## Published real-data replay

The next isolated replay published all 42 preparations through three guarded transactions. Each provider's commit receipt replay recovered with zero publication statements. Credentials, canonical facet versions/timestamps and stream checkpoints stayed unchanged.

| Provider | Published | Ready | Held | Publication statements | Rows read | Rows written |
| -------- | --------: | ----: | ---: | ---------------------: | --------: | -----------: |
| LoFi     |        20 |     0 |   20 |                     12 |     1,096 |          266 |
| LoTW     |         2 |     2 |    0 |                     12 |       132 |           32 |
| QRZ      |        20 |    20 |    0 |                     12 |     1,014 |          266 |

The incomplete LoFi capture correctly remains held. Its other 1,929 candidates remain pending and 51 bookkeeping entries retired; QRZ retains 230 pending candidates in addition to the twenty ready samples. LoTW's two receipt projections are ready, but its coverage still applies only to the explicitly selected day. No match, absence or adoption result was published.

A fresh process authenticated and decrypted all **42 persisted projections**, in addition to the sealed preparations, through the bulk reader. The combined read used **two queries, 608 rows read, 21,495 encrypted input bytes, 9,107 plaintext bytes and 42 decryptions**. It recovered the active generation and checked an original stored hash for each provider. An older preparation-only capture also reopened without requiring projection publication tables.

The published replay occupied **14,503,936 database bytes**. Like the earlier small captures, this does not establish full-log density or production throughput. The private directory ends in `bc6bfd0e-4b44-453d-af07-34c3de2f34b6`; count-only logs are `/tmp/lofi-ferry-projection-publication-capture.log`, `/tmp/lofi-ferry-projection-bulk-reopen.log` and `/tmp/lofi-ferry-projection-preparation-compat-reopen.log`. All replay/reopen runs made **zero vendor HTTP requests and zero uploads**.

## Durable operation projection jobs

[Migration 0052](../migrations/0052_inventory_projection_jobs.sql) and
[InventoryProjectionJobs](../src/inventory-projection-jobs.ts) bridge operation
barriers to bounded child work. An operation/event topology change queues one job
per active/pending index generation in the ingestion transaction. It does not
update every contact. The original 0052 generation/configuration enrollment is superseded by the bounded
setup below; operation/event mutations retain their narrow enqueue triggers.
Existing domains received a one-time enrollment in that earlier migration.

Each job retains its captured configuration/topology, monotonic work/completed
versions and child keyset cursor. At most 200 child references enter one expansion
page. Native admission validates the exact key range, count and completion claim,
the current generation/scope/index census, account/connection and fenced lease.
The batch queues stale children, advances only the captured continuation and commits
an immutable receipt. Final guards repeat authority/version checks and ensure the
qualifying children remain pending. It loads no encrypted contact bodies.

Already dirty child work is coalesced rather than incremented again. Current child
projections are skipped. A newer topology/configuration resets the job cursor and
advances its work version; an old prepared page cannot complete it. Late SQL,
account or topology changes roll the whole expansion back. Lost acknowledgement
recovery returns the original receipt without advancing a newer continuation.
Pending jobs cannot be deleted, and receipts have a seven-day minimum retention.
Receipt collection itself remains future work.

`expandNext()` selects one due operation job with a complete index census.
`projectNext()` selects up to twenty pending records for one generation/scope and
uses the existing guarded projection publisher. Deterministic multi-record capacity
failures halve that cohort before retry; a single oversized record remains an
explicit held projection. Pending-only global and per-scope due indexes replace
the previous full work index, so completed history is absent from those selectors.
The child index supports an operation's keyset range rather than repeatedly
scanning already visited children or unrelated operations.

A 205-contact fixture enqueues one operation job, expands it as 200 plus five
children, then projects it in cohorts of at most twenty. Its source checkpoint and
credential ciphertext remain unchanged throughout expansion/projection. Stable
context verification does not enqueue the completed operation again. Separate
tests cover omitted children, early completion, superseding topology, lost
acknowledgements, account/lease races, late rollback, new-generation enrollment and
coalescing of work that is already pending. The actual Worker drains 21 changed
contacts as twenty plus one and returns to idle with zero external requests.

These APIs do not yet constitute the complete hosted comparison coordinator.
Coverage recovery now wakes context-held projections completed while the baseline
was partial. Automatic generation/build selection, matching work and
ownership-aware planning, Queue/cron integration and end-to-end fairness/retry
policies remain unfinished. They must be connected before runtime activation;
operation fan-out alone cannot establish full-log progress or the hours target.

The 200-child expansion used **four statements, 1,238 rows read and 605 rows
written**, excluding selection, preparation, receipt recovery and lease calls. An
earlier version retaining the now-redundant full work index wrote 805 rows for the
same expansion. Pending indexes add row/index work to future ingestion and
projection completion; their complete cost belongs in the next end-to-end
benchmark. Statement count alone does not measure that work.

The inventory regression passed **366 tests**, including the new Worker and job
tests, with no failures, skips or cancellations. Its 200-child measurement still
included the redundant full work index. After that index was removed, the final
focused selection passed fourteen tests against the final native SQL and measured
the 605 writes above; those counts overlap. TypeScript, lint, formatting and the
Worker dry-run build passed. Logs are
`/tmp/lofi-ferry-inventory-projection-jobs-regression.log`,
`/tmp/lofi-ferry-projection-jobs-final.log`,
`/tmp/lofi-ferry-projection-jobs-types-verified.log`,
`/tmp/lofi-ferry-projection-jobs-lint.log`,
`/tmp/lofi-ferry-projection-jobs-format.log` and
`/tmp/lofi-ferry-projection-jobs-build.log`.

## Recovery after full source coverage

[Migration 0053](../migrations/0053_inventory_projection_coverage_jobs.sql) and
[InventoryProjectionCoverageJobs](../src/inventory-projection-coverage-jobs.ts)
recover contacts projected while source coverage was incomplete. Each complete
full-source baseline queues one scope job per active/pending generation. Completion
does not scan held contacts or update their work rows in the ingestion transaction.
New comparison generations and existing complete coverage are enrolled as well.

The job binds the full run, source configuration and coverage selection. Its native
authority requires both source streams, catch-up and complete observed coverage.
An intervening collection/hold, new full run, changed source binding, retired index,
account lock or expired/replaced lease prevents stale progress. A new full baseline
advances the job version and resets its cursor while preserving completed history.

Recovery visits at most 200 `operation_context_incomplete` source projections per
page through a dedicated partial index. Native SQL derives the frontier/count and
queues those contacts for the existing guarded projection publisher. Already dirty
work is coalesced. Ready projections never enter the recovery index. Missing
operation data remains held after one revisit; another unchanged job turn cannot
spin on it. Later operation data uses the separate topology job to repair context.

One explicit INSERT drives the fixed native publication sequence: authority and
range admission, bulk work upsert, continuation advancement and receipt completion.
These trigger statements remain SQL work; this is not one total SQL operation or
one complete-cohort RPC. Native final checks reject late coverage/account changes
and silently ignored work. Lost acknowledgements recover the original receipt
without moving a newer job cursor. Receipts have a seven-day minimum retention;
collection remains unfinished.

The 205-contact fixture first publishes held projections during collecting
coverage, then completes the actual full/catch-up/quarantine phases. That completion
leaves contact work unchanged. Recovery expands 200 plus five contacts, and bounded
projection turns make all 205 ready. A 200-contact expansion uses **one explicit
statement, 2,450 rows read and 605 rows written**, excluding selection, lease and
receipt calls. An empty recovery after unchanged verification reads **54 rows**
with 205 ready projections and preserves their encrypted payloads/work versions.
No derivation refreshes source observations, checkpoints or credential ciphertext.

An actual Worker repeats the held-to-ready path for 21 contacts in twenty-plus-one
cohorts, releases its lease and makes zero external requests. The inventory
regression passed **384 tests** with no failures, skips or cancellations, including
coverage/version/lease races, native final guard failures, lost acknowledgements,
missing-operation recovery and real new-generation enrollment. TypeScript,
lint/formatting and the Worker dry-run build passed. Logs are
`/tmp/lofi-ferry-inventory-coverage-regression.log`,
`/tmp/lofi-ferry-coverage-types-final.log`, `/tmp/lofi-ferry-coverage-lint.log`,
`/tmp/lofi-ferry-coverage-format.log` and `/tmp/lofi-ferry-coverage-build.log`.
This regression overlaps the earlier selections and should not be added to them.

## Captured projection job sample

The isolated encrypted replay now applies migrations through 0053 and samples one
operation expansion, coverage recovery and ordinary pending projection turn before
capturing matching results. The selected operation has no child candidates: its
empty continuation commits correctly. The pending projection turn publishes twenty
additional held source projections. Coverage recovery stays idle because the
captured source baseline is incomplete. This is bounded refusal/progress evidence,
not positive recovery or full-log completion on personal data.

A fresh process verifies the operation/projection receipts, authenticates the
additional twenty bodies plus the original 42, and recovers the twenty incomplete
matching results and zero historical associations. Credentials, canonical
observations and checkpoints remain unchanged. Vendor HTTP requests and uploads
are zero. The earlier adoption-only capture still reopens without the new job
tables. Logs are `/tmp/lofi-ferry-projection-jobs-capture.log`,
`/tmp/lofi-ferry-projection-jobs-reopen.log` and
`/tmp/lofi-ferry-coverage-compat-reopen.log`.

Source index construction on the same captured workload writes **35,696 rows**,
compared with 31,798 before the pending/parent indexes; its 120 explicit publication
statements are unchanged. The new indexes add writes while avoiding completed-work
and unrelated-child scans. This backfill measurement excludes generation/control
setup and is not a steady-state billing estimate. The new private directory ends
in `38a043c5-9c17-459c-a0e7-337adc645f41`; allocation is 15,663,104 database bytes.
It includes new indexes, control tables, jobs and twenty more bodies, and does not
establish full-log storage density or capacity runway.

The complete hosted coordinator still needs generation/build selection, durable
matching work, ownership-aware planning, Queue/cron wiring and bounded retry/fairness
policies. Source proofs, delivery and restore/cutover remain separate unfinished
work; no new export path is activated here.

## Bounded generation setup

Automatic coordinator work exposed another unbounded path: the original 0052
generation-creation and source-reconfiguration triggers enumerated all retained
operations. That duplicates the ordinary projection work already created by each
new/configuration-changed row in the bounded comparison-index publisher.
[Migration 0054](../migrations/0054_inventory_bounded_generation_setup.sql) removes
those two triggers. It retains the operation/event mutation triggers, so changes
arriving during backfill still install immediate barriers and narrow continuation
work for both active and pending generations. No source payload or observation is
changed by this setup policy.

With a preexisting tenant key, one source scope and full source coverage, the
native generation batch uses **two explicit statements, sixteen rows read and nine
rows written** for both two and 250 retained operations. Key loading/decryption and
the final domain read are outside that batch measurement. Generation setup still
enrolls the source/destination scope censuses and applicable scope-level coverage
recovery controls; it does not enqueue an operation row for every retained parent.

The native tests backfill a 205-contact generation in multiple pages, change an
operation between pages and verify all 205 ready projections, including the changed
station context. Only the edited operation receives a new-generation continuation.
Configuration changes leave existing operation job rows untouched, reset the index
census and queue every affected contact through that rebuild. Projections remain
held until full coverage for the new configuration is observed.

The focused generation/build/projection regression passed **45 tests**, including
the three new setup-policy tests; the older operation enrollment fixture still
checks the original 0052 schema. TypeScript, lint and formatting passed. Logs are
`/tmp/lofi-ferry-bounded-generation-setup.log`,
`/tmp/lofi-ferry-bounded-setup-regression.log`,
`/tmp/lofi-ferry-bounded-setup-types.log`,
`/tmp/lofi-ferry-bounded-setup-lint.log` and
`/tmp/lofi-ferry-bounded-setup-format.log`. These overlap earlier selections and do
not represent a new full inventory regression.

The next encrypted replay applies 0054. Its operation job sample is idle because
generation setup no longer manufactures per-operation work. Ordinary projection
work still publishes twenty additional held source bodies, and coverage recovery
correctly remains idle against the partial source baseline. A fresh process
authenticates those twenty plus the original 42 bodies and recovers the twenty
incomplete matching results and zero historical associations. All canonical state
and credentials remain unchanged; vendor requests and uploads are zero.

That private directory ends in `82423def-21c5-460f-b08f-930114a216d5`; database
allocation is 15,618,048 bytes. Index-build write counts remain unchanged from the
preceding capture because this fix removes setup work outside those phase counts.
This small allocation difference is not a full-log storage forecast. Logs are
`/tmp/lofi-ferry-bounded-setup-capture.log` and
`/tmp/lofi-ferry-bounded-setup-reopen.log`.

The automatic generation/build/projection coordinator, managed activation fences,
durable matching work and hosted wakeups remain unfinished. Bounded initialization
is a prerequisite for that coordinator, not a claim of completed hosted progress.
