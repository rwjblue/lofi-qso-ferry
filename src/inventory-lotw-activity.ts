import { inventoryLotwConfirmationEvidence } from "./inventory-lotw-confirmations.ts";
import {
  type InventoryOwnershipBody,
  inventoryOwnershipIdentity,
} from "./inventory-ownership.ts";
import { lotwRemoteIdentity } from "./reconcile.ts";
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
  const [recent, counts] = await Promise.all([
    store
      .statement(
        `SELECT * FROM (
           SELECT * FROM inventory_lotw_adopted_activity WHERE tenant=?1 ORDER BY updated_at DESC,activity_id LIMIT 50
         )
         UNION ALL SELECT * FROM (
           SELECT * FROM inventory_lotw_observed_activity WHERE tenant=?1 ORDER BY updated_at DESC,activity_id LIMIT 50
         )
         ORDER BY updated_at DESC,activity_id LIMIT 50`,
        tenant,
      )
      .all<ActivityRow>(),
    store
      .statement(
        `SELECT 'adopted_existing' AS state,count(*) AS count FROM inventory_lotw_adopted_activity WHERE tenant=?1 HAVING count(*)>0
         UNION ALL
         SELECT 'observed',count(*) FROM inventory_lotw_observed_activity WHERE tenant=?1 HAVING count(*)>0`,
        tenant,
      )
      .all<{ state: string; count: number }>(),
  ]);
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
  return {
    counts: counts.results,
    activity: recent.results.map(
      (
        { source, qso, destination, state, updated_at, confirmed: observed },
        position,
      ) => ({
        source,
        qso,
        destination,
        state,
        updated_at,
        confirmed: Number(observed !== 0 || confirmed.has(position)),
        reason: null,
        priorIdentityCount: 0,
      }),
    ),
  };
}
