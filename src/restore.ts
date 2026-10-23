/** Apply only to an isolated restored database before binding a service to it.
 * This is a one-way quarantine, never an account-reset/reactivation path.
 * Keep ops/lock-restored.sql byte-equivalent; tests enforce the shared contract.
 */
export const RESTORE_LOCK_SQL = `UPDATE accounts SET status='restore_locked' WHERE status='active';
UPDATE sessions SET revoked_at=COALESCE(revoked_at,CAST(strftime('%s','now') AS INTEGER)*1000);
UPDATE connections SET status='disabled' WHERE status!='revoked';
UPDATE private_data SET revoked_at=COALESCE(revoked_at,CAST(strftime('%s','now') AS INTEGER)*1000) WHERE kind='credential';
INSERT INTO attempt_events(tenant,attempt,state,at,reason) SELECT tenant,attempt,'reconciliation_required',CAST(strftime('%s','now') AS INTEGER)*1000,'restored snapshot requires fresh authoritative receipt evidence' FROM attempt_state WHERE state IN('prepared','dispatching','submitted','uncertain');
UPDATE attempt_state SET state='reconciliation_required',reason='restored snapshot requires fresh authoritative receipt evidence',lease_token=NULL,fence=NULL,updated_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE state IN('prepared','dispatching','submitted','uncertain');
UPDATE leases SET expires_at=0;
UPDATE ledger SET state='inventory_pending',reason='restore_locked_requires_reconciliation' WHERE state NOT IN('adopted_existing','delivered','observed','source_deleted');
UPDATE partitions SET state='inventory_pending',evidence='{}';
UPDATE cursors SET cursor=CASE WHEN json_valid(cursor) THEN json_set(cursor,'$.complete',0) ELSE '{"complete":false}' END,generation=generation+1 WHERE stream='context';
DELETE FROM ceremonies;
DELETE FROM signups;
DELETE FROM local_mailbox;`;

export function restoreLockStatements(): string[] {
  return RESTORE_LOCK_SQL.trim().split(/;\s*/).filter(Boolean);
}
export async function lockRestoredDatabase(database: D1Database): Promise<{
  lockedAccounts: number;
  disabledConnections: number;
  blockedAttempts: number;
}> {
  const result = await database.batch(
    restoreLockStatements().map((sql) => database.prepare(sql)),
  );
  return {
    lockedAccounts: result[0]!.meta.changes,
    disabledConnections: result[2]!.meta.changes,
    blockedAttempts: result[5]!.meta.changes,
  };
}
