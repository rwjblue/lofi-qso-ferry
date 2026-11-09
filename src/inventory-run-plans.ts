import type { QrzInventorySelection } from "./inventory-adapters.ts";
import type { InventoryStream } from "./inventory-ingestion.ts";
import type { InventoryRunDefinition } from "./inventory-run-publication.ts";
import type { SyncState } from "./lofi.ts";
import type { LotwQuery } from "./lotw.ts";
import type { QrzBook } from "./qrz.ts";
import { canonical, randomToken, sha256 } from "./security.ts";

export type InventoryScanPlan =
  | { provider: "lofi"; pageSize?: number }
  | {
      provider: "qrz";
      book: QrzBook;
      between: [string, string];
      pageSize?: number;
      repeatSelectionCatchup?: true;
    }
  | { provider: "lotw"; selection: Omit<LotwQuery, "receivedSince"> };

export type InventoryRunQuery =
  | {
      version: 1;
      provider: "lofi";
      fixedUpperBound: number;
      pageSize: number;
    }
  | {
      version: 1;
      provider: "qrz";
      book: QrzBook;
      selection: QrzInventorySelection;
      catchupSelection?: QrzInventorySelection;
      pageSize: number;
      repeatSelectionCatchup?: true;
    }
  | { version: 1; provider: "lotw"; query: LotwQuery };

function requireValue(value: unknown): asserts value {
  if (!value) throw new Error("invalid_inventory_scan_plan");
}
function object(value: unknown): Record<string, unknown> {
  requireValue(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function date(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}
function pageSize(value: unknown, maximum: number) {
  requireValue(
    Number.isSafeInteger(value) &&
      Number(value) > 0 &&
      Number(value) <= maximum,
  );
}
function dates(start: unknown, end: unknown) {
  requireValue(date(start) && date(end) && start <= end);
}
function qrzSelection(value: unknown) {
  const selection = object(value);
  requireValue(
    Array.isArray(selection.between) && selection.between.length === 2,
  );
  dates(selection.between[0], selection.between[1]);
  requireValue(
    selection.modifiedSince === undefined || date(selection.modifiedSince),
  );
}

/** Validate persisted queries before opening credentials or reserving HTTP. */
export function inventoryRunQuery(value: unknown): InventoryRunQuery {
  const query = object(value);
  requireValue(query.version === 1);
  if (query.provider === "lofi") {
    pageSize(query.pageSize, 1000);
    requireValue(
      Number.isSafeInteger(query.fixedUpperBound) &&
        Number(query.fixedUpperBound) > 0,
    );
  } else if (query.provider === "qrz") {
    pageSize(query.pageSize, 250);
    const book = object(query.book);
    requireValue(
      typeof book.bookId === "string" &&
        book.bookId.length > 0 &&
        typeof book.stationCallsign === "string" &&
        book.stationCallsign.length > 0,
    );
    dates(book.startDate, book.endDate);
    qrzSelection(query.selection);
    if (query.catchupSelection !== undefined)
      qrzSelection(query.catchupSelection);
    const selection = object(query.selection);
    const between = selection.between as string[];
    requireValue(
      between[0] >= String(book.startDate) &&
        between[1] <= String(book.endDate),
    );
    requireValue(
      query.repeatSelectionCatchup === undefined ||
        (query.repeatSelectionCatchup === true &&
          Date.parse(between[1]) - Date.parse(between[0]) <= 34 * 86400000),
    );
    if (query.catchupSelection !== undefined) {
      const catchup = object(query.catchupSelection);
      requireValue(
        canonical(catchup.between) === canonical(selection.between) &&
          (query.repeatSelectionCatchup === true
            ? selection.modifiedSince === undefined &&
              catchup.modifiedSince === undefined
            : date(catchup.modifiedSince)),
      );
    }
  } else if (query.provider === "lotw") {
    const selection = object(query.query);
    dates(selection.startDate, selection.endDate);
    // Bigger universes are separate streams, not an unbounded report request.
    requireValue(
      Date.parse(String(selection.endDate)) -
        Date.parse(String(selection.startDate)) <=
        31 * 86400000,
    );
    for (const key of ["stationCallsign", "workedCallsign"])
      requireValue(
        selection[key] === undefined ||
          (typeof selection[key] === "string" &&
            /^[A-Za-z0-9/]+$/.test(selection[key])),
      );
    requireValue(
      selection.receivedSince === undefined ||
        date(selection.receivedSince) ||
        (typeof selection.receivedSince === "string" &&
          /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(
            selection.receivedSince,
          )),
    );
  } else throw new Error("invalid_inventory_scan_plan");
  return structuredClone(value) as InventoryRunQuery;
}

function priorCheckpoint(stream: InventoryStream) {
  return object(stream.checkpoint);
}

/** An overlapping scheduling lower bound, never a claimed vendor watermark. */
export function qrzModifiedLowerBound(startedAt: number) {
  requireValue(Number.isSafeInteger(startedAt) && startedAt > 86400000);
  return new Date(startedAt - 86400000).toISOString().slice(0, 10);
}

/** One fixed query and binding per phase; retries never regenerate the bounds. */
export async function planInventoryRun(
  stream: InventoryStream,
  plan: InventoryScanPlan,
  options: { mode?: "full" | "delta"; id?: string; now?: number } = {},
): Promise<InventoryRunDefinition> {
  stream = structuredClone(stream);
  plan = structuredClone(plan);
  const mode = options.mode ?? "full";
  const now = options.now ?? Date.now();
  const id = options.id ?? randomToken();
  requireValue(
    plan.provider === stream.provider && Number.isSafeInteger(now) && now > 0,
  );
  let query: InventoryRunQuery;
  let initialResume: unknown;
  let partitionSelection: unknown;
  if (plan.provider === "lofi") {
    const config = object(JSON.parse(stream.connectionConfig));
    requireValue(
      config.accountId === stream.logicalIdentity &&
        stream.remoteIdentity === stream.logicalIdentity,
    );
    query = {
      version: 1,
      provider: "lofi",
      fixedUpperBound: now,
      pageSize: plan.pageSize ?? 1000,
    };
    if (mode === "delta") {
      const checkpoint = priorCheckpoint(stream);
      requireValue(
        checkpoint.mode === "forward" &&
          checkpoint.accountId === stream.logicalIdentity &&
          checkpoint.readerPolicy === "all-clients-v1" &&
          typeof checkpoint.policyEpoch === "string" &&
          checkpoint.policyEpoch.length > 0,
      );
      // A completed checkpoint has no live cursor. Retain only server stamps.
      const operations = object(checkpoint.operations);
      const qsos = object(checkpoint.qsos);
      for (const side of [operations, qsos])
        requireValue(
          Number.isSafeInteger(side.watermark) && Number(side.watermark) >= 0,
        );
      initialResume = {
        mode: "forward",
        accountId: stream.logicalIdentity,
        readerPolicy: "all-clients-v1",
        policyEpoch: checkpoint.policyEpoch,
        operations: { watermark: Number(operations.watermark) },
        qsos: { watermark: Number(qsos.watermark) },
      } satisfies SyncState;
    } else
      initialResume = {
        mode: "backfill",
        accountId: stream.logicalIdentity,
        readerPolicy: "all-clients-v1",
        policyEpoch: id,
        operations: {},
        qsos: {},
      } satisfies SyncState;
    partitionSelection = ["all-client-sync", stream.logicalIdentity];
  } else if (plan.provider === "qrz") {
    const selection: QrzInventorySelection = { between: plan.between };
    partitionSelection = ["qrz-book-dates", plan.book, plan.between];
    if (mode === "delta") {
      const checkpoint = priorCheckpoint(stream);
      requireValue(
        checkpoint.kind === "qrz_inventory_v1" &&
          canonical(checkpoint.selection) === canonical(partitionSelection) &&
          date(checkpoint.modifiedSince),
      );
      selection.modifiedSince = checkpoint.modifiedSince;
    }
    query = {
      version: 1,
      provider: "qrz",
      book: plan.book,
      selection,
      ...(plan.repeatSelectionCatchup && { repeatSelectionCatchup: true }),
      ...(mode === "full"
        ? {
            catchupSelection: {
              between: plan.between,
              // A narrow historical scan can repeat its verified selection
              // when a modification-only response cannot establish absence.
              ...(plan.repeatSelectionCatchup
                ? {}
                : { modifiedSince: qrzModifiedLowerBound(now) }),
            },
          }
        : {}),
      pageSize: plan.pageSize ?? 250,
    };
    initialResume = {};
  } else {
    const querySelection = { ...plan.selection };
    partitionSelection = ["lotw-receipt", querySelection];
    const queryWithLower: LotwQuery = { ...querySelection };
    if (mode === "delta") {
      const checkpoint = priorCheckpoint(stream);
      requireValue(
        canonical(checkpoint.selection) === canonical(querySelection) &&
          typeof checkpoint.receivedThrough === "string",
      );
      queryWithLower.receivedSince = checkpoint.receivedThrough;
    }
    query = { version: 1, provider: "lotw", query: queryWithLower };
    initialResume = {};
  }
  query = inventoryRunQuery(query);
  const partitionBinding = await sha256(
    canonical([
      "inventory-partition-v1",
      stream.logicalIdentity,
      partitionSelection,
    ]),
  );
  const collectionBinding = await sha256(
    canonical(["inventory-collection-v1", stream.configVersion, query]),
  );
  const needsCatchup = mode === "full" && plan.provider !== "lotw";
  return {
    id,
    mode,
    facet: plan.provider === "lofi" ? "source" : "receipt",
    partition: partitionBinding,
    partitionBinding,
    collectionBinding,
    ...(needsCatchup
      ? {
          catchupBinding: await sha256(
            canonical(["inventory-catchup-v1", collectionBinding]),
          ),
        }
      : {}),
    requiredStreams:
      plan.provider === "lofi" ? ["operations", "qsos"] : ["selection"],
    fixedQuery: query,
    initialResume,
  };
}

export function qrzRunCheckpoint(
  query: Extract<InventoryRunQuery, { provider: "qrz" }>,
  startedAt: number,
) {
  return {
    kind: "qrz_inventory_v1",
    selection: ["qrz-book-dates", query.book, query.selection.between],
    modifiedSince: qrzModifiedLowerBound(startedAt),
  };
}
