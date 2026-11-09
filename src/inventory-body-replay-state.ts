import type { InventoryBodyLocation } from "./inventory-body-archive.ts";
import type { Store } from "./store.ts";

/** Only an intact marker for a currently accepted source facet can request an
 * isolated replay. Superseded bodies do not grant access to upstream data. */
export async function requestInventoryBodyReplay(
  store: Store,
  location: InventoryBodyLocation,
  marker: string,
) {
  if (location.kind !== "inventory_source") return;
  await store
    .statement(
      `INSERT INTO inventory_body_replay_requests(tenant,scope_id,payload_id,record_key,body_hash,marker,requested_at)
       SELECT p.tenant,p.scope_id,p.payload_id,f.record_key,f.body_hash,p.envelope,?6
       FROM inventory_payloads p JOIN inventory_record_facets f ON (f.tenant,f.scope_id,f.payload_id)=(p.tenant,p.scope_id,p.payload_id)
       WHERE (p.tenant,p.scope_id,p.payload_id,p.connection_id,p.envelope,p.cold)=(?1,?2,?3,?4,?5,1)
       AND f.entity_family='qso' AND f.facet='source'
       AND NOT EXISTS(SELECT 1 FROM inventory_restore_locks x WHERE x.tenant=p.tenant)
       ON CONFLICT(tenant,scope_id,payload_id) DO UPDATE SET
         record_key=excluded.record_key,body_hash=excluded.body_hash,marker=excluded.marker,requested_at=excluded.requested_at,cursor_id=NULL,state='pending'
       WHERE inventory_body_replay_requests.marker!=excluded.marker`,
      location.tenant,
      location.scope,
      location.id,
      location.connection,
      marker,
      Date.now(),
    )
    .run();
}
