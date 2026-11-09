import { parseAdif, serializeAdifRecord } from "./adif.ts";
import { structuredContactAdif } from "./contact-adif.ts";
import {
  decodeTemplate,
  type QrzConfig,
  routedQrz,
  templateContext,
} from "./delivery.ts";
import { destinationIdentityClaim } from "./identity-claims.ts";
import { INVENTORY_QRZ_BATCH_LIMIT } from "./inventory-delivery-limits.ts";
import { InventoryDeliveryWorkspace } from "./inventory-delivery-workspace.ts";
import { inventoryJsonChunks } from "./inventory-ingestion.ts";
import { canonical, type Envelope, open, seal, sha256 } from "./security.ts";
import type { Store } from "./store.ts";
import { renderNarrative } from "./templates.ts";

const artifactIdentity = (tenant: string, connection: string, id: string) => ({
  tenant,
  connection,
  id,
  kind: "inventory_qrz_insert_v1",
  purpose: "storage",
});
interface Artifact {
  version: 1;
  adif: string;
}
interface AttemptReceipt {
  attempt_id: string;
  record_key: string;
  request_hash: string;
}

/** Stage immutable local QRZ INSERT artifacts. This path performs no I/O with
 * QRZ and does not acquire permission to dispatch. */
export class InventoryQrzPreparation {
  constructor(readonly store: Store) {}

  private async receipt(tenant: string, stageId: string, digest: string) {
    const saved = await this.store
      .statement(
        `SELECT h.input_digest,h.member_count,a.attempt_id,a.record_key,a.request_hash
         FROM inventory_qrz_preparations h JOIN inventory_qrz_attempts a USING(tenant,stage_id)
         WHERE h.tenant=? AND h.stage_id=? AND h.committed_at IS NOT NULL ORDER BY a.record_key`,
        tenant,
        stageId,
      )
      .all<AttemptReceipt & { input_digest: string; member_count: number }>();
    const [head] = saved.results;
    if (!head) return null;
    if (
      head.input_digest !== digest ||
      head.member_count !== saved.results.length
    )
      throw new Error("inventory_qrz_preparation_receipt_conflict");
    return {
      kind: "prepared" as const,
      stageId,
      attempts: saved.results.map(
        ({ attempt_id, record_key, request_hash }) => ({
          attempt_id,
          record_key,
          request_hash,
        }),
      ),
    };
  }

  async prepare(
    tenant: string,
    proofId: string,
    destination: string,
    contactKeys: readonly string[],
    stageId: string = crypto.randomUUID(),
  ) {
    const keys = [...contactKeys].sort();
    if (
      keys.length < 1 ||
      keys.length > INVENTORY_QRZ_BATCH_LIMIT ||
      new Set(keys).size !== keys.length ||
      ![tenant, proofId, destination, stageId, ...keys].every(
        (key) => typeof key === "string" && key.length > 0 && key.length <= 256,
      )
    )
      throw new Error("invalid_inventory_qrz_preparation");
    const digest = await sha256(canonical([proofId, destination, keys]));
    const existing = await this.receipt(tenant, stageId, digest);
    if (existing) return existing;
    const workspace = await new InventoryDeliveryWorkspace(this.store).capture(
      tenant,
      proofId,
      destination,
      keys,
    );
    if (workspace.kind !== "captured") return workspace;
    const first = workspace.members[0].review;
    if (first.provider !== "qrz")
      return { kind: "held" as const, reason: "not_qrz_destination" };
    const config = JSON.parse(first.destination_config) as QrzConfig;
    if (
      config.bookId !== first.book_identity ||
      workspace.members.some(
        ({ contact, review }) =>
          review.provider !== "qrz" ||
          review.destination_connection !== first.destination_connection ||
          review.destination_config !== first.destination_config ||
          review.destination_credential !== first.destination_credential ||
          review.ownership_version !== first.ownership_version ||
          !routedQrz(config, contact),
      )
    )
      return { kind: "held" as const, reason: "qrz_route_changed" };
    const template = await this.store
      .statement(
        `SELECT t.id,t.config FROM active_templates a JOIN templates t ON t.tenant=a.tenant AND t.destination=a.destination AND t.id=a.version
         WHERE a.tenant=? AND a.destination=?`,
        tenant,
        first.destination_connection,
      )
      .first<{ id: string; config: string }>();
    if (!template)
      return { kind: "held" as const, reason: "qrz_template_unavailable" };
    const version = decodeTemplate(template);
    const now = Date.now();
    const rows = [];
    for (const { contact, fingerprint, review } of workspace.members) {
      const record = {
        ...structuredContactAdif(contact),
        ...renderNarrative(version, templateContext(contact, now)),
      };
      const adif = serializeAdifRecord(record);
      const id = crypto.randomUUID();
      rows.push({
        id,
        recordKey: contact.id,
        resultSet: review.result_set,
        resultVersion: review.result_version,
        reviewedAt: review.reviewed_at,
        sourceHash: fingerprint,
        identityHash: (await destinationIdentityClaim("qrz", record)).hash,
        requestHash: await sha256(adif),
        envelope: JSON.stringify(
          await seal(
            { version: 1, adif } satisfies Artifact,
            artifactIdentity(tenant, first.destination_connection, id),
            this.store.keys,
          ),
        ),
      });
    }
    try {
      await this.store.db.batch([
        this.store.statement(
          `INSERT INTO inventory_qrz_preparations(tenant,stage_id,proof_id,source_scope,destination,source_identity,book_identity,destination_connection,destination_config,credential_version,template_version,ownership_version,input_digest,prepared_at,member_count)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          tenant,
          stageId,
          proofId,
          workspace.sourceScope,
          destination,
          first.source_identity,
          first.book_identity,
          first.destination_connection,
          first.destination_config,
          first.destination_credential,
          version.id,
          first.ownership_version,
          digest,
          now,
          rows.length,
        ),
        ...inventoryJsonChunks(rows).map((chunk) =>
          this.store.statement(
            `INSERT INTO inventory_qrz_attempts(tenant,attempt_id,stage_id,record_key,source_identity,book_identity,result_set,result_version,reviewed_at,source_hash,identity_hash,request_hash,envelope)
             SELECT ?,json_extract(value,'$.id'),?,json_extract(value,'$.recordKey'),?,?,json_extract(value,'$.resultSet'),json_extract(value,'$.resultVersion'),
              json_extract(value,'$.reviewedAt'),json_extract(value,'$.sourceHash'),json_extract(value,'$.identityHash'),json_extract(value,'$.requestHash'),json_extract(value,'$.envelope')
             FROM json_each(?)`,
            tenant,
            stageId,
            first.source_identity,
            first.book_identity,
            chunk,
          ),
        ),
        this.store.statement(
          "UPDATE inventory_qrz_preparations SET committed_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE tenant=? AND stage_id=?",
          tenant,
          stageId,
        ),
      ]);
    } catch (error) {
      const recovered = await this.receipt(tenant, stageId, digest);
      if (recovered) return recovered;
      if (
        error instanceof Error &&
        error.message.includes("inventory QRZ preparation changed")
      )
        return { kind: "held" as const, reason: "qrz_preparation_changed" };
      throw error;
    }
    return {
      kind: "prepared" as const,
      stageId,
      attempts: rows.map(({ id, recordKey, requestHash }) => ({
        attempt_id: id,
        record_key: recordKey,
        request_hash: requestHash,
      })),
    };
  }

  async current(tenant: string, attempt: string) {
    return Boolean(
      await this.store
        .statement(
          "SELECT 1 AS current FROM inventory_qrz_attempt_current WHERE tenant=? AND attempt_id=?",
          tenant,
          attempt,
        )
        .first(),
    );
  }

  async cancelStale(tenant: string, attempt: string) {
    return Boolean(
      await this.store
        .statement(
          `UPDATE inventory_qrz_attempts SET cancelled_at=CAST(unixepoch('subsec')*1000 AS INTEGER)
           WHERE tenant=?1 AND attempt_id=?2 AND cancelled_at IS NULL
           AND NOT EXISTS(SELECT 1 FROM inventory_restore_locks l WHERE l.tenant=?1)
           AND NOT EXISTS(SELECT 1 FROM inventory_qrz_dispatches d WHERE d.tenant=?1 AND d.attempt_id=?2)
           AND NOT EXISTS(SELECT 1 FROM inventory_qrz_attempt_current a WHERE a.tenant=?1 AND a.attempt_id=?2)
           RETURNING attempt_id`,
          tenant,
          attempt,
        )
        .first(),
    );
  }

  async artifact(tenant: string, attempt: string) {
    const row = await this.store
      .statement(
        `SELECT a.envelope,a.request_hash,a.identity_hash,h.destination_connection
         FROM inventory_qrz_attempts a JOIN inventory_qrz_preparations h USING(tenant,stage_id)
         WHERE a.tenant=? AND a.attempt_id=? AND h.committed_at IS NOT NULL`,
        tenant,
        attempt,
      )
      .first<{
        envelope: string;
        request_hash: string;
        identity_hash: string;
        destination_connection: string;
      }>();
    if (!row) return null;
    const body = await open<Artifact>(
      JSON.parse(row.envelope) as Envelope,
      artifactIdentity(tenant, row.destination_connection, attempt),
      this.store.keys,
    );
    const parsed = parseAdif(body.adif);
    if (
      body.version !== 1 ||
      (await sha256(body.adif)) !== row.request_hash ||
      parsed.records.length !== 1 ||
      serializeAdifRecord(parsed.records[0]) !== body.adif ||
      (await destinationIdentityClaim("qrz", parsed.records[0])).hash !==
        row.identity_hash
    )
      throw new Error("inventory_qrz_artifact_changed");
    return {
      adif: body.adif,
      record: parsed.records[0],
      hash: row.request_hash,
    };
  }
}
