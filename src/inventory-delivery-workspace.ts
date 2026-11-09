import { contactReconciliationAdif } from "./contact-adif.ts";
import {
  INVENTORY_LOTW_BATCH_LIMIT,
  INVENTORY_SOURCE_PROOF_DEPENDENCY_LIMIT,
} from "./inventory-delivery-limits.ts";
import { InventoryProjections } from "./inventory-projections.ts";
import type {
  InventorySourceProofDependency,
  InventorySourceProofSnapshot,
} from "./inventory-source-proof-workspace.ts";
import type { SourceRecord } from "./lofi.ts";
import { projectContact, sourceFingerprint } from "./projection.ts";
import { canonical, type Envelope, open } from "./security.ts";
import type { Store } from "./store.ts";

const MAX_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

export interface InventoryDeliveryReviewBinding {
  destination: string;
  record_key: string;
  provider: "qrz" | "lotw";
  generation_id: string;
  result_set: string;
  result_version: number;
  reviewed_at: number;
  proof_not_before: number;
  source_config_version: number;
  destination_config_version: number;
  source_identity: string;
  book_identity: string;
  ownership_version: number;
  source_credential: string;
  destination_credential: string;
  projection_version: number;
  projection_payload: string;
  destination_connection: string;
  destination_config: string;
}

/** Open the exact accepted source inputs, never a second observation. */
export class InventoryDeliveryWorkspace {
  constructor(readonly store: Store) {}

  async capture(
    tenant: string,
    proofId: string,
    destination: string,
    contactKeys: readonly string[],
  ) {
    const keys = [...contactKeys].sort();
    if (
      ![tenant, proofId, destination, ...keys].every(identifier) ||
      keys.length < 1 ||
      keys.length > INVENTORY_LOTW_BATCH_LIMIT ||
      new Set(keys).size !== keys.length
    )
      throw new Error("invalid_inventory_delivery_selection");
    const proof = await this.store
      .statement(
        "SELECT scope_id,snapshot,expires_at FROM inventory_source_proof_current WHERE tenant=? AND proof_id=?",
        tenant,
        proofId,
      )
      .first<{
        scope_id: string;
        snapshot: string;
        expires_at: number;
      }>();
    if (!proof) return { kind: "held" as const, reason: "source_proof_stale" };
    const { source, contacts, dependencies } = JSON.parse(
      proof.snapshot,
    ) as InventorySourceProofSnapshot;
    const selected = contacts.filter(({ key }) => keys.includes(key));
    if (selected.length !== keys.length)
      return { kind: "held" as const, reason: "contact_outside_source_proof" };
    const reviews = await this.store
      .statement(
        `WITH chosen AS MATERIALIZED(
          SELECT b.* FROM json_each(?1) j CROSS JOIN inventory_delivery_preparation_review b
          WHERE b.tenant=?2 AND b.source_scope=?3 AND b.destination=?4 AND b.record_key=j.value
        ), fresh AS MATERIALIZED(
          SELECT result_set FROM (SELECT DISTINCT result_set FROM chosen) c
          WHERE NOT EXISTS(SELECT 1 FROM inventory_match_stale_sets x WHERE x.tenant=?2 AND x.set_id=c.result_set)
        )
        SELECT b.* FROM chosen b JOIN fresh f USING(result_set)`,
        canonical(keys),
        tenant,
        proof.scope_id,
        destination,
      )
      .all<InventoryDeliveryReviewBinding>();
    const reviewByKey = new Map(
      reviews.results.map((review) => [review.record_key, review]),
    );
    const bindings = selected.flatMap((contact) => {
      const review = reviewByKey.get(contact.key);
      if (
        !review ||
        review.generation_id !== source.generation_id ||
        review.source_credential !== source.credential_version ||
        review.source_config_version !== source.config_version ||
        review.source_identity !== source.logical_identity ||
        review.projection_version !== contact.projectionVersion ||
        review.projection_payload !== contact.projectionPayload ||
        !contact.routes.some(
          (route) =>
            route.provider === review.provider &&
            route.destination === destination,
        )
      )
        return [];
      return [{ contact, review }];
    });
    if (bindings.length !== keys.length)
      return { kind: "held" as const, reason: "destination_review_stale" };
    if (bindings.some(({ review }) => review.proof_not_before > Date.now()))
      return { kind: "held" as const, reason: "destination_review_quiet" };
    const parents = new Set(
      selected.flatMap(({ operation }) => (operation ? [operation] : [])),
    );
    const needed = dependencies.filter(({ target }) =>
      target.kind === "operation" || target.isEvent
        ? target.operationId !== null && parents.has(target.operationId)
        : keys.includes(target.id),
    );
    const raw = await this.openSourceBodies(
      tenant,
      proof.scope_id,
      source.connection_id,
      needed,
    );
    if (!raw)
      return { kind: "held" as const, reason: "source_payload_unavailable" };
    const approved = await new InventoryProjections(this.store).bodies(
      tenant,
      source.generation_id,
      selected.map((contact) => ({
        scope: proof.scope_id,
        key: contact.key,
        facet: "source",
        version: contact.projectionVersion,
        payload: contact.projectionPayload,
      })),
      {
        maxBytes: MAX_BYTES - Math.max(raw.encryptedBytes, raw.plaintextBytes),
      },
    );
    const approvedByKey = new Map(
      approved.items.map((item) => [item.key, item.body]),
    );
    const members = [];
    for (const { contact: bound, review } of bindings) {
      const rawContact = raw.bodies.find(
        ({ target }) =>
          target.kind === "qso" && !target.isEvent && target.id === bound.key,
      )?.body;
      const operation = raw.bodies.find(
        ({ target }) =>
          target.kind === "operation" && target.id === bound.operation,
      )?.body;
      const events = raw.bodies.flatMap(({ target, body }) =>
        target.isEvent && target.operationId === bound.operation ? [body] : [],
      );
      const projection = approvedByKey.get(bound.key);
      if (!rawContact || (bound.operation && !operation) || !projection?.source)
        return { kind: "held" as const, reason: "projection_unavailable" };
      const contact = await projectContact(
        rawContact,
        operation ?? null,
        events,
        {
          operationComplete: true,
        },
      );
      const fingerprint =
        review.provider === "qrz"
          ? contact.generation
          : await sourceFingerprint(contact, "lotw");
      if (
        projection.state !== "ready" ||
        contact.deleted ||
        contact.id !== bound.key ||
        contact.operationId !== bound.operation ||
        fingerprint !== projection.source[review.provider] ||
        contact.startAtMillis !== projection.source.startAtMillis ||
        contact.timePrecision !== projection.source.timePrecision ||
        canonical(contactReconciliationAdif(contact)) !==
          canonical(projection.record)
      )
        return { kind: "held" as const, reason: "projection_changed" };
      members.push({ contact, fingerprint, review });
    }
    return {
      kind: "captured" as const,
      proofId,
      sourceScope: proof.scope_id,
      expiresAt: proof.expires_at,
      members,
      stats: {
        dependencies: needed.length,
        rowsRead:
          reviews.meta.rows_read + raw.rowsRead + approved.stats.rowsRead,
        encryptedBytes: raw.encryptedBytes + approved.stats.encryptedInputBytes,
        plaintextBytes: raw.plaintextBytes + approved.stats.plaintextBytes,
      },
    };
  }

  private async openSourceBodies(
    tenant: string,
    scope: string,
    connection: string,
    dependencies: InventorySourceProofDependency[],
  ) {
    if (
      !dependencies.length ||
      dependencies.length > INVENTORY_SOURCE_PROOF_DEPENDENCY_LIMIT
    )
      return null;
    const result = await this.store
      .statement(
        `WITH refs AS MATERIALIZED(
           SELECT CAST(j.key AS INTEGER) AS ordinal,p.payload_id,length(CAST(p.envelope AS BLOB)) AS bytes
           FROM json_each(?1) j CROSS JOIN inventory_payloads p
           WHERE p.tenant=?2 AND p.scope_id=?3 AND p.payload_id=j.value AND p.connection_id=?4 AND p.kind='inventory_source'
         ), admitted AS MATERIALIZED(
           SELECT count(*)=?5 AND coalesce(sum(bytes),0)<=?6 AS ok FROM refs
         )
         SELECT r.ordinal,r.bytes,p.envelope FROM admitted a CROSS JOIN refs r CROSS JOIN inventory_payloads p
         WHERE a.ok AND p.tenant=?2 AND p.scope_id=?3 AND p.payload_id=r.payload_id`,
        canonical(dependencies.map(({ payload }) => payload)),
        tenant,
        scope,
        connection,
        dependencies.length,
        MAX_BYTES,
      )
      .all<{ ordinal: number; bytes: number; envelope: string }>();
    if (result.results.length !== dependencies.length) return null;
    let plaintextBytes = 0;
    const bodies = [];
    for (const { ordinal, bytes, envelope } of result.results) {
      const dependency = dependencies[ordinal];
      if (!dependency || encoder.encode(envelope).byteLength !== bytes)
        return null;
      const body = await open<SourceRecord>(
        JSON.parse(envelope) as Envelope,
        {
          tenant,
          connection,
          id: dependency.payload,
          kind: "inventory_source",
          purpose: "storage",
        },
        this.store.keys,
      );
      plaintextBytes += encoder.encode(canonical(body)).byteLength;
      if (plaintextBytes > MAX_BYTES || body.uuid !== dependency.target.id)
        return null;
      bodies.push({ target: dependency.target, body });
    }
    return {
      bodies,
      rowsRead: result.meta.rows_read,
      encryptedBytes: result.results.reduce((sum, row) => sum + row.bytes, 0),
      plaintextBytes,
    };
  }
}
