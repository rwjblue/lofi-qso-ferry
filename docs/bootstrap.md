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

The QRZ integration described below is implemented and focused-tested, with full
combined release checks and deployment pending. The previous verified release is
`0dad1031`; this section does not claim that the new migrations or matcher are
already active in production.

Retain timestamp precision. [ADIF permits both HHMM and HHMMSS](https://adif.org/316/ADIF_316.htm#Time).
A minute-only value represents an interval, not invented `00` seconds. The new QRZ
path applies the published ±30-minute candidate policy, includes adjacent UTC
coverage and requires uniqueness in both source-to-remote and remote-to-source
directions. An exact candidate plus another plausible coarse-time candidate stays
held; there is no closest-time tie-break. LoTW still uses its existing exact
normalized identity/six-digit-time association path. Its broader time-window
adoption requires a separate retained-coverage and ownership integration.

QRZ's [file-import duplicate rules](https://www.qrz.com/docs/logbook30/adif-import)
define a ±30-minute window, but their replacement behavior differs from the API
guide. Historical recognition must not silently authorize replacement. LoTW also
identifies own-log corrections and upload receipts using exact fields, separately
from QSL confirmation tolerances.

Compare operating location only after establishing identity uniqueness. Wrong
grid, state, county or DXCC means an existing-record mismatch, not a missing QSO.
Missing evidence is not equality. Compare only supported, exposed fields; extra
remote fields and narrative differences are not themselves historical errors.
Valid nested two-, four-, six- or eight-character
grids describe compatible regions in either prefix direction; retain both original
values and all other required frequency/location checks. This compatibility does
not prove that the full station projection was transmitted or accepted. Exact
upload receipt verification is unchanged. CQ/ITU zones compare valid numeric
values, including ADIF-permitted leading zeroes.

Every QRZ historical adoption made by the new path, including exact-time matches,
receives a durable **association-only** restriction checked at preparation and
dispatch. Source edits, reconnects or relinking to the same logical book cannot
promote it to INSERT, REPLACE or DELETE authority. Retain the original baseline,
remote hash and actual LOGID independently of exact outbound identity claims.
Existing exact Ferry receipt verification and mapped readback remain unchanged.

The weak source comparison index uses the already-decrypted raw QSO's normalized
worked call and UTC minute, stored as domain-separated HMAC buckets without
plaintext calls or minutes. These inputs do not depend on operation/segment
projection. All retained ordinary nondeleted QSOs are indexed regardless of work
state. A bounded reverse lookup spans active LoFi sources in the tenant, then
projects only the possible competitors against current operation/event context.
Operation changes advance the comparison clock without rebuilding unchanged weak
keys. The reverse window centers on the remote interval and can reach about
60 minutes from the originally selected source.

Database dirty/coverage barriers and a tenant comparison clock cover legacy
writes, source heads/bodies, matching policy and relevant connection changes.
Exact revision/body-incarnation CAS controls publication. Partial call-only,
time-only and fully unknown scopes remain possible competitors; none is silently
dropped. Reverse comparison holds on overflow or unavailable relevant data and
excludes only a proven non-contact under current dependency guards. Atomic adoption
rechecks source/context/retention, complete inventory provenance, comparison clock
and exclusive book-scoped LOGID ownership. This proves uniqueness within current
retained coverage, not universal upstream completeness or absence.

Published opaque buckets survive ordinary body expiry, revocation and archival.
An overlapping unavailable body holds that cohort; unrelated cohorts may proceed.
An unpublished pre-index archive remains dirty until normal source replay supplies
its raw record for one guarded restoration/publication. The random tenant HMAC
secret is encrypted separately from source bodies and rewrapped without changing
buckets. Preserve its envelope and required KEKs in backups; see the
[key lifecycle and measured cost](capacity-plan.md#historical-comparison-index-integration--release-pending).
An unreadable index key leaves coverage dirty while canonical source intake can
continue; SQL/schema/CAS errors are not converted into successful coverage.

Focused tests cover interrupted backfill, stale publication, legacy writes,
retention/KEK changes, late arrivals, cross-source conflicts, midnight intervals,
context changes, concurrent ownership, source edits and direct stage/dispatch
attempts. Full combined checks and deployed backfill/association observations are
still required. Broader LoTW adoption must extend retained coverage across UTC
day/week boundaries before a separate rollout. No historical association supplies
first-insert absence, a current source proof or write permission.

Two source UUIDs must not silently claim one remote record. Remote records without a source match remain untouched. Never fabricate source UUIDs for remote history or upload a marker merely to establish ownership.

### Remaining LoTW time-window association work

This sequence is planned, not implemented. It extends historical recognition only;
it does not change exact Ferry receipts, signing, first-insert absence checks or
export permissions. Keep all export controls closed during implementation.

LoTW's [QSL matching rules](https://lotw.arrl.org/lotw-help/frequently-asked-questions/#datamatch)
compare reciprocal submissions within 30 minutes, on the same band, with matching
mode or mode group; satellite contacts also require matching satellite evidence.
Those confirmation rules do not identify an own-log upload or correction.
[Own-log corrections](https://lotw.arrl.org/lotw-help/submitting-qsos/?lang=en)
require the original callsign, date, time to the second, band and mode; changing
these can create another QSO. The [download contract](https://lotw.arrl.org/lotw-help/developer-query-qsos-qsls/)
allows mapped modes and `APP_LOTW_MODE` without `MODE`, but supplies no documented
stable per-QSO identifier. Neither download timestamps nor a hash of the observed
fields should be presented as such an identifier.
1. **Complete bounded neighboring-date coverage.** Update
   `src/history-inventory.ts` and its tests before changing adoption. Derive required
   UTC dates from the precision-aware source interval plus the 30-minute window.
   Resolve each date through its weekly root and split children independently;
   deduplicate a shared leaf and retain at most two leaf guards. Both singleton and
   batch paths must include neighboring-day candidates, with a combined maximum of
   512 records. A missing, partial, blocked or expired leaf yields no complete
   evidence. Preserve existing byte/request bounds and `freshCheckComplete:false`.
   Acceptance: midnight, month/year/leap-day and week boundaries; two children of
   one split root; shared-leaf reuse; failed second-leaf races; combined overflow;
   and singleton/batch parity. Minute intervals must remain intervals, including
   ambiguous overlap at the 30-minute boundary.

2. **Add separate historical ownership and an exact-receipt bridge.** Use an
   additive migration and bounded helper, preserving the existing QRZ tables and
   exact LoTW identity claims. Store an internal association reference and encrypted
   original LoTW identity evidence in a separate namespace; never manufacture
   seconds or put a coarse/mode-group identity into `ledger.remote_id` or exact
   outbound claims. Add durable overlap reservations scoped to the verified logical
   query account, including connection aliases. Compare time intervals and known
   mode equivalence conservatively; nearest-match or tuple-hash equality is not
   sufficient ownership. Bridge retained encrypted `lotw_identity` evidence from
   existing exact receipts/adoptions, including archived source owners. Unrecoverable
   or incomplete relevant ownership coverage stays held. Legacy/direct receipt
   writes must update or dirty that coverage, and atomic reservation must fence its
   clock. Acceptance: competing owners, concurrent claims, precision/mode changes,
   aliases, archived owners, unreadable evidence, interrupted backfill and old-worker
   writes. Unrelated indexed cohorts must remain bounded and able to proceed.

3. **Wire guarded association-only recognition.** Extend
   `classifyHistoricalAssociation`, service classification and adoption only after
   those guards exist. Reuse the pure LoTW candidate policy and bounded reverse
   source census; require uniqueness before location/frequency comparison, preserve
   every original remote value, and recheck both inventory leaves, source/context,
   comparison clock and historical ownership in the adoption transaction. Extend
   the association-only write-block view to LoTW so edits and same-account relinks
   cannot grant upload authority. Do not treat the existing same-day targeted read
   as complete adjacent-day coverage. Acceptance: exact plus coarse competitors,
   mode-group/APP-only records, substantive mismatches, late source/event changes,
   direct stage/dispatch attempts and relinks. Exact receipt recovery and
   submitted/uncertain outcomes must remain unchanged; empty history never permits
   their automatic resend.

4. **Verify and measure before rollout.** Run populated-migration rehearsal and
   complete regression checks, then observe guarded adoption with exports disabled.
   Change the matching-policy fingerprint once at integration to revisit held work.
   Measure two-leaf and reverse-ownership cost; do not infer large-log capacity from
   focused fixtures. These checks establish retained-observation associations, not
   an immutable LoTW snapshot, universal source completeness or first-insert absence.

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
5. **Catch up before delivery.** Drain source changes since the starting boundary and catch up remote additions/modifications. Recheck a missing candidate immediately before its first write. New records or edits discovered during scanning enter the normal 20–60-minute cooldown. A historical date alone is not a permanent exclusion rule, but a QRZ association-only marker keeps an edited adopted contact held; it cannot enter automatic correction or INSERT processing.
6. **Discard temporary inventory.** After a partition's associations, exceptions, coverage, and replay checkpoint are durable, delete its temporary source/remote index. Retain minimal exception evidence, not every remote record. Restarts must resume safely without converting a partial partition into an empty one.

If LoFi cannot supply a reliable replay boundary, use overlapping rescans and version checks as mitigation, but do not claim they create a snapshot. Keep coverage-dependent absence decisions pending until the adapter can establish the required boundary. Cursor expiration or a detected gap requires reconciliation, not advancing past unseen changes.

“Missing” is scoped to the current identity and completed observation. Without an earlier source revision or mapping, Ferry cannot prove that a different old callsign/time was never uploaded. Readback also cannot prove an external upload is absent from an unprocessed queue. Recent competing uploads require a delayed recheck. Automatic backfill never deletes an unrelated historical remote record.

## Preserving QRZ text on later corrections

Newly adopted QRZ records use `remote_preserved` under the [narrative policy](templates.md#contacts-adopted-during-bootstrap). All existing narrative remains remote-owned, including text originally derived from source notes. Bootstrap neither applies the current template nor infers which application wrote that text. Source-note-only changes on these contacts generate no outgoing work; they are excluded from the relevant source-input fingerprint. QRZ describes preserving otherwise-unused fields in [Lossless ADIF](https://www.qrz.com/docs/logbook30/lossless-adif).

The new QRZ historical association path forbids later automatic replacement, insertion or deletion, including after source edits. The following correction rules apply only to separately authorized exact Ferry delivery paths without an association-only restriction. Before any permitted full-record replacement, fetch the associated LOGID and preserve its current narrative and remote-owned extras through an explicit field-ownership policy. Exclude server-owned identifiers/status fields from outgoing data. If the required read fails, retry rather than replace with missing text. Concurrent external edits remain a race; the read/merge/write sequence is not atomic.

Template-managed records retain their immutable binding. A changed default template must not cause a historical rewrite. Adoption does not opt an old record into that template; a corrected copy also retains the adopted association's preservation policy.

Adoption does not authorize automatic deletion of historical QRZ records. For an identity correction, delete a prior LOGID only when its provenance establishes that Ferry created it, the corrected record is acknowledged, and the IDs are distinct. Leave adopted or unknown prior records in place and surface the stale identity. A successful replacement is not proof of original creation; if it returns the same ID, never delete that ID as cleanup.

## Without LoTW read credentials

A signing certificate is not a substitute for account read access. Without the website password, mark pre-cutover history `historical_unverified` and run live delivery only for records proven new after the source cutover boundary. Do not use QSO date alone: a newly imported old QSO and a late-discovered historical record need explicit classification. Historical edits remain unverified until read access or an explicit, separately scoped policy resolves them. QRZ can still finish adoption and run normally.

## Acceptance cases

| Scenario                                                                   | Required result                                                                                |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Historical QSOs already exist at both services, including unconfirmed ones | Adopt; zero INSERT, REPLACE, DELETE, or signing operations.                                    |
| QRZ text differs from today's template                                     | Preserve text; unchanged future polls remain silent.                                           |
| Same identity has wrong portable location                                  | `history_mismatch`; no automatic historical rewrite.                                           |
| QRZ minute-only time with one compatible candidate in both directions      | Association-only adoption after current coverage/ownership checks; preserve the original time. |
| Unknown mode mapping, competing candidates or incomplete reverse coverage  | Hold; no nearest-match adoption or inferred absence.                                           |
| One source UUID matches exactly; another claims the same remote record     | No silent second association; isolate the conflict.                                            |
| Full inventory and fresh read establish absence at only one destination    | Queue that destination only, after cooldown.                                                   |
| QRZ page fails or LoTW returns HTML/truncated ADIF                         | Coverage remains incomplete; no inferred missing records.                                      |
| Source QSO or operation location changes between capture and commit        | Version check fails; replay/reconcile without losing the edit.                                 |
| Source creates a QSO while its historical partition is scanning            | Change intake discovers it; one logical delivery is scheduled.                                 |
| Crash after association commit but before temporary cleanup                | Resume idempotently and remove the temporary index.                                            |
| Credentials rotate or the same remote account/book reconnects              | Retain adoption, mappings, provenance, and narrative/template policy.                          |
| Trusted Ferry history already contains a QRZ template binding              | Restore it; do not downgrade to `remote_preserved` during reconciliation.                      |
| Only source notes change on an adopted `remote_preserved` contact          | No outgoing work and no takeover of existing narrative.                                        |
| A QRZ association-only contact changes identity                            | Preserve its owner and remote history; no automatic INSERT, REPLACE or DELETE.                 |
| QRZ replacement reuses the prior LOGID                                     | Retain its creation provenance; never delete it as an obsolete ID.                             |
| LoTW password is omitted                                                   | Unverified history stays unsent; established live-cutover records proceed.                     |
| Template edits alone                                                       | Zero historical scans, invalidations, hash recomputations, or export jobs.                     |
