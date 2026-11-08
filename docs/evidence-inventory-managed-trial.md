# Managed real-service inventory trial

Status: local read-only qualification, 2026-11-08. No production reset,
deployment, push or vendor upload was performed. Account access and linked
credentials remain intact. This extends the earlier
[bounded run trial](evidence-inventory-runs.md) through the current comparison
schema rather than stopping after a few service pages.

## Execution and recovery

[The managed trial](../scripts/inventory-managed-trial.ts) creates a private
native D1 database with the current migrations, copies the three linked
credentials under a new trial encryption key, and activates the read-only
inventory runtime there. The original encrypted capture is opened with
SELECT-only application queries. A fingerprint checks its key identity,
account/connection metadata and encrypted credentials before and after a
continuation. Reports contain aggregate counts, states and costs, without
credentials or raw contacts.

```sh
mise run inventory-managed-trial --capture '/private/path/to/capture'
mise run inventory-managed-trial --resume '/private/path/to/managed-trial'
mise run inventory-managed-trial --resume '/private/path/to/managed-trial' --verify-held
mise run inventory-managed-trial --reopen '/private/path/to/managed-trial'
```

Each invocation defaults to 120 requests and twenty minutes, with explicit
upper bounds. It resumes the same native jobs and never starts the next
ordinary poll after a completed selection. Native request admission and
service pacing remain in force. The strict transport blocks registration,
token renewal, approval email, redirects and service mutations. Credential
renewal is covered separately by runtime tests.

The selections are the full LoFi account, the verified QRZ book's configured
date range, and one known LoTW receipt day from the original capture. A
complete LoTW day is not a complete LoTW account inventory. Reports always
keep account-wide coverage false. No absence classification authorizes an
upload.

The command drives the actual native reader and comparison coordinator in
Node, with persistent native D1. Hosted Queue delivery is excluded. Its
comparison-turn count therefore describes bounded coordinator calls, not
measured hosted Queue requests or production Worker CPU. See the separate
[hosted comparison qualification](evidence-inventory-hosted-comparison.md).

Held selections require explicit `--verify-held`. Verification starts a new
full run for those selections while retaining their records and first-seen
history. It leaves completed selections alone. A private intent is saved
before native publication; ordinary resume can finish that already
authorized intent after a crash, including a lost manifest acknowledgement.
The original run identities and verification replacements remain recorded.
A settled held selection reports `selection_held` and a failing CLI status.
Private versioned reports retain each completed invocation's measurements.

## Observed source baseline and QRZ hold

The initial eight-request invocation accepted one LoFi page, 500 QRZ
records and two LoTW records. QRZ's third fetched page contained 250 records
but was rejected as a whole, preserving its last accepted checkpoint. The
LoTW day completed. A second invocation completed LoFi and drained the
current comparison work without retrying the held QRZ selection.

Across these two invocations LoFi used seven actual sync requests, with
1,000 requested records per stream. The retained source contains:
- 181 active and 43 deleted operations.
- 4,251 active and 17 deleted ordinary contacts.
- 123 active and seven deleted event records.

The source baseline published coverage. Five test-operation contacts are
excluded; three contact projections are held for a frequency/band conflict
or incomplete operation context. Receipt coverage still prevents complete
cross-service classification at this checkpoint.

| Invocation          | Actual HTTP requests | Read/control turns | Comparison turns | D1 calls | SQL statements | Rows read | Rows written | Elapsed |
| ------------------- | -------------------: | -----------------: | ---------------: | -------: | -------------: | --------: | -----------: | ------: |
| Initial bound       |                    8 |                  8 |            1,958 |   22,181 |         24,419 | 2,422,988 |      149,029 | 107.8 s |
| Source continuation |                    6 |                 33 |           10,429 |  119,620 |        134,366 | 9,137,270 |    1,065,085 | 643.9 s |

These D1 counters include native admission, reader turns and comparison
coordination during continuation. Schema creation, enrollment, diagnostic
reads and final audit queries are outside the counters. The first
invocation transferred 2,838,458 response bytes; the second transferred
3,129,609. Initial requests were one LoFi, six QRZ and one LoTW; the
continuation's six requests were all LoFi. No upload attempts were created.

At that checkpoint the database occupied **188,882,944 bytes** before
collection. This includes two destination routes, retained incomplete
comparison evidence, input/dependency rows and indexes; it is not a payload
size measurement. The run also retained 678 empty selected-input expansion
pages. These are concrete retention and avoidable coordination costs to
investigate before cutover, alongside the
[synthetic pipeline](evidence-inventory-pipeline.md) and
[incremental measurements](evidence-inventory-incremental.md).

## QRZ operator-only receipt

A bounded diagnostic repeated only the held QRZ STATUS/FETCH pair. It
retained the response encrypted outside the repository and did not publish
observations or advance a checkpoint. All 250 records had valid dates
inside the selected range. Exactly one omitted `STATION_CALLSIGN` and
provided the verified book call in `OPERATOR`; no record supplied a
contradictory explicit station.

[ADIF's OPERATOR rule](https://www.adif.org/318/ADIF_318_annotated.htm#QSO_Field_OPERATOR)
assigns that value as the station when `STATION_CALLSIGN` is absent. The QRZ
adapter now applies that fallback for scope validation, and its comparison
projection carries the interpreted station. An explicit wrong, empty or
invalid station remains authoritative and fails validation. Raw encrypted
receipts remain unchanged. LoTW retains its stricter explicit-station
requirement. The diagnostic added two actual HTTP requests and 356,370
response bytes, separately from the table above.

## Qualification and remaining work

### Completed QRZ verification and current classifications

The explicit QRZ verification completed its configured book date range
and catch-up. It made **38 QRZ requests** and transferred 6,042,621 response
bytes, without another LoFi or LoTW request. The database now retains
4,252 active QRZ records alongside the 4,251 active source contacts.
All three selected runs are complete/idle with published ready coverage.
The LoTW selection remains just one receipt day.

The original final audit repeated native dependency validation for each
result in a shared cohort. It failed through the local D1 transport after
the native jobs had completed. Reopen reproduced the reporting failure;
the accepted records, checkpoints and classifications remained intact.
The corrected audit materializes distinct live sets, validates each once,
and then aggregates their members. A native 20-member fixture reads
**1,846 rows instead of 35,340**, with identical results and continued
stale-set/tenant rejection. This is an audit improvement, not a change to
write authorization or the existing bounded matching API.

A fresh reopen then decrypted a retained sample and verified all 8,502
current comparisons. A subsequent native resume returned quiescent in
5.0 seconds with **zero service requests, zero reader turns and zero
comparison turns**. The QRZ results are:

| Classification                | Contacts |
| ----------------------------- | -------: |
| Matched existing              |    2,957 |
| Absent at inventory           |      366 |
| Operating details differ      |      537 |
| Multiple remote candidates    |       20 |
| Candidate unavailable         |       63 |
| Forward coverage incomplete   |      297 |
| Operating details unavailable |        3 |
| Source unavailable            |        3 |
| Excluded test operation       |        5 |

Absence is a planning fact; fresh source proof, ownership and final
destination checks are still required before any future upload. Detail
mismatches and ambiguous/incomplete records were not rewritten or
classified as upload candidates.

The complete observed HTTP count for these managed continuations and
the separate QRZ diagnostic is **54 requests**: seven LoFi, 46 QRZ and
one LoTW, transferring 12,367,058 response bytes. The failed audit did not
require accepted service reads to be repeated. Complete D1 counters for
that QRZ continuation were not retained, so the earlier table must not
be presented as a complete end-to-end database cost. Its last retained
progress shows 44 read/control turns and at least 4,065 comparison turns.
Future runs persist counter snapshots before final audit as well as
periodically. The successful zero-read resume itself measured two D1
calls, two statements, five reads and zero writes, excluding its audit.

Before historical adoption, the final database allocation was
**275,324,928 bytes** with no collection. Original captured access and all
three copied credential envelopes remained unchanged. All thirty
entries in the private directory had no group/world access. The
[sanitized measurements](benchmarks/inventory-managed-2026-11-08.json)
retain the completed reports, failed-continuation lower bound and scope
limitations; they contain no credentials or raw contacts.

### Checks and remaining integration

Two bounded cohorts of twenty verified QRZ matches were then adopted in
the private database using the existing guarded historical association
API. It retained forty immutable associations and forty encrypted
ownership-evidence records, with zero attempts or vendor requests. The
measured second cohort's retry preserved all twenty original mappings
and inserted none. Original source/facet/scope/checkpoint metadata and
credential ciphertext were fingerprinted before/after and stayed
unchanged; original captured access also stayed unchanged. A retained
ownership body decrypted successfully.

A separate process reopened all forty associations/evidence records and
decrypted an ownership sample with zero vendor reads. No upload attempts
were present. Automatic association scheduling and the new delivery path
were not exercised by these bounded manual cohorts.

The measured twenty-member cohort used six publication statements,
**197,429 publication reads and 325 writes**. Preparation, publication
and lease work together used **15 D1 calls, 21 statements, 367,276 reads
and 327 writes**. Diagnostic queries and the preservation retry are
outside those counters. The first cohort's publication counters were
not retained. The final allocation after forty associations was
275,439,616 bytes. These real-log reads are materially higher than the
small synthetic adoption fixture and need investigation; automatic
adoption scheduling is still unfinished.

Focused adapter/ADIF/native projection checks passed 41 tests. Managed
trial tests cover native baseline completion, request-limited resume,
unchanged original access, a spent deadline, held-selection verification,
preservation of completed source runs and lost manifest acknowledgement.
Reopen audits decrypt a retained sample without service requests. The
six-test managed/access selection passed under schema 0077, as did the
new shared-set audit test and the subsequently affected completion and
deadline cases. A separate projection regression passed 27 tests. TypeScript,
lint, formatting, task validation/help and the Worker dry-run build passed.

Automatic LoTW date-universe discovery and overflow splitting, adoption scheduling,
ownership-aware planning, fresh source proofs, delivery/batch integration,
collection, restore quarantine and account-preserving cutover remain
required before replacement activation. These local trials do not establish
the 200,000-contact wall-clock target or sustained production capacity.
