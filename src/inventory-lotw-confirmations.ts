import type { AdifRecord } from "./adif.ts";
import {
  InventoryIngestion,
  inventoryJsonChunks,
} from "./inventory-ingestion.ts";
import { lotwVariantPrefix } from "./inventory-observations.ts";
import { inventoryStreamReadGuard } from "./inventory-read-guards.ts";
import {
  LotwClient,
  type LotwConfirmationQuery,
  lotwConfirmationFilters,
  validLotwReceiveTime,
} from "./lotw.ts";
import { canonicalLotwIdentity } from "./reconcile.ts";
import { canonical, open, seal, sha256 } from "./security.ts";
import type { Store } from "./store.ts";
import { vendorFetch } from "./vendor-requests.ts";

const kind = "inventory_lotw_confirmation";

function payloadId(scope: string, scopeVersion: number, bodyHash: string) {
  return canonical([scope, scopeVersion, bodyHash]);
}

function supportedIdentity(record: AdifRecord) {
  try {
    return canonicalLotwIdentity(record);
  } catch {
    // The QSL is still evidence when this mode cannot be correlated.
    return null;
  }
}

/** Poll one explicit selection under the same native lease as receipt reads. */
export async function pollInventoryLotwConfirmations(
  store: Store,
  target: { tenant: string; scope: string; selection: LotwConfirmationQuery },
  fetcher: typeof fetch = fetch,
) {
  const { tenant, scope, selection } = structuredClone(target);
  const filters = lotwConfirmationFilters(selection);
  const lease = await store.claim(tenant, `inventory:${scope}`);
  if (!lease) return { state: "busy" as const };
  try {
    const authority = await store
      .statement(
        `SELECT s.config_version FROM inventory_scopes s
         JOIN connections c ON (c.tenant,c.id)=(s.tenant,s.connection_id)
         WHERE (s.tenant,s.scope_id)=(?,?) AND s.provider='lotw' AND s.state='observing'
           AND c.kind='lotw' AND c.status='active' AND json_extract(c.config,'$.readAccess')=1`,
        tenant,
        scope,
      )
      .first<{ config_version: number }>();
    if (!authority)
      throw new Error("inventory_lotw_confirmation_scope_unavailable");
    const scopeVersion = authority.config_version;
    const streamId = `lotw-confirmation-v1:${await sha256(canonical([scopeVersion, filters]))}`;
    await store
      .statement(
        `INSERT INTO inventory_streams(tenant,scope_id,stream_id,query_binding)
         SELECT tenant,scope_id,?3,?3 FROM inventory_scopes
         WHERE (tenant,scope_id,config_version)=(?1,?2,?4)
         ON CONFLICT(tenant,scope_id,stream_id) DO NOTHING`,
        tenant,
        scope,
        streamId,
        scopeVersion,
      )
      .run();
    const stream = await new InventoryIngestion(store).snapshot(
      tenant,
      scope,
      streamId,
    );
    if (
      !stream ||
      stream.configVersion !== scopeVersion ||
      stream.provider !== "lotw" ||
      stream.queryBinding !== streamId
    )
      throw new Error("inventory_lotw_confirmation_scope_unavailable");
    let lower = selection.confirmedSince;
    if (stream.version > 0) {
      const checkpoint = stream.checkpoint as {
        confirmedThrough?: unknown;
      } | null;
      if (
        !validLotwReceiveTime(checkpoint?.confirmedThrough) ||
        checkpoint.confirmedThrough < lower
      )
        throw new Error("inventory_lotw_confirmation_checkpoint_invalid");
      lower = checkpoint.confirmedThrough;
    }
    const credential = await store.private<{
      query?: { username: string; password: string };
    }>(tenant, stream.connection, stream.credentialVersion, "credential");
    if (
      typeof credential?.query?.username !== "string" ||
      !credential.query.username ||
      typeof credential.query.password !== "string" ||
      !credential.query.password
    )
      throw new Error("inventory_credential_unavailable");
    const observedAt = Date.now();
    const transport = vendorFetch(store, "lotw", fetcher, {
      priority: "background",
      admit: async (reservation) => {
        const guard = inventoryStreamReadGuard(
          store,
          stream,
          lease,
          Date.now(),
        );
        const results = await store.db.batch<{
          window_start: number;
          cooldown_until: number;
        }>([
          guard.prepare,
          guard.verify,
          reservation,
          guard.release,
          guard.remove,
        ]);
        return results[2].results[0] ?? null;
      },
    });
    const report = await new LotwClient(credential.query, {
      fetcher: transport,
    }).queryConfirmations({ ...selection, confirmedSince: lower });
    const rows = [];
    for (const record of report.records) {
      const identity = supportedIdentity(record);
      const bodyHash = await sha256(canonical(record));
      const envelope = await seal(
        record,
        {
          tenant,
          connection: stream.connection,
          id: payloadId(scope, scopeVersion, bodyHash),
          kind,
          purpose: "storage",
        },
        store.keys,
      );
      rows.push({
        identityHash: identity && (await sha256(canonical(identity))),
        bodyHash,
        confirmedAt: record.APP_LOTW_RXQSL,
        envelope,
      });
    }
    const confirmedThrough = report.confirmedThrough ?? lower;
    const guard = inventoryStreamReadGuard(store, stream, lease, Date.now());
    const result = await store.db.batch([
      guard.prepare,
      guard.verify,
      ...inventoryJsonChunks(rows).map((chunk) =>
        store.statement(
          `INSERT INTO inventory_lotw_confirmations(tenant,scope_id,scope_version,stream_id,stream_version,connection_id,identity_hash,body_hash,confirmed_at,observed_at,envelope)
           SELECT ?,?,?,?,?,?,json_extract(value,'$.identityHash'),json_extract(value,'$.bodyHash'),json_extract(value,'$.confirmedAt'),?,json_extract(value,'$.envelope')
           FROM json_each(?) WHERE 1
           ON CONFLICT(tenant,scope_id,scope_version,body_hash) DO NOTHING`,
          tenant,
          scope,
          scopeVersion,
          streamId,
          stream.version + 1,
          stream.connection,
          observedAt,
          chunk,
        ),
      ),
      store.statement(
        `UPDATE inventory_streams SET checkpoint_version=checkpoint_version+1,committed_checkpoint=?,updated_at=?
         WHERE (tenant,scope_id,stream_id)=(?,?,?)`,
        canonical({ selection, confirmedThrough }),
        observedAt,
        tenant,
        scope,
        streamId,
      ),
      guard.release,
      guard.remove,
    ]);
    return {
      state: "complete" as const,
      streamId,
      confirmedThrough,
      records: report.records.length,
      added: result
        .slice(2, -3)
        .reduce((count, row) => count + row.meta.changes, 0),
    };
  } finally {
    await store.release(lease);
  }
}

/** Resolve QSL evidence against exactly one known receipt variant at read time. */
export async function inventoryLotwConfirmation(
  store: Store,
  tenant: string,
  scope: string,
  identityHash: string,
) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(identityHash))
    throw new Error("invalid_lotw_inventory_identity");
  const prefix = lotwVariantPrefix(identityHash);
  const [receipts, confirmations] = await store.db.batch<{
    record_key?: string;
    confirmed_at: string;
    observed_at: number;
    envelope: string;
    body_hash: string;
    connection_id: string;
    scope_version: number;
  }>([
    store.statement(
      `SELECT f.record_key FROM inventory_record_facets f
       JOIN inventory_records r ON (r.tenant,r.scope_id,r.entity_family,r.record_key)=(f.tenant,f.scope_id,f.entity_family,f.record_key)
       JOIN inventory_scopes s ON (s.tenant,s.scope_id)=(f.tenant,f.scope_id)
       JOIN ingestion_pages p ON (p.tenant,p.page_id)=(f.tenant,f.last_page_id)
       WHERE (f.tenant,f.scope_id,f.entity_family)=(?,?,'qso') AND f.facet='receipt'
         AND f.record_key>=? AND f.record_key<? AND r.status='active'
         AND s.provider='lotw' AND s.state='observing' AND p.expected_config_version=s.config_version
       LIMIT 2`,
      tenant,
      scope,
      prefix,
      `${prefix.slice(0, -1)};`,
    ),
    store.statement(
      `SELECT q.* FROM inventory_scopes s
       JOIN inventory_lotw_confirmations q ON (q.tenant,q.scope_id,q.scope_version)=(s.tenant,s.scope_id,s.config_version)
       WHERE (s.tenant,s.scope_id)=(?,?) AND s.provider='lotw' AND s.state='observing' AND q.identity_hash=?
       ORDER BY q.confirmed_at DESC,q.body_hash LIMIT 2`,
      tenant,
      scope,
      identityHash,
    ),
  ]);
  const [row, next] = confirmations.results;
  if (!row) return { state: "missing_confirmation" as const };
  const [receipt] = receipts.results;
  if (!receipt?.record_key) return { state: "missing_receipt" as const };
  if (receipts.results.length > 1)
    return { state: "ambiguous_receipt" as const };
  if (next?.confirmed_at === row.confirmed_at)
    return { state: "ambiguous_confirmation" as const };
  return {
    state: "confirmed" as const,
    receipt: receipt.record_key,
    confirmedAt: row.confirmed_at,
    observedAt: row.observed_at,
    record: await open<AdifRecord>(
      JSON.parse(row.envelope),
      {
        tenant,
        connection: row.connection_id,
        id: payloadId(scope, row.scope_version, row.body_hash),
        kind,
        purpose: "storage",
      },
      store.keys,
    ),
  };
}
