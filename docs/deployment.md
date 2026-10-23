# Read-only production deployment

Verified 2026-10-22 at [https://ferry.n1rwj.com](https://ferry.n1rwj.com). The owner selected this permanent hostname. Vendor exports remain disabled; no real logbook entries were changed.

| Resource                 | Current value                                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare account       | `478f5e15ae2afa01364d19f42a3e06f2` (existing account)                                                                                                                                              |
| Worker                   | `lofi-qso-ferry`, environment `production`                                                                                                                                                         |
| Deployed source revision | `8c3f66cd81e39e174cf6e214ce93c965351b3342`                                                                                                                                                         |
| Worker version           | `c2d31e84-8af7-484e-88f1-f1c41ba46885`                                                                                                                                                             |
| Origin / passkey RP      | `https://ferry.n1rwj.com` / `ferry.n1rwj.com`                                                                                                                                                      |
| Dedicated D1             | `ferry-production`, `45ad64ad-92bb-491a-b6e6-1d2b17450144`, ENAM                                                                                                                                   |
| Migrations               | `0001_foundation`, `0002_auth`, `0004_intake`, `0005_cutover`, `0006_account_templates`, `0007_invitations`, `0008_connection_policy`, `0009_vendor_requests`, `0010_source_priority`, all applied |
| Sender                   | Native Cloudflare `EMAIL`, restricted to `signup@ferry.n1rwj.com`                                                                                                                                  |
| Sending domain           | `ferry.n1rwj.com`, tag `e69af8ef82a140b38eeaef98d417ef30`, content previews disabled                                                                                                               |
| Schedule                 | `*/5 * * * *`                                                                                                                                                                                      |
| Alternate origins        | workers.dev and version previews disabled                                                                                                                                                          |
| Artifact                 | 1,587.34 KiB raw / 301.72 KiB gzip; Cloudflare-reported startup 29 ms                                                                                                                              |

The existing account and native email pattern were reused. Ferry has its own database and secrets; unrelated Worker databases were not modified. Sending DNS is isolated to the new subdomain and its bounce/authentication records; existing `n1rwj.com` Fastmail MX records were checked unchanged. No subscription or billing-plan changes were made. The account Email Sending API reported an existing quota of 200 messages/day; this deployment did not change that limit.

## Gate verification

Read back from the deployed Worker settings, independently of the local configuration:

```text
EXPORTS_ENABLED=false
ROLLOUT_CHECKS_PASSED=false
SOURCE_BOUNDARY_VERIFIED=false
LIVE_WRITE_AUTHORIZATION=
ROLLOUT_QSO_IDS_JSON=[]
LOTW_TRUST_ROOTS_JSON=[]
```

[Health](https://ferry.n1rwj.com/health) returns `{"status":"ok","exportsEnabled":false}`. No authorized UUID scope exists. The scheduled service can poll and adopt configured history after the owner connects accounts; it cannot sign, insert, replace, delete or upload contacts with these gates closed. Signup email and LoFi approval/client renewal are separate provider interactions.

## Live checks

- HTTPS UI and static assets load in Chromium with no console errors; secure context confirmed. At 375×812 there is no horizontal overflow.
- Session endpoint returns unauthenticated state with `signupAllowed=false`. The public landing shows an invite-only notice and passkey sign-in; the signup form is hidden. A live uninvited signup probe returned 403 before proof creation or sending.
- Following the invitation link stays at `/join`, serves the app without the asset-canonicalization redirect, reveals invited enrollment and focuses its email field. Both confirmation inputs expose six-digit numeric/one-time-code attributes.
- Remote settings independently confirm every closed gate, exact origin/RP, dedicated D1 and sender allowlist. Production local-mailbox and alternate workers.dev endpoints return 404. Email-content previews remain disabled, and no secrets were rotated.
- Full isolated checks pass **232 tests**, formatting, recommended lint with warnings as errors, types and build. Actual workerd exercises hosted invited registration and native adapter fetches through contained fixtures. Actual isolated Wrangler/D1/Chromium signup and passkey sign-in verify quiet40 and account-default template saves with zero connections, including persistence after reload.
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

Existing users sign in with their passkey. To enroll someone new, run `mise run invite -- person@example.com`; they follow `/join`, confirm the exact invited address and create a passkey. Add an independent backup passkey, then connect only the services you use. Settings and account-default templates need no connections. LoTW connection import still requires the authorized personal P12/trust/status inputs. Keep all vendor exports disabled throughout this review; deployment authorization does not grant live-write authorization.


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
