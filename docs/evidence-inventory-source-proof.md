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

These receipts are inputs for the next native step. Persisting the
collection, revalidating the full closure at mint, producing an expiring
proof, and binding that proof to delivery preparation remain open.
The trials created zero proof rows, delivery attempts or uploads.
