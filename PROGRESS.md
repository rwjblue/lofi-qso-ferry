# Implementation progress

Last checkpoint: 2026-10-22. Work is coordinated on `main`; the owner authorized signed logical commits directly to `origin/main`. No PRs. Live vendor writes require separate explicit authorization and the documented rollout checks.

## Implemented

- Worker/D1 service, encrypted per-tenant credentials/payloads, versioned templates, immutable attempts, leases/fencing, atomic intake checkpoints, conservative adoption, per-contact quiet periods and real vendor adapters.
- Email-confirmed signup and passkey-only sessions; recent assertion guards for connections/account changes; no inbox reset or alternate login.
- LoFi cursor restart/gap recovery, operation/segment rereads, null-operation contacts, tombstones, bounded buffers and source-birth/cutover proofs. Expired context recovery preserves in-progress pagination.
- QRZ narrative preservation and first-prepared template pinning; LoTW in-Worker signing, separate submitted/observed/confirmed states, retained prior identities and confirmation scoping.
- Mobile dashboard, connection approval/import/renewal/disable/revoke, template/settings/passkey management, encrypted KEK rotation, resolved-source purge and executable restore quarantine.
- Reproducible setup/demo/check tasks, CI configuration, operational and rollout runbooks. Every checked-in environment disables exports; no real logbook entries changed.

## Verification and decisions

- Actual local workerd/D1 tests cover isolation, passkeys, zero-write adoption, template versions, segments/location changes, cursor gaps, crashes, retries, uncertain readback, signing vectors, revocations and restore. Final `mise run check` passes formatting, recommended lint with warnings as errors, server/browser TypeScript, all **146 tests**, and the Worker build. `mise run demo` passes **24 tests**.
- Fresh `mise run setup` installed pinned Node 24.21.0 dependencies and applied all four migrations. Chromium virtual resident/UV passkey completed signup, settings 40, connection disable/revoke, reauth and explicit login. At 390×844: no horizontal overflow and dashboard scroll starts at 0. Local health and scheduled endpoint passed with exports disabled.
- Bounded live read-only LoFi, QRZ and LoTW probes passed; evidence and exact limits are in `docs/evidence-*.md`. They do not establish complete history or safe writes.
- Final bundle: **1,534.84 KiB raw / 290.24 KiB gzip**; local startup profile 80.4 ms window, 49.1 ms active samples. Workerd cold dispatch plus two imports/signatures: 362 ms wall; two 1,526-byte synthetic TQ8 artifacts. These are not deployed billed CPU/peak-memory or ARRL acceptance.
- `ferry-liquid-v1` is an explicit bounded compatibility profile. One-contact immutable TQ8 artifacts are the v1 batch size. Local signing matches independent OpenSSL vectors; no native production signer.
- node-forge 1.4.0 has GHSA-86w9-cpqp-85rv with no patched published release. Never use its RSA certificate verifier: strict platform verification and an exploit regression are required and implemented. Package audit is not clean.
- Inspected the initially clean tree at 0c2ed55; all changes are from this run. Read product docs and inherited AGENTS/RTK instructions; applied commit-message, PR-description, jj/jj-commit, task, Cloudflare/Workers/Wrangler and browser skills.

## Live/deployment blockers

See [exact rollout inputs](docs/rollout-checklist.md). Required: Cloudflare target/D1 IDs, final RP/hostname, verified Resend sender/secrets, authoritative LoFi exhaustive UUID/tombstone replay evidence, real LoTW P12/password/trust/status/station inputs, designated test records and explicit scoped write authorization, owner-history review, physical/synced-browser matrix and deployed resource/cost measurements. Existing keychain credentials enabled bounded reads; no personal keys or logs are committed.

## Next action

Implementation, independent reviews and local acceptance are complete. The integrated service is signed/pushed at `feec4b425a77`; the following documentation checkpoint records the handoff. Verify the latest `main` CI run, then resume with the exact rollout inputs and authorization in the checklist. Keep all production gates closed until those checks pass. Do not infer vendor behavior from fixture success or reset unresolved state to force a write.
