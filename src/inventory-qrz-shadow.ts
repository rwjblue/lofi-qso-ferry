import { InventoryQrzPreparation } from "./inventory-qrz-preparation.ts";
import type { InventorySourceProofJobs } from "./inventory-source-proof-jobs.ts";
import type { InventorySourceProofSnapshot } from "./inventory-source-proof-workspace.ts";
import { canonical, sha256 } from "./security.ts";

export type InventoryShadowEnvironment = Env & {
  INVENTORY_QRZ_SHADOW_JSON?: string;
};

interface Selection {
  tenant: string;
  sourceScope: string;
  destinationScope: string;
  recordKeys: string[];
}

const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

export function configuredQrzShadow(env: InventoryShadowEnvironment) {
  if (!env.INVENTORY_QRZ_SHADOW_JSON) return { kind: "off" as const };
  let value: Partial<Selection> | null;
  try {
    value = JSON.parse(env.INVENTORY_QRZ_SHADOW_JSON);
  } catch {
    return { kind: "invalid" as const };
  }
  if (
    !value ||
    !identifier(value.tenant) ||
    !identifier(value.sourceScope) ||
    !identifier(value.destinationScope) ||
    !Array.isArray(value.recordKeys) ||
    value.recordKeys.length < 1 ||
    value.recordKeys.length > 20 ||
    !value.recordKeys.every(identifier) ||
    new Set(value.recordKeys).size !== value.recordKeys.length
  )
    return { kind: "invalid" as const };
  return { kind: "configured" as const, selection: value as Selection };
}

/** The explicit selection limits the shadow to exact lookups. The existing
 * source proof outbox and QRZ preparation receipt carry durable state. */
export class InventoryQrzShadow {
  constructor(
    readonly jobs: InventorySourceProofJobs,
    readonly selection: Selection,
  ) {}

  private get store() {
    return this.jobs.runs.inventory.store;
  }

  private async reviews(keys: readonly string[]) {
    const { tenant, sourceScope, destinationScope } = this.selection;
    return (
      await this.store
        .statement(
          `WITH chosen AS MATERIALIZED(
             SELECT b.record_key,b.proof_not_before,b.result_set
             FROM json_each(?1) j CROSS JOIN inventory_delivery_preparation_review b
             WHERE (b.tenant,b.source_scope,b.destination,b.record_key)=(?2,?3,?4,j.value)
               AND b.provider='qrz' AND json_extract(b.destination_config,'$.bookId')=b.book_identity
               AND EXISTS(SELECT 1 FROM active_templates t WHERE t.tenant=?2 AND t.destination=b.destination_connection)
               AND NOT EXISTS(SELECT 1 FROM inventory_qrz_attempts a WHERE a.tenant=?2 AND a.book_identity=b.book_identity
                 AND a.source_identity=b.source_identity AND a.record_key=b.record_key AND a.cancelled_at IS NULL)
               AND NOT EXISTS(SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=?2)
           ), fresh AS MATERIALIZED(
             SELECT result_set FROM (SELECT DISTINCT result_set FROM chosen) c
             WHERE NOT EXISTS(SELECT 1 FROM inventory_match_stale_sets x WHERE x.tenant=?2 AND x.set_id=c.result_set)
           )
           SELECT c.record_key,c.proof_not_before FROM chosen c JOIN fresh f USING(result_set) ORDER BY c.record_key`,
          canonical(keys),
          tenant,
          sourceScope,
          destinationScope,
        )
        .all<{ record_key: string; proof_not_before: number }>()
    ).results;
  }

  async enroll() {
    const { tenant, sourceScope, destinationScope, recordKeys } =
      this.selection;
    const reviews = await this.reviews(recordKeys);
    if (!reviews.length) return { kind: "idle" as const };
    const completed = await this.store
      .statement(
        `SELECT job_id FROM inventory_source_proof_jobs
         WHERE tenant=? AND scope_id=? AND phase='complete'`,
        tenant,
        sourceScope,
      )
      .first<string>("job_id");
    if (completed) {
      const staged = await this.stage(completed);
      if (staged.kind !== "idle") return staged;
    }
    const now = Date.now();
    const keys = reviews
      .filter((row) => row.proof_not_before <= now)
      .map((row) => row.record_key);
    if (!keys.length) return { kind: "idle" as const };
    const result = await this.jobs.enqueue(tenant, sourceScope, keys, {
      provider: "qrz",
      destination: destinationScope,
    });
    return result.kind === "complete" ? this.stage(result.id) : result;
  }

  async stage(proofId: string) {
    const { tenant, sourceScope, destinationScope, recordKeys } =
      this.selection;
    const proof = await this.store
      .statement(
        `SELECT snapshot,expires_at FROM inventory_source_proof_current
         WHERE tenant=? AND proof_id=? AND scope_id=?`,
        tenant,
        proofId,
        sourceScope,
      )
      .first<{ snapshot: string; expires_at: number }>();
    if (!proof) return { kind: "idle" as const };
    const snapshot = JSON.parse(proof.snapshot) as InventorySourceProofSnapshot;
    const covered = snapshot.contacts
      .filter(
        ({ key, routes }) =>
          recordKeys.includes(key) &&
          routes.some(
            (route) =>
              route.provider === "qrz" &&
              route.destination === destinationScope,
          ),
      )
      .map(({ key }) => key);
    if (!covered.length) return { kind: "idle" as const };
    const reviews = await this.reviews(covered);
    if (!reviews.length) return { kind: "idle" as const };
    const retryAt = Math.max(...reviews.map((row) => row.proof_not_before));
    if (retryAt >= proof.expires_at) return { kind: "idle" as const };
    if (retryAt > Date.now()) return { kind: "quiet" as const, retryAt };
    const keys = reviews.map((row) => row.record_key);
    const stageId = await sha256(
      canonical(["inventory-qrz-shadow-v1", proofId, destinationScope, keys]),
    );
    return new InventoryQrzPreparation(this.store).prepare(
      tenant,
      proofId,
      destinationScope,
      keys,
      stageId,
    );
  }
}
