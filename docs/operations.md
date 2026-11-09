# Inventory operations

The checked-in Worker runs inventory in read-only mode and keeps the
export gates closed. Queue work is native inventory, comparison,
preparation, dispatch and receipt recovery. An environment pause
stops inventory scheduling while account maintenance remains available.

## Account access

Invite a user through the administrator console or the authenticated
CLI. The user verifies the invited address and registers a passkey.
Changing invitations and retention requires recent administrator
authentication. Follow the passwordless recovery and backup passkey
guidance before removing a credential. [Authentication](authentication.md)
· [Administrator controls](admin.md)

## Read-only setup

Link LoFi, then link the QRZ books and LoTW account needed for the log.
LoTW query access and signing authority are separate. Review source
coverage and destination windows before authorizing any upload. Scope
settings select historical, since-date or forward eligibility. Pause
new writes while investigating mismatches or held work.

## Uploads and cooldowns

Managed upload mode also requires rollout checks, explicit live-write
authorization, provider gates and a destination scope. Keep the scope
narrow for the first live runs. QRZ requires a fresh final collision
check and sends individual INSERTs. LoTW sends a signed compatible
cohort and resolves individual receipts. An uncertain claim stays
reserved until exact readback or explicit reconciliation settles it.

Ferry allows 60 requests per minute per provider for QRZ and LoTW.
Provider throttling can extend the shared cooldown. Distinguish local
budget waits from provider cooldown in admin before adjusting pacing.
LoFi uses its separate read budget and sync hints.
[Upload and recovery evidence](evidence-inventory-source-proof.md)

## Retention and rotation

The administrator's settled-state age defaults to 90 days. Native
cleanup preserves current unresolved work, durable ownership and
attempt evidence. Aged settled source bodies can cool to compact D1
replay markers. If the operator supplies an `INVENTORY_BODY_ARCHIVE`
binding, Ferry writes the encrypted body there before cooling. Keep
that archive consistent with its D1 backup. An unavailable body queues
isolated replay while ordinary checkpoints remain independent.

Rotate credentials and encryption keys with the old key material
available through verification. The Worker retains previous keys long
enough to reopen required evidence. [Credential security](security.md)

## Backup and restore

Capture account access, credentials, D1 state and any cold archive
required to read the retained references. Exercise restore on an
isolated copy. Apply the [restore lock](../ops/lock-restored.sql)
before making the restored Worker reachable. Recover or quarantine
possibly sent artifacts before allowing new uploads. Repeated
quarantine must preserve ownership and unresolved receipt evidence.
[Rollout checklist](rollout-checklist.md)
