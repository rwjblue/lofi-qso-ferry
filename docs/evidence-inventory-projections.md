# Encrypted comparison projections

Status: local preparation, native publication, bounded bulk loading and encrypted capture replay, 2026-11-08. The later [matching snapshot evidence](evidence-inventory-matching.md) adds bounded forward/reverse collection. Persisted results and delivery integration are unfinished. Nothing was pushed, deployed, uploaded or reset in production.

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

Soft multi-contact capacity failures must be split before publication; they cannot permanently complete otherwise projectable work. The native publisher rejects such mixed capacity holds. Automatic work selection, coverage-completion wakeups for held context, bounded operation-child reprojection and payload/receipt collection remain unfinished.

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
