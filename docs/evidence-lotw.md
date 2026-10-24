# LoTW actual-contact preflight evidence

Updated **2026-10-24 08:15 UTC**. Production exports remain disabled. This page
records an unsigned, offline check of one actual retained contact. The
[signing evidence](evidence-signing.md) separately documents synthetic signatures,
released TQSL source and local Worker compatibility; the
[certificate checks](lotw-certificates.md) explain the preflight limits.

## Unsigned snapshot check

At **08:15:11.711 UTC**, a protected helper inspected one candidate from a newly
verified production SQL backup, 42.278 seconds after backup completion. The SQL
was restored only into in-memory SQLite. After integrity and schema checks, the
helper enforced both SQLite `query_only` and a SELECT-only adapter. It used the
normal Store, source projection, route matching, identity and trial-audit code,
then called `canonicalSigningData` to validate the actual station/contact fields.
It did not call either signing function or any vendor endpoint.

| Check                                                                      | Observed result                                                            |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Candidates considered / inspected                                          | 1 / 1                                                                      |
| Current source policy, membership, context, revision and ledger binding    | Passed in the snapshot                                                     |
| Retained dependencies, credentials and quiet period                        | Passed in the snapshot                                                     |
| Matching signing certificates / certificates covering the QSO date         | 1 / 1                                                                      |
| Selected certificate validity dates                                        | Valid at the check                                                         |
| Normalized key material and readback credentials                           | Present                                                                    |
| Canonical station/contact fields                                           | Valid under `ferry-lotw-v2-us-ca-2`                                        |
| Source grid                                                                | Eight characters, preserved in full                                        |
| Source timestamp                                                           | Fractional seconds retained; whole-second destination projection validated |
| Frequency                                                                  | Representable at the supported LoTW readback precision                     |
| Parent-mode substitution / county enumeration review                       | Neither needed for this contact                                            |
| Conflicting claims, unresolved or missing-state attempts, existing mapping | None in the snapshot                                                       |
| LoTW `first_insert_candidate`                                              | **0**; normal metadata audit remained false                                |
| Diagnostic SQL reads / writes                                              | 7 / 0                                                                      |
| Signatures, vendor requests and production mutations                       | 0 / 0 / 0                                                                  |

The LoTW route remained `inventory_pending`; the helper did not change its
classification or treat retained inventory as fresh absence. Cached connection
summaries for login, certificate dates and serial status were `ok`, but no fresh
login or ARRL status request occurred. Key-material presence is not a new
key/certificate authentication test. Canonical field validation does not prove
signature acceptance or ARRL processing.

The eight-character grid belongs to this contact. Ferry preserves each contact's
supported four-, six- or eight-character grid; this result imposes no
eight-character requirement on other contacts. Historical lower-precision grids
remain separate association-review holds and are never silently truncated or
adopted because outbound signing supports more precision.

## Remaining acceptance boundary

This packet reports `sourceExportProofVerified`, `freshVendorChecksComplete`,
`arrlUploadAcceptanceVerified` and `writesAuthorized` as false. It supplies
actual-contact field/certificate-date compatibility evidence only. Before a
future LoTW trial, the normal path still needs current source proof and complete
dependency checks, fresh destination absence or a reviewed exact association,
current certificate status, explicit contact/destination scope and authorization.
An upload acknowledgement would establish **submitted**; exact subsequent
supported-projection readback is required for **observed** acceptance. QSL
confirmation is separate.

LoTW requires separate authorization work. The default-off QRZ fresh-first-insert
capability explicitly excludes LoTW. Current LoTW delivery still uses the
source-boundary authorization mode, so the QRZ result and a per-contact source
proof cannot turn on LoTW or assert the global source-boundary contract. Keep
`SOURCE_BOUNDARY_VERIFIED=false` and the export controls closed until an appropriate
LoTW policy and scoped acceptance procedure have been reviewed. No signature,
upload, gate change or ARRL acceptance claim follows from this offline check.
