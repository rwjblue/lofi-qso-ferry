import type { AdifRecord } from "./adif.ts";
import { LotwClient } from "./lotw.ts";
import { adifInstant, QrzClient, QrzError, type QrzPage } from "./qrz.ts";
import {
  type QrzCoveringProgress,
  selectQrzCoveringRange,
  validateQrzCoveringPage,
} from "./qrz-covering.ts";
import type { Envelope } from "./security.ts";
import { canonical, open, randomToken, sha256 } from "./security.ts";
import type { Connection, Lease, LedgerKey, Store } from "./store.ts";
import type { VendorPriority } from "./vendor-requests.ts";
import { VendorDeferredError, vendorFetch } from "./vendor-requests.ts";

const DAY = 86_400_000;
export const HISTORY_INVENTORY_TTL = 4 * 3_600_000;
export const QRZ_AMBIGUOUS_EMPTY_RETRY_DELAY = 15 * 60_000;
const qrzRetryReason =
  "QRZ returned an ambiguous empty selection; bounded retry is scheduled";
const MAX_PARTITIONS = 2048;
const MAX_SCOPE_BYTES = 128 * 1024 * 1024;
const MAX_PARTITION_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 8192;
const MAX_PAGES = 48;
const PAGE_SIZE = 250;
const MAX_PAGE_BYTES = 128 * 1024;
const MAX_CANDIDATES = 512;
const QRZ_RADIUS = 30 * 60_000 + 59_000;
const KIND = "history_inventory";
// Keep this SQL projection aligned with history_inventory_guard in migration0017.
// Certificate/login health timestamps do not change destination read coverage.
const CONFIG_SCOPE_SQL =
  "json_object('bookId',json_extract(d.config,'$.bookId'),'stationCallsign',json_extract(d.config,'$.stationCallsign'),'startDate',json_extract(d.config,'$.startDate'),'endDate',json_extract(d.config,'$.endDate'),'readAccess',json_extract(d.config,'$.readAccess'),'stations',json((SELECT json_group_array(json_array(json_extract(value,'$.callsign'),json_extract(value,'$.dxcc'))) FROM json_each(CASE WHEN json_type(d.config,'$.stations')='array' THEN json_extract(d.config,'$.stations') ELSE json_array(json_extract(d.config,'$.station')) END))))";
function configScope(value: string): string {
  const config = JSON.parse(value) as Record<string, unknown>;
  const stations = Array.isArray(config.stations)
    ? config.stations
    : [config.station ?? null];
  return JSON.stringify({
    bookId: config.bookId ?? null,
    stationCallsign: config.stationCallsign ?? null,
    startDate: config.startDate ?? null,
    endDate: config.endDate ?? null,
    readAccess:
      typeof config.readAccess === "boolean"
        ? Number(config.readAccess)
        : (config.readAccess ?? null),
    stations: stations.map(
      (station: { callsign?: unknown; dxcc?: unknown } | null) => [
        station?.callsign ?? null,
        station?.dxcc ?? null,
      ],
    ),
  });
}
const FIELDS = new Set([
  "STATION_CALLSIGN",
  "CALL",
  "QSO_DATE",
  "TIME_ON",
  "BAND",
  "BAND_RX",
  "MODE",
  "SUBMODE",
  "PROP_MODE",
  "SAT_NAME",
  "FREQ",
  "FREQ_RX",
  "MY_GRIDSQUARE",
  "MY_STATE",
  "MY_CNTY",
  "MY_DXCC",
  "MY_LAT",
  "MY_LON",
  "MY_CQ_ZONE",
  "MY_ITU_ZONE",
  "MY_IOTA",
  "APP_QRZLOG_LOGID",
  "APP_LOTW_MODE",
  "APP_LOTW_MODEGROUP",
  "QSL_RCVD",
]);

export interface HistoryInventoryInput {
  source: Connection;
  destination: Connection;
  qso: string;
  generation: string;
  record: AdifRecord;
}
export interface HistoryInventoryResult {
  state: "ready" | "pending" | "unavailable";
  records: AdifRecord[];
  readAccess: boolean;
  /** Cached coverage is never the fresh identity check required before writes. */
  freshCheckComplete: false;
  fetched: boolean;
  progressed: boolean;
  completedPartitions: string[];
  capturedAt?: number;
  fence?: HistoryInventoryFence;
  reason?: string;
  /** Internal batch diagnostic only. Callers must never log or persist the raw error. */
  failure?: unknown;
}
export interface HistoryInventoryFence {
  tenant: string;
  source: string;
  destination: string;
  sourceRemote: string;
  destinationRemote: string;
  destinationKind: "qrz" | "lotw";
  destinationVersion: string;
  destinationConfig: string;
  partitions: { id: string; evidence: string; pageCount: number }[];
}
/** Recheck cache provenance inside the adoption transaction, not before it. */
export function historyInventoryGuard(
  key: LedgerKey,
  fence: HistoryInventoryFence,
  now = Date.now(),
): { sql: string; params: (string | number | null)[] } {
  if (
    key.tenant !== fence.tenant ||
    key.source !== fence.source ||
    key.destination !== fence.destination ||
    fence.partitions.length < 1 ||
    fence.partitions.length > 2 ||
    new Set(fence.partitions.map((partition) => partition.id)).size !==
      fence.partitions.length ||
    fence.partitions.some(
      (partition) =>
        !Number.isInteger(partition.pageCount) ||
        partition.pageCount < 0 ||
        partition.pageCount > MAX_PAGES,
    )
  )
    return { sql: "0", params: [] };
  const sql = [
    `EXISTS(SELECT 1 FROM accounts a JOIN connections s ON s.tenant=a.id JOIN connections d ON d.tenant=a.id JOIN private_data sp ON sp.tenant=s.tenant AND sp.connection=s.id AND sp.id=s.credential_version AND sp.kind='credential' JOIN private_data dp ON dp.tenant=d.tenant AND dp.connection=d.id AND dp.id=d.credential_version AND dp.kind='credential' WHERE a.id=? AND a.status='active' AND s.id=? AND s.kind='lofi' AND s.status='active' AND s.remote_identity=? AND sp.revoked_at IS NULL AND (sp.expires_at IS NULL OR sp.expires_at>?) AND d.id=? AND d.kind=? AND d.status='active' AND d.remote_identity=? AND d.credential_version=? AND ${CONFIG_SCOPE_SQL}=? AND dp.revoked_at IS NULL AND (dp.expires_at IS NULL OR dp.expires_at>?))`,
  ];
  const params: (string | number | null)[] = [
    key.tenant,
    key.source,
    fence.sourceRemote,
    now,
    key.destination,
    fence.destinationKind,
    fence.destinationRemote,
    fence.destinationVersion,
    fence.destinationConfig,
    now,
  ];
  for (const partition of fence.partitions) {
    sql.push(
      `EXISTS(SELECT 1 FROM partitions h WHERE h.tenant=? AND h.source=? AND h.destination=? AND h.id=? AND h.evidence=? AND h.state='complete' AND h.history_scope IS NOT NULL AND h.expires_at>? AND (SELECT COUNT(*) FROM history_inventory_pages pg JOIN private_data p ON p.tenant=pg.tenant AND p.connection=pg.destination AND p.id=pg.payload_id AND p.kind='history_inventory' WHERE pg.tenant=h.tenant AND pg.source=h.source AND pg.destination=h.destination AND pg.partition=h.id AND p.revoked_at IS NULL AND p.expires_at>?)=?)`,
    );
    params.push(
      key.tenant,
      key.source,
      key.destination,
      partition.id,
      partition.evidence,
      now,
      now,
      partition.pageCount,
    );
  }
  return { sql: sql.join(" AND "), params };
}
export interface HistoryInventoryOptions {
  fetcher?: typeof fetch;
  now?: number;
  vendorNow?: number;
  priority?: VendorPriority;
  /** Batch cold advances yield between representatives; completed reads can finish. */
  shouldContinue?: () => boolean;
  /** Independent partition advances; defaults to one and is bounded to four. */
  coldAdvanceConcurrency?: number;
}
interface Range {
  startDate: string;
  endDate: string;
}
interface Manifest extends Range {
  version: 1;
  epoch: string;
  destinationVersion: string;
  phase: "base" | "catchup" | "verify" | "done" | "split" | "blocked";
  cursor: number;
  pageCount: number;
  recordCount: number;
  createdAt: number;
  completedAt?: number;
  children?: Range[];
  reason?: string;
  retryStartedAt?: number;
  retryAfter?: number;
  /** Read plan/progress only; the target stays the original weekly range. */
  qrzCover?: Range & {
    attempts: number;
    progress?: QrzCoveringProgress;
    base?: { digest: string; recordCount: number };
  };
}
interface Partition {
  id: string;
  state: string;
  evidence: string;
  expires_at: number;
  history_bytes: number;
  history_scope: string;
  history_accessed_at: number;
}
const date = (at: number) => new Date(at).toISOString().slice(0, 10);
const adifDate = (value: string) => value.replaceAll("-", "");
/** Dates, not a new matching rule: retain every worked-call record on each
 * touched UTC date. Minute evidence covers its whole minute without inventing
 * seconds. The resulting interval can touch at most two dates/partition leaves.
 */
function lotwDates(record: AdifRecord): string[] {
  const start = adifInstant(record);
  const end = start + (record.TIME_ON.length === 4 ? 59_000 : 0);
  const radius = 30 * 60_000;
  return [...new Set([date(start - radius), date(end + radius)])];
}
function ranges(input: HistoryInventoryInput): { range: Range; day: string }[] {
  const at = adifInstant(input.record);
  if (input.destination.kind === "lotw")
    return lotwDates(input.record).map((day) => {
      const start = Math.floor(Date.parse(day) / (7 * DAY)) * 7 * DAY;
      return {
        range: { startDate: date(start), endDate: date(start + 6 * DAY) },
        day,
      };
    });
  const starts = [
    ...new Set(
      [at - QRZ_RADIUS, at + QRZ_RADIUS].map(
        (day) => Math.floor(day / (7 * DAY)) * 7 * DAY,
      ),
    ),
  ];
  return starts.map((start) => ({
    range: { startDate: date(start), endDate: date(start + 6 * DAY) },
    day: date(at),
  }));
}
function splitChild(state: Manifest, day: string): Range | undefined {
  const children = state.children;
  if (!Array.isArray(children) || children.length !== 2) return;
  const [left, right] = children;
  if (
    [left, right].some(
      (child) =>
        !child ||
        typeof child !== "object" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(child.startDate) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(child.endDate) ||
        !Number.isFinite(Date.parse(child.startDate)) ||
        !Number.isFinite(Date.parse(child.endDate)) ||
        date(Date.parse(child.startDate)) !== child.startDate ||
        date(Date.parse(child.endDate)) !== child.endDate ||
        child.startDate > child.endDate,
    ) ||
    left.startDate !== state.startDate ||
    right.endDate !== state.endDate ||
    Date.parse(left.endDate) + DAY !== Date.parse(right.startDate)
  )
    return;
  return children.find(
    (child) => child.startDate <= day && child.endDate >= day,
  );
}
function manifest(row: Partition): Manifest | null {
  try {
    const value = JSON.parse(row.evidence) as Manifest;
    if (
      value.version !== 1 ||
      !value.epoch ||
      !["base", "catchup", "verify", "done", "split", "blocked"].includes(
        value.phase,
      ) ||
      !Number.isSafeInteger(value.cursor) ||
      value.cursor < 0 ||
      !Number.isSafeInteger(value.createdAt) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.startDate) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.endDate) ||
      !Number.isFinite(Date.parse(value.startDate)) ||
      !Number.isFinite(Date.parse(value.endDate)) ||
      date(Date.parse(value.startDate)) !== value.startDate ||
      date(Date.parse(value.endDate)) !== value.endDate ||
      value.endDate < value.startDate ||
      Date.parse(value.endDate) - Date.parse(value.startDate) > 6 * DAY ||
      !Number.isInteger(value.pageCount) ||
      value.pageCount < 0 ||
      value.pageCount > MAX_PAGES ||
      !Number.isInteger(value.recordCount) ||
      value.recordCount < 0 ||
      value.recordCount > MAX_RECORDS ||
      (value.qrzCover !== undefined && !validCoverManifest(value)) ||
      ((value.retryAfter !== undefined || value.retryStartedAt !== undefined) &&
        (typeof value.retryAfter !== "number" ||
          typeof value.retryStartedAt !== "number" ||
          !Number.isSafeInteger(value.retryAfter) ||
          !Number.isSafeInteger(value.retryStartedAt) ||
          value.retryStartedAt < value.createdAt ||
          value.retryAfter <= value.retryStartedAt ||
          value.retryAfter - value.retryStartedAt >
            QRZ_AMBIGUOUS_EMPTY_RETRY_DELAY ||
          value.retryAfter > row.expires_at ||
          !["base", "verify"].includes(value.phase)))
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
function validCoverManifest(value: Manifest): boolean {
  const cover = value.qrzCover;
  if (!cover) return false;
  const hash = (value: unknown) =>
    typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
  const integer = (value: unknown, max: number) =>
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= max;
  if (
    !cover ||
    typeof cover !== "object" ||
    !["base", "verify", "done", "blocked"].includes(value.phase) ||
    !integer(cover.attempts, 4) ||
    ![cover.startDate, cover.endDate].every(
      (day) =>
        typeof day === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(day) &&
        Number.isFinite(Date.parse(day)) &&
        date(Date.parse(day)) === day,
    ) ||
    cover.startDate > value.startDate ||
    cover.endDate < value.endDate ||
    Date.parse(cover.endDate) - Date.parse(cover.startDate) > 34 * DAY ||
    (cover.base !== undefined &&
      (!hash(cover.base.digest) ||
        !integer(cover.base.recordCount, 996) ||
        cover.base.recordCount === 0)) ||
    (["verify", "done"].includes(value.phase) && !cover.base) ||
    (value.phase === "base" && cover.base !== undefined)
  )
    return false;
  const progress = cover.progress;
  if (!progress) return value.phase !== "done" && value.cursor === 0;
  return (
    integer(progress.pages, 4) &&
    progress.pages > 0 &&
    progress.pages <= cover.attempts &&
    integer(progress.bytes, MAX_PARTITION_BYTES) &&
    progress.bytes > 0 &&
    integer(progress.recordCount, 996) &&
    progress.recordCount > 0 &&
    hash(progress.digest) &&
    !!progress.anchor &&
    integer(progress.anchor.id, Number.MAX_SAFE_INTEGER) &&
    hash(progress.anchor.hash) &&
    value.cursor === progress.anchor.id &&
    (value.phase !== "done" ||
      (progress.digest === cover.base?.digest &&
        progress.recordCount === cover.base?.recordCount))
  );
}
function requireManifest(row: Partition): Manifest {
  const value = manifest(row);
  if (!value) throw new Error("Invalid history coverage manifest");
  return value;
}
function retryHeld(state: Manifest, now: number): boolean {
  // A clock moving backward must not turn a bounded retry into an arbitrary
  // future hold. Retry metadata is scheduling information, never coverage.
  return (
    state.retryStartedAt !== undefined &&
    state.retryAfter !== undefined &&
    state.retryStartedAt <= now &&
    state.retryAfter > now &&
    state.retryAfter - now <= QRZ_AMBIGUOUS_EMPTY_RETRY_DELAY
  );
}
function credentialVersion(input: HistoryInventoryInput): string {
  const version = input.destination.credential_version;
  if (!version)
    throw new Error("History destination credentials are unavailable");
  return version;
}
function scopeGuard(
  input: HistoryInventoryInput,
  now: number,
  member?: { qso: string; generation: string },
) {
  const { source: s, destination: d } = input;
  return {
    sql: `EXISTS(SELECT 1 FROM accounts a JOIN connections s ON s.tenant=a.id JOIN connections d ON d.tenant=a.id JOIN private_data sp ON sp.tenant=s.tenant AND sp.connection=s.id AND sp.id=s.credential_version AND sp.kind='credential' JOIN private_data dp ON dp.tenant=d.tenant AND dp.connection=d.id AND dp.id=d.credential_version AND dp.kind='credential' JOIN ledger l ON l.tenant=s.tenant AND l.source=s.id AND l.destination=d.id WHERE a.id=? AND a.status='active' AND s.id=? AND s.kind='lofi' AND s.status='active' AND s.remote_identity=? AND d.id=? AND d.kind=? AND d.status='active' AND d.credential_version=? AND ${CONFIG_SCOPE_SQL}=? AND d.remote_identity=? AND sp.revoked_at IS NULL AND (sp.expires_at IS NULL OR sp.expires_at>?) AND dp.revoked_at IS NULL AND (dp.expires_at IS NULL OR dp.expires_at>?) AND l.qso=${member?.qso ?? "?"} AND l.generation=${member?.generation ?? "?"})`,
    params: [
      s.tenant,
      s.id,
      s.remote_identity,
      d.id,
      d.kind,
      d.credential_version,
      configScope(d.config),
      d.remote_identity,
      now,
      now,
      ...(member ? [] : [input.qso, input.generation]),
    ],
  };
}
function currentMembers(
  store: Store,
  inputs: readonly HistoryInventoryInput[],
  now: number,
) {
  const guard = scopeGuard(inputs[0], now, {
    qso: "json_extract(member.value,'$[0]')",
    generation: "json_extract(member.value,'$[1]')",
  });
  return store.statement(
    `SELECT CAST(member.key AS INTEGER) ordinal FROM json_each(?) member WHERE ${guard.sql}`,
    JSON.stringify(inputs.map((input) => [input.qso, input.generation])),
    ...guard.params,
  );
}
async function current(
  store: Store,
  input: HistoryInventoryInput,
  now: number,
) {
  const guard = scopeGuard(input, now);
  return !!(await store
    .statement(`SELECT 1 n WHERE ${guard.sql}`, ...guard.params)
    .first());
}
async function scopeHash(
  input: Pick<HistoryInventoryInput, "source" | "destination" | "record">,
) {
  const { source: s, destination: d } = input;
  return sha256(
    canonical({
      v: 1,
      tenant: s.tenant,
      source: s.id,
      sourceRemote: s.remote_identity,
      destination: d.id,
      kind: d.kind,
      destinationVersion: d.credential_version,
      destinationConfig: configScope(d.config),
      destinationRemote: d.remote_identity,
      station: input.record.STATION_CALLSIGN.toUpperCase(),
    }),
  );
}
/** Same-scope metadata chooses a read range only, never evidence or write authority. */
export async function historyCoveringRange(
  store: Store,
  input: Pick<HistoryInventoryInput, "source" | "destination" | "record">,
  target: [string, string],
  now = Date.now(),
): Promise<[string, string] | null> {
  const config = JSON.parse(input.destination.config) as Record<
    string,
    unknown
  >;
  if (
    input.destination.kind !== "qrz" ||
    input.source.tenant !== input.destination.tenant ||
    !input.destination.credential_version ||
    typeof config.bookId !== "string" ||
    !config.bookId ||
    typeof config.stationCallsign !== "string" ||
    config.stationCallsign.toUpperCase() !==
      input.record.STATION_CALLSIGN.toUpperCase() ||
    typeof config.startDate !== "string" ||
    typeof config.endDate !== "string" ||
    config.readAccess === false
  )
    return null;
  const book: [string, string] = [config.startDate, config.endDate];
  if (!selectQrzCoveringRange(target, book)) return null;
  const rows = await store
    .statement(
      "SELECT * FROM partitions WHERE tenant=? AND source=? AND destination=? AND history_scope=? AND state='complete' AND expires_at>? ORDER BY id LIMIT ?",
      input.source.tenant,
      input.source.id,
      input.destination.id,
      await scopeHash(input),
      now,
      MAX_PARTITIONS + 1,
    )
    .all<Partition>();
  if (rows.results.length > MAX_PARTITIONS) return null;
  const hints: [string, string][] = [];
  for (const row of rows.results) {
    const state = manifest(row);
    if (
      state?.phase === "done" &&
      state.recordCount > 0 &&
      state.destinationVersion === input.destination.credential_version
    )
      hints.push([state.startDate, state.endDate]);
  }
  return selectQrzCoveringRange(target, book, hints);
}
async function neighborhood(
  scope: string,
  kind: Connection["kind"],
  record: AdifRecord,
) {
  return sha256(
    canonical([
      scope,
      record.CALL.toUpperCase(),
      kind === "qrz" ? record.BAND.toUpperCase() : "all-bands",
    ]),
  );
}
function guardStatement(
  store: Store,
  input: HistoryInventoryInput,
  row: Partition,
  lease: Lease,
  now: number,
  id: string,
  addedBytes: number,
) {
  const { source: s, destination: d } = input;
  return store.statement(
    "INSERT INTO history_inventory_guards VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    id,
    s.tenant,
    s.id,
    d.id,
    row.id,
    row.evidence,
    lease.scope,
    lease.token,
    lease.fence,
    now,
    d.credential_version,
    configScope(d.config),
    s.remote_identity,
    d.remote_identity,
    d.kind,
    input.qso,
    input.generation,
    addedBytes,
  );
}
/** Purge bounded cache metadata and ciphertext together; credentials/receipts are untouched. */
export async function pruneHistoryInventory(
  store: Store,
  now = Date.now(),
  limit = 32,
): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 256)
    throw new Error("Invalid history prune limit");
  const result = await store
    .statement(
      `DELETE FROM partitions WHERE (tenant,source,destination,id) IN(SELECT p.tenant,p.source,p.destination,p.id FROM partitions p WHERE p.history_scope IS NOT NULL AND (p.expires_at<=? OR NOT EXISTS(SELECT 1 FROM connections s JOIN connections d ON d.tenant=s.tenant WHERE s.tenant=p.tenant AND s.id=p.source AND d.id=p.destination AND s.status='active' AND d.status='active' AND d.credential_version=json_extract(p.evidence,'$.destinationVersion'))) ORDER BY p.expires_at LIMIT ?) RETURNING id`,
      now,
      limit,
    )
    .all<{ id: string }>();
  return result.results.length;
}
async function evictOne(
  store: Store,
  input: HistoryInventoryInput,
  now: number,
  keep: string,
) {
  const result = await store
    .statement(
      `DELETE FROM partitions WHERE (tenant,source,destination,id) IN(SELECT p.tenant,p.source,p.destination,p.id FROM partitions p WHERE p.tenant=? AND p.source=? AND p.destination=? AND p.history_scope IS NOT NULL AND p.id!=? AND (p.state IN('complete','blocked') OR json_extract(p.evidence,'$.phase')='split' OR p.expires_at<=?) AND NOT EXISTS(SELECT 1 FROM leases l WHERE l.tenant=p.tenant AND l.scope='history:'||p.id AND l.expires_at>?) ORDER BY p.history_accessed_at,p.id LIMIT 1)`,
      input.source.tenant,
      input.source.id,
      input.destination.id,
      keep,
      now,
      now,
    )
    .run();
  return result.meta.changes > 0;
}
async function partition(
  store: Store,
  input: HistoryInventoryInput,
  scope: string,
  range: Range,
  now: number,
): Promise<Partition | null> {
  const id = `history:v1:${await sha256(canonical([scope, range]))}`;
  const params = [
    input.source.tenant,
    input.source.id,
    input.destination.id,
    id,
  ];
  let row = await store
    .statement(
      "SELECT * FROM partitions WHERE tenant=? AND source=? AND destination=? AND id=?",
      ...params,
    )
    .first<Partition>();
  if (row && (row.expires_at <= now || !manifest(row))) {
    await store
      .statement(
        "DELETE FROM partitions WHERE tenant=? AND source=? AND destination=? AND id=? AND evidence=?",
        ...params,
        row.evidence,
      )
      .run();
    row = null;
  }
  if (!row) {
    const count = await store
      .statement(
        "SELECT COUNT(*) n FROM partitions WHERE tenant=? AND source=? AND destination=? AND history_scope IS NOT NULL",
        input.source.tenant,
        input.source.id,
        input.destination.id,
      )
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_PARTITIONS)
      await evictOne(store, input, now, id);
    const value: Manifest = {
      ...range,
      version: 1,
      epoch: randomToken(),
      destinationVersion: credentialVersion(input),
      phase: "base",
      cursor: 0,
      pageCount: 0,
      recordCount: 0,
      createdAt: now,
    };
    const guard = scopeGuard(input, now);
    await store
      .statement(
        `INSERT INTO partitions(tenant,source,destination,id,state,evidence,expires_at,history_scope,history_accessed_at) SELECT ?,?,?,?,'inventory_pending',?,?,?,? WHERE ${guard.sql} AND (SELECT COUNT(*) FROM partitions WHERE tenant=? AND source=? AND destination=? AND history_scope IS NOT NULL)<? ON CONFLICT(tenant,source,destination,id) DO NOTHING`,
        ...params,
        canonical(value),
        now + HISTORY_INVENTORY_TTL,
        scope,
        now,
        ...guard.params,
        input.source.tenant,
        input.source.id,
        input.destination.id,
        MAX_PARTITIONS,
      )
      .run();
    row = await store
      .statement(
        "SELECT * FROM partitions WHERE tenant=? AND source=? AND destination=? AND id=?",
        ...params,
      )
      .first<Partition>();
  }
  return row;
}
function compact(
  records: AdifRecord[],
  input: HistoryInventoryInput,
  range: Range,
): AdifRecord[] {
  return records.map((record) => {
    adifInstant(record);
    if (
      !record.CALL ||
      !record.BAND ||
      !(record.MODE || record.APP_LOTW_MODE) ||
      record.STATION_CALLSIGN?.toUpperCase() !==
        input.record.STATION_CALLSIGN.toUpperCase() ||
      record.QSO_DATE < adifDate(range.startDate) ||
      record.QSO_DATE > adifDate(range.endDate)
    )
      throw new Error("History response does not match partition scope");
    const selected = Object.fromEntries(
      Object.entries(record).filter(([field]) => FIELDS.has(field)),
    );
    if (Object.values(selected).some((value) => value.length > 256))
      throw new Error("History field exceeds retained evidence bound");
    return selected;
  });
}
function retainedPages(records: AdifRecord[]): AdifRecord[][] {
  const pages: AdifRecord[][] = [];
  let page: AdifRecord[] = [];
  let bytes = 2;
  for (const record of records) {
    const size = new TextEncoder().encode(JSON.stringify(record)).length + 1;
    if (size + 2 > MAX_PAGE_BYTES)
      throw new Error("History record exceeds retained evidence bound");
    if (
      page.length &&
      (page.length === PAGE_SIZE || bytes + size > MAX_PAGE_BYTES)
    ) {
      pages.push(page);
      page = [];
      bytes = 2;
    }
    page.push(record);
    bytes += size;
  }
  if (page.length) pages.push(page);
  return pages;
}
function retainedBytes(pages: AdifRecord[][]): number {
  return pages.reduce(
    (bytes, page) =>
      bytes + new TextEncoder().encode(JSON.stringify(page)).length,
    0,
  );
}
async function save(
  store: Store,
  input: HistoryInventoryInput,
  row: Partition,
  lease: Lease,
  next: Manifest,
  records: AdifRecord[],
  now: number,
  restart = false,
) {
  const prior = requireManifest(row);
  const chunks = retainedPages(records);
  const serializedBytes = retainedBytes(chunks);
  const addedBytes = serializedBytes - (restart ? row.history_bytes : 0);
  if (
    next.recordCount > MAX_RECORDS ||
    next.pageCount > MAX_PAGES ||
    row.history_bytes + addedBytes > MAX_PARTITION_BYTES
  )
    throw new Error("History partition exceeds retained evidence bound");
  for (let eviction = 0; ; eviction++) {
    const total = await store
      .statement(
        "SELECT COALESCE(SUM(history_bytes),0) bytes FROM partitions WHERE tenant=? AND source=? AND destination=? AND history_scope IS NOT NULL",
        input.source.tenant,
        input.source.id,
        input.destination.id,
      )
      .first<{ bytes: number }>();
    if ((total?.bytes ?? 0) + addedBytes <= MAX_SCOPE_BYTES) break;
    // Leave room for a worst-case 48-page save within the coordinator's
    // 200-statement allowance; later turns can continue bounded eviction.
    if (eviction >= 8 || !(await evictOne(store, input, now, row.id)))
      throw new Error("History cache exceeds retained evidence bound");
  }
  const statements: D1PreparedStatement[] = [];
  const guardId = randomToken();
  statements.push(
    guardStatement(store, input, row, lease, now, guardId, addedBytes),
  );
  if (restart)
    statements.push(
      store.statement(
        "DELETE FROM history_inventory_pages WHERE tenant=? AND source=? AND destination=? AND partition=?",
        input.source.tenant,
        input.source.id,
        input.destination.id,
        row.id,
      ),
    );
  for (let offset = 0; offset < chunks.length; offset++) {
    const page = (restart ? 0 : prior.pageCount) + offset + 1;
    const values = chunks[offset];
    const payloadId = `history:${row.id}:${prior.epoch}:${page}`;
    statements.push(
      await store.putPrivate(
        input.source.tenant,
        input.destination.id,
        payloadId,
        KIND,
        values,
        row.expires_at,
      ),
    );
    statements.push(
      store.statement(
        "INSERT INTO history_inventory_pages(tenant,source,destination,partition,page,payload_id) VALUES(?,?,?,?,?,?)",
        input.source.tenant,
        input.source.id,
        input.destination.id,
        row.id,
        page,
        payloadId,
      ),
    );
    const index = await Promise.all(
      values.map(async (record, recordIndex) => ({
        identity: await sha256(
          canonical([
            row.history_scope,
            input.destination.kind === "qrz"
              ? record.APP_QRZLOG_LOGID
              : `${prior.epoch}:${page}:${recordIndex}`,
          ]),
        ),
        neighborhood: await neighborhood(
          row.history_scope,
          input.destination.kind,
          record,
        ),
        recordIndex,
      })),
    );
    statements.push(
      store.statement(
        `INSERT INTO history_inventory_neighborhoods(tenant,source,destination,partition,identity_hash,neighborhood_hash,page,record_index) SELECT ?,?,?,?,json_extract(value,'$.identity'),json_extract(value,'$.neighborhood'),?,json_extract(value,'$.recordIndex') FROM json_each(?) WHERE 1 ON CONFLICT(tenant,source,destination,partition,identity_hash) DO UPDATE SET neighborhood_hash=excluded.neighborhood_hash,page=excluded.page,record_index=excluded.record_index`,
        input.source.tenant,
        input.source.id,
        input.destination.id,
        row.id,
        page,
        JSON.stringify(index),
      ),
    );
  }
  const updatedIndex = statements.length;
  statements.push(
    store.statement(
      "UPDATE partitions SET state=?,evidence=?,history_bytes=history_bytes+?,history_accessed_at=? WHERE tenant=? AND source=? AND destination=? AND id=? RETURNING *",
      next.phase === "done"
        ? "complete"
        : next.phase === "blocked"
          ? "blocked"
          : "inventory_pending",
      canonical(next),
      addedBytes,
      now,
      input.source.tenant,
      input.source.id,
      input.destination.id,
      row.id,
    ),
  );
  statements.push(
    store.statement("DELETE FROM history_inventory_guards WHERE id=?", guardId),
  );
  const results = await store.db.batch<Partition>(statements);
  const updated = results[updatedIndex].results[0];
  if (!updated) throw new Error("History partition changed during save");
  return updated;
}
async function advance(
  store: Store,
  input: HistoryInventoryInput,
  row: Partition,
  options: HistoryInventoryOptions,
  isolateReadFailures = false,
): Promise<{
  fetched: boolean;
  progressed: boolean;
  complete: boolean;
  noReadAccess?: boolean;
  partition?: Partition;
}> {
  const now = () => options.now ?? Date.now();
  if (retryHeld(requireManifest(row), now()))
    return { fetched: false, progressed: false, complete: false };
  const lease = await store.claim(
    input.source.tenant,
    `history:${row.id}`,
    now(),
    90_000,
  );
  if (!lease) return { fetched: false, progressed: false, complete: false };
  try {
    const guard = scopeGuard(input, now());
    const latest = await store
      .statement(
        `SELECT h.*,p.envelope credential_envelope FROM partitions h JOIN private_data p ON p.tenant=h.tenant AND p.connection=h.destination AND p.id=? AND p.kind='credential' WHERE h.tenant=? AND h.source=? AND h.destination=? AND h.id=? AND ${guard.sql}`,
        credentialVersion(input),
        input.source.tenant,
        input.source.id,
        input.destination.id,
        row.id,
        ...guard.params,
      )
      .first<Partition & { credential_envelope: string }>();
    if (!latest || latest.evidence !== row.evidence)
      return { fetched: false, progressed: false, complete: false };
    const prior = requireManifest(row);
    const credentials = await open<{
      apiKey?: string;
      query?: { username: string; password: string };
    }>(
      JSON.parse(latest.credential_envelope) as Envelope,
      {
        tenant: input.source.tenant,
        connection: input.destination.id,
        id: credentialVersion(input),
        kind: "credential",
        purpose: "storage",
      },
      store.keys,
    );
    const transport = vendorFetch(
      store,
      input.destination.kind as "qrz" | "lotw",
      options.fetcher,
      { priority: options.priority ?? "background", now: options.vendorNow },
    );
    let records: AdifRecord[];
    let next: Manifest = { ...prior };
    delete next.retryStartedAt;
    delete next.retryAfter;
    if (input.destination.kind === "qrz") {
      if (!credentials?.apiKey)
        return {
          fetched: false,
          progressed: false,
          complete: false,
          noReadAccess: true,
        };
      const client = new QrzClient(credentials.apiKey, { fetch: transport });
      if (prior.qrzCover)
        return await advanceCover(
          store,
          input,
          row,
          lease,
          prior,
          client,
          options,
          isolateReadFailures,
        );
      let page: QrzPage;
      try {
        page = await client.fetchPage({
          between: [prior.startDate, prior.endDate],
          afterLogId: prior.cursor,
          max: PAGE_SIZE,
          ...(prior.phase === "catchup"
            ? { modifiedSince: date(prior.createdAt) }
            : {}),
        });
      } catch (error) {
        if (
          ["base", "verify"].includes(prior.phase) &&
          error instanceof QrzError &&
          error.kind === "rejected" &&
          error.detail === "ambiguous_empty_selection"
        ) {
          const checkedAt = now();
          const cover = await historyCoveringRange(
            store,
            input,
            [prior.startDate, prior.endDate],
            checkedAt,
          );
          if (cover) {
            // The failed selection supplies no evidence. Persist a fixed read
            // plan, discarding every previous partial page in the same guard.
            await save(
              store,
              input,
              row,
              lease,
              {
                ...prior,
                epoch: randomToken(),
                phase: "base",
                cursor: 0,
                pageCount: 0,
                recordCount: 0,
                createdAt: checkedAt,
                retryStartedAt: undefined,
                retryAfter: undefined,
                qrzCover: {
                  startDate: cover[0],
                  endDate: cover[1],
                  attempts: 0,
                },
              },
              [],
              checkedAt,
              true,
            );
            return { fetched: true, progressed: true, complete: false };
          }
          await save(
            store,
            input,
            row,
            lease,
            {
              ...prior,
              retryStartedAt: checkedAt,
              retryAfter: Math.min(
                checkedAt + QRZ_AMBIGUOUS_EMPTY_RETRY_DELAY,
                row.expires_at,
              ),
            },
            [],
            checkedAt,
          );
        }
        if (
          prior.phase !== "catchup" ||
          !(error instanceof QrzError) ||
          error.kind !== "rejected"
        )
          throw isolateReadFailures ? new HistoryReadFailure(error) : error;
        // QRZ can reject an empty MODSINCE selection without explaining why.
        // That response proves nothing. Discard the incomplete first pass and
        // require a new, successful full scan before returning any evidence.
        await save(
          store,
          input,
          row,
          lease,
          {
            ...prior,
            epoch: randomToken(),
            phase: "verify",
            cursor: 0,
            pageCount: 0,
            recordCount: 0,
            createdAt: now(),
          },
          [],
          now(),
          true,
        );
        return { fetched: true, progressed: true, complete: false };
      }
      try {
        records = compact(page.records, input, prior);
      } catch (error) {
        throw isolateReadFailures ? new HistoryReadFailure(error) : error;
      }
      if (page.nextAfterLogId !== null) next.cursor = page.nextAfterLogId;
      else if (prior.phase === "base") {
        next.phase = "catchup";
        next.cursor = 0;
      } else {
        next.phase = "done";
        next.completedAt = now();
      }
    } else {
      if (!credentials?.query)
        return {
          fetched: false,
          progressed: false,
          complete: false,
          noReadAccess: true,
        };
      try {
        const report = await new LotwClient(credentials.query, {
          fetcher: transport,
        }).query({
          startDate: prior.startDate,
          endDate: prior.endDate,
          stationCallsign: input.record.STATION_CALLSIGN,
        });
        records = compact(report.records, input, prior);
        if (
          records.length > MAX_RECORDS ||
          new TextEncoder().encode(JSON.stringify(records)).length >
            MAX_PARTITION_BYTES
        )
          throw new Error(
            "Vendor response exceeds bounded partition; split the date range",
          );
        next.phase = "done";
        next.completedAt = now();
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !==
            "Vendor response exceeds bounded partition; split the date range"
        )
          throw isolateReadFailures ? new HistoryReadFailure(error) : error;
        const start = Date.parse(prior.startDate);
        const end = Date.parse(prior.endDate);
        if (start === end)
          next = {
            ...prior,
            phase: "blocked",
            reason:
              "One-day LoTW inventory exceeds bounded readback; targeted review is required",
          };
        else {
          const middle = start + Math.floor((end - start) / DAY / 2) * DAY;
          next = {
            ...prior,
            phase: "split",
            children: [
              { startDate: prior.startDate, endDate: date(middle) },
              { startDate: date(middle + DAY), endDate: prior.endDate },
            ],
          };
        }
        await save(store, input, row, lease, next, [], now());
        return { fetched: true, progressed: true, complete: false };
      }
    }
    next.recordCount += records.length;
    const chunks = retainedPages(records);
    next.pageCount += chunks.length;
    if (
      next.recordCount > MAX_RECORDS ||
      next.pageCount > MAX_PAGES ||
      row.history_bytes + retainedBytes(chunks) > MAX_PARTITION_BYTES
    ) {
      await save(
        store,
        input,
        row,
        lease,
        {
          ...prior,
          phase: "blocked",
          reason:
            "History inventory exceeds bounded retained evidence; targeted review is required",
        },
        [],
        now(),
      );
      return { fetched: true, progressed: true, complete: false };
    }
    const saved = await save(store, input, row, lease, next, records, now());
    return {
      fetched: true,
      progressed: true,
      complete: next.phase === "done",
      partition: saved,
    };
  } finally {
    await store.release(lease);
  }
}
/** One budgeted page per turn; both cover passes must finish within the original cache TTL. */
async function advanceCover(
  store: Store,
  input: HistoryInventoryInput,
  row: Partition,
  lease: Lease,
  prior: Manifest,
  client: QrzClient,
  options: HistoryInventoryOptions,
  isolateReadFailures: boolean,
) {
  const now = () => options.now ?? Date.now();
  const cover = prior.qrzCover;
  if (!cover) throw new Error("Missing history covering read plan");
  if (options.shouldContinue?.() === false)
    return { fetched: false, progressed: false, complete: false };
  if (cover.attempts >= 4)
    throw new QrzError("blocked", "QRZ covering read attempt limit reached");
  const nextCover = { ...cover, attempts: cover.attempts + 1 };
  let next: Manifest = {
    ...prior,
    retryStartedAt: undefined,
    retryAfter: undefined,
    qrzCover: nextCover,
  };
  let records: AdifRecord[];
  let complete: boolean;
  let progress: QrzCoveringProgress;
  try {
    const deadline = Math.min(lease.expires_at, row.expires_at) - now();
    if (deadline <= 0)
      throw new QrzError("blocked", "QRZ covering read deadline reached");
    const page = await client.fetchPage({
      between: [cover.startDate, cover.endDate],
      afterLogId: cover.progress?.anchor?.id ?? 0,
      max: PAGE_SIZE,
      signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, deadline))),
    });
    const validated = await validateQrzCoveringPage(
      page,
      [cover.startDate, cover.endDate],
      input.record.STATION_CALLSIGN,
      cover.progress,
    );
    // Validate the entire cover before any original-target filtering. Only
    // target rows enter encrypted storage; outer records survive as hashes.
    let compacted: AdifRecord[];
    try {
      compacted = compact(validated.records, input, cover);
    } catch {
      throw new QrzError(
        "protocol",
        "QRZ covering read retained scope mismatch",
      );
    }
    records = compacted.filter(
      (record) =>
        record.QSO_DATE >= adifDate(prior.startDate) &&
        record.QSO_DATE <= adifDate(prior.endDate),
    );
    complete = validated.complete;
    progress = validated.progress;
    nextCover.progress = progress;
    next.cursor = progress.anchor.id;
    if (
      complete &&
      prior.phase === "verify" &&
      (validated.progress.digest !== cover.base?.digest ||
        validated.progress.recordCount !== cover.base?.recordCount)
    )
      throw new QrzError("blocked", "QRZ covering verification changed");
  } catch (error) {
    // Budget-only deferral sends no request and consumes no persisted attempt.
    if (
      error instanceof QrzError ||
      (error instanceof VendorDeferredError && error.requestSent)
    ) {
      const at = now();
      const retry =
        (error instanceof VendorDeferredError ||
          ["transient", "auth"].includes(error.kind)) &&
        cover.attempts + 1 < 4;
      await save(
        store,
        input,
        row,
        lease,
        {
          ...prior,
          qrzCover: { ...cover, attempts: cover.attempts + 1 },
          phase: retry ? prior.phase : "blocked",
          reason: retry
            ? undefined
            : "QRZ covering history could not be verified; retry after cache expiry or review",
          retryStartedAt: retry ? at : undefined,
          retryAfter: retry
            ? Math.min(at + QRZ_AMBIGUOUS_EMPTY_RETRY_DELAY, row.expires_at)
            : undefined,
        },
        [],
        at,
      );
    }
    throw isolateReadFailures ? new HistoryReadFailure(error) : error;
  }
  if (complete && prior.phase === "base") {
    // Start verification from zero over exactly the same cover. Clearing base
    // pages avoids retaining deleted/changed identities from the first pass.
    next = {
      ...next,
      phase: "verify",
      epoch: randomToken(),
      cursor: 0,
      pageCount: 0,
      recordCount: 0,
      qrzCover: {
        startDate: cover.startDate,
        endDate: cover.endDate,
        attempts: 0,
        base: {
          digest: progress.digest,
          recordCount: progress.recordCount,
        },
      },
    };
    const partition = await save(
      store,
      input,
      row,
      lease,
      next,
      [],
      now(),
      true,
    );
    return { fetched: true, progressed: true, complete: false, partition };
  }
  next.recordCount += records.length;
  next.pageCount += retainedPages(records).length;
  if (complete) {
    next.phase = "done";
    next.completedAt = now();
  }
  const partition = await save(store, input, row, lease, next, records, now());
  return { fetched: true, progressed: true, complete, partition };
}
/**
 * At most one bounded, budgeted read per invocation. Partial/expired/revoked
 * partitions never produce ready (including an empty candidate set). Positive
 * cached evidence is distinct from the existing fresh prewrite identity check.
 */
export async function historyCandidates(
  store: Store,
  input: HistoryInventoryInput,
  options: HistoryInventoryOptions = {},
): Promise<HistoryInventoryResult> {
  return readHistoryCandidates(store, input, options);
}
/** Only failures inside vendor read/validation boundaries are isolated by a batch. */
class HistoryReadFailure extends Error {
  constructor(readonly failure: unknown) {
    super("Destination history read failed");
  }
}
async function readHistoryCandidates(
  store: Store,
  input: HistoryInventoryInput,
  options: HistoryInventoryOptions,
  isolateReadFailures = false,
): Promise<HistoryInventoryResult> {
  const now = () => options.now ?? Date.now();
  const result: HistoryInventoryResult = {
    state: "pending",
    records: [],
    readAccess: false,
    freshCheckComplete: false,
    fetched: false,
    progressed: false,
    completedPartitions: [],
  };
  if (
    input.source.tenant !== input.destination.tenant ||
    input.source.kind !== "lofi" ||
    !["qrz", "lotw"].includes(input.destination.kind) ||
    !input.source.credential_version ||
    !input.destination.credential_version ||
    !input.record.STATION_CALLSIGN ||
    !input.record.CALL ||
    !input.record.BAND ||
    !(await current(store, input, now()))
  )
    return {
      ...result,
      reason: "History source, connection or credential changed",
    };
  if (
    input.destination.kind === "lotw" &&
    JSON.parse(input.destination.config).readAccess === false
  )
    return {
      ...result,
      state: "unavailable",
      reason: "Destination history read credentials are unavailable",
    };
  result.readAccess = true;
  const scope = await scopeHash(input);
  const wanted = ranges(input);
  const required: Partition[] = [];
  const loaded = new Map<string, Partition | null>();
  const load = async (range: Range) => {
    const key = `${range.startDate}/${range.endDate}`;
    if (!loaded.has(key))
      loaded.set(key, await partition(store, input, scope, range, now()));
    return loaded.get(key);
  };
  for (const { range, day } of wanted) {
    let row = await load(range);
    if (!row)
      return {
        ...result,
        reason: "History cache is at its bounded partition limit",
      };
    for (let depth = 0; depth < 4; depth++) {
      const state = requireManifest(row);
      if (state.phase !== "split") break;
      const child = splitChild(state, day);
      if (!child)
        return {
          ...result,
          state: "unavailable",
          reason: "History split coverage is incomplete",
        };
      const next = await load(child);
      if (!next)
        return {
          ...result,
          reason: "History cache is at its bounded partition limit",
        };
      row = next;
    }
    if (requireManifest(row).phase === "split")
      return {
        ...result,
        state: "unavailable",
        reason: "History split coverage is incomplete",
      };
    if (!required.some((entry) => entry.id === row.id)) required.push(row);
  }
  for (let index = 0; index < required.length; index++) {
    const row = required[index];
    const state = requireManifest(row);
    if (state.phase === "blocked")
      return { ...result, state: "unavailable", reason: state.reason };
    if (state.phase !== "done" || row.state !== "complete") {
      if (retryHeld(state, now())) return { ...result, reason: qrzRetryReason };
      if (!result.fetched) {
        const progress = await advance(
          store,
          input,
          row,
          options,
          isolateReadFailures,
        );
        if (progress.noReadAccess)
          return {
            ...result,
            state: "unavailable",
            readAccess: false,
            reason: "Destination history read credentials are unavailable",
          };
        result.fetched ||= progress.fetched;
        result.progressed ||= progress.progressed;
        if (progress.complete) {
          result.completedPartitions.push(row.id);
          const refreshed = progress.partition;
          if (
            refreshed &&
            refreshed.state === "complete" &&
            manifest(refreshed)?.phase === "done"
          ) {
            required[index] = refreshed;
            continue;
          }
        }
      }
      return {
        ...result,
        reason:
          "Destination history partition is incomplete; continue bounded inventory",
      };
    }
  }
  const wantedHash = await neighborhood(
    scope,
    input.destination.kind,
    input.record,
  );
  const candidates: AdifRecord[] = [];
  const dates =
    input.destination.kind === "lotw" ? lotwDates(input.record) : [];
  let candidateCount = 0;
  for (const row of required) {
    const state = requireManifest(row);
    const [availability, neighborhoods] = await store.db.batch([
      store.statement(
        "SELECT COUNT(*) n FROM history_inventory_pages h JOIN private_data p ON p.tenant=h.tenant AND p.connection=h.destination AND p.id=h.payload_id AND p.kind='history_inventory' WHERE h.tenant=? AND h.source=? AND h.destination=? AND h.partition=? AND p.revoked_at IS NULL AND p.expires_at>?",
        input.source.tenant,
        input.source.id,
        input.destination.id,
        row.id,
        now(),
      ),
      store.statement(
        "SELECT n.page,json_group_array(n.record_index) record_indices,h.payload_id,p.envelope FROM history_inventory_neighborhoods n JOIN history_inventory_pages h ON h.tenant=n.tenant AND h.source=n.source AND h.destination=n.destination AND h.partition=n.partition AND h.page=n.page JOIN private_data p ON p.tenant=h.tenant AND p.connection=h.destination AND p.id=h.payload_id AND p.kind='history_inventory' WHERE n.tenant=? AND n.source=? AND n.destination=? AND n.partition=? AND n.neighborhood_hash=? AND p.revoked_at IS NULL AND p.expires_at>? GROUP BY n.page,h.payload_id,p.envelope LIMIT ?",
        input.source.tenant,
        input.source.id,
        input.destination.id,
        row.id,
        wantedHash,
        now(),
        MAX_PAGES + 1,
      ),
    ]);
    const available = availability.results[0] as { n: number } | undefined;
    if (available?.n !== state.pageCount)
      return {
        ...result,
        state: "unavailable",
        reason:
          "Retained history page expired or was revoked; coverage is incomplete",
      };
    const indexed = neighborhoods.results as {
      page: number;
      record_indices: string;
      payload_id: string;
      envelope: string;
    }[];
    candidateCount += indexed.reduce(
      (count, entry) =>
        count + (JSON.parse(entry.record_indices) as number[]).length,
      0,
    );
    if (indexed.length > MAX_PAGES || candidateCount > MAX_CANDIDATES)
      return {
        ...result,
        state: "unavailable",
        reason:
          "History neighborhood exceeds bounded comparison; targeted review is required",
      };
    const pages = new Map<number, AdifRecord[]>();
    for (const entry of indexed) {
      let records = pages.get(entry.page);
      if (!records) {
        records = await open<AdifRecord[]>(
          JSON.parse(entry.envelope) as Envelope,
          {
            tenant: input.source.tenant,
            connection: input.destination.id,
            id: entry.payload_id,
            kind: KIND,
            purpose: "storage",
          },
          store.keys,
        );
        if (!Array.isArray(records) || records.length > PAGE_SIZE)
          throw new Error("Invalid retained history page");
        pages.set(entry.page, records);
      }
      for (const recordIndex of JSON.parse(entry.record_indices) as number[]) {
        const record = records[recordIndex];
        if (!record)
          return {
            ...result,
            state: "unavailable",
            reason: "Retained history index is incomplete",
          };
        const sameCall =
          record.CALL.toUpperCase() === input.record.CALL.toUpperCase();
        if (input.destination.kind === "qrz") {
          if (
            sameCall &&
            record.BAND.toUpperCase() === input.record.BAND.toUpperCase() &&
            Math.abs(adifInstant(record) - adifInstant(input.record)) <=
              QRZ_RADIUS
          )
            candidates.push(record);
        } else if (
          sameCall &&
          dates.some((day) => adifDate(day) === record.QSO_DATE)
        )
          candidates.push(record);
      }
    }
  }
  const comparedAt = now();
  const guard = scopeGuard(input, comparedAt);
  const validations = await store.db.batch([
    ...required.map((row) =>
      store.statement(
        "SELECT 1 n FROM partitions h WHERE h.tenant=? AND h.source=? AND h.destination=? AND h.id=? AND h.evidence=? AND h.state='complete' AND h.expires_at>? AND (SELECT COUNT(*) FROM history_inventory_pages pg JOIN private_data p ON p.tenant=pg.tenant AND p.connection=pg.destination AND p.id=pg.payload_id AND p.kind='history_inventory' WHERE pg.tenant=h.tenant AND pg.source=h.source AND pg.destination=h.destination AND pg.partition=h.id AND p.revoked_at IS NULL AND p.expires_at>?)=?",
        input.source.tenant,
        input.source.id,
        input.destination.id,
        row.id,
        row.evidence,
        comparedAt,
        comparedAt,
        requireManifest(row).pageCount,
      ),
    ),
    store.statement(`SELECT 1 n WHERE ${guard.sql}`, ...guard.params),
    ...required.map((row) =>
      store.statement(
        "UPDATE partitions SET history_accessed_at=? WHERE tenant=? AND source=? AND destination=? AND id=? AND evidence=?",
        comparedAt,
        input.source.tenant,
        input.source.id,
        input.destination.id,
        row.id,
        row.evidence,
      ),
    ),
  ]);
  if (
    validations
      .slice(0, required.length)
      .some((result) => !result.results.length)
  )
    return {
      ...result,
      records: [],
      state: "unavailable",
      reason:
        "Retained history changed during comparison; coverage is incomplete",
    };
  if (
    !validations[required.length].results.length ||
    required.some((row) => row.expires_at <= now())
  )
    return {
      ...result,
      reason: "History source, connection or credential changed",
    };
  return {
    ...result,
    state: "ready",
    records: candidates,
    capturedAt: Math.min(
      ...required.map((row) => requireManifest(row).createdAt),
    ),
    fence: {
      tenant: input.source.tenant,
      source: input.source.id,
      destination: input.destination.id,
      sourceRemote: input.source.remote_identity,
      destinationRemote: input.destination.remote_identity,
      destinationKind: input.destination.kind as "qrz" | "lotw",
      destinationVersion: credentialVersion(input),
      destinationConfig: configScope(input.destination.config),
      partitions: required.map((row) => ({
        id: row.id,
        evidence: row.evidence,
        pageCount: requireManifest(row).pageCount,
      })),
    },
  };
}

const MAX_BATCH_INPUTS = 20;
const MAX_BATCH_RESULT_BYTES = 8 * 1024 * 1024;
const changedScope = "History source, connection or credential changed";
const incompletePartition =
  "Destination history partition is incomplete; continue bounded inventory";
function pendingHistory(reason = incompletePartition): HistoryInventoryResult {
  return {
    state: "pending",
    records: [],
    readAccess: false,
    freshCheckComplete: false,
    fetched: false,
    progressed: false,
    completedPartitions: [],
    reason,
  };
}
function validInput(input: HistoryInventoryInput) {
  return (
    input.source.tenant === input.destination.tenant &&
    input.source.kind === "lofi" &&
    ["qrz", "lotw"].includes(input.destination.kind) &&
    !!input.source.credential_version &&
    !!input.destination.credential_version &&
    !!input.record.STATION_CALLSIGN &&
    !!input.record.CALL &&
    !!input.record.BAND
  );
}
interface BatchMember {
  input: HistoryInventoryInput;
  ordinal: number;
  wanted: { id: string; range: Range; day: string }[];
  dates: string[];
  required: Partition[];
  advance?: string;
  unavailable?: string;
  held?: boolean;
  hash: string;
}
function partitionRows(
  store: Store,
  input: HistoryInventoryInput,
  ids: string[],
) {
  return store.statement(
    "SELECT * FROM partitions WHERE tenant=? AND source=? AND destination=? AND id IN(SELECT value FROM json_each(?))",
    input.source.tenant,
    input.source.id,
    input.destination.id,
    JSON.stringify(ids),
  );
}
async function rangeIdentity(scope: string, range: Range) {
  return { id: `history:v1:${await sha256(canonical([scope, range]))}`, range };
}

/**
 * Request-scoped comparison of at most twenty contacts in one read scope.
 * Results retain independent generation validation and the existing commit fence.
 * Only actual cold advances carry fetch/progress metrics, on their representative.
 */
export async function historyCandidatesBatch(
  store: Store,
  inputs: readonly HistoryInventoryInput[],
  options: HistoryInventoryOptions = {},
): Promise<HistoryInventoryResult[]> {
  if (inputs.length > MAX_BATCH_INPUTS)
    throw new Error("History inventory batch exceeds twenty contacts");
  if (!inputs.length) return [];
  if (inputs.some((input) => !validInput(input)))
    return inputs.map(() => pendingHistory(changedScope));
  const scopes = await Promise.all(inputs.map(scopeHash));
  if (scopes.some((scope) => scope !== scopes[0]))
    throw new Error("History inventory batch mixes read scopes");
  return readHistoryBatch(store, inputs, scopes[0], options, true);
}

async function readHistoryBatch(
  store: Store,
  inputs: readonly HistoryInventoryInput[],
  scope: string,
  options: HistoryInventoryOptions,
  allowAdvance: boolean,
): Promise<HistoryInventoryResult[]> {
  const now = () => options.now ?? Date.now();
  const first = inputs[0];
  const results = inputs.map(() => pendingHistory());
  const members: BatchMember[] = await Promise.all(
    inputs.map(async (input, ordinal) => ({
      input,
      ordinal,
      wanted: await Promise.all(
        ranges(input).map(async ({ range, day }) => ({
          ...(await rangeIdentity(scope, range)),
          day,
        })),
      ),
      dates: input.destination.kind === "lotw" ? lotwDates(input.record) : [],
      required: [],
      hash: await neighborhood(scope, input.destination.kind, input.record),
    })),
  );
  const initial = await store.db.batch([
    currentMembers(store, inputs, now()),
    partitionRows(store, first, [
      ...new Set(members.flatMap((m) => m.wanted.map((r) => r.id))),
    ]),
  ]);
  const valid = new Set(
    (initial[0].results as { ordinal: number }[]).map((row) => row.ordinal),
  );
  const retained = new Map(
    (initial[1].results as unknown as Partition[]).map((row) => [row.id, row]),
  );
  const active = members.filter((member) => {
    if (!valid.has(member.ordinal)) {
      results[member.ordinal] = pendingHistory(changedScope);
      return false;
    }
    if (
      first.destination.kind === "lotw" &&
      JSON.parse(first.destination.config).readAccess === false
    ) {
      results[member.ordinal] = {
        ...pendingHistory(
          "Destination history read credentials are unavailable",
        ),
        state: "unavailable",
      };
      return false;
    }
    results[member.ordinal].readAccess = true;
    return true;
  });
  // Split leaves are loaded in bounded levels, with shared metadata read once.
  for (let depth = 0; depth < 5; depth++) {
    const missing = new Set<string>();
    for (const member of active) {
      member.required = [];
      member.advance = undefined;
      member.unavailable = undefined;
      member.held = false;
      for (let index = 0; index < member.wanted.length; index++) {
        const wanted = member.wanted[index];
        const row = retained.get(wanted.id);
        const state = row && manifest(row);
        if (!row || !state || row.expires_at <= now()) {
          member.advance ??= wanted.id;
          continue;
        }
        if (state.phase === "split") {
          const child = splitChild(state, wanted.day);
          if (!child || depth === 4) {
            member.unavailable = "History split coverage is incomplete";
            continue;
          }
          member.wanted[index] = {
            ...(await rangeIdentity(scope, child)),
            day: wanted.day,
          };
          missing.add(member.wanted[index].id);
          continue;
        }
        if (state.phase === "blocked")
          member.unavailable =
            state.reason ?? "History partition requires review";
        else if (state.phase !== "done" || row.state !== "complete") {
          if (retryHeld(state, now())) member.held = true;
          else member.advance ??= row.id;
        }
        if (!member.required.some((entry) => entry.id === row.id))
          member.required.push(row);
      }
    }
    if (!missing.size) break;
    const loaded = await partitionRows(store, first, [
      ...missing,
    ]).all<Partition>();
    for (const row of loaded.results) retained.set(row.id, row);
  }
  const advances = new Map<string, BatchMember>();
  for (const member of active) {
    if (member.unavailable) {
      results[member.ordinal] = {
        ...results[member.ordinal],
        state: "unavailable",
        reason: member.unavailable,
      };
    } else if (member.held) results[member.ordinal].reason = qrzRetryReason;
    else if (member.advance && !advances.has(member.advance))
      advances.set(member.advance, member);
  }
  if (allowAdvance && advances.size) {
    const progressed = new Map<number, HistoryInventoryResult>();
    const failures = new Map<string, unknown>();
    const requested = options.coldAdvanceConcurrency ?? 1;
    const concurrency = Number.isFinite(requested)
      ? Math.max(1, Math.min(4, Math.floor(requested)))
      : 1;
    const queued = [...advances];
    let next = 0;
    let stopped = false;
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, queued.length) }, async () => {
        try {
          while (!stopped && options.shouldContinue?.() !== false) {
            const entry = queued[next++];
            if (!entry) return;
            const [partition, member] = entry;
            try {
              progressed.set(
                member.ordinal,
                await readHistoryCandidates(store, member.input, options, true),
              );
            } catch (error) {
              if (!(error instanceof HistoryReadFailure)) throw error;
              failures.set(partition, error.failure);
            }
          }
        } catch (error) {
          stopped = true;
          throw error;
        }
      }),
    );
    // A failed guard stops new work, but every started save and lease release
    // must finish before the caller can release its source cycle lease.
    const failure = workers.find((worker) => worker.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    // A cold advance can replace an epoch, split a range, or evict another row.
    // Never reuse any metadata or plaintext captured before those mutations.
    const refreshed = await readHistoryBatch(
      store,
      inputs,
      scope,
      options,
      false,
    );
    for (const [ordinal, result] of progressed) {
      refreshed[ordinal].fetched = result.fetched;
      refreshed[ordinal].progressed = result.progressed;
      refreshed[ordinal].completedPartitions = result.completedPartitions;
      if (!result.readAccess && result.state === "unavailable")
        for (const [index, member] of refreshed.entries())
          if (member.reason !== changedScope)
            refreshed[index] = {
              ...member,
              state: "unavailable",
              readAccess: false,
              records: [],
              fence: undefined,
              reason: result.reason,
            };
    }
    for (const member of active) {
      const failed = [
        ...member.wanted.map((row) => row.id),
        ...member.required.map((row) => row.id),
      ].find((id) => failures.has(id));
      if (failed)
        refreshed[member.ordinal] = {
          ...refreshed[member.ordinal],
          state: "pending",
          records: [],
          fence: undefined,
          failure: failures.get(failed),
          reason: "Destination history read failed; retry automatically",
        };
    }
    return refreshed;
  }
  const ready = active.filter(
    (member) => !member.advance && !member.unavailable && !member.held,
  );
  const leaves = new Map<string, Partition>();
  for (const member of ready)
    for (const row of member.required) leaves.set(row.id, row);
  const failed = new Map<number, string>();
  const compared = new Map<number, AdifRecord[]>();
  const resultBytes = new Map<number, number>();
  const candidateCounts = new Map<number, number>();
  let totalBytes = 0;
  for (const row of leaves.values()) {
    const relevant = ready.filter((m) =>
      m.required.some((p) => p.id === row.id),
    );
    const [availability, neighborhoods] = await store.db.batch([
      store.statement(
        "SELECT COUNT(*) n FROM history_inventory_pages h JOIN private_data p ON p.tenant=h.tenant AND p.connection=h.destination AND p.id=h.payload_id AND p.kind='history_inventory' WHERE h.tenant=? AND h.source=? AND h.destination=? AND h.partition=? AND p.revoked_at IS NULL AND p.expires_at>?",
        first.source.tenant,
        first.source.id,
        first.destination.id,
        row.id,
        now(),
      ),
      store.statement(
        "SELECT n.page,json_group_array(json_array(n.neighborhood_hash,n.record_index)) record_indices,h.payload_id,p.envelope FROM history_inventory_neighborhoods n JOIN history_inventory_pages h ON h.tenant=n.tenant AND h.source=n.source AND h.destination=n.destination AND h.partition=n.partition AND h.page=n.page JOIN private_data p ON p.tenant=h.tenant AND p.connection=h.destination AND p.id=h.payload_id AND p.kind='history_inventory' WHERE n.tenant=? AND n.source=? AND n.destination=? AND n.partition=? AND n.neighborhood_hash IN(SELECT value FROM json_each(?)) AND p.revoked_at IS NULL AND p.expires_at>? GROUP BY n.page,h.payload_id,p.envelope LIMIT ?",
        first.source.tenant,
        first.source.id,
        first.destination.id,
        row.id,
        JSON.stringify([...new Set(relevant.map((m) => m.hash))]),
        now(),
        MAX_PAGES + 1,
      ),
    ]);
    const indexed = neighborhoods.results as {
      page: number;
      record_indices: string;
      payload_id: string;
      envelope: string;
    }[];
    if (
      (availability.results[0] as { n: number } | undefined)?.n !==
        requireManifest(row).pageCount ||
      indexed.length > MAX_PAGES
    ) {
      for (const member of relevant)
        failed.set(
          member.ordinal,
          "Retained history page expired or was revoked; coverage is incomplete",
        );
      continue;
    }
    const counts = new Map<string, number>();
    const indices = indexed.map((entry) => {
      const values = JSON.parse(entry.record_indices) as [string, number][];
      for (const [hash] of values)
        counts.set(hash, (counts.get(hash) ?? 0) + 1);
      return values;
    });
    for (const member of relevant) {
      const count =
        (candidateCounts.get(member.ordinal) ?? 0) +
        (counts.get(member.hash) ?? 0);
      candidateCounts.set(member.ordinal, count);
      if (count > MAX_CANDIDATES)
        failed.set(
          member.ordinal,
          "History neighborhood exceeds bounded comparison; targeted review is required",
        );
    }
    for (let page = 0; page < indexed.length; page++) {
      const entry = indexed[page];
      const records = await open<AdifRecord[]>(
        JSON.parse(entry.envelope) as Envelope,
        {
          tenant: first.source.tenant,
          connection: first.destination.id,
          id: entry.payload_id,
          kind: KIND,
          purpose: "storage",
        },
        store.keys,
      );
      if (!Array.isArray(records) || records.length > PAGE_SIZE)
        throw new Error("Invalid retained history page");
      for (const [hash, recordIndex] of indices[page]) {
        const record = records[recordIndex];
        const matching = relevant.filter(
          (m) => m.hash === hash && !failed.has(m.ordinal),
        );
        if (!record) {
          for (const member of matching)
            failed.set(member.ordinal, "Retained history index is incomplete");
          continue;
        }
        for (const member of matching) {
          const source = member.input.record;
          if (record.CALL.toUpperCase() !== source.CALL.toUpperCase()) continue;
          if (
            first.destination.kind === "qrz"
              ? record.BAND.toUpperCase() !== source.BAND.toUpperCase() ||
                Math.abs(adifInstant(record) - adifInstant(source)) > QRZ_RADIUS
              : !member.dates.some((day) => adifDate(day) === record.QSO_DATE)
          )
            continue;
          const bytes = new TextEncoder().encode(JSON.stringify(record)).length;
          if (totalBytes + bytes > MAX_BATCH_RESULT_BYTES) {
            totalBytes -= resultBytes.get(member.ordinal) ?? 0;
            resultBytes.delete(member.ordinal);
            compared.delete(member.ordinal);
            failed.set(
              member.ordinal,
              "History batch comparison budget reached; continue remaining contacts",
            );
            continue;
          }
          totalBytes += bytes;
          resultBytes.set(
            member.ordinal,
            (resultBytes.get(member.ordinal) ?? 0) + bytes,
          );
          const candidates = compared.get(member.ordinal) ?? [];
          candidates.push({ ...record });
          compared.set(member.ordinal, candidates);
        }
      }
    }
  }
  if (!leaves.size) return results;
  const rows = [...leaves.values()];
  const comparedAt = now();
  const validations = await store.db.batch([
    currentMembers(store, inputs, comparedAt),
    ...rows.map((row) =>
      store.statement(
        "SELECT 1 n FROM partitions h WHERE h.tenant=? AND h.source=? AND h.destination=? AND h.id=? AND h.evidence=? AND h.state='complete' AND h.expires_at>? AND (SELECT COUNT(*) FROM history_inventory_pages pg JOIN private_data p ON p.tenant=pg.tenant AND p.connection=pg.destination AND p.id=pg.payload_id AND p.kind='history_inventory' WHERE pg.tenant=h.tenant AND pg.source=h.source AND pg.destination=h.destination AND pg.partition=h.id AND p.revoked_at IS NULL AND p.expires_at>?)=?",
        first.source.tenant,
        first.source.id,
        first.destination.id,
        row.id,
        row.evidence,
        comparedAt,
        comparedAt,
        requireManifest(row).pageCount,
      ),
    ),
    ...rows.map((row) =>
      store.statement(
        "UPDATE partitions SET history_accessed_at=? WHERE tenant=? AND source=? AND destination=? AND id=? AND evidence=?",
        comparedAt,
        first.source.tenant,
        first.source.id,
        first.destination.id,
        row.id,
        row.evidence,
      ),
    ),
  ]);
  const stillCurrent = new Set(
    (validations[0].results as { ordinal: number }[]).map((r) => r.ordinal),
  );
  const unchanged = new Set(
    rows
      .filter((_, index) => validations[index + 1].results.length)
      .map((r) => r.id),
  );
  for (const member of ready) {
    const ordinal = member.ordinal;
    const reason = failed.get(ordinal);
    if (reason) {
      results[ordinal] = {
        ...results[ordinal],
        state: reason.startsWith("History batch comparison budget")
          ? "pending"
          : "unavailable",
        reason,
      };
    } else if (
      !stillCurrent.has(ordinal) ||
      member.required.some((r) => r.expires_at <= now())
    )
      results[ordinal] = pendingHistory(changedScope);
    else if (member.required.some((r) => !unchanged.has(r.id)))
      results[ordinal] = {
        ...results[ordinal],
        state: "unavailable",
        reason:
          "Retained history changed during comparison; coverage is incomplete",
      };
    else
      results[ordinal] = {
        ...results[ordinal],
        state: "ready",
        reason: undefined,
        records: compared.get(ordinal) ?? [],
        capturedAt: Math.min(
          ...member.required.map((r) => requireManifest(r).createdAt),
        ),
        fence: {
          tenant: first.source.tenant,
          source: first.source.id,
          destination: first.destination.id,
          sourceRemote: first.source.remote_identity,
          destinationRemote: first.destination.remote_identity,
          destinationKind: first.destination.kind as "qrz" | "lotw",
          destinationVersion: credentialVersion(first),
          destinationConfig: configScope(first.destination.config),
          partitions: member.required.map((r) => ({
            id: r.id,
            evidence: r.evidence,
            pageCount: requireManifest(r).pageCount,
          })),
        },
      };
  }
  return results;
}
