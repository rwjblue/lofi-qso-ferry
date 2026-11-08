# Bulk inventory ingestion evidence

Status: local implementation and bounded read-only trials, 2026-11-07. The new writer is isolated from the deployed scheduler and delivery paths. No deployment, production reset, export-gate change or vendor upload was performed.

The [inventory design](inventory-reconciliation-design.md) remains the architecture for the remaining work. This milestone implements page ingestion, not complete inventory coverage, matching or batch delivery.

## Implemented boundary

[Migration 0039](../migrations/0039_inventory_ingestion.sql) adds independent inventory scopes, streams, encrypted payloads, current records/facets, immutable births, operation barriers, coalesced work and page receipts. Existing accounts, authentication, connections and credential envelopes remain in their original identities. The schema is initialized in isolated databases for these checks.

[InventoryIngestion](../src/inventory-ingestion.ts) prepares one deterministic page, rejects conflicting equal revisions, retains stale-observation distinctions and inserts encrypted replacements only when bodies change. Bounded JSON bindings feed set-based statements. A single native batch publishes records, barriers, durable work, authoritative resume/checkpoint progress and the receipt, then removes scratch metadata.

Native guards revalidate connection/configuration, current credential, account, lease/fence, scope/stream versions, expected record absence/versions, payload bindings and complete mutation counts. A late SQL failure rolls back the entire page. A committed receipt resolves a lost acknowledgement; replay reloads current progress and cannot restore the page's older cursor. Publication snapshots and verifies its prepared input before awaiting database reads.

[Observation adapters](../src/inventory-observations.ts) accept incomplete source records and tombstones without requiring an exportable projection. LoFi keeps operation/QSO identity and numeric server ordering; QRZ retains exact LOGIDs. LoTW uses explicit local exact-identity/body variants, never an invented vendor record ID. Confirmation-patch correlation is not implemented by the receipt normalizer.

The LoFi client has opt-in inbound limits up to 5,000 records per stream and 8 MiB per response. Ordinary callers retain their previous defaults; operation proof reads keep their 200-record ceiling. Validated server loop/idle hints are available to new inventory callers. This does not change hosted request admission or enable the new reader in the scheduler.

## Reproducible synthetic measurements

Run:

```sh
mise run benchmark-inventory-ingestion
mise run benchmark-inventory-ingestion --sizes 1000 --total 200000
```

The [benchmark](../scripts/benchmark-inventory-ingestion.ts) uses synthetic ordinary QSOs and native local D1. Four complete writer calls are metered: stream snapshot, existing-row lookup, receipt lookup and publication batch. Read metadata is captured for every SQL statement, including `first()` queries. Initialization and final storage measurement are reported outside that boundary.

| Records per page | Publication statements: new / stable / one edit | Complete rows read: new / stable / one edit | Rows written: new / stable / one edit |
| ---------------: | ----------------------------------------------: | ------------------------------------------: | ------------------------------------: |
|              200 |                                    16 / 15 / 16 |                       4,438 / 6,038 / 6,040 |                 2,810 / 1,210 / 1,213 |
|              500 |                                    16 / 15 / 16 |                    11,038 / 15,038 / 15,040 |                 7,010 / 3,010 / 3,013 |
|            1,000 |                                    17 / 15 / 16 |                    22,038 / 30,038 / 30,040 |                14,010 / 6,010 / 6,013 |
|            2,000 |                                    20 / 16 / 17 |                    44,038 / 60,038 / 60,040 |              28,010 / 12,010 / 12,013 |
|            5,000 |                                    26 / 18 / 19 |                 110,038 / 150,038 / 150,040 |              70,010 / 30,010 / 30,013 |

Every profile uses four binding calls. Stable polls create no ciphertext; one-edit polls create one encrypted replacement. Stable polls still write observation metadata and scratch rows, so their write count remains proportional to page size.

The old 200-record operation/event fixtures assert 1,708 explicit publication statements. The new ordinary-QSO benchmark is a different input mix and omits legacy derived delivery work. Its statement reduction establishes the new ingestion shape; it is not a measured end-to-end scheduler speedup.

The 200,000-record import used 200 pages of 1,000, 800 binding calls, 3,400 total SQL statements and 2,802,000 written rows. Its final database occupied 317,460,480 bytes, including 139,288,000 encrypted payload bytes for 71,689,000 plaintext bytes. This is an ingestion-only storage measurement; it excludes comparison indexes, membership epochs, match dependencies, attempts and artifacts.

An initial version scanned the growing scope during publication assertions. The bounded-page replacement reduced import reads from 63,307,800 to 4,407,600. After the change, first/last/minimum/maximum page reads were all exactly 22,038. Written rows were unchanged. A regression adds 5,000 unrelated records and verifies that a fixed page's publication reads remain bounded.

Import wall time was approximately 65 seconds after the change, including about 27 seconds in preparation and 36 seconds in publication. Concurrent local checks affected elapsed times; row counts are the stronger comparison. These are local measurements, not production capacity or billed Worker CPU.

## Worker runtime verification

[The native Worker test](../tests/inventory-worker.test.ts) bundles the actual writer and executes preparation, WebCrypto encryption/decryption, publication and receipt recovery inside workerd. It verifies 1,000 encrypted/decryptable records, 13 publication statements for its smaller synthetic bodies, unchanged credential ciphertext, one committed stream version and zero external requests.

The [ingestion race tests](../tests/inventory-ingestion.test.ts) cover lease replacement/expiry, account and connection changes, credential rotation/revocation/expiry, configuration and cursor races, expected absence, conflicting duplicate versions, stale observations, old/new event parents, final-statement rollback and lost acknowledgements. A newer revision retains its own original observation timestamp, even when that request started earlier than a previous observation.

Validation completed: 1,860 tests passed in the full suite, with the subsequently added native Worker test passing separately. Formatting, lint, both TypeScript checks, mise task validation and the existing Worker dry-run build passed. The dry run deployed nothing; local `main` was updated through focused commits without a push.

## Bounded live reads

Run:

```sh
mise run inventory-readonly-trial --page-size 1000 --pages 2
```

The [trial](../scripts/inventory-readonly-trial.ts) creates a private encrypted local database outside the repository. Credentials come from existing local configuration/Keychain in memory. Original credential files and linked application records are not rewritten. Its [transport](../scripts/inventory-trial-transport.ts) limits total requests, spaces LoFi reads, rejects redirects and permits only metadata-only LoFi sync, QRZ STATUS/FETCH and LoTW receipt queries. Registration, renewal, approval emails and contact mutations are blocked.

The first trial ingested 250 QRZ records and two LoTW receipts from a single selected day. Each page used 13 publication statements, and receipt replay recovered without additional writes. QRZ raw/encrypted bytes were 265,278 / 409,367; LoTW raw/encrypted bytes were 894 / 1,637. The combined isolated database occupied 1,069,056 bytes. Three HTTP requests were made; vendor uploads were zero.

The saved Sidecar LoFi bearer returned HTTP 401 on account verification. The transport blocked automatic registration/renewal, so that first trial observed no source contacts. The CLI's default Sidecar credential source therefore remains unavailable until its bearer is current.

A second trial supplied the existing active Ferry-linked LoFi credential through the exported trial's in-memory credential dependency. Its encrypted credential was read with a SELECT-only production query and decrypted using the existing protected KEK; neither credential identity nor saved ciphertext was rewritten. No token registration or renewal was needed.

That trial successfully requested 1,000 records per stream and ingested:

| Service         |                                            Observations retained | Publication statements | Plaintext / encrypted payload bytes |
| --------------- | ---------------------------------------------------------------: | ---------------------: | ----------------------------------: |
| LoFi, two pages | 225 operations and 2,000 QSO-stream records, including 40 events |                     36 |               2,688,531 / 4,080,104 |
| QRZ, one page   |                                                      250 records |                     13 |                   265,278 / 409,367 |
| LoTW, one day   |                                                       2 receipts |                     13 |                         894 / 1,637 |

The LoFi packets contained 225 operations plus 1,000 QSO-stream records, then another 1,000 QSO-stream records. This verifies that the sampled service/account accepts larger inbound reads; it does not establish a universal maximum. The source scan remained incomplete after the two-page bound.

Five vendor requests were made: LoFi account verification plus two sync reads, one QRZ FETCH and one LoTW report. Received response bytes totaled 3,030,592. The isolated database occupied 9,654,272 bytes. Source preparation/publication wall times totaled approximately 3,372 / 277 ms; pacing and HTTP time are outside those measures. Every page passed receipt replay with zero additional publication writes. Uploads and published coverage were zero.

A separate process reopened that persisted database, found the same 225 operations, 40 events and 1,960 ordinary QSOs at source stream version two, and decrypted a source body with matching identity. This checks durable local persistence rather than only an in-memory database lifetime. The private encrypted capture and trial key remain outside the repository; reports expose fixed counts and timings only.

No trial publishes account-wide coverage or absence conclusions. QRZ is a bounded page and LoTW is a bounded day; those observations do not establish complete destination inventories.

## Remaining work

Next implement durable run/membership/coverage completion and adapter continuations, with persisted pacing and an explicit scheduler reader-ownership switch. Then build the shared HMAC comparison generation, bounded bulk matcher and invalidation dependencies. Preparation, member-aware LoTW upload artifacts, native dispatch/recovery guards, garbage collection, restore quarantine and deployment cutover remain separate milestones.

Full-log completion time, production Worker CPU/memory, final metadata density, operation-child projection cost and vendor-specific upload throughput are still unmeasured. Do not extrapolate the synthetic ingestion rate into a complete synchronization or upload rate.
