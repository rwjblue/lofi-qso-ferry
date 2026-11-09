import {
  INVENTORY_BODY_CIPHER_BYTES,
  openInventoryBody,
} from "./inventory-body-archive.ts";
import { InventoryComparisonGenerations } from "./inventory-comparison-generations.ts";
import {
  type InventoryComparisonToken,
  inventoryComparisonToken,
} from "./inventory-comparison-keys.ts";
import { inventoryComparisonHint } from "./inventory-comparison-pages.ts";
import { inventoryJsonChunks } from "./inventory-ingestion.ts";
import { canonical, sha256 } from "./security.ts";
import type { Lease, Store } from "./store.ts";

interface BuildSnapshot {
  version: number;
  config_version: number;
  cursor_key: string;
  complete: number;
  accepted_sequence: number;
  provider: string;
}
interface BuildRecord {
  record_key: string;
  subtype: string;
  status: string;
  parent_key: string | null;
  facet: "source" | "receipt";
  semantic_version: number;
  payload_id: string;
  connection_id: string;
  kind: string;
  payload_bytes: number;
  key_class: InventoryComparisonToken["keyClass"] | null;
  bucket_hash: string | null;
  reusable: number;
}
interface BuildRow {
  key: string;
  subtype: string;
  status: string;
  parent: string | null;
  facet: "source" | "receipt";
  semanticVersion: number;
  payload: string;
  keyClass: InventoryComparisonToken["keyClass"] | null;
  hash: string | null;
}
export interface PreparedComparisonBuild {
  tenant: string;
  generation: string;
  scope: string;
  pageId: string;
  digest: string;
  version: number;
  configVersion: number;
  sequence: number;
  domainVersion: number;
  lease: Lease;
  previousCursor: string;
  nextCursor: string;
  complete: boolean;
  rows: BuildRow[];
  preparedAt: number;
}
const leaseScope = (generation: string, scope: string) =>
  `comparison:${generation}:${scope}`;
async function digest(page: Omit<PreparedComparisonBuild, "digest">) {
  return sha256(canonical(["comparison-build-v1", page]));
}

/** Resume from a bounded keyset frontier; every page is one native transaction. */
export class InventoryComparisonBuilds {
  constructor(readonly store: Store) {}

  async prepare(
    tenant: string,
    generation: string,
    scope: string,
    lease: Lease,
    limit = 200,
  ): Promise<PreparedComparisonBuild | null> {
    lease = structuredClone(lease);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      lease.tenant !== tenant ||
      lease.scope !== leaseScope(generation, scope)
    )
      throw new Error("invalid_inventory_comparison_build");
    const writers = await new InventoryComparisonGenerations(
      this.store,
    ).writers(tenant);
    const context = writers?.contexts.find(
      (key) => key.generation === generation,
    );
    if (!writers || !context)
      throw new Error("inventory_comparison_generation_unavailable");
    const snapshot = await this.store
      .statement(
        `SELECT b.*,s.accepted_sequence,s.provider FROM comparison_builds b JOIN inventory_scopes s ON s.tenant=b.tenant AND s.scope_id=b.scope_id
       WHERE b.tenant=? AND b.generation_id=? AND b.scope_id=? AND b.config_version=s.config_version`,
        tenant,
        generation,
        scope,
      )
      .first<BuildSnapshot>();
    if (!snapshot) throw new Error("inventory_comparison_build_missing");
    if (snapshot.complete) return null;
    const selected = await this.store
      .statement(
        `SELECT e.record_key,e.subtype,e.status,e.parent_key,f.facet,f.semantic_version,f.payload_id,p.connection_id,p.kind,${INVENTORY_BODY_CIPHER_BYTES} AS payload_bytes,
       i.key_class,i.bucket_hash,CASE WHEN i.semantic_version=f.semantic_version AND i.config_version=? AND i.state!='retired' THEN 1 ELSE 0 END AS reusable
       FROM inventory_records e JOIN inventory_record_facets f ON f.tenant=e.tenant AND f.scope_id=e.scope_id AND f.entity_family=e.entity_family AND f.record_key=e.record_key AND f.facet=?
       JOIN inventory_payloads p ON p.tenant=f.tenant AND p.scope_id=f.scope_id AND p.payload_id=f.payload_id
       LEFT JOIN comparison_index i ON i.tenant=e.tenant AND i.generation_id=? AND i.scope_id=e.scope_id AND i.record_key=e.record_key AND i.facet=f.facet
       WHERE e.tenant=? AND e.scope_id=? AND e.entity_family='qso' AND e.record_key>? ORDER BY e.record_key LIMIT ?`,
        snapshot.config_version,
        snapshot.provider === "lofi" ? "source" : "receipt",
        generation,
        tenant,
        scope,
        snapshot.cursor_key,
        limit + 1,
      )
      .all<BuildRecord>();
    const records: BuildRecord[] = [];
    let bytes = 0;
    for (const row of selected.results.slice(0, limit)) {
      const size =
        row.subtype === "qso" && row.status === "active" && !row.reusable
          ? row.payload_bytes
          : 0;
      if (bytes + size > 2 * 1024 * 1024) break;
      bytes += size;
      records.push(row);
    }
    if (selected.results.length && !records.length)
      throw new Error("inventory_comparison_build_payload_too_large");
    const payloads = new Map<string, string>();
    const needed = records
      .filter(
        (row) =>
          row.subtype === "qso" && row.status === "active" && !row.reusable,
      )
      .map((row) => row.payload_id);
    for (const chunk of inventoryJsonChunks(needed)) {
      const rows = await this.store
        .statement(
          `SELECT p.payload_id,p.envelope FROM json_each(?) j CROSS JOIN inventory_payloads p WHERE p.tenant=? AND p.scope_id=? AND p.payload_id=j.value`,
          chunk,
          tenant,
          scope,
        )
        .all<{ payload_id: string; envelope: string }>();
      for (const row of rows.results)
        payloads.set(row.payload_id, row.envelope);
    }
    const rows: BuildRow[] = [];
    for (const row of records) {
      let token: InventoryComparisonToken | null = null;
      if (row.subtype === "qso" && row.status === "active") {
        if (row.reusable && row.key_class && row.bucket_hash)
          token = { keyClass: row.key_class, hash: row.bucket_hash };
        else {
          const envelope = payloads.get(row.payload_id);
          if (!envelope)
            throw new Error("inventory_comparison_build_payload_missing");
          const body = await openInventoryBody<unknown>(
            this.store,
            {
              tenant,
              scope,
              connection: row.connection_id,
              id: row.payload_id,
              kind: row.kind,
            },
            envelope,
            row.payload_bytes,
          );
          token = await inventoryComparisonToken(
            context,
            inventoryComparisonHint(snapshot.provider, body),
          );
        }
      }
      rows.push({
        key: row.record_key,
        subtype: row.subtype,
        status: row.status,
        parent: row.parent_key,
        facet: row.facet,
        semanticVersion: row.semantic_version,
        payload: row.payload_id,
        keyClass: token?.keyClass ?? null,
        hash: token?.hash ?? null,
      });
    }
    inventoryJsonChunks(rows);
    const page = {
      tenant,
      generation,
      scope,
      pageId: crypto.randomUUID(),
      version: snapshot.version,
      configVersion: snapshot.config_version,
      sequence: snapshot.accepted_sequence,
      domainVersion: writers.domain.version,
      lease,
      previousCursor: snapshot.cursor_key,
      nextCursor: records.at(-1)?.record_key ?? snapshot.cursor_key,
      complete: records.length === selected.results.length,
      rows,
      preparedAt: Date.now(),
    };
    return { ...page, digest: await digest(page) };
  }

  private async recover(page: PreparedComparisonBuild) {
    const receipt = await this.store
      .statement(
        "SELECT digest,state,complete,row_count,changed_count FROM comparison_build_pages WHERE tenant=? AND page_id=?",
        page.tenant,
        page.pageId,
      )
      .first<{
        digest: string;
        state: string;
        complete: number;
        row_count: number;
        changed_count: number;
      }>();
    if (!receipt) return null;
    if (receipt.digest !== page.digest || receipt.state !== "committed")
      throw new Error("inventory_comparison_build_receipt_conflict");
    return {
      complete: receipt.complete === 1,
      records: receipt.row_count,
      changed: receipt.changed_count,
      recovered: true,
      statements: 0,
      rowsRead: 0,
      rowsWritten: 0,
    };
  }

  async publish(page: PreparedComparisonBuild) {
    page = structuredClone(page);
    const { digest: expected, ...input } = page;
    if (expected !== (await digest(input)))
      throw new Error("inventory_comparison_build_changed");
    const existing = await this.recover(page);
    if (existing) return existing;
    const bound = (sql: string) =>
      this.store.statement(sql, page.tenant, page.pageId);
    const plan: D1PreparedStatement[] = [
      this.store.statement(
        `INSERT INTO comparison_build_pages(tenant,page_id,generation_id,scope_id,expected_version,expected_config_version,expected_sequence,domain_version,lease_token,lease_fence,previous_cursor,next_cursor,complete,row_count,digest,prepared_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        page.tenant,
        page.pageId,
        page.generation,
        page.scope,
        page.version,
        page.configVersion,
        page.sequence,
        page.domainVersion,
        page.lease.token,
        page.lease.fence,
        page.previousCursor,
        page.nextCursor,
        Number(page.complete),
        page.rows.length,
        page.digest,
        page.preparedAt,
      ),
    ];
    for (const chunk of inventoryJsonChunks(page.rows))
      plan.push(
        this.store.statement(
          `INSERT INTO comparison_build_rows(tenant,page_id,record_key,facet,subtype,status,parent_key,semantic_version,payload_id,key_class,bucket_hash,changed)
       SELECT p.tenant,p.page_id,json_extract(j.value,'$.key'),json_extract(j.value,'$.facet'),json_extract(j.value,'$.subtype'),json_extract(j.value,'$.status'),json_extract(j.value,'$.parent'),json_extract(j.value,'$.semanticVersion'),json_extract(j.value,'$.payload'),json_extract(j.value,'$.keyClass'),json_extract(j.value,'$.hash'),
       i.record_key IS NULL OR i.semantic_version!=json_extract(j.value,'$.semanticVersion') OR i.config_version!=p.expected_config_version OR i.key_class IS NOT json_extract(j.value,'$.keyClass') OR i.bucket_hash IS NOT json_extract(j.value,'$.hash') OR ((i.state='retired')!=(json_extract(j.value,'$.keyClass') IS NULL))
       FROM json_each(?) j CROSS JOIN comparison_build_pages p LEFT JOIN comparison_index i ON i.tenant=p.tenant AND i.generation_id=p.generation_id AND i.scope_id=p.scope_id AND i.record_key=json_extract(j.value,'$.key') AND i.facet=json_extract(j.value,'$.facet') WHERE p.tenant=? AND p.page_id=?`,
          chunk,
          page.tenant,
          page.pageId,
        ),
      );
    plan.push(
      bound(`INSERT INTO comparison_build_buckets(tenant,page_id,key_class,bucket_hash,expected_version)
       SELECT x.tenant,x.page_id,x.key_class,x.bucket_hash,coalesce(b.version,0) FROM (
        SELECT tenant,page_id,key_class,bucket_hash FROM comparison_build_rows WHERE tenant=?1 AND page_id=?2 AND changed=1 AND key_class IS NOT NULL
        UNION
        SELECT r.tenant,r.page_id,i.key_class,i.bucket_hash FROM comparison_build_rows r JOIN comparison_build_pages p ON p.tenant=r.tenant AND p.page_id=r.page_id JOIN comparison_index i ON i.tenant=p.tenant AND i.generation_id=p.generation_id AND i.scope_id=p.scope_id AND i.record_key=r.record_key AND i.facet=r.facet WHERE r.tenant=?1 AND r.page_id=?2 AND r.changed=1 AND i.key_class IS NOT NULL
       ) x JOIN comparison_build_pages p ON p.tenant=x.tenant AND p.page_id=x.page_id LEFT JOIN bucket_versions b ON b.tenant=p.tenant AND b.generation_id=p.generation_id AND b.scope_id=p.scope_id AND b.key_class=x.key_class AND b.bucket_hash=x.bucket_hash`),
      bound("INSERT INTO comparison_build_guards(tenant,page_id) VALUES(?,?)"),
      bound(
        `INSERT INTO bucket_versions(tenant,generation_id,scope_id,key_class,bucket_hash,version) SELECT x.tenant,p.generation_id,p.scope_id,x.key_class,x.bucket_hash,1 FROM comparison_build_buckets x JOIN comparison_build_pages p ON p.tenant=x.tenant AND p.page_id=x.page_id WHERE x.tenant=? AND x.page_id=? ON CONFLICT(tenant,generation_id,scope_id,key_class,bucket_hash) DO UPDATE SET version=bucket_versions.version+1`,
      ),
      bound(`INSERT INTO comparison_index(tenant,generation_id,scope_id,record_key,facet,key_class,bucket_hash,semantic_version,config_version,state,parent_key,last_page_id)
       SELECT r.tenant,p.generation_id,p.scope_id,r.record_key,r.facet,r.key_class,r.bucket_hash,r.semantic_version,p.expected_config_version,CASE WHEN r.key_class IS NULL THEN 'retired' ELSE 'pending' END,r.parent_key,p.page_id FROM comparison_build_rows r JOIN comparison_build_pages p ON p.tenant=r.tenant AND p.page_id=r.page_id WHERE r.tenant=? AND r.page_id=? AND r.changed=1
       ON CONFLICT(tenant,generation_id,scope_id,record_key,facet) DO UPDATE SET key_class=excluded.key_class,bucket_hash=excluded.bucket_hash,semantic_version=excluded.semantic_version,config_version=excluded.config_version,state=excluded.state,parent_key=excluded.parent_key,topology_version=0,last_page_id=excluded.last_page_id`),
      bound(`INSERT INTO comparison_work(tenant,generation_id,scope_id,record_key,facet,work_version,completed_version,due_at)
       SELECT r.tenant,p.generation_id,p.scope_id,r.record_key,r.facet,1,CASE WHEN r.key_class IS NULL THEN 1 ELSE 0 END,p.prepared_at FROM comparison_build_rows r JOIN comparison_build_pages p ON p.tenant=r.tenant AND p.page_id=r.page_id WHERE r.tenant=? AND r.page_id=? AND r.changed=1
       ON CONFLICT(tenant,generation_id,scope_id,record_key,facet) DO UPDATE SET work_version=comparison_work.work_version+1,completed_version=CASE WHEN excluded.completed_version=1 THEN comparison_work.work_version+1 ELSE comparison_work.completed_version END,due_at=min(comparison_work.due_at,excluded.due_at)`),
      bound(
        `UPDATE comparison_builds SET version=version+1,cursor_key=(SELECT next_cursor FROM comparison_build_pages WHERE tenant=?1 AND page_id=?2),complete=(SELECT complete FROM comparison_build_pages WHERE tenant=?1 AND page_id=?2) WHERE tenant=?1 AND (generation_id,scope_id)=(SELECT generation_id,scope_id FROM comparison_build_pages WHERE tenant=?1 AND page_id=?2)`,
      ),
      bound(
        `UPDATE comparison_build_pages SET changed_count=(SELECT coalesce(sum(changed),0) FROM comparison_build_rows WHERE tenant=?1 AND page_id=?2),state='committed' WHERE tenant=?1 AND page_id=?2`,
      ),
      ...[
        "comparison_build_buckets",
        "comparison_build_rows",
        "comparison_build_guards",
      ].map((table) =>
        bound(`DELETE FROM ${table} WHERE tenant=? AND page_id=?`),
      ),
    );
    let result: D1Result[];
    try {
      result = await this.store.db.batch(plan);
    } catch (error) {
      const committed = await this.recover(page).catch(() => null);
      if (committed) return committed;
      throw error;
    }
    const receipt = await this.recover(page);
    if (!receipt) throw new Error("inventory_comparison_build_receipt_missing");
    return {
      ...receipt,
      recovered: false,
      statements: plan.length,
      rowsRead: result.reduce((n, r) => n + r.meta.rows_read, 0),
      rowsWritten: result.reduce((n, r) => n + r.meta.rows_written, 0),
    };
  }

  async step(tenant: string, generation: string, scope: string, limit = 200) {
    const lease = await this.store.claim(
      tenant,
      leaseScope(generation, scope),
      Date.now(),
      60_000,
    );
    if (!lease) return { deferred: true as const };
    try {
      const page = await this.prepare(tenant, generation, scope, lease, limit);
      return page
        ? await this.publish(page)
        : { complete: true as const, alreadyComplete: true as const };
    } finally {
      await this.store.release(lease);
    }
  }

  async activate(tenant: string, generation: string) {
    await this.store
      .statement(
        "UPDATE index_generations SET state='active' WHERE tenant=? AND generation_id=? AND state='building'",
        tenant,
        generation,
      )
      .run();
    const domain = await new InventoryComparisonGenerations(this.store).domain(
      tenant,
    );
    if (domain?.active_generation !== generation)
      throw new Error("inventory_comparison_generation_changed");
    return domain;
  }
}
