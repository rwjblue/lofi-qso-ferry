# Lo-Fi receipt writeback investigation

Investigated on 2026-10-30. **Do not enable receipt writeback through ordinary
whole-QSO sync yet.** Both inspected clients preserve unfamiliar QSON fields in
ordinary edits, but neither gives those fields independent conflict semantics.
There are reproducible receipt-loss cases, and a receipt-bearing snapshot can
overwrite a pending contact edit.

The preferred design is Lo-Fi-managed receipt storage keyed by account, source
QSO UUID and destination, updated independently of the contact body. That is a
proposed server capability, not a verified existing API.

## Scope and source versions

The review fetched these upstream default-branch snapshots through the connected
GitHub reader, rather than relying on the older local HaLo and PoLo checkouts:
- HaLo: [54592afcff4fb76f73e6138675814adf9ae5c932](https://github.com/ham2k/halo/commit/54592afcff4fb76f73e6138675814adf9ae5c932).
- PoLo: [2450788d2f30038fdf1194eebed2a085a99a171a](https://github.com/ham2k/app-polo/commit/2450788d2f30038fdf1194eebed2a085a99a171a).
- Ferry: current workspace at 128a3e06cbbecafdbd4329da4470d498b75bf45a.
  The tested projection and Lo-Fi adapter files had no working-copy changes.

These findings apply to the inspected code, not every released or installed
build. No authenticated live Lo-Fi request, source write, destination upload,
credential lookup, enrollment or permission email was performed. The synthetic
checks execute local functions; they are not a live server roundtrip.

## Preservation matrix

| Action                                                      | HaLo                                                                  | PoLo                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Ordinary edit after loading a receipt-bearing contact       | Keeps unknown top-level fields                                        | Keeps unknown top-level fields                                          |
| Serialize that contact for outbound sync                    | Sends the QSON data, including unknown fields                         | Sends the stored QSON data, including unknown fields                    |
| Receive a strictly newer contact containing a receipt       | Stores the whole accepted body                                        | Stores the whole accepted body; also restamps its edit revision locally |
| Receive a receipt-only change with the same edit timestamp  | Skips it                                                              | Skips it                                                                |
| Receive a strictly newer body lacking the old receipt       | Replaces the contact body; no independent receipt merge               | Replaces the contact body; no independent receipt merge                 |
| Save an editor opened before a receipt arrived              | Main editor uses a three-way merge if the stored revision changed     | Saving its older draft can remove the receipt                           |
| Reconcile an offline edit with a newer receipt-bearing body | Newer incoming revision can pass even while the local row is unsynced | Newer incoming revision can pass even while the local row is unsynced   |
| Merge a duplicate import lacking receipt metadata           | Merge helper preserves older-only fields                              | Merge helper can discard older-only fields                              |

"Preserved" means the field survives this client path. It does not establish that
Lo-Fi accepts that field, persists it unchanged, or delivers it to other clients.

### HaLo evidence

The [QSO normalizer](https://github.com/ham2k/halo/blob/54592afcff4fb76f73e6138675814adf9ae5c932/packages/halo_core/lib/src/models/qson_values.dart#L312)
starts from the original map and normalizes known fields; it does not rebuild a
record from an allowlist. The [editor draft](https://github.com/ham2k/halo/blob/54592afcff4fb76f73e6138675814adf9ae5c932/packages/halo_widgets/lib/src/logging_controls_draft.dart#L280)
starts with the edited QSO's complete data. The
[outbound payload](https://github.com/ham2k/halo/blob/54592afcff4fb76f73e6138675814adf9ae5c932/packages/halo_core/lib/src/sync/sync_wire.dart#L72)
also spreads the complete data before adding transport identity and flags.

The [main editor save](https://github.com/ham2k/halo/blob/54592afcff4fb76f73e6138675814adf9ae5c932/packages/halo_widgets/lib/src/logging_controls_submit.dart#L523)
passes its original snapshot as `basedOn`. The
[repository update](https://github.com/ham2k/halo/blob/54592afcff4fb76f73e6138675814adf9ae5c932/packages/halo_core/lib/src/repo/qsos_repository.dart#L529)
rereads the stored row and uses
[three-way field merging](https://github.com/ham2k/halo/blob/54592afcff4fb76f73e6138675814adf9ae5c932/packages/halo_core/lib/src/models/qso_merge.dart#L403)
when its revision changed. A concurrently added receipt survives if the editor
did not change that top-level field. Only `our` and `their` merge per nested field;
a custom receipt namespace is one indivisible value.

That protection is specific to local saves with an appropriate base snapshot.
[Inbound sync](https://github.com/ham2k/halo/blob/54592afcff4fb76f73e6138675814adf9ae5c932/packages/halo_core/lib/src/repo/qsos_repository.dart#L1111)
copies the incoming map and upserts it after the
[revision comparison](https://github.com/ham2k/halo/blob/54592afcff4fb76f73e6138675814adf9ae5c932/packages/halo_core/lib/src/repo/repo_support.dart#L80).
When both edit timestamps exist, a strictly newer incoming timestamp wins
regardless of whether the local row has unpushed edits. A receipt-bearing stale
snapshot with a new timestamp can therefore replace meaningful local content.

### PoLo evidence

[Opening an existing contact](https://github.com/ham2k/app-polo/blob/2450788d2f30038fdf1194eebed2a085a99a171a/src/screens/OperationScreens/OpLoggingTab/components/LoggingPanel/loggingFunctions.js#L37)
deep-clones it. [Field edits](https://github.com/ham2k/app-polo/blob/2450788d2f30038fdf1194eebed2a085a99a171a/src/store/ui/uiSlice.js#L66)
merge into that draft. [Saving](https://github.com/ham2k/app-polo/blob/2450788d2f30038fdf1194eebed2a085a99a171a/src/store/qsos/actions/qsosDB.js#L93)
serializes the complete object, removing specific transient fields rather than
all unfamiliar fields. The own-station batch-edit path also retains the rest of
the object.

However, [sync merge](https://github.com/ham2k/app-polo/blob/2450788d2f30038fdf1194eebed2a085a99a171a/src/store/qsos/actions/qsosDB.js#L183)
skips incoming revisions whose edit timestamp is equal or older, then sends
accepted records through the same whole-record saver. The saver sets
`updatedAtMillis` to local time and replaces the device stamp even when
`synced: true`. An edit timestamp is therefore unsuitable as a portable
receipt fingerprint.

The [logging submit path](https://github.com/ham2k/app-polo/blob/2450788d2f30038fdf1194eebed2a085a99a171a/src/screens/OperationScreens/OpLoggingTab/components/LoggingPanel.jsx#L249)
saves the draft without HaLo's base/current/edited merge. An editor opened before
a receipt arrived can later overwrite the receipt-bearing stored copy. The
[duplicate-import merge helper](https://github.com/ham2k/app-polo/blob/2450788d2f30038fdf1194eebed2a085a99a171a/src/tools/mergeQSOs.js)
also starts from the newer record and only specially combines times/references.

The suggested-contact path clones metadata while assigning a different UUID.
Consequently a receipt must bind to the original source account and UUID as well
as content; mere presence of an upload marker cannot establish delivery.

## Why the timestamp choices do not resolve this

Keeping the QSO's existing edit timestamp makes receipt-only incoming records
lose the clients' equality comparison. Updating that timestamp gets the receipt
accepted, but puts a background bookkeeping write into the same whole-record
conflict ordering as an operator's edits.

A fresh read before writing reduces the race window; it does not make the
read/write atomic or protect edits made on an offline device. Even a server
conditional update alone would not repair the clients' whole-record inbound
replacement behavior if metadata writes advance the contact's edit timestamp.

Receipts may also disappear during later offline edits or replacement/import
operations. Their absence must mean "unknown; consult retained evidence or
reconcile", never "definitely not uploaded; create another record".

## Lo-Fi server guarantees remain unverified

The inspected clients expose whole-record arrays through `POST /v1/sync`. That
establishes the client wire shape, not the server's accepted JSON keys or merge
semantics. A direct lookup of `ham2k/api-lofi` returned 404 through the connected
GitHub account; repository/code searches did not expose a server receipt
contract. This means the server source was inaccessible in this investigation,
not that no private implementation or metadata API exists.

Before implementation, establish with server documentation/source or its
maintainer:
1. Whether arbitrary, namespaced QSON fields are stored and returned unchanged,
   and whether a namespace is reserved for integrations.
2. Whether any metadata-only or conditional update exists, and its exact
   behavior for concurrent body changes, tombstones, operation membership and
   client-supplied edit timestamps.
3. Whether receipt storage can remain independent of contact edit timestamps
   and survive a later full-QSO upload that omits the receipt.
4. How receipt reads/changes are paginated and replayed, with account isolation,
   bounds and deletion behavior.
5. Whether metadata ownership can distinguish a Ferry-issued receipt from
   imported/copied user data.

A successful sequential live roundtrip would verify one preservation example;
it would not establish these conflict guarantees.

## Ferry findings and required design

Ferry's [adapter](../src/lofi.ts) intentionally has no contact-mutation method.
Its existing [ledger](design.md#minimal-retained-state) already retains mappings,
hashes, delivery state, provenance and template bindings.

Three direct synthetic checks against [projection.ts](../src/projection.ts)
showed:
- Adding a top-level receipt changes the ordinary QRZ source fingerprint,
  because it includes the raw QSO template context.
- LoTW's fingerprint ignores the receipt.
- QRZ's remote-preserved narrative branch ignores the receipt.

Naive writeback would therefore queue unnecessary QRZ work and could create a
feedback loop when each export updates its receipt. A future implementation
must explicitly exclude receipt bookkeeping from export-trigger inputs and
prevent templates from turning that bookkeeping into recursive export work.

A usable receipt should bind to source account/UUID, logical destination
account/book, schema/projection version, destination-relevant content hash
(including effective operation/segment/location inputs), delivery status and
observation time. QRZ can include its returned LOGID. LoTW needs separate
submitted and observed-accepted states; neither means confirmed QSL. Retain
created-versus-adopted provenance and immutable template policy as needed; a
generic marker cannot confer authority to replace/delete an historical record.

Keep a durable local outbox and uncertain-outcome ledger. Destination acceptance
and Lo-Fi receipt storage cannot be made one transaction; a failure between them
must not cause a blind reupload. Receipts also do not detect a later manual
destination deletion or eliminate selected-contact source-freshness checks.

**Recommendation:** seek server-managed, independently updated receipt storage.
Continue using the local ledger until the server contract and client race cases
are resolved. Ordinary custom QSON fields could carry a best-effort display
hint, but the observed contact-overwrite risk makes whole-record writeback
unsuitable for enabling Ferry's automatic receipts now.

## Local checks and reproduction

All **21 synthetic checks passed**: 10 PoLo, 8 HaLo and 3 Ferry. Several checks
pass by reproducing the unsafe outcome; this is not a production safety pass.
- PoLo: executed fetched upstream save/read, editor preparation, field-merge,
  batch-edit, sync-merge, duplicate-import and suggested-contact functions in a
  Node VM. Database, identity-key, Redux and scheduling/network boundaries were
  mocked; SQL execution and actual device UI were not tested.
- HaLo: executed fetched normalization, duplicate-import and three-way merge
  helpers plus the exact fetched staleness function with Dart 3.12.2. Normal
  widget save and whole-record sync-upsert wiring were reviewed, not executed.
  Pure radio/ADIF dependencies came from the older local HaLo checkout
  eb1a54ced637bfdd3c5b361a31df0e843edf9867.
- Ferry: executed its actual projection functions on synthetic loose contacts
  with and without a receipt, using Node 24.21.0 and tsx.

The nonsecret local packet is at
`/private/tmp/ferry-lofi-receipt-review-lj6XGv/`. It contains pinned fetched
sources, a manifest, the three check scripts and JSON result lists. From the
Ferry workspace, rerun the Node checks with:

```sh
mise exec -- node /private/tmp/ferry-lofi-receipt-review-lj6XGv/check-polo.mjs
mise exec -- node --import tsx /private/tmp/ferry-lofi-receipt-review-lj6XGv/check-ferry.mts
```

From the existing HaLo workspace, which configures the Dart runtime:

```sh
mise exec -- dart /private/tmp/ferry-lofi-receipt-review-lj6XGv/check-halo.dart
```

The temporary packet is local evidence, not a checked-in fixture or permanent
artifact. No upstream checkout was modified.

## Bounded live canary after a server contract is available

Use a dedicated test account and synthetic operation, with exact HaLo/PoLo build
versions and one allowlisted synthetic QSO. Do not submit anything to QRZ or
LoTW. Prepare a script that refuses writes outside that account/QSO and retains
before/after content comparisons; review that concrete request plan before a
live source write.

Test serial receipt creation/readback, both clients loading/editing/syncing the
record, an editor held open across receipt arrival, an offline edit from each
client, equal revision stamps, competing receipt destinations, a copied UUID and
a deletion/tombstone race. Compare every contact-content field and receipt after
each step. The pass condition includes no lost user edits or resurrection, not
just a surviving receipt. Keep independent evidence before removing test data.
