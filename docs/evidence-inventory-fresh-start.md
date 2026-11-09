# Fresh database account rehearsal

Run `mise run inventory-fresh-start -- --source /path/to/snapshot` with
a closed private local snapshot containing `keys.json` and `database/`.
The command creates a separate private Miniflare database, applies the
current schema, and retires the legacy scheduler in that copy.

The copy retains accounts, passkeys, connection IDs and settings,
credential envelopes with their original encryption bindings, and
template versions and selections. It clears old poll and cutover state
and omits sessions, contacts, comparisons, cursors and delivery attempts.
The command reopens the copy and verifies the account records and active
credential decryption. It compares the source rows again before returning.

[Migration 0098](../migrations/0098_inventory_fresh_start_lock.sql) puts
a durable send lock on the rehearsal. The lock records counts of
unsettled legacy and native QRZ work without copying its contact data.
[Migration 0102](../migrations/0102_inventory_lotw_readback.sql) also
records the unresolved LoTW batch count.
The same lock blocks a QRZ dispatch claim even when the environment's
export flags are open. A production cutover will need separate evidence
that the previous sender stopped and its unresolved work was settled
or quarantined.

## Read-only run with real credentials

The local copy took 5.4 seconds and started with empty contact state.
One account and four connection rows survived the copy. All four
credentials decrypted under their existing IDs. The older QRZ trial
alias and the verified book link both survived. Only the verified link
was selected for this readback. The snapshot contained one outstanding
native preparation. The copy recorded its count and retained its send
lock.

The rebuilt 15-day QRZ and LoTW selections finished with 73 and 3
receipts, respectively. LoFi accepted two 1,000-record pages, leaving
1,949 active contacts, then rejected the bearer. The local run retained
the cursor and LoFi client identity. The client cleared the rejected
bearer only in the rehearsal copy. No registration or renewal request
was sent, and the original credential ciphertext and the copied QRZ
and LoTW envelopes were unchanged.

The run used eight read-only requests and created zero dispatch claims
or uploads. The LoFi selection remains incomplete. Managed read-only
trials now report `source_authentication_required` immediately instead
of spending local turns trying a registration that the transport blocks.
The fixture verifies this stop and verifies preservation of passkey and
template bindings on a fresh copy with an unsettled legacy attempt.

## Resume after LoFi authentication loss

```sh
mise run inventory-fresh-start -- \
  --rehearsal /path/to/closed-rehearsal \
  --lofi-bearer-from /path/to/closed-snapshot
```

The rehearsal must have its durable send lock and exactly one active
LoFi link. The other private snapshot must have one active link for
the same LoFi account and the same client key and secret. If the
rehearsal still has a bearer, the command makes no requests.

After an authentication loss, the command checks the offered bearer
with one read-only LoFi account request. It updates only the existing
encrypted LoFi credential in the rehearsal after the account matches.
The credential ID, saved cursor, run, destination links and send lock
stay in place. The command never calls LoFi registration or renewal.

A native D1 fixture accepted a page, received HTTP 401 on the next
read, and resumed at the exact saved cursor after bearer recovery.
Rejected bearers and mismatched accounts failed verification. The
original snapshot and the rehearsal's destination credentials kept
their ciphertext. The fixture used a simulated provider.

A read-only census examined 95 private captures. Of the 92 with the
same client, 89 held the rejected bearer and three had no bearer.
The real rehearsal still needs a current same-client bearer before
its next LoFi read.

A private copy of the later QRZ recovery rehearsal was upgraded
through migration 0114. It retained the exact LoFi run and cursor,
1,949 active LoFi contacts, 706 LoTW receipts across four ready
selections, and 73 QRZ receipts in one ready selection. Reopening
verified the linked credential envelopes, passkeys, template bindings
and write lock. The current resume command stopped at
`source_authentication_required` with zero reader or comparison turns
and zero provider requests. The original rehearsal retained the same
saved state.

### Restart a refused LoFi cursor

Restore the same-client bearer and resume the saved run first. If
LoFi explicitly refuses the cursor, the runner holds that source run
with reason `cursor_refused`. Use its run ID to restart the full
source scan on the same linked selection.

```sh
mise run inventory-fresh-start-rebuild -- \
  --rehearsal /path/to/closed-rehearsal --restart-lofi-source RUN_ID
```

The restart requires the durable write lock and an available bearer.
It keeps the previously ingested observations and committed
checkpoint. The replacement starts with fresh read windows and
publishes coverage after collection and catch-up. The old wakeup
becomes stale, and repeating the command for the same held run
continues the same replacement.

A private copy of the 1,949-contact rehearsal received a simulated
refusal at its exact saved cursor, then finished the replacement
from six responses built from the encrypted LoFi capture. Ready
coverage contained 223 operations and 4,398 QSOs and events. The
canonical inventory held 4,341 active contacts. It kept 90 newer
contacts and two deleted events absent from the capture, plus one
operation with a newer revision. Their coverage membership remained
unresolved. Account bindings, destination credentials and destination
inventory matched the original. The trial made zero external requests
and created zero dispatches.

## Run or continue a locked rebuild

```sh
mise run inventory-fresh-start-rebuild -- \
  --rehearsal /path/to/closed-rehearsal --plan /path/to/private-plan.json \
  --max-requests 120 --max-minutes 20
```

Supply a JSON array of selections to enroll in a single active account.
Each selection names the copied connection ID. LoFi scans the source
with 1,000 records per stream. QRZ uses the verified book's date bounds
unless the selection supplies dates. LoTW accepts a date range for
coverage or a UTC receive timestamp for its separate receipt delta.

```json
[
  { "connection": "lofi-link" },
  { "connection": "verified-qrz-link" },
  { "connection": "lotw-link", "from": "2026-10-01", "through": "2026-10-31" },
  { "connection": "lotw-link", "receivedSince": "2026-11-07 12:00:00" }
]
```

Omit `--plan` to continue the existing selections. Each invocation
drives the native baseline and comparison jobs and saves aggregate
progress, coverage, D1 cost and database size in the rehearsal.
A missing or rejected LoFi bearer pauses source reads and lets the
selected destinations finish. The command retains the source checkpoint
and reports incomplete source coverage. The durable write lock and
read-only transport apply throughout.

Add `--poll-due` to also run the next scheduled poll for each selection
whose deadline has already passed when the command starts. The same
runner as the hosted Queue uses the saved checkpoint and chooses between
a delta and full verification. A selection's next deadline stays in the
future after it finishes, so the invocation does not start a second poll.
A plain continuation can finish work started by a request-limited poll.
The coverage report includes the current run's mode alongside the state
of the retained published selection.

With migration 0108 applied, use `--resume-qrz-cover <run-id>` to requeue
a held QRZ covering delta in a write-locked rehearsal. Use the held
run's ID from the private local database. The operation verifies the
committed hold receipt, current lease and link, and the saved cursor and
checkpoint. It requeues the same run and leaves coverage collecting
until the normal terminal publication. Once requeued, a plain
continuation can finish the saved run.

### Real continuation while LoFi waited

A private clone of the interrupted rehearsal, upgraded through
migration 0104, completed three additional LoTW months in two
invocations. The first two months added coverage without adding
records. The largest added 703 receipts in one request, matching the
count from the earlier calendar trial. Across the two invocations,
three LoTW requests transferred 421,001 bytes in 50.0 seconds of
combined elapsed time, including local comparison work. The larger
invocation used 5,149 SQL statements and 401 comparison turns. The
database occupied 42,483,712 bytes after the reads.

The reopened clone had four ready LoTW selections and 706 active LoTW
receipts, alongside the earlier 73 QRZ receipts. It decrypted a new
monthly receipt and matched the original rehearsal's LoFi checkpoint,
job version and credential envelopes. A repeat continuation made
zero provider requests and performed zero reader or comparison turns.
LoFi coverage is still incomplete, and the new LoTW results cover only
the selected dates.

### Real scheduled polls

A private clone upgraded through migration 0107 ran the selections that
were already due. Three LoTW requests completed two deltas and one full
scan for a selection without a receive checkpoint. Both deltas advanced
the local checkpoint version by three and retained the previous receive
stamp and published full selection. A fourth LoTW selection was still
scheduled for later. Receipt counts stayed at 706 for LoTW and 73 for QRZ.

The QRZ `MODSINCE` delta held for verification after two requests and
retained its prior checkpoint. A three-request read-only diagnostic
verified the book and reproduced the ambiguous empty selection. A
one-record control over the same dates without `MODSINCE` succeeded.
The failed delta supplied no evidence of absence.

The scheduled invocation made five requests in 6.5 seconds, including
local work. Reopening verified the original copy, LoFi cursor and job,
and all credential envelopes. A plain resume made zero provider requests
and zero reader or comparison turns. Both the poll and the diagnostic
used the write-locked copy and made zero uploads.

### QRZ delta recovery

The initial recovery handled the exact ambiguous empty first `MODSINCE`
page with one complete positive covering read. It kept the verified book
and date bounds and removed only the modification filter. Recovery uses
the ordinary delta publication, which retains the full coverage epoch
and does not quarantine older receipts.

A fresh clone of the same pre-poll database completed the real QRZ delta
with three requests. The covering read re-observed 73 unchanged receipts.
After reopening, the QRZ checkpoint version had advanced by three and
the original full selection and its coverage were ready. The modification
date stayed at the same overlapping calendar lower bound. The other due
polls completed in three LoTW requests. The combined invocation took 7.2
seconds, with the LoFi cursor, original database and credential envelopes
preserved. It made zero uploads.

### Paged QRZ verification

A covering read can now continue across pages. The saved cursor records
that the modification filter was removed and stays bound to the original
book, dates and run. Each page verifies book identity and uses the shared
vendor admission. A live probe observed `COUNT=2` on each of two pages in
a book with more than 4,000 receipts, so a full page is still followed
by a terminal read. The existing smaller-page replay can recover an
ambiguous tail without treating the failed response as completion.

An ambiguous or invalid response during a covering read can retry at the
same cursor after one, two and four minutes. A successful page clears
the retry marker. Vendor deferrals retain it. Persistent ambiguity
leaves the run held. Only terminal publication advances the committed
checkpoint. After a multi-page recovery, the next scheduled poll is at
least 24 hours later, so an idle selection that requires a covering
scan uses at most one scheduled scan per day.

A native replay of the full captured book accepted 4,252 unchanged
receipts in 18 covering pages and restored ready coverage on the retained
full selection. The runner consumed 38 local responses, including STATUS
and the initial failed `MODSINCE` read. The replay simulated the admission
window elapsing and made zero provider requests. It scheduled the next
poll one day after completion.

The live full-book trial first completed a normal modified poll with two
changed receipts. A second poll entered covering verification and accepted
six pages before repeated read failures left it held. Diagnostic reads at
the held cursor produced both a LOGID validation failure and a valid page.
Reopening confirmed the previous checkpoint and full selection were still
retained, the source checkpoint and credential envelopes were unchanged,
and no delivery attempts existed. That invocation left full-book live
verification open.

Two alternating read-only probes at the held cursor reproduced an unusable
LOGID in each 250-record response. Both 125-record responses validated
and advanced. A later probe returned valid pages at both sizes and also
validated the next 125-record page, so the failure was intermittent.

On an invalid LOGID during a covering scan, the reader retries once at
the same cursor with half the page size, down to 32 records. Only a full,
valid smaller page can save the new size and cursor. An incomplete
smaller result supplies no evidence for finishing the selection.

In a subsequent live full-book delta, invalid LOGIDs caused successful
reductions from 250 to 125, 62 and 32 records. The write-locked copy
accepted 1,094 observations in seven pages. After 22 requests, the run
deferred at the next vendor window. We stopped that invocation there
because a 32-record page would exceed its remaining request allowance
before the end of the book. Reopening found the same cursor ready at 32,
the previous committed checkpoint and full selection retained, unchanged
source and credential envelopes, and zero delivery attempts. The live
run still requires a successful terminal page.

The covering reader now tries the configured page size again after two
full pages at a reduced size. If the larger request returns an invalid
LOGID, the reader retries at the last validated size and the same cursor.
The two-page count persists in the resume state.

A captured-book replay injected four invalid LOGID responses. It stepped
down to 62 records and recovered to 250, then reduced and recovered once
more. It accepted all 4,252 receipts in 25 pages with no changed bodies,
published the delta, and retained the full coverage epoch. It consumed
56 local responses with simulated vendor windows and made zero provider
requests or uploads.

The live continuation accepted one more 32-record page and then held
after an invalid response and its retry. Reopening counted 1,126
accepted observations, retained the previous committed checkpoint and
full selection, and verified unchanged source and credential envelopes
with zero delivery attempts.

A private clone of that held run passed the migration 0108 resume guard.
The rearm retained all eight accepted pages, the exact resume state and
committed checkpoint, and the full selection. It advanced the job and
coverage versions, and the reader rejected the old wakeup without
contacting QRZ.

The live continuation then accepted 15 more pages in 35 read-only QRZ
requests over 5 minutes 14 seconds. It resumed at the saved 32-record
size, reached 250 again, and completed the same delta run. Reopening the
clone verified 4,252 distinct observations across 23 accepted pages,
4,252 active receipts, ready coverage on the retained full selection,
the published delta checkpoint, and a next poll one day later. The
source cursor and credential envelopes stayed intact, with zero delivery
attempts. The live scan published 4,250 changed receipt bodies and left
4,252 QRZ projections pending for the separate comparison coordinator.

Two bounded local passes drained those projections and the comparison
queue in 4 minutes 44 seconds. The 4,251 current QRZ comparison results
included 3,005 existing matches, 537 operating-detail mismatches, 367
inventory absences and 20 ambiguous matches. The passes used 51,547 D1
calls and 63,802 SQL statements, with about 9.42 million rows read and
865,442 rows written. They made zero vendor requests and zero uploads.
Reopening and comparing locally preserved the source and vendor
checkpoints and credential envelopes.

An offline comparison of the earlier closed baseline and the completed
clone found the same 4,252 active receipt IDs. For 4,240 receipts, only
`QRZCOM_QSO_DOWNLOAD_DATE` differed. The other 12 differed in additional
fields. This compares the two closed copies. The live publication count
above measures changes against the state immediately before that run.

Wire inspection found that the numeric LOGID tag was present in the
malformed response. A preceding `X_HAM2K_SOLAR` field's declared length
extended into that tag. A valid response for the same receipt had a
consistent field length. The reader requires a successful retry to
advance and keeps the counted-field parser and LOGID checks in place.

A separate captured-book replay injected six invalid responses at one
cursor, covering the original and smaller request in each failed turn.
The one-, two- and four-minute retries retained the prior checkpoint. A
valid response at the same cursor resumed the scan, and all 4,252 receipts
completed across 18 pages. The replay used 46 local responses and
simulated both the retry delays and vendor window.

### QRZ receipt change detection

QRZ now excludes `QRZCOM_QSO_DOWNLOAD_DATE` from its semantic hash while
retaining the exact raw receipt and its revision. The first observation
of a receipt stored under the old hash can queue one reprojection. A
replay of all 4,252 unchanged bodies verified this transition without
rewriting any of the raw payloads.

Two isolated copies of the completed live book replayed the same earlier
captured bodies through the native covering reader. The two arms first
settled their respective hash formats, then each accepted 4,252 receipts
in 18 pages. Both published ready coverage on the same retained full
selection, and all 4,251 current QRZ comparison outcomes, reasons and
remote keys agreed per contact. The source cursor and credential
envelopes stayed intact, with zero provider calls or uploads.

| Work for the changed refresh | Full-body semantic hash | Download date excluded |
| --- | ---: | ---: |
| Receipts queued for projection | 4,252 | 12 |
| Ingestion SQL statements | 1,110 | 1,000 |
| Comparison SQL statements | 50,877 | 12,944 |
| Comparison rows read | 8,339,345 | 2,130,047 |
| Comparison rows written | 831,361 | 180,983 |

The unchanged-body control still used 1,066 comparison statements for
coverage recovery with no receipt projections. The changed refresh added
4,252 encrypted raw envelopes in each arm, totaling 7,360,855 bytes
before database overhead.

### Superseded raw payload retention

Migration 0109 queued 8,504 unreferenced QRZ bodies on a private copy of
the normalized replay. None was eligible immediately. After advancing the
queue deadlines in the copy to simulate the seven-day grace period, 34
collection turns removed all 8,504 bodies. Each turn removed at most 256.
The collection used 35 SQL statements including the final empty check,
with 85,284 rows read and 17,008 written.

The deleted envelopes totaled 14,719,954 bytes. SQLite gained 21,381,120
bytes of reusable pages at the same allocated file size. The 4,252
current QRZ bodies and all current LoFi and LoTW bodies were preserved.
Reopening verified identical current ciphertext, linked credentials,
checkpoints, coverage, matching results and ownership evidence, with no
foreign-key violations or provider requests.

A synthetic scale check used 100 accounts, 200,000 current facet bodies
and 200,000 superseded bodies with small fixture envelopes. Half the
accounts were quarantined. One tick removed 256 eligible bodies with
2,863 rows read and 512 written. A tick with only quarantined accounts
due read 255 rows and wrote none. The check covers queue traversal at
this row count. The captured copy supplies the envelope sizes above.

After raw collection, match tokens and their indexes occupied 86.45 MB
in the captured copy. The 945 superseded proofs in the separate match
retirement queue accounted for 191,024 of the 366,408 tokens. All 945
were still within their grace period. This was a copy used for several
replays, so these counts measure that backlog.

### Batched comparison proof retention

Two private copies advanced the preparation time and queue deadline of
the same 945 superseded proofs to simulate expiry. The production guards
were in place for both collector runs. The batch takes the oldest
eligible prefix, up to 16 proofs and 20,000 dependency rows per tick, and
uses the same native pin checks and atomic deletion as the single-proof
collector. The largest proof in this capture had 698 dependencies.

| Captured backlog | Single proof | Batched proofs |
| --- | ---: | ---: |
| Productive ticks | 945 | 60 |
| D1 statements including the empty check | 946 | 61 |
| Total rows read | 1,086,569 | 1,095,139 |
| Total rows written | 270,104 | 270,104 |
| Peak rows written in one tick | 699 | 7,084 |
| SQLite bytes made reusable | 72,470,528 | 72,462,336 |

At the configured five-minute cadence, 60 productive ticks represent
about five hours of scheduled cleanup after eligibility. Both runs
removed exactly 269,159 dependency rows, preserved proof headers and
result rows, and kept current matches, ownership, linked credentials,
coverage and stream checkpoints identical. Both passed SQLite's foreign
key check and made zero provider requests.

### Full QRZ catch-up verification

A full run can use the same covering scan when its `MODSINCE` catch-up
returns an ambiguous first page. The reader keeps the original book and
date selection and completes the normal quarantine and publication steps
before advancing the checkpoint or publishing a new coverage epoch.

A captured-book replay completed both the full census and covering
catch-up for 4,252 receipts. It accepted 36 pages with no changed receipt
bodies, published a new ready coverage epoch, and scheduled the next poll
one day later. The replay used 74 local responses with simulated vendor
windows and made zero provider requests or uploads.

### QRZ STATUS reuse

The scheduled reader saves one book verification with an accepted full
page. One following full page can reuse it within 30 seconds, for the
same credential version and selection. Terminal pages, recovery and a
response that outlasts the evidence window require fresh verification.
The rule uses QRZ's documented book-specific key routing. [QRZ API guide](https://www.qrz.com/docs/logbook/QRZLogbookAPI.html)

A live read on a private write-locked copy collected 44 receipts in
three pages. It issued five requests, with one STATUS check shared by
the first two pages. Reopening after the first page verified that the
evidence survived in the accepted cursor. The normal covering catch-up
then completed in seven reads and published ready coverage. The
terminal catch-up page rechecked STATUS after its FETCH. The trial
preserved the other checkpoints and credential envelopes and made
zero uploads.

A separate replay used all 4,252 captured QRZ receipts and compared
the same 18 date-selection pages. Both passes produced identical
ordered observations. STATUS calls dropped from 18 to 10, so total
requests fell from 36 to 28. This replay used local responses and
excluded quota delays and catch-up.

## LoTW account receipt deltas

ARRL's receipt report accepts an explicit `qso_qsorxsince` with optional
contact-date filters. A real read without those filters returned two
receipts. The first receive timestamp matched the header, and both were
within the requested lower bound and report watermark. A control report
for their contact date returned identical records. Both receipts were on
one contact date. A synthetic adapter fixture covers receipts from
different years in the same report. [ARRL report documentation](https://lotw.arrl.org/lotw-help/developer-query-qsos-qsls/)

On a private write-locked copy, the native runner replayed those two
captured receipts and committed the account stream's own watermark.
The next scheduled delta used the inclusive saved receive timestamp in
one live request and returned one unchanged receipt at that boundary. Both runs
completed with positive-only coverage and preserved other checkpoints,
dated coverage and linked credential envelopes. The diagnostic and
native continuation made three real reads in total and zero uploads.

The native fixture rejects full runs for the account stream and verifies
that the cursor advances only after publication. An empty report leaves
the watermark in place. An oversized account report holds for review
with its previous watermark. Enrollment uses an explicit initial UTC
timestamp and allows one account stream per LoTW scope. The default
recurrence is two hours.

### LoTW dated fallback after account overflow

A successful account feed can move an overlapping dated selection to
its verification interval. The dated full scan must have started at or
after the account feed's initial receive cutoff. Until that overlap
exists, the dated selection keeps its ordinary cadence. If the account
feed is held or its last completed read ages past two poll periods, cron
restores the ordinary due time on up to 16 idle dated selections per
tick. The dated wakeup and new job version commit together. A locked
rebuild with `--poll-due` applies the same recovery at startup.

On a private copy, the native runner replayed two captured receipts in
the account feed and the matching dated report. The completed dated
selection scheduled its next full verification seven days later. A
simulated account report over the two-MiB bound held the account run
with its saved watermark and no new observations. The fallback restored
the dated selection's ten-minute cadence and fenced off the old wakeup.
A second fallback pass found no remaining work.

The restored dated delta completed in one live read and returned one
unchanged receipt at its inclusive cursor. It retained the published
dated coverage, the account watermark, other stream checkpoints and
credential envelopes. The trial made zero uploads. The native fixture
also exercises a late reschedule failure and verifies that the job
and wakeup roll back together.

### Resume a held LoTW account delta

An overflowed account run can resume at its saved inclusive cursor in
a closed, write-locked rehearsal. The rearm checks the held run,
credential, selection, checkpoint and lease before it commits a new
wakeup version. It allows intervening dated polls to advance the shared
scope sequence and keeps dated fallback active until the account read
completes and publishes.

```sh
mise run inventory-fresh-start-rebuild -- \
  --rehearsal /path/to/closed-rehearsal \
  --resume-lotw-account RUN_ID --max-requests 1
```

Ordinary reports retain the two-MiB limit. The rearmed run may download
and parse up to four MiB. After completion, the same stream and
configuration may use that bound for later inclusive polls inside the
write-locked rehearsal. A report beyond the expanded byte or transaction
budget holds the feed with its accepted checkpoint and restores dated
polling.

The native test ingested 2,200 synthetic receipts in a report above two
MiB. The next inclusive poll accepted the same boundary receipts with
zero changed bodies. The test also covers rearm rollback and rejection
of the old wakeup. A private copy of the live fallback rehearsal
completed the same held run in one real read at its saved receive
timestamp. The report returned one unchanged receipt, retained
positive-only coverage, and left the dated checkpoints, dated coverage
and credential envelopes intact. The live trial made zero uploads.

An offline capacity replay assembled the 4,082 captured calendar
receipts into one 2,163,423-byte report with a synthetic common receive
timestamp and ADIF field whitespace. The comparison-enabled reader
accepted all 4,082 observations and committed 4,082 changed raw bodies
in 42 D1 page-publication statements. That batch reported 337,034 rows
read and 157,145 rows written. The local read and terminal publication
took 2.4 seconds, excluding fixture assembly and the separate
comparison queue. The replay made zero external requests and uploads.

### Hosted LoTW account enrollment

With `INVENTORY_LOTW_ACCOUNT_FEEDS=true`, cron enrolls up to eight
account feeds per tick after dated calendar registration. Each link
needs current query access and at least one unfiltered dated plan. The
first receive cursor uses the oldest eligible plan creation time with
at most one hour of lookback. A bounded registration cursor lets later
accounts proceed when a link fails registration.

The native fixture verifies opt-in enrollment, idempotence, a nonempty
first report and read-access restoration. Restoring access starts a new
positive-only run on the same stream at its last committed receive
timestamp. A changed timestamp fails native admission. The old wakeup
is stale.

On a private write-locked copy, the scheduler enrolled one feed beside
15 existing dated selections. A repeat enrollment found no work. The
first native account poll completed in one live request and returned
zero receipts for the one-hour lookback. It published positive-only
coverage and preserved the other stream jobs, checkpoints, coverage and
credential envelopes. The trial made zero uploads.

## Complete account-only offline replay

A fresh write-locked copy started with empty contact tables and kept
the account, passkeys, four linked credential envelopes and template
bindings. The native inventory reader replayed the retained encrypted
LoFi, QRZ and LoTW bodies through local responses. The replay rebuilt
LoFi's independent operation and QSO cursors, used an empty QRZ
modification catch-up for the static capture, and simulated two quota
windows. It made zero external requests and uploads.

All 17 selections published ready coverage. They retained 4,251 active
LoFi contacts, 4,252 QRZ receipts and 4,082 LoTW receipts. The LoTW
selections cover the captured contact-date windows. The coordinator
finished comparison, historical adoption and ownership review. A
read-only reopen compared all 12,956 raw body hashes and record
statuses, all 8,502 current classifications and reasons, and all 6,260
source-to-receipt associations against the capture. Every set matched.
Review marked 1,112 absences as requiring source proof. There were zero
dispatch claims, zero pending historical adoptions, and no foreign-key
violations.

| Local phase | D1 calls | SQL statements | Rows read | Rows written | Elapsed |
| --- | ---: | ---: | ---: | ---: | ---: |
| Inventory read and publication | 1,887 | 5,385 | 1,109,900 | 318,817 | 48.4 s |
| Comparison, adoption and review before lookup fix | 97,020 | 113,998 | 68,805,488 | 1,540,524 | 493.6 s |

The reader used 59 local responses and transferred 12,615,336 bytes.
The quiescent copy reported 281,378,816 allocated bytes. These times
measure the native local reader and coordinator. They exclude vendor
network latency, hosted Queue delivery, snapshot preparation and the
final audit. The [backfill lookup profile](evidence-inventory-comparison.md#backfill-payload-lookup)
isolates the preparation fix discovered during the replay. The live
LoFi account-only resume still requires a current bearer for the same
client.

## LoTW recurrence scale check

Completion-relative scheduling let cohorts remain concentrated in the
same quota windows. Recurring account feeds and overlapping weekly
verification now use a stable phase derived from each stream's identity.
This keeps the scheduled account gap below one and a half poll periods.
For dated coverage, the next full scan can be earlier than its existing
deadline. An already-due deadline schedules verification immediately.

A seven-day simulation modeled 100 account feeds and 1,400 dated
streams. Prior completions were clustered in groups of eight per
five-minute window, and one simulated HTTP 429 triggered a one-hour
cooldown. Both arms used the production LoTW quota SQL, the same
eight-request background cap, and oldest-due dispatch.

| Seven-day result | Completion-relative | Stable phases |
| --- | ---: | ---: |
| Completed account reports | 7,976 | 8,381 |
| Completed dated verifications | 1,400 | 1,400 |
| Deferred attempts before transport | 45,944 | 646 |
| Account gaps over four hours | 86 | 1 |
| Longest account gap | 22 h 10 min | 4 h 38 s |
| Busiest five-minute window, including denied attempts | 370 | 64 |

The one long gap in the phase-aligned run occurred after the cooldown
and would make the account feed stale. The simulation measured schedule
and quota behavior. It excluded hosted Queue latency, the extra dated
polls from stale-feed fallback, report bytes, range splits, and the
source and delivery workloads.

A separate native D1 fixture registered and ran 100 account selections
through the inventory runner with empty LoTW reports. It used 13
simulated quota windows and verified that the first attempted read after
each full window deferred before transport. All 100 completed runs
published positive-only coverage and a durable next wakeup. Their next
wakeups spanned 24 five-minute buckets, with scheduled delays between
about 62 and 180 minutes. The fixture made zero external requests.

## LoFi steady polling scale check

At 100 links, independent five-minute polling would offer 28,800
requests per day to the four-slot ordinary allowance of 1,152.
Established links now share three starts per five-minute window.
The stable 100-link roster uses a 170-minute cycle. The fourth slot
can admit another page or source proof. Smaller rosters of up to
three links retain their configured polling interval. Each link
honors longer server check periods.

The 24-hour simulation used production LoFi admission and pacing
SQL in SQLite. Both arms modeled 100 single-page poll streams,
one background proof request per window and a one-hour vendor
cooldown. The completion-relative arm started with all links due.
The model dispatched the oldest deadline first and used account
order for ties. A simulated proof expired if its window ended.

| 24-hour result | Five-minute polling | Ordered slots |
| --- | ---: | ---: |
| Links with at least one poll | 4 | 100 |
| Completed polls | 1,104 | 844 |
| Polls per link | 0–276 | 7–9 |
| Completed modeled proof requests | 0 of 288 | 250 of 288 |
| Deferrals before transport | 106,383 | 2,156 |

The ordered schedule's longest gap was about 5 h 49 min during
recovery. The simulation measured one deterministic dispatch
order. It excluded hosted Queue latency, competing bootstrap
traffic, actual proof collection and report pagination.

The native D1 fixture completed all 100 baselines, then published one
12-contact delta per link. It retained 1,200 new contacts and 100
durable next wakeups across the 34 five-minute windows in the cycle.
Three sampled roster lookups each read 801 D1 rows. This fixture used
simulated quota windows and pacing and made zero external requests.

### Mixed LoFi bootstrap and recurring work

[Migration 0114](../migrations/0114_inventory_lofi_bootstrap_reserve.sql)
caps bootstrap at 16 requests per five-minute window when a current
scheduled LoFi link has published full source coverage. The native guard
checks the recurring roster after validating request authority and
pacing. A denied reservation leaves the existing counters and
transport untouched and returns the next window as its earliest retry.

The native D1 fixture completed one full source run, then admitted 16
bootstrap reads for a new source, four ordinary reads and four
foreground reads in one simulated window. The 17th bootstrap attempt
deferred before transport. After disabling the only established
link, the next window admitted 20 bootstrap reads. All responses were
local fixtures.

A separate 68-window model covered two nominal cycles for 100
established links. Each window offered 20 bootstrap reads and one
ordinary proof request alongside scheduled polls. Both arms used the
native quota and pacing SQL, with bootstrap first when deadlines tied.

| Completed work in two cycles | Prior admission | Ordinary capacity reserved |
| --- | ---: | ---: |
| Established links reached | 34 | 100 |
| Scheduled polls | 67 | 200 |
| Modeled proof requests | 0 | 68 |
| Bootstrap reads | 1,293 | 1,088 |
| Deferrals before transport | 76,977 | 748 |

Both arms reached the same 20-request nonforeground ceiling. This
model measured scheduling and admission with synthetic responses.
Hosted Queue timing, pagination and actual proof collection were
outside the model.
