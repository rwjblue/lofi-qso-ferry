# Adopting existing QRZ and LoTW history

Status: implemented v1 contract; complete owner-history and source-boundary verification remain gated. See [rollout checklist](rollout-checklist.md). Bootstrap first inventories and adopts existing contacts without remote writes. After reconciliation, contacts whose current identity is demonstrably absent become eligible for automatic backfill through normal delivery. Adoption itself must not re-upload existing history, regenerate its comments, reset confirmations, or re-sign every QSO.

QRZ and LoTW reconcile independently. A QSO can be adopted at QRZ while LoTW remains unavailable. Exceptions affect the relevant record and destination; they do not hold up unrelated live logging.

## Outcomes

| Destination state          | Meaning and next action                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `inventory_pending`        | Coverage or source-version checks are incomplete. Do not export historical records.                                                           |
| `adopted_existing`         | One existing record matches, with sufficient agreement on source-owned operational fields. Record the association without writing remotely.   |
| `missing_current_identity` | Complete, successful inventory and a fresh targeted check found no matching or ambiguous candidate. Eligible for normal automatic delivery.   |
| `history_mismatch`         | An identifiable existing QSO disagrees on substantive source-owned data, such as operating location. Preserve it and expose the disagreement. |
| `history_ambiguous`        | Multiple candidates, insufficient precision, or an unverified normalization prevents safe association. Isolate the exception.                 |
| `historical_unverified`    | Required read access is unavailable. History is skipped, not marked delivered or eligible for blind backfill.                                 |

Adoption records presence; confirmation is a separate fact. Source upload flags, operation completion, and another service's confirmation badge are not evidence that a destination contains the current QSO.

## Destination readback

### QRZ

Use the connected logbook's API key and `ACTION=FETCH`, requesting ADIF and relying on the all-status default. An explicit `STATUS:ALL` produced generic failure in the bounded live probe; see [QRZ evidence](evidence-qrz.md). Page with `MAX:250,AFTERLOGID:0`, advancing to the largest returned `APP_QRZLOG_LOGID` plus one. Stop on the parsed page length, not `COUNT`, which describes all matches. `BETWEEN` can bound a partition. Do not combine `ALL` with pagination options. `MODSINCE` covers modifications that an ID-only pass misses. The documented interface has no snapshot token. A generic `FAIL` is not an empty inventory; validate the server's empty-result behavior in adapter contract tests. See the [QRZ API guide](https://www.qrz.com/docs/logbook/QRZLogbookAPI.html).

Inventory every connected callsign/date-range book. Portable suffixes are significant; `N1RWJ` and `N1RWJ/P` must not be silently combined. The [multiple-logbooks rules](https://www.qrz.com/docs/logbook30/multiple-logbooks) explain this routing.

### LoTW

Query `https://lotw.arrl.org/lotwuser/lotwreport.adi` with website `login`, `password`, `qso_query=1`, `qso_qsl=no`, an explicit early `qso_qsorxsince`, `qso_withown=yes`, and `qso_mydetail=yes`. For example, the adapter can test `1970-01-01` as its initial receive-date floor. Otherwise defaults can restrict results to confirmations or a previous download's watermark. Partition with `qso_owncall` and QSO date/time bounds; avoid confirmation or DXCC filters.

Validate ADIF framing and `APP_LoTW_NUMREC`; errors can be HTML. Keep `APP_LoTW_LASTQSORX` with the exact query scope for overlapping catch-up. Read `STATION_CALLSIGN`, own-location fields, and `MODE`/`APP_LoTW_MODE`. `APP_LoTW_MODEGROUP` is an award category, not a unique mode identity. These contracts are documented in [Querying LoTW](https://lotw.arrl.org/lotw-help/developer-query-qsos-qsls/). Redact credential-bearing URLs from logs.

## Historical association and vendor matching

Use the vendor's published matching rules to discover historical candidates, then require a unique, one-to-one association with durable ownership. QRZ documents ±30 minutes, callsigns, band and primary mode for confirmations and ADIF import duplicates. LoTW confirms reciprocal callsigns on the same band within 30 minutes, using exact mode or its mode group and matching satellite/SAT where applicable. See the [published rules and implementation plan](reconciliation-investigation.md#published-vendor-rules-and-revised-implementation-plan-2026-10-24). Normalize case and documented aliases; retain callsign suffixes and original remote modes. A confirmation rule does not establish an API replacement or upload identity.

Retain timestamp precision. [ADIF permits both HHMM and HHMMSS](https://adif.org/316/ADIF_316.htm#Time). A minute-only value represents an interval, not invented `00` seconds. The current automatic association path still requires exact normalized contact identity and a six-digit time. A separate non-authoritative historical candidate policy supplies the published time/mode comparisons; broader adoption waits for source uniqueness, complete relevant coverage and durable historical ownership. Include adjacent UTC dates and search reverse competitors around each remote candidate. Do not select the nearest contact from competing candidates.

QRZ's [file-import duplicate rules](https://www.qrz.com/docs/logbook30/adif-import) define a ±30-minute window, but their replacement behavior differs from the API guide. Historical recognition must not silently authorize replacement. LoTW also identifies own-log corrections and upload receipts using exact fields, separately from QSL confirmation tolerances.

Compare operating location after identifying candidates. Wrong grid, state, county, or DXCC means an existing-record mismatch, not a missing QSO. Missing evidence is not equality. Only compare fields the destination supports and exposes, using explicit precision rules; unsupported fields cannot be verified there. Extra remote fields and narrative differences are not, by themselves, historical errors.

For QRZ and LoTW historical association, two valid two-, four-, six- or eight-character grids
are compatible when either is a prefix of the other. Require one exact normalized
contact identity with a valid six-digit time and agreement on every other current
frequency/location comparison. Preserve both original grid values and the normal
durable ownership guards. This identifies an existing contact; it does not claim
that the full station projection was transmitted or accepted. Upload receipt
verification still compares the exact supported projection. A different grid
prefix, invalid/missing grid, competing identity or other field conflict remains
held. CQ/ITU zone values use their valid numeric values, including ADIF-permitted
leading zeroes, rather than textual formatting alone.

Before wider/coarse-time matches become trusted adoptions, require a durable
association-only capability checked during both preparation and dispatch.
Editing an adopted source currently enters correction processing; a broader
historical match must not inherit exact replacement or INSERT authority from
that transition. Retain the original baseline, remote hash and actual remote
identity separately from an exact outbound claim.

Populate the opaque source comparison index incrementally from ordinary source
projections. Fence coverage and competitor checks to the current account/policy,
body incarnations, projected generation, route and all operation/event dependencies.
Unindexed or stale possible competitors prevent adoption; bound unknown scopes
where independently valid call/time evidence permits it. Recheck these facts with
inventory provenance and ownership in the atomic association transaction. Do not
scan every retained source ciphertext for each contact. Validate late arrivals,
reverse-window competitors, stale context, cross-source collisions, legacy-worker
overlap and edited associations before rollout.

Two source UUIDs must not silently claim one remote record. Remote records without a source match remain untouched. Never fabricate source UUIDs for remote history or upload a marker merely to establish ownership.

## Minimal adoption ledger

Persist one row per tenant, stable LoFi account, source UUID, and **logical destination identity**: QRZ account/book or LoTW account. Credential versions and connection attempts are not part of this key. Rotation, renewal, and reconnection to the same destination preserve adoption, remote mappings, creation provenance, and narrative/template policy. Verify the remote identity before reattaching credentials; a genuinely different account or book is a different destination.

On reconnect, reuse trusted Ferry receipt, mapping, provenance, and binding history before considering fresh adoption. Restore an established QRZ template binding; never downgrade it to `remote_preserved` merely because the remote record already exists. Reconciliation checks that retained association without inventing a new ownership policy.

| Value                                         | Purpose                                                                                                                                                                                |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Captured source revision or content token     | Identifies the exact version examined, including effective operation/location inputs.                                                                                                  |
| `source_baseline_hash` and projection version | Hashes that captured version's source-owned inputs included in the destination projection. Detects subsequent real source changes.                                                     |
| `remote_observed_hash`                        | Hashes comparable remote fields under a separate, versioned projection. Records what was observed, not what Ferry wishes had been sent.                                                |
| Association and evidence time                 | QRZ book/LOGID, or an encrypted LoTW identity tuple; observation time and inventory scope.                                                                                             |
| Adoption state and compact reason             | Distinguishes an adopted record from a Ferry delivery and records unresolved evidence.                                                                                                 |
| Remote creation provenance                    | Per QRZ LOGID: `adopted`, `ferry_created`, or `unknown`; retained for any prior ID awaiting cleanup. A replacement does not convert adopted provenance into Ferry creation.            |
| QRZ narrative ownership                       | `remote_preserved` for newly adopted associations; otherwise the retained immutable template binding. This is separate from remote creation provenance. LoTW has no narrative binding. |

A newly adopted row without trusted Ferry history has no Ferry delivery receipt or `last_sent_hash`. Do not set those to today's generated payload: that payload was never sent. Do not compare `remote_observed_hash` with the differently defined source hash and treat their inequality as a change.

The first unchanged poll is a no-op. Later source edits compare against the captured source baseline, regardless of the QSO's age. Location changes at operation level must invalidate affected QSO projections. Source baseline/input hashes exclude rendering, polling metadata, and remote confirmation changes; their inputs follow the destination's field-ownership policy. Outbound projection hashes include all supported transmitted content, including rendered or preserved QRZ narrative. Keep only compact encrypted identity evidence after adoption; it supports later correction reporting without retaining a full historical log mirror.

## Reconciliation and cutover algorithm

V1 uses one source contact as its bounded partition: QRZ reads its documented collision neighborhood with date margins, and LoTW queries that station/worked callsign on its UTC date. The complete targeted response supplies candidate coverage; no permanent remote logbook index is retained. Oversized, partial or malformed responses remain unresolved. The immutable source birth/cursor cutover and replay gate still apply; targeted readback does not establish a missing source snapshot guarantee.
1. **Establish source change intake.** Record a cutover boundary and begin durable intake before scanning. Use a resumable cursor only if its ordering, retention, pagination, and historical-edit behavior are verified. Record bootstrap progress separately from normal delivery progress.
2. **Capture one bounded source partition.** Save its UUIDs, exact observed version tokens, destination projections, and effective location dependencies temporarily. An inventory page of mutable current records is not an immutable historical snapshot.
3. **Stream remote candidates.** Build a bounded temporary index for the corresponding account, callsign, dates, and collision margins. Resume failed pages; incomplete or malformed responses cannot establish absence. Track coverage independently for each destination.
4. **Classify and commit.** Match against the captured source versions. Compare-and-set each ledger baseline against that same version. Never compute a baseline from a later reread and claim it describes the earlier match. If inputs changed, reconcile the new version; retain or replay the change instead of swallowing it.
5. **Catch up before delivery.** Drain source changes since the starting boundary and catch up remote additions/modifications. Recheck a missing candidate immediately before its first write. New records or edits discovered during scanning enter the normal 20–60-minute cooldown. An adopted old QSO edited afterward is eligible too; a historical QSO date is not a permanent exclusion rule.
6. **Discard temporary inventory.** After a partition's associations, exceptions, coverage, and replay checkpoint are durable, delete its temporary source/remote index. Retain minimal exception evidence, not every remote record. Restarts must resume safely without converting a partial partition into an empty one.

If LoFi cannot supply a reliable replay boundary, use overlapping rescans and version checks as mitigation, but do not claim they create a snapshot. Keep coverage-dependent absence decisions pending until the adapter can establish the required boundary. Cursor expiration or a detected gap requires reconciliation, not advancing past unseen changes.

“Missing” is scoped to the current identity and completed observation. Without an earlier source revision or mapping, Ferry cannot prove that a different old callsign/time was never uploaded. Readback also cannot prove an external upload is absent from an unprocessed queue. Recent competing uploads require a delayed recheck. Automatic backfill never deletes an unrelated historical remote record.

## Preserving QRZ text on later corrections

Newly adopted QRZ records use `remote_preserved` under the [narrative policy](templates.md#contacts-adopted-during-bootstrap). All existing narrative remains remote-owned, including text originally derived from source notes. Bootstrap neither applies the current template nor infers which application wrote that text. Source-note-only changes on these contacts generate no outgoing work; they are excluded from the relevant source-input fingerprint. QRZ describes preserving otherwise-unused fields in [Lossless ADIF](https://www.qrz.com/docs/logbook30/lossless-adif).

Before any later full-record replacement, fetch the associated LOGID and preserve its current narrative and remote-owned extras through an explicit field-ownership policy. Exclude server-owned identifiers/status fields from outgoing data. If the required read fails, retry rather than replace with missing text. Concurrent external edits remain a race; the read/merge/write sequence is not atomic.

Template-managed records retain their immutable binding. A changed default template must not cause a historical rewrite. Adoption does not opt an old record into that template; a corrected copy also retains the adopted association's preservation policy.

Adoption does not authorize automatic deletion of historical QRZ records. For an identity correction, delete a prior LOGID only when its provenance establishes that Ferry created it, the corrected record is acknowledged, and the IDs are distinct. Leave adopted or unknown prior records in place and surface the stale identity. A successful replacement is not proof of original creation; if it returns the same ID, never delete that ID as cleanup.

## Without LoTW read credentials

A signing certificate is not a substitute for account read access. Without the website password, mark pre-cutover history `historical_unverified` and run live delivery only for records proven new after the source cutover boundary. Do not use QSO date alone: a newly imported old QSO and a late-discovered historical record need explicit classification. Historical edits remain unverified until read access or an explicit, separately scoped policy resolves them. QRZ can still finish adoption and run normally.

## Acceptance cases

| Scenario                                                                   | Required result                                                            |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Historical QSOs already exist at both services, including unconfirmed ones | Adopt; zero INSERT, REPLACE, DELETE, or signing operations.                |
| QRZ text differs from today's template                                     | Preserve text; unchanged future polls remain silent.                       |
| Same identity has wrong portable location                                  | `history_mismatch`; no automatic historical rewrite.                       |
| Minute-only time, unknown mode mapping, or two plausible candidates        | `history_ambiguous`; no nearest-match adoption.                            |
| One source UUID matches exactly; another claims the same remote record     | No silent second association; isolate the conflict.                        |
| Full inventory and fresh read establish absence at only one destination    | Queue that destination only, after cooldown.                               |
| QRZ page fails or LoTW returns HTML/truncated ADIF                         | Coverage remains incomplete; no inferred missing records.                  |
| Source QSO or operation location changes between capture and commit        | Version check fails; replay/reconcile without losing the edit.             |
| Source creates a QSO while its historical partition is scanning            | Change intake discovers it; one logical delivery is scheduled.             |
| Crash after association commit but before temporary cleanup                | Resume idempotently and remove the temporary index.                        |
| Credentials rotate or the same remote account/book reconnects              | Retain adoption, mappings, provenance, and narrative/template policy.      |
| Trusted Ferry history already contains a QRZ template binding              | Restore it; do not downgrade to `remote_preserved` during reconciliation.  |
| Only source notes change on an adopted `remote_preserved` contact          | No outgoing work and no takeover of existing narrative.                    |
| An adopted QRZ identity is corrected into a distinct new record            | Preserve the old historical record and surface it; no automatic deletion.  |
| QRZ replacement reuses the prior LOGID                                     | Retain its creation provenance; never delete it as an obsolete ID.         |
| LoTW password is omitted                                                   | Unverified history stays unsent; established live-cutover records proceed. |
| Template edits alone                                                       | Zero historical scans, invalidations, hash recomputations, or export jobs. |
