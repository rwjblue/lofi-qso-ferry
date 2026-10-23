import type { AdifRecord } from "./adif.ts";
import {
  ClubLogClient,
  ClubLogError,
  clublogRecord,
  clublogRemoteIdentity,
  matchClublogHistory,
} from "./clublog.ts";
import { LotwClient } from "./lotw.ts";
import { contactAdif, sourceFingerprint, type Contact } from "./projection.ts";
import { type DestinationKind, providerDefinitions } from "./providers.ts";
import { matchQrzHistory, QrzClient, type QrzMatch } from "./qrz.ts";
import { canonical, sha256 } from "./security.ts";
import { lotwMode } from "./signing.ts";

export interface HistoryReadOptions {
  fetcher: typeof fetch;
  clublogApiKey?: string;
  config?: Record<string, unknown>;
}
export interface DestinationAdapter {
  kind: DestinationKind;
  capabilities: (typeof providerDefinitions)[DestinationKind]["capabilities"];
  routeMatches(config: Record<string, unknown>, contact: Contact): boolean;
  project(contact: Contact): AdifRecord;
  fingerprint(contact: Contact, remotePreserved?: boolean): Promise<string>;
  readHistory(
    credential: unknown,
    contact: Contact,
    record: AdifRecord,
    options: HistoryReadOptions,
  ): Promise<{ records: AdifRecord[]; readAccess: boolean }>;
  matchHistory(source: AdifRecord, records: AdifRecord[]): QrzMatch;
  remoteIdentity(record: AdifRecord): Promise<string | null>;
  /** Pre-insert identity, which may differ from a server-assigned record ID. */
  reservationIdentity?(record: AdifRecord): Promise<string | null>;
  requestScope?(config: Record<string, unknown>): string | undefined;
}

/** Minimal identity tuple; unchanged from the existing LoTW reconciliation contract. */
export function canonicalLotwIdentity(record: AdifRecord): AdifRecord {
  const mode = lotwMode(
    record.MODE ?? "",
    record.SUBMODE || record.APP_LOTW_MODE,
  );
  return Object.fromEntries(
    [
      "STATION_CALLSIGN",
      "CALL",
      "QSO_DATE",
      "TIME_ON",
      "BAND",
      "MODE",
      "PROP_MODE",
      "SAT_NAME",
    ].map((field) => [
      field,
      (field === "MODE" ? mode : (record[field] ?? "")).toUpperCase(),
    ]),
  );
}
export async function lotwRemoteIdentity(record: AdifRecord): Promise<string> {
  return sha256(canonical(canonicalLotwIdentity(record)));
}

function matchLotwHistory(source: AdifRecord, remote: AdifRecord[]): QrzMatch {
  const normalize = (record: AdifRecord): AdifRecord => {
    const mode = lotwMode(
      record.MODE ?? "",
      record.SUBMODE || record.APP_LOTW_MODE,
    );
    const {
      SUBMODE: _submode,
      APP_LOTW_MODE: _mode,
      APP_LOTW_MODEGROUP: _group,
      ...fields
    } = record;
    const supported = new Set([
      "STATION_CALLSIGN",
      "CALL",
      "QSO_DATE",
      "TIME_ON",
      "BAND",
      "FREQ",
      "FREQ_RX",
      "BAND_RX",
      "MODE",
      "PROP_MODE",
      "SAT_NAME",
      "MY_DXCC",
      "MY_GRIDSQUARE",
      "MY_STATE",
      "MY_CNTY",
      "MY_CQ_ZONE",
      "MY_ITU_ZONE",
      "MY_IOTA",
      "QSL_RCVD",
    ]);
    return {
      ...Object.fromEntries(
        Object.entries(fields).filter(([field]) => supported.has(field)),
      ),
      MODE: mode,
    };
  };
  let matchingSource: AdifRecord;
  let matchingRemote: AdifRecord[];
  try {
    matchingSource = normalize(source);
    matchingRemote = remote.map(normalize);
  } catch {
    return {
      state: "history_ambiguous",
      reason: "LoTW individual mode mapping is unsupported",
    };
  }
  for (const field of ["FREQ", "FREQ_RX"]) {
    const frequency = matchingSource[field];
    if (
      frequency &&
      (!/^\d+(?:\.\d+)?$/.test(frequency) ||
        (frequency.split(".")[1] ?? "").replace(/0+$/, "").length > 5)
    )
      return {
        state: "history_ambiguous",
        reason: `LoTW query cannot establish the transmitted precision of ${field}`,
      };
  }
  return matchQrzHistory(matchingSource, matchingRemote);
}

export const destinationAdapters: Readonly<
  Record<DestinationKind, DestinationAdapter>
> = {
  qrz: {
    kind: "qrz",
    capabilities: providerDefinitions.qrz.capabilities,
    routeMatches(config, contact) {
      const date = new Date(contact.startAtMillis).toISOString().slice(0, 10);
      return (
        config.stationCallsign === contact.stationCall &&
        typeof config.startDate === "string" &&
        typeof config.endDate === "string" &&
        date >= config.startDate &&
        date <= config.endDate
      );
    },
    project: contactAdif,
    fingerprint: (contact, preserved) =>
      sourceFingerprint(contact, "qrz", preserved),
    async readHistory(credential, _contact, record, options) {
      const raw = credential as { apiKey?: string } | null;
      if (!raw?.apiKey) return { records: [], readAccess: false };
      const records = await new QrzClient(raw.apiKey, {
        fetch: options.fetcher,
      }).findNeighborhood(record);
      return { records, readAccess: true };
    },
    matchHistory(source, records) {
      const match = matchQrzHistory(source, records);
      if (
        match.state === "adopted_existing" &&
        !/^\d+$/.test(match.record.APP_QRZLOG_LOGID ?? "")
      )
        return {
          state: "history_ambiguous",
          reason: "Matched QRZ record has no verified LOGID",
        };
      return match;
    },
    remoteIdentity: async (record) => record.APP_QRZLOG_LOGID ?? null,
  },
  lotw: {
    kind: "lotw",
    capabilities: providerDefinitions.lotw.capabilities,
    routeMatches(config, contact) {
      const stations = (
        Array.isArray(config.stations) ? config.stations : [config.station]
      ) as { callsign?: string; dxcc?: number }[];
      return stations.some(
        (station) =>
          station?.callsign === contact.stationCall &&
          (contact.dxcc === undefined || station.dxcc === contact.dxcc),
      );
    },
    project: contactAdif,
    fingerprint: (contact, preserved) =>
      sourceFingerprint(contact, "lotw", preserved),
    async readHistory(credential, contact, _record, options) {
      const raw = credential as {
        query?: { username: string; password: string };
      } | null;
      if (!raw?.query) return { records: [], readAccess: false };
      const date = new Date(contact.startAtMillis).toISOString().slice(0, 10);
      const report = await new LotwClient(raw.query, {
        fetcher: options.fetcher,
      }).query({
        startDate: date,
        endDate: date,
        stationCallsign: contact.stationCall,
        workedCallsign: contact.call,
      });
      return { records: report.records, readAccess: true };
    },
    matchHistory: matchLotwHistory,
    remoteIdentity: lotwRemoteIdentity,
  },
  clublog: {
    kind: "clublog",
    capabilities: providerDefinitions.clublog.capabilities,
    routeMatches: (config, contact) =>
      config.stationCallsign === contact.stationCall,
    project: clublogRecord,
    fingerprint: (contact, preserved) =>
      sourceFingerprint(contact, "clublog", preserved),
    async readHistory(credential, contact, _record, options) {
      const raw = credential as {
        email?: string;
        password?: string;
        callsign?: string;
      } | null;
      if (!raw?.email || !raw.password || !raw.callsign)
        return { records: [], readAccess: false };
      if (raw.callsign !== contact.stationCall)
        throw new ClubLogError("blocked", "Club Log credential route changed");
      const records = await new ClubLogClient(
        { email: raw.email, password: raw.password, callsign: raw.callsign },
        { apiKey: options.clublogApiKey, fetcher: options.fetcher },
      ).download();
      return { records, readAccess: true };
    },
    matchHistory: matchClublogHistory,
    remoteIdentity: clublogRemoteIdentity,
    reservationIdentity: clublogRemoteIdentity,
  },
};

export function destinationAdapter(kind: DestinationKind): DestinationAdapter {
  const adapter = destinationAdapters[kind];
  if (!adapter) throw new Error("Unsupported destination");
  return adapter;
}
