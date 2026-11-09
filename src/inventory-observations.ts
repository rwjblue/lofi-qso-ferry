import type { AdifRecord } from "./adif.ts";
import { historicalCandidates } from "./historical-matching.ts";
import type { InventoryObservation } from "./inventory-ingestion.ts";
import type { SourceRecord } from "./lofi.ts";
import { isEventRecord, isSourceDeleted } from "./projection.ts";
import {
  canonicalLotwIdentity,
  comparableRemote,
  lotwRemoteIdentity,
} from "./reconcile.ts";
import { canonical, sha256 } from "./security.ts";

export class InventoryObservationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "InventoryObservationError";
  }
}

function requireValue(condition: unknown, code: string): asserts condition {
  if (!condition) throw new InventoryObservationError(code);
}

function record(value: unknown, code: string): asserts value is SourceRecord {
  requireValue(
    value !== null && typeof value === "object" && !Array.isArray(value),
    code,
  );
}

function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value
  );
}

// Keep the context-free semantic view aligned with projection.ts triggerContext.
// A full sourceFingerprint requires complete operation/event context, which an
// inventory page, a tombstone, or an incomplete source record need not contain.
const sourceMetadata = new Set([
  "updatedAtMillis",
  "createdAtMillis",
  "syncedAtMillis",
  "qsoCount",
  "startAtMillisMin",
  "startAtMillisMax",
  "endAt",
  "endAtMillis",
  "lastQso",
  "lastQSO",
]);

function semanticSource(raw: SourceRecord, operation: boolean): SourceRecord {
  return Object.fromEntries(
    Object.entries(raw).filter(
      ([key]) =>
        !sourceMetadata.has(key) ||
        (!operation && ["endAt", "endAtMillis"].includes(key)),
    ),
  );
}

/** Capture raw source pages without requiring an exportable contact projection. */
export async function lofiInventoryObservations(
  operations: SourceRecord[],
  qsos: SourceRecord[],
): Promise<InventoryObservation[]> {
  // Capture all caller-owned input before the first hashing await.
  const input = structuredClone({ operations, qsos });
  const observations: InventoryObservation[] = [];
  for (const family of ["operation", "qso"] as const) {
    for (const raw of input[family === "operation" ? "operations" : "qsos"]) {
      record(raw, "invalid_lofi_inventory_record");
      requireValue(identifier(raw.uuid), "invalid_lofi_inventory_uuid");
      requireValue(
        typeof raw.syncedAtMillis === "number" &&
          Number.isSafeInteger(raw.syncedAtMillis) &&
          raw.syncedAtMillis >= 0,
        "invalid_lofi_inventory_server_stamp",
      );
      const parent = family === "qso" ? raw.operation : undefined;
      requireValue(
        parent === undefined || parent === null || identifier(parent),
        "invalid_lofi_inventory_parent",
      );
      // Match canonical intake revisions: the server stamp orders observations
      // but is not part of the semantic source revision.
      const { syncedAtMillis: _stamp, ...revisionInputs } = raw;
      observations.push({
        family,
        key: raw.uuid,
        subtype:
          family === "operation"
            ? "operation"
            : isEventRecord(raw)
              ? "event"
              : "qso",
        ...(typeof parent === "string" ? { parentKey: parent } : {}),
        status: isSourceDeleted(raw) ? "deleted" : "active",
        revision: await sha256(canonical(revisionInputs)),
        order: raw.syncedAtMillis,
        body: raw,
        semantic: semanticSource(raw, family === "operation"),
      });
    }
  }
  return observations;
}

function adifRecords(records: AdifRecord[]): AdifRecord[] {
  const input = structuredClone(records);
  for (const value of input) {
    record(value, "invalid_inventory_adif_record");
    requireValue(
      Object.values(value).every((field) => typeof field === "string"),
      "invalid_inventory_adif_field",
    );
  }
  return input;
}

/** LOGID is a record key, not an ordered modification checkpoint. */
export async function qrzInventoryObservations(
  records: AdifRecord[],
): Promise<InventoryObservation[]> {
  const observations: InventoryObservation[] = [];
  for (const body of adifRecords(records)) {
    const id = body.APP_QRZLOG_LOGID;
    requireValue(
      typeof id === "string" && /^\d{1,64}$/.test(id),
      "invalid_qrz_inventory_logid",
    );
    // QRZ stamps the download date on reads. Keep it in the raw receipt only.
    const { QRZCOM_QSO_DOWNLOAD_DATE: _downloadDate, ...semantic } = body;
    observations.push({
      family: "qso",
      key: id,
      subtype: "qso",
      status: "active",
      revision: await sha256(canonical(body)),
      order: null,
      body,
      semantic,
    });
  }
  return observations;
}

export function lotwVariantPrefix(identityHash: string) {
  return `lotw-variant-v1:${identityHash}:`;
}

/** Receipt observations keep their own body and variant identity. */
export async function lotwInventoryObservations(
  records: AdifRecord[],
): Promise<InventoryObservation[]> {
  const observations: InventoryObservation[] = [];
  for (const body of adifRecords(records)) {
    // Reuse identity validation while preserving minute/second precision and
    // retaining original evidence. This does not establish coverage or a match.
    const validation = historicalCandidates("lotw", body, [body]);
    requireValue(
      validation.state === "unique",
      "invalid_lotw_inventory_identity",
    );
    let identity: AdifRecord;
    let identityHash: string;
    try {
      identity = canonicalLotwIdentity(body);
      identityHash = await lotwRemoteIdentity(body);
    } catch {
      // Some syntactically valid historical modes are outside the existing
      // exact-identity namespace. Hold the page rather than invent a mapping.
      throw new InventoryObservationError(
        "unsupported_lotw_inventory_exact_identity",
      );
    }
    const revision = await sha256(canonical(body));
    observations.push({
      family: "qso",
      // LoTW supplies no stable record ID. This is explicitly a local variant
      // key; distinct bodies sharing an exact identity remain distinct evidence.
      key: lotwVariantPrefix(identityHash) + revision,
      subtype: "qso",
      status: "active",
      revision,
      order: null,
      body,
      semantic: { identity, projection: comparableRemote(body) },
    });
  }
  return observations;
}
