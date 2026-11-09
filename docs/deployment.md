# Deploying native inventory

Production deployment is a separate operation from local development and
tests. Earlier deployment checkpoints and provider pilots remain in
repository history. Use the native restore and rollout checks for the
current Worker.

## Prepare

- Verify Worker bindings and the permanent passkey hostname in
  [the configuration](../wrangler.jsonc). Keep environments, database
  instances, queue bindings and secret material separate.
- Build the Worker and browser assets with the pinned tools. Generate
  types and run the native D1 and Queue tests.
- Take a protected backup. Rehearse an isolated account-only rebuild
  with account access, templates and encrypted credentials. Stop the
  previous sender and settle or quarantine any possibly sent attempt
  before activating the new writer.
- Apply the read-only migration and deployment procedure only after
  approval. The deploy-readonly task requires the read-only runtime and
  every closed export control before its remote commands.

## Verify

Check the health endpoint, passkey access, admin coverage and provider
scopes. Confirm scheduled source discovery and Queue continuations
against the chosen destinations. Reopen the backup under restore
quarantine and compare ownership, attempt evidence and member receipts.
A managed live rollout requires a separate explicit authorization
and provider-specific qualification.

[Operations](operations.md) · [Rollout checklist](rollout-checklist.md)
· [Fresh-start evidence](evidence-inventory-fresh-start.md)
