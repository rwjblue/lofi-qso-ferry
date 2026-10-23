import {
  type AdifRecord,
  normalizeAdifValue,
  serializeAdifRecord,
} from "./adif.ts";
import { LotwClient, observeLotwContact } from "./lotw.ts";
import type { Contact } from "./projection.ts";
import {
  mergeQrzCorrection,
  QrzClient,
  QrzError,
  sameQrzIdentity,
} from "./qrz.ts";
import {
  canonicalLotwIdentity,
  comparableRemote,
  lotwRemoteIdentity,
  reconcileQrzAttempt,
} from "./reconcile.ts";
import { b64, canonical, randomToken, sha256, unb64 } from "./security.ts";
import {
  buildSignedTq8,
  type LotwContact,
  type LotwStation,
  type SigningCredential,
} from "./signing.ts";
import {
  type Connection,
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
export interface DeliveryGates {
  exportsEnabled: boolean;
  liveWriteAuthorized: boolean;
  sourceBoundaryVerified: boolean;
  allowedQsoIds?: string[] | null;
}
export interface DeliveryDependencies {
  fetcher?: typeof fetch;
  now?: number;
  sign?: typeof buildSignedTq8;
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
const enabled = (gates: DeliveryGates) =>
  gates.exportsEnabled &&
  gates.liveWriteAuthorized &&
  gates.sourceBoundaryVerified;
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
  if (contact.deleted) throw new Error("Deleted contacts cannot be exported");
  if (contact.startAtMillis % 1000)
    throw new Error(
      "Subsecond contact precision has no verified destination mapping",
    );
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
function qrzClient(
  credential: QrzCredential,
  config: QrzConfig,
  gates: DeliveryGates,
  deps: DeliveryDependencies,
  beforeWrite?: () => Promise<boolean>,
): QrzClient {
  if (!credential.apiKey) throw new Error("QRZ credential is unavailable");
  return new QrzClient(credential.apiKey, {
    fetch: deps.fetcher,
    writesEnabled: enabled(gates),
    replacementContractVerified: config.replacementContractVerified === true,
    beforeWrite,
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
      "UPDATE ledger SET baseline_hash=source_hash,state=CASE WHEN remote_id IS NOT NULL THEN 'observed' ELSE state END,reason=CASE WHEN reason=? THEN reason ELSE NULL END,updated_at=? WHERE tenant=? AND source=? AND qso=? AND destination=? AND generation=? AND sent_hash=?",
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
  return result.meta.changes === 1;
}
/** Prepare one immutable attempt; no template change can call this without source work. */
export async function prepareDue(
  store: Store,
  key: LedgerKey,
  contact: Contact,
  gates: DeliveryGates,
  deps: DeliveryDependencies = {},
): Promise<DeliveryResult> {
  const now = deps.now ?? Date.now();
  if (gates.allowedQsoIds && !gates.allowedQsoIds.includes(key.qso))
    return { state: "blocked", reason: "qso_outside_rollout_scope" };
  const row = await store.ledger(key);
  if (
    !row ||
    row.generation !== contact.generation ||
    contact.id !== key.qso ||
    contact.deleted ||
    row.due_at > now ||
    !["missing_current_identity", "changed", "live_new"].includes(row.state)
  )
    return { state: "skipped", reason: "not_due_or_current" };
  const connection = await store.connection(key.tenant, key.destination);
  const source = await store.connection(key.tenant, key.source);
  if (
    connection?.status !== "active" ||
    source?.status !== "active" ||
    !connection.credential_version
  )
    return { state: "blocked", reason: "connection_inactive" };
  if (!gates.sourceBoundaryVerified && !row.remote_id)
    return { state: "blocked", reason: "source_replay_boundary_unverified" };
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
    const client = qrzClient(credential, config, gates, deps);
    const structured = contactAdif(contact);
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
    } else if ((await client.findNeighborhood(record)).length)
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
    if (!enabled(gates))
      return { state: "blocked", reason: "exports_disabled_before_signing" };
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
    if (contact.startAtMillis % 1000)
      return {
        state: "blocked",
        reason: "lotw_subsecond_precision_unverified",
      };
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
    lotwIdentityId = (await lotwAttemptIdentity(station, lotwContact)).remoteId;
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
      fetcher: deps.fetcher,
      exportsEnabled: enabled(gates),
    });
    if (credential.query) {
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
    const signing = {
      ...selected,
      status,
      statusCheckedAt: new Date(now).toISOString(),
    };
    const artifact = await (deps.sign ?? buildSignedTq8)(
      signing,
      station,
      [lotwContact],
      new Date(now),
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
      preparedAt: new Date(now).toISOString(),
    };
  } else return { state: "blocked", reason: "invalid_destination" };
  const attemptId = await store.stage(
    key,
    contact.generation,
    payload,
    connection.credential_version,
    expectedTemplate,
    now,
    payload.projectionHash,
    lotwIdentityId,
  );
  return { state: "prepared", attemptId };
}
interface AttemptRow {
  id: string;
  source: string;
  qso: string;
  destination: string;
  generation: string;
  payload_id: string;
  credential_version: string;
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
    .statement("SELECT * FROM attempts WHERE tenant=? AND id=?", tenant, id)
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
  if (!enabled(gates)) return { state: "blocked", reason: "exports_disabled" };
  const now = deps.now ?? Date.now();
  const data = await attemptData(store, tenant, id);
  if (
    data &&
    gates.allowedQsoIds &&
    !gates.allowedQsoIds.includes(data.attempt.qso)
  )
    return { state: "blocked", reason: "qso_outside_rollout_scope" };
  if (!data)
    return { state: "blocked", reason: "attempt_or_connection_unavailable" };
  const lease = await store.claim(
    tenant,
    `delivery:${data.attempt.destination}`,
    now,
    120000,
  );
  if (!lease) return { state: "skipped", reason: "delivery_lease_busy" };
  try {
    if (
      !(await store.claimAttempt(
        tenant,
        id,
        lease,
        now,
        data.payload.kind === "lotw"
          ? await lotwAttemptIdentity(
              data.payload.station,
              data.payload.contact,
            )
          : undefined,
      ))
    )
      return { state: "skipped", reason: "attempt_not_claimable" };
    let state: "delivered" | "submitted" | "uncertain" | "rejected" =
      "uncertain";
    let remoteId: string | null = null;
    let mutationStarted = false;
    if (data.payload.kind === "qrz") {
      const credential = await store.private<QrzCredential>(
        tenant,
        data.attempt.destination,
        data.attempt.credential_version,
        "credential",
      );
      if (!credential) {
        await store.resolve(
          tenant,
          id,
          lease,
          "rejected",
          null,
          deps.now ?? Date.now(),
        );
        return { state: "rejected", reason: "credential_revoked" };
      }
      const client = qrzClient(
        credential,
        JSON.parse(data.connection.config) as QrzConfig,
        gates,
        deps,
        async () => {
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
              deps.now ?? Date.now(),
            )
            .first();
          const active =
            enabled(gates) &&
            current?.status === "active" &&
            current.credential_version === data.attempt.credential_version &&
            activeSource?.status === "active" &&
            Boolean(liveLease) &&
            Boolean(
              await store.private(
                tenant,
                data.attempt.destination,
                data.attempt.credential_version,
                "credential",
              ),
            );
          if (active) mutationStarted = true;
          return active;
        },
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
            deps.now ?? Date.now(),
          );
          return {
            state: "retry_scheduled",
            attemptId: id,
            reason: "qrz_readback_before_dispatch_failed",
          };
        }
        state =
          error instanceof QrzError &&
          ["rejected", "blocked", "auth"].includes(error.kind)
            ? "rejected"
            : "uncertain";
      }
    } else {
      const credential = await store.private<LotwCredential>(
        tenant,
        data.attempt.destination,
        data.attempt.credential_version,
        "credential",
      );
      if (!credential) {
        await store.resolve(
          tenant,
          id,
          lease,
          "rejected",
          null,
          deps.now ?? Date.now(),
        );
        return { state: "rejected", reason: "credential_revoked" };
      }
      const client = new LotwClient(credential.query ?? null, {
        fetcher: deps.fetcher,
        exportsEnabled: true,
      });
      const certificateVersion = data.payload.certificateVersion;
      const certificate = (
        credential.signingCredentials ??
        (credential.signing ? [credential.signing] : [])
      ).find((cert) => cert.version === certificateVersion);
      if (!certificate) {
        await store.resolve(
          tenant,
          id,
          lease,
          "rejected",
          null,
          deps.now ?? Date.now(),
        );
        return {
          state: "rejected",
          reason: "lotw_certificate_version_unavailable",
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
          deps.now ?? Date.now(),
        );
        return {
          state: "retry_scheduled",
          attemptId: id,
          reason: "lotw_certificate_status_unavailable",
        };
      }
      if (certificateStatus !== "unrevoked") {
        await store.resolve(
          tenant,
          id,
          lease,
          "rejected",
          null,
          deps.now ?? Date.now(),
        );
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
        !enabled(gates) ||
        beforeSubmit?.status !== "active" ||
        beforeSubmit.credential_version !== data.attempt.credential_version ||
        (await store.connection(tenant, data.attempt.source))?.status !==
          "active" ||
        !(await store.private(
          tenant,
          data.attempt.destination,
          data.attempt.credential_version,
          "credential",
        ))
      ) {
        await store.resolve(
          tenant,
          id,
          lease,
          "rejected",
          null,
          deps.now ?? Date.now(),
        );
        return {
          state: "rejected",
          reason: "connection_revoked_before_submit",
        };
      }
      const result = await client.submit(unb64(data.payload.tq8), {
        liveWriteAuthorized: true,
      });
      state = result.state;
    }
    await store.resolve(
      tenant,
      id,
      lease,
      state,
      remoteId,
      deps.now ?? Date.now(),
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
  } finally {
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
        credential,
        JSON.parse(data.connection.config) as QrzConfig,
        {
          exportsEnabled: false,
          liveWriteAuthorized: false,
          sourceBoundaryVerified: false,
        },
        deps,
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
        fetcher: deps.fetcher,
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
          fetcher: deps.fetcher,
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
      } catch {
        totals.unresolved++;
      } finally {
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
