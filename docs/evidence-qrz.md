# QRZ and template implementation evidence

Initial implementation review: 2026-10-22, using documentation and synthetic fixtures. Subsequent observations are dated below. The singleton and checked pairs C/D2 account for five acknowledged QRZ INSERTs with populated recovery and unique neighborhoods. The observed returned minute/sideband representations are accepted; seconds remain unverified. Automatic exports remain disabled.

## Current checked QRZ acceptance — D2, 2026-10-25 UTC

The singleton and checked pairs C/D2 now account for **five delivered QRZ ACKs**.
D2's exact five-attempt/four-artifact recovery and complete unique ACK
neighborhoods pass. The separate known-ACK assessment accepts same-minute time
and the observed sideband representation; all other transmitted fields match
literally. Original literal holds and unverified seconds remain unchanged.
These observations do not loosen uncertain-result matching or permit retries.

All eight controls are closed on c88d413e/schema 37. See the
[D2 deployment checkpoint](deployment.md#accepted-trial-d2-and-current-closed-state-2026-10-25-utc) for the current Worker and detailed
recovery/readback hashes. Pair E, the unresolved scheduler exception and
full-window verification remain open. Wider-window recovery and all-member
observation are still offline; actual window validation remains pending; automatic QRZ and LoTW stay off.

## Earlier scheduled checkpoint — 87e87b2d, 2026-10-25 UTC

The finite-scope scheduling correction is deployed in signed `87e87b2d`, with
**1,666 tests** and [exact-release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40165603166)
passing. Trial B's two exact QRZ contacts both reached live selection at
**06:01:30 / 06:01:45 UTC**. One held for incomplete history and the other for
`source_export_proof_read_failed`; **zero attempts or vendor writes** occurred.
The scope closed at **06:05:54.576653 UTC**; independent **06:11:34.594 UTC**
attestation verifies all eight controls closed. After at least 180 seconds of
drain observation, zero new attempts and **one unfinalized scheduler row** remain.
The **06:12:54.606 UTC**, **41,555,300-byte** recovery snapshot preserves the
original singleton and all immutable prior rows, with zero new artifacts and
passing integrity/FK/repeated-quarantine checks. See [deployment evidence](deployment.md).

Native Workerd reproduces the coordinator's invalid receiver on native `fetch`:
`options.rawFetcher(...)` throws `Illegal invocation` before outbound transport.
Signed fix `c88d413e52c8d3ebd5ed7bff4eab10ec6fbf2dd7` binds `globalThis`; the
actual-coordinator regression and 42 focused cases pass. Full checks and
[CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40168290537) were running;
the fix was **not yet deployed** at that checkpoint. It subsequently deployed
closed at 06:29 UTC. Trial C subsequently passed normal scheduled delivery,
populated artifact recovery and the separate known-ACK assessment above. The
earlier singleton's minute-consistent acceptance and unverified seconds are
unchanged.

## Earlier scheduled trial and recovery retention — 890f714c, 2026-10-25 UTC

Signed `890f714c` deploys migration `0038`: original encrypted attempt artifacts
survive terminal outbox cleanup with unchanged AAD and seven-day expiry. All
1,663 tests, required checks and exact-release CI pass. Native cases cover ACK
purge, lost responses, atomic cohort rollback, expiry, old KEKs and populated
full-SQL recovery through two quarantines. The 37-migration PRE/POST recovery
preserves every prior immutable row and the original singleton host packet.

The first real two-contact scheduled trial made **zero attempts or vendor writes**.
Its policy change woke the whole backlog; the selected contacts remained eligible
behind unrelated due rows. The 05:10 UTC invocation processed 27 contacts and 22
cached classifications before a 93.097-second deadline, with no errors. This is
not scheduled export acceptance. After closure and drain, both runs are complete,
all eight controls are independently closed, and the 05:17 UTC backup verifies
exactly the prior one attempt and no new table artifacts. This led to the
finite-scope correction deployed in `87e87b2d`; the later trial is recorded above.

## Authorized singleton INSERT — 2026-10-25 03:55 UTC

The reviewed singleton completed normal source-proof, QRZ absence, ownership,
preparation and dispatch checks on exact deployed `0386af30`. QRZ acknowledged
**one INSERT** with a LOGID by **03:55:14.887 UTC**. Its immediate exact readback
was unresolved; no retry or additional INSERT occurred. All eight production
controls stayed closed, and the temporary preview was disposed.

The **03:56 UTC** recovery check verifies exactly one delivered attempt and
accepted receipt, its durable identity claim and source-proof pin. The normal
ACK path purged the database outbox; the original encrypted artifact remains
preserved and decrypts correctly from the protected pre-dispatch packet.
All baseline claims, historical owners, association markers and exact evidence
remain unchanged. Integrity/FKs, credential/key checks and two isolated
quarantines pass. Subsequent readback and its precision limits are recorded below;
the original unresolved literal-readback outcome remains unchanged.

## Known-ACK readback and duplicate absence — 2026-10-25 UTC

A separate read-only exact-LOGID FETCH verifies the intended book and the
acknowledged record. All **13 other transmitted fields match literally**,
including the full eight-character grid, coordinates, power, reports and complete
narrative. `TIME_ON` returns four digits matching the first four transmitted
digits, with the same UTC date. [ADIF permits four- or six-digit time](https://www.adif.org/316/ADIF_316_annotated.htm#Time).
This observation does not establish that QRZ preserves seconds internally or
that every QRZ read discards them.

The separate offline assessment requires the native accepted LOGID, delivered
receipt, permanent owner and exact claim links. It verifies the original payload
and populated recovery snapshot, and accepts only the observed same-minute
precision reduction with every other transmitted field literal-exact. All
**21 focused cases** and strict TypeScript pass. Literal equality and exact
seconds remain false; source seconds and original evidence are preserved.
The production uncertain/no-ACK recovery matcher is unchanged.

A later bounded STATUS plus complete CALL/band/date FETCH returns **one record,
one neighborhood candidate and one occurrence of the acknowledged LOGID**.
It uses the normal ±30-minute neighborhood, rejects incomplete pagination and
does not use the same-minute assessment to choose identity. All **10 focused
cases**, types and bundle checks pass. Both read-only previews are disposed,
with all eight production controls independently verified closed. No additional
INSERT or source request occurred.

This accepts the singleton at the precision returned by QRZ, with seconds
unverified. Migration `0038` now retains encrypted artifacts after terminal
outbox cleanup; actual scheduled batches still need approved-set recovery. The singleton's
one-INSERT allowance is exhausted; later batches use separate bounded scope.

The earlier two invocations stopped before any attempt or dispatch, as verified
by their independent recovery snapshots. An offline reproduction identified
the operator tool's omitted bounded history-covering SELECT: QRZ's ambiguous
empty selection triggered its fallback, which the tool's SQL allowlist denied.
The separate corrected packet adds only that read-only template with exact
tenant/source/destination and row-limit checks. All **32 execution, diagnostic
and inventory cases** pass, including full fallback preparation, one synthetic
INSERT, exact readback and replay denial. The deployed application source,
write permissions, budgets and factual recovery schemas are unchanged.

## Same-contact cloud checkpoint — f2c41cb3, 2026-10-24 22:03 UTC

The exact signed `f2c41cb3a929ae3d3545e235894027b84fbf09fb` modules, matching
production Worker `fc1f2a5b-13e0-4509-ba03-9c93856c6464` and all 36 migrations,
completed source-proof creation and QRZ absence observation in **one temporary
Cloudflare preview invocation**. The private handoff retained the same contact,
source/operation versions and route. Normal coordinator observation refreshed
stale ledger context; strict current eligibility, ownership exclusions and the
immutable proof then passed before QRZ reads. No stored state was forced to
make the contact eligible.

One positive collection and one mandatory final canonical drain covered **two
dependencies and zero events**. One native atomic batch minted the proof at
**22:03:22.388 UTC**. Three QRZ reads—one targeted FETCH, verified-book STATUS,
and a complete covering FETCH—observed **zero neighborhood records**. The
**same proof** remained current at **22:03:28.032 UTC**, with **293,053 ms** left.
The inner composition took **7.471 seconds**, **109 D1 RPCs / 135 SQL statements**;
these counts exclude preview startup, the separate nonce lease and host
attestation. The original **22:03:17.856 UTC** production receipt was reused
unchanged inside the Worker. Normal request limits, source leases, clock
admission, source timestamps and proof guards remained in force.

The preview was disposed. Independent attestation at **22:03:29.573 UTC**
reconfirmed the same sole production Worker and all **eight controls closed**.
Attempts, stage guards, source-proof pins and cutovers remained zero, as did
signatures and vendor mutations. Normal guarded source observation, proof,
lease and read-budget bookkeeping did occur. The **21:53:13.701 UTC** pre-run
backup contains 42,485,324 bytes and verifies all 36 migrations, three
credentials, the tenant key, **3,327 exact ownership copies** and **2,702 QRZ
owners/markers**, with integrity/FK checks and two isolated quarantines.

The **22:04:34.745 UTC** post-proof backup contains **42,608,702 bytes** and all
36 migrations. It verifies all 3,327 exact ownership ciphertext records, three
credentials and the tenant key, integrity/FKs and two isolated quarantines.
The new **one immutable proof and matching retention row** survive unchanged;
attempts, both pin tables, cutovers and raw LoTW references remain zero. The
snapshot has 2,766 QRZ owners/markers and complete ownership coverage with no
pending, held or unhashed inputs. The separate **22:05:47.352 UTC** immutable
comparison uses the **21:28 UTC baseline**: all original 3,327 claims, 2,689 QRZ
owners and markers, and 3,294 exact evidence records are unchanged in every field,
with zero missing rows. The post-proof snapshot adds 77 QRZ owners/markers and
33 exact copies. This is isolated recovery and comparison to that earlier
baseline, not a production restore or an all-row comparison to the 21:53 snapshot.

The first host launch stopped because its public provenance manifest exceeded
the default 64 KiB input limit, before any live attestation, preview, nonce,
database or vendor call. A reviewed fix gives only that public manifest a
128 KiB cap; private candidate/receipt and Worker limits are unchanged. The
first actual preview then returned known `cycle_busy` at **22:02 UTC**, with
zero source or QRZ requests. Once the ordinary source lease was available,
a fresh explicit context plan retained the same candidate before the successful
invocation. Neither stopped run supplied absence or proof evidence.

This is finite cloud execution of the deployed modules, **not scheduled-Worker
proof-path validation, universal source completeness or first-INSERT
acceptance**. A later authorized write must obtain current evidence again
through normal preparation and dispatch. The owner's instruction remains
**keep exports disabled**; this read-only success grants no trial authority.

## Snapshot historical exceptions — 2026-10-24 21:36 UTC

A protected offline replay examined all **606** QRZ hold routes in the verified
**21:36:47.379 UTC** f2c backup using the exact deployed classification code and
retained source/history evidence. It found **47 forward- and reverse-unique
positive candidates**, **539 current holds**, and **20 incomplete comparisons**:
19 lacked complete inventory and one lacked a required reverse-source body.
The 47 positives were not committed or checked for final ownership/adoption
authority. These counts do not establish that every remaining route is a manual
exception, nor do they describe a fresh vendor read.

Of the current holds, **349** first failed latitude comparison despite compatible
grids. Separate geometry analysis covers **523** forward-unique held pairs.
All **359** available source-coordinate pairs are syntactically valid and inside
both compatible grids. **343 of 523** retained remote-coordinate pairs lie
outside their own grid, including **274 of the 359** pairs with source coordinates
and compatible grids. No retained remote point matches its own or a supported
parent-grid center, exactly or at its recorded precision. All observed coordinate
components have three fractional-minute digits; comparisons use signed ADIF
degrees plus minutes, not decimal degrees.

This establishes inconsistent retained location evidence and does not support
the own/parent-grid-center hypothesis in this snapshot. It does **not** establish
GPS accuracy, how QRZ produced those fields, or the cause of the discrepancy.
The user policy clarification is pending; contradictory fields remain held.
No matching rule, stored association or export permission was changed.

## Remaining QRZ scheduled acceptance

Use the [restricted QRZ pilot checklist](qrz-pilot.md) for the concrete packet
and the separate authorization/acceptance boundary.

The singleton and checked pairs C/D2 exercise current source proofs, absence,
delivery, readback at observed precision and populated recovery. Each next batch
needs reviewed exact QSO/destination scope, fresh checks and durable artifact
capture before dispatch. A clean INSERT acknowledgement currently resolves
delivery and purges its outbox without automatic post-acknowledgement field
verification. Preserve the original payload for independent comparison and
recovery through the scheduled path. Unknown outcomes
retain their durable attempt and claim; they never authorize blind retry.

After checked scheduled acceptance, the existing first-insert capability
can use `ROLLOUT_QSO_IDS_JSON=["*"]` with exact QRZ destination IDs for a small
pilot. This includes older missing contacts that satisfy all current source,
absence and ownership checks; it is not limited to newly arrived contacts.
Keep `SOURCE_BOUNDARY_VERIFIED=false`, LoTW off, and corrections, replacement
and deletion disabled. Unrelated historical exceptions, recovery of currently
empty raw LoTW history and 200,000-contact capacity are separate workstreams,
not prerequisites for that restricted QRZ pilot. The owner has authorized staged
progression only after successful checks; automatic exports remain disabled
while further checked batches and full-window verification remain open.

## Previous-release same-contact cloud check — 2026-10-24 21:10 UTC

The exact signed `5a427a30` runtime, deployed as Worker
`1e3a63b8-eceb-47dc-86d5-b4c64dd79a48`, completed source proof creation and QRZ
absence verification in **one temporary Cloudflare preview invocation**. The
separate preliminary planner admitted stale ledger context only as a refresh
hint; the unchanged normal coordinator refreshed it and strict post-proof
selection passed. An earlier invocation held on changed binding before any
vendor request. The successful invocation used a fresh binding for the same
contact, without substituting another contact or weakening the checks.

Two ordinary LoFi reads covered two positive dependencies and the final canonical
drain; one native atomic batch minted the proof at **21:10:09.659 UTC**. Three QRZ
reads used the normal targeted FETCH, verified-book STATUS and covering FETCH
fallback, returning a complete neighborhood with zero records. The **same proof**
was current after all reads at **21:10:12.733 UTC**, with **296,013 ms** remaining.
The inner helper used 110 D1 RPCs / 136 SQL in 4.617 seconds, excluding preview
startup, the separate nonce lease and host verification. There were no events in
this dependency closure. Normal budgets, leases, original timestamps and atomic
guards remained in effect; the original independent receipt was never renewed
inside the Worker.

The preview was disposed. Independent checks at **21:10:05.144** and
**21:10:14.213 UTC** retain the sole production Worker, matching assets, active
KEK version 1 and all eight closed controls. Attempts, cutovers, staging guards
and source-proof pins remain zero. No QSO was staged, signed or exported. This is
finite cloud observation of the deployed modules, not execution by the deployed
scheduler, universal source completeness, vendor write acceptance or permission
to export. Exact evidence must be obtained again before a later authorized trial.

The problem is that QRZ replacement is a duplicate operation with possible confirmation loss, while adopted history must retain its narrative. The adapter uses conservative readback, a fixed HTTPS form-POST endpoint and an identifiable User-Agent; it does not invent an update-by-LOGID request. A bounded interpreted Liquid subset supplies forward-only narrative rendering.

## Primary contracts and remaining live checks

The [QRZ API guide](https://www.qrz.com/docs/logbook/QRZLogbookAPI.html), updated March 7, 2025, establishes `https://logbook.qrz.com/api`, `KEY`/`ACTION`, `INSERT` results `OK`/`REPLACE`/`FAIL`, singular `LOGID`, and `COUNT`. Its initial example uses plural `LOGIDS`, but the INSERT table specifies singular `LOGID`: an unexpected mutation receipt is uncertain and must be reconciled. `AUTH` is a subscription/privilege failure. API access needs an active [XML subscription or higher](https://www.qrz.com/docs/logbook30/api).

The adapter requests `TYPE:ADIF,MAX:250,AFTERLOGID:0`, relying on the documented default `STATUS:ALL`, advances to the highest returned `APP_QRZLOG_LOGID` plus one, and finishes on parsed page length rather than global `COUNT`. It excludes `ALL` when paging. Generic `FAIL`, bad framing, duplicate IDs and nonadvancing cursors are errors, never absence evidence. `BETWEEN` and `MODSINCE` are supported. QRZ documents no snapshot token; a successful scan still needs the application's catch-up and fresh-absence checks.

The API guide says `OPTION=REPLACE` overwrites duplicates, including confirmed records, until they match again. It does not specify the API duplicate predicate. QRZ's [file import rules](https://www.qrz.com/docs/logbook30/adif-import) describe a broad time neighborhood; Ferry treats it as a conservative collision search, not proof that the API has the same predicate. Replacement requires an explicit verified-contract flag, a fresh mapped-record fetch and exactly one candidate in the ±30-minute neighborhood (with adjacent UTC dates and minute-precision allowance). Adopted narrative is merged back; server IDs/confirmation/award fields are never copied into a replacement. Unknown remote-owned ADIF fields are retained. If retained content cannot be serialized safely, preparation fails instead of dropping it.

A read-only live probe established STATUS identity/date field names (`BOOKID`, `CALLSIGN`, `START_DATE`, `END_DATE`) and the raw HTML-entity-encoded ADIF response tail. Adding an explicit `STATUS:ALL` caused a generic `FAIL` for a nonempty book, while omitting it returned a record. The adapter therefore relies on the documented all-status default, never requests confirmed-only inventory, and separates the ADIF tail before parsing metadata. Single-pass entity decoding preserves literal entities, ampersands, plus signs and percent signs; percent-encoded synthetic responses remain supported. No personal record contents are checked into fixtures. A scoped test logbook is still required to establish actual empty-fetch behavior, API duplicate matching including mode aliases and time precision, portable-location readback, replacement LOGID behavior, preservation of remote-owned fields and confirmation effects. `verifyBook` fails closed if expected book/callsign/date evidence is absent or differs. Do not enable replacement from parser fixtures alone.

A lost connection, error HTTP response, malformed body, or inconsistent mutation receipt is `uncertain`. The adapter never escalates a duplicate INSERT to REPLACE. Reconciliation must observe the exact transmitted revision, not only identity presence. Empty readback after a timeout is not proof the upload was rejected; no helper authorizes blind retry. Cleanup eligibility requires Ferry-created provenance, a durable acknowledged new mapping, different IDs, and fresh evidence for the old identity. Automatic deletion is intentionally not exposed before the vendor contract is proven.

### Ambiguous empty selections (2026-10-23)

At **23:31:06 UTC**, a protected four-request diagnostic used the existing QRZ
credentials and shared background request budget. All four requests were FETCH;
there were no vendor writes or application ledger, cache or cursor changes.
Only fixed result categories and presence flags were retained. Dates, LOGIDs,
raw counts, reasons, credentials and ADIF records were not logged.

| Read                                       | Observed response                                 |
| ------------------------------------------ | ------------------------------------------------- |
| Pending base partition, `MAX:1`            | HTTP 200; `FAIL`, zero count, no ADIF or reason   |
| Same selection, `MAX:0`                    | HTTP 200; `FAIL`, zero count, no ADIF or reason   |
| Unfiltered `MAX:1` control                 | HTTP 200; `OK`, positive count, one parsed record |
| Control record's exact date with `BETWEEN` | HTTP 200; `OK`, positive count, ADIF present      |

This narrows the observed failure to the selected range; it does not support an
authentication failure or universally broken date-filter syntax. An empty
selection is the leading explanation, not proven absence. The
[QRZ FETCH contract](https://www.qrz.com/docs/logbook/QRZLogbookAPI.html)
supports `MAX:0` for count-only requests, but defines `FAIL` broadly for parameter
or other problems. It does not give this zero-count failure an unambiguous
absence meaning. The count-only probe therefore supplies no safe alternative.
Provider clarification or separately scoped contract evidence remains needed.
A successfully completed broader covering read could supply independent
evidence; treating the failed selection itself as empty cannot.

The adapter now distinguishes only the exact observed framing as
`qrz_ambiguous_empty_selection`, while preserving its rejected-read behavior.
An incomplete base or verification partition stores a fifteen-minute retry hold
under the existing lease, source generation, credential and logical-book guards.
The hold preserves the cursor and retained pages, never marks coverage complete,
and is shared across contacts and invocations. Invalid or future-clock retry
metadata cannot create an indefinite delay; credential/book scope changes use
independent inventory. Due reads resume normally, and valid progress clears the
hold. The four-hour cache expiry remains unchanged. Rejected modification
catch-up still discards partial evidence and requires a full verification pass.

Held contacts remain inventory-pending with no adoption fence or fresh absence
proof. This reduces repeated failed reads; it does not clear the backlog or make
those contacts exportable. Reproduce the diagnostic locally with
`tests/qrz-read-diagnostic.test.ts`; adapter, telemetry and retry regressions are
in `tests/qrz.test.ts`, `tests/failure-diagnostics.test.ts` and
`tests/history-inventory.test.ts`.

The runtime change deployed read-only as Worker
`076adec3-eeb7-4dc9-bcd8-f6b04ce75318` at 2026-10-24 00:00 UTC. The first new
scheduled run recorded four `qrz_ambiguous_empty_selection` diagnostic events
covering 21 failed routes. At 00:06:18 UTC, all four pending QRZ history partitions
held bounded retry metadata, with zero holds on complete/invalid-phase partitions
or holds exceeding fifteen minutes/cache expiry. The settled 00:07:15 UTC audit
confirmed zero export attempts. No coverage or adoption was inferred from these
failures; the sample verifies deployed cooldown persistence, not QRZ absence.

### Bounded covering reads (2026-10-24 UTC)

`QrzClient.readCoveringRange` can gather independent successful coverage around
a target of at most seven days. It permits either a seven-day expansion on each
side or an explicit containing range of at most 35 days, selected using nearby
positive history. It retains at most four FETCH attempts, a sixty-second deadline,
two MiB per response and two MiB of retained canonical records. Every page must
contain a positive record, valid station/date/identity fields and ascending
LOGIDs. Since `AFTERLOGID` is documented as inclusive, continuation requests
repeat the last LOGID and require its entire canonical record to be unchanged.
Only that verified overlap is removed. A successful short page completes the
observation; failures, missing/changed anchors and limits return no partial
inventory. The caller must separately verify book identity and current scope.
This is an observed covering read, not a snapshot token or write authorization.

The neighborhood query now includes the same full 30-minute-59-second radius
used by its record filter when calculating UTC date bounds. Regression tests
cover both midnight edges so minute precision cannot exclude an adjacent date.

At 00:26:02 UTC a protected diagnostic verified the configured book with STATUS
and attempted one expanded covering FETCH around a pending range. It returned
the same ambiguous empty-selection failure. Only two vendor reads occurred;
there were no vendor, ledger, cache or cursor mutations. The first selector did
not fully validate the cached partition's current scope/expiry, so this is a
response observation, not evidence for current pending work. A metadata-only
follow-up found four pending ranges with nearby populated cached ranges; the
nearest range gaps were one, eight, fifteen and twenty-two days. This suggests
a deterministic cover containing a known positive range, subject to current
scope/expiry checks and unchanged resource bounds. Cached positives choose the
read range; only fresh successful reads could supply coverage evidence.

At 00:35:18 UTC the stricter metadata selector found 33 current scoped partitions:
four pending and 29 positive. It verified active account/source/destination,
unrevoked current credentials, unexpired retained pages, the exact history-scope
hash and book date boundaries. No row failed those checks. Each pending range
had a positive-range cover within 35 days (14, 21, 28 and 35 days); the selected
positive cached partition contained 98 records. No vendor request or application
state mutation was made by this selector. The protected live runner separately
requires STATUS book verification, fresh positive records inside that range,
and unchanged target/positive scope and credentials after the read.

This selection did not remain available. At 00:57:15 UTC the current selector
found four pending and sixteen positive partitions, but none of the positive
ranges could cover a pending target within 35 days. It stopped before any vendor
call. At 01:03:15 UTC an additional metadata-only audit permitted expired positive
metadata solely as a range hint, while retaining current scope/credential checks
and an unexpired target. Thirteen current positives and three expired hints
remained, again with no candidate within 35 days. These are cache-lifecycle
observations, not QRZ response failures or evidence that records disappeared.
No vendor calls or ledger/cache/cursor writes occurred in either check.

At 01:09:35 UTC a one-shot directional probe succeeded. It selected the nearest
current same-scope positive range as a direction hint, then read one containing
35-day range within the verified book boundaries. The hint itself lay outside
that range and supplied no retained evidence. STATUS verified the book; two
complete positive FETCH pages supplied 467 unique records, with an unchanged
inclusive continuation anchor. Zero records fell inside the seven-day pending
target. The fresh cover completed in 5.853 seconds; the run used three vendor
reads in total. Current target scope, book configuration and destination
credential version remained unchanged after the read. No source-boundary or
write authority was granted, and vendor/ledger/cache/cursor mutations were zero.

This establishes successful observed coverage containing one pending gap, rather
than inferring absence from QRZ's ambiguous `FAIL`. It is a finite observation,
not a snapshot or proof for the other pending ranges. No repeated expansion or
retry loop was used. The result was not imported into production history state.

### Integrated history and fresh checks

The automatic history path now recovers only the exact ambiguous-empty response
with one fixed cover of at most 35 days. Current same-scope positive metadata can
choose the smallest containing range; otherwise one directional range is chosen.
The plan never widens itself after failure. Each scheduler advance performs at
most one budgeted FETCH, with four attempts per pass and the original partition
expiry. Inclusive continuation anchors must match exactly. Every outer record
is validated before filtering to the original target; only hashes and counters
from outer records are retained. The target becomes complete only after two
complete covers agree in content and count. Changed, malformed, oversized or
incomplete reads stay held. Cached results still have no fresh-write authority.

The fresh neighborhood path separately handles the same response with verified
STATUS book identity and one complete current cover. Its hard bounds are four
targeted FETCHs, one STATUS and four covering FETCHs, sharing a 60-second deadline.
All modes inside the call/band/time neighborhood remain collision candidates.
Partial targeted results are discarded before fallback. Account, source,
destination, credential and book scope are rechecked during reads and before
write authorization; existing generation, dependency, claim and lease fences
remain required. A new destination allowlist makes a QRZ-only trial explicit.

Focused tests cover the observed 467-record gap, changed anchors and verification
passes, malformed outer records, scope races, midnight boundaries and bounded
failure. The implementation deployed read-only at 01:59 UTC. Its first new
scheduled run completed at 02:02:16 UTC; the 02:03:58 aggregate found one complete
cover after matching base/verification reads of 98 surrounding records and zero
records in the original target. No attempt or cutover was created. This verifies
one automatic cache completion in production. At that checkpoint, remaining
gaps, fresh live pre-write checks and real insert/readback acceptance were still
unverified. The later bounded fresh-read observations are recorded below;
actual INSERT/readback acceptance remains outstanding.

### Current read-only readiness observations (2026-10-24 UTC)

At 06:55:23 UTC, a protected read completed one targeted QRZ FETCH for an eligible
candidate, with stable local scope/dependency metadata and no STATUS or covering
fallback. It found **one nearby record and zero exact identity matches**. The
neighborhood was therefore not empty: this result establishes neither absence
nor permission for a first INSERT. Raw records were not retained, so the cause
of the non-exact match is unknown; no precision mismatch is inferred.

All seven export controls were verified closed before and after the read.
The source side ran only a metadata plan; no fresh source export proof was
verified. There were no vendor mutations or source, cursor, ledger, cache, proof,
staging or attempt writes; only the normal shared QRZ request-budget reservation
was recorded. Final counts remained zero for attempts, cutovers and stage guards.
Fresh same-contact source proof and destination absence checks remain required
before any guarded first insert.

At 07:19:34 UTC, a SELECT-only plan examined nine currently eligible candidates.
Three had current scoped cache hints with no matching CALL/BAND index entries;
none had fully empty cached weeks. The selected candidate had two source
dependencies and no events. Known stamp groups suggested one collection page,
which is an estimate, not a coverage guarantee. This plan made zero vendor reads
or state mutations. Cache hints only choose where to spend a fresh read; no fresh
QRZ absence check or source proof was completed for this selection.

The first cache-selected retry at 07:35:48 stopped on its first keyed eligibility
SELECT, before any QRZ request or budget reservation. The earlier source plan had
passed; no predicate-level diagnostic established which condition changed during
setup. The scheduled canonical poll can advance context generation, so this is
not evidence of a remote identity mismatch or a reason to relax the fence.

At **07:38:44 UTC**, the next bounded check completed successfully: one targeted
FETCH, one STATUS book verification and one complete covering FETCH established
an **empty current neighborhood** for an eligible candidate with two source
dependencies. Exact local scope and dependencies stayed stable. The deployed
fallback completed in 2.469 seconds using 37 database queries, including three
normal QRZ budget reservations. All seven controls were closed before and after;
attempts, cutovers and stage guards remained zero. No source, ledger, cache,
proof or vendor mutation occurred.

This was fresh absence evidence for that observation, without a successful source
proof or export approval. A joint same-contact source/vendor packet was still
outstanding at 07:38, and destination evidence must be refreshed before a future write.
The 06:55 neighboring-record candidate remains unsuitable for absence-based
insertion; the later result does not resolve that historical exception.

At **08:12:53 UTC**, a protected Node diagnostic completed the source-proof and
QRZ neighborhood checks for the **same contact**. Its runtime imports came from
the exact deployed revision `02e3dc89b99a5d7428c01b6a09596a105784eb11`, associated
with Worker version `da7b7b70-6b7e-4cab-b9f6-f4b88f38390d`. This exercised the
deployed implementation through the diagnostic harness and real D1/vendor reads;
it was not an execution of the Worker's mutation path.

The source check covered two exact dependencies and zero events. One collection
read and one qualifying final canonical drain produced one current immutable
source proof. Normal guarded source, ledger-observation and proof checkpoints
were permitted, together with leases and shared request-budget accounting;
there were no staging, attempt, cutover or vendor-export writes. The source
phase used two network reads, 53 database calls and 78 SQL statements. The
diagnostic clock-admission check preserved the original proof bindings and
required no wait. Strict candidate selection ran after normal context refresh;
neither a stale admission hint nor cached destination absence supplied authority.

The subsequent QRZ check used one targeted FETCH, one STATUS book verification
and one complete covering FETCH. It observed zero neighborhood records and zero
exact identity matches, with the normal matcher reporting
`missing_current_identity` / `no_candidates`. Fallback completed with stable
source/dependency, destination, credential and book scope. The QRZ phase used
three network reads and 37 database queries, including three ordinary request
budget reservations; it made no source, cursor, ledger, cache, proof or staging
writes.

The proof was current immediately before the QRZ check and again after the final
gate/safety checks at **08:12:53.735 UTC**, with about 292 seconds remaining at
that observation. All seven export controls stayed closed; attempts, cutovers
and stage guards remained zero. This establishes one bounded same-contact
source-proof/empty-neighborhood observation. It does not establish a persistent
permission, source-wide purge or replay guarantees, QRZ duplicate semantics, or
successful INSERT/readback acceptance. Proofs expire and ordinary source progress
can invalidate them, so a future write must obtain current evidence through the
normal guarded path. No export was authorized or attempted.

At **09:20:40.895 UTC**, the same-contact check passed again after source proof
creation in a remote Cloudflare comparison containing the committed clock fix.
The source composition and its limits are recorded in [the source evidence](evidence-lofi.md).
The subsequent QRZ read ran through a protected host harness using the exact
deployed adapter. One targeted FETCH,
one STATUS and one covering FETCH completed an empty neighborhood with zero
exact identities in 2.537 seconds. The inner probe used 37 database queries;
including outer current-proof and safety checks, the wrapper used 45 queries
and three normal budget reservations.

The exact cloud-created proof passed before QRZ and after the final gate/safety
checks, with 271,806 ms remaining. Source/dependency, destination, credentials
and book scope stayed current. Seven export controls were closed before and
after; attempts, cutovers and stage guards remained zero. The QRZ phase made no
source, cursor, ledger, proof, cache or staging writes and no vendor mutation.
This closes the bounded cloud-proof/QRZ-read check for one contact; release,
fresh evidence at any future write and actual INSERT/readback acceptance remain
outstanding. The owner's keep-disabled instruction continues to apply.

## ADIF and template profile

[ADIF 3.1.6](https://adif.org/316/ADIF_316.htm) defines ordinary ADI string fields as ASCII; international string fields require ADX. Ferry's ADI serializer rejects non-ASCII data rather than transliterating, dropping it or claiming QRZ UTF-8 support. Final normalized lengths include both CR and LF. NOTES preserves line breaks as CRLF; COMMENT/QSLMSG collapse whitespace. Literal `<EOR>`, `&`, `+`, `=` and `%` inside field values survive local framing and form encoding. Parsing preserves four- versus six-digit times.

The independent `ferry-liquid-v1` interpreter follows the [HaLo SDK template vocabulary and helper behavior](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/extensions/sdk/src/templates.ts) and [context contract](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/extensions/sdk/src/templateContext.ts). No separately licensed exporter code was copied. Supported tags are assign, if/else, unless, for and comment. Supported filters include where, map, sentence, refLabels, join, compact, uniq, size, first/last, default, strip, oneLine, downcase/upcase, dash, alnum, pad, cut, truncate, split, replace, append/prepend and UTC date directives `%Y %m %d %H %M %S %F %T %%`. Other tags/filters/directives fail explicitly; this is a documented compatibility subset, not a full Liquid engine. Context construction uses the effective operation from projection; the POTA example selects `op.refs` of type `potaActivation`, never the contacted station's `qso.refs` parks.

### Read-only source timestamp projection (2026-10-23)

[ADIF Time](https://adif.org/316/ADIF_316.htm#Time) supports UTC `HHMMSS` or `HHMM`, not fractional seconds. [PoLo stores millisecond timestamps](https://github.com/ham2k/app-polo/blob/59d2d2868c3b916fe7f54748359235bee619aa3c/src/store/qsos/actions/qsosDB.js#L93-L105), and both [PoLo's exporter](https://github.com/ham2k/app-polo/blob/59d2d2868c3b916fe7f54748359235bee619aa3c/src/tools/qsonToADIF.js#L214-L215) and [HaLo's exporter](https://github.com/ham2k/halo/blob/eb1a54ced637bfdd3c5b361a31df0e843edf9867/extensions/core/adif/src/index.ts#L271-L273) use `fmtADIFTime`. The [pinned formatting helper](https://github.com/ham2k/ham-js-libs/blob/8ab96df23a9653fc36e71a34a23520a8024a5b48/packages/lib-format-tools/src/lib/time.ts#L382-L389) selects UTC hours/minutes/seconds from the ISO timestamp, omitting milliseconds without rounding into a later second or day. These are primary implementation references for the normalization; they do not establish vendor mutation behavior.

`contactReconciliationAdif` applies this explicit projection for read-only history comparison. The guarded outbound attempt path now uses the same whole-second representation with the durable ownership checks below. The original source timestamp, precision, generation and source fingerprints retain milliseconds. Matching still requires a unique exact six-digit timestamp and the other identity/location evidence; a minute-only record, another second or multiple exact candidates remains ambiguous. Durable per-destination remote claims prevent a second source UUID from adopting the same record, including two millisecond timestamps in one second. Synthetic regression tests cover both destinations and UTC minute/day/year boundaries without creating an attempt.

When another source UUID contests an adopted identity, reconciliation marks both unproven associations ambiguous and retains the original remote ID as a reservation. The `adoption_conflict` provenance survives subsequent source edits and route restoration; automatic preparation remains blocked pending association review. Prepared, undispatched corrections are cancelled in the same transaction. A mapping backed by a delivery receipt or pinned template, and any dispatched uncertainty, stays intact while the contender is held. There is no automatic reservation cleanup. This detects conflicts as their source rows are reconciled; it does not establish source completeness or protect against a contender that has not yet been inventoried. Complete source and destination inventory and association review remain prerequisites to enabling exports.

### Durable outbound ownership

Migration `0023_outbound_identity_claims.sql` adds permanent hashed identity ownership scoped by tenant, logical destination and vendor, with the source connection and QSO UUID as owner. QRZ uses the existing exact identity fields; LoTW uses the existing canonical individual-mode mapping. Location and narrative changes do not create a different identity. This exact key does not establish QRZ's broader API duplicate predicate, which still needs scoped live evidence and conservative neighborhood checks.

Every newly prepared QRZ or LoTW attempt, including whole-second contacts, acquires its identity in the same D1 transaction as the immutable encrypted outbox, attempt and source/credential/template guards. A competing source UUID cannot stage the same identity even if the first result is uncertain or hidden from remote readback. Failed staging rolls back the claim. Successful claims are never automatically released after cancellation, rejection, expiry, source edits or revocation; changing an identity retains the old reservation. Adoption uses the same ownership table and preserves conflict quarantine.

Dispatch recomputes identity from the immutable payload and requires its exact attempt-to-claim link, current source/context/dependency evidence, active credentials and account, and a live delivery lease/fence before transport. Unlinked legacy attempts cannot gain permission to send. A linked, known-unsent attempt whose proof changed is cancelled so a fresh preparation can recapture evidence under the same retained owner; uncertain or submitted work cannot take that path. The public `contactAdif` helper remains strict. Only this guarded preparation path may omit fractional seconds, retaining full source timestamps, generations and fingerprints.

Existing LoTW mapped identities are backfilled from their canonical hashes, with retained prior-identity exclusions preserved. A legacy mapped QRZ record requires a fresh exact-LOGID read because its source may have changed. Bounded read-only maintenance checks at most one due mapping per invocation, shares the background QRZ budget, and retains the hold on missing records, conflicts or changed book/credential/lease evidence. Possible or completed pre-migration writes also retain a destination-wide legacy reservation until explicitly reviewed; outbox expiry does not erase that uncertainty. Production had zero attempts and zero mapped QRZ rows before this migration, so those legacy holds were not expected for the current account.

Legacy LoTW prior-identity exclusions still depend on retained, unrevoked `lotw_identity` private rows. Normal credential revocation and restore preserve those rows, and the application does not expire them. Operators must not manually purge or revoke that evidence; independent minimal reservations for every old prior identity remain a hardening follow-up. New ownership claims do not depend on payload retention.

Migration `0024_identity_mapping_overlap.sql` closes the deployment overlap where an old Worker invocation can adopt a mapping after `0023` has seeded existing rows. Every subsequent LoTW mapping write atomically reserves its canonical hash; a conflicting owner aborts the mapping. QRZ mapping changes reserve the exact LOGID unless an exact completed receipt is linked to the same immutable attempt claim. Current historical adoption removes only its own exact LOGID/owner/hash reservation under the same proof transaction, including idempotent adoption. Legacy mappings without that proof remain held for bounded readback; an unresolved older LOGID reservation cannot be overwritten.

The claims replace the earlier blanket fractional-timestamp block; they do not open any export gate, approve historical precision mismatches, establish source completeness or prove vendor acceptance. All production export controls remain closed. New regression fixtures cover competing-stage races, atomic rollback, retained ownership, migration, exact payload linkage and final source/dependency/lease changes, including fractional-time contacts with full eight-character grids and lost mutation responses.

Limits do not depend on clocks or cooperative timeouts: 16 KiB combined template source, 16 nesting levels, 2,048 structural tokens, 20,000 execution steps, 1,000 aggregate loop iterations, 64 KiB intermediate allocation budget and 8 KiB final UTF-8 output per field, rechecked after normalization. Filters preflight expanding joins and bound split/replacement results. There is no include, filesystem/network, JavaScript evaluation, arbitrary property traversal or compiled code path. The profile rejects prototype properties. `now` must be captured by the durable preparer once per eligible source generation; templates cannot schedule work themselves.

## Reproduce

Run `npx tsx --test tests/adif.test.ts tests/qrz.test.ts tests/templates.test.ts` and the repository's type/lint/build checks. The tests cover ADIF framing, normalization and unsupported encodings; pagination and failed inventories; conservative matching and adopted text preservation; disabled writes, duplicate rejection and uncertain mutation responses; POTA context, UTC helper behavior, fixed-clock-independent resource limits and deterministic retries. `fixtures/qrz/contracts.json` distinguishes synthetic response forms from vendor observations.

## Durable preparation, delivery and confirmation integration

`src/reconcile.ts` classifies complete scoped inventories and applies adoption with an atomic generation/source-hash compare-and-set. Tenant/destination uniqueness prevents two source UUIDs claiming one remote ID. Trusted mappings and pinned templates survive reconnect. Newly adopted QRZ rows atomically switch to the source fingerprint that excludes owned narrative; otherwise the next unchanged poll could look like a source correction. Adoption creates no attempt, signing operation or destination request.

`src/delivery.ts` prepares after the per-contact quiet period. It pins an immutable template, freezes render-time context, checks routing and fresh collisions, and stores an encrypted payload before mutation. QRZ correction preparation fetches remote-owned fields, preserves adopted narrative, and persists compact encrypted prior-identity evidence for changed identities. Dispatch rechecks remote-owned fields against the prepared bytes and refuses a mutation if those fields changed. It never silently regenerates an in-flight payload. Actual transmitted projection hashes are separate from envelope/payload metadata, so a source edit whose transmitted fields are unchanged performs no second write.

Worker configuration gates and an explicit rollout source-UUID allowlist are checked before signing and dispatch. LoTW certificate arrays and station routes select exact callsign/DXCC/date coverage; contact location wins over configuration. ADIF `MY_CNTY` includes the state prefix while LoTW's canonical county name does not; this conversion has integration coverage. Certificate revocation status and authoritative connection/credential state are checked before signing and again before submission. A failure during a read before any mutating request begins schedules bounded exponential backoff and reuses the same immutable attempt. Once a mutating request starts, ambiguous outcomes remain uncertain and require readback.

LoTW signed artifacts persist exact contact membership, source generations, certificate and configuration versions. Upload acknowledgement is `submitted`; exact supported projection readback changes it to `observed`. QSL confirmation is separate metadata. The observed checkpoint atomically retains a compact encrypted identity before purging the signed artifact. Bounded daily confirmation refreshes perform read-only queries and update the badge only when the complete observed projection still agrees with the current sent hash. An old identity, differing location, or expired unresolved artifact never authorizes a blind resend.

Reproduce integration with `npx tsx --test tests/reconcile.test.ts tests/delivery.test.ts tests/store-reconcile.test.ts`. These tests use real local D1/workerd storage and generated-key signing with synthetic vendor transport. They prove local state transitions, tenant and lease fencing, safe retries, rollout scope, zero-write adoption, narrative retention and the submission/observation/confirmation distinction; they do not prove QRZ replacement semantics or ARRL acceptance. Production QRZ replacement remains contract-gated, automatic old-identity deletion remains unavailable, and no-query LoTW live classification remains blocked pending an evidenced LoFi replay/cutover contract.

## No-query live cutover

`src/cutover.ts` and migration `0005_cutover.sql` retain minimal immutable source UUID births independently of expiring contact buffers. The first normal sync cursor checkpoint captures an inventory epoch. A destination cutover is created only with the source-boundary verification gate enabled, completed normal source backfill/catch-up, and either a destination that predates initial inventory or a completed explicit destination rescan. The marker freezes cursor generation/snapshot, epoch and evidence; it never moves with later polls.

A no-query LoTW contact is live only if its UUID was first observed in a normal forward page strictly after that destination's cursor cutover. QSO dates, device clocks and local wall-clock ordering do not grant eligibility. Backfill, operation rereads, destination rescans, preexisting source metadata and restored historical UUIDs remain historical; an immutable birth cannot be relabeled. Birth insertion shares the source page's atomic cursor checkpoint. Partial inventories, stale checkpoints and cross-tenant/source/destination references cannot create proof.

These local checks rely on an independently verified exhaustive LoFi UUID/tombstone/replay contract. The verification gate remains false by default. A fixture, client implementation, environment flag or stored marker is not live vendor proof. Until that source contract is established, no-query live delivery remains blocked operationally even though its conditional code path is implemented and tested. Run `npx tsx --test tests/cutover.test.ts tests/service.test.ts` for the durable classification and two-vendor scheduler flow.
