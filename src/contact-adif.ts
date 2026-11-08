import { type AdifRecord, serializeAdifRecord } from "./adif.ts";
import { type Contact, isTestCallsign, isTestContact } from "./projection.ts";

function coordinate(value: number, latitude: boolean): string {
  const total = Math.round(Math.abs(value) * 60 * 1000) / 1000;
  const degrees = Math.floor(total / 60);
  const minutes = (total - degrees * 60).toFixed(3).padStart(6, "0");
  return `${latitude ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W"}${String(degrees).padStart(3, "0")} ${minutes}`;
}
export function countyAdif(county: string, state: string | undefined): string {
  if (!state) throw new Error("County requires an explicit station state");
  if (county.includes(",")) {
    if (!county.toUpperCase().startsWith(`${state.toUpperCase()},`))
      throw new Error("County and station state disagree");
    return county;
  }
  return `${state},${county}`;
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
export function contactIsTest(contact: Contact): boolean {
  return (
    isTestCallsign(contact.stationCall) ||
    isTestContact(contact.context.qso, contact.context.op)
  );
}

export function structuredContactAdif(contact: Contact): AdifRecord {
  if (contactIsTest(contact)) throw new Error("test_operation_not_exported");
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
