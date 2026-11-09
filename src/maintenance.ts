import type { Envelope } from "./security.ts";
import { canonical, rewrap } from "./security.ts";
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
          "UPDATE private_data SET envelope=? WHERE tenant=? AND connection=? AND id=? AND kind=? AND envelope=? RETURNING id",
          canonical(envelope),
          row.tenant,
          row.connection,
          row.id,
          row.kind,
          row.envelope,
        )
        .all<{ id: string }>();
      // D1 changes also counts auxiliary trigger writes, such as rotating a
      // source body's proof token. RETURNING counts only matched private rows.
      rotated += update.results.length;
    } catch {
      blocked++;
    }
  }
  return { rotated, blocked };
}
