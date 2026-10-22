# LoFi QSO Ferry

Automatic, one-way delivery of Ham2K LoFi contacts to QRZ and ARRL Logbook of The World (LoTW).

Log in PoLo or HaLo, let the contact settle, and Ferry handles delivery and subsequent corrections. The intended service runs on Cloudflare Workers with D1, supports multiple independent users, and keeps a small delivery ledger instead of a permanent copy of everyone's logbook.

**Status: design and implementation roadmap. No service is implemented or deployed yet.** The initial release is for the repository owner's use, with tenant isolation built in from the beginning.

## Product decisions

- **Live exports:** poll every five minutes, with a proposed 30-minute quiet period per changed contact and destination. No operation-complete button is required. Continued logging does not hold earlier stable contacts back.
- **Existing history:** first inventory and adopt contacts already at each destination without rewriting them. Separately backfill contacts whose current identity is absent after complete readback and a fresh check. Ambiguous or unavailable history stays visible and unsent.
- **Templates go forward only:** a contact pins its QRZ template version when its first validated export is durably prepared. Later template changes do not revisit history. Existing contacts adopted from QRZ retain their remote narrative.
- **Email-confirmed signup; passkey-only login:** email ownership allows initial registration, then all sign-ins use a passkey. Register a second passkey or use a recoverable synced provider; v1 has no email account-reset path.
- **Correct operating location:** resolve the station callsign, activation references, and location for each contact, including operation segments. Route QRZ to the appropriate logbook and LoTW to the appropriate certificate and station data.
- **Hosted signing:** import and encrypt the user's LoTW certificate/private key and sign inside the Worker. A compatibility spike must prove this; a separate signer host or native TQSL production process is not part of the proposed design.
- **Small retained state:** store source IDs, destination associations, versioned hashes, immutable template bindings, encrypted credentials, and bounded temporary delivery/reconciliation data.

LoTW has no supported narrative destination for QRZ-style comments or POTA text. Ferry will include the operator's activated park in QRZ templates and transmit LoTW's supported station/location fields. See the [destination contracts](docs/design.md#destination-contracts) and their primary references for update limitations.

## Documentation

| Document | Purpose |
| --- | --- |
| [Roadmap](ROADMAP.md) | Ordered implementation tasks, dependencies, and acceptance criteria for local agents |
| [System design](docs/design.md) | Source intake, scheduling, minimal state, destination adapters, and direct signing |
| [Existing-history reconciliation](docs/bootstrap.md) | Read-only adoption, missing records, cutover, and incomplete evidence |
| [Templates](docs/templates.md) | HaLo compatibility, immutable versions, and preservation of adopted QRZ text |
| [Authentication](docs/authentication.md) | Email confirmation, passkeys, sessions, and recovery boundaries |
| [Credential security](docs/security.md) | Encryption, key rotation, tenant isolation, and retention |

## Starting implementation

Read the design and the first roadmap milestone before introducing an application framework. The main uncertainties are LoFi change/cursor behavior, QRZ replacement identity, and LoTW signing compatibility in the actual Worker runtime. Resolve them with fixtures and focused adapters before integrating automatic delivery. Record evidence and any necessary design changes in the repository.

The roadmap distinguishes settled product decisions from implementation proposals and unverified protocol behavior. External source links are pinned where practical; the initial research was checked on 2026-10-22.

## License

[MIT](LICENSE). Reused upstream code must retain its own required notices; the MIT-licensed HaLo SDK and the separately licensed HaLo application/exporter are not interchangeable licensing scopes.
