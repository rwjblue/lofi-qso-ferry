import type { DeliveryGates } from "./delivery.ts";
import { randomToken } from "./security.ts";
import type { Connection, LedgerKey, Store } from "./store.ts";
/**
 * Must precede the source_work upsert in the same cursor checkpoint batch.
 * cursorGeneration is the COMMITTED page generation (saved generation + 1).
 * A replayed legacy source row is historical even if this deployment has no birth.
 */
export function recordBirth(
  store: Store,
  tenant: string,
  source: string,
  qso: string,
  stream: string,
  oldSyncMode: string,
  cursorGeneration: number,
  now: number,
): D1PreparedStatement {
  if (
    !qso ||
    qso.length > 256 ||
    !stream ||
    stream.length > 256 ||
    !Number.isSafeInteger(cursorGeneration) ||
    cursorGeneration < 1 ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    throw new Error("invalid_source_birth");
  return store.statement(
    `INSERT OR IGNORE INTO source_births(tenant,source,qso,phase,first_seen_at,first_cursor_generation,first_stream) SELECT ?,?,?,CASE WHEN ?='sync' AND ?='forward' AND NOT EXISTS(SELECT 1 FROM source_work WHERE tenant=? AND source=? AND id=? AND kind='qso') THEN 'forward_new' ELSE 'history' END,?,?,? WHERE EXISTS(SELECT 1 FROM connections WHERE tenant=? AND id=? AND kind='lofi' AND status='active')`,
    tenant,
    source,
    qso,
    stream,
    oldSyncMode,
    tenant,
    source,
    qso,
    now,
    cursorGeneration,
    stream,
    tenant,
    source,
  );
}
interface CursorRow {
  cursor: string;
  generation: number;
  updated_at: number;
}
interface EpochRow {
  epoch: string;
  started_at: number;
}
interface Destination {
  id: string;
  created_at: number;
}
/**
 * This local evidence is valid ONLY after the operator independently verifies
 * exhaustive source UUID/tombstone/replay semantics. The configuration gate is
 * false by default; a fixture or this marker is not proof of vendor behavior.
 */
export async function establishCutovers(
  store: Store,
  source: Connection,
  gates: Pick<DeliveryGates, "sourceBoundaryVerified">,
  now = Date.now(),
): Promise<number> {
  if (!gates.sourceBoundaryVerified || source.kind !== "lofi") return 0;
  const current = await store.connection(source.tenant, source.id);
  if (
    current?.kind !== "lofi" ||
    current.status !== "active" ||
    current.remote_identity !== source.remote_identity
  )
    return 0;
  const sync = await store
    .statement(
      "SELECT cursor,generation,updated_at FROM cursors WHERE tenant=? AND connection=? AND stream='sync'",
      source.tenant,
      source.id,
    )
    .first<CursorRow>();
  const context = await store
    .statement(
      "SELECT cursor,generation,updated_at FROM cursors WHERE tenant=? AND connection=? AND stream='context'",
      source.tenant,
      source.id,
    )
    .first<CursorRow>();
  if (!sync || !context) return 0;
  const syncState = JSON.parse(sync.cursor) as { mode?: string };
  const contextState = JSON.parse(context.cursor) as {
    complete?: boolean;
    syncComplete?: boolean;
  };
  if (
    syncState.mode !== "forward" ||
    contextState.complete !== true ||
    contextState.syncComplete !== true
  )
    return 0;
  const inventory = await store
    .statement(
      "SELECT epoch,started_at FROM source_inventory_epochs WHERE tenant=? AND source=?",
      source.tenant,
      source.id,
    )
    .first<EpochRow>();
  const destinations = (
    await store
      .statement(
        "SELECT id,created_at FROM connections WHERE tenant=? AND kind IN('qrz','lotw') AND status='active'",
        source.tenant,
      )
      .all<Destination>()
  ).results;
  let established = 0;
  for (const destination of destinations) {
    const rescan = await store
      .statement(
        "SELECT cursor,generation,updated_at FROM cursors WHERE tenant=? AND connection=? AND stream=?",
        source.tenant,
        source.id,
        `rescan:${destination.id}`,
      )
      .first<CursorRow>();
    const predatesInventory = Boolean(
      inventory && destination.created_at <= inventory.started_at,
    );
    const rescanComplete = Boolean(
      rescan &&
        (JSON.parse(rescan.cursor) as { rescanComplete?: boolean })
          .rescanComplete === true,
    );
    if (!predatesInventory && !rescanComplete) continue;
    const kind = predatesInventory ? "initial_inventory" : "destination_rescan";
    const result = await store
      .statement(
        `INSERT OR IGNORE INTO source_cutovers(tenant,source,destination,epoch,inventory_epoch,source_generation,source_cursor,evidence_kind,evidence_generation,evidence_cursor,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM connections WHERE tenant=? AND id=? AND kind='lofi' AND status='active') AND EXISTS(SELECT 1 FROM connections WHERE tenant=? AND id=? AND kind IN('qrz','lotw') AND status='active') AND EXISTS(SELECT 1 FROM cursors WHERE tenant=? AND connection=? AND stream='sync' AND generation=? AND cursor=? AND json_extract(cursor,'$.mode')='forward') AND EXISTS(SELECT 1 FROM cursors WHERE tenant=? AND connection=? AND stream='context' AND generation=? AND cursor=? AND json_extract(cursor,'$.complete')=1 AND json_extract(cursor,'$.syncComplete')=1) AND (?='initial_inventory' AND EXISTS(SELECT 1 FROM source_inventory_epochs e JOIN connections d ON d.tenant=e.tenant AND d.id=? WHERE e.tenant=? AND e.source=? AND e.epoch=? AND d.created_at<=e.started_at) OR ?='destination_rescan' AND EXISTS(SELECT 1 FROM cursors WHERE tenant=? AND connection=? AND stream=? AND generation=? AND cursor=? AND json_extract(cursor,'$.rescanComplete')=1))`,
        source.tenant,
        source.id,
        destination.id,
        randomToken(),
        inventory?.epoch ?? null,
        sync.generation,
        sync.cursor,
        kind,
        predatesInventory ? sync.generation : rescan!.generation,
        predatesInventory ? sync.cursor : rescan!.cursor,
        now,
        source.tenant,
        source.id,
        source.tenant,
        destination.id,
        source.tenant,
        source.id,
        sync.generation,
        sync.cursor,
        source.tenant,
        source.id,
        context.generation,
        context.cursor,
        kind,
        destination.id,
        source.tenant,
        source.id,
        inventory?.epoch ?? null,
        kind,
        source.tenant,
        source.id,
        `rescan:${destination.id}`,
        rescan?.generation ?? 0,
        rescan?.cursor ?? "",
      )
      .run();
    established += result.meta.changes;
  }
  return established;
}
/** No QSO date or device clock participates in eligibility. */
export async function proveNewAfterCutover(
  store: Store,
  key: LedgerKey,
): Promise<boolean> {
  return Boolean(
    await store
      .statement(
        `SELECT 1 proven FROM source_births b JOIN source_cutovers c ON c.tenant=b.tenant AND c.source=b.source JOIN connections s ON s.tenant=b.tenant AND s.id=b.source JOIN connections d ON d.tenant=c.tenant AND d.id=c.destination JOIN cursors p ON p.tenant=b.tenant AND p.connection=b.source AND p.stream='sync' JOIN cursors context ON context.tenant=b.tenant AND context.connection=b.source AND context.stream='context' WHERE b.tenant=? AND b.source=? AND b.qso=? AND c.destination=? AND b.phase='forward_new' AND b.first_stream='sync' AND b.first_cursor_generation>c.source_generation AND p.generation>=b.first_cursor_generation AND json_extract(p.cursor,'$.mode')='forward' AND json_extract(context.cursor,'$.complete')=1 AND json_extract(context.cursor,'$.syncComplete')=1 AND s.kind='lofi' AND s.status='active' AND d.kind IN('qrz','lotw') AND d.status='active'`,
        key.tenant,
        key.source,
        key.qso,
        key.destination,
      )
      .first(),
  );
}
