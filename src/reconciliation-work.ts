import type { Work } from "./intake.ts";
import type { Connection, LedgerKey, Store } from "./store.ts";
import type { VendorPriority } from "./vendor-requests.ts";

const retryDelay = 5 * 60_000;
const reviewDelay = 24 * 60 * 60_000;
const parked = 8_640_000_000_000_000;

export interface ReconciliationWork extends Work {
  reconciliation_version: number;
}

/** Indexed hints choose work; intake still validates ciphertext and all context. */
export async function selectReconciliationWork(
  store: Store,
  source: Pick<Connection, "tenant" | "id">,
  options: {
    limit: number;
    now: number;
    priority?: VendorPriority;
    processedBefore?: number;
    readyContextOnly?: boolean;
    qso?: string;
  },
): Promise<ReconciliationWork[]> {
  const { now, priority, processedBefore, readyContextOnly, qso } = options;
  const limit = Math.max(0, Math.min(200, Math.floor(options.limit)));
  if (!limit) return [];
  if (qso !== undefined) {
    // Immutable attempt recovery must refresh its exact source contact even
    // when routine inventory is parked until its next check.
    return (
      await store
        .statement(
          `SELECT w.*,r.version AS reconciliation_version FROM source_work w JOIN reconciliation_work r ON r.tenant=w.tenant AND r.source=w.source AND r.qso=w.id WHERE w.tenant=? AND w.source=? AND w.id=? AND w.kind='qso' AND w.state IN('pending','waiting') AND w.expires_at>? ${priority ? "AND r.priority=?" : ""} ${processedBefore === undefined ? "" : "AND r.selected_at<?"} ${readyContextOnly ? "AND r.context_ready=1 AND r.context_expires_at>?" : ""}`,
          source.tenant,
          source.id,
          qso,
          now,
          ...(priority ? [priority] : []),
          ...(processedBefore === undefined ? [] : [processedBefore]),
          ...(readyContextOnly ? [now] : []),
        )
        .all<ReconciliationWork>()
    ).results;
  }
  const rows: ReconciliationWork[] = [];
  for (const lane of priority
    ? [priority]
    : (["live", "background"] as const)) {
    // Time can expire a hint between maintenance passes. The final lane still
    // lets ordinary intake classify that dependency instead of hiding it.
    for (const readiness of readyContextOnly
      ? ["ready"]
      : ["ready", "held", "expired"]) {
      if (rows.length >= limit) break;
      const ready = readiness === "held" ? 0 : 1;
      const batch = await store
        .statement(
          `SELECT w.*,r.version AS reconciliation_version FROM reconciliation_work r INDEXED BY reconciliation_due JOIN source_work w ON w.tenant=r.tenant AND w.source=r.source AND w.id=r.qso AND w.kind='qso' WHERE r.tenant=? AND r.source=? AND r.priority=? AND r.eligible=1 AND r.context_ready=? AND r.next_due_at<=? AND r.selected_at<? AND w.expires_at>? ${ready ? `AND r.context_expires_at${readiness === "expired" ? "<=" : ">"}?` : ""} ORDER BY r.next_due_at,r.selected_at,r.qso LIMIT ?`,
          source.tenant,
          source.id,
          lane,
          ready,
          now,
          processedBefore ?? parked,
          now,
          ...(ready ? [now] : []),
          limit - rows.length,
        )
        .all<ReconciliationWork>();
      rows.push(...batch.results);
    }
  }
  return rows;
}

/** A changed policy wakes work once, without scanning the backlog every tick. */
export async function syncReconciliationPolicy(
  store: Store,
  policyKey: string,
) {
  await store
    .statement(
      "INSERT INTO reconciliation_policy(id,value) VALUES('delivery',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value WHERE value IS NOT excluded.value",
      policyKey,
    )
    .run();
}

export async function reconciliationCheckDue(
  store: Store,
  key: LedgerKey,
  generation: string,
  now: number,
): Promise<boolean> {
  const checked = await store
    .statement(
      "SELECT 1 checked FROM reconciliation_checks WHERE tenant=? AND source=? AND qso=? AND destination=? AND generation=? AND next_due_at>?",
      key.tenant,
      key.source,
      key.qso,
      key.destination,
      generation,
      now,
    )
    .first();
  return !checked;
}

/** Persist only successful classifications, never a transport failure or defer. */
export async function recordReconciliationCheck(
  store: Store,
  key: LedgerKey,
  generation: string,
  outcome: { state: string; reason?: string | null },
  now: number,
  version?: number,
): Promise<boolean> {
  if (version === undefined) return false;
  const resolved = [
    "adopted_existing",
    "delivered",
    "observed",
    "source_deleted",
  ].includes(outcome.state);
  const review =
    ["history_ambiguous", "history_mismatch", "historical_unverified"].includes(
      outcome.state,
    ) ||
    outcome.reason ===
      "Source replay/cutover evidence is not yet verified; absence cannot authorize backfill" ||
    outcome.reason ===
      "Shared history has no matching identity; a fresh targeted check is required before exporting";
  const due = resolved ? parked : now + (review ? reviewDelay : retryDelay);
  const result = await store
    .statement(
      "INSERT INTO reconciliation_checks(tenant,source,qso,destination,generation,checked_at,next_due_at) SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE EXISTS(SELECT 1 FROM reconciliation_work WHERE tenant=?1 AND source=?2 AND qso=?3 AND version=?8) AND EXISTS(SELECT 1 FROM ledger WHERE tenant=?1 AND source=?2 AND qso=?3 AND destination=?4 AND generation=?5) ON CONFLICT(tenant,source,qso,destination) DO UPDATE SET generation=excluded.generation,checked_at=excluded.checked_at,next_due_at=excluded.next_due_at",
      key.tenant,
      key.source,
      key.qso,
      key.destination,
      generation,
      now,
      due,
      version,
    )
    .run();
  return result.meta.changes === 1;
}

/** A stale completion cannot delay a newer source, route, or inventory update. */
export async function finishReconciliationWork(
  store: Store,
  source: Pick<Connection, "tenant" | "id">,
  qso: string,
  version: number | undefined,
  now: number,
): Promise<boolean> {
  if (version === undefined) return false;
  const result = await store
    .statement(
      `UPDATE reconciliation_work SET next_due_at=COALESCE((SELECT MIN(CASE WHEN l.state IN('adopted_existing','delivered','observed','source_deleted') AND l.source_hash IS l.baseline_hash THEN ?1 WHEN l.state IN('changed','missing_current_identity','live_new') THEN MAX(?2,l.due_at) WHEN c.generation=l.generation THEN MAX(?2,c.next_due_at) ELSE ?2 END) FROM ledger l JOIN connections d ON d.tenant=l.tenant AND d.id=l.destination AND d.status='active' LEFT JOIN reconciliation_checks c ON c.tenant=l.tenant AND c.source=l.source AND c.qso=l.qso AND c.destination=l.destination WHERE l.tenant=?3 AND l.source=?4 AND l.qso=?5),?6) WHERE tenant=?3 AND source=?4 AND qso=?5 AND version=?7`,
      parked,
      now + retryDelay,
      source.tenant,
      source.id,
      qso,
      now + reviewDelay,
      version,
    )
    .run();
  return result.meta.changes === 1;
}

/** Wake only contacts whose newly completed inventory can change their result. */
export async function wakeReconciliationWork(
  store: Store,
  source: Pick<Connection, "tenant" | "id">,
  qsos: readonly string[],
  destination?: string,
): Promise<void> {
  if (!qsos.length) return;
  // Bound SQL parameters and messages; callers can stream larger partitions.
  for (let offset = 0; offset < qsos.length; offset += 200) {
    const ids = JSON.stringify(qsos.slice(offset, offset + 200));
    await store.db.batch([
      store.statement(
        "UPDATE reconciliation_work SET next_due_at=0,version=version+1 WHERE tenant=? AND source=? AND qso IN(SELECT value FROM json_each(?))",
        source.tenant,
        source.id,
        ids,
      ),
      store.statement(
        `DELETE FROM reconciliation_checks WHERE tenant=? AND source=? AND qso IN(SELECT value FROM json_each(?)) ${destination === undefined ? "" : "AND destination=?"}`,
        source.tenant,
        source.id,
        ids,
        ...(destination === undefined ? [] : [destination]),
      ),
    ]);
  }
}
