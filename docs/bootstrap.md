# Sync scope and existing history

A destination's scope describes which LoFi contacts Ferry should
reconcile. It stays independent of opaque upstream cursors.

| Scope | Eligibility |
| --- | --- |
| All LoFi history | Contacts present in the linked source log |
| Since a date | Contacts on or after the selected UTC QSO date |
| From now on | New source contacts after the verified setup boundary |

Full history uses the contact dates in LoFi to plan remote windows. A
remote book with older unrelated records does not need a complete scan.
The initial LoFi scan can still supply operation context and existing
IDs. A prospective setup uses a ready all-client baseline and the first
observed birth of each source UUID. Edits of existing contacts retain
their original birth.

Historical matching distinguishes verified existing records, operating
detail conflicts, incomplete coverage and inventory absence. A grid-only
conflict can still be adopted as existing history when the same contact
is unique in both directions and its exact identity agrees. Adoption
records the association without uploading or changing the destination.
An absence must still pass fresh source and destination checks before
first delivery.

When an adopted contact's effective LoFi grid changes and still differs
from the same destination record, the comparison flags it for correction
review. The adopted mapping continues to prevent a duplicate upload.
For LoTW, a correction must preserve the remote record's exact identity,
including its receive band, and use the corrected signed Station Location.
QRZ corrections require manual review because replacement can insert a
record or reset its confirmation. See [LoTW confirmation updates](https://lotw.arrl.org/lotw-help/updatingconfirmations/)
and the [QRZ API guide](https://www.qrz.com/docs/logbook/QRZLogbookAPI.html).

A scope change fences obsolete work. Preserve settled mappings and any
attempt that might already have reached a provider.

The Worker binds matching and delivery authority to the current scope
version. Changing that version invalidates stale prepared evidence.
Forward eligibility uses the first immutable birth after a completed
all-client baseline and a committed delta. This is local evidence from
observed replay. [Scope and dispatch tests](../tests/inventory-sync-scope.test.ts)
· [Personal-log evidence](evidence-inventory-fresh-start.md)
