import {
  archiveInventoryBody,
  INVENTORY_ARCHIVE_MAX_BODY_BYTES,
} from "./inventory-body-archive.ts";
import { canonical } from "./security.ts";
import type { Store } from "./store.ts";

const COLD_CENSUS_PAGE = 64;
const COLD_WRITES_PER_TICK = 8;
const COLD_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

interface ColdBodyKey {
  created_at: number;
  tenant: string;
  scope_id: string;
  payload_id: string;
}

/** Cool settled source bodies to replay pointers. With object storage, persist
 * each encrypted object before swapping its current D1 representation. */
export async function collectInventoryColdBodies(store: Store) {
  const archive = store.inventoryBodyArchive;
  const clock = Date.now();
  const state = await store
    .statement(
      `SELECT c.*,?1-p.settled_retention_days*86400000 AS cutoff
       FROM inventory_cold_body_census c CROSS JOIN inventory_retention_policy p
       WHERE c.singleton=1 AND (c.restart_at IS NULL OR c.restart_at<=?1)`,
      clock,
    )
    .first<
      ColdBodyKey & {
        version: number;
        cutoff: number;
        restart_at: number | null;
      }
    >();
  if (!state) return 0;
  const start = state.restart_at === null ? state : null;
  const page = await store
    .statement(
      `WITH candidates AS MATERIALIZED (
         SELECT p.created_at,p.tenant,p.scope_id,p.payload_id
         FROM inventory_payloads p INDEXED BY inventory_cold_body_age
         WHERE p.kind='inventory_source' AND p.cold=0 AND p.created_at<=?5
           AND (p.created_at,p.tenant,p.scope_id,p.payload_id)>(?1,?2,?3,?4)
         ORDER BY p.created_at,p.tenant,p.scope_id,p.payload_id LIMIT ?6
       )
       SELECT p.*,EXISTS(SELECT 1 FROM inventory_replay_coolable_bodies b
         WHERE (b.tenant,b.scope_id,b.payload_id)=(p.tenant,p.scope_id,p.payload_id)) AS eligible
       FROM candidates p ORDER BY p.created_at,p.tenant,p.scope_id,p.payload_id`,
      start?.created_at ?? 0,
      start?.tenant ?? "",
      start?.scope_id ?? "",
      start?.payload_id ?? "",
      state.cutoff,
      COLD_CENSUS_PAGE,
    )
    .all<ColdBodyKey & { eligible: number }>();
  let visited = 0;
  const selected: ColdBodyKey[] = [];
  for (const row of page.results) {
    if (row.eligible) {
      if (selected.length === COLD_WRITES_PER_TICK) break;
      selected.push(row);
    }
    visited++;
  }
  const updates: D1PreparedStatement[] = [];
  if (selected.length) {
    const { results: bodies } = await store
      .statement(
        `SELECT p.tenant,p.scope_id,p.payload_id,p.connection_id,p.kind,p.envelope
         FROM json_each(?1) j CROSS JOIN inventory_payloads p
         WHERE (p.tenant,p.scope_id,p.payload_id)=(json_extract(j.value,'$.tenant'),json_extract(j.value,'$.scope_id'),json_extract(j.value,'$.payload_id'))
           AND p.kind='inventory_source' AND p.cold=0 AND length(p.envelope)<=?2`,
        canonical(selected),
        INVENTORY_ARCHIVE_MAX_BODY_BYTES,
      )
      .all<
        ColdBodyKey & { connection_id: string; kind: string; envelope: string }
      >();
    for (const body of bodies) {
      const pointer = await archiveInventoryBody(
        archive,
        {
          tenant: body.tenant,
          scope: body.scope_id,
          id: body.payload_id,
          connection: body.connection_id,
          kind: body.kind,
        },
        body.envelope,
      );
      updates.push(
        store.statement(
          `UPDATE inventory_payloads SET envelope=?1,cold=1
           WHERE (tenant,scope_id,payload_id)=(?2,?3,?4) AND cold=0 AND envelope=?5
           AND EXISTS(SELECT 1 FROM inventory_cold_body_census s WHERE s.singleton=1 AND s.version=?6)
           AND EXISTS(SELECT 1 FROM inventory_replay_coolable_bodies b WHERE (b.tenant,b.scope_id,b.payload_id)=(?2,?3,?4))`,
          pointer,
          body.tenant,
          body.scope_id,
          body.payload_id,
          body.envelope,
          state.version,
        ),
      );
    }
  }
  const last = page.results[visited - 1] ?? start;
  const finished =
    visited === page.results.length && visited < COLD_CENSUS_PAGE;
  const results = await store.db.batch([
    ...updates,
    store.statement(
      `UPDATE inventory_cold_body_census SET created_at=?1,tenant=?2,scope_id=?3,payload_id=?4,restart_at=?5,version=version+1
       WHERE singleton=1 AND version=?6`,
      last?.created_at ?? 0,
      last?.tenant ?? "",
      last?.scope_id ?? "",
      last?.payload_id ?? "",
      finished ? clock + COLD_SWEEP_INTERVAL_MS : null,
      state.version,
    ),
  ]);
  return results
    .slice(0, updates.length)
    .reduce((sum, result) => sum + result.meta.changes, 0);
}

/** Delete one bounded cohort. The foreign key protects current facet bodies. */
export async function collectInventoryPayloads(store: Store) {
  const removed = await store
    .statement(
      `WITH heads AS MATERIALIZED (
        SELECT a.id AS tenant,(
          SELECT r.eligible_at FROM inventory_payload_retirements r INDEXED BY inventory_payload_retirement_due
          WHERE r.tenant=a.id AND r.eligible_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)
          AND NOT EXISTS(SELECT 1 FROM inventory_record_facets f WHERE (f.tenant,f.scope_id,f.payload_id)=(r.tenant,r.scope_id,r.payload_id))
          ORDER BY r.eligible_at LIMIT 1
        ) AS due FROM accounts a
        WHERE NOT EXISTS(SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=a.id)
       ), next AS MATERIALIZED (
        SELECT tenant FROM heads WHERE due IS NOT NULL ORDER BY due,tenant LIMIT 1
       )
       DELETE FROM inventory_payloads WHERE (tenant,scope_id,payload_id) IN (
        SELECT r.tenant,r.scope_id,r.payload_id
        FROM next n CROSS JOIN inventory_payload_retirements r INDEXED BY inventory_payload_retirement_due
        WHERE r.tenant=n.tenant AND r.eligible_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)
        AND NOT EXISTS(SELECT 1 FROM inventory_record_facets f WHERE (f.tenant,f.scope_id,f.payload_id)=(r.tenant,r.scope_id,r.payload_id))
        ORDER BY r.eligible_at,r.scope_id,r.payload_id LIMIT 256
       ) RETURNING 1 AS collected`,
    )
    .all<{ collected: number }>();
  return removed.results.length;
}
