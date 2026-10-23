# Read-only production deployment

Verified 2026-10-22 at [https://ferry.n1rwj.com](https://ferry.n1rwj.com). The owner selected this permanent hostname. Vendor exports remain disabled; no real logbook entries were changed.

| Resource                 | Current value                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------ |
| Cloudflare account       | `478f5e15ae2afa01364d19f42a3e06f2` (existing account)                                |
| Worker                   | `lofi-qso-ferry`, environment `production`                                           |
| Deployed source revision | `f9856fdefa47e647da945f55a0059ce9323a10b7`                                           |
| Worker version           | `00466132-9db4-467a-ae4d-caa5d13abfda`                                               |
| Origin / passkey RP      | `https://ferry.n1rwj.com` / `ferry.n1rwj.com`                                        |
| Dedicated D1             | `ferry-production`, `45ad64ad-92bb-491a-b6e6-1d2b17450144`, ENAM                     |
| Migrations               | `0001_foundation`, `0002_auth`, `0004_intake`, `0005_cutover`, all applied           |
| Sender                   | Native Cloudflare `EMAIL`, restricted to `signup@ferry.n1rwj.com`                    |
| Sending domain           | `ferry.n1rwj.com`, tag `e69af8ef82a140b38eeaef98d417ef30`, content previews disabled |
| Schedule                 | `*/5 * * * *`                                                                        |
| Alternate origins        | workers.dev and version previews disabled                                            |
| Artifact                 | 1,535.35 KiB raw / 290.41 KiB gzip; Cloudflare-reported startup 41 ms                |

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

- HTTPS UI and static assets load in Chromium with no console errors; secure context confirmed. At 390×844 there is no horizontal overflow.
- Session endpoint returns unauthenticated state; discoverable authentication options use `rpId=ferry.n1rwj.com`, `userVerification=required` and no credential allowlist.
- Production local-mailbox endpoint returns 404 and exposes no messages. The alternate workers.dev health path returns 404.
- The live signup form sent one confirmation to the owner's existing Cloudflare account address. Fastmail search confirmed the sender, subject and receipt time; code/body content was not printed or stored in repository artifacts. Cloudflare email-content previews were disabled before this send.
- No production passkey/account was enrolled. A read-only D1 count query showed zero accounts, connections, ledger rows, attempts and local mailbox rows. The uncompleted email proof expires normally.
- Full local checks pass 149 tests, formatting, recommended lint with warnings as errors, types and build. [CI passes for the deployed code](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39880597020). Native email failure/local/optional-Resend cases use fixtures; the real delivered message separately verifies the deployed provider path.

The reported startup is deployment evidence, not per-request billed CPU or peak memory. No representative monthly workload/cost has been measured. Physical and synced passkey behavior remains for the owner to verify at this permanent origin. See [rollout acceptance](rollout-checklist.md) for the remaining vendor checks.

## Reproduce deployment

```sh
mise run check
mise run deploy-readonly
```

The deploy task builds the dashboard, refuses any open export gate, validates the permanent origin and D1 configuration, applies pending migrations to the dedicated production database, then deploys. It preserves provisioned secrets. Staging is intentionally a placeholder and remains undeployed.

Independent `KEK_V1`, `AUTH_SECRET` and `EMAIL_CODE_SECRET` are installed as Worker secrets. A protected local backup is at `~/.config/lofi-qso-ferry/production.secrets.json`, file mode 0600 in a 0700 directory outside Git. Preserve it until archived in the operator's secret manager; 1Password CLI was signed out during deployment. Do not print it, commit it, reuse local development secrets or rotate the KEK without preserving encrypted-data access. See [operations](operations.md) for rotation and restore quarantine.

## Owner's next step

Start a fresh signup in your own browser, confirm its email and enroll a real discoverable passkey. Add an independent backup passkey, then connect LoFi/QRZ to review read-only adoption. LoTW connection import still requires the authorized personal P12/trust/status inputs. Keep all vendor exports disabled throughout this review; deployment authorization does not grant live-write authorization.
