import {
  InventoryIngestionError,
  type InventoryObservation,
  inventoryJsonChunks,
} from "./inventory-ingestion.ts";
import { canonical, sha256 } from "./security.ts";
import type { Store } from "./store.ts";

const variant = /^lotw-variant-v1:[A-Za-z0-9_-]{43}:[A-Za-z0-9_-]{43}$/;
const prefixLength = 60;
const maxSupersessionRows = 10_000;

/** A complete dated report can retire a variant replaced by our own verified
 * correction. Omission alone supplies no retirement authority. */
export async function retireVerifiedLotwVariants(
  store: Store,
  tenant: string,
  destination: string,
  requestStartedAt: number,
  observations: InventoryObservation[],
): Promise<InventoryObservation[]> {
  const keys = new Set(observations.map((row) => row.key));
  const byIdentity = new Map<string, InventoryObservation | null>();
  for (const row of observations) {
    if (row.status !== "active" || !variant.test(row.key)) continue;
    const prefix = row.key.slice(0, prefixLength);
    const existing = byIdentity.get(prefix);
    byIdentity.set(
      prefix,
      existing === undefined || existing?.key === row.key ? row : null,
    );
  }
  const unique = [...byIdentity]
    .filter(([, row]) => row !== null)
    .map(([key]) => key);
  if (!unique.length) return observations;
  const results = await store.db.batch<{
    prior: string;
    verified: string;
    projection: string;
  }>(
    inventoryJsonChunks(unique).map((chunk) =>
      store.statement(
        `SELECT old.prior_remote_key AS prior,u.verified_remote_key AS verified,u.verified_projection_hash AS projection
     FROM json_each(?1) j CROSS JOIN inventory_lotw_grid_updates u INDEXED BY inventory_lotw_grid_update_variant
     CROSS JOIN inventory_lotw_grid_updates old INDEXED BY inventory_lotw_grid_update_observed
     CROSS JOIN inventory_record_facets f
     WHERE (u.tenant,u.destination_scope,substr(u.verified_remote_key,1,60))=(?2,?3,j.value)
       AND u.state='observed' AND u.verified_remote_key IS NOT NULL
       AND u.prior_remote_key IS NOT NULL AND u.verified_projection_hash IS NOT NULL
       AND u.checked_at<=?4
       AND NOT EXISTS(SELECT 1 FROM inventory_lotw_grid_updates newer
         WHERE (newer.tenant,newer.association_id)=(u.tenant,u.association_id)
         AND newer.state='observed' AND (newer.claimed_at,newer.source_payload)>(u.claimed_at,u.source_payload))
       AND (old.tenant,old.association_id,old.destination_scope)=(u.tenant,u.association_id,u.destination_scope)
       AND old.state='observed' AND old.checked_at<=?4
       AND (f.tenant,f.scope_id,f.entity_family,f.record_key,f.facet)=(old.tenant,old.destination_scope,'qso',old.prior_remote_key,'receipt')
     LIMIT ?5`,
        chunk,
        tenant,
        destination,
        requestStartedAt,
        maxSupersessionRows + 1,
      ),
    ),
  );
  if (
    results.reduce((count, page) => count + page.results.length, 0) >
    maxSupersessionRows
  )
    throw new InventoryIngestionError("inventory_page_too_large");
  const retired: InventoryObservation[] = [];
  const projectionHashes = new Map<string, string>();
  for (const { results: rows } of results)
    for (const { prior, verified, projection } of rows) {
      const prefix = verified.slice(0, prefixLength);
      const current = byIdentity.get(prefix);
      if (
        !current ||
        keys.has(prior) ||
        !variant.test(prior) ||
        prior.slice(0, prefixLength) !== prefix
      )
        continue;
      if (current.key !== verified) {
        if (current.semantic === undefined) continue;
        const hash =
          projectionHashes.get(current.key) ??
          (await sha256(canonical(current.semantic)));
        projectionHashes.set(current.key, hash);
        if (hash !== projection) continue;
      }
      keys.add(prior);
      retired.push({
        family: "qso",
        key: prior,
        subtype: "qso",
        status: "deleted",
        revision: "lotw-verified-grid-supersession-v1",
        order: null,
        body: {},
      });
    }
  return retired.length ? [...observations, ...retired] : observations;
}
