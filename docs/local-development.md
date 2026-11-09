# Local development

Use [mise](https://mise.jdx.dev/) with the pinned Node 24.21.0 from `mise.toml`. The lockfile pins cryptography, passkey and tooling versions. A fresh checkout needs no Cloudflare, email, LoFi, QRZ or LoTW credentials for automated checks.

```sh
mise install
mise run setup
mise run check
mise run demo
mise exec -- npm run dev -- --test-scheduled
```

`setup` installs locked dependencies, creates independent local secrets with file mode 0600 when `.dev.vars` is absent, generates Worker types, bundles the browser and applies every migration to local D1. It preserves an existing `.dev.vars`; keep those KEKs while their encrypted local data remains useful. `.dev.vars`, `.wrangler`, build output and generated browser bundles are ignored by Git.

`check` covers formatting, lint, TypeScript (server, browser and scripts), all tests, browser bundling and a dry-run Worker build. `demo` builds the application and runs the actual local Worker E2E plus native inventory and delivery scenarios with synthetic authenticators and vendor fixtures. It uses isolated test data and does not create a persistent dashboard account. Neither task deploys or writes to a live vendor. `mise run db-local` remains available to apply local migrations separately. Use `mise exec --` for manual Node/npm commands if your shell does not activate project tool versions.

Open `http://localhost:8787` exactly: the fixed local origin/RP configuration does not accept `127.0.0.1` or an alternate port. Start signup with a synthetic address. In local mode only, verification codes appear in the browser-bound local mailbox shown during signup. Complete registration with a real discoverable passkey; later sign-ins use passkeys. Keep the explicit sign-in button available and register a second independent passkey. Browser support for synced providers, phone transport, backup keys and conditional autofill still needs the manual matrix in [authentication](authentication.md). Automated authenticators do not prove hardware/provider behavior.

Local email does not contact Resend. Staging/production cannot expose the local mailbox. LoFi connection approval is a separate vendor email flow: clicking it with real credentials makes a real vendor approval request. Export gates remain disabled in every checked-in environment. Synthetic adapter tests are the safe way to explore connections without live accounts.

To invoke one local cron cycle, with the dev server running:

```sh
curl --fail http://localhost:8787/health
curl --fail http://localhost:8787/__scheduled
```

The health response reports the deployment export gate. A cron tick
registers bounded inventory work and publishes Queue continuations.
The dashboard shows coverage, current match outcomes and delivery
activity per provider.

## Reproducible focused flows

```sh
mise exec -- npx tsx --test tests/worker-e2e.test.ts
mise exec -- npx tsx --test tests/inventory-hosted-worker.test.ts
mise exec -- npx tsx --test tests/inventory-lotw-batch.test.ts
mise run benchmark-inventory-ingestion
mise run benchmark-inventory-pipeline
```

The Worker tests exercise the bundled handler, native D1 and local
Queue delivery. Signing and readback tests use synthetic certificates
and provider responses. [Measurement boundaries](capacity-plan.md)

The public synthetic key material under `fixtures/signing/` is intentionally committed and has no ARRL authority. [Its README](../fixtures/signing/README.md) reproduces the containers and vector. Never submit those contacts or import these synthetic credentials into a live account.

Use [operations](operations.md) for deployment, backups, rotation and the live rollout boundary. Protocol findings and remaining vendor inputs are recorded in `docs/evidence-*.md`; production writes stay disabled while their required checks remain unresolved.

For an explicitly authorized scoped read of existing vendor data, `mise run vendor-readonly PERSONA_NAME` uses the configured OS-keychain persona and emits only fixed boolean/count metadata. Its transport blocks mutations, derives a one-day LoTW query from one QRZ sample in memory, and stores no returned contacts. See [live read-only evidence](evidence-live-readonly.md) for the measured result and limits. This optional probe needs vendor credentials; the automated fixture suite does not.

The isolated inventory foundation has a synthetic `mise run benchmark-inventory-ingestion` task and a bounded `mise run inventory-readonly-trial --page-size 1000 --pages 2` capture task. The latter makes real reads using saved credentials and stores encrypted records in a private local directory outside the repository; it never enters delivery. See [inventory ingestion evidence](evidence-inventory-ingestion.md) for measurements, authentication limits and remaining work. Neither task enables the new reader in the hosted scheduler.

Lint permits non-null assertions only in test fixtures, where assertions deliberately fail if a required fixture row is missing. Production code uses narrowed values. The CSS hidden-state declaration has one documented suppression so component display layouts cannot reveal hidden signup/dashboard panels. No runtime or integration checks are disabled.
