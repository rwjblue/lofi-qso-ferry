# Native inventory rollout

- Build and test the bundled Worker with native D1 and Queue fixtures.
  Run the scoped and retention tests in [the release checklist](../ROADMAP.md).
- Prepare a fresh database with verified account, passkey, connection,
  template and credential access. Keep vendor uploads locked during
  replay and validation.
- Before changing the deployed writer, stop its sender and settle or
  quarantine every outstanding possibly sent attempt. The native
  database handoff checks old leases and unresolved attempt state.
- Verify current LoFi coverage and selected QRZ/LoTW windows. Check
  match and hold counts against the dashboard's scope. Inspect
  confirmation activity separately from delivery receipts.
- Exercise restore quarantine twice on a populated copy. Verify
  immutable attempt bytes, member receipts and linked credentials.
- Enable only a separately authorized provider and destination scope
  for a first live send. Confirm actual provider acceptance and exact
  readback before expanding it.
- Roll back by pausing sends while keeping the authoritative native
  recovery state available. A restored copy must stay quarantined
  until possibly sent work is reconciled.

[Operations](operations.md) · [Rehearsal and fresh-start evidence](evidence-inventory-fresh-start.md)
· [Delivery evidence](evidence-inventory-source-proof.md)
