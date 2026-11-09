# LoFi source evidence for delivery

## Shared snapshot and witness collection

[Migration 0086](../migrations/0086_inventory_source_proof_scope.sql)
and the [source workspace](../src/inventory-source-proof-workspace.ts)
capture a bounded set of contacts across QRZ and LoTW reviews. The
source must have a complete managed LoFi baseline, an idle current
stream, and committed all-client watermarks. A captured route binds
the review result and source projection versions. The operation and
its active event dependencies are shared across both destinations.

The workspace uses accepted server revisions and stamps. It may reuse
a positive from a current committed observation page, under the same
credential, configuration and read epoch, within its original five
minutes. The page's request start supplies the time. An older retained
row can position the next read as an anchor. The quiet-period lower
bound uses the current projection's derivation time and can postpone
preparation after an otherwise unchanged rebuild.

The saved personal log supplied a cohort of twenty contacts with forty
current destination reviews. It shared one base operation across the
contacts, giving twenty-one dependencies and twenty-one observed
anchors. All old positive observations were outside the witness
lifetime. This native read used one D1 call, three SQL statements,
53,617 rows read, and zero writes or HTTP requests. Checking the
distinct retained comparison sets accounts for most of those reads.

The presence collector can resume the last validated side positions
after vendor pacing. The continuation binds the original scope, target
set and deadline. A resumed read preserves the timestamps of earlier
witnesses and still reserves an attempt for the final forward read.

## Canonical forward drain

[Migration 0087](../migrations/0087_inventory_source_proof_drain.sql)
and the [drain helper](../src/inventory-source-proof-drain.ts) use the
normal paced LoFi delta run and the existing inventory outbox. A
qualifying receipt starts after collection, begins from the prior
committed vector, and completes both streams in its first observation
page. A paginated or cursor-started run can still advance the inventory
normally. Its completion supplies no first-page drain receipt.

Completing a read updates poll metadata on the source link. Drain
authority compares the configuration after removing those display
fields. It retains the logical source, credential version, runtime,
configuration version and coverage epoch checks.

The live response included cursor strings even though both streams
reported zero records left. The inventory adapter now commits the two
numeric watermarks at that boundary. [Migration 0088](../migrations/0088_inventory_terminal_source_checkpoints.sql)
also recognizes retained terminal-cursor checkpoints that explicitly
completed their streams. The next delta begins without those cursors.

## Read-only live trials

All trials ran on isolated copies with the same linked credentials and
a transport restricted to read-only LoFi sync bodies. The first
operation-bound contact yielded one of two required positives over two
attempts and stayed held. A standalone contact then yielded its one
positive, while the attempted forward read ended before HTTP headers.

The next bounded trial witnessed the same standalone contact shared by
both destinations and completed a one-page canonical forward run in
45.3 seconds after collection. Three LoFi attempts included two HTTP
200 responses and one transport timeout. The trial harness enforced
20-second spacing independently of the retained inventory pacer, which
can consume the client's 15-second timeout when a read starts too early.

The original proof lookup held the completed live run because of its
terminal cursors. A separate copy on schema 0088 qualified the original
committed receipt, verified the same dependency and destination routes
against the pre-read capture, and recovered the receipt after reopening.
Requalification used zero new requests and preserved the original
account access and credential ciphertext.

The actual Worker cron and Queue test qualifies a forward drain and
checks that its new checkpoint omits the terminal cursors. The collector
and adapter tests cover resuming a paced collection, unchanged witness
times and the completed watermark vector. The focused suites passed
124 tests. TypeScript, lint, formatting and the Worker dry-run build passed.

These first trials qualified read receipts before proof publication was
implemented. They created zero proof rows, delivery attempts or uploads.

## Durable proof publication

[Migration 0089](../migrations/0089_inventory_source_proof_jobs.sql)
keeps one active collection per managed source. It retains the exact
scope, dependency snapshot, witnesses, validated side positions, due
time and original deadline across restarts. A native debit runs in the
same transaction as LoFi request admission. A denied request rolls back
the debit. An admitted request consumes the slot even if the worker
restarts before saving the result.

[Migration 0090](../migrations/0090_inventory_source_proofs.sql)
binds the collection to one deterministic forward run. Collection
reserves a fourth attempt for the drain. The drain's admitted requests
count against the same allowance. If the proof expires or exceeds that
allowance, later requests proceed as ordinary inventory work.

Publication checks the one-page receipt, original witness times, exact
source versions, complete operation event set, and current lease. The
immutable proof and completed job become visible in one transaction.
The current-proof lookup checks expiry and the source closure again.
A destination can refresh its review while the source remains
identical. Delivery preparation will check the current destination
review before it uses a source proof.

[Migration 0091](../migrations/0091_inventory_source_proof_wakeups.sql)
uses the job's work version to recover Queue publication and ignore
older messages. The hosted read-only worker processes explicitly
queued proof jobs. Repeating a selection already covered by a current
proof reuses that proof and its original expiry.

## Live proof trial and qualification

The durable job processed one real LoFi contact needed by both QRZ
and LoTW in 26.3 seconds. LoFi returned HTTP 200 for both requests,
one targeted collection and one complete forward read. Native
admission charged exactly two attempts. A new process recovered the
collection before the drain and recovered the published proof after
the drain. Another reopen after expiry found the retained proof row
outside the current-proof lookup. All copies preserved the captured
credential ciphertext and original access. The trial created one
proof and zero delivery attempts or uploads.

The actual Worker cron and Queue test used one canonical forward
request after reusing committed operation and contact witnesses. It
verified proof reuse, the original expiry, and invalidation when the
source quiet period changed. The hosted tests also recovered a failed
queue send and ignored an older work version. The focused suites
passed 44 tests, and TypeScript, lint, formatting and the Worker
dry-run build passed.

The next stage binds this proof to destination preparation, exact
routing and a current ownership review. Automatic cohort enrollment
from delivery work, signed batches, upload recovery and expired proof
collection remain open.
