import {
  LoFiClient,
  type LoFiCredentials,
  LoFiError,
  type SourceRecord,
  type SyncState,
} from "../src/lofi.ts";
import { isEventRecord } from "../src/projection.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";

const PAGE_SIZE = 25;
const MAX_READS = 4;
const MAX_RECORDS = 100;
const MAX_DURATION = 120_000;
const MAX_MANIFEST_AGE = 300_000;
const MAX_WINDOW_AGE = 86_400_000;
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const validClient = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;
const stamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

interface RecordMetadata {
  kind: "operation" | "qso";
  uuid: string;
  operation: string | null;
  isEvent: boolean;
  deleted: boolean;
  purged: boolean;
  updatedAtMillis: number | null;
  syncedAtMillis: number;
}

/**
 * The runner must independently verify account/client identities and each
 * record's last writer. A local `synced` flag alone is not writer evidence.
 * Records are known positives, not a claim to enumerate the forward window.
 */
export interface ForwardManifest {
  origin: "independent-client-metadata";
  capturedAt: number;
  accountId: string;
  readerClientKey: string;
  records: (RecordMetadata & {
    synced: boolean;
    writerClientKey: string;
  })[];
}

type Stop =
  | "manifest_invalid"
  | "manifest_expired"
  | "manifest_changed"
  | "manifest_unsynced"
  | "writer_not_distinct"
  | "window_invalid"
  | "authentication_required"
  | "account_changed"
  | "transport_denied"
  | "vendor_deferred"
  | "vendor_unavailable"
  | "protocol_error"
  | "read_cap"
  | "time_cap"
  | "empty_incomplete_page"
  | "page_size_exceeded"
  | "record_cap"
  | "conflicting_duplicate";
class ProbeStop extends Error {
  constructor(readonly code: Stop) {
    super(code);
  }
}

const id = (row: Pick<RecordMetadata, "kind" | "uuid">) =>
  `${row.kind}:${row.uuid}`;
const recordKey = (row: RecordMetadata) =>
  JSON.stringify([
    row.operation,
    row.isEvent,
    row.deleted,
    row.purged,
    row.updatedAtMillis,
    row.syncedAtMillis,
  ]);
const manifestKey = (manifest: ForwardManifest) =>
  JSON.stringify([
    manifest.accountId,
    manifest.readerClientKey,
    [...manifest.records]
      .sort((a, b) => id(a).localeCompare(id(b)))
      .map((row) => [id(row), recordKey(row), row.synced, row.writerClientKey]),
  ]);
function flag(value: unknown): boolean {
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
}
function metadata(
  raw: SourceRecord,
  kind: RecordMetadata["kind"],
): RecordMetadata {
  const operation = kind === "operation" ? null : (raw.operation ?? null);
  if (
    !validId(raw.uuid) ||
    (operation !== null && !validId(operation)) ||
    !stamp(raw.syncedAtMillis) ||
    (raw.updatedAtMillis != null && !stamp(raw.updatedAtMillis))
  )
    throw new ProbeStop("protocol_error");
  return {
    kind,
    uuid: raw.uuid,
    operation,
    isEvent: kind === "qso" && isEventRecord(raw),
    deleted: flag(raw.deleted),
    purged: flag(raw.purged),
    updatedAtMillis: (raw.updatedAtMillis as number | undefined) ?? null,
    syncedAtMillis: raw.syncedAtMillis,
  };
}

/**
 * Read-only known-positive forward observation. The injected transport must use
 * the existing shared vendor budget. No filesystem/database access, credentials
 * loading, client renewal, source writes, production cursors or authorizations.
 * The callback must independently reread the manifest on its second invocation.
 */
export async function probeForwardReplay(options: {
  credentials: LoFiCredentials;
  accountId: string;
  watermarks: { operations: number; qsos: number };
  loadManifest: () => Promise<ForwardManifest>;
  fetcher: typeof fetch;
  now?: () => number;
}) {
  const clock = options.now ?? Date.now;
  const started = clock();
  const credentials = { ...options.credentials };
  const accountId = options.accountId;
  const watermarks = { ...options.watermarks };
  const report = {
    evidence: "observed-forward-replay" as const,
    sourceBoundaryVerified: false as const,
    accountMembershipVerified: false as const,
    unknownHistoricalPurgesExcluded: false as const,
    writesAuthorized: false as const,
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
    expectedRecords: 0,
    expectedOperations: 0,
    expectedEvents: 0,
    expectedDeleted: 0,
    expectedPurged: 0,
    observedRecords: 0,
    incidentalRecords: 0,
    missingRecords: 0,
    changedRecords: 0,
    unknownVersions: 0,
    repeatedReadDifferences: 0,
    duplicateRows: 0,
    tiedServerStamps: 0,
    independentSnapshotStable: false,
    distinctWriterEvidenceProvided: false,
    positiveDeliveryObserved: false,
  };
  const checkTime = () => {
    const current = clock();
    if (
      !stamp(started) ||
      !stamp(current) ||
      current < started ||
      current - started >= MAX_DURATION
    )
      throw new ProbeStop("time_cap");
  };
  const checkManifest = (value: ForwardManifest) => {
    if (
      value?.origin !== "independent-client-metadata" ||
      value.accountId !== accountId ||
      value.readerClientKey !== credentials.key ||
      !stamp(value.capturedAt) ||
      !Array.isArray(value.records) ||
      value.records.length < 1 ||
      value.records.length > 50
    )
      throw new ProbeStop("manifest_invalid");
    if (
      value.capturedAt > clock() ||
      clock() - value.capturedAt > MAX_MANIFEST_AGE
    )
      throw new ProbeStop("manifest_expired");
    const seen = new Set<string>();
    for (const row of value.records) {
      if (
        !row ||
        !["operation", "qso"].includes(row.kind) ||
        !validId(row.uuid) ||
        (row.operation !== null && !validId(row.operation)) ||
        (row.kind === "operation" && (row.operation !== null || row.isEvent)) ||
        [row.isEvent, row.deleted, row.purged, row.synced].some(
          (value) => typeof value !== "boolean",
        ) ||
        (row.updatedAtMillis !== null && !stamp(row.updatedAtMillis)) ||
        !stamp(row.syncedAtMillis) ||
        row.syncedAtMillis <=
          watermarks[row.kind === "operation" ? "operations" : "qsos"] ||
        row.syncedAtMillis > started ||
        seen.has(id(row))
      )
        throw new ProbeStop("manifest_invalid");
      if (!row.synced) throw new ProbeStop("manifest_unsynced");
      if (
        !validClient(row.writerClientKey) ||
        row.writerClientKey === credentials.key
      )
        throw new ProbeStop("writer_not_distinct");
      seen.add(id(row));
    }
  };
  const loadManifest = async () => {
    let value: ForwardManifest;
    try {
      value = structuredClone(await options.loadManifest());
    } catch {
      throw new ProbeStop("manifest_invalid");
    }
    checkTime();
    checkManifest(value);
    return value;
  };
  try {
    checkTime();
    if (!validId(accountId) || !validClient(credentials.key))
      throw new ProbeStop("manifest_invalid");
    if (!credentials.token) throw new ProbeStop("authentication_required");
    if (
      Object.values(watermarks).length !== 2 ||
      [watermarks.operations, watermarks.qsos].some(
        (value) =>
          !stamp(value) || value >= started || started - value > MAX_WINDOW_AGE,
      )
    )
      throw new ProbeStop("window_invalid");
    const before = await loadManifest();
    report.expectedRecords = before.records.length;
    report.expectedOperations = before.records.filter(
      (row) => row.kind === "operation",
    ).length;
    report.expectedEvents = before.records.filter((row) => row.isEvent).length;
    report.expectedDeleted = before.records.filter((row) => row.deleted).length;
    report.expectedPurged = before.records.filter((row) => row.purged).length;
    report.distinctWriterEvidenceProvided = true;
    let allowedBody: string | undefined;
    const guardedFetch: typeof fetch = async (input, init) => {
      checkTime();
      const url = new URL(String(input));
      if (url.pathname === "/v1/client")
        throw new ProbeStop("authentication_required");
      if (
        url.origin !== "https://lofi.ham2k.net" ||
        url.pathname !== "/v1/sync" ||
        url.search ||
        url.hash ||
        url.username ||
        url.password ||
        init?.method !== "POST" ||
        init.redirect !== "manual" ||
        allowedBody === undefined ||
        init.body !== allowedBody
      )
        throw new ProbeStop("transport_denied");
      allowedBody = undefined;
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
      try {
        checkTime();
      } catch (error) {
        void response.body?.cancel().catch(() => {});
        throw error;
      }
      return response;
    };
    const passes: Map<string, RecordMetadata>[] = [];
    for (let pass = 0; pass < 2; pass++) {
      let state: SyncState = {
        mode: "forward",
        accountId,
        operations: { watermark: watermarks.operations },
        qsos: { watermark: watermarks.qsos },
      };
      const found = new Map<string, RecordMetadata>();
      const stamps = new Set<string>();
      for (;;) {
        checkTime();
        checkManifest(before);
        const window = (side: "operations" | "qsos") => ({
          syncedSinceMillis: state[side].watermark,
          ...(state[side].cursor ? { cursor: state[side].cursor } : {}),
          limit: PAGE_SIZE,
          anyClient: false,
        });
        allowedBody = JSON.stringify({
          meta: {
            inboundSync: true,
            lastSyncAccountUUID: accountId,
            sync: { operations: window("operations"), qsos: window("qsos") },
          },
        });
        const page = await new LoFiClient(credentials, guardedFetch).syncPage(
          state,
          clock(),
          PAGE_SIZE,
        );
        allowedBody = undefined;
        checkTime();
        checkManifest(before);
        report.pages++;
        for (const side of ["operations", "qsos"] as const) {
          if (page[side].length > PAGE_SIZE)
            throw new ProbeStop("page_size_exceeded");
          if (!page.next[side].complete && page[side].length === 0)
            throw new ProbeStop("empty_incomplete_page");
          for (const raw of page[side]) {
            const row = metadata(
              raw,
              side === "operations" ? "operation" : "qso",
            );
            if (row.syncedAtMillis < watermarks[side])
              throw new ProbeStop("protocol_error");
            const key = id(row);
            const previous = found.get(key);
            if (previous) {
              report.duplicateRows++;
              if (recordKey(previous) !== recordKey(row))
                throw new ProbeStop("conflicting_duplicate");
              continue;
            }
            if (found.size >= MAX_RECORDS) throw new ProbeStop("record_cap");
            const tied = `${row.kind}:${row.syncedAtMillis}`;
            if (stamps.has(tied)) report.tiedServerStamps++;
            stamps.add(tied);
            found.set(key, row);
          }
        }
        if (page.complete) break;
        state = JSON.parse(JSON.stringify(page.next)) as SyncState;
      }
      report.completedPasses++;
      passes.push(found);
    }
    const after = await loadManifest();
    if (manifestKey(before) !== manifestKey(after))
      throw new ProbeStop("manifest_changed");
    report.independentSnapshotStable = true;
    const [first, second] = passes;
    const expected = new Set(before.records.map(id));
    for (const key of new Set([...first.keys(), ...second.keys()])) {
      const a = first.get(key);
      const b = second.get(key);
      if (!a || !b || recordKey(a) !== recordKey(b))
        report.repeatedReadDifferences++;
      if (!expected.has(key)) report.incidentalRecords++;
    }
    for (const known of before.records) {
      const rows = [first.get(id(known)), second.get(id(known))];
      if (rows.some((row) => !row)) report.missingRecords++;
      if (
        known.updatedAtMillis === null ||
        rows.some((row) => row?.updatedAtMillis === null)
      )
        report.unknownVersions++;
      if (
        rows.some(
          (row) =>
            row &&
            (row.operation !== known.operation ||
              row.isEvent !== known.isEvent ||
              row.deleted !== known.deleted ||
              row.purged !== known.purged ||
              row.syncedAtMillis !== known.syncedAtMillis ||
              (known.updatedAtMillis !== null &&
                row.updatedAtMillis !== null &&
                row.updatedAtMillis !== known.updatedAtMillis)),
        )
      )
        report.changedRecords++;
      if (
        rows.every((row) => row && recordKey(row) === recordKey(known)) &&
        known.updatedAtMillis !== null
      )
        report.observedRecords++;
    }
    report.positiveDeliveryObserved = report.observedRecords > 0;
    report.status =
      report.missingRecords +
        report.changedRecords +
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
      "page_size_exceeded",
      "record_cap",
    ].includes(reason)
      ? "incomplete"
      : ["manifest_changed", "conflicting_duplicate"].includes(reason)
        ? "discrepancy"
        : "unavailable";
  }
  const elapsed = clock() - started;
  report.elapsedMs = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  return report;
}
