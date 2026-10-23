# Read-only production deployment

Verified 2026-10-23 UTC at [https://ferry.n1rwj.com](https://ferry.n1rwj.com). The owner selected this permanent hostname. Vendor exports remain disabled; no real logbook entries were changed. The resource summary reflects the latest deployment; the follow-up sections retain earlier evidence.

| Resource                 | Current value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare account       | `478f5e15ae2afa01364d19f42a3e06f2` (existing account)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Worker                   | `lofi-qso-ferry`, environment `production`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Deployed source revision | `cec488febcad419ff55a4aa677619a1aef61fcd5`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Worker version           | `3c1f615e-bf2d-403f-9d54-1aed519da582`, created `2026-10-23T21:29:17.720637Z`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Deployment               | `55df0cef-37db-4a20-9b10-4ed7f49d2640`, `2026-10-23T21:29:18.881251Z`, 100% of traffic                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Origin / passkey RP      | `https://ferry.n1rwj.com` / `ferry.n1rwj.com`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Dedicated D1             | `ferry-production`, `45ad64ad-92bb-491a-b6e6-1d2b17450144`, ENAM                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Migrations               | `0001_foundation`, `0002_auth`, `0004_intake`, `0005_cutover`, `0006_account_templates`, `0007_invitations`, `0008_connection_policy`, `0009_vendor_requests`, `0010_source_priority`, `0011_admin_metrics`, `0012_admin_invitations`, `0013_lotw_trust`, `0014_retire_lotw_trust`, `0015_admin_workload`, `0016_reproject_general_log_station`, `0017_history_inventory`, `0018_reconciliation_work`, `0019_scheduler_throughput`, `0020_test_operation_review`, `0021_scheduler_admission`, `0022_source_context_members`; all 21 independently verified at `2026-10-23T21:29:44.834Z` |
| Sender                   | Native Cloudflare `EMAIL`, restricted to `signup@ferry.n1rwj.com`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Sending domain           | `ferry.n1rwj.com`, tag `e69af8ef82a140b38eeaef98d417ef30`, content previews disabled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Schedule                 | `*/5 * * * *`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Alternate origins        | workers.dev and version previews disabled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Artifact                 | 1,778.02 KiB raw / 343.73 KiB gzip; reported startup 31 ms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

The existing account and native email pattern were reused. Ferry has its own database and secrets; unrelated Worker databases were not modified. Sending DNS is isolated to the new subdomain and its bounce/authentication records; existing `n1rwj.com` Fastmail MX records were checked unchanged. No subscription or billing-plan changes were made. The account Email Sending API reported an existing quota of 200 messages/day; this deployment did not change that limit.

## Gate verification

Read back from the deployed Worker settings, independently of the local configuration:

```text
EXPORTS_ENABLED=false
ROLLOUT_CHECKS_PASSED=false
SOURCE_BOUNDARY_VERIFIED=false
LIVE_WRITE_AUTHORIZATION=
ROLLOUT_QSO_IDS_JSON=[]
```

[Health](https://ferry.n1rwj.com/health) returns `{"status":"ok","exportsEnabled":false}`. No authorized UUID scope exists. The scheduled service can poll and adopt configured history after the owner connects accounts; it cannot sign, insert, replace, delete or upload contacts with these gates closed. Signup email and LoFi approval/client renewal are separate provider interactions.

## Live checks

- HTTPS UI and static assets load in Chromium with no console errors; secure context confirmed. At 375×812 there is no horizontal overflow.
- Session endpoint returns unauthenticated state with `signupAllowed=false`. The public landing shows an invite-only notice and passkey sign-in; the signup form is hidden. A live uninvited signup probe returned 403 before proof creation or sending.
- Following the invitation link stays at `/join`, serves the app without the asset-canonicalization redirect, reveals invited enrollment and focuses its email field. Both confirmation inputs expose six-digit numeric/one-time-code attributes.
- Remote settings independently confirm every closed gate, exact origin/RP, dedicated D1 and sender allowlist. Production local-mailbox and alternate workers.dev endpoints return 404. Email-content previews remain disabled, and no secrets were rotated.
- The current context-index and QRZ-decoding follow-up passes **553 tests**, formatting, lint, both TypeScript checks and the Worker build locally. [Release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40025951354) passed all 553 tests and required checks. The preceding diagnostic release passed all 548 tests and required checks in CI. Prior release-specific CI results and browser/Worker evidence remain in the dated follow-up sections below; they do not substitute for this release's production measurement.
- Read-only remote D1 probes verified that the invite task must use query results, rather than bulk-file import summaries, to establish an exact email/deadline grant. Existing OAuth includes Email Sending write access. No real invitation grant/send was performed; CLI sends still require recipient-specific delivery confirmation.
- The initial deployment delivered one real verification message to the owner's inbox through the same native provider path; only fixed delivery metadata was inspected. That smoke test enrolled no production account and initially observed zero account/connection/ledger/attempt rows. These are historical counts, not a claim about subsequent personal use. New branded mail was rendered/tested locally; email-client/device autofill remains unverified.

The reported startup is deployment evidence, not per-request billed CPU or peak memory. No representative monthly workload/cost has been measured. Physical and synced passkey behavior remains for the owner to verify at this permanent origin. See [rollout acceptance](rollout-checklist.md) for the remaining vendor checks.

## Reproduce deployment

```sh
mise run check
mise run deploy-readonly
```

The deploy task builds the dashboard, refuses any open export gate, validates the permanent origin and D1 configuration, applies pending migrations to the dedicated production database, then deploys. It preserves provisioned secrets. Staging is intentionally a placeholder and remains undeployed.

Independent `KEK_V1`, `AUTH_SECRET` and `EMAIL_CODE_SECRET` are installed as Worker secrets. A protected local backup is at `~/.config/lofi-qso-ferry/production.secrets.json`, file mode 0600 in a 0700 directory outside Git. Preserve it until archived in the operator's secret manager; 1Password CLI was signed out during deployment. Do not print it, commit it, reuse local development secrets or rotate the KEK without preserving encrypted-data access. See [operations](operations.md) for rotation and restore quarantine.

## Owner's next step

The owner has enrolled and connected LoFi, QRZ and LoTW. Keep exports disabled while the repaired scheduler reconciles history and operation reads catch up; review the resulting exceptions before the scoped live checks in the [roadmap](../ROADMAP.md).

Existing users sign in with their passkey. To enroll someone new, run `mise run invite -- person@example.com`; they follow `/join`, confirm the exact invited address and create a passkey. Add an independent backup passkey, then connect only the services you use. Settings and account-default templates need no connections. LoTW connection import requires the personal P12 and its export password, if set. Ferry checks the certificate/private key, dates, serial status and optional website login, then leaves certificate-authority validation to LoTW during upload processing. See [certificate checks](lotw-certificates.md); there is no root configuration or updater. Keep all vendor exports disabled throughout this review; deployment authorization does not grant live-write authorization.

## Connection passkey freshness fix

Deployed `cbe9e63af1bf` after a stale signed-in session exposed a missing passkey prompt on LoFi approval. Protected buttons now verify freshness automatically; cancellation retains form data and sends no connection request. Typed precondition errors permit one bounded retry, while vendor, CSRF/origin and ambiguous failures do not. Account/CSRF snapshots stay pinned during another-tab refreshes.

All 180 local tests and deployed-code CI pass. Actual local Worker/Chromium checks use real virtual-passkey signatures and contained LoFi fixtures, including stale/fresh/canceled requests and native click activation. Production serves the new client, rejects a bad-origin auth request with its explicit code, and independently reads back all export gates closed. There were no pending migrations, secret changes or real vendor requests. The owner's actual passkey and LoFi email approval remain for them to complete after refreshing Ferry.

## Retained-source review follow-up

Deployed signed revision `1b7e2d4b2b08` as Worker `14faa523-c4a8-4b77-b92b-1fe8a378cf32`, applying only migration0008. The owner has completed LoFi linking; its display name comes from the vendor account name. New links now permit one current connection per optional service, including guarded concurrent saves, same-identity renewal and conservative pause/resume. Existing history is preserved.

The dashboard top counts now describe source ingestion, with destination activity separately below. Read-only review exposes scan/context progress, retained contact samples and effective station/location/reference/current-comment predictions. Complete context is required for a preview; existing pinned and adopted narrative policies are explicit. Review never calls vendors, changes a database row, prepares an attempt or signs a payload. Refresh review preserves unsaved forms.

All 196 tests plus strict lint/format/types/build pass. Actual isolated Worker/D1/Chromium resident/UV-passkey signup/link/pause/resume verifies the expected saved COMMENT prediction, duplicate409 before a second approval request, zero attempts/outbox, retained unsaved edits and 375px without overflow or console errors. Independent review fixed a stale diagnostic race using exact lease fencing. Deleted operations are skipped and failed/partial operation reads yield fairly. These fixture results do not prove live replay guarantees or vendor writes.

Live HTTPS serves the new review HTML and separate delivery metrics; unauthenticated review returns401/no-store. Cloudflare settings independently confirm all export gates closed, exact RP/origin, dedicated D1 and disabled alternate origins. Seven migrations are applied. Aggregate metadata at verification shows one active LoFi, 492 contacts, 176 live operations and initial backfill generation 5; the scan is still in progress. With no destination connected there are zero ledger rows and attempts, and no connection-guard residue. Operator verification read aggregate metadata only; it did not inspect source contents or credentials or edit real log entries. The first-page counts recorded earlier are historical; dashboard counts advance with cron.

## Vendor budgets and live-priority deployment

Deployed signed main revision `8c3f66cd81e39e174cf6e214ce93c965351b3342` as Worker `c2d31e84-8af7-484e-88f1-f1c41ba46885`. The guarded task verified all export gates closed, confirmed migrations 0009 and 0010 were already applied, and deployed the five-minute production schedule. The dedicated database now has all nine migrations. No application secrets were changed.

Persistent per-vendor request budgets and `Retry-After` cooldowns cover hosted reads and uploads. New contacts and corrections receive live priority; initial history uses smaller page/contact/attempt budgets, a bounded prepared outbox and independent repair scans for expired retained inputs. Initial source-context and cutover requirements remain enforced. The deployment also includes the separate LoTW password help and scrubbed certificate-versus-login errors.

The active deployment reports 100% on this Worker version. Public HTTPS checks returned health `status=ok` with exports disabled. Root HTML, dashboard JavaScript and CSS matched the locally built SHA-256 hashes, including the latest LoTW import-password help. Unauthenticated review returned `401` with `Cache-Control: no-store`, the session reported unauthenticated/invite-only, and production local-mailbox returned `404`. Version metadata independently confirmed every closed export gate, exact origin/RP, dedicated D1 and native sender allowlist. Verification read only public endpoints and deployment/schema metadata; it did not request vendor uploads or account messages.

The full isolated check passed all 232 tests, lint, formatting, types and Worker build. The deployed artifact is 1,587.34 KiB raw / 301.72 KiB gzip with reported startup 29 ms; these figures are not billed CPU or peak-memory measurements.

## Time-budgeted drain deployment

Verified 2026-10-23 UTC. The guarded read-only task deployed clean signed main revision `8066d25050462eaf001f0a25944d2225beebf791` as Worker `46c8523e-9e5d-42e3-a330-0073f5be4ceb`. The deployment includes scheduler commit `c353183` and intake commit `aa928cd`. There were no pending migrations. Deployment output confirmed the custom domain `ferry.n1rwj.com` and cron `*/5 * * * *`; independent deployment-status JSON reports this version receiving 100% of traffic.

The scheduler drains repeated fair rounds within a 90-second soft deadline instead of stopping after one fixed batch. Each selected source gets one contact turn per traffic class per round, with live polling and contacts before live delivery and saved historical attempts before further history inventory. Persistent vendor request caps, cooldowns, source-context requirements and export gates remain in force. Aggregate `ferry_tick` logs now include `rounds`, `elapsedMs` and `stopReason`. These counters support later throughput measurement; this deployment verification did not measure representative deployed capacity or billed CPU.

Version JSON independently confirmed all five closed export gates, exact production origin/RP, dedicated D1 `45ad64ad-92bb-491a-b6e6-1d2b17450144`, and the native `EMAIL` sender restriction to `signup@ferry.n1rwj.com`. Public health returned HTTP 200 with `{"status":"ok","exportsEnabled":false}`. Unauthenticated `/api/review` returned 401 with `Cache-Control: no-store`; `/api/auth/session` reported unauthenticated state with `signupAllowed=false`; `/api/auth/local-mailbox` returned 404. The SHA-256 hashes for `/`, `/app.js` and `/style.css` each matched the locally built files. Verification directly invoked no vendor uploads or account messages.

All 292 tests, formatting, lint, types and Worker build passed before the focused commits. The uploaded artifact is 1,605.00 KiB raw / 305.51 KiB gzip. This deployment reported no startup measurement; the earlier 29 ms result belongs to the previous version.

## Historical managed LoTW trust deployment

Deployed signed main revision `8f371eb5deaa2c28eee77249b49f2adc3b3860a8`
as Worker `521a1920-fc03-49d2-aa4e-24a0b9287ab5`. The guarded deployment applied
migrations 0011 and 0012 from the already landed admin work, then deployed the
latest tested main tree. All eleven migrations are applied. Every export gate
remains closed, and the trust setting is `LOTW_TRUST_ROOTS_JSON=bundled`.

The [former trust bundle](lotw-certificates.md) includes the current ARRL root obtained
independently from ARRL's authenticated HTTPS certificate download. The actual
imported certificate chain verified against that root in memory. No private key,
website password or user certificate was saved as release data. Existing
credentials were neither rotated nor reimported.

The first deployed scheduled refresh at `2026-10-23T04:45:43.159Z` automatically
changed the saved LoTW connection from unverified to active, with issuer trust
verified and ARRL status unrevoked. Its scheduler turn completed with zero errors.
Live health returns `status=ok` and `exportsEnabled=false`; deployment metadata
confirms the exact version receives 100% of traffic and every write gate remains
closed. The full release check passed all 333 tests, formatting, lint, types and
build, including trust withdrawal between preparation and dispatch. No real
logbook entry was uploaded or changed.

[GitHub CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39901830697)
passed for this deployed revision.

## Historical automatic LoTW trust discovery deployment

Deployed signed main revision `a20660b41f9aea4adb20798820ea1e2638705020`
as Worker `5b6e738c-dfb6-42f3-bc7c-f825712e2338`, receiving 100% of traffic.
Migration 0013 adds the shared public-root cache; all twelve migrations are
applied. No application secrets changed, and every export gate remains closed.

At `2026-10-23T12:31:11.057Z`, the live scheduler fetched and cached one current
root from ARRL's fixed HTTPS certificate download. Its next normal attempt is
24 hours later. The saved LoTW connection remains active, trusted and unrevoked;
no certificate reimport or private-key rewrite was needed. Failed refreshes
retain known anchors, and uploaded certificate chains cannot establish trust.
An unfamiliar issuer can request an earlier refresh subject to shared cooldowns.
See [current certificate checks](lotw-certificates.md) for source provenance and explicit overrides.

The full release check passed all 358 tests, formatting, lint, types and Worker
build. [GitHub CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39953556943)
passed for the deployed revision. Public health returns `status=ok` with exports
disabled, and deployment metadata independently confirms every write gate is
closed. Verification performed authenticated certificate reads only; no real
logbook entry was uploaded or changed.

## LoTW preflight simplification deployment

Deployed signed main revision `de6259ee8bc7b69e66b983926659e2bd154c1995`
as Worker `e712842f-71c4-4ec6-b807-69ab9fb1d112` at
`2026-10-23T13:00:26.989Z`, receiving 100% of traffic. Migration 0014 removes only
the obsolete public-root cache; all thirteen migrations are applied. Production
schema inspection confirms the cache is absent, and version metadata confirms
there is no root-policy binding. No application secrets changed.

Ferry now follows the direct-signing model described in
[certificate and login checks](lotw-certificates.md). Local checks retain P12
integrity, matching keys, certificate/QSO dates, station constraints, fresh ARRL
serial status and separate website-login verification. LoTW determines certificate
authority and signed-upload acceptance. The earlier trust-deployment sections are
historical evidence for functionality that has now been removed.

The saved LoTW connection remains active with unrevoked serial status. Existing
encrypted credentials need no reimport; regression tests prove legacy local trust
flags are ignored and maintenance leaves encrypted keys and versions unchanged.
The full release check passed 328 tests, formatting, lint, both typechecks and the
Worker build. Independent review found no blocking issues.

Public health reports `status=ok` with exports disabled. Deployed HTML and client
JavaScript exactly match the release files; unauthenticated review remains 401
with no-store and the production local mailbox remains absent. Deployment metadata
independently confirms every export gate is closed. Verification submitted no
contacts and changed no real logbook entries.

## Classified admin workload deployment

Deployed signed main revision `9eef564af80d449a99227ae1099bd11fc8bff64a`
as Worker `ca6bc362-f675-4b96-9831-8c466391aa49` at
`2026-10-23T13:39:13.890Z`, receiving 100% of traffic. The guarded deployment
applied migration `0015_admin_workload.sql` before deploying; all fourteen
migrations are applied. Its six nullable scheduler columns preserve missing
historical breakdowns as unknown, and its indexes support workload and delivery
summaries. No application secrets changed.

The admin console now distinguishes ready processing, known holds, invalid
source records, and expired inputs. It shows sanitized reasons, hourly backlog
trends with coverage and gaps, and completed destination-contact versions derived
from durable attempt events. Repeated processing, LoTW submission acknowledgements,
and adopted existing history do not inflate delivery throughput. See the
[workload investigation](admin-workload-investigation.md) and
[metric definitions](admin.md).

Live `/admin`, `/admin.js`, `/admin.css`, and `/app.js` exactly match the release
files. Health reports `status=ok` with exports disabled. Unauthenticated admin
overview and invitation requests return 401 with no-store, the session remains
invite-only, and the production local mailbox returns 404. Independent version
metadata confirms all export gates closed, the existing origin/RP, and the
dedicated production D1. New classified samples accumulate on normal scheduled
runs; the pre-deployment history cannot supply their breakdown.

All 344 tests, formatting, lint, both typechecks, and the Worker build passed.
[GitHub CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39961544700)
passed for the deployed revision. Desktop and mobile layouts were verified
with synthetic data before release. The uploaded artifact is 1,648.91 KiB raw /
316.66 KiB gzip with reported startup 47 ms, not a measurement of billed CPU.
Verification performed no invitation sends or real logbook uploads.

## Reconciliation backlog repair deployment

Deployed signed main revision `1679f749aa7f13f76219375386867005afcf507b`
as Worker `1eaf7657-686a-471c-9f8b-0760f7b624f1`, created
`2026-10-23T13:40:34.062Z`. The release includes the linked-account email and
actionable admin workload changes already landed on main. The guarded deployment
found no pending migrations; an independent D1 query confirms all fourteen are
applied, including 0015. No application secrets or export settings changed.

All twelve sampled generic readback failures contained nonzero source
milliseconds. Source projection succeeded, but the strict outbound ADIF converter
rejected them before vendor access. Read-only reconciliation now uses the
PoLo/HaLo whole-second projection while preserving source precision. A bounded
live diagnostic successfully read both vendors and returned conservative QRZ
ambiguity and LoTW mismatch outcomes; it made no vendor mutations. Fractional
exports remain blocked until durable outbound identity claims exist.

Renewed LoFi session tokens are now retained with credential/identity race
guards. This was a confirmed implementation defect; its contribution to live
backlog delays was not measured. Closed export gates no longer replace history
review reasons, and fixed error categories distinguish source conversion, saved
credentials and destination readback failures without retaining private errors.
Competing history claims quarantine untransmitted adoptions and their contender;
identity reservations and trusted or dispatched evidence are preserved.

The full integration check and added admin regression passed locally.
[GitHub CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39963134190)
passed all 371 tests, formatting, lint, both TypeScript checks and build for
the deployed revision. Identity review holds remain visible after route/state
changes and under open synthetic gates.

Independent deployed-version metadata confirms every export gate remains closed.
Public health reports `status=ok` and `exportsEnabled=false`; deployed app and
admin JavaScript exactly match the release files. At 13:41:45 UTC, production
still contained zero delivery attempts and zero cutovers. Its first observed run at 13:42:35 UTC completed with zero errors but
zero contact turns; the scheduling follow-up below addresses that remaining
bottleneck.

## Reconciliation scheduling follow-up

Deployed signed main revision `634517d0de72002c585da4815bf728ccbd182b13`
as Worker `bb37da72-5aad-42a5-a5b7-29503787b0c8`, created
`2026-10-23T13:59:38.831Z`. Every independently read-back export gate remains
closed, health reports exports disabled, and all fourteen migrations remain
applied. The release did not change secrets or vendor request budgets.

The 13:42:35 UTC run took 130,398 ms, completed two rounds, and hit its soft
deadline without reconciling a contact. Cursor timestamps show normal sync at
13:42:40, historical rescans at 13:42:48 and 13:43:42, and an operation reread
at 13:43:17. The contact selected at 13:43:31 lacked operation context even
though the workload sample contained 1,465 ready contacts. These timestamps
locate wasted scheduling opportunities without attributing all elapsed time to
network I/O; end-of-run cleanup also contributes to the duration.

A bounded read-only production comparison found available operation-base
context for two of the first ten oldest contacts, versus ten of ten when
prioritizing available context. The query wrote zero rows. Selection now prefers
retained contacts with available context within each traffic class, while the
full payload/event/generation checks remain mandatory. A ready background
contact gets its turn after canonical polling and before additional historical
rescan/reread work. When none is ready, the scheduler retries after the context
read, preserving same-run recovery. Live context ordering is unchanged.

The full local check passed 377 tests, formatting, lint, both TypeScript checks
and build. New tests prove slow historical reads cannot prevent an already
ready contact from reconciling first, and known context holds remain available
for later recovery without bypassing validation. Independent review found no
blocking issues. [GitHub CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39965786804)
passed for this exact deployed revision. Deployment metadata confirms it receives
100% of traffic.

At 14:04:02 UTC, the run that started at 14:00:46 had completed in 132,058 ms
with one source page, one contact turn, zero errors and zero deferrals. Both
vendor reads completed: QRZ retained a precise ambiguous-identity reason, and
LoTW retained an operating-grid mismatch. No contact was guessed to match or
made eligible for export. The overlapping run at 14:00:55 completed without
source/contact work; lease fencing prevented it from duplicating the active turn.

The completed working run sampled 1,509 contacts ready for further processing,
2,624 held and one invalid source contact, compared with 1,486/2,647/1 before the
follow-up. Operation context progressed to 129 complete and 47 pending operations.
These changes demonstrate processing, not complete recovery or a sustainable
throughput measurement. Total retained source contacts remained 4,134: 3,097
pending, 761 blocked on context, one callsign validation failure, 270 waiting,
and five routing holds. The old generic readback reason still appeared on 264
ledger rows at each destination until those rows are revisited; one newer QRZ
retry failure also remained. Review exceptions and sustained catch-up are still
required before enabling exports.

Production still had zero attempts and zero cutovers, every export gate stayed
closed, and all verification queries wrote zero rows. No real QSO was signed,
inserted, replaced, deleted or uploaded.

## Reconciliation investigation release (2026-10-23)

Deployed signed revision `cf34ac0a82e4f3f845b058684a04128f91c0b147` as Worker
`40a3c20e-81f8-45a7-9350-2e99767c241c`, created at `2026-10-23T15:04:09.293Z`.
Deployment `4e6b6270-2424-4a2d-b642-fecae559a7a2` assigns it 100% of traffic.
The [CI run](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39974178346) passed all 392 tests and required checks.
Local full validation passed 391 tests before a final diagnostic refinement;
all 35 focused QRZ/reconciliation tests and TypeScript/lint then passed.

This release contains the narrow canonical general-log station fix and migration
`32758f5`, precision-specific review reasons `789d652`, cleanup optimization
`fa822ba`, and the capacity investigation/roadmap `cf34ac0`. Independent review
checked migration/deletion scope and caught an unrelated-neighbor diagnostic
case, fixed before release. Existing history is still held where precision or
coverage is insufficient; no comparison or outbound identity guard was relaxed.

`mise run deploy-readonly` applied migration 0016 and deployed the Worker without
changing secrets. Preflight SELECT found exactly one eligible source hold; the
15:04:50 UTC readback confirms fifteen migrations, that input pending with no
old callsign reason, and zero export attempts. Version readback confirms all
five gates closed, with healthy `/health` and `exportsEnabled=false`. Bundle
size is 1,659.23 KiB raw / 318.87 KiB gzip; reported startup is 32 ms.

The [investigation](reconciliation-investigation.md) records local cleanup and
4,000/200,000-contact scale measurements, request-budget floors, source/context
amplification and remaining batching/inventory work. These are not production
throughput or completed reconciliation claims. No real QSO was signed,
inserted, replaced, deleted or uploaded.

At 15:08:05 UTC, the first completed post-release run (started 15:05:50) took
96,730 ms, with two contact turns, one canonical source page, zero errors and
zero deferrals. The immediately preceding run took 132,572 ms for two turns.
This one-run comparison is consistent with less cleanup overhead; contact
throughput remains two turns per run and sustained draining is not established.
Classified work was 1,820 ready, 2,314 held and zero blocked. The cleared callsign
hold was requeued, not independently proven reconciled. New precision-specific
reasons were stored for one QRZ and two LoTW rows, all still review holds.
Export attempts and source cutovers both remained zero.

## Reconciliation throughput and test-operation release (2026-10-23)

Deployed signed source revision `bbc2346c0e4da2754a7a1971697ce5d7eccf7a13`,
including test-operation commit `0000073e7bd6a79f873c6609fba500739179f1de`, as
Worker `c592733f-171f-406e-bb8d-827b7ffd7fd9`. The Worker was created at
`2026-10-23T16:12:02.575537Z`; deployment
`45d4360c-cd35-414d-9dc7-32ce92ab9420` at `2026-10-23T16:12:03.659075Z`
assigns it 100% of traffic. The
[release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39983716440)
passed all 452 tests and required checks. Local validation also passed 452 tests
and the focused final event-race checks.

The combined release adds batched source/context access, indexed durable
reconciliation scheduling, quiet retries for stable review holds, shared
positive history inventory and aggregate scheduler throughput telemetry. It
also includes test-operation review and export guards. Background contact
batches are 20, live processing remains one contact at a time, and the scheduler
yields at its 90-second or 850-D1-RPC soft budget. Vendor allowances and every
export gate remain unchanged. Local performance evidence and remaining source
capacity work are recorded in the [investigation](reconciliation-investigation.md).

The guarded deployment applied migrations 0017–0020. Independent D1 readback
at `2026-10-23T16:12:41.646Z` confirmed all 19 migrations, zero attempts, zero
source cutovers and zero guard residue. No application secrets changed.
Deployed-version readback independently confirmed all five export gates closed.
Health returned `status=ok` and `exportsEnabled=false`; SHA-256 hashes for `/`,
`/app.js` and `/admin.js` matched the local build. The uploaded bundle is
1,715.07 KiB raw / 331.10 KiB gzip, with reported startup of 34 ms.

Sustained production throughput remains unmeasured for this release. A scheduler
run that started before the 16:12:03 UTC deployment belongs to the previous
version even if it finishes afterward; its duration and missing new telemetry
must not be treated as results from this implementation. Observe newly started
runs and multiple windows before claiming a drain rate, complete reconciliation
or 200,000-contact capacity. Deployment and local checks do not authorize
exports or resolve precision/routing exceptions.

## Reconciliation round-trip and QRZ catch-up follow-up (2026-10-23)

Deployed signed source revision `471e8620e227c35adf2cb5c91a31765fdc7fa04a` as
Worker `5d667922-2d09-4020-8fbd-46594a537750`, created at
`2026-10-23T16:37:08.807799Z`. Deployment
`18c2ecd3-a9ef-4c6e-8b28-1712c65d41fa` at `2026-10-23T16:37:10.435132Z`
assigns it 100% of traffic. Full local validation passed 465 tests and all
required checks. [Release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39988135604)
passed all 465 tests and required checks.

A rejected QRZ modification catch-up no longer leaves a repeatedly failing
partial inventory. The worker atomically discards its partial pages, index and
ciphertext, then requires a fresh, fully verified date-range scan with valid
response framing. The fallback supplies positive evidence only; rejected or
incomplete responses never establish absence. Metadata reads in intake,
reconciliation and inventory are combined into fewer D1 round trips while
retaining the source, credential, generation, lease and commit-time evidence
guards.

Read-only background reconciliation can process up to four contacts concurrently,
with work for the same destination/week serialized to share partition progress.
Live processing and every batch with exports effectively enabled remain
sequential. The scheduler waits for all started tasks to settle before releasing
its source lease, including on a task failure. The existing vendor budgets,
90-second/850-D1-RPC soft thresholds and closed export gates are unchanged.

Telemetry now distinguishes `database.wallMs`, the union of time with at least
one D1 RPC in flight, from `database.durationMs`, the sum of RPC durations.
Concurrent stage durations are also cumulative and may exceed elapsed wall time;
do not add overlapping durations to infer invocation time or billed CPU.

The first deployment attempt stopped at the preflight API error `7403` before
changing the Worker. Read-only identity and migration checks then succeeded,
and a retry of the guarded deployment completed. No new migrations were
required. Independent readback at `2026-10-23T16:37:39.690Z` confirmed all 19
migrations, zero attempts, zero cutovers and zero guard residue. Secrets were
preserved. Deployed-version settings confirm every export gate closed; health
returns `status=ok` and `exportsEnabled=false`. The `/`, `/app.js` and
`/admin.js` hashes match the local build. The bundle is 1,718.88 KiB raw /
331.87 KiB gzip, with reported startup of 35 ms.

The first follow-up run, 16:40:49–16:42:24 UTC, processed 20 contacts and made 29 destination classifications in 95.3 seconds, with three errors and eight deferrals. It recorded 25 inventory fetches, 14 cache hits and 92.9 seconds of D1 wall time across 667 RPCs / 1,171 statements. No historical rescan or operation reread page advanced, exposing background scheduling starvation. At 16:43 UTC, six QRZ and seventeen LoTW partitions were complete; attempts, cutovers and temporary guard rows remained zero. Sustained capacity and source freshness remain unverified. Runs started
before the 16:37:10 UTC deployment remain evidence for their earlier version,
even if they finish afterward. Observe new runs and multiple windows before
claiming sustained throughput, backlog completion or 200,000-contact capacity.
No export gate was opened by this release.

## Background lane fairness follow-up (2026-10-23)

Deployed signed source revision `cb9ea362e2a03e29b7d53793bae95276de7d7341` as
Worker `aea20af6-c08d-4718-bc41-2e450d8cc2e4`, created at
`2026-10-23T16:53:26.165896Z`. Deployment
`383eb991-f7ff-4dc7-97cd-f8834332f431` at `2026-10-23T16:53:28.594528Z`
assigns it 100% of traffic. Full local validation passed 467 tests and all
required checks. [Initial release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39990488592)
failed only formatting after a documentation edit. Signed documentation revision
`7252cad4` corrects that formatting with code identical to the deployed revision;
its [CI rerun](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39991118470)
passed all 467 tests and required checks.

The scheduler now rotates which background lane runs first after canonical
polling: retained contacts, historical rescan or context reread. The isolated
`scheduler:background` cursor advances before executing the lane under the exact
active source-cycle lease. A slow or failed lane therefore cannot repeatedly
keep the other lanes behind it. Live context and contact processing keep their
existing priority. The rotation cursor is scheduling metadata, not source
coverage or cutover evidence. No schema, vendor allowance, batch size or
90-second/850-D1-RPC soft budget changed.

Independent D1 readback at `2026-10-23T16:53:42.060Z` confirmed all 19
migrations, zero attempts, zero cutovers and zero guard residue. No migration
was required and secrets were preserved. At `2026-10-23T16:53:56.840Z`,
deployed-version settings independently confirmed every export gate closed,
health returned `status=ok` and `exportsEnabled=false`, and the `/`, `/app.js`
and `/admin.js` hashes matched the local build. The bundle is 1,720.10 KiB raw /
332.17 KiB gzip, with reported startup of 32 ms.

The first fairness run, `16:55:48.291–16:57:28.171 UTC`, processed 23 contact
turns and made 31 destination classifications in 99.880 seconds. It processed
55 source records and advanced two historical rescan pages and two context
reread pages, with six errors and five deferrals. History recorded 14 fetches
and 22 cache hits. D1 recorded 662 RPCs / 1,495 statements, 203.490 seconds of
cumulative duration and 93.964 seconds of wall time; overlapping work explains
why cumulative duration exceeds elapsed time.

The `16:57:52.155 UTC` snapshot showed rotation generation 2 after two
background rounds, 125 destination checks covering 87 distinct contacts, and
12 completed QRZ plus 21 completed LoTW partitions. Attempts, cutovers and
temporary guard rows remained zero. This first run demonstrates resumed rescan
and context progress alongside reconciliation; it does not establish a sustained
completion rate across larger accounts.

The second fairness run, `17:01:30.009–17:03:19.475 UTC`, advanced rotation
generation 3 and one context reread page before processing 15 contacts. It made
17 destination classifications, including one adoption, with four errors and
zero deferrals. No rescan page advanced; the context page returned zero source
records. D1 wall time was 96.214 seconds across 337 RPCs / 751 statements in
109.466 seconds elapsed. At `17:03:59.338 UTC`, 142 remembered checks covered
97 contacts, fifteen QRZ and twenty-three LoTW partitions were complete, and
attempts/cutovers/guard residue remained zero. All three first positions have
now been exercised across the two runs. The observed 15–23 contact turns remain
insufficient evidence for complete reconciliation or the larger capacity goals.

The preceding 16:50 UTC run used revision `471e862` and processed 15 contacts
with 17 classifications in 117.6 seconds, with ten errors, no deferrals and no
context or rescan progress. Across three observed runs of that earlier release,
15–21 contact turns per invocation did not establish a sustained completion
rate. Runs started before this deployment remain evidence for the earlier
version even if they finish afterward. Exports remain disabled; neither release
validation nor scheduling fairness completes exception review or establishes
200,000-contact capacity.

## Guarded reconciliation cohorts (2026-10-23)

Deployed signed main revision `bca137b1a38ceb7ab0601e1db53136d69cce9c9c`, with
application code `b23e563a4104bd16b8bb9ce0cd6d356ddfad9d3f`, as Worker
`1f481a97-7e78-443a-a180-ea488822f78b`, created at
`2026-10-23T19:45:28.295064Z`. Deployment
`df1b5117-8f4e-43ae-933d-e697c0baeae3` at `2026-10-23T19:45:29.359227Z`
assigns it 100% of traffic. All six logical commits were signed and their
signatures independently verified. Full local validation passed all 512 tests
and required checks; [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40013802909)
passed all 512 tests and required checks.

Read-only background groups now share observation snapshots, encrypted history
reads and bounded guarded outcome commits. Individual source generations,
credentials, retained evidence, remote identity reservations and queue versions
remain checked. Failed partitions isolate dependent contacts; collision
quarantine preserves competing claims. Small groups and live preparation retain
the existing path. There is no cross-request plaintext cache, new write permission,
change to vendor allowances or change to the 90-second/850-RPC soft budget.

The local warm 20-contact/two-destination fixture falls from 400 to 19 cohort
RPCs, 467 to 86 whole-tick RPCs and 939 to 556 SQL statements. All 40 destination
classifications remain, with zero vendor history requests and zero exports.
Cold whole-tick calls fall from 519 to 170 while retaining three history fetches.
These measurements establish lower database amplification, not sustained
production capacity. `reconciliationBatchCalls` includes all cohort work rather
than inventory reads alone.

The deploy task found no pending migrations and preserved secrets. Independent
D1 readback at `2026-10-23T19:45:46.663Z` confirms nineteen migrations, zero
attempts, zero cutovers and zero temporary proof-guard rows. Live version
settings confirm all five export gates closed; health returns `status=ok` and
`exportsEnabled=false`. The root, `/app.js` and `/admin.js` hashes match the
local build. The bundle is 1,758.87 KiB raw / 339.42 KiB gzip, with reported
startup of 46 ms.

The first new cron run, `19:45:43–19:47:15 UTC`, processed 80 contact turns and
made 121 destination classifications, including five adoptions, with 39 errors
and three deferrals. Inventory recorded 121 cache hits and zero successful
advances; `inventoryFetches` does not count failed vendor requests. The run
used 384 whole-run RPCs / 2,643 SQL statements, 208 reconciliation cohort RPCs
and 83.49 seconds of database wall time, reaching its deadline after 92.209
seconds. The preceding old-code run processed 40 turns / 60 classifications
using 862 RPCs / 1,900 statements in 64.118 seconds and stopped at its database
budget. The first new sample doubled contact turns and reduced RPCs per turn
by approximately 78% (4.8 versus 21.55). It also ran longer and processed mixed
work; these are not unique completed reconciliations or a sustained capacity SLA.
Warm inventory reuse leaves cold-inventory behavior unmeasured in this sample.

The second new run, `19:50:42–19:52:09 UTC`, processed 137 contact turns and
249 destination classifications, including 29 adoptions, with 13 errors and
three deferrals. It recorded five successful inventory advances and 244 cache
hits. Whole-run cost was 861 RPCs / 4,842 SQL statements, including 569 cohort
RPCs, with 85.067 seconds of database wall time in 86.646 seconds total. It
stopped at the 850-RPC soft admission budget; bounded work already started and
cleanup can finish beyond that threshold. RPCs per turn were 6.28. Both new
samples improve on the preceding 40-turn run, but still contain errors and
different work mixes. The second sample includes some inventory advancement;
it is not a full cold-inventory or sustained-capacity test.

The `19:52:36 UTC` snapshot still confirms nineteen migrations, zero attempts,
zero cutovers and zero temporary guards. Earlier runs and progress accumulated
before deployment belong to the previous release. Errors and sustained
classification/context progress remain under observation. Exports remain
disabled; full history reconciliation, fair account admission, source capacity,
delivery identity claims and workload acceptance remain open.

## Independent background admission and diagnostics (2026-10-23)

Signed revision `8863bd9439681122e71bc3c2a31174a72aa30bb2` deployed at
20:44:21 UTC as Worker `004edefd-d2a5-462c-b079-1cf8d04e6b05`, with 100%
traffic. The guarded task applied additive migration `0021`; twenty migrations
are now present. The five signed commits add fixed failure counters, mixed-date
scope sharing, independent background account/source turns and bounded cold
partition concurrency, plus a JSON persistence assertion correction.

All 531 tests and required local checks pass. Independent readback at 20:44:30
confirms all five export gates closed, health `ok`, matching browser assets and
zero attempts, cutovers or temporary guards. Secrets and request allowances were
unchanged. The first scheduled run with the new diagnostics is recorded below.

The warm 20-contact/20-week fixture uses 57 cohort RPCs, 128 whole-run RPCs and
716 statements while preserving all 40 outcomes without vendor requests or
writes. Cold reads remain bounded to four; failures and deadlines stop new
advances, and started peers finish before lease release. The 100-account fixture
proves background turn order across restarts, including slow failures and
multiple sources; it does not establish full live/vendor fairness or sustained
capacity. Full workload verification and the export-readiness requirements
remain open in the [capacity plan](capacity-plan.md).

The first new run, 20:46:52–20:48:32 UTC, completed 22 contact turns and
27 destination classifications, including two adoptions, with 11 errors and
two deferrals. It used 254 RPCs and 880 SQL statements in 100.130 seconds;
97.563 seconds were database wall time. It stopped at the soft deadline after
in-flight work settled. This sample does not establish a production speedup.
The new fixed categories identify QRZ rejected responses (four events affecting
six routes across the single-contact and shared-history paths), QRZ invalid
responses (two events affecting four routes), one LoTW unavailable event and
one LoTW budget-deferral event affecting two routes. Diagnostic events are not
physical request counts. The exact QRZ parser cause and the source of variable
D1 latency still need investigation. The 20:48:44 UTC snapshot confirms zero
attempts, cutovers or temporary guards.

## QRZ response and D1 timing diagnostics (2026-10-23)

Signed revision `57a64b02285f55f3dee25fdf52674ac54cd3893f` deployed at
21:03:35 UTC as Worker `25628683-a870-40e5-835f-e697adbc7f44`, at 100%
traffic. No migration was needed. Both new commits have verified signatures.
All 548 local tests and required checks pass; release CI passed all 548 tests and required checks.
Independent 21:05:18 UTC checks confirm all five gates closed, healthy service
and matching browser assets.

Read-only QRZ failures now preserve only fixed framing, entity, form, result,
size, UTF-8 and body-read categories. Raw responses and error causes are not
retained. Malformed write responses remain uncertain, and a rejected FETCH
never becomes empty-history evidence. D1 metrics add bounded SQL timing,
row/retry totals, metadata coverage and known database-region counts. Query
behavior and first/raw methods are unchanged. Reported SQL/row metadata covers
the last attempt only; its difference from binding wait is not pure network
latency.

The first refined-counter run, 21:05:42–21:07:13 UTC, completed 104 contact
turns and 158 destination classifications, including ten adoptions, in 91.239
seconds. It recorded 33 errors and four deferrals. QRZ entity decoding accounts
for eleven diagnostic events affecting twenty history routes; ten separate QRZ
rejection events affected twelve routes. One LoTW unavailable event and four
budget-deferral events account for the remaining categories. Events are not
physical request counts. This diagnostic run localized the entity failure to numeric Unicode
validation; the later 21:29 UTC follow-up addresses the observed valid pairs.

D1 used 702 RPCs and 3,624 statements, with 84.089 seconds of wall time and
97.357 seconds of cumulative request time. Metadata covered 3,395 statements:
1.425 seconds of reported SQL execution, 1,004,089 rows read, 5,818 rows written,
zero additional statement retries, and ENAM service for all covered statements.
The uncovered 229 statements and last-attempt-only SQL reporting prevent
attributing the wait gap purely to network latency. This points to further
round-trip reduction and query profiling, not a reason to raise budgets.
The 21:08:59 UTC snapshot confirms zero attempts, cutovers or temporary guards.

## Context lookup index and QRZ Unicode compatibility (2026-10-23)

Current checkpoint, 2026-10-23 21:29 UTC: signed revision
`cec488febcad419ff55a4aa677619a1aef61fcd5` is deployed as Worker
`3c1f615e-bf2d-403f-9d54-1aed519da582` at 100% traffic. The follow-up adds
migration `0022` to keep context/event lookups independent of ordinary contact
counts, and lossless decoding of QRZ's observed adjacent Unicode surrogate
entities. Invalid pairs and split ADIF fields still fail closed. All **553 tests**
and required checks pass locally and in [release CI](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/40025951354).
Independent 21:29:45 UTC checks confirm closed export gates, healthy service
and matching assets. D1 has twenty-one migrations, with zero attempts,
cutovers or temporary guards.

The first new run, 21:30:42–21:32:15 UTC, completed 117 contact turns and
166 destination classifications, including eighteen adoptions, in 92.576 seconds.
It advanced seventeen history inventories and four source rescan pages, with
twenty errors and one deferral. No entity-decoding failures were recorded in this
sample. QRZ still reported eight rejected routes, nine scope-mismatch routes,
one invalid/repeated log-ID route and two uncategorized failed routes. The LoFi
rescan contributed the budget deferral. These are affected routes, not requests.

The run used 838 RPCs and 4,135 statements; metadata covered 3,856 statements,
reporting 1.812 seconds of SQL, 1,117,936 rows read, 9,990 rows written and no
additional retries. Database wall time was 86.934 seconds. It still reached the
deadline: this mixed-work sample establishes neither a sustained speedup nor a
whole-run scan reduction. The local context-index result remains valid, but the
production scan attribution needs query-level profiling. Remaining QRZ failures
must stay held until their scope, identity and parse evidence is understood.
At 21:32:48 UTC, attempts, cutovers and temporary guards remain zero.

The exact context fence reads 4,003→3 rows and the context query 4,004→4 in a
local 4,000-contact fixture. A bounded live QRZ read with the new parser returned
121 records with well-formed Unicode. An earlier post-patch probe still failed
with a generic protocol error; these samples do not prove complete QRZ recovery.
The next larger performance task is memory-bounded history-leaf batching, followed
by dependency parking, larger measured source pages and full workload acceptance.
Review holds and export-readiness requirements remain open.
