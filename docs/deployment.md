# Read-only production deployment

Verified 2026-10-22 at [https://ferry.n1rwj.com](https://ferry.n1rwj.com). The owner selected this permanent hostname. Vendor exports remain disabled; no real logbook entries were changed.

| Resource                 | Current value                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Cloudflare account       | `478f5e15ae2afa01364d19f42a3e06f2` (existing account)                                                                    |
| Worker                   | `lofi-qso-ferry`, environment `production`                                                                               |
| Deployed source revision | `cbe9e63af1bf9215e2b87b75631f2effebd17e10`                                                                               |
| Worker version           | `6a580035-ad08-4e35-9fa5-5d09fe5f9baf`                                                                                   |
| Origin / passkey RP      | `https://ferry.n1rwj.com` / `ferry.n1rwj.com`                                                                            |
| Dedicated D1             | `ferry-production`, `45ad64ad-92bb-491a-b6e6-1d2b17450144`, ENAM                                                         |
| Migrations               | `0001_foundation`, `0002_auth`, `0004_intake`, `0005_cutover`, `0006_account_templates`, `0007_invitations`, all applied |
| Sender                   | Native Cloudflare `EMAIL`, restricted to `signup@ferry.n1rwj.com`                                                        |
| Sending domain           | `ferry.n1rwj.com`, tag `e69af8ef82a140b38eeaef98d417ef30`, content previews disabled                                     |
| Schedule                 | `*/5 * * * *`                                                                                                            |
| Alternate origins        | workers.dev and version previews disabled                                                                                |
| Artifact                 | 1,545.91 KiB raw / 292.78 KiB gzip; Cloudflare-reported startup 30 ms                                                    |

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
- Full local checks pass **180 tests**, formatting, recommended lint with warnings as errors, types and build. [CI passes for the deployed code](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39887260462). Actual workerd exercises hosted invited registration and native adapter fetches through contained fixtures. Actual isolated Wrangler/D1/Chromium signup and passkey sign-in verify quiet40 and account-default template saves with zero connections, including persistence after reload.
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
