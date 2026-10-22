# Implementation progress

Last checkpoint: 2026-10-22. Coordinator works on main; signed logical commits
are pushed directly with owner authorization. Do not open PRs or enable live
exports without the separate rollout authorization.

## Completed and evidence

- Read all product specs; root AGENTS.md/RTK.md absent. Applied inherited
  /Users/rwjblue/AGENTS.md and installed Codex RTK.md, commit-message,
  pr-description, jj/jj-commit, task, Cloudflare and Wrangler skills.
- Clean initial tree, main matched origin/main at 0c2ed55.
- Worker/TypeScript project; local/staging/production bindings separate;
  five-minute cron; exports disabled everywhere.
- D1 tenant constraints, encrypted private storage, versioned templates,
  immutable attempts/events, atomic checkpoint guards, fenced leases.
- Local D1/workerd tests prove checkpoint rollback, fencing, immutable attempts,
  fixed payload/version bindings and crash-to-uncertain behavior. Envelope tests
  prove tenant/purpose tamper rejection and KEK rewrap preserving ciphertext.
- Formatting/lint/typecheck and dry-run Worker build pass at foundation slice.

## Decisions and blockers

- Pin reviewed packages/lockfile. Miniflare uses exactly Wrangler's
  5.20261019.2-beta runtime; older npm latest carried fixed transitive issues.
- node-forge 1.4.0 has GHSA-86w9-cpqp-85rv and no fixed published version.
  Signer work must avoid its RSA certificate verifier and test strict platform
  verification; do not regard package audit as clean.
- No live credentials/test logbooks, production hostname, email sender,
  ARRL trust/status configuration or live-write authorization supplied.
- Source replay/absence and vendor mutation contracts need scoped live evidence;
  synthetic fixtures are never proof of those contracts.

## Active work / next action

- Coordinator: integrate adapters with source/reconciliation/scheduling and UI.
- LoFi adapter/projection reviewed: 17 fixtures pass; opaque independent cursors,
  tombstones, explicit clearing, boundary locations and per-destination hashes.
  Server replay guarantee remains unverified; missing-history exports stay blocked.
- LoFi agent: implementing passkey account flows.
- QRZ agent: adapter/ADIF/bounded templates ready; reconciliation and review next.
- Signer adapter/runtime vectors pass locally; implementing connection routes.
- Review/integrate each slice, meaningful checks, commit and push; update this log.

## QRZ adapter checkpoint

QRZ/ADIF/template modules reviewed; twenty focused tests pass. Fixed vendor hosts,
bounded bodies, strict empty/error handling, exact history matching and narrative
merge are implemented. No API duplicate predicate or live mutation claim is made.
Template profile supports the documented bounded subset and fails unsupported syntax.

## Signing checkpoint

Worker imports legacy/current P12 and matches OpenSSL signatures locally; no native
signer host. Strict WebCrypto verification rejects Forge advisory fixture. Query
inventories accepted unconfirmed contacts; upload ack stays submission evidence.
Production trust roots, real cert/status/readback and ARRL acceptance still needed.

## Accounts checkpoint

Seven focused auth checks and two bundled Worker HTTP E2E checks pass. Real
Chromium UI created a synthetic local account, reauthenticated, saved settings,
logged out and signed in via virtual passkey; 390px has no horizontal overflow.
No real signup email sent. qso-auth found existing OS-keychain QRZ/LoTW read
credentials; read-only protocol checks are in progress. No credentials copied to
repo files or tool output. LoFi/signing material and deployment inputs still absent.

## Live readback checkpoint

Bounded, authorized read-only probes used existing local credentials in memory.
LoFi same-client renewal/account/sync cursor/operation reads succeeded; existing
credential file unchanged. QRZ STATUS + bounded FETCH exposed actual date field
names, raw HTML-entity ADIF framing and unsupported explicit STATUS:ALL; fixed
against synthetic regressions. LoTW nonempty report parsed two unconfirmed QSOs;
ADIF allows outside-field annotations. No contact writes or permission emails.
Full source replay/snapshot semantics, complete owner reconciliation, real signing
certificate, live mutations, deployment/email/hardware measurements remain open.
