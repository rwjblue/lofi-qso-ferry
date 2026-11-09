import { lotwRemoteIdentity } from "./destination-receipts.ts";
import { inventoryLotwConfirmationEvidence } from "./inventory-lotw-confirmations.ts";
import {
  type InventoryOwnershipBody,
  inventoryOwnershipIdentity,
} from "./inventory-ownership.ts";
import { open } from "./security.ts";
import type { Store } from "./store.ts";

interface ActivityRow {
  source: string;
  qso: string;
  destination: string;
  scope: string;
  updated_at: number;
  state: "adopted_existing" | "observed";
  confirmed: number;
  receipt_key: string | null;
  evidence_id: string | null;
  envelope: string | null;
}

async function confirmationIdentity(
  store: Store,
  tenant: string,
  row: ActivityRow,
) {
  if (row.receipt_key)
    return /^lotw-variant-v1:([A-Za-z0-9_-]{43}):[A-Za-z0-9_-]{43}$/.exec(
      row.receipt_key,
    )?.[1];
  if (!row.evidence_id || !row.envelope) return undefined;
  try {
    const evidence = await open<InventoryOwnershipBody>(
      JSON.parse(row.envelope),
      inventoryOwnershipIdentity(tenant, row.evidence_id),
      store.keys,
    );
    if (evidence.version === 1 && evidence.provider === "lotw")
      return await lotwRemoteIdentity(evidence.record);
  } catch {
    // An unreadable evidence body cannot add a QSL badge to the readback.
  }
}

export async function inventoryLotwActivity(store: Store, tenant: string) {
  const recent = await store
    .statement(
      `SELECT * FROM (
       SELECT src.id AS source,h.record_key AS qso,dst.id AS destination,h.destination_scope AS scope,
         h.created_at AS updated_at,h.id AS activity_id,'adopted_existing' AS state,0 AS confirmed,
         h.remote_record_key AS receipt_key,NULL AS evidence_id,NULL AS envelope
       FROM inventory_historical_associations h INDEXED BY inventory_lotw_association_activity
       CROSS JOIN connections src ON (src.tenant,src.kind,src.remote_identity)=(h.tenant,'lofi',h.source_identity)
       CROSS JOIN connections dst ON (dst.tenant,dst.kind,dst.remote_identity)=(h.tenant,'lotw',h.book_identity)
       WHERE h.tenant=?1 AND h.provider='lotw' ORDER BY updated_at DESC,activity_id LIMIT 50
     )
     UNION ALL SELECT * FROM (
       SELECT src.id AS source,e.record_key AS qso,dst.id AS destination,e.destination_scope AS scope,
         r.received_at AS updated_at,r.attempt_id AS activity_id,'observed' AS state,r.confirmed,
         NULL AS receipt_key,e.id AS evidence_id,CASE WHEN r.confirmed=0 THEN e.envelope END AS envelope
       FROM inventory_lotw_member_receipts r INDEXED BY inventory_lotw_receipt_activity
       CROSS JOIN inventory_ownership_evidence e ON (e.tenant,e.id)=(r.tenant,r.evidence_id) AND e.provider='lotw'
       CROSS JOIN connections src ON (src.tenant,src.kind,src.remote_identity)=(e.tenant,'lofi',e.source_identity)
       CROSS JOIN connections dst ON (dst.tenant,dst.kind,dst.remote_identity)=(e.tenant,'lotw',e.book_identity)
       WHERE r.tenant=?1 ORDER BY updated_at DESC,activity_id LIMIT 50
     )
     ORDER BY updated_at DESC,activity_id LIMIT 50`,
      tenant,
    )
    .all<ActivityRow>();
  const identities = await Promise.all(
    recent.results.map(async (row, position) => {
      if (row.confirmed) return [];
      const identityHash = await confirmationIdentity(store, tenant, row);
      return identityHash ? [{ scope: row.scope, identityHash, position }] : [];
    }),
  );
  const targets = identities.flat();
  const evidence = await inventoryLotwConfirmationEvidence(
    store,
    tenant,
    targets,
  );
  const confirmed = new Set(
    targets.flatMap(({ position }, index) => {
      const row = recent.results[position];
      const result = evidence[index];
      return result.state === "confirmed" &&
        (row.receipt_key === null || row.receipt_key === result.receipt)
        ? [position]
        : [];
    }),
  );
  const activity = recent.results.map(
    (
      { qso, destination, state, updated_at, confirmed: observed },
      position,
    ) => ({
      qso,
      destination,
      state,
      updated_at,
      confirmed: Number(observed !== 0 || confirmed.has(position)),
      reason: null,
    }),
  );
  return { activity };
}
