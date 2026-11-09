import { historicalCandidates } from "./historical-matching.ts";
import { inventoryLotwReportGroups } from "./inventory-lotw-neighborhood.ts";
import { InventoryLotwPreparation } from "./inventory-lotw-preparation.ts";
import { LotwClient } from "./lotw.ts";
import {
  certificateCurrentlyValid,
  lotwAttemptIdentity,
  type LotwCredential,
  lotwSigningCertificate,
} from "./lotw-delivery-input.ts";
import { canonical, sha256 } from "./security.ts";
import { routeDeliveryMode, type ScheduledDeliveryGates } from "./service.ts";
import { SIGNING_CONFIGURATION } from "./signing.ts";
import type { Lease, Store } from "./store.ts";
import {
  type VendorAdmission,
  VendorDeferredError,
  type VendorPriority,
  vendorFetch,
} from "./vendor-requests.ts";

const LOTW_ORIGIN = "https://lotw.arrl.org";
const UPLOAD_URL = `${LOTW_ORIGIN}/lotw/upload`;
export const INVENTORY_LOTW_DELIVERY_LEASE = "inventory:lotw-delivery";
const held = (reason: string) => ({ kind: "held" as const, reason });
type SendResult =
  | ReturnType<typeof held>
  | { kind: "deferred"; retryAt: number }
  | { kind: "submitted" | "rejected" | "uncertain" };
interface Authority {
  destination_connection: string;
  credential_version: string;
  wire_hash: string;
  manifest_hash: string;
  member_count: number;
  proof_expires_at: number;
  lease_expires_at: number;
}

/** Sending a batch requires a new complete neighborhood check. The claim and
 * request slot are one transaction and no claim is ever reused for transport. */
export class InventoryLotwDispatch {
  constructor(
    readonly store: Store,
    readonly fetcher: typeof fetch = fetch,
  ) {}

  private async outcome(tenant: string, batch: string) {
    const row = await this.store
      .statement(
        `SELECT r.state FROM inventory_lotw_dispatches d LEFT JOIN inventory_lotw_upload_receipts r USING(tenant,batch_id)
       WHERE (d.tenant,d.batch_id)=(?,?)`,
        tenant,
        batch,
      )
      .first<{ state: "submitted" | "rejected" | null }>();
    return row ? { kind: row.state ?? ("uncertain" as const) } : null;
  }

  async send(
    tenant: string,
    batch: string,
    loadGates: () => ScheduledDeliveryGates,
    priority: VendorPriority = "background",
  ): Promise<SendResult> {
    const prior = await this.outcome(tenant, batch);
    if (prior) return prior;
    const lease = await this.store.claim(
      tenant,
      INVENTORY_LOTW_DELIVERY_LEASE,
      Date.now(),
      90_000,
    );
    if (!lease) return held("lotw_delivery_busy");
    try {
      return await this.sendLeased(batch, lease, loadGates, priority);
    } catch (error) {
      const claimed = await this.outcome(tenant, batch);
      if (claimed) return claimed;
      if (error instanceof VendorDeferredError)
        return { kind: "deferred", retryAt: error.retryAt };
      if (
        error instanceof Error &&
        error.message.includes("inventory LoTW send authority changed")
      )
        return held("lotw_send_authority_changed");
      throw error;
    } finally {
      await this.store.release(lease);
    }
  }

  private async sendLeased(
    batch: string,
    lease: Lease,
    loadGates: () => ScheduledDeliveryGates,
    priority: VendorPriority,
  ): Promise<SendResult> {
    const { tenant, token, fence } = lease;
    const stale = held("lotw_send_authority_changed");
    const binding = await this.store
      .statement(
        `SELECT * FROM inventory_lotw_send_authority WHERE (tenant,batch_id,lease_token,lease_fence)=(?,?,?,?)`,
        tenant,
        batch,
        token,
        fence,
      )
      .first<Authority>();
    if (!binding) return stale;
    const artifact = await new InventoryLotwPreparation(this.store).artifact(
      tenant,
      batch,
    );
    if (
      !artifact ||
      artifact.hash !== binding.wire_hash ||
      artifact.members.length !== binding.member_count ||
      artifact.signingConfiguration !== SIGNING_CONFIGURATION
    )
      return stale;
    const authorized = () => {
      const gates = loadGates();
      return artifact.members.every(
        ({ qso }) =>
          routeDeliveryMode(gates, qso.id, {
            id: binding.destination_connection,
            kind: "lotw",
          }) === "lotw_fresh_insert",
      );
    };
    if (!authorized()) return held("lotw_exports_disabled");
    const credential = await this.store.private<LotwCredential>(
      tenant,
      binding.destination_connection,
      binding.credential_version,
      "credential",
    );
    if (!credential?.query) return held("lotw_query_credential_unavailable");
    const certificate = lotwSigningCertificate(
      credential,
      artifact.station,
      artifact.members[0].qso,
    );
    if (
      !certificate ||
      certificate.version !== artifact.certificate.version ||
      certificate.serial !== artifact.certificate.serial ||
      (await sha256(certificate.certificatePem)) !==
        artifact.certificate.hash ||
      !artifact.members.every(
        ({ qso }) =>
          lotwSigningCertificate(credential, artifact.station, qso) ===
          certificate,
      )
    )
      return held("lotw_certificate_changed");
    const groups = inventoryLotwReportGroups(
      artifact.station,
      artifact.members,
    );
    if (!groups) return held("lotw_batch_history_bound");
    const identities = await Promise.all(
      artifact.members.map(async ({ qso }) => {
        const { identity } = await lotwAttemptIdentity(artifact.station, qso);
        return Object.fromEntries(
          Object.entries(identity).filter(([, value]) => value !== ""),
        );
      }),
    );
    if (
      identities.some(
        (identity) =>
          historicalCandidates(
            "lotw",
            identity,
            identities.filter((other) => other !== identity),
          ).state !== "none",
      )
    )
      return held("lotw_batch_identity_conflict");
    const startedAt = Date.now();
    const expiresAt = Math.min(
      startedAt + 60_000,
      binding.lease_expires_at,
      binding.proof_expires_at,
    );
    const current = () =>
      Date.now() < expiresAt &&
      authorized() &&
      certificateCurrentlyValid(certificate, Date.now());
    if (!current()) return stale;
    const client = new LotwClient(credential.query, {
      fetcher: this.neighborhoodFetch(
        batch,
        lease,
        certificate.serial,
        expiresAt,
        current,
        priority,
      ),
    });
    try {
      const status = await client.certificateStatus(certificate.serial);
      if (!current()) return stale;
      if (status !== "unrevoked") return held(`lotw_certificate_${status}`);
      for (const { query, selections } of groups) {
        const report = await client.query(query);
        if (
          selections.some(({ selection }) =>
            report.records.some(
              (record) =>
                record.CALL.toUpperCase() === selection.workedCallsign &&
                record.QSO_DATE >= selection.startDate.replaceAll("-", "") &&
                record.QSO_DATE <= selection.endDate.replaceAll("-", ""),
            ),
          )
        )
          return held("lotw_batch_existing_history");
        if (!current()) return stale;
      }
    } catch (error) {
      if (error instanceof VendorDeferredError) throw error;
      return current() ? held("lotw_batch_history_unavailable") : stale;
    }
    const observation = crypto.randomUUID();
    await this.store
      .statement(
        `INSERT INTO inventory_lotw_observations(tenant,observation_id,batch_id,wire_hash,manifest_hash,members,report_count,lease_token,lease_fence,started_at,completed_at,expires_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,CAST(unixepoch('subsec')*1000 AS INTEGER),?)`,
        tenant,
        observation,
        batch,
        artifact.hash,
        binding.manifest_hash,
        canonical(artifact.members.map(({ attemptId }) => attemptId)),
        groups.length,
        token,
        fence,
        startedAt,
        expiresAt,
      )
      .run();
    return this.submit(
      batch,
      lease,
      observation,
      artifact,
      expiresAt,
      current,
      priority,
    );
  }

  private neighborhoodFetch(
    batch: string,
    lease: Lease,
    serial: string,
    expiresAt: number,
    current: () => boolean,
    priority: VendorPriority,
  ): typeof fetch {
    const admitted = vendorFetch(this.store, "lotw", this.fetcher, {
      priority,
      admit: async (reservation) => {
        if (!current())
          throw new Error("inventory LoTW send authority changed");
        const guard = crypto.randomUUID();
        const results = await this.store.db.batch<{
          window_start: number;
          cooldown_until: number;
        }>([
          this.store.statement(
            "INSERT INTO inventory_lotw_read_guards VALUES(?,?,?,?,?)",
            guard,
            lease.tenant,
            batch,
            lease.token,
            lease.fence,
          ),
          reservation,
          this.store.statement(
            "DELETE FROM inventory_lotw_read_guards WHERE id=?",
            guard,
          ),
        ]);
        return results[1].results[0] ?? null;
      },
    });
    return (input, init) => {
      const url = new URL(String(input));
      if (
        url.origin !== LOTW_ORIGIN ||
        url.username ||
        url.password ||
        url.hash ||
        (init?.method ?? "GET") !== "GET" ||
        init?.body != null ||
        init?.redirect !== "manual" ||
        (url.pathname !== "/lotwuser/lotwreport.adi" &&
          url.href !== `${LOTW_ORIGIN}/lotw/crl?serial=${serial}`) ||
        !current()
      )
        throw new Error("inventory LoTW send authority changed");
      const deadline = AbortSignal.timeout(Math.max(1, expiresAt - Date.now()));
      return admitted(input, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, deadline])
          : deadline,
      });
    };
  }

  private async submit(
    batch: string,
    lease: Lease,
    observation: string,
    artifact: { bytes: Uint8Array; hash: string },
    expiresAt: number,
    current: () => boolean,
    priority: VendorPriority,
  ): Promise<SendResult> {
    const { tenant, token, fence } = lease;
    const claim = crypto.randomUUID();
    let reserved = false;
    const admit: VendorAdmission = async (reservation) => {
      if (!current()) throw new Error("inventory LoTW send authority changed");
      const result = await this.store.db.batch<{
        window_start: number;
        cooldown_until: number;
        claim_id: string;
      }>([
        this.store.statement(
          "INSERT INTO inventory_lotw_dispatch_guards VALUES(1,?,?,?,?,?,?,?,?)",
          tenant,
          batch,
          claim,
          observation,
          artifact.hash,
          token,
          fence,
          expiresAt,
        ),
        reservation,
        this.store.statement(
          "SELECT claim_id FROM inventory_lotw_dispatches WHERE tenant=? AND batch_id=?",
          tenant,
          batch,
        ),
        this.store.statement(
          "DELETE FROM inventory_lotw_dispatch_guards WHERE singleton=1",
        ),
      ]);
      const budget = result[1].results[0];
      if (!budget) return null;
      if (result[2].results[0]?.claim_id !== claim)
        throw new Error("inventory LoTW send authority changed");
      reserved = true;
      return budget;
    };
    const fetcher: typeof fetch = async (input, init) => {
      const form = init?.body;
      const file = form instanceof FormData ? form.get("upfile") : null;
      const exact = () =>
        String(input) === UPLOAD_URL &&
        init?.method === "POST" &&
        init.redirect === "manual" &&
        init.body === form &&
        form instanceof FormData &&
        [...form.keys()].length === 1 &&
        form.get("upfile") === file &&
        file instanceof File &&
        file.name === "lofi-qso-ferry.tq8" &&
        file.type === "application/octet-stream" &&
        file.size === artifact.bytes.length;
      if (
        !exact() ||
        !(file instanceof File) ||
        (await sha256(new Uint8Array(await file.arrayBuffer()))) !==
          artifact.hash ||
        !current()
      )
        throw new Error("inventory LoTW send authority changed");
      const guarded: typeof fetch = (outbound, options) => {
        if (
          !reserved ||
          !exact() ||
          !current() ||
          outbound !== input ||
          options !== init
        )
          throw new Error("inventory LoTW send authority changed");
        reserved = false;
        return this.fetcher(outbound, options);
      };
      return vendorFetch(this.store, "lotw", guarded, { priority, admit })(
        input,
        init,
      );
    };
    const result = await new LotwClient(null, {
      fetcher,
      exportsEnabled: true,
    }).submit(artifact.bytes, { liveWriteAuthorized: true });
    const claimed = await this.outcome(tenant, batch);
    if (!claimed) return held("lotw_send_authority_changed");
    if (result.state === "uncertain" || claimed.kind !== "uncertain")
      return claimed;
    await this.store
      .statement(
        `INSERT INTO inventory_lotw_upload_receipts(tenant,batch_id,state,received_at)
       VALUES(?,?,?,CAST(unixepoch('subsec')*1000 AS INTEGER))`,
        tenant,
        batch,
        result.state,
      )
      .run();
    return { kind: result.state };
  }
}
