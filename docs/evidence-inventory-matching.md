# Bulk matching snapshot evidence

Status: local snapshot collection and private encrypted-capture replay, 2026-11-08. Candidate relations are computed locally. Native match-result publication, ownership/adoption, automatic comparison scheduling and delivery integration remain unfinished. Nothing was pushed, deployed, uploaded or reset in production.

## Implemented boundary

[InventoryMatchingWorkspace](../src/inventory-matching-workspace.ts) collects at most twenty selected source contacts for one destination. It pins the active comparison generation and domain/source-set versions, loads the source roster and selected projection metadata, gathers forward candidates and then probes reverse candidates around each remote record. All queries use tenant-scoped identities. A request-local [lookup session](../src/inventory-comparison-lookup.ts) loads/imports the comparison key once; every candidate query still checks the captured domain version in SQL.

The union admits at most 128 distinct source/receipt records, 128 reverse probe requests and twenty source scopes. Repeated source/receipt references share one immutable body load/decryption. Source, receipt and reverse-source loading consume one four-MiB encrypted/plaintext budget; later phases receive only the remaining allowance. Metadata admission rejects an overflowing phase before its ciphertext is loaded. Dense cohorts request a split rather than returning a truncated set. An individual group that cannot fit still needs a scheduler-visible hold in the future coordinator.

The returned manifest contains opaque record/projection references, scope configuration versions and configuration hashes, coverage/run identities and query hashes, all forward/reverse bucket versions including zero-hit buckets, and candidate relations. Decrypted records and source narrative do not appear in it. It retains every supplied candidate dependency, including exclusions and currently irrelevant records. The digest binds this complete preparation; it is not native commit authority.

Selected/current projection metadata is loaded through indexed point reads. A stale operation context makes the selected record pending rather than disappearing. Missing bodies remain explicit. The pure [relation pass](../src/inventory-matching-graph.ts) keeps source/receipt roles during reverse comparison, preserves minute intervals and holds unsupported or incomplete evidence. `none` describes the supplied candidate set, and `unique` describes candidate geometry. Neither is a persisted absence/adoption result.

## Coverage and unknown membership

Source readiness requires an observed, complete full run with operation and QSO streams, catch-up and the current scope configuration. Every linked source participates in the reverse census; a new source without an inventory scope blocks reverse completeness. Disabled, held or unindexed source scopes cannot silently vanish from that census.

Destination coverage must contain the selected source's entire candidate window, including both UTC days when the thirty-minute window crosses midnight. Adjacent observed date selections can supply that union. QRZ requires full selection plus catch-up, no baseline modified-date filter and the compatible station book. LoTW requires full receipt selection with no received-since filter; optional station/worked-call filters must include the selected source. A completed unrelated selection cannot establish absence.

[Migration 0049](../migrations/0049_inventory_matching_read_indexes.sql) adds an index over unresolved partition membership and a connection-to-scope index. Unresolved membership is a scope-wide uncertainty barrier, including when a retained old record lies outside all probed buckets. Keeping its old hash cannot establish where that identity currently belongs upstream. This policy is intentionally conservative; provider-specific verification may later resolve or narrow uncertainty. It cannot be replaced by silently interpreting disappearance as deletion.

Source/destination coverage and membership remain separate from encrypted body availability. No preparation renews a vendor observation, advances a checkpoint or grants write authority. The eventual native publisher must recheck the captured generation, scope/coverage/projection/bucket dependencies and current uncertainty barriers before committing results. Later current-result selection must also invalidate stale dependencies without forcing every result to rebuild after an unchanged verification poll.

## Local measurements and verification

Twenty distinct source/receipt pairs sharing one operation required:

| Boundary                                                               | Measurement |
| ---------------------------------------------------------------------- | ----------: |
| Complete preparation SQL/binding reads, including generation/key setup |          11 |
| Collector data rows read, excluding generation/key setup               |       2,527 |
| Scope/selection/coverage metadata queries                              |           3 |
| Candidate queries, forward plus reverse                                |           2 |
| Body size/loading queries                                              |           4 |
| Distinct encrypted bodies decrypted                                    |          40 |
| Distinct source/receipt pairs evaluated by the relation pass           |          20 |

This is preparation only. It excludes work/lease claiming, native result/ownership publication and release. It does **not** meet the proposed six-binding-call complete-cohort target. Folding metadata/body admission queries and key setup into fewer snapshots remains a measured optimization opportunity. It is not an end-to-end scheduler speedup or a hosted latency/billing measurement. Coverage selection also reads the tenant's candidate partition metadata; a large date-partition universe needs its own query-plan/cost qualification.

The native D1 tests cover reverse competition outside the selected source's window, newly linked unregistered sources, unresolved source/receipt membership outside the lookup, date-boundary unions, unrelated filtered LoTW selections, stale operation context, dense candidate union rejection and a byte overflow spanning separate loading phases. The byte test proves that later receipt ciphertext is not loaded after the source phase consumes most of the shared budget. Adding 5,000 unrelated present membership rows leaves the snapshot's data row-read count unchanged.

An actual [workerd test](../tests/inventory-matching-worker.test.ts) opens the node-prepared encrypted inventory, collects all twenty unique pairs, verifies the manifest digest, checks unchanged source checkpoint/credential ciphertext and makes zero external requests. This exercises Worker WebCrypto and the actual D1 SQL rather than a stubbed store.

The final focused snapshot/graph/projection selection passed **48 tests**; the six-test lookup selection separately verifies key reuse and domain-race rejection. The broader inventory regression passed **297 tests**, including hosted Queue and native Worker checks, with no failures, skips or cancellations. Counts overlap and should not be added. Logs are `/tmp/lofi-ferry-matching-workspace-verified.log`, `/tmp/lofi-ferry-lookup-session.log` and `/tmp/lofi-ferry-inventory-matching-regression.log`. TypeScript and the Worker dry-run build passed; build log: `/tmp/lofi-ferry-matching-snapshot-build.log`.

## Captured-data replay

The [comparison trial](../scripts/inventory-comparison-trial.ts) now stores private `matching-snapshots.json` preparations alongside the sealed projection preparations and count-only report. The original three-provider capture is copied before mutation, and credentials/canonical facets/checkpoints are checked unchanged.

| Destination | Selected sources | Incomplete relations | Other relation states | Data queries | Data rows read | Decryptions |
| ----------- | ---------------: | -------------------: | --------------------: | -----------: | -------------: | ----------: |
| LoTW        |               10 |                   10 |                     0 |            5 |            361 |          10 |
| QRZ         |               10 |                   10 |                     0 |            5 |            361 |          10 |

Generation/key setup is outside those data-query and row counts. The unfinished LoFi inventory correctly keeps every selected source incomplete; these cohorts perform no forward/reverse candidate probes. The trial's separate original twenty-probe index sample remains a candidate-collection measurement, not an absence result.

A fresh process verified both matching manifest digests and reproduced their complete logical state, excluding derivation time and diagnostic statistics. It also authenticated/decrypted all 42 persisted source/receipt projections and recovered one original hash per provider. Reopening the earlier projection-only capture still works without migration 0049 or matching artifacts.

The new private directory ends in `0625c130-8062-4059-81f1-27ce7c0104af`; its database occupied **14,508,032 bytes**. This small capture does not establish full-log storage density or throughput. Logs are `/tmp/lofi-ferry-matching-snapshot-capture.log`, `/tmp/lofi-ferry-matching-snapshot-reopen.log` and `/tmp/lofi-ferry-matching-snapshot-compat-reopen.log`. Vendor HTTP requests and uploads were **zero**. No match result, ownership or adoption state was published.

## Next implementation boundary

Persist matching results and their complete dependencies through one guarded native batch. Validate expected-zero bucket versions, exact candidate sets, all current projection/context/membership inputs, active generation/source visibility, captured coverage and unknown barriers. Preserve newer work when completing a claimed version, recover lost acknowledgements and reject raced/omitted inputs inside the transaction. Operating-detail checks and native ownership/adoption are still required before a candidate relation can become a historical association. Then connect comparison work selection and delivery to those results.
