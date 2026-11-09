import { inventoryJsonChunks } from "./inventory-ingestion.ts";
import {
  type InventoryProjectionBody,
  InventoryProjectionWorkspace,
  inventoryProjectionDigest,
  inventoryProjectionIdentity,
  type PreparedInventoryProjections,
} from "./inventory-projection-workspace.ts";
import { canonical, type Envelope, open } from "./security.ts";
import type { Lease, Store } from "./store.ts";

interface ProjectionReceipt {
  input_digest: string;
  state: string;
  row_count: number;
  ready_count: number;
  held_count: number;
  excluded_count: number;
}
export interface InventoryProjectionRead {
  scope: string;
  key: string;
  facet: "source" | "receipt";
  version: number;
  payload: string;
}
interface ProjectionReadMetadata {
  ordinal: number;
  connection_id: string;
  encrypted_bytes: number;
  state: "ready" | "held" | "excluded";
}
const encoder = new TextEncoder();
const readKey = (row: InventoryProjectionRead) =>
  canonical([row.scope, row.key, row.facet]);
const MAX_READ_BYTES = 4 * 1024 * 1024;
const leaseScope = (generation: string, scope: string) =>
  `projection:${generation}:${scope}`;
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

/** Publishes derived availability only. No observation, coverage or write proof
 * is renewed by this transaction, and excluded contacts retain their hash. */
export class InventoryProjections {
  constructor(readonly store: Store) {}
  private async recover(page: PreparedInventoryProjections, pageId: string) {
    const row = await this.store
      .statement(
        "SELECT input_digest,state,row_count,ready_count,held_count,excluded_count FROM comparison_projection_pages WHERE tenant=? AND page_id=?",
        page.tenant,
        pageId,
      )
      .first<ProjectionReceipt>();
    if (!row) return null;
    if (row.input_digest !== page.digest || row.state !== "committed")
      throw new Error("inventory_projection_receipt_conflict");
    return {
      pageId,
      recovered: true,
      records: row.row_count,
      ready: row.ready_count,
      held: row.held_count,
      excluded: row.excluded_count,
      statements: 0,
      rowsRead: 0,
      rowsWritten: 0,
    };
  }
  async publish(
    page: PreparedInventoryProjections,
    lease: Lease,
    pageId: string = crypto.randomUUID(),
  ) {
    page = structuredClone(page);
    lease = structuredClone(lease);
    const { digest, ...input } = page;
    if (digest !== (await inventoryProjectionDigest(input)))
      throw new Error("inventory_projection_preparation_changed");
    if (
      !identifier(pageId) ||
      lease.tenant !== page.tenant ||
      lease.scope !== leaseScope(page.generation, page.scope)
    )
      throw new Error("invalid_inventory_projection_lease");
    const existing = await this.recover(page, pageId);
    if (existing) return existing;
    if (
      page.rows.length < 1 ||
      page.rows.length > 20 ||
      page.inputs.length !== page.rows.length ||
      page.payloads.length !== page.rows.length ||
      page.dependencies.length > 256
    )
      throw new Error("invalid_inventory_projection_manifest");
    if (
      page.rows.length > 1 &&
      page.rows.some(
        (row) =>
          row.reason === "projection_byte_bound" ||
          row.reason === "projection_context_bound",
      )
    )
      throw new Error("inventory_projection_split_required");
    const byKey = new Map(
      page.inputs.map((row) => [canonical([row.key, row.facet]), row]),
    );
    const payloadIds = new Set(page.payloads.map((row) => row.id));
    if (
      byKey.size !== page.rows.length ||
      payloadIds.size !== page.rows.length ||
      new Set(page.rows.map((row) => row.payload)).size !== page.rows.length
    )
      throw new Error("invalid_inventory_projection_manifest");
    const rows = page.rows.map((row) => {
      const source = byKey.get(canonical([row.key, row.facet]));
      if (!source?.payload_id || !payloadIds.has(row.payload))
        throw new Error("invalid_inventory_projection_manifest");
      return { ...source, ...row, raw_payload_id: source.payload_id };
    });
    const ready = page.rows.filter((row) => row.state === "ready").length,
      held = page.rows.filter((row) => row.state === "held").length,
      excluded = page.rows.filter((row) => row.state === "excluded").length;
    const bound = (sql: string) =>
      this.store.statement(sql, page.tenant, pageId);
    const plan: D1PreparedStatement[] = [
      this.store.statement(
        `INSERT INTO comparison_projection_pages(tenant,page_id,generation_id,scope_id,connection_id,provider,domain_version,config_version,input_digest,lease_token,lease_fence,prepared_at,coverage,context_complete,row_count,dependency_count,ready_count,held_count,excluded_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        page.tenant,
        pageId,
        page.generation,
        page.scope,
        page.connection,
        page.provider,
        page.domainVersion,
        page.configVersion,
        page.digest,
        lease.token,
        lease.fence,
        page.preparedAt,
        canonical(page.coverage),
        Number(page.contextComplete),
        page.rows.length,
        page.dependencies.length,
        ready,
        held,
        excluded,
      ),
    ];
    for (const chunk of inventoryJsonChunks(rows))
      plan.push(
        this.store.statement(
          `INSERT INTO comparison_projection_rows(tenant,page_id,record_key,facet,semantic_version,raw_payload_id,parent_key,key_class,bucket_hash,projection_version,topology_version,membership_version,work_version,completed_version,state,reason,payload_id)
   SELECT ?,?,json_extract(value,'$.key'),json_extract(value,'$.facet'),json_extract(value,'$.semantic_version'),json_extract(value,'$.raw_payload_id'),json_extract(value,'$.parent_key'),json_extract(value,'$.key_class'),json_extract(value,'$.bucket_hash'),json_extract(value,'$.projection_version'),json_extract(value,'$.topology_version'),json_extract(value,'$.membership_version'),json_extract(value,'$.work_version'),json_extract(value,'$.completed_version'),json_extract(value,'$.state'),json_extract(value,'$.reason'),json_extract(value,'$.payload') FROM json_each(?)`,
          page.tenant,
          pageId,
          chunk,
        ),
      );
    for (const chunk of inventoryJsonChunks(page.dependencies))
      plan.push(
        this.store.statement(
          `INSERT INTO comparison_projection_dependencies(tenant,page_id,entity_family,record_key,facet,subtype,status,parent_key,semantic_version,payload_id,connection_id,kind,payload_bytes,membership_version,member_state)
   SELECT ?,?,json_extract(value,'$.family'),json_extract(value,'$.key'),json_extract(value,'$.facet'),json_extract(value,'$.subtype'),json_extract(value,'$.status'),json_extract(value,'$.parent_key'),json_extract(value,'$.semantic_version'),json_extract(value,'$.payload_id'),json_extract(value,'$.connection_id'),json_extract(value,'$.kind'),json_extract(value,'$.payload_bytes'),json_extract(value,'$.membership_version'),json_extract(value,'$.member_state') FROM json_each(?)`,
          page.tenant,
          pageId,
          chunk,
        ),
      );
    plan.push(
      bound(
        "INSERT INTO comparison_projection_guards(tenant,page_id) VALUES(?,?)",
      ),
    );
    for (const chunk of inventoryJsonChunks(page.payloads))
      plan.push(
        this.store.statement(
          `INSERT INTO comparison_projection_payloads(tenant,scope_id,payload_id,connection_id,envelope,encrypted_bytes,created_at) SELECT ?,?,json_extract(value,'$.id'),?,json_extract(value,'$.envelope'),length(json_extract(value,'$.envelope')),? FROM json_each(?)`,
          page.tenant,
          page.scope,
          page.connection,
          page.preparedAt,
          chunk,
        ),
      );
    plan.push(
      bound(`INSERT INTO comparison_projections(tenant,generation_id,scope_id,record_key,facet,version,semantic_version,config_version,parent_key,topology_version,membership_version,state,reason,payload_id,coverage_stream,coverage_partition,coverage_version,derived_at,last_page_id)
    SELECT q.tenant,p.generation_id,p.scope_id,q.record_key,q.facet,q.projection_version+1,q.semantic_version,p.config_version,q.parent_key,q.topology_version,q.membership_version,q.state,q.reason,q.payload_id,json_extract(p.coverage,'$.stream_id'),json_extract(p.coverage,'$.partition_id'),json_extract(p.coverage,'$.version'),p.prepared_at,p.page_id
    FROM comparison_projection_rows q JOIN comparison_projection_pages p ON p.tenant=q.tenant AND p.page_id=q.page_id WHERE q.tenant=? AND q.page_id=?
    ON CONFLICT(tenant,generation_id,scope_id,record_key,facet) DO UPDATE SET version=excluded.version,semantic_version=excluded.semantic_version,config_version=excluded.config_version,parent_key=excluded.parent_key,topology_version=excluded.topology_version,membership_version=excluded.membership_version,state=excluded.state,reason=excluded.reason,payload_id=excluded.payload_id,coverage_stream=excluded.coverage_stream,coverage_partition=excluded.coverage_partition,coverage_version=excluded.coverage_version,derived_at=excluded.derived_at,last_page_id=excluded.last_page_id`),
      bound(`UPDATE comparison_index AS i SET state=(SELECT CASE q.state WHEN 'held' THEN 'held' ELSE 'ready' END FROM comparison_projection_rows q WHERE q.tenant=i.tenant AND q.page_id=?2 AND q.record_key=i.record_key AND q.facet=i.facet),projection_version=projection_version+1,topology_version=(SELECT q.topology_version FROM comparison_projection_rows q WHERE q.tenant=i.tenant AND q.page_id=?2 AND q.record_key=i.record_key AND q.facet=i.facet)
    WHERE i.tenant=?1 AND (i.generation_id,i.scope_id)=(SELECT generation_id,scope_id FROM comparison_projection_pages WHERE tenant=?1 AND page_id=?2) AND (i.record_key,i.facet) IN (SELECT record_key,facet FROM comparison_projection_rows WHERE tenant=?1 AND page_id=?2)`),
      bound(
        `UPDATE comparison_work AS w SET completed_version=work_version WHERE w.tenant=?1 AND (w.generation_id,w.scope_id)=(SELECT generation_id,scope_id FROM comparison_projection_pages WHERE tenant=?1 AND page_id=?2) AND (w.record_key,w.facet) IN (SELECT record_key,facet FROM comparison_projection_rows WHERE tenant=?1 AND page_id=?2)`,
      ),
      bound(
        "UPDATE comparison_projection_pages SET state='committed' WHERE tenant=? AND page_id=?",
      ),
      ...[
        "comparison_projection_dependencies",
        "comparison_projection_rows",
        "comparison_projection_guards",
      ].map((table) =>
        bound(`DELETE FROM ${table} WHERE tenant=? AND page_id=?`),
      ),
    );
    if (plan.length > 200)
      throw new Error("inventory_projection_transaction_too_large");
    let results: D1Result[];
    try {
      results = await this.store.db.batch(plan);
    } catch (error) {
      const receipt = await this.recover(page, pageId).catch(() => null);
      if (receipt) return receipt;
      throw error;
    }
    return {
      pageId,
      recovered: false,
      records: page.rows.length,
      ready,
      held,
      excluded,
      statements: plan.length,
      rowsRead: results.reduce((sum, row) => sum + row.meta.rows_read, 0),
      rowsWritten: results.reduce((sum, row) => sum + row.meta.rows_written, 0),
    };
  }
  async project(
    tenant: string,
    generation: string,
    scope: string,
    keys: readonly string[],
  ) {
    keys = [...keys];
    const lease = await this.store.claim(
      tenant,
      leaseScope(generation, scope),
      Date.now(),
      60_000,
    );
    if (!lease) return { deferred: true as const };
    try {
      return await this.publish(
        await new InventoryProjectionWorkspace(this.store).prepare(
          tenant,
          generation,
          scope,
          keys,
        ),
        lease,
      );
    } finally {
      await this.store.release(lease);
    }
  }
  /** A bounded immutable input snapshot, not matching or write authority.
   * Publication must still recheck every captured dependency. Shared forward
   * and reverse references are loaded/decrypted once across the whole cohort. */
  async bodies(
    tenant: string,
    generation: string,
    requested: readonly InventoryProjectionRead[],
    options: { maxBytes?: number } = {},
  ) {
    requested = structuredClone(requested);
    const maxBytes = options.maxBytes ?? MAX_READ_BYTES;
    if (
      !identifier(tenant) ||
      !identifier(generation) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 ||
      maxBytes > MAX_READ_BYTES ||
      requested.length > 1024 ||
      requested.some(
        (row) =>
          !identifier(row.scope) ||
          !identifier(row.key) ||
          !identifier(row.payload) ||
          !["source", "receipt"].includes(row.facet) ||
          !Number.isSafeInteger(row.version) ||
          row.version < 1,
      ) ||
      encoder.encode(canonical(requested)).byteLength > 512 * 1024
    )
      throw new Error("invalid_inventory_projection_reads");
    const distinct = new Map<string, InventoryProjectionRead>();
    for (const row of requested) {
      const previous = distinct.get(readKey(row));
      if (
        previous &&
        (previous.version !== row.version || previous.payload !== row.payload)
      )
        throw new Error("inventory_projection_read_conflict");
      distinct.set(readKey(row), row);
    }
    if (distinct.size > 128)
      throw new Error("inventory_projection_read_split_required");
    const references = [...distinct.values()];
    const stats = {
      queries: 0,
      rowsRead: 0,
      encryptedInputBytes: 0,
      plaintextBytes: 0,
      decryptedBodies: 0,
    };
    const items: (InventoryProjectionRead & {
      body: InventoryProjectionBody;
    })[] = [];
    if (!references.length) return { items, missing: [], stats };
    // Materialize only metadata before admitting ciphertext in the same read.
    const payloads = await this.store
      .statement(
        `WITH requested AS MATERIALIZED (
           SELECT CAST(j.key AS INTEGER) AS ordinal,p.scope_id,p.payload_id,p.connection_id,p.encrypted_bytes,p.state
           FROM json_each(?1) j CROSS JOIN comparison_projections_current p
           WHERE p.tenant=?2 AND p.generation_id=?3 AND p.scope_id=json_extract(j.value,'$.scope') AND p.record_key=json_extract(j.value,'$.key') AND p.facet=json_extract(j.value,'$.facet') AND p.version=json_extract(j.value,'$.version') AND p.payload_id=json_extract(j.value,'$.payload')
         ), budget AS MATERIALIZED (
           SELECT sum(encrypted_bytes) AS bytes FROM requested
         )
         SELECT r.ordinal,r.connection_id,r.encrypted_bytes,r.state,p.envelope
         FROM budget b CROSS JOIN requested r
         LEFT JOIN comparison_projection_payloads p ON b.bytes<=?4 AND (p.tenant,p.scope_id,p.payload_id)=(?2,r.scope_id,r.payload_id)
         ORDER BY r.ordinal`,
        canonical(references),
        tenant,
        generation,
        maxBytes,
      )
      .all<ProjectionReadMetadata & { envelope: string | null }>();
    stats.queries++;
    stats.rowsRead += payloads.meta.rows_read;
    stats.encryptedInputBytes = payloads.results.reduce(
      (sum, row) => sum + row.encrypted_bytes,
      0,
    );
    if (stats.encryptedInputBytes > maxBytes)
      throw new Error("inventory_projection_read_byte_bound");
    for (const row of payloads.results) {
      if (row.envelope === null) continue;
      const reference = references[row.ordinal];
      if (encoder.encode(row.envelope).byteLength !== row.encrypted_bytes)
        throw new Error("inventory_projection_read_size_mismatch");
      const body = await open<InventoryProjectionBody>(
        JSON.parse(row.envelope) as Envelope,
        inventoryProjectionIdentity(
          tenant,
          row.connection_id,
          reference.payload,
        ),
        this.store.keys,
      );
      stats.plaintextBytes += encoder.encode(canonical(body)).byteLength;
      if (stats.plaintextBytes > maxBytes)
        throw new Error("inventory_projection_read_byte_bound");
      if (body.version !== 1 || body.state !== row.state)
        throw new Error("inventory_projection_body_changed");
      stats.decryptedBodies++;
      items.push({ ...reference, body });
    }
    const loaded = new Set(items.map(readKey));
    return {
      items,
      missing: references.filter((row) => !loaded.has(readKey(row))),
      stats,
    };
  }
  async body(
    tenant: string,
    generation: string,
    scope: string,
    key: string,
    facet: "source" | "receipt",
  ) {
    const row = await this.store
      .statement(
        `SELECT payload_id,connection_id,envelope,state,version FROM comparison_projections_current WHERE tenant=? AND generation_id=? AND scope_id=? AND record_key=? AND facet=?`,
        tenant,
        generation,
        scope,
        key,
        facet,
      )
      .first<{
        payload_id: string;
        connection_id: string;
        envelope: string;
        state: string;
        version: number;
      }>();
    if (!row) return null;
    const body = await open<InventoryProjectionBody>(
      JSON.parse(row.envelope) as Envelope,
      inventoryProjectionIdentity(tenant, row.connection_id, row.payload_id),
      this.store.keys,
    );
    if (body.version !== 1 || body.state !== row.state)
      throw new Error("inventory_projection_body_changed");
    return { version: row.version, payload: row.payload_id, body };
  }
}
