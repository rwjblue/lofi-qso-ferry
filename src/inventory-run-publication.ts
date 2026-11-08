import type { InventoryPageInput } from "./inventory-ingestion.ts";
import {
  INVENTORY_DEFAULT_SOURCE_DELAY_MS,
  type InventoryPacingHints,
  inventorySourcePacingStatement,
} from "./inventory-vendor-admission.ts";
import { canonical } from "./security.ts";
import type { Store } from "./store.ts";

export type InventoryRunPhase =
  | "collecting"
  | "catchup"
  | "quarantining"
  | "publishing"
  | "complete"
  | "held";
export interface InventoryRunDefinition {
  id: string;
  mode: "full" | "delta";
  facet: "source" | "receipt";
  partition: string;
  partitionBinding: string;
  collectionBinding: string;
  catchupBinding?: string;
  requiredStreams: string[];
  fixedQuery: unknown;
  initialResume: unknown;
}
export interface InventoryRunPosition {
  id: string;
  version: number;
  jobVersion: number;
  phase: InventoryRunPhase;
}
interface Base extends InventoryRunPosition {
  nextDueAt: number;
}
export type InventoryRunPublication =
  | (Base & {
      action: "begin";
      definition: InventoryRunDefinition;
      inputDigest: string;
      replaceHeld?: boolean;
    })
  | (Base & {
      action: "page";
      requestBinding: string;
      observedComplete: boolean;
      completedStreams: string[];
      proposedCheckpoint?: unknown;
      pacingDelayMs?: number;
      pacingHints?: InventoryPacingHints;
    })
  | (Base & {
      action: "quarantine";
      rows: { family: string; key: string; version: number }[];
      nextCursor: { family: string; key: string } | null;
      exhausted: boolean;
    })
  | (Base & { action: "complete" })
  | (Base & {
      action: "defer" | "hold";
      reason:
        | "vendor_deferred"
        | "read_unavailable"
        | "scope_changed"
        | "verification_required"
        | "unsupported"
        | "overflow"
        | "cursor_refused";
    });

function bound(store: Store, input: InventoryPageInput, sql: string) {
  return store.statement(sql, input.stream.tenant, input.pageId);
}

/** Metadata is staged inside the same batch as the ordinary page guard. */
export function inventoryRunPrelude(
  store: Store,
  input: InventoryPageInput,
): D1PreparedStatement[] {
  const run = input.run;
  if (!run) return [];
  const s = input.stream;
  const statements: D1PreparedStatement[] = [];
  if (run.action === "begin") {
    const d = run.definition;
    statements.push(
      store.statement(
        `INSERT INTO inventory_runs(tenant,run_id,scope_id,stream_id,facet,partition_id,partition_binding,mode,requires_catchup,config_version,adapter_binding,query_binding,collection_binding,catchup_binding,fixed_query,required_streams,input_digest,start_sequence,initial_stream_version,expected_stream_version,started_at,phase_started_at,position_started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        s.tenant,
        d.id,
        s.scope,
        s.stream,
        d.facet,
        d.partition,
        d.partitionBinding,
        d.mode,
        Number(Boolean(d.catchupBinding)),
        s.configVersion,
        s.adapterBinding,
        s.queryBinding,
        d.collectionBinding,
        d.catchupBinding ?? null,
        canonical(d.fixedQuery),
        canonical(d.requiredStreams),
        run.inputDigest,
        s.sequence + 1,
        s.version,
        s.version,
        input.requestStartedAt,
        input.requestStartedAt,
        input.requestStartedAt,
      ),
      store.statement(
        "INSERT INTO inventory_stream_jobs(tenant,scope_id,stream_id) VALUES(?,?,?) ON CONFLICT DO NOTHING",
        s.tenant,
        s.scope,
        s.stream,
      ),
      store.statement(
        "INSERT INTO inventory_coverage(tenant,scope_id,stream_id,facet,partition_id,partition_binding) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        s.tenant,
        s.scope,
        s.stream,
        d.facet,
        d.partition,
        d.partitionBinding,
      ),
    );
  }
  const data = run.action === "page" ? run : null;
  const quarantine = run.action === "quarantine" ? run : null;
  const proposed = data?.proposedCheckpoint;
  statements.push(
    store.statement(
      `INSERT INTO ingestion_run_pages(tenant,page_id,run_id,action,expected_run_version,expected_job_version,expected_phase,request_binding,observed_complete,completed_streams,proposed_checkpoint,next_due_at,cursor_family,cursor_key,quarantine_complete,reason,replace_held) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      s.tenant,
      input.pageId,
      run.id,
      run.action,
      run.version,
      run.jobVersion,
      run.phase,
      data?.requestBinding ?? null,
      Number(data?.observedComplete ?? false),
      canonical(data?.completedStreams ?? []),
      proposed === undefined || proposed === null ? null : canonical(proposed),
      run.nextDueAt,
      quarantine?.nextCursor?.family ?? null,
      quarantine?.nextCursor?.key ?? null,
      Number(quarantine?.exhausted ?? false),
      run.action === "defer" || run.action === "hold" ? run.reason : null,
      Number(run.action === "begin" && run.replaceHeld === true),
    ),
  );
  if (quarantine?.rows.length) {
    const json = JSON.stringify(quarantine.rows);
    if (new TextEncoder().encode(json).byteLength > 512 * 1024)
      throw new Error("inventory_quarantine_page_too_large");
    statements.push(
      store.statement(
        `INSERT INTO inventory_quarantine_rows(tenant,page_id,entity_family,record_key,expected_version) SELECT ?,?,json_extract(value,'$.family'),json_extract(value,'$.key'),json_extract(value,'$.version') FROM json_each(?)`,
        s.tenant,
        input.pageId,
        json,
      ),
    );
  }
  return statements;
}

/** Derived run effects precede the ordinary scope/stream checkpoint transition. */
export function inventoryRunEffects(
  store: Store,
  input: InventoryPageInput,
): D1PreparedStatement[] {
  const run = input.run;
  if (!run) return [];
  const statements: D1PreparedStatement[] = [];
  if (run.action === "page") {
    const observed = `FROM ingestion_page_rows s JOIN ingestion_pages p ON p.tenant=s.tenant AND p.page_id=s.page_id JOIN ingestion_run_pages x ON x.tenant=p.tenant AND x.page_id=p.page_id JOIN inventory_runs r ON r.tenant=x.tenant AND r.run_id=x.run_id JOIN inventory_record_facets f ON f.tenant=p.tenant AND f.scope_id=p.scope_id AND f.entity_family=s.entity_family AND f.record_key=s.record_key AND f.facet=s.facet WHERE p.tenant=? AND p.page_id=? AND s.accepted=1`;
    statements.push(
      bound(
        store,
        input,
        `UPDATE connections SET last_poll_at=max(coalesce(last_poll_at,0),(SELECT request_started_at FROM ingestion_pages WHERE tenant=?1 AND page_id=?2)),config=json_set(json_remove(config,'$.lastError'),'$.lastSuccessfulPollAt',max(CASE WHEN json_type(config,'$.lastSuccessfulPollAt')='integer' THEN json_extract(config,'$.lastSuccessfulPollAt') ELSE 0 END,(SELECT request_started_at FROM ingestion_pages WHERE tenant=?1 AND page_id=?2))) WHERE tenant=?1 AND id=(SELECT s.connection_id FROM ingestion_pages p JOIN inventory_scopes s ON s.tenant=p.tenant AND s.scope_id=p.scope_id WHERE p.tenant=?1 AND p.page_id=?2)`,
      ),
      bound(
        store,
        input,
        `INSERT INTO inventory_run_membership(tenant,run_id,scope_id,entity_family,record_key,facet,facet_version,revision,body_hash,accepted_sequence,observed_at,last_page_id) SELECT p.tenant,r.run_id,p.scope_id,s.entity_family,s.record_key,s.facet,f.row_version,f.revision,f.body_hash,f.last_accepted_sequence,p.request_started_at,p.page_id ${observed} ON CONFLICT(tenant,run_id,entity_family,record_key,facet) DO UPDATE SET facet_version=excluded.facet_version,revision=excluded.revision,body_hash=excluded.body_hash,accepted_sequence=excluded.accepted_sequence,observed_at=excluded.observed_at,last_page_id=excluded.last_page_id`,
      ),
      bound(
        store,
        input,
        `INSERT INTO inventory_partition_membership(tenant,scope_id,stream_id,facet,partition_id,entity_family,record_key,state,row_version,facet_version,last_accepted_sequence,last_observed_at,last_run_id) SELECT p.tenant,p.scope_id,p.stream_id,s.facet,r.partition_id,s.entity_family,s.record_key,'present',1,f.row_version,f.last_accepted_sequence,p.request_started_at,r.run_id ${observed} ON CONFLICT(tenant,scope_id,stream_id,facet,partition_id,entity_family,record_key) DO UPDATE SET state='present',row_version=inventory_partition_membership.row_version+1,facet_version=excluded.facet_version,last_accepted_sequence=excluded.last_accepted_sequence,last_observed_at=excluded.last_observed_at,last_run_id=excluded.last_run_id`,
      ),
    );
    if (run.pacingDelayMs !== undefined || run.pacingHints !== undefined)
      statements.push(
        inventorySourcePacingStatement(
          store,
          input.stream,
          input.requestStartedAt,
          run.pacingDelayMs ??
            run.pacingHints?.loopDelayMs ??
            INVENTORY_DEFAULT_SOURCE_DELAY_MS,
          run.pacingHints,
        ),
      );
  }
  if (run.action === "quarantine") {
    const freshSource = `FROM inventory_quarantine_rows q CROSS JOIN ingestion_run_pages x CROSS JOIN inventory_runs r CROSS JOIN inventory_record_facets f CROSS JOIN inventory_partition_membership old WHERE q.tenant=?1 AND q.page_id=?2 AND x.tenant=q.tenant AND x.page_id=q.page_id AND r.tenant=x.tenant AND r.run_id=x.run_id AND r.facet='source' AND f.tenant=r.tenant AND f.scope_id=r.scope_id AND f.entity_family=q.entity_family AND f.record_key=q.record_key AND f.facet=r.facet AND f.last_accepted_sequence>r.start_sequence AND f.last_observed_at>=r.started_at AND old.tenant=r.tenant AND old.scope_id=r.scope_id AND old.stream_id=r.stream_id AND old.facet=r.facet AND old.partition_id=r.partition_id AND old.entity_family=q.entity_family AND old.record_key=q.record_key AND (f.last_accepted_sequence>old.last_accepted_sequence OR NOT EXISTS(SELECT 1 FROM inventory_run_membership prior WHERE prior.tenant=r.tenant AND prior.run_id=r.run_id AND prior.entity_family=q.entity_family AND prior.record_key=q.record_key AND prior.facet=r.facet AND prior.facet_version=f.row_version))`;
    statements.push(
      bound(
        store,
        input,
        `INSERT INTO inventory_run_membership(tenant,run_id,scope_id,entity_family,record_key,facet,facet_version,revision,body_hash,accepted_sequence,observed_at,last_page_id) SELECT r.tenant,r.run_id,r.scope_id,q.entity_family,q.record_key,r.facet,f.row_version,f.revision,f.body_hash,f.last_accepted_sequence,f.last_observed_at,f.last_page_id ${freshSource} ON CONFLICT(tenant,run_id,entity_family,record_key,facet) DO UPDATE SET facet_version=excluded.facet_version,revision=excluded.revision,body_hash=excluded.body_hash,accepted_sequence=excluded.accepted_sequence,observed_at=excluded.observed_at,last_page_id=excluded.last_page_id`,
      ),
      bound(
        store,
        input,
        `UPDATE inventory_partition_membership AS m SET state='present',row_version=row_version+1,
        facet_version=(SELECT f.row_version FROM inventory_record_facets f WHERE f.tenant=m.tenant AND f.scope_id=m.scope_id AND f.entity_family=m.entity_family AND f.record_key=m.record_key AND f.facet=m.facet),
        last_accepted_sequence=(SELECT f.last_accepted_sequence FROM inventory_record_facets f WHERE f.tenant=m.tenant AND f.scope_id=m.scope_id AND f.entity_family=m.entity_family AND f.record_key=m.record_key AND f.facet=m.facet),
        last_observed_at=(SELECT f.last_observed_at FROM inventory_record_facets f WHERE f.tenant=m.tenant AND f.scope_id=m.scope_id AND f.entity_family=m.entity_family AND f.record_key=m.record_key AND f.facet=m.facet),
        last_run_id=(SELECT run_id FROM ingestion_run_pages WHERE tenant=?1 AND page_id=?2)
        WHERE (m.tenant,m.scope_id,m.stream_id,m.facet,m.partition_id,m.entity_family,m.record_key) IN (SELECT old.tenant,old.scope_id,old.stream_id,old.facet,old.partition_id,old.entity_family,old.record_key ${freshSource})`,
      ),
    );
    statements.push(
      bound(
        store,
        input,
        `UPDATE inventory_partition_membership AS m SET state='unresolved',row_version=row_version+1 WHERE (m.tenant,m.scope_id,m.stream_id,m.facet,m.partition_id,m.entity_family,m.record_key) IN (SELECT old.tenant,old.scope_id,old.stream_id,old.facet,old.partition_id,old.entity_family,old.record_key FROM inventory_quarantine_rows q CROSS JOIN ingestion_run_pages x CROSS JOIN inventory_runs r CROSS JOIN inventory_partition_membership old WHERE q.tenant=?1 AND q.page_id=?2 AND x.tenant=q.tenant AND x.page_id=q.page_id AND r.tenant=x.tenant AND r.run_id=x.run_id AND old.tenant=q.tenant AND old.scope_id=r.scope_id AND old.stream_id=r.stream_id AND old.facet=r.facet AND old.partition_id=r.partition_id AND old.entity_family=q.entity_family AND old.record_key=q.record_key AND old.last_accepted_sequence<=r.start_sequence AND old.state!='unresolved' AND NOT EXISTS(SELECT 1 FROM inventory_run_membership seen WHERE seen.tenant=r.tenant AND seen.run_id=r.run_id AND seen.entity_family=old.entity_family AND seen.record_key=old.record_key AND seen.facet=old.facet))`,
      ),
    );
  }
  statements.push(
    bound(
      store,
      input,
      `UPDATE inventory_runs AS r SET version=version+1,expected_stream_version=(SELECT p.expected_stream_version+1 FROM ingestion_pages p WHERE p.tenant=r.tenant AND p.page_id=?2),
    coverage_version=CASE (SELECT x.action FROM ingestion_run_pages x WHERE x.tenant=r.tenant AND x.page_id=?2) WHEN 'begin' THEN (SELECT c.version+1 FROM inventory_coverage c WHERE c.tenant=r.tenant AND c.scope_id=r.scope_id AND c.stream_id=r.stream_id AND c.facet=r.facet AND c.partition_id=r.partition_id) WHEN 'complete' THEN coverage_version+1 WHEN 'hold' THEN coverage_version+1 ELSE coverage_version END,
    proposed_checkpoint=coalesce((SELECT x.proposed_checkpoint FROM ingestion_run_pages x WHERE x.tenant=r.tenant AND x.page_id=?2),proposed_checkpoint),
    cursor_family=coalesce((SELECT x.cursor_family FROM ingestion_run_pages x WHERE x.tenant=r.tenant AND x.page_id=?2),cursor_family),cursor_key=coalesce((SELECT x.cursor_key FROM ingestion_run_pages x WHERE x.tenant=r.tenant AND x.page_id=?2),cursor_key),
    position_started_at=(SELECT p.prepared_at FROM ingestion_pages p WHERE p.tenant=r.tenant AND p.page_id=?2),
    phase_started_at=CASE WHEN (SELECT x.observed_complete FROM ingestion_run_pages x WHERE x.tenant=r.tenant AND x.page_id=?2)=1 THEN (SELECT p.prepared_at FROM ingestion_pages p WHERE p.tenant=r.tenant AND p.page_id=?2) ELSE phase_started_at END,
    completed_at=CASE WHEN (SELECT x.action FROM ingestion_run_pages x WHERE x.tenant=r.tenant AND x.page_id=?2)='complete' THEN (SELECT p.prepared_at FROM ingestion_pages p WHERE p.tenant=r.tenant AND p.page_id=?2) ELSE completed_at END,
    reason=(SELECT x.reason FROM ingestion_run_pages x WHERE x.tenant=r.tenant AND x.page_id=?2),
    phase=CASE (SELECT x.action FROM ingestion_run_pages x WHERE x.tenant=r.tenant AND x.page_id=?2)
      WHEN 'hold' THEN 'held' WHEN 'complete' THEN 'complete'
      WHEN 'quarantine' THEN CASE WHEN (SELECT x.quarantine_complete FROM ingestion_run_pages x WHERE x.tenant=r.tenant AND x.page_id=?2)=1 THEN 'publishing' ELSE phase END
      WHEN 'page' THEN CASE WHEN (SELECT x.observed_complete FROM ingestion_run_pages x WHERE x.tenant=r.tenant AND x.page_id=?2)=0 THEN phase WHEN mode='delta' THEN 'publishing' WHEN phase='collecting' AND requires_catchup=1 THEN 'catchup' ELSE 'quarantining' END
      ELSE phase END
    WHERE r.tenant=?1 AND r.run_id=(SELECT x.run_id FROM ingestion_run_pages x WHERE x.tenant=?1 AND x.page_id=?2)`,
    ),
  );
  statements.push(
    bound(
      store,
      input,
      `UPDATE inventory_stream_jobs AS j SET work_version=work_version+1,next_due_at=(SELECT x.next_due_at FROM ingestion_run_pages x WHERE x.tenant=j.tenant AND x.page_id=?2),
    reason=(SELECT x.reason FROM ingestion_run_pages x WHERE x.tenant=j.tenant AND x.page_id=?2),
    state=CASE (SELECT x.action FROM ingestion_run_pages x WHERE x.tenant=j.tenant AND x.page_id=?2) WHEN 'complete' THEN 'idle' WHEN 'hold' THEN 'held' ELSE 'ready' END,
    active_run_id=CASE WHEN (SELECT x.action FROM ingestion_run_pages x WHERE x.tenant=j.tenant AND x.page_id=?2)='complete' THEN NULL ELSE (SELECT x.run_id FROM ingestion_run_pages x WHERE x.tenant=j.tenant AND x.page_id=?2) END
    WHERE j.tenant=?1 AND (j.scope_id,j.stream_id)=(SELECT p.scope_id,p.stream_id FROM ingestion_pages p WHERE p.tenant=?1 AND p.page_id=?2)`,
    ),
  );
  if (
    run.action === "begin" ||
    run.action === "hold" ||
    run.action === "complete"
  )
    statements.push(
      bound(
        store,
        input,
        `UPDATE inventory_coverage AS c SET version=c.version+1,
    building_run_id=CASE WHEN x.action='begin' THEN r.run_id WHEN x.action='complete' THEN NULL ELSE c.building_run_id END,
    epoch=CASE WHEN x.action='complete' AND r.mode='full' THEN c.epoch+1 ELSE c.epoch END,
    published_run_id=CASE WHEN x.action='complete' AND r.mode='full' THEN r.run_id ELSE c.published_run_id END,
    published_config_version=CASE WHEN x.action='complete' AND r.mode='full' THEN r.config_version ELSE c.published_config_version END,
    delta_run_id=CASE WHEN x.action='complete' AND r.mode='delta' THEN r.run_id ELSE c.delta_run_id END,
    kind=CASE WHEN x.action='complete' AND (r.mode='full' OR c.published_run_id IS NOT NULL AND c.published_config_version=r.config_version) THEN 'observed_selection' ELSE c.kind END,
    state=CASE x.action WHEN 'begin' THEN 'collecting' WHEN 'hold' THEN 'held' ELSE CASE WHEN r.mode='full' OR c.published_run_id IS NOT NULL AND c.published_config_version=r.config_version THEN 'ready' ELSE 'partial' END END,
    completed_at=CASE WHEN x.action='complete' THEN p.prepared_at ELSE c.completed_at END
    FROM ingestion_pages p JOIN ingestion_run_pages x ON x.tenant=p.tenant AND x.page_id=p.page_id JOIN inventory_runs r ON r.tenant=x.tenant AND r.run_id=x.run_id
    WHERE p.tenant=?1 AND p.page_id=?2 AND c.tenant=p.tenant AND c.scope_id=p.scope_id AND c.stream_id=p.stream_id AND c.facet=r.facet AND c.partition_id=r.partition_id`,
      ),
    );
  statements.push(
    bound(
      store,
      input,
      `INSERT INTO inventory_wakeups(tenant,wakeup_id,scope_id,stream_id,run_id,work_version,not_before) SELECT p.tenant,p.page_id||':next',p.scope_id,p.stream_id,x.run_id,j.work_version,j.next_due_at FROM ingestion_pages p JOIN ingestion_run_pages x ON x.tenant=p.tenant AND x.page_id=p.page_id JOIN inventory_stream_jobs j ON j.tenant=p.tenant AND j.scope_id=p.scope_id AND j.stream_id=p.stream_id WHERE p.tenant=? AND p.page_id=?`,
    ),
  );
  return statements;
}

export function inventoryRunCleanup(
  store: Store,
  input: InventoryPageInput,
): D1PreparedStatement[] {
  return input.run?.action === "quarantine"
    ? [
        bound(
          store,
          input,
          "DELETE FROM inventory_quarantine_rows WHERE tenant=? AND page_id=?",
        ),
      ]
    : [];
}
