# LoTW actual-contact preflight evidence

Updated **2026-10-25 UTC**. Production exports remain disabled. This page
records unsigned checks, history queries and a serial-status observation for one actual contact. The
[signing evidence](evidence-signing.md) separately documents synthetic signatures,
released TQSL source and local Worker compatibility; the
[certificate checks](lotw-certificates.md) explain the preflight limits.

The separate **2026-10-25** native synthetic comparison now verifies canonical
bytes and public-API signatures for six- and eight-character grid fixtures.
Deployed profile 3 holds unverified FST4W signing while preserving old exact
identities for recovery. Signed `0386af30` includes these changes with all eight
controls closed; see [the deployment receipt](deployment.md). The dated
actual-contact checks below used the earlier `f2c41cb3` / profile 2. Neither the synthetic result
nor the profile correction proves personal-key signing or ARRL acceptance.

## Certificate-status checkpoint — f2c41cb3

At **23:00:35.114 UTC**, a separate exact-`f2c41cb3` diagnostic completed one
normal, budgeted certificate-status GET. ARRL reported the selected certificate
**unrevoked**. The helper selected the actual decrypted credential's unique
certificate for the same contact, checked its dates and key-material presence,
and rechecked the unchanged contact, route, credential and ownership bindings
around admission and transport. Its protected packet passed **29 offline cases**,
types, formatting and independent source/host review.

The inner run took **8.121 seconds / 78 D1 RPCs / 88 SQL statements**, including
the two live attestation calls and excluding proxy startup/disposal. Its sole database mutation was one
ordinary vendor-budget reservation. It made no source or history request and
created no proof, stage, attempt, claim or cutover. The final independent
**23:00:34.070 UTC** attestation confirmed the same production Worker and all
eight controls closed; the proxy was disposed afterward.

This is a finite serial-status observation, not certificate-issuer verification,
proof that the private key can sign an accepted artifact, or ARRL upload
acceptance. It neither renews the earlier source/history evidence nor supplies
write authority. Signing, upload and exact supported-projection readback remain
unobserved. The normal path must repeat current checks before any separately
authorized LoTW trial; a QRZ-only authorization cannot authorize that trial.

## Three-day diagnostic checkpoint — f2c41cb3

The separately reviewed exact-`f2c41cb3` packet passes **24 native offline cases**,
strict types and formatting. A SELECT-only plan for the same contact succeeded
at **22:28:02.816 UTC**: one unique route, complete ownership coverage with zero
candidates, one locally date-valid certificate and full eight-character grid
preservation. It used **35 D1 RPCs / 39 SQL statements**, made no vendor/source
request and changed no row. An earlier stale binding held; the later plan
explicitly re-read the same contact rather than silently changing its binding.

At **22:30:58.466 UTC**, explicit verification stopped at the three-day-history
phase. The normal coordinator had made one positive collection and one final
drain, minted a proof at **22:30:50.081 UTC**, and passed the strict metadata
audit for both routes. The run used **101 D1 RPCs / 131 SQL statements**, including
ordinary proof/checkpoint and vendor-budget bookkeeping. Its raw LoTW request
counter stayed **zero**: the local transport path stopped before a GET reached
the vendor. The reported category is `unexpected_failure`; a separate diagnostic
is tracing the local guard without changing its policy or bounds. The held run's
final proof/readiness flags are false, and it establishes no three-day absence.

The separate, independently reviewed diagnostic repeated the same-contact
current planning and normal proof collection. At **22:42:33.579 UTC**, it passed:
one positive collection plus the mandatory final drain minted a new proof at
**22:42:23.747 UTC**, and **one actual LoTW GET** returned a valid complete empty
report for the preceding/current/following UTC dates and exact own/worked calls.
The same proof remained current at the final check, with **288,387 ms** left;
strict metadata and complete ownership checks passed before and after admission
and response. The inner run took **15.485 seconds / 137 D1 RPCs / 171 SQL
statements**, excluding proxy startup and independent attestation. All eight
controls were closed at the final **22:42:32.425 UTC** attestation and again at
**22:43:01.478 UTC**.

Its fixed local trace recorded no failure. The earlier pre-GET failure did not
recur; its cause remains unknown. The diagnostic added bounded observation only,
without changing guards, deadlines, SQL batches, source/vendor request caps or
retry behavior. No prior source proof was reused. This is finite host diagnostic
evidence, not scheduled Worker execution or standing absence authority. Its
`sourceExportProofVerified` and `completeEmptyThreeDayReport` are true;
`freshVendorChecksComplete`, certificate-status, signing, ARRL-upload acceptance,
global source-boundary and write-authority flags remain false.

The **22:43:13.471 UTC** post-diagnostic backup verifies a 42,862,933-byte snapshot,
36 migrations, all 3,327 exact ownership ciphertext records, three credentials
and the tenant key. One proof and its matching retention row are preserved;
attempts, pins, cutovers and raw historical references remain zero. Integrity/FK
checks and two isolated quarantines pass. The snapshot has 2,803 QRZ
owners/markers, a clean 4,146-contact index and complete 9,981-input ownership
coverage.

The separate **22:43:58.546 UTC** immutable comparison against the **21:28 UTC
baseline** preserves every original field, including ciphertext and creation
time, of 3,327 claims, 2,689 QRZ owners and markers, and 3,294 exact ownership
records. No prior row changed or disappeared; additions are 114 QRZ
owners/markers and 33 exact records. This comparison uses that earlier baseline,
not the 22:29 pre-run snapshot. Neither operation restores production or permits
a vendor write.

All eight controls remained closed. No signing, preparation, attempt, upload or
vendor mutation occurred. The verified **22:29:48.108 UTC** pre-run backup has
36 migrations, all 3,327 exact ownership records, zero attempts/proofs/pins and
two isolated quarantines. The separate later serial-status observation is
recorded above; actual signing/upload acceptance and supported-projection
readback remain open. This diagnostic
does not delay the restricted QRZ first-insert trial.

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
eight-character requirement on other contacts. The deployed historical matcher
accepts valid nested 2/4/6/8-character grids for a unique historical candidate
within the inclusive ±30-minute window when every other current comparison agrees.
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

The earlier unsigned snapshot and single-day diagnostic packets report
`sourceExportProofVerified`, `freshVendorChecksComplete`,
`arrlUploadAcceptanceVerified` and `writesAuthorized` as false. Those observations
supply field/certificate-date compatibility and a finite scoped absence observation.
The later current-release three-day and serial-status checks above retain their
separate, dated scopes; no packet grants continuing write authority. Before a
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

## Shared historical grid policy release

Signed revision `0dad1031507bde4798bedef68e12c582f3af1889` deployed at **2026-10-24 09:43 EDT**, Worker
`6d745929-708d-40e3-bd00-d29c084185f3` at 100% traffic. All **1,373 tests** and required release checks
passed in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40098125350).
Independent version, HTTPS and asset checks confirm all **eight export controls
closed**. All 31 migrations and 32 mandatory guards remain verified; no migration
or vendor mutation occurred.

Historical grid compatibility now accepts valid nested **2/4/6/8-character**
regions for both QRZ and LoTW under the existing exact-identity, other-field and
ownership checks. Original source and remote precision remain intact; new exports
retain the most accurate supported source value. The separate published
**±30-minute candidate policy** is implemented and tested, including primary-mode
and LoTW mode-group comparisons, UTC precision, bounded inputs and unknown-data
holds. It has no production reconciliation consumer and grants no adoption,
absence, correction or export authority.

Next: finish the bounded source comparison index, current source/remote uniqueness,
durable historical ownership and association-only stage/dispatch restrictions.
Extend LoTW retained coverage across UTC day/week boundaries before using the
wider window for adoption. Then review actual identity/location conflicts and
refresh exact source/vendor evidence for the separate export-readiness packet.
Exports remain disabled; no first-write trial is authorized by this release.
