import { canonical, rewrap } from "./security.ts";
import type { Envelope } from "./security.ts";
import type { Store } from "./store.ts";
/** Interrupted rotation is safe: old KEKs remain readable and ciphertext stays fixed. */
export async function rotatePrivateData(store: Store, limit = 50) {
  const rows = (
    await store
      .statement(
        "SELECT tenant,connection,id,kind,envelope FROM private_data WHERE json_extract(envelope,'$.kek')!=? LIMIT ?",
        store.keys.active,
        limit,
      )
      .all<{
        tenant: string;
        connection: string;
        id: string;
        kind: string;
        envelope: string;
      }>()
  ).results;
  let rotated = 0;
  let blocked = 0;
  for (const row of rows) {
    try {
      const identity = {
        tenant: row.tenant,
        connection: row.connection,
        id: row.id,
        kind: row.kind,
        purpose: "storage",
      };
      const envelope = await rewrap(
        JSON.parse(row.envelope) as Envelope,
        identity,
        store.keys,
      );
      const update = await store
        .statement(
          "UPDATE private_data SET envelope=? WHERE tenant=? AND connection=? AND id=? AND kind=? AND envelope=?",
          canonical(envelope),
          row.tenant,
          row.connection,
          row.id,
          row.kind,
          row.envelope,
        )
        .run();
      rotated += update.meta.changes;
    } catch {
      blocked++;
    }
  }
  return { rotated, blocked };
}
/** Resolved contact payloads leave only their compact delivery ledger and context. */
export async function purgeResolvedSource(store: Store) {
  const resolved = `SELECT w.tenant,w.source,w.private_id FROM source_work w WHERE w.kind='qso' AND w.is_event=0 AND w.state!='test' AND EXISTS(SELECT 1 FROM ledger l WHERE l.tenant=w.tenant AND l.source=w.source AND l.qso=w.id) AND NOT EXISTS(SELECT 1 FROM ledger l WHERE l.tenant=w.tenant AND l.source=w.source AND l.qso=w.id AND (l.state NOT IN('adopted_existing','delivered','observed','source_deleted') OR l.source_hash IS NOT l.baseline_hash)) AND NOT EXISTS(SELECT 1 FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE a.tenant=w.tenant AND a.source=w.source AND a.qso=w.id AND s.state NOT IN('delivered','observed','rejected','cancelled'))`;
  await store.db.batch([
    // Resolve the payload keys once, then use private_data's primary key. A
    // correlated source_work lookup scans the tenant's backlog for every body.
    store.statement(
      `DELETE FROM private_data WHERE kind='source' AND (tenant,connection,id) IN(${resolved})`,
    ),
    store.statement(
      `UPDATE source_work SET state='archived',expires_at=0,reason=NULL WHERE kind='qso' AND is_event=0 AND (tenant,source,private_id) IN(${resolved}) AND NOT EXISTS(SELECT 1 FROM private_data p WHERE p.tenant=source_work.tenant AND p.connection=source_work.source AND p.id=source_work.private_id AND p.kind='source')`,
    ),
  ]);
}
