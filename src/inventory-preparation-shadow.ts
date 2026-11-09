import {
  INVENTORY_LOTW_BATCH_LIMIT,
  INVENTORY_QRZ_BATCH_LIMIT,
} from "./inventory-delivery-limits.ts";
import { InventoryLotwPreparation } from "./inventory-lotw-preparation.ts";
import { InventoryQrzPreparation } from "./inventory-qrz-preparation.ts";
import type { InventorySourceProofJobs } from "./inventory-source-proof-jobs.ts";
import type { InventorySourceProofSnapshot } from "./inventory-source-proof-workspace.ts";
import { canonical, sha256 } from "./security.ts";

export type InventoryShadowEnvironment = Env & {
  INVENTORY_QRZ_SHADOW_JSON?: string;
  INVENTORY_LOTW_SHADOW_JSON?: string;
};
export const inventoryShadowProviders = ["qrz", "lotw"] as const;
type Provider = (typeof inventoryShadowProviders)[number];

interface Selection {
  tenant: string;
  sourceScope: string;
  destinationScope: string;
  recordKeys: string[];
}

const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

export function configuredInventoryShadow(
  env: InventoryShadowEnvironment,
  provider: Provider,
) {
  const raw =
    provider === "qrz"
      ? env.INVENTORY_QRZ_SHADOW_JSON
      : env.INVENTORY_LOTW_SHADOW_JSON;
  if (!raw) return { kind: "off" as const };
  let value: Partial<Selection> | null;
  try {
    value = JSON.parse(raw);
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
    value.recordKeys.length >
      (provider === "lotw"
        ? INVENTORY_LOTW_BATCH_LIMIT
        : INVENTORY_QRZ_BATCH_LIMIT) ||
    !value.recordKeys.every(identifier) ||
    new Set(value.recordKeys).size !== value.recordKeys.length
  )
    return { kind: "invalid" as const };
  return { kind: "configured" as const, selection: value as Selection };
}

const reviewGuard: Record<Provider, string> = {
  qrz: `json_extract(b.destination_config,'$.bookId')=b.book_identity
   AND EXISTS(SELECT 1 FROM active_templates t WHERE t.tenant=?2 AND t.destination=b.destination_connection)
   AND NOT EXISTS(SELECT 1 FROM inventory_qrz_attempts a WHERE a.tenant=?2 AND a.book_identity=b.book_identity
       AND a.source_identity=b.source_identity AND a.record_key=b.record_key AND a.cancelled_at IS NULL)`,
  lotw: `json_extract(b.destination_config,'$.readAccess')=1
   AND (json_type(b.destination_config,'$.station')='object' OR json_array_length(b.destination_config,'$.stations')>0)
   AND NOT EXISTS(SELECT 1 FROM inventory_lotw_batch_members a WHERE a.tenant=?2
       AND a.source_identity=b.source_identity AND a.record_key=b.record_key AND a.cancelled_at IS NULL)`,
};

/** The explicit selection limits the shadow to exact lookups. The source
 * proof outbox and provider preparation receipts carry durable state. */
export class InventoryPreparationShadow {
  constructor(
    readonly jobs: InventorySourceProofJobs,
    readonly selection: Selection,
    readonly provider: Provider,
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
               AND b.provider=?5 AND ${reviewGuard[this.provider]}
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
          this.provider,
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
      provider: this.provider,
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
              route.provider === this.provider &&
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
      canonical([
        `inventory-${this.provider}-shadow-v1`,
        proofId,
        destinationScope,
        keys,
      ]),
    );
    const args = [tenant, proofId, destinationScope, keys, stageId] as const;
    if (this.provider === "qrz")
      return new InventoryQrzPreparation(this.store).prepare(...args);
    const result = await new InventoryLotwPreparation(
      this.store,
      this.jobs.fetcher,
    ).prepare(...args);
    if (result.kind === "deferred" && result.retryAt >= proof.expires_at)
      return {
        kind: "held" as const,
        reason: "lotw_certificate_budget_outside_proof",
      };
    return result;
  }
}
