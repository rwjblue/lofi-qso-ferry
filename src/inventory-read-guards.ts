import type { InventoryRunContext } from "./inventory-runs.ts";
import { canonical, randomToken } from "./security.ts";
import type { Lease, Store } from "./store.ts";
import type { VendorAdmission } from "./vendor-requests.ts";

function requireValue(value: unknown): asserts value {
  if (!value) throw new Error("invalid_inventory_read_context");
}

/** Compose with one request reservation in the same native transaction. */
export function inventoryReadGuardStatements(
  store: Store,
  context: InventoryRunContext,
  lease: Lease,
  now = Date.now(),
): { before: D1PreparedStatement[]; after: D1PreparedStatement[] } {
  context = structuredClone(context);
  lease = structuredClone(lease);
  const { run, stream } = context;
  requireValue(
    Number.isSafeInteger(now) &&
      now > 0 &&
      ["collecting", "catchup"].includes(run.phase) &&
      run.activeRun === run.id &&
      run.tenant === stream.tenant &&
      run.scope === stream.scope &&
      run.streamId === stream.stream &&
      run.configVersion === stream.configVersion &&
      run.expectedStreamVersion === stream.version &&
      lease.tenant === stream.tenant &&
      lease.scope === `inventory:${stream.scope}`,
  );
  const requestBinding =
    run.phase === "collecting" ? run.collectionBinding : run.catchupBinding;
  requireValue(typeof requestBinding === "string" && requestBinding.length > 0);
  const pageId = `read:${randomToken()}`;
  const statement = (sql: string, ...params: (string | number | null)[]) =>
    store.statement(sql, ...params);
  const bound = (sql: string) => statement(sql, stream.tenant, pageId);
  // The transient admission page has no observations or calendar demand.
  const calendar = stream.sourceCalendarFormat === 1;
  return {
    before: [
      statement(
        `INSERT INTO ingestion_pages(tenant,page_id,scope_id,stream_id,input_digest,manifest_digest,adapter_binding,query_binding,expected_config_version,expected_sequence,expected_stream_version,credential_version,connection_config,remote_identity,lease_scope,lease_token,lease_fence,request_started_at,prepared_at,raw_count,distinct_count,accepted_count,changed_count,next_resume,next_checkpoint,origin${calendar ? ",lotw_calendar_months" : ""}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,0,?,NULL,'historical'${calendar ? ",'[]'" : ""})`,
        stream.tenant,
        pageId,
        stream.scope,
        stream.stream,
        pageId,
        pageId,
        stream.adapterBinding,
        stream.queryBinding,
        stream.configVersion,
        stream.sequence,
        stream.version,
        stream.credentialVersion,
        stream.connectionConfig,
        stream.remoteIdentity,
        lease.scope,
        lease.token,
        lease.fence,
        now,
        now,
        canonical(stream.resume),
      ),
      statement(
        `INSERT INTO ingestion_run_pages(tenant,page_id,run_id,action,expected_run_version,expected_job_version,expected_phase,request_binding,observed_complete,completed_streams,next_due_at) VALUES(?,?,?,'admit',?,?,?,?,0,'[]',?)`,
        stream.tenant,
        pageId,
        run.id,
        run.version,
        run.jobVersion,
        run.phase,
        requestBinding,
        now,
      ),
      bound("INSERT INTO ingestion_page_guards(tenant,page_id) VALUES(?,?)"),
    ],
    after: [
      bound("DELETE FROM ingestion_page_guards WHERE tenant=? AND page_id=?"),
      bound("DELETE FROM ingestion_run_pages WHERE tenant=? AND page_id=?"),
      bound("DELETE FROM ingestion_pages WHERE tenant=? AND page_id=?"),
    ],
  };
}

/** QRZ/LoTW admission; LoFi composes these guards with its additional pacing. */
export function inventoryReadAdmission(
  store: Store,
  context: InventoryRunContext,
  lease: Lease,
): VendorAdmission {
  context = structuredClone(context);
  lease = structuredClone(lease);
  requireValue(["qrz", "lotw"].includes(context.stream.provider));
  return async (reservation) => {
    const { before, after } = inventoryReadGuardStatements(
      store,
      context,
      lease,
    );
    const result = await store.db.batch<{
      window_start: number;
      cooldown_until: number;
    }>([...before, reservation, ...after]);
    return result[before.length].results[0] ?? null;
  };
}
