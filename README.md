# LoFi QSO Ferry

Automatic, one-way delivery of Ham2K LoFi contacts to QRZ and ARRL Logbook of The World (LoTW).

Log in PoLo or HaLo, let the contact settle, and Ferry handles delivery and subsequent corrections. The service runs on Cloudflare Workers with D1, supports multiple independent users, and keeps a small delivery ledger instead of a permanent copy of everyone's logbook.

**Status: v1 implemented and locally verified; production deployment and live exports remain gated.** The initial release is for the repository owner's use, with tenant isolation built in from the beginning. See the [rollout checklist](docs/rollout-checklist.md) for exact remaining inputs and verification boundaries.

## Product decisions

- **Live exports:** poll every five minutes, with a default 30-minute quiet period per changed contact and destination. No operation-complete button is required. Continued logging does not hold earlier stable contacts back.
- **Existing history:** first inventory and adopt contacts already at each destination without rewriting them. Separately backfill contacts whose current identity is absent after complete readback and a fresh check. Ambiguous or unavailable history stays visible and unsent.
- **Templates go forward only:** a contact pins its QRZ template version when its first validated export is durably prepared. Later template changes do not revisit history. Existing contacts adopted from QRZ retain their remote narrative.
- **Email-confirmed signup; passkey-only login:** email ownership allows initial registration, then all sign-ins use a passkey. Register a second passkey or use a recoverable synced provider; v1 has no email account-reset path.
- **Correct operating location:** resolve the station callsign, activation references, and location for each contact, including operation segments. Route QRZ to the appropriate logbook and LoTW to the appropriate certificate and station data.
- **Hosted signing:** import and encrypt the user's LoTW certificate/private key and sign inside the Worker. Synthetic signing vectors and actual local workerd execution pass. Scoped ARRL acceptance and deployed resource measurements remain rollout checks.
- **Small retained state:** store source IDs, destination associations, versioned hashes, immutable template bindings, encrypted credentials, and bounded temporary delivery/reconciliation data.

LoTW has no supported narrative destination for QRZ-style comments or POTA text. Ferry will include the operator's activated park in QRZ templates and transmit LoTW's supported station/location fields. See the [destination contracts](docs/design.md#destination-contracts) and their primary references for update limitations.

## Documentation

| Document                                             | Purpose                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [Roadmap](ROADMAP.md)                                | Ordered implementation tasks, dependencies, and acceptance criteria for local agents |
| [System design](docs/design.md)                      | Source intake, scheduling, minimal state, destination adapters, and direct signing   |
| [Existing-history reconciliation](docs/bootstrap.md) | Read-only adoption, missing records, cutover, and incomplete evidence                |
| [Templates](docs/templates.md)                       | HaLo compatibility, immutable versions, and preservation of adopted QRZ text         |
| [Authentication](docs/authentication.md)             | Email confirmation, passkeys, sessions, and recovery boundaries                      |
| [Credential security](docs/security.md)              | Encryption, key rotation, tenant isolation, and retention                            |

## Run locally

Install [mise](https://mise.jdx.dev/), then run:

```sh
mise trust
mise install
mise run setup
mise run check
mise run demo
mise exec -- npm run dev -- --test-scheduled
```

Open `http://localhost:8787`. Signup uses a browser-bound local mailbox and a discoverable passkey. Setup creates local secrets only if absent and migrates local D1; no vendor credentials are needed. The demo exercises the actual bundled Worker and realistic vendor fixtures without external writes. See [local development](docs/local-development.md) for focused checks and [operations](docs/operations.md) for deployment, recovery and export gates.

The dashboard manages connections, immutable QRZ template versions, passkeys and the 20–60 minute quiet period. Cron processes contacts automatically, including operation/segment corrections, without an operation-release step. Signing runs inside the Worker; submission, observed acceptance and confirmation remain separate states.

[Live read-only evidence](docs/evidence-live-readonly.md) verifies bounded existing-account reads from LoFi, QRZ and LoTW. These reads do not establish complete historical absence or mutation compatibility. No existing log was modified. Production exports require verified source boundaries, rollout checks, explicit live-write authorization and a scoped QSO allowlist. All checked-in environments disable exports.

The roadmap distinguishes completed implementation from blocked vendor, hardware and deployment checks. Primary sources and experiments were checked on 2026-10-22.

## License

[MIT](LICENSE). Reused upstream code must retain its own required notices; the MIT-licensed HaLo SDK and the separately licensed HaLo application/exporter are not interchangeable licensing scopes.
