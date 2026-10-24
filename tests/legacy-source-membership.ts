/**
 * Frozen pre-0030 Worker claim check from ce238cdcfea7. This fixture preserves
 * the transitional 0026 migration contract; it must never authorize runtime
 * exports. Current preparation/dispatch requires immutable source proofs and
 * is covered by source-export-guards.test.ts and delivery-source-proof.test.ts.
 */
import type { DestinationIdentityClaim } from "../src/identity-claims.ts";
import { canonical, randomToken, sha256 } from "../src/security.ts";
import type { Lease, LedgerKey, Store } from "../src/store.ts";

/** Original stage transaction for the isolated pre-0030 migration fixtures.
 * Current Store.stage also requires immutable ownership evidence. This helper
 * must never run against the current source-proof/ownership schema.
 */
export async function legacyStageAttempt(
  store: Store,
  key: LedgerKey,
  generation: string,
  payload: unknown,
  credentialVersion: string,
  expectedTemplate: string | null,
  now: number,
  identity: { claim: DestinationIdentityClaim; sourceVersion: number },
) {
  if (
    await store
      .statement(
        "SELECT 1 FROM sqlite_schema WHERE name='source_export_proofs_current'",
      )
      .first()
  )
    throw new Error("legacy stage requires the isolated pre-0030 schema");
  const id = randomToken();
  const encrypted = await store.putPrivate(
    key.tenant,
    key.destination,
    id,
    "outbox",
    payload,
    now + 7 * 86400_000,
  );
  await store.db.batch([
    store.statement(
      "INSERT INTO stage_guards(id,tenant,source,qso,destination,generation,template_version,now,credential_version,identity_vendor,identity_hash,identity_source_version,identity_lotw_owner_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      key.tenant,
      key.source,
      key.qso,
      key.destination,
      generation,
      expectedTemplate,
      now,
      credentialVersion,
      identity.claim.vendor,
      identity.claim.hash,
      identity.sourceVersion,
      identity.claim.vendor === "lotw"
        ? `identity:${await sha256(canonical([key.source, key.qso]))}:${identity.claim.hash}`
        : null,
    ),
    encrypted,
    store.statement(
      "INSERT INTO attempts SELECT ?,?,?,?,?,?,?,?,?,?,?,source_hash FROM ledger WHERE tenant=? AND source=? AND qso=? AND destination=?",
      key.tenant,
      id,
      key.source,
      key.qso,
      key.destination,
      generation,
      id,
      await sha256(canonical(payload)),
      expectedTemplate,
      credentialVersion,
      now,
      key.tenant,
      key.source,
      key.qso,
      key.destination,
    ),
    store.statement(
      "INSERT INTO attempt_state(tenant,attempt,state,due_at,updated_at,priority) VALUES(?,?,'prepared',?,?,'live')",
      key.tenant,
      id,
      now,
      now,
    ),
    store.statement(
      "INSERT INTO attempt_identity_claims(tenant,attempt,destination,vendor,identity_hash,source,qso,source_version) VALUES(?,?,?,?,?,?,?,?)",
      key.tenant,
      id,
      key.destination,
      identity.claim.vendor,
      identity.claim.hash,
      key.source,
      key.qso,
      identity.sourceVersion,
    ),
    store.statement(
      "INSERT INTO attempt_events(tenant,attempt,state,at) VALUES(?,?,'prepared',?)",
      key.tenant,
      id,
      now,
    ),
    store.statement(
      "UPDATE ledger SET narrative=CASE WHEN narrative='unbound' AND ? IS NOT NULL THEN 'template_bound' ELSE narrative END,template_version=? WHERE tenant=? AND source=? AND qso=? AND destination=?",
      expectedTemplate,
      expectedTemplate,
      key.tenant,
      key.source,
      key.qso,
      key.destination,
    ),
    store.statement("DELETE FROM stage_guards WHERE id=?", id),
  ]);
  return id;
}

export async function legacyClaimedAttemptCurrent(
  store: Store,
  tenant: string,
  attempt: string,
  claim: DestinationIdentityClaim,
  now: number,
  lease?: Lease,
): Promise<boolean> {
  if (lease && lease.tenant !== tenant) return false;
  const dependencies = `NOT EXISTS(SELECT 1 FROM legacy_outbound_identity_reservations r WHERE r.tenant=a.tenant AND r.destination=a.destination) AND EXISTS(SELECT 1 FROM private_data sc WHERE sc.tenant=src.tenant AND sc.connection=src.id AND sc.id=src.credential_version AND sc.kind='credential' AND sc.revoked_at IS NULL AND (sc.expires_at IS NULL OR sc.expires_at>?)) AND (l.context_generation IS NULL OR l.operation_id IS NULL OR EXISTS(SELECT 1 FROM source_work o JOIN private_data op ON op.tenant=o.tenant AND op.connection=o.source AND op.id=o.private_id AND op.kind='source' WHERE o.tenant=l.tenant AND o.source=l.source AND o.id=l.operation_id AND o.kind='operation' AND o.state='context' AND o.deleted=0 AND o.expires_at>? AND op.revoked_at IS NULL AND (op.expires_at IS NULL OR op.expires_at>?) AND NOT EXISTS(SELECT 1 FROM source_work e LEFT JOIN private_data ep ON ep.tenant=e.tenant AND ep.connection=e.source AND ep.id=e.private_id AND ep.kind='source' WHERE e.tenant=o.tenant AND e.source=o.source AND e.operation_id=o.id AND e.kind='qso' AND e.is_event=1 AND e.deleted=0 AND (e.expires_at<=? OR ep.id IS NULL OR ep.revoked_at IS NOT NULL OR (ep.expires_at IS NOT NULL AND ep.expires_at<=?)))))`;
  return Boolean(
    await store
      .statement(
        `SELECT 1 owned FROM attempts a JOIN attempt_identity_claims i ON i.tenant=a.tenant AND i.attempt=a.id AND i.destination=a.destination AND i.source=a.source AND i.qso=a.qso JOIN destination_identity_claims c ON c.tenant=i.tenant AND c.destination=i.destination AND c.vendor=i.vendor AND c.identity_hash=i.identity_hash AND c.source=i.source AND c.qso=i.qso JOIN attempt_state st ON st.tenant=a.tenant AND st.attempt=a.id JOIN ledger l ON l.tenant=a.tenant AND l.source=a.source AND l.qso=a.qso AND l.destination=a.destination JOIN connections d ON d.tenant=a.tenant AND d.id=a.destination JOIN connections src ON src.tenant=a.tenant AND src.id=a.source JOIN accounts account ON account.id=a.tenant JOIN private_data p ON p.tenant=a.tenant AND p.connection=a.destination AND p.id=a.credential_version AND p.kind='credential' WHERE a.tenant=? AND a.id=? AND i.vendor=? AND i.identity_hash=? AND d.kind=i.vendor AND d.status='active' AND d.credential_version=a.credential_version AND src.status='active' AND account.status='active' AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?) AND l.generation=a.generation AND l.source_hash=a.source_hash AND l.provenance!='adoption_conflict' AND l.state NOT IN('source_deleted','retained_old_route') AND st.state=? AND NOT EXISTS(SELECT 1 FROM legacy_qrz_identity_reservations r WHERE r.tenant=a.tenant AND r.destination=a.destination) AND (l.context_generation IS NULL OR EXISTS(SELECT 1 FROM reconciliation_work rw JOIN source_work w ON w.tenant=rw.tenant AND w.source=rw.source AND w.id=rw.qso AND w.kind='qso' JOIN private_data body ON body.tenant=w.tenant AND body.connection=w.source AND body.id=w.private_id AND body.kind='source' JOIN cursors context ON context.tenant=w.tenant AND context.connection=w.source AND context.stream='context' WHERE rw.tenant=a.tenant AND rw.source=a.source AND rw.qso=a.qso AND rw.version=i.source_version AND w.deleted=0 AND w.state IN('pending','waiting') AND w.expires_at>? AND body.revoked_at IS NULL AND (body.expires_at IS NULL OR body.expires_at>?) AND context.generation=l.context_generation AND json_extract(context.cursor,'$.complete')=1)) AND ${dependencies} AND NOT EXISTS(SELECT 1 FROM source_read_policies policy WHERE policy.tenant=a.tenant AND policy.source=a.source AND NOT EXISTS(SELECT 1 FROM source_read_contact_membership member WHERE member.tenant=a.tenant AND member.source=a.source AND member.qso=a.qso AND member.operation_id IS l.operation_id AND l.context_generation IS NOT NULL)) ${lease ? "AND st.lease_token=? AND st.fence=? AND EXISTS(SELECT 1 FROM leases lease WHERE lease.tenant=a.tenant AND lease.scope='delivery:'||a.destination AND lease.token=? AND lease.fence=? AND lease.expires_at>?)" : ""}`,
        tenant,
        attempt,
        claim.vendor,
        claim.hash,
        now,
        lease ? "dispatching" : "prepared",
        now,
        now,
        now,
        now,
        now,
        now,
        now,
        ...(lease
          ? [lease.token, lease.fence, lease.token, lease.fence, now]
          : []),
      )
      .first(),
  );
}
