import { INVENTORY_LOTW_DELIVERY_LEASE } from "./inventory-lotw-dispatch.ts";
import {
  inventoryLotwReadFetch,
  inventoryLotwReportGroups,
} from "./inventory-lotw-neighborhood.ts";
import { InventoryLotwPreparation } from "./inventory-lotw-preparation.ts";
import {
  InventoryOwnership,
  type InventoryOwnershipBody,
  inventoryOwnershipIdentity,
} from "./inventory-ownership.ts";
import { LotwClient, type LotwReport, observeLotwContact } from "./lotw.ts";
import {
  lotwAttemptIdentity,
  type LotwCredential,
} from "./lotw-delivery-input.ts";
import { canonical, seal } from "./security.ts";
import type { LotwContact, LotwStation } from "./signing.ts";
import type { Lease, Store } from "./store.ts";
import { VendorDeferredError, type VendorPriority } from "./vendor-requests.ts";

interface Authority {
  claimed_at: number;
  wire_hash: string;
  source_scope: string;
  source_identity: string;
  destination_scope: string;
  book_identity: string;
  key_id: string;
  connection_id: string;
  credential_version: string;
  connection_config: string;
  lease_expires_at: number;
}
interface Member {
  attemptId: string;
  qso: LotwContact;
}

const reportStamp = (instant: number) =>
  new Date(instant).toISOString().slice(0, 19).replace("T", " ");

async function evidenceForMember(
  station: LotwStation,
  member: Member,
  report: LotwReport,
  floor: number,
  now: number,
) {
  let observation: ReturnType<typeof observeLotwContact>;
  try {
    observation = observeLotwContact(station, member.qso, report);
  } catch {
    // An unsupported mode in the candidate set cannot prove this member.
    return [];
  }
  const stamp = observation.record?.APP_LOTW_RXQSO;
  if (
    observation.state !== "observed" ||
    typeof stamp !== "string" ||
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp)
  )
    return [];
  const receivedAt = Date.parse(`${stamp.replace(" ", "T")}Z`);
  if (
    !Number.isFinite(receivedAt) ||
    reportStamp(receivedAt) !== stamp ||
    receivedAt < floor ||
    receivedAt > now
  )
    return [];
  const { identity, remoteId } = await lotwAttemptIdentity(station, member.qso);
  return [
    {
      member,
      remoteId,
      receivedAt,
      confirmed: observation.confirmed,
      record: Object.fromEntries(
        Object.entries(identity).filter(([, value]) => value !== ""),
      ),
    },
  ];
}

/** Reopen the immutable attempted file and independently resolve its members.
 * Recovery has no upload client and does not require the old source proof. */
export class InventoryLotwReadback {
  constructor(
    readonly store: Store,
    readonly fetcher: typeof fetch = fetch,
  ) {}

  async outcome(tenant: string, batch: string) {
    const row = await this.store
      .statement(
        `SELECT h.member_count AS members,d.settled_at,
        (SELECT count(*) FROM inventory_lotw_member_receipts r WHERE (r.tenant,r.batch_id)=(d.tenant,d.batch_id)) AS observed
       FROM inventory_lotw_dispatches d JOIN inventory_lotw_batches h USING(tenant,batch_id)
       WHERE (d.tenant,d.batch_id)=(?,?)`,
        tenant,
        batch,
      )
      .first<{
        members: number;
        observed: number;
        settled_at: number | null;
      }>();
    if (!row)
      return { kind: "held" as const, reason: "lotw_dispatch_unavailable" };
    const { members, observed } = row;
    const kind =
      row.settled_at !== null
        ? ("observed" as const)
        : observed
          ? ("partial" as const)
          : ("pending" as const);
    return { kind, members, observed };
  }

  async reconcile(
    tenant: string,
    batch: string,
    priority: VendorPriority = "background",
  ) {
    const prior = await this.outcome(tenant, batch);
    if (prior.kind === "held" || prior.kind === "observed") return prior;
    const lease = await this.store.claim(
      tenant,
      INVENTORY_LOTW_DELIVERY_LEASE,
      Date.now(),
      90_000,
    );
    if (!lease) return prior;
    try {
      return await this.reconcileLeased(batch, lease, priority);
    } finally {
      await this.store.release(lease);
    }
  }

  async reconcileLeased(
    batch: string,
    lease: Lease,
    priority: VendorPriority = "background",
  ) {
    const { tenant, token, fence } = lease;
    if (lease.scope !== INVENTORY_LOTW_DELIVERY_LEASE)
      return this.outcome(tenant, batch);
    const binding = await this.store
      .statement(
        `SELECT * FROM inventory_lotw_readback_authority WHERE (tenant,batch_id,lease_token,lease_fence)=(?,?,?,?)`,
        tenant,
        batch,
        token,
        fence,
      )
      .first<Authority>();
    if (!binding) return this.outcome(tenant, batch);
    const [artifact, credential, waiting] = await Promise.all([
      new InventoryLotwPreparation(this.store).artifact(tenant, batch),
      this.store.private<LotwCredential>(
        tenant,
        binding.connection_id,
        binding.credential_version,
        "credential",
      ),
      this.store
        .statement(
          `SELECT m.attempt_id FROM inventory_lotw_batch_members m WHERE (m.tenant,m.batch_id)=(?,?)
          AND NOT EXISTS(SELECT 1 FROM inventory_lotw_member_receipts r WHERE (r.tenant,r.attempt_id)=(m.tenant,m.attempt_id))`,
          tenant,
          batch,
        )
        .all<{ attempt_id: string }>(),
    ]);
    if (!artifact || artifact.hash !== binding.wire_hash || !credential?.query)
      return this.outcome(tenant, batch);
    const ids = new Set(waiting.results.map(({ attempt_id }) => attempt_id));
    const groups = inventoryLotwReportGroups(
      artifact.station,
      artifact.members.filter(({ attemptId }) => ids.has(attemptId)),
    );
    if (!groups) return this.outcome(tenant, batch);
    const startedAt = Date.now();
    const expiresAt = Math.min(startedAt + 60_000, binding.lease_expires_at);
    const current = () =>
      startedAt > binding.claimed_at && Date.now() < expiresAt;
    if (!current()) return this.outcome(tenant, batch);
    const floor = Math.floor(binding.claimed_at / 1000) * 1000;
    const client = new LotwClient(credential.query, {
      fetcher: inventoryLotwReadFetch(this.store, batch, lease, this.fetcher, {
        priority,
        expiresAt,
        current,
        authority: { kind: "readback" },
      }),
    });
    try {
      for (const { query, selections } of groups) {
        if (!current()) break;
        const report = await client.query({
          ...query,
          receivedSince: reportStamp(floor),
        });
        const now = Date.now();
        const evidence = (
          await Promise.all(
            selections.map(({ member }) =>
              evidenceForMember(artifact.station, member, report, floor, now),
            ),
          )
        ).flat();
        if (evidence.length && current())
          await this.save(batch, lease, binding, startedAt, evidence);
      }
    } catch (error) {
      const outcome = await this.outcome(tenant, batch);
      if (error instanceof VendorDeferredError && outcome.kind !== "observed")
        return {
          ...outcome,
          kind: "deferred" as const,
          retryAt: error.retryAt,
        };
      // An incomplete report, a changed lease, or a raced ownership insert
      // leaves all unresolved members reserved for another readback.
      if (
        !(error instanceof Error) ||
        !/LoTW|UNIQUE constraint/.test(error.message)
      )
        throw error;
      return outcome;
    }
    return this.outcome(tenant, batch);
  }

  private async save(
    batch: string,
    lease: Lease,
    binding: Authority,
    startedAt: number,
    candidates: Awaited<ReturnType<typeof evidenceForMember>>,
  ) {
    const { tenant, token, fence } = lease;
    const lookup = await new InventoryOwnership(this.store).lookup(
      tenant,
      "lotw",
      candidates.map(({ member, record, remoteId }) => ({
        id: member.attemptId,
        sourceIdentity: binding.source_identity,
        key: member.qso.id,
        book: binding.book_identity,
        remoteKey: remoteId,
        record,
      })),
    );
    if (lookup.state !== "observed" || lookup.keyId !== binding.key_id) return;
    const rows = [];
    for (const [index, item] of candidates.entries()) {
      if (lookup.observations[index]?.state !== "clear") continue;
      const id = crypto.randomUUID();
      const { claim, bucket } = lookup.tokens[index];
      const body: InventoryOwnershipBody = {
        version: 1,
        provider: "lotw",
        kind: "historical",
        record: item.record,
      };
      const envelope = JSON.stringify(
        await seal(
          body,
          inventoryOwnershipIdentity(tenant, id),
          this.store.keys,
        ),
      );
      rows.push({
        id,
        attempt: item.member.attemptId,
        key: item.member.qso.id,
        claim,
        bucket,
        envelope,
        receivedAt: item.receivedAt,
        confirmed: Number(item.confirmed),
      });
    }
    if (!rows.length) return;
    const guard = crypto.randomUUID();
    const input = canonical(rows);
    await this.store.db.batch([
      this.store.statement(
        `INSERT INTO inventory_lotw_receipt_guards(tenant,batch_id,guard_id,lease_token,lease_fence,connection_id,credential_version,connection_config,ownership_version,read_started_at,member_count,manifest)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        tenant,
        batch,
        guard,
        token,
        fence,
        binding.connection_id,
        binding.credential_version,
        binding.connection_config,
        lookup.version,
        startedAt,
        rows.length,
        canonical(
          rows.map(({ id, attempt, claim, bucket }) => ({
            id,
            attempt,
            claim,
            bucket,
          })),
        ),
      ),
      this.store.statement(
        `INSERT INTO inventory_ownership_evidence(tenant,id,provider,book_identity,destination_scope,source_scope,source_identity,record_key,kind,key_id,claim_hash,bucket_hash,envelope,encrypted_bytes,created_at)
         SELECT ?1,json_extract(j.value,'$.id'),'lotw',?2,?3,?4,?5,json_extract(j.value,'$.key'),'historical',?6,
          json_extract(j.value,'$.claim'),json_extract(j.value,'$.bucket'),json_extract(j.value,'$.envelope'),length(json_extract(j.value,'$.envelope')),CAST(unixepoch('subsec')*1000 AS INTEGER)
         FROM json_each(?7) j`,
        tenant,
        binding.book_identity,
        binding.destination_scope,
        binding.source_scope,
        binding.source_identity,
        binding.key_id,
        input,
      ),
      this.store.statement(
        `INSERT INTO inventory_lotw_member_receipts(tenant,batch_id,attempt_id,evidence_id,guard_id,connection_id,credential_version,read_started_at,vendor_received_at,received_at,confirmed)
         SELECT ?1,?2,json_extract(j.value,'$.attempt'),json_extract(j.value,'$.id'),?3,?4,?5,?6,
          json_extract(j.value,'$.receivedAt'),CAST(unixepoch('subsec')*1000 AS INTEGER),json_extract(j.value,'$.confirmed') FROM json_each(?7) j`,
        tenant,
        batch,
        guard,
        binding.connection_id,
        binding.credential_version,
        startedAt,
        input,
      ),
      this.store.statement(
        "DELETE FROM inventory_lotw_receipt_guards WHERE tenant=? AND batch_id=? AND guard_id=?",
        tenant,
        batch,
        guard,
      ),
    ]);
  }
}
