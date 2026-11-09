import { InventoryQrzPreparation } from "./inventory-qrz-preparation.ts";
import { type QrzBook, QrzClient, QrzError } from "./qrz.ts";
import { selectQrzCoveringRange } from "./qrz-covering.ts";
import type { Lease, Store } from "./store.ts";
import {
  type VendorAdmission,
  VendorDeferredError,
  type VendorPriority,
  vendorFetch,
} from "./vendor-requests.ts";

const LEASE_PREFIX = "inventory:qrz-delivery:";
const READ_WINDOW_MS = 60_000;
const AUTHORITY_CHANGED = "inventory QRZ neighborhood authority changed";
interface Authority {
  destination_config: string;
  destination_connection: string;
  credential_version: string;
  request_hash: string;
  lease_expires_at: number;
  proof_expires_at: number;
}

/** Observe the exact staged artifact under the same book lease needed for
 * dispatch. Only the future dispatch path may consume a current observation. */
export class InventoryQrzNeighborhood {
  constructor(
    readonly store: Store,
    readonly fetcher: typeof fetch = fetch,
  ) {}

  async acquire(tenant: string, attempt: string) {
    const row = await this.store
      .statement(
        `SELECT a.book_identity FROM inventory_qrz_attempt_current c
         JOIN inventory_qrz_attempts a USING(tenant,attempt_id)
         WHERE c.tenant=? AND c.attempt_id=?`,
        tenant,
        attempt,
      )
      .first<{ book_identity: string }>();
    return row
      ? this.store.claim(
          tenant,
          LEASE_PREFIX + row.book_identity,
          Date.now(),
          90_000,
        )
      : null;
  }

  async observe(
    attempt: string,
    lease: Lease,
    priority: VendorPriority = "background",
  ) {
    lease = structuredClone(lease);
    const { tenant, scope, token, fence } = lease;
    const stale = { kind: "held", reason: "attempt_stale" } as const;
    const binding = await this.store
      .statement(
        `SELECT destination_config,destination_connection,credential_version,request_hash,lease_expires_at,proof_expires_at
         FROM inventory_qrz_neighborhood_authority WHERE (tenant,attempt_id,lease_scope,lease_token,lease_fence)=(?,?,?,?,?)`,
        tenant,
        attempt,
        scope,
        token,
        fence,
      )
      .first<Authority>();
    if (!binding) return stale;
    const [artifact, credential] = await Promise.all([
      new InventoryQrzPreparation(this.store).artifact(tenant, attempt),
      this.store.private<{ apiKey: string }>(
        tenant,
        binding.destination_connection,
        binding.credential_version,
        "credential",
      ),
    ]);
    if (!artifact || artifact.hash !== binding.request_hash) return stale;
    if (typeof credential?.apiKey !== "string" || !credential.apiKey)
      return { kind: "held" as const, reason: "credential_unavailable" };
    const startedAt = Date.now();
    const expiresAt = Math.min(
      binding.lease_expires_at,
      binding.proof_expires_at,
      startedAt + READ_WINDOW_MS,
    );
    if (expiresAt <= startedAt) return stale;
    let authorityChanged = false;
    const admit: VendorAdmission = async (reservation) => {
      const id = crypto.randomUUID();
      try {
        const results = await this.store.db.batch<{
          window_start: number;
          cooldown_until: number;
        }>([
          this.store.statement(
            "INSERT INTO inventory_qrz_neighborhood_guards(id,tenant,attempt_id,lease_token,lease_fence) VALUES(?,?,?,?,?)",
            id,
            tenant,
            attempt,
            token,
            fence,
          ),
          reservation,
          this.store.statement(
            "DELETE FROM inventory_qrz_neighborhood_guards WHERE id=?",
            id,
          ),
        ]);
        return results[1].results[0] ?? null;
      } catch (error) {
        authorityChanged =
          error instanceof Error && error.message.includes(AUTHORITY_CHANGED);
        throw error;
      }
    };
    const book = JSON.parse(binding.destination_config) as QrzBook;
    const client = new QrzClient(credential.apiKey, {
      fetch: vendorFetch(this.store, "qrz", this.fetcher, { priority, admit }),
      neighborhoodFallback: {
        book,
        selectCover: async (_record, target) =>
          selectQrzCoveringRange(target, [book.startDate, book.endDate]),
        // Native admission rechecks full authority before every actual read.
        isCurrent: async () => Date.now() < expiresAt,
      },
    });
    let candidateCount: number;
    try {
      candidateCount = (await client.findNeighborhood(artifact.record)).length;
    } catch (error) {
      if (error instanceof VendorDeferredError)
        return { kind: "deferred" as const, retryAt: error.retryAt };
      if (authorityChanged || Date.now() >= expiresAt) return stale;
      if (error instanceof QrzError)
        return {
          kind: "held" as const,
          reason: "qrz_neighborhood_unavailable",
        };
      throw error;
    }
    const completedAt = Date.now();
    if (completedAt >= expiresAt) return stale;
    const id = crypto.randomUUID();
    try {
      await this.store
        .statement(
          `INSERT INTO inventory_qrz_neighborhood_observations(tenant,observation_id,attempt_id,request_hash,lease_token,lease_fence,started_at,completed_at,expires_at,candidate_count)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
          tenant,
          id,
          attempt,
          artifact.hash,
          token,
          fence,
          startedAt,
          completedAt,
          expiresAt,
          candidateCount,
        )
        .run();
    } catch (error) {
      if (error instanceof Error && error.message.includes(AUTHORITY_CHANGED))
        return stale;
      throw error;
    }
    return { kind: "observed" as const, id, candidateCount, expiresAt };
  }
}
