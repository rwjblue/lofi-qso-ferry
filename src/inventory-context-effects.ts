import {
  type InventoryPageInput,
  inventoryJsonChunks,
} from "./inventory-ingestion.ts";
import type { Store } from "./store.ts";

export interface InventoryContextRow {
  semanticChanged: number;
  domains: string[];
}

/** Coalesce source semantic edits and membership uncertainty before mutation. */
export class InventoryContextEffects {
  readonly domains: string[];
  readonly membership: boolean;
  constructor(
    readonly store: Store,
    readonly input: InventoryPageInput,
    rows: readonly InventoryContextRow[],
  ) {
    this.domains = [
      ...new Set(
        rows.filter((row) => row.semanticChanged).flatMap((row) => row.domains),
      ),
    ];
    this.membership =
      input.facet === "source" &&
      ((input.run?.action === "page" && input.observations.length > 0) ||
        (input.run?.action === "quarantine" && input.run.rows.length > 0));
  }
  get needed() {
    return (
      this.input.stream.provider === "lofi" &&
      (this.domains.length > 0 || this.membership)
    );
  }
  private bound(sql: string) {
    return this.store.statement(
      sql,
      this.input.stream.tenant,
      this.input.pageId,
    );
  }
  prelude() {
    if (!this.needed) return [];
    const statements = [
      this.bound(
        "INSERT INTO ingestion_context_pages(tenant,page_id) VALUES(?,?)",
      ),
    ];
    for (const chunk of inventoryJsonChunks(this.domains))
      statements.push(
        this.store.statement(
          `INSERT INTO ingestion_page_domains(tenant,page_id,operation_key,expected_version) SELECT ?,?,j.value,coalesce(d.topology_version,0) FROM json_each(?) j LEFT JOIN projection_domains d ON d.tenant=? AND d.scope_id=? AND d.operation_key=j.value`,
          this.input.stream.tenant,
          this.input.pageId,
          chunk,
          this.input.stream.tenant,
          this.input.stream.scope,
        ),
      );
    if (this.membership)
      statements.push(
        this.bound(`INSERT INTO ingestion_membership_effects(tenant,page_id,entity_family,record_key,facet,subtype,parent_key,before_state,after_state,expected_version)
       SELECT m.tenant,m.page_id,m.entity_family,m.record_key,m.facet,m.subtype,m.parent_key,m.before_state,m.after_state,coalesce(v.version,0)
       FROM ingestion_source_membership_changes m JOIN ingestion_pages p ON p.tenant=m.tenant AND p.page_id=m.page_id LEFT JOIN inventory_membership_versions v ON v.tenant=p.tenant AND v.scope_id=p.scope_id AND v.entity_family=m.entity_family AND v.record_key=m.record_key AND v.facet=m.facet WHERE m.tenant=? AND m.page_id=?`),
        this.bound(`INSERT INTO ingestion_page_domains(tenant,page_id,operation_key,expected_version)
       SELECT m.tenant,m.page_id,CASE WHEN m.entity_family='operation' THEN m.record_key ELSE m.parent_key END,coalesce(d.topology_version,0)
       FROM ingestion_membership_effects m JOIN ingestion_pages p ON p.tenant=m.tenant AND p.page_id=m.page_id
       LEFT JOIN projection_domains d ON d.tenant=p.tenant AND d.scope_id=p.scope_id AND d.operation_key=CASE WHEN m.entity_family='operation' THEN m.record_key ELSE m.parent_key END
       WHERE m.tenant=? AND m.page_id=? AND (m.entity_family='operation' OR m.subtype='event' AND m.parent_key IS NOT NULL)
       GROUP BY m.tenant,m.page_id,CASE WHEN m.entity_family='operation' THEN m.record_key ELSE m.parent_key END ON CONFLICT DO NOTHING`),
      );
    return statements;
  }
  domainEffects() {
    return this.needed
      ? [
          this.bound(
            `INSERT INTO projection_domains(tenant,scope_id,operation_key,topology_version,ready_version) SELECT q.tenant,p.scope_id,q.operation_key,1,0 FROM ingestion_page_domains q JOIN ingestion_pages p ON p.tenant=q.tenant AND p.page_id=q.page_id WHERE q.tenant=? AND q.page_id=? ON CONFLICT(tenant,scope_id,operation_key) DO UPDATE SET topology_version=projection_domains.topology_version+1`,
          ),
        ]
      : [];
  }
  membershipEffects() {
    if (!this.needed || !this.membership) return [];
    return [
      this.bound(
        `INSERT INTO inventory_membership_versions(tenant,scope_id,entity_family,record_key,facet,version) SELECT q.tenant,p.scope_id,q.entity_family,q.record_key,q.facet,1 FROM ingestion_membership_effects q JOIN ingestion_pages p ON p.tenant=q.tenant AND p.page_id=q.page_id WHERE q.tenant=? AND q.page_id=? ON CONFLICT(tenant,scope_id,entity_family,record_key,facet) DO UPDATE SET version=inventory_membership_versions.version+1`,
      ),
      this.bound(
        `UPDATE comparison_index AS i SET state='pending' WHERE i.tenant=?1 AND i.state!='retired' AND i.generation_id IN (SELECT active_generation FROM comparison_domains WHERE tenant=?1 UNION SELECT pending_generation FROM comparison_domains WHERE tenant=?1) AND (i.scope_id,i.record_key,i.facet) IN (SELECT p.scope_id,q.record_key,q.facet FROM ingestion_membership_effects q JOIN ingestion_pages p ON p.tenant=q.tenant AND p.page_id=q.page_id WHERE q.tenant=?1 AND q.page_id=?2 AND q.entity_family='qso' AND q.subtype='qso')`,
      ),
      this.bound(`INSERT INTO comparison_work(tenant,generation_id,scope_id,record_key,facet,work_version,completed_version,due_at)
       SELECT i.tenant,i.generation_id,i.scope_id,i.record_key,i.facet,1,0,p.request_started_at
       FROM ingestion_membership_effects q JOIN ingestion_pages p ON p.tenant=q.tenant AND p.page_id=q.page_id JOIN comparison_domains d ON d.tenant=q.tenant
       JOIN comparison_index i ON i.tenant=q.tenant AND i.generation_id IN (d.active_generation,d.pending_generation) AND i.scope_id=p.scope_id AND i.record_key=q.record_key AND i.facet=q.facet AND i.state!='retired'
       WHERE q.tenant=? AND q.page_id=? AND q.entity_family='qso' AND q.subtype='qso' AND NOT EXISTS(SELECT 1 FROM ingestion_page_rows r WHERE r.tenant=q.tenant AND r.page_id=q.page_id AND r.entity_family=q.entity_family AND r.record_key=q.record_key AND r.facet=q.facet AND r.semantic_changed=1)
       ON CONFLICT(tenant,generation_id,scope_id,record_key,facet) DO UPDATE SET work_version=comparison_work.work_version+1,due_at=min(comparison_work.due_at,excluded.due_at)`),
    ];
  }
  cleanup() {
    return this.needed
      ? [
          "ingestion_page_domains",
          "ingestion_membership_effects",
          "ingestion_context_pages",
        ].map((table) =>
          this.bound(`DELETE FROM ${table} WHERE tenant=? AND page_id=?`),
        )
      : [];
  }
}
