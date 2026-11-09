import type { AdifRecord } from "./adif.ts";
import { routeDeliveryMode } from "./delivery-gates.ts";
import { INVENTORY_LOTW_DELIVERY_LEASE } from "./inventory-lotw-dispatch.ts";
import { lotwInventoryObservations } from "./inventory-observations.ts";
import {
  InventoryProjections,
  openInventoryProjectionBody,
} from "./inventory-projections.ts";
import type { InventorySourceProofJobs } from "./inventory-source-proof-jobs.ts";
import {
  type InventoryDeliveryEnvironment,
  managedInventoryAuthorization,
} from "./inventory-upload-authorization.ts";
import { LotwClient, type LotwQuery } from "./lotw.ts";
import {
  certificateCurrentlyValid,
  type LotwCredential,
  lotwSigningCertificate,
} from "./lotw-delivery-input.ts";
import {
  lotwGridCorrectionObserved,
  lotwGridCorrectionRecord,
  lotwGridCorrectionTarget,
} from "./lotw-grid-correction.ts";
import { canonical, type Envelope, open, seal, sha256 } from "./security.ts";
import { buildSignedTq8 } from "./signing.ts";
import type { Lease, Store } from "./store.ts";
import { VendorDeferredError, vendorFetch } from "./vendor-requests.ts";

export type LotwGridUpdateEnvironment = InventoryDeliveryEnvironment & {
  LOTW_GRID_CORRECTIONS_ENABLED?: string;
};
interface Candidate {
  tenant: string;
  association_id: string;
  source_scope: string;
  destination: string;
  destination_connection: string;
  destination_credential: string;
  destination_config: string;
  record_key: string;
  remote_key: string;
  result_set: string;
  result_version: number;
  generation_id: string;
  projection_version: number;
  projection_payload: string;
  remote_version: number;
  remote_payload: string;
  adopted_remote_payload: string;
  adopted_destination: string;
}
interface Claimed {
  tenant: string;
  association_id: string;
  source_payload: string;
  claimed_at: number;
  checks: number;
  envelope: string;
  connection_id: string;
  credential_version: string;
}
interface UpdateEvidence {
  original: AdifRecord;
  grid: string;
  query: LotwQuery;
}
const uploadUrl = "https://lotw.arrl.org/lotw/upload";
const minute = 60_000;
const proofPurpose = "lotw_grid_correction";
const evidenceIdentity = (row: {
  tenant: string;
  association_id: string;
  source_payload: string;
}) => ({
  tenant: row.tenant,
  connection: row.association_id,
  id: row.source_payload,
  kind: "lotw_grid_correction",
  purpose: "storage",
});
const leaseCurrent = `EXISTS(SELECT 1 FROM leases l WHERE
  (l.tenant,l.scope,l.token,l.fence)=(?1,?2,?3,?4)
  AND l.expires_at>unixepoch('subsec')*1000)`;
const leaseArgs = (lease: Lease) =>
  [lease.tenant, lease.scope, lease.token, lease.fence] as const;

/** One correction and one readback per scheduled turn. A durable pre-send
 * claim makes every uncertain outcome readback-only. */
export class InventoryLotwGridUpdates {
  constructor(
    readonly store: Store,
    readonly jobs: Pick<InventorySourceProofJobs, "enqueue">,
    readonly fetcher: typeof fetch = fetch,
  ) {}

  private authorization(env: LotwGridUpdateEnvironment) {
    return env.LOTW_GRID_CORRECTIONS_ENABLED === "true"
      ? managedInventoryAuthorization(env, "lotw")
      : null;
  }

  async step(env: LotwGridUpdateEnvironment) {
    const observed = await this.readback();
    const auth = this.authorization(env);
    if (!auth) return { attempted: false, observed };
    const row = await this.store
      .statement(
        `SELECT c.* FROM inventory_lotw_grid_correction_candidates c
         WHERE (?1 IS NULL OR c.record_key IN(SELECT value FROM json_each(?1)))
         AND (?2 IS NULL OR c.destination_connection IN(SELECT value FROM json_each(?2)))
         AND NOT EXISTS(SELECT 1 FROM inventory_lotw_grid_updates u
          WHERE (u.tenant,u.association_id)=(c.tenant,c.association_id)
          AND (u.state IN('uncertain','submitted','attention')
            OR (u.source_payload=c.projection_payload AND (u.state='observed' OR u.due_at>?3))))
         ORDER BY c.derived_at,c.tenant,c.destination,c.source_scope,c.record_key LIMIT 1`,
        auth.keys === null ? null : canonical(auth.keys),
        auth.destinations === null ? null : canonical(auth.destinations),
        Date.now(),
      )
      .first<Candidate>();
    if (!row) return { attempted: false, observed };
    const proof = await this.jobs.enqueue(
      row.tenant,
      row.source_scope,
      [row.record_key],
      { provider: "lotw", destination: row.destination, purpose: proofPurpose },
    );
    if (proof.kind !== "complete") {
      if (proof.kind === "held" || proof.kind === "quiet")
        await this.defer(
          row,
          proof.kind === "quiet" ? "source_quiet_period" : proof.reason,
          proof.kind === "quiet" ? proof.retryAt : Date.now() + 5 * minute,
        );
      return { attempted: false, observed };
    }
    const lease = await this.store.claim(
      row.tenant,
      INVENTORY_LOTW_DELIVERY_LEASE,
      Date.now(),
      90_000,
    );
    if (!lease) return { attempted: false, observed };
    try {
      return {
        attempted: await this.update(
          row,
          proof.id,
          proof.expiresAt,
          lease,
          env,
        ),
        observed,
      };
    } catch (error) {
      if (error instanceof VendorDeferredError)
        await this.defer(row, "lotw_request_deferred", error.retryAt);
      else await this.defer(row, "lotw_grid_update_unavailable");
      return { attempted: false, observed };
    } finally {
      await this.store.release(lease);
    }
  }

  private defer(row: Candidate, reason: string, at = Date.now() + 15 * minute) {
    return this.store
      .statement(
        `INSERT INTO inventory_lotw_grid_updates(tenant,association_id,source_scope,source_payload,state,reason,due_at)
         VALUES(?,?,?,?,'deferred',?,?)
         ON CONFLICT(tenant,association_id,source_payload) DO UPDATE SET reason=excluded.reason,due_at=excluded.due_at
         WHERE state='deferred'`,
        row.tenant,
        row.association_id,
        row.source_scope,
        row.projection_payload,
        reason,
        at,
      )
      .run();
  }

  private async update(
    row: Candidate,
    proof: string,
    proofExpiresAt: number,
    lease: Lease,
    env: LotwGridUpdateEnvironment,
  ) {
    const deadline = Math.min(
      proofExpiresAt,
      lease.expires_at,
      Date.now() + minute,
    );
    const current = () => {
      const auth = this.authorization(env);
      return (
        auth &&
        Date.now() < Math.min(deadline, auth.expiresAt) &&
        routeDeliveryMode(auth.gates, row.record_key, {
          id: row.destination_connection,
          kind: "lotw",
        }) === "lotw_fresh_insert"
      );
    };
    if (!current()) return false;
    const credential = await this.store.private<LotwCredential>(
      row.tenant,
      row.destination_connection,
      row.destination_credential,
      "credential",
    );
    if (!credential?.query) {
      await this.defer(row, "lotw_query_credential_unavailable");
      return false;
    }
    const projections = await new InventoryProjections(this.store).bodies(
      row.tenant,
      row.generation_id,
      [
        {
          scope: row.source_scope,
          key: row.record_key,
          facet: "source",
          version: row.projection_version,
          payload: row.projection_payload,
        },
        {
          scope: row.destination,
          key: row.remote_key,
          facet: "receipt",
          version: row.remote_version,
          payload: row.remote_payload,
        },
      ],
    );
    const source = projections.items.find(
      (item) => item.facet === "source",
    )?.body;
    const remote = projections.items.find(
      (item) => item.facet === "receipt",
    )?.body;
    const grid = source?.record.MY_GRIDSQUARE;
    if (!grid || source?.state !== "ready" || remote?.state !== "ready")
      return false;
    const prior = await this.store
      .statement(
        `SELECT connection_id,encrypted_bytes,envelope FROM comparison_projection_payloads
         WHERE (tenant,scope_id,payload_id)=(?,?,?)`,
        row.tenant,
        row.adopted_destination,
        row.adopted_remote_payload,
      )
      .first<{
        connection_id: string;
        encrypted_bytes: number;
        envelope: string;
      }>();
    if (!prior) return false;
    const adopted = (
      await openInventoryProjectionBody(
        row.tenant,
        row.adopted_remote_payload,
        { ...prior, state: "ready" },
        this.store.keys,
        4 * 1024 * 1024,
      )
    ).body.record;
    const date = remote.record.QSO_DATE.replace(
      /^(\d{4})(\d{2})(\d{2})$/,
      "$1-$2-$3",
    );
    const query = {
      startDate: date,
      endDate: date,
      stationCallsign: remote.record.STATION_CALLSIGN,
      workedCallsign: remote.record.CALL,
    };
    const reads = vendorFetch(
      this.store,
      "lotw",
      (input, init) => {
        if (!current()) throw new Error("lotw_grid_authority_changed");
        const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
        return this.fetcher(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, timeout])
            : timeout,
        });
      },
      { priority: "background" },
    );
    const client = new LotwClient(credential.query, { fetcher: reads });
    const report = await client.query(query);
    const target = lotwGridCorrectionTarget(
      remote.record,
      report.records,
      grid,
    );
    if (!target || !lotwGridCorrectionRecord(adopted, [target.original])) {
      await this.defer(row, "lotw_grid_target_unavailable");
      return false;
    }
    const qso = {
      ...target.qso,
      id: row.record_key,
      generation: row.projection_payload,
    };
    const cert = lotwSigningCertificate(credential, target.station, qso);
    if (!cert || !certificateCurrentlyValid(cert, Date.now())) {
      await this.defer(row, "lotw_certificate_unavailable");
      return false;
    }
    const status = await client.certificateStatus(cert.serial);
    if (status !== "unrevoked") {
      await this.defer(row, `lotw_certificate_${status}`);
      return false;
    }
    const signed = await buildSignedTq8(
      { ...cert, status, statusCheckedAt: new Date().toISOString() },
      target.station,
      [qso],
    );
    const evidence: UpdateEvidence = { original: target.original, grid, query };
    const identity = evidenceIdentity({
      ...row,
      source_payload: row.projection_payload,
    });
    const envelope = JSON.stringify(
      await seal(evidence, identity, this.store.keys),
    );
    let claimed = false;
    const send = vendorFetch(
      this.store,
      "lotw",
      (input, init) => {
        if (
          !claimed ||
          !current() ||
          String(input) !== uploadUrl ||
          init?.method !== "POST" ||
          init.redirect !== "manual"
        )
          throw new Error("lotw_grid_authority_changed");
        return this.fetcher(input, init);
      },
      {
        priority: "background",
        admit: async (reservation) => {
          if (!current()) throw new Error("lotw_grid_authority_changed");
          const budget = await reservation.first<{
            window_start: number;
            cooldown_until: number;
          }>();
          if (!budget) return null;
          claimed = await this.claim(row, proof, lease, envelope);
          if (!claimed) throw new Error("lotw_grid_authority_changed");
          return budget;
        },
      },
    );
    const result = await new LotwClient(null, {
      fetcher: send,
      exportsEnabled: true,
    }).submit(signed.bytes, { liveWriteAuthorized: true });
    if (claimed && result.state !== "uncertain")
      await this.store
        .statement(
          `UPDATE inventory_lotw_grid_updates SET state=?,reason=?
           WHERE (tenant,association_id,source_payload)=(?,?,?) AND state='uncertain'`,
          result.state === "submitted" ? "submitted" : "attention",
          result.state === "submitted" ? null : "lotw_grid_update_rejected",
          row.tenant,
          row.association_id,
          row.projection_payload,
        )
        .run();
    return claimed;
  }

  private async claim(
    row: Candidate,
    proof: string,
    lease: Lease,
    envelope: string,
  ) {
    const now = Date.now();
    const claimed = await this.store
      .statement(
        `INSERT INTO inventory_lotw_grid_updates(tenant,association_id,source_scope,source_payload,destination_scope,prior_remote_key,state,reason,due_at,claimed_at,envelope)
       SELECT c.tenant,c.association_id,c.source_scope,c.projection_payload,c.destination,c.remote_key,'uncertain','lotw_grid_dispatch_uncertain',?15,?16,?17
       FROM inventory_lotw_grid_correction_candidates c
       JOIN inventory_source_proof_current p ON (p.tenant,p.scope_id,p.proof_id)=(c.tenant,c.source_scope,?14)
       WHERE c.tenant=?1 AND ${leaseCurrent}
       AND (c.association_id,c.destination,c.source_scope,c.result_set,c.result_version,c.projection_payload,c.destination_connection,c.destination_credential,c.destination_config)
          =(?5,?6,?7,?8,?9,?10,?11,?12,?13)
       AND EXISTS(SELECT 1 FROM json_each(p.snapshot,'$.contacts') contact
         CROSS JOIN json_each(contact.value,'$.routes') route
         WHERE (json_extract(contact.value,'$.key'),json_extract(contact.value,'$.projectionVersion'),json_extract(contact.value,'$.projectionPayload'))
           =(c.record_key,c.projection_version,c.projection_payload)
         AND (json_extract(route.value,'$.provider'),json_extract(route.value,'$.destination'),json_extract(route.value,'$.purpose'))
           =('lotw',c.destination,'lotw_grid_correction'))
       AND NOT EXISTS(SELECT 1 FROM inventory_lotw_grid_updates u
          WHERE (u.tenant,u.association_id)=(c.tenant,c.association_id) AND u.state IN('uncertain','submitted','attention'))
       ON CONFLICT(tenant,association_id,source_payload) DO UPDATE SET
         state=excluded.state,reason=excluded.reason,due_at=excluded.due_at,claimed_at=excluded.claimed_at,envelope=excluded.envelope,
         destination_scope=excluded.destination_scope,prior_remote_key=excluded.prior_remote_key
       WHERE state='deferred'`,
        ...leaseArgs(lease),
        row.association_id,
        row.destination,
        row.source_scope,
        row.result_set,
        row.result_version,
        row.projection_payload,
        row.destination_connection,
        row.destination_credential,
        row.destination_config,
        proof,
        now + minute,
        now,
        envelope,
      )
      .run();
    return claimed.meta.changes === 1;
  }

  private async readback() {
    const row = await this.store
      .statement(
        `SELECT u.*,c.id AS connection_id,c.credential_version
         FROM inventory_lotw_grid_updates u
         JOIN inventory_historical_associations a ON (a.tenant,a.id)=(u.tenant,u.association_id)
         JOIN accounts account ON account.id=u.tenant AND account.status='active'
         JOIN connections c ON (c.tenant,c.kind,c.remote_identity,c.status)=(a.tenant,'lotw',a.book_identity,'active')
         WHERE u.state IN('uncertain','submitted') AND u.due_at<=?
         AND NOT EXISTS(SELECT 1 FROM inventory_restore_locks lock WHERE lock.tenant=u.tenant)
         ORDER BY u.due_at,u.tenant,u.association_id LIMIT 1`,
        Date.now(),
      )
      .first<Claimed>();
    if (!row) return false;
    const lease = await this.store.claim(
      row.tenant,
      INVENTORY_LOTW_DELIVERY_LEASE,
      Date.now(),
      minute,
    );
    if (!lease) return false;
    let verified: { key: string; hash: string } | null = null;
    let reason = "lotw_grid_update_not_observed";
    let due = Date.now() + 5 * minute;
    try {
      const evidence = await open<UpdateEvidence>(
        JSON.parse(row.envelope) as Envelope,
        evidenceIdentity(row),
        this.store.keys,
      );
      const credential = await this.store.private<LotwCredential>(
        row.tenant,
        row.connection_id,
        row.credential_version,
        "credential",
      );
      if (credential?.query) {
        const client = new LotwClient(credential.query, {
          fetcher: vendorFetch(this.store, "lotw", this.fetcher, {
            priority: "background",
          }),
        });
        const report = await client.query(evidence.query);
        if (
          lotwGridCorrectionObserved(
            evidence.original,
            report.records,
            evidence.grid,
            row.claimed_at,
          )
        ) {
          const record = lotwGridCorrectionRecord(
            evidence.original,
            report.records,
          );
          if (record) {
            const [observation] = await lotwInventoryObservations([record]);
            verified = {
              key: observation.key,
              hash: await sha256(canonical(observation.semantic)),
            };
          }
        }
      } else reason = "lotw_query_credential_unavailable";
    } catch (error) {
      if (error instanceof VendorDeferredError) due = error.retryAt;
      reason = "lotw_grid_readback_unavailable";
    }
    try {
      const result = await this.store
        .statement(
          `UPDATE inventory_lotw_grid_updates SET state=coalesce(?5,state),reason=?6,
             due_at=?7,checked_at=?8,checks=checks+1,verified_remote_key=?11,verified_projection_hash=?14
           WHERE (tenant,association_id,source_payload)=(?1,?9,?10)
             AND state IN('uncertain','submitted') AND ${leaseCurrent}
             AND EXISTS(SELECT 1 FROM accounts WHERE id=?1 AND status='active')
             AND EXISTS(SELECT 1 FROM connections WHERE tenant=?1 AND id=?12 AND credential_version=?13 AND status='active')`,
          ...leaseArgs(lease),
          verified
            ? "observed"
            : Date.now() - row.claimed_at >= 1440 * minute
              ? "attention"
              : null,
          verified ? null : reason,
          due,
          Date.now(),
          row.association_id,
          row.source_payload,
          verified?.key ?? null,
          row.connection_id,
          row.credential_version,
          verified?.hash ?? null,
        )
        .run();
      return verified !== null && result.meta.changes === 1;
    } finally {
      await this.store.release(lease);
    }
  }
}
