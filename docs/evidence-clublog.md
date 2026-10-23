# Club Log integration evidence and boundaries

Checked 2026-10-23. Official help article bodies were retrieved from indexed
search results; direct retrieval of the Freshdesk pages returned 404. No live
account reads, credential checks, uploads, deletes, or deployments were made.
Tests use synthetic records and an injected fetch implementation.

## Documented contracts

- [Supported ADIF fields](https://clublog.freshdesk.com/support/solutions/articles/53202-which-adif-fields-does-club-log-use-)
  documents retained QSO identity, frequency, operator, reports, satellite data,
  notes and several server/confirmation fields. It explicitly says an export is
  not the original uploaded ADIF. Our projection sends identity, frequency,
  operator and reports. It does not send MY_* location, park references,
  comments, confirmation claims or DXCC calculations. STATION_CALLSIGN remains a
  local routing value; the request chooses the destination log. Own grid must
  never be put into GRIDSQUARE, which describes the contacted station.
- [ADIF download](https://clublog.freshdesk.com/support/solutions/articles/3000047458-downloading-oqrs-adif-files)
  specifies POST to getadif.php with email, password and call. Omitting the OQRS
  type filter returns the whole log. No application API key is listed for this
  download. `verifyLogin()` is solely this bounded read; it does not prove upload
  authorization or the validity of the developer key.
- [Application API keys](https://clublog.freshdesk.com/support/solutions/articles/54910-api-keys)
  are developer credentials, distinct from user application passwords. Rejected
  credentials must stop subsequent calls. The client flags auth/rejection errors
  with `suspend`, halts its current instance, never logs raw vendor errors, and
  leaves durable connection suspension to the service layer.
- [Batch upload](https://clublog.freshdesk.com/support/solutions/articles/54905)
  specifies putlogs.php multipart ADIF uploads. Omitting clear merges; clear=1
  erases the existing log. The client never sends clear. HTTP acknowledgement
  precedes background processing, so a batch receipt is `submitted`, never proof
  that a record is present. The client uses realtime.php for newly logged QSOs.
  These instructions also require stopping after every non-200 response. The
  client therefore suspends on redirects, server errors and sent throttle
  responses as well as credential/rejection errors. A possible mutation remains
  uncertain even when the connection must stop; suspension does not prove that
  no upload occurred. Local budget deferrals before sending remain retryable.
- [API usage guidance](https://clublog.freshdesk.com/support/solutions/articles/3000023706-excessive-api-usage)
  prohibits fast serial backfill through the realtime API. Historical uploads
  must use putlogs.php. The initial scheduler may issue only a very small number
  of single-record background uploads under a shared, conservative request
  budget. This is intentionally slow; efficient larger backfills need grouped
  batch preparation and grouped durable receipt handling, not a tighter loop.
- [Delete API](https://clublog.freshdesk.com/support/solutions/articles/54903-how-to-delete-qsos-in-real-time)
  uses destination callsign plus contacted callsign, exact seconds and numeric
  band. It does **not** include mode. A caller must prove uniqueness across modes
  before using it. No bulk delete/clear method is exposed.
- [Update guidance](https://clublog.freshdesk.com/support/solutions/articles/54908-using-adif-to-update-or-delete-qsos)
  permits delete then add for correction, and discourages the special QSLCALL
  rewrite feature outside QSL-management workflows. We do not use QSLCALL or
  assume duplicate uploads update frequency, operator or reports. Such a
  correction requires a separately guarded workflow and fresh readback.

## Conservative implementation limits

The client uses HTTPS POST bodies, rejects redirects, bounds the complete
response to 2 MiB (receipts to 8 KiB), applies a 20-second timeout, performs no
automatic retries, and preserves typed vendor-budget deferrals. Lost or unknown
mutation receipts remain uncertain. Known acknowledgement strings are covered
by synthetic fixtures, not a live vendor receipt capture; unrecognized success
formats require readback reconciliation rather than optimistic acceptance.
The retrieved upload instructions specify HTTP 200 but no exact body or MIME
type. The client accepts valid ADIF and exact plain receipts despite a PHP
text/html content type; actual HTML documents cannot satisfy those validators.
The linked realtime API article (54906) could not be retrieved during this
audit, so its precise success strings remain an explicit validation gap.

Downloads require an ADIF-version header, complete record terminators, valid
identity fields and no unexplained trailing text. Content-Length, when supplied
without content encoding, must match bytes read. The shared parser caps records
at 10,000; larger logs fail instead of silently authorizing backfill. These
checks detect malformed and visibly truncated exports. The documented endpoint
does not provide a total-record count or snapshot token, so truncation exactly
at a valid record boundary cannot be independently detected. No claim of a
transactionally complete snapshot is made.

History adoption requires one exact callsign, timestamp **including precision**,
band and mode within the bound account. Nearby competing records remain
ambiguous. Supported optional source fields must be present and equal remotely;
decimal frequency formatting differences are normalized. Remote narratives,
confirmation/award state and fields Club Log does not retain are not compared or
claimed synchronized. A syntactic upload acknowledgement is not a QSL
confirmation and does not establish matching remote content.

An intended identity is reserved atomically when its immutable attempt is
claimed for dispatch. Competing source UUIDs cannot adopt or submit an identity
owned by another current mapping, retained prior record or unresolved attempt.
Reservation does not imply remote acceptance; definite rejection or cancellation
releases it, while uncertain delivery preserves it even after payload expiry.

For a mapped contact whose source baseline changed without changing identity,
remotely retained frequency, operator or signal-report fields that are absent
locally require manual review. Omitting an ADIF field does not establish that
Club Log cleared it, so such corrections cannot advance the source baseline.
Initial adoption and upload readback still leave fields absent from the source
unowned. This correction check is deliberately conservative: it may also flag a
remote-only optional field after an unrelated supported source edit because the
ledger does not track historical ownership of each field.

SSB USB/LSB radio settings project to SSB. Other distinct submode mappings,
including MFSK/FT4 and MFSK/JS8, lack a verified official readback contract in the
retrieved evidence and initially block rather than silently collapsing modes.
Subsecond source times likewise block. These limits can be widened using
documented mappings and scoped readback fixtures without altering the ledger.

## Regression evidence

The client and scheduler suites use synthetic credentials and intercept every
vendor request. They exercise bounded and malformed inventory handling,
authentication suspension, exact matching, disabled writes, duplicate and
uncertain receipts, and merge-only background uploads. Scheduler coverage runs
QRZ, LoTW and Club Log together: independent history adoption performs no writes;
a forward-new contact respects the quiet period and becomes observed only after
readback derived from its transmitted artifact; supported same-identity
corrections, including removal of a previously sent frequency or report, require
Club Log review; own-location changes leave Club Log's
projection unchanged; and Club Log authentication rejection does not suspend
the other providers. These tests verify local behavior, not a live vendor
contract.
