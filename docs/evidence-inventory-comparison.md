# Durable comparison-index evidence

Status: local implementation and isolated capture replay, 2026-11-08. No changes were pushed, deployed or applied to production. Runtime activation remains configured off. This is the index and candidate-collection foundation; it does not publish match results or authorize uploads.

## Implemented contracts

[Migration 0044](../migrations/0044_inventory_comparison_generations.sql) stores one envelope-encrypted tenant HMAC key independently from connection credentials. KEK rewrapping preserves its logical key ID and hashes. Concurrent initialization loads the winning stored key rather than retaining a losing caller's random secret. Tenant/key identity is authenticated when opening the envelope.

The [generation API](../src/inventory-comparison-generations.ts) pins the key ID, format, historical matching policy and aligned bucket width. The domain keeps active and pending generation pointers and monotonic domain/source-set versions. New scopes enroll in both current generations. A newly linked source invalidates reverse-census dependencies before it has an inventory scope. Display/health metadata does not advance that source-set version.

[Migration 0045](../migrations/0045_inventory_comparison_ingestion.sql) and the [page hook](../src/inventory-comparison-pages.ts) publish hints in the original ingestion transaction. Each accepted semantic QSO change immediately enters its narrowest known call/time fallback class, even while full projection context is unavailable. Event/deleted transitions retire its hash. Old and new bucket invalidations coalesce per generation/scope/page. Native guards reject omitted hints, omitted bucket staging/invalidation, changed generation pointers or configuration, and incomplete final publication. Stable observations, stale incoming records and metadata-only changes do not rehash or advance comparison work.

The hosted read-only Queue uses this hook. A domain/build is still explicitly initialized through the comparison APIs; cron does not yet schedule comparison builds or projection work automatically. Callers without the hook cannot silently change an already indexed scope.

[Migration 0047](../migrations/0047_inventory_context_membership.sql) and [context effects](../src/inventory-context-effects.ts) also invalidate retained context when scan membership changes. Semantic edits and operation/event membership changes coalesce into one topology increment per operation/page. Missing ordinary contacts advance their own membership version, mark their index entry pending and queue their own projection work. Unchanged full verification does not increment these versions or work. Reappearance with unchanged bytes still advances the affected membership version. Bucket hashes stay in place; the lookup returns each candidate's membership version for later native matching dependencies. Event uncertainty does not enqueue every operation child.

Context staging, membership transitions, version increments, work and the checkpoint share the page transaction. Native guards reject missing context effects even when a caller supplies an otherwise valid inventory page. Receipt replay cannot increment these versions twice. The shared [contact ADIF serializer](../src/contact-adif.ts) is now independent of delivery orchestration and retains the existing fractional-time and test-contact rules.

[Migration 0046](../migrations/0046_inventory_comparison_builds.sql) and [backfill](../src/inventory-comparison-builds.ts) scan at most 200 references and decrypt at most 2 MiB per step. Each transaction checks the exact keyset range, current scope sequence/configuration, lease, generation pointer and EOF. Newly ingested records behind the cursor already have hints from atomic ingestion. Existing current hints retain their projection/work state without body decryption. Receipts resolve lost acknowledgements without moving an old cursor back or invalidating buckets twice. Generation activation requires every enrolled scope's index census to complete, then retires the old generation and switches the pointer atomically.

Rebuilding retained data can proceed for a held/disabled connection. This does not make that scope ready for matching or renew observations. Index-census completion, upstream scan coverage and projection readiness remain separate facts.

The [bulk lookup](../src/inventory-comparison-lookup.ts) accepts up to 20 selected contact keys. It sends eight equality hashes per selection and retrieves bounded candidate metadata through the bucket index, including pending/held candidates and current operation topology versions. It returns versions for zero-hit buckets too. At most 512 candidates per selection and approximately 1,024 across the batch are usable; an extra row establishes overflow, which returns an explicit hold with no truncated candidate list. Request/output byte budgets also fail closed. A domain change during asynchronous hashing rejects the read snapshot.

Exact historical predicates, source coverage, current projections, reverse-source uniqueness and native result dependency checks remain necessary. An empty probe is not an absence result. Initial keys use one format; a future incompatible format needs a dual-format token writer before its pending generation can be populated. Unsupported formats currently fail closed.

The native tests exercise actual D1 SQL. Transaction rollback also follows Cloudflare's documented [D1 batch semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

## Synthetic measurements

These are native local D1 publication metrics, not hosted latency or billing measurements. Ingestion figures exclude initialization, read-side preparation, lease acquisition and later collection. Backfill figures likewise count its publication transaction, excluding key/cursor/body loading and lease control.

| Workload                                         | Publication statements | Rows read | Rows written |
| ------------------------------------------------ | ---------------------: | --------: | -----------: |
| 1,000 source records, one shared bucket          |                     22 |    46,065 |       24,018 |
| 1,000 source records, distinct buckets           |                     22 |    55,056 |            — |
| Move 1,000 records to distinct new buckets       |                     22 |    91,056 |            — |
| Backfill 200 retained records, one shared bucket |                     12 |     3,845 |        2,012 |

The distinct-bucket test guards against quadratic scratch-table checks. Publication cost is bounded by the page and its distinct old/new keys, rather than repeatedly scanning unrelated inventory.

Twenty lookup selections against 1,003 retained contacts read **684 rows** in the candidate/dependency query. A 1,000-candidate shared bucket read **1,043 rows** before reporting overflow at the 512-candidate cap. Those lookup numbers exclude generation/key loading and HMAC preparation.

## Backfill payload lookup

The account-only replay exposed a scan in preparation that the
publication-only counters did not capture. SQLite chose the
tenant/scope prefix of the payload key and joined that scope's payloads
to each page's JSON IDs. Driving the join from the page IDs makes the
planner probe the full tenant, scope and payload key.

The same first 180 coordinator turns on two private copies of the
personal log each built 60 pages. The replay compared their index
record identities, key classes, semantic versions and states.

| D1 reads | Original join | Page IDs first |
| --- | ---: | ---: |
| Payload lookup statements | 51,463,812 | 23,732 |
| All 180 turns | 52,129,982 | 689,779 |

Both passes used 2,879 calls and 3,540 SQL statements, reported 208,463
rows written, and produced the same inspected index rows. This is a
local cold-build slice and made zero vendor requests. The native
regression counts preparation and publication for a 200-record page
inside a 450-record scope. The old plan read 94,908 rows and the
updated plan read 4,858.

## Encrypted real-data replay

The [trial tool](../scripts/inventory-comparison-trial.ts), exposed as `mise run inventory-comparison-trial`, copied the prior three-provider [run capture](evidence-inventory-runs.md) into a separate private directory. The original capture was not opened for mutation. The copy kept its existing account/connection credentials and payload encryption identities. This trial made **zero vendor HTTP requests and zero uploads**.

| Provider | Backfill pages | Record references | Publication statements | Rows read | Rows written |
| -------- | -------------: | ----------------: | ---------------------: | --------: | -----------: |
| LoFi     |             10 |             2,000 |                    120 |    75,357 |       29,798 |
| LoTW     |              1 |                 2 |                     12 |        99 |           37 |
| QRZ      |              2 |               250 |                     24 |     7,724 |        3,759 |

The active index contains 1,949 pending LoFi candidates, 51 hashless retired LoFi bookkeeping entries, 250 pending QRZ candidates and two pending LoTW candidates. It retains 2,187 bucket-version rows, 2,252 work rows and 13 build-page receipts. Pending here means projection materialization is unfinished, not that a vendor request is pending.

Ten source contact keys produced twenty destination probes and **460 rows read** in the candidate/dependency query. This selected sample found no candidate references in the limited destination capture. It published **zero match/absence results**: the QRZ inventory capture is partial, and LoTW covers only its explicitly selected day. Candidate-count zero is not evidence that the remote service lacks a contact.

Credential ciphertext, canonical facet versions/timestamps and stream/checkpoint rows stayed unchanged. The replay with migration 0047 occupied **14,028,800 bytes** after the index build, compared with the prior run capture's reported **11,550,720 bytes** before these tables. The roughly 2.48 MB difference includes new tables/indexes and receipts; fixed allocation, bucket density and retained generations make per-record extrapolation from this small capture unreliable. The earlier replay before migration 0047 occupied 13,979,648 bytes; the updated migration/reopen checks again made no vendor requests or uploads.

A separate process reopened the copy, recovered the active generation and recomputed one stored HMAC from its original encrypted body for each provider. All three matched. Keys and bodies remain outside the repository in the private trial directory; the report contains counts only.

## Verification and remaining work

- The combined comparison selection passed **31 tests**, covering keys, tenant isolation, page invalidation, indexed lookup, builds and generation transitions. The final seven-test build selection also checks native skipped-range rejection with a recomputed application manifest, held-scope readiness and lost-ack/late-failure recovery. Counts overlap.
- The earlier ingestion/hosted-path checkpoint passed **45 tests**, including actual delayed Worker Queue delivery. The final page selection passed nine tests after adding distinct-bucket cost checks.
- The full regression run passed **2,054 tests** in approximately eighteen minutes, with zero failures, cancellations or skips. Its log is `/tmp/lofi-ferry-full-comparison-tests.log`. The later seven-test backfill selection additionally verifies the recomputed-manifest skipped-range case and held-scope/lost-ack behavior on the final code.
- After that full-suite checkpoint, the serializer extraction passed **59 delivery/precision/signing tests**, and the membership/context change passed **238 inventory tests**, including actual hosted Worker/Queue execution and four context-membership cases. Logs are `/tmp/lofi-ferry-contact-adif-tests.log` and `/tmp/lofi-ferry-inventory-context-final.log`. These counts overlap earlier selections and should not be added. The four-record context fixture quarantines missing events in two bounded publications totaling 49 statements and 475 rows read; this is a small native correctness fixture, not full-log throughput evidence.
- TypeScript, repository lint/formatting, mise task validation and the Worker dry-run build passed at their recorded checkpoints.

The later [projection evidence](evidence-inventory-projections.md) covers bounded encrypted preparation, native publication/work-version guards, shared body loading and real-data replay. Bulk lookup now exposes current projection versions/state/payload references through indexed metadata joins. Stale or missing projections remain visible as pending; unchanged full verification can reuse their bodies without rebuilding them.

## Forward and reverse relation evaluation

The pure [matching graph](../src/inventory-matching-graph.ts) reuses the precision-aware historical predicate over supplied forward/reverse candidate sets. It admits at most twenty selected sources and 128 distinct source/receipt inputs. Each distinct source/remote pair is evaluated once across the cohort. The twenty-source/one-remote ambiguity fixture uses twenty distinct predicate calls rather than reevaluating the same pairs for every selected source.

Reverse comparisons retain the original source/receipt roles, including LoTW individual/group mode rules. A 13:00 source and a 14:00 source both compete for a 13:30 remote record, even though the second source is outside the selected source's own thirty-minute window. Relevant missing/unsupported evidence, incomplete reverse sets and precision intervals crossing the boundary stay unresolved. Distinct remote identities remain separate candidates even with identical record contents. Pending data cannot establish irrelevance using stale fields; current held evidence may establish irrelevance through the existing predicate's valid keys. Excluded/currently irrelevant inputs remain in the supplied snapshot for dependency capture.

The relation pass publishes nothing. `none` describes only the supplied candidate set, and `unique` still needs complete source/destination coverage, operating-detail comparison, reverse census, ownership and native dependency checks. Its tests and the original historical predicate selection passed **26 tests**; log: `/tmp/lofi-ferry-inventory-matching-graph.log`. TypeScript and focused lint/format checks passed.

The later [matching evidence](evidence-inventory-matching.md) implements complete bounded input collection, scope-wide unresolved-membership barriers, native persisted comparison results/dependencies and private capture replay. Ownership/adoption and automatic comparison scheduling remain next. Source-proof/delivery integration, member-aware LoTW batches, adaptive date partitions, payload collection and account-preserving fresh-state cutover/restore remain unfinished. Full-log elapsed-time and 100-account sustained-capacity qualification have not been demonstrated.
