# Inventory release checks

The hosted Worker uses the native inventory scheduler. The checked-in
settings allow read-only reconciliation. Production activation is a
separate rollout.

- Verify all-history, since-date and forward-only scope through the
  scheduler, matching, preparation and final send guards. Exercise a
  scope change with work already queued.
- Qualify managed upload scheduling for both providers using native
  fixtures. Check explicit gates, fair selection, compatible LoTW
  batches, final duplicate checks and partial receipt recovery.
- Verify the 90-day administrator policy against aged, settled state.
  Preserve source identity, ownership, pending attempts and exact
  recovery evidence. Exercise an old operation edit after cooling.
- Rehearse a fresh database with account, passkey, connection, template
  and encrypted credential preservation. Resolve or quarantine any
  outstanding upload from the prior deployment before cutover.
- Run the full test suite and bundle the actual Worker. Review dashboard
  coverage and budget states using the same isolated runtime.
- Keep production exports closed until the scoped live rollout and
  restore checks are separately authorized.

[System design](docs/design.md) · [Native evidence](docs/capacity-plan.md)
