import { randomToken } from "./security.ts";
import type { Connection, Lease, Store } from "./store.ts";

export interface BackgroundSource extends Connection {
  sync_mode: "backfill" | "forward";
  account_turn: number;
  source_turn: number;
}

/** One oldest available source per account, independently of canonical polling. */
export async function backgroundSources(
  store: Store,
  now: number,
  limit = 8,
): Promise<BackgroundSource[]> {
  return (
    await store
      .statement(
        `SELECT c.*,CASE WHEN p.source IS NOT NULL THEN 'forward' ELSE 'backfill' END AS sync_mode,
          a.last_turn AS account_turn,s.last_turn AS source_turn
         FROM scheduler_background_accounts a
         JOIN scheduler_background_sources s ON s.tenant=a.tenant AND s.source=(
           SELECT candidate.source FROM scheduler_background_sources candidate
           WHERE candidate.tenant=a.tenant AND candidate.eligible=1
             AND NOT EXISTS(SELECT 1 FROM leases l WHERE l.tenant=candidate.tenant
               AND l.scope='cycle:'||candidate.source AND l.expires_at>?)
           ORDER BY candidate.last_turn,candidate.source LIMIT 1)
         JOIN connections c ON c.tenant=s.tenant AND c.id=s.source
         LEFT JOIN source_read_policy_ready p ON p.tenant=c.tenant AND p.source=c.id
         WHERE a.eligible=1
         ORDER BY a.last_turn,a.tenant LIMIT ?`,
        now,
        Math.max(
          1,
          Math.min(16, Math.floor(Number.isFinite(limit) ? limit : 8)),
        ),
      )
      .all<BackgroundSource>()
  ).results;
}

/** Advance before work starts, including a selected source's canonical prelude. */
export async function admitBackgroundSource(
  store: Store,
  source: BackgroundSource,
  lease: Lease,
  now: number,
): Promise<boolean> {
  if (lease.tenant !== source.tenant || lease.scope !== `cycle:${source.id}`)
    return false;
  const admission = randomToken();
  const results = await store.db.batch([
    store.statement(
      `UPDATE scheduler_background_clock SET turn=turn+1,admission=? WHERE id=1
       AND EXISTS(SELECT 1 FROM scheduler_background_accounts a
         JOIN scheduler_background_sources s ON s.tenant=a.tenant
         JOIN accounts owner ON owner.id=a.tenant
         JOIN connections c ON c.tenant=s.tenant AND c.id=s.source
         WHERE a.tenant=? AND s.source=? AND a.eligible=1 AND s.eligible=1
           AND a.last_turn=? AND s.last_turn=? AND owner.status='active'
           AND c.kind='lofi' AND c.status='active')
       AND EXISTS(SELECT 1 FROM leases WHERE tenant=? AND scope=? AND token=? AND fence=? AND expires_at>?)`,
      admission,
      source.tenant,
      source.id,
      source.account_turn,
      source.source_turn,
      lease.tenant,
      lease.scope,
      lease.token,
      lease.fence,
      now,
    ),
    store.statement(
      `UPDATE scheduler_background_accounts SET last_turn=(SELECT turn FROM scheduler_background_clock WHERE id=1)
       WHERE tenant=? AND EXISTS(SELECT 1 FROM scheduler_background_clock WHERE id=1 AND admission=?)`,
      source.tenant,
      admission,
    ),
    store.statement(
      `UPDATE scheduler_background_sources SET last_turn=(SELECT turn FROM scheduler_background_clock WHERE id=1)
       WHERE tenant=? AND source=? AND EXISTS(SELECT 1 FROM scheduler_background_clock WHERE id=1 AND admission=?)
       RETURNING source`,
      source.tenant,
      source.id,
      admission,
    ),
  ]);
  return results[2]?.results.length === 1;
}
