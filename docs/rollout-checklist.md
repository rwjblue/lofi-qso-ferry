# Personal rollout acceptance

Ferry is suitable for an invite-only, read-only pilot with one or two users.
Automatic exports are still disabled. A small first-export trial requires source
boundary evidence and exact contact review; finishing the 200,000-contact capacity
plan is a separate expansion milestone. No real logbook entry has been inserted,
replaced, deleted or uploaded during this implementation work.

## Current evidence (2026-10-24 UTC)

The owner has enrolled and linked LoFi, QRZ and LoTW.
Signed revision `5a416de5898657a6b12b60fd900d787f60341d51` deployed read-only
at 05:11:14 UTC as Worker `a16f8d42-d039-437e-8fee-44116ddb5195`, at 100% traffic.
All **1,131 tests** and required checks passed in [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40064363238).
Independent 05:11:28 checks confirm healthy service, all three asset hashes
matching, all six export gates closed, 29 migrations through `0030`, 380 LoTW
identity claims and zero uncovered mappings, attempts, cutovers or temporary
guards. Mandatory preparation/dispatch proof binding and bounded scheduler
integration are deployed. No proof, attempt pin or retention candidate exists
while exports are closed. All 4,500 retained source bodies have incarnations;
1,055 positive observations have no future or partially populated metadata.
The all-client policy remains in backfill with 218 operations and 1,750 QSO-stream
records in the current epoch, zero ready sources and zero eligible exports.

At 04:51:11 UTC, policy membership covered 218 operations and 1,425 QSO-stream
records, still in backfill with no ready source or eligible export. QRZ had 36
complete and one pending partition, but zero retained covering plans; the prior
98-record plan expired at 04:00:56. Its ledger had 3,435 ambiguous and 398 pending
rows. Attempts, cutovers and temporary guards were zero. Expiry cleanup can reduce
partition counts without resolving gaps. Refresh QRZ evidence for the exact trial.
At approximately 04:58 UTC, the pending partition was an expired, empty base
manifest awaiting cleanup or rebuilding; freshness of all complete partitions
was not independently verified.

At 02:52:53 UTC, QRZ had 35 complete and five pending history partitions. The
same single complete covering plan contained 98 surrounding records and zero
target records. Its ledger held 3,438 ambiguous and 395 pending rows; attempts,
cutovers and temporary guards remained zero. These are reconciliation states,
not deliveries or approval of historical exceptions.

The earlier read-only D1 snapshot at **2026-10-23 21:53:13 UTC** contains zero export attempts and
zero cutovers. The five completed scheduler runs from 21:30 through 21:50 processed
117, 140, 160, 125 and 119 contact turns. Four stopped at the deadline and one at
the database budget; each reported 20–23 errors and one deferral. These are
processing turns, not unique finished contacts or a proven production rate.

At that snapshot, QRZ had 2,468 ambiguous and 1,213 inventory-pending destination
rows. LoTW had 338 adopted, 2,587 ambiguous, 138 mismatched and 618 inventory-pending
rows. The destinations overlap, so these counts cannot be added to count contacts.
Source review separately includes eight test contacts and one blocked contact.
Waiting for cron advances available inventory and retry work; it does not approve
ambiguous identities, lower-precision locations or missing routes.

| Readiness item            | Evidence and remaining work                                                                                                                                                                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts and connections  | Owner enrollment and all three connections are complete. One active passkey is registered; a second key is recommended, not an export gate. The protected local key backup exists and its encryption key decrypted current credentials for the scoped audits. Off-device secret-manager storage remains unconfirmed. |
| Reconciliation throughput | Batched intake, guarded classification, shared history, indexed retries, account admission, context index and QRZ Unicode decoding are deployed. Sustained capacity and remaining vendor errors still need measurement.                                                                                              |
| Source boundary           | Two inventories and a bounded forward sample match Ferry. The deployed policy is still in backfill. Mandatory exact-dependency source proofs are deployed; production handoff and current trial evidence remain outstanding. These proofs do not establish global purge/replay guarantees.                           |
| Outbound identities       | Durable whole-second claims now protect preparation, adoption and dispatch. Race, rollback, migration, uncertainty, expiry and source-change tests pass. Deployed ownership and closed gates are independently verified.                                                                                             |
| LoTW station location     | Lossless per-contact 4/6/8-character signing is implemented with released TQSL evidence and independent fixed-vector coverage. Historical lower-precision associations and live ARRL acceptance remain unproved.                                                                                                     |
| First vendor writes       | The latest instruction to keep exports disabled supersedes the earlier one- or two-contact trial authorization. No write or actual trial may occur until the owner changes that instruction. Exact scope, fresh evidence, backup and enforced exclusion of global cutover/no-query effects are still required.       |

## Finish reconciliation and review exceptions

Keep all six export gates closed while doing this work. Preserve cursors, source
birth evidence, current context and destination reservations; clearing counts or
forcing a contact into an eligible state is not reconciliation.

| Outcome                                                       | Next action                                                                                                                             | Can scheduled work resolve it?                                                                                                                                                                                                                           |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inventory/context pending                                     | Let bounded reads finish; diagnose persistent vendor failures and expired or missing dependencies.                                      | Yes, when the dependency is obtainable and retries succeed.                                                                                                                                                                                              |
| Waiting for current source verification                       | Obtain fresh exact QSO/base/event observations and a complete final canonical drain under the ordinary budget.                          | Complete subsets and later singleton turns can progress. A budget-limited singleton with no ready contact receives an exact-version ten-minute delay; neighbors retain five-minute turns. A contact needing more than three collection reads stays held. |
| QRZ minute-only or nonunique identity                         | Compare the specific source and remote records; establish an explicit association policy with adequate evidence.                        | No; another unchanged read cannot supply missing precision.                                                                                                                                                                                              |
| LoTW six-character history versus eight-character source grid | Review the actual station location and association. Full-grid outbound support does not retroactively establish historical equivalence. | No automatic adoption or grid truncation.                                                                                                                                                                                                                |
| Other location mismatch                                       | Compare exact station fields and authoritative source context. Keep the hold until the discrepancy is understood.                       | Only a meaningful source/remote correction can change the evidence.                                                                                                                                                                                      |
| Missing or ambiguous route                                    | Select the intended station/book/account coverage.                                                                                      | No; the scheduler cannot invent destination coverage.                                                                                                                                                                                                    |
| Test or invalid contact                                       | Tests stay excluded; correct an invalid real source record through its normal source application.                                       | Test exclusion is intentional. Invalid source data needs a correction.                                                                                                                                                                                   |

A narrow first-export trial does not require approving every historical exception.
Its selected contacts must have complete current context, unambiguous routing,
valid certificate/location/mode fields, durable identity ownership, a current
immutable source proof and fresh remote checks. Other held contacts remain outside the trial. General automatic
coverage requires its own scope review afterward.

## Source boundary before cutover

Run the aggregate source audit described in [LoFi evidence](evidence-lofi.md), then
complete the missing evidence packet. Replaying retained UUIDs can show observed
repeatability or reveal omissions; it cannot prove that older tombstones were
never omitted. Record the authoritative initial inventory, independent operation
and QSO cursors, snapshot/overlap semantics, deletion retention and expired-cursor
recovery. Late uploads, historical edits, segment changes and deletion must be
covered by the supported contract or a deliberately scoped experiment.

Keep `SOURCE_BOUNDARY_VERIFIED=false` until that evidence supports the real source
connection. The 2026-10-23 22:19 UTC audit confirms both destination rescans complete and no missing births or unavailable current payloads. Two contacts still reference deleted operations. Keep those contacts held. The source gate is global and applies even to an exact-UUID trial.

**Remaining blocker before a narrow trial:** this global gate also permits
source-wide cutovers and no-query inference. Exact fresh per-contact proofs do
not establish universal UUID, tombstone or purge guarantees. Decouple proof-based
contact delivery from those effects, or otherwise exclude them with enforced
guards, before any QRZ trial. Completing the baseline and deploying mandatory
proofs alone is insufficient to enable exports. Keep the global gate closed.
A naturally whole-second contact does not waive it. Never alter a source timestamp
merely to bypass a safety check.

The later [independent comparison and live replay](evidence-lofi.md#observed-local-and-live-comparisons)
found every local HaLo UUID in Ferry and matched two ordinary tombstones across
two complete operation reads. A separate repeated operation probe matched ten
members, including four events. On 2026-10-24 at 00:19 UTC, two complete server
reads found all thirteen additional Ferry contacts unchanged; HaLo's local
omission remains unexplained. At 00:58 UTC a four-read probe matched 23 members
twice and confirmed that Ferry's exact base-body revision hash and server stamp
matched both fresh server reads. HaLo's local base differed only in its server
stamp. See the [current source observations](evidence-lofi.md#current-server-positives-and-base-operation-checks-2026-10-24-utc).
Purged records, forward event changes, source-wide context completeness, cursor
aging and server retention still need evidence. The client-filtered forward
probe still needs independently verified writer provenance before a live run;
the separate all-client probe below does not make that claim. No deletion or
source repair was inferred from local differences.

QRZ absence work now has integrated bounded history fallback and separate
fresh collision checks. A prior 35-day read observed 467 records across two
complete pages with none in one pending seven-day gap. The deployed history path
requires matching complete covers before publishing cached evidence; the fresh
path verifies the current book and scope again before writes. One automatic
cover completed in production at the 02:03:58 observation, with 98 surrounding
records and zero target records. The remaining gaps and actual insert/readback
acceptance still need observation. See the [QRZ evidence](evidence-qrz.md#integrated-history-and-fresh-checks).

The all-client inventory completed **two 4,500-record passes at 02:41:09 UTC**,
matching each other and Ferry exactly. HaLo remained stable with 13 additional
server contacts, 3,247 server-stamp differences and 180 unknown versions; no local
UUID was missing remotely, and shared flags, membership, application versions
and known revisions agreed. At **02:42:27 UTC**, two complete all-client forward
reads matched 20 known targets (ten operations and ten contacts), with no missing,
changed, unexpected or repeat-different records. No events or tombstones were in
that sample. Current scope and positive delivery were observed; source-boundary,
account-wide membership, continuous coverage, writer provenance and purge-exclusion
authority all remain false.

The [versioned baseline and handoff](capacity-plan.md#implemented-versioned-all-client-source-baseline-and-handoff)
is signed and pushed in five commits through `339590e08e229b411f411d3878e921d4a02265df`,
followed by signed delivery test fixture fixes in `ce238cdcfea72ed5cbc7b624ec6a7efc01978154`.
The [first CI run](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40055506398)
was cancelled after a leaked `workerd` process; [replacement CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40057488314)
passed, and `ce238cdcfea7` deployed at 03:28:48 UTC with all six gates closed.
Observe production baseline/drain/quarantine completion after activation.
The transitional policy fences are dormant where no policy row exists; main
exports must require current ready policy membership for each exporting source.
Fresh-positive collection, canonical witness storage, completed-drain markers,
immutable proofs, indexed observation anchors and shared cohort coordination are
signed and pushed through `e16f987441fc`, with exact-key lookup correction
`3d7b0cac782a`. All 1,098 tests pass and the foundation deployed at 04:13 UTC.
It grants no export authority by itself. Mandatory proof binding at both boundaries
and scheduler integration deployed in `5a416de5` at 05:11 UTC. Migration
`0030` requires current ready policy and exact dependency proof even for old
workers, missing policy or null context. Evidence expires from its oldest original
positive observation within five minutes; an empty drain cannot renew it. Each
attempt pins its original proof ID. Stale known-unsent work may be rebuilt, but
dispatched uncertainty and permanent identity ownership remain. These safeguards
do not open the global source gate or establish source-wide cutover authority.

## First-export trial packet

The latest instruction to keep exports disabled supersedes the earlier one- or
two-contact trial authorization. Prepare this packet read-only; no actual trial
may run until the owner changes that instruction. Any later trial also requires
enforced separation from the global cutover/no-query effects described above,
then current evidence for the exact scope. The proposed order remains QRZ first,
followed by LoTW. Keep private contact details out of repository documentation.

A fresh protected production SQL backup was verified at **04:25:27 UTC on
2026-10-24**, before the mandatory-proof release. Its isolated restore passed all
28 existing migrations plus pending `0030`, integrity checks and zero foreign-key
violations. All three current credentials decrypted; repeated quarantine preserved
380 permanent identity claims and zero attempts/cutovers. No production restore
or vendor mutation occurred. Preserve that backup and its verification evidence
before external changes; refresh it if intervening state changes warrant it.

The earlier protected production SQL backup completed at **03:50:46 UTC on
2026-10-24**. It restored successfully into isolated in-memory SQLite with valid
integrity, zero foreign-key violations and all 25 current migrations; pending
migrations `0027`–`0029` also applied successfully in that isolated copy. It retained
380 identity claims and zero attempts or cutovers. The separately protected
encryption-key backup decrypted all three current credentials. Quarantine was applied twice to
the isolated copy: accounts, connections, sessions, credentials and leases were
inactive, while attempts and permanent claims were preserved. No production
restore or external logbook write occurred. Take a current backup before the live
trial if the intervening state changes warrant it.

The [read-only trial audit](../scripts/export-trial-audit.ts) accepts one explicit
contact, current revision/generation and normal projected destination identities.
It checks source/context/credential freshness, quiet period, ledger bindings,
unresolved attempts and identity ownership using a SELECT. It always reports
`writesAuthorized: false`; it neither signs nor stages a delivery. In the 2026-10-23 23:34 UTC
live sample, both routes passed the current metadata and ownership checks but
neither had an eligible first-insert classification. That contact remains held.
Its six-character source grid and fractional timestamp were preserved; the audit
does not impose eight-character grids on other users or contacts.
1. Record the signed deployed revision, closed-gate readback and the source
   evidence. Verify that narrow delivery cannot invoke source-wide cutovers or
   no-query inference without independent authority. Verify access to the existing production encryption-key
   backup; do not rotate or recreate keys. A second independent passkey is
   recommended but is not a hard requirement for this owner-operated pilot.
   Operator database recovery can associate a newly verified passkey with the
   existing account; there is no automated recovery tool, and the lost private
   passkey cannot be reconstructed. Record and review any such recovery, revoke
   lost credentials and sessions, and preserve tenant/connection ownership.
2. Select one genuine new source UUID, then freeze its source/operation generation,
   exact timestamp and projected station/contact fields. Preserve its actual
   source grid (4/6/8 characters); exercise fractional time and eight-character
   precision when naturally present in the selected contact.
3. Name the exact QRZ book or LoTW account, with the relevant station/certificate
   and date coverage. Set both the contact and destination allowlists to the
   reviewed scope. The destination allowlist must exclude LoTW during the first
   QRZ trial; absent or empty scope grants no write permission.
4. Review fresh absence or existing association evidence, identity reservations,
   source context, quiet period, credentials and all unresolved attempts. Require
   a current immutable source proof for the complete selected QSO/base/live-event
   set after the final canonical drain; cached destination absence and a completed
   cursor alone are insufficient. Confirm
   the selected contact has no ambiguity, location mismatch or competing owner.
5. Show the expected QRZ record/narrative and LoTW signed station fields, the exact
   UUID and destination scope, and the stop conditions. Keep the packet read-only
   until the owner changes the current keep-disabled instruction. A test callsign
   is excluded by Ferry and is not a bypass.
6. Only after that instruction changes and all prerequisites are met, enable the
   newly approved scope. Record QRZ receipt
   and exact readback. For LoTW, distinguish upload acknowledgment (**submitted**)
   from exact later readback (**observed**); QSL confirmation is independent.
   Capture deployed signing/resource measurements without logging credentials or
   raw signed payloads.
7. Close the export gates after the bounded trial and review the results before
   expanding coverage. On an uncertain result, use readback and preserve the claim;
   do not resend blindly. Source edits cancel only unsent work and require renewed
   review if they change the approved content.

QRZ replacement and old-record deletion remain separately gated. They do not have
to be enabled to prove a first insert. A first successful contact also does not
prove replacement, cleanup, restore or arbitrary station/mode coverage.

## Gates and later expansion

Enablement requires all of `EXPORTS_ENABLED=true`, `ROLLOUT_CHECKS_PASSED=true`,
`SOURCE_BOUNDARY_VERIFIED=true`, the exact authorization value documented in
[operations](operations.md), and nonempty `ROLLOUT_QSO_IDS_JSON` and
`ROLLOUT_DESTINATION_IDS_JSON` scopes. None of
these values is evidence by itself. The guarded deployment task deliberately
refuses open gates; current readiness deployments use it unchanged.

After the bounded trial, review the accepted outcomes and historical associations
before authorizing broader automatic coverage. Exercise restore quarantine and
credential revocation, check real browser/passkey behavior, and measure cost and
queue age. Continue the [capacity plan](capacity-plan.md) before promising
100-account daily volume or 200,000-contact initial imports. Account/source
admission fixtures and isolated query benchmarks do not establish that capacity.

The production origin/RP remains `https://ferry.n1rwj.com` / `ferry.n1rwj.com`;
staging is intentionally undeployed. Existing enrollment needs no repeat signup,
new hostname, database or email provider. See [operations](operations.md) for
resource IDs and protected backup details, [roadmap](../ROADMAP.md) for work order,
and [progress](../PROGRESS.md) for implementation checkpoints.

## Reproduce local evidence

`mise run setup`, `mise run check` and `mise run demo` require no live vendor
credentials. `mise run vendor-readonly -- PERSONA_NAME` uses existing OS-keychain
credentials only when deliberately invoked and emits fixed boolean/count metadata.
See [live read evidence](evidence-live-readonly.md), [LoFi evidence](evidence-lofi.md),
[QRZ evidence](evidence-qrz.md), [signing evidence](evidence-signing.md) and
[auth evidence](evidence-auth.md) for primary references, tests and their limits.
