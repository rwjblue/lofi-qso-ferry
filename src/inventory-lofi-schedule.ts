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
        sum((tenant,scope_id,stream_id)<(?1,?2,?3)) AS position
       FROM inventory_lofi_scheduled_links
       WHERE established=1 OR (tenant,scope_id,stream_id)=(?1,?2,?3)
       HAVING max((tenant,scope_id,stream_id)=(?1,?2,?3))=1`,
      run.tenant,
      run.scope,
      run.streamId,
    )
    .first<{ link_count: number; position: number }>();
  return roster
    ? lofiPollSlot(earliest, roster.link_count, roster.position)
    : earliest;
}
