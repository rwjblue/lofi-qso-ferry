import { InventoryOwnership } from "./inventory-ownership.ts";
import { InventoryProjections } from "./inventory-projections.ts";
import { canonical } from "./security.ts";
import type { Lease, Store } from "./store.ts";

type Provider = "qrz" | "lotw";
type Blocker =
  | "credentials_unavailable"
  | "historical_owner"
  | "ownership_incomplete"
  | "prior_delivery_evidence"
  | "projection_unavailable";
type Decision =
  | Blocker
  | "comparison_changed"
  | "ownership_conflict"
  | "ownership_bound"
  | "source_proof_required";
interface ReviewHead {
  provider: Provider;
  result_set: string;
  source_scope: string;
  destination: string;
  generation_id: string;
}
interface ReviewRow extends ReviewHead {
  work_id: number;
  book_identity: string;
  source_identity: string;
  record_key: string;
  result_version: number;
  due_at: number;
  reviewed_at: number | null;
  ownership_version: number;
  current_ownership_version: number;
  current_source_credential: string | null;
  current_destination_credential: string | null;
  blocker: Blocker | null;
  projection_version: number;
  projection_payload: string;
}
const WAIT_FOR_CHANGE = Number.MAX_SAFE_INTEGER;
const RETRY_MS = 300_000;
const BODY_LIMIT = 4 * 1024 * 1024;
const readBounds = new Set([
  "inventory_projection_read_split_required",
  "inventory_projection_read_byte_bound",
]);
const transient = new Set<Decision>([
  "credentials_unavailable",
  "prior_delivery_evidence",
  "projection_unavailable",
]);

const reviewHeads = `WITH routes AS MATERIALIZED(
  SELECT r.*,coalesce(o.version,0) AS ownership_clock
  FROM inventory_matching_coverage_live_routes r
  JOIN inventory_scopes d ON d.tenant=r.tenant AND d.scope_id=r.destination
  LEFT JOIN inventory_ownership_domains o ON o.tenant=r.tenant AND o.provider=d.provider
  WHERE r.tenant=?1
), heads AS MATERIALIZED(
  SELECT
    (SELECT w.rowid FROM inventory_delivery_review w INDEXED BY inventory_delivery_review_due
     WHERE (w.tenant,w.generation_id,w.destination,w.source_scope,w.source_config_version,w.destination_config_version)=(r.tenant,r.generation_id,r.destination,r.source_scope,r.source_config_version,r.destination_config_version)
       AND w.due_at<${WAIT_FOR_CHANGE} ORDER BY w.due_at,w.record_key LIMIT 1) AS scheduled,
    (SELECT w.rowid FROM inventory_delivery_review w INDEXED BY inventory_delivery_review_clock
     WHERE (w.tenant,w.generation_id,w.destination,w.source_scope,w.source_config_version,w.destination_config_version)=(r.tenant,r.generation_id,r.destination,r.source_scope,r.source_config_version,r.destination_config_version)
       AND w.ownership_version>=0 AND w.ownership_version<r.ownership_clock ORDER BY w.ownership_version,w.record_key LIMIT 1) AS changed
  FROM routes r
)`;

/** Rebuildable planning decisions. Even a clear review requires a fresh source proof. */
export class InventoryDeliveryReview {
  constructor(readonly store: Store) {}

  dueStatement(tenant: string) {
    return this.store.statement(
      `${reviewHeads}
         SELECT min(CASE WHEN h.changed IS NOT NULL THEN min(coalesce(w.due_at,?2),?2) ELSE w.due_at END) AS due_at
         FROM heads h LEFT JOIN inventory_delivery_review w ON w.rowid=h.scheduled`,
      tenant,
      Date.now(),
    );
  }

  async step(tenant: string) {
    if (typeof tenant !== "string" || !tenant.length || tenant.length > 512)
      throw new Error("invalid_inventory_delivery_review_tenant");
    const head = await this.store
      .statement(
        `${reviewHeads}
         SELECT w.provider,w.result_set,w.source_scope,w.destination,w.generation_id
         FROM heads h LEFT JOIN inventory_delivery_review scheduled ON scheduled.rowid=h.scheduled
         CROSS JOIN inventory_delivery_review w
         WHERE w.rowid=CASE WHEN scheduled.due_at<=?2 THEN scheduled.rowid ELSE h.changed END
         ORDER BY w.due_at,w.destination,w.source_scope,w.record_key LIMIT 1`,
        tenant,
        Date.now(),
      )
      .first<ReviewHead>();
    if (!head) return { kind: "idle" as const };
    const lease = await this.store.claim(
      tenant,
      `inventory-ownership:${head.provider}`,
      Date.now(),
      60_000,
    );
    if (!lease) return { kind: "deferred" as const };
    try {
      let rows = (
        await this.store
          .statement(
            `SELECT b.* FROM inventory_delivery_review_basis b
           WHERE (b.tenant,b.result_set,b.source_scope,b.destination)=(?,?,?,?)
             AND (b.due_at<=? OR b.ownership_version>=0 AND b.ownership_version<b.current_ownership_version)
           ORDER BY b.due_at,b.record_key LIMIT 20`,
            tenant,
            head.result_set,
            head.source_scope,
            head.destination,
            Date.now(),
          )
          .all<ReviewRow>()
      ).results;
      if (!rows.length) return { kind: "deferred" as const };
      for (;;) {
        const decisions = new Map<number, Decision>();
        let clock = rows[0].current_ownership_version;
        for (const row of rows)
          decisions.set(row.work_id, row.blocker ?? "source_proof_required");
        const candidates = rows.filter(
          (row) => decisions.get(row.work_id) === "source_proof_required",
        );
        if (head.provider === "lotw" && candidates.length) {
          try {
            const inspected = await this.inspectLotw(tenant, head, candidates);
            clock = inspected.clock ?? clock;
            if (inspected.bounded && rows.length > 1) {
              rows = rows.slice(0, Math.floor(rows.length / 2));
              continue;
            }
            for (const [id, decision] of inspected.decisions)
              decisions.set(id, decision);
          } catch (error) {
            if (!(error instanceof Error) || !readBounds.has(error.message))
              throw error;
            if (rows.length > 1) {
              rows = rows.slice(0, Math.floor(rows.length / 2));
              continue;
            }
            decisions.set(rows[0].work_id, "ownership_bound");
          }
        }
        return await this.finish(head, lease, rows, decisions, clock);
      }
    } finally {
      await this.store.release(lease);
    }
  }

  private async inspectLotw(
    tenant: string,
    head: ReviewHead,
    candidates: readonly ReviewRow[],
  ) {
    const bodies = await new InventoryProjections(this.store).bodies(
      tenant,
      head.generation_id,
      candidates.map((row) => ({
        scope: row.source_scope,
        key: row.record_key,
        facet: "source",
        version: row.projection_version,
        payload: row.projection_payload,
      })),
    );
    const decisions = new Map<number, Decision>();
    const records = new Map(
      bodies.items
        .filter((item) => item.body.state === "ready")
        .map((item) => [item.key, item.body.record]),
    );
    const available = candidates.flatMap((row) => {
      const record = records.get(row.record_key);
      if (!record) {
        decisions.set(row.work_id, "projection_unavailable");
        return [];
      }
      return [
        {
          id: String(row.work_id),
          sourceIdentity: row.source_identity,
          key: row.record_key,
          book: row.book_identity,
          remoteKey: row.record_key, // LoTW uses the station/call/time record.
          record,
        },
      ];
    });
    if (!available.length) return { decisions, bounded: false };
    const lookup = await new InventoryOwnership(this.store).lookup(
      tenant,
      "lotw",
      available,
      {
        maxRecords: 128 - bodies.items.length,
        maxBytes:
          BODY_LIMIT -
          Math.max(
            bodies.stats.encryptedInputBytes,
            bodies.stats.plaintextBytes,
          ),
      },
    );
    const bounded =
      lookup.reason === "ownership_record_bound" ||
      lookup.reason === "ownership_byte_bound";
    for (const observation of lookup.observations) {
      const decision =
        observation.state === "clear"
          ? "source_proof_required"
          : observation.state === "conflict"
            ? "ownership_conflict"
            : observation.state === "owned"
              ? "historical_owner"
              : bounded
                ? "ownership_bound"
                : "ownership_incomplete";
      decisions.set(Number(observation.id), decision);
    }
    return { decisions, bounded, clock: lookup.version };
  }

  private async finish(
    head: ReviewHead,
    lease: Lease,
    rows: ReviewRow[],
    decisions: ReadonlyMap<number, Decision>,
    clock: number,
  ) {
    const reviewedAt = Date.now();
    const claims = rows.map((row) => {
      const decision = decisions.get(row.work_id);
      if (!decision)
        throw new Error("inventory_delivery_review_decision_missing");
      return {
        id: row.work_id,
        key: row.record_key,
        version: row.result_version,
        before: row.reviewed_at,
        due: row.due_at,
        blocker: row.blocker,
        source: row.current_source_credential,
        destination: row.current_destination_credential,
        decision,
        next: transient.has(decision) ? reviewedAt + RETRY_MS : WAIT_FOR_CHANGE,
      };
    });
    const saved = await this.store
      .statement(
        `WITH authority AS MATERIALIZED(
           SELECT NOT EXISTS(SELECT 1 FROM inventory_match_stale_sets WHERE tenant=?2 AND set_id=?6) AS proof_current
           FROM leases l WHERE l.tenant=?2 AND l.scope=?3 AND l.token=?4 AND l.fence=?5 AND l.expires_at>unixepoch('subsec')*1000
         ), selected AS MATERIALIZED(
           SELECT b.work_id,j.value,authority.proof_current FROM authority CROSS JOIN json_each(?1) j CROSS JOIN inventory_delivery_review_basis b
           WHERE b.work_id=json_extract(j.value,'$.id') AND (b.tenant,b.result_set,b.source_scope,b.destination)=(?2,?6,?7,?8)
           AND (b.record_key,b.result_version,b.due_at)=(json_extract(j.value,'$.key'),json_extract(j.value,'$.version'),json_extract(j.value,'$.due'))
           AND b.reviewed_at IS json_extract(j.value,'$.before') AND b.current_ownership_version=?9
           AND b.blocker IS json_extract(j.value,'$.blocker') AND b.current_source_credential IS json_extract(j.value,'$.source') AND b.current_destination_credential IS json_extract(j.value,'$.destination')
         )
         UPDATE inventory_delivery_review AS w SET reviewed_at=?10,ownership_version=?9,
         decision=CASE WHEN s.proof_current=1 THEN json_extract(s.value,'$.decision') ELSE 'comparison_changed' END,
         due_at=CASE WHEN s.proof_current=1 THEN json_extract(s.value,'$.next') ELSE ?11 END,
         source_credential=json_extract(s.value,'$.source'),destination_credential=json_extract(s.value,'$.destination')
         FROM selected s WHERE w.rowid=s.work_id`,
        canonical(claims),
        lease.tenant,
        lease.scope,
        lease.token,
        lease.fence,
        head.result_set,
        head.source_scope,
        head.destination,
        clock,
        reviewedAt,
        reviewedAt + RETRY_MS,
      )
      .run();
    return saved.meta.changes
      ? { kind: "reviewed" as const, records: saved.meta.changes }
      : { kind: "deferred" as const };
  }
}
