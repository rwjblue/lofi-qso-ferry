import { ClubLogError } from "./clublog.ts";
import type { Connection, LedgerKey, Store } from "./store.ts";

export const CLUBLOG_REJECTION_REASON =
  "Club Log rejected access. Verify the connected credentials and account before resuming.";

/** Returns true for handled rejections, even if renewed credentials make the failure stale. */
export async function handleProviderRejection(
  store: Store,
  connection: Connection,
  error: unknown,
  key?: LedgerKey,
): Promise<boolean> {
  if (
    connection.kind !== "clublog" ||
    !(error instanceof ClubLogError) ||
    !error.suspend
  )
    return false;
  if (
    key &&
    (key.tenant !== connection.tenant || key.destination !== connection.id)
  )
    throw new Error("Provider failure does not match its ledger destination");
  await store.db.batch([
    ...(key
      ? [
          store.statement(
            "UPDATE ledger SET reason=? WHERE tenant=? AND source=? AND qso=? AND destination=? AND EXISTS(SELECT 1 FROM connections c WHERE c.tenant=ledger.tenant AND c.id=ledger.destination AND c.kind='clublog' AND c.status!='revoked' AND c.credential_version=?)",
            CLUBLOG_REJECTION_REASON,
            key.tenant,
            key.source,
            key.qso,
            key.destination,
            connection.credential_version,
          ),
        ]
      : []),
    store.statement(
      "UPDATE connections SET status=CASE WHEN status='active' THEN 'needs_verification' ELSE status END,config=json_set(config,'$.lastError',?,'$.credentialRejected',json('true')) WHERE tenant=? AND id=? AND kind='clublog' AND status!='revoked' AND credential_version=?",
      CLUBLOG_REJECTION_REASON,
      connection.tenant,
      connection.id,
      connection.credential_version,
    ),
  ]);
  return true;
}
