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
  {"connection": "lofi-link"},
  {"connection": "verified-qrz-link"},
  {"connection": "lotw-link", "from": "2026-10-01", "through": "2026-10-31"}
]
```

Omit `--plan` to continue the existing selections. Each invocation
drives the native baseline and comparison jobs and saves aggregate
progress, coverage, D1 cost and database size in the rehearsal.
A missing or rejected LoFi bearer pauses source reads and lets the
selected destinations finish. The command retains the source checkpoint
and reports incomplete source coverage. The durable write lock and
read-only transport apply throughout.

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
