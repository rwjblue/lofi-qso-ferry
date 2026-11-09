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

A local census examined 58 private captures. The 55 with the same
client all held the rejected bearer. The real rehearsal still needs
a current same-client bearer before its next LoFi read.

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
