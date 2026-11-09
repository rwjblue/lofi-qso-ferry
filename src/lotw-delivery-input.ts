import { countyAdif } from "./contact-adif.ts";
import {
  canonicalLotwIdentity,
  lotwRemoteIdentity,
} from "./destination-receipts.ts";
import type { Contact } from "./projection.ts";
import { canonical, sha256 } from "./security.ts";
import type { LotwContact, LotwStation, SigningCredential } from "./signing.ts";
import type { LotwIdentityEvidence } from "./store.ts";

export interface LotwCredential {
  signing?: SigningCredential;
  signingCredentials?: SigningCredential[];
  query?: { username: string; password: string };
}

export interface LotwConfig {
  station?: LotwStation;
  stations?: LotwStation[];
}

export function lotwDeliveryInput(config: LotwConfig, contact: Contact) {
  const routes = (
    config.stations ?? (config.station ? [config.station] : [])
  ).filter(
    (station) =>
      station.callsign === contact.stationCall &&
      (contact.dxcc === undefined || station.dxcc === contact.dxcc),
  );
  const [route] = routes;
  if (routes.length !== 1 || !Number.isInteger(contact.dxcc ?? route.dxcc))
    return null;
  const station: LotwStation = {
    callsign: contact.stationCall,
    dxcc: contact.dxcc ?? route.dxcc,
    ...(contact.grid ? { grid: contact.grid } : {}),
    ...(contact.state ? { state: contact.state } : {}),
    ...(contact.county
      ? {
          county: countyAdif(contact.county, contact.state)
            .split(",")
            .slice(1)
            .join(","),
        }
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
  const qso: LotwContact = {
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
  return { station, qso };
}

export function lotwSigningCertificate(
  credential: LotwCredential,
  station: LotwStation,
  contact: LotwContact,
) {
  const eligible = (
    credential.signingCredentials ??
    (credential.signing ? [credential.signing] : [])
  ).filter(
    (cert) =>
      cert.callsign === station.callsign &&
      cert.dxcc === station.dxcc &&
      cert.qsoFrom <= contact.date &&
      (!cert.qsoTo || cert.qsoTo >= contact.date),
  );
  return eligible.length === 1 ? eligible[0] : null;
}

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

export function lotwProjectionHash(station: LotwStation, qso: LotwContact) {
  const { id: _id, generation: _generation, ...contact } = qso;
  return sha256(canonical({ station, contact }));
}
