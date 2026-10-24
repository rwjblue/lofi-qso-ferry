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
import type {
  InventoryCheckpoint,
  InventoryRecord,
  InventoryScope,
} from "./source-inventory-audit.ts";

const PAGE_SIZE = 25;
const MAX_READS = 4;
const MAX_RECORDS = 100;
const MAX_DURATION = 120_000;
const MAX_BASELINE_AGE = 300_000;
const MAX_INVENTORY_AGE = 90 * 60_000;
const stamp = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const validId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const hash = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
const id = (r: InventoryRecord) => `${r.kind}:${r.uuid}`;
const recordsKey = (rows: InventoryRecord[]) =>
  canonical([...rows].sort((a, b) => id(a).localeCompare(id(b))));
type Stop =
  | "baseline_invalid"
  | "baseline_incomplete"
  | "baseline_expired"
  | "baseline_changed"
  | "window_unavailable"
  | "scope_changed"
  | "scope_invalid"
  | "authentication_required"
  | "account_changed"
  | "transport_denied"
  | "budget_deferred"
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
interface Baseline {
  first: InventoryRecord[];
  second: InventoryRecord[];
  startedAt: number;
  updatedAt: number;
  lastRemoteReadAt: number;
  scopeDigest: string;
}
function scopeKey(scope: InventoryScope) {
  if (
    !scope ||
    ![
      scope.tenant,
      scope.source,
      scope.accountId,
      scope.credentialVersion,
    ].every(validId) ||
    typeof scope.clientKey !== "string" ||
    !scope.clientKey ||
    scope.clientKey.length > 512
  )
    throw new ProbeStop("scope_invalid");
  return canonical([
    scope.tenant,
    scope.source,
    scope.accountId,
    scope.clientKey,
    scope.credentialVersion,
  ]);
}
function validateRecords(rows: InventoryRecord[]) {
  if (!Array.isArray(rows) || rows.length > 10_000)
    throw new ProbeStop("baseline_invalid");
  const seen = new Set<string>();
  for (const r of rows) {
    if (
      !r ||
      Object.keys(r).sort().join(",") !==
        "deleted,isEvent,kind,operation,purged,revision,syncedAtMillis,updatedAtMillis,uuid" ||
      !["operation", "qso"].includes(r.kind) ||
      !validId(r.uuid) ||
      (r.operation !== null && !validId(r.operation)) ||
      (r.kind === "operation" && (r.operation !== null || r.isEvent)) ||
      [r.isEvent, r.deleted, r.purged].some((v) => typeof v !== "boolean") ||
      (r.updatedAtMillis !== null && !stamp(r.updatedAtMillis)) ||
      !stamp(r.syncedAtMillis) ||
      !hash(r.revision) ||
      seen.has(id(r))
    )
      throw new ProbeStop("baseline_invalid");
    seen.add(id(r));
  }
}
function windowFor(rows: InventoryRecord[], kind: InventoryRecord["kind"]) {
  const side = rows.filter((r) => r.kind === kind);
  const stamps = [...new Set(side.map((r) => r.syncedAtMillis as number))].sort(
    (a, b) => b - a,
  );
  if (stamps.length < 2) throw new ProbeStop("window_unavailable");
  // Select a bounded recent suffix. The watermark is an actual separately
  // observed older record, so positives never depend on inclusive equality.
  let watermark = stamps[1];
  for (const candidate of stamps.slice(1)) {
    if (
      side.filter((r) => (r.syncedAtMillis as number) > candidate).length > 10
    )
      break;
    watermark = candidate;
  }
  const expected = side.filter((r) => (r.syncedAtMillis as number) > watermark);
  if (expected.length < 1 || expected.length > PAGE_SIZE)
    throw new ProbeStop("window_unavailable");
  return { watermark, expected };
}
async function metadata(
  raw: SourceRecord,
  kind: InventoryRecord["kind"],
): Promise<InventoryRecord> {
  const operation =
    kind === "operation" || raw.operation === ""
      ? null
      : (raw.operation ?? null);
  if (
    !validId(raw.uuid) ||
    (operation !== null && !validId(operation)) ||
    !stamp(raw.syncedAtMillis) ||
    (raw.updatedAtMillis != null && !stamp(raw.updatedAtMillis))
  )
    throw new ProbeStop("protocol_error");
  let deleted: boolean;
  let purged: boolean;
  try {
    deleted = sourceFlag(raw.deleted);
    purged = sourceFlag(raw.purged);
  } catch {
    throw new ProbeStop("protocol_error");
  }
  const { syncedAtMillis: _, ...inputs } = raw;
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
 * Bounded observation of all-client forward reads against a separate completed
 * two-pass inventory. The caller reloads the protected checkpoint and current
 * scope; transport must use the shared vendor budget. No production state,
 * policy, default client behavior, credentials or source records are changed.
 * This validates known positives only, not complete future delivery or retention.
 */
export async function probeAllClientForwardReplay(options: {
  scope: InventoryScope;
  credentials: LoFiCredentials;
  loadScope: () => Promise<InventoryScope | null>;
  loadBaseline: () => Promise<InventoryCheckpoint>;
  fetcher: typeof fetch;
  now?: () => number;
}) {
  const clock = options.now ?? Date.now;
  const started = clock();
  const scope = { ...options.scope };
  const credentials = { ...options.credentials };
  const report = {
    evidence: "observed-all-client-forward-replay" as const,
    sourceBoundaryVerified: false as const,
    writesAuthorized: false as const,
    accountMembershipVerified: false as const,
    unknownHistoricalPurgesExcluded: false as const,
    continuousForwardCoverageVerified: false as const,
    writerProvenanceVerified: false as const,
    status: "incomplete" as
      | "incomplete"
      | "observed_match"
      | "discrepancy"
      | "unavailable",
    stopReason: null as Stop | null,
    retryAt: null as number | null,
    readAttempts: 0,
    pages: 0,
    completedPasses: 0,
    completedOperationPasses: 0,
    completedMemberPasses: 0,
    baselineRecords: 0,
    expectedRecords: 0,
    expectedOperations: 0,
    expectedContacts: 0,
    expectedEvents: 0,
    expectedDeleted: 0,
    observedRecords: 0,
    missingRecords: 0,
    changedRecords: 0,
    unexpectedRecords: 0,
    boundaryRecords: 0,
    repeatedReadDifferences: 0,
    duplicateRows: 0,
    tiedServerStamps: 0,
    baselineStable: false,
    currentScopeVerified: false,
    positiveDeliveryObserved: false,
    elapsedMs: 0,
  };
  const checkTime = () => {
    const now = clock();
    if (
      !stamp(started) ||
      !stamp(now) ||
      now < started ||
      now - started >= MAX_DURATION
    )
      throw new ProbeStop("time_cap");
  };
  const checkScope = async () => {
    let current: InventoryScope | null;
    try {
      current = await options.loadScope();
    } catch {
      throw new ProbeStop("scope_changed");
    }
    checkTime();
    if (!current || scopeKey(current) !== scopeKey(scope))
      throw new ProbeStop("scope_changed");
  };
  const checkAge = (baseline: Baseline) => {
    if (
      baseline.updatedAt > clock() ||
      baseline.lastRemoteReadAt > clock() ||
      clock() - baseline.lastRemoteReadAt > MAX_BASELINE_AGE ||
      clock() - baseline.startedAt > MAX_INVENTORY_AGE
    )
      throw new ProbeStop("baseline_expired");
  };
  const loadBaseline = async (digest: string): Promise<Baseline> => {
    let raw: InventoryCheckpoint;
    try {
      raw = await options.loadBaseline();
    } catch {
      throw new ProbeStop("baseline_invalid");
    }
    checkTime();
    if (
      raw?.schema !== 1 ||
      raw.scopeDigest !== digest ||
      raw.initial?.accountId !== scope.accountId ||
      raw.state?.accountId !== scope.accountId ||
      !stamp(raw.startedAt) ||
      !stamp(raw.updatedAt) ||
      !stamp(raw.passStartedAt) ||
      !stamp(raw.lastRemoteReadAt) ||
      raw.lastRemoteReadAt < raw.passStartedAt ||
      raw.lastRemoteReadAt > raw.updatedAt ||
      raw.startedAt > raw.passStartedAt ||
      raw.passStartedAt > raw.updatedAt ||
      !stamp(raw.pages) ||
      !stamp(raw.attempts) ||
      raw.pages > raw.attempts ||
      raw.attempts > 128
    )
      throw new ProbeStop("baseline_invalid");
    if (
      raw.pass !== 3 ||
      raw.state.mode !== "forward" ||
      raw.pages < 2 ||
      raw.haloStable !== true ||
      raw.ferryStable !== true
    )
      throw new ProbeStop("baseline_incomplete");
    validateRecords(raw.first);
    validateRecords(raw.second);
    const baseline: Baseline = {
      first: structuredClone(raw.first),
      second: structuredClone(raw.second),
      startedAt: raw.startedAt,
      updatedAt: raw.updatedAt,
      lastRemoteReadAt: raw.lastRemoteReadAt,
      scopeDigest: raw.scopeDigest,
    };
    checkAge(baseline);
    if (
      baseline.first.some(
        (r) => (r.syncedAtMillis as number) > raw.passStartedAt,
      ) ||
      baseline.second.some(
        (r) => (r.syncedAtMillis as number) > raw.passStartedAt,
      )
    )
      throw new ProbeStop("baseline_invalid");
    if (recordsKey(baseline.first) !== recordsKey(baseline.second))
      throw new ProbeStop("baseline_changed");
    return baseline;
  };
  try {
    checkTime();
    const digest = await sha256(scopeKey(scope));
    if (credentials.key !== scope.clientKey)
      throw new ProbeStop("scope_invalid");
    if (!credentials.token) throw new ProbeStop("authentication_required");
    await checkScope();
    const before = await loadBaseline(digest);
    const windows = {
      operations: windowFor(before.second, "operation"),
      qsos: windowFor(before.second, "qso"),
    };
    const expected = [...windows.operations.expected, ...windows.qsos.expected];
    const known = new Map(before.second.map((r) => [id(r), r]));
    report.baselineRecords = before.second.length;
    report.expectedRecords = expected.length;
    report.expectedOperations = windows.operations.expected.length;
    report.expectedContacts = windows.qsos.expected.filter(
      (r) => !r.isEvent,
    ).length;
    report.expectedEvents = expected.filter((r) => r.isEvent).length;
    report.expectedDeleted = expected.filter((r) => r.deleted).length;
    let allowedBody: string | undefined;
    let wireBody: string | undefined;
    const guarded: typeof fetch = async (input, init) => {
      checkTime();
      checkAge(before);
      const url = new URL(String(input));
      if (url.pathname === "/v1/client")
        throw new ProbeStop("authentication_required");
      if (
        url.href !== "https://lofi.ham2k.net/v1/sync" ||
        init?.method !== "POST" ||
        init.redirect !== "manual" ||
        allowedBody === undefined ||
        wireBody === undefined ||
        init.body !== allowedBody
      )
        throw new ProbeStop("transport_denied");
      // LoFiClient's default is deliberately unchanged. Validate its entire
      // request, then replace only the two approved client-filter booleans.
      const body = wireBody;
      allowedBody = undefined;
      wireBody = undefined;
      if (report.readAttempts >= MAX_READS) throw new ProbeStop("read_cap");
      report.readAttempts++;
      let response: Response;
      try {
        response = await options.fetcher(input, {
          ...init,
          body,
          signal: AbortSignal.any([
            ...(init.signal ? [init.signal] : []),
            AbortSignal.timeout(
              Math.max(1, Math.min(15000, MAX_DURATION - (clock() - started))),
            ),
          ]),
        });
      } catch (error) {
        if (error instanceof VendorDeferredError && !error.requestSent)
          report.readAttempts--;
        throw error;
      }
      try {
        checkTime();
        checkAge(before);
      } catch (error) {
        void response.body?.cancel().catch(() => {});
        throw error;
      }
      return response;
    };
    const passes: Map<string, InventoryRecord>[] = [];
    for (let pass = 0; pass < 2; pass++) {
      let state: SyncState = {
        mode: "forward",
        accountId: scope.accountId,
        operations: { watermark: windows.operations.watermark },
        qsos: { watermark: windows.qsos.watermark },
      };
      const found = new Map<string, InventoryRecord>();
      const stamps = new Set<string>();
      const completed = { operations: false, qsos: false };
      for (;;) {
        checkTime();
        checkAge(before);
        await checkScope();
        const body = (anyClient: boolean) =>
          JSON.stringify({
            meta: {
              inboundSync: true,
              lastSyncAccountUUID: scope.accountId,
              sync: Object.fromEntries(
                (["operations", "qsos"] as const).map((side) => [
                  side,
                  {
                    syncedSinceMillis: state[side].watermark ?? 0,
                    ...(state[side].cursor
                      ? { cursor: state[side].cursor }
                      : {}),
                    limit: PAGE_SIZE,
                    anyClient,
                  },
                ]),
              ),
            },
          });
        allowedBody = body(false);
        wireBody = body(true);
        const page = await new LoFiClient(credentials, guarded).syncPage(
          state,
          clock(),
          PAGE_SIZE,
        );
        allowedBody = undefined;
        wireBody = undefined;
        checkTime();
        checkAge(before);
        await checkScope();
        report.pages++;
        for (const side of ["operations", "qsos"] as const) {
          if (page[side].length > PAGE_SIZE)
            throw new ProbeStop("page_size_exceeded");
          if (!page.next[side].complete && page[side].length === 0)
            throw new ProbeStop("empty_incomplete_page");
          if (page.next[side].complete && !completed[side]) {
            completed[side] = true;
            if (side === "operations") report.completedOperationPasses++;
            else report.completedMemberPasses++;
          }
          const rows = await Promise.all(
            page[side].map((r) =>
              metadata(r, side === "operations" ? "operation" : "qso"),
            ),
          );
          for (const row of rows) {
            const time = row.syncedAtMillis as number;
            if (time < windows[side].watermark || time > clock())
              throw new ProbeStop("protocol_error");
            const prior = found.get(id(row));
            if (prior) {
              report.duplicateRows++;
              if (canonical(prior) !== canonical(row))
                throw new ProbeStop("conflicting_duplicate");
              continue;
            }
            if (found.size >= MAX_RECORDS) throw new ProbeStop("record_cap");
            const tied = `${row.kind}:${time}`;
            if (stamps.has(tied)) report.tiedServerStamps++;
            stamps.add(tied);
            found.set(id(row), row);
          }
        }
        if (page.complete) break;
        state = JSON.parse(JSON.stringify(page.next)) as SyncState;
      }
      report.completedPasses++;
      passes.push(found);
    }
    const after = await loadBaseline(digest);
    await checkScope();
    if (canonical(before) !== canonical(after))
      throw new ProbeStop("baseline_changed");
    report.baselineStable = true;
    report.currentScopeVerified = true;
    const [first, second] = passes;
    const changed = new Set<string>();
    for (const key of new Set([...first.keys(), ...second.keys()])) {
      const a = first.get(key);
      const b = second.get(key);
      const original = known.get(key);
      if (!a || !b || canonical(a) !== canonical(b))
        report.repeatedReadDifferences++;
      if (!original) {
        report.unexpectedRecords++;
        continue;
      }
      if ([a, b].some((row) => row && canonical(row) !== canonical(original)))
        changed.add(key);
      const side = original.kind === "operation" ? "operations" : "qsos";
      if (original.syncedAtMillis === windows[side].watermark)
        report.boundaryRecords++;
    }
    report.changedRecords = changed.size;
    for (const row of expected) {
      const a = first.get(id(row));
      const b = second.get(id(row));
      if (!a || !b) report.missingRecords++;
      else if (
        canonical(a) === canonical(row) &&
        canonical(b) === canonical(row)
      )
        report.observedRecords++;
    }
    report.positiveDeliveryObserved =
      report.observedRecords === report.expectedRecords;
    report.status =
      report.missingRecords +
        report.changedRecords +
        report.unexpectedRecords +
        report.repeatedReadDifferences >
      0
        ? "discrepancy"
        : "observed_match";
  } catch (error) {
    const reason: Stop =
      error instanceof ProbeStop
        ? error.code
        : error instanceof VendorDeferredError
          ? error.requestSent
            ? "vendor_deferred"
            : "budget_deferred"
          : error instanceof LoFiError
            ? error.status === 401
              ? "authentication_required"
              : error.code === "account_changed"
                ? "account_changed"
                : error.status === 429
                  ? "vendor_deferred"
                  : error.status
                    ? "vendor_unavailable"
                    : "protocol_error"
            : "vendor_unavailable";
    report.stopReason = reason;
    if (error instanceof VendorDeferredError && stamp(error.retryAt))
      report.retryAt = error.retryAt;
    report.status = [
      "baseline_incomplete",
      "baseline_expired",
      "window_unavailable",
      "read_cap",
      "time_cap",
      "empty_incomplete_page",
      "page_size_exceeded",
      "record_cap",
      "budget_deferred",
      "vendor_deferred",
    ].includes(reason)
      ? "incomplete"
      : ["baseline_changed", "conflicting_duplicate"].includes(reason)
        ? "discrepancy"
        : "unavailable";
  }
  const elapsed = clock() - started;
  report.elapsedMs = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  return report;
}
