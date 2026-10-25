# Implementation roadmap

This roadmap is the handoff for implementation in this repository. Checked items have implementation and local evidence. Unchecked items retain external verification or rollout work; they must not be inferred from synthetic success. The owner authorized small signed commits directly to `origin/main` for implementation; no implementation PRs are opened. Retain the product decisions in [README](README.md). Each milestone should update its evidence and remaining questions here.

## Next milestones (2026-10-25 UTC)

### Export readiness at a glance

| Work                            | Current state                                                                                       | Next acceptance evidence                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Historical matching             | Deployed: inclusive ±30 minutes, compatible grid precision, reverse uniqueness and ownership checks | Continue guarded associations; review contradictory location evidence                              |
| Source comparison and ownership | Clean 4,161-contact index; all 9,981 ownership inputs covered at the 02:44 UTC checkpoint           | Observe ongoing intake and sustained cost/throughput                                               |
| QRZ first-insert evidence       | Earlier singleton source proof and fresh empty neighborhood passed; evidence expires normally       | Renew normal evidence for every later contact                                                      |
| QRZ delivery                    | Automatic trial accepted: all thirteen ACKs assessed; temporarily closed for LoTW preparation       | Preserve accepted QRZ evidence through the separate LoTW trial; continue monitoring                |
| LoTW delivery                   | Trial A reached a source-proof hold; closed with zero new attempts and verified recovery            | Resolve the precise proof hold; renew normal checks and complete scoped upload/readback acceptance |
| Broader rollout                 | All eight controls temporarily closed; QRZ trial accepted; LoTW acceptance pending                  | Complete the separate LoTW acceptance process; sustain measured QRZ operation                      |

The receiver fix is deployed; checked pairs C, D2 and F4 passed scheduled delivery,
recovery and known-ACK assessment at the observed minute/sideband representation.
Window H has now run and closed; all four additional ACKs pass complete-window
readback and assessment. Two persistent QRZ cycles added two more ACKs; all
thirteen records now pass observed-precision assessment and populated recovery.
QRZ was temporarily closed for independent observation and LoTW preparation,
not because the trial failed, as described in
[the pilot guide](docs/qrz-pilot.md). Historical exceptions, general corrections
and source-wide cutovers remain separate work. Detailed dated observations below
are evidence checkpoints, not a claim that every backlog item has been resolved.

### Current checkpoint — QRZ accepted; LoTW trial A held and closed

The 13:15 and 13:20 persistent QRZ cycles completed **32 and 38 contact turns**,
with one attempt, zero errors and two deferrals each; both stopped at
`database_budget`. Independent closure at **13:25:46.975 UTC** confirms all eight
controls closed on Worker `d3df1bb6-39d2-4bb5-b1c2-ce268ed22744`, deployment
`0eb59b3a-8c88-4259-a688-f3e559084855`. The closed 13:25 cycle completed 84 turns
with zero attempts/errors; there were no other new QRZ attempts.

The **13:29:39.418 UTC** POST recovery verifies **41,654,630 bytes, thirteen
attempts and twelve artifacts**: both new attempts plus all prior eleven exactly
preserved, original crypto/claims/proof pins, integrity/FKs and both quarantines
passing. Zero unfinished window invocations remain distinct from 31 inherited
unfinished rows. Five read-only QRZ requests cover the two new ACKs with all eight
controls closed before/after; complete assessment finds two consistent members
and zero held, missing or unresolved members. **All thirteen QRZ records are
accepted at known-ACK minute/sideband precision**. Exact seconds remain unverified;
original source values, literal-held summaries and uncertain matching are unchanged.
This accepted automatic trial does not establish sustained scale.

LoTW preparation remains separate. Unsigned offline helper V4 held the first
20 candidates on `unsigned_source_time_precision`; reviewed V5 removes only its
modulo-zero requirement to match the already-deployed whole-second projection
and durable claims, preserving raw milliseconds/fingerprints. Its 23 checks and
peer reviews pass; an actual offline V5 selection found one candidate without
signing or network. The reviewed recovery bridge passes eleven native checks and
both peers; it derives signed-artifact facts from saved SQL before the unchanged
full recovery, granting no authority. LoTW trial A subsequently activated one
exact contact on Worker `49d9c771-7553-40d0-a5f2-7ad7a39e5822`. The normal 14:00
cron ran on that active Worker: 16 contact turns, zero attempts/errors, one
deferral and a deadline stop. The selected candidate remained structurally
eligible but its LoTW ledger held `source_export_proof_proof_unavailable`;
that generic reason does not identify a request-budget, clock, transport or
other proof failure. Independent closure at **14:02:46.080 UTC** verified all
eight controls closed on Worker `40991304-8c5e-422e-bb41-61deb79b08c7`.

Trial A POST recovery passed at **14:08:52.990 UTC**: all thirteen prior attempts
remain exact, with zero new attempts, zero unfinished window invocations,
31 inherited unfinished rows, no LoTW proof pins, full restore and both
quarantines passing. No LoTW attempt or upload occurred; zero attempts alone
does not establish whether signing ran. Trial B
preparation stopped at **14:12:54 UTC**, before any input, intent or activation,
with `settled_margin_not_available`. The latest completed cycle was 14:05; no
14:10 scheduler row was present at that check. This does not establish a missed
cron or its cause. All eight controls remain closed on Worker `40991304`, with
thirteen total attempts; the precise trial-A proof failure still needs diagnosis.
Runtime `7738f7d7` and its 1,688-test CI qualification are unchanged. See the
[LoTW trial-A receipt](docs/deployment.md#lotw-trial-a-source-proof-hold-and-closed-recovery-2026-10-25-utc).

### Earlier persistent QRZ activation B (7738f7d7)

Activation B was independently attested at **13:10:58.762 UTC** on unchanged
signed runtime `7738f7d7d733e67ef1fa9567eb3c2683d1a5f382` (1,688 tests and
required checks passed). Worker `242c1aa6-aa79-4f46-9ef2-dc033971bdac`, deployment
`472f153d-d9b8-42e7-861e-635bc19bcd8b`, receives sole 100% traffic; health,
assets and KEK 1 passed. Exports, rollout checks and QRZ fresh inserts were enabled
for **one exact existing QRZ destination and wildcard contacts**. LoTW fresh
inserts and source-boundary authority remain false; ordinary mode has no window
expiry. Every contact still needs its normal source proof, absence and ownership
checks. Activation began with the **eleven prior attempts and zero new attempts**.
The 13:15 cron, received **13:15:42.570 UTC**, completed 32 contact turns and one
attempt with zero errors/two deferrals. At **13:18 UTC**, complete accounting
confirms **one new delivered ACK, twelve total**, all prior eleven exactly
preserved, unchanged scope/schema and zero unknown, rejected, running or leased
work; `stopRequired=false`. At that checkpoint the twelfth record still needed
independent readback/recovery and QRZ was active. The later thirteen-record
acceptance and temporary closure are recorded above; neither sample establishes
sustained scale.

The fresh **13:09:53.227 UTC** PRE recovery verifies 42,245,796 bytes, eleven
attempts/ten artifacts, all crypto/quarantine checks and zero unfinished rows
in its explicit **12:53:27–13:09 closed-period** follow-up. It is not a new
activation window. Earlier activation A stopped before intent or deployment
because its backup was 909,311 ms old against a 900,000 ms limit; B used fresh
inputs, without an active retry. See the [activation receipt](docs/deployment.md#persistent-qrz-activation-b-2026-10-25-utc).

LoTW remains disabled with no actual signing/upload. An unsigned offline scan
examined 20 of 200 queued contacts and held all 20. A separate read-only aggregate
found 373 structurally eligible/due routes; neither is complete eligibility or
absence evidence. Private LoTW tooling corrections remain in progress.

### Earlier accepted window H and closed release (7738f7d7)

The monitored normal-cron **window H** used native `expiresAt=12:12:30 UTC`
on the unchanged signed runtime. Its tick recorded **six contact turns, four
attempts and zero errors**, producing four new delivered QRZ ACKs and **eleven
attempts in total**. The independent closer confirmed all eight controls closed
at **12:12:40.617 UTC**, Worker `30c3c0b3-0e11-4858-8f41-211a7882fb2e`,
deployment `4313866b-1832-472b-a2aa-444b5aa5f375`. Fresh 12:40 UTC attestation
retains the closed state.

Actual POST recovery completed at **12:40:34.456 UTC**: **41,768,036 bytes,
37 migrations, eleven attempts and ten retained table artifacts**. The prior
seven attempts are preserved exactly; artifact/claim/proof-pin crypto,
integrity/FKs and both isolated quarantines pass. Accounting distinguishes zero
unfinished window invocations from **31 inherited unfinished rows**. Two disjoint
pair observations, each using five QRZ reads and 24 D1 calls with all eight
controls closed before and after, cover all four new ACKs. Aggregate replay is
`complete_all_deliveries_consistent`: four consistent native ACKs, zero held,
missing or unresolved members, and `fullMemberAssessmentComplete=true`. All
**eleven trial records are accepted at known-ACK minute/sideband precision**.
Seconds remain unverified; original literal-held summaries and the uncertain-
result matcher are unchanged. At this checkpoint persistent automatic QRZ and
LoTW remained disabled;
no actual LoTW attempt or upload has occurred.

Recovery V4 ignores only the top-level source diagnostics `lastSuccessfulPollAt`,
`lastSyncFailureAt` and `lastError` when comparing configuration; every other
source and destination field remains checked. It passes 26 offline checks and
both peer reviews. This permits diagnostic-only drift without asserting source
health. Later closed cycles show intermittent `db_d1` failures (three in 12:15,
five in 12:25); the 12:20, 12:30 and 12:35 cycles are clean. Their cause remains
unknown; `db_d1` also includes deliberate native guard aborts and does not prove
a provider fault. See the [window-H receipt](docs/deployment.md#accepted-window-h-and-current-closed-state-2026-10-25-utc).

The following release and F2/F4 receipts predate window H.

The signing blocker is resolved. Signed `7738f7d7d733e67ef1fa9567eb3c2683d1a5f382`
deployed closed at **10:34:26.259635 UTC**; GitHub verifies all four new commit
signatures. Independent **10:35:00.183 UTC** checks confirm sole 100% traffic,
healthy assets, KEK 1 and all eight controls closed. Schema remains 37 migrations.
Fresh PRE/POST recovery preserves exactly **five QRZ attempts and four original
artifacts**, with crypto, immutable-row, integrity/FK and repeated-quarantine
checks passing. No new export occurred.

The scheduler diagnostics and optional native QRZ proof deadline are deployed.
Three work cycles completed with 56, 51 and 30 contact turns; the middle cycle's
six handled errors are missing QRZ history identity fields. These are turn
counts, not unique-contact or capacity measurements. The historical initiating
exception remains unresolved. All **1,688 local tests** and required checks pass;
[exact-release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40184837953)
also passed all **1,688 tests and required checks** at **10:56:43 UTC**.

The first prepared pair never activated and aged out while CI ran. The subsequent
F2 scope activated but made **zero new attempts** and closed at **11:09:28.973 UTC**.
F2's closed Worker was `17c17e12-db38-48da-9773-ca8df18268ef`; independent
11:22:46 UTC attestation confirms all eight controls closed. The 11:14:21 UTC
POST recovery preserves all five attempts and four artifacts through decryption,
restore and repeated quarantine.

F2's original 11:00 scheduler row remains unfinalized. A separate invocation
received at 11:15:50 UTC carried the old scheduled time and completed on the
closed Worker; it did not resume or finish that original row. The cause remains
unknown. Later closed cycles complete and release leases. Their handled route
exceptions are separate from a scheduler failure: the 11:25 cycle's five errors
are LoTW history unavailability, with budget deferrals recorded separately.

F4 subsequently delivered **two reviewed contacts**, with USB and LSB sidebands,
through a completed scheduled run with zero errors. Its independent closer
verified all eight controls closed at **11:43:12.107 UTC**; its closed Worker was
`bfdb4768-1018-4b38-a01d-bac7f7d662c1`. After the minimum observation period,
the **11:46:41 UTC** recovery verifies all **seven attempts/six artifacts**.
Five QRZ reads establish exact ACK identities and complete unique neighborhoods.
The separate assessment accepts both minute/sideband representations; all other
fields match literally, including their eight-character grids. Seconds remain
unverified. Original literal holds and uncertain-result matching are unchanged.

Window H subsequently exercised the bounded normal-cron window with native
absolute expiry and complete attempt recovery; all four new records now pass
all-member readback and aggregate acceptance. Persistent automatic QRZ was still
off at that checkpoint. Timing reduces overlap; native proofs and durable claims remain necessary
when delayed events arrive. LoTW remains separate. See [deployment evidence](docs/deployment.md#closed-scheduler-and-qrz-deadline-release-2026-10-25-utc).

### Previous production — accepted D2 checkpoint (c88d413e)

Trial D2 adds two delivered QRZ ACKs to the prior three, with **five approved
attempts and four retained artifacts** verified through restore and repeated
quarantine. Exact-LOGID readback and complete unique neighborhoods pass. The
separate assessment accepts the observed minute/sideband representation while
preserving literal holds and unverified seconds.

All eight controls are closed on c88d413e/schema 37. Exact source and test-only
follow-up CI are green. See the [D2 deployment checkpoint](docs/deployment.md#accepted-trial-d2-and-current-closed-state-2026-10-25-utc)
for its immutable receipts and then-closed Worker. The planned pair E stopped
before activation; F4 and window H subsequently supplied the later scheduled
evidence above. Actual window recovery, all-member readback and aggregate
acceptance now pass; scheduler diagnosis remains unresolved. LoTW
acceptance follows separately.

### Readiness follow-up — implementation deployed closed

The scheduler follow-up preserves a completed tick before optional backlog
sampling and reports the original work failure separately from a failure to
record status. The optional QRZ window deadline caps native source proofs and
the final pre-INSERT admission check. The combined local source passes **all
1,688 tests**, formatting, lint, both TypeScript checks and the Worker dry build.
The signer was subsequently unlocked; the changes are signed, pushed and
deployed closed in the current checkpoint above. Window H has exercised the
native deadline in a monitored normal-cron scope; persistent automatic export
has not been enabled.
- [x] Review and locally validate scheduler failure preservation and the native
  QRZ deadline, including expiry during vendor-budget admission.
- [x] Independently review complete-window recovery, explicit one/two-member
  readback and aggregation covering every actual new attempt. Actual window-H
  recovery and all-member readback/acceptance now pass. Original
  literal holds, unknown states and incomplete coverage remain explicit.
- [x] Finish and review the offline window controller with an independent
  closer and the original native expiry fixed to the intended close time.
  Fourteen focused cases pass, including launcher exit, late deployment/audit
  and closure-journal failures. Window H subsequently activated with its original
  native expiry and independently verified closure.
- [x] Resolve signing, push, deploy closed, and verify fresh backup/recovery and
  completed scheduler runs on the actual release. Historical failure diagnosis
  remains open.
- [x] Obtain green exact-release CI before the next live QRZ scope.
- [x] Complete F4 with two reviewed scheduled exports, populated recovery and
  unique ACK/neighborhood readback at observed minute/sideband precision.
- [x] Run window H with native absolute expiry, independent closure and actual
  eleven-attempt/ten-artifact recovery, preserving all seven prior attempts.
- [x] Complete window-H readback for every new ACK and aggregate acceptance at
  observed minute/sideband precision, preserving literal holds and unverified seconds.
- [x] Enable persistent QRZ fresh inserts for the existing exact destination after
  accepted window H and fresh recovery; its first completed active cycle adds one
  delivered ACK, with independent readback/recovery pending.
- [ ] Monitor active delivery/recovery and investigate intermittent `db_d1`
  categories without inferring their cause.
- [ ] Validate LoTW separately after QRZ, preserving the complete prior QRZ
  ledger in its recovery checks.

### Previous production — scoped selection reached; source transport held (87e87b2d)

Signed `87e87b2d9f02f4534a914789a9e4487f35703a43` passes **1,666 tests** and
[exact-release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40165603166).
It deployed closed at **05:50:40.674521 UTC**, retaining all **37 migrations
through `0038`**. Finite authorized scopes now receive their bounded native
cohort before unrelated backlog, with all existing eligibility and delivery
guards intact. The **05:46:13.212 UTC PRE** and **05:52:02.914 UTC POST** backups
pass; their SQL sizes are **41,598,715** and **41,600,106 bytes** respectively.

Trial B recorded its exact two-contact activation intent at **05:59:23.886 UTC**. Both reached
live selection at **06:01:30 / 06:01:45 UTC**: one held for incomplete history,
the other for `source_export_proof_read_failed`. It produced **zero attempts or
vendor writes**. The scope closed at **06:05:54.576653 UTC** as Worker
`7aaf4d15-66e8-48d4-ab6a-b771b02000ad`, deployment
`0765e455-aafd-45ab-b79a-c9306a3560aa`. Independent **06:11:34.594 UTC**
attestation confirms all eight controls closed. After at least 180 seconds of
drain observation, there are zero new attempts and **one unfinalized scheduler
row**; this is not a completed-run claim.

The **06:12:54.606 UTC** recovery snapshot contains **41,555,300 bytes** and
verifies the original singleton only, zero new attempts/artifacts, all prior
immutable rows, integrity/FKs and repeated quarantine. The earlier singleton
remains accepted at returned minute precision, with seconds unverified.

A native Workerd reproduction proves that the coordinator's method-style
`options.rawFetcher(...)` invokes native `fetch` with the wrong receiver and
throws `Illegal invocation` before outbound transport. Signed, pushed fix
`c88d413e52c8d3ebd5ed7bff4eab10ec6fbf2dd7` changes that call to
`.call(globalThis, ...)`; the actual-coordinator regression and **42 focused
cases pass**. Its full check and
[CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40168290537) are still
running at that checkpoint. The fix subsequently deployed closed at 06:29 UTC,
as recorded above. Trial B remains zero-attempt evidence; it does not establish
successful scheduled delivery.

The **05:50 UTC** idle invocation was blocked by the ordinary cycle lease until
**05:51:00.023 UTC**. The **05:55 UTC** closed run completed **189 turns in
31.837 seconds with zero errors**. Neither sample establishes sustained capacity.
LoTW observer and recovery tools are ready offline; real-key signing, upload,
accepted-report readback and populated live artifact recovery remain unproved.

### Previous production — retained artifacts and first scheduled trial (890f714c)

Signed `890f714c39390b71f0d4222eb03ef864981e5f98` passes all **1,663 tests**
and required checks, including [exact-release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40162836106).
It deployed at **05:00:29.106103 UTC** with migration `0038`, bringing the
installed count to **37**. Original encrypted attempt artifacts now survive
terminal outbox cleanup with their original AAD and seven-day expiry. The
26 focused cases cover atomic staging, lost ACKs, expiry, original KEKs and
populated full-SQL restore. The migration rehearsal preserves all 70 prior tables;
the **04:58 UTC PRE** and **05:03 UTC POST** recovery checks preserve the existing
delivered singleton and all baseline immutable evidence.

A restricted two-contact QRZ scope was opened for a normal scheduled trial.
The **05:10 UTC** invocation completed **27 contact turns / 22 classifications**
in **93.097 seconds**, stopping at its deadline with **zero attempts, errors or
vendor writes**. The policy change woke the whole backlog, leaving the recently
reviewed contacts behind unrelated due work; both remained eligible and untouched.
This is a scheduling failure, not successful scheduled export acceptance.

The scope was closed at **05:13:15.292286 UTC**, Worker
`8122bc6c-87eb-46d0-8b2e-5e13e5cd16e3`, deployment
`b1542925-2e7d-4a0f-a76e-2dfd978ebc26`, sole 100% traffic.
Independent **05:17:40.088 UTC** attestation confirms all eight controls closed,
healthy HTTPS, matching assets and KEK 1. Both recorded runs are complete. The
**05:17 UTC** backup passes isolated recovery with exactly the prior one attempt,
zero new scheduled attempts and zero retained table artifacts. The old singleton
still uses its preserved host packet; no purged legacy body was reconstructed.

That trial led to the finite-scope scheduling correction deployed in `87e87b2d`
above. Its old run and recovery receipts remain evidence for `890f714c`, not for
the later source-transport fix or successful scheduled delivery.

### Throughput follow-up — request demand

The exact-`f2c41cb3` native scheduler experiment uses four QRZ requests for one
successful fake INSERT with cached inventory. Three candidates produce two
INSERTs and nine requests under the existing background admission. The
live-observed ambiguous-empty response path instead has a ten-request/contact
one-page model. These counts establish demand, not production completion rate.

At 100 users × 100 new contacts/day, even four requests/contact exceeds the
current total application budget before maintenance or retries. Background
backfill has a smaller allowance. The first small optimization is now deployed
in `0386af30`: reuse the immediate history observation during
preparation while retaining a new duplicate query before every INSERT. An
independent native comparison measures **4→3** requests for one direct-empty
contact, **9→7** for three candidates/two INSERTs and **10→7** for one
ambiguous-empty fallback. Current source proofs, ownership and dispatch/recovery
checks remain mandatory. All **1,628 tests** and the full local check pass;
[CI for that committed reuse change](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40144251500)
also passed at **2026-10-25 00:10:55 UTC**.
A separate 20-candidate fallback probe exposed history reads consuming all
24 background QRZ requests before dispatch: two attempts prepared, zero INSERTs.
The deployed follow-up bounds fresh negative-history scans by available dispatch
slots and caps planning HTTP requests across the entire invocation. Unscanned
contacts retain their existing due work without an absence classification;
positive historical matching retains the larger cohort. A native worst-case
test completes one nine-read final neighborhood and INSERT within the unchanged
24-request budget after another planning scan stops partway. This prevents the
reproduced starvation; it does not establish larger-scale throughput or guarantee
headroom when other Workers share the same budget. Signed `e4a1b1e2` passes
**1,635 tests** and the full local check. Its
[CI run](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40146718840)
passed at **2026-10-25 00:53:34 UTC**.

The deployed re-entry follow-up revisits at most 20 deferred primitive work keys in
later normal source rounds, with current projection and exact queue guards.
An independent 20-contact fixture completes **four direct-empty** or **three
fallback** INSERTs within one invocation; a real following-window run completes
three more fallback contacts, six across two ticks. Budgets, quiet periods,
source proofs, final duplicate checks and recovery remain mandatory. These are
fake-vendor/native-D1 results, not production capacity. Review, all **27 modified
service tests**, formatting, lint, both TypeScript checks and the Worker dry
build pass. The 1,635-test full result above belongs to the parent commit.
[CI for signed `ddddd5e7`](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40146967034)
passed at **2026-10-25 00:59:39 UTC**.
Then evaluate bounded earlier covering reads and LoTW batches, with per-contact
ownership, proofs and uncertain-result recovery
preserved. No quota increase or production capacity is claimed. The
[capacity plan](docs/capacity-plan.md#qrz-first-insert-request-demand--exact-f2c-local-measurement)
records measurements, request models and race-test acceptance criteria. This
work does not delay the separately authorized singleton QRZ trial.

### LoTW native comparison and deployed signing-profile correction

At **2026-10-25 00:51:14 UTC**, the isolated native TQSL 2.8.6 comparison passed
both repository-public synthetic FT8 vectors. Native canonical bytes and
separately generated public-API signatures equal Ferry/OpenSSL output, including
the complete six- and eight-character grids. The independently audited packet
used no production credential or vendor request. The native full signed-contact
writer was not exercised; this does not prove ARRL upload/readback acceptance.
See [the exact scope and pinned evidence](docs/evidence-signing.md).

That comparison exposed an unverified mode in the old Ferry allowlist: native
configuration 11.34 has no FST4W mapping. Deployed profile
`ferry-lotw-v2-us-ca-3` holds new FST4W signing, including ADIF submode form,
without substituting DATA. Historical matching policy 6 / candidate policy 2
also holds that unverified LoTW mode; QRZ's separate ADIF parent-mode comparison
is unchanged. Other verified modes remain supported.

Prepared LoTW artifacts must now have the current profile and supported fields
before dispatch can acquire a lease, reserve vendor budget or submit. Existing
exact FST4W identities remain unchanged for permanent claims and read-only
recovery of submitted/uncertain attempts. Both legacy recovery states and
mutation-free prepared holds pass the **28-test LoTW delivery file**. These
changes pass **all 1,653 tests**, formatting, lint, both TypeScript checks and
the Worker dry build, with independent source review. The correction is signed
and pushed as `d4dba32d`; the native evidence is in signed `3e46faac`. Both are
included in the disabled-export `0386af30` production release. Actual personal-key signing, accepted upload/readback,
and populated raw-evidence recovery remain open. The mixed-cohort cloud resource
observations below are complete, with per-case cost attribution unavailable.
[CI for signed `3e46faac`](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40151923651)
passed at **02:15:37 UTC**.
The **02:16:45.545 UTC** postexperiment attestation verified the preceding
`f2c41cb3` release. The later `0386af30` deployment and closed-control verification
are recorded below.

### LoTW cloud signing experiment — synthetic fixtures

At **2026-10-25 01:56:09.954–01:56:17.212 UTC**, an isolated cloud Worker
completed **27/27 validated requests**: normalized signing batches of **1, 10
and 100 contacts**, each with six- and eight-character grids; separate
legacy/current credential imports; and a control. Three requests per case
produced **666 synthetic signatures and six imports**, matching fully verified
offline expectations. No production credential, database or vendor was used.
All nine previews and the temporary Worker were deleted, with parent absence
verified at **01:56:39.837 UTC** and the temporary control secret removed.

The first run's exact-name analytics stayed empty; a separate diagnostic found
24 events with unknown Worker/preview names, which cannot establish per-case
resource attribution. A second isolated measurement retained its naming
metadata and passed another **27/27 requests** at **02:08:29.728–02:08:39.062 UTC**.
At **02:14:30.047 UTC**, its exact-Worker analytics account for **27 successes
and zero errors**, with mixed-cohort CPU P50/P99 **17.735/128.030 ms** and sampled
isolate-memory P50/P99 **7,029,477/13,283,376 bytes** (about **6.7/12.7 MiB**).
No limit failure was observed under the configured 5,000 ms CPU cap. This
completes the bounded aggregate cloud resource observation. Preview names
remain unknown in analytics, so the original per-case experiment is incomplete
and no separate import/batch-size cost, peak-memory or production-capacity
claim follows. Cleanup verified all second-run previews and the parent absent
at **02:15:31.810 UTC**, with the control secret removed. Real-credential
signing and ARRL upload/readback acceptance remain open. See
[the exact experiment scope](docs/evidence-signing.md#cloud-signing-experiment-2026-10-25).

### Previous production — QRZ request reuse and LoTW profile 3 (0386af30)

Signed revision `0386af30312494bf31c2fd45f833e9c2a41534e9` deployed at
**2026-10-25 02:31:55.011049 UTC** as Worker
`fbaf8af8-d51c-44e9-a5ca-53e29c2eb5c3`, deployment
`a909a390-1b0d-418b-8bfb-80a72949c9dd`, sole 100% traffic. All **1,653 tests** and required checks pass;
[CI for the exact deployed revision](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40154037329)
completed successfully at **02:48:16 UTC**.
Independent **02:32:22.968 UTC** attestation verifies healthy HTTPS, matching
assets, active KEK 1 and all **eight export controls closed**. No migration,
secret or vendor write occurred; the schema remains at 36 migrations through
`0037`.

The **02:30:14.652 UTC PRE** and **02:33:12.483 UTC POST** backups pass isolated
restore, all 3,327 populated exact-evidence crypto/ownership checks, three
credential decryptions, tenant-key verification, integrity/FKs and two
quarantines. The separate **02:39:24.873 UTC** comparison preserves every field
of all 3,327 claims, 2,895 QRZ owners and matching markers, 3,327 exact evidence
records and the tenant comparison-key binding, with zero changed or missing
rows. No production restore occurred. Raw LoTW references remain empty, so their
populated recovery is still unverified.

At **02:44:16.072 UTC**, policy 6 is active, the **4,161-row source index is
clean**, and all **9,981 ownership inputs are covered**, with zero pending,
held or unhashed ownership work. New intake briefly left two unhashed owners in
the immediate POST snapshot; normal maintenance processed them before this
later aggregate. Attempts, cutovers and temporary staging guards remain zero.

The first two completed new-release crons made **126/148 contact turns** and
**96/156 classifications**, with zero adoptions or attempt turns. They stopped
at the database budget after **91.034/56.019 seconds**, using **852/856 D1 RPCs**.
Fixed-category readback reports LoTW unavailable-history reads and vendor-budget
deferrals. These remain holds, never absence evidence. The samples establish
continued reconciliation, not the exact upstream failure cause or sustained
production export capacity; see [deployment details](docs/deployment.md).

The exact-release QRZ operator packet has been regenerated and independently
reviewed: **22 native execution cases, 92 supporting cases and 21 recovery
cases** pass, with unchanged SQL permissions. The owner subsequently authorized
the reviewed one-contact trial, with a fresh backup, at most one INSERT, exact
readback and recovery. Automatic exports and LoTW remain disabled.

The **02:56:37.961 UTC** current-release SELECT-only payload review confirms the
same original contact, book, credential/template versions, every transmitted
field and exact ADIF bytes, with no source/vendor request or attempt. The
**02:56:39.484 UTC** independent post-review attestation reconfirms all eight
closed controls. This preliminary review still requires normal context refresh,
a fresh source proof and vendor checks before an authorized trial; see
[the pilot evidence](docs/qrz-pilot.md).

The first authorized invocation stopped during preparation, before dispatch.
Its **03:22:23.152 UTC** recovery check independently verifies **zero attempts,
attempt claims, proof pins or cutovers**, and preserves every baseline claim,
historical owner, association marker and exact evidence record. Credential/key
decryption, integrity/FKs and two isolated quarantines pass. One unpinned
diagnostic proof remains; no INSERT or acknowledgement is claimed. The original
launch burn, approval and unknown-outcome journal are preserved.

A separate **03:29:02.518 UTC** diagnostic completed normal source collection,
final drain, proof verification and the same-contact QRZ checks, with two source
reads, three QRZ reads and **109 D1 RPCs / 135 SQL statements**. It had no INSERT
capability. That short-lived evidence does not authorize a later write. Next:
finish the operator diagnostic repair, continue only from independently
verified zero-attempt state with fresh checks, then require exact INSERT
readback and recovery before checked QRZ batches. LoTW acceptance follows QRZ.

By **03:55:14.887 UTC**, the corrected operator packet completed normal
preparation and **one QRZ INSERT**, with a valid acknowledgement and LOGID.
Its immediate exact readback remained unresolved, so no further writes are
permitted by this trial. Automatic exports and LoTW remain disabled. The
**03:56 UTC** post-trial recovery verifies exactly one delivered attempt, its
accepted receipt, identity claim and source-proof pin; the original encrypted
artifact remains recoverable in the protected packet after normal outbox
purging. Every pretrial immutable row is preserved, and crypto, integrity/FKs
and two isolated quarantines pass.

Subsequent read-only checks verify the acknowledged LOGID in the intended book
and a complete neighborhood containing exactly one candidate, that same LOGID.
All **13 other transmitted fields** match literally, including the full grid,
coordinates and narrative. `TIME_ON` returns four digits matching the first four
of the six transmitted digits: the UTC date/minute agrees, while seconds remain
unverified. A separate offline assessment binds this result to the delivered
receipt, permanent owner, exact claims and proof pin. The original unresolved
literal-readback outcome is preserved; uncertain-attempt recovery is unchanged.
See [the acceptance limits](docs/qrz-pilot.md#acknowledged-readback-and-duplicate-check--2026-10-25-utc).

At that singleton checkpoint, the next batch still required artifact retention
through normal ACK cleanup and actual scheduled delivery. Migration `0038` and
Trial C subsequently supplied retained artifacts, two scheduled deliveries and
populated approved-set recovery, as recorded above. Continue small checked QRZ
batches before broader automatic activation. LoTW remains a separate later
milestone; all eight controls are currently closed.

### Previous production — ownership bootstrap and deletion status (f2c41cb3)

Signed revision `f2c41cb3a929ae3d3545e235894027b84fbf09fb` deployed read-only at
**2026-10-24 21:29:41.127501 UTC** as Worker
`fc1f2a5b-13e0-4509-ba03-9c93856c6464`, deployment
`5cd52bea-75ce-40ed-be6c-f847c904e36d`, the sole deployment at 100% traffic.
All **1,617 tests** and required checks passed in
[release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40132320522)
at **21:26:36 UTC**. Independent attestation at **21:30:27.888 UTC** confirmed
all **eight export controls closed**. The schema remains at **36 migrations**
through `0037`.

The release prioritizes exact identity copies for owners hashed in the same
bounded maintenance pass and treats authoritative LoFi `status: "deleted"` as
additional tombstone evidence. Existing positive deletion flags cannot be
revived by another status. These changes preserve the guarded historical
association and write protections introduced in `5a427a30`; **exports remain
disabled**.

The **21:28:43.196 UTC** PRE and **21:30:41.035 UTC** POST backups contain the
same **41,811,658-byte** SQL snapshot, SHA256
`5a41e911c628ccdd3a2f60b0bf90a5f7fd6d9ee35ad3bb1e9ce277f784169b36`.
Recovery validates all **3,294 populated exact ownership ciphertext records**,
three credentials and the tenant key, with integrity/FK checks and two isolated
quarantines. The snapshot retains 3,327 claims and 2,689 QRZ owners/markers.
No production restore or vendor mutation occurred. This populated exact-evidence
recovery does not verify recovery of populated raw historical associations.

At **21:32:51.368 UTC**, all **19 aggregate checks** pass: the ownership registry
has **9,981 covered inputs**, zero pending or held inputs, zero unhashed owners
and **3,327 exact copies**. The source index is clean with **4,146 entries**;
QRZ retains **2,689 owners and association markers**. Raw references, attempts,
cutovers, pins and proofs are zero. **Ownership coverage bootstrap is complete
at this checkpoint**; it does not establish fresh source/vendor evidence or
write authority.

The first f2c cron, **21:30:48.324–21:31:50.809 UTC**, made **220 contact turns /
380 classifications / zero adoptions**, with zero attempt turns and **four
affected routes** from one failed QRZ history read. Its recorded category is
`history_read:qrz:unknown`; the precise cause remains unknown. It took
**62.485 seconds**, using **857 D1 RPCs /
6,865 SQL statements**. An overlapping idle run,
**21:31:18.620–21:31:28.582 UTC**, took **9.962 seconds** and used **62 RPCs / 535
statements**, with zero errors. These samples do not identify the exact live
cause of the errors or bootstrap ordering, or establish sustained or
200,000-contact capacity.

The **21:36:47.379 UTC** protected backup verifies all **3,327 populated exact
evidence envelopes**, complete bootstrap coverage and 2,702 QRZ owners/markers.
Its 42,144,346-byte snapshot passes credential/key decryption, exact AAD/HMAC and
ownership checks, integrity/FKs and two isolated quarantines. The separate
**21:37:57.619 UTC** immutable comparison preserves every prior claim, owner,
marker and evidence field; additions are 33 exact copies and 13 QRZ
owners/markers, with zero prior rows changed or lost. Raw references remain
empty, so populated raw-reference recovery is still open. Neither check restores
production or grants export authority.

A fresh exact-f2c same-contact packet succeeded at **22:03:28.032 UTC** in one
Cloudflare preview: one positive collection plus mandatory final drain covered
two dependencies and no events, one native batch minted a proof at
**22:03:22.388 UTC**, and three QRZ targeted/book/covering reads observed a complete
empty neighborhood. The **same proof** remained current with **293,053 ms** left.
The inner composition used **109 D1 RPCs / 135 SQL statements** in **7.471 seconds**,
excluding host startup, nonce admission and attestation. The original
**22:03:17.856 UTC** receipt was never refreshed inside the Worker. The preview
was disposed; independent **22:03:29.573 UTC** attestation reconfirmed the same
Worker and all eight closed controls. Attempts, stages, pins, cutovers, signing
and vendor mutations remained zero. This is finite preview evidence, not
scheduled proof execution or write acceptance. The earlier 5a packet below
retains its original scope and expired proof.

The **21:53:13.701 UTC** pre-run recovery backup verifies 36 migrations, all
3,327 exact ownership copies and 2,702 QRZ owners/markers, with three credential
and tenant-key decryptions, integrity/FKs and two isolated quarantines.
A local public-manifest size failure stopped before any live operation; its
reviewed 128 KiB metadata-only correction preserves private and Worker limits.
An initial actual preview returned known `cycle_busy` with zero source/QRZ
requests before the successful same-candidate run.

The **22:04:34.745 UTC** post-proof backup contains **42,608,702 bytes** and all
36 migrations. All 3,327 exact ownership ciphertext records, three credentials
and the tenant key pass validation, along with integrity/FKs and two isolated
quarantines. One immutable proof and its matching retention row are preserved;
attempts, both pin tables, cutovers and raw references remain zero. The snapshot
has 2,766 QRZ owners/markers, 4,146 index rows and 9,981 covered ownership inputs
with no pending, held or unhashed work. The separate **22:05:47.352 UTC**
comparison against the **21:28 UTC baseline** preserves every original field of
3,327 claims, 2,689 QRZ owners and markers, and 3,294 exact evidence records,
with zero missing or changed rows. Additions are 77 QRZ owners/markers and 33
exact copies. This comparison uses that earlier baseline, not the 21:53 pre-run
snapshot; no production restore occurred.

The protected offline **21:36:47.379 UTC snapshot** audit examined all 606 QRZ
hold routes: **47 forward/reverse-unique positive candidates**, **539 current
holds**, and **19 incomplete inventories plus one unavailable reverse body**.
These are not committed associations or final ownership approval. Among 523
forward-unique held pairs, 343 retained remote coordinate pairs lie outside
their own grid; all 359 available source pairs lie inside both compatible grids,
while 274 of those remote pairs lie outside their own. No remote point matches
its own or a supported parent-grid center at recorded precision. The cause and
vendor provenance remain unproved; user location-policy clarification is pending
and contradictions remain held. See [QRZ evidence](docs/evidence-qrz.md).

The concrete protected single-attempt/stop/recovery packet now passes 22 native
offline cases and a separate 21-case recovery suite, with independent review.
The same-contact SELECT-only payload capture succeeded at **22:36:54.773 UTC**;
it grants no source-proof or write authority. The **22:29:48.108 UTC** backup
verifies all 3,327 exact ownership records, 2,798 QRZ owners/markers, zero
attempts and two isolated quarantines. A separate LoTW diagnostic passed at
**22:42:33.579 UTC**: a newly collected proof stayed current through one complete
empty three-day GET. Its earlier pre-GET failure did not recur and remains
unexplained. A separate **23:00:35.114 UTC** diagnostic made one budgeted
certificate-status GET and reported the selected certificate unrevoked. Its
inner run used **78 D1 RPCs / 88 SQL statements** in **8.121 seconds**, with no
source/history read, proof, signing, stage or attempt. Independent attestation at
**23:00:34.070 UTC** confirmed all eight controls closed. This finite observation
does not prove signing or upload acceptance; see [LoTW evidence](docs/evidence-lotw.md).

The **22:43:13.471 UTC** post-diagnostic backup verifies all 3,327 exact ownership
records, one proof with matching retention, 2,803 QRZ owners/markers, zero
attempts/pins/cutovers and repeated isolated recovery. The **22:43:58.546 UTC**
comparison against the **21:28 UTC baseline** preserves every original claim,
owner, marker and exact evidence field; additions are 114 QRZ owners/markers and
33 exact records. No production restore or vendor mutation occurred.

The remaining first-QRZ-write work is explicit owner authorization, fresh normal
preparation evidence, and real acknowledgement plus exact readback acceptance. Follow the
[restricted QRZ pilot guide](docs/qrz-pilot.md). **Keep exports disabled**
is still the controlling instruction. Unrelated historical exceptions,
currently empty raw-LoTW recovery and 200,000-contact capacity do not block that
restricted future QRZ pilot. They remain separate follow-ups, along with
scheduled proof-path validation and sustained capacity.

### Previous production — guarded LoTW historical association (5a427a30)

Signed revision `5a427a3009d817066a744a005f46bb30c1c14095` deployed read-only at
**2026-10-24 20:27:06.855761 UTC** as Worker
`1e3a63b8-eceb-47dc-86d5-b4c64dd79a48`, deployment
`9abe3b85-f5c4-4250-9d26-45d9b53bd332`, the sole deployment at 100% traffic.
All 11 new commits have independently verified remote signatures. All **1,610
tests** and required checks passed in
[release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40127593520)
at **20:24:10 UTC**. Independent attestation at **20:27:28.292 UTC** confirmed
all **eight export controls closed**, active KEK version 1, healthy HTTPS and
matching assets. Production now has **36 migrations**, including `0035`–`0037`.

The release implements inclusive **±30-minute LoTW historical association**,
retained raw precision, durable ownership and permanent historical-upload blocks,
with reverse-source uniqueness and source-comparison batching. Failed history
reads also receive bounded partition-local retry delays. The implementation and
local recovery evidence are recorded below. None grants export permission;
**exports remain disabled**.

The fresh **20:25:52 UTC** predeployment backup verified 33 migrations, 2,549
QRZ owners and matching association markers, 3,327 exact claims, 4,141 indexed
contacts, 4,500 source rows and 2,465 legitimate resolved archives, with zero
attempts, proofs or pins. The **20:26:17.941 UTC** migration rehearsal preserved
all 12 checked original tables and five ownership/history registries through two
quarantines. The **20:27:46.782 UTC** postdeployment backup contains 39,123,981
bytes and all 36 migrations. Its isolated restore, three credential decryptions,
tenant-key verification, integrity/FK checks and repeated quarantine pass,
including bridge, raw-evidence, source, inventory and receipt tables. The
**20:28:34.534 UTC** immutable comparison preserved all 3,327 claims, 2,549 QRZ
owners and 2,549 markers exactly, including creation times: zero missing, added
or changed rows. No production restore or vendor write occurred.

The postdeployment snapshot still has 4,141 index rows, 4,500 source rows and
2,465 legitimate archives, with zero attempts, cutovers, proofs, pins, temporary
guards or raw-history records. The newly created LoTW registry has **3,833
unhashed owners and 9,981 pending inputs**, with zero held inputs or retained
evidence. This is the initial bootstrap state; unfinished coverage remains
explicitly nonauthoritative.

The first scheduled run, **20:30:43.485–20:32:18.599 UTC**, made 22 contact turns,
21 classifications and four adoptions, with zero attempt turns, one error and
zero deferrals. It stopped at the deadline after 95.114 seconds, using 359 D1
RPCs / 2,878 SQL statements. Ten ownership passes examined 1,000 inputs, covered
none and hashed 1,000 owners in 20.832 seconds. All **19 aggregate checks** passed
at **20:31:23.628 UTC**, during the run, with matching policy v5 active: 2,833
owners remained unhashed, 8,981 inputs pending and 1,000 claim inputs held.
Identity/mapping copies, new raw references and attempts remained zero.

The single error was `history_read:lotw:lotw_unavailable`, affecting one route.
Its exact HTTP cause is unknown; the reader keeps coverage incomplete and applies
bounded partition retry. This is not proof of absence or completed reconciliation.
At **20:50:15.919 UTC**, all 19 aggregate checks still pass: 640 copied exact
ownership records, 640 covered inputs, 5,981 pending and 3,360 held inputs, with
two unhashed owners. The clean comparison index has 4,144 rows and QRZ has 2,635
guarded associations. The latest completed run made 123 contact turns, 89
classifications and 29 adoptions, with zero errors, deferrals or attempt turns.
These observations describe progress, not complete ownership coverage.

The fresh **20:50:59.570 UTC** backup verifies recovery of all **640 populated
encrypted exact records**, including original AAD, retained key, HMAC bucket and
ownership bindings. Isolated integrity/FK checks, three credential decryptions,
tenant-key verification and two quarantine passes succeed. The **20:51:08.635
UTC** comparison preserves every original claim, owner and marker exactly; 86
additional QRZ owners/markers are legitimate guarded associations. Raw LoTW
history is still empty, so populated raw-reference recovery remains open.

The **20:51:53.826 UTC** SELECT-only QRZ trial planner found no eligible candidate
under its complete current-context selection rule. It made no vendor request or
database mutation. Diagnose that selection result before refreshing proofs; do
not force a contact into eligibility. Bootstrap coverage, actual exception
review, fresh source/vendor proofs, scoped first-write acceptance and sustained
capacity remain open. Exports remain disabled.

The stale-context diagnostic admission issue is resolved without changing final
eligibility. A separate SELECT-only planner preserves the failed preliminary
audit and binds the current source versions and routes. One cloud invocation
then held at `candidate_binding_changed` before any vendor request. A cron ran
between selection and execution; the exact differing field was not diagnosed.
A fresh plan for that **same contact** succeeded at
**21:10:12.733 UTC** using the exact `5a427a30` modules in one Cloudflare preview:
two normal source reads, one native proof batch, and three QRZ reads with verified
book identity and a complete empty neighborhood. The same proof remained current
afterward with **296,013 ms** left. The inner composition took 4.617 seconds,
110 D1 RPCs / 136 SQL, with two dependencies and no events. These metrics exclude
preview startup, the separate nonce lease and host verification. The preview was disposed; independent
before/after checks preserve the sole production Worker and all eight closed
controls. This verified a finite then-deployed `5a427a30` read path, not scheduled proof
execution, global completeness, capacity or a QSO upload.

The **21:05:40.508 UTC** backup independently validates **2,640 populated exact
ownership records**, preserving 3,327 claims and 2,653 QRZ owners/markers through
isolated restore and repeated quarantine. Coverage remains unfinished: 3,981
pending inputs and 3,360 held inputs, with zero unhashed owners. At
**21:06:53.328 UTC**, QRZ has 226 ambiguous / 512 mismatched / 447 pending routes.
Only five ambiguous rows have a memo for the same ledger generation; memo timing
does not establish current canonical projection or finished exception review.

The **21:13:06.917 UTC** postdiagnostic backup verifies **3,294 encrypted exact
ownership records** plus the new immutable proof and its matching retention row
through isolated restore and two quarantines. Attempts, cutovers and pins remain
zero. There are still 1,981 pending inputs and 3,360 held inputs; copying most
identities does not establish complete ownership coverage. Raw references remain
empty. No production restore or vendor mutation occurred.

### Follow-ups released in f2c41cb3

`59c320afac37c36858b51b87d5153ec51500799e` prioritizes identity copies for owners
hashed in the same bounded pass. The identical-snapshot rehearsal reduces adapter
RPCs **925→773** while preserving complete coverage and every prior protected
row. Its full isolated check passes **1,613 tests** and all required checks.
`f2c41cb3a929ae3d3545e235894027b84fbf09fb` conservatively honors authoritative
LoFi `status: "deleted"`; 57 projection/collector tests and three focused native
intake cases pass. Both changes are signed and pushed; integrated types and build
pass. [Combined release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40132320522)
passed all **1,617 tests** at **21:26:36 UTC**, and both follow-ups are included
in the f2c deployment above. Fresh exact evidence is required again before any
later authorized first-write trial; exports remain disabled.

### Previous production — inventory diagnostics (c4f51de8)

Signed revision `c4f51de821d7d5867a19b1710fc188659b9d3771` deployed at
**2026-10-24 17:28:57.761108 UTC**, Worker
`7666c159-2a0b-463b-a08b-69295d8653a6`, deployment
`05e67989-f6bb-4a41-9ea9-d8c1a53d5a30` at 100% traffic. All **1,488 tests** and
release checks passed in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40114936899).
Independent verification at **17:33:39.140 UTC** confirmed all eight controls
closed, healthy HTTPS, matching assets and active KEK version 1. At that checkpoint,
production had 33 migrations through `0034`.

Fixed categories distinguish missing identity/station, wrong station and
out-of-partition dates; matching and rejection behavior are unchanged. The first
cron, **17:30:42.737–17:31:25.276 UTC**, made 100 contact turns, 110 classifications
and 72 adoptions, with zero errors, deferrals or attempt turns. It used 856 D1
RPCs / 3,675 statements in 42.539 seconds and stopped at the database budget.
This sample establishes neither a causal speedup nor the cause of older errors.

All 13 aggregate checks passed at **17:33:38.015 UTC**: 797 QRZ mappings have
owners, association markers and write blocks without gaps; the 4,141-row index is
clean; 3,327 LoTW claims cover their mappings; and all 778 missing source bodies
are legitimate resolved archives, with 3,722 bodies retained. Attempts, cutovers,
proofs, pins and temporary guards remain zero. The **17:34:16 UTC** QRZ snapshot
has 2,432 ambiguous / 135 mismatched / 469 pending routes. Of the ambiguous labels,
2,423 lack a current-generation memo; nine have post-index checks (eight remote
competitors and one location-detail hold). Memo timing does not prove current
canonical projection or exact policy provenance. The earlier backup and proof
receipts below keep their original scope.

Independent **18:12:34.791 UTC** readback confirms the same sole c4f Worker,
eight closed controls and 33 migrations. QRZ has **1,219** guarded associations,
**1,953 ambiguous / 183 mismatched / 478 pending** routes, and a clean 4,141-row
index. Of the ambiguous labels, **1,939** lack a current-generation memo; 14 have
post-index checks (11 remote-competitor and three location-detail holds). Memo
timing still does not establish current canonical projection or exact policy
provenance. The latest completed cron made 160 contact turns, 295 classifications
and 22 adoptions, with zero errors, deferrals or attempts, in 91.812 seconds.
This is continued read-only reconciliation, not completed exception review or
sustained capacity. No release after c4f had been deployed at that checkpoint.

A **19:43:07.376 UTC** independent release check reconfirms the same sole c4f
Worker, active KEK version 1, matching assets, healthy HTTPS and all eight closed
controls. The changes described below were still local at that checkpoint.

The separate **19:43:59.512 UTC** read-only database snapshot has 2,132 QRZ
associations and 2,132 owners, with **775 ambiguous / 437 mismatched / 489
pending** routes. Of the ambiguous labels, 754 lack a current-generation memo;
the other 21 have post-index checks (18 remote competitors and three location
holds). The same memo/provenance limitations above still apply. The index remains
clean at 4,141 rows, migrations remain 33, and attempts/cutovers/stage guards remain
zero. All six sampled completed crons have zero errors and deferrals; the latest
made 40 contact turns, 33 classifications and 24 adoptions in 94.746 seconds,
using 323 D1 RPCs / 1,343 statements. Waiting continues to resolve old labels;
these samples do not finish reconciliation, exception review or capacity proof.

### Implementation evidence for 5a427a30 — ownership and bounded retries

Migration `0035` and an observation-only LoTW registry preserve encrypted exact
identity evidence across inactive, signing-only and reconnected destinations.
Lookups use tenant plus exact station callsign and bounded opaque buckets; missing
or unreadable evidence holds coverage. Results explicitly require a later write
bridge and grant no adoption or export authority on their own. The release
includes that guarded bridge and consumer. Twenty foundation/Store cases
and four delivery/recovery cases passed. A rehearsal on the verified 17:04:57
backup installed 34 migrations locally, preserved all 58 prior tables, 3,327
claims and 462 owners/markers, and preserved the new registry through repeated
quarantine. This rehearsal preceded production migration `0035`. Retain every KEK referenced by
copied evidence until its separate bounded rewrap path is implemented.

A second patch gives actually sent failed history reads a partition-local retry
delay of at most 15 minutes, clipped to the original expiry. Failed responses add
no page evidence or cursor progress; later cohorts wait without duplicate failure
events. Auth, vendor deferrals, scope/lease commit guards and split behavior remain
unchanged. All 81 focused history/diagnostic cases passed. Together, the patches
pass 161 history/Store/foundation cases plus the mixed-history integration case,
with unchanged 158 cohort / 262 whole-tick RPCs and 1,176 statements. Types, lint,
format and Worker build pass. The expanded CI run passed 1,516 of 1,520 cases;
four scheduler fixtures still expected retry after five minutes. Their timing now
honors the production 15-minute retry policy, explicitly checks no early reads,
and all four pass locally. The foundation, retry fixture fixes, pure classifier
and batched backfill then passed the full local check: **1,535 tests**, formatting,
lint, both TypeScript projects and the Worker build. That local checkpoint
preceded the verified 1,610-test signed release above.

A fresh **17:51:44.635 UTC** backup of deployed `c4f51de8` contains 34,509,084
bytes and 33 migrations. Isolated restore, all three credential decryptions,
tenant-key verification and repeated quarantine pass; 3,327 claims and 1,061 QRZ
owners/markers are retained. An isolated `0035` backfill covers all 9,981 inputs
with 3,327 validated encrypted tuples and zero holds, preserving prior tables.
The separately reviewed backfill batching patch reduces the same local adapter
work from 27,528 to 925 calls; its native-D1 30-contact fixture falls from 188 to
11 RPCs. These are local results; scheduled bootstrap and capacity remain open.

All 21 reverse-source cases now pass, including five actual-D1 LoTW cases for
mode groups, the inclusive time limit, midnight, portable station namespaces and
late cross-source competition. A separate pure broader LoTW classifier passes
seven cases while preserving raw precision, modes and nested grid values. This
foundation alone grants no ownership or write authority. The deployed consumer
and write-bridge implementation is described below.

Three additional commits implement the ownership write bridge, raw
historical evidence and the LoTW reconciliation consumer. Historical matches use
the inclusive 30-minute policy, compatible valid grid subsets, reverse-source
uniqueness and guarded permanent ownership. Original minute timestamps and grids
remain encrypted as reported; a historical reference never becomes an exact
delivery receipt. All LoTW routes remain blocked from uploading that historical
owner, including after source/configuration changes. Real submitted or uncertain
receipt facts remain recoverable when a new mapping must stay held.

The focused native suites cover atomic stage/adoption cohorts, unknown
acknowledgements, partial mapping conflicts, policy upgrades, source/inventory
races and retained references. These service cases now pass in the full
integrated run. An **18:57:20 UTC** isolated rehearsal
applied `0035`–`0037` to the protected current production snapshot: all 12 checked
original tables were unchanged, integrity/FK checks passed, and two restore
quarantines preserved all five ownership/history registries. These are local
results from before deployment; production now has all 36 migrations and exports
remain disabled.

The expanded consumer also exposes a real bootstrap cost regression: the fully
cached 40-route mixed-week case makes **309 cohort / 413 whole-tick RPCs** and
1,372 SQL statements, exceeding its unchanged 220-RPC limit. Explicit source
comparison batching now passes that same fixture at **118 cohort / 222 whole-tick
RPCs and 1,123 SQL**, retaining the original 220-cohort-RPC limit, 40 adoptions, zero
inventory fetches and 40 cache hits. Shared reads retain independent comparison
guards; bounded cohort overflow splits without truncating candidates. The
separate pre-batching minute-time fixture completes all 40 associations in 315
cohort RPCs; the integrated batched run completes the same 40 in **124 cohort /
312 whole-tick RPCs and 1,379 SQL**. It still makes three inventory fetches and
at least 38 cache hits. Its settled pass does no reconciliation, while routine
scheduler/maintenance work remains 144 RPCs / 168 SQL.
The full integrated local check now passes **all 1,610 tests**, formatting, lint,
both TypeScript projects and the Worker build. The older fixture failures are
repaired without relaxing runtime guards or the cached cohort's 220-RPC limit.
Signed push, release CI, refreshed release-bound backup/rehearsal and read-only
deployment are verified above. Bootstrap coverage, full exception review,
first-write acceptance and sustained capacity remain open.

The recovery packet passes **61 offline cases**: 45 backup/comparison
cases and 16 native-D1 aggregate cases. It verifies original raw encryption and
HMAC bindings, retained old keys, exact ledger references, permanent LoTW upload
blocks and repeated quarantine under all 36 migrations. Unfinished ownership
coverage stays visible and grants no authority. Fresh release-bound copies and
independent Worker verification now support the production migration and
postdeployment restore/comparison evidence above; no vendor write occurred.

### Comparison and coverage follow-up — deployed read-only

Four signed commits through `9aeab582149baa8af8fd6db8cc9cc318b2bc3739` deployed
at **2026-10-24 17:04:38.163667 UTC** as Worker
`950c081c-03b4-455f-8e31-b579fec56788`, deployment
`f4213a4e-e67e-4ef8-8581-41196f47f14f` at 100% traffic.
All **1,485 tests** and required checks passed in
[release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40112629290).
Independent verification at **17:04:50.692 UTC** confirmed healthy HTTPS,
matching assets and all **eight export controls closed**. This release excludes
permanent historical write blocks from
first-insert audit suggestions, combines the unchanged source-index candidate and
guard SELECTs in one D1 batch, and retains both required UTC date paths through
LoTW and accepted QRZ split inventory. Broader LoTW adoption is still separate.

Focused checks passed: 42 source-index/reverse/service cases, 122 history cases,
and all 11 audit cases, plus formatting, lint, types and the Worker build. The
20-contact fixture falls from 178 to **158 cohort RPCs** and 282 to **262 whole-tick
RPCs**, with the same 1,176 statements and guarded outcomes. This is a measured
local reduction; sustained production capacity remains unverified.

At **17:05:22.396 UTC**, all 13 aggregate checks passed: 33 migrations through
`0034`, 4,141 clean published index rows, 462 QRZ mappings with permanent owners,
association markers and write blocks, and all 3,327 LoTW exact mappings covered
by claims. There were no ownership gaps, attempts, cutovers, proofs, pins or
temporary write guards. All 453 missing ordinary bodies were legitimate resolved
archives; 4,047 retained bodies account for the remaining source rows.

The protected **17:04:57 UTC** backup retained 33,946,884 bytes and passed isolated
restore, integrity/foreign-key checks, three credential decryptions, tenant-key
decryption/HMAC-ID validation and repeated quarantine. Exact comparison at
**17:05:22.514 UTC** preserved all 3,327 prior claims and all 39 prior owners and
markers, including creation timestamps; 423 owners/markers were added and none
changed or disappeared. No production restore or vendor mutation occurred.

The **17:05:22 UTC** snapshot has QRZ 462 mapped / 2,810 ambiguous / 100 mismatched /
461 pending routes; LoTW has 3,327 / 7 / 160 / 339, with zero adoption conflicts.
It precedes the first completed new-release cron and is not a sustained capacity
result or completed exception review. The separate fixed-category history-error
patch and broader LoTW ownership foundation are not deployed in this revision.

The first completed new-release cron, **17:05:42.632–17:07:16.980 UTC**, made
80 contact turns, 47 classifications and 38 adoptions, with zero attempt turns
or deferrals. Its 15 affected-contact errors came from two diagnostic events:
missing time evidence affected one contact and generic partition-scope rejection
affected 14. Those contacts remain held; the old generic scope counter cannot
identify the cause. The run stopped at its deadline after 94.348 seconds,
552 D1 RPCs / 2,407 statements and 92.033 seconds of database wall time. This
unequal workload does not establish a production speedup.

At **17:07:28.689 UTC**, QRZ has 500 associations/owners, 2,765 ambiguous labels,
103 mismatches and 465 pending routes. Of the ambiguous labels, 2,760 lack a
current-ledger-generation memo; five have post-index checks identifying remote
competitors. These hints still do not prove current canonical projection or exact
matching-policy provenance. The index remains clean and attempts/cutovers remain
zero. Continue fresh revisits, diagnose the fixed inventory failures, and complete
the LoTW ownership/write bridges before enabling its broader classifier.
Independent verification at **17:08:02.184 UTC** reconfirmed the same sole Worker,
all eight closed controls, active KEK version 1, HTTPS and matching asset hashes.

The **16:27:05 UTC** aggregate separates processing backlog from established
exceptions: QRZ has 221 associations and 3,114 ambiguous labels; 3,110 ambiguous
routes lack a current-ledger-generation memo, while four have post-index checks
identifying competing remote records. Most labels still need a current revisit.
Memo time alone does not prove current canonical projection or exact policy
provenance. The index remains clean; attempts, cutovers and stage guards are zero.

A current-release SELECT-only planner succeeded at **16:34:42 UTC** for one fixed
contact, with two source dependencies and no events. Both destination metadata
checks passed, including zero historical write blocks. It made no source/vendor
requests, observations, proofs, stages or attempts. The same fixed contact then
passed the bounded source-proof and QRZ-read composition at **16:53:05.833 UTC**
against the deployed `6ff685a7` runtime: two normal source reads (dependency
collection and final canonical drain), two dependencies/no events, one immutable
proof batch, and three QRZ reads (targeted FETCH, STATUS and covering FETCH).
The final proof, route, credentials, ownership and eight closed controls remained
current; QRZ returned a complete empty neighborhood. No signing, staging,
attempts, cutovers or vendor mutations occurred. This finite host diagnostic
used separately hashed runtime/audit code; it is neither scheduled Worker
execution nor write-acceptance evidence. The proof had 287,448 ms remaining at
the final check and must be renewed for a future write; it grants no export
authority or global source-completeness claim.

### Previous verified release (6ff685a7)

Signed revision `6ff685a7f4991dec0fd0b368552233330bf692bf` deployed read-only at
**2026-10-24 15:59:23.445021 UTC**, deployment
`6fee8987-3084-4519-809e-e4c943b9a524` at 100% traffic. Worker
`aa64f26f-e2b7-4638-8e04-542854a912b0` was created at
`2026-10-24T15:59:22.49107Z`. All **1,429 tests** and required release checks passed
in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40108165167).
Independent verification at **15:59:42.503 UTC** confirmed all **eight export
controls closed**, healthy HTTPS, matching hashes for all three assets and all
33 migrations through `0034`. No vendor writes occurred.

The QRZ historical association integration is now deployed. Index backfill completed
at **16:02:36.319 UTC**: all **4,141** retained ordinary contacts are published, with
zero dirty, rebuilding or unknown entries and one initialized tenant key. Four
bounded manual invocations and scheduled work contributed; overlapping publication
counters are not added to derive that unique total. Manual backfill had zero held
entries and no source, ledger, attempt or vendor writes. The index and policy
version 4 passed all 13 aggregate checks at **16:03:00.447 UTC**.
Its bounded opaque
source index, reverse-source uniqueness and durable LOGID ownership support
minute-precision/±30-minute association without inventing seconds. Every QRZ
historical adoption through the new path is association-only, including exact-time
matches. Existing exact Ferry receipt/readback paths remain separate and unchanged.

The first completed scheduled run, **16:00:42.898–16:02:17.635 UTC**, ended before
index completion. It reported 105 contact turns, 89 destination classifications,
zero adoptions/errors/deferrals, and 1,000 index entries examined / 900 published /
zero held. Its 610 D1 RPCs / 4,474 statements took 94.737 seconds, including 91.754
seconds of database wall time. This initial run did not establish post-backfill
adoption or sustained capacity.

The first post-index run, **16:05:42.889–16:06:38.147 UTC**, made **39 adoptions**
from 82 contact turns / 74 destination classifications, with zero attempt turns,
errors or deferrals. It stopped at `database_budget` after 55.258 seconds,
916 D1 RPCs / 3,039 statements and 52.291 seconds of database wall time; inventory
used 25 fetches and 54 cache hits. At **16:07:37.591 UTC**, all 13 aggregate checks
passed: 39 QRZ mappings/owners/association markers/write blocks, no unreserved or
orphaned ownership or missing blocks, all 4,141 index entries published and
covered, and all 3,327 LoTW exact claims covering their mappings. QRZ outbound
claims, attempts, cutovers, proofs, pins and temporary write guards remain zero.
Thirty-six source bodies were legitimately archived after both routes resolved;
4,464 remain, with zero unexplained missing bodies.

At **16:07:37.728 UTC**, QRZ has 3,833 routes: 39 mapped, 3,359 ambiguous,
16 mismatches, 419 pending and zero conflicts. LoTW has 3,327 mapped, seven
ambiguous, 161 mismatches and 338 pending. These remaining holds are not yet a
proven manual exception queue. Neither this sample nor published index coverage
establishes sustained capacity, universal upstream completeness or first-insert
absence.

The postdeployment backup started at **16:07:07 UTC** and verified 35,325,311 bytes
with all 33 migrations. Isolated restore, integrity/foreign-key checks, three
credential decryptions and repeated quarantine passed, preserving the decrypted,
HMAC-ID-validated tenant index key, 4,141 index rows and 39 owners/association
markers. All 36 archived-body checks passed; attempts/cutovers remain zero.
The **16:08:10.506 UTC** comparison preserved all 3,176 predeployment claims
across every one of their seven fields, including `created_at`: 3,327 postdeployment
claims, 151 additions, zero missing or changed. Preserve both backups and the
wrapping KEKs. No production restore or vendor write occurred.

QRZ deployment, index, ownership and backup verification are complete for this
rollout. All eight closed controls, HTTPS and assets were reconfirmed at
**16:07:02.175 UTC**. Exports remain disabled.
The 20-contact fixture's **178 cohort / 282 whole-tick D1 RPCs**, up from 65 cohort
RPCs, is a known cost to reduce; no 200,000-contact capacity is established.
LoTW's wider adoption and fresh first-write acceptance evidence remain outstanding.
See [the integration contract](docs/bootstrap.md#historical-association-and-vendor-matching)
and [release acceptance](docs/rollout-checklist.md#verify-the-deployed-lookup-and-coverage-follow-up).

### Previous verified release (0dad1031)

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
holds. At this release it had no production reconciliation consumer and granted
no adoption, absence, correction or export authority.

The first completed run on this release ran **13:45:43–13:47:22 UTC**:
84 contact turns, 113 destination
classifications and 44 adoptions, with zero attempt turns,
0 errors and 0 deferrals; it stopped at
`deadline` after 98.845 seconds.
The aggregate snapshot at `2026-10-24T13:47:30.260Z` records
**1,360 LoTW adoptions** and
1,360 retained destination claims, with all mapped
LoTW identities covered. Export attempts, cutovers and temporary stage guards
remain zero. Policy version 3 is active. These are read-only reconciliation
measurements, not sustained capacity or completed cross-vendor contacts.

The next work at that checkpoint was the bounded source comparison index,
current source/remote uniqueness, durable historical ownership and association-only
stage/dispatch restrictions.
Extend LoTW retained coverage across UTC day/week boundaries before using the
wider window for adoption. Then review actual identity/location conflicts and
refresh exact source/vendor evidence for the separate export-readiness packet.
Exports remain disabled; no first-write trial is authorized by this release.

### Earlier matching correction release (ba8c982a)

**Priority update, 08:51 EDT:** matching corrections are deployed; finish the
separate QRZ historical association policy before the first-export packet. The
08:16 EDT investigation histogram
attributes 2,858 of 2,957 LoTW ambiguities to compatible lower grid precision;
QRZ has 1,578 minute-only-time holds and 1,853 generic identity failures.
These are not established duplicate-contact counts. The narrow LoTW grid-compatible
association correction is deployed with exports disabled. An offline audit attributes 87 of
93 frequency holds to a kHz conversion artifact; its correction preserves six
genuine finer-precision holds. QRZ needs a distinct historical
association path and source/remote uniqueness checks. See the
[matching investigation](docs/reconciliation-investigation.md#precision-matching-investigation-2026-10-24).
Exports remain disabled.

The matching corrections deployed read-only at **2026-10-24 08:51 EDT** as signed revision
`ba8c982a0b67b97e354f1bcb4acc8efe50729097`, Worker `6b07bcf7-ac24-4bcb-abf4-be43766c8938` at 100% traffic.
All **1,353 tests** and required release checks passed in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40094384509).
Independent readback confirms all eight export controls closed, healthy HTTPS
and matching assets. There was no migration or vendor write. The grid-compatible
LoTW association, exact decimal frequency conversion and valid numeric zone
comparison are now available to normal reconciliation. Their policy version wakes
held work once; the 2,858 grid and 87 artifact-related frequency counts describe
the investigation cohorts, not a claim that every row has already reconciled.

The first matching-release cron completed **12:55:44–12:57:13 UTC** with
147 contact turns, 262 destination classifications and **99 LoTW adoptions** in
88.756 seconds. It stopped at the database budget: 878 D1 calls, 5,018 statements
and 80.687 seconds of database wall time. Three affected-contact errors and 21
deferrals remain; this sample does not establish sustained capacity. The 12:58:08
snapshot has 479 LoTW adoptions and identity claims (up from 380), with no uncovered
mapped identities, export attempts, cutovers or temporary stage guards. Matching
policy version 2 is active. QRZ remains held for the separate association work.

### Earlier first-insert safeguards release (12f636b3)

Signed revision `12f636b312c9192b755188faf06d66171d485da5` deployed read-only at **2026-10-24 07:59 EDT**
(`2026-10-24T11:59:10.901859Z`), as Worker `bd6ff427-351d-463c-9b7d-4395e256117d` at 100% traffic.
All **1,338 tests** and required release checks passed in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40090915890).
Independent readback verified all **eight export controls closed**, healthy HTTPS,
and matching dashboard assets. All 31 migrations through `0032` are installed;
source membership is ready, all 4,500 retained rows have bodies/incarnations,
380 LoTW identity claims remain covered, and export attempts, cutovers, pins and
temporary write guards remain zero. Diagnostic source proofs are temporary and
are not write authorization.

Exports remain disabled. The separate QRZ and LoTW first-insert safeguards,
source collector expansion and bounded proof-clock admission are now deployed.
Next: refresh the exact contact's source proof and fresh QRZ evidence on this
release, then prepare its read-only trial packet. LoTW separately needs a complete
empty three-day report, current certificate checks, and eventual signed upload
and exact readback acceptance. No trial runs under the keep-disabled instruction.
Global source completeness, historical exception review and sustained capacity
remain separate unresolved work. Closed-gate cron continues reconciliation but
skips export proof creation; waiting for cron alone cannot close those checks.

See [deployment evidence](docs/deployment.md), [LoTW safeguards](docs/evidence-lotw.md)
and [capacity limits](docs/capacity-plan.md#cost-of-the-lotw-first-insert-path).

The first completed scheduled run after deployment ran from **08:01:51 to
08:03:23 EDT** (12:01:51–12:03:23 UTC): 63 contact turns and 42 destination
classifications in 92.154 seconds, with zero attempt turns. It stopped at the
soft deadline after 600 D1 calls/1,837 statements and 86.767 seconds of database
wall time. Nine affected-contact errors were two LoTW-unavailable, two QRZ
history-scope mismatches and five QRZ missing-ADIF-time results; 21 vendor-budget
deferrals were separate. These remain held rather than becoming absent or
exportable. This verifies scheduled reconciliation on the new release, not the
export-proof/signing path or sustained throughput.

A protected LoTW three-day diagnostic stopped at **08:03:26 EDT** before any
remote database or vendor call: the pre-deployment snapshot yielded zero
candidates satisfying the strict selection predicate. An isolated repeat confirmed
one selection read, zero inspected candidates and zero writes. No alternate
contact or weaker predicate was used. Thus fresh three-day LoTW evidence remains
outstanding, as does the final-release joint source/QRZ proof refresh. The helper
was independently reviewed against all 93 runtime file hashes and passed 16
focused offline tests; that is implementation evidence, not a successful live read.

### Earlier observations (before this release)

Signed revision `02e3dc89b99a5d7428c01b6a09596a105784eb11` deployed read-only
at 06:09:06 UTC as Worker `da7b7b70-6b7e-4cab-b9f6-f4b88f38390d`, at 100% traffic.
All **1,178 tests** and required checks passed in [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40068069314).
Independent 06:09:17–18 checks confirm healthy service, matching hashes for all
three assets and all seven export controls closed. Health reports no active
export mode and `sourceBoundaryVerified:false`. All 30 migrations through `0031`
are applied. The 380 LoTW identity claims have no uncovered mappings; attempts,
cutovers, proofs, pins and temporary guards were zero at release verification.
All 4,500 source bodies had incarnations, and 2,155 positive observations had no
future or partial metadata.
The production baseline, forward drain and quarantine handoff completed at
**06:35:44.881 UTC**. The policy is `ready`: all 218 operations and 4,282 QSO-stream
records—4,500 retained rows—are members of the current epoch, with zero unseen
retained rows. The 4,130 eligible contacts are eligible for reconciliation
processing, not authorized exports.

The 06:35:43–06:36:10 run resumed normal reconciliation: 62 contact turns and
60 destination classifications in 27.187 seconds, with four errors and 50
deferrals before the `database_budget` stop. It made 871 D1 calls containing
2,179 statements; database wall time was 24.125 seconds. These are processing
turns and classifications, not unique completed contacts or sustained capacity.

At **08:12:53 UTC**, exact deployed source code minted a current source proof
and observed fresh QRZ absence for the **same contact**. One positive collection
and a final canonical drain covered two dependencies, with no events. QRZ used
one targeted FETCH, one STATUS book verification and one complete covering FETCH.
Strict keyed eligibility and the exact proof passed again after QRZ and closed-gate
verification, with 291,986 ms of proof lifetime remaining. Attempts, stage guards,
cutovers and vendor mutations stayed zero.

This was a protected Node diagnostic against real source services and production
D1, not scheduled Worker or upload acceptance. The original proof guards and the
deployed 25-record response bound were unchanged. One diagnostic clock-admission
SELECT required no explicit wait and observed D1 49 ms past proof creation; its
extra I/O delays minting, so the earlier clock-failure hypothesis remains unproved.
The evidence expires and must be refreshed before any future authorized write.

The prepared collector fix requests 25 records but accepts bounded timestamp
groups up to 100 per stream, with whole-page validation and unchanged proof/request
limits. Both collector changes later shipped in signed release `12f636b3`, whose
full release CI passes 1,338 tests. The 1,184-test checkpoint described here
predates that release.

The earlier 07:38:44 QRZ-only check observed absence without a source proof;
the 08:12:53 combined observation above closes that evidence gap for one sample.
The 06:55 candidate had a nearby record and remains unsuitable for absence-based
insertion. No historical association or precision hold was waived. All seven
export controls remain closed, and the owner's keep-disabled instruction applies.

The initial larger-page runs preserved the saved cursor and existing request
limits. Their variable page counts and D1 latency are recorded in the
[capacity measurements](docs/capacity-plan.md#bounded-100-record-baseline-follow-up-deployed-0609-utc).
Baseline completion does not establish sustained capacity, global purge retention
or permission to create cutovers.

At 04:51:11 UTC, current membership covered 218 operations and 1,425 QSO-stream
records, still in backfill with zero ready sources or eligible exports. QRZ had
36 complete and one pending partition, but no retained covering plan; the earlier
98-record cover expired at 04:00:56. Its ledger retained 3,435 ambiguous and 398
pending rows. Attempts, cutovers and temporary guards were zero. Partition expiry
can reduce counts without resolving a gap; the trial needs fresh coverage.
At approximately 04:58 UTC the one pending partition was an expired, empty base
manifest awaiting cleanup or rebuilding. The count of complete partitions was
not independently verified for freshness.

At 02:52:53 UTC, QRZ had 35 complete and five pending history partitions, with
the same single completed 98-record cover and zero target records. Its ledger
had 3,438 ambiguous and 395 pending rows, with zero attempts, cutovers or temporary
guards. These counts describe reconciliation evidence, not completed deliveries.

Completed throughput work includes batched intake and guarded reconciliation,
shared history across dates, indexed retries, independent background account/source
turns, precise diagnostics, the context/event index, and QRZ Unicode compatibility.
The first 21:29-release run processed **117 contact turns and 166 destination
classifications**, with no entity-decoding errors recorded. It still reached the
deadline, with twenty other errors, 86.934 seconds of database wait and 1.12 million
reported rows read. The local context-index fixture improves 4,003→3 rows, but
production scan attribution and sustained throughput remain unproven. The
[capacity plan](docs/capacity-plan.md) records measurements and acceptance targets.

The 100-account fixture proves background admission order, including restarts;
it does not prove full live/vendor fairness or 200,000-contact import capacity.
Timestamp/grid precision, routing and source-validity holds still require review.

## Remaining work before exports

The singleton, checked pairs C/D2/F4 and monitored window H now account for
**eleven QRZ ACKs accepted at known-ACK minute/sideband precision**. Actual
eleven-attempt/ten-artifact recovery and complete-window assessment pass. Exact
seconds remain unverified, and original literal-held summaries are preserved.
All thirteen QRZ records now pass observed-precision assessment and recovery.
QRZ is temporarily closed for independent observation and LoTW preparation;
LoTW acceptance remains pending.
Linking accounts or waiting for cron does not establish readiness for expansion.

Durable outbound claims, the ±30-minute historical matcher, nested valid grid
matching, full supported LoTW grid precision, per-contact source proofs, guarded
first-insert modes and original encrypted attempt-artifact retention are deployed.
Historical associations do not authorize edits or prove upstream absence. Keep
`SOURCE_BOUNDARY_VERIFIED=false`; source-wide replay and purge guarantees remain
unproved.
1. **Monitored QRZ window accepted.** Window H adds four normal-cron ACKs to
   the prior seven, with native absolute expiry, independent closure, complete
   attempt recovery and all-member readback/assessment. Keep inherited unfinished
   scheduler rows separate from completed window accounting. Use fresh normal
   proof/history checks for every later contact and verify retained artifacts
   and accepted records. Neither representation differences nor an unresolved
   `db_d1` category authorizes a retry or bypass.
2. **Preserve accepted automatic QRZ evidence.** Two activation-B cycles added
   two ACKs; thirteen total now pass observed-precision assessment and recovery.
   QRZ is temporarily closed for the separate LoTW phase, not a failed trial. Keep exact destination IDs, expand contacts
   gradually, and verify created records after each batch. First-insert authority
   does not enable replacements, corrections, deletion, source-wide cutovers or
   LoTW. Unrelated historical exceptions and 200,000-contact capacity do not block
   this restricted pilot. A second passkey remains recommended rather than an
   export gate; operator account recovery is documented.
3. **Accept LoTW separately after QRZ.** Obtain fresh complete three-day absence
   evidence for the station/worked-call pair, current certificate and revocation
   checks, actual personal-key
   signing and upload, then accepted-report readback and populated artifact
   recovery. An upload acknowledgement is submitted status, not accepted
   observation. Keep LoTW disabled until this separate process succeeds. Current
   raw historical-reference tables are empty; verify their populated recovery
   when such records exist.
4. **Finish reconciliation and review actual exceptions.** Preserve historical
   ownership and permanent upload blocks. Let normal inventory/retry work finish
   before treating stale or unprocessed holds as manual exceptions. Distinguish
   contradictory location/identity evidence from compatible reduced precision;
   neither incomplete comparison nor ambiguity is evidence of absence.
5. **Measure sustained capacity before promising larger service volume.** Record
   completed contacts, queue age, vendor fairness, D1 round trips and cost across
   repeated production runs. Local indexed-selection benchmarks and one or two
   successful exports do not prove 100-account daily volume or 200,000-contact
   imports. Durable continuations, inventory-triggered wakes and further
   amortization remain separate capacity work.

See the [personal acceptance checklist](docs/rollout-checklist.md) and
[restricted QRZ pilot evidence](docs/qrz-pilot.md) for the execution and recovery
record. Refresh expiring evidence before every external trial.

### Historical reconciliation and throughput checkpoints

The following measurements predate the current release checkpoints above. They
remain historical evidence, not current rollout status or sustained-capacity
acceptance.

The new throughput implementation reduces the measured intake/context database calls from 32→7, 33→9, 56→7 and 102→5 across the four local fixtures. Indexed selection returns 100 contacts using 200 rows read at both 4,000 and 200,000 contacts (7.68/7.63 ms locally). These validate database work bounds, not an end-to-end service rate. Read-only background processing uses batches of 20. The deployed mandatory-proof path can select up to six live contacts for shared evidence while dispatch remains sequential; background preparation shares two attempt slots. A source cohort has at most four actual source requests including the final drain. Complete witnessed subsets can proceed, and prior budget holds receive a later singleton turn. An unsuccessful budget-limited singleton receives an exact-version ten-minute delay, yielding to neighbors on the ordinary five-minute schedule; a single dependency closure requiring more than three collection reads remains held. The scheduler still yields at a 90-second or 850-D1-call soft budget. See the [implementation status and measurements](docs/reconciliation-investigation.md#implementation-status).

The previous release at 15:04:09 UTC contains signed commits `32758f5` (general-log station projection and scoped retry migration), `789d652` (precision-specific review holds), and `fa822ba` (cleanup query scaling). Local checks passed 391 tests plus 35 focused tests after the final diagnostic refinement. All 392 tests and required checks passed in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39974178346), and revision `cf34ac0` was deployed with all gates closed. Those release results predate the throughput release. The new release `bbc2346c` passed all 452 tests and required checks in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39983716440) and deployed at 16:12 UTC as Worker `c592733f-171f-406e-bb8d-827b7ffd7fd9`; all gates remain closed.

The first run after that previous release, at 15:05:50 UTC, completed in 96,730 ms versus 132,572 ms for the preceding run, with zero errors and deferrals. It still examined only two contacts. The 15:08:05 snapshot recorded 1,820 ready, 2,314 held and zero blocked, with the callsign input requeued and the new precision diagnoses appearing as review holds. Attempts and cutovers remained zero. This is the production baseline before batching and shared inventory, not their measured result.

The 2026-10-23 follow-up found 10 QRZ ambiguities and eight current LoTW grid mismatches. Three QRZ samples had a single otherwise matching identity with minute-only time; two LoTW samples had the matching six-character prefix of an eight-character source grid. These samples identify compatibility patterns, not proof for every held record. The general-log station field is present as canonical `our.call`; deployed correction `32758f5` fixes that parser compatibility defect without a user edit. Four other contacts use stations outside the personal routes and one uses a test suffix; cron cannot invent appropriate destination coverage. Exact contact details remain outside repository documentation.

The five runs from 14:05 through 14:25 UTC examined two contacts each in 128.8–140.7 seconds. Context rereads progressed to 134 of 176 by 14:38, with both rescans unfinished. The [capacity investigation](docs/reconciliation-investigation.md) separates contact turns from unique completed classifications, records the seven-day source-payload retention risk, and prioritizes a measured cleanup defect, batched database access, stable exception scheduling and shared inventory. Exports remain disabled throughout this work.

The initial repair `1679f749` passed 371 tests in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39963134190). All 12 retained contacts sampled from generic reconciliation failures projected successfully and contained nonzero milliseconds; strict outbound ADIF conversion rejected them before vendor reads. Read-only conversion now follows PoLo/HaLo whole-second truncation while preserving raw timestamps and fingerprints. At that checkpoint fractional-timestamp writes were blocked with `subsecond_export_requires_identity_claim`; the later durable-claim implementation replaces that blanket restriction while retaining all rollout gates. Renewed LoFi bearer persistence and scheduler error classification are also repaired; the persistence defect's contribution to the earlier backlog remains unconfirmed. Independent D1 metadata at 13:41:45 UTC verified fourteen migrations, zero attempts and zero cutovers.

Post-deployment observation found historical reads consuming a scheduler turn before contact processing and known context holds being selected ahead of available work. The scheduling follow-up keeps canonical sync first, processes a retained background contact before historical rescan/reread work, and prefers available base context without relaxing complete-context or export checks. In a read-only pre-deployment experiment, available base contexts among the first ten selections improved from two to ten, with zero writes. All 377 tests and required checks passed locally and in [CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39965786804). The 14:00:46 UTC production run completed in 132,058 ms with one source page, one contact processing turn, zero errors and zero deferrals. This confirms limited recovery for one run, not a sustained draining rate.

The 14:04:02 UTC snapshot still has 4,134 source contacts and 264 old generic readback-reason rows per destination awaiting revisit, plus a prior QRZ retry-error row. Actual vendor reads now produce actionable diagnostics: QRZ has no unique exact identity matching its time precision/mode evidence, and LoTW reports a differing or absent `MY_GRIDSQUARE`. Review these outcomes before treating history as adopted or absent. Fourteen migrations, zero attempts and zero cutovers remain verified.

Adoption collision quarantine is implemented and tested: when two source contacts claim the same remote identity, both an untransmitted adopted owner and the contender become `history_ambiguous`, the existing reservation remains, and a later edit cannot auto-export either contact. That quarantine change alone did not make fractional-timestamp writes eligible; the later guarded outbound-claim path supplies the missing ownership protection.

The [workload investigation](docs/admin-workload-investigation.md) separates readback defects from source dependencies. At 13:23 UTC, read-only classification found 1,423 ready-for-processing records, 2,704 held for operation context, five held for routing, one held for history review and one blocked by callsign validation. Context rereads share the existing LoFi allowance of four background requests per five minutes; more elapsed time or a completed operation-list scan does not mean every operation's contacts/events have been read. Those time-specific counts do not authorize uploads or establish a completion estimate.

See [current progress](PROGRESS.md) for the resumable checkpoint and the [rollout checklist](docs/rollout-checklist.md) for the evidence and authorization required to open the gates.

## Delivery order

| Milestone                       | Depends on                               | Result                                                           |
| ------------------------------- | ---------------------------------------- | ---------------------------------------------------------------- |
| 0. Protocol/runtime spikes      | None                                     | Evidence for source, destination, signing, and passkey contracts |
| 1. Worker and durable state     | Enough spike evidence to fix boundaries  | Tenant-scoped storage, encryption, leases, fixture harness       |
| 2. Accounts and connections     | 1; relevant authentication/import spikes | Email-confirmed passkey signup and verified service connections  |
| 3. Source intake and projection | 1; LoFi spike                            | Correct, resumable contact/operation changes and station context |
| 4. Historical adoption          | 2–3; destination readback spikes         | Existing history linked without remote writes                    |
| 5. Live QRZ delivery            | 4; QRZ mutation spike                    | Delayed automatic insert/correction and forward-only templates   |
| 6. Live LoTW delivery           | 4; signing/query spikes                  | Worker-signed uploads with honest acceptance status              |
| 7. Personal rollout and handoff | 5–6                                      | Small production deployment with documented recovery and cost    |

Milestone 0's investigations can run independently. QRZ and LoTW delivery can be implemented in parallel once their shared ledger and bootstrap contracts are stable. A destination outage must not become a dependency for the other destination's ongoing operation.

## 0. Prove the uncertain contracts

### 0A. LoFi changes, pagination, and effective context

- [x] Adapt the known [qso-sidecar](https://github.com/rwjblue/qso-sidecar/blob/c502cecd068a6a4330afd94458e5636fa17f3a51/src/lofi.rs) and [HaLo LoFi](https://github.com/ham2k/halo/blob/299564ccc433a42f4093c415420559288253cbf6/extensions/sync/ham2k-lofi/src/index.ts) protocol behavior into a small typed client/spike. Do not copy Sidecar's contest assumptions.
- [x] Implement `/v1/sync` from the inspected client contract, independent operation/QSO checkpoints, explicit page completion and same-identity permission renewal. Record bounded live cursor/resumption and operation-read evidence.
- [ ] Establish exhaustive historical-edit/tombstone replay and cursor-retention/expiration guarantees. Treat a snapshot/replay boundary as unproven until demonstrated.
- [x] Fixture-test null-operation general-log contacts and bounded encrypted buffering when current context is available.
- [ ] Verify live null-operation behavior and whether selective reread is available; retain visible recovery exceptions when buffered data expires.
- [x] Capture synthetic fixtures for operation and segment corrections, same-time boundaries, own/worked POTA refs, multiple station callsigns, explicit clearing values, and raw frequency units.

**Acceptance:** a paged import and later catch-up do not lose or duplicate work after restart; changing only an operation's location causes affected QSO projections to change. Record unsupported recovery semantics explicitly instead of substituting device timestamps for a server cursor.

### 0B. QRZ readback and mutation semantics

- [x] Implement and fixture-test response/ADIF parsing, pagination, empty/error responses, book identity, and required subscription checks using the [API contract](https://www.qrz.com/docs/logbook/QRZLogbookAPI.html).
- [ ] Prove how `INSERT`, duplicate rejection, `OPTION=REPLACE`, returned LOGIDs, confirmed records, time precision, and portable-location fields behave. Distinguish documented behavior from observed behavior.
- [x] Fixture-test preservation of narrative and writable remote-owned fields during a structured correction, and bounded identity/collision searches. Live field-preservation evidence remains in the mutation check above.
- [x] Implement uncertain-response reconciliation against the exact transmitted projection and specify provenance requirements for old-identity cleanup. No guessed update-by-LOGID primitive.
- [ ] Prove the narrow cleanup contract for a Ferry-created old identity before exposing automatic deletion; retained identities remain visible in the meantime.

**Acceptance:** fixtures distinguish missing, ambiguous, rejected, replaced, and possibly accepted requests; existing text survives the intended update. Any live mutation experiment uses a deliberately designated test logbook/contact and separate authorization, never the owner's existing history by default.

### 0C. Direct LoTW signing and readback

- [x] Build an isolated Worker signing spike with generated keys and representative PKCS#12 fixtures. Compare against [Wavelog's direct signer](https://github.com/wavelog/wavelog/blob/7f8eef4de94c674f73c6859ed4e0b0247f68dcd9/application/controllers/Lotw.php) and native TQSL/reference output where useful.
- [x] Verify key import, legacy/current PKCS#12 encryption, certificate/key matching, callsign/DXCC/QSO-date authorization, canonical station/contact fields, RSA signature bytes, gzip, and multipart encoding.
- [x] Record Worker bundle/startup observations and exercise cryptographic primitives with generated fixtures in actual local workerd.
- [x] Record aggregate Cloudflare CPU, sampled isolate memory and resource-limit outcomes for a representative mixed cohort of synthetic certificate imports and 1/10/100-contact signing batches. The 2026-10-25 exact-Worker cohort accounts for all 27 successful requests; per-case attribution is unavailable and its parser remains incomplete. See [cloud evidence](docs/evidence-signing.md#aggregate-resource-observations). Sampled memory is not a per-request peak.
- [ ] Prove a real Worker-signed artifact through separately authorized scoped ARRL upload and exact readback. Synthetic resource measurements and published algorithm support do not establish acceptance.
- [x] Exercise [LoTW query parsing](https://lotw.arrl.org/lotw-help/developer-query-qsos-qsls/) with accepted unconfirmed records, own station detail, error HTML, date partitions, and receive-time checkpoints. Distinguish submission acknowledgement from observed processing and QSL confirmation.

**Acceptance:** reproducible synthetic vectors and runtime measurements are checked in without personal keys or logs. Document what still needs a deliberately scoped live ARRL acceptance check. A separate signer host is not the default fallback; report an actual blocker before revising the agreed architecture.

### 0D. Passkeys in Workers and mobile browsers

- [x] Pin reviewed SimpleWebAuthn releases and demonstrate registration/authentication in the Worker runtime with the fixed RP/origin model in [authentication](docs/authentication.md).
- [ ] Exercise discoverable credentials, required user verification, synced passkeys, a backup security key, and the explicit sign-in button. Conditional autofill is progressive enhancement.

**Acceptance:** wrong challenge/origin/RP/user handle, missing UV, replay, and concurrent consumption fail correctly. No OAuth, password, email-login, or email-reset alternative is introduced.

## 1. Establish the Worker and durable state

- [x] Create the minimal TypeScript/Workers project, package scripts, D1 migrations, environment configuration, and test harness. Document local setup and keep preview/prod bindings separate.
- [x] Implement tenant-scoped records for accounts, linked source accounts, stable logical destinations, encrypted credential versions, cursors, ledger rows, template versions, bootstrap partitions, and outbox attempts.
- [x] Keep source baseline, remote observation, transmitted projection hash, creation provenance, narrative policy, and receipt state distinct. Enforce uniqueness across tenant/source/destination identities.
- [x] Implement the [envelope format](docs/security.md), KEK-version rotation, credential revocation, and logging redaction.
- [x] Implement atomic cursor/work checkpoints, guarded job claims, lease fencing, retry scheduling, and immutable uncertain attempts. Choose bounded retention defaults with explicit expiry behavior.

**Acceptance:** crash/restart and overlapping cron invocations cannot skip source work, change an in-flight payload, or issue work for another tenant. A database export has no plaintext private credentials or pending payloads. Rotation and restore preserve mappings and revoked states.

## 2. Add accounts and service connections

- [x] Implement email signup proof, first passkey enrollment, passkey-only login, sessions, additional keys, revocation, and email change exactly as [specified](docs/authentication.md). Production uses native Cloudflare email and `ferry.n1rwj.com` as its fixed RP; the owner has enrolled.
- [x] Make second-passkey/synced-provider recovery guidance visible; losing every usable passkey has no automatic v1 reset path.
- [x] Link a LoFi account through its existing approval flow. Verify account ownership and show which source account is connected.
- [x] Link QRZ book keys and validate station callsign/date routing. Link LoTW signing material and optional query credentials, keeping their purposes separate.
- [x] Require recent passkey verification for sensitive connection changes. Reconnecting or renewing a credential preserves the stable logical destination; a genuinely different account/book does not inherit mappings.

**Acceptance:** the same email confirmation cannot sign into or replace credentials on an existing account. A second tenant cannot reference another tenant's connections or passkeys. No contact export occurs merely because credentials were saved; initial reconciliation determines historical eligibility.

## 3. Build resumable source intake and projection

- [x] Implement separate operation/QSO progress and atomic page checkpoints; recover expired/gapped cursors through reconciliation.
- [x] Normalize contact identity, tombstones, timestamp precision, frequency, band/mode, station callsign, and effective location. Retain event context needed for segments while excluding event rows from exports.
- [x] Coalesce destination-relevant changes per contact. Set the default quiet period to 30 minutes and poll every five minutes; expose a 20–60-minute setting.
- [x] Preserve temporary source/context data only where necessary for delayed delivery or reread limitations. An operation edit can trigger a bounded reread; a template edit cannot.
- [x] Batch source-page metadata/checkpoint access and share operation/event ciphertext reads within a bounded contact batch; validate atomic rollback and complete projection locally.
- [x] Implement immutable short-lived source proofs, mandatory staging/dispatch pins and post-admission validation. The release is deployed with 1,131 tests passing. Production baseline/handoff is complete; the 08:12 diagnostic minted a current proof and verified same-contact QRZ absence. Scheduled Worker validation and scoped vendor write acceptance remain outstanding.
- [x] Separate default-off QRZ first-insert authority from global source-boundary effects, with immutable mode pins, structural history guards and final exact-request validation. Deployed with all seven controls closed; live acceptance remains outstanding.
- [x] Verify bounded 100-record canonical baseline pages in production, including saved-cursor continuation and completed baseline/drain/quarantine handoff. Noncanonical and handoff page sizes remain unchanged.
- [ ] Measure sustained source throughput and reduce redundant passes where the source contract permits; baseline completion is not capacity acceptance.

**Acceptance:** ongoing logging does not postpone earlier stable contacts. Offline arrivals and old-contact corrections work. Location/park changes at segment boundaries affect the correct contacts; changes to unsupported LoTW narrative fields create no LoTW work.

## 4. Adopt existing history without rewriting it

- [x] Implement [bootstrap states and matching](docs/bootstrap.md) separately for QRZ and LoTW. Inventory accepted unconfirmed contacts as well as confirmed ones.
- [x] Match conservatively by verified identity and operational context. Preserve timestamp precision; isolate collisions, missing location evidence, and unsupported mode mappings.
- [x] Adopt unique existing records with a captured source baseline and remote observation, without a fabricated delivery receipt. Preserve trusted Ferry mappings on reconnect and QRZ remote narrative on first adoption.
- [x] Establish source intake before scanning, catch up races, and recheck absence before first backfill. Use bounded encrypted temporary partitions and remove them after durable progress.
- [x] Without LoTW read access, leave prior history unverified and permit only live records proven new after the source cutover. Expose incomplete coverage rather than treating it as absence.
- [x] Match read-only historical identities at the same whole-second precision as PoLo/HaLo while preserving raw source milliseconds and fingerprints. Keep outbound preparation stricter than historical lookup.
- [x] Implement and test adoption collision quarantine for both the untransmitted adopted owner and contender, preserving the identity reservation and blocking later edit exports.
- [x] Implement and deploy the QRZ ±30-minute/minute-precision association path with opaque source indexing, bounded reverse comparison, book-scoped LOGID ownership and permanent association-only stage/dispatch restrictions. Release `6ff685a7` passed all 1,429 tests and required checks; exact receipt verification remains unchanged.
- [x] Verify the deployed `0033`/`0034` migration, complete 4,141-row retained index, 39 live QRZ associations with permanent ownership/write blocks and zero export attempts. The postdeployment isolated restore preserves the validated tenant key, ownership/association markers and every predeployment exact claim through repeated quarantine. Full history reconciliation and sustained capacity remain open.
- [x] Extend LoTW retained time coverage across UTC day/week boundaries and deploy inclusive ±30-minute historical matching with reverse-source uniqueness, retained raw precision, durable ownership and permanent historical-upload blocks in `5a427a30`. Exact receipt verification remains separate.
- [x] Complete and verify production LoTW ownership bootstrap coverage: the `f2c41cb3` checkpoint covers all 9,981 inputs with no pending/held inputs or unhashed owners, and all 3,327 exact copies pass populated recovery. This grants no export authority.
- [ ] Distinguish resolved historical associations from actual remaining exceptions after current reconciliation. Verify populated raw-reference recovery after associations begin.
- [x] Implement indexed due-work selection and versioned destination checks. Stable review holds retry after 24 hours and incomplete reconciliation checks after five minutes; ambiguous-empty QRZ partitions share a separate fifteen-minute read cooldown. Relevant source/context/route/credential/policy changes invalidate the affected checks. Retention-only refreshes preserve holds.
- [x] Implement shared encrypted four-hour history partitions with QRZ base/catch-up paging, LoTW date-range splitting, scoped/fenced commits and bounded local candidate lookup. Cached absence does not authorize export; a fresh targeted prewrite check remains required.
- [ ] Wake previously held contacts when their relevant inventory completes; the current timed retry backstops remain in place. Add durable queue continuations and prove fair, resumable end-to-end capacity at 4,000 and 200,000 contacts.
- [x] Implement durable outbound identity claims for contacts whose distinct source timestamps truncate to the same destination second, for both QRZ and LoTW. Atomic claims cover adoption, preparation and dispatch and survive uncertainty, cancellation, source edits and payload expiry. Fractional projection is available only through the guarded attempt path; source completeness and all export gates still apply.
- [x] Preserve supported eight-character station grids in LoTW signing without truncation, with pinned released TQSL evidence and an independent fixed signature vector. Live ARRL acceptance remains open.

**Acceptance:** a representative source log already uploaded to both services produces zero INSERT, REPLACE, DELETE, or signing operations during adoption and unchanged subsequent polls. A contact absent at just one destination queues only there. Failed/partial inventories never authorize backfill. Two source UUIDs cannot silently adopt one remote record.

## 5. Deliver to QRZ and support forward-only templates

- [x] Implement and fixture-test insert/correction with stable book routing, response mapping, fetch/merge preservation and uncertain-result reconciliation. Replacement remains gated on the live contract in milestone 0B.
- [x] Reuse the appropriately licensed HaLo Liquid SDK/helpers or compatible bounded implementation. Preserve notices and avoid importing the separately licensed full exporter without an explicit licensing decision.
- [x] Implement immutable version creation and first-staged-export binding from [templates](docs/templates.md). Keep unbound, template-bound, and remote-preserved policies distinct.
- [x] Include a POTA example using the operator's activated park; enforce resource and length-correct ADIF serialization limits.
- [x] Handle changed identities with durable old/new identity evidence while retaining prior remote records visibly. Source deletions cancel unsent work and record retained remote state.
- [ ] Enable narrow provenance-checked cleanup only after its live contract is proven. Adopted old identities remain intact.

**Acceptance:** changing a template generates no historical scan, invalidation, hash recomputation, or job. In-flight requests and retries keep their pinned version. An actual later source change uses current data with that version. Adopted text survives structured corrections; note-only source edits do not take ownership. Lost responses do not cause blind inserts or deletes.

## 6. Deliver signed contacts to LoTW

- [x] Deploy separate default-off first-insert authority, complete three-day absence checks before signing and dispatch, immutable mode/proof pins and exact final upload validation. All eight production controls remain closed; actual upload/readback acceptance remains open.

- [x] Integrate the proven Worker signer, versioned field/configuration tables, certificate selection, and per-location grouping.
- [x] Persist immutable encrypted signed batches with exact member UUIDs, source generations, and certificate/configuration versions until their outcomes resolve. Commit membership and member attempt states together. One-contact artifacts are acceptable initially; bound batch work and isolate invalid records without resubmitting unrelated history.
- [x] Implement acknowledgement, observed acceptance, retry, and optional confirmation tracking as separate states. Reconcile via readback when configured.
- [x] Apply supported nonidentity corrections and report identity corrections that leave the prior record at LoTW. Surface certificate/award/location restrictions precisely.

**Acceptance:** mixed callsigns/locations use the proper certificate and station data; source-note/template-only changes produce no LoTW submission. An ambiguous timeout is reconciled. A submitted batch is not displayed as per-QSO accepted solely because its upload was acknowledged. Production compatibility claims require actual scoped acceptance evidence.

## 7. Roll out personally and document operations

- [x] Add a compact mobile-friendly dashboard for connection health, history adoption, pending work, submitted/observed states, and exceptions. No manual operation-release step.
- [ ] Complete review of the owner's read-only reconciliation results and relevant exceptions for broader rollout. The restricted QRZ singleton uses its own exact candidate, proof, ownership and absence checks; unrelated historical holds remain held.
- [x] Accept one specifically authorized QRZ INSERT with populated recovery, known-ACK readback at returned minute precision and a complete unique neighborhood. All other transmitted fields match literally; seconds remain unverified.
- [x] Deploy original encrypted artifact retention through normal delivery cleanup, preserving original AAD/expiry and native populated restore/quarantine checks. Production schema37 recovery preserves the earlier host-packet singleton and four populated table artifacts from Trials C/D2.
- [x] Correct finite-scope scheduling and verify that both authorized contacts are reached in a real scheduled trial. Trial B held both before preparation; this is selection evidence only.
- [x] Accept checked pairs C/D2 through populated five-attempt recovery, unique complete neighborhoods and separate known-ACK minute/sideband assessments. Literal differences and unverified seconds remain recorded.
- [ ] Validate further checked QRZ batches before automatic scope. LoTW needs separate signing and accepted upload/readback evidence before its own activation. Record each deployed revision and contract evidence.
- [x] Document deployment, certificate renewal, key rotation, passkey management, source cursor gaps, uncertain requests, backup restore, disabling connections, retention, and vendor throttling.
- [ ] Measure representative monthly Worker/D1/email usage; document actual cost and tune batching/polling without weakening correctness.
- [x] Verify a second isolated tenant with synthetic fixtures before enabling additional people.
- [x] Record scheduler stage durations, D1 RPC/SQL counts, classified destinations and inventory fetch/cache use; add reproducible local 4,000/200,000-contact indexed-selection measurements.
- [x] Deploy the throughput implementation with every export gate closed and verify the deployed settings, health, assets and zero export attempts.
- [ ] Verify sustained production drain rate, context progress, live fairness, retry behavior and resource use. Local selection and 20-contact integration fixtures do not establish the proposed capacity targets.

**Acceptance:** ordinary PoLo/HaLo logging reaches both configured destinations after settling without additional user actions. Existing history and comments remain intact. Failed jobs remain visible and retry safely; revocation stops new work. Operational instructions and measured limitations let another local agent continue without reconstructing this conversation.

## Decisions to record during implementation

Keep unresolved items attached to their milestone: verified LoFi replay boundaries and null-operation rereads; QRZ replacement/collision and field-preservation semantics; deployed signing measurements and ARRL acceptance; LoTW station/mode configuration provenance; measured retention/batch capacity and cost. The native email provider, production hostname and initial one-contact LoTW artifact size are selected. These are implementation evidence requirements, not reasons to reopen the settled live-sync, forward-only-template, passkey-login, minimal-storage, or hosted-signer product choices.

## Historical acceptance checkpoint (2026-10-23)

Core service paths across all eight areas have executable code, fixtures and
actual workerd/D1 coverage. Durable outbound identity claims for fractional
timestamps and lossless eight-character LoTW grids are implemented and tested. The
dashboard has been exercised in Chromium at desktop and 390px mobile widths with
a virtual passkey. Production exports remain disabled. No live INSERT, REPLACE,
DELETE or LoTW upload occurred.

The historical shared-history cohort release `bca137b1a38ceb7ab0601e1db53136d69cce9c9c`
(application code `b23e563a4104bd16b8bb9ce0cd6d356ddfad9d3f`) deployed as Worker
`1f481a97-7e78-443a-a180-ea488822f78b` at `2026-10-23T19:45:29.359227Z`.
All 512 tests and required checks passed locally; [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40013802909)
passed all 512 tests and required checks. At that checkpoint, live version and health checks confirmed 100% traffic and all five
gates closed. The 19:45:46 UTC D1 snapshot recorded nineteen migrations, zero
attempts, zero cutovers and no temporary guard residue. The first new run,
19:45:43–19:47:15 UTC, processed 80 contact turns and 121 destination
classifications in 92.209 seconds, including five adoptions, 39 errors and three
deferrals. It used 384 RPCs (4.8 per turn), compared with 862 RPCs for 40 turns
in the preceding run. This is one mixed-work observation, not unique completion
counts or sustained capacity. It recorded 121 inventory cache hits and zero
successful inventory advances; that counter does not exclude failed vendor requests.
Earlier source-lane fairness runs processed 23 and 15 contact turns while
advancing context; they remain evidence for that earlier release. Owner
enrollment and LoFi/QRZ/LoTW linking are complete. Sustained production progress,
complete inventory/source capacity, precision policy and owner-history acceptance
remain outstanding.
No 200,000-contact SLA has been demonstrated.
See [deployment evidence](docs/deployment.md).

Milestone 0 has bounded live read evidence for all three vendors, local signing
vectors and Worker HTTP passkey evidence. Exhaustive source UUID/tombstone replay,
QRZ mutation behavior, ARRL signed acceptance, physical/synced passkeys and
production runtime measurements remain unproved. Milestones 4–6 implement the
conservative gates; their live acceptance depends on that evidence. Prior QRZ
identities remain retained until the narrow cleanup contract is live-proven.

Milestone 7 has a reproducible local demo, dashboard and operational runbooks.
Production is now deployed read-only. Complete owner-history review, scoped first
writes and measured monthly cost remain outstanding under the exact inputs in the
[rollout checklist](docs/rollout-checklist.md). The implementation does not replace
those checks with mock success. See [PROGRESS.md](PROGRESS.md) for the current
resumable checkpoint.

## Implementation checkpoints

- 2026-10-22: Worker/D1 foundation implemented with AES-GCM envelope storage,
  immutable template/attempt records, atomic cursor batches and fenced leases.
  Focused tests execute against actual local D1/workerd and cover stale cursors,
  overlapping claims, tenant boundaries, encryption rotation and crash recovery.
  Adapter and account integration remain in progress. Production exports remain
  disabled. See [PROGRESS.md](PROGRESS.md) for the resumable work log.

- 2026-10-22: Typed read-only LoFi sync and per-contact projection implemented;
  17 fixtures cover restart cursor state, paging failures, segment boundaries,
  explicit clears, tombstones, kHz/MHz and location-only invalidation. Public
  client behavior is verified against pinned primary sources. Server snapshot,
  retention and cutover guarantees remain live-verification blockers. See
  [LoFi evidence](docs/evidence-lofi.md).

- 2026-10-22: QRZ adapter, bounded ADIF and `ferry-liquid-v1` template profile
  implemented. Twenty focused checks cover pagination, exact matching, narrative
  preservation, uncertain responses, resource budgets and forward rendering.
  Replacement remains gated by scoped live evidence. See [QRZ evidence](docs/evidence-qrz.md).

- 2026-10-22: Direct Worker signing imports legacy/current synthetic PKCS#12,
  validates strict platform certificate signatures, matches independent OpenSSL
  RSA/SHA-1 vectors and emits gzip TQ8. LoTW adapters separate queue submission,
  exact observed revision and QSL metadata. Fourteen signing/query tests plus
  actual workerd experiment pass. Billed CPU/memory and scoped ARRL acceptance
  remain unverified. See [signing evidence](docs/evidence-signing.md).

- 2026-10-22: Email-confirmed passkey accounts implemented with browser-bound
  codes, atomic single-use ceremonies, required UV, fixed RP/origin, session/key
  revocation, fresh verification and no last-key removal or inbox reset. Synthetic
  ES256 cryptography passes in Node and real Worker HTTP endpoints, including two
  isolated tenants. Native Chromium signup/signin/reauth also exercised with a
  virtual authenticator. Physical/synced-provider matrix and real email delivery
  remain rollout checks. See [auth evidence](docs/evidence-auth.md).

- 2026-10-22: Bounded live read-only probes verified LoFi same-identity renewal,
  account access, cursor issuance/empty-incomplete resumption and an operation
  page; QRZ metadata and raw ADIF readback; and LoTW accepted/unconfirmed readback.
  Corrected observed protocol differences with synthetic regression fixtures.
  These reads do not prove snapshot/retention guarantees or mutation acceptance.
  See [live read evidence](docs/evidence-live-readonly.md) and [LoFi evidence](docs/evidence-lofi.md).

- 2026-10-22: Integrated source intake, per-destination history reconciliation,
  cutover evidence, immutable delivery artifacts, crash/uncertainty handling,
  confirmation tracking, encrypted maintenance/restore quarantine and the mobile
  dashboard. Actual local Worker HTTP and synthetic scheduler flows pass; all
  production gates remain closed. See [local setup](docs/local-development.md),
  [operations](docs/operations.md) and [rollout inputs](docs/rollout-checklist.md).

Initial local acceptance checkpoint (historical): `mise run check` passes formatting, recommended
lint with warnings treated as errors, server/browser TypeScript, all **146 tests**
and the **1,534.84 KiB raw / 290.24 KiB gzip** Worker build. `mise run demo`
passes **24 tests**. Workerd signing and D1 fixtures use the application's
2026-10-22 compatibility date. Final review fixed expiry pagination, cross-tenant
scheduler fairness, durable prior LoTW identities across dispatch crashes and
stale confirmation inheritance. Startup profiling passed locally; these are not
deployed resource or live acceptance measurements.

## Read-only production deployment (2026-10-22)

Deployed `f9856fdefa47` to [ferry.n1rwj.com](https://ferry.n1rwj.com) in the existing
Cloudflare account, with a dedicated migrated D1, independent protected secrets,
a native sender allowlist and disabled email-content previews. All vendor export
gates remain closed. Production health, session/passkey options, mailbox denial,
mobile rendering and actual signup-email delivery pass; no production account,
connection, ledger row or attempt was created. The updated full check passes
**149 tests**, and [CI passes](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39880597020).
See [deployment evidence](docs/deployment.md) for the version and safe redeploy path.
Owner enrollment, history review, source-boundary proof and scoped live-write
contracts remain distinct acceptance checks.

## Invite-only onboarding and independent settings (2026-10-22)

- [x] Save account template defaults and quiet periods without any service; use the requested reference-labels/contact-notes COMMENT default and preserve immutable prior versions.
- [x] Add branded HTML/plain-text mail, six-digit code hints, focus and paste support; retain the explicit device/mail-client autofill verification boundary.
- [x] Enforce hosted invite-only enrollment in the server and UI; add the operator `mise run invite` task with seven-day exact-email grants and atomic claim guards.
- [x] Exercise actual hosted Worker HTTP invitation/passkey flow and actual local Wrangler/Chromium signup, zero-connection saves, reload, sign-out/sign-in and mobile rendering.
- [x] Complete all 168 tests/types/lint/format/build checks, fix vendor-adapter runtime defects found by global-fetch experiments, and redeploy/read back every export gate closed.

The initial read-only deployment evidence above is historical. Existing users keep their passkeys and sessions; invitations do not reset accounts. No live invitations were sent during implementation. See [authentication](docs/authentication.md) and [operations](docs/operations.md).

Deployed follow-up revision `58a965d7c54d`, Worker version `0bf32d19-13c7-43da-b179-702ab49ad3d6`; six migrations applied. Live invite-only/join/gate checks and [deployed-code CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39884975858) pass. Branded mail/client autofill remains a separate device check; no real invites or vendor log writes were sent.

## Connection passkey freshness follow-up

The LoFi approval form now obtains a fresh passkey assertion automatically when needed, with preserved input and no connection request on cancellation. Auth/CSRF failures are distinct from scrubbed vendor errors; only a known pre-dispatch freshness failure can retry once. Concurrent session/account-switch and passkey-ceremony boundaries have focused coverage. Actual local Worker/Chromium tests exercise real signatures and contained vendor requests. All 180 tests, formatting, strict lint, types and the Worker build passed for this historical release. Deployed `cbe9e63af1bf` as Worker `6a580035-ad08-4e35-9fa5-5d09fe5f9baf`; live asset/origin-error/closed-gate checks passed. The owner has since completed the actual passkey and vendor approval. See [progress](PROGRESS.md).

## Read-only source review and connection controls

- [x] Explain vendor-provided LoFi account names; use friendly service/status labels and one current optional connection of each kind. Preserve existing extra/removed connection history and same-identity renewals.
- [x] Enforce new-connection policy before vendor requests and atomically during credential saves; safely replace pending LoFi approvals and resume paused connections without promoting unverified LoTW credentials.
- [x] Show source counts at the top, separate destination activity counts, initial scan/context progress, last successful page, retained contact samples and effective station/location/reference/current-comment previews.
- [x] Keep review reads tenant scoped, bounded and free of vendor calls or database mutation; explicitly preserve adopted narrative and pinned template policy. No preview can prepare, sign or export a contact.
- [x] Skip operation tombstones, fairly rotate failed/partial context reads and fence stale failure diagnostics. Preserve coverage and retry evidence.
- [x] Pass full formatting/lint/types/build and all **196 tests**, including real D1 race/retention/no-mutation checks. Actual isolated Worker/Chromium passkey signup/link/pause/resume/review confirms the expected comment, duplicate rejection, preserved unsaved edits, mobile375px without overflow, and zero attempts/outbox/vendor exports.

At this historical checkpoint the owner had completed real LoFi linking. Aggregate live metadata confirmed initial source ingestion; no destination was connected at that check, so an empty delivery ledger was expected. The dashboard provides useful source review independently. Both destinations have since been connected; current backlog and rollout status are recorded above and in [progress](PROGRESS.md). All live-write and exhaustive source-boundary acceptance checks remain separate.
