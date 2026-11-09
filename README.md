# LoFi QSO Ferry

Ferry reconciles Ham2K LoFi contacts with QRZ and ARRL Logbook of The
World (LoTW). It inventories relevant remote windows, recognizes
existing contacts, and prepares guarded uploads for eligible missing
records. It runs on Cloudflare Workers, D1 and Queues.

Checked-in environments run read-only inventory with vendor exports
closed. The upload path uses one QRZ INSERT per contact and signed
LoTW files with up to 100 compatible contacts. Dispatch and receipt
recovery are separate states.

## Local development

~~~sh
mise trust
mise install
mise run setup
mise run check
mise run demo
mise exec -- npm run dev -- --test-scheduled
~~~

Open http://localhost:8787. Local signup uses the browser-bound mailbox
and a discoverable passkey. The demo uses isolated data and synthetic
vendor responses. [Local setup and native checks](docs/local-development.md)

## Account setup

Hosted signup requires an invitation and email verification. Subsequent
sign-ins use a passkey. Register a second independent passkey, then link
LoFi and the destinations you want to use. The dashboard shows source
coverage, destination matches, review holds and delivery activity.

An administrator can issue an invitation with the existing authenticated
Cloudflare CLI. Preview with the dry-run flag.

~~~sh
mise run invite -- --dry-run person@example.com
mise run invite -- person@example.com
~~~

[Authentication](docs/authentication.md) · [Admin console](docs/admin.md)

## Documentation

- [System design](docs/design.md)
- [Sync scope and historical reconciliation](docs/bootstrap.md)
- [Inventory and delivery design](docs/inventory-reconciliation-design.md)
- [Capacity and measurement boundaries](docs/capacity-plan.md)
- [Release checks](ROADMAP.md)
- [Templates](docs/templates.md) · [Credential security](docs/security.md)

## License

[MIT](LICENSE). Upstream code retains its own license and notices.
