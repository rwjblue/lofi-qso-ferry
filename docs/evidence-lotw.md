# LoTW actual-contact preflight evidence

Updated **2026-10-24 08:51 EDT**. Production exports remain disabled. This page
records an unsigned snapshot check and a later fresh query for one actual contact. The
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
eight-character requirement on other contacts. The deployed historical matcher now accepts valid nested 4/6/8-character grids
for a unique exact contact identity when every other current comparison agrees.
Both original grids and durable ownership remain intact. This association does
not establish exact full-grid upload acceptance; strict readback remains separate.

## Fresh scoped read

At **09:20:55.938 UTC**, one bounded LoTW query for the pinned contact completed
with zero records through a protected host harness. The helper reproduced the
original snapshot selection, then
checked current source versions, exact fields, route, destination and credentials
before reserving budget, before transport and after the response. Date, station
and worked-call scope, full framing, declared count and every returned identity
were validated defensively around the exact deployed adapter. The fresh response
reported absence with stable scope; no source identity or lower-precision history
was adopted or changed.

The run made one vendor read and 41 database queries: 40 reads and one ordinary
shared-budget reservation. Seven controls were closed before and after, with the
final check at **09:21:02.621 UTC**. Attempts, cutovers and stage guards stayed zero.
No signing, source/proof/cache/ledger changes, upload or vendor mutation occurred.
This provides finite destination absence evidence for that observation. It does
not establish current certificate status, a LoTW source-proof authorization mode,
first-insert eligibility, signature or ARRL upload/readback acceptance. The LoTW
helper did not assert a source proof; the earlier same-contact cloud proof was
checked through the separate QRZ phase. Future LoTW delivery must perform its own
current proof and complete fresh checks under its separately reviewed policy.

## Remaining acceptance boundary

Both diagnostic packets report `sourceExportProofVerified`, `freshVendorChecksComplete`,
`arrlUploadAcceptanceVerified` and `writesAuthorized` as false. Together they supply
field/certificate-date compatibility and a finite scoped absence observation. Before a
future LoTW trial, the normal path still needs current source proof and complete
dependency checks, fresh destination absence or a reviewed exact association,
current certificate status, explicit contact/destination scope and authorization.
An upload acknowledgement would establish **submitted**; exact subsequent
supported-projection readback is required for **observed** acceptance. QSL
confirmation is separate.

Production now has separate default-off LoTW first-insert authority. It is
deployed and disabled; broader source-boundary authority remains unproved.
The QRZ result and a per-contact source proof cannot themselves turn on LoTW or
assert the global source-boundary contract. Keep `SOURCE_BOUNDARY_VERIFIED=false`
and all export controls closed. No live signature, upload, gate change or ARRL
acceptance claim follows from these checks.

## Separate LoTW first-insert implementation

The following implementation is signed, pushed and deployed with all eight
controls closed. All 1,338 tests and release CI pass; live acceptance remains
outstanding:
1. Validate every returned LoTW record against the sent dates and optional
   station/worked-call filters before evaluating absence. Reject malformed
   identities while preserving valid minute precision and historical modes.
2. Check the previous, current and following UTC dates for exact own/worked
   calls, without band or mode filters. Only a valid complete zero-record report
   passes; any record or failed response holds. The helper has 58 new tests,
   with all 111 helper and existing adapter tests passing. The observed one-day
   production query does not satisfy this stronger policy.
3. Pin `lotw_fresh_insert` separately from QRZ and source-boundary authority.
   Migration `0032` widens two mode constraints while retaining existing rows,
   foreign keys, immutable pins and original guards. LoTW structural eligibility
   excludes accepted/mapped history and unsafe or missing attempt states.
4. Repeat the three-day check before signing and before dispatch of a prepared,
   known-unsent artifact. Check current certificate status and validate the exact
   single-contact upload after vendor-budget admission. Query failures retain
   known-unsent state; uncertain/submitted attempts never become fresh inserts.
5. Add default-off `LOTW_FRESH_INSERTS_ENABLED`, independent service admission,
   reconciliation-policy refresh, health/admin reporting and deployment checks.
   Combined first-insert status never claims source completeness. Every configured
   environment has eight closed controls, independently verified in production.

The scheduler fixture proves one LoTW upload followed by separate submitted and
observed receipts, with no QRZ write or source-wide cutover. All 13 source-export
scheduler tests and 10 metadata-audit tests pass. This is synthetic evidence,
not production signing or upload acceptance. The metadata audit now uses the
same structural LoTW eligibility view; a candidate still carries false source-
proof, fresh-vendor-check and write-authorization flags until those are separately
established. This does not revise the older snapshot results above.

At **09:52:16 UTC**, migration `0032` also passed an isolated in-memory SQLite
rehearsal against the hash-verified 08:14 production backup. All 56 tables and
38,547 rows were unchanged, every existing trigger definition was retained, and
four new LoTW guard triggers were added. Integrity and foreign-key checks passed.
No production read/write or vendor request occurred. This is an additional real-
data compatibility check, not a production D1 migration or a refreshed backup;
local D1 tests separately cover populated immutable pins and atomic rollback.
The protected result is `/private/tmp/ferry-lotw-backup-migration-check-result.json`.

The three-day empty-report rule is conservative Ferry policy, not an ARRL
uniqueness guarantee. ARRL's [correction identity](https://lotw.arrl.org/lotw-help/submitting-qsos/)
requires matching time to the second, while [QSL matching](https://lotw.arrl.org/lotw-help/frequently-asked-questions/#datamatch)
allows a 30-minute difference and mode groups. The [query contract](https://lotw.arrl.org/lotw-help/developer-query-qsos-qsls/)
also warns that downloaded modes can differ from locally recorded modes. A
calendar-day-only query can miss a neighboring record across midnight. These
contracts do not justify treating a mode-only conflict as absence.

Only a currently prepared, known-unsent first insertion could use this mode.
Submitted, uncertain, missing-state or previously accepted attempts remain
ineligible regardless of an empty query. An acknowledgement means submitted;
empty subsequent readback cannot authorize resubmission. See ARRL's
[query contract](https://lotw.arrl.org/lotw-help/developer-query-qsos-qsls/) and
[submission contract](https://lotw.arrl.org/lotw-help/developer-submit-qsos/).
QRZ release and acceptance remain the first rollout milestone.

The final combined runtime in signed release `12f636b3` passes all
**1,338 tests** and `mise run check`: formatting, lint, both TypeScript checks and
the Worker build. The test phase took 865,489 ms. This includes 23 new delivery
cases, populated migration/rollback tests and the older QRZ/source-boundary paths.
Independent delivery and service reviews found no remaining blocker. The run
caught and fixed a lease-release race in the new known-unsent history hold:
dispatch now awaits the fenced retry transition before releasing its lease.

Signed release `12f636b3` and migration `0032` are deployed. All eight controls
remain closed, and no live signature/upload occurred. Fresh three-day production
history, final-release source proof/certificate checks and actual ARRL acceptance
remain outstanding; the older one-day observation cannot substitute for them.

## Final-release three-day diagnostic (2026-10-24, 08:03 EDT)

The release-specific helper verifies the exact signed `12f636b3` runtime, the
explicit deployed Worker, all eight closed controls, and the same private
candidate before and after one normally budgeted GET. It uses the actual
three-day first-insert helper and admits no source, proof, ledger or attempt
writes, signing or upload. Source/QRZ freshness remains explicitly unverified.
Sixteen offline tests and independent review passed.

The actual invocation at **12:03:26 UTC** stopped during local snapshot selection:
zero candidates satisfied the predicate in the verified 11:48 pre-deployment
backup. One isolated selection read confirmed that result, with zero inspected
candidates. The generic `candidate_changed` stop did not establish that a selected
contact had changed: no candidate was selected. No remote proxy, budget reservation,
certificate check or vendor request occurred. No source/QRZ proof was refreshed.
Fresh three-day history and ARRL acceptance therefore remain open. Use current
eligible metadata for the next bounded packet; do not relax the selection checks
or treat this stop as destination absence.

## Matching correction release

The matching corrections deployed read-only at **2026-10-24 08:51 EDT** as signed revision
`ba8c982a0b67b97e354f1bcb4acc8efe50729097`, Worker `6b07bcf7-ac24-4bcb-abf4-be43766c8938` at 100% traffic.
All **1,353 tests** and required release checks passed in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40094384509).
Independent readback confirms all eight export controls closed, healthy HTTPS
and matching assets. There was no migration or vendor write. The grid-compatible
LoTW association, exact decimal frequency conversion and valid numeric zone
comparison are now available to normal reconciliation. Their policy version wakes
held work once; the 2,858 grid and 87 artifact-related frequency counts describe
the investigation cohorts, not a claim that every row has already reconciled.
