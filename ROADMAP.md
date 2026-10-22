# Implementation roadmap

This roadmap is the handoff for implementation in this repository. All checkboxes begin unchecked: the initial documentation PR did not implement or validate the service. The owner authorized small signed commits directly to `origin/main` for implementation; no implementation PRs are opened. Retain the product decisions in [README](README.md). Each milestone should update its evidence and remaining questions here.

## Delivery order

| Milestone | Depends on | Result |
| --- | --- | --- |
| 0. Protocol/runtime spikes | None | Evidence for source, destination, signing, and passkey contracts |
| 1. Worker and durable state | Enough spike evidence to fix boundaries | Tenant-scoped storage, encryption, leases, fixture harness |
| 2. Accounts and connections | 1; relevant authentication/import spikes | Email-confirmed passkey signup and verified service connections |
| 3. Source intake and projection | 1; LoFi spike | Correct, resumable contact/operation changes and station context |
| 4. Historical adoption | 2–3; destination readback spikes | Existing history linked without remote writes |
| 5. Live QRZ delivery | 4; QRZ mutation spike | Delayed automatic insert/correction and forward-only templates |
| 6. Live LoTW delivery | 4; signing/query spikes | Worker-signed uploads with honest acceptance status |
| 7. Personal rollout and handoff | 5–6 | Small production deployment with documented recovery and cost |

Milestone 0's investigations can run independently. QRZ and LoTW delivery can be implemented in parallel once their shared ledger and bootstrap contracts are stable. A destination outage must not become a dependency for the other destination's ongoing operation.

## 0. Prove the uncertain contracts

### 0A. LoFi changes, pagination, and effective context

- [ ] Adapt the known [qso-sidecar](https://github.com/rwjblue/qso-sidecar/blob/c502cecd068a6a4330afd94458e5636fa17f3a51/src/lofi.rs) and [HaLo LoFi](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/extensions/sync/ham2k-lofi/src/index.ts) protocol behavior into a small typed client/spike. Do not copy Sidecar's contest assumptions.
- [ ] Establish whether `/v1/sync` is the appropriate read path and document exact operation/QSO cursor semantics, page completion, historical edits, tombstones, permission renewal, and cursor expiration. Treat a snapshot/replay boundary as unproven until demonstrated.
- [ ] Test null-operation general-log contacts and determine whether a selective reread is available. Specify temporary buffering if not.
- [ ] Capture synthetic fixtures for operation and segment corrections, same-time boundaries, own/worked POTA refs, multiple station callsigns, explicit clearing values, and raw frequency units.

**Acceptance:** a paged import and later catch-up do not lose or duplicate work after restart; changing only an operation's location causes affected QSO projections to change. Record unsupported recovery semantics explicitly instead of substituting device timestamps for a server cursor.

### 0B. QRZ readback and mutation semantics

- [ ] Implement and fixture-test response/ADIF parsing, pagination, empty/error responses, book identity, and required subscription checks using the [API contract](https://www.qrz.com/docs/logbook/QRZLogbookAPI.html).
- [ ] Prove how `INSERT`, duplicate rejection, `OPTION=REPLACE`, returned LOGIDs, confirmed records, time precision, and portable-location fields behave. Distinguish documented behavior from observed behavior.
- [ ] Prove preservation of narrative and remote-owned fields during a structured correction. Determine the exact safe collision search needed before creating or replacing.
- [ ] Specify uncertain-response reconciliation and the narrow provenance-checked cleanup of a Ferry-created old identity. No guessed update-by-LOGID primitive.

**Acceptance:** fixtures distinguish missing, ambiguous, rejected, replaced, and possibly accepted requests; existing text survives the intended update. Any live mutation experiment uses a deliberately designated test logbook/contact and separate authorization, never the owner's existing history by default.

### 0C. Direct LoTW signing and readback

- [ ] Build an isolated Worker signing spike with generated keys and representative PKCS#12 fixtures. Compare against [Wavelog's direct signer](https://github.com/wavelog/wavelog/blob/7f8eef4de94c674f73c6859ed4e0b0247f68dcd9/application/controllers/Lotw.php) and native TQSL/reference output where useful.
- [ ] Verify key import, legacy/current PKCS#12 encryption, certificate/key matching, callsign/DXCC/QSO-date authorization, canonical station/contact fields, RSA signature bytes, gzip, and multipart encoding.
- [ ] Measure actual Worker bundle size, memory, and CPU for import and representative batches. Prove the chosen cryptographic primitives in the deployed runtime; published algorithm support is not a completed test.
- [ ] Exercise [LoTW query parsing](https://lotw.arrl.org/lotw-help/developer-query-qsos-qsls/) with accepted unconfirmed records, own station detail, error HTML, date partitions, and receive-time checkpoints. Distinguish submission acknowledgement from observed processing and QSL confirmation.

**Acceptance:** reproducible synthetic vectors and runtime measurements are checked in without personal keys or logs. Document what still needs a deliberately scoped live ARRL acceptance check. A separate signer host is not the default fallback; report an actual blocker before revising the agreed architecture.

### 0D. Passkeys in Workers and mobile browsers

- [ ] Pin reviewed SimpleWebAuthn releases and demonstrate registration/authentication in the Worker runtime with the fixed RP/origin model in [authentication](docs/authentication.md).
- [ ] Exercise discoverable credentials, required user verification, synced passkeys, a backup security key, and the explicit sign-in button. Conditional autofill is progressive enhancement.

**Acceptance:** wrong challenge/origin/RP/user handle, missing UV, replay, and concurrent consumption fail correctly. No OAuth, password, email-login, or email-reset alternative is introduced.

## 1. Establish the Worker and durable state

- [ ] Create the minimal TypeScript/Workers project, package scripts, D1 migrations, environment configuration, and test harness. Document local setup and keep preview/prod bindings separate.
- [ ] Implement tenant-scoped records for accounts, linked source accounts, stable logical destinations, encrypted credential versions, cursors, ledger rows, template versions, bootstrap partitions, and outbox attempts.
- [ ] Keep source baseline, remote observation, transmitted projection hash, creation provenance, narrative policy, and receipt state distinct. Enforce uniqueness across tenant/source/destination identities.
- [ ] Implement the [envelope format](docs/security.md), KEK-version rotation, credential revocation, and logging redaction.
- [ ] Implement atomic cursor/work checkpoints, guarded job claims, lease fencing, retry scheduling, and immutable uncertain attempts. Choose bounded retention defaults with explicit expiry behavior.

**Acceptance:** crash/restart and overlapping cron invocations cannot skip source work, change an in-flight payload, or issue work for another tenant. A database export has no plaintext private credentials or pending payloads. Rotation and restore preserve mappings and revoked states.

## 2. Add accounts and service connections

- [ ] Implement email signup proof, first passkey enrollment, passkey-only login, sessions, additional keys, revocation, and email change exactly as [specified](docs/authentication.md). Select the email provider and production RP hostname before real enrollment.
- [ ] Make second-passkey/synced-provider recovery guidance visible; losing every usable passkey has no automatic v1 reset path.
- [ ] Link a LoFi account through its existing approval flow. Verify account ownership and show which source account is connected.
- [ ] Link QRZ book keys and validate station callsign/date routing. Link LoTW signing material and optional query credentials, keeping their purposes separate.
- [ ] Require recent passkey verification for sensitive connection changes. Reconnecting or renewing a credential preserves the stable logical destination; a genuinely different account/book does not inherit mappings.

**Acceptance:** the same email confirmation cannot sign into or replace credentials on an existing account. A second tenant cannot reference another tenant's connections or passkeys. No contact export occurs merely because credentials were saved; initial reconciliation determines historical eligibility.

## 3. Build resumable source intake and projection

- [ ] Implement separate operation/QSO progress and atomic page checkpoints; recover expired/gapped cursors through reconciliation.
- [ ] Normalize contact identity, tombstones, timestamp precision, frequency, band/mode, station callsign, and effective location. Retain event context needed for segments while excluding event rows from exports.
- [ ] Coalesce destination-relevant changes per contact. Set the default quiet period to 30 minutes and poll every five minutes; expose a 20–60-minute setting.
- [ ] Preserve temporary source/context data only where necessary for delayed delivery or reread limitations. An operation edit can trigger a bounded reread; a template edit cannot.

**Acceptance:** ongoing logging does not postpone earlier stable contacts. Offline arrivals and old-contact corrections work. Location/park changes at segment boundaries affect the correct contacts; changes to unsupported LoTW narrative fields create no LoTW work.

## 4. Adopt existing history without rewriting it

- [ ] Implement [bootstrap states and matching](docs/bootstrap.md) separately for QRZ and LoTW. Inventory accepted unconfirmed contacts as well as confirmed ones.
- [ ] Match conservatively by verified identity and operational context. Preserve timestamp precision; isolate collisions, missing location evidence, and unsupported mode mappings.
- [ ] Adopt unique existing records with a captured source baseline and remote observation, without a fabricated delivery receipt. Preserve trusted Ferry mappings on reconnect and QRZ remote narrative on first adoption.
- [ ] Establish source intake before scanning, catch up races, and recheck absence before first backfill. Use bounded encrypted temporary partitions and remove them after durable progress.
- [ ] Without LoTW read access, leave prior history unverified and permit only live records proven new after the source cutover. Expose incomplete coverage rather than treating it as absence.

**Acceptance:** a representative source log already uploaded to both services produces zero INSERT, REPLACE, DELETE, or signing operations during adoption and unchanged subsequent polls. A contact absent at just one destination queues only there. Failed/partial inventories never authorize backfill. Two source UUIDs cannot silently adopt one remote record.

## 5. Deliver to QRZ and support forward-only templates

- [ ] Implement insert/correction with stable book routing, response mapping, fetch/merge preservation, uncertain-result reconciliation, and the tested duplicate contract.
- [ ] Reuse the appropriately licensed HaLo Liquid SDK/helpers or compatible bounded implementation. Preserve notices and avoid importing the separately licensed full exporter without an explicit licensing decision.
- [ ] Implement immutable version creation and first-staged-export binding from [templates](docs/templates.md). Keep unbound, template-bound, and remote-preserved policies distinct.
- [ ] Include a POTA example using the operator's activated park; enforce resource and length-correct ADIF serialization limits.
- [ ] Handle changed identities with durable old/new IDs and provenance-checked cleanup. Leave adopted old identities intact and visible. Source deletions cancel unsent work and record retained remote state.

**Acceptance:** changing a template generates no historical scan, invalidation, hash recomputation, or job. In-flight requests and retries keep their pinned version. An actual later source change uses current data with that version. Adopted text survives structured corrections; note-only source edits do not take ownership. Lost responses do not cause blind inserts or deletes.

## 6. Deliver signed contacts to LoTW

- [ ] Integrate the proven Worker signer, versioned field/configuration tables, certificate selection, and per-location grouping.
- [ ] Persist immutable encrypted signed batches with exact member UUIDs, source generations, and certificate/configuration versions until their outcomes resolve. Commit membership and member attempt states together. One-contact artifacts are acceptable initially; bound batch work and isolate invalid records without resubmitting unrelated history.
- [ ] Implement acknowledgement, observed acceptance, retry, and optional confirmation tracking as separate states. Reconcile via readback when configured.
- [ ] Apply supported nonidentity corrections and report identity corrections that leave the prior record at LoTW. Surface certificate/award/location restrictions precisely.

**Acceptance:** mixed callsigns/locations use the proper certificate and station data; source-note/template-only changes produce no LoTW submission. An ambiguous timeout is reconciled. A submitted batch is not displayed as per-QSO accepted solely because its upload was acknowledged. Production compatibility claims require actual scoped acceptance evidence.

## 7. Roll out personally and document operations

- [ ] Add a compact mobile-friendly dashboard for connection health, history adoption, pending work, submitted/observed states, and exceptions. No manual operation-release step.
- [ ] Run a read-only reconciliation against the owner's history and review aggregate results and exceptions before enabling the service's first production writes. This is rollout verification, not the recurring logging workflow.
- [ ] Enable a small, identifiable set of new contacts, verify both destinations, then expand normal automatic coverage. Record the deployed revision and contract evidence.
- [ ] Document deployment, certificate renewal, key rotation, passkey management, source cursor gaps, uncertain requests, backup restore, disabling connections, retention, and vendor throttling.
- [ ] Measure representative monthly Worker/D1/email usage; document actual cost and tune batching/polling without weakening correctness.
- [ ] Verify a second isolated tenant with synthetic fixtures before enabling additional people.

**Acceptance:** ordinary PoLo/HaLo logging reaches both configured destinations after settling without additional user actions. Existing history and comments remain intact. Failed jobs remain visible and retry safely; revocation stops new work. Operational instructions and measured limitations let another local agent continue without reconstructing this conversation.

## Decisions to record during implementation

Keep unresolved items attached to their milestone: verified LoFi replay boundaries and null-operation rereads; QRZ replacement/collision and field-preservation semantics; Worker PKCS#12/signature compatibility; LoTW station/mode configuration provenance; email provider and production hostname; concrete retention/batch limits and measured cost. These are implementation evidence requirements, not reasons to reopen the settled live-sync, forward-only-template, passkey-login, minimal-storage, or hosted-signer product choices.

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
