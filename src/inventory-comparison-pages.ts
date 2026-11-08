import type { AdifRecord } from "./adif.ts";
import { InventoryComparisonGenerations } from "./inventory-comparison-generations.ts";
import {
  type InventoryComparisonToken,
  inventoryComparisonToken,
} from "./inventory-comparison-keys.ts";
import {
  type InventoryPageInput,
  inventoryJsonChunks,
} from "./inventory-ingestion.ts";
import type { Store } from "./store.ts";

interface ComparisonInput {
  family: string;
  key: string;
  subtype: string;
  status: string;
  semanticChanged: number;
  body: unknown;
}
interface ComparisonRow {
  generation: string;
  key: string;
  facet: string;
  keyClass: InventoryComparisonToken["keyClass"] | null;
  hash: string | null;
}
export interface PreparedComparisonPage {
  domainVersion: number;
  rows: ComparisonRow[];
}
function map(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** CALL/time never inherit operation context in projectContact. Invalid fields
 * stay partial hints, including contacts awaiting their operation/event census. */
export function inventoryComparisonHint(
  provider: string,
  body: unknown,
): AdifRecord {
  const raw = map(body);
  if (provider !== "lofi")
    return Object.fromEntries(
      Object.entries(raw).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  const their = map(raw.their);
  const hint: AdifRecord = {};
  if (typeof their.call === "string")
    hint.CALL = their.call.trim().toUpperCase();
  const value = raw.startAtMillis;
  const at =
    (typeof value === "number" ||
      (typeof value === "string" && value.trim())) &&
    Number(value);
  if (
    typeof at === "number" &&
    Number.isSafeInteger(at) &&
    at > 0 &&
    Number.isFinite(new Date(at).getTime())
  ) {
    const iso = new Date(Math.floor(at / 1000) * 1000).toISOString();
    hint.QSO_DATE = iso.slice(0, 10).replaceAll("-", "");
    hint.TIME_ON = iso.slice(11, 19).replaceAll(":", "");
  }
  return hint;
}

/** Bulk page hook: only semantic changes compute hints or invalidate buckets. */
export class InventoryComparisonPages {
  constructor(readonly store: Store) {}

  async prepare(
    input: InventoryPageInput,
    incoming: ComparisonInput[],
  ): Promise<PreparedComparisonPage | null> {
    const changed = incoming.filter(
      (row) => row.family === "qso" && row.semanticChanged,
    );
    if (!changed.length) return null;
    const writers = await new InventoryComparisonGenerations(
      this.store,
    ).writers(input.stream.tenant);
    if (!writers) return null;
    const rows = await Promise.all(
      writers.contexts.flatMap((context) =>
        changed.map(async (row): Promise<ComparisonRow> => {
          const token =
            row.subtype === "qso" && row.status === "active"
              ? await inventoryComparisonToken(
                  context,
                  inventoryComparisonHint(input.stream.provider, row.body),
                )
              : null;
          return {
            generation: context.generation,
            key: row.key,
            facet: input.facet,
            keyClass: token?.keyClass ?? null,
            hash: token?.hash ?? null,
          };
        }),
      ),
    );
    inventoryJsonChunks(rows);
    return { domainVersion: writers.domain.version, rows };
  }

  prelude(input: InventoryPageInput, page: PreparedComparisonPage | null) {
    if (!page) return [];
    const { tenant } = input.stream;
    return [
      this.store.statement(
        "INSERT INTO comparison_page_state(tenant,page_id,domain_version) VALUES(?,?,?)",
        tenant,
        input.pageId,
        page.domainVersion,
      ),
      ...inventoryJsonChunks(page.rows).map((chunk) =>
        this.store.statement(
          `INSERT INTO comparison_page_rows(tenant,page_id,generation_id,record_key,facet,key_class,bucket_hash)
           SELECT ?,?,json_extract(value,'$.generation'),json_extract(value,'$.key'),json_extract(value,'$.facet'),json_extract(value,'$.keyClass'),json_extract(value,'$.hash') FROM json_each(?)`,
          tenant,
          input.pageId,
          chunk,
        ),
      ),
      this.bucketSnapshot(input),
    ];
  }

  private bucketSnapshot(input: InventoryPageInput) {
    // The native guard verifies this complete old/new set before raw mutation.
    return this.store.statement(
      `INSERT INTO comparison_page_buckets(tenant,page_id,generation_id,scope_id,key_class,bucket_hash,expected_version)
        SELECT x.tenant,x.page_id,x.generation_id,x.scope_id,x.key_class,x.bucket_hash,coalesce(b.version,0) FROM (
         SELECT r.tenant,r.page_id,r.generation_id,p.scope_id,r.key_class,r.bucket_hash FROM comparison_page_rows r JOIN ingestion_pages p ON p.tenant=r.tenant AND p.page_id=r.page_id WHERE r.tenant=?1 AND r.page_id=?2 AND r.key_class IS NOT NULL
         UNION
         SELECT r.tenant,r.page_id,i.generation_id,i.scope_id,i.key_class,i.bucket_hash FROM comparison_page_rows r JOIN ingestion_pages p ON p.tenant=r.tenant AND p.page_id=r.page_id JOIN comparison_index i ON i.tenant=r.tenant AND i.generation_id=r.generation_id AND i.scope_id=p.scope_id AND i.record_key=r.record_key AND i.facet=r.facet WHERE r.tenant=?1 AND r.page_id=?2 AND i.key_class IS NOT NULL
        ) x LEFT JOIN bucket_versions b ON b.tenant=x.tenant AND b.generation_id=x.generation_id AND b.scope_id=x.scope_id AND b.key_class=x.key_class AND b.bucket_hash=x.bucket_hash`,
      input.stream.tenant,
      input.pageId,
    );
  }

  effects(input: InventoryPageInput, page: PreparedComparisonPage | null) {
    if (!page) return [];
    const bound = (sql: string) =>
      this.store.statement(sql, input.stream.tenant, input.pageId);
    return [
      bound(`INSERT INTO bucket_versions(tenant,generation_id,scope_id,key_class,bucket_hash,version)
        SELECT tenant,generation_id,scope_id,key_class,bucket_hash,1 FROM comparison_page_buckets WHERE tenant=? AND page_id=?
        ON CONFLICT(tenant,generation_id,scope_id,key_class,bucket_hash) DO UPDATE SET version=bucket_versions.version+1`),
      bound(`INSERT INTO comparison_index(tenant,generation_id,scope_id,record_key,facet,key_class,bucket_hash,semantic_version,config_version,state,parent_key,last_page_id)
        SELECT x.tenant,x.generation_id,p.scope_id,x.record_key,x.facet,x.key_class,x.bucket_hash,f.semantic_version,p.expected_config_version,CASE WHEN x.key_class IS NULL THEN 'retired' ELSE 'pending' END,r.parent_key,p.page_id
        FROM comparison_page_rows x JOIN ingestion_pages p ON p.tenant=x.tenant AND p.page_id=x.page_id
        JOIN ingestion_page_rows r ON r.tenant=x.tenant AND r.page_id=x.page_id AND r.entity_family='qso' AND r.record_key=x.record_key AND r.facet=x.facet
        JOIN inventory_record_facets f ON f.tenant=x.tenant AND f.scope_id=p.scope_id AND f.entity_family='qso' AND f.record_key=x.record_key AND f.facet=x.facet
        WHERE x.tenant=? AND x.page_id=?
        ON CONFLICT(tenant,generation_id,scope_id,record_key,facet) DO UPDATE SET key_class=excluded.key_class,bucket_hash=excluded.bucket_hash,semantic_version=excluded.semantic_version,config_version=excluded.config_version,state=excluded.state,parent_key=excluded.parent_key,topology_version=0,last_page_id=excluded.last_page_id`),
      bound(`INSERT INTO comparison_work(tenant,generation_id,scope_id,record_key,facet,work_version,completed_version,due_at)
        SELECT i.tenant,i.generation_id,i.scope_id,i.record_key,i.facet,1,CASE WHEN i.state='retired' THEN 1 ELSE 0 END,p.request_started_at
        FROM comparison_page_rows x JOIN ingestion_pages p ON p.tenant=x.tenant AND p.page_id=x.page_id
        JOIN comparison_index i ON i.tenant=x.tenant AND i.generation_id=x.generation_id AND i.scope_id=p.scope_id AND i.record_key=x.record_key AND i.facet=x.facet WHERE x.tenant=? AND x.page_id=?
        ON CONFLICT(tenant,generation_id,scope_id,record_key,facet) DO UPDATE SET work_version=comparison_work.work_version+1,completed_version=CASE WHEN excluded.completed_version=1 THEN comparison_work.work_version+1 ELSE comparison_work.completed_version END,due_at=min(comparison_work.due_at,excluded.due_at)`),
    ];
  }

  cleanup(input: InventoryPageInput, page: PreparedComparisonPage | null) {
    if (!page) return [];
    return [
      "comparison_page_buckets",
      "comparison_page_rows",
      "comparison_page_state",
    ].map((table) =>
      this.store.statement(
        `DELETE FROM ${table} WHERE tenant=? AND page_id=?`,
        input.stream.tenant,
        input.pageId,
      ),
    );
  }
}
