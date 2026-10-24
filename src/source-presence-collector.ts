import {
  LoFiClient,
  type LoFiCredentials,
  type SideProgress,
  type SourceRecord,
  type SyncState,
} from "./lofi.ts";
import { LOFI_CLIENT_NAME } from "./lofi-identity.ts";
import { isEventRecord, isSourceDeleted } from "./projection.ts";
import { canonical, sha256 } from "./security.ts";
import { VendorDeferredError } from "./vendor-requests.ts";

export const SOURCE_PRESENCE_MAX_AGE_MS = 5 * 60_000;
export const SOURCE_PRESENCE_COLLECTION_MS = 120_000;
// Leave headroom for cursorless responses expanded over a tied edge timestamp.
export const SOURCE_PRESENCE_REQUEST_PAGE_SIZE = 25;
export const SOURCE_PRESENCE_MAX_PAGE_RECORDS = 100;
const MAX_PAGE_RECORD_BYTES = 1024 * 1024;

/** Logical credential identity excludes in-place bearer-token renewal. */
export interface SourcePresenceScope {
  tenant: string;
  source: string;
  accountId: string;
  credentialVersion: string;
  readerPolicy: "all-clients-v1";
  policyEpoch: string;
}

export interface SourcePresenceTarget {
  kind: "operation" | "qso";
  id: string;
  /** Base operations use their own id; QSO membership is not inferred. */
  operationId: string | null;
  revision: string;
  syncedAtMillis: number;
  deleted: boolean;
  isEvent: boolean;
}

export interface SourcePresenceWitness {
  scope: SourcePresenceScope;
  target: SourcePresenceTarget;
  /** Start of the successful source transport attempt, never cache-load time. */
  requestStartedAt: number;
}

export interface SourcePresenceInput {
  scope: SourcePresenceScope;
  credentials: LoFiCredentials;
  targets: readonly SourcePresenceTarget[];
  selectedContacts: readonly string[];
  /** Actual accepted server observations in this scope, not synthesized S+1. */
  observedAnchors?: readonly {
    kind: "operation" | "qso";
    syncedAtMillis: number;
  }[];
  cachedWitnesses?: readonly SourcePresenceWitness[];
  /** Total caller allowance remaining, including the mandatory later drain. */
  remainingRequests: number;
  /** Preserve these two values when resuming the same collection. */
  collectionStartedAt: number;
  collectionDeadline: number;
}

export interface SourcePresenceOptions {
  /** Caller supplies its normal budgeted transport; the collector adds no quota. */
  fetcher: typeof fetch;
  currentScope: () => Promise<SourcePresenceScope | null>;
  now?: () => number;
}

export type SourcePresenceHold =
  | "invalid_input"
  | "scope_changed"
  | "deadline"
  | "request_budget"
  | "vendor_deferred"
  | "read_failed"
  | "page_bound"
  | "invalid_page"
  | "partial_page"
  | "missing_target"
  | "changed_target"
  | "deleted_target"
  | "dependency_changed"
  | "window_unavailable"
  | "witness_expired";

export interface SourcePresenceResult {
  status: "observed" | "held";
  reason: SourcePresenceHold | null;
  witnesses: SourcePresenceWitness[];
  actualAttempts: number;
  remainingRequests: number;
  collectionStartedAt: number;
  collectionDeadline: number;
  retryAt?: number;
  /** Sensitive caller-only state; never serialize this in diagnostics. */
  credentials: LoFiCredentials;
  requiresFinalDrain: true;
  requiresDependencyReload: true;
  targetedWindowCoverageVerified: false;
  sourceBoundaryVerified: false;
  writesAuthorized: false;
}

class Held extends Error {
  constructor(readonly reason: SourcePresenceHold) {
    super(reason);
  }
}

const stamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
const key = (value: Pick<SourcePresenceTarget, "kind" | "id">) =>
  `${value.kind}:${value.id}`;
const same = (left: unknown, right: unknown) =>
  canonical(left) === canonical(right);

function validScope(
  value: SourcePresenceScope | null,
): value is SourcePresenceScope {
  return Boolean(
    value &&
      text(value.tenant) &&
      text(value.source) &&
      text(value.accountId) &&
      text(value.credentialVersion) &&
      value.readerPolicy === "all-clients-v1" &&
      text(value.policyEpoch),
  );
}

function validTarget(value: SourcePresenceTarget): boolean {
  return (
    (value.kind === "operation" || value.kind === "qso") &&
    text(value.id) &&
    (value.operationId === null ||
      (typeof value.operationId === "string" &&
        value.operationId.length <= 256)) &&
    /^[A-Za-z0-9_-]{43}$/.test(value.revision) &&
    stamp(value.syncedAtMillis) &&
    typeof value.deleted === "boolean" &&
    typeof value.isEvent === "boolean" &&
    (value.kind !== "operation" ||
      (value.operationId === value.id && !value.isEvent))
  );
}

async function targetFromRecord(
  kind: SourcePresenceTarget["kind"],
  raw: SourceRecord,
): Promise<SourcePresenceTarget> {
  if (
    !text(raw.uuid) ||
    !stamp(raw.syncedAtMillis) ||
    (kind === "qso" &&
      raw.operation !== undefined &&
      raw.operation !== null &&
      typeof raw.operation !== "string")
  )
    throw new Held("invalid_page");
  const { syncedAtMillis, ...inputs } = raw;
  return {
    kind,
    id: raw.uuid,
    operationId:
      kind === "operation"
        ? raw.uuid
        : typeof raw.operation === "string"
          ? raw.operation
          : null,
    revision: await sha256(canonical(inputs)),
    syncedAtMillis,
    deleted: isSourceDeleted(raw),
    isEvent: kind === "qso" && isEventRecord(raw),
  };
}

interface Window {
  targetStamp: number;
  progress: SideProgress;
  oldest?: number;
}

/**
 * Collect exact positive observations only. The caller must subsequently apply a
 * complete canonical forward drain, reload/reproject every dependency (including
 * previously unknown events), and enforce its own atomic prepare/dispatch guards.
 * Even an observed result certifies neither range coverage nor export safety.
 */
export async function collectSourcePresence(
  input: SourcePresenceInput,
  options: SourcePresenceOptions,
): Promise<SourcePresenceResult> {
  // Reject oversized inputs before cloning; snapshot before asynchronous work.
  const oversized =
    input.targets.length > 64 ||
    input.selectedContacts.length > 20 ||
    (input.observedAnchors?.length ?? 0) > 128 ||
    (input.cachedWitnesses?.length ?? 0) > 64;
  const scope = { ...input.scope };
  const credentials = { ...input.credentials };
  const startedAt = input.collectionStartedAt;
  const deadline = input.collectionDeadline;
  const allowance = input.remainingRequests;
  const targets = oversized
    ? []
    : input.targets.map((target) => ({ ...target }));
  const contacts = oversized ? [] : [...input.selectedContacts];
  const anchors = oversized
    ? []
    : (input.observedAnchors ?? []).map((anchor) => ({ ...anchor }));
  const cached = (oversized ? [] : (input.cachedWitnesses ?? [])).map(
    (witness) => ({
      scope: { ...witness.scope },
      target: { ...witness.target },
      requestStartedAt: witness.requestStartedAt,
    }),
  );
  const now = options.now ?? Date.now;
  const witnesses = new Map<string, SourcePresenceWitness>();
  let attempts = 0;
  let retryAt: number | undefined;
  let syncRequestStartedAt: number | undefined;
  let expectedSyncBody: string | undefined;
  let client: LoFiClient | undefined;
  let lastTime = startedAt;

  const checkTime = () => {
    const current = now();
    if (!stamp(current) || current < lastTime || current >= deadline)
      throw new Held("deadline");
    lastTime = current;
    return current;
  };
  const checkScope = async () => {
    checkTime();
    const current = await options.currentScope();
    checkTime();
    if (!validScope(current) || !same(scope, current)) {
      witnesses.clear();
      throw new Held("scope_changed");
    }
  };
  const transport: typeof fetch = async (url, init) => {
    await checkScope();
    if (attempts >= allowance - 1) throw new Held("request_budget");
    const sync = url === "https://lofi.ham2k.net/v1/sync";
    const register = url === "https://lofi.ham2k.net/v1/client";
    if (
      (!sync && !register) ||
      init?.method !== "POST" ||
      init.redirect !== "manual" ||
      typeof init.body !== "string" ||
      (sync && init.body !== expectedSyncBody) ||
      (register &&
        init.body !==
          JSON.stringify({
            client: {
              name: LOFI_CLIENT_NAME,
              type: "browser",
              key: credentials.key,
              secret: credentials.secret,
            },
          }))
    )
      throw new Held("invalid_input");
    // LoFiClient alone constructs the same-client renewal body. Source mutation
    // routes and GET/REST reads are never admitted by this transport.
    const requestStartedAt = checkTime();
    attempts++;
    let response: Response;
    try {
      response = await options.fetcher(url, {
        ...init,
        signal: AbortSignal.any([
          ...(init.signal ? [init.signal] : []),
          AbortSignal.timeout(deadline - requestStartedAt),
        ]),
      });
    } catch (error) {
      if (error instanceof VendorDeferredError) {
        if (!error.requestSent) attempts--;
        retryAt = error.retryAt;
      }
      throw error;
    }
    try {
      await checkScope();
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    if (sync && response.ok) syncRequestStartedAt = requestStartedAt;
    return response;
  };

  let reason: SourcePresenceHold | null = null;
  try {
    const initialNow = now();
    if (
      oversized ||
      !validScope(scope) ||
      !text(credentials.key) ||
      !text(credentials.secret) ||
      !stamp(startedAt) ||
      !stamp(deadline) ||
      !stamp(initialNow) ||
      startedAt > initialNow ||
      deadline <= startedAt ||
      deadline > startedAt + SOURCE_PRESENCE_COLLECTION_MS ||
      !Number.isSafeInteger(allowance) ||
      allowance < 1 ||
      allowance > 4 ||
      targets.length < 1 ||
      targets.length > 64 ||
      contacts.length < 1 ||
      contacts.length > 20 ||
      cached.length > 64 ||
      anchors.length > 128 ||
      targets.some((target) => !validTarget(target)) ||
      contacts.some((id) => !text(id)) ||
      anchors.some(
        (anchor) =>
          (anchor.kind !== "operation" && anchor.kind !== "qso") ||
          !stamp(anchor.syncedAtMillis),
      )
    )
      throw new Held("invalid_input");
    const required = new Map<string, SourcePresenceTarget>();
    for (const target of targets) {
      const previous = required.get(key(target));
      if (previous && !same(previous, target)) throw new Held("invalid_input");
      required.set(key(target), target);
    }
    for (const id of contacts) {
      const contact = required.get(key({ kind: "qso", id }));
      if (!contact || contact.isEvent || contact.deleted)
        throw new Held("invalid_input");
    }
    if (targets.some((target) => target.deleted))
      throw new Held("deleted_target");
    const operationIds = new Set(
      contacts.map((id) => required.get(key({ kind: "qso", id }))?.operationId),
    );
    await checkScope();
    for (const witness of cached) {
      const target = required.get(key(witness.target));
      if (
        target &&
        same(scope, witness.scope) &&
        same(target, witness.target) &&
        stamp(witness.requestStartedAt) &&
        witness.requestStartedAt <= initialNow &&
        witness.requestStartedAt > initialNow - SOURCE_PRESENCE_MAX_AGE_MS
      ) {
        const previous = witnesses.get(key(target));
        if (!previous || previous.requestStartedAt > witness.requestStartedAt)
          witnesses.set(key(target), witness);
      }
    }
    client = new LoFiClient(credentials, transport);
    const windows = new Map<SourcePresenceTarget["kind"], Window>();
    while (witnesses.size < required.size) {
      await checkScope();
      if (attempts >= allowance - 1) throw new Held("request_budget");
      const selectWindow = (
        kind: SourcePresenceTarget["kind"],
      ): SideProgress => {
        const missing = [...required.values()]
          .filter(
            (target) => target.kind === kind && !witnesses.has(key(target)),
          )
          .sort((left, right) => right.syncedAtMillis - left.syncedAtMillis);
        if (!missing.length) {
          windows.delete(kind);
          return { watermark: checkTime() };
        }
        const targetStamp = missing[0].syncedAtMillis;
        const previous = windows.get(kind);
        if (previous?.targetStamp === targetStamp) return previous.progress;
        const greater = anchors
          .filter(
            (anchor) =>
              anchor.kind === kind && anchor.syncedAtMillis > targetStamp,
          )
          .map((anchor) => anchor.syncedAtMillis);
        const ceiling = greater.length ? Math.min(...greater) : checkTime();
        if (ceiling <= targetStamp) throw new Held("window_unavailable");
        const progress = { watermark: ceiling };
        windows.set(kind, { targetStamp, progress });
        return progress;
      };
      const state: SyncState = {
        mode: "backfill",
        accountId: scope.accountId,
        readerPolicy: scope.readerPolicy,
        policyEpoch: scope.policyEpoch,
        operations: selectWindow("operation"),
        qsos: selectWindow("qso"),
      };
      const windowBody = (progress: SideProgress) => ({
        syncedUntilMillis: progress.watermark,
        ...(progress.cursor ? { cursor: progress.cursor } : {}),
        limit: SOURCE_PRESENCE_REQUEST_PAGE_SIZE,
        anyClient: true,
      });
      expectedSyncBody = JSON.stringify({
        meta: {
          inboundSync: true,
          lastSyncAccountUUID: scope.accountId,
          sync: {
            operations: windowBody(state.operations),
            qsos: windowBody(state.qsos),
          },
        },
      });
      syncRequestStartedAt = undefined;
      const page = await client.syncPage(
        state,
        checkTime(),
        SOURCE_PRESENCE_REQUEST_PAGE_SIZE,
      );
      await checkScope();
      if (syncRequestStartedAt === undefined) throw new Held("invalid_page");
      // Cursorless source pages may expand over a tied edge millisecond. The
      // requested limit is not a server response guarantee: retain a separate
      // application bound and never truncate a page or manufacture its cursor.
      // Check BOTH streams and their combined plaintext size before hashing or
      // retaining any witness; LoFiClient separately caps transport at 2 MiB.
      if (
        page.operations.length > SOURCE_PRESENCE_MAX_PAGE_RECORDS ||
        page.qsos.length > SOURCE_PRESENCE_MAX_PAGE_RECORDS
      )
        throw new Held("page_bound");
      const encoder = new TextEncoder();
      let recordBytes = 0;
      for (const rows of [page.operations, page.qsos]) {
        for (const raw of rows) {
          checkTime();
          recordBytes += encoder.encode(JSON.stringify(raw)).byteLength;
          if (recordBytes > MAX_PAGE_RECORD_BYTES) throw new Held("page_bound");
        }
      }
      // Publish only after BOTH streams validate. A rejected page may not leave
      // reusable positive witnesses behind for a later cache-only collection.
      const pageWitnesses = new Map(witnesses);
      const pageAnchors: typeof anchors = [];
      for (const [kind, side] of [
        ["operation", "operations"],
        ["qso", "qsos"],
      ] as const) {
        const rows = page[side];
        const window = windows.get(kind);
        let prior = state[side].watermark;
        for (const raw of rows) {
          checkTime();
          const observed = await targetFromRecord(kind, raw);
          checkTime();
          if (
            prior === undefined ||
            observed.syncedAtMillis > prior ||
            (!state[side].cursor &&
              observed.syncedAtMillis >= (state[side].watermark ?? 0)) ||
            (window?.oldest !== undefined &&
              observed.syncedAtMillis > window.oldest)
          )
            throw new Held("invalid_page");
          prior = observed.syncedAtMillis;
          pageAnchors.push({ kind, syncedAtMillis: observed.syncedAtMillis });
          const expected = required.get(key(observed));
          if (expected && !same(expected, observed)) {
            witnesses.delete(key(observed));
            throw new Held("changed_target");
          }
          if (expected && !pageWitnesses.has(key(observed))) {
            pageWitnesses.set(key(observed), {
              scope: { ...scope },
              target: observed,
              requestStartedAt: syncRequestStartedAt,
            });
          }
          if (
            !expected &&
            observed.isEvent &&
            !observed.deleted &&
            operationIds.has(observed.operationId)
          )
            throw new Held("dependency_changed");
        }
        const missing = [...required.values()].filter(
          (target) => target.kind === kind && !pageWitnesses.has(key(target)),
        );
        if (!missing.length) continue;
        const oldest = rows.length
          ? Number(rows[rows.length - 1].syncedAtMillis)
          : undefined;
        const complete = page.complete || page.next[side].complete;
        if (
          complete ||
          (oldest !== undefined &&
            missing.some((target) => target.syncedAtMillis > oldest))
        )
          throw new Held("missing_target");
        if (!rows.length) throw new Held("partial_page");
        if (
          !page.next[side].cursor &&
          missing.some((target) => target.syncedAtMillis === oldest)
        )
          throw new Held("partial_page");
        if (window) {
          window.progress = { ...page.next[side] };
          window.oldest = oldest;
        }
      }
      await checkScope();
      for (const [id, witness] of pageWitnesses) witnesses.set(id, witness);
      anchors.push(...pageAnchors);
    }
    await checkScope();
    const finishedAt = checkTime();
    if (
      [...witnesses.values()].some(
        (witness) =>
          witness.requestStartedAt <= finishedAt - SOURCE_PRESENCE_MAX_AGE_MS,
      )
    )
      throw new Held("witness_expired");
  } catch (error) {
    reason =
      error instanceof Held
        ? error.reason
        : error instanceof VendorDeferredError
          ? "vendor_deferred"
          : "read_failed";
  }
  return {
    status: reason ? "held" : "observed",
    reason,
    witnesses: [...witnesses.values()],
    actualAttempts: attempts,
    remainingRequests: Math.max(0, allowance - attempts),
    collectionStartedAt: startedAt,
    collectionDeadline: deadline,
    ...(retryAt === undefined ? {} : { retryAt }),
    credentials: client?.credentialsSnapshot() ?? credentials,
    requiresFinalDrain: true,
    requiresDependencyReload: true,
    targetedWindowCoverageVerified: false,
    sourceBoundaryVerified: false,
    writesAuthorized: false,
  };
}
