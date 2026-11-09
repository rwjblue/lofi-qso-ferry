# Hosted comparison continuation evidence

Status: local implementation and native Worker/Queue verification, 2026-11-08.
Local, staging and production configuration keep runtime activation off and
exports disabled. Nothing was pushed, deployed, reset in production or uploaded.

## Durable scheduling

[Migration 0073](../migrations/0073_inventory_comparison_wakeups.sql) retains one
reusable outbox row per account. Coordinator wakeups and progress update its
version and captured control/work counters in the originating transaction.
Idle and disabled accounts keep their clock with a null deadline, outside the
pending indexes. A parked capacity retry retains its exact due time.

Native guards reject forged frames and clock erasure. Suppressing the outbox
update rolls back the coordinator wake and its newly enqueued matching work.
Publication marks only the captured frame after Queue confirms its send. An old
acknowledgement cannot mark a newer wakeup published. Lost messages become
eligible for recovery after five minutes past both publication and due time.
New delayed messages use a twelve-hour local publication horizon.

The first selector let SQLite drive the final join from every coordinator.
Adding 5,000 parked accounts increased reads from 14 to 10,014. Pending-first
selection with exact coordinator probes reads **13 rows with or without those
5,000 accounts**. The regression measures the complete selection query and keeps
parked history outside both fresh and recovery scans.

## Queue and cron

[Comparison continuations](../src/inventory-comparison-continuations.ts) publish
small versioned scheduling hints. Messages contain account/runtime/work identity
and counters. Each turn reloads current metadata; child publishers retain their
native generation, input, configuration and lease checks. Duplicate parked
messages leave the coordinator unchanged. Early messages retry at the retained
deadline, and failed sends leave durable work recoverable.

[Hosted execution](../src/inventory-hosted.ts) publishes inventory and comparison
outboxes from cron. A mixed batch advances at most one inventory turn. A new
comparison message can advance up to four steps before publishing its final
frame. Each step rechecks the durable runtime and wakeup and uses its existing
lease. The consumer stops starting new steps after five seconds of elapsed
time and runs at most one step on redelivery. Both continuation families
publish before successful acknowledgement. A failed comparison send retries
the original message from the latest durable frame. Reports distinguish
comparison messages, completed steps and publication counts. Environment off
still pauses both families after the one-way handoff.

The implementation uses Queue bindings and awaits publication, following the
[Queue JavaScript API](https://developers.cloudflare.com/queues/configuration/javascript-apis/)
and [retry/acknowledgement API](https://developers.cloudflare.com/queues/configuration/batching-retries/).
The four-step profile uses the design's Workers Paid budget. D1 counts each
binding call against the invocation limit, including each batch as one call.
Hosted CPU and invocation latency still need measurement. See the
[D1 invocation limits](https://developers.cloudflare.com/d1/platform/limits/)
and [Queue consumer limits](https://developers.cloudflare.com/queues/platform/limits/).

## Read-only runtime admission

The original runtime guard rejected comparison leases alongside old reader and
sender leases. [Migration 0074](../migrations/0074_inventory_comparison_runtime_leases.sql)
admits known comparison, projection, matching and historical-adoption lease
families for active accounts, including bounded JSON job scopes. Unknown names,
malformed job scopes and locked accounts remain rejected.

Every native legacy checkpoint, source-proof, staging and attempt guard remains
in place. Existing in-flight legacy work still prevents handoff. Acquiring a
derived lease does not authorize an export or refresh an upstream observation.
A complete coordinator drain now passes under the actual read-only runtime.

## Native verification

The focused checks cover eight outbox cases, seven comparison Queue protocol
cases, two derived-runtime cases, the existing runtime regression, and hosted
source/comparison continuation behavior. They include stale send acknowledgements,
new signals during send, lost-message recovery, native rollback, deadlines,
bounded batches and the 5,000-account selector check.

The actual bundled `src/index.ts` runs cron and a real local Queue against native
D1. With complete mocked LoFi operation/QSO records and an independently empty
QRZ book, it completes both baselines, projects the source, publishes one current
inventory-absence result and parks its active comparison generation. It makes
two paced LoFi sync requests, two QRZ STATUS requests and two QRZ FETCH requests.
There are zero uploads or attempts; both credential envelopes are preserved.
No explicit comparison API call drives this test.

The runner additionally recovers an exact 250-record QRZ terminal boundary within
its existing request budget. STATUS, the rejected empty FETCH and a smaller
249-record replay use three requests in one turn. The persisted 249-record page
size allows the following turn to fetch the last contact and enter catch-up.

The inventory regression passes **609 cases**. The subsequently strengthened
cross-provider Worker test and added QRZ runner recovery case pass separately.
TypeScript, lint, formatting and the Worker dry-run build pass.

Logs:
- `/tmp/lofi-ferry-comparison-outbox-regression.log`
- `/tmp/lofi-ferry-comparison-outbox-costs-verified.log`
- `/tmp/lofi-ferry-comparison-runtime.log`
- `/tmp/lofi-ferry-comparison-continuations.log`
- `/tmp/lofi-ferry-hosted-comparison.log`
- `/tmp/lofi-ferry-hosted-comparison-worker-cross-provider-verified.log`
- `/tmp/lofi-ferry-qrz-runner-recovery.log`
- `/tmp/lofi-ferry-hosted-comparison-inventory.log`

## Encrypted real-source replay

The replay through 0074 is `265f7524-cd11-4a05-b35f-4f9889705937`.
Its private copy installs the genuine runtime prerequisites missing from the
original minimal ingestion/run capture, then performs native read-only handoff
before comparison work. It retains one scheduled, unpublished outbox row bound
to the final control, with zero missing rows or invalid bindings. Read-only
selection finds its one Queue candidate.

A fresh process recovers this audit, 82 derived bodies, twenty matching
claims/results, 400 pair references and the earlier dependency audits. Canonical
inventory, checkpoints and credentials remain unchanged. The database allocates
**17,240,064 bytes**, including the completed runtime/legacy guard schema.
All 21 private directory entries have no group/world access. New vendor requests
and uploads are zero. The previous 0072 capture still reopens without schema
changes.

The source baseline in this capture is partial. Four sampled local coordinator
turns do not qualify automatic full real-source recovery or initial-sync timing.
The actual Queue test uses mocked providers. Logs are
`/tmp/lofi-ferry-comparison-handoff-capture.log`,
`/tmp/lofi-ferry-comparison-handoff-reopen.log` and
`/tmp/lofi-ferry-comparison-handoff-compat.log`.

## Remaining qualification

Initial [normalized pipeline measurements](evidence-inventory-pipeline.md) found
and removed empty selected-input Queue amplification through migration 0075.
Continue qualification against larger and complete real-source inventories.
Current QRZ reads verify STATUS before each FETCH, so quota models
must include both requests per page plus catch-up and terminal recovery. Reusing
book-identity verification needs a verified provider/credential/scope contract.

Automatic LoTW date discovery/splitting, adoption scheduling, ownership-aware
planning, fresh source proofs and new delivery ownership/submission remain
unfinished. Retention/GC, restore quarantine and account-preserving cutover also
remain separate work. Hosted comparison activation is not export authorization.
