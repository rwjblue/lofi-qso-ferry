# Implementation progress

Last checkpoint: 2026-10-22, read-only production deployment. Work is coordinated on `main`; the owner authorized signed logical commits directly to `origin/main`. No PRs. Live vendor writes require separate explicit authorization and the documented rollout checks.

## Implemented

- Worker/D1 service, encrypted per-tenant credentials/payloads, versioned templates, immutable attempts, leases/fencing, atomic intake checkpoints, conservative adoption, per-contact quiet periods and real vendor adapters.
- Email-confirmed signup and passkey-only sessions; recent assertion guards for connections/account changes; no inbox reset or alternate login.
- LoFi cursor restart/gap recovery, operation/segment rereads, null-operation contacts, tombstones, bounded buffers and source-birth/cutover proofs. Expired context recovery preserves in-progress pagination.
- QRZ narrative preservation and first-prepared template pinning; LoTW in-Worker signing, separate submitted/observed/confirmed states, retained prior identities and confirmation scoping.
- Mobile dashboard, connection approval/import/renewal/disable/revoke, template/settings/passkey management, encrypted KEK rotation, resolved-source purge and executable restore quarantine.
- Reproducible setup/demo/check tasks, CI configuration, operational and rollout runbooks. Every checked-in environment disables exports; no real logbook entries changed.

## Verification and decisions

- Actual local workerd/D1 tests cover isolation, passkeys, zero-write adoption, template versions, segments/location changes, cursor gaps, crashes, retries, uncertain readback, signing vectors, revocations and restore. Final `mise run check` passes formatting, recommended lint with warnings as errors, server/browser TypeScript, all **149 tests**, and the Worker build. `mise run demo` passes **24 tests**.
- Fresh `mise run setup` installed pinned Node 24.21.0 dependencies and applied all four migrations. Chromium virtual resident/UV passkey completed signup, settings 40, connection disable/revoke, reauth and explicit login. At 390×844: no horizontal overflow and dashboard scroll starts at 0. Local health and scheduled endpoint passed with exports disabled.
- Bounded live read-only LoFi, QRZ and LoTW probes passed; evidence and exact limits are in `docs/evidence-*.md`. They do not establish complete history or safe writes.
- Pre-deployment local profiling checkpoint: **1,534.84 KiB raw / 290.24 KiB gzip**; startup profile 80.4 ms window, 49.1 ms active samples. Workerd cold dispatch plus two imports/signatures: 362 ms wall; two 1,526-byte synthetic TQ8 artifacts. These are not deployed billed CPU/peak-memory or ARRL acceptance.
- `ferry-liquid-v1` is an explicit bounded compatibility profile. One-contact immutable TQ8 artifacts are the v1 batch size. Local signing matches independent OpenSSL vectors; no native production signer.
- node-forge 1.4.0 has GHSA-86w9-cpqp-85rv with no patched published release. Never use its RSA certificate verifier: strict platform verification and an exploit regression are required and implemented. Package audit is not clean.
- Inspected the initially clean tree at 0c2ed55; all changes are from this run. Read product docs and inherited AGENTS/RTK instructions; applied commit-message, PR-description, jj/jj-commit, task, Cloudflare/Workers/Wrangler and browser skills.

## Read-only production checkpoint

- User selected `https://ferry.n1rwj.com`; RP matches that exact hostname. Reused Cloudflare account `478f5e15ae2afa01364d19f42a3e06f2` and native Email Service conventions. Dedicated D1 `ferry-production` (`45ad64ad-92bb-491a-b6e6-1d2b17450144`) has all four migrations applied.
- Deployed code `f9856fdefa47`, Worker version `00466132-9db4-467a-ae4d-caa5d13abfda`; custom domain + five-minute cron active. workers.dev and preview URLs disabled. All five gates read back closed; LoTW trust roots remain empty.
- Three independent secrets provisioned; backup `~/.config/lofi-qso-ferry/production.secrets.json` has mode 0600 inside a 0700 directory, outside Git. 1Password CLI was signed out; retain this backup and securely archive it in the operator’s secret manager before removing it. Never regenerate keys casually or print contents.
- Native Cloudflare EMAIL binding is restricted to `signup@ferry.n1rwj.com`. Dedicated sending DNS resolves via independent DoH providers; existing Fastmail MX preserved; content previews explicitly false.
- Full local check now passes **149 tests**, recommended lint/types/format/build; deployed code [CI passed](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39880597020). Bundle 290.41 KiB gzip; Cloudflare-reported startup 41 ms, not a billed-CPU/peak-memory measurement.
- Live health/session, exact RP + required UV/discoverable options, production mailbox 404, mobile 390px/no overflow and real signup email delivery to the owner’s inbox passed. Only fixed email metadata was inspected. Remote DB has zero accounts/connections/ledger rows/attempts/local mailbox rows. No real logs changed.

## Remaining acceptance and next action

Owner: open Ferry in their own browser, start a fresh signup, enroll a real passkey and independent backup key, then link LoFi/QRZ for read-only adoption. The verification smoke test created no account and its code belongs to the test browser. Do not enroll virtual authenticators in production or bypass recent-passkey guards to preload credentials.

Keep all vendor exports disabled. Remaining rollout evidence: exhaustive LoFi UUID/tombstone replay contract, full owner-history review, authorized LoTW P12/password/trust/status/station inputs, physical/synced-browser matrix, scoped QRZ/LoTW live-write authorization/tests, deployed resource/cost measurements and restore drill. See [deployment evidence](docs/deployment.md) and [rollout checklist](docs/rollout-checklist.md). Staging remains intentionally undeployed. This read-only deployment does not authorize export enablement.
