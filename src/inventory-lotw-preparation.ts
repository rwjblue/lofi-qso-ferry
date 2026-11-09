import { InventoryComparisonGenerations } from "./inventory-comparison-generations.ts";
import type { InventoryComparisonKey } from "./inventory-comparison-keys.ts";
import { INVENTORY_LOTW_BATCH_LIMIT } from "./inventory-delivery-limits.ts";
import { InventoryDeliveryWorkspace } from "./inventory-delivery-workspace.ts";
import { inventoryLotwReportGroups } from "./inventory-lotw-neighborhood.ts";
import { inventoryOwnershipTokens } from "./inventory-ownership.ts";
import { LotwClient } from "./lotw.ts";
import {
  certificateCurrentlyValid,
  type LotwConfig,
  type LotwCredential,
  lotwAttemptIdentity,
  lotwDeliveryInput,
  lotwProjectionHash,
  lotwSigningCertificate,
} from "./lotw-delivery-input.ts";
import type { Contact } from "./projection.ts";
import {
  b64,
  canonical,
  type Envelope,
  open,
  seal,
  sha256,
  unb64,
} from "./security.ts";
import {
  buildSignedTq8,
  canonicalSigningData,
  type LotwContact,
  type LotwStation,
  type SigningCredential,
} from "./signing.ts";
import type { Store } from "./store.ts";
import {
  VendorDeferredError,
  type VendorPriority,
  vendorFetch,
} from "./vendor-requests.ts";

const WIRE_LIMIT = 512_000;
const ENVELOPE_LIMIT = 1_048_576;
const artifactIdentity = (tenant: string, connection: string, id: string) => ({
  tenant,
  connection,
  id,
  kind: "inventory_lotw_batch_v1",
  purpose: "storage",
});
const held = (reason: string) => ({ kind: "held" as const, reason });

interface ArtifactMember {
  attemptId: string;
  qso: LotwContact;
  sourceTimePrecision: Contact["timePrecision"];
}
interface Artifact {
  version: 1;
  tq8: string;
  station: LotwStation;
  certificate: { version: string; hash: string; serial: string };
  signingConfiguration: string;
  members: ArtifactMember[];
}
interface MemberRow {
  attempt_id: string;
  record_key: string;
  source_hash: string;
  identity_hash: string;
  projection_hash: string;
}

async function identityHash(
  key: InventoryComparisonKey,
  book: string,
  station: LotwStation,
  qso: LotwContact,
) {
  const { identity, remoteId } = await lotwAttemptIdentity(station, qso);
  const record = Object.fromEntries(
    Object.entries(identity).filter(([, value]) => value !== ""),
  );
  return (await inventoryOwnershipTokens(key, "lotw", book, remoteId, record))
    .claim;
}

/** An exact compatible selection shares one certificate check and one signed
 * artifact. Preparation can read the public CRL but cannot upload the file. */
export class InventoryLotwPreparation {
  constructor(
    readonly store: Store,
    readonly fetcher: typeof fetch = fetch,
  ) {}

  private async receipt(tenant: string, batchId: string, digest: string) {
    const { results } = await this.store
      .statement(
        `SELECT h.input_digest,h.member_count,h.wire_hash,h.wire_bytes,a.attempt_id,a.record_key
         FROM inventory_lotw_batches h JOIN inventory_lotw_batch_members a USING(tenant,batch_id)
         WHERE h.tenant=? AND h.batch_id=? AND h.committed_at IS NOT NULL ORDER BY a.position`,
        tenant,
        batchId,
      )
      .all<
        Pick<MemberRow, "attempt_id" | "record_key"> & {
          input_digest: string;
          member_count: number;
          wire_hash: string;
          wire_bytes: number;
        }
      >();
    const [head] = results;
    if (!head) return null;
    if (head.input_digest !== digest || head.member_count !== results.length)
      throw new Error("inventory_lotw_preparation_receipt_conflict");
    return {
      kind: "prepared" as const,
      batchId,
      wireHash: head.wire_hash,
      wireBytes: head.wire_bytes,
      members: results.map(({ attempt_id, record_key }) => ({
        attempt_id,
        record_key,
      })),
    };
  }

  private async certificateStatus(
    certificate: SigningCredential,
    priority: VendorPriority,
  ) {
    const expected = `https://lotw.arrl.org/lotw/crl?serial=${certificate.serial}`;
    const readOnly: typeof fetch = (input, init) => {
      if (
        String(input) !== expected ||
        (init?.method ?? "GET") !== "GET" ||
        init?.body != null ||
        init?.redirect !== "manual"
      )
        throw new Error("inventory_lotw_certificate_transport_blocked");
      return this.fetcher(input, init);
    };
    return new LotwClient(null, {
      fetcher: vendorFetch(this.store, "lotw", readOnly, { priority }),
    }).certificateStatus(certificate.serial);
  }

  async prepare(
    tenant: string,
    proofId: string,
    destination: string,
    contactKeys: readonly string[],
    batchId: string = crypto.randomUUID(),
    priority: VendorPriority = "background",
  ) {
    const keys = [...contactKeys].sort();
    if (
      keys.length < 1 ||
      keys.length > INVENTORY_LOTW_BATCH_LIMIT ||
      new Set(keys).size !== keys.length ||
      ![tenant, proofId, destination, batchId, ...keys].every(
        (id) => typeof id === "string" && id.length > 0 && id.length <= 256,
      )
    )
      throw new Error("invalid_inventory_lotw_preparation");
    const digest = await sha256(canonical([proofId, destination, keys]));
    const existing = await this.receipt(tenant, batchId, digest);
    if (existing) return existing;
    const workspace = await new InventoryDeliveryWorkspace(this.store).capture(
      tenant,
      proofId,
      destination,
      keys,
    );
    if (workspace.kind !== "captured") return workspace;
    const first = workspace.members[0].review;
    if (
      workspace.members.some(
        ({ review }) =>
          review.provider !== "lotw" ||
          review.destination_connection !== first.destination_connection ||
          review.destination_config !== first.destination_config ||
          review.destination_credential !== first.destination_credential ||
          review.book_identity !== first.book_identity ||
          review.ownership_version !== first.ownership_version,
      )
    )
      return held("lotw_route_changed");
    const credential = await this.store.private<LotwCredential>(
      tenant,
      first.destination_connection,
      first.destination_credential,
      "credential",
    );
    if (!credential?.query?.username || !credential.query.password)
      return held("lotw_query_credential_unavailable");
    const key = await new InventoryComparisonGenerations(this.store).key(
      tenant,
    );
    const config = JSON.parse(first.destination_config) as LotwConfig;
    const members: ArtifactMember[] = [];
    const rows = [];
    let station: LotwStation | undefined;
    let certificate: SigningCredential | undefined;
    for (const { contact, fingerprint, review } of workspace.members) {
      const input = lotwDeliveryInput(config, contact);
      if (!input) return held("lotw_station_route_mismatch");
      const selected = lotwSigningCertificate(
        credential,
        input.station,
        input.qso,
      );
      if (!selected)
        return held("lotw_certificate_selection_ambiguous_or_missing");
      if (
        station &&
        (canonical(station) !== canonical(input.station) ||
          certificate !== selected)
      )
        return held("lotw_batch_requires_partition");
      station = input.station;
      certificate = selected;
      const qso = { ...input.qso, generation: fingerprint };
      try {
        canonicalSigningData(station, qso);
      } catch {
        return held("lotw_signing_fields_unavailable");
      }
      const attemptId = crypto.randomUUID();
      members.push({
        attemptId,
        qso,
        sourceTimePrecision: contact.timePrecision,
      });
      rows.push({
        attempt_id: attemptId,
        record_key: contact.id,
        source_hash: fingerprint,
        result_set: review.result_set,
        result_version: review.result_version,
        reviewed_at: review.reviewed_at,
        projection_hash: await lotwProjectionHash(station, qso),
        identity_hash: await identityHash(
          key,
          first.book_identity,
          station,
          qso,
        ),
      });
    }
    if (!station || !certificate) throw new Error("inventory_lotw_empty_batch");
    if (new Set(rows.map((row) => row.identity_hash)).size !== rows.length)
      return held("lotw_batch_identity_conflict");
    if (!inventoryLotwReportGroups(station, members))
      return held("lotw_batch_report_bound");
    const rowsJson = canonical(rows);
    const reserved = await this.store
      .statement(
        `SELECT 1 FROM json_each(?1) j WHERE EXISTS(
        SELECT 1 FROM inventory_lotw_batch_members a WHERE a.tenant=?2 AND a.source_identity=?3 AND a.record_key=json_extract(j.value,'$.record_key') AND a.cancelled_at IS NULL
       ) OR EXISTS(
        SELECT 1 FROM inventory_lotw_batch_members a WHERE a.tenant=?2 AND a.identity_hash=json_extract(j.value,'$.identity_hash') AND a.cancelled_at IS NULL
       ) LIMIT 1`,
        rowsJson,
        tenant,
        first.source_identity,
      )
      .first();
    if (reserved)
      return (
        (await this.receipt(tenant, batchId, digest)) ??
        held("lotw_member_reserved")
      );
    const checkedAt = Date.now();
    if (checkedAt >= workspace.expiresAt) return held("source_proof_stale");
    if (!certificateCurrentlyValid(certificate, checkedAt))
      return held("lotw_certificate_not_currently_valid");
    let status: Awaited<ReturnType<LotwClient["certificateStatus"]>>;
    try {
      status = await this.certificateStatus(certificate, priority);
    } catch (error) {
      if (error instanceof VendorDeferredError)
        return { kind: "deferred" as const, retryAt: error.retryAt };
      throw error;
    }
    if (status !== "unrevoked") return held(`lotw_certificate_${status}`);
    const now = Date.now();
    if (now >= workspace.expiresAt) return held("source_proof_stale");
    if (!certificateCurrentlyValid(certificate, now))
      return held("lotw_certificate_not_currently_valid");
    const signed = await buildSignedTq8(
      {
        ...certificate,
        status,
        statusCheckedAt: new Date(checkedAt).toISOString(),
      },
      station,
      members.map(({ qso }) => qso),
      new Date(now),
    );
    if (!signed.bytes.length || signed.bytes.length > WIRE_LIMIT)
      return held("lotw_batch_byte_bound");
    const certificateHash = await sha256(certificate.certificatePem);
    const artifact: Artifact = {
      version: 1,
      tq8: b64(signed.bytes),
      station,
      certificate: {
        version: signed.credentialVersion,
        hash: certificateHash,
        serial: certificate.serial,
      },
      signingConfiguration: signed.configurationVersion,
      members,
    };
    const envelope = JSON.stringify(
      await seal(
        artifact,
        artifactIdentity(tenant, first.destination_connection, batchId),
        this.store.keys,
      ),
    );
    if (envelope.length > ENVELOPE_LIMIT) return held("lotw_batch_byte_bound");
    const wireHash = await sha256(signed.bytes);
    try {
      await this.store.db.batch([
        this.store.statement(
          `INSERT INTO inventory_lotw_batches(tenant,batch_id,proof_id,source_scope,destination,source_identity,book_identity,destination_connection,destination_config,credential_version,
            ownership_version,key_id,certificate_version,certificate_hash,certificate_checked_at,certificate_valid_until,signing_configuration,station_hash,input_digest,manifest_hash,wire_hash,wire_bytes,envelope,prepared_at,member_count)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          tenant,
          batchId,
          proofId,
          workspace.sourceScope,
          destination,
          first.source_identity,
          first.book_identity,
          first.destination_connection,
          first.destination_config,
          first.destination_credential,
          first.ownership_version,
          key.keyId,
          signed.credentialVersion,
          certificateHash,
          checkedAt,
          Date.parse(certificate.validTo),
          signed.configurationVersion,
          await sha256(canonical(station)),
          digest,
          await sha256(canonical(members)),
          wireHash,
          signed.bytes.length,
          envelope,
          now,
          rows.length,
        ),
        this.store.statement(
          `INSERT INTO inventory_lotw_batch_members(tenant,attempt_id,batch_id,position,source_identity,record_key,result_set,result_version,reviewed_at,source_hash,projection_hash,identity_hash)
           SELECT ?,json_extract(value,'$.attempt_id'),?,key+1,?,json_extract(value,'$.record_key'),json_extract(value,'$.result_set'),json_extract(value,'$.result_version'),
            json_extract(value,'$.reviewed_at'),json_extract(value,'$.source_hash'),json_extract(value,'$.projection_hash'),json_extract(value,'$.identity_hash') FROM json_each(?)`,
          tenant,
          batchId,
          first.source_identity,
          rowsJson,
        ),
        this.store.statement(
          "UPDATE inventory_lotw_batches SET committed_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE tenant=? AND batch_id=?",
          tenant,
          batchId,
        ),
      ]);
    } catch (error) {
      const recovered = await this.receipt(tenant, batchId, digest);
      if (recovered) return recovered;
      if (
        error instanceof Error &&
        error.message.includes("inventory LoTW preparation changed")
      )
        return held("lotw_preparation_changed");
      if (
        error instanceof Error &&
        error.message.includes(
          "UNIQUE constraint failed: inventory_lotw_batch_members.tenant",
        )
      )
        return held("lotw_member_reserved");
      throw error;
    }
    return {
      kind: "prepared" as const,
      batchId,
      wireHash,
      wireBytes: signed.bytes.length,
      members: rows.map(({ attempt_id, record_key }) => ({
        attempt_id,
        record_key,
      })),
    };
  }

  async current(tenant: string, batch: string) {
    return Boolean(
      await this.store
        .statement(
          "SELECT 1 FROM inventory_lotw_batch_current WHERE tenant=? AND batch_id=?",
          tenant,
          batch,
        )
        .first(),
    );
  }

  async cancelStale(tenant: string, batch: string) {
    return Boolean(
      await this.store
        .statement(
          `UPDATE inventory_lotw_batches SET cancelled_at=CAST(unixepoch('subsec')*1000 AS INTEGER)
       WHERE tenant=?1 AND batch_id=?2 AND committed_at IS NOT NULL AND cancelled_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM inventory_restore_locks WHERE tenant=?1)
       AND NOT EXISTS(SELECT 1 FROM inventory_lotw_dispatches WHERE tenant=?1 AND batch_id=?2)
       AND NOT EXISTS(SELECT 1 FROM inventory_lotw_batch_current WHERE tenant=?1 AND batch_id=?2) RETURNING batch_id`,
          tenant,
          batch,
        )
        .first(),
    );
  }

  async artifact(tenant: string, batch: string) {
    const head = await this.store
      .statement(
        `SELECT destination_connection,book_identity,key_id,certificate_version,certificate_hash,signing_configuration,station_hash,
              manifest_hash,wire_hash,wire_bytes,member_count,envelope
       FROM inventory_lotw_batches WHERE tenant=? AND batch_id=? AND committed_at IS NOT NULL`,
        tenant,
        batch,
      )
      .first<{
        destination_connection: string;
        book_identity: string;
        key_id: string;
        certificate_version: string;
        certificate_hash: string;
        signing_configuration: string;
        station_hash: string;
        manifest_hash: string;
        wire_hash: string;
        wire_bytes: number;
        member_count: number;
        envelope: string;
      }>();
    if (!head) return null;
    const body = await open<Artifact>(
      JSON.parse(head.envelope) as Envelope,
      artifactIdentity(tenant, head.destination_connection, batch),
      this.store.keys,
    );
    const bytes = unb64(body.tq8);
    const changed = () => new Error("inventory_lotw_artifact_changed");
    if (
      body.version !== 1 ||
      bytes.length !== head.wire_bytes ||
      b64(bytes) !== body.tq8 ||
      body.certificate.version !== head.certificate_version ||
      body.certificate.hash !== head.certificate_hash ||
      body.signingConfiguration !== head.signing_configuration ||
      body.members.length !== head.member_count ||
      (await sha256(canonical(body.station))) !== head.station_hash ||
      (await sha256(canonical(body.members))) !== head.manifest_hash ||
      (await sha256(bytes)) !== head.wire_hash
    )
      throw changed();
    const { results } = await this.store
      .statement(
        `SELECT attempt_id,record_key,source_hash,identity_hash,projection_hash FROM inventory_lotw_batch_members WHERE tenant=? AND batch_id=? ORDER BY position`,
        tenant,
        batch,
      )
      .all<MemberRow>();
    const key = await new InventoryComparisonGenerations(this.store).key(
      tenant,
    );
    if (key.keyId !== head.key_id || results.length !== body.members.length)
      throw changed();
    for (const [i, { attemptId, qso }] of body.members.entries()) {
      const row = results[i];
      if (
        attemptId !== row.attempt_id ||
        qso.id !== row.record_key ||
        qso.generation !== row.source_hash ||
        (await lotwProjectionHash(body.station, qso)) !== row.projection_hash ||
        (await identityHash(key, head.book_identity, body.station, qso)) !==
          row.identity_hash
      )
        throw changed();
    }
    return {
      bytes,
      hash: head.wire_hash,
      station: body.station,
      certificate: body.certificate,
      signingConfiguration: body.signingConfiguration,
      members: body.members,
    };
  }
}
