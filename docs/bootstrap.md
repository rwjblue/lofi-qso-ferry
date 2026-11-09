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
detail conflicts, incomplete coverage and inventory absence. An absence
must still pass fresh source and destination checks before first delivery.
A scope change fences obsolete work. Preserve settled mappings and any
attempt that might already have reached a provider.

The dashboard and settings API are implemented. Release checks cover
native scope enforcement and forward eligibility. [Release checks](../ROADMAP.md)
· [Personal-log evidence](evidence-inventory-fresh-start.md)
