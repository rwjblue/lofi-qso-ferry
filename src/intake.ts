import { destinationAdapter } from "./destination-adapters.ts";
import { isDestinationKind } from "./providers.ts";
import { recordBirth } from "./cutover.ts";
import { lofiAccountLabel } from "./lofi-identity.ts";
import type {
  LoFiCredentials,
  SourceRecord,
  SyncPage,
  SyncState,
} from "./lofi.ts";
import { LoFiClient, LoFiError } from "./lofi.ts";
import type { Contact } from "./projection.ts";
import {
  isEventRecord,
  isSourceDeleted,
  projectContact,
} from "./projection.ts";
import { canonical, randomToken, sha256 } from "./security.ts";
import type { Connection, Store } from "./store.ts";
import type { VendorPriority } from "./vendor-requests.ts";
import { VendorDeferredError, vendorFetch } from "./vendor-requests.ts";
export interface IntakeContact extends Contact {
  contextGeneration: number;
}
export interface Work {
  tenant: string;
  source: string;
  id: string;
  kind: "operation" | "qso";
  operation_id: string | null;
  private_id: string;
  revision: string;
  state: string;
  reason: string | null;
  expires_at: number;
  synced_at: number;
  is_event: number;
  seen_epoch: string | null;
  deleted: number;
  priority: VendorPriority;
}

/** Arrival provenance drives scheduling; the QSO's date does not. */
function liveWorkSql(alias: string): string {
  return `(${alias}.priority='live' OR EXISTS(SELECT 1 FROM source_births b WHERE b.tenant=${alias}.tenant AND b.source=${alias}.source AND b.qso=${alias}.id AND b.phase='forward_new') OR EXISTS(SELECT 1 FROM ledger l WHERE l.tenant=${alias}.tenant AND l.source=${alias}.source AND l.qso=${alias}.id AND l.state='changed'))`;
}

export async function contactPriority(
  store: Store,
  source: Pick<Connection, "tenant" | "id">,
  qso: string,
): Promise<VendorPriority> {
  const row = await store
    .statement(
      `SELECT CASE WHEN EXISTS(SELECT 1 FROM source_work w WHERE w.tenant=? AND w.source=? AND w.id=? AND w.kind='qso' AND ${liveWorkSql("w")}) OR EXISTS(SELECT 1 FROM source_births b WHERE b.tenant=? AND b.source=? AND b.qso=? AND b.phase='forward_new') OR EXISTS(SELECT 1 FROM ledger l WHERE l.tenant=? AND l.source=? AND l.qso=? AND l.state='changed') THEN 'live' ELSE 'background' END AS priority`,
      source.tenant,
      source.id,
      qso,
      source.tenant,
      source.id,
      qso,
      source.tenant,
      source.id,
      qso,
    )
    .first<{ priority: VendorPriority }>();
  return row?.priority ?? "background";
}
export interface PollResult {
  pages: number;
  records: number;
  complete: boolean;
  coverage: "client-contract-only";
}
/** A raw page and its work index commit before the opaque source cursor advances. */
export async function pollSource(
  store: Store,
  connection: Connection,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  stream = "sync",
  vendorNow: number | null = now,
): Promise<PollResult> {
  const lease = await store.claim(
    connection.tenant,
    `poll:${connection.id}:${stream}`,
    now,
    90_000,
  );
  if (!lease)
    return {
      pages: 0,
      records: 0,
      complete: false,
      coverage: "client-contract-only",
    };
  try {
    const credentials = connection.credential_version
      ? await store.private<LoFiCredentials>(
          connection.tenant,
          connection.id,
          connection.credential_version,
          "credential",
        )
      : null;
    if (!credentials || connection.status !== "active")
      throw new Error("source_connection_unavailable");
    const cursor = await store
      .statement(
        "SELECT cursor,generation FROM cursors WHERE tenant=? AND connection=? AND stream=?",
        connection.tenant,
        connection.id,
        stream,
      )
      .first<{ cursor: string; generation: number }>();
    const config = JSON.parse(connection.config) as { accountId?: string };
    const state: SyncState = cursor
      ? JSON.parse(cursor.cursor)
      : {
          mode: "backfill",
          operations: {},
          qsos: {},
          accountId: config.accountId,
        };
    if (
      stream !== "sync" &&
      (state as SyncState & { rescanComplete?: boolean }).rescanComplete
    )
      return {
        pages: 0,
        records: 0,
        complete: true,
        coverage: "client-contract-only",
      };
    const priority: VendorPriority =
      stream === "sync" && state.mode === "forward" ? "live" : "background";
    const client = new LoFiClient(
      credentials,
      vendorFetch(store, "lofi", fetcher, {
        priority,
        ...(vendorNow === null ? {} : { now: vendorNow }),
      }),
    );
    let page: SyncPage;
    try {
      page = await client.syncPage(state, now, priority === "live" ? 100 : 25);
    } catch (error) {
      await recoverSourceGap(store, connection, error, now, stream);
      throw error;
    }
    const checkpointGuard = sourceGuard(store, connection);
    const work: D1PreparedStatement[] = [checkpointGuard.sql];
    for (const [kind, rows] of [
      ["operation", page.operations],
      ["qso", page.qsos],
    ] as const)
      for (const raw of rows) {
        if (kind === "qso")
          work.push(
            recordBirth(
              store,
              connection.tenant,
              connection.id,
              String(raw.uuid),
              stream,
              isSourceDeleted(raw) || isEventRecord(raw)
                ? "backfill"
                : state.mode,
              (cursor?.generation ?? 0) + 1,
              now,
            ),
          );
        work.push(
          ...(await sourceStatements(
            store,
            connection,
            kind,
            raw,
            now,
            undefined,
            priority,
            stream === "repair"
              ? null
              : stream.startsWith("rescan:")
                ? stream.slice(7)
                : undefined,
          )),
        );
      }
    work.push(
      store.statement(
        "UPDATE connections SET last_poll_at=?,label=CASE WHEN ?='sync' AND ? THEN ? ELSE label END,config=CASE WHEN ?='sync' THEN json_set(json_remove(config,'$.lastError'),'$.lastSuccessfulPollAt',?,'$.accountEmail',CASE WHEN ? THEN ? ELSE json_extract(config,'$.accountEmail') END) ELSE config END WHERE tenant=? AND id=? AND status='active'",
        now,
        stream,
        Number(page.accountEmail !== undefined),
        lofiAccountLabel(page.accountEmail),
        stream,
        now,
        Number(page.accountEmail !== undefined),
        page.accountEmail ?? null,
        connection.tenant,
        connection.id,
      ),
    );
    if (stream === "sync") {
      work.push(
        store.statement(
          "INSERT INTO cursors(tenant,connection,stream,cursor,generation,updated_at) VALUES(?,?,'context',?,1,?) ON CONFLICT(tenant,connection,stream) DO UPDATE SET cursor=excluded.cursor,generation=generation+1,updated_at=excluded.updated_at",
          connection.tenant,
          connection.id,
          JSON.stringify({
            complete: page.complete,
            syncComplete: page.complete,
            coverage: page.coverage,
          }),
          now,
        ),
      );
    } else {
      work.push(
        store.statement(
          "UPDATE cursors SET generation=generation+1,updated_at=? WHERE tenant=? AND connection=? AND stream='context'",
          now,
          connection.tenant,
          connection.id,
        ),
      );
    }
    work.push(
      store.statement(
        "DELETE FROM source_write_guards WHERE id=?",
        checkpointGuard.id,
      ),
    );
    await store.checkpoint(
      lease,
      connection.id,
      stream,
      cursor?.generation ?? 0,
      stream === "sync"
        ? page.next
        : { ...page.next, rescanComplete: page.complete },
      work,
      now,
    );
    return {
      pages: 1,
      records: page.operations.length + page.qsos.length,
      complete: page.complete,
      coverage: page.coverage,
    };
  } finally {
    await store.release(lease);
  }
}
export async function pendingContacts(
  store: Store,
  source: Connection,
  limit = 40,
  now = Date.now(),
  priority?: VendorPriority,
  qso?: string,
): Promise<IntakeContact[]> {
  return (await pendingContactBatch(store, source, limit, now, priority, qso))
    .contacts;
}
export async function pendingContactBatch(
  store: Store,
  source: Connection,
  limit = 40,
  now = Date.now(),
  priority?: VendorPriority,
  qso?: string,
  processedBefore?: number,
): Promise<{ contacts: IntakeContact[]; selected: number }> {
  const context = await store
    .statement(
      "SELECT cursor,generation FROM cursors WHERE tenant=? AND connection=? AND stream='context'",
      source.tenant,
      source.id,
    )
    .first<{ cursor: string; generation: number }>();
  if (
    !context ||
    !(JSON.parse(context.cursor) as { complete: boolean }).complete
  )
    return { contacts: [], selected: 0 };
  const rows = (
    await store
      .statement(
        `SELECT w.* FROM source_work w WHERE w.tenant=? AND w.source=? AND w.kind='qso' AND w.state IN('pending','waiting') AND w.expires_at>? ${priority ? `AND ${liveWorkSql("w")}=${priority === "live" ? 1 : 0}` : ""} ${qso === undefined ? "" : "AND w.id=?"} ${processedBefore === undefined ? "" : "AND w.processed_at<?"} ORDER BY ${liveWorkSql("w")} DESC,w.processed_at,w.id LIMIT ?`,
        source.tenant,
        source.id,
        now,
        ...(qso === undefined ? [] : [qso]),
        ...(processedBefore === undefined ? [] : [processedBefore]),
        limit,
      )
      .all<Work>()
  ).results;
  const contacts: IntakeContact[] = [];
  for (const row of rows) {
    if (processedBefore !== undefined)
      await store
        .statement(
          "UPDATE source_work SET processed_at=? WHERE tenant=? AND source=? AND id=? AND kind='qso' AND revision=?",
          now,
          row.tenant,
          row.source,
          row.id,
          row.revision,
        )
        .run();
    try {
      const raw = await store.private<SourceRecord>(
        row.tenant,
        row.source,
        row.private_id,
        "source",
      );
      if (!raw) throw new Error("source_payload_expired");
      if (isSourceDeleted(raw)) {
        const guard = randomToken();
        await store.db.batch([
          store.statement(
            "INSERT INTO projection_guards VALUES(?,?,?,?,?,?)",
            guard,
            row.tenant,
            row.source,
            context.generation,
            now,
            null,
          ),
          store.statement(
            "UPDATE ledger SET state='source_deleted',reason='remote history retained' WHERE tenant=? AND source=? AND qso=?",
            row.tenant,
            row.source,
            row.id,
          ),
          store.statement(
            "INSERT INTO attempt_events(tenant,attempt,state,at,reason) SELECT s.tenant,s.attempt,'cancelled',?,'source tombstone' FROM attempt_state s JOIN attempts a ON a.tenant=s.tenant AND a.id=s.attempt WHERE s.tenant=? AND s.state='prepared' AND a.source=? AND a.qso=?",
            now,
            row.tenant,
            row.source,
            row.id,
          ),
          store.statement(
            "UPDATE attempt_state SET state='cancelled',updated_at=? WHERE tenant=? AND state='prepared' AND attempt IN(SELECT id FROM attempts WHERE tenant=? AND source=? AND qso=?)",
            now,
            row.tenant,
            row.tenant,
            row.source,
            row.id,
          ),
          store.statement(
            "UPDATE source_work SET state='processed' WHERE tenant=? AND source=? AND id=? AND kind='qso' AND revision=?",
            row.tenant,
            row.source,
            row.id,
            row.revision,
          ),
          store.statement("DELETE FROM projection_guards WHERE id=?", guard),
        ]);
        continue;
      }
      if (isEventRecord(raw)) {
        await store
          .statement(
            "UPDATE source_work SET state='context' WHERE tenant=? AND source=? AND id=? AND kind='qso' AND revision=?",
            row.tenant,
            row.source,
            row.id,
            row.revision,
          )
          .run();
        continue;
      }
      let operation: SourceRecord | null = null;
      const events: SourceRecord[] = [];
      if (row.operation_id) {
        const dependencies = (
          await store
            .statement(
              "SELECT * FROM source_work WHERE tenant=? AND source=? AND operation_id=? AND (kind='operation' OR is_event=1)",
              row.tenant,
              row.source,
              row.operation_id,
            )
            .all<Work>()
        ).results;
        for (const dependency of dependencies) {
          if (dependency.kind === "qso" && dependency.deleted) continue;
          if (dependency.expires_at <= now)
            throw new Error("operation_context_expired");
          const value = await store.private<SourceRecord>(
            row.tenant,
            row.source,
            dependency.private_id,
            "source",
          );
          if (!value) throw new Error("operation_context_unavailable");
          if (dependency.kind === "operation") operation = value;
          else if (isEventRecord(value)) events.push(value);
        }
        if (
          !operation ||
          dependencies.some(
            (d) => d.kind === "operation" && d.state !== "context",
          ) ||
          isSourceDeleted(operation)
        )
          throw new Error("operation_context_unavailable");
      }
      const contact = await projectContact(raw, operation, events, {
        operationComplete: true,
      });
      contacts.push({ ...contact, contextGeneration: context.generation });
    } catch (error) {
      const reason =
        error instanceof Error && /^[a-z_]+$/.test(error.message)
          ? error.message
          : "source_projection_requires_review";
      await store
        .statement(
          "UPDATE source_work SET state='blocked',reason=? WHERE tenant=? AND source=? AND id=? AND kind='qso' AND revision=?",
          reason,
          row.tenant,
          row.source,
          row.id,
          row.revision,
        )
        .run();
    }
  }
  return { contacts, selected: rows.length };
}
/** Fingerprints are per destination; a narrative edit cannot create LoTW work. */
export async function observeContact(
  store: Store,
  source: Connection,
  contact: IntakeContact,
  now = Date.now(),
  routedDestinations?: Connection[],
) {
  const settings = await store
    .statement("SELECT quiet_minutes FROM accounts WHERE id=?", source.tenant)
    .first<{ quiet_minutes: number }>();
  const destinations =
    routedDestinations ??
    (await store.connections(source.tenant)).filter(
      (c) => isDestinationKind(c.kind) && c.status === "active",
    );
  if (
    destinations.some(
      (destination) =>
        destination.tenant !== source.tenant ||
        !isDestinationKind(destination.kind) ||
        destination.status !== "active",
    )
  )
    throw new Error("invalid_destination_scope");
  const guard = randomToken();
  const updates: D1PreparedStatement[] = [
    store.statement(
      "INSERT INTO projection_guards VALUES(?,?,?,?,?,?)",
      guard,
      source.tenant,
      source.id,
      contact.contextGeneration,
      now,
      contact.operationId,
    ),
  ];
  if (routedDestinations !== undefined) {
    const existing = (
      await store
        .statement(
          "SELECT destination,remote_id,state FROM ledger WHERE tenant=? AND source=? AND qso=?",
          source.tenant,
          source.id,
          contact.id,
        )
        .all<{ destination: string; remote_id: string | null; state: string }>()
    ).results;
    const routed = new Set(destinations.map((destination) => destination.id));
    for (const previous of existing) {
      if (routed.has(previous.destination)) continue;
      updates.push(
        store.statement(
          "UPDATE ledger SET prior_route_state=COALESCE(prior_route_state,state),state='retained_old_route',reason='Source now routes elsewhere; prior association retained' WHERE tenant=? AND source=? AND qso=? AND destination=?",
          source.tenant,
          source.id,
          contact.id,
          previous.destination,
        ),
      );
      updates.push(
        store.statement(
          "INSERT INTO attempt_events(tenant,attempt,state,at,reason) SELECT s.tenant,s.attempt,'cancelled',?,'source routing changed before dispatch' FROM attempt_state s JOIN attempts a ON a.tenant=s.tenant AND a.id=s.attempt WHERE s.tenant=? AND s.state='prepared' AND a.source=? AND a.qso=? AND a.destination=?",
          now,
          source.tenant,
          source.id,
          contact.id,
          previous.destination,
        ),
      );
      updates.push(
        store.statement(
          "UPDATE attempt_state SET state='cancelled',updated_at=?,reason='source routing changed before dispatch' WHERE tenant=? AND state='prepared' AND attempt IN(SELECT id FROM attempts WHERE tenant=? AND source=? AND qso=? AND destination=?)",
          now,
          source.tenant,
          source.tenant,
          source.id,
          contact.id,
          previous.destination,
        ),
      );
    }
  }
  for (const destination of destinations) {
    if (!isDestinationKind(destination.kind))
      throw new Error("invalid_destination_scope");
    const key = {
      tenant: source.tenant,
      source: source.id,
      qso: contact.id,
      destination: destination.id,
    };
    const previous = await store.ledger(key);
    const hash = await destinationAdapter(destination.kind).fingerprint(
      contact,
      previous?.narrative === "remote_preserved",
    );
    updates.push(
      store.statement(
        "UPDATE ledger SET state=COALESCE(prior_route_state,state),prior_route_state=NULL,reason=NULL WHERE tenant=? AND source=? AND qso=? AND destination=? AND state='retained_old_route'",
        key.tenant,
        key.source,
        key.qso,
        key.destination,
      ),
    );
    updates.push(
      store.observation(
        key,
        contact.generation,
        hash,
        settings?.quiet_minutes ?? 30,
        contact.deleted,
        now,
      ),
    );
    updates.push(
      store.statement(
        "UPDATE ledger SET context_generation=?,operation_id=? WHERE tenant=? AND source=? AND qso=? AND destination=?",
        contact.contextGeneration,
        contact.operationId,
        key.tenant,
        key.source,
        key.qso,
        key.destination,
      ),
    );
  }
  const changedPrepared =
    "SELECT a.id FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id JOIN ledger l ON l.tenant=a.tenant AND l.source=a.source AND l.qso=a.qso AND l.destination=a.destination WHERE a.tenant=? AND a.source=? AND a.qso=? AND s.state='prepared' AND a.source_hash!=l.source_hash";
  updates.push(
    store.statement(
      `INSERT INTO attempt_events(tenant,attempt,state,at,reason) SELECT tenant,id,'cancelled',?,'source changed before dispatch' FROM attempts WHERE tenant=? AND id IN(${changedPrepared})`,
      now,
      source.tenant,
      source.tenant,
      source.id,
      contact.id,
    ),
  );
  updates.push(
    store.statement(
      `DELETE FROM private_data WHERE tenant=? AND kind='outbox' AND id IN(${changedPrepared})`,
      source.tenant,
      source.tenant,
      source.id,
      contact.id,
    ),
  );
  updates.push(
    store.statement(
      `UPDATE attempt_state SET state='cancelled',reason='source changed before dispatch',updated_at=? WHERE tenant=? AND attempt IN(${changedPrepared})`,
      now,
      source.tenant,
      source.tenant,
      source.id,
      contact.id,
    ),
  );
  updates.push(
    store.statement("DELETE FROM projection_guards WHERE id=?", guard),
  );
  await store.db.batch(updates);
}
export async function expireSource(store: Store, now = Date.now()) {
  await store.db.batch([
    store.statement(
      "DELETE FROM cursors WHERE stream LIKE 'gap:%' AND updated_at<=?",
      now - 30 * 86400_000,
    ),
    // Recovery uses its own historical cursor; forward coverage and cutovers
    // stay intact. An incomplete repair is never restarted by older expiries.
    store.statement(
      "INSERT INTO cursors(tenant,connection,stream,cursor,generation,updated_at) SELECT c.tenant,c.id,'repair',json_object('mode','backfill','operations',json('{}'),'qsos',json('{}'),'accountId',json_extract(c.config,'$.accountId'),'rescanComplete',json('false')),0,? FROM connections c LEFT JOIN cursors r ON r.tenant=c.tenant AND r.connection=c.id AND r.stream='repair' WHERE c.kind='lofi' AND c.status='active' AND EXISTS(SELECT 1 FROM source_work w WHERE w.tenant=c.tenant AND w.source=c.id AND w.kind='qso' AND w.is_event=0 AND w.state!='archived' AND w.expires_at<=? AND (r.cursor IS NULL OR w.state!='expired' OR w.expires_at>r.updated_at)) ON CONFLICT(tenant,connection,stream) DO UPDATE SET cursor=excluded.cursor,generation=cursors.generation+1,updated_at=excluded.updated_at WHERE COALESCE(json_extract(cursors.cursor,'$.rescanComplete'),0)=1",
      now,
      now,
    ),
    // Keep dependency metadata until a complete operation reread classifies it.
    store.statement(
      "UPDATE source_work SET state='pending',reason='operation_context_expired' WHERE kind='operation' AND EXISTS(SELECT 1 FROM source_work w WHERE w.tenant=source_work.tenant AND w.source=source_work.source AND w.operation_id=source_work.id AND w.expires_at<=? AND (w.kind='operation' OR w.is_event=1))",
      now,
    ),
    store.statement(
      "UPDATE ledger SET state='inventory_pending',reason='source_buffer_expired_requires_reread' WHERE EXISTS(SELECT 1 FROM source_work w WHERE w.tenant=ledger.tenant AND w.source=ledger.source AND w.id=ledger.qso AND w.expires_at<=?) AND state NOT IN('delivered','observed','adopted_existing','source_deleted')",
      now,
    ),
    // There is no verified selective base-operation GET; refresh expired bases
    // by replaying the source, while event-only expiry uses the operation read.
    // An active backfill already covers these bases: retain its committed pages
    // until it reaches the expired operation instead of restarting each tick.
    store.statement(
      "UPDATE cursors SET cursor=json_object('mode','backfill','operations',json('{}'),'qsos',json('{}'),'accountId',json_extract((SELECT config FROM connections c WHERE c.tenant=cursors.tenant AND c.id=cursors.connection),'$.accountId')),generation=generation+1 WHERE stream='sync' AND COALESCE(json_extract(cursor,'$.mode'),'')!='backfill' AND EXISTS(SELECT 1 FROM source_work w WHERE w.tenant=cursors.tenant AND w.source=cursors.connection AND w.expires_at<=? AND w.kind='operation')",
      now,
    ),
    store.statement(
      "UPDATE cursors SET cursor=json_set(cursor,'$.complete',CASE WHEN EXISTS(SELECT 1 FROM source_work w WHERE w.tenant=cursors.tenant AND w.source=cursors.connection AND w.kind='operation' AND w.expires_at<=?) THEN 0 ELSE json_extract(cursor,'$.syncComplete') END),generation=generation+1 WHERE stream='context' AND EXISTS(SELECT 1 FROM source_work w WHERE w.tenant=cursors.tenant AND w.source=cursors.connection AND w.expires_at<=? AND (w.kind='operation' OR w.is_event=1))",
      now,
      now,
    ),
    store.statement(
      "UPDATE source_work SET state='expired',reason='source payload expired; current reread required' WHERE expires_at<=? AND kind='qso' AND is_event=0 AND state!='archived'",
      now,
    ),
  ]);
}
function sourceGuard(
  store: Store,
  connection: Connection,
  record?: Pick<Work, "id" | "kind" | "synced_at"> & {
    revision: string | null;
  },
) {
  const id = randomToken();
  return {
    id,
    sql: store.statement(
      "INSERT INTO source_write_guards VALUES(?,?,?,?,?,?,?,?)",
      id,
      connection.tenant,
      connection.id,
      record?.id ?? null,
      record?.kind ?? null,
      record?.synced_at ?? null,
      record?.revision ?? null,
      connection.credential_version,
    ),
  };
}
/** Merge overlapping reads by server timestamp and compare-and-set the row. */
async function sourceStatements(
  store: Store,
  connection: Connection,
  kind: "operation" | "qso",
  raw: SourceRecord,
  now: number,
  epoch?: string,
  incomingPriority: VendorPriority = "background",
  replayDestination?: string | null,
): Promise<D1PreparedStatement[]> {
  const id = String(raw.uuid);
  const syncedAt = Number(raw.syncedAtMillis);
  if (!Number.isSafeInteger(syncedAt) || syncedAt < 0)
    throw new Error("missing_server_watermark");
  const previous = await store
    .statement(
      "SELECT * FROM source_work WHERE tenant=? AND source=? AND id=? AND kind=?",
      connection.tenant,
      connection.id,
      id,
      kind,
    )
    .first<Work>();
  const { syncedAtMillis: _stamp, ...inputs } = raw;
  const revision = await sha256(canonical(inputs));
  if (
    previous &&
    previous.synced_at === syncedAt &&
    previous.revision !== revision
  )
    throw new Error("conflicting_server_timestamp_requires_reconciliation");
  const guard = sourceGuard(
    store,
    connection,
    previous ?? { id, kind, synced_at: 0, revision: null },
  );
  // A null expected revision means an insert compare-and-set.
  const statements: D1PreparedStatement[] = [guard.sql];
  const seen = () => {
    if (epoch)
      statements.push(
        store.statement(
          "UPDATE source_work SET seen_epoch=? WHERE tenant=? AND source=? AND id=? AND kind=? AND operation_id IS ?",
          epoch,
          connection.tenant,
          connection.id,
          id,
          kind,
          typeof raw.operation === "string" ? raw.operation : null,
        ),
      );
    statements.push(
      store.statement("DELETE FROM source_write_guards WHERE id=?", guard.id),
    );
    return statements;
  };
  if (previous && previous.synced_at > syncedAt) return seen();
  if (
    replayDestination !== undefined &&
    kind === "qso" &&
    !isEventRecord(raw) &&
    previous?.revision === revision
  ) {
    const resolved = await store
      .statement(
        "SELECT 1 resolved WHERE EXISTS(SELECT 1 FROM ledger l WHERE l.tenant=?1 AND l.source=?2 AND l.qso=?3 AND (?4 IS NULL OR l.destination=?4)) AND NOT EXISTS(SELECT 1 FROM ledger l WHERE l.tenant=?1 AND l.source=?2 AND l.qso=?3 AND (?4 IS NULL OR l.destination=?4) AND (l.state NOT IN('adopted_existing','delivered','observed','source_deleted') OR l.source_hash IS NOT l.baseline_hash)) AND NOT EXISTS(SELECT 1 FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE a.tenant=?1 AND a.source=?2 AND a.qso=?3 AND (?4 IS NULL OR a.destination=?4) AND s.state NOT IN('delivered','observed','rejected','cancelled'))",
        connection.tenant,
        connection.id,
        id,
        replayDestination,
      )
      .first();
    if (resolved) return seen();
  }
  if (previous && previous.revision === revision && previous.expires_at > now) {
    if (syncedAt > previous.synced_at)
      statements.push(
        store.statement(
          "UPDATE source_work SET synced_at=? WHERE tenant=? AND source=? AND id=? AND kind=?",
          syncedAt,
          connection.tenant,
          connection.id,
          id,
          kind,
        ),
      );
    return seen();
  }
  const priority: VendorPriority =
    previous?.priority === "live" ||
    (incomingPriority === "live" && previous?.revision !== revision)
      ? "live"
      : "background";
  const privateId = randomToken();
  const deleted = isSourceDeleted(raw);
  const event =
    kind === "qso" &&
    (isEventRecord(raw) || (deleted && Boolean(previous?.is_event)));
  const expires = now + (kind === "operation" || event ? 30 : 7) * 86400_000;
  const op =
    kind === "operation"
      ? id
      : typeof raw.operation === "string"
        ? raw.operation
        : raw.operation === null
          ? null
          : (previous?.operation_id ?? null);
  statements.push(
    await store.putPrivate(
      connection.tenant,
      connection.id,
      privateId,
      "source",
      raw,
      expires,
    ),
  );
  statements.push(
    store.statement(
      "DELETE FROM private_data WHERE tenant=? AND connection=? AND kind='source' AND id IN(SELECT private_id FROM source_work WHERE tenant=? AND source=? AND id=? AND kind=?)",
      connection.tenant,
      connection.id,
      connection.tenant,
      connection.id,
      id,
      kind,
    ),
  );
  statements.push(
    store.statement(
      "INSERT INTO source_work(tenant,source,id,kind,operation_id,private_id,revision,expires_at,synced_at,is_event,deleted,seen_epoch,priority) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant,source,id,kind) DO UPDATE SET operation_id=excluded.operation_id,private_id=excluded.private_id,state='pending',reason=NULL,revision=excluded.revision,expires_at=excluded.expires_at,synced_at=excluded.synced_at,is_event=excluded.is_event,deleted=excluded.deleted,seen_epoch=COALESCE(excluded.seen_epoch,source_work.seen_epoch),priority=CASE WHEN source_work.priority='live' THEN 'live' ELSE excluded.priority END",
      connection.tenant,
      connection.id,
      id,
      kind,
      op,
      privateId,
      revision,
      expires,
      syncedAt,
      event ? 1 : 0,
      deleted ? 1 : 0,
      epoch ?? null,
      priority,
    ),
  );
  if (kind === "operation" || event) {
    statements.push(
      store.statement(
        "UPDATE source_work SET state='pending',reason='operation_context_changed',priority=CASE WHEN ?='live' THEN 'live' ELSE priority END WHERE tenant=? AND source=? AND operation_id=?",
        priority,
        connection.tenant,
        connection.id,
        op,
      ),
    );
    // Keep adoption baselines and mapped correction states: a context reread
    // must not turn a known delivered record into an initial backfill.
    statements.push(
      store.statement(
        "UPDATE ledger SET reason='operation_context_changed_requires_reread' WHERE tenant=? AND source=? AND operation_id=?",
        connection.tenant,
        connection.id,
        op,
      ),
    );
  }
  statements.push(
    store.statement("DELETE FROM source_write_guards WHERE id=?", guard.id),
  );
  return statements;
}
/** Bounded full-operation reread, with durable page membership and safe replay. */
export async function rereadOperation(
  store: Store,
  connection: Connection,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  priority?: VendorPriority,
  vendorNow: number | null = now,
  processedBefore?: number,
) {
  const startedAt = Date.now();
  const liveOperation = `(w.priority='live' OR EXISTS(SELECT 1 FROM source_work q WHERE q.tenant=w.tenant AND q.source=w.source AND q.operation_id=w.id AND q.kind='qso' AND ${liveWorkSql("q")}))`;
  const operation = await store
    .statement(
      `SELECT w.*,CASE WHEN ${liveOperation} THEN 'live' ELSE 'background' END AS request_priority FROM source_work w WHERE w.tenant=? AND w.source=? AND w.kind='operation' AND w.state='pending' AND w.deleted=0 AND w.expires_at>? ${priority ? `AND ${liveOperation}=${priority === "live" ? 1 : 0}` : ""} ${processedBefore === undefined ? "" : "AND w.processed_at<?"} ORDER BY ${liveOperation} DESC,w.processed_at,w.id LIMIT 1`,
      connection.tenant,
      connection.id,
      now,
      ...(processedBefore === undefined ? [] : [processedBefore]),
    )
    .first<Work & { request_priority: VendorPriority }>();
  if (!operation) return { complete: true, records: 0, pages: 0 };
  const lease = await store.claim(
    connection.tenant,
    `reread:${connection.id}`,
    now,
    90_000,
  );
  if (!lease) return { complete: false, records: 0, pages: 0 };
  try {
    const credentials = connection.credential_version
      ? await store.private<LoFiCredentials>(
          connection.tenant,
          connection.id,
          connection.credential_version,
          "credential",
        )
      : null;
    if (!credentials || connection.status !== "active")
      throw new Error("source_connection_unavailable");
    if (
      !(await store.private(
        connection.tenant,
        connection.id,
        operation.private_id,
        "source",
      ))
    )
      throw new Error("operation_payload_unavailable");
    const stream = `reread:${operation.id}`;
    const saved = await store
      .statement(
        "SELECT cursor,generation FROM cursors WHERE tenant=? AND connection=? AND stream=?",
        connection.tenant,
        connection.id,
        stream,
      )
      .first<{ cursor: string; generation: number }>();
    const previous = saved
      ? (JSON.parse(saved.cursor) as {
          cursor?: number;
          since?: number;
          revision: string;
          complete?: boolean;
          epoch?: string;
        })
      : null;
    const state =
      previous &&
      previous.revision === operation.revision &&
      !previous.complete &&
      previous.epoch
        ? previous
        : { revision: operation.revision, epoch: randomToken() };
    const page = await new LoFiClient(
      credentials,
      vendorFetch(store, "lofi", fetcher, {
        priority: operation.request_priority,
        ...(vendorNow === null ? {} : { now: vendorNow }),
      }),
    ).operationQsosPage(
      operation.id,
      state,
      operation.request_priority === "live" ? 100 : 25,
    );
    const guard = sourceGuard(store, connection, operation);
    const work: D1PreparedStatement[] = [guard.sql];
    for (const raw of page.qsos) {
      work.push(
        recordBirth(
          store,
          connection.tenant,
          connection.id,
          String(raw.uuid),
          stream,
          "backfill",
          (saved?.generation ?? 0) + 1,
          now,
        ),
      );
      work.push(
        ...(await sourceStatements(
          store,
          connection,
          "qso",
          raw,
          now,
          state.epoch,
        )),
      );
    }
    if (page.complete) {
      // Complete read coverage is not proof that an unseen old event was
      // deleted. Retain compact unresolved evidence and retry a fresh epoch.
      work.push(
        store.statement(
          "UPDATE source_work SET state=CASE WHEN EXISTS(SELECT 1 FROM source_work q WHERE q.tenant=? AND q.source=? AND q.operation_id=? AND q.kind='qso' AND q.is_event=1 AND q.deleted=0 AND (q.seen_epoch IS NULL OR q.seen_epoch!=?)) THEN 'pending' ELSE 'context' END,reason=CASE WHEN EXISTS(SELECT 1 FROM source_work q WHERE q.tenant=? AND q.source=? AND q.operation_id=? AND q.kind='qso' AND q.is_event=1 AND q.deleted=0 AND (q.seen_epoch IS NULL OR q.seen_epoch!=?)) THEN 'event_absence_requires_reconciliation' ELSE NULL END,processed_at=? WHERE tenant=? AND source=? AND id=? AND kind='operation' AND revision=?",
          connection.tenant,
          connection.id,
          operation.id,
          state.epoch ?? null,
          connection.tenant,
          connection.id,
          operation.id,
          state.epoch ?? null,
          now,
          connection.tenant,
          connection.id,
          operation.id,
          operation.revision,
        ),
      );
      work.push(
        store.statement(
          "UPDATE source_work SET state='pending',reason=NULL WHERE tenant=? AND source=? AND operation_id=? AND kind='qso' AND seen_epoch=?",
          connection.tenant,
          connection.id,
          operation.id,
          state.epoch ?? null,
        ),
      );
      work.push(
        store.statement(
          "UPDATE source_work SET state='missing_from_reread',reason='not observed in completed operation read' WHERE tenant=? AND source=? AND operation_id=? AND kind='qso' AND deleted=0 AND (seen_epoch IS NULL OR seen_epoch!=?)",
          connection.tenant,
          connection.id,
          operation.id,
          state.epoch ?? null,
        ),
      );
      work.push(
        store.statement(
          "UPDATE ledger SET reason='source_member_absent_from_complete_operation_reread' WHERE tenant=? AND source=? AND operation_id=? AND NOT EXISTS(SELECT 1 FROM source_work q WHERE q.tenant=ledger.tenant AND q.source=ledger.source AND q.id=ledger.qso AND q.kind='qso' AND q.seen_epoch=?)",
          connection.tenant,
          connection.id,
          operation.id,
          state.epoch ?? null,
        ),
      );
      work.push(
        store.statement(
          "DELETE FROM private_data WHERE tenant=? AND connection=? AND kind='source' AND expires_at<=? AND id IN(SELECT private_id FROM source_work WHERE tenant=? AND source=? AND operation_id=? AND seen_epoch IS NOT ?)",
          connection.tenant,
          connection.id,
          now,
          connection.tenant,
          connection.id,
          operation.id,
          state.epoch ?? null,
        ),
      );
      work.push(
        store.statement(
          "UPDATE source_work SET state='context' WHERE tenant=? AND source=? AND operation_id=? AND kind='qso' AND is_event=1 AND deleted=1 AND seen_epoch IS NOT ?",
          connection.tenant,
          connection.id,
          operation.id,
          state.epoch ?? null,
        ),
      );
    } else {
      work.push(
        store.statement(
          "UPDATE source_work SET processed_at=?,reason=NULL WHERE tenant=? AND source=? AND id=? AND kind='operation' AND revision=?",
          now,
          connection.tenant,
          connection.id,
          operation.id,
          operation.revision,
        ),
      );
    }
    work.push(
      store.statement(
        "UPDATE cursors SET generation=generation+1 WHERE tenant=? AND connection=? AND stream='context'",
        connection.tenant,
        connection.id,
      ),
    );
    work.push(
      store.statement("DELETE FROM source_write_guards WHERE id=?", guard.id),
    );
    await store.checkpoint(
      lease,
      connection.id,
      stream,
      saved?.generation ?? 0,
      {
        ...page.next,
        revision: operation.revision,
        epoch: state.epoch,
        complete: page.complete,
      },
      work,
      now,
    );
    return { complete: page.complete, records: page.qsos.length, pages: 1 };
  } catch (error) {
    if (error instanceof VendorDeferredError) throw error;
    // A failed read must consume its scheduling turn without asserting any
    // coverage. Guard the diagnostic so an old request cannot mark a newer
    // source revision, renewed connection or another tenant.
    const guard = sourceGuard(store, connection, operation);
    await store.db.batch([
      guard.sql,
      store.statement(
        "UPDATE source_work SET processed_at=?,reason='operation_read_failed_retrying' WHERE tenant=? AND source=? AND id=? AND kind='operation' AND revision=? AND state='pending' AND EXISTS(SELECT 1 FROM leases WHERE tenant=? AND scope=? AND token=? AND fence=? AND expires_at>?)",
        now,
        connection.tenant,
        connection.id,
        operation.id,
        operation.revision,
        connection.tenant,
        lease.scope,
        lease.token,
        lease.fence,
        now + Math.max(0, Date.now() - startedAt),
      ),
      store.statement("DELETE FROM source_write_guards WHERE id=?", guard.id),
    ]);
    throw error;
  } finally {
    await store.release(lease);
  }
}

/** A protocol gap restarts read-only reconciliation, never destination history. */
export async function recoverSourceGap(
  store: Store,
  connection: Connection,
  error: unknown,
  now = Date.now(),
  stream = "sync",
): Promise<boolean> {
  if (
    !(error instanceof LoFiError) ||
    ![
      "cursor_or_record_reconciliation_required",
      "repeated_cursor",
      "timestamp_pagination_stalled",
    ].includes(error.code)
  )
    return false;
  const lease = await store.claim(
    connection.tenant,
    `recover:${connection.id}:${stream}`,
    now,
    60_000,
  );
  if (!lease) return false;
  try {
    const saved = await store
      .statement(
        "SELECT cursor,generation FROM cursors WHERE tenant=? AND connection=? AND stream=?",
        connection.tenant,
        connection.id,
        stream,
      )
      .first<{ cursor: string; generation: number }>();
    const gap = `gap:${randomToken()}`;
    const config = JSON.parse(connection.config) as { accountId?: string };
    const reset = {
      mode: "backfill",
      operations: {},
      qsos: {},
      ...(config.accountId ? { accountId: config.accountId } : {}),
    };
    const guard = sourceGuard(store, connection);
    await store.checkpoint(
      lease,
      connection.id,
      stream,
      saved?.generation ?? 0,
      reset,
      [
        guard.sql,
        store.statement(
          "INSERT INTO cursors(tenant,connection,stream,cursor,generation,updated_at) VALUES(?,?,?,?,1,?)",
          connection.tenant,
          connection.id,
          gap,
          JSON.stringify({
            stream,
            code: error.code,
            previous: saved ? JSON.parse(saved.cursor) : null,
            observedAt: now,
          }),
          now,
        ),
        store.statement(
          "UPDATE cursors SET generation=generation+1,cursor=json_set(cursor,'$.complete',0,'$.syncComplete',0),updated_at=? WHERE tenant=? AND connection=? AND stream='context'",
          now,
          connection.tenant,
          connection.id,
        ),
        store.statement(
          "UPDATE source_work SET state='pending',reason='source cursor gap requires reconciliation' WHERE tenant=? AND source=? AND kind='operation'",
          connection.tenant,
          connection.id,
        ),
        store.statement(
          "UPDATE ledger SET reason='Source cursor gap; read-only reconciliation required before new delivery' WHERE tenant=? AND source=?",
          connection.tenant,
          connection.id,
        ),
        store.statement("DELETE FROM source_write_guards WHERE id=?", guard.id),
      ],
      now,
    );
    return true;
  } finally {
    await store.release(lease);
  }
}
