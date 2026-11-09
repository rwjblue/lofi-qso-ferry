import { historicalQrzLogId } from "./historical-associations.ts";
import {
  type HistoricalVendor,
  historicalCandidates,
} from "./historical-matching.ts";
import { InventoryComparisonGenerations } from "./inventory-comparison-generations.ts";
import { inventoryJsonChunks } from "./inventory-ingestion.ts";
import { inventoryCurrentMatchSelection } from "./inventory-matching-results.ts";
import {
  InventoryOwnership,
  type InventoryOwnershipBody,
  inventoryOwnershipIdentity,
} from "./inventory-ownership.ts";
import { InventoryProjections } from "./inventory-projections.ts";
import { canonical, seal, sha256 } from "./security.ts";
import type { Lease, Store } from "./store.ts";

interface Selection {
  scope: string;
  key: string;
}
interface Target {
  provider: HistoricalVendor;
  logical_identity: string;
}
interface Existing extends Selection, Target {
  source_identity: string | null;
  association: string | null;
}
interface Member extends Selection {
  source_identity: string;
  match_set: string;
  match_version: number;
  remote_record_key: string;
  source_projection_version: number;
  source_payload: string;
  remote_projection_version: number;
  remote_payload: string;
}
interface CurrentMember extends Member {
  state: string;
  reason: string | null;
  generation_id: string;
  inputs_ready: number;
}
export interface InventoryAdoptionRow extends Member {
  association_id: string;
  evidence_id: string;
  claim_hash: string;
  bucket_hash: string;
  remote_id: string | null;
  existing_evidence: number;
}
interface EvidenceInput {
  id: string;
  source_scope: string;
  source_identity: string;
  record_key: string;
  claim_hash: string;
  bucket_hash: string;
  remote_id: string | null;
  envelope: string;
}
export interface PreparedInventoryAdoption {
  formatVersion: 1;
  tenant: string;
  destination: string;
  provider: HistoricalVendor;
  book: string;
  keyId: string | null;
  ownershipVersion: number | null;
  rows: InventoryAdoptionRow[];
  evidence: EvidenceInput[];
  skipped: {
    scope: string;
    key: string;
    reason: string;
    association?: string;
  }[];
  preparedAt: number;
  digest: string;
  stats: {
    decryptedBodies: number;
    encryptedInputBytes: number;
    plaintextBytes: number;
    ownershipCandidates: number;
  };
}
const key = (row: Selection) => canonical([row.scope, row.key]);
const owner = (sourceIdentity: string, recordKey: string) =>
  canonical([sourceIdentity, recordKey]);
const leaseScope = (provider: string) => `inventory-ownership:${provider}`;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;

/** Permanent association-only adoption. It cannot synthesize Ferry-created
 * provenance, a receipt identity, confirmation or an upload/signing attempt. */
export class InventoryAssociations {
  constructor(readonly store: Store) {}
  async prepare(
    tenant: string,
    destination: string,
    selected: readonly Selection[],
  ): Promise<PreparedInventoryAdoption> {
    selected = structuredClone(selected);
    if (
      !identifier(tenant) ||
      !identifier(destination) ||
      selected.length < 1 ||
      selected.length > 20 ||
      selected.some((row) => !identifier(row.scope) || !identifier(row.key)) ||
      new Set(selected.map(key)).size !== selected.length
    )
      throw new Error("invalid_inventory_adoption_selection");
    const existing = await this.store
      .statement(
        `WITH target AS MATERIALIZED (
   SELECT tenant,provider,logical_identity FROM inventory_scopes WHERE tenant=?2 AND scope_id=?3 AND provider IN('qrz','lotw')
 ) SELECT t.provider,t.logical_identity,json_extract(j.value,'$.scope') AS scope,json_extract(j.value,'$.key') AS key,s.logical_identity AS source_identity,a.id AS association
   FROM target t CROSS JOIN json_each(?1) j
   LEFT JOIN inventory_scopes s ON s.tenant=t.tenant AND s.scope_id=json_extract(j.value,'$.scope') AND s.provider='lofi'
   LEFT JOIN inventory_historical_associations a ON a.tenant=t.tenant AND a.provider=t.provider AND a.book_identity=t.logical_identity AND a.source_identity=s.logical_identity AND a.record_key=json_extract(j.value,'$.key')
   ORDER BY CAST(j.key AS INTEGER)`,
        canonical(selected),
        tenant,
        destination,
      )
      .all<Existing>();
    const target = existing.results[0];
    if (!target) throw new Error("inventory_adoption_destination_unavailable");
    const skipped: PreparedInventoryAdoption["skipped"] = [];
    const pending: Selection[] = [];
    for (const row of existing.results) {
      if (row.association)
        skipped.push({
          scope: row.scope,
          key: row.key,
          reason: "historical_mapping_preserved",
          association: row.association,
        });
      else if (!row.source_identity)
        skipped.push({
          scope: row.scope,
          key: row.key,
          reason: "source_scope_unavailable",
        });
      else pending.push({ scope: row.scope, key: row.key });
    }
    const page: Omit<PreparedInventoryAdoption, "digest"> = {
      formatVersion: 1,
      tenant,
      destination,
      provider: target.provider,
      book: target.logical_identity,
      keyId: null,
      ownershipVersion: null,
      rows: [],
      evidence: [],
      skipped,
      preparedAt: Date.now(),
      stats: {
        decryptedBodies: 0,
        encryptedInputBytes: 0,
        plaintextBytes: 0,
        ownershipCandidates: 0,
      },
    };
    const finish = async () => ({
      ...page,
      digest: await sha256(canonical(page)),
    });
    if (!pending.length) return finish();
    const {
      results: [prior, metadata],
      openKey,
    } = await new InventoryComparisonGenerations(this.store).keyWith(tenant, [
      this.store.statement(
        "SELECT 1 FROM inventory_prior_delivery_evidence WHERE tenant=? AND provider=? LIMIT 1",
        tenant,
        target.provider,
      ),
      this.store.statement(
        `${inventoryCurrentMatchSelection}
         SELECT r.source_scope AS scope,r.record_key AS key,r.state,r.reason,r.generation_id,
           s.logical_identity AS source_identity,r.set_id AS match_set,r.version AS match_version,r.remote_key AS remote_record_key,
           src.current_projection_version AS source_projection_version,src.payload_id AS source_payload,
           remote.current_projection_version AS remote_projection_version,remote.payload_id AS remote_payload,
           (s.scope_id IS NOT NULL AND src.record_key IS NOT NULL AND remote.record_key IS NOT NULL) AS inputs_ready
         FROM current_matches r
         LEFT JOIN inventory_scopes s ON r.state='matched_existing' AND (s.tenant,s.scope_id,s.provider)=(r.tenant,r.source_scope,'lofi')
         LEFT JOIN inventory_match_records src ON s.scope_id IS NOT NULL
           AND (src.tenant,src.set_id,src.scope_id,src.record_key,src.facet)=(r.tenant,r.set_id,r.source_scope,r.record_key,'source')
         LEFT JOIN inventory_match_records remote ON s.scope_id IS NOT NULL
           AND (remote.tenant,remote.set_id,remote.scope_id,remote.record_key,remote.facet)=(r.tenant,r.set_id,r.destination,r.remote_key,'receipt')`,
        canonical(pending),
        tenant,
        destination,
      ),
    ]);
    const current = metadata.results as CurrentMember[];
    const byKey = new Map(current.map((row) => [key(row), row]));
    const matches: CurrentMember[] = [];
    for (const row of pending) {
      const result = byKey.get(key(row));
      if (result?.state === "matched_existing") matches.push(result);
      else
        skipped.push({
          ...row,
          reason: result?.reason ?? "comparison_not_matched",
        });
    }
    if (!matches.length) return finish();
    if (prior.results.length) {
      for (const row of matches)
        skipped.push({
          scope: row.scope,
          key: row.key,
          reason: "prior_delivery_evidence",
        });
      return finish();
    }
    if (matches.some((row) => !row.inputs_ready))
      throw new Error("inventory_adoption_match_changed");
    const generationIds = new Set(matches.map((row) => row.generation_id));
    if (generationIds.size !== 1)
      throw new Error("inventory_adoption_generation_changed");
    const generation = [...generationIds][0];
    const members = matches.map(
      ({
        generation_id: _generation,
        state: _state,
        reason: _reason,
        inputs_ready: _ready,
        ...row
      }) => row,
    );
    const refs = members.flatMap((row) => [
      {
        scope: row.scope,
        key: row.key,
        facet: "source" as const,
        version: row.source_projection_version,
        payload: row.source_payload,
      },
      {
        scope: destination,
        key: row.remote_record_key,
        facet: "receipt" as const,
        version: row.remote_projection_version,
        payload: row.remote_payload,
      },
    ]);
    const bodies = await new InventoryProjections(this.store).bodies(
      tenant,
      generation,
      refs,
    );
    if (bodies.missing.length)
      throw new Error("inventory_adoption_projection_unavailable");
    page.stats.decryptedBodies += bodies.stats.decryptedBodies;
    page.stats.encryptedInputBytes += bodies.stats.encryptedInputBytes;
    page.stats.plaintextBytes += bodies.stats.plaintextBytes;
    const remote = members.map((row) => {
      const body = bodies.items.find(
        (body) =>
          body.scope === destination &&
          body.key === row.remote_record_key &&
          body.facet === "receipt",
      )?.body;
      if (body?.state !== "ready")
        throw new Error("inventory_adoption_projection_unavailable");
      return body.record;
    });
    const lookup = await new InventoryOwnership(this.store).lookup(
      tenant,
      target.provider,
      members.map((row, i) => ({
        id: String(i),
        sourceIdentity: row.source_identity,
        key: row.key,
        book: target.logical_identity,
        remoteKey: row.remote_record_key,
        record: remote[i],
      })),
      {
        key: await openKey(),
        maxRecords: 128 - bodies.items.length,
        maxBytes:
          4 * 1024 * 1024 -
          Math.max(page.stats.encryptedInputBytes, page.stats.plaintextBytes),
      },
    );
    page.keyId = lookup.keyId;
    page.ownershipVersion = lookup.version;
    page.stats.ownershipCandidates = lookup.evidence.length;
    page.stats.decryptedBodies += lookup.stats.decryptedBodies;
    page.stats.encryptedInputBytes += lookup.stats.encryptedInputBytes;
    page.stats.plaintextBytes += lookup.stats.plaintextBytes;
    const conflicts = new Set<number>();
    if (target.provider === "lotw")
      for (let i = 0; i < remote.length; i++)
        for (let j = i + 1; j < remote.length; j++)
          if (
            owner(members[i].source_identity, members[i].key) !==
              owner(members[j].source_identity, members[j].key) &&
            historicalCandidates("lotw", remote[i], [remote[j]]).state !==
              "none"
          ) {
            conflicts.add(i);
            conflicts.add(j);
          }
    for (const [i, row] of members.entries()) {
      const observation = lookup.observations[i];
      if (
        lookup.state !== "observed" ||
        observation.state === "held" ||
        observation.state === "conflict" ||
        conflicts.has(i)
      ) {
        skipped.push({
          scope: row.scope,
          key: row.key,
          reason: conflicts.has(i)
            ? "ownership_conflict"
            : (observation.reason ?? "ownership_unavailable"),
        });
        continue;
      }
      const token = lookup.tokens[i],
        evidenceId = observation.evidenceId ?? crypto.randomUUID();
      const remoteId =
        target.provider === "qrz"
          ? historicalQrzLogId(row.remote_record_key)
          : null;
      page.rows.push({
        ...row,
        association_id: crypto.randomUUID(),
        evidence_id: evidenceId,
        claim_hash: token.claim,
        bucket_hash: token.bucket,
        remote_id: remoteId,
        existing_evidence: Number(!!observation.evidenceId),
      });
      if (!observation.evidenceId) {
        const body: InventoryOwnershipBody = {
          version: 1,
          provider: target.provider,
          kind: "historical",
          record: remote[i],
        };
        page.evidence.push({
          id: evidenceId,
          source_scope: row.scope,
          source_identity: row.source_identity,
          record_key: row.key,
          claim_hash: token.claim,
          bucket_hash: token.bucket,
          remote_id: remoteId,
          envelope: JSON.stringify(
            await seal(
              body,
              inventoryOwnershipIdentity(tenant, evidenceId),
              this.store.keys,
            ),
          ),
        });
      }
    }
    return finish();
  }
  private async recover(page: PreparedInventoryAdoption, id: string) {
    const row = await this.store
      .statement(
        "SELECT input_digest,state,row_count FROM inventory_adoption_pages WHERE tenant=? AND page_id=?",
        page.tenant,
        id,
      )
      .first<{ input_digest: string; state: string; row_count: number }>();
    if (!row) return null;
    if (row.input_digest !== page.digest || row.state !== "committed")
      throw new Error("inventory_adoption_receipt_conflict");
    return {
      pageId: id,
      recovered: true,
      records: row.row_count,
      statements: 0,
      rowsRead: 0,
      rowsWritten: 0,
    };
  }
  async publish(
    page: PreparedInventoryAdoption,
    lease: Lease,
    id: string = crypto.randomUUID(),
  ) {
    page = structuredClone(page);
    lease = structuredClone(lease);
    const { digest, ...manifest } = page;
    if (digest !== (await sha256(canonical(manifest))))
      throw new Error("inventory_adoption_preparation_changed");
    if (
      !identifier(id) ||
      lease.tenant !== page.tenant ||
      lease.scope !== leaseScope(page.provider)
    )
      throw new Error("invalid_inventory_adoption_lease");
    const existing = await this.recover(page, id);
    if (existing) return existing;
    if (
      page.formatVersion !== 1 ||
      page.rows.length < 1 ||
      page.rows.length > 20 ||
      page.evidence.length > page.rows.length ||
      !page.keyId ||
      page.ownershipVersion === null ||
      new Set(page.rows.map((row) => owner(row.source_identity, row.key)))
        .size !== page.rows.length
    )
      throw new Error("invalid_inventory_adoption_manifest");
    const plan = [
      this.store.statement(
        `INSERT INTO inventory_adoption_pages(tenant,page_id,provider,destination_scope,book_identity,key_id,ownership_version,lease_token,lease_fence,input_digest,prepared_at,row_count,new_evidence_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        page.tenant,
        id,
        page.provider,
        page.destination,
        page.book,
        page.keyId,
        page.ownershipVersion,
        lease.token,
        lease.fence,
        page.digest,
        page.preparedAt,
        page.rows.length,
        page.evidence.length,
      ),
    ];
    for (const chunk of inventoryJsonChunks(page.rows))
      plan.push(
        this.store.statement(
          `INSERT INTO inventory_adoption_rows(tenant,page_id,association_id,source_scope,source_identity,record_key,match_set,match_version,remote_record_key,source_projection_version,source_payload,remote_projection_version,remote_payload,evidence_id,claim_hash,bucket_hash,remote_id,existing_evidence)
   SELECT ?,?,json_extract(value,'$.association_id'),json_extract(value,'$.scope'),json_extract(value,'$.source_identity'),json_extract(value,'$.key'),json_extract(value,'$.match_set'),json_extract(value,'$.match_version'),json_extract(value,'$.remote_record_key'),json_extract(value,'$.source_projection_version'),json_extract(value,'$.source_payload'),json_extract(value,'$.remote_projection_version'),json_extract(value,'$.remote_payload'),json_extract(value,'$.evidence_id'),json_extract(value,'$.claim_hash'),json_extract(value,'$.bucket_hash'),json_extract(value,'$.remote_id'),json_extract(value,'$.existing_evidence') FROM json_each(?)`,
          page.tenant,
          id,
          chunk,
        ),
      );
    plan.push(
      this.store.statement(
        "INSERT INTO inventory_adoption_guards(tenant,page_id) VALUES(?,?)",
        page.tenant,
        id,
      ),
    );
    for (const chunk of inventoryJsonChunks(page.evidence))
      plan.push(
        this.store.statement(
          `INSERT INTO inventory_ownership_evidence(tenant,id,provider,book_identity,destination_scope,source_scope,source_identity,record_key,remote_id,kind,key_id,claim_hash,bucket_hash,envelope,encrypted_bytes,created_at)
   SELECT ?,json_extract(value,'$.id'),?,?,?,json_extract(value,'$.source_scope'),json_extract(value,'$.source_identity'),json_extract(value,'$.record_key'),json_extract(value,'$.remote_id'),'historical',?,json_extract(value,'$.claim_hash'),json_extract(value,'$.bucket_hash'),json_extract(value,'$.envelope'),length(json_extract(value,'$.envelope')),? FROM json_each(?)`,
          page.tenant,
          page.provider,
          page.book,
          page.destination,
          page.keyId,
          page.preparedAt,
          chunk,
        ),
      );
    plan.push(
      this.store.statement(
        `INSERT INTO inventory_historical_associations(tenant,id,provider,book_identity,destination_scope,source_scope,source_identity,record_key,remote_record_key,source_payload,remote_payload,evidence_id,match_set,adoption_page,created_at)
   SELECT q.tenant,q.association_id,h.provider,h.book_identity,h.destination_scope,q.source_scope,q.source_identity,q.record_key,q.remote_record_key,q.source_payload,q.remote_payload,q.evidence_id,q.match_set,q.page_id,h.prepared_at FROM inventory_adoption_rows q JOIN inventory_adoption_pages h ON h.tenant=q.tenant AND h.page_id=q.page_id WHERE q.tenant=? AND q.page_id=?`,
        page.tenant,
        id,
      ),
      this.store.statement(
        "UPDATE inventory_adoption_pages SET state='committed' WHERE tenant=? AND page_id=?",
        page.tenant,
        id,
      ),
    );
    let results: D1Result[];
    try {
      results = await this.store.db.batch(plan);
    } catch (error) {
      const receipt = await this.recover(page, id).catch(() => null);
      if (receipt) return receipt;
      throw error;
    }
    return {
      pageId: id,
      recovered: false,
      records: page.rows.length,
      statements: plan.length,
      rowsRead: results.reduce((n, row) => n + row.meta.rows_read, 0),
      rowsWritten: results.reduce((n, row) => n + row.meta.rows_written, 0),
    };
  }
  async adopt(
    tenant: string,
    destination: string,
    selected: readonly Selection[],
  ) {
    const page = await this.prepare(tenant, destination, selected);
    if (!page.rows.length)
      return { deferred: false, records: 0, skipped: page.skipped };
    const lease = await this.store.claim(
      tenant,
      leaseScope(page.provider),
      Date.now(),
      60000,
    );
    if (!lease) return { deferred: true, records: 0, skipped: page.skipped };
    try {
      return {
        ...(await this.publish(page, lease)),
        deferred: false,
        skipped: page.skipped,
      };
    } finally {
      await this.store.release(lease);
    }
  }
}
