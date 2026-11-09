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
