import type { DeliveryDependencies, DeliveryGates } from "./delivery-types.ts";
import { LotwClient, observeLotwContact } from "./lotw.ts";
import type { Contact } from "./projection.ts";
import { QrzClient } from "./qrz.ts";
import { canonicalLotwIdentity, lotwRemoteIdentity } from "./reconcile.ts";
import type { LotwContact, LotwStation, SigningCredential } from "./signing.ts";
import {
  type LedgerKey,
  LOTW_PRIOR_IDENTITY_NOTICE,
  type LotwIdentityEvidence,
  type Store,
} from "./store.ts";
import {
  TEMPLATE_PROFILE,
  type TemplateValue,
  type TemplateVersion,
} from "./templates.ts";
import { VendorDeferredError, vendorFetch } from "./vendor-requests.ts";
export function certificateCurrentlyValid(
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
export interface QrzCredential {
  apiKey: string;
}
export interface LotwCredential {
  signing?: SigningCredential;
  signingCredentials?: SigningCredential[];
  query?: { username: string; password: string };
}
export interface QrzConfig {
  stationCallsign: string;
  startDate: string;
  endDate: string;
  replacementContractVerified?: boolean;
}
export interface LotwConfig {
  station?: LotwStation;
  stations?: LotwStation[];
}
export const enabled = (gates: DeliveryGates) =>
  gates.exportsEnabled &&
  gates.liveWriteAuthorized &&
  gates.sourceBoundaryVerified;
export async function lotwAttemptIdentity(
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
function countyAdif(county: string, state: string | undefined): string {
  if (!state) throw new Error("County requires an explicit station state");
  if (county.includes(",")) {
    if (!county.toUpperCase().startsWith(`${state.toUpperCase()},`))
      throw new Error("County and station state disagree");
    return county;
  }
  return `${state},${county}`;
}
export function countyLotw(county: string, state: string | undefined): string {
  return countyAdif(county, state).split(",").slice(1).join(",");
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
export function qrzClient(
  store: Store,
  credential: QrzCredential,
  config: QrzConfig,
  gates: DeliveryGates,
  deps: DeliveryDependencies,
  beforeWrite?: () => Promise<boolean>,
): QrzClient {
  if (!credential.apiKey) throw new Error("QRZ credential is unavailable");
  return new QrzClient(credential.apiKey, {
    fetch: vendorFetch(store, "qrz", deps.fetcher, {
      priority: deps.priority,
      now: deps.now,
    }),
    writesEnabled: enabled(gates),
    replacementContractVerified: config.replacementContractVerified === true,
    beforeWrite,
  });
}
export function routedQrz(config: QrzConfig, contact: Contact): boolean {
  const date = new Date(contact.startAtMillis).toISOString().slice(0, 10);
  return (
    config.stationCallsign?.toUpperCase() === contact.stationCall &&
    /^\d{4}-\d{2}-\d{2}$/.test(config.startDate ?? "") &&
    /^\d{4}-\d{2}-\d{2}$/.test(config.endDate ?? "") &&
    date >= config.startDate &&
    date <= config.endDate
  );
}
export async function activeTemplate(
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
export async function unchangedProjection(
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
