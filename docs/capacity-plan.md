# Capacity plan

Status: implementation started 2026-10-23. Production exports remain disabled.
This plan extends the [reconciliation investigation](reconciliation-investigation.md)
to ongoing delivery across accounts. Targets below are engineering acceptance
criteria, not demonstrated service guarantees.

## Workloads and success criteria

The first growth workload is 100 accounts creating 100 contacts each per day:
10,000 new contacts and up to 20,000 destination deliveries daily. That averages
about 35 new contacts every five minutes, but averages hide bursts, outages and
large initial imports. A 200,000-contact import must coexist with daily traffic.

Test these separately, with fake vendor adapters and actual D1/workerd:

| Workload                                                            | Proposed acceptance                                                                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 100 accounts, 100 new contacts each daily, both destinations        | Arrival rate remains below measured completion rate; queue age does not grow over a simulated week; at least 2× sustained capacity headroom            |
| Tenfold arrival burst for one hour                                  | Bounded memory and queue growth; drain within the following day while normal arrivals continue                                                         |
| One account importing 200,000 contacts alongside normal traffic     | Small accounts continue receiving turns; first classification within one day is a target to validate, with external service delays reported separately |
| Existing 4,000-contact backlog                                      | Target first classification within one hour after required context is available; explicit review holds count as classified, not delivered              |
| Vendor outage, 429/503, duplicate jobs, worker crash and restart    | No duplicate writes, no lost work, bounded retries, persisted cooldown, other vendors/accounts continue                                                |
| Expiry, edits, removal, credential rotation and identity collisions | Stale evidence cannot authorize an association or dispatch; uncertain submissions remain unresolved until readback                                     |

Track first classification, review-required, prepared, submitted and observed
separately. Vendor processing time and human exception review cannot be counted
as worker capacity. Proposed live discovery/delivery freshness must be chosen
against the vendor budgets below; five-minute polling is not currently feasible
for 100 accounts.

## Current limits and measurements

The deployed worker uses a five-minute cron, a 90-second soft execution budget,
850 D1 RPC budget, background batches of 20 and a live batch of one. Recent
read-only runs processed 15–23 contact turns. This is not live delivery capacity.

A local 20-contact, same-week, two-destination fixture made 467 D1 RPCs and
939 SQL statements with fully cached history, zero vendor reads and 40 review
classifications. Of those RPCs, 160 reread the same history, 40 observed contacts,
40 checked eligibility, 80 applied outcomes, and 80 saved checks/source status/
queue completion. Local elapsed time does not predict remote D1 latency.

Current vendor limits are application policy shared across all accounts, not
verified vendor quotas. They reserve capacity for live work and enforce shared
Retry-After cooldowns. They must not be raised merely to make a benchmark pass.

| Vendor | Current total requests / five minutes | Consequence at 100 accounts                                                                                                                                                                                              |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LoFi   | 24, including at most 4 background    | Five-minute polling needs 100 requests. Equal polling takes at least about 21 minutes, or 25 minutes when all four background slots are used.                                                                            |
| QRZ    | 120                                   | A new contact currently needs at least four calls through INSERT: classifier read, preparation read, dispatch read and INSERT. 40,000 calls/day exceeds the 34,560/day budget before maintenance or retries.             |
| LoTW   | 40, including at most 8 background    | A new query-enabled contact currently needs at least six calls through observed receipt: classifier read, preparation read, two certificate checks, upload and readback. 60,000 calls/day exceeds the 11,520/day budget. |

The LoTW signer already accepts multiple contacts, but the attempt lifecycle
currently represents one contact. Combining signed input alone would bypass
per-member source validation, cancellation and outcome tracking. Sparse daily
traffic also cannot assume every account fills a 100-contact upload quickly.

## Ordered implementation

### 1. Reduce repeated reconciliation database work — in progress

Share complete encrypted history reads and decryption within a bounded source/
destination/station cohort. Keep per-contact generation checks, current account
and credential validation, retention checks and commit-time evidence guards.
There is no cross-request plaintext cache. Cold partitions retain leased progress;
missing, expired or malformed evidence never becomes proof of absence.

Read observation and eligibility metadata for a cohort, then submit bounded
transactions containing individually guarded outcomes. Preserve route changes,
attempt cancellation, remote identity ownership and collision quarantine even
when competing contacts occur in the same batch. Queue completion and review
memos must reflect the final ledger state, including collisions discovered later
in the batch.

Acceptance: reduce the warm fixture's per-contact portion from 400 RPCs to at
most 30, excluding source selection and housekeeping. Record SQL counts and
database time as well as RPCs. Add integration/race regressions; keep live
dispatch sequential in this first release. Deploy read-only and compare actual
classification rate and database wall time before increasing cohort size.

### 2. Wake eligible work and schedule accounts fairly

Inventory completion should wake only contacts waiting for that evidence,
instead of waiting for a 24-hour review timer. Persist the dependency without
storing plaintext contact data. Validate larger LoFi page sizes against real
responses before changing them; repeated context and destination rescans must
share retained source work where its proof allows reuse.

Replace full account sweeps with indexed due work and bounded account turns.
Separate live arrivals, history imports, readback and maintenance. Reserve live
capacity and give background work guaranteed progress; an account with a large
import cannot consume everyone else's vendor allowance. Use adaptive polling
for idle accounts, with explicit measured discovery latency and retry jitter.

Acceptance: deterministic multi-account tests demonstrate bounded wait and
progress under bursts, cooldowns and a 200,000-contact import. Report actual
poll age and oldest eligible work, not just completed turns.

### 3. Make live delivery economical without weakening write safety

First implement durable outbound identity claims for both vendors, including
fractional timestamps, collisions and edits. They remain a prerequisite for
exports. Keep historical precision and eight-character source-grid policy as
separate review decisions.

Introduce immutable attempt membership before enabling multi-contact LoTW
artifacts. Group only compatible tenant/account, certificate, station location
and signing policy. Bound member count, serialized bytes and signing CPU, with
a maximum coalescing delay so sparse accounts are not held indefinitely.

Every member needs pinned source/version/identity, artifact membership and
readback state. Any invalid member before dispatch invalidates the saved
artifact; rebuild an unsent replacement from still-valid members. Once dispatch
may have occurred, retain the exact artifact and reconcile every member without
blind resubmission. An upload receipt does not prove every member was observed.
Share certificate validation only within its validated scope and dispatch turn.

For QRZ, retain the final write-adjacent duplicate check and immutable write
intent. Determine which earlier readbacks can be safely coalesced after identity
claims exist. Batch readback neighborhoods where responses prove complete
coverage; do not treat cached absence as authority to write. Model required
calls for sparse and bursty accounts before deciding whether vendor-approved
budget changes are needed.

Acceptance: request demand fits the configured budgets with retry/maintenance
headroom in both sparse and burst tests. Member cancellation, crash recovery,
partial readback and collisions pass with zero duplicate writes.

### 4. Add durable continuations around bounded work

Persist runnable work and a transactional outbox before queue publication. Queue
messages identify work, not credentials or contact payloads. At-least-once
delivery requires idempotent processing, fenced leases and checkpointed progress;
cron remains a recovery sweep. A queue consumer must call the bounded operations
above rather than multiply the original per-contact database/vendor requests.

Account and vendor admission apply before dispatch. Use bounded concurrency,
dead-letter handling and operational retry controls that cannot repeat uncertain
external writes. Benchmark one D1 database before considering partitioning;
queues cannot remove a database serialization or vendor budget bottleneck.

### 5. Prove capacity and rollout readiness

Run the full workload matrix, publish reproducible commands and record maximum
queue age, completion rate, RPC/SQL counts, vendor calls, CPU/memory, retries and
cost estimates. Separate a simulation of time from real Worker/runtime latency.
Observe read-only production after each runtime release and retain a rollback
revision. Do not label an index microbenchmark as a 200,000-contact capacity test.

Exports stay disabled until source replay/cutover evidence, identity claims,
precision policy, exception review and the existing
[rollout checklist](rollout-checklist.md) are satisfied. First writes need exact
scoped canary authorization and observed results. Capacity work itself does not
provide that authorization or evidence.

## Platform constraints informing this plan

[D1 batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
reduce client round trips and execute transactionally; reducing RPCs does not
eliminate SQL work or [D1 database limits](https://developers.cloudflare.com/d1/platform/limits/).
[Cloudflare Queues delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
is at least once, which is why leases, idempotency and the outbox precede queue
adoption. [LoTW signed submission](https://lotw.arrl.org/lotw-help/developer-submit-qsos/)
accepts signed files; safe multi-contact lifecycle handling remains application
work, not a signer-only change.
