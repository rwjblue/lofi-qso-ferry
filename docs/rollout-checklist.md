# Personal rollout acceptance

Ferry is suitable for an invite-only, read-only pilot with one or two users.
Automatic exports are still disabled. A small first-export trial requires source
boundary evidence and exact contact review; finishing the 200,000-contact capacity
plan is a separate expansion milestone. No real logbook entry has been inserted,
replaced, deleted or uploaded during this implementation work.

## Current evidence (2026-10-23)

The owner has enrolled and linked LoFi, QRZ and LoTW. Signed source
`a8b592bead90a22e4e7fe36f005e390727002df9` deployed read-only as Worker
`fd752a85-83e5-4afd-810c-1f4a2c4e3633` at 22:42 UTC. All **606 tests** and required
checks passed locally; [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40034841991) also passed.
Live checks at 22:43 UTC confirmed twenty-three migrations, healthy service,
matching assets and all five gates closed. There are 370 LoTW identity claims
with zero uncovered mappings; attempts, cutovers and legacy holds remain zero.
The settled 22:47 UTC audit found 378 claims and still zero uncovered mappings
after eight more adoptions. The run retained 70 QRZ rejected-read route failures
and four budget-deferred routes; diagnose these and require successful fresh reads
for the selected trial contacts. This is not a cleared backlog.
Migration `0024` also closes the old-Worker deployment overlap found after the
initial identity migration. See [deployment evidence](deployment.md).

The read-only D1 snapshot at **21:53:13 UTC** contains zero export attempts and
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
| Source boundary           | Local replay, tombstone and cutover guards are implemented. Exhaustive UUID/tombstone coverage and the live replay/retention contract are not established. A completed cursor alone is insufficient.                                                                                                                 |
| Outbound identities       | Durable whole-second claims now protect preparation, adoption and dispatch. Race, rollback, migration, uncertainty, expiry and source-change tests pass. Deployed ownership and closed gates are independently verified.                                                                                             |
| LoTW station location     | Lossless per-contact 4/6/8-character signing is implemented with released TQSL evidence and independent fixed-vector coverage. Historical lower-precision associations and live ARRL acceptance remain unproved.                                                                                                     |
| First vendor writes       | No first-write trial is authorized or performed. Prepare exact source UUIDs, destination identities, projected fields and expected readback before requesting it.                                                                                                                                                    |

## Finish reconciliation and review exceptions

Keep all five export gates closed while doing this work. Preserve cursors, source
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
connection. The 22:19 UTC audit confirms both destination rescans complete and no missing births or unavailable current payloads. Two contacts still reference deleted operations. Keep those contacts held. The source gate is global and applies even to an exact-UUID trial.
A naturally whole-second contact does not waive it. Never alter a source timestamp
merely to bypass a safety check.

The later [independent comparison and live replay](evidence-lofi.md#observed-local-and-live-comparisons)
found every local HaLo UUID in Ferry and matched two ordinary tombstones across
two complete operation reads. Thirteen additional Ferry contacts are absent from
the local database and its QSO backups; their cause is unresolved. Purged records,
event replay, forward-only changes, cursor aging and server retention still need
evidence. No deletion or source repair was inferred from the local difference.

## First-export trial packet

Prepare this restricted packet before asking for live-write authorization. Keep
private contact details out of repository documentation.

The [read-only trial audit](../scripts/export-trial-audit.ts) accepts one explicit
contact, current revision/generation and normal projected destination identities.
It checks source/context/credential freshness, quiet period, ledger bindings,
unresolved attempts and identity ownership using a SELECT. It always reports
`writesAuthorized: false`; it neither signs nor stages a delivery. In the 23:34 UTC
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
   exact timestamp and projected station/contact fields. Prefer a normal contact
   that exercises fractional time and the actual eight-character station grid.
3. Name every routed destination: the exact QRZ book and LoTW account, with the
   relevant station/certificate and date coverage. The existing UUID allowlist
   applies across **all routed destinations**; it is not a destination allowlist.
   A QRZ-only trial needs an explicitly reviewed route/connection plan first.
4. Review fresh absence or existing association evidence, identity reservations,
   source context, quiet period, credentials and all unresolved attempts. Confirm
   the selected contact has no ambiguity, location mismatch or competing owner.
5. Show the expected QRZ record/narrative and LoTW signed station fields, the exact
   UUID scope, and the stop conditions. Obtain explicit permission for those real
   destination writes. A test callsign is excluded by Ferry and is not a bypass.
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
[operations](operations.md), and a nonempty `ROLLOUT_QSO_IDS_JSON` scope. None of
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
