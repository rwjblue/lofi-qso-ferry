import { HISTORICAL_CANDIDATE_POLICY_VERSION } from "./historical-matching.ts";
import {
  INVENTORY_COMPARISON_BUCKET_MS,
  INVENTORY_COMPARISON_KEY_VERSION,
  type InventoryComparisonKey,
  type InventoryComparisonKeyContext,
  importInventoryComparisonKey,
} from "./inventory-comparison-keys.ts";
import { type Envelope, open, randomToken, rewrap, seal } from "./security.ts";
import type { Store } from "./store.ts";

interface KeyRow {
  key_id: string;
  envelope: string;
}
export interface InventoryComparisonGeneration {
  generation_id: string;
  key_id: string;
  key_version: number;
  policy_version: number;
  bucket_ms: number;
  state: "building" | "active" | "retired";
}
export interface InventoryComparisonDomain {
  tenant: string;
  version: number;
  source_set_version: number;
  active_generation: string | null;
  pending_generation: string | null;
}
const identity = (tenant: string, keyId: string) => ({
  tenant,
  connection: "inventory-comparison",
  id: keyId,
  kind: "inventory_comparison_key",
  purpose: "storage",
});

/** Stable tenant keys are envelope encrypted; rotating a KEK does not rehash data. */
export class InventoryComparisonGenerations {
  constructor(readonly store: Store) {}

  private row(tenant: string) {
    return this.store
      .statement(
        "SELECT key_id,envelope FROM inventory_comparison_keys WHERE tenant=?",
        tenant,
      )
      .first<KeyRow>();
  }

  private async decode(tenant: string, row: KeyRow) {
    const value = await open<{ secret: string }>(
      JSON.parse(row.envelope) as Envelope,
      identity(tenant, row.key_id),
      this.store.keys,
    );
    const key = await importInventoryComparisonKey(tenant, value.secret);
    if (key.keyId !== row.key_id)
      throw new Error("inventory_comparison_key_identity_changed");
    return key;
  }

  async key(tenant: string): Promise<InventoryComparisonKey> {
    let row = await this.row(tenant);
    if (!row) {
      const secret = randomToken();
      const key = await importInventoryComparisonKey(tenant, secret);
      const envelope = await seal(
        { secret },
        identity(tenant, key.keyId),
        this.store.keys,
      );
      await this.store
        .statement(
          "INSERT INTO inventory_comparison_keys(tenant,key_id,envelope,created_at) VALUES(?,?,?,?) ON CONFLICT(tenant) DO NOTHING",
          tenant,
          key.keyId,
          JSON.stringify(envelope),
          Date.now(),
        )
        .run();
      // Another caller may have won creation with a different secret.
      row = await this.row(tenant);
    }
    if (!row) throw new Error("inventory_comparison_key_missing");
    return this.decode(tenant, row);
  }

  async rewrapKey(tenant: string): Promise<boolean> {
    const row = await this.row(tenant);
    if (!row) return false;
    await this.decode(tenant, row);
    const envelope = await rewrap(
      JSON.parse(row.envelope) as Envelope,
      identity(tenant, row.key_id),
      this.store.keys,
    );
    const result = await this.store
      .statement(
        "UPDATE inventory_comparison_keys SET envelope=? WHERE tenant=? AND key_id=? AND envelope=?",
        JSON.stringify(envelope),
        tenant,
        row.key_id,
        row.envelope,
      )
      .run();
    return result.meta.changes === 1;
  }

  domain(tenant: string) {
    return this.store
      .statement("SELECT * FROM comparison_domains WHERE tenant=?", tenant)
      .first<InventoryComparisonDomain>();
  }

  /** Idempotently request a side-by-side build, never publish it as complete. */
  async begin(tenant: string): Promise<InventoryComparisonDomain> {
    const key = await this.key(tenant);
    await this.store.db.batch([
      this.store.statement(
        "INSERT INTO comparison_domains(tenant) VALUES(?) ON CONFLICT DO NOTHING",
        tenant,
      ),
      this.store.statement(
        `INSERT INTO index_generations(tenant,generation_id,key_id,key_version,policy_version,bucket_ms,created_at)
         SELECT ?,?,?,?,?,?,? FROM comparison_domains WHERE tenant=? AND pending_generation IS NULL`,
        tenant,
        crypto.randomUUID(),
        key.keyId,
        INVENTORY_COMPARISON_KEY_VERSION,
        HISTORICAL_CANDIDATE_POLICY_VERSION,
        INVENTORY_COMPARISON_BUCKET_MS,
        Date.now(),
        tenant,
      ),
    ]);
    const domain = await this.domain(tenant);
    if (!domain?.pending_generation)
      throw new Error("inventory_comparison_build_missing");
    return domain;
  }

  async writers(tenant: string): Promise<{
    domain: InventoryComparisonDomain;
    contexts: InventoryComparisonKeyContext[];
  } | null> {
    // Capture the pointers, formats and wrapped key in one snapshot.
    const rows = await this.store
      .statement(
        `SELECT d.*,g.generation_id,g.key_id,g.key_version,g.policy_version,g.bucket_ms,g.state,k.envelope
         FROM comparison_domains d JOIN index_generations g ON g.tenant=d.tenant
         AND g.generation_id IN (d.active_generation,d.pending_generation)
         LEFT JOIN inventory_comparison_keys k ON (k.tenant,k.key_id)=(g.tenant,g.key_id)
         WHERE d.tenant=?`,
        tenant,
      )
      .all<
        InventoryComparisonDomain &
          InventoryComparisonGeneration & {
            envelope: string | null;
          }
      >();
    const first = rows.results[0];
    if (!first) return null;
    if (first.envelope === null)
      throw new Error("inventory_comparison_key_missing");
    const key = await this.decode(tenant, {
      key_id: first.key_id,
      envelope: first.envelope,
    });
    for (const row of rows.results)
      if (
        row.key_id !== key.keyId ||
        row.key_version !== INVENTORY_COMPARISON_KEY_VERSION ||
        row.policy_version !== HISTORICAL_CANDIDATE_POLICY_VERSION ||
        row.bucket_ms !== INVENTORY_COMPARISON_BUCKET_MS
      )
        throw new Error("inventory_comparison_format_unsupported");
    return {
      domain: {
        tenant,
        version: first.version,
        source_set_version: first.source_set_version,
        active_generation: first.active_generation,
        pending_generation: first.pending_generation,
      },
      contexts: rows.results.map((row) => ({
        ...key,
        generation: row.generation_id,
      })),
    };
  }
}
