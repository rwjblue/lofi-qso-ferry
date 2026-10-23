# Implementation progress

Last checkpoint: 2026-10-22, LoFi connection passkey freshness fix deployed read-only. The owner authorizes signed logical commits directly to `origin/main`; no PRs. Every vendor export gate remains closed. This deployment does not authorize real logbook writes.

Current follow-up: explain LoFi's vendor-provided account name, enforce one current optional connection per service, and add a retained-source read-only review. Initial tree was clean; upstream unchanged. Aggregate production metadata confirms intake is working (first page: 97 contacts, 3 events, 86 live operations and 14 operation tombstones), with no destination/ledger/attempt yet. No source contents or credentials were read. Full `mise run check` passes **196 tests**, formatting, strict lint, both TypeScript checks and the Worker build (297.93 KiB gzip). Actual isolated Worker/D1 + Chromium resident/UV passkey signup/link/pause/resume/review passes: one fixture source, expected effective location/reference/comment, hidden duplicate form, duplicate API409, unchanged unsaved settings on review refresh, zero attempts/outbox and no uncontrolled vendor traffic. Mobile375px has no overflow or browser errors. Independent review caught and fixed stale failure diagnostics with exact lease fencing; deleted/failed/partial operation reads now yield fairly. Next: land the three reviewed logical slices, deploy with migration0008 and every gate closed, verify live metadata/assets and record the deployed version.

## Current production

- Host/RP: `https://ferry.n1rwj.com` / `ferry.n1rwj.com`. App revision `cbe9e63af1bf9215e2b87b75631f2effebd17e10`, Worker version `6a580035-ad08-4e35-9fa5-5d09fe5f9baf`; five-minute cron, workers.dev/previews disabled.
- Existing Cloudflare account `478f5e15ae2afa01364d19f42a3e06f2`; dedicated D1 `ferry-production` (`45ad64ad-92bb-491a-b6e6-1d2b17450144`) has all six migrations applied. No unrelated resources were changed.
- Remote settings read back `EXPORTS_ENABLED=false`, `ROLLOUT_CHECKS_PASSED=false`, `SOURCE_BOUNDARY_VERIFIED=false`, empty `LIVE_WRITE_AUTHORIZATION`, `ROLLOUT_QSO_IDS_JSON=[]`, and `LOTW_TRUST_ROOTS_JSON=[]`.
- Native `EMAIL` sender restricted to `signup@ferry.n1rwj.com`; sending DNS verified, existing Fastmail MX preserved, email-content previews disabled. Existing Wrangler OAuth includes Email Sending write access; no new credentials are needed for invites.
- Independent Worker secrets are preserved. Backup: `~/.config/lofi-qso-ferry/production.secrets.json`, mode 0600 inside 0700, outside Git. It was created while 1Password CLI was signed out; archive it securely before removing it. Never print or casually regenerate the keys.

## Implemented and committed

- Worker/D1 service with encrypted tenant credentials/bounded payloads, durable immutable outbox/leases, atomic intake checkpoints, conservative read-only adoption, per-contact quiet periods and real LoFi/QRZ/LoTW adapters.
- Effective operation/segment location handling, cursor gap/restart recovery, tombstones, source-birth/cutover proofs and forward-only templates pinned at first durable preparation; adopted QRZ narrative is preserved.
- In-Worker LoTW signing, separate submitted/observed/confirmed states, retained prior identities, encrypted KEK rotation and tested restore quarantine. One-contact immutable TQ8 artifacts are the v1 batch size.
- Email-confirmed, passkey-only accounts with tenant/session/recent-assertion guards; no inbox reset. Hosted signup now requires an exact-email seven-day invitation claimed atomically with the first passkey. Local signup retains its encrypted fixture mailbox.
- Styled HTML/plain-text verification and invitation messages; six-digit code subject, configured-host final line, one-time-code/numeric/paste/focus hints. Operator command: `mise run invite -- person@example.com`; `--dry-run` previews without granting access or sending.
- Mobile dashboard, optional independent connections and settings. Requested reference-labels/contact-notes COMMENT default, immutable account preferences saved without QRZ, new-book-only inheritance and existing-book version selection.
- Follow-up signed commits: settings `0f4a8c1a33bf`, adapter runtime fixes `d44e74f9cd3f`, invite/mail/UI `58a965d7c54d`. The runtime fixes use manual redirects and the global fetch receiver; Node-only mocks had hidden both failures.

## Verification and evidence

- Full `mise run check`: **180 tests**, formatting, recommended lint with warnings as errors, server/browser/script TypeScript and Worker build pass. [Deployed-code CI passed](https://github.com/rwjblue/lofi-qso-ferry/actions/runs/39887260462). Bundle 1545.91 KiB raw / 292.78 KiB gzip; deployment-reported startup 30 ms. These are not billed CPU/peak-memory/monthly-cost measurements.
- Actual workerd/D1 tests cover isolation, passkey cryptography, invitation expiry/atomic races, zero-write adoption, immutable templates, segment changes, retries/crashes, uncertain readback, signing vectors, revocation and restore. Native global-fetch adapter tests exercise successful requests plus redirect/opaque rejection through contained fixtures; no live vendors are contacted.
- Actual isolated Wrangler/D1 + Chromium virtual resident/UV passkey signup, sign-out/sign-in and zero-connection saves pass. Quiet period 40 and COMMENT preference persisted after reload. `/join` asset canonicalization was found and fixed. Mobile 375×812 has no horizontal overflow.
- Deployed Chromium confirms invite-only home, uninvited signup 403, `/join` retained/focused, code hints and no console errors. Health reports exports=false; local mailbox/alternate workers.dev return 404. All gates/RP/D1/sender/preview restrictions were independently checked through Cloudflare settings.
- Read-only remote D1 experiments show `--file` returns bulk-import summaries, while `--command --json` returns query rows. The invite task uses query results and validates the exact granted email/deadline before sending. Local D1 fixtures cover quoting, existing/claimed rejection and uncertain-send behavior. No live invitations were granted or sent during this follow-up.
- Initial deployment delivered a real verification email through the native provider; only fixed receipt metadata was inspected. New branded HTML was visually checked locally, not in real mail clients. Domain-bound formatting is documented by Apple for SMS; email-client/device autofill remains unverified.
- Earlier bounded live read-only LoFi/QRZ/LoTW probes passed; limits remain in `docs/evidence-*.md`. They do not prove complete history or safe writes. Signing matches independent OpenSSL vectors in workerd; no ARRL acceptance claim.
- node-forge 1.4.0 still has GHSA-86w9-cpqp-85rv without a patched release. Strict platform certificate verification and exploit regression avoid the affected verifier; dependency audit is not clean.

## Next action and rollout boundaries

Reload Ferry and use an existing passkey, or invite a new address with the task. Add an independent backup passkey; connect only desired services and review read-only adoption. No implementation/deployment blocker remains for this follow-up.

Keep exports disabled. Remaining acceptance inputs: exhaustive LoFi UUID/tombstone replay evidence, complete owner-history review, authorized LoTW P12/password/trust/status/station inputs, physical/synced-passkey and mail-client autofill checks, separately authorized scoped QRZ/LoTW writes, deployed resource/cost measurements and restore drill. Staging remains intentionally undeployed. See [deployment](docs/deployment.md) and [rollout checklist](docs/rollout-checklist.md).

## Current follow-up: LoFi connection freshness

- Initial tree clean at `8f122307852e`; upstream unchanged. Read-only production metadata confirmed the user's active session was beyond the five-minute recent-passkey window, with no LoFi connection saved. No source records or credentials were read or changed.
- Implemented automatic session/CSRF preflight and passkey assertion for protected connection/account actions; cancellation retains inputs and sends no protected request. Typed pre-dispatch auth errors permit one bounded retry; vendor, origin/CSRF and post-request failures never do. The original account and CSRF snapshot are pinned through concurrent refresh/retry.
- Focused client/backend checks pass; actual isolated Worker/Chromium verifies stale/fresh/canceled approval flows and real signature checks with contained vendor fixtures. Review added stale+invalid-CSRF ordering and preservation of an unverified add-passkey ceremony on a retryable freshness refusal.
- Full `mise run check` passes **180 tests**, formatting, strict lint, both TypeScript checks and Worker build (292.78 KiB gzip). Browser cancellation/retry, immutable CSRF/account snapshots, stale+invalid-CSRF precedence and add-key ceremony preservation have regression coverage.
- Signed/pushed `cbe9e63af1bf` and deployed it as Worker version `6a580035-ad08-4e35-9fa5-5d09fe5f9baf`. No migrations or secret changes. Live new-client asset, typed origin rejection, health and all closed export gates verified; no real vendor requests were made.
- Next operator action: refresh Ferry and request LoFi approval; use the existing passkey when prompted. The owner must complete that actual passkey/vendor approval flow; automated checks used contained vendor fixtures. Existing account data/passkeys/connections remain intact.
