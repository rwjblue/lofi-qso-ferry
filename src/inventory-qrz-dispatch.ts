import {
  qrzWindowProofAllowed,
  routeDeliveryMode,
  type ScheduledDeliveryGates,
} from "./delivery-gates.ts";
import { reconcileQrzAttempt } from "./destination-receipts.ts";
import { historicalQrzLogId } from "./historical-associations.ts";
import {
  InventoryQrzNeighborhood,
  inventoryQrzBookLeaseScope,
  inventoryQrzReadAdmission,
} from "./inventory-qrz-neighborhood.ts";
import { InventoryQrzPreparation } from "./inventory-qrz-preparation.ts";
import { QRZ_ENDPOINT, type QrzBook, QrzClient, QrzError } from "./qrz.ts";
import { selectQrzCoveringRange } from "./qrz-covering.ts";
import type { Lease, Store } from "./store.ts";
import {
  type VendorAdmission,
  VendorDeferredError,
  type VendorPriority,
  vendorFetch,
} from "./vendor-requests.ts";

interface SendBinding {
  record_key: string;
  book_identity: string;
  destination_connection: string;
  destination_config: string;
  credential_version: string;
  request_hash: string;
  proof_expires_at: number;
}
interface Receipt {
  kind: "delivered" | "observed";
  remote_id: string;
}
type DispatchResult =
  | { kind: Receipt["kind"]; remoteId: string }
  | { kind: "uncertain" }
  | { kind: "deferred"; retryAt: number }
  | { kind: "held"; reason: string };

/** A reserved INSERT is never replayed. A missing response leaves an
 * unsettled claim which can only be resolved by exact readback. */
export class InventoryQrzDispatch {
  constructor(
    readonly store: Store,
    readonly fetcher: typeof fetch = fetch,
  ) {}

  private async outcome(tenant: string, attempt: string) {
    const row = await this.store
      .statement(
        `SELECT d.attempt_id,r.kind,r.remote_id,EXISTS(SELECT 1 FROM inventory_fresh_start_lock WHERE id=1) AS write_locked
         FROM (SELECT 1) seed
         LEFT JOIN inventory_qrz_dispatches d ON d.tenant=? AND d.attempt_id=?
         LEFT JOIN inventory_qrz_dispatch_receipts r ON r.tenant=d.tenant AND r.attempt_id=d.attempt_id`,
        tenant,
        attempt,
      )
      .first<
        (Receipt | { kind: null; remote_id: null }) & {
          attempt_id: string | null;
          write_locked: number;
        }
      >();
    if (!row?.attempt_id)
      return row?.write_locked
        ? { kind: "held" as const, reason: "fresh_start_requires_cutover" }
        : null;
    return row.kind
      ? { kind: row.kind, remoteId: row.remote_id }
      : { kind: "uncertain" as const };
  }

  private async openRequest(
    tenant: string,
    attempt: string,
    connection: string,
    version: string,
  ) {
    const [artifact, credential] = await Promise.all([
      new InventoryQrzPreparation(this.store).artifact(tenant, attempt),
      this.store.private<{ apiKey: string }>(
        tenant,
        connection,
        version,
        "credential",
      ),
    ]);
    return artifact &&
      typeof credential?.apiKey === "string" &&
      credential.apiKey
      ? { artifact, apiKey: credential.apiKey }
      : null;
  }

  async send(
    tenant: string,
    attempt: string,
    loadGates: () => ScheduledDeliveryGates,
    priority: VendorPriority = "background",
  ): Promise<DispatchResult> {
    const existing = await this.outcome(tenant, attempt);
    if (existing) return existing;
    const neighborhood = new InventoryQrzNeighborhood(this.store, this.fetcher);
    const lease = await neighborhood.acquire(tenant, attempt);
    if (!lease) return { kind: "held", reason: "attempt_or_book_unavailable" };
    try {
      return await this.sendLeased(
        attempt,
        lease,
        loadGates,
        priority,
        neighborhood,
      );
    } finally {
      await this.store.release(lease);
    }
  }

  private async sendLeased(
    attempt: string,
    lease: Lease,
    loadGates: () => ScheduledDeliveryGates,
    priority: VendorPriority,
    neighborhood: InventoryQrzNeighborhood,
  ): Promise<DispatchResult> {
    const { tenant, scope, token, fence } = lease;
    const stale = {
      kind: "held",
      reason: "dispatch_authority_changed",
    } as const;
    const binding = await this.store
      .statement(
        `SELECT a.record_key,a.book_identity,b.destination_connection,b.destination_config,b.credential_version,b.request_hash,b.proof_expires_at
         FROM inventory_qrz_neighborhood_authority b JOIN inventory_qrz_attempts a USING(tenant,attempt_id)
         WHERE (b.tenant,b.attempt_id,b.lease_scope,b.lease_token,b.lease_fence)=(?,?,?,?,?)`,
        tenant,
        attempt,
        scope,
        token,
        fence,
      )
      .first<SendBinding>();
    if (!binding) return stale;
    const authorized = () => {
      const gates = loadGates();
      return (
        routeDeliveryMode(gates, binding.record_key, {
          id: binding.destination_connection,
          kind: "qrz",
        }) === "qrz_fresh_insert" &&
        qrzWindowProofAllowed(gates, binding.proof_expires_at) &&
        Date.now() < binding.proof_expires_at
      );
    };
    if (!authorized()) return { kind: "held", reason: "qrz_exports_disabled" };
    const observation = await neighborhood.observe(attempt, lease, priority);
    if (observation.kind !== "observed") return observation;
    if (observation.candidateCount)
      return { kind: "held", reason: "qrz_neighborhood_has_candidate" };
    const request = await this.openRequest(
      tenant,
      attempt,
      binding.destination_connection,
      binding.credential_version,
    );
    if (!request || request.artifact.hash !== binding.request_hash)
      return stale;
    const { artifact, apiKey } = request;
    const current = () => Date.now() < observation.expiresAt && authorized();
    const claim = crypto.randomUUID();
    let reserved = false;
    const admit: VendorAdmission = async (reservation) => {
      if (!current())
        throw new Error("inventory QRZ write authorization closed");
      const result = await this.store.db.batch<{
        window_start: number;
        cooldown_until: number;
        claim_id: string;
      }>([
        this.store.statement(
          `INSERT INTO inventory_qrz_dispatch_guards(singleton,tenant,attempt_id,claim_id,observation_id,request_hash,lease_token,lease_fence,expires_at)
           VALUES(1,?,?,?,?,?,?,?,?)`,
          tenant,
          attempt,
          claim,
          observation.id,
          artifact.hash,
          token,
          fence,
          observation.expiresAt,
        ),
        reservation,
        this.store.statement(
          "SELECT claim_id FROM inventory_qrz_dispatches WHERE tenant=? AND attempt_id=?",
          tenant,
          attempt,
        ),
        this.store.statement(
          "DELETE FROM inventory_qrz_dispatch_guards WHERE singleton=1",
        ),
      ]);
      const budget = result[1].results[0];
      if (!budget) return null;
      if (result[2].results[0]?.claim_id !== claim)
        throw new Error("inventory QRZ reserved claim unavailable");
      reserved = true;
      return budget;
    };
    const guardedFetch: typeof fetch = (input, init) => {
      const form = init?.body;
      if (
        !reserved ||
        !current() ||
        String(input) !== QRZ_ENDPOINT ||
        init?.method !== "POST" ||
        init.redirect !== "manual" ||
        init.signal?.aborted ||
        !(form instanceof URLSearchParams) ||
        [...form].length !== 3 ||
        form.get("KEY") !== apiKey ||
        form.get("ACTION") !== "INSERT" ||
        form.get("ADIF") !== artifact.adif
      )
        throw new Error("inventory QRZ write transport blocked");
      reserved = false;
      return this.fetcher(input, init);
    };
    const client = new QrzClient(apiKey, {
      writesEnabled: true,
      beforeWrite: async () => current(),
      fetch: vendorFetch(this.store, "qrz", guardedFetch, { priority, admit }),
    });
    try {
      const sent = await client.insert(artifact.record);
      const remoteId = historicalQrzLogId(sent.logId);
      await this.saveReceipt(attempt, lease, {
        book: binding.book_identity,
        connection: binding.destination_connection,
        credential: binding.credential_version,
        config: binding.destination_config,
        kind: "delivered",
        remoteId,
      });
      return { kind: "delivered", remoteId };
    } catch (error) {
      const outcome = await this.outcome(tenant, attempt);
      if (outcome) return outcome;
      if (error instanceof VendorDeferredError)
        return { kind: "deferred", retryAt: error.retryAt };
      if (error instanceof QrzError) return stale;
      throw error;
    }
  }

  async reconcile(
    tenant: string,
    attempt: string,
    priority: VendorPriority = "background",
  ): Promise<DispatchResult> {
    const outcome = await this.outcome(tenant, attempt);
    if (!outcome) return { kind: "held", reason: "dispatch_unavailable" };
    if (outcome.kind !== "uncertain") return outcome;
    const pending = await this.store
      .statement(
        "SELECT book_identity FROM inventory_qrz_dispatch_pending WHERE tenant=? AND attempt_id=?",
        tenant,
        attempt,
      )
      .first<{ book_identity: string }>();
    if (!pending) return (await this.outcome(tenant, attempt)) ?? outcome;
    const lease = await this.store.claim(
      tenant,
      inventoryQrzBookLeaseScope(pending.book_identity),
      Date.now(),
      90_000,
    );
    if (!lease) return outcome;
    try {
      return await this.reconcileLeased(attempt, lease, priority);
    } finally {
      await this.store.release(lease);
    }
  }

  /** The caller owns the book lease across readback and any work update. */
  async reconcileLeased(
    attempt: string,
    lease: Lease,
    priority: VendorPriority = "background",
  ): Promise<DispatchResult> {
    const { tenant } = lease;
    const outcome = { kind: "uncertain" } as const;
    try {
      const binding = await this.store
        .statement(
          `SELECT book_identity,connection_id,credential_version,connection_config,lease_expires_at
           FROM inventory_qrz_dispatch_receipt_authority
           WHERE (tenant,attempt_id,lease_scope,lease_token,lease_fence)=(?,?,?,?,?) AND lease_fence>dispatch_fence`,
          tenant,
          attempt,
          lease.scope,
          lease.token,
          lease.fence,
        )
        .first<{
          book_identity: string;
          connection_id: string;
          credential_version: string;
          connection_config: string;
          lease_expires_at: number;
        }>();
      if (!binding) return outcome;
      const request = await this.openRequest(
        tenant,
        attempt,
        binding.connection_id,
        binding.credential_version,
      );
      if (!request) return outcome;
      const { artifact, apiKey } = request;
      const book = JSON.parse(binding.connection_config) as QrzBook;
      const compactDate = artifact.record.QSO_DATE;
      const day = `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6, 8)}`;
      if (
        day < book.startDate ||
        day > book.endDate ||
        artifact.record.STATION_CALLSIGN !== book.stationCallsign?.toUpperCase()
      )
        return outcome;
      const started = Date.now();
      const deadline = Math.min(binding.lease_expires_at, started + 60_000);
      if (deadline <= started) return outcome;
      const isCurrent = () => Date.now() < deadline;
      const client = new QrzClient(apiKey, {
        fetch: vendorFetch(this.store, "qrz", this.fetcher, {
          priority,
          admit: inventoryQrzReadAdmission(this.store, attempt, lease, {
            connection: binding.connection_id,
            credential: binding.credential_version,
            config: binding.connection_config,
          }),
        }),
        neighborhoodFallback: {
          book,
          selectCover: async (_record, target) =>
            selectQrzCoveringRange(target, [book.startDate, book.endDate]),
          isCurrent: async () => isCurrent(),
        },
      });
      await client.verifyBook(book, AbortSignal.timeout(deadline - started));
      const candidates = await client.findNeighborhood(artifact.record);
      const match = reconcileQrzAttempt(artifact.record, candidates);
      if (!isCurrent() || match.state !== "observed" || !match.remoteId)
        return outcome;
      const remoteId = historicalQrzLogId(match.remoteId);
      await this.saveReceipt(attempt, lease, {
        book: binding.book_identity,
        connection: binding.connection_id,
        credential: binding.credential_version,
        config: binding.connection_config,
        kind: "observed",
        remoteId,
        readStartedAt: started,
      });
      return { kind: "observed", remoteId };
    } catch (error) {
      if (error instanceof VendorDeferredError)
        return { kind: "deferred", retryAt: error.retryAt };
      // A lost acknowledgement may already have committed the exact receipt.
      const recovered = await this.outcome(tenant, attempt);
      if (recovered && recovered.kind !== "uncertain") return recovered;
      if (
        error instanceof QrzError ||
        (error instanceof Error &&
          (error.message.includes("inventory QRZ receipt authority changed") ||
            error.message.includes("UNIQUE constraint")))
      )
        return outcome;
      throw error;
    }
  }

  private async saveReceipt(
    attempt: string,
    lease: Lease,
    evidence: {
      book: string;
      connection: string;
      credential: string;
      config: string;
      kind: Receipt["kind"];
      remoteId: string;
      readStartedAt?: number;
    },
  ) {
    await this.store
      .statement(
        `INSERT INTO inventory_qrz_dispatch_receipts(tenant,attempt_id,book_identity,kind,remote_id,connection_id,credential_version,connection_config,lease_token,lease_fence,read_started_at,received_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,CAST(unixepoch('subsec')*1000 AS INTEGER))`,
        lease.tenant,
        attempt,
        evidence.book,
        evidence.kind,
        evidence.remoteId,
        evidence.connection,
        evidence.credential,
        evidence.config,
        lease.token,
        lease.fence,
        evidence.readStartedAt ?? null,
      )
      .run();
  }
}
