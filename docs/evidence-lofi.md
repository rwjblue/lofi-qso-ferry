# LoFi adapter evidence

Initial adapter review: 2026-10-22, before live requests. The dated observations
below record subsequent read-only vendor evidence; fixture results alone do not
establish server compatibility or production coverage.

Current checkpoint, 2026-10-24 09:21 UTC: the production all-client baseline,
forward drain and quarantine handoff completed at **06:35:44.881 UTC**. The policy
is `ready`, with all 218 operations and 4,282 QSO-stream rows (4,500 retained rows)
witnessed in the current epoch and zero unseen retained rows. There are 4,130
contacts eligible for reconciliation processing, not authorized exports. At
08:12:53, the exact deployed coordinator collected two required positives,
completed a qualifying drain and minted a current proof for one contact. Fresh
QRZ reads found an empty neighborhood for that same contact, with strict
eligibility and the proof current afterward. This was a protected Node harness
against production D1, not scheduled Worker or upload acceptance; see
[the QRZ observation](evidence-qrz.md#current-read-only-readiness-observations-2026-10-24-utc).

At **09:05:45 UTC**, a one-shot remote Cloudflare preview reproduced the atomic
`proof_cohort_count` rejection with the exact deployed coordinator and no clock
barrier. One positive collection and one final canonical drain completed for the
same two-dependency contact, but no proof was accepted. QRZ and LoTW follow-up
reads were therefore skipped. The diagnostic recorded 52 database calls and 77
statements; its eight mutating calls cover ordinary source observations, leases,
budget accounting and the rolled-back mint attempt. The separate one-shot
admission lease is outside those helper counters. No vendor export, attempt,
stage guard or cutover was created.

After rollback, all 21 proof predicates and the outer lease/count checks passed.
The failed batch lasted 42 ms; the later SELECT observed D1 14 ms past proof
creation and 47 ms behind the Worker at that SELECT's start. This supports a
clock-ordering hypothesis without identifying the failed predicate inside the
transaction. The failure is reproducible in a cloud Worker, not only Node. A
bounded pre-mint database-clock check was then committed; proof timestamps,
expiry and the atomic guards remain unchanged.

The temporary preview was disposed. Independent before/after checks confirmed
the original production Worker, all three asset hashes and seven closed export
controls. This was diagnostic cloud execution, not scheduled production traffic
or capacity evidence. A preceding local preflight stopped before remote execution
because bundle comments depended on the working directory; pinning the build
directory fixed that check without changing the Worker bundle. A separate
timestamp-group response-bound fix and the clock-admission fix later shipped in
signed release `12f636b3` at 11:59 UTC with all eight export controls closed.
Current evidence must be refreshed before any write.

At **09:20:14 UTC**, a separately reviewed remote comparison applied only the
committed clock-admission proof and coordinator modules over the exact deployed
`02e3dc89` base. It completed one collection and one final drain, covering two
positive dependencies and no events, then minted one proof in one successful
atomic batch. The source verification helper took 2.163 seconds, 53 database calls and 78
statements. Ordinary guarded source/proof checkpoints, leases and budget
accounting were permitted; no export, staging, attempt or cutover was made.

The runtime clock check observed D1 9 ms beyond the original creation timestamp
on its first SELECT. No second check or timer wait was needed, and every proof
binding remained unchanged. This verifies the new admission path in cloud
execution; it does not demonstrate live negative-clock catch-up or uniquely
identify the earlier failure's cause. A controlled real-D1 regression separately
reproduces a 40 ms lag and verifies successful admission with original times,
expiry and dependencies. The fix allows at most two clock/lease reads and one
wait within a 500 ms admission deadline, also bounded by the original phase,
proof and lease expiry. A late database response cannot authorize a late mint;
the unchanged atomic guards still reject intervening changes or expiry.

Fresh QRZ reads found an empty neighborhood for this exact contact and proof,
which remained current after the final check at **09:20:40.895 UTC**, with 271,806
ms remaining. See [the QRZ evidence](evidence-qrz.md#current-read-only-readiness-observations-2026-10-24-utc).
The temporary comparison was disposed and production remained on its existing
version with matching assets and seven closed controls. It is an explicitly
unreleased two-module composition, not a traffic deployment, scheduled-run or
capacity result. The source timestamp-expansion collector change was not part
of this comparison. All 1,233 tests and the full local release check passed for the combined
unreleased changes. Signing and production release remain outstanding.

The protocol references are [Sidecar's browser registration and operation reads](https://github.com/rwjblue/qso-sidecar/blob/c502cecd068a6a4330afd94458e5636fa17f3a51/src/lofi.rs), [HaLo's transport](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/extensions/sync/ham2k-lofi/src/index.ts), and [its sync engine](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/packages/halo_core/lib/src/sync/sync_engine.dart). These are client implementation evidence; public server retention and replay guarantees were not found.

### Upstream deletion and pagination evidence reviewed 2026-10-24

[HALO-557](https://cabo.ham2k.com/halo/c/557) records that ordinary delete payloads
use `true`, `1`, `"true"` or `"1"`, and that the REST operation-delete path can
leave the application revision timestamp unchanged. It identifies the server's
`status: "deleted"` as authoritative. Ferry already accepts those flag dialects
and uses server sync timestamps for intake; equal-server-timestamp conflicts
remain holds. A conservative status-only deletion decoder fix is separate work,
not a deployed behavior claim for `5a427a30`.

[HALO-683](https://cabo.ham2k.com/halo/c/683) documents server hard deletion of
owner-purged test operations and contacts, including their change history, with
**no tombstone retained**. Stored and incoming test classification plus timestamp
checks constrain that operation. The card records merged server changes and
deployment/cleanup follow-ups; it does not independently establish the exact
production server revision or universal tombstone retention. A previously real
record can also have been changed to test before a later purge, so current test
exclusion alone cannot prove every historical deletion is delivered.

Exact-contact proofs establish bounded recent positive observations of the
retained dependency closure. They cannot detect a silent purge occurring after
those observations if the server removes both the record and its change history.
The mandatory final sync and the oldest positive's remaining five-minute proof
lifetime limit staleness; they do not establish universal deletion delivery or
source-wide completeness. Known missing targets before collection remain held.
`SOURCE_BOUNDARY_VERIFIED` stays false.

[HALO-770](https://cabo.ham2k.com/halo/c/770) records a deployed server repair for
force-refresh timestamp ties and distinguishes row-cursor continuation from
millisecond fallback expansion. This supports testing both pagination paths,
not assuming a requested page size is an exhaustive response or a stable snapshot.
It supplies no cursor-age or purge-retention guarantee.

## Implemented contract

`LoFiClient` registers a stable `browser:` identity at `POST /v1/client`, sends the existing permission approval flow at `POST /v1/client/permissions`, and verifies `current_account.uuid` through `GET /v1/accounts`. A protected request renews a rejected bearer once using the same identity. It does not replace a refused client identity or silently connect a different account. Callers must encrypt and durably save `credentialsSnapshot()` when its token changes. Registration/approval are separate from Ferry account signup.

A read-only metadata check on 2026-10-23 verified that `current_account.email` is available and matches `account.email` in a sync response for the same account UUID. The sync window began at the check time and returned zero operations and zero contacts. The existing bearer was used without renewal, permission requests, account changes or source mutations; only boolean/count diagnostics were retained. Ferry displays this confirmed email with its registered client name and hides the historical first-connection account name.

Read intake uses `POST /v1/sync` with only `meta.inboundSync` and `meta.sync`; no operations, QSOs, or claims are uploaded. Backfill windows carry `syncedUntilMillis`; forward windows carry `syncedSinceMillis`. The deployed versioned `all-clients-v1` policy sends `anyClient: true` in both directions. Untagged legacy forward requests retain the earlier `anyClient: false` behavior, but cannot establish current policy membership. Operation and QSO cursors/watermarks are independent. `next_cursor`/`nextCursor` remain opaque. Forward and backward cursor state are never reused across directions.

Only the server-authored `syncedAtMillis` advances watermarks. Cursor pages retain a one-millisecond overlap in their fallback watermark so equal-timestamp rows can be replayed. Missing record UUIDs or timestamps fail the whole page. Explicit `records_left`/`recordsLeft: 0` establishes page completion; a short page does not. Empty cooldown pages with more history preserve their cursor. Repeated nonterminal cursors and server pagination errors require reconciliation. HTML, malformed records, redirects, unexpected account IDs, and oversized responses cannot establish coverage.

`syncPage()` returns records and a new checkpoint together without changing the supplied state. The caller must commit both atomically under its source lease; an external fetch cannot itself provide database atomicity. UUID-scoped upserts make replay harmless. Tests serialize/recreate the client between pages and cover tied timestamps, empty pages, refusals, and renewal. All endpoints are fixed to `https://lofi.ham2k.net`; templates/settings cannot select a credential-bearing fetch host.

## Effective contact context

The segment rules come from [HaLo's segment model](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/packages/halo_core/lib/src/models/segments.dart). A `band: event` row whose `event.event` is `start` or `break` can open a segment. Its allowed overrides apply independently over the base operation. A contact exactly at a boundary uses the new segment. Missing keys fall back to the base; explicit nulls and empty reference arrays clear values. Stops, deleted events, and purges do not open segments. Two opening events at the same instant block the affected projection because inspected code does not establish a stable tie-breaker. QSO-level location replaces the grid/coordinate group as a unit.

Projection uses the effective operation's `potaActivation` references for own parks and QSO `pota` references for worked parks. It converts QSON kHz to MHz explicitly, preserving fractional seconds. An operation-only change changes each affected contact's generation. An edit to a later segment leaves earlier projections unchanged. Operation running totals/end-of-log snapshots and synchronization metadata do not trigger work. LoTW fingerprints exclude narrative and park-only changes; `remote_preserved` QRZ fingerprints exclude narrative inputs.

The normalization is independently implemented from the documented wire behavior; no MPL application/exporter source was copied. Unknown mode mappings and inconsistent band/frequency pairs block projection. A comma-separated multi-station segment requires an explicit routing decision rather than silently selecting one callsign.

A bounded read-only inspection on 2026-10-23 found one retained null-operation QSO with a valid canonical `our.call`, but no `our.stationCall` or top-level `stationCall`. Ferry incorrectly reported `missing_or_ambiguous_station_call` because it only recognized those aliases. [HaLo's QSON model](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/packages/halo_core/lib/src/models/models.dart) exposes the own call through `our.call`. [Its ADIF importer](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/packages/halo_core/lib/src/adif/adif_to_qson.dart) maps `STATION_CALLSIGN` into that field after an `OPERATOR` fallback, while preserving `OPERATOR` separately as `our.operatorCall`. This establishes the wire field, but does not make the operator the transmitting station for an operation.

Projection therefore accepts validated `our.call` only for null-operation contacts whose explicit station fields are absent. Explicit QSO station fields retain their precedence, including null/empty clears that must block projection. For operation contacts, effective operation/segment station context remains authoritative over `our.call`; a missing or cleared operation station cannot fall back to it. Ferry never infers station identity from `operatorCall`, or infers an operator from the station. Synthetic regressions cover these distinctions. Migration `0016_reproject_general_log_station.sql` requeues only nondeleted, nonevent null-operation rows held for this projection error with matching, unexpired, unrevoked retained ciphertext. It preserves source revisions, payloads, cursors, destination evidence and attempts; requeued rows still pass all normal projection, routing, history and write gates. The local D1 regression also verifies expired, revoked, missing and incorrectly bound payloads remain held. This repair is not source replay/cutover evidence.

## Test operations and external delivery

Source review on 2026-10-23 verified HaLo revision `299564ccc433a42f4093c415420559288253cbf6`. Its [test classifier](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/extensions/sdk/src/testOperation.ts#L13) splits `stationCall` into comma-separated callsigns, trims each call, and recognizes an exact `T` or `TEST` slash-delimited segment, case-insensitively. The marker can occur anywhere: `N0CALL/T`, `N0CALL/TEST/P`, `N0CALL/TEST/OP1`, `TEST/N0CALL`, and bare `TEST` qualify. `N0CALL/TESTER` and normal portable/mobile modifiers do not. Individual slash segments are not separately trimmed. Any matching call makes the whole operation a test.

HaLo's [operation getter](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/packages/halo_core/lib/src/models/models.dart#L98) derives this classification only from `stationCall`; it does not read `operatorCall`, `their.call`, or a stored test flag. Its [LoFi serializer](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/packages/halo_core/lib/src/sync/sync_engine.dart#L1207) sends the original operation/QSO data plus identity and deletion/purge fields, without adding the derived classification. Test records still sync through LoFi. In HaLo's [write policy](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/packages/halo_core/lib/src/repo/write_policy.dart#L76), attached contacts use their operation's test status; only operation-less contacts use `our.call` independently. `purged` describes deletion state, not test status.

HaLo still allows [exports, marked “Testing” in filenames](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/extensions/sdk/src/exportNames.ts#L121), and [self-spots, with trailing `/T` rewritten to `/TEST`](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/app/lib/services/extensions/extension_hook_api.dart#L203). Its behavior therefore establishes the classifier, not a blanket prohibition on external activity.

Ferry's delivery policy retains imported source records and shows affected contacts in review as **Test — not exported**. It applies HaLo's marker rule to the base operation and additionally protects effective segment station calls and explicit QSO station fields; loose contacts also use canonical `our.call`. These additional checks are Ferry policy, not claims about HaLo's operation getter. Test classification blocks staging and dispatch, cancels only unsent attempts, and preserves existing external delivery history and reconciliation evidence. Encrypted payloads still follow normal retention limits; compact test status survives expiry without requesting repair solely for a known test contact. A later source edit requeues classification normally.

Migration `0020_test_operation_review.sql` requeues retained waiting/blocked contacts for classification and adds a database dispatch guard for known tests. It preserves raw source revisions, cursors, destination evidence and immutable attempts. Apply it before deploying this change to an existing database. Regression coverage is in `tests/projection.test.ts`, `tests/intake.test.ts`, `tests/review.test.ts`, and `tests/delivery.test.ts`. This source review and local coverage do not establish deployed behavior or live classification of the user's test operations; no live verification was performed for this change.

## Unverified boundaries and required inputs

- Supply a deliberately approved LoFi browser connection and a synthetic operation/general-log dataset to verify server responses, operation/QSO cursors, `anyClient` behavior, historical edits, equal-time pages, tombstones, account renewal, and cursor invalidation. The current code exposes `coverage: client-contract-only` until this is established.
- Client code supplies no immutable snapshot token or documented cursor retention interval. A completed inventory alone is insufficient evidence for historical absence. Keep coverage-dependent backfill disabled until a live source cutover/replay experiment establishes the necessary boundary; overlapping rescans are mitigation, not proof of a snapshot.
- Null-operation QSOs are represented and projected when they contain their own station context. A selective UUID reread endpoint was not established. Preserve their encrypted records temporarily within the configured retention ceiling while work remains unresolved; expiry must produce a visible reconciliation exception.
- A non-null operation cannot be projected until the current operation and its complete event timeline have been obtained. Missing/purged/partial context must not fall back to a default station. `operationQsosPage()` implements the Sidecar-documented operation-QSO GET path with independent `syncedUntilMillis` pagination and optional retained `syncedSinceMillis`. It preserves event/tombstone rows, requires server timestamps and explicit completion counts, and blocks stalled descending cursors. It can recover event context, while the server replay/snapshot boundary still needs live validation.

Reproduce focused checks with `npx tsx --test tests/lofi.test.ts tests/projection.test.ts`. They use synthetic records and injected fetch responses; they do not establish live LoFi behavior.

## Durable integration checks

`tests/intake.test.ts` exercises actual D1 transactions for raw-page/checkpoint rollback, overlapping poll leases, monotonic server-stamp merges, conflicting timestamp ties, and stale composite-generation rejection at observation and staging. Operation rereads have durable epoch membership across pages. A missing prior event after a complete reread remains an unresolved operation, with bounded fresh rereads; Ferry does not invent a tombstone or fall back to base location. Unrelated operations and general-log contacts continue after normal forward intake completes. Source tombstones cancel only prepared attempts and leave an immutable audit event.

Encrypted contact payloads expire after seven days and necessary operation/event payloads after thirty days. Compact UUID, operation association, server watermark and revision metadata remain so a later old read cannot resurrect an older source revision. Event-only expiry requests that operation's reread; an expired base-operation payload needs source replay because a selective base-operation GET was not established. A body cannot be used merely because its metadata survives. Missing current data remains visible and unsent.

A genuinely new logical destination requests its own `rescan:<destination>` cursor. Its bounded historical backfill neither resets the ongoing forward cursor nor globally blocks existing stable contacts. Credential renewals, same-destination reconnects and template versions do not request this scan. Each recovered contact still follows normal adoption, absence-evidence and quiet-period rules. Explicit unique routing creates ledger work only for the applicable destination. A source callsign change retains the old association visibly, preserves its narrative/provenance, and cancels only unsent old-route attempts; it does not delete remote history. Returning to an unchanged adopted route restores its prior baseline without inventing an export.

Destination fingerprints explicitly select their source fields. Internal context-generation counters, polling changes and source synchronization metadata cannot reset the quiet period. Additional regressions cover this integration boundary, not only isolated projection examples. These local tests establish application behavior; production absence/backfill still requires the source replay evidence above.

## Bounded live access check

On 2026-10-22 a narrowly scoped probe found a preexisting Sidecar browser identity locally and issued exactly one live `GET /v1/accounts`. LoFi returned **HTTP 401**. The probe blocked registration, token renewal, approval-email requests and all source-write endpoints; it did not modify the saved credential file. No sync or operation pages were read, and no source operation/QSO mutation arrays were sent. Diagnostics retained only the fixed endpoint category, HTTP status and the zero-page result; no secrets, account IDs or contact data were recorded.

The saved bearer alone therefore did not establish current approved access. This first failed check established only the unauthorized response and the probe's stop boundary; the separately authorized renewal and bounded read follow below.

A separately authorized follow-up renewed only that existing client identity in memory. `POST /v1/client` with the existing key and secret returned HTTP 200; no name, new identity, account change or permission-email request was submitted, and the credential file remained unchanged. `GET /v1/accounts` then returned HTTP 200.

The follow-up made five requests total (one renewal, one account read, two sync pulls, one operation read). Both sync windows requested limit 5. The first pull returned five operations and five QSOs, both opaque cursors present, with incomplete coverage. After constructing a new client and reusing the serialized checkpoint in memory, the second pull returned zero operations and zero QSOs while still incomplete, retaining its cursors without advancement. This directly supports Ferry's rule that an empty page does not establish completion; the cause of the empty response was not independently established. A bounded read of one returned operation produced three QSO rows with explicit completion, so no second operation page was needed. None of the small samples contained a null-operation row, event or tombstone.

This verifies the inspected account response, same-identity renewal, basic sync cursor issuance/resumption, empty-incomplete response handling and one operation read against the live service. It does not establish an immutable snapshot, forward historical-edit coverage, retention/expiration guarantees, large timestamp ties or deletion behavior. Those rollout experiments still need deliberately scoped records and complete replay/cutover evidence. Source mutation arrays remained absent in every request; only redacted status/count/cursor-presence diagnostics were retained. No personal source rows, identifiers or credentials were checked in.

Detected pagination refusal/stall now checkpoints a bounded `gap:` breadcrumb, resets only the affected source stream to read-only backfill, and invalidates projection coverage before any new staging/dispatch. Original mappings, baselines, immutable attempts, UUID births and destination cutovers remain. Ordinary transport outages do not reset progress. Gap breadcrumbs expire after thirty days. Restored UUIDs and first-seen tombstones reserve historical births; a recovered scan cannot declare them new merely because they reappeared. A prepared payload waits for matching current source coverage; a meaningful newer destination input cancels only unsent work, retains the original template binding, and records the cancellation. Already dispatched outcomes still require reconciliation.

## Source-boundary audit and personal canary preparation

The 2026-10-23 source review still does not establish the server boundary. HaLo's pinned [sync engine](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/packages/halo_core/lib/src/sync/sync_engine.dart#L1255) describes row cursors, strict timestamp fallback windows and one-millisecond overlap when a cursor page ends inside a tie. It also sends deletion/purge flags and null-operation membership. These are client compatibility evidence. They do not specify an immutable snapshot, minimum cursor/tombstone retention, or exhaustive replay after an outage. Ferry's `records_left: 0` handling therefore continues to report `client-contract-only`.

The standalone [source-boundary audit](../scripts/source-boundary-audit.ts) exports one parameterized SELECT for one tenant/source and an explicit observation time. It has no database/network runner and loads no credentials. An approved protected reader binds `sourceBoundaryAuditQuery(tenant, source, now).params` to its `.sql`, then passes the single result to `sourceBoundaryAuditReport`. The report copies only fixed integer aggregates and always returns `sourceBoundaryVerified: false`. It never returns UUIDs, raw records, ciphertext, credential versions, account identifiers or cursor tokens. Do not log the input parameters or the reader's raw error text.

The audit separates deleted operation tombstones from nondeleted pending operations, reports current payload and operation/event dependency availability, and checks local birth-generation, scan and gap metadata. `reread_eligible_metadata_operations` covers the row predicate only; it does not assert available request budget, credentials, lease or turn time. `context_complete` and `context_sync_complete` describe the canonical sync page, not every operation's event timeline. Required destination rescans follow the existing cutover rule: the destination either predates the initial inventory epoch or has its own completed rescan. A retained gap is a review signal, and zero retained gaps cannot establish that no earlier gap occurred because breadcrumbs expire. Likewise, counts of retained tombstones establish only those observed tombstones, not all deletions the server has ever accepted. Known test contacts can retain compact status without a current payload and are excluded from candidate payload/dependency counts.

The audit is observational: it changes no cursors, births, generations, cutovers, queue state or gates. Fixtures cover 41 deleted pending operations with zero eligible rereads, missing/expired/revoked event context despite complete sync, tenant/source isolation, missing births, required rescans, and fixed-field output. Reproduce them with `npx tsx --test tests/source-boundary-audit.test.ts`. They establish query behavior, not production results. A consistent audit can support selecting a small candidate cohort; it cannot authorize exports.

### Read-only production observation

At **2026-10-23T21:58:43.835Z**, the scoped aggregate audit ran against the sole active production source. Canonical sync was forward at generation 279; context generation 886 reported complete/sync-complete. It retained 4,154 contact rows (13 deleted), 218 operations (41 deleted, 177 available context rows), and 128 events (six deleted). There were zero missing QSO birth records, invalid sync-birth generations, missing/revoked/expired nondeleted payloads, retained gap markers or cutovers. Seven births were recorded as `forward_new`; that is local provenance and does not waive the unverified source boundary.

One of two destination rescans remained required. A follow-up aggregate SELECT identified LoTW as unfinished and QRZ as complete. Two non-test, nondeleted contacts had unavailable operation dependencies; both reference deleted operations, rather than pending operation rereads. There were zero pending nondeleted operations and zero eligible operation rereads. Keep those two contacts held until authoritative source context is resolved; repeated rereads cannot invent a live operation. These observations do not establish that all independently unknown server rows or tombstones were received.

The same read-only observation confirmed zero export attempts, zero mapped QRZ rows and one active account with one active passkey. The audit changed no production rows. All export gates remain closed and the source-boundary report remains false. Exact identifiers and source contents were not included in the retained report.

### Follow-up after scheduled rescan completion

At **2026-10-23T22:19:49.925Z**, a repeat aggregate audit found both destination
rescans complete and zero destinations requiring rescan. Forward generation was
282 and complete context generation was 898. Retained contact/event/operation
counts, zero missing births, available current payloads and the two deleted-operation
dependency holds were unchanged. Attempts and cutovers remained zero, with one
active account/passkey. The report still explicitly returns
`sourceBoundaryVerified: false`: completed local scans do not supply the server
replay, tombstone or retention contract.

### Evidence packet still required

Keep the following distinct in the personal canary record:
1. **Local integrity:** deployed revision and observation time; all seven export controls closed; the scoped audit; current source account identity verified in memory; and aggregate candidate classifications. Preserve exact candidate UUIDs only in the protected owner review/allowlist, never in repository evidence.
2. **Observed source replay:** independent expected UUID membership for the selected operation and its full event timeline, including any known tombstones; completed read counts; server-watermark comparisons; and repeated-page/resume results. A matching second read establishes observed repeatability for that sample. A missing expected UUID falsifies completeness. Neither result proves that an independently unknown historical UUID never existed.
3. **Server boundary:** a primary server contract or controlled, separately authorized experiment covering a historical QSO edit, base-operation edit, event edit/delete, QSO/operation delete or purge, null-operation contact, same-millisecond page boundary and a mutation during initial inventory. It must exercise the deployed versioned all-client forward path, not merely establish backfill discovery. The earlier `anyClient:false` requirement belonged to the replaced reader policy. Record what happens when a saved cursor is rejected or aged, the oldest supported replay position and tombstone retention. A finite experiment establishes only its tested duration; do not invent an indefinite retention guarantee.
4. **Selected-contact freshness:** current unrevoked QSO/base/event bodies, exact projected station and destination identity, unique destination-history outcome, and a current immutable source proof for the approved UUIDs. The deployed mandatory path obtains bounded sync positives and a final canonical drain; it does not assume a selective UUID endpoint or unrestricted operation REST history. This source packet does not replace outbound collision claims, station/signing acceptance or explicit vendor-write authorization.

### Bounded read-only replay plan

The initial aggregate audit made no vendor requests. The bounded plan below was subsequently exercised in the [observed local and live comparisons](#observed-local-and-live-comparisons). The first proposed probe uses an existing small, non-test operation whose independent expected UUID/event/tombstone set is available. Root must review the operation and request reservation before execution. Use the existing approved identity and the existing shared LoFi background budget; do not create or relink a client, request permissions, reset a production cursor or raise a quota. Start with at most four vendor reads, 25 rows per page and a 120-second overall bound. Stop on admission denial, cooldown, authentication failure, unexpected account identity, malformed response, repeated/nonadvancing cursor, response-size limit or the read/time cap. Incomplete is a result, not permission to increase those bounds automatically.

Use an allowlisted transport that admits only the selected operation-QSO GET and, if separately included in the four-request plan, `POST /v1/sync` containing only the approved `meta.inboundSync`, account check and read windows. Deny mutation arrays, claims, client/permission endpoints and redirects before network dispatch. A copied cursor stays in memory and never passes to `Store.checkpoint`; do not use `pollSource` or `rereadOperation`, which persist normal intake state. Stop rather than silently renew an expired bearer in this probe. Normal atomic vendor-budget reservations/cooldown counters are the only permitted production writes by the protected runner.

Compare UUID, operation membership, server timestamp, deletion/purge and event classification in memory. Retain only counts, fixed failure codes, completion/cursor-presence booleans, elapsed time and comparison outcomes. Do not persist raw responses, decrypted payloads, credentials, UUID lists or opaque cursors. Capture the protected D1 metadata before and after to distinguish legitimate concurrent intake from a replay discrepancy. If the operation requires fewer reads than the cap, replay its first completed window or resume a serialized in-memory checkpoint to test repeatability. If it needs more reads, report the bound and obtain a separately budgeted continuation; do not call a partial operation complete.

This targeted probe verifies one operation's observed response and adapter behavior. A whole-account shadow inventory would need its own bounded, resumable, protected read plan and independent expected UUID set. It cannot be replaced by comparing two aggregate counts. Without the server-boundary evidence above, `SOURCE_BOUNDARY_VERIFIED` remains false even if the targeted probe and every local fixture pass.

### All-client inventory audit and remaining read-policy work (2026-10-24 UTC)

The [resumable inventory audit](../scripts/source-inventory-audit.ts) reads two
independent full `/v1/sync` backfills with `anyClient:true`, comparing their
operation/contact/event identities and versions against separate HaLo and Ferry
manifests. Each continuation permits four actual reads over 120 seconds, with
200 requested rows per stream, a 2 MiB response cap, bounded tie expansion,
10,000 retained metadata rows and a 90-minute total age. Scope and credentials
must remain current. Private checkpoints contain metadata and opaque cursors,
never credentials or QSON bodies; production intake cursors are untouched.
Budget denial before dispatch consumes no read attempt.

The first successful continuation ended at 01:47:15 UTC after four reads and
77.929 seconds. It retained 1,018 records: 218 operations, 795 contacts and five
events, including 46 deleted records. Five duplicate observations and four
timestamp ties were consistent; no page expansion occurred. Both inventories
were incomplete at that checkpoint, so it was progress rather than completeness evidence.
The checkpoint is durable; source mutations and production cursor writes were
zero. Future continuations must retain the same scope and the shared vendor
budget. All source-boundary and write-authority flags remain false.

At 02:10:56 UTC, 24 total reads had accepted 23 pages and completed the first
pass: 4,500 records, including 218 operations, 4,154 contacts, 128 events and
60 deleted records. Ferry matches all identities, flags, membership, application
versions, server stamps and revisions. HaLo has 13 fewer contacts, 3,247 differing
server stamps and 180 unknown versions; shared flags, membership and application
versions agree. Both independent local snapshots remained stable through the
first comparison. The second server pass then had 400 records and was incomplete.
No source mutation or production cursor write occurred.

At **02:41:09 UTC**, both inventories completed with **4,500 records each**.
They matched each other and Ferry exactly across identities, membership, flags,
application versions, server stamps and revisions. Across 46 attempts, 44 pages
were accepted; 100 duplicate observations and 306 timestamp ties were consistent,
with no expanded page. HaLo and Ferry snapshots stayed stable. The HaLo comparison
still reports 13 additional server contacts, 3,247 differing server stamps and
180 unknown versions, with zero missing local UUIDs and no shared application,
flag, membership or known-revision differences. The overall report remains
`discrepancy`, rather than rounding unknown/different metadata into agreement.

At **02:42:27 UTC**, the [all-client forward probe](../scripts/source-all-client-forward-probe.ts)
returned `observed_match`: two complete passes over 20 known-positive targets,
ten operations and ten contacts, using two network reads. Missing, changed,
unexpected and repeat-different counts were all zero. The sample contained no
events, deleted records, duplicates or tied server stamps. The completed baseline
remained stable and current scope was verified; positive delivery was observed.
This does not establish account-wide membership, continuous forward coverage,
writer provenance, unknown historical purge exclusion or source-boundary
authority. All those report flags and `writesAuthorized` remain false. Neither
diagnostic mutated source/vendor records or production cursors; only protected
local audit checkpoints and ordinary shared request-budget counters changed.

Independent HaLo metadata contains fractional historical server stamps and some
missing stamps. The audit preserves those values exactly and reports version
differences or unknowns; it never rounds them into agreement. Live sync cursor
and remote checkpoint stamps remain integer-only, matching the existing adapter.

Primary implementation notes identify two further boundaries. The maintainer
corrected [HALO-454](https://cabo.ham2k.com/halo/c/454) to say REST reads use
`cutoff_in_days`, while the sync controller has no such cutoff. Thus a complete
operation-QSO REST response does not by itself prove full historical membership
for every account plan. Earlier exact positive observations remain valid.
[HALO-609](https://cabo.ham2k.com/halo/c/609) reports that `anyClient:false` can
exclude rows whose writer is NULL. The deployed timestamp correction described
in [HALO-770](https://cabo.ham2k.com/halo/c/770) does not establish that this filter
was fixed. [HALO-787](https://cabo.ham2k.com/halo/c/787) describes all-client
forward reads for claims; that alone does not prove deployed QSO/operation
behavior.

The [versioned all-client baseline and handoff](capacity-plan.md#implemented-versioned-all-client-source-baseline-and-handoff)
is deployed in signed revision `ce238cdcfea72ed5cbc7b624ec6a7efc01978154`, including
the five baseline commits through `339590e08e229b411f411d3878e921d4a02265df`.
The [first release CI run](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40055506398)
was cancelled after a delivery test fixture leaked `workerd`. Fixture fixes are
signed and pushed as `ce238cdcfea72ed5cbc7b624ec6a7efc01978154`, with
[replacement CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40057488314)
passing all 1,031 tests and required checks. Worker `aabdd51c-1665-480a-8806-fe993967bc27`
deployed at 03:28:48 UTC; independent 03:29 checks confirm all six gates closed
and 25 migrations. Recovered old rows remain
historical; unseen members are held, never inferred deleted. Migrations `0025`
and `0026` fence old canonical checkpoints, independent reread version changes,
staging, dispatch and cutover provenance after a policy is activated. Transitional
fences remain dormant for sources with no policy row, so main exports must require
current ready policy membership explicitly. The first scheduled run activated one
all-client policy at 03:30:43.295 UTC. The 03:31:37.477 snapshot showed backfill
with 25 operations and 25 QSOs in the current epoch, no ready policy and zero
eligible exports; baseline completion and handoff were not yet observed at that
time. The later completed handoff is recorded at the top of this document.
Fresh-positive collection, witness storage, completed-drain markers, immutable proofs, indexed
observation anchors and shared cohort coordination are signed and pushed through
`e16f987441fc`, with exact-key lookup correction `3d7b0cac782a`. All 1,098 tests
pass and the foundation deployed read-only at 04:13 UTC with migrations
`0027`–`0029`. At 04:18:08 the current epoch covered all 218 operations and 800
QSO-stream records, but the policy remained in backfill with zero eligible exports.
Mandatory stage/dispatch binding and scheduler integration deployed in
`5a416de5898657a6b12b60fd900d787f60341d51` at 05:11:14 UTC after all 1,131 tests
and required checks passed. Independent 05:11:28 checks confirm migration `0030`,
all six gates closed, no attempts/proofs/pins/cutovers, and 218 operations plus
1,750 QSO-stream records in the current backfill epoch. Migration `0030`
requires an immutable proof for the current account, credential, policy epoch,
source and reconciliation versions. Its dependency set contains the selected
QSO, base operation and every retained live event, including events that do not
change the effective projection. Fresh positives retain their original request
start times; proof expiry is no later than five minutes after the oldest one.
A qualifying final canonical drain and exact dependency reload precede minting.
Attempts pin the proof, and dispatch rechecks it after vendor-budget admission.
Known-unsent stale work can be rebuilt; dispatched or uncertain work and permanent
identity ownership remain retained.

The coordinator allows at most four actual source requests, including authentication
and the final drain, under the ordinary shared budget. Only a collection
`request_budget` hold can salvage fully witnessed contacts; other failures cannot
publish partial proofs. Remaining contacts receive a later singleton turn. If that
singleton again exhausts collection reads with no ready contact, an exact-version
ten-minute retry delay lets neighbors on the ordinary five-minute schedule proceed.
A single contact needing more than three collection reads remains held. These
bounded progress rules do not establish an upstream snapshot or general capacity.

At 04:51:11 UTC, the current epoch contained 218 operations and 1,425 QSO-stream
records, still in backfill with no ready source, eligible export, attempt, cutover
or temporary guard. Those historical counts preceded the completed handoff;
fresh proof and vendor evidence for the selected trial contacts remain prerequisites.
The 04:25 UTC protected backup passed an isolated restore with all 28 existing migrations plus pending `0030`, integrity and
foreign-key checks, three current credential decryptions and repeated quarantine;
380 identity claims and zero attempts/cutovers were preserved. No production
restore or vendor mutation occurred. Neither this backup nor the diagnostic reads
opens a gate or establishes future presence after a hard purge.

### Independent membership probe and conflicting purge evidence

The next source review inspected HaLo commit `eb1a54ced637bfdd3c5b361a31df0e843edf9867`. It found conflicting descriptions of LoFi purge behavior within that same committed client revision. The [database schema comment](https://github.com/ham2k/halo/blob/eb1a54ced637bfdd3c5b361a31df0e843edf9867/packages/halo_core/lib/src/db/database.dart#L35) describes server removal without replay to other devices, while the [operation merge guard](https://github.com/ham2k/halo/blob/eb1a54ced637bfdd3c5b361a31df0e843edf9867/packages/halo_core/lib/src/repo/operations_repository.dart#L549) describes retained purge records being redelivered. The latter prevents a received purge from recreating a locally absent operation. These comments establish neither a stable server contract nor a retention duration. A primary public `ham2k/api-lofi` repository was not accessible in the repository lookup, and scoped repository/code searches did not find the server contract. That search result does not establish that no contract exists privately.

HaLo's ordinary QSON export is not a complete independent membership source. Its [export loader](https://github.com/ham2k/halo/blob/eb1a54ced637bfdd3c5b361a31df0e843edf9867/app/lib/services/export_service.dart#L109) reads undeleted rows and filters event rows before passing contacts to the QSON serializer. A comparison against that export would miss exactly the deletion/event evidence needed here. The independent input must instead come from a read-only local database snapshot containing the base operation and all its QSO/event rows, including deleted and purged flags. Even this snapshot cannot recover purged rows already physically removed from that device; an independently retained earlier manifest would be required to test those UUIDs.

The new [source replay probe](../scripts/source-replay-probe.ts) provides three pure interfaces:
- `haloOperationManifestQuery(operationId)` returns a parameterized SQLite SELECT for one base operation and at most 101 member rows. The extra member makes an oversized operation reject rather than silently truncate. It reads only identity, membership, deletion/event/sync flags and revision/server timestamps, never raw QSON fields. This query is for the independent HaLo database, not Ferry D1.
- `haloOperationManifest(rows, capturedAt)` validates that metadata in memory. The protected runner must not log the returned manifest. It includes at most 100 members, and the probe rejects unsynced rows, snapshots older than five minutes, or an operation identity mismatch.
- `probeOperationReplay({ credentials, accountId, operationId, loadManifest, fetcher, now? })` verifies the existing account, then attempts two complete operation-QSO reads. `fetcher` must be the existing shared-budget transport; the probe does not create another quota. The default transport permits only those GET routes and rejects renewal/registration and all POSTs. An explicit `observeBaseOperation` option instead brackets the member reads with two account-checked, read-only `/v1/sync` requests for the newest 25 base operations. That option permits only the exact metadata-only request shape, with no mutation arrays or production cursors. Both modes retain the four-attempt, 25-row/page and 120-second bounds. A target outside the bounded base window is unobserved, never absent. The probe serializes each in-memory page state and recreates the client between pages. No production checkpoint, source state or credential is written. The protected runner rereads the independent manifest after both passes to detect local changes.

The returned report contains only fixed counts, booleans, elapsed time and allowlisted stop reasons. A complete pair of identical server reads still reports a discrepancy if an independently known event, contact or tombstone is missing. Conflicting duplicate UUIDs, changed versions, membership drift and changed local snapshots remain visible. Partial pages, cooldowns, request/time limits and missing revision stamps cannot produce `observed_match`. Errors never include response text, URLs, UUIDs or credentials. Synthetic coverage is in [source-replay-probe.test.ts](../tests/source-replay-probe.test.ts), including SQLite snapshot membership, deletion/purge omissions, timestamp ties, partial/expired reads, account/authentication failures and redaction.

The smallest live plan is one already-synced, non-test operation with no more than 25 total members, preferably containing both an event and an ordinary tombstone: one account read and two operation reads, with a fourth read available only for an unexpected continuation page. The runner must first select it from protected metadata and approve this exact plan against the shared background budget. A larger operation, an independently known purge, or a shadow forward window needs a separately reviewed request plan; the probe cannot expand itself. No live request was made while implementing this tool.

This can establish recent observed member/version agreement for an exact operation and falsify omissions. The GET-only mode reports `serverBaseOperationObserved: false`; the optional base mode sets it only after observing the selected operation twice. Both retain `unknownHistoricalPurgesExcluded: false` and `sourceBoundaryVerified: false`. The operation-QSO endpoint alone does not prove that its base operation still exists or is unchanged, and identical rereads cannot prove delivery of unknown historical purges. Base comparisons separately count flag, application-revision and server-stamp differences; overlapping differences still count once in the aggregate per observation. A personal UUID trial could use this as one part of a narrowly scoped freshness proof, alongside a fresh base-operation read, independent current source review, destination uniqueness and the existing commit/dispatch fences. It does not justify changing the global replay-boundary gate. Any future per-UUID trial authorization must bind its own evidence, versions and short validity window rather than relabeling this observation as a general retention guarantee.

### Observed local and live comparisons

A protected read-only comparison on 2026-10-23 found 218 operations and 4,269 QSO/event rows in the independent local HaLo database, all marked synced, versus the same 218 operations and 4,282 QSO/event rows in Ferry. No local UUID was missing from Ferry. After normalizing operation membership representations, the shared rows had no operation-membership, deletion-flag or event-classification disagreement. Ferry had 13 additional contact rows absent from both the local live table and every local `qsos_backup` UUID; all were waiting under present, nondeleted, non-test operations, with none in the general log. Their absence from the independent local snapshot remains unexplained, and no deletion was inferred or repair applied. The local snapshot contained no purged rows, so this comparison supplies no purge-replay sample. These are observed local-to-retained membership results, not a complete server inventory, source freshness proof, or retention guarantee; private UUIDs and payloads were not retained in this document.

At 23:32:10 UTC on 2026-10-23, the protected runner completed the bounded live probe for one small, synced, non-test operation. It made three GET requests: the account check and two complete operation-QSO passes. Both passes matched the independent before/after manifest's two ordinarily deleted contacts, with zero missing, unexpected or changed members and no unknown revision stamps. There were no events, purges, duplicate rows, timestamp ties or differences between the repeated reads. The independent snapshot remained stable; source mutations and production cursor writes were both zero. This establishes observed ordinary tombstone replay for that sample. It does not test event/purge delivery, establish any retention interval, or verify the base operation through the server. All source-boundary authority flags remained false.

At 23:44:24 UTC, a separately budgeted three-GET probe repeated the comparison
for another small, synced, non-test operation containing ten members, including
four events. Both complete passes matched the stable independent manifest with
zero missing, unexpected, changed or unknown-version members. That sample had
no deleted or purged members, duplicates or timestamp ties. No source mutation
or production cursor write occurred. This adds observed event membership/version
agreement; it does not establish event edits/deletes through forward sync,
base-operation freshness, purge retention or a general replay guarantee.

### Current server positives and base-operation checks (2026-10-24 UTC)

The thirteen additional Ferry contacts all belong to one present, nondeleted,
non-test operation. Its independent local base exists but has no members. Three
local daily database snapshots also contain none of these contacts, and the
client's stored sync markers report a completed full sync with no remaining
backfill cursors. Those markers do not prove that this local copy is exhaustive.

At 00:19:49 UTC, the protected GET-only probe checked the account and read that
operation completely twice. All thirteen retained Ferry contacts were present
and unchanged in both server reads. There were no missing, changed, unstable or
unknown-version retained suspects, and both local and retained before/after
snapshots remained stable. The independent local expected set still had zero
members, so the probe correctly reports thirteen unexpected members and a
discrepancy. Retained suspects are a separate comparison input: adding them does
not rewrite the independent expected set or turn the result into a match.
Source mutations and cursor writes were zero. This resolves whether the extra
Ferry contacts currently exist on the server; HaLo's local omission remains
unexplained and supplies no deletion instruction.

The opt-in base mode was then exercised with an explicit four-read plan: a
read-only sync window, two complete member reads and a second read-only sync
window. An initial candidate was outside the newest 25 base rows; the probe
stopped after one read as incomplete instead of expanding its scope. At
00:25:26 UTC a current-window candidate was observed twice. All 23 independent
members matched both reads, with no events, missing/unexpected/changed members,
duplicates, ties or unknown versions. The server base was stable between reads,
but disagreed with the independent local base in both observations. That result
remained a discrepancy at that checkpoint. No source mutation or production
cursor write occurred.

At 00:58:58 UTC a four-read follow-up compared the same independent local
manifest, the fresh server base bodies and Ferry's retained base revision before
and after the probe. All 23 members again matched both complete reads, with zero
missing, unexpected, changed or unknown-version members. The local/server base
differences were exclusively server timestamps: deletion flags and application
revisions agreed. Ferry's exact base-body revision hash and server timestamp
matched both fresh server observations, and its stored revision, timestamp and
deletion state stayed unchanged. The independent local snapshot was also stable.
This establishes current Ferry/server base agreement for this one operation and
isolates its local discrepancy to HaLo's stored server timestamp. The independent
comparison still correctly reports a discrepancy; neither the local manifest nor
the report was rewritten. Four network reads, zero source mutations and zero
cursor writes occurred. This sample does not establish completeness for all
operations, forward delivery or historical purge exclusion.

Maintainer implementation notes in HALO-557 describe ordinary web deletion as
an integer `deleted: 1` tombstone with a newer server sync stamp, potentially
without a new application timestamp. Two additional intake regressions cover
contact and operation deletion under that pattern, equal-server-stamp conflicts,
cancellation of prepared work, and retention of dispatched uncertainty and
permanent identity claims. Existing intake behavior passes those checks.

The maintainer decision in HALO-683 describes hard deletion without tombstones
as intentional for test-only purges, with orphaned test records on another
device tolerated. This explains the conflicting client comments as design
intent; it does not verify the currently deployed server revision or provide a
general tombstone-retention guarantee. Nor does test-only eligibility prove that
each removed record was always a test: a real operation could change into test
status before purging, leaving another client with stale eligible-looking data
if it misses that transition. Unknown non-test historical deletions, forward
replay, cursor aging and source-wide base/context completeness still need evidence.
All source-boundary authority flags remain closed.

The [forward replay probe](../scripts/source-forward-probe.ts) implements two
known-positive forward reads using independent operation/QSO server watermarks
and `anyClient: false`. Its input requires independently verified account and
reader identity, a last-writer client key different from Ferry for each known
record, and fresh before/after manifests. A local synced flag cannot substitute
for writer evidence. The probe permits only the exact metadata-only sync body,
denies renewal, shares the injected vendor budget, and never checkpoints a read.
It limits the run to four attempts, 25 records per stream/page, 100 retained
metadata records per pass and 120 seconds. Input windows are at most 24 hours
old; independent manifests are at most five minutes old. Empty, partial,
changed, missing, unknown-version or unknown-writer evidence cannot pass.
Incidental records are compared separately and never turn the known sample into
an account-wide membership claim. All write, boundary, membership and historical
purge-exclusion flags stay false. Its 68 focused tests and independent review
passed. This client-filtered probe has not run live: independently verified writer
provenance or a separately authorized controlled edit is still required. The
separate all-client probe observed the bounded positive replay described above
without claiming writer provenance.

The existing global source gate also permits source-wide cutover creation; a
UUID allowlist does not narrow that effect. The 05:40 UTC release independently
pins a default-off QRZ first-insert authorization mode. It requires mandatory
current per-contact proofs and excludes source-wide cutovers, no-query inference,
LoTW, replacement and corrections while the global source gate remains closed.
All seven production controls are verified closed. These observations are not
a global retention guarantee, and neither the probes nor the new mode's deployment
authorizes a vendor write. Baseline completion is observed; the later 08:12
diagnostic below also establishes one current proof and fresh same-contact QRZ
observation, without establishing global boundary authority.

The 06:09 UTC release added bounded 100-record canonical baseline pages under
the unchanged shared request budget. Production completed backfill, a forward
drain and quarantine at 06:35:44.881 UTC. All 4,500 retained rows were witnessed
in the current epoch, with zero unseen rows; the ready policy permits ordinary
reconciliation of 4,130 eligible contacts. This establishes that observed
baseline/handoff, not historical purge exclusion or export authority.

The 06:35:43–06:36:10 scheduler run resumed reconciliation with 62 contact turns
and 60 destination classifications in 27.187 seconds, then stopped at the
`database_budget` limit with four errors and 50 deferrals. The run created no
export attempt or cutover. These are processing counts, not completed deliveries
or sustained capacity acceptance.

At 06:43:26 UTC, a protected selected-contact diagnostic made one live collection
read and one final canonical drain, without bearer renewal, for four required
dependencies including two events. The source checkpoint and local ledger
observation completed, but the atomic proof batch failed with
`SQLITE_CONSTRAINT_CHECK` / `proof_cohort_count`; the coordinator returned
`proof_unavailable` with zero ready contacts. The failure remains under diagnosis,
not evidence that any guard should be relaxed. Both independent gate attestations
confirmed all seven controls closed; attempts, stage guards and cutovers were
zero before and after. No upstream source or destination mutation occurred.
No fresh QRZ neighborhood result is available at this checkpoint. A successful
current proof and fresh destination evidence remain required before any separately
authorized write; no source-boundary authority was granted.

The 06:49:44 diagnostic again failed the atomic mint count guard. A SELECT-only
post-rollback evaluation of the exact proposed proof against the installed
current-proof view passed all 21 conditions, including dependency versions and
ledger/reconciliation versions. That later observation does not prove the failed
transaction saw the same conditions; the outer lease/filter checks and transaction
timing remain under investigation. The 06:50:20 QRZ-only diagnostic stopped in
its SQL validation before any QRZ request. It supplied no absence evidence and
made no database mutation; seven controls remained closed and attempts, stage
guards and cutovers stayed zero.

At 06:54:26, the same post-rollback diagnostic also passed every outer mint
filter and lease check. D1's observed clock was 55–103 ms behind the local Node
clock; the original proposed proof's creation time had become valid by the
later SELECT. This is consistent with a clock-admission race, but does not prove
the failed transaction's clock or the deployed Worker's behavior. The protected
diagnostic can now wait at most 500 ms, using at most two D1 clock/lease checks,
before submitting the original atomic batch once. It never rewrites timestamps,
extends expiry, relaxes predicates or retries an uncertain mutation. This remains
a diagnostic-only option, not a production clock fix.

The 07:05:07 diagnostic stopped earlier, at `page_bound`, after one collection
request and before its final drain or mint. HaLo's
[pinned sync implementation](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/packages/halo_core/lib/src/sync/sync_engine.dart#L1413)
allows a cursorless page to expand across an entire edge millisecond. Ferry's
25-record collector ceiling rejected the expanded response. Signed
`a8ba8dd92a15` introduced a bounded 100-record collector. A reviewed follow-up
keeps nominal requests at 25 while accepting up to 100 per stream: requesting
100 can reach another timestamp group and exceed the response ceiling even
when the required positives arrived first. The final refinement is committed
locally but awaiting 1Password signing; neither change is deployed yet.
All 1,184 tests and required local checks pass for the final collector behavior.
The collector has a combined 1 MiB parsed-record limit and the existing 2 MiB
transport limit.
Both streams validate before any new witness is published. Larger ties still
hold; Ferry never truncates them or fabricates a continuation cursor. The four
actual requests, reserved final drain, 120-second deadline and exact proof
requirements remain unchanged. Deployment and a fresh same-contact check are
still required at this checkpoint.

### Diagnostic admission correction (2026-10-24, 08:08 UTC)

Two SELECT-only attempts found no candidate under the diagnostic's original
precheck. Query-only analysis of the verified 07:56 backup identified the exact
cause: all 430 structurally eligible QRZ rows were due and passed policy membership,
retained-body, credential and operation checks, but their ledger context versions
lagged the current context cursor. This is not evidence of a new runtime export
defect. Normal reconciliation refreshes the projection before export eligibility;
the deployed source coordinator also observes the refreshed projection after its
final drain and before atomic proof creation.

A protected diagnostic now admits one deterministic structural/current-member key
as a source-verification hint, tolerating only that old ledger-context mismatch.
It invokes the unchanged deployed coordinator under the normal cycle lease and
request budget. The original strict keyed selector and exact current proof must
pass after the refresh and again before QRZ; there is no candidate fallback.
This mode omits cache ranking, so its selected contact may have a QRZ neighbor.
It neither relaxes a runtime proof condition nor grants export authority.

The adapter passed 92 offline cases, strict TypeScript and independent review.
The 08:08:08 metadata-only plan selected one contact with two source dependencies,
zero events and no cached witnesses, using 12 SELECT statements and no vendor
request or write. The isolated checkout is pinned to deployed `02e3dc89`; its
generated assets matched production at 08:09:57 with all seven controls closed.
The 08:10:50 verification attempt respected the scheduled worker's cycle lease
and stopped at `cycle_busy`, before any vendor request or proof attempt.

An unsigned LoTW preflight against the same protected backup also found no
candidate satisfying its current-context precheck. It made one local SELECT and
no signature, vendor request or production write. This supplies no additional
certificate compatibility or ARRL acceptance evidence.

### Successful joint source/QRZ observation (2026-10-24, 08:12 UTC)

After the scheduled worker released its lease, the exact-deployed diagnostic
completed at **08:12:53.743 UTC**. One collection request supplied the two required
QSO/base dependencies, with no events; one final canonical drain qualified the
closure. The unchanged coordinator reloaded dependencies, refreshed the normal
ledger projection and minted an immutable proof in its original atomic batch.
Strict keyed eligibility passed after that refresh. Source verification used
53 D1 calls containing 78 statements, including eight mutating calls for ordinary
lease, budget, checkpoint, observation and proof operations, and took 8.650 seconds.
No proof guard was relaxed, and the deployed request/response bound remained 25.

The diagnostic clock-admission option made one clock/lease SELECT, observed D1
49 ms after the immutable creation time and required no explicit wait. That extra
I/O itself delays minting. This success does not establish that the earlier
failures were clock skew, or whether the scheduled Worker needs a clock change.

Only after strict keyed eligibility and the exact current proof passed did the
same process query QRZ. One targeted FETCH, one STATUS book verification and one
complete covering FETCH found zero neighborhood records and zero exact identities.
Final scope remained stable. After another independent closed-gate attestation,
the original keyed eligibility and proof remained current at **08:12:53.735 UTC**,
with 291,986 ms of proof lifetime remaining. All seven controls stayed closed;
attempts, cutovers, stage guards and vendor mutations stayed zero.

This is a successful expiring same-contact read-path observation, not an upload
test, event-bearing closure sample or global retention guarantee. The protected
08:14:29 backup preserves the new proof and its retention row and passed isolated
restore plus repeated quarantine. The later unsigned LoTW snapshot check is
recorded separately in [LoTW evidence](evidence-lotw.md).
