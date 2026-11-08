import { inventoryJsonChunks } from "./inventory-ingestion.ts";
import {
  InventoryMatchingWorkspace,
  type PreparedInventoryMatchingSnapshot,
} from "./inventory-matching-workspace.ts";
import { canonical, sha256 } from "./security.ts";
import type { Lease, Store } from "./store.ts";

interface MatchReceipt {
  input_digest: string;
  row_count: number;
  state: string;
}
interface MatchVersion {
  ordinal: number;
  version: number;
}
export interface InventoryMatchResult {
  source_scope: string;
  record_key: string;
  state: string;
  reason: string | null;
  remote_key: string | null;
  version: number;
  set_id: string;
  derived_at: number;
}
export interface InventoryMatchingWorkClaim {
  scope: string;
  key: string;
  workVersion: number;
  completedVersion: number;
  sourceConfigVersion: number;
  destinationConfigVersion: number;
  dueAt: number;
}
const refKey = (row: { scope: string; key: string; facet: string }) =>
  canonical([row.scope, row.key, row.facet]);
const scope = (destination: string) => `matching:${destination}`;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;

/** Persists comparison observations only. No ownership, association, source
 * proof, delivery attempt or vendor write is created by matching publication. */
export class InventoryMatchingResults {
  constructor(readonly store: Store) {}
  private async recover(
    page: PreparedInventoryMatchingSnapshot,
    id: string,
    digest = page.digest,
  ) {
    const receipt = await this.store
      .statement(
        "SELECT input_digest,row_count,state FROM inventory_match_sets WHERE tenant=? AND set_id=?",
        page.tenant,
        id,
      )
      .first<MatchReceipt>();
    if (!receipt) return null;
    if (receipt.input_digest !== digest || receipt.state !== "committed")
      throw new Error("inventory_match_receipt_conflict");
    return {
      setId: id,
      recovered: true,
      records: receipt.row_count,
      statements: 0,
      rowsRead: 0,
      rowsWritten: 0,
    };
  }
  async publish(
    page: PreparedInventoryMatchingSnapshot,
    lease: Lease,
    id: string = crypto.randomUUID(),
    work?: readonly InventoryMatchingWorkClaim[],
  ) {
    page = structuredClone(page);
    lease = structuredClone(lease);
    work = structuredClone(work);
    const { digest, ...manifest } = page;
    if (digest !== (await sha256(canonical(manifest))))
      throw new Error("inventory_matching_preparation_changed");
    if (
      typeof id !== "string" ||
      !id.length ||
      id.length > 512 ||
      lease.tenant !== page.tenant ||
      lease.scope !== scope(page.destination)
    )
      throw new Error("invalid_inventory_matching_lease");
    if (
      work &&
      (work.length !== page.selected.length ||
        !work.length ||
        new Set(work.map((row) => canonical([row.scope, row.key]))).size !==
          work.length ||
        work.some(
          (row) =>
            !page.selected.some(
              (selected) =>
                selected.scope === row.scope && selected.key === row.key,
            ) ||
            ![
              row.workVersion,
              row.completedVersion,
              row.sourceConfigVersion,
              row.destinationConfigVersion,
              row.dueAt,
            ].every(Number.isSafeInteger) ||
            row.workVersion <= row.completedVersion ||
            row.completedVersion < 0 ||
            row.sourceConfigVersion < 1 ||
            row.destinationConfigVersion < 1 ||
            row.dueAt < 0,
        ))
    )
      throw new Error("invalid_inventory_matching_work_claim");
    const inputDigest = work
      ? await sha256(canonical({ matchingDigest: page.digest, work }))
      : page.digest;
    const receipt = await this.recover(page, id, inputDigest);
    if (receipt) return receipt;
    if (
      page.formatVersion !== 1 ||
      page.results.length < 1 ||
      page.results.length > 20 ||
      page.results.length !== page.selected.length ||
      page.records.length > 128 ||
      page.scopes.length > 21 ||
      page.coverage.length > 256 ||
      page.lookups.length > 148 ||
      page.graph.policyVersion !== 2 ||
      (page.coverageRecovery === 1 &&
        (!page.recovery || page.recovery.length > 40)) ||
      new Set(page.results.map((row) => refKey(row.source))).size !==
        page.results.length ||
      page.results.some(
        (row) =>
          row.source.facet !== "source" ||
          !page.selected.some(
            (selected) => refKey(selected) === refKey(row.source),
          ) ||
          (row.remote &&
            (row.remote.facet !== "receipt" ||
              row.remote.scope !== page.destination)),
      )
    )
      throw new Error("invalid_inventory_matching_manifest");
    const versions = await this.store
      .statement(
        `SELECT CAST(j.key AS INTEGER) AS ordinal,coalesce(r.version,0) AS version FROM json_each(?1) j LEFT JOIN match_results r ON r.tenant=?2 AND r.destination=?3 AND r.source_scope=json_extract(j.value,'$.scope') AND r.record_key=json_extract(j.value,'$.key')`,
        canonical(page.selected),
        page.tenant,
        page.destination,
      )
      .all<MatchVersion>();
    const versionByKey = new Map(
      versions.results.map((row) => [
        refKey(page.selected[row.ordinal]),
        row.version,
      ]),
    );
    const rows = page.results.map((row) => ({
      ...row,
      expectedVersion: versionByKey.get(refKey(row.source)),
    }));
    const probes = page.lookups.map((row, ordinal) => {
      const declared = (
        row.direction === "forward" ? page.forward : page.reverse
      ).find((probe) => refKey(probe.subject) === refKey(row.subject));
      return { ...row, ordinal, complete: declared?.complete === true };
    });
    const tokens = probes.flatMap((row) =>
      row.probe.buckets.map((token) => ({ ...token, probe: row.ordinal })),
    );
    const candidates = probes.flatMap((row) =>
      row.probe.candidates.map((candidate) => ({
        probe: row.ordinal,
        scope: row.probe.scope,
        key: candidate.key,
        facet: candidate.facet,
      })),
    );
    const recovery = page.recovery ?? [];
    const plan = [
      this.store.statement(
        `INSERT INTO inventory_match_sets(tenant,set_id,destination,generation_id,domain_version,source_set_version,policy_version,result_version,input_digest,lease_token,lease_fence,prepared_at,scope_count,coverage_count,record_count,probe_count,token_count,candidate_count,row_count${page.coverageRecovery === 1 ? ",recovery_count" : ""}) VALUES(?,?,?,?,?,?,2,1,?,?,?,?,?,?,?,?,?,?,?${page.coverageRecovery === 1 ? ",?" : ""})`,
        page.tenant,
        id,
        page.destination,
        page.generation,
        page.domainVersion,
        page.sourceSetVersion,
        inputDigest,
        lease.token,
        lease.fence,
        page.preparedAt,
        page.scopes.length,
        page.coverage.length,
        page.records.length,
        probes.length,
        tokens.length,
        candidates.length,
        rows.length,
        ...(page.coverageRecovery === 1 ? [recovery.length] : []),
      ),
    ];
    const stage = (
      table: string,
      columns: string,
      select: string,
      values: readonly unknown[],
    ) => {
      for (const chunk of inventoryJsonChunks(values))
        plan.push(
          this.store.statement(
            `INSERT INTO ${table}(tenant,set_id,${columns}) SELECT ?,?,${select} FROM json_each(?)`,
            page.tenant,
            id,
            chunk,
          ),
        );
    };
    stage(
      "inventory_match_scopes",
      "connection_id,scope_id,kind,connection_state,logical_identity,provider,scope_identity,config_version,scope_state,build_config_version,build_complete,unresolved,source" +
        (page.coverageClocks === 1 ? ",coverage_clock" : ""),
      `json_extract(value,'$.connection'),coalesce(json_extract(value,'$.scope'),''),json_extract(value,'$.kind'),json_extract(value,'$.connectionState'),json_extract(value,'$.logicalIdentity'),json_extract(value,'$.provider'),json_extract(value,'$.scopeIdentity'),json_extract(value,'$.configVersion'),json_extract(value,'$.state'),json_extract(value,'$.buildConfigVersion'),json_extract(value,'$.buildComplete'),json_extract(value,'$.unresolved'),json_extract(value,'$.source')` +
        (page.coverageClocks === 1
          ? ",json_extract(value,'$.coverageClock')"
          : ""),
      page.scopes,
    );
    stage(
      "inventory_match_coverage",
      "scope_id,stream_id,facet,partition_id,version,epoch,state,kind,config_version,run_id",
      `json_extract(value,'$.scope'),json_extract(value,'$.stream'),json_extract(value,'$.facet'),json_extract(value,'$.partition'),json_extract(value,'$.version'),json_extract(value,'$.epoch'),json_extract(value,'$.state'),json_extract(value,'$.kind'),json_extract(value,'$.configVersion'),json_extract(value,'$.run')`,
      page.coverage,
    );
    stage(
      "inventory_match_records",
      "scope_id,record_key,facet,exists_flag,key_class,bucket_hash,state,semantic_version,current_semantic_version,config_version,parent_key,topology_version,current_topology_version,projection_version,membership_version,current_projection_version,projection_state,projection_reason,payload_id",
      `json_extract(value,'$.reference.scope'),json_extract(value,'$.reference.key'),json_extract(value,'$.reference.facet'),(json_type(value,'$.candidate')!='null'),json_extract(value,'$.candidate.keyClass'),json_extract(value,'$.candidate.hash'),json_extract(value,'$.candidate.state'),json_extract(value,'$.candidate.semanticVersion'),json_extract(value,'$.candidate.currentSemanticVersion'),json_extract(value,'$.candidate.configVersion'),json_extract(value,'$.candidate.parent'),json_extract(value,'$.candidate.topologyVersion'),json_extract(value,'$.candidate.currentTopologyVersion'),json_extract(value,'$.candidate.projectionVersion'),json_extract(value,'$.candidate.membershipVersion'),json_extract(value,'$.candidate.currentProjectionVersion'),json_extract(value,'$.candidate.projectionState'),json_extract(value,'$.candidate.projectionReason'),json_extract(value,'$.candidate.payload')`,
      page.records,
    );
    stage(
      "inventory_match_probes",
      "probe_id,direction,subject_scope,subject_key,subject_facet,search_scope,config_version,index_ready,complete",
      `json_extract(value,'$.ordinal'),json_extract(value,'$.direction'),json_extract(value,'$.subject.scope'),json_extract(value,'$.subject.key'),json_extract(value,'$.subject.facet'),json_extract(value,'$.probe.scope'),json_extract(value,'$.probe.configVersion'),json_extract(value,'$.probe.indexReady'),json_extract(value,'$.complete')`,
      probes,
    );
    stage(
      "inventory_match_tokens",
      "probe_id,key_class,bucket_hash,version",
      `json_extract(value,'$.probe'),json_extract(value,'$.keyClass'),json_extract(value,'$.hash'),json_extract(value,'$.version')`,
      tokens,
    );
    stage(
      "inventory_match_candidates",
      "probe_id,scope_id,record_key,facet",
      `json_extract(value,'$.probe'),json_extract(value,'$.scope'),json_extract(value,'$.key'),json_extract(value,'$.facet')`,
      candidates,
    );
    stage(
      "inventory_match_rows",
      "source_scope,record_key,expected_version,state,reason,remote_key,required_coverage",
      `json_extract(value,'$.source.scope'),json_extract(value,'$.source.key'),json_extract(value,'$.expectedVersion'),json_extract(value,'$.state'),json_extract(value,'$.reason'),json_extract(value,'$.remote.key'),json_extract(value,'$.coverage')`,
      rows,
    );
    if (page.coverageRecovery === 1)
      stage(
        "inventory_match_recovery",
        "recovery_id,scope_id,facet,subject_scope,subject_key,nodes",
        `CAST(key AS INTEGER),json_extract(value,'$.scope'),json_extract(value,'$.facet'),json_extract(value,'$.subject.scope'),json_extract(value,'$.subject.key'),json_extract(value,'$.nodes')`,
        recovery,
      );
    if (work) {
      plan.push(
        this.store.statement(
          "INSERT INTO inventory_match_work_claims(tenant,set_id,row_count) VALUES(?,?,?)",
          page.tenant,
          id,
          work.length,
        ),
      );
      stage(
        "inventory_match_work_rows",
        "generation_id,destination,source_scope,record_key,work_version,completed_version,source_config_version,destination_config_version,due_at",
        "json_extract(value,'$.generation'),json_extract(value,'$.destination'),json_extract(value,'$.scope'),json_extract(value,'$.key'),json_extract(value,'$.workVersion'),json_extract(value,'$.completedVersion'),json_extract(value,'$.sourceConfigVersion'),json_extract(value,'$.destinationConfigVersion'),json_extract(value,'$.dueAt')",
        work.map((row) => ({
          ...row,
          generation: page.generation,
          destination: page.destination,
        })),
      );
    }
    const bound = (sql: string) => this.store.statement(sql, page.tenant, id);
    plan.push(
      bound("INSERT INTO inventory_match_guards(tenant,set_id) VALUES(?,?)"),
      bound(`INSERT INTO match_results(tenant,destination,source_scope,record_key,version,set_id,state,reason,remote_key,derived_at,next_eligible_at)
       SELECT q.tenant,h.destination,q.source_scope,q.record_key,q.expected_version+1,q.set_id,q.state,q.reason,q.remote_key,h.prepared_at,h.prepared_at+60000 FROM inventory_match_rows q JOIN inventory_match_sets h ON h.tenant=q.tenant AND h.set_id=q.set_id WHERE q.tenant=? AND q.set_id=?
       ON CONFLICT(tenant,destination,source_scope,record_key) DO UPDATE SET version=excluded.version,set_id=excluded.set_id,state=excluded.state,reason=excluded.reason,remote_key=excluded.remote_key,derived_at=excluded.derived_at,next_eligible_at=excluded.next_eligible_at`),
    );
    if (work)
      plan.push(
        bound(
          `UPDATE matching_work SET completed_version=work_version,last_completed_set=?2,hold_reason=NULL WHERE rowid IN(SELECT w.rowid FROM inventory_match_work_rows q CROSS JOIN matching_work w WHERE q.tenant=?1 AND q.set_id=?2 AND w.tenant=q.tenant AND w.generation_id=q.generation_id AND w.destination=q.destination AND w.source_scope=q.source_scope AND w.record_key=q.record_key)`,
        ),
      );
    plan.push(
      bound(
        "UPDATE inventory_match_sets SET state='committed' WHERE tenant=? AND set_id=?",
      ),
    );
    if (plan.length > 200)
      throw new Error("inventory_matching_transaction_too_large");
    let results: D1Result[];
    try {
      results = await this.store.db.batch(plan);
    } catch (error) {
      const recovered = await this.recover(page, id, inputDigest).catch(
        () => null,
      );
      if (recovered) return recovered;
      throw error;
    }
    return {
      setId: id,
      recovered: false,
      records: rows.length,
      statements: plan.length,
      rowsRead: results.reduce((sum, row) => sum + row.meta.rows_read, 0),
      rowsWritten: results.reduce((sum, row) => sum + row.meta.rows_written, 0),
    };
  }
  async match(
    tenant: string,
    destination: string,
    selected: readonly { scope: string; key: string }[],
  ) {
    selected = structuredClone(selected);
    const lease = await this.store.claim(
      tenant,
      scope(destination),
      Date.now(),
      60000,
    );
    if (!lease) return { deferred: true as const };
    try {
      const page = await new InventoryMatchingWorkspace(this.store).prepare(
        tenant,
        destination,
        selected,
      );
      const result = await this.publish(page, lease);
      return { ...result, preparation: page.stats };
    } finally {
      await this.store.release(lease);
    }
  }
  async current(
    tenant: string,
    destination: string,
    selected: readonly { scope: string; key: string }[],
  ) {
    selected = structuredClone(selected);
    if (
      !identifier(tenant) ||
      !identifier(destination) ||
      selected.length < 1 ||
      selected.length > 20 ||
      selected.some((row) => !identifier(row.scope) || !identifier(row.key)) ||
      new Set(selected.map((row) => canonical([row.scope, row.key]))).size !==
        selected.length
    )
      throw new Error("invalid_inventory_matching_selection");
    const result = await this.store
      .statement(
        `WITH chosen AS MATERIALIZED(
      SELECT r.* FROM json_each(?1) j CROSS JOIN match_results r WHERE r.tenant=?2 AND r.destination=?3 AND r.source_scope=json_extract(j.value,'$.scope') AND r.record_key=json_extract(j.value,'$.key')
     ), valid AS MATERIALIZED(SELECT h.set_id FROM (SELECT DISTINCT set_id FROM chosen) c CROSS JOIN inventory_match_sets h WHERE h.tenant=?2 AND h.set_id=c.set_id AND h.state='committed' AND NOT EXISTS(SELECT 1 FROM inventory_match_stale_sets x WHERE x.tenant=h.tenant AND x.set_id=h.set_id))
     SELECT r.source_scope,r.record_key,r.state,r.reason,r.remote_key,r.version,r.set_id,r.derived_at FROM chosen r JOIN valid v ON v.set_id=r.set_id`,
        canonical(selected),
        tenant,
        destination,
      )
      .all<InventoryMatchResult>();
    return { results: result.results, rowsRead: result.meta.rows_read };
  }
}
