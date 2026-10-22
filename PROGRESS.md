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
