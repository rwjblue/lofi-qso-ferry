import { createLoFiInventoryAdapter } from "./inventory-adapters.ts";
import {
  InventoryIngestion,
  type InventoryStream,
} from "./inventory-ingestion.ts";
import {
  inventorySourcePacing,
  inventoryVendorFetch,
} from "./inventory-vendor-admission.ts";
import type { SyncState } from "./lofi.ts";
import { canonical, randomToken, seal, sha256 } from "./security.ts";
import { openSourceCredentials } from "./source-credentials.ts";
import type { Lease, Store } from "./store.ts";

const MAX_TARGETS = 8;
const RETRY_MS = 5 * 60_000;

interface ReplayRoute {
  tenant: string;
  scope_id: string;
}
interface ReplayCursor extends ReplayRoute {
  id: string;
  config_version: number;
  credential_version: string;
  connection_config: string;
  upper_bound: number;
  resume: string;
  next_due_at: number;
  version: number;
}
interface ReplayTarget {
  payload_id: string;
  record_key: string;
  body_hash: string;
  marker: string;
}

const currentTarget = `SELECT 1 FROM inventory_payloads p JOIN inventory_record_facets f
 ON (f.tenant,f.scope_id,f.payload_id)=(p.tenant,p.scope_id,p.payload_id)
 JOIN inventory_records e ON (e.tenant,e.scope_id,e.entity_family,e.record_key)=(f.tenant,f.scope_id,f.entity_family,f.record_key)
 WHERE (p.tenant,p.scope_id,p.payload_id,p.envelope,p.cold)=(q.tenant,q.scope_id,q.payload_id,q.marker,1)
 AND (f.entity_family,f.record_key,f.facet,f.body_hash)=('qso',q.record_key,'source',q.body_hash) AND e.status='active'`;
const currentCursor = `c.tenant=?1 AND c.scope_id=?2 AND c.id=?3 AND c.version=?4
 AND EXISTS(SELECT 1 FROM leases l JOIN inventory_scopes s ON (s.tenant,s.scope_id)=(c.tenant,c.scope_id)
 JOIN connections x ON (x.tenant,x.id)=(s.tenant,s.connection_id)
 JOIN accounts a ON a.id=s.tenant AND a.status='active'
 WHERE (l.tenant,l.scope,l.token,l.fence)=(c.tenant,'inventory:'||c.scope_id,?5,?6)
 AND l.expires_at>unixepoch('subsec')*1000 AND (s.config_version,s.state)=(c.config_version,'observing')
 AND (x.credential_version,x.config,x.status,x.remote_identity)=(c.credential_version,c.connection_config,'active',s.logical_identity))`;

function replayResume(stream: InventoryStream, epoch: string): SyncState {
  return {
    mode: "backfill",
    accountId: stream.logicalIdentity,
    readerPolicy: "all-clients-v1",
    policyEpoch: epoch,
    operations: {},
    qsos: {},
  };
}

/** Process one paced LoFi page with its own durable cursor. Exact digest and
 * native lease/credential checks bind restores to the still-current facet. */
export async function stepInventoryBodyReplay(
  store: Store,
  fetcher: typeof fetch = fetch,
) {
  const now = Date.now();
  const route = await store
    .statement(
      `SELECT q.tenant,q.scope_id FROM inventory_body_replay_requests q INDEXED BY inventory_body_replay_request_due
       LEFT JOIN inventory_body_replay_cursors c ON (c.tenant,c.scope_id)=(q.tenant,q.scope_id)
       JOIN inventory_scopes s ON (s.tenant,s.scope_id,s.state)=(q.tenant,q.scope_id,'observing')
       JOIN accounts a ON a.id=s.tenant AND a.status='active'
       WHERE q.state='pending' AND q.cursor_id IS c.id AND coalesce(c.next_due_at,0)<=?
       ORDER BY q.requested_at,q.tenant,q.scope_id,q.payload_id LIMIT 1`,
      now,
    )
    .first<ReplayRoute>();
  if (!route) return { kind: "idle" as const };
  const lease = await store.claim(
    route.tenant,
    `inventory:${route.scope_id}`,
    now,
    60_000,
  );
  if (!lease) return { kind: "deferred" as const };
  try {
    return await replayPage(store, route, lease, fetcher);
  } finally {
    await store.release(lease);
  }
}

async function replayPage(
  store: Store,
  route: ReplayRoute,
  lease: Lease,
  fetcher: typeof fetch,
) {
  const { tenant, scope_id: scope } = route;
  const stream = await new InventoryIngestion(store).snapshot(
    tenant,
    scope,
    "sync",
  );
  if (stream?.provider !== "lofi") return { kind: "deferred" as const };
  let cursor = await store
    .statement(
      "SELECT * FROM inventory_body_replay_cursors WHERE tenant=? AND scope_id=?",
      tenant,
      scope,
    )
    .first<ReplayCursor>();
  if (cursor && cursor.next_due_at > Date.now())
    return { kind: "deferred" as const };
  if (
    cursor &&
    (cursor.config_version !== stream.configVersion ||
      cursor.credential_version !== stream.credentialVersion ||
      cursor.connection_config !== stream.connectionConfig)
  ) {
    await store.db.batch([
      store.statement(
        "UPDATE inventory_body_replay_requests SET cursor_id=NULL WHERE (tenant,scope_id,cursor_id)=(?,?,?) AND state='pending'",
        tenant,
        scope,
        cursor.id,
      ),
      store.statement(
        "DELETE FROM inventory_body_replay_cursors WHERE (tenant,scope_id,id,version)=(?,?,?,?)",
        tenant,
        scope,
        cursor.id,
        cursor.version,
      ),
    ]);
    cursor = null;
  }
  if (!cursor) {
    const id = randomToken();
    const upper = Date.now();
    const resume = canonical(replayResume(stream, id));
    await store.db.batch([
      store.statement(
        `INSERT INTO inventory_body_replay_cursors(tenant,scope_id,id,config_version,credential_version,connection_config,upper_bound,resume,next_due_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        tenant,
        scope,
        id,
        stream.configVersion,
        stream.credentialVersion,
        stream.connectionConfig,
        upper,
        resume,
        upper,
      ),
      store.statement(
        `UPDATE inventory_body_replay_requests SET cursor_id=?1 WHERE rowid IN(
           SELECT rowid FROM inventory_body_replay_requests WHERE (tenant,scope_id)=(?2,?3) AND state='pending' AND cursor_id IS NULL
           ORDER BY requested_at,payload_id LIMIT ?4)`,
        id,
        tenant,
        scope,
        MAX_TARGETS,
      ),
    ]);
    cursor = {
      tenant,
      scope_id: scope,
      id,
      config_version: stream.configVersion,
      credential_version: stream.credentialVersion,
      connection_config: stream.connectionConfig,
      upper_bound: upper,
      resume,
      next_due_at: upper,
      version: 1,
    };
  }
  await store
    .statement(
      `UPDATE inventory_body_replay_requests AS q SET state='obsolete'
     WHERE (q.tenant,q.scope_id,q.cursor_id,q.state)=(?,?,?,'pending') AND NOT EXISTS(${currentTarget})`,
      tenant,
      scope,
      cursor.id,
    )
    .run();
  const { results: targets } = await store
    .statement(
      `SELECT payload_id,record_key,body_hash,marker FROM inventory_body_replay_requests WHERE (tenant,scope_id,cursor_id,state)=(?,?,?,'pending')`,
      tenant,
      scope,
      cursor.id,
    )
    .all<ReplayTarget>();
  if (!targets.length) {
    await store
      .statement(
        "DELETE FROM inventory_body_replay_cursors WHERE (tenant,scope_id,id,version)=(?,?,?,?)",
        tenant,
        scope,
        cursor.id,
        cursor.version,
      )
      .run();
    return { kind: "complete" as const, restored: 0 };
  }
  const connection = await store.connection(tenant, stream.connection);
  const session =
    connection && connection.credential_version === stream.credentialVersion
      ? await openSourceCredentials(store, connection).catch(() => null)
      : null;
  const args = [
    tenant,
    scope,
    cursor.id,
    cursor.version,
    lease.token,
    lease.fence,
  ] as const;
  const delay = (next: number, resume = cursor.resume) =>
    store.statement(
      `UPDATE inventory_body_replay_cursors AS c SET next_due_at=?7,resume=?8,version=version+1 WHERE ${currentCursor}`,
      ...args,
      next,
      resume,
    );
  if (!session) {
    await delay(Date.now() + RETRY_MS).run();
    return { kind: "deferred" as const };
  }
  const pacing = await inventorySourcePacing(store, stream);
  const adapter = createLoFiInventoryAdapter(session.credentials, {
    allowLargePages: true,
  });
  const page = await adapter.readStep(
    {
      transport: inventoryVendorFetch(store, stream, lease, fetcher, {
        priority: "background",
        sourceDelayMs: pacing.loopDelayMs,
      }),
      limits: {
        maxRequests: 3,
        maxResponseBytes: 8 * 1024 * 1024,
        maxRecords: 2000,
        deadlineAt: Date.now() + 45_000,
      },
    },
    {
      binding: {
        scope,
        configVersion: stream.configVersion,
        queryBinding: cursor.id,
      },
      resume: JSON.parse(cursor.resume) as SyncState,
      fixedUpperBound: cursor.upper_bound,
      pageSize: 1000,
    },
  );
  await session.persistTokenState(adapter.credentialsSnapshot());
  if (page.kind !== "page") {
    const next =
      page.kind === "deferred" ? page.retryAt : Date.now() + RETRY_MS;
    const resume =
      page.kind === "blocked" && page.recovery === "restart"
        ? canonical(replayResume(stream, cursor.id))
        : cursor.resume;
    await delay(next, resume).run();
    return { kind: "deferred" as const };
  }
  const restore: D1PreparedStatement[] = [];
  let restored = 0;
  const pending = new Map(targets.map((target) => [target.record_key, target]));
  for (const observation of page.observations) {
    const target = pending.get(observation.key);
    if (
      !target ||
      observation.family !== "qso" ||
      observation.subtype !== "qso" ||
      observation.status !== "active" ||
      (await sha256(canonical(observation.body))) !== target.body_hash
    )
      continue;
    const encrypted = await seal(
      observation.body,
      {
        tenant,
        connection: stream.connection,
        id: target.payload_id,
        kind: "inventory_source",
        purpose: "storage",
      },
      store.keys,
    );
    restore.push(
      store.statement(
        `INSERT INTO inventory_body_replay_restores(tenant,scope_id,payload_id,cursor_id,cursor_version,lease_token,lease_fence) VALUES(?,?,?,?,?,?,?)`,
        tenant,
        scope,
        target.payload_id,
        cursor.id,
        cursor.version,
        lease.token,
        lease.fence,
      ),
      store.statement(
        `UPDATE inventory_payloads SET envelope=?1,cold=0 WHERE (tenant,scope_id,payload_id,envelope,cold)=(?2,?3,?4,?5,1)`,
        canonical(encrypted),
        tenant,
        scope,
        target.payload_id,
        target.marker,
      ),
      store.statement(
        `UPDATE inventory_body_replay_requests SET state='restored' WHERE (tenant,scope_id,payload_id,cursor_id,state)=(?,?,?,?,'pending')`,
        tenant,
        scope,
        target.payload_id,
        cursor.id,
      ),
      store.statement(
        `DELETE FROM inventory_body_replay_restores WHERE (tenant,scope_id,payload_id)=(?,?,?)`,
        tenant,
        scope,
        target.payload_id,
      ),
    );
    pending.delete(observation.key);
    restored++;
  }
  const complete =
    pending.size === 0 || page.progress.kind === "observed_complete";
  const next = Math.max(
    Date.now() + 5_000,
    page.nextReadAt ?? Date.now() + (pacing.loopDelayMs ?? 20_000),
  );
  const progress = delay(next, canonical(page.progress.resume));
  const committed = complete
    ? await store.db.batch([
        ...restore,
        progress,
        store.statement(
          `UPDATE inventory_body_replay_requests SET state='unavailable' WHERE (tenant,scope_id,cursor_id,state)=(?1,?2,?3,'pending') AND EXISTS(SELECT 1 FROM inventory_body_replay_cursors c WHERE (c.tenant,c.scope_id,c.id,c.version)=(?1,?2,?3,?4))`,
          tenant,
          scope,
          cursor.id,
          cursor.version + 1,
        ),
        store.statement(
          `DELETE FROM inventory_body_replay_cursors WHERE (tenant,scope_id,id,version)=(?,?,?,?)`,
          tenant,
          scope,
          cursor.id,
          cursor.version + 1,
        ),
      ])
    : await store.db.batch([...restore, progress]);
  if (!committed[restore.length].meta.changes)
    return { kind: "deferred" as const };
  return {
    kind: complete ? ("complete" as const) : ("continue" as const),
    restored,
  };
}
