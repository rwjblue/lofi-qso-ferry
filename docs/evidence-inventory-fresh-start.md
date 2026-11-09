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
unless the selection supplies dates. LoTW requires dates for each
bounded report.

```json
[
  { "connection": "lofi-link" },
  { "connection": "verified-qrz-link" },
  { "connection": "lotw-link", "from": "2026-10-01", "through": "2026-10-31" }
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

An ambiguous or invalid response during a covering read gets one delayed
retry at the same cursor. A successful page clears the retry marker.
Persistent ambiguity leaves the run held. Only terminal publication
advances the committed checkpoint. After a multi-page recovery, the
next scheduled poll is at least 24 hours later, so an idle selection
that requires a covering scan uses at most one scheduled scan per day.

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
and no delivery attempts existed. Full-book live verification remains
unqualified under these response failures.

Two alternating read-only probes at the held cursor reproduced an unusable
LOGID in each 250-record response. Both 125-record responses validated
and advanced. A later probe returned valid pages at both sizes and also
validated the next 125-record page, so the failure was intermittent.

On an invalid LOGID during a covering scan, the reader retries once at
the same cursor with half the page size, down to 32 records. Only a full,
valid smaller page can save the new size and cursor. An incomplete
smaller result supplies no evidence for finishing the selection.

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
