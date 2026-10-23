# Read-only production deployment

Verified 2026-10-23 UTC at [https://ferry.n1rwj.com](https://ferry.n1rwj.com). The owner selected this permanent hostname. Vendor exports remain disabled; no real logbook entries were changed. The resource summary reflects the latest deployment; the follow-up sections retain earlier evidence.

| Resource                 | Current value                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare account       | `478f5e15ae2afa01364d19f42a3e06f2` (existing account)                                                                                                                                                                                                                                                                  |
| Worker                   | `lofi-qso-ferry`, environment `production`                                                                                                                                                                                                                                                                             |
| Deployed source revision | `634517d0de72002c585da4815bf728ccbd182b13`                                                                                                                                                                                                                                                                             |
| Worker version           | `bb37da72-5aad-42a5-a5b7-29503787b0c8`, 100% of traffic                                                                                                                                                                                                                                                                |
| Origin / passkey RP      | `https://ferry.n1rwj.com` / `ferry.n1rwj.com`                                                                                                                                                                                                                                                                          |
| Dedicated D1             | `ferry-production`, `45ad64ad-92bb-491a-b6e6-1d2b17450144`, ENAM                                                                                                                                                                                                                                                       |
| Migrations               | `0001_foundation`, `0002_auth`, `0004_intake`, `0005_cutover`, `0006_account_templates`, `0007_invitations`, `0008_connection_policy`, `0009_vendor_requests`, `0010_source_priority`, `0011_admin_metrics`, `0012_admin_invitations`, `0013_lotw_trust`, `0014_retire_lotw_trust`, `0015_admin_workload`, all applied |
| Sender                   | Native Cloudflare `EMAIL`, restricted to `signup@ferry.n1rwj.com`                                                                                                                                                                                                                                                      |
| Sending domain           | `ferry.n1rwj.com`, tag `e69af8ef82a140b38eeaef98d417ef30`, content previews disabled                                                                                                                                                                                                                                   |
| Schedule                 | `*/5 * * * *`                                                                                                                                                                                                                                                                                                          |
| Alternate origins        | workers.dev and version previews disabled                                                                                                                                                                                                                                                                              |
| Artifact                 | 1,657.13 KiB raw / 318.32 KiB gzip; reported startup 31 ms                                                                                                                                                                                                                                                             |

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
- Earlier full isolated checks passed **232 tests**, formatting, recommended lint with warnings as errors, types and build. Actual workerd exercises hosted invited registration and native adapter fetches through contained fixtures. Actual isolated Wrangler/D1/Chromium signup and passkey sign-in verify quiet40 and account-default template saves with zero connections, including persistence after reload. The current reconciliation release passed the full **377-test** local and CI checks recorded below.
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
