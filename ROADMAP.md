# Implementation roadmap

This roadmap is the handoff for implementation in this repository. Checked items have implementation and local evidence. Unchecked items retain external verification or rollout work; they must not be inferred from synthetic success. The owner authorized small signed commits directly to `origin/main` for implementation; no implementation PRs are opened. Retain the product decisions in [README](README.md). Each milestone should update its evidence and remaining questions here.

## Next milestones (2026-10-24 UTC)

The separate, default-disabled QRZ first-insert capability is deployed. It retains
mandatory source proofs while excluding source-wide cutovers, no-query inference,
LoTW, replacement and corrections. It remains disabled. The policy-aware review
audit and bounded 100-record baseline pages are deployed in `02e3dc89b99a`.
Production baseline/handoff completed at 06:35:44.881 UTC. The live source-proof
mint failure and sustained capacity remain outstanding. Fresh QRZ absence was
observed for one candidate at 07:38:44; joint source/vendor readiness remains open.

Signed revision `02e3dc89b99a5d7428c01b6a09596a105784eb11` deployed read-only
at 06:09:06 UTC as Worker `da7b7b70-6b7e-4cab-b9f6-f4b88f38390d`, at 100% traffic.
All **1,178 tests** and required checks passed in [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40068069314).
Independent 06:09:17–18 checks confirm healthy service, matching hashes for all
three assets and all seven export controls closed. Health reports no active
export mode and `sourceBoundaryVerified:false`. All 30 migrations through `0031`
are applied. The 380 LoTW identity claims have no uncovered mappings; attempts,
cutovers, proofs, pins and temporary guards were zero at release verification.
All 4,500 source bodies had incarnations, and 2,155 positive observations had no
future or partial metadata.
The production baseline, forward drain and quarantine handoff completed at
**06:35:44.881 UTC**. The policy is `ready`: all 218 operations and 4,282 QSO-stream
records—4,500 retained rows—are members of the current epoch, with zero unseen
retained rows. The 4,130 eligible contacts are eligible for reconciliation
processing, not authorized exports.

The 06:35:43–06:36:10 run resumed normal reconciliation: 62 contact turns and
60 destination classifications in 27.187 seconds, with four errors and 50
deferrals before the `database_budget` stop. It made 871 D1 calls containing
2,179 statements; database wall time was 24.125 seconds. These are processing
turns and classifications, not unique completed contacts or sustained capacity.

Fresh selected-contact source proof remains unverified. The 06:43 and 06:54
protected diagnostics collected current dependencies and completed a final drain,
then rolled back at `proof_cohort_count`. Exact post-rollback predicates passed;
measured local/D1 clock differences are a hypothesis, not a confirmed production
cause. A later read stopped at the collector's 25-record response ceiling.
The prepared fix requests 25 records but accepts bounded timestamp groups up to
100 per stream, with whole-page validation and unchanged proof/request limits.
Its initial commit is signed and pushed; the final refinement is committed locally
and awaiting 1Password signing. All **1,184 tests** and required local checks pass.
Neither collector change is deployed yet.

At **07:38:44 UTC**, a fresh QRZ check established an empty neighborhood for one
eligible candidate using one targeted FETCH, one STATUS book verification and one
complete covering FETCH. Exact local scope and dependencies remained stable.
This is current observed absence for that contact, not a source proof or permission
to insert. Repeat fresh QRZ checks alongside the same contact's successful source
proof before any later authorized write. The earlier 06:55 candidate had a nearby
record and remains unsuitable for absence-based insertion. All seven export
controls remain closed; attempts, stage guards, cutovers and vendor mutations
remain zero. The owner's keep-disabled instruction still applies.

The initial larger-page runs preserved the saved cursor and existing request
limits. Their variable page counts and D1 latency are recorded in the
[capacity measurements](docs/capacity-plan.md#bounded-100-record-baseline-follow-up-deployed-0609-utc).
Baseline completion does not establish sustained capacity, global purge retention
or permission to create cutovers.

At 04:51:11 UTC, current membership covered 218 operations and 1,425 QSO-stream
records, still in backfill with zero ready sources or eligible exports. QRZ had
36 complete and one pending partition, but no retained covering plan; the earlier
98-record cover expired at 04:00:56. Its ledger retained 3,435 ambiguous and 398
pending rows. Attempts, cutovers and temporary guards were zero. Partition expiry
can reduce counts without resolving a gap; the trial needs fresh coverage.
At approximately 04:58 UTC the one pending partition was an expired, empty base
manifest awaiting cleanup or rebuilding. The count of complete partitions was
not independently verified for freshness.

At 02:52:53 UTC, QRZ had 35 complete and five pending history partitions, with
the same single completed 98-record cover and zero target records. Its ledger
had 3,438 ambiguous and 395 pending rows, with zero attempts, cutovers or temporary
guards. These counts describe reconciliation evidence, not completed deliveries.

Completed throughput work includes batched intake and guarded reconciliation,
shared history across dates, indexed retries, independent background account/source
turns, precise diagnostics, the context/event index, and QRZ Unicode compatibility.
The first 21:29-release run processed **117 contact turns and 166 destination
classifications**, with no entity-decoding errors recorded. It still reached the
deadline, with twenty other errors, 86.934 seconds of database wait and 1.12 million
reported rows read. The local context-index fixture improves 4,003→3 rows, but
production scan attribution and sustained throughput remain unproven. The
[capacity plan](docs/capacity-plan.md) records measurements and acceptance targets.

The 100-account fixture proves background admission order, including restarts;
it does not prove full live/vendor fairness or 200,000-contact import capacity.
Timestamp/grid precision, routing and source-validity holds still require review.

Core feature paths, owner enrollment and service linking are implemented. The next milestone is a safe one- or two-user export trial; the full large-scale capacity plan follows separately. Production remains read-only. Linking credentials and waiting for cron do not establish export readiness. See the [personal acceptance checklist](docs/rollout-checklist.md) for exact prerequisites and the first-write packet.
Durable outbound identity claims, bounded legacy QRZ binding, lossless eight-character LoTW signing and the aggregate source audit are implemented, tested and deployed. Claims protect adoption, preparation and dispatch across cancellation, uncertainty, source edits and payload expiry. Historical precision holds and live vendor acceptance remain separate.
1. **Finish current per-contact source verification.** The production baseline,
   forward drain and quarantine handoff are complete: all 4,500 retained rows
   were witnessed, with 4,130 contacts eligible for reconciliation. The immutable
   proof mint still fails its atomic guard. Preserve that guard while testing the
   measured clock-admission hypothesis. Deploy the reviewed timestamp-expansion
   collector fix after final signing and checks, then repeat the exact dependency
   collection and final drain. No current proof has been established by these
   diagnostics. See the [dated source evidence](docs/evidence-lofi.md).
   Full-account purge, retention and replay guarantees remain unproved; keep
   `SOURCE_BOUNDARY_VERIFIED=false`.
2. **Authority separation implemented and deployed.** The independent
   `QRZ_FRESH_INSERTS_ENABLED` mode is off by default and limited to a first INSERT.
   It pins its authorization mode immutably and rechecks exact scope, current
   source proof, first-insert history and the final request after vendor admission.
   It cannot grant source-wide cutovers, no-query inference, LoTW, replacements or
   corrections. Keep `SOURCE_BOUNDARY_VERIFIED=false`; universal UUID, tombstone
   and purge guarantees remain unproved. This completes the permission split,
   not successful live proof minting or vendor acceptance.
3. **Pair observed QRZ absence with a current source proof.** The 07:38:44
   production diagnostic completed targeted, book-verification and covering reads
   and found an empty neighborhood for one eligible contact. This verifies the
   deployed fresh fallback for that observation; cached metadata only selected
   where to read. Recheck the same exact contact after successful source proof
   collection and before any future authorized write. Minute-only history,
   ambiguous associations and lower-precision locations remain review holds.
4. **Prepare a trial packet; do not execute it under the current instruction.**
   The latest instruction to keep exports disabled supersedes the earlier one-
   or two-contact trial authorization. No actual trial may run until the owner
   changes that instruction and the remaining evidence checks pass.
   The proposed sequence remains QRZ first, then LoTW. Both contact and destination allowlists must be
   exact, so LoTW remains excluded during QRZ work. A fresh protected production
   SQL backup was verified at 07:56 UTC: isolated restore with all 30 installed
   migrations and no pending migration, integrity/foreign-key checks, three credential
   decryptions and repeated quarantine passed, preserving 380 claims and zero
   attempts/cutovers/proofs. Preserve its evidence and
   refresh it if needed before external changes. Earlier restore rehearsals
   remain recorded in the deployment history. Preserve each contact's
   actual 4/6/8-character grid. No
   source or vendor write has occurred. Record exact readback and deployed
   signing evidence, close gates after the trial, and review before expansion.
   Replacement and old-record deletion can remain disabled. A second passkey is
   recommended, not an owner-pilot gate; manual operator recovery is documented.
5. **Expand automatic coverage and prove capacity.** Source policy and fresh
   positive evidence must protect main exports, not only the trial. Then review
   historical associations and broaden the scopes deliberately. Measure queue
   age, cost, vendor fairness and complete import throughput before promising
   100-account daily volume or 200,000-contact imports. The audit's 200-row pages
   are not a runtime intake throughput measurement.

The new throughput implementation reduces the measured intake/context database calls from 32→7, 33→9, 56→7 and 102→5 across the four local fixtures. Indexed selection returns 100 contacts using 200 rows read at both 4,000 and 200,000 contacts (7.68/7.63 ms locally). These validate database work bounds, not an end-to-end service rate. Read-only background processing uses batches of 20. The deployed mandatory-proof path can select up to six live contacts for shared evidence while dispatch remains sequential; background preparation shares two attempt slots. A source cohort has at most four actual source requests including the final drain. Complete witnessed subsets can proceed, and prior budget holds receive a later singleton turn. An unsuccessful budget-limited singleton receives an exact-version ten-minute delay, yielding to neighbors on the ordinary five-minute schedule; a single dependency closure requiring more than three collection reads remains held. The scheduler still yields at a 90-second or 850-D1-call soft budget. See the [implementation status and measurements](docs/reconciliation-investigation.md#implementation-status).

The previous release at 15:04:09 UTC contains signed commits `32758f5` (general-log station projection and scoped retry migration), `789d652` (precision-specific review holds), and `fa822ba` (cleanup query scaling). Local checks passed 391 tests plus 35 focused tests after the final diagnostic refinement. All 392 tests and required checks passed in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39974178346), and revision `cf34ac0` was deployed with all gates closed. Those release results predate the throughput release. The new release `bbc2346c` passed all 452 tests and required checks in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39983716440) and deployed at 16:12 UTC as Worker `c592733f-171f-406e-bb8d-827b7ffd7fd9`; all gates remain closed.

The first run after that previous release, at 15:05:50 UTC, completed in 96,730 ms versus 132,572 ms for the preceding run, with zero errors and deferrals. It still examined only two contacts. The 15:08:05 snapshot recorded 1,820 ready, 2,314 held and zero blocked, with the callsign input requeued and the new precision diagnoses appearing as review holds. Attempts and cutovers remained zero. This is the production baseline before batching and shared inventory, not their measured result.

The 2026-10-23 follow-up found 10 QRZ ambiguities and eight current LoTW grid mismatches. Three QRZ samples had a single otherwise matching identity with minute-only time; two LoTW samples had the matching six-character prefix of an eight-character source grid. These samples identify compatibility patterns, not proof for every held record. The general-log station field is present as canonical `our.call`; deployed correction `32758f5` fixes that parser compatibility defect without a user edit. Four other contacts use stations outside the personal routes and one uses a test suffix; cron cannot invent appropriate destination coverage. Exact contact details remain outside repository documentation.

The five runs from 14:05 through 14:25 UTC examined two contacts each in 128.8–140.7 seconds. Context rereads progressed to 134 of 176 by 14:38, with both rescans unfinished. The [capacity investigation](docs/reconciliation-investigation.md) separates contact turns from unique completed classifications, records the seven-day source-payload retention risk, and prioritizes a measured cleanup defect, batched database access, stable exception scheduling and shared inventory. Exports remain disabled throughout this work.

The initial repair `1679f749` passed 371 tests in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39963134190). All 12 retained contacts sampled from generic reconciliation failures projected successfully and contained nonzero milliseconds; strict outbound ADIF conversion rejected them before vendor reads. Read-only conversion now follows PoLo/HaLo whole-second truncation while preserving raw timestamps and fingerprints. At that checkpoint fractional-timestamp writes were blocked with `subsecond_export_requires_identity_claim`; the later durable-claim implementation replaces that blanket restriction while retaining all rollout gates. Renewed LoFi bearer persistence and scheduler error classification are also repaired; the persistence defect's contribution to the earlier backlog remains unconfirmed. Independent D1 metadata at 13:41:45 UTC verified fourteen migrations, zero attempts and zero cutovers.

Post-deployment observation found historical reads consuming a scheduler turn before contact processing and known context holds being selected ahead of available work. The scheduling follow-up keeps canonical sync first, processes a retained background contact before historical rescan/reread work, and prefers available base context without relaxing complete-context or export checks. In a read-only pre-deployment experiment, available base contexts among the first ten selections improved from two to ten, with zero writes. All 377 tests and required checks passed locally and in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39965786804). The 14:00:46 UTC production run completed in 132,058 ms with one source page, one contact processing turn, zero errors and zero deferrals. This confirms limited recovery for one run, not a sustained draining rate.

The 14:04:02 UTC snapshot still has 4,134 source contacts and 264 old generic readback-reason rows per destination awaiting revisit, plus a prior QRZ retry-error row. Actual vendor reads now produce actionable diagnostics: QRZ has no unique exact identity matching its time precision/mode evidence, and LoTW reports a differing or absent `MY_GRIDSQUARE`. Review these outcomes before treating history as adopted or absent. Fourteen migrations, zero attempts and zero cutovers remain verified.

Adoption collision quarantine is implemented and tested: when two source contacts claim the same remote identity, both an untransmitted adopted owner and the contender become `history_ambiguous`, the existing reservation remains, and a later edit cannot auto-export either contact. That quarantine change alone did not make fractional-timestamp writes eligible; the later guarded outbound-claim path supplies the missing ownership protection.

The [workload investigation](docs/admin-workload-investigation.md) separates readback defects from source dependencies. At 13:23 UTC, read-only classification found 1,423 ready-for-processing records, 2,704 held for operation context, five held for routing, one held for history review and one blocked by callsign validation. Context rereads share the existing LoFi allowance of four background requests per five minutes; more elapsed time or a completed operation-list scan does not mean every operation's contacts/events have been read. Those time-specific counts do not authorize uploads or establish a completion estimate.

See [current progress](PROGRESS.md) for the resumable checkpoint and the [rollout checklist](docs/rollout-checklist.md) for the evidence and authorization required to open the gates.

## Delivery order

| Milestone                       | Depends on                               | Result                                                           |
| ------------------------------- | ---------------------------------------- | ---------------------------------------------------------------- |
| 0. Protocol/runtime spikes      | None                                     | Evidence for source, destination, signing, and passkey contracts |
| 1. Worker and durable state     | Enough spike evidence to fix boundaries  | Tenant-scoped storage, encryption, leases, fixture harness       |
| 2. Accounts and connections     | 1; relevant authentication/import spikes | Email-confirmed passkey signup and verified service connections  |
| 3. Source intake and projection | 1; LoFi spike                            | Correct, resumable contact/operation changes and station context |
| 4. Historical adoption          | 2–3; destination readback spikes         | Existing history linked without remote writes                    |
| 5. Live QRZ delivery            | 4; QRZ mutation spike                    | Delayed automatic insert/correction and forward-only templates   |
| 6. Live LoTW delivery           | 4; signing/query spikes                  | Worker-signed uploads with honest acceptance status              |
| 7. Personal rollout and handoff | 5–6                                      | Small production deployment with documented recovery and cost    |

Milestone 0's investigations can run independently. QRZ and LoTW delivery can be implemented in parallel once their shared ledger and bootstrap contracts are stable. A destination outage must not become a dependency for the other destination's ongoing operation.

## 0. Prove the uncertain contracts

### 0A. LoFi changes, pagination, and effective context

- [x] Adapt the known [qso-sidecar](https://github.com/rwjblue/qso-sidecar/blob/c502cecd068a6a4330afd94458e5636fa17f3a51/src/lofi.rs) and [HaLo LoFi](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/extensions/sync/ham2k-lofi/src/index.ts) protocol behavior into a small typed client/spike. Do not copy Sidecar's contest assumptions.
- [x] Implement `/v1/sync` from the inspected client contract, independent operation/QSO checkpoints, explicit page completion and same-identity permission renewal. Record bounded live cursor/resumption and operation-read evidence.
- [ ] Establish exhaustive historical-edit/tombstone replay and cursor-retention/expiration guarantees. Treat a snapshot/replay boundary as unproven until demonstrated.
- [x] Fixture-test null-operation general-log contacts and bounded encrypted buffering when current context is available.
- [ ] Verify live null-operation behavior and whether selective reread is available; retain visible recovery exceptions when buffered data expires.
- [x] Capture synthetic fixtures for operation and segment corrections, same-time boundaries, own/worked POTA refs, multiple station callsigns, explicit clearing values, and raw frequency units.

**Acceptance:** a paged import and later catch-up do not lose or duplicate work after restart; changing only an operation's location causes affected QSO projections to change. Record unsupported recovery semantics explicitly instead of substituting device timestamps for a server cursor.

### 0B. QRZ readback and mutation semantics

- [x] Implement and fixture-test response/ADIF parsing, pagination, empty/error responses, book identity, and required subscription checks using the [API contract](https://www.qrz.com/docs/logbook/QRZLogbookAPI.html).
- [ ] Prove how `INSERT`, duplicate rejection, `OPTION=REPLACE`, returned LOGIDs, confirmed records, time precision, and portable-location fields behave. Distinguish documented behavior from observed behavior.
- [x] Fixture-test preservation of narrative and writable remote-owned fields during a structured correction, and bounded identity/collision searches. Live field-preservation evidence remains in the mutation check above.
- [x] Implement uncertain-response reconciliation against the exact transmitted projection and specify provenance requirements for old-identity cleanup. No guessed update-by-LOGID primitive.
- [ ] Prove the narrow cleanup contract for a Ferry-created old identity before exposing automatic deletion; retained identities remain visible in the meantime.

**Acceptance:** fixtures distinguish missing, ambiguous, rejected, replaced, and possibly accepted requests; existing text survives the intended update. Any live mutation experiment uses a deliberately designated test logbook/contact and separate authorization, never the owner's existing history by default.

### 0C. Direct LoTW signing and readback

- [x] Build an isolated Worker signing spike with generated keys and representative PKCS#12 fixtures. Compare against [Wavelog's direct signer](https://github.com/wavelog/wavelog/blob/7f8eef4de94c674f73c6859ed4e0b0247f68dcd9/application/controllers/Lotw.php) and native TQSL/reference output where useful.
- [x] Verify key import, legacy/current PKCS#12 encryption, certificate/key matching, callsign/DXCC/QSO-date authorization, canonical station/contact fields, RSA signature bytes, gzip, and multipart encoding.
- [x] Record Worker bundle/startup observations and exercise cryptographic primitives with generated fixtures in actual local workerd.
- [ ] Measure deployed billed CPU/memory for import and representative batches, and prove a real Worker-signed artifact through scoped ARRL acceptance. Local runtime results and published algorithm support do not establish this evidence.
- [x] Exercise [LoTW query parsing](https://lotw.arrl.org/lotw-help/developer-query-qsos-qsls/) with accepted unconfirmed records, own station detail, error HTML, date partitions, and receive-time checkpoints. Distinguish submission acknowledgement from observed processing and QSL confirmation.

**Acceptance:** reproducible synthetic vectors and runtime measurements are checked in without personal keys or logs. Document what still needs a deliberately scoped live ARRL acceptance check. A separate signer host is not the default fallback; report an actual blocker before revising the agreed architecture.

### 0D. Passkeys in Workers and mobile browsers

- [x] Pin reviewed SimpleWebAuthn releases and demonstrate registration/authentication in the Worker runtime with the fixed RP/origin model in [authentication](docs/authentication.md).
- [ ] Exercise discoverable credentials, required user verification, synced passkeys, a backup security key, and the explicit sign-in button. Conditional autofill is progressive enhancement.

**Acceptance:** wrong challenge/origin/RP/user handle, missing UV, replay, and concurrent consumption fail correctly. No OAuth, password, email-login, or email-reset alternative is introduced.

## 1. Establish the Worker and durable state

- [x] Create the minimal TypeScript/Workers project, package scripts, D1 migrations, environment configuration, and test harness. Document local setup and keep preview/prod bindings separate.
- [x] Implement tenant-scoped records for accounts, linked source accounts, stable logical destinations, encrypted credential versions, cursors, ledger rows, template versions, bootstrap partitions, and outbox attempts.
- [x] Keep source baseline, remote observation, transmitted projection hash, creation provenance, narrative policy, and receipt state distinct. Enforce uniqueness across tenant/source/destination identities.
- [x] Implement the [envelope format](docs/security.md), KEK-version rotation, credential revocation, and logging redaction.
- [x] Implement atomic cursor/work checkpoints, guarded job claims, lease fencing, retry scheduling, and immutable uncertain attempts. Choose bounded retention defaults with explicit expiry behavior.

**Acceptance:** crash/restart and overlapping cron invocations cannot skip source work, change an in-flight payload, or issue work for another tenant. A database export has no plaintext private credentials or pending payloads. Rotation and restore preserve mappings and revoked states.

## 2. Add accounts and service connections

- [x] Implement email signup proof, first passkey enrollment, passkey-only login, sessions, additional keys, revocation, and email change exactly as [specified](docs/authentication.md). Production uses native Cloudflare email and `ferry.n1rwj.com` as its fixed RP; the owner has enrolled.
- [x] Make second-passkey/synced-provider recovery guidance visible; losing every usable passkey has no automatic v1 reset path.
- [x] Link a LoFi account through its existing approval flow. Verify account ownership and show which source account is connected.
- [x] Link QRZ book keys and validate station callsign/date routing. Link LoTW signing material and optional query credentials, keeping their purposes separate.
- [x] Require recent passkey verification for sensitive connection changes. Reconnecting or renewing a credential preserves the stable logical destination; a genuinely different account/book does not inherit mappings.

**Acceptance:** the same email confirmation cannot sign into or replace credentials on an existing account. A second tenant cannot reference another tenant's connections or passkeys. No contact export occurs merely because credentials were saved; initial reconciliation determines historical eligibility.

## 3. Build resumable source intake and projection

- [x] Implement separate operation/QSO progress and atomic page checkpoints; recover expired/gapped cursors through reconciliation.
- [x] Normalize contact identity, tombstones, timestamp precision, frequency, band/mode, station callsign, and effective location. Retain event context needed for segments while excluding event rows from exports.
- [x] Coalesce destination-relevant changes per contact. Set the default quiet period to 30 minutes and poll every five minutes; expose a 20–60-minute setting.
- [x] Preserve temporary source/context data only where necessary for delayed delivery or reread limitations. An operation edit can trigger a bounded reread; a template edit cannot.
- [x] Batch source-page metadata/checkpoint access and share operation/event ciphertext reads within a bounded contact batch; validate atomic rollback and complete projection locally.
- [x] Implement immutable short-lived source proofs, mandatory staging/dispatch pins and post-admission validation. The release is deployed with 1,131 tests passing. Production baseline/handoff is complete; live proof minting still fails `proof_cohort_count`, and scoped vendor acceptance remains outstanding.
- [x] Separate default-off QRZ first-insert authority from global source-boundary effects, with immutable mode pins, structural history guards and final exact-request validation. Deployed with all seven controls closed; live acceptance remains outstanding.
- [x] Verify bounded 100-record canonical baseline pages in production, including saved-cursor continuation and completed baseline/drain/quarantine handoff. Noncanonical and handoff page sizes remain unchanged.
- [ ] Measure sustained source throughput and reduce redundant passes where the source contract permits; baseline completion is not capacity acceptance.

**Acceptance:** ongoing logging does not postpone earlier stable contacts. Offline arrivals and old-contact corrections work. Location/park changes at segment boundaries affect the correct contacts; changes to unsupported LoTW narrative fields create no LoTW work.

## 4. Adopt existing history without rewriting it

- [x] Implement [bootstrap states and matching](docs/bootstrap.md) separately for QRZ and LoTW. Inventory accepted unconfirmed contacts as well as confirmed ones.
- [x] Match conservatively by verified identity and operational context. Preserve timestamp precision; isolate collisions, missing location evidence, and unsupported mode mappings.
- [x] Adopt unique existing records with a captured source baseline and remote observation, without a fabricated delivery receipt. Preserve trusted Ferry mappings on reconnect and QRZ remote narrative on first adoption.
- [x] Establish source intake before scanning, catch up races, and recheck absence before first backfill. Use bounded encrypted temporary partitions and remove them after durable progress.
- [x] Without LoTW read access, leave prior history unverified and permit only live records proven new after the source cutover. Expose incomplete coverage rather than treating it as absence.
- [x] Match read-only historical identities at the same whole-second precision as PoLo/HaLo while preserving raw source milliseconds and fingerprints. Keep outbound preparation stricter than historical lookup.
- [x] Implement and test adoption collision quarantine for both the untransmitted adopted owner and contender, preserving the identity reservation and blocking later edit exports.
- [x] Implement indexed due-work selection and versioned destination checks. Stable review holds retry after 24 hours and incomplete reconciliation checks after five minutes; ambiguous-empty QRZ partitions share a separate fifteen-minute read cooldown. Relevant source/context/route/credential/policy changes invalidate the affected checks. Retention-only refreshes preserve holds.
- [x] Implement shared encrypted four-hour history partitions with QRZ base/catch-up paging, LoTW date-range splitting, scoped/fenced commits and bounded local candidate lookup. Cached absence does not authorize export; a fresh targeted prewrite check remains required.
- [ ] Wake previously held contacts when their relevant inventory completes; the current timed retry backstops remain in place. Add durable queue continuations and prove fair, resumable end-to-end capacity at 4,000 and 200,000 contacts.
- [x] Implement durable outbound identity claims for contacts whose distinct source timestamps truncate to the same destination second, for both QRZ and LoTW. Atomic claims cover adoption, preparation and dispatch and survive uncertainty, cancellation, source edits and payload expiry. Fractional projection is available only through the guarded attempt path; source completeness and all export gates still apply.
- [x] Preserve supported eight-character station grids in LoTW signing without truncation, with pinned released TQSL evidence and an independent fixed signature vector. Live ARRL acceptance remains open.

**Acceptance:** a representative source log already uploaded to both services produces zero INSERT, REPLACE, DELETE, or signing operations during adoption and unchanged subsequent polls. A contact absent at just one destination queues only there. Failed/partial inventories never authorize backfill. Two source UUIDs cannot silently adopt one remote record.

## 5. Deliver to QRZ and support forward-only templates

- [x] Implement and fixture-test insert/correction with stable book routing, response mapping, fetch/merge preservation and uncertain-result reconciliation. Replacement remains gated on the live contract in milestone 0B.
- [x] Reuse the appropriately licensed HaLo Liquid SDK/helpers or compatible bounded implementation. Preserve notices and avoid importing the separately licensed full exporter without an explicit licensing decision.
- [x] Implement immutable version creation and first-staged-export binding from [templates](docs/templates.md). Keep unbound, template-bound, and remote-preserved policies distinct.
- [x] Include a POTA example using the operator's activated park; enforce resource and length-correct ADIF serialization limits.
- [x] Handle changed identities with durable old/new identity evidence while retaining prior remote records visibly. Source deletions cancel unsent work and record retained remote state.
- [ ] Enable narrow provenance-checked cleanup only after its live contract is proven. Adopted old identities remain intact.

**Acceptance:** changing a template generates no historical scan, invalidation, hash recomputation, or job. In-flight requests and retries keep their pinned version. An actual later source change uses current data with that version. Adopted text survives structured corrections; note-only source edits do not take ownership. Lost responses do not cause blind inserts or deletes.

## 6. Deliver signed contacts to LoTW

- [x] Integrate the proven Worker signer, versioned field/configuration tables, certificate selection, and per-location grouping.
- [x] Persist immutable encrypted signed batches with exact member UUIDs, source generations, and certificate/configuration versions until their outcomes resolve. Commit membership and member attempt states together. One-contact artifacts are acceptable initially; bound batch work and isolate invalid records without resubmitting unrelated history.
- [x] Implement acknowledgement, observed acceptance, retry, and optional confirmation tracking as separate states. Reconcile via readback when configured.
- [x] Apply supported nonidentity corrections and report identity corrections that leave the prior record at LoTW. Surface certificate/award/location restrictions precisely.

**Acceptance:** mixed callsigns/locations use the proper certificate and station data; source-note/template-only changes produce no LoTW submission. An ambiguous timeout is reconciled. A submitted batch is not displayed as per-QSO accepted solely because its upload was acknowledged. Production compatibility claims require actual scoped acceptance evidence.

## 7. Roll out personally and document operations

- [x] Add a compact mobile-friendly dashboard for connection health, history adoption, pending work, submitted/observed states, and exceptions. No manual operation-release step.
- [ ] Run a read-only reconciliation against the owner's history and review aggregate results and exceptions before enabling the service's first production writes. This is rollout verification, not the recurring logging workflow.
- [ ] Enable a small, identifiable set of new contacts, verify both destinations, then expand normal automatic coverage. Record the deployed revision and contract evidence.
- [x] Document deployment, certificate renewal, key rotation, passkey management, source cursor gaps, uncertain requests, backup restore, disabling connections, retention, and vendor throttling.
- [ ] Measure representative monthly Worker/D1/email usage; document actual cost and tune batching/polling without weakening correctness.
- [x] Verify a second isolated tenant with synthetic fixtures before enabling additional people.
- [x] Record scheduler stage durations, D1 RPC/SQL counts, classified destinations and inventory fetch/cache use; add reproducible local 4,000/200,000-contact indexed-selection measurements.
- [x] Deploy the throughput implementation with every export gate closed and verify the deployed settings, health, assets and zero export attempts.
- [ ] Verify sustained production drain rate, context progress, live fairness, retry behavior and resource use. Local selection and 20-contact integration fixtures do not establish the proposed capacity targets.

**Acceptance:** ordinary PoLo/HaLo logging reaches both configured destinations after settling without additional user actions. Existing history and comments remain intact. Failed jobs remain visible and retry safely; revocation stops new work. Operational instructions and measured limitations let another local agent continue without reconstructing this conversation.

## Decisions to record during implementation

Keep unresolved items attached to their milestone: verified LoFi replay boundaries and null-operation rereads; QRZ replacement/collision and field-preservation semantics; deployed signing measurements and ARRL acceptance; LoTW station/mode configuration provenance; measured retention/batch capacity and cost. The native email provider, production hostname and initial one-contact LoTW artifact size are selected. These are implementation evidence requirements, not reasons to reopen the settled live-sync, forward-only-template, passkey-login, minimal-storage, or hosted-signer product choices.

## Current acceptance boundary (2026-10-23)

Core service paths across all eight areas have executable code, fixtures and
actual workerd/D1 coverage. Durable outbound identity claims for fractional
timestamps and lossless eight-character LoTW grids are implemented and tested. The
dashboard has been exercised in Chromium at desktop and 390px mobile widths with
a virtual passkey. Production exports remain disabled. No live INSERT, REPLACE,
DELETE or LoTW upload occurred.

The historical shared-history cohort release `bca137b1a38ceb7ab0601e1db53136d69cce9c9c`
(application code `b23e563a4104bd16b8bb9ce0cd6d356ddfad9d3f`) deployed as Worker
`1f481a97-7e78-443a-a180-ea488822f78b` at `2026-10-23T19:45:29.359227Z`.
All 512 tests and required checks passed locally; [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40013802909)
passed all 512 tests and required checks. At that checkpoint, live version and health checks confirmed 100% traffic and all five
gates closed. The 19:45:46 UTC D1 snapshot recorded nineteen migrations, zero
attempts, zero cutovers and no temporary guard residue. The first new run,
19:45:43–19:47:15 UTC, processed 80 contact turns and 121 destination
classifications in 92.209 seconds, including five adoptions, 39 errors and three
deferrals. It used 384 RPCs (4.8 per turn), compared with 862 RPCs for 40 turns
in the preceding run. This is one mixed-work observation, not unique completion
counts or sustained capacity. It recorded 121 inventory cache hits and zero
successful inventory advances; that counter does not exclude failed vendor requests.
Earlier source-lane fairness runs processed 23 and 15 contact turns while
advancing context; they remain evidence for that earlier release. Owner
enrollment and LoFi/QRZ/LoTW linking are complete. Sustained production progress,
complete inventory/source capacity, precision policy and owner-history acceptance
remain outstanding.
No 200,000-contact SLA has been demonstrated.
See [deployment evidence](docs/deployment.md).

Milestone 0 has bounded live read evidence for all three vendors, local signing
vectors and Worker HTTP passkey evidence. Exhaustive source UUID/tombstone replay,
QRZ mutation behavior, ARRL signed acceptance, physical/synced passkeys and
production runtime measurements remain unproved. Milestones 4–6 implement the
conservative gates; their live acceptance depends on that evidence. Prior QRZ
identities remain retained until the narrow cleanup contract is live-proven.

Milestone 7 has a reproducible local demo, dashboard and operational runbooks.
Production is now deployed read-only. Complete owner-history review, scoped first
writes and measured monthly cost remain outstanding under the exact inputs in the
[rollout checklist](docs/rollout-checklist.md). The implementation does not replace
those checks with mock success. See [PROGRESS.md](PROGRESS.md) for the current
resumable checkpoint.

## Implementation checkpoints

- 2026-10-22: Worker/D1 foundation implemented with AES-GCM envelope storage,
  immutable template/attempt records, atomic cursor batches and fenced leases.
  Focused tests execute against actual local D1/workerd and cover stale cursors,
  overlapping claims, tenant boundaries, encryption rotation and crash recovery.
  Adapter and account integration remain in progress. Production exports remain
  disabled. See [PROGRESS.md](PROGRESS.md) for the resumable work log.

- 2026-10-22: Typed read-only LoFi sync and per-contact projection implemented;
  17 fixtures cover restart cursor state, paging failures, segment boundaries,
  explicit clears, tombstones, kHz/MHz and location-only invalidation. Public
  client behavior is verified against pinned primary sources. Server snapshot,
  retention and cutover guarantees remain live-verification blockers. See
  [LoFi evidence](docs/evidence-lofi.md).

- 2026-10-22: QRZ adapter, bounded ADIF and `ferry-liquid-v1` template profile
  implemented. Twenty focused checks cover pagination, exact matching, narrative
  preservation, uncertain responses, resource budgets and forward rendering.
  Replacement remains gated by scoped live evidence. See [QRZ evidence](docs/evidence-qrz.md).

- 2026-10-22: Direct Worker signing imports legacy/current synthetic PKCS#12,
  validates strict platform certificate signatures, matches independent OpenSSL
  RSA/SHA-1 vectors and emits gzip TQ8. LoTW adapters separate queue submission,
  exact observed revision and QSL metadata. Fourteen signing/query tests plus
  actual workerd experiment pass. Billed CPU/memory and scoped ARRL acceptance
  remain unverified. See [signing evidence](docs/evidence-signing.md).

- 2026-10-22: Email-confirmed passkey accounts implemented with browser-bound
  codes, atomic single-use ceremonies, required UV, fixed RP/origin, session/key
  revocation, fresh verification and no last-key removal or inbox reset. Synthetic
  ES256 cryptography passes in Node and real Worker HTTP endpoints, including two
  isolated tenants. Native Chromium signup/signin/reauth also exercised with a
  virtual authenticator. Physical/synced-provider matrix and real email delivery
  remain rollout checks. See [auth evidence](docs/evidence-auth.md).

- 2026-10-22: Bounded live read-only probes verified LoFi same-identity renewal,
  account access, cursor issuance/empty-incomplete resumption and an operation
  page; QRZ metadata and raw ADIF readback; and LoTW accepted/unconfirmed readback.
  Corrected observed protocol differences with synthetic regression fixtures.
  These reads do not prove snapshot/retention guarantees or mutation acceptance.
  See [live read evidence](docs/evidence-live-readonly.md) and [LoFi evidence](docs/evidence-lofi.md).

- 2026-10-22: Integrated source intake, per-destination history reconciliation,
  cutover evidence, immutable delivery artifacts, crash/uncertainty handling,
  confirmation tracking, encrypted maintenance/restore quarantine and the mobile
  dashboard. Actual local Worker HTTP and synthetic scheduler flows pass; all
  production gates remain closed. See [local setup](docs/local-development.md),
  [operations](docs/operations.md) and [rollout inputs](docs/rollout-checklist.md).

Initial local acceptance checkpoint (historical): `mise run check` passes formatting, recommended
lint with warnings treated as errors, server/browser TypeScript, all **146 tests**
and the **1,534.84 KiB raw / 290.24 KiB gzip** Worker build. `mise run demo`
passes **24 tests**. Workerd signing and D1 fixtures use the application's
2026-10-22 compatibility date. Final review fixed expiry pagination, cross-tenant
scheduler fairness, durable prior LoTW identities across dispatch crashes and
stale confirmation inheritance. Startup profiling passed locally; these are not
deployed resource or live acceptance measurements.

## Read-only production deployment (2026-10-22)

Deployed `f9856fdefa47` to [ferry.n1rwj.com](https://ferry.n1rwj.com) in the existing
Cloudflare account, with a dedicated migrated D1, independent protected secrets,
a native sender allowlist and disabled email-content previews. All vendor export
gates remain closed. Production health, session/passkey options, mailbox denial,
mobile rendering and actual signup-email delivery pass; no production account,
connection, ledger row or attempt was created. The updated full check passes
**149 tests**, and [CI passes](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39880597020).
See [deployment evidence](docs/deployment.md) for the version and safe redeploy path.
Owner enrollment, history review, source-boundary proof and scoped live-write
contracts remain distinct acceptance checks.

## Invite-only onboarding and independent settings (2026-10-22)

- [x] Save account template defaults and quiet periods without any service; use the requested reference-labels/contact-notes COMMENT default and preserve immutable prior versions.
- [x] Add branded HTML/plain-text mail, six-digit code hints, focus and paste support; retain the explicit device/mail-client autofill verification boundary.
- [x] Enforce hosted invite-only enrollment in the server and UI; add the operator `mise run invite` task with seven-day exact-email grants and atomic claim guards.
- [x] Exercise actual hosted Worker HTTP invitation/passkey flow and actual local Wrangler/Chromium signup, zero-connection saves, reload, sign-out/sign-in and mobile rendering.
- [x] Complete all 168 tests/types/lint/format/build checks, fix vendor-adapter runtime defects found by global-fetch experiments, and redeploy/read back every export gate closed.

The initial read-only deployment evidence above is historical. Existing users keep their passkeys and sessions; invitations do not reset accounts. No live invitations were sent during implementation. See [authentication](docs/authentication.md) and [operations](docs/operations.md).

Deployed follow-up revision `58a965d7c54d`, Worker version `0bf32d19-13c7-43da-b179-702ab49ad3d6`; six migrations applied. Live invite-only/join/gate checks and [deployed-code CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39884975858) pass. Branded mail/client autofill remains a separate device check; no real invites or vendor log writes were sent.

## Connection passkey freshness follow-up

The LoFi approval form now obtains a fresh passkey assertion automatically when needed, with preserved input and no connection request on cancellation. Auth/CSRF failures are distinct from scrubbed vendor errors; only a known pre-dispatch freshness failure can retry once. Concurrent session/account-switch and passkey-ceremony boundaries have focused coverage. Actual local Worker/Chromium tests exercise real signatures and contained vendor requests. All 180 tests, formatting, strict lint, types and the Worker build passed for this historical release. Deployed `cbe9e63af1bf` as Worker `6a580035-ad08-4e35-9fa5-5d09fe5f9baf`; live asset/origin-error/closed-gate checks passed. The owner has since completed the actual passkey and vendor approval. See [progress](PROGRESS.md).

## Read-only source review and connection controls

- [x] Explain vendor-provided LoFi account names; use friendly service/status labels and one current optional connection of each kind. Preserve existing extra/removed connection history and same-identity renewals.
- [x] Enforce new-connection policy before vendor requests and atomically during credential saves; safely replace pending LoFi approvals and resume paused connections without promoting unverified LoTW credentials.
- [x] Show source counts at the top, separate destination activity counts, initial scan/context progress, last successful page, retained contact samples and effective station/location/reference/current-comment previews.
- [x] Keep review reads tenant scoped, bounded and free of vendor calls or database mutation; explicitly preserve adopted narrative and pinned template policy. No preview can prepare, sign or export a contact.
- [x] Skip operation tombstones, fairly rotate failed/partial context reads and fence stale failure diagnostics. Preserve coverage and retry evidence.
- [x] Pass full formatting/lint/types/build and all **196 tests**, including real D1 race/retention/no-mutation checks. Actual isolated Worker/Chromium passkey signup/link/pause/resume/review confirms the expected comment, duplicate rejection, preserved unsaved edits, mobile375px without overflow, and zero attempts/outbox/vendor exports.

At this historical checkpoint the owner had completed real LoFi linking. Aggregate live metadata confirmed initial source ingestion; no destination was connected at that check, so an empty delivery ledger was expected. The dashboard provides useful source review independently. Both destinations have since been connected; current backlog and rollout status are recorded above and in [progress](PROGRESS.md). All live-write and exhaustive source-boundary acceptance checks remain separate.
