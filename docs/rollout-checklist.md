# Personal rollout acceptance

Ferry is suitable for an invite-only, read-only pilot with one or two users.
Automatic exports are still disabled. A small first-export trial requires source
boundary evidence and exact contact review; finishing the 200,000-contact capacity
plan is a separate expansion milestone. No real logbook entry has been inserted,
replaced, deleted or uploaded during this implementation work.

## Current evidence (2026-10-24 UTC)

The owner has enrolled and linked LoFi, QRZ and LoTW.
Signed revision `3d7b0cac782af45bcd6684129f77da4cd8f159e2` deployed read-only
at 04:13:24 UTC as Worker `4a8c5a8b-8eb1-4569-b0b5-33a7acd2a043`, at 100% traffic.
All **1,098 tests** and required checks passed in [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40060259245).
Independent 04:18:07–04:18:08 checks confirm healthy service, matching assets,
all six export gates closed, 28 migrations, 380 LoTW identity claims and zero
uncovered mappings, attempts, cutovers or stage/history guards. At 04:18:08 the
all-client policy remained in backfill with all 218 operations and 800 QSO-stream
records in the current epoch, no ready policy and zero eligible exports.
Fresh-positive proof building blocks are deployed; mandatory preparation/dispatch
binding and scheduler integration remain in progress.

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

| Readiness item            | Evidence and remaining work                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts and connections  | Owner enrollment and all three connections are complete. One active passkey is registered; a second key is recommended, not an export gate. The protected local key backup exists and its encryption key decrypted current credentials for the scoped audits. Off-device secret-manager storage remains unconfirmed.                      |
| Reconciliation throughput | Batched intake, guarded classification, shared history, indexed retries, account admission, context index and QRZ Unicode decoding are deployed. Sustained capacity and remaining vendor errors still need measurement.                                                                                                                   |
| Source boundary           | Two complete inventories match Ferry, and a 20-target all-client forward sample matches. Versioned baseline/runtime guards are deployed; the first policy is in backfill, with handoff still pending. Continuous coverage, purge exclusion and fresh positive source/context enforcement remain open. A completed cursor is insufficient. |
| Outbound identities       | Durable whole-second claims now protect preparation, adoption and dispatch. Race, rollback, migration, uncertainty, expiry and source-change tests pass. Deployed ownership and closed gates are independently verified.                                                                                                                  |
| LoTW station location     | Lossless per-contact 4/6/8-character signing is implemented with released TQSL evidence and independent fixed-vector coverage. Historical lower-precision associations and live ARRL acceptance remain unproved.                                                                                                                          |
| First vendor writes       | The owner authorized one or two contacts, QRZ first and LoTW afterward, with a database backup before external changes. No write has occurred. Exact source/destination selection, current evidence and normal delivery prerequisites remain required.                                                                                    |

## Finish reconciliation and review exceptions

Keep all six export gates closed while doing this work. Preserve cursors, source
birth evidence, current context and destination reservations; clearing counts or
forcing a contact into an eligible state is not reconciliation.

| Outcome                                                       | Next action                                                                                                                             | Can scheduled work resolve it?                                         |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Inventory/context pending                                     | Let bounded reads finish; diagnose persistent vendor failures and expired or missing dependencies.                                      | Yes, when the dependency is obtainable and retries succeed.            |
| QRZ minute-only or nonunique identity                         | Compare the specific source and remote records; establish an explicit association policy with adequate evidence.                        | No; another unchanged read cannot supply missing precision.            |
| LoTW six-character history versus eight-character source grid | Review the actual station location and association. Full-grid outbound support does not retroactively establish historical equivalence. | No automatic adoption or grid truncation.                              |
| Other location mismatch                                       | Compare exact station fields and authoritative source context. Keep the hold until the discrepancy is understood.                       | Only a meaningful source/remote correction can change the evidence.    |
| Missing or ambiguous route                                    | Select the intended station/book/account coverage.                                                                                      | No; the scheduler cannot invent destination coverage.                  |
| Test or invalid contact                                       | Tests stay excluded; correct an invalid real source record through its normal source application.                                       | Test exclusion is intentional. Invalid source data needs a correction. |

A narrow first-export trial does not require approving every historical exception.
Its selected contacts must have complete current context, unambiguous routing,
valid certificate/location/mode fields, durable identity ownership and fresh
remote checks. Other held contacts remain outside the trial. General automatic
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
It grants no export authority. Mandatory proof binding at both boundaries and
scheduler integration remain in progress. The diagnostic observations and signed
guards do not open the global source gate or authorize a trial before those prerequisites.

## First-export trial packet

The owner has authorized a one- or two-contact trial with QRZ first, followed by
LoTW. Prepare this restricted packet and satisfy the evidence prerequisites before
executing that scope. Keep private contact details out of repository documentation.

A refreshed protected production SQL backup completed at **03:50:46 UTC on
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
1. Record the signed deployed revision, closed-gate readback and completed source
   boundary evidence. Verify access to the existing production encryption-key
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
   source context, quiet period, credentials and all unresolved attempts. Confirm
   the selected contact has no ambiguity, location mismatch or competing owner.
5. Show the expected QRZ record/narrative and LoTW signed station fields, the exact
   UUID and destination scope, and the stop conditions. Use the owner's existing
   one- or two-contact authorization only within that scope. A test callsign is
   excluded by Ferry and is not a bypass.
6. Enable only the approved scope after prerequisites are met. Record QRZ receipt
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
