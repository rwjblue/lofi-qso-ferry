# Durable inventory run evidence

Status: local libraries and bounded read-only trials, 2026-11-08. The deployed scheduler still uses its existing reader. No production migration, reset, deployment, push or vendor upload was performed.

This follows the [bulk ingestion milestone](evidence-inventory-ingestion.md). It adds durable scan lifecycle and execution; it does not complete matching, delivery integration or the scheduler handoff.

## Implemented boundary

[Migration 0040](../migrations/0040_inventory_runs.sql) adds immutable run selections, run/partition membership, coverage generations, versioned jobs and a transactional wakeup outbox. [InventoryRuns](../src/inventory-runs.ts) publishes ordinary pages and bounded lifecycle controls through the same native ingestion transaction. A full LoFi run requires both operation/QSO streams, forward catch-up, bounded quarantine and final coverage publication. Delta-only observation cannot establish a full baseline. A missing member becomes unresolved; it does not change the canonical record to deleted.

Every step binds the original configuration, selection, stream position, run version, job version and lease. A response cannot be attached to a refreshed context after a compare-and-set failure. Controls advance bookkeeping without renewing any record's original observation timestamp. Native final assertions detect omitted membership/coverage writes and roll the entire transaction back.

Source query/client changes hold the affected runs and coverage. Display/template metadata and same-account destination password renewal do not invalidate query scope. A same-account restart after a source client change requires a full run. LoTW receipt membership and coverage stay independent of confirmation evidence, which these adapters do not yet ingest.

The [read adapters](../src/inventory-adapters.ts) expose bounded pages, resumable vector/LOGID progress, scoped proposed checkpoints, explicit deferrals and blocked/split outcomes. They do not own database writes, leases or quota. QRZ's ambiguous empty `FAIL` response cannot complete a selection. After an exact full-page boundary, the adapter can rewind with a smaller successful page to establish an explicit tail; ambiguity without that witness remains held.

[Migration 0041](../migrations/0041_inventory_vendor_admission.sql) and [native LoFi admission](../src/inventory-vendor-admission.ts) share the existing global 24-request/five-minute budget. Bootstrap and ordinary background traffic together may use twenty; ordinary background retains its four-request sublimit. Each request reserves quota and global/source pacing atomically with current authority checks. The [run admission guard](../src/inventory-read-guards.ts) adds the captured run/job position to those checks, including each authentication, QRZ STATUS, FETCH and fallback request.

The [runner](../src/inventory-runner.ts) executes one read page or bounded control step per turn. LoFi uses loop pacing through baseline and catch-up, then the longer of the product idle period and server check hint after completion. The next job also respects an already reserved native pacing deadline. A short new hint cannot make the initial job repeatedly arrive before its old reservation expires.

QRZ catch-up uses a fixed overlapping modification-date selection and resets LOGID pagination to zero. A new incremental run resets that cursor again. Its scheduling lower bound comes from the run's start day with a one-day overlap; it is not a returned vendor modification watermark. Periodic full verification and the treatment of larger clock skew remain scheduler policy work. LoTW carries a report receive stamp only for the identical station/date/worked selection; an empty response cannot advance it.

Token rejection is durable across paced turns. If a 401 clears the bearer and registration is deferred, the same-client credential session can persist the cleared state. A later turn saves the renewed bearer, and a subsequent turn resumes reading. All changes compare against the originally opened envelope; a late invalidation cannot overwrite a newer successful renewal. Original production credential rows are untouched by local trials.

## Continuation and recovery

[Continuation publication](../src/inventory-continuations.ts) sends a bounded outbox cohort and acknowledges that cohort with one set-based D1 update. Queue messages contain only schema version, tenant/scope/stream/run identity and job version. Duplicate messages cannot repeat an accepted page. Early/busy messages retry with a delay, and work per consumer call is bounded.

The consumer awaits publication of the next committed wakeup before acknowledging successful work. If Queue accepts a send but its acknowledgement is lost, the same outbox entry can be republished. If a page commits before continuation publication fails, retrying the old message flushes the new outbox without another vendor read. Recovery publication can resend an overdue current generation even when an earlier send was acknowledged, covering dropped/dead-lettered deliveries. Old generations and held jobs are excluded.

The local publication horizon is twelve hours. Cloudflare currently documents up to twenty-four hours of per-message delay and explicit per-message acknowledgements/retries; the implementation uses the generated platform queue types. See [batching, retries and delays](https://developers.cloudflare.com/queues/configuration/batching-retries/) and [JavaScript queue APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/).

Completed runs can start a new incremental run under the original wakeup's job fence. The current generation's outbox must identify that completed run; loading an older completed run alongside today's idle job cannot select old query bounds. A LoTW selection without a usable receive checkpoint repeats a bounded full read.

These are library entry points. The hosted `queue` handler, recovery cron invocation, initial partition scheduler and explicit legacy-reader ownership switch are not wired yet.

## Verification

The full existing suite completed with **1,986 passing tests** after the lifecycle/admission foundation. Runner/continuation test files were added after that suite started and were verified separately. The final combined inventory/credential selection passed **193 tests**, including all inventory adapters, normalizers, ingestion, run races, HTTP admission, pacing, continuation recovery and token persistence.

[The runner Worker test](../tests/inventory-runner-worker.test.ts) bundles the actual modules into workerd. It admits a synthetic request, ingests 1,000 encrypted records with run/partition membership, publishes a delayed versioned continuation and acknowledges the input message. It verifies the retained credential ciphertext, decrypted sample identity, unchanged committed checkpoint during catch-up, empty scratch tables, zero attempts/ledger rows and zero actual external requests.

TypeScript, repository lint, formatting and mise task validation passed. This is local correctness/runtime evidence; production Worker CPU/memory and a complete-log wall-clock trial remain unmeasured.

## Bounded real-service trial

Run the [trial](../scripts/inventory-run-trial.ts) with an existing private encrypted capture from the ingestion milestone:

```sh
mise run inventory-run-trial --capture '/private/path/to/previous-inventory-trial'
mise run inventory-run-trial --reopen '/private/path/to/new-inventory-run-trial'
```

The trial opens the previous capture with SELECT-only application queries, decrypts its three linked credentials in memory and reseals copies in a new isolated database. It does not rewrite the original credential files, Keychain entries or production rows. The new directory is mode `0700`; its trial key is mode `0600`. No raw contact bodies or credentials appear in the report.

The strict trial transport allows only LoFi account/sync metadata, QRZ STATUS/FETCH and LoTW receipt queries, with a total eight-request bound. Token registration/renewal, approval email and log mutations are blocked. Runtime tests separately exercise the credential-renewal continuation.

The first live run accepted one LoFi packet before a native pacing deferral exposed the initial-reservation handoff described above. The second run, after aligning the scheduled deadline, completed its requested bound:

| Service | Accepted observations | Read pages | Publication/control SQL statements | Publication/control rows read | Publication/control rows written | End state             |
| ------- | --------------------: | ---------: | ---------------------------------: | ----------------------------: | -------------------------------: | --------------------- |
| LoFi    |                 2,225 |          2 |                                 50 |                        74,084 |                           40,549 | collecting, partial   |
| QRZ     |                   250 |          1 |                                 19 |                         8,340 |                            4,519 | collecting, partial   |
| LoTW    |                     2 |          1 |                                 74 |                           487 |                              119 | selected day complete |

LoFi retained the same shape as the earlier bound: 225 operations plus 2,000 QSO-stream records. Each sync requested 1,000 records per stream. The LoTW count includes the local quarantine/completion controls; LoFi and QRZ did not complete their baselines. The SQL figures exclude initialization, run-begin publication, native HTTP admission, credential access and state reloads. They are not whole-turn RPC or cost totals.

Actual HTTP requests were six: two LoFi syncs, three QRZ requests (initial STATUS plus adapter STATUS/FETCH), and one LoTW report. Response bytes totaled **3,027,500**. The isolated database retained **2,477 records** and occupied **11,550,720 bytes**. Uploads were zero. Only the bounded LoTW receipt-day selection published coverage; no account-wide completeness or negative-upload authorization was established.

A separate process reopened the new database without vendor reads. LoFi remained at run/stream/job version three in collection; QRZ remained at version two in collection; LoTW remained complete/idle at version five. A retained payload decrypted successfully. This verifies persisted resume positions rather than only an in-memory process lifetime.

## Remaining work

Complete scheduler integration and its explicit reader handoff, initial/reverification partition scheduling, adaptive LoTW overflow splitting and QRZ empty-selection verification. Then implement shared comparison generations, bulk matching and dependency invalidation, historical associations, source proofs against the fresh inventory, upload preparation/batches and member-aware recovery. Garbage collection, restore quarantine, account-preserving fresh-state cutover and full-log cost/throughput trials remain required before replacement activation.
