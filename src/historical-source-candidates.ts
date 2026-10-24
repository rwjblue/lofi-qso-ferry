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
  lookupSourceHistoricalIndex,
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

/**
 * Resolve the reverse side of one already-unique remote candidate. Every active
 * source participates; the processing queue and ledger state do not define the
 * source census. No location/frequency filtering can turn two owners into one.
 */
export async function historicalSourceCandidates(
  store: Store,
  request: HistoricalSourceCandidateRequest,
): Promise<HistoricalSourceCandidateResult> {
  const tenant = request.tenant;
  const vendor = request.vendor;
  const destination = { ...request.destination };
  const remote = { ...request.remote };
  const selected = { ...request.selected };
  const routeMatches = request.routeMatches;
  const began = Date.now();
  const now = request.now ?? began;
  const currentTime = () => now + Math.max(0, Date.now() - began);
  let inspected = 0;
  let competitors = 0;
  const common = () => ({
    authoritative: false as const,
    coverage: "retained_sources" as const,
    inspected,
    competitors,
  });
  const held = (
    reason: HistoricalSourceCandidateReason,
  ): HistoricalSourceCandidateResult => ({
    ...common(),
    state: "held",
    reason,
  });
  if (
    !integer(now) ||
    !tenant ||
    destination.tenant !== tenant ||
    destination.kind !== vendor ||
    destination.status !== "active" ||
    !selected.source ||
    !selected.qso ||
    !selected.generation
  )
    return held("invalid_request");
  if (!validRouting(destination)) return held("unknown_route");
  // Reuse the matching policy's validation and inclusive minute interval. Do not
  // center this range on the original source, which could miss reverse owners
  // nearly sixty minutes away from that original contact.
  const remoteValidation = historicalCandidates(vendor, remote, [remote]);
  const interval = remoteValidation.candidates[0]?.time.remote;
  if (remoteValidation.state !== "unique" || !interval)
    return held("invalid_remote");
  const indexed = await lookupSourceHistoricalIndex(store, tenant, {
    workedCall: remote.CALL,
    startMs: interval.startMs - HISTORICAL_TIME_WINDOW_MS,
    endMs: interval.endMs + HISTORICAL_TIME_WINDOW_MS,
    limit: HISTORICAL_SOURCE_CANDIDATE_LIMIT,
    now,
  });
  if (indexed.status !== "ready" || !indexed.snapshot)
    return held("index_unavailable");
  if (indexed.rows.length > HISTORICAL_SOURCE_CANDIDATE_LIMIT)
    return held("source_bound");
  const indexGuard = sourceHistoricalIndexGuard(indexed.snapshot);
  // Copy serializations before awaiting any projection work. Later caller edits
  // cannot change either the comparison input or the eventual SQL proof.
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
      JSON.stringify(indexed.rows),
      tenant,
    ),
    store.statement(
      "SELECT 1 AS current FROM connections c JOIN accounts a ON a.id=c.tenant WHERE c.tenant=? AND c.id=? AND c.kind=? AND c.status='active' AND c.config=? AND c.remote_identity=? AND c.credential_version IS ? AND a.status='active'",
      tenant,
      destination.id,
      destination.kind,
      destination.config,
      destination.remote_identity,
      destination.credential_version,
    ),
  ]);
  const headers = loaded[0].results as unknown as Header[];
  const rows = loaded[1].results as unknown as BodyRow[];
  if (!loaded[2].results.length) return held("destination_changed");
  if (
    !headers.length ||
    headers.length > 128 ||
    headers.some((header) => !currentHeader(header, currentTime()))
  )
    return held("source_scope_unavailable");
  const headerBySource = new Map(headers.map((header) => [header.id, header]));
  const indexedByKey = new Map(
    indexed.rows.map((row) => [canonical([row.source, "qso", row.qso]), row]),
  );
  if (
    rows.length !== indexed.rows.length ||
    new Set(rows.map(recordKey)).size !== rows.length ||
    rows.some((row) => {
      const indexedRow = indexedByKey.get(recordKey(row));
      return (
        !indexedRow ||
        !headerBySource.has(row.source) ||
        indexedRow.revision !== row.revision ||
        indexedRow.syncedAt !== row.synced_at ||
        indexedRow.privateId !== row.private_id ||
        indexedRow.bodyVersion !== row.body_version ||
        row.deleted !== 0 ||
        row.is_event !== 0
      );
    })
  )
    return held("source_changed");
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
    return held("dependency_bound");
  // Admit the whole ciphertext cohort before fetching any envelope. A row cap
  // alone would allow many individually valid retained bodies to exceed memory.
  if (allRows.some((row) => !integer(row.body_bytes) || row.body_bytes < 1))
    return held("retained_body_unavailable");
  const bodyBytes = allRows.reduce(
    (sum, row) => sum + (row.body_bytes ?? 0),
    0,
  );
  if (bodyBytes > MAX_CIPHERTEXT_BYTES) return held("dependency_bound");
  const envelopes = allRows.length
    ? (
        await store
          .statement(
            `SELECT json_extract(requested.value,'$.key') AS key,p.envelope
     FROM json_each(?) requested CROSS JOIN private_data p
     ON p.tenant=? AND p.connection=json_extract(requested.value,'$.source') AND p.id=json_extract(requested.value,'$.id') AND p.kind='source'
     WHERE p.source_proof_version=json_extract(requested.value,'$.version')
       AND length(CAST(p.envelope AS BLOB))=json_extract(requested.value,'$.bytes')`,
            JSON.stringify(
              allRows.map((row) => ({
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
  if (envelopes.length !== allRows.length)
    return held("retained_body_unavailable");
  const envelopeByKey = new Map(
    envelopes.map((row) => [row.key, row.envelope]),
  );
  const decoded = new Map<string, SourceRecord>();
  const fences: DependencyFence[] = [];
  for (const row of allRows) {
    const header = headerBySource.get(row.source);
    const envelope = envelopeByKey.get(recordKey(row));
    if (
      !header ||
      !envelope ||
      !row.body_version ||
      row.body_created_at === null ||
      row.body_revoked_at !== null ||
      row.expires_at <= currentTime() ||
      (row.body_expires_at !== null && row.body_expires_at <= currentTime()) ||
      row.policy_seen_epoch !== header.policy_epoch ||
      row.deleted !== 0 ||
      (row.kind === "operation" && row.state !== "context")
    )
      return held("retained_body_unavailable");
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
      )
        return held("source_changed");
      decoded.set(recordKey(row), raw);
      fences.push({
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
      return held("retained_body_unavailable");
    }
  }
  const matches: {
    owner: { source: string; qso: string };
    contact: IntakeContact;
    candidate: HistoricalCandidate;
  }[] = [];
  for (const row of rows) {
    inspected++;
    const header = headerBySource.get(row.source);
    const raw = decoded.get(recordKey(row));
    if (!header || !integer(header.context_generation) || !raw)
      return held("source_changed");
    const operation = row.operation_id
      ? decoded.get(
          recordKey({
            source: row.source,
            kind: "operation",
            id: row.operation_id,
          }),
        )
      : null;
    if (row.operation_id && !operation)
      return held("source_projection_unavailable");
    const events = dependencies
      .filter(
        (dependency) =>
          dependency.source === row.source &&
          dependency.kind === "qso" &&
          dependency.operation_id === row.operation_id,
      )
      .flatMap((dependency) => {
        const value = decoded.get(recordKey(dependency));
        return value ? [value] : [];
      });
    let contact: IntakeContact;
    try {
      contact = {
        ...(await projectContact(raw, operation ?? null, events, {
          operationComplete: true,
        })),
        contextGeneration: header.context_generation,
        ...(row.reconciliation_version === null
          ? {}
          : { reconciliationVersion: row.reconciliation_version }),
      };
    } catch (error) {
      if (
        error instanceof ProjectionError &&
        error.code === "test_operation_not_exported"
      )
        continue;
      return held("source_projection_unavailable");
    }
    try {
      if (!routeMatches(destination, contact)) continue;
    } catch {
      return held("unknown_route");
    }
    const comparison = historicalCandidates(
      vendor,
      contactReconciliationAdif(contact),
      [remote],
    );
    if (comparison.state === "invalid" || comparison.state === "ambiguous")
      return held("unknown_candidate");
    if (comparison.state === "unique") {
      matches.push({
        owner: { source: row.source, qso: row.id },
        contact,
        candidate: comparison.candidates[0],
      });
      competitors++;
    }
  }
  if (matches.length !== 1)
    return { ...common(), state: matches.length ? "ambiguous" : "none" };
  const match = matches[0];
  if (
    match.owner.source !== selected.source ||
    match.owner.qso !== selected.qso ||
    match.contact.generation !== selected.generation
  )
    return held("selected_source_changed");
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
  const commitGuard = (commitTime: number): SqlGuard => {
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
  // Do not return a unique result that is already stale after projection. The
  // identical predicate must still be ANDed into the later adoption transaction.
  const guard = commitGuard(currentTime());
  const current = await store
    .statement(`SELECT 1 AS current WHERE ${guard.sql}`, ...guard.params)
    .first();
  if (!current) return held("source_changed");
  return { ...common(), state: "unique", ...match, commitGuard };
}
