import type { AdifRecord } from "./adif.ts";
import { contactReconciliationAdif } from "./delivery.ts";
import {
  HISTORICAL_TIME_WINDOW_MS,
  type HistoricalCandidate,
  type HistoricalVendor,
  historicalCandidates,
} from "./historical-matching.ts";
import type { IntakeContact, Work } from "./intake.ts";
import type { SourceRecord } from "./lofi.ts";
import {
  isEventRecord,
  isSourceDeleted,
  ProjectionError,
  projectContact,
} from "./projection.ts";
import { canonical, type Envelope, open, sha256 } from "./security.ts";
import {
  lookupSourceHistoricalIndexBatch,
  type SourceHistoricalIndexLookup,
  type SourceHistoricalIndexRow,
  sourceHistoricalIndexGuard,
} from "./source-historical-index.ts";
import type { Connection, Store } from "./store.ts";

export const HISTORICAL_SOURCE_CANDIDATE_LIMIT = 128;
export const HISTORICAL_SOURCE_DEPENDENCY_LIMIT = 256;
const MAX_CIPHERTEXT_BYTES = 4 * 1024 * 1024;

type SqlGuard = { sql: string; params: (string | number | null)[] };
export interface HistoricalSourceCandidateRequest {
  tenant: string;
  destination: Connection;
  remote: AdifRecord;
  selected: { source: string; qso: string; generation: string };
  vendor: HistoricalVendor;
  /** The caller's normal routing predicate. Unknown/invalid routes must throw. */
  routeMatches: (destination: Connection, contact: IntakeContact) => boolean;
  now?: number;
}
export type HistoricalSourceCandidateReason =
  | "invalid_request"
  | "invalid_remote"
  | "index_unavailable"
  | "source_bound"
  | "cohort_bound"
  | "source_scope_unavailable"
  | "destination_changed"
  | "source_changed"
  | "dependency_bound"
  | "retained_body_unavailable"
  | "source_projection_unavailable"
  | "unknown_route"
  | "unknown_candidate"
  | "selected_source_changed";
export type HistoricalSourceCandidateResult = {
  authoritative: false;
  /** Coverage is the current retained source inventory, not an upstream claim. */
  coverage: "retained_sources";
  inspected: number;
  competitors: number;
} & (
  | {
      state: "held";
      reason: HistoricalSourceCandidateReason;
    }
  | { state: "none" | "ambiguous" }
  | {
      state: "unique";
      owner: { source: string; qso: string };
      contact: IntakeContact;
      candidate: HistoricalCandidate;
      commitGuard: (now: number) => SqlGuard;
    }
);

interface Header extends Connection {
  policy_epoch: string | null;
  sync_generation: number | null;
  context_generation: number | null;
  context_cursor: string | null;
  credential_id: string | null;
  credential_revoked_at: number | null;
  credential_expires_at: number | null;
}
interface BodyRow extends Work {
  body_bytes: number | null;
  body_version: string | null;
  body_created_at: number | null;
  body_expires_at: number | null;
  body_revoked_at: number | null;
  reconciliation_version: number | null;
}
interface DependencyFence {
  source: string;
  kind: string;
  id: string;
  work: (string | number | null)[];
  body: (string | number | null)[];
}

const bodyColumns = `w.*,length(CAST(p.envelope AS BLOB)) AS body_bytes,p.source_proof_version AS body_version,
 p.created_at AS body_created_at,p.expires_at AS body_expires_at,
 p.revoked_at AS body_revoked_at,r.version AS reconciliation_version`;
const bodyJoin = `LEFT JOIN private_data p ON p.tenant=w.tenant AND p.connection=w.source AND p.id=w.private_id AND p.kind='source'
 LEFT JOIN reconciliation_work r ON r.tenant=w.tenant AND r.source=w.source AND r.qso=w.id AND w.kind='qso'`;
const recordKey = (row: Pick<Work, "source" | "kind" | "id">) =>
  canonical([row.source, row.kind, row.id]);
const operationKey = (source: string, operation: string) =>
  canonical([source, operation]);
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function validRouting(destination: Connection): boolean {
  try {
    const config = JSON.parse(destination.config) as Record<string, unknown>;
    const call = (value: unknown) =>
      typeof value === "string" &&
      /^[A-Z0-9]+(?:\/[A-Z0-9]+)*$/i.test(value) &&
      /[A-Z]/i.test(value) &&
      /[0-9]/.test(value);
    if (destination.kind === "qrz") {
      const date = (value: unknown): value is string => {
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
          return false;
        const instant = Date.parse(`${value}T00:00:00Z`);
        return (
          Number.isFinite(instant) &&
          new Date(instant).toISOString().slice(0, 10) === value
        );
      };
      return (
        call(config.stationCallsign) &&
        date(config.startDate) &&
        date(config.endDate) &&
        config.startDate <= config.endDate
      );
    }
    const stations = Array.isArray(config.stations)
      ? config.stations
      : [config.station];
    return (
      stations.length > 0 &&
      stations.every(
        (station) =>
          station &&
          typeof station === "object" &&
          call(station.callsign) &&
          integer(station.dxcc) &&
          station.dxcc > 0,
      )
    );
  } catch {
    return false;
  }
}

function currentHeader(header: Header, now: number): boolean {
  try {
    const context = JSON.parse(header.context_cursor ?? "null") as {
      complete?: unknown;
      syncComplete?: unknown;
    } | null;
    return Boolean(
      header.policy_epoch &&
        integer(header.sync_generation) &&
        integer(header.context_generation) &&
        context?.complete === true &&
        context.syncComplete === true &&
        header.credential_id &&
        header.credential_id === header.credential_version &&
        header.credential_revoked_at === null &&
        (header.credential_expires_at === null ||
          header.credential_expires_at > now),
    );
  } catch {
    return false;
  }
}

export type HistoricalSourceCandidateBatchRequest = Omit<
  HistoricalSourceCandidateRequest,
  "tenant" | "now"
>;

function resultBase(inspected = 0, competitors = 0) {
  return {
    authoritative: false as const,
    coverage: "retained_sources" as const,
    inspected,
    competitors,
  };
}
function held(
  reason: HistoricalSourceCandidateReason,
  inspected = 0,
  competitors = 0,
): HistoricalSourceCandidateResult {
  return { ...resultBase(inspected, competitors), state: "held", reason };
}

type Operation = { source: string; id: string };
function comparisonGuard(
  tenant: string,
  destination: Connection,
  indexGuard: SqlGuard,
  headers: Header[],
  fences: DependencyFence[],
  operations: Operation[],
  now: number,
): (commitTime: number) => SqlGuard {
  const headerJson = JSON.stringify(
    headers.map((header) => ({
      source: header.id,
      remote: header.remote_identity,
      config: header.config,
      credential: header.credential_version,
      epoch: header.policy_epoch,
      sync: header.sync_generation,
      context: header.context_generation,
    })),
  );
  const dependencyJson = JSON.stringify(fences);
  const operationJson = JSON.stringify(operations);
  return (commitTime: number): SqlGuard => {
    if (!integer(commitTime) || commitTime < now)
      return { sql: "0", params: [] };
    return {
      sql: `(${indexGuard.sql})
       AND EXISTS(SELECT 1 FROM connections d JOIN accounts a ON a.id=d.tenant WHERE d.tenant=? AND d.id=? AND d.kind=? AND d.status='active' AND d.config=? AND d.remote_identity=? AND d.credential_version IS ? AND a.status='active')
       AND NOT EXISTS(SELECT 1 FROM json_each(?) h WHERE NOT EXISTS(
        SELECT 1 FROM connections c JOIN source_read_policy_ready ready ON ready.tenant=c.tenant AND ready.source=c.id
        JOIN cursors context ON context.tenant=c.tenant AND context.connection=c.id AND context.stream='context'
        JOIN private_data credential ON credential.tenant=c.tenant AND credential.connection=c.id AND credential.id=c.credential_version AND credential.kind='credential'
        WHERE c.tenant=? AND c.id=json_extract(h.value,'$.source') AND c.config=json_extract(h.value,'$.config')
         AND c.remote_identity=json_extract(h.value,'$.remote') AND c.credential_version IS json_extract(h.value,'$.credential')
         AND ready.epoch=json_extract(h.value,'$.epoch') AND ready.sync_generation=json_extract(h.value,'$.sync') AND context.generation=json_extract(h.value,'$.context')
         AND json_extract(context.cursor,'$.complete')=1 AND json_extract(context.cursor,'$.syncComplete')=1
         AND credential.revoked_at IS NULL AND (credential.expires_at IS NULL OR credential.expires_at>MAX(?,CAST(unixepoch('subsec')*1000 AS INTEGER)))))
       AND NOT EXISTS(SELECT 1 FROM json_each(?) dependency WHERE NOT EXISTS(
        SELECT 1 FROM source_work w JOIN private_data p ON p.tenant=w.tenant AND p.connection=w.source AND p.id=w.private_id AND p.kind='source'
        WHERE w.tenant=? AND w.source=json_extract(dependency.value,'$.source') AND w.kind=json_extract(dependency.value,'$.kind') AND w.id=json_extract(dependency.value,'$.id')
         AND json_array(w.revision,w.synced_at,w.private_id,w.operation_id,w.deleted,w.is_event,w.policy_seen_epoch)=json_extract(dependency.value,'$.work')
         AND json_array(p.source_proof_version,p.created_at)=json_extract(dependency.value,'$.body')
         AND w.expires_at>MAX(?,CAST(unixepoch('subsec')*1000 AS INTEGER)) AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>MAX(?,CAST(unixepoch('subsec')*1000 AS INTEGER))) AND (w.kind!='operation' OR w.state='context')))
       AND NOT EXISTS(SELECT 1 FROM json_each(?) operation CROSS JOIN source_work e INDEXED BY source_context_members
        ON e.tenant=? AND e.source=json_extract(operation.value,'$.source') AND e.operation_id=json_extract(operation.value,'$.id') AND e.kind='qso' AND e.is_event=1
        WHERE e.deleted=0 AND NOT EXISTS(SELECT 1 FROM json_each(?) dependency WHERE json_extract(dependency.value,'$.source')=e.source AND json_extract(dependency.value,'$.kind')=e.kind AND json_extract(dependency.value,'$.id')=e.id))`,
      params: [
        ...indexGuard.params,
        tenant,
        destination.id,
        destination.kind,
        destination.config,
        destination.remote_identity,
        destination.credential_version,
        headerJson,
        tenant,
        commitTime,
        dependencyJson,
        tenant,
        commitTime,
        commitTime,
        operationJson,
        tenant,
        dependencyJson,
      ],
    };
  };
}

/** Resolve one already-unique remote through the same bounded batch path. */
export async function historicalSourceCandidates(
  store: Store,
  request: HistoricalSourceCandidateRequest,
): Promise<HistoricalSourceCandidateResult> {
  const { tenant, now, ...input } = request;
  return (
    await historicalSourceCandidatesBatch(store, tenant, [input], { now })
  )[0];
}

/**
 * Share reads/projection within one bounded invocation, never comparison verdicts.
 * Every active source participates regardless of queue/ledger state. Per-request
 * candidate closure and current commit guards survive the shared snapshot.
 */
export async function historicalSourceCandidatesBatch(
  store: Store,
  tenant: string,
  requests: readonly HistoricalSourceCandidateBatchRequest[],
  options: { now?: number } = {},
): Promise<HistoricalSourceCandidateResult[]> {
  if (requests.length > 20) throw new Error("historical_source_batch_bound");
  if (!requests.length) return [];
  const began = Date.now();
  const now = options.now ?? began;
  const currentTime = () => now + Math.max(0, Date.now() - began);
  // Freeze every caller-owned primitive before the first key/database await.
  const captured = requests.map((request) => ({
    ...request,
    destination: { ...request.destination },
    remote: { ...request.remote },
    selected: { ...request.selected },
  }));
  const results: (HistoricalSourceCandidateResult | undefined)[] = captured.map(
    () => undefined,
  );
  const valid: { index: number; startMs: number; endMs: number }[] = [];
  for (const [index, request] of captured.entries()) {
    const { destination, selected, vendor, remote } = request;
    if (
      !integer(now) ||
      !tenant ||
      destination.tenant !== tenant ||
      destination.kind !== vendor ||
      destination.status !== "active" ||
      !selected.source ||
      !selected.qso ||
      !selected.generation
    ) {
      results[index] = held("invalid_request");
      continue;
    }
    if (!validRouting(destination)) {
      results[index] = held("unknown_route");
      continue;
    }
    // Center on the remote interval: a reverse owner can be almost sixty
    // minutes from the selected source. Never manufacture seconds for HHMM.
    const validation = historicalCandidates(vendor, remote, [remote]);
    const interval = validation.candidates[0]?.time.remote;
    if (validation.state !== "unique" || !interval) {
      results[index] = held("invalid_remote");
      continue;
    }
    valid.push({
      index,
      startMs: interval.startMs - HISTORICAL_TIME_WINDOW_MS,
      endMs: interval.endMs + HISTORICAL_TIME_WINDOW_MS,
    });
  }
  const finish = () =>
    results.map((result) => result ?? held("source_changed"));
  if (!valid.length) return finish();
  const lookups = await lookupSourceHistoricalIndexBatch(
    store,
    tenant,
    valid.map((item) => ({
      workedCall: captured[item.index].remote.CALL,
      startMs: item.startMs,
      endMs: item.endMs,
      limit: HISTORICAL_SOURCE_CANDIDATE_LIMIT,
      now,
    })),
  );
  const active: { index: number; lookup: SourceHistoricalIndexLookup }[] = [];
  const indexedByKey = new Map<string, SourceHistoricalIndexRow>();
  for (const [offset, item] of valid.entries()) {
    const lookup = lookups[offset];
    if (lookup.status !== "ready" || !lookup.snapshot) {
      results[item.index] = held(
        lookup.reason === "cohort_bound" ? "cohort_bound" : "index_unavailable",
      );
      continue;
    }
    if (lookup.rows.length > HISTORICAL_SOURCE_CANDIDATE_LIMIT) {
      results[item.index] = held("source_bound");
      continue;
    }
    active.push({ index: item.index, lookup });
    for (const row of lookup.rows) {
      const key = recordKey({ source: row.source, kind: "qso", id: row.qso });
      const prior = indexedByKey.get(key);
      if (prior && canonical(prior) !== canonical(row)) {
        for (const item of valid)
          results[item.index] ??= held("source_changed");
        return finish();
      }
      indexedByKey.set(key, row);
    }
  }
  const stop = (reason: HistoricalSourceCandidateReason) => {
    for (const item of active) results[item.index] ??= held(reason);
    return finish();
  };
  if (!active.length) return finish();
  if (indexedByKey.size > HISTORICAL_SOURCE_CANDIDATE_LIMIT)
    return stop(active.length > 1 ? "cohort_bound" : "source_bound");
  const loaded = await store.db.batch([
    store.statement(
      `SELECT c.*,ready.epoch AS policy_epoch,ready.sync_generation,
       context.generation AS context_generation,context.cursor AS context_cursor,
       credential.id AS credential_id,credential.revoked_at AS credential_revoked_at,
       credential.expires_at AS credential_expires_at
       FROM connections c
       LEFT JOIN source_read_policy_ready ready ON ready.tenant=c.tenant AND ready.source=c.id
       LEFT JOIN cursors context ON context.tenant=c.tenant AND context.connection=c.id AND context.stream='context'
       LEFT JOIN private_data credential ON credential.tenant=c.tenant AND credential.connection=c.id AND credential.id=c.credential_version AND credential.kind='credential'
       WHERE c.tenant=? AND c.kind='lofi' AND c.status='active' LIMIT 129`,
      tenant,
    ),
    store.statement(
      `SELECT ${bodyColumns} FROM json_each(?) requested
       CROSS JOIN source_work w ON w.tenant=? AND w.source=json_extract(requested.value,'$.source') AND w.id=json_extract(requested.value,'$.qso') AND w.kind='qso' ${bodyJoin}`,
      JSON.stringify([...indexedByKey.values()]),
      tenant,
    ),
    store.statement(
      `SELECT requested.key AS request_index FROM json_each(?) requested
       JOIN connections c ON c.tenant=? AND c.id=json_extract(requested.value,'$.id')
       JOIN accounts a ON a.id=c.tenant
       WHERE c.kind=json_extract(requested.value,'$.kind') AND c.status='active'
       AND c.config=json_extract(requested.value,'$.config') AND c.remote_identity=json_extract(requested.value,'$.remote_identity')
       AND c.credential_version IS json_extract(requested.value,'$.credential_version') AND a.status='active'`,
      JSON.stringify(captured.map((request) => request.destination)),
      tenant,
    ),
  ]);
  const headers = loaded[0].results as unknown as Header[];
  const rows = loaded[1].results as unknown as BodyRow[];
  const currentDestinations = new Set(
    loaded[2].results.map((row) =>
      Number((row as { request_index: number }).request_index),
    ),
  );
  for (const item of active)
    if (!currentDestinations.has(item.index))
      results[item.index] = held("destination_changed");
  if (
    !headers.length ||
    headers.length > 128 ||
    headers.some((header) => !currentHeader(header, currentTime()))
  )
    return stop("source_scope_unavailable");
  const headerBySource = new Map(headers.map((header) => [header.id, header]));
  const rowByKey = new Map(rows.map((row) => [recordKey(row), row]));
  if (
    rowByKey.size !== rows.length ||
    rows.some((row) => !indexedByKey.has(recordKey(row)))
  )
    return stop("source_changed");
  const failures = new Map<string, HistoricalSourceCandidateReason>();
  for (const [key, indexed] of indexedByKey) {
    const row = rowByKey.get(key);
    if (
      !row ||
      !headerBySource.has(row.source) ||
      indexed.revision !== row.revision ||
      indexed.syncedAt !== row.synced_at ||
      indexed.privateId !== row.private_id ||
      indexed.bodyVersion !== row.body_version ||
      row.deleted !== 0 ||
      row.is_event !== 0
    )
      failures.set(key, "source_changed");
  }
  const operations = [
    ...new Map(
      rows.flatMap((row) =>
        row.operation_id
          ? [
              [
                operationKey(row.source, row.operation_id),
                { source: row.source, id: row.operation_id },
              ] as const,
            ]
          : [],
      ),
    ).values(),
  ];
  const dependencies = operations.length
    ? (
        await store
          .statement(
            `SELECT ${bodyColumns} FROM json_each(?1) requested
     CROSS JOIN source_work w ON w.tenant=?2 AND w.source=json_extract(requested.value,'$.source') AND w.kind='operation' AND w.id=json_extract(requested.value,'$.id') ${bodyJoin}
     UNION ALL SELECT ${bodyColumns} FROM json_each(?1) requested
     CROSS JOIN source_work w INDEXED BY source_context_members ON w.tenant=?2 AND w.source=json_extract(requested.value,'$.source') AND w.operation_id=json_extract(requested.value,'$.id') AND w.kind='qso' AND w.is_event=1 ${bodyJoin}
     WHERE w.deleted=0 LIMIT 257`,
            JSON.stringify(operations),
            tenant,
          )
          .all<BodyRow>()
      ).results
    : [];
  const allRows = [...rows, ...dependencies];
  if (
    allRows.length > HISTORICAL_SOURCE_DEPENDENCY_LIMIT ||
    new Set(allRows.map(recordKey)).size !== allRows.length
  )
    return stop(active.length > 1 ? "cohort_bound" : "dependency_bound");
  // The one union, not each request, owns the ciphertext and dependency budget.
  let bodyBytes = 0;
  for (const row of allRows) {
    const key = recordKey(row),
      header = headerBySource.get(row.source);
    if (!integer(row.body_bytes) || row.body_bytes < 1)
      failures.set(key, "retained_body_unavailable");
    else bodyBytes += row.body_bytes;
    if (
      !header ||
      !row.body_version ||
      row.body_created_at === null ||
      row.body_revoked_at !== null ||
      row.expires_at <= currentTime() ||
      (row.body_expires_at !== null && row.body_expires_at <= currentTime()) ||
      row.policy_seen_epoch !== header.policy_epoch ||
      row.deleted !== 0 ||
      (row.kind === "operation" && row.state !== "context")
    )
      failures.set(key, "retained_body_unavailable");
  }
  if (bodyBytes > MAX_CIPHERTEXT_BYTES)
    return stop(active.length > 1 ? "cohort_bound" : "dependency_bound");
  const readable = allRows.filter((row) => !failures.has(recordKey(row)));
  const envelopes = readable.length
    ? (
        await store
          .statement(
            `SELECT json_extract(requested.value,'$.key') AS key,p.envelope
     FROM json_each(?) requested CROSS JOIN private_data p
     ON p.tenant=? AND p.connection=json_extract(requested.value,'$.source') AND p.id=json_extract(requested.value,'$.id') AND p.kind='source'
     WHERE p.source_proof_version=json_extract(requested.value,'$.version')
       AND length(CAST(p.envelope AS BLOB))=json_extract(requested.value,'$.bytes')`,
            JSON.stringify(
              readable.map((row) => ({
                key: recordKey(row),
                source: row.source,
                id: row.private_id,
                version: row.body_version,
                bytes: row.body_bytes,
              })),
            ),
            tenant,
          )
          .all<{ key: string; envelope: string }>()
      ).results
    : [];
  const envelopeByKey = new Map(
    envelopes.map((row) => [row.key, row.envelope]),
  );
  const decoded = new Map<string, SourceRecord>();
  const fences = new Map<string, DependencyFence>();
  for (const row of readable) {
    const key = recordKey(row),
      envelope = envelopeByKey.get(key);
    if (!envelope) {
      failures.set(key, "retained_body_unavailable");
      continue;
    }
    try {
      const raw = await open<SourceRecord>(
        JSON.parse(envelope) as Envelope,
        {
          tenant: row.tenant,
          connection: row.source,
          id: row.private_id,
          kind: "source",
          purpose: "storage",
        },
        store.keys,
      );
      const { syncedAtMillis: _serverStamp, ...semantic } = raw;
      if (
        raw.uuid !== row.id ||
        !integer(raw.syncedAtMillis) ||
        raw.syncedAtMillis > row.synced_at ||
        (await sha256(canonical(semantic))) !== row.revision ||
        isSourceDeleted(raw) ||
        (row.kind === "operation" && row.operation_id !== row.id) ||
        (row.kind === "qso" &&
          ((raw.operation ?? null) !== row.operation_id ||
            isEventRecord(raw) !== Boolean(row.is_event)))
      ) {
        failures.set(key, "source_changed");
        continue;
      }
      decoded.set(key, raw);
      fences.set(key, {
        source: row.source,
        kind: row.kind,
        id: row.id,
        work: [
          row.revision,
          row.synced_at,
          row.private_id,
          row.operation_id,
          row.deleted,
          row.is_event,
          row.policy_seen_epoch ?? null,
        ],
        body: [row.body_version, row.body_created_at],
      });
    } catch {
      failures.set(key, "retained_body_unavailable");
    }
  }
  // Keep each QSO's full closure, including dependencies of known test records.
  const closure = new Map<string, string[]>();
  const projected = new Map<string, IntakeContact | null>();
  for (const row of rows) {
    const key = recordKey(row);
    const related = row.operation_id
      ? dependencies.filter(
          (dependency) =>
            dependency.source === row.source &&
            dependency.operation_id === row.operation_id,
        )
      : [];
    const keys = [key, ...related.map(recordKey)];
    closure.set(key, keys);
    const failed = keys.map((key) => failures.get(key)).find(Boolean);
    if (failed) {
      failures.set(key, failed);
      continue;
    }
    const header = headerBySource.get(row.source),
      raw = decoded.get(key);
    const operation = row.operation_id
      ? decoded.get(
          recordKey({
            source: row.source,
            kind: "operation",
            id: row.operation_id,
          }),
        )
      : null;
    if (!header || !integer(header.context_generation) || !raw) {
      failures.set(key, "source_changed");
      continue;
    }
    if (row.operation_id && !operation) {
      failures.set(key, "source_projection_unavailable");
      continue;
    }
    const eventRows = related.filter((dependency) => dependency.kind === "qso");
    const events = eventRows.flatMap((dependency) => {
      const value = decoded.get(recordKey(dependency));
      return value ? [value] : [];
    });
    if (events.length !== eventRows.length) {
      failures.set(key, "retained_body_unavailable");
      continue;
    }
    try {
      projected.set(key, {
        ...(await projectContact(raw, operation ?? null, events, {
          operationComplete: true,
        })),
        contextGeneration: header.context_generation,
        ...(row.reconciliation_version === null
          ? {}
          : { reconciliationVersion: row.reconciliation_version }),
      });
    } catch (error) {
      if (
        error instanceof ProjectionError &&
        error.code === "test_operation_not_exported"
      )
        projected.set(key, null);
      else failures.set(key, "source_projection_unavailable");
    }
  }
  for (const { index, lookup } of active) {
    if (results[index]) continue;
    const { destination, selected, remote, vendor, routeMatches } =
      captured[index];
    const keys = lookup.rows.map((row) =>
      recordKey({ source: row.source, kind: "qso", id: row.qso }),
    );
    const failed = keys.map((key) => failures.get(key)).find(Boolean);
    if (failed) {
      results[index] = held(failed);
      continue;
    }
    let inspected = 0;
    const matches: {
      owner: { source: string; qso: string };
      contact: IntakeContact;
      candidate: HistoricalCandidate;
    }[] = [];
    for (const key of keys) {
      inspected++;
      const contact = projected.get(key);
      if (contact === null) continue;
      if (!contact) {
        results[index] = held("source_changed", inspected, matches.length);
        break;
      }
      try {
        if (!routeMatches(destination, contact)) continue;
      } catch {
        results[index] = held("unknown_route", inspected, matches.length);
        break;
      }
      const comparison = historicalCandidates(
        vendor,
        contactReconciliationAdif(contact),
        [remote],
      );
      if (comparison.state === "invalid" || comparison.state === "ambiguous") {
        results[index] = held("unknown_candidate", inspected, matches.length);
        break;
      }
      if (comparison.state === "unique") {
        const row = rowByKey.get(key);
        if (!row) {
          results[index] = held("source_changed", inspected, matches.length);
          break;
        }
        matches.push({
          owner: { source: row.source, qso: row.id },
          contact,
          candidate: comparison.candidates[0],
        });
      }
    }
    if (results[index]) continue;
    const common = resultBase(inspected, matches.length);
    if (matches.length !== 1) {
      results[index] = {
        ...common,
        state: matches.length ? "ambiguous" : "none",
      };
      continue;
    }
    const match = matches[0];
    if (
      match.owner.source !== selected.source ||
      match.owner.qso !== selected.qso ||
      match.contact.generation !== selected.generation
    ) {
      results[index] = held(
        "selected_source_changed",
        inspected,
        matches.length,
      );
      continue;
    }
    const relevant = new Set(keys.flatMap((key) => closure.get(key) ?? []));
    const requestOperations = operations.filter((op) =>
      relevant.has(
        recordKey({ source: op.source, kind: "operation", id: op.id }),
      ),
    );
    const requestFences = [...relevant].flatMap((key) => {
      const fence = fences.get(key);
      return fence ? [fence] : [];
    });
    if (!lookup.snapshot || requestFences.length !== relevant.size) {
      results[index] = held("source_changed", inspected, matches.length);
      continue;
    }
    const commitGuard = comparisonGuard(
      tenant,
      destination,
      sourceHistoricalIndexGuard(lookup.snapshot),
      headers,
      requestFences,
      requestOperations,
      now,
    );
    results[index] = { ...common, state: "unique", ...match, commitGuard };
  }
  // No unique result escapes after a projection-time race. Each identical guard
  // must also be composed with inventory/source CAS at the later native commit.
  const unique = results.flatMap((result, index) =>
    result?.state === "unique" ? [{ index, result }] : [],
  );
  if (unique.length) {
    const checks = await store.db.batch(
      unique.map(({ result }) => {
        const guard = result.commitGuard(currentTime());
        return store.statement(
          `SELECT 1 AS current WHERE ${guard.sql}`,
          ...guard.params,
        );
      }),
    );
    for (const [offset, item] of unique.entries())
      if (!checks[offset].results.length)
        results[item.index] = held(
          "source_changed",
          item.result.inspected,
          item.result.competitors,
        );
  }
  return finish();
}
