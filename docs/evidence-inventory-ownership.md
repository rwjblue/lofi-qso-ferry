# Historical inventory ownership evidence

Status: local permanent ownership and guarded historical association publication,
2026-11-08. [Automatic adoption](evidence-inventory-adoption-scheduling.md) is
implemented in the later coordinator milestone. Delivery ownership integration
and deployment remain unfinished. No production data was reset and no upload was
performed.

## Identity and retained evidence

[Migration 0051](../migrations/0051_inventory_historical_ownership.sql) and
[InventoryOwnership](../src/inventory-ownership.ts) introduce a permanent ownership
namespace independent of rebuildable comparison generations. Its tenant HMAC key
survives credential changes and KEK rewrapping. Tokens use a separate ownership
domain rather than treating a candidate bucket as a remote identity.

An owner is the original LoFi logical account identity plus QSO UUID. The archived
source scope remains an audit reference; changing an inventory binding or replacing
a connection cannot transfer that owner. QRZ claims use canonical decimal LOGID
within the logical book, so changing the remote contact's call/time does not make
its LOGID available to another source. Leading zeroes do not distinguish claims.

LoTW retains the original literal time, including minute precision, and explicit
mode/group fields. It has no invented stable vendor receipt ID. A claim hash names
the archived identity fields; half-hour HMAC buckets find candidates and the shared
historical matcher checks time, mode and satellite compatibility. Lookup searches
all retained LoTW ownership for the tenant/station, including inactive connections
and other query/signing accounts. Different accounts cannot hide a competing owner.
The same LoFi QSO can reuse its exact archived evidence in another signing account.

Provider-wide holds represent unresolved delivery, unverified owners and unsupported
identities. They prevent a bounded registry lookup from reporting usable ownership.
There is no automatic hold-clearing API yet: clearing requires a future resolver
with positive evidence. Current outbound attempts and trusted ledger evidence also
block new historical adoption for their provider. This is a transition protection,
not an import/dual-write requirement for a fresh contact database. New delivery must
publish its own ownership and uncertainty evidence before this barrier can be
replaced by the fresh delivery path.

## Association publication

[InventoryAssociations](../src/inventory-associations.ts) prepares up to twenty
currently matched source contacts for one destination. Existing associations are
returned as preserved before looking for a replacement. Preparation loads the
captured source/receipt projections together, checks the permanent owner registry
and encrypts new original remote evidence. The manifest exposes opaque references
and fixed reasons rather than plaintext ADIF or narrative.

Source/receipt bodies and ownership candidates share one 128-record/four-MiB
encrypted/plaintext allowance. Overflow is a hold. Native metadata admission
withholds ciphertext when the candidate or byte limit is exceeded; there is no
usable truncated registry. LoTW also checks competition between remote tuples in
the same prepared cohort, even when their individual source matches are unique.

One native batch stages the bounded rows, admits them, inserts required encrypted
evidence and immutable associations, and commits a receipt. Admission and final
commit validate account/lease authority, current nonrevoked/unexpired credentials,
source/book bindings, exact result versions and source/receipt payload references.
Each distinct matching dependency set is revalidated once at each boundary. Its
existing native closure checks still cover source visibility, coverage, membership,
projection semantics and all forward/reverse buckets, including empty probes.

A provider ownership-version comparison fences lookup-to-commit races. Each new
evidence row and association advances that version; final commit requires exactly
the expected advance. A new hold, competing association, late authority change or
late SQL failure rejects the entire transaction. Lost acknowledgements recover the
original immutable receipt without refreshing observations or replacing evidence.

These are historical, read-only associations. They do not create Ferry-created
provenance, confirmation, signing artifacts or upload attempts. The original source
and remote projection bodies and the complete matching dependency set remain pinned.
Source edits preserve that original baseline. Native guards also prevent current
stage/attempt/dispatch entry points from writing an adopted contact. Write blocks
join logical source/book identities and remain effective after connection rebinding,
including disabled connections.

## Native measurements and verification

For twenty distinct matched pairs sharing one source operation:

| Adoption publication boundary | Measurement |
| ----------------------------- | ----------: |
| Explicit native statements    |           6 |
| Rows read                     |       4,657 |
| Rows written                  |         325 |

An initial implementation reread each shared matching set per contact and consumed
73,369 rows. Validating each distinct set once reduced those reads by approximately
94%, while retaining per-contact input checks. These figures cover adoption
publication only; preparation, matching, ownership-key setup, receipt reads and
lease operations remain additional work. Six statements are not six complete-cohort
binding RPCs. The complete-cohort six-RPC target remains unmet.

The native D1 tests cover canonical QRZ identity, tenant isolation, KEK rewrapping,
literal LoTW minute/group evidence, inactive/cross-account ownership, intra-cohort
competition, candidate/byte admission, frozen baselines, connection rebinding,
read-only outbound guards, retained proof pins, credential and dependency races,
manifest omissions/substitutions, prior delivery evidence, late rollback and
lost-acknowledgement/competing-preparation recovery. Absence or stale comparison
results create neither ownership nor an adoption lease.

The actual [Worker test](../tests/inventory-matching-worker.test.ts) runs matching
and adoption for twenty pairs, preserves all twenty read-only mappings on retry,
releases both leases, and makes zero external requests. Source checkpoints and
credential ciphertext remain unchanged.

The complete inventory regression passed **352 tests** with no failures, skips or
cancellations. TypeScript, lint, formatting and the Worker dry-run build passed.
Logs are `/tmp/lofi-ferry-inventory-adoption-regression.log`,
`/tmp/lofi-ferry-adoption-types-final-pass.log`, `/tmp/lofi-ferry-adoption-lint.log`,
`/tmp/lofi-ferry-adoption-format.log` and `/tmp/lofi-ferry-adoption-build.log`.
These counts include the Worker and adoption tests rather than adding overlapping
focused runs.

The existing historical-association and QRZ/LoTW fresh-insert guard selection also
passed **48 tests** with the cumulative schema. Its log is
`/tmp/lofi-ferry-adoption-existing-delivery.log`; it is a separate selection from the
inventory regression.

## Encrypted capture replay

The [comparison trial](../scripts/inventory-comparison-trial.ts) copies the original
three-provider capture before applying the new schema. It now evaluates historical
adoption after publishing each matching cohort. The partial source inventory still
produces ten incomplete comparisons for LoTW and ten for QRZ, all skipped as
`source_unavailable`. No association or ownership is manufactured from incomplete
coverage. Vendor HTTP requests and uploads are zero.

A fresh process recovered twenty matching results, all 42 encrypted projections and
zero historical associations. Canonical observations, checkpoint vectors and
credentials stayed unchanged. The private directory ends in
`445d751a-235e-42b6-b905-04aa5f032ef0`; database allocation was 14,778,368 bytes.
The earlier result-only capture also reopens without migration 0051. Logs are
`/tmp/lofi-ferry-adoption-capture.log`, `/tmp/lofi-ferry-adoption-reopen.log` and
`/tmp/lofi-ferry-adoption-format-compat.log`.

This small incomplete capture verifies safe refusal and restart, not positive
adoption on a complete personal log, full-log elapsed time or storage density.
Permanent evidence, retained adoption manifests and pinned complete matching sets
must be included in the larger storage benchmark. Proof compaction/collection must
preserve ownership and original baselines; no collector is implemented yet.

## Remaining integration

The later [managed real-service trial](evidence-inventory-managed-trial.md)
completed the personal LoFi/QRZ selections and positively adopted two
twenty-contact historical cohorts without service writes. Retrying the
measured cohort preserved its twenty mappings. Its native publication
cost was 197,429 reads and 325 writes in six statements; complete
preparation/publication/lease work was 15 calls and 367,276 reads. These
real-log counts exceed the small fixture above. Investigation and the
complete-cohort RPC target remain open. The later
[automatic replay](evidence-inventory-adoption-scheduling.md) measures the
remaining 2,917 matches under the new coordinator.

Base `match_results` continue to describe comparison facts. The automatic planner
still needs an ownership-aware selection layer and durable claimed-work completion.
Ownership changes must invalidate that planning authority without making an adoption
invalidate its own captured comparison facts. Delivery must consume historical
write blocks and publish new Ferry ownership/uncertainty directly in the fresh model.
New-format source proofs, QRZ submission, LoTW batch membership/recovery, retained
payload collection, restore quarantine and account-preserving cutover remain open.
