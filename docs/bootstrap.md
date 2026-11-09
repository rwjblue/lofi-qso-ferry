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

Historical comparison results store a stable primary reason in
`match_results.reason`. For example, `historical_freq_differs` means
the transmit frequency disagrees after applying the historical tolerance,
`historical_my_lat_differs` identifies a latitude disagreement, and
`historical_my_gridsquare_unavailable` identifies a missing destination
grid when the LoFi record supplies one. Field codes use the lowercase
ADIF field and end in `_differs` or `_unavailable`. The dashboards group
current comparison counts by reason. Each result records the first
blocking condition in comparison order, so one contact contributes to one
reason count even when several fields differ. Migration 0139 schedules
rechecks of existing historical comparisons to replace generic reasons.

When an adopted contact's effective LoFi grid changes and still differs
from the same destination record, the comparison records
`historical_grid_changed`. The adopted mapping continues to prevent a
duplicate upload. With grid corrections enabled, Ferry can resubmit a
LoTW QSO with a corrected signed Station Location. It requires a fresh
source proof and preserves the remote contact's exact identity,
including its receive band. A correction is complete after readback
verifies it. LoTW may refuse a change that would affect protected award
credit. QRZ discrepancies remain visible because its replacement call
can insert a record or reset its confirmation.
[LoTW confirmation updates](https://lotw.arrl.org/lotw-help/updatingconfirmations/)
· [QRZ API guide](https://www.qrz.com/docs/logbook/QRZLogbookAPI.html)

A scope change fences obsolete work. Preserve settled mappings and any
attempt that might already have reached a provider.

The Worker binds matching and delivery authority to the current scope
version. Changing that version invalidates stale prepared evidence.
Forward eligibility uses the first immutable birth after a completed
all-client baseline and a committed delta. This is local evidence from
observed replay. [Scope and dispatch tests](../tests/inventory-sync-scope.test.ts)
· [Personal-log evidence](evidence-inventory-fresh-start.md)
