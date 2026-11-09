import type { InventoryRun } from "./inventory-runs.ts";
import type { Store } from "./store.ts";
import { VENDOR_POLICIES } from "./vendor-requests.ts";

export function lofiPollSlot(
  earliest: number,
  linkCount: number,
  position: number,
) {
  const { windowMs, background } = VENDOR_POLICIES.lofi;
  // Keep one ordinary request per window available for another page or proof.
  const startsPerWindow = background - 1;
  if (linkCount <= startsPerWindow) return earliest;

  const cycle = Math.ceil(linkCount / startsPerWindow) * windowMs;
  const window = Math.floor(position / startsPerWindow);
  const inWindow = Math.floor(
    ((position % startsPerWindow) + 0.5) * (windowMs / startsPerWindow),
  );
  const slot = window * windowMs + inWindow;
  return earliest + ((slot + cycle - (earliest % cycle)) % cycle);
}

/** Schedule a completed read alongside current, already baselined links. */
export async function lofiRecurringDueAt(
  store: Store,
  run: Pick<InventoryRun, "tenant" | "scope" | "streamId">,
  earliest: number,
) {
  const roster = await store
    .statement(
      `SELECT count(*) AS link_count,
        sum((p.tenant,p.scope_id,p.stream_id)<(?1,?2,?3)) AS position
       FROM inventory_scopes s
       JOIN inventory_runtime v ON v.mode='inventory_read_only' AND v.version=s.runtime_version
       JOIN inventory_scheduled_selections p
        ON (p.tenant,p.scope_id,p.config_version,p.runtime_version)=(s.tenant,s.scope_id,s.config_version,s.runtime_version)
       JOIN inventory_stream_jobs j USING(tenant,scope_id,stream_id)
       JOIN accounts a ON a.id=s.tenant AND a.status='active'
       JOIN connections c ON (c.tenant,c.id)=(s.tenant,s.connection_id)
       JOIN private_data k ON (k.tenant,k.connection,k.id,k.kind)=(c.tenant,c.id,c.credential_version,'credential')
       WHERE s.provider='lofi' AND s.state='observing' AND j.state IN('idle','ready')
        AND c.kind='lofi' AND c.status='active' AND c.remote_identity=s.logical_identity
        AND json_extract(c.config,'$.accountId')=s.logical_identity
        AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>unixepoch('subsec')*1000)
        AND ((p.tenant,p.scope_id,p.stream_id)=(?1,?2,?3) OR EXISTS(
         SELECT 1 FROM inventory_coverage cov
         WHERE (cov.tenant,cov.scope_id,cov.stream_id)=(p.tenant,p.scope_id,p.stream_id)
          AND cov.facet='source' AND cov.kind='observed_selection' AND cov.state IN('ready','collecting')
          AND cov.published_config_version=p.config_version AND cov.published_run_id IS NOT NULL
        ))
       HAVING max((p.tenant,p.scope_id,p.stream_id)=(?1,?2,?3))=1`,
      run.tenant,
      run.scope,
      run.streamId,
    )
    .first<{ link_count: number; position: number }>();
  return roster
    ? lofiPollSlot(earliest, roster.link_count, roster.position)
    : earliest;
}
