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

## Destination preparation

[Migration 0092](../migrations/0092_inventory_delivery_preparation_review.sql)
binds a current review to the proof's exact projection and logical
destination. The workspace reopens at most 64 accepted source bodies
and checks the reconstructed contact against the approved projection
and provider fingerprint. It shares the 4 MiB input budget between
raw bodies and projections. A replacement destination review can
settle while the source proof still has time left.

[Migration 0093](../migrations/0093_inventory_qrz_preparation.sql)
stages up to 20 individual QRZ INSERT artifacts in one transaction.
It binds the current credential version, verified book identity, route,
active template, ownership clock and exact review for each member.
The artifact contains the serialized ADIF and its digest, with no API
key. A committed preparation receipt recovers the original attempt IDs
and bytes. Pending attempts reserve each source contact and outbound
seconds identity within the logical book. Cancelling a stale unsent
attempt releases the reservation and preserves the artifact.

The native Worker fixture exercised a template change during commit,
atomic rollback, restart-style receipt recovery, overlapping staging,
and source, route, template and ownership invalidation. The live
personal-log copy reopened one source contact against both provider
reviews without another provider request. Each route opened 3,490
encrypted bytes and 2,284 plaintext bytes. The review and body queries
read 1,328 rows for QRZ and 1,405 for LoTW, excluding the initial proof
lookup. The older copy used a credential-derived QRZ book alias. The
canonical book guard held staging before any attempt was written.
New managed trials seed the verified book ID. The original access and
credential envelopes were unchanged.

## Canonical QRZ trial and final observation

An isolated copy registered the verified QRZ book ID and scanned a
bounded date range around one real LoFi contact. The initial run held
after four QRZ requests because its modification catch-up did not prove
completion. An explicit repeat-selection catch-up established coverage
with a second complete read of the same range. This policy is bounded
to 35 inclusive days. It preserves the normal overlapping modification
checkpoint for later incremental reads.

The successful canonical run used four QRZ reads for baseline and
catch-up and two LoFi reads for the source proof. The copy staged one
236-byte QRZ ADIF artifact, recovered the exact artifact and preparation
receipt after closing and reopening the database, and preserved the
original credential envelopes and capture.

[Migration 0094](../migrations/0094_inventory_qrz_neighborhood.sql)
binds the final QRZ observation to the saved request digest, the current
review and source proof, and a fenced book lease. Each read shares
native QRZ request admission. A rejected, incomplete or stale read
cannot publish evidence. Only the latest observation for the attempt
and lease is current. Its lifetime ends no later than 60 seconds from
the read start and is also limited by the source proof and lease.

The live neighborhood check made three read-only QRZ requests and
found zero candidates. Its observation was current while the lease
was held and became unavailable when the lease was released. The
trial made zero uploads. Native Workerd tests also cover a positive
candidate, replacement of a prior observation, and a template change
during the read.

## QRZ dispatch and readback

[Migration 0095](../migrations/0095_inventory_qrz_dispatch.sql) commits
a single may-send claim with the vendor request reservation. It checks
the current empty observation, request digest and book lease in the
same transaction. A denied budget leaves no claim. The transport also
checks rollout authorization and the exact saved INSERT fields before
sending. A confirmed response publishes the canonical QRZ LOGID as
delivery ownership.

A lost response leaves the claim and its identity reservation in
place. Recovery needs a newer lease and current credentials for the
same logical book. It verifies that book and reads for a unique exact
copy of the archived ADIF. An empty or ambiguous read leaves the claim
unsettled. While an outcome is unknown, this first version pauses QRZ
delivery review and historical adoption for the tenant. A settled
delivery retains its source and remote ownership without a historical
association.

The native Workerd fixture verified a normal receipt and an interrupted
send with one simulated INSERT, a stranded lease, an empty readback
and then an exact observation after the source proof became stale.
It also verified that closed exports, a candidate, a denied budget and
a template rebind block dispatch. The upgrade on an isolated copy of
the live trial preserved its artifact and credential envelopes with
zero network requests.

## Hosted QRZ recovery and restore

[Migration 0096](../migrations/0096_inventory_qrz_recovery.sql) creates
recovery work in the reservation transaction. Cron publishes due work
and the Queue checks the version under the book lease. Each recovery
turn records its successor before HTTP. After six turns, an unsettled
claim stays reserved and automatic readback stops. The Worker fixture
recovered a failed publication, discarded an old work version, and
resolved a simulated lost response after an empty readback. Exports
were disabled for all hosted recovery reads.

[Migration 0097](../migrations/0097_inventory_restore_quarantine.sql)
attaches native quarantine to the account lock shared by the operator
SQL and the programmatic restore path. It invalidates scope freshness,
retires active proof work, clears leases and fences queued recovery.
Confirmed receipts remain authoritative. Prepared snapshot attempts and
possibly sent attempts keep their artifacts and identity reservations
under the durable restore lock. Repeating the lock preserves its
versions, including any legacy context cursor already invalidated.

The Workerd fixture locked a database with a prepared attempt, a
possibly sent attempt and two confirmed receipts. An isolated copy of
the real trial held four scopes and invalidated 18 ready selections.
It preserved the staged artifact and credential ciphertext. Repeating
the operator SQL produced the same state with zero network requests
or uploads. Hosted enrollment and new-send scheduling, LoTW batches
and expired-proof collection remain open.
