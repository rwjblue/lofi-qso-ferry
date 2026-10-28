import {
  type AdifRecord,
  normalizeAdifValue,
  serializeAdifRecord,
} from "./adif.ts";
import { historyCoveringRange } from "./history-inventory.ts";
import {
  availableIdentityClaim,
  claimedAttemptCurrent,
  destinationIdentityClaim,
} from "./identity-claims.ts";
import { type IntakeContact, pendingContacts } from "./intake.ts";
import { LotwClient, observeLotwContact } from "./lotw.ts";
import { checkLotwFirstInsertHistory } from "./lotw-first-insert.ts";
import {
  attemptLotwOwnershipCurrent,
  LotwOwnershipUnavailable,
  lotwOwnershipAvailable,
  renewAttemptLotwOwnership,
} from "./lotw-ownership-bridge.ts";
import { type Contact, isTestCallsign, isTestContact } from "./projection.ts";
import {
  mergeQrzCorrection,
  QrzClient,
  QrzError,
  type QrzOptions,
  sameQrzIdentity,
} from "./qrz.ts";
import { type QrzPlanningAllowance, qrzPlanningFetch } from "./qrz-planning.ts";
import {
  canonicalLotwIdentity,
  comparableRemote,
  lotwRemoteIdentity,
  reconcileQrzAttempt,
} from "./reconcile.ts";
import { b64, canonical, randomToken, sha256, unb64 } from "./security.ts";
import {
  buildSignedTq8,
  canonicalSigningData,
  type LotwContact,
  type LotwStation,
  SIGNING_CONFIGURATION,
  type SigningCredential,
} from "./signing.ts";
import {
  attemptSourceExportAuthorizationMode,
  attemptSourceExportProofCurrent,
  attemptSourceExportProofGuard,
  loadCurrentSourceExportProof,
  lotwFreshInsertCurrent,
  qrzFreshInsertCurrent,
  type SourceExportAuthorization,
  type SourceExportAuthorizationMode,
} from "./source-export-proofs.ts";
import {
  type Connection,
  type Lease,
  type LedgerKey,
  LOTW_PRIOR_IDENTITY_NOTICE,
  type LotwIdentityEvidence,
  type Store,
} from "./store.ts";
import {
  renderNarrative,
  TEMPLATE_PROFILE,
  type TemplateValue,
  type TemplateVersion,
} from "./templates.ts";
import {
  VendorDeferredError,
  type VendorPriority,
  vendorFetch,
} from "./vendor-requests.ts";
export interface DeliveryGates {
  exportsEnabled: boolean;
  liveWriteAuthorized: boolean;
  sourceBoundaryVerified: boolean;
  qrzFreshInsertsEnabled?: boolean;
  lotwFreshInsertsEnabled?: boolean;
  allowedQsoIds?: string[] | null;
  allowedDestinationIds?: string[] | null;
}
export interface DeliveryDependencies {
  fetcher?: typeof fetch;
  now?: number;
  sign?: typeof buildSignedTq8;
  priority?: VendorPriority;
  /** Scheduler projection already fenced by observeContact in this turn. */
  sourceContact?: Pick<
    IntakeContact,
    "id" | "generation" | "contextGeneration"
  >;
  /** Immutable, current evidence from the post-collection canonical drain. */
  sourceProof?: SourceExportAuthorization;
  /** Single-use empty scan from this source turn; never valid for dispatch. */
  qrzEmptyObservation?: QrzEmptyObservation;
  /** Invocation-local planning reads only; dispatch and recovery never consume it. */
  qrzPlanning?: QrzPlanningAllowance;
  /** Scheduler capacity only; cannot authorize or extend any export proof. */
  preparationAllowed?: () => boolean;
}
/** An injected test origin cannot freeze expiry while asynchronous work runs. */
function deliveryClock(origin?: number): () => number {
  const started = Date.now();
  const base = origin ?? started;
  let latest = base;
  return () => {
    latest = Math.max(latest, base + Math.max(0, Date.now() - started));
    return latest;
  };
}
class UnsentAuthorizationError extends Error {
  constructor() {
    super("Authorization changed before mutation transport");
  }
}
function certificateCurrentlyValid(
  credential: SigningCredential,
  now: number,
): boolean {
  const validFrom = Date.parse(credential.validFrom);
  const validTo = Date.parse(credential.validTo);
  return (
    Number.isFinite(now) &&
    Number.isFinite(validFrom) &&
    Number.isFinite(validTo) &&
    validFrom <= now &&
    now <= validTo
  );
}
interface QrzCredential {
  apiKey: string;
}
interface LotwCredential {
  signing?: SigningCredential;
  signingCredentials?: SigningCredential[];
  query?: { username: string; password: string };
}
interface QrzConfig {
  bookId?: string;
  stationCallsign: string;
  startDate: string;
  endDate: string;
  replacementContractVerified?: boolean;
}
interface LotwConfig {
  station?: LotwStation;
  stations?: LotwStation[];
}
interface Member {
  id: string;
  generation: string;
}
export type PreparedPayload =
  | {
      kind: "qrz";
      record: AdifRecord;
      operation: "insert" | "replace";
      mappedLogId: string | null;
      narrative: "remote_preserved" | "template_bound";
      projectionHash: string;
      members: Member[];
      preparedAt: string;
      priorIdentityEvidenceId?: string;
    }
  | {
      kind: "lotw";
      tq8: string;
      station: LotwStation;
      contact: LotwContact;
      members: Member[];
      certificateVersion: string;
      configurationVersion: string;
      projectionHash: string;
      preparedAt: string;
    };
export interface DeliveryResult {
  state:
    | "prepared"
    | "skipped"
    | "blocked"
    | "delivered"
    | "submitted"
    | "observed"
    | "uncertain"
    | "rejected"
    | "unresolved"
    | "retry_scheduled";
  reason?: string;
  attemptId?: string;
}
/** Each fresh capability is vendor-specific and grants no source-wide authority. */
export function deliveryMode(
  gates: DeliveryGates,
  kind: "qrz" | "lotw",
): SourceExportAuthorizationMode | null {
  if (!gates.exportsEnabled || !gates.liveWriteAuthorized) return null;
  if (gates.sourceBoundaryVerified) return "source_boundary";
  if (kind === "qrz" && gates.qrzFreshInsertsEnabled === true)
    return "qrz_fresh_insert";
  return kind === "lotw" && gates.lotwFreshInsertsEnabled === true
    ? "lotw_fresh_insert"
    : null;
}
function modeEnabled(
  gates: DeliveryGates,
  mode: SourceExportAuthorizationMode,
): boolean {
  return (
    gates.exportsEnabled &&
    gates.liveWriteAuthorized &&
    (mode === "source_boundary"
      ? gates.sourceBoundaryVerified
      : mode === "qrz_fresh_insert"
        ? gates.qrzFreshInsertsEnabled === true
        : mode === "lotw_fresh_insert" &&
          gates.lotwFreshInsertsEnabled === true)
  );
}
function scoped(
  gates: DeliveryGates,
  key: LedgerKey,
  requireDefined = false,
): boolean {
  return (
    (!requireDefined ||
      (gates.allowedQsoIds !== undefined &&
        gates.allowedDestinationIds !== undefined)) &&
    (!gates.allowedQsoIds || gates.allowedQsoIds.includes(key.qso)) &&
    (!gates.allowedDestinationIds ||
      gates.allowedDestinationIds.includes(key.destination))
  );
}
function freshInsertPayload(
  payload: PreparedPayload,
  mode: SourceExportAuthorizationMode,
  key: LedgerKey,
  generation: string,
): boolean {
  if (mode === "source_boundary") return true;
  if (mode === "qrz_fresh_insert")
    return (
      payload.kind === "qrz" &&
      payload.operation === "insert" &&
      payload.mappedLogId === null &&
      payload.priorIdentityEvidenceId === undefined
    );
  return (
    payload.kind === "lotw" &&
    payload.contact.id === key.qso &&
    payload.contact.generation === generation &&
    payload.members.length === 1 &&
    payload.members[0].id === key.qso &&
    payload.members[0].generation === payload.contact.generation
  );
}
function freshInsertUnavailable(mode: SourceExportAuthorizationMode): string {
  return mode === "lotw_fresh_insert"
    ? "lotw_fresh_insert_unavailable"
    : "qrz_fresh_insert_unavailable";
}
async function lotwAttemptIdentity(
  station: LotwStation,
  contact: LotwContact,
): Promise<LotwIdentityEvidence> {
  const identity = canonicalLotwIdentity({
    STATION_CALLSIGN: station.callsign,
    CALL: contact.call,
    QSO_DATE: contact.date.replaceAll("-", ""),
    TIME_ON: contact.time.replaceAll(":", "").replace(/Z$/, ""),
    BAND: contact.band,
    MODE: contact.mode,
    ...(contact.submode ? { SUBMODE: contact.submode } : {}),
    PROP_MODE: contact.propagation ?? "",
    SAT_NAME: contact.satellite ?? "",
  });
  return { remoteId: await lotwRemoteIdentity(identity), identity };
}
function coordinate(value: number, latitude: boolean): string {
  const total = Math.round(Math.abs(value) * 60 * 1000) / 1000;
  const degrees = Math.floor(total / 60);
  const minutes = (total - degrees * 60).toFixed(3).padStart(6, "0");
  return `${latitude ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W"}${String(degrees).padStart(3, "0")} ${minutes}`;
}
function countyAdif(county: string, state: string | undefined): string {
  if (!state) throw new Error("County requires an explicit station state");
  if (county.includes(",")) {
    if (!county.toUpperCase().startsWith(`${state.toUpperCase()},`))
      throw new Error("County and station state disagree");
    return county;
  }
  return `${state},${county}`;
}
function countyLotw(county: string, state: string | undefined): string {
  return countyAdif(county, state).split(",").slice(1).join(",");
}
/** Structured fields are validated independently of all narrative templates. */
export function contactAdif(contact: Contact): AdifRecord {
  if (contact.startAtMillis % 1000)
    throw new Error(
      "Subsecond export requires a verified destination identity claim",
    );
  return structuredContactAdif(contact);
}
/**
 * Read-only history comparison follows PoLo/HaLo's documented ADIF projection:
 * retain UTC seconds and omit milliseconds without rounding. The source contact,
 * generation and fingerprint keep their full precision. This does not authorize
 * exporting a fractional timestamp; preparation still requires a durable claim
 * that excludes other source UUIDs with the same destination identity.
 * Primary implementation references are recorded in docs/evidence-qrz.md.
 */
export function contactReconciliationAdif(contact: Contact): AdifRecord {
  return structuredContactAdif(contact);
}
function testContact(contact: Contact): boolean {
  return (
    isTestCallsign(contact.stationCall) ||
    isTestContact(contact.context.qso, contact.context.op)
  );
}

/** Recheck retained source even for an upload prepared by an older version. */
async function sourceExportContext(
  store: Store,
  key: LedgerKey,
  now: number,
  observed?: DeliveryDependencies["sourceContact"],
): Promise<number | null | undefined> {
  const ledger = await store.ledger(key);
  if (!ledger) return undefined;
  // Legacy/directly staged records have no retained intake context. Their
  // immutable station call is still checked at the dispatch boundary below.
  if (ledger.context_generation == null) return null;
  if (
    observed?.id === key.qso &&
    observed.generation === ledger.generation &&
    observed.contextGeneration === ledger.context_generation
  )
    return observed.contextGeneration;
  const source = await store.connection(key.tenant, key.source);
  if (source?.status !== "active") return undefined;
  const [current] = await pendingContacts(
    store,
    source,
    1,
    now,
    undefined,
    key.qso,
  );
  return current !== undefined &&
    current.generation === ledger.generation &&
    current.contextGeneration === ledger.context_generation
    ? current.contextGeneration
    : undefined;
}

async function sourceContextUnchanged(
  store: Store,
  key: LedgerKey,
  generation: number | null,
  now: number,
): Promise<boolean> {
  if (generation === null) return true;
  return Boolean(
    await store
      .statement(
        "SELECT 1 current FROM ledger l JOIN cursors c ON c.tenant=l.tenant AND c.connection=l.source AND c.stream='context' JOIN source_work w ON w.tenant=l.tenant AND w.source=l.source AND w.id=l.qso AND w.kind='qso' WHERE l.tenant=? AND l.source=? AND l.qso=? AND l.destination=? AND l.context_generation=? AND c.generation=? AND json_extract(c.cursor,'$.complete')=1 AND w.state IN('pending','waiting') AND w.expires_at>?",
        key.tenant,
        key.source,
        key.qso,
        key.destination,
        generation,
        generation,
        now,
      )
      .first(),
  );
}
function structuredContactAdif(contact: Contact): AdifRecord {
  if (testContact(contact)) throw new Error("test_operation_not_exported");
  if (contact.deleted) throw new Error("Deleted contacts cannot be exported");
  const iso = new Date(contact.startAtMillis).toISOString();
  const record: AdifRecord = {
    STATION_CALLSIGN: contact.stationCall,
    CALL: contact.call,
    QSO_DATE: iso.slice(0, 10).replaceAll("-", ""),
    TIME_ON: iso.slice(11, 19).replaceAll(":", ""),
    BAND: contact.band,
    MODE: contact.mode,
  };
  const optional: Record<string, string | number | undefined> = {
    SUBMODE: contact.submode,
    FREQ: contact.frequencyMHz,
    RST_SENT: contact.rstSent,
    RST_RCVD: contact.rstReceived,
    MY_GRIDSQUARE: contact.grid,
    MY_STATE: contact.state,
    MY_CNTY: contact.county
      ? countyAdif(contact.county, contact.state)
      : undefined,
    MY_DXCC: contact.dxcc,
    MY_CQ_ZONE: contact.cqZone,
    MY_ITU_ZONE: contact.ituZone,
    OPERATOR: contact.operatorCall,
    TX_PWR: contact.power,
  };
  for (const [field, value] of Object.entries(optional))
    if (value !== undefined) record[field] = String(value);
  if (contact.latitude !== undefined && contact.longitude !== undefined) {
    record.MY_LAT = coordinate(contact.latitude, true);
    record.MY_LON = coordinate(contact.longitude, false);
  }
  serializeAdifRecord(record);
  return record;
}
export function templateContext(
  contact: Contact,
  now: number,
): Record<string, TemplateValue> {
  // JSON roundtrip rejects non-data source objects and strips undefined fields.
  const raw = JSON.parse(JSON.stringify(contact.context)) as {
    qso: Record<string, TemplateValue>;
    op: Record<string, TemplateValue>;
  };
  const iso = new Date(contact.startAtMillis).toISOString();
  const dates = {
    date: iso.slice(0, 10),
    dateCompact: iso.slice(0, 10).replaceAll("-", ""),
    time: iso.slice(11, 16).replace(":", ""),
    at: iso,
  };
  const object = (
    value: TemplateValue | undefined,
  ): Record<string, TemplateValue> =>
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const firstText = (...values: (TemplateValue | undefined)[]) =>
    values
      .find(
        (value) =>
          (typeof value === "string" || typeof value === "number") &&
          String(value).trim(),
      )
      ?.toString()
      .trim() ?? "";
  const their = object(raw.qso.their);
  const guess = object(their.guess);
  const serial = (field: string) =>
    (Array.isArray(raw.qso.refs) ? raw.qso.refs : [])
      .map((ref) => firstText(object(ref)[field]))
      .find(Boolean) ?? "";
  const opBoundary = (value: TemplateValue | undefined) => {
    const millis = Number(value);
    if (!Number.isFinite(millis) || millis <= 0)
      return { date: "", time: "", at: "" };
    const stamp = new Date(millis).toISOString();
    return {
      date: stamp.slice(0, 10),
      time: stamp.slice(11, 16).replace(":", ""),
      at: stamp,
    };
  };
  const start = opBoundary(raw.op.startAtMillisMin ?? raw.op.startAtMillis);
  const end = opBoundary(raw.op.startAtMillisMax);
  return {
    app: { name: "LoFi QSO Ferry" },
    now: new Date(now).toISOString(),
    op: {
      ...raw.op,
      ...dates,
      station: contact.stationCall,
      call: contact.stationCall,
      stations: [contact.stationCall],
      grid: contact.grid ?? "",
      operator: contact.operatorCall ?? firstText(raw.op.operatorCall),
      startDate: start.date,
      startTime: start.time,
      startAt: start.at,
      endDate: end.date,
      endTime: end.time,
      endAt: end.at,
      qsoCount: raw.op.qsoCount ?? 0,
    },
    qso: {
      ...raw.qso,
      ...dates,
      call: contact.call,
      fullCall: contact.call,
      partial: "",
      nextCall: "",
      nextPartial: "",
      band: contact.band,
      mode: contact.submode ?? contact.mode,
      freq:
        contact.frequencyMHz === undefined ? "" : contact.frequencyMHz * 1000,
      rstSent: contact.rstSent ?? "",
      rstRcvd: contact.rstReceived ?? "",
      rst: contact.rstSent ?? "",
      state: firstText(their.state, guess.state),
      name: firstText(their.name, guess.name).split(/\s+/)[0] ?? "",
      serialSent: serial("ourSerial"),
      serialRcvd: serial("theirSerial"),
      serial: serial("ourSerial"),
      startAtMillis: contact.startAtMillis,
      notes: contact.notes ?? "",
    },
    log: {
      station: contact.stationCall,
      ref: contact.ownParks[0] ?? "",
      refName: "",
      refShortName: "",
      activity: contact.ownParks.length ? "POTA" : "",
      format: "adif",
      exportType: "qrz",
    },
  };
}
/** Read authorization only; it cannot replace the final immutable-attempt fence. */
export function qrzNeighborhoodFallback(
  store: Store,
  source: Connection | null | undefined,
  destination: Connection,
  fixedNow?: number | (() => number),
): NonNullable<QrzOptions["neighborhoodFallback"]> {
  const config = JSON.parse(destination.config) as QrzConfig;
  const currentTime =
    typeof fixedNow === "function" ? fixedNow : deliveryClock(fixedNow);
  return {
    book: {
      bookId: config.bookId ?? "",
      stationCallsign: config.stationCallsign,
      startDate: config.startDate,
      endDate: config.endDate,
    },
    now: currentTime,
    selectCover: async (record, target) =>
      source
        ? historyCoveringRange(
            store,
            { source, destination, record },
            target,
            currentTime(),
          )
        : null,
    isCurrent: async () => {
      if (!source || source.tenant !== destination.tenant) return false;
      const at = currentTime();
      return Boolean(
        await store
          .statement(
            "SELECT 1 n FROM accounts a JOIN connections s ON s.tenant=a.id JOIN connections d ON d.tenant=a.id JOIN private_data sp ON sp.tenant=s.tenant AND sp.connection=s.id AND sp.id=s.credential_version AND sp.kind='credential' JOIN private_data dp ON dp.tenant=d.tenant AND dp.connection=d.id AND dp.id=d.credential_version AND dp.kind='credential' WHERE a.id=? AND a.status='active' AND s.id=? AND s.kind='lofi' AND s.status='active' AND s.remote_identity=? AND sp.revoked_at IS NULL AND (sp.expires_at IS NULL OR sp.expires_at>?) AND d.id=? AND d.kind='qrz' AND d.status='active' AND d.remote_identity=? AND d.credential_version=? AND d.config=? AND dp.revoked_at IS NULL AND (dp.expires_at IS NULL OR dp.expires_at>?)",
            destination.tenant,
            source.id,
            source.remote_identity,
            at,
            destination.id,
            destination.remote_identity,
            destination.credential_version,
            destination.config,
            at,
          )
          .first(),
      );
    },
  };
}

export interface QrzEmptyObservation {
  readonly scope: QrzEmptyObservationScope;
  readonly token: object;
}
type QrzObservationInput = {
  key: LedgerKey;
  contact: Contact;
  source: Connection;
  destination: Connection;
};
function qrzObservationSourceConfig(config: string) {
  const value = JSON.parse(config);
  // The mandatory canonical drain updates only this diagnostic timestamp.
  // Every other source setting and every destination setting remains bound.
  delete value.lastSuccessfulPollAt;
  return canonical(value);
}
const qrzObservationConnection = (connection: Connection, source = false) => ({
  tenant: connection.tenant,
  id: connection.id,
  kind: connection.kind,
  status: connection.status,
  remoteIdentity: connection.remote_identity,
  credentialVersion: connection.credential_version,
  config: source
    ? qrzObservationSourceConfig(connection.config)
    : connection.config,
});
function qrzObservationInput(input: QrzObservationInput) {
  const {
    contextGeneration: _context,
    reconciliationVersion: _queue,
    ...projection
  } = input.contact as IntakeContact;
  const binding = canonical({
    key: input.key,
    projection,
    record: structuredContactAdif(input.contact),
    source: qrzObservationConnection(input.source, true),
    destination: qrzObservationConnection(input.destination),
  });
  // Large source contexts still use normal reads; they are not retained here.
  return new TextEncoder().encode(binding).byteLength <= 64 * 1024
    ? binding
    : undefined;
}
/** A bounded source-turn capability, not a cache shared between invocations. */
export class QrzEmptyObservationScope {
  #open = true;
  #issued = 0;
  readonly #store: Store;
  #observations = new WeakMap<object, { binding: string; expiresAt: number }>();
  constructor(store: Store) {
    this.#store = store;
  }

  close() {
    this.#open = false;
    this.#observations = new WeakMap();
  }

  async #credentials(input: QrzObservationInput, now: number) {
    return this.#store
      .statement(
        `SELECT sp.envelope source_envelope,sp.created_at source_created_at,sp.expires_at source_expires_at,
          dp.envelope destination_envelope,dp.created_at destination_created_at,dp.expires_at destination_expires_at
         FROM accounts a JOIN connections s ON s.tenant=a.id JOIN connections d ON d.tenant=a.id
         JOIN private_data sp ON sp.tenant=s.tenant AND sp.connection=s.id AND sp.id=s.credential_version AND sp.kind='credential'
         JOIN private_data dp ON dp.tenant=d.tenant AND dp.connection=d.id AND dp.id=d.credential_version AND dp.kind='credential'
         WHERE a.id=? AND a.status='active' AND s.id=? AND s.kind='lofi' AND s.status='active' AND s.remote_identity IS ? AND s.credential_version=? AND json_remove(s.config,'$.lastSuccessfulPollAt')=json_remove(?,'$.lastSuccessfulPollAt')
          AND d.id=? AND d.kind='qrz' AND d.status='active' AND d.remote_identity IS ? AND d.credential_version=? AND d.config=?
          AND sp.revoked_at IS NULL AND (sp.expires_at IS NULL OR sp.expires_at>?)
          AND dp.revoked_at IS NULL AND (dp.expires_at IS NULL OR dp.expires_at>?)`,
        input.key.tenant,
        input.source.id,
        input.source.remote_identity,
        input.source.credential_version,
        input.source.config,
        input.destination.id,
        input.destination.remote_identity,
        input.destination.credential_version,
        input.destination.config,
        now,
        now,
      )
      .first<{ destination_envelope: string }>();
  }

  /** Only a real, complete guarded scan can issue an empty observation. */
  async read(
    input: QrzObservationInput,
    credential: QrzCredential,
    deps: DeliveryDependencies = {},
  ) {
    input = structuredClone(input);
    const apiKey = credential.apiKey;
    if (!this.#open || !apiKey)
      throw new QrzError("blocked", "QRZ observation scope unavailable");
    const captured = qrzObservationInput(input);
    const time = deliveryClock(deps.now);
    const expiresAt = time() + 60_000;
    const before =
      captured && this.#issued < 20
        ? await this.#credentials(input, time())
        : null;
    if (!this.#open)
      throw new QrzError("blocked", "QRZ observation scope unavailable");
    const records = await new QrzClient(apiKey, {
      fetch: qrzPlanningFetch(
        this.#store,
        deps.fetcher ?? fetch,
        deps.priority,
        time,
        deps.qrzPlanning,
      ),
      neighborhoodFallback: qrzNeighborhoodFallback(
        this.#store,
        input.source,
        input.destination,
        time,
      ),
    }).findNeighborhood(structuredContactAdif(input.contact));
    let observation: QrzEmptyObservation | undefined;
    if (
      records.length === 0 &&
      captured !== undefined &&
      before !== null &&
      input.key.tenant === input.source.tenant &&
      input.key.tenant === input.destination.tenant &&
      input.key.source === input.source.id &&
      input.key.destination === input.destination.id &&
      input.key.qso === input.contact.id &&
      this.#open &&
      time() < expiresAt &&
      canonical(await this.#credentials(input, time())) === canonical(before) &&
      this.#open &&
      time() < expiresAt
    ) {
      const binding = await sha256(canonical([captured, before, apiKey]));
      if (!this.#open || time() >= expiresAt || this.#issued >= 20)
        return { records, observation };
      const token = Object.freeze({});
      this.#observations.set(token, {
        binding,
        expiresAt,
      });
      this.#issued++;
      observation = Object.freeze({ scope: this, token });
    }
    return { records, observation };
  }

  static async consume(
    observation: QrzEmptyObservation | undefined,
    store: Store,
    input: QrzObservationInput,
    credential: QrzCredential,
    now: () => number,
  ): Promise<boolean> {
    if (!observation) return false;
    const scope = observation.scope;
    if (
      typeof scope !== "object" ||
      scope === null ||
      !(#observations in scope) ||
      scope.#store !== store
    )
      return false;
    const entry = scope.#observations.get(observation.token);
    scope.#observations.delete(observation.token);
    if (!entry || !scope.#open || now() >= entry.expiresAt) return false;
    // Capture primitives before the metadata await; callers cannot change the
    // query identity while a database operation is in flight.
    input = structuredClone(input);
    const captured = qrzObservationInput(input);
    if (captured === undefined) return false;
    const apiKey = credential.apiKey;
    const current = await scope.#credentials(input, now());
    const binding = await sha256(canonical([captured, current, apiKey]));
    return (
      scope.#open &&
      now() < entry.expiresAt &&
      current !== null &&
      binding === entry.binding
    );
  }
}
function qrzClient(
  store: Store,
  credential: QrzCredential,
  config: QrzConfig,
  gates: DeliveryGates,
  deps: DeliveryDependencies,
  scope: { source: Connection | null; destination: Connection },
  beforeWrite?: () => Promise<boolean>,
  beforeMutationTransport?: (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ) => Promise<void>,
  authorizationMode: SourceExportAuthorizationMode = "source_boundary",
  planning?: QrzPlanningAllowance,
): QrzClient {
  if (!credential.apiKey) throw new Error("QRZ credential is unavailable");
  const currentTime = deliveryClock(deps.now);
  const neighborhoodFallback = qrzNeighborhoodFallback(
    store,
    scope.source,
    scope.destination,
    currentTime,
  );
  const transport: typeof fetch = async (input, init) => {
    const form = new URLSearchParams(String(init?.body));
    const action = form.get("ACTION");
    if (
      action === "INSERT" ||
      action === "DELETE" ||
      (authorizationMode === "qrz_fresh_insert" &&
        (form.getAll("ACTION").length !== 1 ||
          !["FETCH", "STATUS", "COUNT"].includes(action ?? "")))
    ) {
      if (authorizationMode === "qrz_fresh_insert" && !beforeMutationTransport)
        throw new UnsentAuthorizationError();
      await beforeMutationTransport?.(input, init);
    }
    return (deps.fetcher ?? fetch)(input, init);
  };
  return new QrzClient(credential.apiKey, {
    fetch: qrzPlanningFetch(
      store,
      transport,
      deps.priority,
      currentTime,
      planning,
    ),
    writesEnabled: modeEnabled(gates, authorizationMode),
    replacementContractVerified: config.replacementContractVerified === true,
    beforeWrite: async () =>
      (await neighborhoodFallback.isCurrent()) &&
      (beforeWrite ? await beforeWrite() : true),
    neighborhoodFallback,
  });
}
function routedQrz(config: QrzConfig, contact: Contact): boolean {
  const date = new Date(contact.startAtMillis).toISOString().slice(0, 10);
  return (
    config.stationCallsign?.toUpperCase() === contact.stationCall &&
    /^\d{4}-\d{2}-\d{2}$/.test(config.startDate ?? "") &&
    /^\d{4}-\d{2}-\d{2}$/.test(config.endDate ?? "") &&
    date >= config.startDate &&
    date <= config.endDate
  );
}
async function activeTemplate(
  store: Store,
  key: LedgerKey,
  pinned: string | null,
): Promise<TemplateVersion> {
  const row = await store
    .statement(
      pinned
        ? "SELECT id,config FROM templates WHERE tenant=? AND destination=? AND id=?"
        : "SELECT t.id,t.config FROM active_templates a JOIN templates t ON t.tenant=a.tenant AND t.destination=a.destination AND t.id=a.version WHERE a.tenant=? AND a.destination=?",
      ...[key.tenant, key.destination, ...(pinned ? [pinned] : [])],
    )
    .first<{ id: string; config: string }>();
  if (!row) throw new Error("No immutable QRZ template profile is configured");
  const config = JSON.parse(row.config) as TemplateVersion;
  return { ...config, id: row.id, profile: config.profile ?? TEMPLATE_PROFILE };
}
async function unchangedProjection(
  store: Store,
  key: LedgerKey,
  generation: string,
  projectionHash: string,
  now: number,
): Promise<boolean> {
  const row = await store.ledger(key);
  if (!row || row.generation !== generation || row.sent_hash !== projectionHash)
    return false;
  const result = await store
    .statement(
      "UPDATE ledger SET baseline_hash=source_hash,state=CASE WHEN remote_id IS NOT NULL THEN 'observed' ELSE state END,reason=CASE WHEN reason=? THEN reason ELSE NULL END,updated_at=? WHERE tenant=? AND source=? AND qso=? AND destination=? AND generation=? AND sent_hash=? RETURNING qso",
      LOTW_PRIOR_IDENTITY_NOTICE,
      now,
      key.tenant,
      key.source,
      key.qso,
      key.destination,
      generation,
      projectionHash,
    )
    .run();
  return result.results.length === 1;
}
/** Retire only a known-unsent artifact whose immutable source proof is stale. */
export async function cancelStalePreparedSourceProof(
  store: Store,
  tenant: string,
  attempt: string,
  now = Date.now(),
): Promise<boolean> {
  const proof = attemptSourceExportProofGuard(tenant, attempt, now);
  const rows = await store.db.batch([
    store.statement(
      `INSERT INTO attempt_events(tenant,attempt,state,at,reason) SELECT tenant,attempt,'cancelled',?,'source_export_proof_unavailable' FROM attempt_state WHERE tenant=? AND attempt=? AND state='prepared' AND NOT (${proof.sql})`,
      now,
      tenant,
      attempt,
      ...proof.params,
    ),
    store.statement(
      `UPDATE attempt_state SET state='cancelled',reason='source_export_proof_unavailable',updated_at=? WHERE tenant=? AND attempt=? AND state='prepared' AND NOT (${proof.sql}) RETURNING attempt`,
      now,
      tenant,
      attempt,
      ...proof.params,
    ),
  ]);
  return rows[1].results.length === 1;
}
/** Prepare one immutable attempt; no template change can call this without source work. */
export async function prepareDue(
  store: Store,
  key: LedgerKey,
  contact: Contact,
  gates: DeliveryGates,
  deps: DeliveryDependencies = {},
): Promise<DeliveryResult> {
  const currentTime = deliveryClock(deps.now);
  const now = currentTime();
  if (deps.preparationAllowed?.() === false)
    return { state: "blocked", reason: "dispatch_headroom_unavailable" };
  if (testContact(contact))
    return { state: "blocked", reason: "test_operation_not_exported" };
  if (gates.allowedQsoIds && !gates.allowedQsoIds.includes(key.qso))
    return { state: "blocked", reason: "qso_outside_rollout_scope" };
  if (
    gates.allowedDestinationIds &&
    !gates.allowedDestinationIds.includes(key.destination)
  )
    return { state: "blocked", reason: "destination_outside_rollout_scope" };
  const row = await store.ledger(key);
  if (await store.historicalAssociationOnly(key))
    return { state: "blocked", reason: "historical_association_read_only" };
  if (row?.provenance === "adoption_conflict")
    return { state: "blocked", reason: "remote_identity_claim_conflict" };
  if (
    !row ||
    row.generation !== contact.generation ||
    contact.id !== key.qso ||
    contact.deleted ||
    row.due_at > now ||
    !["missing_current_identity", "changed", "live_new"].includes(row.state)
  )
    return { state: "skipped", reason: "not_due_or_current" };
  if (
    row.context_generation != null &&
    !(await sourceContextUnchanged(store, key, row.context_generation, now))
  )
    return { state: "blocked", reason: "source_not_exportable" };
  const unresolved = await store
    .statement(
      "SELECT a.id,s.state FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE a.tenant=? AND a.source=? AND a.qso=? AND a.destination=? AND s.state NOT IN('delivered','observed','rejected','cancelled') LIMIT 1",
      key.tenant,
      key.source,
      key.qso,
      key.destination,
    )
    .first<{ id: string; state: string }>();
  if (
    unresolved &&
    (unresolved.state !== "prepared" ||
      !(await cancelStalePreparedSourceProof(
        store,
        key.tenant,
        unresolved.id,
        currentTime(),
      )))
  )
    return { state: "skipped", reason: "unresolved_attempt" };
  const connection = await store.connection(key.tenant, key.destination);
  const source = await store.connection(key.tenant, key.source);
  if (
    connection?.status !== "active" ||
    source?.status !== "active" ||
    !connection.credential_version
  )
    return { state: "blocked", reason: "connection_inactive" };
  if (connection.kind !== "qrz" && connection.kind !== "lotw")
    return { state: "blocked", reason: "invalid_destination" };
  // Preserve the legacy boundary path; the independent fresh capability is
  // selected only with current consent and can never authorize another vendor.
  const authorizationMode = gates.sourceBoundaryVerified
    ? "source_boundary"
    : deliveryMode(gates, connection.kind);
  if (!authorizationMode)
    return { state: "blocked", reason: "source_replay_boundary_unverified" };
  const freshInsertCurrent = async () =>
    authorizationMode === "source_boundary" ||
    (modeEnabled(gates, authorizationMode) &&
      scoped(gates, key, true) &&
      (await (authorizationMode === "qrz_fresh_insert"
        ? qrzFreshInsertCurrent(store, key)
        : lotwFreshInsertCurrent(store, key))) &&
      modeEnabled(gates, authorizationMode) &&
      scoped(gates, key, true));
  if (!(await freshInsertCurrent()))
    return {
      state: "blocked",
      reason: freshInsertUnavailable(authorizationMode),
    };
  const sourceProof = deps.sourceProof;
  if (!sourceProof)
    return { state: "blocked", reason: "source_export_proof_unavailable" };
  const sourceProofCurrent = async () =>
    Boolean(
      sourceProof.scope.tenant === key.tenant &&
        sourceProof.scope.source === key.source &&
        (await loadCurrentSourceExportProof(
          store,
          sourceProof.scope,
          sourceProof.proofId,
          {
            qso: key.qso,
            generation: contact.generation,
            reconciliationVersion: sourceProof.reconciliationVersion,
          },
          currentTime(),
        )),
    );
  if (!(await sourceProofCurrent()))
    return { state: "blocked", reason: "source_export_proof_unavailable" };
  // This projection is only used by the guarded attempt path. The public ADIF
  // helper remains strict; every attempt must acquire its exact seconds claim.
  const structured = structuredContactAdif(contact);
  const identity = await destinationIdentityClaim(connection.kind, structured);
  const available = availableIdentityClaim(key, identity);
  const retained =
    connection.kind === "lotw"
      ? await store.lotwIdentityClaimGuard(key, identity.hash)
      : { sql: "1", params: [] };
  const ownership = await store
    .statement(
      `SELECT (${available.sql}) AND (${retained.sql}) available,EXISTS(SELECT 1 FROM legacy_qrz_identity_reservations r WHERE r.tenant=? AND r.destination=?) legacy,EXISTS(SELECT 1 FROM legacy_outbound_identity_reservations r WHERE r.tenant=? AND r.destination=?) legacy_attempt`,
      ...available.params,
      ...retained.params,
      key.tenant,
      key.destination,
      key.tenant,
      key.destination,
    )
    .first<{ available: number; legacy: number; legacy_attempt: number }>();
  if (ownership?.legacy)
    return {
      state: "blocked",
      reason: "legacy_qrz_identity_backfill_required",
    };
  if (ownership?.legacy_attempt)
    return {
      state: "blocked",
      reason: "legacy_outbound_identity_backfill_required",
    };
  if (!ownership?.available)
    return { state: "blocked", reason: "outbound_identity_claim_conflict" };
  if (deps.priority === "background") {
    const backlog = await store
      .statement(
        "SELECT COUNT(*) n FROM (SELECT 1 FROM attempt_state s JOIN attempts a ON a.tenant=s.tenant AND a.id=s.attempt JOIN connections c ON c.tenant=a.tenant AND c.id=a.destination AND c.status='active' JOIN connections src ON src.tenant=a.tenant AND src.id=a.source AND src.status='active' WHERE s.state='prepared' AND s.priority='background' AND c.kind=? AND a.credential_version=c.credential_version AND EXISTS(SELECT 1 FROM private_data p WHERE p.tenant=a.tenant AND p.connection=a.destination AND p.id=a.credential_version AND p.kind='credential' AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?)) LIMIT 2)",
        connection.kind,
        now,
      )
      .first<{ n: number }>();
    if ((backlog?.n ?? 0) >= 2)
      return { state: "skipped", reason: "background_outbox_full" };
  }
  const member = { id: contact.id, generation: contact.generation };
  let payload: PreparedPayload;
  let expectedTemplate: string | null = null;
  let lotwIdentityId: string | undefined;
  if (connection.kind === "qrz") {
    const config = JSON.parse(connection.config) as QrzConfig;
    if (!routedQrz(config, contact))
      return { state: "blocked", reason: "qrz_station_or_date_route_mismatch" };
    const credential = await store.private<QrzCredential>(
      key.tenant,
      key.destination,
      connection.credential_version,
      "credential",
    );
    if (!credential)
      return { state: "blocked", reason: "credential_unavailable" };
    const client = qrzClient(
      store,
      credential,
      config,
      gates,
      { ...deps, now: currentTime() },
      {
        source,
        destination: connection,
      },
      undefined,
      undefined,
      authorizationMode,
      authorizationMode === "qrz_fresh_insert" ? deps.qrzPlanning : undefined,
    );
    let record = structured;
    if (row.narrative !== "remote_preserved") {
      const version = await activeTemplate(store, key, row.template_version);
      expectedTemplate = version.id;
      record = {
        ...structured,
        ...renderNarrative(version, templateContext(contact, now)),
      };
    }
    let operation: "insert" | "replace" = "insert";
    let priorIdentityEvidenceId: string | undefined;
    if (row.remote_id) {
      const remote = await client.fetchLogId(row.remote_id);
      if (!remote)
        return { state: "blocked", reason: "mapped_qrz_record_missing" };
      record = mergeQrzCorrection(
        remote,
        record,
        row.narrative === "remote_preserved"
          ? "remote_preserved"
          : "template_bound",
      );
      for (const [field, value] of Object.entries(record))
        record[field] = normalizeAdifValue(field, value);
      const recordHash = await sha256(canonical(record));
      if (
        await unchangedProjection(
          store,
          key,
          contact.generation,
          recordHash,
          now,
        )
      )
        return { state: "skipped", reason: "transmitted_projection_unchanged" };
      const observed = mergeQrzCorrection(
        remote,
        remote,
        row.narrative === "remote_preserved"
          ? "remote_preserved"
          : "template_bound",
      );
      for (const [field, value] of Object.entries(observed))
        observed[field] = normalizeAdifValue(field, value);
      if (canonical(record) === canonical(observed)) {
        await store
          .statement(
            "UPDATE ledger SET baseline_hash=source_hash,state=CASE WHEN provenance='adopted' THEN 'adopted_existing' ELSE 'observed' END,updated_at=? WHERE tenant=? AND source=? AND qso=? AND destination=? AND generation=? AND remote_id=?",
            now,
            key.tenant,
            key.source,
            key.qso,
            key.destination,
            contact.generation,
            row.remote_id,
          )
          .run();
        return {
          state: "skipped",
          reason: "remote_projection_already_current",
        };
      }
      if (sameQrzIdentity(remote, record)) {
        if (!config.replacementContractVerified)
          return {
            state: "blocked",
            reason: "qrz_replacement_contract_unverified",
          };
        const neighbors = await client.findNeighborhood(record);
        if (
          neighbors.length !== 1 ||
          neighbors[0].APP_QRZLOG_LOGID !== row.remote_id
        )
          return { state: "blocked", reason: "qrz_collision_ambiguous" };
        operation = "replace";
      } else {
        if ((await client.findNeighborhood(record)).length)
          return { state: "blocked", reason: "qrz_changed_identity_collision" };
        priorIdentityEvidenceId = randomToken();
        await (
          await store.putPrivate(
            key.tenant,
            key.destination,
            priorIdentityEvidenceId,
            "identity_history",
            {
              source: key.source,
              qso: key.qso,
              oldLogId: row.remote_id,
              oldProvenance: row.provenance,
              oldIdentity: comparableRemote(remote),
              newIdentity: comparableRemote(structured),
              cleanup: "retained_remote_identity",
            },
            now + 90 * 86400000,
          )
        ).run();
      }
    } else if (
      !(
        authorizationMode === "qrz_fresh_insert" &&
        (await QrzEmptyObservationScope.consume(
          deps.qrzEmptyObservation,
          store,
          { key, contact, source, destination: connection },
          credential,
          currentTime,
        ))
      ) &&
      (await client.findNeighborhood(record)).length
    )
      return {
        state: "blocked",
        reason: "qrz_fresh_absence_check_found_candidate",
      };
    for (const [field, value] of Object.entries(record))
      record[field] = normalizeAdifValue(field, value);
    serializeAdifRecord(record);
    const projectionHash = await sha256(canonical(record));
    if (
      await unchangedProjection(
        store,
        key,
        contact.generation,
        projectionHash,
        now,
      )
    )
      return { state: "skipped", reason: "transmitted_projection_unchanged" };
    payload = {
      kind: "qrz",
      record,
      operation,
      mappedLogId: row.remote_id,
      narrative:
        row.narrative === "remote_preserved"
          ? "remote_preserved"
          : "template_bound",
      projectionHash,
      members: [member],
      preparedAt: new Date(now).toISOString(),
      ...(priorIdentityEvidenceId ? { priorIdentityEvidenceId } : {}),
    };
  } else if (connection.kind === "lotw") {
    if (!modeEnabled(gates, authorizationMode))
      return { state: "blocked", reason: "exports_disabled_before_signing" };
    if (await store.historicalAssociationOnly(key))
      return { state: "blocked", reason: "historical_association_read_only" };
    const config = JSON.parse(connection.config) as LotwConfig;
    const routes = (
      config.stations ?? (config.station ? [config.station] : [])
    ).filter(
      (station) =>
        station.callsign === contact.stationCall &&
        (contact.dxcc === undefined || station.dxcc === contact.dxcc),
    );
    if (
      routes.length !== 1 ||
      !Number.isInteger(contact.dxcc ?? routes[0]?.dxcc)
    )
      return { state: "blocked", reason: "lotw_station_route_mismatch" };
    const route = routes[0];
    const credential = await store.private<LotwCredential>(
      key.tenant,
      key.destination,
      connection.credential_version,
      "credential",
    );
    if (!credential)
      return { state: "blocked", reason: "credential_unavailable" };
    const station: LotwStation = {
      callsign: contact.stationCall,
      dxcc: contact.dxcc ?? route.dxcc,
      ...(contact.grid ? { grid: contact.grid } : {}),
      ...(contact.state ? { state: contact.state } : {}),
      ...(contact.county
        ? { county: countyLotw(contact.county, contact.state) }
        : {}),
      ...((contact.cqZone ?? route.cqZone)
        ? { cqZone: contact.cqZone ?? route.cqZone }
        : {}),
      ...((contact.ituZone ?? route.ituZone)
        ? { ituZone: contact.ituZone ?? route.ituZone }
        : {}),
      ...(route.iota ? { iota: route.iota } : {}),
    };
    const iso = new Date(contact.startAtMillis).toISOString();
    const lotwContact: LotwContact = {
      id: contact.id,
      generation: contact.generation,
      call: contact.call,
      band: contact.band,
      mode: contact.mode,
      ...(contact.submode ? { submode: contact.submode } : {}),
      date: iso.slice(0, 10),
      time: `${iso.slice(11, 19)}Z`,
      ...(contact.frequencyMHz
        ? { frequencyMHz: String(contact.frequencyMHz) }
        : {}),
    };
    try {
      canonicalSigningData(station, lotwContact);
    } catch {
      return { state: "blocked", reason: "lotw_signing_fields_unavailable" };
    }
    const exactLotwIdentity = await lotwAttemptIdentity(station, lotwContact);
    lotwIdentityId = exactLotwIdentity.remoteId;
    if (!(await lotwOwnershipAvailable(store, key, exactLotwIdentity)))
      return { state: "blocked", reason: "lotw_ownership_unavailable" };
    const { id: _id, generation: _generation, ...transmitted } = lotwContact;
    const projectionHash = await sha256(
      canonical({ station, contact: transmitted }),
    );
    if (
      await unchangedProjection(
        store,
        key,
        contact.generation,
        projectionHash,
        now,
      )
    )
      return { state: "skipped", reason: "transmitted_projection_unchanged" };
    const client = new LotwClient(credential.query ?? null, {
      fetcher: (input, init) =>
        vendorFetch(store, "lotw", deps.fetcher, {
          priority: deps.priority,
          now: currentTime(),
        })(input, init),
      exportsEnabled: modeEnabled(gates, authorizationMode),
    });
    if (authorizationMode === "lotw_fresh_insert") {
      if (!credential.query)
        return {
          state: "blocked",
          reason: "lotw_query_required_for_fresh_insert",
        };
      try {
        const history = await checkLotwFirstInsertHistory(
          { credentials: credential.query, station, contact: lotwContact },
          {
            fetcher: (input, init) =>
              vendorFetch(store, "lotw", deps.fetcher, {
                priority: deps.priority,
                now: currentTime(),
              })(input, init),
          },
        );
        if (history.state !== "empty")
          return {
            state: "blocked",
            reason: "lotw_fresh_insert_history_present",
          };
      } catch (error) {
        if (error instanceof VendorDeferredError) throw error;
        return {
          state: "blocked",
          reason: "lotw_fresh_insert_history_unavailable",
        };
      }
    } else if (credential.query) {
      const report = await client.query({
        startDate: lotwContact.date,
        endDate: lotwContact.date,
        stationCallsign: station.callsign,
        workedCallsign: lotwContact.call,
      });
      const observation = observeLotwContact(station, lotwContact, report);
      if (!row.remote_id && observation.state !== "absent")
        return {
          state: "blocked",
          reason: "lotw_fresh_absence_check_found_candidate",
        };
      if (
        row.remote_id &&
        ["ambiguous", "insufficient_evidence"].includes(observation.state)
      )
        return {
          state: "blocked",
          reason: "lotw_correction_readback_ambiguous",
        };
    } else if (row.state !== "live_new" && !row.remote_id)
      return {
        state: "blocked",
        reason: "lotw_historical_readback_unavailable",
      };
    // Re-read authoritative credential status immediately before signing.
    const current = await store.connection(key.tenant, key.destination);
    if (
      current?.status !== "active" ||
      current.credential_version !== connection.credential_version ||
      !(await store.private(
        key.tenant,
        key.destination,
        connection.credential_version,
        "credential",
      ))
    )
      return { state: "blocked", reason: "credential_revoked_before_signing" };
    const eligibleCertificates = (
      credential.signingCredentials ??
      (credential.signing ? [credential.signing] : [])
    ).filter(
      (cert) =>
        cert.callsign === station.callsign &&
        cert.dxcc === station.dxcc &&
        cert.qsoFrom <= lotwContact.date &&
        (!cert.qsoTo || cert.qsoTo >= lotwContact.date),
    );
    if (eligibleCertificates.length !== 1)
      return {
        state: "blocked",
        reason: "lotw_certificate_selection_ambiguous_or_missing",
      };
    const selected = eligibleCertificates[0];
    if (!certificateCurrentlyValid(selected, currentTime()))
      return {
        state: "blocked",
        reason: "lotw_certificate_not_currently_valid",
      };
    const status = await client.certificateStatus(selected.serial);
    if (status !== "unrevoked")
      return { state: "blocked", reason: `lotw_certificate_${status}` };
    const beforeSigning = await store.connection(key.tenant, key.destination);
    if (
      beforeSigning?.status !== "active" ||
      beforeSigning.credential_version !== connection.credential_version ||
      (await store.connection(key.tenant, key.source))?.status !== "active" ||
      !(await store.private(
        key.tenant,
        key.destination,
        connection.credential_version,
        "credential",
      ))
    )
      return {
        state: "blocked",
        reason: "credential_or_source_revoked_before_signing",
      };
    if (!(await sourceProofCurrent()))
      return { state: "blocked", reason: "source_export_proof_unavailable" };
    if (!(await freshInsertCurrent()))
      return {
        state: "blocked",
        reason: freshInsertUnavailable(authorizationMode),
      };
    if (!modeEnabled(gates, authorizationMode))
      return { state: "blocked", reason: "exports_disabled_before_signing" };
    const signingAt = currentTime();
    if (!certificateCurrentlyValid(selected, signingAt))
      return {
        state: "blocked",
        reason: "lotw_certificate_not_currently_valid",
      };
    const signing = {
      ...selected,
      status,
      statusCheckedAt: new Date(signingAt).toISOString(),
    };
    const artifact = await (deps.sign ?? buildSignedTq8)(
      signing,
      station,
      [lotwContact],
      new Date(signingAt),
    );
    payload = {
      kind: "lotw",
      tq8: b64(artifact.bytes),
      station,
      contact: lotwContact,
      members: artifact.members,
      certificateVersion: artifact.credentialVersion,
      configurationVersion: artifact.configurationVersion,
      projectionHash,
      preparedAt: new Date(signingAt).toISOString(),
    };
  } else return { state: "blocked", reason: "invalid_destination" };
  let attemptId: string;
  try {
    if (!(await sourceProofCurrent()))
      return { state: "blocked", reason: "source_export_proof_unavailable" };
    if (
      !(await freshInsertCurrent()) ||
      !freshInsertPayload(payload, authorizationMode, key, contact.generation)
    )
      return {
        state: "blocked",
        reason: freshInsertUnavailable(authorizationMode),
      };
    const identityClaim = await preparedIdentityClaim(payload);
    // Planning, history and signing can consume the caller's remaining budget.
    // Yield before persisting an artifact that cannot get a dispatch turn.
    if (deps.preparationAllowed?.() === false)
      return { state: "blocked", reason: "dispatch_headroom_unavailable" };
    attemptId = await store.stage(
      key,
      contact.generation,
      payload,
      connection.credential_version,
      expectedTemplate,
      currentTime(),
      payload.projectionHash,
      lotwIdentityId,
      deps.priority ?? "live",
      {
        claim: identityClaim,
        sourceVersion: sourceProof.reconciliationVersion,
      },
      { ...sourceProof, authorizationMode },
    );
  } catch (error) {
    if (
      error instanceof LotwOwnershipUnavailable ||
      (error instanceof Error && error.message.includes("LoTW ownership"))
    )
      return { state: "blocked", reason: "lotw_ownership_unavailable" };
    if (
      error instanceof Error &&
      error.message.includes("historical association is read only")
    )
      return { state: "blocked", reason: "historical_association_read_only" };
    if (
      error instanceof Error &&
      (error.message.includes("QRZ fresh insert unavailable") ||
        error.message.includes("LoTW fresh insert unavailable"))
    )
      return {
        state: "blocked",
        reason: freshInsertUnavailable(authorizationMode),
      };
    if (
      error instanceof Error &&
      error.message.includes("source export proof unavailable")
    )
      return { state: "blocked", reason: "source_export_proof_unavailable" };
    if (
      error instanceof Error &&
      error.message.includes("outbound identity claim conflict")
    )
      return { state: "blocked", reason: "outbound_identity_claim_conflict" };
    if (
      error instanceof Error &&
      error.message.includes("legacy QRZ identity backfill required")
    )
      return {
        state: "blocked",
        reason: "legacy_qrz_identity_backfill_required",
      };
    if (
      error instanceof Error &&
      error.message.includes("legacy outbound identity backfill required")
    )
      return {
        state: "blocked",
        reason: "legacy_outbound_identity_backfill_required",
      };
    throw error;
  }
  return { state: "prepared", attemptId };
}

async function preparedIdentityClaim(payload: PreparedPayload) {
  if (payload.kind === "qrz")
    return destinationIdentityClaim("qrz", payload.record);
  return destinationIdentityClaim("lotw", {
    STATION_CALLSIGN: payload.station.callsign,
    CALL: payload.contact.call,
    QSO_DATE: payload.contact.date.replaceAll("-", ""),
    TIME_ON: payload.contact.time.replaceAll(":", "").replace(/Z$/, ""),
    BAND: payload.contact.band,
    MODE: payload.contact.mode,
    ...(payload.contact.submode ? { SUBMODE: payload.contact.submode } : {}),
    PROP_MODE: payload.contact.propagation ?? "",
    SAT_NAME: payload.contact.satellite ?? "",
  });
}
interface AttemptRow {
  id: string;
  source: string;
  qso: string;
  destination: string;
  generation: string;
  payload_id: string;
  credential_version: string;
  attempt_state: string;
}
async function attemptData(
  store: Store,
  tenant: string,
  id: string,
): Promise<{
  attempt: AttemptRow;
  connection: Connection;
  payload: PreparedPayload;
} | null> {
  const attempt = await store
    .statement(
      "SELECT a.*,s.state AS attempt_state FROM attempts a JOIN attempt_state s ON s.tenant=a.tenant AND s.attempt=a.id WHERE a.tenant=? AND a.id=?",
      tenant,
      id,
    )
    .first<AttemptRow>();
  if (!attempt) return null;
  const connection = await store.connection(tenant, attempt.destination);
  if (
    connection?.status !== "active" ||
    (await store.connection(tenant, attempt.source))?.status !== "active"
  )
    return null;
  const payload = await store.private<PreparedPayload>(
    tenant,
    attempt.destination,
    attempt.payload_id,
    "outbox",
  );
  return payload ? { attempt, connection, payload } : null;
}
export async function dispatchAttempt(
  store: Store,
  tenant: string,
  id: string,
  gates: DeliveryGates,
  deps: DeliveryDependencies = {},
): Promise<DeliveryResult> {
  if (!deliveryMode(gates, "qrz") && !deliveryMode(gates, "lotw"))
    return { state: "blocked", reason: "exports_disabled" };
  const currentTime = deliveryClock(deps.now);
  const now = currentTime();
  const data = await attemptData(store, tenant, id);
  if (
    data &&
    gates.allowedQsoIds &&
    !gates.allowedQsoIds.includes(data.attempt.qso)
  )
    return { state: "blocked", reason: "qso_outside_rollout_scope" };
  if (!data)
    return { state: "blocked", reason: "attempt_or_connection_unavailable" };
  if (
    gates.allowedDestinationIds &&
    !gates.allowedDestinationIds.includes(data.attempt.destination)
  )
    return { state: "blocked", reason: "destination_outside_rollout_scope" };
  const key = { tenant, ...data.attempt };
  if (
    isTestCallsign(
      data.payload.kind === "qrz"
        ? data.payload.record.STATION_CALLSIGN
        : data.payload.station.callsign,
    )
  ) {
    await store.db.batch([
      store.statement(
        "INSERT INTO attempt_events(tenant,attempt,state,at,reason) SELECT tenant,attempt,'cancelled',?,'test_operation_not_exported' FROM attempt_state WHERE tenant=? AND attempt=? AND state='prepared'",
        now,
        tenant,
        id,
      ),
      store.statement(
        "UPDATE attempt_state SET state='cancelled',reason='test_operation_not_exported',updated_at=? WHERE tenant=? AND attempt=? AND state='prepared'",
        now,
        tenant,
        id,
      ),
    ]);
    return { state: "blocked", reason: "test_operation_not_exported" };
  }
  if (data.attempt.attempt_state !== "prepared")
    return { state: "skipped", reason: "attempt_not_claimable" };
  if (data.payload.kind === "lotw") {
    if (data.payload.configurationVersion !== SIGNING_CONFIGURATION)
      return { state: "blocked", reason: "lotw_signing_configuration_changed" };
    try {
      canonicalSigningData(data.payload.station, data.payload.contact);
    } catch {
      return { state: "blocked", reason: "lotw_signing_fields_unavailable" };
    }
  }
  if (await store.historicalAssociationOnly(key))
    return { state: "blocked", reason: "historical_association_read_only" };
  const authorizationMode = await attemptSourceExportAuthorizationMode(
    store,
    tenant,
    id,
  );
  if (!authorizationMode || !modeEnabled(gates, authorizationMode))
    return {
      state: "blocked",
      reason: "source_export_authorization_unavailable",
    };
  const operationAuthorized = () =>
    modeEnabled(gates, authorizationMode) &&
    scoped(gates, key, authorizationMode !== "source_boundary") &&
    (authorizationMode === "source_boundary" ||
      (data.connection.kind ===
        (authorizationMode === "qrz_fresh_insert" ? "qrz" : "lotw") &&
        freshInsertPayload(
          data.payload,
          authorizationMode,
          key,
          data.attempt.generation,
        )));
  if (!operationAuthorized())
    return {
      state: "blocked",
      reason: freshInsertUnavailable(authorizationMode),
    };
  const proofCheckedAt = currentTime();
  const proofExpiresAt = await store
    .statement(
      "SELECT expires_at FROM attempt_source_export_proofs_current WHERE tenant=? AND attempt=? AND created_at<=? AND expires_at>?",
      tenant,
      id,
      proofCheckedAt,
      proofCheckedAt,
    )
    .first<number>("expires_at");
  if (proofExpiresAt === null || currentTime() >= proofExpiresAt) {
    await cancelStalePreparedSourceProof(store, tenant, id, currentTime());
    return { state: "blocked", reason: "source_export_proof_unavailable" };
  }
  const identity = await preparedIdentityClaim(data.payload);
  if (
    !(await claimedAttemptCurrent(store, tenant, id, identity, currentTime()))
  ) {
    if (await cancelStalePreparedSourceProof(store, tenant, id, currentTime()))
      return { state: "blocked", reason: "source_export_proof_unavailable" };
    // A source/context refresh can invalidate the pinned proof without changing
    // the payload. Retire only known-unsent linked attempts so a fresh prepare
    // can recapture evidence; destination ownership is deliberately retained.
    await store.db.batch([
      store.statement(
        "INSERT INTO attempt_events(tenant,attempt,state,at,reason) SELECT tenant,attempt,'cancelled',?,'outbound_identity_evidence_changed' FROM attempt_state s WHERE tenant=? AND attempt=? AND state='prepared' AND EXISTS(SELECT 1 FROM attempt_identity_claims i WHERE i.tenant=s.tenant AND i.attempt=s.attempt)",
        now,
        tenant,
        id,
      ),
      store.statement(
        "UPDATE attempt_state SET state='cancelled',reason='outbound_identity_evidence_changed',updated_at=? WHERE tenant=? AND attempt=? AND state='prepared' AND EXISTS(SELECT 1 FROM attempt_identity_claims i WHERE i.tenant=attempt_state.tenant AND i.attempt=attempt_state.attempt)",
        now,
        tenant,
        id,
      ),
    ]);
    return { state: "blocked", reason: "outbound_identity_claim_unavailable" };
  }
  const sourceContext = await sourceExportContext(
    store,
    key,
    now,
    deps.sourceContact,
  );
  if (sourceContext === undefined)
    return { state: "blocked", reason: "source_not_exportable" };
  const lease = await store.claim(
    tenant,
    `delivery:${data.attempt.destination}`,
    currentTime(),
    120000,
  );
  if (!lease) return { state: "skipped", reason: "delivery_lease_busy" };
  let ownershipLease: Lease | undefined;
  let ownershipExpiresAt = 0;
  let claimed = false;
  let mutationStarted = false;
  let mutationBlocked = false;
  const retireUnsentProof = async (): Promise<DeliveryResult> => {
    // This is used only before transport begins. Return through the existing
    // fenced unsent transition before cancelling; never rewrite uncertainty.
    await store.retryUnsent(
      tenant,
      id,
      lease,
      "source_export_proof_unavailable",
      currentTime(),
    );
    await cancelStalePreparedSourceProof(store, tenant, id, currentTime());
    return { state: "blocked", reason: "source_export_proof_unavailable" };
  };
  const retryBlockedTransport = async (): Promise<DeliveryResult> => {
    if (
      !(await attemptSourceExportProofCurrent(store, tenant, id, currentTime()))
    )
      return retireUnsentProof();
    await store.retryUnsent(
      tenant,
      id,
      lease,
      "authorization_changed_before_transport",
      currentTime(),
    );
    return {
      state: "blocked",
      reason: "authorization_changed_before_transport",
    };
  };
  try {
    if (data.payload.kind === "lotw") {
      const ownership = await renewAttemptLotwOwnership(
        store,
        tenant,
        id,
        data.payload,
        currentTime(),
      );
      ownershipLease = ownership.lease;
      ownershipExpiresAt = ownership.expiresAt;
    }
    if (
      !(await store.claimAttempt(
        tenant,
        id,
        lease,
        currentTime(),
        data.payload.kind === "lotw"
          ? await lotwAttemptIdentity(
              data.payload.station,
              data.payload.contact,
            )
          : undefined,
        ownershipLease
          ? { payload: data.payload, lease: ownershipLease }
          : undefined,
      ))
    )
      return { state: "skipped", reason: "attempt_not_claimable" };
    claimed = true;
    let state: "delivered" | "submitted" | "uncertain" | "rejected" =
      "uncertain";
    let remoteId: string | null = null;
    if (data.payload.kind === "qrz") {
      const credential = await store.private<QrzCredential>(
        tenant,
        data.attempt.destination,
        data.attempt.credential_version,
        "credential",
      );
      if (!credential) {
        await store.resolve(tenant, id, lease, "rejected", null, currentTime());
        return { state: "rejected", reason: "credential_revoked" };
      }
      const authorized = async () => {
        const current = await store.connection(
          tenant,
          data.attempt.destination,
        );
        const activeSource = await store.connection(
          tenant,
          data.attempt.source,
        );
        const liveLease = await store
          .statement(
            "SELECT 1 n FROM leases WHERE tenant=? AND scope=? AND token=? AND fence=? AND expires_at>?",
            tenant,
            lease.scope,
            lease.token,
            lease.fence,
            currentTime(),
          )
          .first();
        const active =
          operationAuthorized() &&
          current?.status === "active" &&
          current.credential_version === data.attempt.credential_version &&
          current.remote_identity === data.connection.remote_identity &&
          current.config === data.connection.config &&
          activeSource?.status === "active" &&
          Boolean(liveLease) &&
          (await claimedAttemptCurrent(
            store,
            tenant,
            id,
            identity,
            currentTime(),
            lease,
          )) &&
          (await sourceContextUnchanged(
            store,
            key,
            sourceContext,
            currentTime(),
          )) &&
          Boolean(
            await store.private(
              tenant,
              data.attempt.destination,
              data.attempt.credential_version,
              "credential",
            ),
          ) &&
          (authorizationMode !== "qrz_fresh_insert" ||
            (await qrzFreshInsertCurrent(store, key, id)));
        return active;
      };
      const client = qrzClient(
        store,
        credential,
        JSON.parse(data.connection.config) as QrzConfig,
        gates,
        { ...deps, now: currentTime() },
        {
          source: await store.connection(tenant, data.attempt.source),
          destination: data.connection,
        },
        authorized,
        async (input, init) => {
          mutationBlocked = true;
          const validRequest = () => {
            if (authorizationMode !== "qrz_fresh_insert") return true;
            if (data.payload.kind !== "qrz") return false;
            const form = new URLSearchParams(String(init?.body));
            return (
              String(input) === "https://logbook.qrz.com/api" &&
              init?.method === "POST" &&
              init.redirect === "manual" &&
              [...form.keys()].length === 3 &&
              ["KEY", "ACTION", "ADIF"].every(
                (field) => form.getAll(field).length === 1,
              ) &&
              form.get("KEY") === credential.apiKey &&
              form.get("ACTION") === "INSERT" &&
              form.get("ADIF") === serializeAdifRecord(data.payload.record)
            );
          };
          if (
            !validRequest() ||
            !(await authorized()) ||
            !operationAuthorized() ||
            !validRequest() ||
            currentTime() >= Math.min(proofExpiresAt, lease.expires_at)
          ) {
            throw new UnsentAuthorizationError();
          }
          mutationBlocked = false;
          mutationStarted = true;
        },
        authorizationMode,
      );
      try {
        if (
          data.payload.operation === "insert" &&
          (await client.findNeighborhood(data.payload.record)).length
        )
          throw new QrzError(
            "blocked",
            "Fresh QRZ collision appeared before dispatch",
          );
        const receipt =
          data.payload.operation === "replace" && data.payload.mappedLogId
            ? await client.replacePrepared(
                data.payload.mappedLogId,
                data.payload.record,
                data.payload.narrative,
              )
            : await client.insert(data.payload.record);
        remoteId = receipt.logId;
        state = "delivered";
      } catch (error) {
        if (error instanceof VendorDeferredError) throw error;
        if (mutationBlocked && !mutationStarted)
          return await retryBlockedTransport();
        if (
          !mutationStarted &&
          !(await attemptSourceExportProofCurrent(
            store,
            tenant,
            id,
            currentTime(),
          ))
        )
          return await retireUnsentProof();
        if (
          !mutationStarted &&
          error instanceof QrzError &&
          ["transient", "protocol", "rejected"].includes(error.kind)
        ) {
          await store.retryUnsent(
            tenant,
            id,
            lease,
            "qrz_readback_before_dispatch_failed",
            currentTime(),
          );
          return {
            state: "retry_scheduled",
            attemptId: id,
            reason: "qrz_readback_before_dispatch_failed",
          };
        }
        state =
          error instanceof QrzError &&
          (["rejected", "auth"].includes(error.kind) ||
            (error.kind === "blocked" && !mutationStarted))
            ? "rejected"
            : "uncertain";
      }
    } else {
      const payload = data.payload;
      const credential = await store.private<LotwCredential>(
        tenant,
        data.attempt.destination,
        data.attempt.credential_version,
        "credential",
      );
      if (!credential) {
        await store.resolve(tenant, id, lease, "rejected", null, currentTime());
        return { state: "rejected", reason: "credential_revoked" };
      }
      let authorizeTransport: (() => Promise<boolean>) | undefined;
      const transport: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        const upload = url.pathname === "/lotw/upload";
        // A narrow capability may use only the adapter's two read endpoints or
        // the exact single-artifact upload. No other mutation can bypass this hook.
        if (
          !upload &&
          !(
            url.origin === "https://lotw.arrl.org" &&
            !url.hash &&
            !url.username &&
            !url.password &&
            ["/lotwuser/lotwreport.adi", "/lotw/crl"].includes(url.pathname) &&
            (init?.method ?? "GET") === "GET" &&
            init?.redirect === "manual"
          )
        ) {
          mutationBlocked = true;
          throw new UnsentAuthorizationError();
        }
        if (upload) {
          mutationBlocked = true;
          let requestCurrent = () => true;
          {
            const form = init?.body;
            const file = form instanceof FormData ? form.get("upfile") : null;
            requestCurrent = () =>
              String(input) === "https://lotw.arrl.org/lotw/upload" &&
              init?.method === "POST" &&
              init.redirect === "manual" &&
              init.body === form &&
              form instanceof FormData &&
              [...form.keys()].length === 1 &&
              form.getAll("upfile").length === 1 &&
              form.get("upfile") === file &&
              file instanceof File &&
              file.name === "lofi-qso-ferry.tq8" &&
              file.type === "application/octet-stream" &&
              file.size > 0 &&
              file.size <= 512_000;
            if (
              !requestCurrent() ||
              !(file instanceof File) ||
              b64(new Uint8Array(await file.arrayBuffer())) !== payload.tq8
            )
              throw new UnsentAuthorizationError();
          }
          try {
            const ownership = await renewAttemptLotwOwnership(
              store,
              tenant,
              id,
              payload,
              currentTime(),
              ownershipLease,
            );
            ownershipExpiresAt = ownership.expiresAt;
          } catch {
            throw new UnsentAuthorizationError();
          }
          if (
            !requestCurrent() ||
            !authorizeTransport ||
            !(await authorizeTransport()) ||
            !(await attemptLotwOwnershipCurrent(
              store,
              tenant,
              id,
              currentTime(),
            )) ||
            !operationAuthorized() ||
            !requestCurrent() ||
            !certificate ||
            !certificateCurrentlyValid(certificate, currentTime()) ||
            currentTime() >=
              Math.min(proofExpiresAt, lease.expires_at, ownershipExpiresAt)
          ) {
            throw new UnsentAuthorizationError();
          }
          mutationBlocked = false;
          mutationStarted = true;
        }
        return (deps.fetcher ?? fetch)(input, init);
      };
      const client = new LotwClient(credential.query ?? null, {
        fetcher: (input, init) =>
          vendorFetch(store, "lotw", transport, {
            priority: deps.priority,
            now: currentTime(),
          })(input, init),
        exportsEnabled: true,
      });
      if (authorizationMode === "lotw_fresh_insert") {
        const holdUnsent = async (reason: string): Promise<DeliveryResult> => {
          await store.retryUnsent(tenant, id, lease, reason, currentTime());
          return { state: "retry_scheduled", attemptId: id, reason };
        };
        if (!credential.query)
          return await holdUnsent("lotw_query_required_for_fresh_insert");
        let history: Awaited<ReturnType<typeof checkLotwFirstInsertHistory>>;
        try {
          history = await checkLotwFirstInsertHistory(
            {
              credentials: credential.query,
              station: data.payload.station,
              contact: data.payload.contact,
            },
            {
              fetcher: (input, init) =>
                vendorFetch(store, "lotw", transport, {
                  priority: deps.priority,
                  now: currentTime(),
                })(input, init),
            },
          );
        } catch (error) {
          if (error instanceof VendorDeferredError) throw error;
          return await holdUnsent("lotw_fresh_insert_history_unavailable");
        }
        if (history.state !== "empty")
          return await holdUnsent("lotw_fresh_insert_history_present");
      }
      const certificateVersion = data.payload.certificateVersion;
      const certificate = (
        credential.signingCredentials ??
        (credential.signing ? [credential.signing] : [])
      ).find((cert) => cert.version === certificateVersion);
      if (!certificate) {
        await store.resolve(tenant, id, lease, "rejected", null, currentTime());
        return {
          state: "rejected",
          reason: "lotw_certificate_version_unavailable",
        };
      }
      if (!certificateCurrentlyValid(certificate, currentTime())) {
        await store.resolve(tenant, id, lease, "rejected", null, currentTime());
        return {
          state: "rejected",
          reason: "lotw_certificate_not_currently_valid",
        };
      }
      const certificateStatus = await client.certificateStatus(
        certificate.serial,
      );
      if (certificateStatus === "unknown") {
        await store.retryUnsent(
          tenant,
          id,
          lease,
          "lotw_certificate_status_unavailable",
          currentTime(),
        );
        return {
          state: "retry_scheduled",
          attemptId: id,
          reason: "lotw_certificate_status_unavailable",
        };
      }
      if (certificateStatus !== "unrevoked") {
        await store.resolve(tenant, id, lease, "rejected", null, currentTime());
        return {
          state: "rejected",
          reason: "lotw_certificate_no_longer_usable",
        };
      }
      const beforeSubmit = await store.connection(
        tenant,
        data.attempt.destination,
      );
      if (
        !(await attemptSourceExportProofCurrent(
          store,
          tenant,
          id,
          currentTime(),
        ))
      )
        return await retireUnsentProof();
      if (
        !operationAuthorized() ||
        beforeSubmit?.status !== "active" ||
        beforeSubmit.credential_version !== data.attempt.credential_version ||
        (await store.connection(tenant, data.attempt.source))?.status !==
          "active" ||
        !(await claimedAttemptCurrent(
          store,
          tenant,
          id,
          identity,
          currentTime(),
          lease,
        )) ||
        !(await sourceContextUnchanged(
          store,
          key,
          sourceContext,
          currentTime(),
        )) ||
        !(await store.private(
          tenant,
          data.attempt.destination,
          data.attempt.credential_version,
          "credential",
        ))
      ) {
        if (authorizationMode === "lotw_fresh_insert")
          return await retryBlockedTransport();
        await store.resolve(tenant, id, lease, "rejected", null, currentTime());
        return {
          state: "rejected",
          reason: "connection_revoked_before_submit",
        };
      }
      authorizeTransport = async () => {
        const current = await store.connection(
          tenant,
          data.attempt.destination,
        );
        return (
          operationAuthorized() &&
          certificateCurrentlyValid(certificate, currentTime()) &&
          current?.status === "active" &&
          current.credential_version === data.attempt.credential_version &&
          current.remote_identity === data.connection.remote_identity &&
          current.config === data.connection.config &&
          (await claimedAttemptCurrent(
            store,
            tenant,
            id,
            identity,
            currentTime(),
            lease,
          )) &&
          (await sourceContextUnchanged(
            store,
            key,
            sourceContext,
            currentTime(),
          )) &&
          (authorizationMode !== "lotw_fresh_insert" ||
            (await lotwFreshInsertCurrent(store, key, id)))
        );
      };
      const result = await client.submit(unb64(data.payload.tq8), {
        liveWriteAuthorized: true,
      });
      if (mutationBlocked && !mutationStarted)
        return await retryBlockedTransport();
      state = result.state;
    }
    await store.resolve(
      tenant,
      id,
      lease,
      state,
      remoteId,
      currentTime(),
      data.payload.kind === "lotw"
        ? await lotwAttemptIdentity(data.payload.station, data.payload.contact)
        : undefined,
    );
    if (
      state === "delivered" &&
      data.payload.kind === "qrz" &&
      data.payload.operation === "insert"
    )
      await store
        .statement(
          "UPDATE ledger SET provenance='ferry_created' WHERE tenant=? AND source=? AND qso=? AND destination=? AND remote_id=?",
          tenant,
          data.attempt.source,
          data.attempt.qso,
          data.attempt.destination,
          remoteId,
        )
        .run();
    return { state, attemptId: id };
  } catch (error) {
    if (
      !mutationStarted &&
      (error instanceof LotwOwnershipUnavailable ||
        (error instanceof Error && error.message.includes("LoTW ownership")))
    ) {
      if (claimed)
        await store.retryUnsent(
          tenant,
          id,
          lease,
          "lotw_ownership_unavailable",
          currentTime(),
        );
      return { state: "blocked", reason: "lotw_ownership_unavailable" };
    }
    if (
      !mutationStarted &&
      error instanceof Error &&
      error.message.includes("historical association is read only")
    )
      return { state: "blocked", reason: "historical_association_read_only" };
    if (
      !mutationStarted &&
      error instanceof Error &&
      error.message.includes("source export proof unavailable")
    ) {
      await cancelStalePreparedSourceProof(store, tenant, id, currentTime());
      return { state: "blocked", reason: "source_export_proof_unavailable" };
    }
    if (!(error instanceof VendorDeferredError)) throw error;
    // Only the absence of any mutation transport proves this attempt unsent.
    // A later read or admission deferral cannot undo an earlier write.
    if (!mutationStarted) {
      if (
        !(await attemptSourceExportProofCurrent(
          store,
          tenant,
          id,
          currentTime(),
        ))
      )
        return await retireUnsentProof();
      await store.retryUnsent(
        tenant,
        id,
        lease,
        "vendor_request_deferred",
        currentTime(),
        error.retryAt,
      );
      return {
        state: "retry_scheduled",
        attemptId: id,
        reason: "vendor_request_deferred",
      };
    }
    await store.resolve(
      tenant,
      id,
      lease,
      "uncertain",
      null,
      currentTime(),
      data.payload.kind === "lotw"
        ? await lotwAttemptIdentity(data.payload.station, data.payload.contact)
        : undefined,
    );
    return { state: "uncertain", attemptId: id };
  } finally {
    if (ownershipLease) await store.release(ownershipLease);
    await store.release(lease);
  }
}
export async function reconcileAttempt(
  store: Store,
  tenant: string,
  id: string,
  deps: DeliveryDependencies = {},
): Promise<DeliveryResult> {
  const now = deps.now ?? Date.now();
  const data = await attemptData(store, tenant, id);
  if (!data)
    return {
      state: "unresolved",
      reason: "artifact_expired_or_connection_disabled",
    };
  const lease = await store.claim(
    tenant,
    `reconcile:${data.attempt.destination}`,
    now,
    120000,
  );
  if (!lease) return { state: "skipped", reason: "reconciliation_lease_busy" };
  try {
    let remoteId: string | null = null;
    let observation:
      | { confirmed: boolean; data: unknown; identity?: LotwIdentityEvidence }
      | undefined;
    if (data.payload.kind === "qrz") {
      const credential = await store.private<QrzCredential>(
        tenant,
        data.attempt.destination,
        data.connection.credential_version ?? data.attempt.credential_version,
        "credential",
      );
      if (!credential)
        return { state: "unresolved", reason: "credential_unavailable" };
      const client = qrzClient(
        store,
        credential,
        JSON.parse(data.connection.config) as QrzConfig,
        {
          exportsEnabled: false,
          liveWriteAuthorized: false,
          sourceBoundaryVerified: false,
        },
        deps,
        {
          source: await store.connection(tenant, data.attempt.source),
          destination: data.connection,
        },
      );
      const result = reconcileQrzAttempt(
        data.payload.record,
        await client.findNeighborhood(data.payload.record),
      );
      if (result.state !== "observed")
        return { state: "unresolved", reason: result.reason };
      remoteId = result.remoteId ?? null;
    } else {
      const credential = await store.private<LotwCredential>(
        tenant,
        data.attempt.destination,
        data.connection.credential_version ?? data.attempt.credential_version,
        "credential",
      );
      if (!credential?.query)
        return {
          state: "unresolved",
          reason: "lotw_query_unavailable_submission_only",
        };
      const report = await new LotwClient(credential.query, {
        fetcher: vendorFetch(store, "lotw", deps.fetcher, {
          priority: deps.priority,
          now: deps.now,
        }),
      }).query({
        startDate: data.payload.contact.date,
        endDate: data.payload.contact.date,
        stationCallsign: data.payload.station.callsign,
        workedCallsign: data.payload.contact.call,
      });
      const result = observeLotwContact(
        data.payload.station,
        data.payload.contact,
        report,
      );
      if (result.state !== "observed")
        return { state: "unresolved", reason: `lotw_${result.state}` };
      const identity = await lotwAttemptIdentity(
        data.payload.station,
        data.payload.contact,
      );
      observation = {
        confirmed: result.confirmed,
        identity,
        data: {
          station: data.payload.station,
          contact: data.payload.contact,
          projectionHash: data.payload.projectionHash,
        },
      };
      remoteId = identity.remoteId;
    }
    const applied = await store.resolveReconciled(
      tenant,
      id,
      lease,
      remoteId,
      deps.now ?? Date.now(),
      observation,
    );
    return {
      state: applied ? "observed" : "unresolved",
      reason: applied ? undefined : "reconciliation_state_or_lease_changed",
    };
  } finally {
    await store.release(lease);
  }
}

/** Refresh only compact, previously observed LoTW identities; never signs or uploads. */
export async function refreshConfirmations(
  store: Store,
  tenant: string,
  deps: DeliveryDependencies = {},
  limit = 2,
): Promise<{ checked: number; confirmed: number; unresolved: number }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10)
    throw new Error("Confirmation refresh limit must be 1–10");
  const now = deps.now ?? Date.now();
  const lease = await store.claim(tenant, "confirmation-refresh", now, 120000);
  if (!lease) return { checked: 0, confirmed: 0, unresolved: 0 };
  try {
    const rows = (
      await store
        .statement(
          "SELECT p.id,p.connection,p.created_at,a.source,a.qso,a.payload_hash FROM private_data p JOIN attempts a ON a.tenant=p.tenant AND a.destination=p.connection AND p.id='observation:'||a.id JOIN connections c ON c.tenant=p.tenant AND c.id=p.connection WHERE p.tenant=? AND p.kind='lotw_observation' AND p.revoked_at IS NULL AND c.status='active' AND p.created_at<=? ORDER BY p.created_at LIMIT ?",
          tenant,
          now - 24 * 3600000,
          limit,
        )
        .all<{
          id: string;
          connection: string;
          created_at: number;
          source: string;
          qso: string;
          payload_hash: string;
        }>()
    ).results;
    const totals = { checked: 0, confirmed: 0, unresolved: 0 };
    for (const row of rows) {
      let deferred = false;
      try {
        const evidence = await store.private<{
          station: LotwStation;
          contact: LotwContact;
          projectionHash: string;
        }>(tenant, row.connection, row.id, "lotw_observation");
        const connection = await store.connection(tenant, row.connection);
        const credential = connection?.credential_version
          ? await store.private<LotwCredential>(
              tenant,
              row.connection,
              connection.credential_version,
              "credential",
            )
          : null;
        if (!evidence || !credential?.query) {
          totals.unresolved++;
          continue;
        }
        const report = await new LotwClient(credential.query, {
          fetcher: vendorFetch(store, "lotw", deps.fetcher, {
            priority: "background",
            now: deps.now,
          }),
        }).query({
          startDate: evidence.contact.date,
          endDate: evidence.contact.date,
          stationCallsign: evidence.station.callsign,
          workedCallsign: evidence.contact.call,
        });
        const result = observeLotwContact(
          evidence.station,
          evidence.contact,
          report,
        );
        totals.checked++;
        if (result.state !== "observed") {
          totals.unresolved++;
          continue;
        }
        const updated = await store
          .statement(
            "UPDATE ledger SET confirmed=?,updated_at=? WHERE tenant=? AND source=? AND qso=? AND destination=? AND sent_hash=? AND state IN('observed','adopted_existing','delivered') AND EXISTS(SELECT 1 FROM leases WHERE tenant=? AND scope=? AND token=? AND fence=? AND expires_at>?)",
            result.confirmed ? 1 : 0,
            now,
            tenant,
            row.source,
            row.qso,
            row.connection,
            evidence.projectionHash,
            tenant,
            lease.scope,
            lease.token,
            lease.fence,
            deps.now ?? Date.now(),
          )
          .run();
        if (updated.meta.changes && result.confirmed) totals.confirmed++;
      } catch (error) {
        if (error instanceof VendorDeferredError) {
          deferred = true;
          throw error;
        }
        totals.unresolved++;
      } finally {
        if (!deferred)
          await store
            .statement(
              "UPDATE private_data SET created_at=? WHERE tenant=? AND connection=? AND id=? AND kind='lotw_observation' AND created_at=?",
              now,
              tenant,
              row.connection,
              row.id,
              row.created_at,
            )
            .run();
      }
    }
    return totals;
  } finally {
    await store.release(lease);
  }
}
