import {
  LoFiClient,
  type LoFiCredentials,
  LoFiError,
  type SourceRecord,
  type SyncState,
} from "../src/lofi.ts";
import { isEventRecord, sourceFlag } from "../src/projection.ts";
import { canonical, sha256 } from "../src/security.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";

const PAGE_SIZE = 200;
const MAX_PAGE_ROWS = 2000;
const MAX_RECORDS = 10_000;
const MAX_ATTEMPTS = 128;
const MAX_BATCH_ATTEMPTS = 4;
const MAX_BATCH_MS = 120_000;
const MAX_RUN_MS = 90 * 60_000;
const MAX_SNAPSHOT_AGE = 300_000;
const validId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const stamp = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
// Older HaLo server acknowledgements retain sub-millisecond precision. Keep
// that independent version evidence exactly; clocks/counters/cursors stay integer.
const versionStamp = (v: unknown): v is number =>
  typeof v === "number" &&
  Number.isFinite(v) &&
  v >= 0 &&
  v <= Number.MAX_SAFE_INTEGER;
const hash = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
type Kind = "operation" | "qso";

export interface InventoryScope {
  tenant: string;
  source: string;
  accountId: string;
  clientKey: string;
  credentialVersion: string;
}
/** Minimal metadata only. Null identifies information that origin does not retain. */
export interface InventoryRecord {
  kind: Kind;
  uuid: string;
  operation: string | null;
  isEvent: boolean;
  deleted: boolean;
  purged: boolean | null;
  updatedAtMillis: number | null;
  syncedAtMillis: number | null;
  revision: string | null;
}
export interface InventoryManifests {
  capturedAt: number;
  accountId: string;
  halo: InventoryRecord[];
  ferry: InventoryRecord[];
}
interface Comparison {
  expected: number;
  missing: number;
  additional: number;
  flags: number;
  membership: number;
  applicationVersions: number;
  serverVersions: number;
  revisions: number;
  unknownVersions: number;
}
export interface InventoryCheckpoint {
  schema: 1;
  scopeDigest: string;
  startedAt: number;
  updatedAt: number;
  pass: 1 | 2 | 3;
  passStartedAt: number;
  state: SyncState;
  lastStamps: { operations: number | null; qsos: number | null };
  attempts: number;
  pages: number;
  duplicateRows: number;
  tiedRows: number;
  expandedPages: number;
  haloStable: boolean;
  ferryStable: boolean;
  initial: InventoryManifests;
  first: InventoryRecord[];
  second: InventoryRecord[];
}
type Stop =
  | "batch_limit"
  | "time_limit"
  | "run_expired"
  | "attempt_limit"
  | "budget_deferred"
  | "vendor_deferred"
  | "vendor_unavailable"
  | "authentication_required"
  | "account_changed"
  | "scope_changed"
  | "scope_invalid"
  | "checkpoint_invalid"
  | "checkpoint_not_saved"
  | "manifest_invalid"
  | "manifest_expired"
  | "transport_denied"
  | "protocol_error"
  | "page_overflow"
  | "record_overflow"
  | "out_of_order"
  | "conflicting_duplicate"
  | "empty_incomplete_page";
class AuditStop extends Error {
  constructor(readonly code: Stop) {
    super(code);
  }
}
const key = (r: InventoryRecord) => `${r.kind}:${r.uuid}`;
const recordKey = (r: InventoryRecord) => canonical(r);
const recordsKey = (rows: InventoryRecord[]) =>
  canonical([...rows].sort((a, b) => key(a).localeCompare(key(b))));
const emptyComparison = (): Comparison => ({
  expected: 0,
  missing: 0,
  additional: 0,
  flags: 0,
  membership: 0,
  applicationVersions: 0,
  serverVersions: 0,
  revisions: 0,
  unknownVersions: 0,
});
function compare(
  expected: InventoryRecord[],
  observed: InventoryRecord[],
): Comparison {
  const result = emptyComparison();
  result.expected = expected.length;
  const actual = new Map(observed.map((r) => [key(r), r]));
  const known = new Set(expected.map(key));
  result.additional = observed.filter((r) => !known.has(key(r))).length;
  for (const a of expected) {
    const b = actual.get(key(a));
    if (!b) {
      result.missing++;
      continue;
    }
    if (
      a.deleted !== b.deleted ||
      a.isEvent !== b.isEvent ||
      (a.purged !== null && a.purged !== b.purged)
    )
      result.flags++;
    if (a.operation !== b.operation) result.membership++;
    if (
      a.updatedAtMillis !== null &&
      b.updatedAtMillis !== null &&
      a.updatedAtMillis !== b.updatedAtMillis
    )
      result.applicationVersions++;
    if (a.syncedAtMillis !== null && a.syncedAtMillis !== b.syncedAtMillis)
      result.serverVersions++;
    if (a.revision !== null && a.revision !== b.revision) result.revisions++;
    if (
      a.syncedAtMillis === null ||
      (a.updatedAtMillis !== null && b.updatedAtMillis === null) ||
      (a.revision === null && a.updatedAtMillis === null)
    )
      result.unknownVersions++;
  }
  return result;
}
function validateRows(rows: InventoryRecord[], server = false) {
  if (!Array.isArray(rows) || rows.length > MAX_RECORDS)
    throw new AuditStop("record_overflow");
  const ids = new Set<string>();
  for (const r of rows) {
    if (
      !r ||
      Object.keys(r).sort().join(",") !==
        "deleted,isEvent,kind,operation,purged,revision,syncedAtMillis,updatedAtMillis,uuid" ||
      !["operation", "qso"].includes(r.kind) ||
      !validId(r.uuid) ||
      (r.operation !== null && !validId(r.operation)) ||
      (r.kind === "operation" && (r.operation !== null || r.isEvent)) ||
      typeof r.deleted !== "boolean" ||
      typeof r.isEvent !== "boolean" ||
      (r.purged !== null && typeof r.purged !== "boolean") ||
      (r.updatedAtMillis !== null &&
        !(server ? stamp : versionStamp)(r.updatedAtMillis)) ||
      (r.syncedAtMillis !== null &&
        !(server ? stamp : versionStamp)(r.syncedAtMillis)) ||
      (r.revision !== null && !hash(r.revision)) ||
      (server &&
        (r.syncedAtMillis === null ||
          r.revision === null ||
          r.purged === null)) ||
      ids.has(key(r))
    )
      throw new AuditStop("manifest_invalid");
    ids.add(key(r));
  }
}
function validateManifests(value: InventoryManifests, accountId: string) {
  if (
    !value ||
    Object.keys(value).sort().join(",") !== "accountId,capturedAt,ferry,halo" ||
    value.accountId !== accountId ||
    !stamp(value.capturedAt)
  )
    throw new AuditStop("manifest_invalid");
  validateRows(value.halo);
  validateRows(value.ferry);
}
function scopeKey(scope: InventoryScope) {
  if (
    !scope ||
    !validId(scope.tenant) ||
    !validId(scope.source) ||
    !validId(scope.accountId) ||
    !validId(scope.credentialVersion) ||
    typeof scope.clientKey !== "string" ||
    !scope.clientKey ||
    scope.clientKey.length > 512
  )
    throw new AuditStop("scope_invalid");
  return canonical([
    scope.tenant,
    scope.source,
    scope.accountId,
    scope.clientKey,
    scope.credentialVersion,
  ]);
}
function validateState(state: SyncState, accountId: string, complete: boolean) {
  if (
    !state ||
    Object.keys(state).sort().join(",") !== "accountId,mode,operations,qsos" ||
    state.accountId !== accountId ||
    state.mode !== (complete ? "forward" : "backfill")
  )
    throw new AuditStop("checkpoint_invalid");
  for (const side of [state.operations, state.qsos]) {
    if (
      !side ||
      Object.keys(side).some(
        (k) => !["cursor", "watermark", "latest", "complete"].includes(k),
      ) ||
      (side.cursor !== undefined &&
        (typeof side.cursor !== "string" ||
          !side.cursor ||
          side.cursor.length > 16_384)) ||
      (side.watermark !== undefined && !stamp(side.watermark)) ||
      (side.latest !== undefined && !stamp(side.latest)) ||
      (side.complete !== undefined && typeof side.complete !== "boolean")
    )
      throw new AuditStop("checkpoint_invalid");
  }
}
function validateCheckpoint(c: InventoryCheckpoint, accountId: string) {
  if (
    !c ||
    Object.keys(c).sort().join(",") !==
      "attempts,duplicateRows,expandedPages,ferryStable,first,haloStable,initial,lastStamps,pages,pass,passStartedAt,schema,scopeDigest,second,startedAt,state,tiedRows,updatedAt" ||
    c.schema !== 1 ||
    !hash(c.scopeDigest) ||
    ![1, 2, 3].includes(c.pass) ||
    ![
      c.startedAt,
      c.updatedAt,
      c.passStartedAt,
      c.attempts,
      c.pages,
      c.duplicateRows,
      c.tiedRows,
      c.expandedPages,
    ].every(stamp) ||
    c.updatedAt < c.startedAt ||
    c.passStartedAt < c.startedAt ||
    c.passStartedAt > c.updatedAt ||
    c.attempts > MAX_ATTEMPTS ||
    c.pages > c.attempts ||
    typeof c.haloStable !== "boolean" ||
    typeof c.ferryStable !== "boolean" ||
    !c.lastStamps ||
    Object.keys(c.lastStamps).sort().join(",") !== "operations,qsos" ||
    Object.values(c.lastStamps).some((s) => s !== null && !stamp(s))
  )
    throw new AuditStop("checkpoint_invalid");
  try {
    validateManifests(c.initial, accountId);
    validateRows(c.first, true);
    validateRows(c.second, true);
    validateState(c.state, accountId, c.pass === 3);
  } catch {
    throw new AuditStop("checkpoint_invalid");
  }
  if (c.pass === 1 && c.second.length)
    throw new AuditStop("checkpoint_invalid");
}
async function metadata(
  raw: SourceRecord,
  kind: Kind,
): Promise<InventoryRecord> {
  const operation = kind === "operation" ? null : raw.operation || null;
  if (
    !validId(raw.uuid) ||
    (operation !== null && !validId(operation)) ||
    !stamp(raw.syncedAtMillis) ||
    (raw.updatedAtMillis != null && !stamp(raw.updatedAtMillis))
  )
    throw new AuditStop("protocol_error");
  let deleted: boolean;
  let purged: boolean;
  try {
    deleted = sourceFlag(raw.deleted);
    purged = sourceFlag(raw.purged);
  } catch {
    throw new AuditStop("protocol_error");
  }
  const { syncedAtMillis: _stamp, ...inputs } = raw;
  return {
    kind,
    uuid: raw.uuid,
    operation,
    isEvent: kind === "qso" && isEventRecord(raw),
    deleted: deleted || purged,
    purged,
    updatedAtMillis: (raw.updatedAtMillis as number | undefined) ?? null,
    syncedAtMillis: raw.syncedAtMillis,
    revision: await sha256(canonical(inputs)),
  };
}

/**
 * One bounded continuation of two all-client full sync reads. The caller owns
 * private checkpoint I/O and the existing shared vendor budget. Its scope and
 * independent-manifest loaders must perform fresh read-only checks. Checkpoints
 * contain private metadata/cursors; only the returned fixed-shape report may be
 * logged. This audit never changes production intake or grants source authority.
 */
export async function advanceSourceInventoryAudit(options: {
  scope: InventoryScope;
  credentials: LoFiCredentials;
  checkpoint?: InventoryCheckpoint;
  loadScope: () => Promise<InventoryScope | null>;
  loadManifests: () => Promise<InventoryManifests>;
  saveCheckpoint: (checkpoint: InventoryCheckpoint) => Promise<void>;
  fetcher: typeof fetch;
  now?: () => number;
}) {
  const clock = options.now ?? Date.now;
  const batchStart = clock();
  const scope = { ...options.scope };
  const credentials = { ...options.credentials };
  let checkpoint: InventoryCheckpoint | undefined;
  let stop: Stop | null = null;
  let retryAt: number | null = null;
  let batchAttempts = 0;
  let durable = false;
  const report = {
    evidence: "observed-all-client-inventory" as const,
    sourceBoundaryVerified: false as const,
    writesAuthorized: false as const,
    accountMembershipVerified: false as const,
    unknownHistoricalPurgesExcluded: false as const,
    forwardCatchupObserved: false as const,
    status: "incomplete" as
      | "incomplete"
      | "observed_match"
      | "discrepancy"
      | "unavailable",
    stopReason: null as Stop | null,
    retryAt: null as number | null,
    batchAttempts: 0,
    totalAttempts: 0,
    pages: 0,
    completedPasses: 0,
    firstRecords: 0,
    secondRecords: 0,
    operations: 0,
    contacts: 0,
    events: 0,
    deleted: 0,
    purged: 0,
    duplicateRows: 0,
    tiedRows: 0,
    expandedPages: 0,
    haloSnapshotStable: false,
    ferrySnapshotStable: false,
    checkpointSaved: false,
    elapsedMs: 0,
    halo: emptyComparison(),
    ferry: emptyComparison(),
    repeat: emptyComparison(),
  };
  const checkTime = () => {
    const now = clock();
    if (
      !stamp(now) ||
      !stamp(batchStart) ||
      now < batchStart ||
      now - batchStart >= MAX_BATCH_MS
    )
      throw new AuditStop("time_limit");
    if (
      checkpoint &&
      (now < checkpoint.updatedAt || now - checkpoint.startedAt >= MAX_RUN_MS)
    )
      throw new AuditStop("run_expired");
  };
  const checkScope = async () => {
    let current: InventoryScope | null;
    try {
      current = await options.loadScope();
    } catch {
      throw new AuditStop("scope_changed");
    }
    checkTime();
    if (!current || scopeKey(current) !== scopeKey(scope))
      throw new AuditStop("scope_changed");
  };
  const manifests = async () => {
    let value: InventoryManifests;
    try {
      value = structuredClone(await options.loadManifests());
    } catch {
      throw new AuditStop("manifest_invalid");
    }
    checkTime();
    validateManifests(value, scope.accountId);
    if (
      value.capturedAt > clock() ||
      clock() - value.capturedAt > MAX_SNAPSHOT_AGE
    )
      throw new AuditStop("manifest_expired");
    return value;
  };
  const save = async () => {
    if (!checkpoint) return;
    checkpoint.updatedAt = clock();
    try {
      await options.saveCheckpoint(structuredClone(checkpoint));
      durable = true;
    } catch {
      durable = false;
      throw new AuditStop("checkpoint_not_saved");
    }
  };
  try {
    checkTime();
    const digest = await sha256(scopeKey(scope));
    if (credentials.key !== scope.clientKey)
      throw new AuditStop("scope_invalid");
    if (!credentials.token) throw new AuditStop("authentication_required");
    if (options.checkpoint) {
      const candidate = structuredClone(options.checkpoint);
      validateCheckpoint(candidate, scope.accountId);
      if (candidate.scopeDigest !== digest)
        throw new AuditStop("scope_changed");
      checkpoint = candidate;
      checkTime();
    }
    await checkScope();
    if (!checkpoint) {
      const initial = await manifests();
      checkpoint = {
        schema: 1,
        scopeDigest: digest,
        startedAt: clock(),
        updatedAt: clock(),
        pass: 1,
        passStartedAt: clock(),
        state: {
          mode: "backfill",
          accountId: scope.accountId,
          operations: {},
          qsos: {},
        },
        lastStamps: { operations: null, qsos: null },
        attempts: 0,
        pages: 0,
        duplicateRows: 0,
        tiedRows: 0,
        expandedPages: 0,
        haloStable: true,
        ferryStable: true,
        initial,
        first: [],
        second: [],
      };
      await save();
    }
    let allowedBody: string | undefined;
    const guarded: typeof fetch = async (input, init) => {
      checkTime();
      const url = new URL(String(input));
      if (url.pathname === "/v1/client")
        throw new AuditStop("authentication_required");
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
        throw new AuditStop("transport_denied");
      allowedBody = undefined;
      if (batchAttempts >= MAX_BATCH_ATTEMPTS)
        throw new AuditStop("batch_limit");
      if (!checkpoint) throw new AuditStop("checkpoint_invalid");
      if (checkpoint.attempts >= MAX_ATTEMPTS)
        throw new AuditStop("attempt_limit");
      batchAttempts++;
      checkpoint.attempts++;
      let response: Response;
      try {
        response = await options.fetcher(input, {
          ...init,
          signal: AbortSignal.any([
            ...(init.signal ? [init.signal] : []),
            AbortSignal.timeout(
              Math.max(
                1,
                Math.min(15000, MAX_BATCH_MS - (clock() - batchStart)),
              ),
            ),
          ]),
        });
      } catch (error) {
        if (error instanceof VendorDeferredError && !error.requestSent) {
          batchAttempts--;
          checkpoint.attempts--;
        }
        throw error;
      }
      try {
        checkTime();
      } catch (error) {
        void response.body?.cancel().catch(() => {});
        throw error;
      }
      return response;
    };
    while (checkpoint.pass < 3) {
      checkTime();
      await checkScope();
      const currentCheckpoint = checkpoint;
      const window = (side: "operations" | "qsos") => ({
        syncedUntilMillis:
          currentCheckpoint.state[side].watermark ??
          currentCheckpoint.passStartedAt,
        ...(currentCheckpoint.state[side].cursor
          ? { cursor: currentCheckpoint.state[side].cursor }
          : {}),
        limit: PAGE_SIZE,
        anyClient: true,
      });
      allowedBody = JSON.stringify({
        meta: {
          inboundSync: true,
          lastSyncAccountUUID: scope.accountId,
          sync: { operations: window("operations"), qsos: window("qsos") },
        },
      });
      const page = await new LoFiClient(credentials, guarded).syncPage(
        checkpoint.state,
        checkpoint.passStartedAt,
        PAGE_SIZE,
      );
      allowedBody = undefined;
      checkTime();
      const target =
        checkpoint.pass === 1 ? checkpoint.first : checkpoint.second;
      const next = new Map(target.map((r) => [key(r), r]));
      const stamps = new Set(
        target.map((r) => `${r.kind}:${r.syncedAtMillis}`),
      );
      const last = { ...checkpoint.lastStamps };
      let duplicates = 0;
      let ties = 0;
      let expanded = 0;
      for (const side of ["operations", "qsos"] as const) {
        if (page[side].length > MAX_PAGE_ROWS)
          throw new AuditStop("page_overflow");
        if (page[side].length > PAGE_SIZE) expanded++;
        if (
          !page.complete &&
          !page.next[side].complete &&
          page[side].length === 0
        )
          throw new AuditStop("empty_incomplete_page");
        const rows: InventoryRecord[] = [];
        for (let offset = 0; offset < page[side].length; offset += 25)
          rows.push(
            ...(await Promise.all(
              page[side]
                .slice(offset, offset + 25)
                .map((raw) =>
                  metadata(raw, side === "operations" ? "operation" : "qso"),
                ),
            )),
          );
        for (const row of rows) {
          const serverStamp = row.syncedAtMillis;
          const previousStamp = last[side];
          if (serverStamp === null) throw new AuditStop("protocol_error");
          if (
            serverStamp > checkpoint.passStartedAt ||
            (previousStamp !== null && serverStamp > previousStamp)
          )
            throw new AuditStop("out_of_order");
          last[side] = row.syncedAtMillis;
          const prior = next.get(key(row));
          if (prior) {
            duplicates++;
            if (recordKey(prior) !== recordKey(row))
              throw new AuditStop("conflicting_duplicate");
            continue;
          }
          if (next.size >= MAX_RECORDS) throw new AuditStop("record_overflow");
          const tied = `${row.kind}:${row.syncedAtMillis}`;
          if (stamps.has(tied)) ties++;
          stamps.add(tied);
          next.set(key(row), row);
        }
      }
      await checkScope();
      checkTime();
      const candidate: InventoryCheckpoint = {
        ...checkpoint,
        pages: checkpoint.pages + 1,
        state: page.next,
        lastStamps: last,
        duplicateRows: checkpoint.duplicateRows + duplicates,
        tiedRows: checkpoint.tiedRows + ties,
        expandedPages: checkpoint.expandedPages + expanded,
        ...(checkpoint.pass === 1
          ? { first: [...next.values()] }
          : { second: [...next.values()] }),
      };
      if (page.complete) {
        const current = await manifests();
        await checkScope();
        candidate.haloStable &&=
          recordsKey(candidate.initial.halo) === recordsKey(current.halo);
        candidate.ferryStable &&=
          recordsKey(candidate.initial.ferry) === recordsKey(current.ferry);
        if (candidate.pass === 1) {
          candidate.pass = 2;
          candidate.passStartedAt = clock();
          candidate.state = {
            mode: "backfill",
            accountId: scope.accountId,
            operations: {},
            qsos: {},
          };
          candidate.lastStamps = { operations: null, qsos: null };
        } else candidate.pass = 3;
      }
      checkpoint = candidate;
      await save();
    }
    const current = await manifests();
    await checkScope();
    checkpoint.haloStable &&=
      recordsKey(checkpoint.initial.halo) === recordsKey(current.halo);
    checkpoint.ferryStable &&=
      recordsKey(checkpoint.initial.ferry) === recordsKey(current.ferry);
    await save();
  } catch (error) {
    stop =
      error instanceof AuditStop
        ? error.code
        : error instanceof VendorDeferredError
          ? error.requestSent
            ? "vendor_deferred"
            : "budget_deferred"
          : error instanceof LoFiError
            ? error.code === "account_changed"
              ? "account_changed"
              : error.status === 401
                ? "authentication_required"
                : error.status === 429
                  ? "vendor_deferred"
                  : error.status
                    ? "vendor_unavailable"
                    : "protocol_error"
            : "vendor_unavailable";
    if (["scope_changed", "scope_invalid", "checkpoint_invalid"].includes(stop))
      durable = false;
    if (error instanceof VendorDeferredError && stamp(error.retryAt))
      retryAt = error.retryAt;
    if (
      checkpoint &&
      ![
        "checkpoint_invalid",
        "scope_changed",
        "scope_invalid",
        "checkpoint_not_saved",
      ].includes(stop)
    ) {
      try {
        await save();
      } catch {
        stop = "checkpoint_not_saved";
      }
    }
  }
  if (checkpoint) {
    report.totalAttempts = checkpoint.attempts;
    report.pages = checkpoint.pages;
    report.completedPasses = checkpoint.pass - 1;
    report.firstRecords = checkpoint.first.length;
    report.secondRecords = checkpoint.second.length;
    report.operations = checkpoint.first.filter(
      (r) => r.kind === "operation",
    ).length;
    report.contacts = checkpoint.first.filter(
      (r) => r.kind === "qso" && !r.isEvent,
    ).length;
    report.events = checkpoint.first.filter((r) => r.isEvent).length;
    report.deleted = checkpoint.first.filter((r) => r.deleted).length;
    report.purged = checkpoint.first.filter((r) => r.purged).length;
    report.duplicateRows = checkpoint.duplicateRows;
    report.tiedRows = checkpoint.tiedRows;
    report.expandedPages = checkpoint.expandedPages;
    report.haloSnapshotStable = checkpoint.haloStable;
    report.ferrySnapshotStable = checkpoint.ferryStable;
    if (checkpoint.pass >= 2) {
      report.halo = compare(checkpoint.initial.halo, checkpoint.first);
      report.ferry = compare(checkpoint.initial.ferry, checkpoint.first);
    }
    if (checkpoint.pass === 3) {
      report.repeat = compare(checkpoint.first, checkpoint.second);
      const differences = [report.halo, report.ferry, report.repeat].some(
        (c) =>
          c.missing +
            c.additional +
            c.flags +
            c.membership +
            c.applicationVersions +
            c.serverVersions +
            c.revisions >
          0,
      );
      report.status =
        !checkpoint.haloStable || !checkpoint.ferryStable || differences
          ? "discrepancy"
          : [report.halo, report.ferry, report.repeat].some(
                (c) => c.unknownVersions > 0,
              )
            ? "incomplete"
            : "observed_match";
    }
  }
  if (stop)
    report.status = [
      "batch_limit",
      "time_limit",
      "budget_deferred",
      "vendor_deferred",
      "empty_incomplete_page",
      "page_overflow",
      "record_overflow",
      "run_expired",
      "attempt_limit",
    ].includes(stop)
      ? "incomplete"
      : stop === "conflicting_duplicate"
        ? "discrepancy"
        : "unavailable";
  report.stopReason = stop;
  report.retryAt = retryAt;
  report.batchAttempts = batchAttempts;
  report.checkpointSaved = durable;
  const elapsed = clock() - batchStart;
  report.elapsedMs = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  return report;
}
