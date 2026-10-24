import type { SourceRecord } from "./lofi.ts";

export interface Contact {
  id: string;
  operationId: string | null;
  call: string;
  stationCall: string;
  startAtMillis: number;
  timePrecision: "second" | "millisecond";
  frequencyMHz?: number;
  band: string;
  mode: string;
  submode?: string;
  grid?: string;
  latitude?: number;
  longitude?: number;
  state?: string;
  county?: string;
  dxcc?: number;
  cqZone?: number;
  ituZone?: number;
  operatorCall?: string;
  rstSent?: string;
  rstReceived?: string;
  power?: number;
  ownParks: string[];
  workedParks: string[];
  notes?: string;
  deleted: boolean;
  context: { qso: SourceRecord; op: SourceRecord };
  generation: string;
}

export class ProjectionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProjectionError";
  }
}

function map(value: unknown): SourceRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as SourceRecord)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function megahertz(frequencyKHz: number): number {
  // Shift the source number's decimal representation instead of introducing
  // binary division artifacts that look like additional transmitted precision.
  const [significand, exponent = "0"] = frequencyKHz.toString().split("e");
  return Number(`${significand}e${Number(exponent) - 3}`);
}

export function sourceFlag(value: unknown): boolean {
  if (
    value === undefined ||
    value === null ||
    value === false ||
    value === 0 ||
    value === "false" ||
    value === "0"
  )
    return false;
  if (value === true || value === 1 || value === "true" || value === "1")
    return true;
  throw new ProjectionError("invalid_tombstone_flag");
}

export function isSourceDeleted(record: SourceRecord): boolean {
  // LoFi's computed deletion status is authoritative even when its stored
  // flag is absent or disagrees. Other status values cannot revive a tombstone.
  return (
    record.status === "deleted" ||
    sourceFlag(record.deleted) ||
    sourceFlag(record.purged)
  );
}

export function isEventRecord(record: SourceRecord): boolean {
  return record.band === "event" || Boolean(record.event);
}

/** Match HaLo's exact T/TEST slash components in any comma-separated call. */
export function isTestCallsign(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.split(",").some((call) =>
      call
        .trim()
        .toUpperCase()
        .split("/")
        .some((part) => part === "T" || part === "TEST"),
    )
  );
}

function sourceStationCall(
  qso: SourceRecord,
  operation: SourceRecord,
  hasOperation: boolean,
): unknown {
  const our = map(qso.our);
  // QSON our.call also carries imported OPERATOR fallbacks. Use it only for
  // general-log QSOs without an explicit station field; explicit clears block.
  return Object.hasOwn(our, "stationCall")
    ? our.stationCall
    : Object.hasOwn(qso, "stationCall")
      ? qso.stationCall
      : hasOperation
        ? operation.stationCall
        : our.call;
}

const segmentKeys = new Set([
  "stationCall",
  "refs",
  "grid",
  "gridSource",
  "lat",
  "lon",
  "state",
  "county",
]);

/** Independent overrides apply to the base, never the preceding segment. */
export function effectiveOperation(
  base: SourceRecord,
  events: SourceRecord[],
  at: number,
): SourceRecord {
  const boundaries = events
    .flatMap((event) => {
      if (!isEventRecord(event) || isSourceDeleted(event)) return [];
      const detail = map(event.event);
      if (detail.event !== "start" && detail.event !== "break") return [];
      const override = map(detail.operation);
      if (!Object.keys(override).length) return [];
      const from = numeric(event.startAtMillis);
      if (from === undefined || !Number.isSafeInteger(from))
        throw new ProjectionError("invalid_segment_boundary");
      return [{ from, override }];
    })
    .sort((a, b) => a.from - b.from);
  let selected: SourceRecord = {};
  for (let index = 0; index < boundaries.length; index++) {
    const boundary = boundaries[index];
    if (boundary.from > at) break;
    if (index > 0 && boundaries[index - 1].from === boundary.from) {
      throw new ProjectionError("ambiguous_segment_boundary");
    }
    selected = boundary.override;
  }
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(selected).filter(([key]) => segmentKeys.has(key)),
    ),
  };
}

/** Classify reliable test identities before validating an exportable contact. */
export function isTestContact(
  qso: SourceRecord,
  operation: SourceRecord | null,
  events: SourceRecord[] = [],
): boolean {
  if (isEventRecord(qso)) return false;
  const hasOperation = qso.operation !== null && qso.operation !== undefined;
  if (isTestCallsign(sourceStationCall(qso, {}, hasOperation))) return true;
  if (
    !hasOperation ||
    !operation ||
    !text(qso.operation) ||
    text(qso.operation) !== operation.uuid
  )
    return false;
  // A test operation stays a test even if a QSO or segment changes its station.
  if (isTestCallsign(operation.stationCall)) return true;
  const at = numeric(qso.startAtMillis);
  if (
    at === undefined ||
    !Number.isSafeInteger(at) ||
    at <= 0 ||
    !Number.isFinite(new Date(at).getTime())
  )
    return false;
  try {
    return isTestCallsign(
      effectiveOperation(operation, events, at).stationCall,
    );
  } catch (error) {
    // Invalid segment context still fails normal projection; it cannot reliably
    // identify a test segment or justify suppressing an otherwise normal QSO.
    if (error instanceof ProjectionError) return false;
    throw error;
  }
}

function refs(value: unknown, kind: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ProjectionError("invalid_references");
  return [
    ...new Set(
      value.flatMap((entry) => {
        const ref = map(entry);
        return ref.type === kind && text(ref.ref)
          ? [text(ref.ref) as string]
          : [];
      }),
    ),
  ].sort();
}

const bands: [number, number, string][] = [
  [1800, 2000, "160m"],
  [3500, 4000, "80m"],
  [5000, 5500, "60m"],
  [7000, 7300, "40m"],
  [10100, 10150, "30m"],
  [14000, 14350, "20m"],
  [18068, 18168, "17m"],
  [21000, 21450, "15m"],
  [24890, 24990, "12m"],
  [28000, 29700, "10m"],
  [50000, 54000, "6m"],
  [144000, 148000, "2m"],
  [420000, 450000, "70cm"],
];

function stationCall(value: unknown): string {
  const call = text(value)?.toUpperCase();
  if (
    !call ||
    !/^[A-Z0-9]+(?:\/[A-Z0-9]+)*$/.test(call) ||
    !/[A-Z]/.test(call) ||
    !/\d/.test(call)
  ) {
    throw new ProjectionError("missing_or_ambiguous_station_call");
  }
  return call;
}

function mode(value: unknown): { mode: string; submode?: string } {
  const normalized = text(value)?.toUpperCase();
  if (!normalized) throw new ProjectionError("missing_mode");
  if (normalized === "USB" || normalized === "LSB")
    return { mode: "SSB", submode: normalized };
  if (normalized === "FT4") return { mode: "MFSK", submode: "FT4" };
  if (normalized === "JS8") return { mode: "MFSK", submode: "JS8" };
  if (
    normalized === "FT8" ||
    normalized === "CW" ||
    normalized === "SSB" ||
    normalized === "AM" ||
    normalized === "FM" ||
    normalized === "RTTY" ||
    normalized === "PSK"
  )
    return { mode: normalized };
  throw new ProjectionError("unsupported_mode_mapping");
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

export async function projectionHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const metadata = new Set([
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

function triggerContext(record: SourceRecord, operation = false): SourceRecord {
  return Object.fromEntries(
    Object.entries(record).filter(
      ([key]) =>
        !metadata.has(key) ||
        (!operation && ["endAt", "endAtMillis"].includes(key)),
    ),
  );
}

/** Retain original context only in the caller's bounded encrypted workspace. */
export async function projectContact(
  qso: SourceRecord,
  operation: SourceRecord | null,
  events: SourceRecord[] = [],
  options: { operationComplete: boolean } = { operationComplete: false },
): Promise<Contact> {
  if (isTestContact(qso, operation, events))
    throw new ProjectionError("test_operation_not_exported");
  if (isEventRecord(qso)) throw new ProjectionError("event_is_not_contact");
  const id = text(qso.uuid);
  if (!id) throw new ProjectionError("missing_qso_uuid");
  const operationId =
    qso.operation === null || qso.operation === undefined
      ? null
      : text(qso.operation);
  if (operationId === undefined)
    throw new ProjectionError("invalid_operation_id");
  if (
    operationId &&
    (!operation ||
      operation.uuid !== operationId ||
      isSourceDeleted(operation) ||
      !options.operationComplete)
  ) {
    throw new ProjectionError("operation_context_incomplete");
  }
  const startAtMillis = numeric(qso.startAtMillis);
  if (
    startAtMillis === undefined ||
    !Number.isSafeInteger(startAtMillis) ||
    startAtMillis <= 0 ||
    !Number.isFinite(new Date(startAtMillis).getTime())
  ) {
    throw new ProjectionError("invalid_qso_time");
  }
  const op =
    operationId && operation
      ? effectiveOperation(operation, events, startAtMillis)
      : {};
  const our = map(qso.our);
  const their = map(qso.their);
  const call = stationCall(their.call);
  const ownCall = stationCall(sourceStationCall(qso, op, Boolean(operationId)));
  const frequencyKHz = numeric(qso.freq);
  if (
    qso.freq !== undefined &&
    (frequencyKHz === undefined || frequencyKHz <= 0)
  )
    throw new ProjectionError("invalid_frequency_khz");
  const derivedBand =
    frequencyKHz === undefined
      ? undefined
      : bands.find(
          ([low, high]) => frequencyKHz >= low && frequencyKHz <= high,
        )?.[2];
  const band = text(qso.band)?.toLowerCase() ?? derivedBand;
  if (!band || !/^[0-9]+(?:\.[0-9]+)?(?:m|cm|mm)$/.test(band))
    throw new ProjectionError("missing_or_invalid_band");
  if (frequencyKHz !== undefined && (!derivedBand || derivedBand !== band))
    throw new ProjectionError("frequency_band_mismatch");
  const ownLocation = ["grid", "lat", "lon"].some((key) =>
    Object.hasOwn(our, key),
  )
    ? our
    : op;
  const grid = text(ownLocation.grid)?.toUpperCase();
  if (grid && !/^[A-R]{2}[0-9]{2}(?:[A-X]{2}(?:[0-9]{2})?)?$/.test(grid))
    throw new ProjectionError("invalid_grid");
  const latitude = numeric(ownLocation.lat);
  const longitude = numeric(ownLocation.lon);
  if (
    (latitude === undefined) !== (longitude === undefined) ||
    (latitude !== undefined && Math.abs(latitude) > 90) ||
    (longitude !== undefined && Math.abs(longitude) > 180)
  )
    throw new ProjectionError("invalid_coordinate_pair");
  const state = text(Object.hasOwn(our, "state") ? our.state : op.state);
  const county = text(Object.hasOwn(our, "county") ? our.county : op.county);
  const contact: Contact = {
    id,
    operationId,
    call,
    stationCall: ownCall,
    startAtMillis,
    timePrecision: startAtMillis % 1000 ? "millisecond" : "second",
    ...(frequencyKHz ? { frequencyMHz: megahertz(frequencyKHz) } : {}),
    band,
    ...mode(qso.mode),
    ...(grid ? { grid } : {}),
    ...(latitude !== undefined ? { latitude, longitude } : {}),
    ...(state ? { state } : {}),
    ...(county ? { county } : {}),
    ...(numeric(our.dxccCode) ? { dxcc: numeric(our.dxccCode) } : {}),
    ...(numeric(our.cqZone) !== undefined
      ? { cqZone: numeric(our.cqZone) }
      : {}),
    ...(numeric(our.ituZone) !== undefined
      ? { ituZone: numeric(our.ituZone) }
      : {}),
    ...(text(our.operatorCall)
      ? { operatorCall: text(our.operatorCall)?.toUpperCase() }
      : {}),
    ...(text(our.sent) ? { rstSent: text(our.sent) } : {}),
    ...(text(their.sent) ? { rstReceived: text(their.sent) } : {}),
    ...(numeric(qso.power) !== undefined ? { power: numeric(qso.power) } : {}),
    ownParks: refs(op.refs, "potaActivation"),
    workedParks: refs(qso.refs, "pota"),
    ...(typeof qso.notes === "string" ? { notes: qso.notes } : {}),
    deleted: isSourceDeleted(qso),
    context: { qso: { ...qso }, op },
    generation: "",
  };
  contact.generation = await sourceFingerprint(contact, "qrz");
  return contact;
}

/** Versioned source baselines, independent from remote and outbound hashes. */
export async function sourceFingerprint(
  contact: Contact,
  destination: "qrz" | "lotw",
  remotePreserved = false,
): Promise<string> {
  const {
    context,
    generation: _generation,
    notes,
    ownParks,
    workedParks,
  } = contact;
  const structured = Object.fromEntries(
    [
      "id",
      "operationId",
      "call",
      "stationCall",
      "startAtMillis",
      "timePrecision",
      "frequencyMHz",
      "band",
      "mode",
      "submode",
      "grid",
      "latitude",
      "longitude",
      "state",
      "county",
      "dxcc",
      "cqZone",
      "ituZone",
      "operatorCall",
      "rstSent",
      "rstReceived",
      "power",
      "deleted",
    ].map((key) => [key, contact[key as keyof Contact]]),
  );
  if (destination === "lotw") {
    return projectionHash({
      version: "lotw-source-v1",
      call: contact.call,
      stationCall: contact.stationCall,
      startAtMillis: contact.startAtMillis,
      band: contact.band,
      mode: contact.mode,
      submode: contact.submode,
      frequencyMHz: contact.frequencyMHz,
      grid: contact.grid,
      state: contact.state,
      county: contact.county,
      dxcc: contact.dxcc,
      cqZone: contact.cqZone,
      ituZone: contact.ituZone,
      deleted: contact.deleted,
    });
  }
  return projectionHash({
    version: "qrz-source-v1",
    ...structured,
    ...(remotePreserved
      ? {}
      : {
          notes,
          ownParks,
          workedParks,
          qso: triggerContext(context.qso),
          op: triggerContext(context.op, true),
        }),
  });
}
