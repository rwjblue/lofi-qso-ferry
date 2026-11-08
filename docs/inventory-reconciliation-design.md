# Inventory driven reconciliation design

Status: **Architecture with local inventory, matching and historical adoption implementation, 2026-11-08.** Bulk ingestion, bounded reads, run/membership/coverage, reader handoff, hosted scheduler/Queue wiring, encrypted comparison keys, atomic hash/context invalidation, resumable index generations, native encrypted projection publication, shared body loading, bounded matching snapshots, guarded persisted comparison results, permanent read-only historical associations, durable operation projection jobs, coverage-recovery wakeups, unified build/projection/matching coordination, guarded matching-work completion, bounded bucket/scope invalidation and current coverage wait points/readiness journaling, guarded prefix dispatch and bounded rematching publication are implemented locally. See [ingestion evidence](evidence-inventory-ingestion.md), [run evidence](evidence-inventory-runs.md), [runtime evidence](evidence-inventory-runtime.md), [comparison evidence](evidence-inventory-comparison.md), [projection evidence](evidence-inventory-projections.md), [matching evidence](evidence-inventory-matching.md), [matching-work evidence](evidence-inventory-matching-work.md), [invalidation evidence](evidence-inventory-matching-invalidation.md), [scope-enrollment evidence](evidence-inventory-matching-pairs.md), [coverage-wait evidence](evidence-inventory-matching-coverage.md), [ownership evidence](evidence-inventory-ownership.md) and [coordinator evidence](evidence-inventory-coordinator.md). Durable hosted comparison wakeups, Queue/cron recovery and native read-only lease admission are implemented locally; see [hosted comparison evidence](evidence-inventory-hosted-comparison.md). Automatic adoption scheduling and ownership-aware planning, delivery ownership integration, automatic LoTW date discovery/splitting, delivery integration and deployment remain future work. Selected-input cohort invalidation, including missing/retired identities, is implemented with guarded bounded recovery; see [selected-input evidence](evidence-inventory-matching-selected.md). Runtime activation is configured off; no production reset or export-policy change has been performed.

Ferry should inventory each service independently, retain the latest encrypted LoFi source data, and reconcile bounded groups through a shared local comparison index. Persisted results would drive delivery planning. External discovery would follow service pages and changes, while matching and queue creation would operate on sets of records locally.

The existing [system design](design.md), [bootstrap rules](bootstrap.md), [capacity plan](capacity-plan.md) and [rollout checklist](rollout-checklist.md) describe the current implementation and its evidence. This proposal changes the current preference against a permanent source mirror. Reuse useful protocol, projection, signing and evidence rules, while implementing a fresh database model rather than preserving the existing database layout or contents.

## Goals and decisions

- Retain one current encrypted copy of LoFi operations, ordinary QSOs and segment events, with the context required to reconstruct exports.
- Maintain compact encrypted destination comparison projections and opaque candidate indexes. Keep full destination records when needed for unresolved delivery, remote-owned field preservation or bounded diagnostics.
- Replace contact-driven historical discovery with independent inventory jobs and incremental ingestion.
- Match cohorts locally, share loading and decryption, and persist results with precise invalidation dependencies.
- Retain the delivery-ledger, ownership, historical write-block, immutable-attempt and source-proof invariants in the fresh schema; existing rows and trigger layout need not be migrated.
- Prepare QRZ work in cohorts and continue individual QRZ INSERTs. Add multi-contact LoTW artifacts through a separate member-aware delivery lifecycle.
- Build against an empty database, compare behavior through captured/synthetic inputs, and re-inventory services before a separate deployment cutover.

LoFi remains the source for new delivery and corrections. Destination inventories supply presence, comparison and receipt observations; this is not a general bidirectional log editor. Future providers such as Club Log require their own verified adapter contracts.

The confirmed workload priority is personal use first, with 100 accounts creating 100 contacts/day retained as a scale check. The scale scenario exposes growth and request-policy constraints; achieving its full sustained capacity is not a prerequisite for the personal-use implementation. Correctness, recoverability and tenant isolation still apply at either scale.

The confirmed initial storage choice is D1 for both payloads and indexed state, with an explicit path to move full payloads to R2 later. Preserve backend/version-aware payload references in the design; initial implementation does not require an R2 bucket or cross-store publication protocol.

Starting with fresh contact and reconciliation state is explicitly acceptable. Preserve accounts, authentication and account links, including LoFi, LoTW and QRZ credentials and the encryption identities needed to read them. Existing contact mappings, timestamps, attempts and artifacts do not require a data-preserving migration, compatibility writers, dual materialization or an old-worker rollback floor. This decision concerns local/database state, not edits to vendor logs. No database reset is performed by this planning decision.

Existing remote contacts are rediscovered as historical observations. A fresh database cannot recover Ferry-created provenance or narrative/template bindings from the shape of a remote record. Adopt discovered history conservatively and preserve remote content; do not fabricate old ownership, delete contacts or re-upload records merely because a local mapping is absent. After the new service starts submitting, its new ownership and unresolved-attempt evidence must remain durable.

Initial synchronization should finish in hours rather than inheriting the current four-background-request allocation. Plan for a 2–4-hour 200,000-contact LoFi baseline under healthy service and representative payloads, including catch-up/context. Larger read pages, server-directed pacing and durable continuations are part of this target. End-to-end cross-vendor classification and actual historical uploads remain separately measured workloads.

```mermaid
flowchart LR
  A[Independent service scans] --> B[Current local records]
  B --> C[Opaque comparison index]
  C --> D[Bulk matching]
  D --> E[Versioned match results]
  E --> F[Delivery planning]
  F --> G[Immutable attempts and artifacts]
  G --> H[Vendor submission]
  H --> A
```

## Identity and evidence

These values serve different purposes and must not be substituted for one another:

| Value                                    | Purpose                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Stable record reference                  | LoFi UUID, QRZ LOGID, or a provider-specific observation identity                   |
| Candidate bucket HMAC                    | Find potentially matching records without indexing plaintext contact fields         |
| Content fingerprint                      | Detect meaningful changes within a defined source, remote or transmitted projection |
| Composite source generation              | Bind a contact to its QSO, effective operation and relevant segment events          |
| Inventory coverage                       | Describe the successful query scope, scan progress and catch-up observations        |
| Source proof and final destination check | Establish the evidence required for a particular write                              |

An available payload is not proof of current upstream membership. Retaining it must not refresh an observation timestamp, renew a proof or imply a deletion-delivery guarantee. A complete observed scan is not an immutable vendor snapshot.

An `absent_at_inventory` result selects delivery-planning work. It does not itself authorize an INSERT. The current source-proof, routing, credential, ownership, historical-association, quiet-period and final destination checks still apply. Historical recognition remains separate from exact attempt receipt verification and correction identity.

## Retention

Retain the latest source records while the linked source is active. Keep operation bases and segment events needed to interpret retained QSOs, including deletion/test state and dependency relationships. Preserve original precision and source fields needed by templates and destination projections.

Separate payload retention from observation freshness. Refactor the current guards and maintenance that use source-buffer expiry as availability; do not emulate durable storage with distant expiration timestamps. Existing proof lifetimes remain separate.

Store durable source bodies under a payload kind such as `inventory_source`, with its own encryption binding and explicit retention policy. The fresh writer and collector share that policy from the start; no temporary duplicate legacy bodies are required. The old resolved-source cleanup is a reference for behavior to replace, not a routine to run against the new database. Changing an envelope's identity without resealing remains invalid.

Superseded source bodies may be collected after no unresolved attempt, active matcher/shadow comparison or necessary dependency references them. Matching runs pin their captured immutable inputs until commit or abandonment. Immutable attempt artifacts remain independent of mutable current source data. Connection removal, account deletion, revocation and backup retention need explicit policies before this retention change activates.

Destination comparison projections persist for incremental matching. Full remote bodies can expire when they are no longer required for preservation or uncertain delivery. If a correction needs remote-owned content that is unavailable, fetch it through the adapter or hold the correction.

## Proposed schema

These are logical table definitions, not executable migrations. All primary keys, unique constraints, joins and foreign keys include `tenant`. IDs and hashes use TEXT; timestamps and monotonic counters use INTEGER; cursor manifests use JSON TEXT. Payload references include the full tenant, connection, ID and kind required by `private_data` and encryption binding.

### Inventory tables

| Table                     | Key                                                             | Principal columns                                                                                                                                                                                                          |
| ------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inventory_scopes`        | `(tenant, scope_id)`                                            | `provider`, `logical_identity`, `connection_id`, `config_version`, `adapter_version`, `accepted_sequence`, `state`; client/source pacing state shared by all sync streams                                                  |
| `inventory_streams`       | `(tenant, scope_id, stream_id)`                                 | query/checkpoint-format binding, `checkpoint_version`, committed checkpoint, active run, next due time                                                                                                                     |
| `inventory_records`       | `(tenant, scope_id, entity_family, record_key)`                 | subtype, `parent_key`, provider ID, canonical identity group, `row_version`, `last_accepted_sequence`, `status`, `last_observed_at`                                                                                        |
| `inventory_record_facets` | record key plus `facet`                                         | opaque remote revision, supplied-field mask, raw/projection payload references, semantic version, `last_accepted_sequence`, original/current observation metadata                                                          |
| `inventory_runs`          | `(tenant, run_id)`                                              | scope/configuration and expected stream versions, requested stream vector, partition, epoch, phase, resume state, start/catch-up sequences, quarantine cursor, fixed query bound, proposed checkpoint, counts/digest/times |
| `inventory_membership`    | `(tenant, run_id, stream_id, facet, entity_family, record_key)` | bound scope/partition/epoch, observed facet revision/version, observation time                                                                                                                                             |
| `inventory_coverage`      | `(tenant, scope_id, stream_id, facet, partition_id)`            | `published_epoch`, `coverage_kind`, `coverage_version`, checkpoint/observation metadata, planning freshness policy                                                                                                         |
| `inventory_wakeups`       | `(tenant, wakeup_id)`                                           | scope/run/work version, `not_before`, publication state; unique continuation identity for the transactional outbox                                                                                                         |

`inventory_scopes` identifies a logical account/book and query contract independently of credential version. Reconnecting the same logical destination preserves its identity. Query-shape, reader-policy or account/book changes advance scope configuration. Routine credential renewal does not erase inventory.

Source entity families distinguish operations from QSOs, as current storage does. Event/contact is a subtype of a QSO entity, so changing classification cannot leave two independent records. A parent relationship is not a cascading deletion instruction. QRZ records use LOGID within their canonical book scope; observing the same LOGID through overlapping query ranges or reconnect aliases must not create extra candidate contacts. Query partitions are read scopes rather than ownership identity. LoTW has no established equivalent stable UUID: its adapter must preserve exact identity and distinguish conflicting observation variants instead of collapsing them into one invented vendor ID. Its cross-query deduplication follows the existing ownership namespace; unproved cross-account equivalence stays unresolved.

Keep stable provider ID, local record/variant key and canonical ownership identity distinct. A receipt facet and confirmation facet have independent versions, observation/accepted-sequence metadata, checkpoint streams, membership and coverage. Aggregate record metadata is a scheduling hint, not a facet freshness proof. Confirmation patches merge supplied fields only; an omitted field does not clear an accepted-QSO field. If a patch cannot be correlated unambiguously with a LoTW variant, retain the unresolved observation without modifying several records by guesswork.

Coverage dependency identity includes stream and facet. Historical destination presence/absence uses receipt coverage, while LoFi projection uses the required source operation/QSO coverage. Completing a confirmation scan cannot publish receipt completeness, refresh receipt observation freshness or satisfy receipt-run quarantine.

`resume_state` advances after an accepted page; the committed incremental checkpoint advances only when the required run completes. Bind both to provider, logical scope, query fingerprint, stream/reader policy, timestamp precision and checkpoint-format version. Ordinary adapter code changes do not automatically invalidate a compatible checkpoint. LoFi operation/QSO progress is a vector in one sync packet; one side's completion must not advance the other.

Accepted pages update current records and scan membership atomically. During a full scan, affected coverage is incomplete for new absence conclusions. Completion includes bounded classification of previously known but unseen records. Publishing coverage updates a small metadata row; it must not require rewriting a whole 200,000-record log in one transaction.

A scan records its starting accepted sequence and captured configuration. Membership quarantine preserves relevant facet observations accepted after that boundary or explicitly incorporates them into that stream/facet's membership. An unrelated confirmation patch does not establish receipt membership. Local accepted sequences order ingestion bookkeeping, not vendor revisions. Publication atomically checks run/epoch, stream/facet binding, captured configuration, expected stream versions, successful catch-up and completed quarantine. While rolling updates make coverage incomplete, new historical adoptions also wait for adequate coverage; existing permanent associations are retained.

A record not observed in a completed scan becomes unresolved membership until the provider contract or a confirming read establishes what happened. In particular, source disappearance does not manufacture a tombstone, and disappearance of an owned destination record does not grant permission to recreate it.

### Ingestion page tables

| Table                 | Key                                                   | Principal columns                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingestion_pages`     | `(tenant, page_id)`                                   | scope/run/query binding, original request start, input/manifest digests, raw/distinct counts, expected stream/configuration/index versions, state and committed checkpoint receipt  |
| `ingestion_page_rows` | `(tenant, page_id, entity_family, record_key, facet)` | typed incoming revision/stamp, expected previous version or absence, merge decision, old/new parent/effect metadata, planned immutable body/projection references and index entries |

`ingestion_pages` records an accepted page and resolves an uncertain commit acknowledgement. It is not a second stream checkpoint authority. `ingestion_page_rows` is a private preparation relation, not readable source data or match evidence. It can hold metadata without copying every encrypted body into another table. Only canonical inventory references make a body usable. Both tables require bounded retention; keep receipts through the retry/recovery horizon and input pins, then collect them without changing authoritative stream progress.

Planned body IDs in scratch rows are declarations, not active payload references. Verify that they correspond exactly to inserted or reusable immutable bodies before writing canonical foreign-key references. Source scope, request time and authority metadata come from the core page manifest, not vendor-supplied fields.

The default path stages metadata, publishes canonical records and deletes scratch rows in one native transaction. An optional larger-page path may persist preparation chunks first, but must retain the same single final canonical publication and cursor transition. Its additional write/space/recovery costs must be measured before use.

### Comparison and work tables

| Table                                    | Key                                                              | Principal columns                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `index_generations`                      | `(tenant, generation_id)`                                        | fixed key ID, bucket/normalization versions, state, captured source positions and catch-up progress                                        |
| `comparison_domains`                     | `(tenant)`                                                       | one contact-comparison domain per tenant initially; monotonic `version`, `source_set_version`, active/pending generation                   |
| `inventory_comparison_keys`              | `(tenant)`                                                       | stable key ID and envelope-encrypted tenant HMAC secret, independent of credential and KEK versions                                        |
| `comparison_builds`                      | `(tenant, generation_id, scope_id)`                              | configuration/version, bounded keyset cursor and index-census completion                                                                   |
| `projection_domains`                     | `(tenant, source, operation_key)`                                | `topology_version`, `ready_version`, pending work and bounded continuation                                                                 |
| `comparison_index`                       | `(tenant, generation_id, scope_id, record_key, facet)`           | key class, `bucket_hash`, semantic/configuration/projection versions, parent/topology version, readiness                                   |
| `bucket_versions`                        | `(tenant, generation_id, scope_id, key_class, bucket_hash)`      | monotonic `version`                                                                                                                        |
| `comparison_work`                        | `(tenant, generation_id, scope_id, record_key, facet)`           | coalesced projection work, monotonic work/completed versions and due time                                                                  |
| `inventory_membership_versions`          | `(tenant, scope_id, entity_family, record_key, facet)`           | monotonic source membership certainty version, independent of unchanged observation freshness                                              |
| `comparison_projection_payloads`         | `(tenant, scope_id, payload_id)`                                 | immutable encrypted comparison body, connection/AAD binding, encrypted byte size                                                           |
| `comparison_projections`                 | `(tenant, generation_id, scope_id, record_key, facet)`           | versioned current body reference, ready/held/excluded state, semantic/configuration/topology/membership inputs and source coverage binding |
| `comparison_projection_pages`            | `(tenant, page_id)`                                              | guarded publication manifest and immutable commit receipt; private row/dependency relations are removed on commit                          |
| `inventory_projection_jobs`              | `(tenant, generation_id, scope_id, operation_key)`               | coalesced topology/configuration work, captured version, completed version, bounded child cursor and due time                              |
| `inventory_projection_job_pages`         | `(tenant, page_id)`                                              | exact key-range/count, work/lease fences and immutable expansion receipt                                                                   |
| `inventory_projection_coverage_jobs`     | `(tenant, generation_id, scope_id)`                              | full-source baseline binding, captured work/completed versions and held-contact keyset cursor                                              |
| `inventory_projection_coverage_pages`    | `(tenant, page_id)`                                              | native bounded recovery manifest, lease/version fences and immutable commit receipt                                                        |
| `inventory_comparison_coordinators`      | `(tenant)`                                                       | durable phase/build cursor, phase count, progress/wake/observed versions, idle streak and next retry deadline                              |
| `inventory_comparison_wakeups`           | `(tenant)`                                                       | retained outbox clock, captured control/work versions, nullable next eligibility and exact-frame Queue publication time                    |
| `inventory_comparison_activations`       | `(tenant, activation_id)`                                        | captured pending/previous generation, domain/source-set/lease fences and immutable managed activation receipt                              |
| `matching_work`                          | `(tenant, generation_id, destination, source_scope, record_key)` | source/destination configuration, work/completed versions, due time, capacity hold and last completed dependency set                       |
| `inventory_match_work_claims`            | `(tenant, set_id)`                                               | immutable captured-work cohort count; matching-set receipt digest includes exact work claims                                               |
| `inventory_match_work_rows`              | `(tenant, set_id, source_scope, record_key)`                     | captured generation/destination, work/completed versions, configuration and due-time bindings                                              |
| `inventory_match_live_sets`              | `(tenant, set_id)`                                               | generation and exact current result reference count; scheduling entries disappear when the final reference leaves                          |
| `inventory_matching_bucket_dependents`   | `(tenant, set_id, scope_id, key_class, bucket_hash)`             | generation, exact original probe/token reference and observed invalidation clock                                                           |
| `inventory_matching_bucket_jobs`         | `(tenant, generation_id, scope_id, key_class, bucket_hash)`      | configuration, work/completed clocks and bounded `(observed_clock, set_id)` frontier                                                       |
| `inventory_matching_bucket_pages`        | `(tenant, page_id)`                                              | native guarded range/census, lease/clock fences and immutable expansion receipt                                                            |
| `inventory_matching_bucket_rows`         | `(tenant, page_id, destination, source_scope, record_key)`       | exact routed members, configuration and expected work/completed versions                                                                   |
| `inventory_matching_bucket_guards`       | `(tenant, page_id)`                                              | closed row manifest required before publishing queued work and the job frontier                                                            |
| `inventory_matching_selected_dependents` | `(tenant, set_id, source_scope, scope_id, facet, record_key)`    | current owner route, generation/destination, exact selected-input identity and captured local signal clock                                 |
| `inventory_matching_selected_jobs`       | `(tenant, generation_id, scope_id, facet, record_key)`           | coalesced selected-identity signal/work/completed clock, configuration, fair turn and route/cohort frontier                                |
| `inventory_matching_selected_pages`      | `(tenant, page_id)`                                              | exact current cohort/member census, work/domain/lease fences and immutable requeue receipt                                                 |
| `inventory_matching_selected_rows`       | `(tenant, page_id, destination, source_scope, record_key)`       | current routed member in any result state, configuration and expected matching-work versions                                               |
| `inventory_matching_selected_guards`     | `(tenant, page_id)`                                              | closed native row manifest required before selected-input work and frontier publication                                                    |
| `inventory_matching_pair_jobs`           | `(tenant, generation_id, destination, source_scope)`             | source/destination configuration and source-set version, work/completed clock, keyset cursor and logical last-served turn                  |
| `inventory_matching_pair_pages`          | `(tenant, page_id)`                                              | bounded source/current-result census, exact work/lease/cursor fences and immutable receipt                                                 |
| `inventory_matching_pair_rows`           | `(tenant, page_id, record_key)`                                  | exact routed key and prior work/completed versions                                                                                         |
| `inventory_matching_pair_guards`         | `(tenant, page_id)`                                              | closed census required before queue publication and cursor advancement                                                                     |
| `inventory_matching_coverage_clocks`     | `(tenant, scope_id, facet)`                                      | retained source/receipt set clock fencing partitions added after comparison preparation                                                    |
| `inventory_match_recovery`               | `(tenant, set_id, recovery_id)`                                  | immutable selected-subject reference and opaque source/day wait-point declaration; no plaintext contact date                               |
| `inventory_matching_coverage_dependents` | `(tenant, set_id, source_scope, scope_id, facet, node_hash)`     | current incomplete route, generation/destination, exact declaration/path reference and captured coverage clock                             |
| `inventory_matching_coverage_events`     | `(tenant, scope_id, stream_id, facet, partition_id)`             | coalesced readiness edge bound to configuration, original published full run, coverage version and work/completed clock                    |
| `inventory_matching_coverage_dispatches` | `(tenant, dispatch_id)`                                          | captured full selection/scope clock, generation/key/lease fences, opaque prefix list and immutable event-completion receipt                |
| `inventory_matching_coverage_jobs`       | `(tenant, generation_id, scope_id, facet, node_hash)`            | coalesced signal/work/completed clocks, route/cohort frontier and original dispatch reference                                              |
| `inventory_matching_coverage_pages`      | `(tenant, page_id)`                                              | exact current cohort/routed-member census, coverage/work/lease fences, fair frontier and immutable publication receipt                     |
| `inventory_matching_coverage_rows`       | `(tenant, page_id, destination, source_scope, record_key)`       | selected current incomplete member, configuration and expected matching-work versions                                                      |
| `inventory_matching_coverage_guards`     | `(tenant, page_id)`                                              | closed native row manifest required before queued work and frontier publication                                                            |
| `match_results`                          | `(tenant, destination, source_scope, record_key)`                | result version, shared dependency set, state/reason, remote reference, derivation time and next eligibility                                |
| `match_dependencies`                     | result key plus dependency kind, scope and dependency key        | key/index version, expected bucket/coverage/projection/ownership version                                                                   |

The implemented permanent ownership tables are separate from those rebuildable comparisons:

| Table                               | Key                                                              | Principal columns                                                                                                                                      |
| ----------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `inventory_ownership_domains`       | `(tenant, provider)`                                             | permanent key/format, monotonic ownership version                                                                                                      |
| `inventory_ownership_holds`         | `(tenant, provider, reference)`                                  | unresolved delivery/unverified owner/unsupported identity barrier                                                                                      |
| `inventory_ownership_buckets`       | `(tenant, provider, bucket_hash)`                                | retained monotonic candidate-domain version                                                                                                            |
| `inventory_ownership_evidence`      | `(tenant, id)`; unique provider claim                            | original LoFi logical identity/QSO, original source/destination scopes, book, canonical QRZ LOGID or LoTW claim, immutable encrypted historical record |
| `inventory_adoption_pages`          | `(tenant, page_id)`                                              | captured ownership version, fenced lease, digest, row/evidence counts and commit receipt                                                               |
| `inventory_adoption_rows`           | `(tenant, page_id, source_identity, record_key)`                 | exact matching result/version, original source/receipt payloads and owner/evidence references                                                          |
| `inventory_historical_associations` | `(tenant, provider, book_identity, source_identity, record_key)` | immutable read-only association and pinned original comparison proof                                                                                   |

An owner uses the LoFi logical account identity plus QSO UUID, independent of mutable scope/connection IDs. QRZ claims bind canonical LOGID to the logical book. LoTW retains original time precision and mode/group evidence and checks historical conflicts across inactive connections and query/signing accounts. Permanent ownership HMACs are independent of comparison generations. Provider-wide uncertainty holds remain until a proof-backed resolver can clear them.

The comparison index is derived and rebuildable. Only ordinary contacts enter it as QSO candidates; operation and event data remain projection dependencies. Initial complete records store one time bucket. Key classes are `call_and_time`, `call_only`, `time_only` and `unknown`; each class has a distinct HMAC domain. Pending/unavailable records immediately enter the narrowest known fallback domain. They cannot simply disappear behind a `readiness='ready'` filter.

The local implementation retains hashless `retired` bookkeeping entries when an indexed QSO becomes an event/deleted record. These entries are not candidates. Each semantic page change stages hints for both active and pending generations and advances every distinct old/new bucket once in the original ingestion transaction. Stable polls and metadata-only changes preserve index/work versions. Generation creation, side-by-side catch-up and activation are available through comparison APIs and hosted Queue/cron continuation.

Generation creation and source configuration changes now rely on bounded index backfill to queue each new/changed contact's projection work. They do not enumerate retained operations. Narrow operation/event mutation jobs still capture changes arriving during a build. The bounded-setup fixture, before coordinator wakeups, measures two native statements, sixteen rows read and nine written for both two and 250 retained operations with an existing tenant key and one source scope. This excludes key/domain reads and lease work; it is not a complete bootstrap cost. The local coordinator selects bounded build/projection/matching work and uses managed activation fences. Hosted continuation is implemented; full-pipeline performance qualification remains unfinished.

Pending-work selection and managed activation now probe current eligible generation/scope pairs before looking for work. Retired generations, disabled scopes and obsolete operation configurations do not cause retained pending history to be scanned on every turn. Scoped indexes replace three superseded tenant-global pending indexes; coverage uses an exact generation/scope key. Native fixtures retain 5,000 pending rows while selecting current work and activating safely. See the [selector costs and limits](evidence-inventory-coordinator.md#current-work-selection); many-scope and whole-turn costs still need qualification.

`comparison_domains.source_set_version` advances when a relevant source is linked, removed, reactivated or reconfigured. Every reverse-source result captures it; dependencies on previously known scopes alone cannot detect a new source. A newly visible source starts behind a baseline/context readiness barrier.

An operation/event addition, removal, move or semantic edit advances the operation's `topology_version` and installs its dirty projection barrier in the same page transaction. Each derived contact records the topology version used. A stale projection cannot remain eligible while bounded child reprojection is pending. Relevant unknown candidates remain holds until their operation context is ready.

Build a new key/format generation alongside the active generation, catch it up to every participating scope's accepted record versions, including destination observations, and atomically publish the domain's active-generation pointer. Results depend on that pointer. This allows bounded rebuilds without mixing minute and half-hour indexes or replacing active rows in place.

Suggested lookup indexes:

```sql
-- Illustrative definitions; final migrations must include tenant-scoped FKs.
CREATE INDEX comparison_bucket
  ON comparison_index(tenant, generation_id, scope_id, key_class, bucket_hash);
CREATE INDEX inventory_parent
  ON inventory_records(tenant, scope_id, parent_key, entity_family, subtype);
CREATE INDEX matching_work_scope_pending
  ON matching_work(tenant, generation_id, destination, source_scope,
    source_config_version, destination_config_version, due_at, record_key)
  WHERE completed_version < work_version;
CREATE INDEX match_result_due
  ON match_results(tenant, destination, state, next_eligible_at, source_scope, record_key);
CREATE INDEX inventory_matching_bucket_dependents_cursor
  ON inventory_matching_bucket_dependents(tenant, generation_id, scope_id,
    key_class, bucket_hash, seen_version, set_id);
```

Keep scope/configuration versions distinct from observation times. Increment semantic record and bucket versions only when relevant data or status changes. A successful unchanged poll advances freshness without forcing every result to recompute.

Retain fenced lease semantics. A worker finishes only the claimed work version; a newer invalidation that arrives during a lease must remain queued. `inventory_streams` is the single checkpoint authority. The fresh database has no parallel legacy cursor or materialization to synchronize.

### Upload batch tables

| Table                    | Key                            | Principal columns                                                                                                                                                  |
| ------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `upload_batches`         | `(tenant, batch_id)`           | destination, immutable artifact reference/hash, credential and station configuration versions, signing/authorization policy versions, member count, creation time  |
| `upload_batch_members`   | `(tenant, batch_id, ordinal)`  | transport version, immutable attempt reference, source generation, per-member payload/source/identity hashes and signed-contact binding; unique attempt membership |
| `upload_batch_artifacts` | `(tenant, batch_id)`           | one immutable original wire-artifact envelope with its encryption binding, digest, original metadata and retention references                                      |
| `upload_batch_state`     | `(tenant, batch_id)`           | state, fenced lease, due/dispatched/updated times, fixed outcome code                                                                                              |
| `upload_batch_events`    | `(tenant, batch_id, event_id)` | immutable state transition, time and fixed reason; consistent with member attempt events                                                                           |

Each member remains an ordinary per-QSO attempt with its own ledger and outcome. Keep its immutable per-QSO prepared representation separate from the batch's exact wire file. Preserve per-member hashes and the batch digest as distinct values. Bind every ordinal to exactly one signed contact; reject duplicate, missing, reordered or extra unclaimed contacts. Existing singleton payload/ownership hashes must not be reinterpreted as batch hashes.

Define attempts, batch membership and transport versions together in the fresh schema, using explicit-column writers and complete constraints. `upload_batch_members` remains useful for immutable ordered membership; retaining the old `attempts` column layout is not a requirement. Old positional writers are not supported against this database.

The shared file is batch-owned, with reference-aware collection after all member/recovery pins are released. Separate member payload references from the wire artifact. Current singleton cleanup/capture behavior would delete shared bytes too early or duplicate the file, so replace it with native batch-aware capture/resolution. Fresh single-member and multi-member submissions use the new artifact rules; importing old `attempt_artifacts` is unnecessary.

Native guards cover dispatch, cancellation, retry, lease-expiry recovery and reconciliation entry points for batch members. Claim batch state, all expected member states, proof/ownership and one vendor request reservation atomically, asserting the exact directly transitioned member count before network I/O. Any failed member rolls the entire claim back. A member cannot become an independently retried singleton through another code path.

## Adapter contract

Separate inventory transport, comparison policy and submission. The scheduler owns work persistence, fencing, tenant boundaries and vendor budgets. Adapters must use the injected admitted transport for every request, including authentication, status and fallback reads.

| Contract area       | Required behavior                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Scope               | Verify logical account/book, query shape and credential access without replacing durable identity                              |
| Capabilities        | Declare baseline shape, delta precision, stable IDs, deletion coverage, reread options, batch submission and readback coverage |
| Page read           | Return explicit records, continuation, completion classification, captured query bounds and proposed checkpoint                |
| Normalization       | Preserve original precision, remote identity, unsupported/unknown fields relevant to matching, and conflicting variants        |
| Comparison          | Apply provider-specific tolerance, mode, satellite, station and operating-location policy                                      |
| Submission          | Build an immutable artifact and report submitted, rejected or uncertain independently of later observation                     |
| Receipt observation | Verify a particular attempt's identity and supported projection; return field coverage and member outcomes                     |

A generic `complete: true` must not imply identical guarantees across services. Results need a tagged distinction between successful covered observations, continuation, ambiguous empty selection, unsupported coverage and failure. An empty array alone is never a completeness signal.

An adapter must compare observations explicitly as `same`, `newer`, `older`, `conflict` or `unordered`. Opaque revisions and local response arrival times are not universally ordered vendor versions. Default to serialized reads and ingestion for a logical scope/facet when ordering is unavailable. A late baseline response cannot overwrite a newer delta observation; contradictory unordered observations remain retained for verification. Separate receipt and confirmation facet merges even when their observations share one logical QSO.

The proposed interface shape is:

```ts
type OpaqueState = Readonly<Record<string, unknown>>;

interface QueryBinding {
  provider: string;
  scopeId: string;
  configVersion: number;
  queryFingerprint: string;
  checkpointFormat: number;
}

interface ReadContext {
  transport: AdmittedTransport; // Core admission; no Store/D1 access in adapter.
  limits: {
    maxRequests: number;
    maxRecords: number;
    maxResponseBytes: number;
    deadlineAt: number;
  };
  signal: AbortSignal;
}

interface StreamCapability {
  name: string;
  purpose: "source" | "receipt" | "confirmation";
  baseline: "cursor" | "paged_selection" | "bounded_report" | "unsupported";
  delta: "server_stamp" | "modified_date" | "received_stamp" | "unsupported";
  deletions: "unknown" | "explicit_tombstones" | "verified_change_feed";
  recordIds: "stable" | "identity_and_variants";
  checkpointPrecision: "millisecond" | "second" | "date" | "opaque";
  contractVersion: string;
}

interface Observation {
  streamId: string;
  recordKey: string;
  identityGroup?: string;
  kind: "operation" | "qso" | "event";
  parentKey?: string;
  facet: "source" | "receipt" | "confirmation";
  operation: "replace" | "patch" | "tombstone";
  revision?: OpaqueState;
  suppliedFields: readonly string[];
  payload: unknown; // Validated by the provider schema before return.
}

type StreamProgress =
  | { kind: "continue"; resume: OpaqueState }
  | {
      kind: "observed_complete";
      resume: OpaqueState;
      proposedCheckpoint: OpaqueState | null;
      coverage: CoverageClaim;
    };

type ReadResult =
  | {
      kind: "page";
      binding: QueryBinding;
      observations: readonly Observation[];
      progress: Readonly<Record<string, StreamProgress>>;
      startedAt: number;
      completedAt: number;
    }
  | { kind: "split"; partitions: readonly OpaqueState[] }
  | { kind: "deferred"; retryAt: number; code: ReadCode }
  | { kind: "blocked"; code: ReadCode; recovery: RecoveryAction }
  | { kind: "unsupported"; capability: CapabilityName };

type MergeDecision =
  | { kind: "same" | "newer" | "older" }
  | { kind: "conflict" | "unordered"; code: MergeCode };

interface InventoryAdapter {
  capabilities(scope: VerifiedScope): readonly StreamCapability[];
  readStep(
    context: ReadContext,
    request: BoundReadRequest,
  ): Promise<ReadResult>;
  compareObservations(
    current: Observation,
    incoming: Observation,
  ): MergeDecision;
}
```

This is a design sketch. Core types such as `CoverageClaim`, `ReadCode` and `RecoveryAction` need finite, versioned definitions before implementation. Coverage claims identify the successful selection and deletion guarantees and default to no immutable snapshot guarantee. Capability declarations are bound to the verified scope, access and contract evidence; signing support does not imply receipt-query access.

The separate comparison policy exposes versioned candidate-interval and precise comparison functions. The submission adapter builds immutable artifacts, submits through a core-owned write context, distinguishes `not_dispatched` from submitted/rejected/uncertain, and evaluates per-member receipt evidence. These interfaces cannot create their own write authorization or silently reuse the historical time window for exact receipt verification.

Every read step has a total request/byte/record/deadline budget, including token renewal, STATUS and covering fallback. Cursor refusal requests bounded restart/reconciliation. QRZ ambiguous-empty failure requests verification/retry without checkpoint advancement. An oversized LoTW report requests a range split; an unsplittable overflow becomes a visible hold.

LoFi's inbound sync is read-only at the QSO/operation level in Ferry, even though its sync transport uses POST. Connection/authentication operations and log mutations remain separate capabilities. Club Log stays a future adapter; the existing database kind constraints and TypeScript unions must be migrated explicitly when it is added.

## Bulk ingestion and atomic checkpoints

### Current statement amplification

The current writer builds a per-record recipe in [sourceStatements](../src/intake.ts) and combines the recipes into one `Store.checkpoint` batch. The [100-operation/100-event baseline fixture](../tests/source-baseline-pages.test.ts) asserts 1,708 explicit statements; the [100-operation/100-ordinary-contact forward fixture](../tests/intake.test.ts) has the same total through a different final work category.

| Work in the 200-record fixtures                                                 | Explicit statements |
| ------------------------------------------------------------------------------- | ------------------: |
| Insert/delete per-record compare-and-set guard rows                             |                 400 |
| Insert new payload and delete previous payload separately                       |                 400 |
| Upsert current source rows                                                      |                 200 |
| Update positive-presence metadata separately                                    |                 200 |
| Insert first-seen/birth facts for QSO-stream records                            |                 100 |
| Invalidate source/ledger context for the 100 operations                         |                 200 |
| Invalidate context for 100 events, or publish indexes for 100 ordinary contacts |                 200 |
| Page-level source/policy/context/cursor guards and updates                      |                   8 |
| Total                                                                           |               1,708 |

This is one native checkpoint call, not 1,708 network round trips. Trigger bodies add SQL and row work beyond that explicit statement-array count. Ordinary-contact publication also attempts tenant index-key activation once per contact. Operation/event handling can revisit the same dependent contacts repeatedly within a page. The 1,800-statement application cap protects this implementation; it is not the target shape for larger pages.

### Prepared page representation

Prepare a typed page delta outside the database transaction. Validate framing, identity and timestamps; load bounded existing metadata together; compute revisions, relevant semantic fingerprints, lookup tokens and required ciphertext. Reuse imported crypto/index keys within their scope. Encrypt only new/changed or legitimately restored bodies. Unchanged content and newer server stamps do not require another encrypted copy.

Fold repeated identities in the response deterministically, preserving observations needed to detect equal-server-stamp conflicts, first-seen provenance, membership, and all affected old/intermediate/new operation domains. Any equal-stamp/different-body conflict rejects the page rather than choosing a last row. A stale incoming observation cannot refresh positive evidence for a newer current revision. Keep provider-specific merge ordering; opaque revisions are not universally comparable.

Classify rows as new, changed, observation-only, superseded, recovery-needed or conflict. Distinguish raw-body revision, observation freshness and comparison/context semantics. Persist a new raw body when necessary, but only relevant semantic changes reset quiet periods, invalidate matching or dirty operation topology. Reuse the existing destination/source fingerprint rules rather than treating every raw metadata difference as a meaningful edit.

### Publication transaction

Use a small set of relational operations over the page, with byte-bounded JSON inputs instead of constructing SQL for each record. The default sequence is:
1. Establish the page identity and common account/source/credential/query/configuration, lease/fence, stream and active-index-generation guards.
2. Bulk-load prepared metadata into `ingestion_page_rows`. Assert all expected current row versions and expected absences through indexed joins. Derive affected old index/parent domains from the current database state before replacing pointers, so concurrent index maintenance cannot make prepared old-effect metadata authoritative by accident.
3. Bulk-insert immutable first-seen facts from the pre-page classification, preserving existing birth facts and historical/forward provenance. Do this before current-row upserts, as the existing rule requires.
4. Bulk-insert the required immutable payloads from bounded encrypted input chunks. Do not delete the previous body here.
5. Bulk-upsert canonical entity/facet rows. Include exact-version positive observation metadata in the appropriate facet operation; separate bulk observation-only updates touch metadata without rewriting payloads or semantic indexes.
6. Bulk-upsert scan membership and ready/partial comparison entries, with distinct metadata for source, receipt and confirmation facets.
7. Advance each distinct affected operation topology/domain and old/new/fallback bucket version once for the entire page. Immediately install dirty/unknown barriers before the transaction becomes visible.
8. Coalesce durable projection/matching/cleanup work by operation, bucket or scope. Do not update every dependent ledger/contact repeatedly during intake; the immediate domain barriers make stale projections ineligible while bounded reprojection catches up.
9. Save run/policy progress, observation metadata, the vector checkpoint, commit receipt and continuation outbox together. Recheck lease/time-sensitive guards and assert the expected checkpoint transition inside SQL before commit. Remove scratch rows in the same default-path transaction.

All operations use tenant-scoped, explicit column lists. A page-wide guard still validates every affected row; it replaces repeated guard bookkeeping, not the compare-and-set conditions. A failed predicate must raise a native transaction error. Silently skipping a raced row and advancing the cursor would lose source changes. Likewise, checking counts in JavaScript after `batch()` returns cannot roll back an already committed page; mandatory count/transition assertions belong inside the transaction.

For example, all encrypted source bodies in one bounded input chunk can use one statement:

```sql
-- Illustrative bulk operation, not an executable migration or complete writer.
INSERT INTO private_data
  (tenant, connection, id, kind, envelope, created_at, expires_at)
SELECT ?1, ?2,
       json_extract(value, '$.id'),
       'inventory_source',
       json_extract(value, '$.envelope'),
       ?3, NULL
FROM json_each(?4);
```

The worker assigns the tenant/connection/time and validates the prepared input; vendor records do not supply those authority fields. Canonical-row and index changes use corresponding `INSERT ... SELECT ... ON CONFLICT DO UPDATE` operations over typed page rows. Use conflict-specific handling and semantic predicates: a blanket `OR IGNORE` must not hide unexpected body, identity or integrity conflicts. Include a WHERE clause in SELECT-based UPSERTs to avoid SQLite's join/ON CONFLICT parsing ambiguity. See [SQLite UPSERT](https://www.sqlite.org/lang_upsert.html).

### Trigger and invalidation ownership

A bulk INSERT still fires row triggers. Replacing 1,000 prepared statements with one INSERT does not eliminate any existing per-row trigger fan-out. Audit the full trigger graph as part of this design: [reconciliation work](../migrations/0018_reconciliation_work.sql), [source presence](../migrations/0027_source_presence.sql), [proof body versions](../migrations/0028_source_export_proofs.sql) and [historical index maintenance](../migrations/0033_source_historical_index.sql).

The fresh inventory writer owns derived invalidation explicitly in its page transaction. Keep native uniqueness, foreign-key, immutable-evidence, publication and dispatch protections. Build the fresh schema with the distinct domain operations above rather than copying old broad derived-state trigger effects. The old trigger graph is a behavioral reference and cost baseline, not a compatibility requirement.

Benchmark the fresh publication path against the recorded old-path fixtures and report complete ingestion cost. Large-page activation requires native source/projection guards that consume the new immediate domain barriers. There is no old per-child fan-out or dual-write mode to preserve, and no SQL guard may silently keep reading the old `source_work` model.

An operation with 100 changed events therefore gets one immediate topology barrier and one coalesced reprojection job, rather than 100 passes over its children. A changed record that remains in the same bucket still advances that bucket once; unknown-to-complete moves advance both domains. An unchanged replay updates only required membership/observation metadata and does not re-encrypt bodies, reactivate the same key per row, or dirty unchanged semantic work. Source tombstones invalidate current dispatch eligibility immediately even if unsent-attempt cancellation is subsequently completed by a worker.

### Bounds and larger page staging

Statement growth should follow a fixed set of table operations plus byte chunks, not a fixed recipe multiplied by records. The initial design target was about 20–30 explicit publication statements for a representative 1,000-record page with one writer generation. The [local comparison benchmark](evidence-inventory-comparison.md) now measures **22 statements for 1,000 source records**, including hints, narrow invalidation and coalesced projection work. Additional statements follow bounded chunks/streams/generations. Row writes, encryption and HMAC work still scale with accepted records and indexes; this fixture does not establish full-log elapsed time or hosted billing.

Use an initial 512 KiB ceiling per bound metadata/ciphertext input chunk, retaining an independent whole-page wire/plaintext/encrypted/heap budget. Respect D1's parameter, string/row and SQL-size limits, and its whole-batch 30-second duration limit. Keep publication comfortably below that limit in native and remote measurements. Larger allowed row counts do not justify a larger byte or transaction budget by themselves. See [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Separate the remote page size from database input chunk size. The first qualified profiles are 200, 500 and 1,000 records; extend to 2,000–5,000 only if response parsing, memory, encryption and final publication fit their measured budgets. Both streams can return full pages, and large records/timestamp groups must be included. Retire the legacy 1,800-statement application cap on the new writer only after its replacement byte/time/row-work protections pass.

If a larger page needs preparation across multiple D1 calls, persist immutable bodies and page staging chunks while leaving canonical pointers, match visibility and authoritative cursors unchanged. Validate a complete ordered manifest/digest and perform the same final guarded publication in one transaction. Prepared data are not source observations available to the matcher until publication. A crash leaves collectable/pinned preparation, not a partially accepted page. Do not fetch the next remote page using a tentative cursor. If final publication itself cannot fit, reduce the remote page or design a separately proven versioned-publication model; splitting canonical updates into independently visible chunks is not an implicit fallback.

### Recovery and collection

Give each fetched page a stable page ID through its publication attempt and preserve the original request start and input digest. A failed transaction commits none of its canonical changes. If the checkpoint response is lost, inspect the page receipt and current authoritative stream state before retrying. A matching committed receipt means the page already applied; reload current progress instead of replaying writes or restoring an older cursor. Never renew the page's source-observation time during recovery.

Old bodies leave the hot pointer through bulk replacement and enter deferred collection. Delete them only after current records, unresolved attempts, active matching/shadow runs, staged pages and recovery references release them. Collector work is bounded and separate from ingestion; it must not reintroduce one payload-delete statement per incoming record.

## Incremental synchronization

### LoFi

Use the existing all-client baseline, forward drain and quarantine sequence. Preserve independent operation and QSO progress and opaque cursor handling. Forward sync follows server `syncedAtMillis`, so offline uploads and edits to old contacts can arrive without a historical contact-date scan.

Persist raw records, dependency metadata, comparison invalidations and the next cursor in one guarded transaction. Operation-only edits invalidate affected contact projections, even when QSO revisions are unchanged. Preserve event/tombstone/test semantics and equal-server-stamp conflict handling.

Do not assume a universal selective UUID reread. The current adapter supports operation-QSO rereads; PoLo also exposes a general QSO listing, but its arbitrary UUID filtering contract has not been established. Durable source retention avoids making routine delivery depend on that unresolved capability. See [source evidence](evidence-lofi.md) and [LoFi client](../src/lofi.ts).

An initial all-account source scan does not prove complete reverse-source uniqueness for an arbitrary historical time partition until the necessary source baseline/context coverage is ready. Publish destination partitions independently, but do not infer source completeness from QSO dates in an unfinished server-sync stream.

### LoFi bootstrap throughput

The current `24 total / 4 background` requests per five minutes is Ferry policy, introduced in commit `7713a7f` to bound shared traffic and reserve capacity for foreground work. That commit provides no upstream quota or measured derivation for the specific four-request background value. It is a historical baseline for comparison, not a requirement for the new design.

There are three distinct local limits: the vendor-wide background allowance, the source-proof collector's four-request cohort budget, and each read/page/checkpoint bound. Revising initial inventory admission does not change the proof collector's budget or proof semantics. A bootstrap read is not an upload or a source-wide cutover authorization.

Current [HaLo source](https://github.com/ham2k/halo/blob/507c7741cd9b8882a64591b04edf0fdd4aa8c574/packages/halo_core/lib/src/sync/sync_engine.dart#L129-L199) sets a normal pull size of 5,201 records and a client constant of 20,000 for its stated server maximum. It separately [requests large inbound pages](https://github.com/ham2k/halo/blob/507c7741cd9b8882a64591b04edf0fdd4aa8c574/packages/halo_core/lib/src/sync/sync_engine.dart#L799-L814) while preserving the server-suggested outbound batch size. This is primary client evidence, not verification of Ferry's account/server behavior or permission to discard Ferry's byte and transaction bounds. The current Ferry adapter's 200-row ceiling is local validation, not an established vendor maximum.

The proposed bootstrap policy is:

| Control                                           | Planning choice                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Vendor-wide total                                 | Retain the existing 24 requests/five minutes initially; measure before considering a higher total                                          |
| Combined nonforeground allowance during bootstrap | Up to 20 requests/five minutes across bootstrap and other background source work, leaving four slots reserved for foreground demand        |
| Ordinary background sublimit                      | Keep its four-request allowance inside the combined nonforeground ceiling; do not add it on top of 20                                      |
| Foreground priority                               | Due established-source/proof/authentication work runs first and may consume more than its reserve, reducing bootstrap capacity             |
| Source concurrency                                | One fenced request chain per LoFi client/source across operation and QSO streams                                                           |
| Page size                                         | Validate 200 as an intermediate step; target adaptive 500–1,000-record QSO pulls with separately budgeted operation records                |
| Backlog pacing                                    | Honor validated server loop-delay guidance; proposed 20-second fallback when absent; local five-second floor when guidance is shorter/zero |
| Idle pacing                                       | Return to normal product polling once caught up, respecting a longer server check period; do not reuse the backlog rate indefinitely       |

This is a source-inventory allocation, not relabeling every historical delivery as foreground traffic. All requests, including renewal and retries, still use persistent vendor admission. A future multi-account bootstrap shares the same global allowance; it is not 20 requests per account. Add a persisted global pacing/burst bound alongside per-source timing so multiple sources and fixed-window rollover cannot generate a synchronized request burst.

Read and persist the server tuning values from top-level camelCase, top-level snake_case or nested `meta.flags` snake_case, matching the [current HaLo parser](https://github.com/ham2k/halo/blob/507c7741cd9b8882a64591b04edf0fdd4aa8c574/packages/halo_core/lib/src/sync/sync_engine.dart#L1133-L1185). The relevant knobs are `suggested_sync_loop_delay` and `suggested_sync_check_period`, in milliseconds. Loop delay zero is valid guidance, with local pacing/admission still preventing a hot loop; idle check period must be positive. Server-suggested sync batch size is not automatically an inbound-read cap, because upstream now distinguishes pull size from push batch size.

Persist `next_read_at`, validated loop/idle hints, their observation time and pacing-policy version per client/source. Recheck them under the read lease/admission fence. Honor Retry-After and back off on 429/503, transport failures and repeated empty-incomplete pages. An empty-incomplete page preserves cursor/progress and schedules a later read; it cannot complete inventory or trigger an immediate busy loop. A repeated opaque cursor remains a bounded reconciliation/diagnostic condition, not permission to increase page size indefinitely.

For a single healthy 200,000-contact QSO stream, a 20-request/five-minute bootstrap allocation gives these arithmetic data-page floors:

| Requested records/page | Data pages | Quota-only equivalent | With illustrative 20-second pacing | With illustrative 35-second pacing |
| ---------------------- | ---------: | --------------------: | ---------------------------------: | ---------------------------------: |
| 100                    |      2,000 |    8 hours 20 minutes |                 11 hours 7 minutes |                19 hours 27 minutes |
| 200                    |      1,000 |    4 hours 10 minutes |                 5 hours 33 minutes |                 9 hours 43 minutes |
| 500                    |        400 |     1 hour 40 minutes |                 2 hours 13 minutes |                 3 hours 53 minutes |
| 1,000                  |        200 |            50 minutes |                   1 hour 7 minutes |                  1 hour 57 minutes |

Paced columns use the slower of the quota-equivalent rate and the illustrative delay. They exclude HTTP latency, database/crypto work, operation/events, empty pages, retries, other accounts and final catch-up. Twenty/35 seconds are scenario inputs, not observed settings for Ferry's account. The larger-page range creates room for the 2–4-hour target; the 200-row intermediate alone does not reliably do so.

The page-size controller uses measured response/encrypted bytes and checkpoint CPU/SQL/wall time, not just row counts. The [bulk ingestion design](#bulk-ingestion-and-atomic-checkpoints) replaces the current per-record statement recipes with prepared page deltas and set-based publication. Begin with current byte protections and profile 200, 500 and 1,000 on that path; higher profiles follow its byte/time acceptance. If a candidate page does not fit, retry a smaller limit from the original cursor only after a deterministic precommit failure. Uncertain checkpoint outcomes require checkpoint reconciliation first. Never truncate a returned page or split cursor advancement from accepted records.

Do not jump to 5,201 records because another client requests it: Ferry encrypts/publishes database state and has different memory/commit costs. Larger byte bounds or staged-page publication need their own design and measurements if 500–1,000 cannot fit. The final page profile must cover simultaneous operation/QSO responses, large individual records and complete timestamp groups.

Move source bootstrap work onto durable delayed continuations in phase C, with cron as recovery. A queue message carries only job identity/version; the handler acquires the existing fence, reads current due/pacing state, performs bounded work and schedules the next continuation. Save `inventory_wakeups` in the page transaction, publish after commit, and recover unpublished or duplicate wakeups idempotently. [Cloudflare Queues supports delayed delivery](https://developers.cloudflare.com/queues/configuration/batching-retries/#delay-messages). Reaching the current 90-second turn budget should yield to another due continuation, not force a wait for the next five-minute cron. A queue is not permission to bypass pacing or extend a database transaction across I/O.

Measure useful committed records/minute, effective page size, request/empty-page counts, enforced wait reasons, database latency/SQL time, CPU/memory, and remaining work. Acceptance is a representative native 200,000-contact baseline plus catch-up/context within the proposed hours target when upstream conditions permit, with intact cursor/fence/coverage behavior and no starvation of established foreground work. Attribute upstream cooldown/outage and database bottlenecks separately. No credentialed probe or runtime setting changes are authorized by this planning revision.

### QRZ

Baseline each relevant book using bounded date ranges and `AFTERLOGID` paging. Query all accepted records, including unconfirmed contacts. Incremental runs use a fixed `MODSINCE` lower date with overlap for date precision and restart paging at the beginning of that modification selection. Scanning only increasing LOGIDs would miss edits to older IDs.

Checkpoint a modification run only after every required page succeeds. Preserve the current ambiguous-empty handling: a generic failed empty selection does not complete a delta or prove absence. Retain the successful full/covering-read fallback and its scope checks. Query rejection, changing framing or incomplete catch-up leaves affected coverage unresolved.

Use periodic bounded inventory verification for changes not established by the delta contract, including disappearance. See the [QRZ API](https://www.qrz.com/docs/logbook/QRZLogbookAPI.html) and [adapter evidence](evidence-qrz.md).

### LoTW

Baseline bounded station/date ranges, splitting oversized responses. Include accepted unconfirmed QSOs and own-station/location details. Incremental receipt queries use `qso_qsorxsince`, with inclusive overlap and a checkpoint tied to the identical query scope. `APP_LOTW_LASTQSORX` is not an account-wide checkpoint when obtained from a restricted report.

Track confirmation updates separately using the QSL stream. This is new adapter work: the current query implementation requests `qso_qsl=no`. A confirmation-only report cannot replace receipt inventory. Empty reports do not justify advancing a checkpoint to local wall time unless the contract establishes that boundary. Report precision and missing fields remain visible to matching and receipt verification. See the [LoTW query API](https://lotw.arrl.org/lotw-help/developer-query-qsos-qsls/).

### Commit and recovery

Each page transaction saves records, scan membership, semantic bucket changes, durable matching work and the next cursor together. A crash before commit replays the page. A crash after commit resumes the saved cursor. No cursor moves ahead of the records it covers.

Source and destination baselines, delta reads, verification sweeps, matching and delivery receive separate fair work turns. A large import must not starve forward arrivals. Keep persistent vendor admission and Retry-After enforcement. The proposed LoFi bootstrap allocation above replaces its fixed four-request background share; QRZ/LoTW request policies remain unchanged in this revision.

## Bulk matching

### Candidate index

For a complete record, use a tenant-keyed HMAC over a canonical tuple:

```text
candidate_hash = HMAC(tenant_key,
  ["comparison-bucket", index_version, normalization_version,
   "call_and_time", normalized_worked_call,
   floor(utc_timestamp_ms / 1800000)])
```

Use the same normalization/key namespace across compared services. Keep service, account/book and record IDs in separate columns. Initially leave station, band and mode out of this broad lookup, retaining their validation in the precise matcher. This avoids hiding relevant candidates whose context or provider normalization differs.

For a second/minute-precision source and a 30-minute tolerance, the query normally probes previous/current/next buckets. More generally, generate every bucket intersecting the complete precision-aware candidate interval and the adapter's tolerance. For 13:05, the three buckets retrieve 12:30 through just before 14:00; runtime comparison narrows the window to 12:35 through 13:35.

The bucket is a candidate index, not stable QSO identity. Maintain separate key ID, bucket-format and normalization versions. Existing minute-bucket HMACs cannot be converted to coarser hashes; rebuilding requires source/comparison data. Keep old keys recoverable while their indexes, artifacts or backups remain relevant.

### Matching transaction

1. Claim a bounded work cohort and capture its work version.
2. Load routing, coverage, relevant projection versions and index metadata together.
3. Generate/deduplicate probes and join them to indexed candidate rows in one bounded database operation.
4. Admit the union of source/destination bodies and context dependencies against row/byte limits, then load and decrypt each once.
5. Apply the current precision-aware matcher, operating-detail checks, reverse-source uniqueness and durable remote ownership rules.
6. Save results through a guarded native batch and complete only the claimed work versions.

Initial proposed bounds are 20 source contacts for one destination, 128 distinct records in the union of forward and reverse candidates, 256 distinct context dependencies, and a 4 MiB decrypted cohort budget. Admit encrypted sizes before loading and enforce plaintext limits during decoding; persisted size metadata must agree with referenced envelopes. These are union limits across the entire cohort, not allowances multiplied by every lookup. Split overflow into durable continuations. An individual dense/unknown group that still exceeds a bound remains incomplete; truncation cannot establish absence or uniqueness.

Results distinguish `matched_existing`, `matched_ferry_owned`, `absent_at_inventory`, `ambiguous`, `projection_mismatch` and `incomplete`. Matching a historical record preserves its association-only restrictions. A changed source fingerprint does not grant correction permission for an adopted historical association.

The local [relation pass](../src/inventory-matching-graph.ts) evaluates supplied forward/reverse candidate sets, with at most twenty selected sources and 128 distinct inputs. It shares each source/receipt predicate evaluation across the cohort, preserves LoTW source/receipt mode roles and holds missing, unsupported or precision-boundary evidence. Its `none` and `unique` classifications describe candidate geometry only. The workspace now applies shared operating-detail checks and native publication saves classified comparison observations. Historical adoption is now a separate native guarded phase; these base comparison facts still confer no delivery authority. Every input/probe dependency is retained, including excluded and currently irrelevant candidates.

The [snapshot collector](../src/inventory-matching-workspace.ts) now gathers those inputs, source visibility, coverage and all forward/reverse bucket versions with one shared body budget. Unregistered sources block reverse census, incomplete date selections cannot supply absence and unresolved source/receipt membership supplies an indexed scope-wide uncertainty barrier even outside the probed hashes. The twenty-pair fixture uses eleven complete preparation reads and forty decryptions; native publication/ownership/lease work is not included, so the six-call complete-cohort target remains unmet. See the matching evidence for boundaries and captured-data replay.

[Native result publication](../src/inventory-matching-results.ts) stores one shared immutable dependency set per bounded cohort and versioned result pointers. Typed scope/coverage/record/probe/token/candidate tables implement the logical `match_dependencies`. Native guards check exact coarse candidate closure, expected-zero versions, retained date-union dependencies and current input versions at admission and commit. The comparison-only twenty-result fixture uses eleven publication statements, 8,233 rows read and 1,053 rows written. Unchanged full verification preserves current result versions; changed dependencies hide the cohort until recomputed. These results do not create ownership or export authority.

The [matching-work lifecycle](evidence-inventory-matching-work.md) captures at most twenty due keys under the destination lease and completes their exact work versions in the result transaction. Its receipt binds the matching preparation and work claims; late invalidation rolls back publication, and old receipt replay cannot clear newer work. Source projection changes enqueue their selected keys atomically. Cohort capacity failures split without completing unprocessed keys; an indivisible dense group stays pending behind a durable paced hold. Current dependency, bucket and coverage invalidation, scope/connection enrollment and hosted coordination are implemented. Ownership-aware planning remains unfinished.

[Historical adoption](../src/inventory-associations.ts) now captures current matched result versions, original source/receipt projections and permanent ownership. Native admission/final guards validate exact record bindings and each distinct shared matching dependency set once, plus current credentials and provider-wide ownership-version fencing. Twenty associations publish through six statements with 4,657 rows read and 325 written, excluding preparation/receipt/lease work. The original source baseline and remote evidence remain pinned; source edits or connection rebinding cannot turn historical discovery into correction permission. Native stage/attempt guards enforce the read-only association. The complete matching/ownership six-RPC target remains unmet; automatic ownership-aware planning and new delivery ownership still need integration.

### Invalidation

Every relevant insert/edit/status change updates old and new bucket generations and enqueues affected work atomically. A result records dependencies for every forward and reverse lookup, including buckets that returned zero rows. Preserve aggregate source visibility across relevant linked LoFi scopes when proving reverse uniqueness.

The [current dependency index and bucket jobs](evidence-inventory-matching-invalidation.md) now implement bounded old/new bucket, projection-version and source-retirement scheduling. Retained superseded proofs are separate from current reverse dependencies. Ten cohorts and at most 200 still-current references publish per native page, with exact work versions, a fenced frontier and lost-acknowledgement recovery. Newly recomputed results record the current clock and are skipped by older pending invalidations. A fresh baseline with no current dependencies creates no empty bucket continuations. The [bounded pair census](evidence-inventory-matching-pairs.md) handles initial enrollment, scope/source-set/connection changes and scope-wide unresolved-membership transitions without contact fan-out inside metadata updates. Selective coverage recovery and coordinator/ownership integration remain required before automatic reconciliation activates.

Prepared comparisons also capture source/receipt coverage-set clocks, checked at native admission and final commit. Per-partition dependencies alone cannot detect a partition first added after preparation. These clocks fence publication while preserving an existing ready result across unchanged full verification. The clocks alone do not schedule recovery. The current wait-point index and bounded publishers below wake affected blocked comparisons without rescanning the entire source log for each LoTW day.

[Current wait points and readiness journaling](evidence-inventory-matching-coverage.md) now supply that scheduling input. A receipt comparison stores one currently missing day as an opaque calendar path; completing it requires a fresh comparison of the full window and any remaining gap. Source wildcards cover unchanged verification restoring projection visibility and another registered source completing an empty census. Only current incomplete routes materialize the prefix index. A complete range needs at most 44 query hashes rather than a day-by-day walk. The event dispatcher, bounded rematching publisher and coordinator/hosted integration are implemented. Projection recovery distinguishes missing source coverage from persistent operation/event context holds. Peak incomplete-log index/receipt storage still needs qualification.

Source membership certainty is a separate dependency from raw semantic versions and bucket membership. Operation/event membership changes advance the affected operation topology alongside semantic edits, coalesced once per page. Ordinary contact membership changes retain their hash, advance their membership version and queue only their own projection work. Every supplied candidate, including an excluded or presently irrelevant one, retains these dependencies; storing dependencies only for the eventual match would miss a later context change. Unresolved membership cannot establish deletion or absence. Unchanged successful verification updates coverage/freshness without forcing these per-record versions to advance.

An absent bucket-version row means version zero. Its first mutation creates version one; subsequent changes increment it. Version rows are not deleted/recreated within a generation. Compaction must advance a generation checked by every surviving dependency, preventing an old empty result from becoming current after a bucket changes and is emptied again.

For worked call C and interval W, probe C's complete time buckets, C's call-only domain, time-only domains intersecting W, and the relevant unknown/unpublished barrier. Capture each fallback version even when it returns no candidates. Moving a record from unknown/partial to complete updates both domains atomically.

A source at 13:00 can compete with another source at 14:00 for a remote at 13:30. Therefore invalidation must cover the reverse lookup around each remote candidate, not only the selected source's three buckets. Unknown and partial-key fallback domains also have generations and coverage barriers.

Record changes, context edits, route changes, ownership changes, new source scopes and query/policy changes invalidate the results that depend on them. Check those dependencies again in the commit transaction. An existing row's unchanged payload is insufficient when a new competitor has appeared.

`match_results_current` exposes only results whose generations, coverage, routing and policy dependencies are valid. Queue selection is then approximately:

```sql
SELECT tenant, source, qso, destination
FROM match_results_current
WHERE result = 'absent_at_inventory'
  AND next_eligible_at <= ?
ORDER BY next_eligible_at, source, qso
LIMIT ?;
```

This selects planning work. Existing proof and final destination checks remain required before staging/dispatch. Mapped corrections use a separate branch and the existing provenance rules. The view and due selector need query-plan/row-count benchmarks so dependency checks do not recreate whole-log scans.

## Preparation and submission

### Shared preparation

Load source data, routing, credentials, templates, ownership and match results for a bounded cohort. Reuse the source-proof coordinator's shared collection and final canonical drain while retaining each member's original generation, proof identity and expiry. Stage immutable per-QSO attempts with the existing individually guarded cohort transaction.

Implement source/adoption/proof guards directly against the new inventory and projection model. Existing guards that join `source_work` and unexpired `kind='source'` bodies cannot simply be copied unchanged. Preserve their correctness conditions, original observation metadata and ordinary fresh proof acquisition without a legacy compatibility materialization. Retaining or resealing source data is not a new source observation.

The new planner must not call back into the old per-contact historical discovery loop. Targeted final duplicate checks, uncertain-attempt readback and remote-field preservation remain distinct delivery operations. Existing concurrent external writer races are not made atomic by a local inventory.

### QRZ

Use bulk preparation and shared database work followed by individual serial writes under the book's delivery lease. Retain each write's fresh final neighborhood, current authorization and exact immutable request body. A duplicate response starts reconciliation and does not imply REPLACE permission.

The documented [QRZ INSERT](https://www.qrz.com/docs/logbook/QRZLogbookAPI.html) accepts one record. Treat an alternative multi-record upload protocol as a separate contract investigation. Do not assume batching preparation removes the per-record network request floor.

### LoTW

Group members by tenant, logical destination, certificate version, full station configuration, signing policy, traffic class and authorization mode. Initially cap batches at 20 contacts, within the current signer's 100-contact maximum and the submitter's 512,000-byte bound. These are application bounds, not claimed vendor limits. See [signer](../src/signing.ts) and [submitter](../src/lotw.ts).

Do not wait for a full batch. A sparse eligible cohort submits on its next fair scheduler turn. Share certificate checks only within their validated scope and lifetime.

Twenty is an upper bound, not a requirement to combine every eligible contact. Members must fit the source-proof dependency/request/byte limits and have overlapping valid proof lifetimes at the shared dispatch boundary. Split or send smaller cohorts when those conditions cannot be met. The existing LoTW fresh-insert payload check explicitly permits one member, so multi-member authorization needs a distinct versioned contract and acceptance evidence; changing the signer call alone cannot enable it.

The batch and every member are validated in one guarded claim before sending the saved artifact once. If an unsent artifact contains a cancelled/stale member, cancel the never-dispatched original batch/attempts and construct a replacement with new attempts for still-eligible members. Immutable membership must not be edited.

After dispatch may have occurred, preserve the exact artifact and mark submission/uncertainty for every affected member. A queue acknowledgement does not establish accepted processing of all QSOs. Resolve each member from current readback against that attempt's exact identity and supported projection. Do not blindly replay the whole file to recover an uncertain or partially observed outcome. Confirmation remains separate.

Member receipt resolution may occur after the original dispatch proof expires or the source changes. It uses the immutable attempt plus sufficient current remote evidence; it must not require renewing the old dispatch proof or adopting the latest source as the old attempt's payload. Keep new-source correction work separate. Ownership renewal and receipt correlation need a member-aware version of the existing singleton LoTW payload/identity bridge.

Readback queries may be shared where their scope covers multiple members, including through the incremental receipt scanner, but each member needs independent sufficient evidence. A preexisting historical identity or unsupported field coverage cannot acknowledge a later correction. See [LoTW submission contract](https://lotw.arrl.org/lotw-help/developer-submit-qsos/).

## First implementation milestone

Start implementation with a fresh-database bulk-ingestion slice. Broad architecture planning is sufficient; the next uncertain choices should be settled by running the actual prepared-page writer against native D1/workerd with synthetic LoFi pages.

The milestone includes the minimal fresh inventory/stream/facet, payload, ingestion-page/receipt and domain-barrier schema; a prepared-page representation; bulk guarded publication; restart/lost-ack recovery; and a reproducible benchmark. Keep comparison/submission interfaces explicit, but do not build every future table or provider in the first change. Reuse proven encryption and LoFi parsing/projection code where it fits the new contracts.

Exercise insert, update, unchanged replay, tombstone and event-heavy pages at 200, 500 and 1,000 records, then qualify larger profiles where bytes permit. Compare typed staging with direct bounded JSON relations and promote one canonical path. Verify rollback for races/late failures, same-stamp conflict handling, exact source-observation times, first-seen provenance and immediate topology/bucket barriers. Build a 200,000-contact synthetic import benchmark with CPU, memory, storage, row/trigger work, binding calls and explicit statement counts.

Success means a measured bulk writer with safe 500–1,000-record pages, understandable size/time limits, a substantial reduction from the old per-record recipe, and an end-to-end native ingestion cost model. Synthetic timing does not establish actual LoFi cooldowns or the hours target; a later bounded live-read validation supplies that evidence. No uploads, database resets or credentialed service requests are needed for this first milestone.

This first milestone is implemented and measured locally. The inventory runtime, comparison-key/index foundations, native encrypted projections, guarded comparison results/work completion and historical adoption have also advanced; see the evidence links at the top. Selected-input cohort invalidation and automatic edit/retirement/restoration recovery are implemented. Hosted comparison wakeups and bounded Queue/cron recovery are implemented. Initial [complete-pipeline measurements](evidence-inventory-pipeline.md) found and removed empty selected-input Queue amplification; larger and complete real-source qualification remains open. The next milestones are automatic adoption scheduling and ownership-aware planning, followed by new delivery ownership, source-proof and member-aware delivery integration. Adapter edge cases and batch submission remain focused work rather than reasons to extend broad planning indefinitely.

## Fresh database rollout phases

The earlier additive-migration sequence is superseded by the decision that existing contact/reconciliation contents need not be preserved. Preserve account/authentication/connection records and credential encryption identities. Use a fresh contact schema/environment; do not run old binaries against it or implement dual writers solely for historical database compatibility.

| Phase | Change                                                                                                                               | Exit criteria and deployment boundary                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | Define the minimal fresh schema and native integrity/publication guards                                                              | Empty-database initialization is reproducible; no old-schema writer compatibility required                                                          |
| B     | Implement prepared pages, set-based publication, domain barriers and commit receipts with synthetic LoFi inputs                      | Race/recovery invariants and native larger-page benchmarks pass; no live services needed                                                            |
| C     | Add real read adapters, paced LoFi bootstrap, larger qualified reads and durable continuations; inventory destinations independently | Preserved/new connections, correct coverage and observed pacing; uploads disabled                                                                   |
| D     | Implement local bulk matching and compare behavior using identical captured or synthetic inputs and reusable pure matching logic     | Explain semantic differences and measure full cohort/tick cost; new ownership/association rules hold                                                |
| E     | Rebuild historical associations from vendor observations under native inventory/source/adoption guards                               | Existing remote records stay historical; no fabricated old Ferry provenance or duplicate insertion                                                  |
| F1    | Add cohort preparation and individual QRZ dispatch plus normalized batch artifact/recovery machinery                                 | New-format source proofs, ownership, capture/GC and all-member claims pass before any upload activation                                             |
| F2    | Add LoTW member-aware authorization, signing, submission and receipt resolution                                                      | Proof fit, exact member binding, partial outcomes and restart recovery accepted                                                                     |
| G     | Perform a separate deployment cutover and scoped activation on the fresh database                                                    | Previous writer paused, outstanding remote work reconciled/held, read inventories ready, preserved access verified and new-format recovery verified |

Use `off`, `shadow` and `active` planner modes independently of export gates and batch-submission capability. Shadow comparison is an evaluation technique and does not require maintaining the old database schema. A planner activation does not authorize exports.

Preserve existing account, authentication and connection records, encrypted credentials, configuration and their required references. Validate that preserved credentials still decrypt under their original identities. Contact/mapping/attempt data import is not required. Existing remote history is observed and conservatively adopted, including remote narrative preservation. An absent new local mapping does not mean a contact is absent at a vendor.

At deployment cutover, pause the previous sender before allowing the replacement to write. Resolve or quarantine any outstanding submitted/dispatching/uncertain vendor work before treating a fresh negative read as permission to insert; a reset must not turn a possibly queued old upload into a new contact. This can be evaluated before the old database is retired without copying its complete history into the replacement. The local implementation and trial authorization does not include a production reset or cutover.

After the replacement starts submitting, its new durable ownership, immutable attempts/artifacts, template bindings and uncertain outcomes remain authoritative. Rollback must use a release compatible with the fresh schema and any dispatched batches, or pause new writes while its resolver remains available. Do not resume an old sender against independently re-inventoried state.

Define new-format restore quarantine in both the programmatic path and `ops/lock-restored.sql`. Restoring invalidates inventory/write freshness, disables dispatch, clears leases and puts unresolved batches/members into reconciliation-required state. Validate populated single-member/multi-member restore and repeated quarantine. Old-schema backup import and mixed-generation recovery are not required.

## Cost and throughput model

The proposed improvement is fewer external discovery requests and fewer database round trips per matched cohort. Coarser buckets also reduce token generation/index probes, while retrieving a wider candidate set. None of those changes remove source-proof, final write, signing or readback costs.

The [capacity plan](capacity-plan.md#bulk-preparation-and-queued-dispatch--local-measurements-2026-10-30) records local complete-scheduler measurements of 148 D1 RPCs for one direct-empty contact and 386 for six direct-empty contacts. Its isolated already-observed queue phase measures 3.3 RPCs per contact for 20 uploads, excluding inventory/planning/proof setup. The earlier warm matching fixture measures 118 cohort RPCs for 20 contacts across two destinations, or 40 routes. These are different measurement boundaries, not interchangeable estimates.

For N relevant contacts, page size P and changed records D, model baseline demand as paged inventory plus catch-up/verification, then incremental demand as changed pages plus necessary polling and verification sweeps. Bulk matching should scale with changed candidate groups and their dependencies. Cost estimates must count index writes, membership, invalidation fan-out, SQL rows, encryption/signing CPU, durable storage and backups alongside binding RPCs.

Under the current 100-row/four-background-request policy, 200,000 LoFi contacts require about 41.7 hours of request capacity before additional work. This is the legacy comparison, not the chosen bootstrap target. The proposed allocation/pacing and 500–1,000-row read profile are described in [LoFi bootstrap throughput](#lofi-bootstrap-throughput); their target is 2–4 hours under healthy service, subject to native ingestion and upstream pacing measurements.

### Inventory and matching scenarios

For the legacy inventory comparison, assume N relevant contacts at each destination, healthy already-covered matching inputs, no retries, 100 source QSOs/page, and 250 QRZ records/page. Matching totals below extrapolate the existing warm fixture and proposed target; they are not new benchmark results. Rate-equivalent time expresses consumed quota, not elapsed scheduling or vendor latency. Proposed LoFi bootstrap figures are in the separate pacing table above.

| Work                                 |       4,000 contacts |    200,000 contacts | Boundary                                                                   |
| ------------------------------------ | -------------------: | ------------------: | -------------------------------------------------------------------------- |
| LoFi QSO baseline data pages         |                   40 |               2,000 | Excludes operation/events, completion/drain and authentication             |
| LoFi background rate equivalent      |           50 minutes | 41 hours 40 minutes | Four global requests/five minutes                                          |
| QRZ baseline data pages              |                   16 |                 800 | Excludes completion, catch-up and verification                             |
| QRZ STATUS + FETCH baseline requests |                   32 |               1,600 | Current adapter verifies book identity before each page; excludes catch-up |
| QRZ background rate equivalent       | 6 minutes 40 seconds |  5 hours 33 minutes | 24 global requests/five minutes, including STATUS + FETCH                  |
| Current warm matching RPCs           |               23,600 |           1,180,000 | `118 * ceil(N / 20)` for both destinations                                 |
| Proposed matching target RPCs        |                2,400 |             120,000 | `2 * 6 * ceil(N / 20)` for both destinations                               |
| Added durable storage sensitivity    |             16–66 MB |        0.82–3.28 GB | Assumed 4–16 KiB/contact for new payload/index/dependency state            |

QRZ baseline request capacity includes STATUS verification before each FETCH. This was observed in the cross-provider Worker test; the two baseline/catch-up FETCHes also require two STATUS calls. Safe verification reuse remains unimplemented. These quota equivalents do not measure elapsed initial-sync time.

The target implies about 90% fewer matching-phase binding calls if full guarded adoption and ownership work fit the proposed boundary. It does not imply the same complete-scheduler reduction. In the isolated queue workload, substituting six planning calls for the current 120 would give `(66 + 6) / 20 = 3.6` RPCs/contact, still excluding source-proof setup, ingestion and maintenance. That is a design bound for that one-destination workload.

### QRZ request demand

The current QRZ total policy is 120 requests/five minutes, or 34,560/day. Cached inventory negatives cannot supply the immediate fresh `QrzEmptyObservation` token consumed by current preparation. Retaining the preparation read, final read and INSERT therefore gives an expected direct-empty path of three requests/contact. Phase E and early phase F retain this singleton authorization behavior.

| QRZ delivery scenario                               | Requests/day at 10,000 deliveries | Share of current daily allowance |
| --------------------------------------------------- | --------------------------------: | -------------------------------: |
| Retained direct-empty preparation/final/INSERT path |                            30,000 |                            86.8% |
| Existing one-page fallback path                     |                            70,000 |                           202.5% |
| Conditional final-read plus INSERT lower bound      |                            20,000 |                            57.9% |
| Twice the target at that two-request lower bound    |                            40,000 |                           115.7% |

The two-request case requires a separately established change that removes/merges the preparation read; the local matcher alone does not accomplish it. The current policy cannot provide 2x headroom through batching alone. These are application limits, not published upstream quotas. See [preparation](../src/delivery.ts), [request policy](../src/vendor-requests.ts) and the [request-demand measurements](capacity-plan.md).

Historical uploads also share QRZ's smaller background allowance: 24 requests/five minutes is 6,912/day. At three requests/contact, an all-missing 200,000-contact import would need a rate-equivalent minimum of about 86.8 days for QRZ delivery, before competing background reads or retries. Fast inventory/classification and fast completion of missing historical uploads are separate acceptance targets.

### Source proofs and LoTW batches

Model LoFi demand as discovery polling not already supplied by drains, plus fresh witness collection, canonical drains, baseline/context/verification and authentication. Preserve sharing of source evidence across both destination projections. A 20-contact matcher does not increase the scheduler's existing six-live/two-background preparation turns or its proof request/dependency/lifetime limits.

For illustration, packing 100 contacts/day/account into six-contact proof cohorts gives 1,700 cohorts/day across 100 accounts. At one collection and one drain each, that is 3,400 source requests against 6,912/day. This is neither a guaranteed floor nor an expected measurement: cached witnesses and useful polling/drain overlap reduce demand; sparse groups, dispersed dependencies and failures increase it. Independent 25-minute polling of all 100 accounts already consumes 5,760 requests/day, so these tasks cannot simply be budgeted as unrelated polling plus proof reads.

For LoTW, count inventory/confirmation reads, preparation/final history reads, certificate checks, upload batches, receipt reads and retries separately. Full 20-member groups would need 500 uploads/day at 10,000 contacts/day. An illustrative six-request cycle with all required reads/checks shared within valid scopes would consume 3,000 requests/day plus scanning. If two history checks remain individual, those checks alone consume 20,000/day and exceed the current 11,520/day total allowance. Batch activation therefore needs proof-fit, read-scope sharing and observed effective batch-size acceptance; sparse accounts cannot assume full batches. Signing still performs one signature per contact.

### Storage horizon and monetary cost

For personal use, the existing 4–16 KiB/contact sensitivity model implies approximately 16–66 MB for 4,000 contacts or 0.82–3.28 GB for a 200,000-contact log. These are assumptions about additional retained state, not measured payload sizes or complete database forecasts. Measure source bodies, comparison projections, indexes, dependency rows, history and artifacts separately before treating this range as a storage budget.

The first [normalized pipeline storage measurements](evidence-inventory-pipeline.md) allocate 16.3 MB for 1,000 source contacts and 67.3 MB for 4,000, with an empty destination and before collection. Only 2.4 MB and 9.7 MB respectively are encrypted inventory/projection envelopes. A 200-contact fully matched destination is denser at 5.3 MB of growth. These include retained incomplete/ready comparison evidence and do not establish sustained incremental growth or a 200,000-contact capacity forecast. They make retention and relational/index density explicit prerequisites alongside any later R2 payload move.

At an illustrative personal rate of 100 new contacts/day, that same assumption adds approximately 12–49 MB per 30 days, compared with 1.23–4.92 GB at the 100-account scale check. Personal use is not subject to the scale scenario's 61–244-day database horizon.

The selected initial storage direction is to keep current payloads and matching state in D1, with a backend/version-aware payload reference that permits a later move to object storage. This preserves atomic payload/index/checkpoint commits and avoids adding object reads to each cohort immediately. Measure total database growth and forecast capacity runway before choosing an R2 migration trigger. Moving full bodies later does not remove D1's limit for metadata and comparison state.

An alternative is D1 for indexed state and compact comparison projections, with encrypted full source bodies in R2 Standard. R2 includes 10 GB-month storage, one million write-class operations and ten million read-class operations monthly; storage overage is $0.015/GB-month. At a steady 50 GB, storage alone would be about $0.60/month with unused included storage, versus $33.75 in D1 across multiple databases. Operations, Worker usage, backups and metadata are separate. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

If payloads move to R2, keep matching inputs and due work in D1 so candidate discovery does not fetch a blob per row. Use immutable record versions or bounded chunks, not a mutable whole-log file. Persist and verify the object before atomically committing its D1 references and source checkpoint; a failed D1 commit may leave a collectable orphan, while a committed reference must never precede durable payload availability. Design input pins, orphan collection and coordinated restore before that backend activates. R2's strong consistency does not make its writes transactional with D1. See [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/).

At 10,000 new contacts/day, the assumed additional 4–16 KiB/contact adds 1.23–4.92 GB per 30 days. At that assumed density, an otherwise empty database reaches D1's current 10-GB database limit in roughly 61–244 days, before other application state and retained artifacts. This sensitivity estimate must be replaced by measured encrypted row/index/dependency sizes. Choose database partitioning, separate payload storage or an explicit source archival policy before accepting the sustained 100-account retention workload. See [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Collect completed scan membership epochs and runs after retaining active/published epochs and all required evidence references. Repeated verification must not append a permanent full membership copy each time. Version/dependency compaction must preserve the monotonic generation rules above.

As checked for this review, paid [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) includes 25 billion rows read/month, 50 million rows written/month and 5 GB storage. Overage rates are $0.001/million rows read, $1/million rows written and $0.75/GB-month. Secondary-index updates contribute billed writes. [Workers Standard pricing](https://developers.cloudflare.com/workers/platform/pricing/) has a $5 monthly minimum including 10 million requests and 30 million CPU-ms; additional CPU is $0.02/million CPU-ms. Allowances are shared account resources, not reserved to Ferry.

For sensitivity only, 300,000 new contacts/month at an assumed 50–200 billable writes/contact means 15–60 million writes/month. If the entire included write allowance were otherwise unused, that component contributes $0–$10 in write overage. It excludes existing workload, requests, read/storage overage, CPU, external storage and backups; it is not a project bill. Recheck pricing when implementation estimates are accepted.

Favor coalesced work and version bumps over eagerly updating every dependent result. An operation edit can still require O(affected contacts) reprojection; measure that fan-out, dense bucket expansion, dependency replacement and key rebuilds. Fewer binding RPCs may reduce latency while increasing billed row writes.

Treat local admission policy as a design parameter, separately from vendor guidance and service behavior. LoFi's proposed bootstrap allocation uses unused capacity within its existing total. Any further increase needs an explicit policy choice, measured pacing and demand, rather than a benchmark that silently overrides admission. A monthly-dollar estimate requires current pricing plus observed row operations, storage and CPU; RPC count alone is insufficient.

## Validation and acceptance

Correctness cases include bucket/day/year boundaries; minute-only time; repeated worked calls; mode groups and satellite details; unknown fields; incomplete source context; new competitors after lookup; changes during commit; source scope additions; old/new bucket invalidation; ownership contention; overlapping pages; rejected cursors; ambiguous empty results; and disappearance without tombstones.

Ingestion cases additionally cover repeated identities within one page, same-stamp conflicts, stale incoming rows that cannot refresh current witnesses, changed/stable bodies, old/new event parents, and one operation with many events. Race a staged row insert/update, cursor, credential, index generation or lease against publication and assert complete rollback with unchanged cursor. Lose the commit acknowledgement and verify receipt-based recovery makes no duplicate writes or fresh observation claim. For the larger-page preparation path, crash between every chunk and before/after final publication; no prepared chunk may become a usable source record early. Fail a later SQL chunk and retain atomic page rejection. Measure hidden trigger fan-out, metadata staging writes and deferred collection alongside explicit SQL count.

Delivery cases include cancellation before send; changes after artifact creation; revocation; missing proof; crash before/after dispatch or between outcome commits; lost acknowledgements; partial LoTW observation; stale historical identities; membership immutability; and recovery of new-format single-member and multi-member attempts. Member 19 failing a guard leaves zero members dispatching. The first observed member cannot collect bytes still needed by an uncertain member. Reject an artifact with an extra/reordered contact or wrong member digest. Proof expiry after dispatch must not prevent otherwise sufficient exact receipt resolution.

Fresh-start acceptance preserves account access and linked credential decryption while rebuilding source/destination observations without importing old contact/reconciliation rows. Existing remote contacts must be recognized as historical rather than inserted again or assigned invented Ferry-created provenance. Restore a populated new-format backup with both single-member and multi-member artifacts, preserving their hashes, encryption and unresolved outcomes.

Complete a confirmation scan while receipt inventory is partial and verify that receipt coverage/freshness stays incomplete. A confirmation patch arriving during receipt quarantine must not masquerade as a newer receipt observation or membership witness.

Also test new-event insertion after projection capture, newly activated source scopes, unknown-to-complete index moves, an empty bucket that receives then loses a record, forward observations during baseline quarantine, rebuilds during ingestion, duplicate QRZ observations across ranges, and candidate/dependency 129/257 being relevant. New-format single-member and multi-member staging/recovery must agree with batch membership and ownership rules. Run populated restore quarantine twice and test cutover with an old possibly accepted upload.

Proposed performance targets:
- Warm matching makes zero vendor requests.
- Compare the 1,708-statement 200-record fixtures with the new set-based writer. Target about 20–30 explicit publication statements for a representative 1,000-record page, plus attributable byte chunks; meter trigger work, rows/writes, preparation/crypto and full page time separately.
- Target a 2–4-hour 200,000-contact LoFi baseline plus catch-up/context with representative larger pages and paced continuations; record the actual upstream delay and distinguish full cross-vendor classification/uploads.
- At most six D1 binding RPCs per 20-contact, single-destination warm matching cohort, including full guarded ownership/adoption, commit and lease work; report SQL/rows/bytes separately.
- Unrelated inventory growth does not cause whole-log candidate scans.
- Report all setup, scanner, planning, proof and maintenance costs alongside isolated phase measurements.
- Benchmark 4,000 contacts, a 200,000-contact import, and 100 accounts creating 100 contacts/day, with bursts, outages, restart and ordinary traffic during import.
- Track first classification, review holds, eligible/prepared/submitted/observed contacts, queue age, completion rate, storage, CPU/memory, retries and vendor demand separately.

These targets require native D1/workerd workloads and sustained observations. An index microbenchmark or simulated clock does not establish production capacity. [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) reduces binding round trips while retaining transactional SQL work; neither a batch nor a queue makes vendor I/O atomic.

## Open questions

| ID  | Question                                                                                      | Proposed default or required decision                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | What durable source retention and deletion policy replaces temporary buffering?               | Current encrypted source/context retained while active; specify unlink/account deletion, backups and superseded-body collection before phase B activates                                                          |
| Q2  | Which provider changes and deletions are actually covered by incremental reads?               | Capabilities express limited coverage; periodic verification and current write checks remain necessary                                                                                                            |
| Q3  | How do baseline, concurrent deltas and membership quarantine publish consistent coverage?     | Rolling current observations plus incomplete coverage during scan; monotonic versions, bounded quarantine and guarded publication; prove handoff races before phase C                                             |
| Q4  | What is LoTW's stable local observation key when exact identity or details change?            | Preserve canonical identity and distinguish variants; never discard conflicting records through deduplication                                                                                                     |
| Q5  | Are half-hour buckets economical for dense calls and unknown records?                         | Benchmark against minute buckets using complete candidate/dependency and decryption costs; keep bucket format versioned                                                                                           |
| Q6  | How do source additions, partial-key records and reverse uniqueness invalidate older results? | Explicit source visibility/fallback barriers and all forward/reverse bucket dependencies; no silent candidate truncation                                                                                          |
| Q7  | What planner freshness and verification cadence fit each service's budget?                    | LoFi separates server-guided backlog pacing from idle polling; benchmark the proposed bootstrap allocation; scale polling and verification cadence remain open                                                    |
| Q8  | Can LoFi use larger pages or reliable selective UUID reads?                                   | Target adaptive 500–1,000-row reads with 200 as an intermediate; upstream client requests 5,201, while Ferry's native byte/checkpoint profile still needs validation; UUID lookup remains optional                |
| Q9  | What is the final adapter API and its coverage/result algebra?                                | Refine the interface sketch into finite core types; page resume versus committed checkpoints, vector progress, bounded outcomes, facet merge and provider-specific ordering are phase C prerequisites             |
| Q10 | Can ownership and adoption commits meet the proposed six-RPC cohort budget?                   | Local historical adoption publication: 6 statements, 4,657 reads/325 writes for 20; complete-cohort six-RPC target remains unmet                                                                                  |
| Q11 | What evidence permits LoTW member retry after partial/uncertain processing?                   | No automatic whole-file replay; define bounded observation and proven-rejection behavior before phase F                                                                                                           |
| Q12 | How are shared batch artifacts and events represented in the fresh schema?                    | Native batch ownership/state guards and normalized file/member references; no legacy trigger compatibility required                                                                                               |
| Q13 | Does QRZ offer a suitable supported multi-record upload contract?                             | Individual INSERTs until a separate contract evaluation establishes otherwise                                                                                                                                     |
| Q14 | What storage and monthly cost does durable source retention add?                              | Personal-first workload confirmed; measure encrypted row/index size, write amplification, CPU and backups; keep scale estimates separate from the personal budget                                                 |
| Q15 | Can the existing global vendor admission policies meet the target workload?                   | LoFi bootstrap may use up to 20 of the existing 24 requests/five minutes, with foreground reserve; QRZ/LoTW stay unchanged; broader total/scale-policy changes remain open                                        |
| Q16 | When should durable queue continuations replace cron-only resumption?                         | Promote delayed bootstrap continuations to phase C for the hours target; transactional wakeup outbox and cron recovery are prerequisites; other queue use remains optional                                        |
| Q17 | How can a batch fit current source-proof limits and singleton fresh-insert authorization?     | Batch size follows jointly valid proofs; introduce and verify a distinct multi-member authorization contract before activation                                                                                    |
| Q18 | Which restore protections must precede retention and batch activation?                        | Fresh source collection and dispatch guards plus both new-format quarantine paths; no legacy purge isolation or data import required                                                                              |
| Q19 | How does indefinite source retention fit the database size horizon?                           | D1 first with a later R2 payload path is confirmed; actual density, migration trigger and metadata growth remain open                                                                                             |
| Q20 | Can the QRZ preparation read be removed or merged without weakening its current contract?     | Retain and budget it initially; treat two requests/contact as a conditional lower bound                                                                                                                           |
| Q21 | Must existing database contents or old binaries be supported?                                 | Settled: preserve accounts, authentication and linked credentials; rebuild contact/reconciliation state; no old-writer compatibility or dual materialization; future rollback uses new-format-compatible releases |
| Q22 | How do source proofs and native adoption guards consume durable inventory?                    | Read-only historical adoption now uses native inventory/dependency guards; export source proofs and delivery ownership remain unfinished; no legacy source_work bridge                                            |
| Q23 | How long must partially resolved batch artifacts remain, and how is partial status shown?     | Preserve shared bytes until every unresolved/recovery reference releases them; define operator-visible partial state and terminal retention before F2                                                             |
| Q24 | What LoFi pacing and page-size values does Ferry's account actually support?                  | Read validated server hints and profile native 200/500/1,000-row ingestion in a separately authorized validation phase; do not treat upstream client constants as a verified quota                                |
| Q25 | Can page-wide relational guards preserve all current merge/provenance/checkpoint semantics?   | Native assertions must reject any raced/omitted row; preserve same-page duplicate/timestamp conflicts, first-seen facts, exact observation times and lost-ack recovery                                            |
| Q26 | Which page sizes fit after removing statement and trigger amplification?                      | Profile 200/500/1,000 first, then 2,000–5,000 if byte/CPU/memory and atomic publication fit; remote page size and database chunk size are separate                                                                |
| Q27 | Is private relational staging cheaper than repeated bounded JSON parsing?                     | Default to typed page staging reused by bulk phases; meter its extra writes/space against direct JSON relations before fixing the implementation shape                                                            |
| Q28 | What permits deployment cutover without replaying an old possibly accepted upload?            | Pause the previous sender and resolve or quarantine outstanding remote work before enabling replacement inserts; existing remote history is conservatively adopted                                                |
| Q29 | Can QRZ STATUS book-identity verification be reused across inventory pages?                   | Current reads verify every page. Include STATUS + FETCH in budgets; reuse needs a verified credential/scope/query binding and lifetime or immutable provider identity contract                                    |

## Review follow ups

Four independent reviews covered cost/throughput, the adapter contract, matching/schema correctness, and migration/batch recovery. Their main amendments are incorporated above:

| Review                       | Incorporated amendments                                                                                                                                                              | Remaining decision                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Cost and throughput          | Comparable phase model, expected three-request QRZ path, proof/batch occupancy, billed-write sensitivity and database horizon                                                        | Measured storage density, freshness cadence, vendor admission and preparation-read contract |
| Adapter interface            | Resume versus committed checkpoint, LoFi vector progress, provider ordering, receipt/confirmation facets, bounded tagged results                                                     | Finite core types, facet correlation and evidence-backed capability declarations            |
| Matching and schema          | Source-set epoch, immediate projection barriers, partial-key domains, expected-zero versions, index generations, union admission and input pins                                      | Detailed SQL/transaction proof and dense-group benchmark                                    |
| Migration and batch recovery | Member/wire hash separation, shared artifact GC, all-member claims and source proof semantics retained; old-writer/data-preservation requirements superseded by fresh-start decision | New-format rollback/recovery, deployment cutover and partial-artifact retention             |

The remaining questions are design work. These reviews do not authorize runtime implementation.
