import {
  LoFiClient,
  LoFiError,
  type LoFiCredentials,
  type OperationQsosState,
  type SourceRecord,
} from "../src/lofi.ts";
import { isEventRecord } from "../src/projection.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";

const MAX_MEMBERS = 100;
const MAX_READS = 4;
const PAGE_SIZE = 25;
const MAX_DURATION = 120_000;
const MAX_MANIFEST_AGE = 300_000;
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const stamp = (value: unknown): value is number | null =>
  value === null ||
  (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

interface ManifestRecord {
  uuid: string;
  deleted: boolean;
  purged: boolean;
  synced: boolean;
  updatedAtMillis: number | null;
  syncedAtMillis: number | null;
}
export interface OperationManifest {
  origin: "independent-local-database";
  capturedAt: number;
  operation: ManifestRecord;
  members: (ManifestRecord & { operation: string; isEvent: boolean })[];
}

/** One SQLite snapshot, including events and tombstones; never run on Ferry D1. */
export function haloOperationManifestQuery(operation: string) {
  if (!validId(operation)) throw new Error("Invalid manifest scope");
  return {
    sql: `SELECT 'operation' kind,uuid,NULL operation,0 is_event,deleted,purged,synced,
      updated_at_millis,json_extract(data,'$.syncedAtMillis') synced_at_millis
      FROM operations WHERE uuid=?1
      UNION ALL
      SELECT 'qso' kind,uuid,operation,
        CASE WHEN band='event' OR json_extract(data,'$.band')='event' OR
          CASE json_type(data,'$.event')
            WHEN 'object' THEN 1 WHEN 'array' THEN 1 WHEN 'true' THEN 1
            WHEN 'integer' THEN json_extract(data,'$.event')!=0
            WHEN 'real' THEN json_extract(data,'$.event')!=0
            WHEN 'text' THEN json_extract(data,'$.event')!='' ELSE 0 END
          THEN 1 ELSE 0 END is_event,deleted,purged,synced,
        updated_at_millis,json_extract(data,'$.syncedAtMillis') synced_at_millis
      FROM qsos WHERE operation=?1 LIMIT 102`,
    params: [operation] as const,
  };
}

/** Raw rows and UUIDs stay with the caller in memory; this is not a report. */
export function haloOperationManifest(
  rows: unknown,
  capturedAt: number,
): OperationManifest {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_MEMBERS + 1)
    throw new Error("Invalid independent manifest");
  const flag = (value: unknown) => {
    if (value === 0 || value === false || value === null) return false;
    if (value === 1 || value === true) return true;
    throw new Error("Invalid independent manifest");
  };
  const records = rows.map((row: Record<string, unknown>) => ({
    kind: row.kind,
    uuid: row.uuid as string,
    operation: row.operation as string,
    isEvent: flag(row.is_event),
    deleted: flag(row.deleted),
    purged: flag(row.purged),
    synced: flag(row.synced),
    updatedAtMillis: row.updated_at_millis as number | null,
    syncedAtMillis: row.synced_at_millis as number | null,
  }));
  const bases = records.filter((row) => row.kind === "operation");
  if (
    bases.length !== 1 ||
    records.some((row) => !["operation", "qso"].includes(String(row.kind)))
  )
    throw new Error("Invalid independent manifest");
  const manifest: OperationManifest = {
    origin: "independent-local-database",
    capturedAt,
    operation: bases[0],
    members: records.filter((row) => row.kind === "qso"),
  };
  validateManifest(manifest);
  return manifest;
}

function validateManifest(value: OperationManifest) {
  if (
    value.origin !== "independent-local-database" ||
    !stamp(value.capturedAt) ||
    value.capturedAt === null ||
    !Array.isArray(value.members) ||
    value.members.length > MAX_MEMBERS ||
    !value.operation ||
    !validId(value.operation.uuid)
  )
    throw new Error("Invalid independent manifest");
  const ids = new Set<string>();
  for (const row of [value.operation, ...value.members]) {
    if (
      !validId(row.uuid) ||
      !stamp(row.updatedAtMillis) ||
      !stamp(row.syncedAtMillis) ||
      [row.deleted, row.purged, row.synced].some(
        (flag) => typeof flag !== "boolean",
      )
    )
      throw new Error("Invalid independent manifest");
  }
  for (const row of value.members) {
    if (
      row.operation !== value.operation.uuid ||
      typeof row.isEvent !== "boolean" ||
      ids.has(row.uuid)
    )
      throw new Error("Invalid independent manifest");
    ids.add(row.uuid);
  }
}

function manifestKey(manifest: OperationManifest) {
  const key = (row: ManifestRecord) => [
    row.uuid,
    row.deleted,
    row.purged,
    row.synced,
    row.updatedAtMillis,
    row.syncedAtMillis,
  ];
  return JSON.stringify([
    key(manifest.operation),
    [...manifest.members]
      .sort((a, b) => a.uuid.localeCompare(b.uuid))
      .map((row) => [...key(row), row.operation, row.isEvent]),
  ]);
}

type Stop =
  | "read_cap"
  | "time_cap"
  | "manifest_expired"
  | "manifest_changed"
  | "manifest_unsynced"
  | "manifest_invalid"
  | "account_changed"
  | "authentication_required"
  | "vendor_deferred"
  | "vendor_unavailable"
  | "protocol_error"
  | "empty_incomplete_page"
  | "conflicting_duplicate"
  | "member_cap"
  | "page_size_exceeded"
  | "transport_denied";
class ProbeStop extends Error {
  constructor(readonly code: Stop) {
    super(code);
  }
}
interface Metadata {
  uuid: string;
  operation: string;
  isEvent: boolean;
  deleted: boolean;
  purged: boolean;
  updatedAtMillis: number | null;
  syncedAtMillis: number;
}
function metadata(raw: SourceRecord, operation: string): Metadata {
  const flag = (value: unknown) => {
    if (
      value === undefined ||
      value === null ||
      value === false ||
      value === 0 ||
      value === "0" ||
      value === "false"
    )
      return false;
    if (value === true || value === 1 || value === "1" || value === "true")
      return true;
    throw new ProbeStop("protocol_error");
  };
  if (
    !validId(raw.uuid) ||
    raw.operation !== operation ||
    !stamp(raw.syncedAtMillis) ||
    raw.syncedAtMillis === null ||
    !stamp(raw.updatedAtMillis ?? null)
  )
    throw new ProbeStop("protocol_error");
  return {
    uuid: raw.uuid,
    operation,
    isEvent: isEventRecord(raw),
    deleted: flag(raw.deleted),
    purged: flag(raw.purged),
    updatedAtMillis: (raw.updatedAtMillis as number | undefined) ?? null,
    syncedAtMillis: raw.syncedAtMillis,
  };
}
const recordKey = (row: Metadata) =>
  JSON.stringify([
    row.operation,
    row.isEvent,
    row.deleted,
    row.purged,
    row.updatedAtMillis,
    row.syncedAtMillis,
  ]);

/**
 * Bounded observation only. The injected fetcher must already enforce the shared
 * vendor budget. No filesystem, credentials loading, database writes or renewal.
 * loadManifest must read the independent local database again on its second call.
 */
export async function probeOperationReplay(options: {
  credentials: LoFiCredentials;
  accountId: string;
  operationId: string;
  loadManifest: () => Promise<OperationManifest>;
  fetcher: typeof fetch;
  now?: () => number;
}) {
  const clock = options.now ?? Date.now;
  const started = clock();
  const report = {
    evidence: "observed-operation-replay" as const,
    sourceBoundaryVerified: false as const,
    serverBaseOperationObserved: false as const,
    unknownHistoricalPurgesExcluded: false as const,
    status: "incomplete" as
      | "incomplete"
      | "observed_match"
      | "discrepancy"
      | "unavailable",
    stopReason: null as Stop | null,
    readAttempts: 0,
    pages: 0,
    completedPasses: 0,
    elapsedMs: 0,
    expectedMembers: 0,
    expectedEvents: 0,
    expectedDeleted: 0,
    expectedPurged: 0,
    missingMembers: 0,
    unexpectedMembers: 0,
    changedMembers: 0,
    unknownVersions: 0,
    duplicateRows: 0,
    tiedServerStamps: 0,
    repeatedReadDifferences: 0,
    independentSnapshotStable: false,
  };
  const checkTime = () => {
    if (clock() - started >= MAX_DURATION) throw new ProbeStop("time_cap");
  };
  const checkManifest = (manifest: OperationManifest) => {
    try {
      validateManifest(manifest);
    } catch {
      throw new ProbeStop("manifest_invalid");
    }
    if (manifest.operation.uuid !== options.operationId)
      throw new ProbeStop("manifest_invalid");
    if (
      manifest.capturedAt > clock() ||
      clock() - manifest.capturedAt > MAX_MANIFEST_AGE
    )
      throw new ProbeStop("manifest_expired");
    if ([manifest.operation, ...manifest.members].some((row) => !row.synced))
      throw new ProbeStop("manifest_unsynced");
  };
  try {
    if (!validId(options.operationId) || !validId(options.accountId))
      throw new ProbeStop("manifest_invalid");
    if (!options.credentials.token)
      throw new ProbeStop("authentication_required");
    let before: OperationManifest;
    try {
      before = structuredClone(await options.loadManifest());
    } catch {
      throw new ProbeStop("manifest_invalid");
    }
    checkManifest(before);
    report.expectedMembers = before.members.length;
    report.expectedEvents = before.members.filter((row) => row.isEvent).length;
    report.expectedDeleted = before.members.filter((row) => row.deleted).length;
    report.expectedPurged = before.members.filter((row) => row.purged).length;
    const guardedFetch: typeof fetch = async (input, init) => {
      checkTime();
      const url = new URL(String(input));
      if (url.pathname === "/v1/client")
        throw new ProbeStop("authentication_required");
      if (
        url.origin !== "https://lofi.ham2k.net" ||
        url.username ||
        url.password ||
        url.hash ||
        init?.method !== "GET" ||
        init.body !== undefined ||
        init.redirect !== "manual" ||
        (url.pathname !== "/v1/accounts" &&
          url.pathname !== `/v1/operations/${options.operationId}/qsos`)
      )
        throw new ProbeStop("transport_denied");
      if (
        url.pathname === "/v1/accounts"
          ? url.search !== ""
          : url.searchParams.get("limit") !== String(PAGE_SIZE) ||
            [...url.searchParams.keys()].some(
              (key) => !["limit", "syncedUntilMillis"].includes(key),
            )
      )
        throw new ProbeStop("transport_denied");
      if (report.readAttempts >= MAX_READS) throw new ProbeStop("read_cap");
      report.readAttempts++;
      const response = await options.fetcher(input, {
        ...init,
        signal: AbortSignal.any([
          ...(init.signal ? [init.signal] : []),
          AbortSignal.timeout(
            Math.max(1, Math.min(15_000, MAX_DURATION - (clock() - started))),
          ),
        ]),
      });
      checkTime();
      return response;
    };
    const client = () => new LoFiClient(options.credentials, guardedFetch);
    if ((await client().accounts()).uuid !== options.accountId)
      throw new ProbeStop("account_changed");
    const passes: Map<string, Metadata>[] = [];
    for (let pass = 0; pass < 2; pass++) {
      const found = new Map<string, Metadata>();
      let state: OperationQsosState = {};
      for (;;) {
        checkTime();
        checkManifest(before);
        const page = await client().operationQsosPage(
          options.operationId,
          state,
          PAGE_SIZE,
        );
        report.pages++;
        if (page.qsos.length > PAGE_SIZE)
          throw new ProbeStop("page_size_exceeded");
        for (const raw of page.qsos) {
          const row = metadata(raw, options.operationId);
          const previous = found.get(row.uuid);
          if (previous) {
            report.duplicateRows++;
            if (recordKey(previous) !== recordKey(row))
              throw new ProbeStop("conflicting_duplicate");
          }
          found.set(row.uuid, row);
          if (found.size > MAX_MEMBERS) throw new ProbeStop("member_cap");
        }
        if (page.complete) break;
        if (!page.qsos.length) throw new ProbeStop("empty_incomplete_page");
        state = JSON.parse(JSON.stringify(page.next)) as OperationQsosState;
      }
      passes.push(found);
      report.completedPasses++;
    }
    let after: OperationManifest;
    try {
      after = await options.loadManifest();
    } catch {
      throw new ProbeStop("manifest_invalid");
    }
    checkTime();
    checkManifest(before);
    checkManifest(after);
    if (manifestKey(before) !== manifestKey(after))
      throw new ProbeStop("manifest_changed");
    report.independentSnapshotStable = true;
    const first = passes[0];
    const second = passes[1];
    const ids = new Set([...first.keys(), ...second.keys()]);
    for (const id of ids) {
      const earlier = first.get(id);
      const later = second.get(id);
      if (!earlier || !later || recordKey(earlier) !== recordKey(later))
        report.repeatedReadDifferences++;
    }
    const expected = new Map(before.members.map((row) => [row.uuid, row]));
    const times = new Set<number>();
    for (const row of second.values()) {
      if (times.has(row.syncedAtMillis)) report.tiedServerStamps++;
      times.add(row.syncedAtMillis);
      const known = expected.get(row.uuid);
      if (!known) {
        report.unexpectedMembers++;
        continue;
      }
      if (known.updatedAtMillis === null || row.updatedAtMillis === null)
        report.unknownVersions++;
      if (
        known.isEvent !== row.isEvent ||
        known.deleted !== row.deleted ||
        known.purged !== row.purged ||
        (known.updatedAtMillis !== null &&
          row.updatedAtMillis !== null &&
          known.updatedAtMillis !== row.updatedAtMillis) ||
        (known.syncedAtMillis !== null &&
          known.syncedAtMillis !== row.syncedAtMillis)
      )
        report.changedMembers++;
    }
    for (const id of expected.keys())
      if (!second.has(id)) report.missingMembers++;
    report.status =
      report.missingMembers +
        report.unexpectedMembers +
        report.changedMembers +
        report.repeatedReadDifferences >
      0
        ? "discrepancy"
        : report.unknownVersions > 0
          ? "incomplete"
          : "observed_match";
  } catch (error) {
    const reason: Stop =
      error instanceof ProbeStop
        ? error.code
        : error instanceof VendorDeferredError
          ? "vendor_deferred"
          : error instanceof LoFiError
            ? error.status === 401
              ? "authentication_required"
              : error.status === 429
                ? "vendor_deferred"
                : error.code === "account_changed"
                  ? "account_changed"
                  : error.status
                    ? "vendor_unavailable"
                    : "protocol_error"
            : "vendor_unavailable";
    report.stopReason = reason;
    report.status = [
      "read_cap",
      "time_cap",
      "empty_incomplete_page",
      "member_cap",
      "page_size_exceeded",
    ].includes(reason)
      ? "incomplete"
      : ["conflicting_duplicate", "manifest_changed"].includes(reason)
        ? "discrepancy"
        : "unavailable";
  }
  report.elapsedMs = Math.max(0, clock() - started);
  return report;
}
