# Encrypted comparison projection preparation

Status: local bounded preparation and encrypted capture replay, 2026-11-08. Projection publication, persisted matching and delivery integration are unfinished. Nothing was pushed, deployed, uploaded or reset in production.

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

## Encrypted real-data replay

The [capture trial](../scripts/inventory-comparison-trial.ts) now retains private `projection-preparations.json` artifacts as well as its count-only report. It still copies the original encrypted run capture into a new private directory, preserving credential identities and checking that canonical facets/timestamps and stream checkpoints remain unchanged. No vendor request or upload was made.

| Provider | Prepared | Ready preparations | Held preparations | Distinct bodies decrypted |
| -------- | -------: | -----------------: | ----------------: | ------------------------: |
| LoFi     |       20 |                  0 |                20 |                        20 |
| LoTW     |        2 |                  2 |                 0 |                         2 |
| QRZ      |       20 |                 20 |                 0 |                        20 |

LoFi's capture still has incomplete full source coverage, so its twenty samples stayed held. The receipt samples were independently projectable; that does not make the limited destination capture complete. The index remained pending, and no matching result or ready projection was published. A separate process authenticated and decrypted all **42 preparations**, recovered the active index generation and reproduced one stored hint from each provider's original encrypted body.

This replay's database occupied **14,012,416 bytes**, in addition to the private sealed preparation artifact. An earlier run of the same index/membership schema measured 14,028,800 bytes. These small fixture allocation measurements do not establish full-log storage or throughput. The earlier [comparison evidence](evidence-inventory-comparison.md) records its publication statement/row boundaries.

## Required native publication

The next change must publish the preparations through one guarded native batch. It must check the active/pending generation, scope configuration, current lease/account/connection, exact index/projection/work versions, every immutable input reference, semantic and membership versions, operation topology and captured coverage. Ready/excluded source rows with a parent require a complete, present operation/event closure. Native checks must reject missing dependencies, raced additions/moves and truncation independently of the application digest.

Persist encrypted bodies separately from versioned projection metadata, then advance index readiness/projection versions and complete only the captured work versions atomically. Preserve hashes for context-dependent exclusions. A newer invalidation must remain pending, and a lost acknowledgement must recover a receipt without incrementing versions twice. Loading a retained projection must detect changed semantic/topology/membership/configuration inputs. Derivation cannot renew a vendor witness.

Soft multi-contact capacity failures must be split before publication; they must not permanently complete otherwise projectable work. Held context may need reevaluation when coverage completes even without a new semantic edit. Stable completed coverage must not force all ready projections to rebuild merely because a successful unchanged poll advanced a control version.
