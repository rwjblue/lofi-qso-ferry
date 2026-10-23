# Local development

Use [mise](https://mise.jdx.dev/) with the pinned Node 24.21.0 from `mise.toml`. The lockfile pins cryptography, passkey and tooling versions. A fresh checkout needs no Cloudflare, email, LoFi, QRZ, LoTW or Club Log credentials for automated checks.

```sh
mise install
mise run setup
mise run check
mise run demo
mise exec -- npm run dev -- --test-scheduled
```

`setup` installs locked dependencies, creates independent local secrets with file mode 0600 when `.dev.vars` is absent, generates Worker types, bundles the browser and applies every migration to local D1. It preserves existing secret values in `.dev.vars`, adding a blank optional `CLUBLOG_API_KEY` entry if missing; keep those KEKs while their encrypted local data remains useful. `.dev.vars`, `.wrangler`, build output and generated browser bundles are ignored by Git.

`check` covers formatting, lint, TypeScript (server, browser and scripts), all tests, browser bundling and a dry-run Worker build. `demo` builds the application and runs the actual local Worker E2E plus source-intake/delivery scenarios with synthetic authenticators and vendor fixtures. It uses isolated test data and does not create a persistent dashboard account. Neither task deploys or writes to a live vendor. `mise run db-local` remains available to apply local migrations separately. Use `mise exec --` for manual Node/npm commands if your shell does not activate project tool versions.

Open `http://localhost:8787` exactly: the fixed local origin/RP configuration does not accept `127.0.0.1` or an alternate port. Start signup with a synthetic address. In local mode only, verification codes appear in the browser-bound local mailbox shown during signup. Complete registration with a real discoverable passkey; later sign-ins use passkeys. Keep the explicit sign-in button available and register a second independent passkey. Browser support for synced providers, phone transport, backup keys and conditional autofill still needs the manual matrix in [authentication](authentication.md). Automated authenticators do not prove hardware/provider behavior.

Local email does not contact Resend. Staging/production cannot expose the local mailbox. LoFi connection approval is a separate vendor email flow: clicking it with real credentials makes a real vendor approval request. Export gates remain disabled in every checked-in environment. Synthetic adapter tests are the safe way to explore connections without live accounts.

To invoke one local cron cycle, with the dev server running:

```sh
curl --fail http://localhost:8787/health
curl --fail http://localhost:8787/__scheduled
```

The health response reports the deployment export gate. The dashboard shows pending work and exceptions. Normal logging has no operation-release control; eligible changes settle for 30 minutes by default (configurable from 20 to 60). A cron tick polls bounded source pages and processes a bounded contact/attempt set.

The dashboard's top counts describe the LoFi source index seen so far; destination adoption/delivery counts appear separately under Delivery activity. Read-only contact review works with no destination connection, reads only retained encrypted source data, and previews the selected saved template without creating an attempt or retaining extra raw data. Refresh review preserves unsaved editor/settings values. Run its contained fixture checks without vendor credentials:

```sh
mise exec -- npx tsx --test tests/review.test.ts tests/browser-dashboard.test.ts
```

Those tests check segment-aware station/location/reference/comment projection, tenant boundaries, retention and byte-for-byte database equality across review calls. Full `mise run check` also exercises the actual Worker HTTP route, single-service connection races and operation-read fairness. Fixture success establishes local behavior; it does not establish live source replay or vendor-write acceptance.

## Reproducible focused flows

```sh
npx tsx --test tests/worker-e2e.test.ts
npx tsx --test tests/signing-runtime.test.ts
npx tsx --test tests/auth.test.ts tests/connections.test.ts
npx tsx --test tests/lofi.test.ts tests/projection.test.ts tests/delivery.test.ts
npx tsx --test tests/reconcile.test.ts tests/store-reconcile.test.ts tests/store.test.ts
```

The Worker E2E bundles the actual service, applies migrations to workerd-backed D1, performs email-confirmed passkey registration/login using a synthetic authenticator, exercises the dashboard and security gates, and blocks outbound vendor access. The signing-runtime test imports both generated legacy/current PKCS#12 fixtures in actual workerd, verifies certificate chains and RSA/SHA-1 signatures against OpenSSL, and emits gzip TQ8. Delivery tests inject realistic QRZ/LoTW/Club Log responses for adoption, immutable outbox preparation, lost responses, corrections and separate submission/observation states. These are local contract checks; none proves live vendor acceptance.

The public synthetic key material under `fixtures/signing/` is intentionally committed and has no ARRL authority. [Its README](../fixtures/signing/README.md) reproduces the containers and vector. Never submit those contacts or import these synthetic credentials into a live account.

Use [operations](operations.md) for deployment, backups, rotation and the live rollout boundary. Protocol findings and remaining vendor inputs are recorded in `docs/evidence-*.md`; production writes stay disabled while their required checks remain unresolved.

For an explicitly authorized scoped read of existing vendor data, `mise run vendor-readonly -- PERSONA_NAME` uses the configured OS-keychain persona and emits only fixed boolean/count metadata. Its transport blocks mutations, derives a one-day LoTW query from one QRZ sample in memory, and stores no returned contacts. See [live read-only evidence](evidence-live-readonly.md) for the measured result and limits. This optional probe needs vendor credentials; the automated fixture suite does not.

Lint permits non-null assertions only in test fixtures, where assertions deliberately fail if a required fixture row is missing. Production code uses narrowed values. The CSS hidden-state declaration has one documented suppression so component display layouts cannot reveal hidden signup/dashboard panels. No runtime or integration checks are disabled.

For optional Club Log linking in local development, set `CLUBLOG_API_KEY` in ignored `.dev.vars` to the application developer key. User email/application passwords are entered through the connection form and stored encrypted. Leave the key blank when using synthetic tests; they inject credentials and responses and perform no live vendor requests.
