import { type AdifRecord, parseAdif } from "./adif.ts";
import {
  type CertificateStatus,
  type LotwContact,
  type LotwStation,
  lotwMode,
} from "./signing.ts";

const QUERY_ENDPOINT = "https://lotw.arrl.org/lotwuser/lotwreport.adi";
const UPLOAD_ENDPOINT = "https://lotw.arrl.org/lotw/upload";
const MAX_RESPONSE = 2 * 1024 * 1024;
export interface LotwReport {
  records: AdifRecord[];
  receivedThrough: string | null;
  complete: true;
}
export interface LotwQuery {
  startDate: string;
  endDate: string;
  stationCallsign?: string;
  receivedSince?: string;
  workedCallsign?: string;
}
export type SubmissionResult = {
  state: "submitted" | "rejected" | "uncertain";
  code: string;
};
export type LotwObservation = {
  state:
    | "absent"
    | "ambiguous"
    | "observed"
    | "projection_mismatch"
    | "insufficient_evidence";
  confirmed: boolean;
  record?: AdifRecord;
  differingFields: string[];
  unverifiableFields?: string[];
};
function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}
export async function boundedResponse(
  response: Response,
  limit = MAX_RESPONSE,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let length = 0;
  let result = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > limit)
        throw new Error(
          "Vendor response exceeds bounded partition; split the date range",
        );
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
export function parseLotwReport(input: string): LotwReport {
  if (!/<EOH>/i.test(input) || !/<APP_LOTW_EOF>\s*$/i.test(input))
    throw new Error("Incomplete or non-ADIF LoTW report");
  const document = parseAdif(input.replace(/<APP_LOTW_EOF>\s*$/i, ""));
  if (
    document.header.PROGRAMID?.toUpperCase() !== "LOTW" ||
    !/^\d+$/.test(document.header.APP_LOTW_NUMREC ?? "") ||
    Number(document.header.APP_LOTW_NUMREC) !== document.records.length
  )
    throw new Error("LoTW report count or program identity mismatch");
  for (const record of document.records) {
    if (
      !record.CALL ||
      !record.STATION_CALLSIGN ||
      !record.BAND ||
      !(record.MODE || record.APP_LOTW_MODE) ||
      !/^\d{8}$/.test(record.QSO_DATE ?? "") ||
      !/^(?:\d{4}|\d{6})$/.test(record.TIME_ON ?? "") ||
      !["Y", "N"].includes(record.QSL_RCVD ?? "")
    )
      throw new Error(
        "LoTW report is missing required identity/confirmation fields",
      );
  }
  const receivedThrough = document.header.APP_LOTW_LASTQSORX ?? null;
  if (
    receivedThrough &&
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(receivedThrough)
  )
    throw new Error("Invalid LoTW receive checkpoint");
  return { records: document.records, receivedThrough, complete: true };
}
export function parseUploadResponse(input: string): SubmissionResult {
  const results = [
    ...input.matchAll(/<!--\s*\.UPL\.\s*(accepted|rejected)\s*-->/gi),
  ];
  if (results.length !== 1)
    return { state: "uncertain", code: "unrecognized_upload_response" };
  return results[0][1].toLowerCase() === "accepted"
    ? { state: "submitted", code: "queue_acknowledged" }
    : { state: "rejected", code: "vendor_rejected" };
}
/** Account passwords occur only in the outbound URL. Never log Request/URL/errors. */
export class LotwClient {
  private readonly request: typeof fetch;
  constructor(
    private readonly credentials: { username: string; password: string } | null,
    options: { fetcher?: typeof fetch; exportsEnabled?: boolean } = {},
  ) {
    this.request = options.fetcher ?? fetch;
    this.exportsEnabled = options.exportsEnabled === true;
  }
  private readonly exportsEnabled: boolean;
  async query(partition: LotwQuery): Promise<LotwReport> {
    if (!this.credentials)
      throw new Error("LoTW query credentials are not configured");
    if (
      !validDate(partition.startDate) ||
      !validDate(partition.endDate) ||
      partition.endDate < partition.startDate ||
      Date.parse(partition.endDate) - Date.parse(partition.startDate) >
        31 * 86_400_000
    )
      throw new Error(
        "LoTW query requires a date partition of at most 32 inclusive days",
      );
    if (
      partition.receivedSince &&
      !/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/.test(
        partition.receivedSince,
      )
    )
      throw new Error("Invalid LoTW receive checkpoint");
    const parameters = new URLSearchParams({
      login: this.credentials.username,
      password: this.credentials.password,
      qso_query: "1",
      qso_qsl: "no",
      qso_qsorxsince: partition.receivedSince ?? "1900-01-01",
      qso_mydetail: "yes",
      qso_withown: "yes",
      qso_startdate: partition.startDate,
      qso_enddate: partition.endDate,
    });
    if (partition.stationCallsign)
      parameters.set("qso_owncall", partition.stationCallsign);
    if (partition.workedCallsign)
      parameters.set("qso_callsign", partition.workedCallsign);
    let response: Response;
    try {
      response = await this.request(`${QUERY_ENDPOINT}?${parameters}`, {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: { "User-Agent": "LoFiQSOFerry/0.1" },
      });
    } catch {
      throw new Error(
        "LoTW query transport failed; coverage remains incomplete",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("LoTW query unavailable; coverage remains incomplete");
    }
    return parseLotwReport(await boundedResponse(response));
  }
  async certificateStatus(serial: string): Promise<CertificateStatus> {
    if (!/^\d{1,50}$/.test(serial)) return "unknown";
    try {
      const response = await this.request(
        `https://lotw.arrl.org/lotw/crl?serial=${serial}`,
        { redirect: "error", signal: AbortSignal.timeout(15_000) },
      );
      if (!response.ok) {
        await response.body?.cancel();
        return "unknown";
      }
      const body = await boundedResponse(response, 16_384);
      const statuses = [...body.matchAll(/<Status>\s*([^<]+?)\s*<\/Status>/g)];
      if (statuses.length !== 1) return "unknown";
      const known: Record<string, CertificateStatus> = {
        Unrevoked: "unrevoked",
        Superceded: "superseded",
        Superseded: "superseded",
        Revoked: "revoked",
      };
      return known[statuses[0][1].trim()] ?? "unknown";
    } catch {
      return "unknown";
    }
  }
  async submit(
    tq8: Uint8Array,
    authorization: { liveWriteAuthorized: boolean },
  ): Promise<SubmissionResult> {
    if (!this.exportsEnabled || !authorization.liveWriteAuthorized)
      throw new Error("Production exports are disabled");
    if (
      !tq8.length ||
      tq8.length > 512_000 ||
      tq8[0] !== 0x1f ||
      tq8[1] !== 0x8b
    )
      throw new Error("Invalid or excessive TQ8 artifact");
    const form = new FormData();
    form.set(
      "upfile",
      new Blob([new Uint8Array(tq8)], { type: "application/octet-stream" }),
      "lofi-qso-ferry.tq8",
    );
    try {
      const response = await this.request(UPLOAD_ENDPOINT, {
        method: "POST",
        body: form,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: { "User-Agent": "LoFiQSOFerry/0.1" },
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { state: "uncertain", code: "http_after_dispatch" };
      }
      return parseUploadResponse(await boundedResponse(response, 64 * 1024));
    } catch {
      return { state: "uncertain", code: "transport_after_dispatch" };
    }
  }
}
/** Exact precision and full supported projection: identity presence alone is insufficient. */
export function observeLotwContact(
  station: LotwStation,
  contact: LotwContact,
  report: LotwReport,
): LotwObservation {
  const date = contact.date.replaceAll("-", "");
  const time = contact.time.replaceAll(":", "").replace(/Z$/, "");
  const mode = lotwMode(contact.mode, contact.submode);
  const candidates = report.records.filter(
    (record) =>
      record.CALL?.toUpperCase() === contact.call.toUpperCase() &&
      record.STATION_CALLSIGN?.toUpperCase() ===
        station.callsign.toUpperCase() &&
      record.QSO_DATE === date &&
      record.BAND?.toUpperCase() === contact.band.toUpperCase() &&
      lotwMode(record.APP_LOTW_MODE || record.MODE || "", record.SUBMODE) ===
        mode &&
      (record.TIME_ON === time ||
        (record.TIME_ON?.length === 4 && record.TIME_ON === time.slice(0, 4))),
  );
  if (!candidates.length)
    return { state: "absent", confirmed: false, differingFields: [] };
  if (candidates.length !== 1 || candidates[0].TIME_ON !== time)
    return {
      state: "ambiguous",
      confirmed: false,
      differingFields: ["TIME_ON"],
    };
  const record = candidates[0];
  const expected: Record<string, string> = {
    BAND_RX: "",
    FREQ_RX: "",
    FREQ: contact.frequencyMHz ? Number(contact.frequencyMHz).toFixed(5) : "",
    MY_DXCC: String(station.dxcc),
    MY_GRIDSQUARE: station.grid ?? "",
    MY_STATE: station.state ?? "",
    MY_CNTY: station.county ? `${station.state},${station.county}` : "",
    MY_CQ_ZONE: station.cqZone === undefined ? "" : String(station.cqZone),
    MY_ITU_ZONE: station.ituZone === undefined ? "" : String(station.ituZone),
    MY_IOTA: station.iota ?? "",
    PROP_MODE: contact.propagation ?? "",
    SAT_NAME: contact.satellite ?? "",
  };
  if (contact.frequencyMHz)
    expected.FREQ = Number(contact.frequencyMHz).toFixed(5);
  if (
    contact.frequencyRxMHz &&
    Number(contact.frequencyRxMHz) !== Number(contact.frequencyMHz)
  )
    expected.FREQ_RX = Number(contact.frequencyRxMHz).toFixed(5);
  if (
    contact.bandRx &&
    contact.bandRx.toUpperCase() !== contact.band.toUpperCase()
  )
    expected.BAND_RX = contact.bandRx;
  const unverifiableFields = (
    [
      ["FREQ", contact.frequencyMHz],
      ["FREQ_RX", contact.frequencyRxMHz],
    ] as const
  )
    .filter(
      ([, frequency]) =>
        (frequency?.split(".")[1]?.replace(/0+$/, "").length ?? 0) > 5,
    )
    .map(([name]) => name);
  const differingFields = Object.entries(expected)
    .filter(
      ([name, input]) =>
        (record[name] ?? "").toUpperCase() !== input.toUpperCase(),
    )
    .map(([name]) => name);
  if (record.MY_VUCC_GRIDS) differingFields.push("MY_VUCC_GRIDS");
  return {
    state: differingFields.length
      ? "projection_mismatch"
      : unverifiableFields.length
        ? "insufficient_evidence"
        : "observed",
    unverifiableFields,
    confirmed: record.QSL_RCVD === "Y",
    record,
    differingFields,
  };
}
