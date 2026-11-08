# Hosted inventory runtime evidence

Status: local implementation and runtime verification, 2026-11-08. Local `main` contains the runtime handoff, hosted scheduler/Queue wiring and the first shared comparison-key module. The configured runtime flag remains `off` in local, staging and production configuration. Nothing was pushed, deployed or reset.

## Native reader handoff

[Migration 0042](../migrations/0042_inventory_runtime.sql) records a one-way database handoff from the old reader/sender to the inventory read-only runtime. [Activation](../src/inventory-runtime.ts) requires a current fenced lease, no live legacy work leases and no unresolved old upload attempts, including attempts whose state is missing. Imported submitted/dispatching/uncertain work must be reconciled before activation. Activation changes no account, authentication, connection or credential rows.

The native transition rechecks its preconditions even if a switch guard was staged in an earlier transaction. After handoff, native guards block legacy leases, source writes, checkpoints, cursors, projections, history publication, proof creation, staging and dispatch. Pausing the environment flag does not restore that sender. The durable ownership row cannot be deleted/replaced to reset the decision.

Managed inventory scopes bind the runtime generation before accepting pages. A scope containing accepted standalone observations cannot be relabeled into the managed runtime. Fresh-state/account-preserving cutover and restore quarantine remain separate work; these guards do not prove that a different old deployment/database has been paused.

## Scheduling and hosted execution

[Migration 0043](../migrations/0043_inventory_scheduling.sql) stores fixed provider selections and their polling/verification policy. A managed run must match its registered book/date/station selection; it cannot substitute a different query while retaining the same coverage identity.

The [scheduler](../src/inventory-scheduler.ts) registers known LoFi accounts and QRZ books independently from contact matching. Registration uses a persisted bounded roster cursor so malformed metadata at the front cannot starve later accounts. Initial and query/client-reconfigured selections start full runs under their original job fence. Unchanged selections keep their active runs and cursors.

LoTW date/station selections can be registered explicitly. The date helper produces disjoint intervals of at most 32 inclusive days, preserving station/worked-call filters. Automatic derivation of the relevant date universe from source projections, and adaptive splitting of oversized reports, remain unfinished. A held overflow is not automatically restarted in a tight loop.

Default policy is five-minute source polling, fifteen-minute QRZ polling, fifteen-minute polling for recent LoTW selections and daily polling for older selections. Full verification is due after seven days for LoFi/LoTW and thirty days for QRZ. Policy is persisted and bounded; native vendor quotas/pacing still control actual requests. These are initial personal-use choices, not a demonstrated 100-account sustained request budget.

The [hosted entry points](../src/inventory-hosted.ts) select the old scheduler only while the database is still legacy and the runtime flag is off. In read-only mode, cron activates the runtime, registers bounded selections, starts full jobs and publishes the transactional outbox. Queue delivery executes one bounded inventory turn and publishes its continuation before acknowledgement. After handoff, turning the flag off pauses inventory delivery and never falls back to the old scheduler.

The [Worker entry point](../src/index.ts) now connects both handlers. [Wrangler configuration](../wrangler.jsonc) declares a separate Queue per environment, one message per consumer batch and bounded concurrency. Environment types were regenerated from the installed Wrangler schema; no remote resource was created. See Cloudflare's [Queue configuration](https://developers.cloudflare.com/queues/configuration/configure-queues/) and [local development](https://developers.cloudflare.com/queues/configuration/local-development/) references.

Accepted read pages update connection success health in the same atomic transaction. Deferrals, lifecycle controls and receipt replay do not renew it. A late publication failure rolls health back with the page. This adds one set-based statement per read page to the earlier [bounded run trial's publication measurements](evidence-inventory-runs.md#bounded-real-service-trial); those measurements retain their original boundary and values.

## Verification

- The full regression run passed **2,021 tests**, including the new ownership and hosted scheduling tests.
- A separate [actual Worker/Queue test](../tests/inventory-hosted-worker.test.ts), added after that run started, passed using the real bundled `src/index.ts`, native D1 and a real local Queue. Actual cron activated the isolated database, published its first job, read a synthetic source response, waited for delayed delivery, completed catch-up/quarantine/publication and queued the next idle run. Two source requests were made; their separation respected the initial pacing reservation. No old source materialization, ledger, attempts or export proofs were created, and credential ciphertext stayed unchanged.
- The later health change passed **58 focused lifecycle/runner/continuation tests**, including rollback and control-step freshness checks. These overlap the full suite; the counts should not be added.
- The final combined inventory/credential run passed **219 tests** on the current code, including the actual delayed Queue path, health publication and comparison-key checks.
- TypeScript, repository lint/formatting, mise validation and the Worker dry-run build passed. The build deployed nothing.

The runtime test proves the actual handler/Queue path, not a 200,000-contact production completion rate. Local Queue metrics did not expose delayed backlog as expected; the test therefore verifies actual delayed delivery through completion rather than relying on that metric.

The fixture migration loader now delegates to the checked shared parser. Previously an unfinished SQL trigger block could leave later fixture guards unapplied without an error; this was detected and corrected while testing handoff admission.

## QRZ count-only investigation

QRZ documents count-only selection using `MAX:0`. See the [official API guide](https://www.qrz.com/docs/logbook/QRZLogbookAPI.html). A bounded real-service probe used the retained encrypted trial credential through the strict read-only transport, with no credential rewrite or upload:

| Selection                       | Result | Count | Response bytes |
| ------------------------------- | ------ | ----: | -------------: |
| Whole configured book, `MAX:0`  | `OK`   | 4,252 |             20 |
| Empty high-LOGID tail, `MAX:0`  | `FAIL` |     0 |             19 |
| Same tail, normal bounded FETCH | `FAIL` |     0 |             19 |

The initial STATUS plus these three FETCH requests totaled **four HTTP requests and 228 response bytes**, with zero uploads. Neither empty response supplied ADIF or a reason. Count-only lookup therefore does not resolve the ambiguous empty-result case for this account. It is not being used to turn `FAIL, COUNT=0` into completion or absence evidence. A sparse modification selection can still require verification before its run completes.

## Shared comparison-key foundation

[Comparison keys](../src/inventory-comparison-keys.ts) now reuse the [existing matcher's](../src/historical-matching.ts) exact call and timestamp normalization. A complete record stores one HMAC bucket. A complete lookup probes three neighboring call/time buckets plus the relevant call-only, time-only and unknown classes, for eight equality keys total. Invalid/incomplete fields remain in their fallback class; they cannot disappear behind a readiness filter.

ADIF second/minute intervals fit wholly within an aligned half-hour bucket. Two buckets separated by an entire intervening bucket have a minimum separation greater than the existing inclusive thirty-minute candidate window. The implementation pins that width/normalization/policy version and rejects an incompatible future window. Exact station, band, mode, satellite and interval predicates still run after lookup; a neighboring hash does not establish a match.

Keys use a nonexportable 256-bit HMAC-SHA-256 key and distinct tenant, generation, key-ID and class domains. Stored tokens contain no clear callsign or date. Asynchronous signing captures its context and normalized input before yielding.

The key and existing matcher selection passed **22 tests**, including **1,152 generated record pairs** around half-hour, minute, midnight, leap-day, pre-epoch and year boundaries. Every candidate accepted by the actual precision-aware predicate remained discoverable, as did relevant malformed-time holds. Tenant/generation isolation, fallback classes, coarse false positives and mutation during asynchronous signing are covered.

This section records the key primitive checkpoint. The later [comparison evidence](evidence-inventory-comparison.md) covers durable encrypted keys, generation builds, atomic hint/bucket publication and bounded bulk candidate lookup. Projection materialization, matching dependencies, reverse-source uniqueness and actual bulk matching remain unfinished.
