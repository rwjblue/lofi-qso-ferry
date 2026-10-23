import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { LotwClient } from "../src/lotw.ts";
import { QrzClient } from "../src/qrz.ts";

const execute = promisify(execFile);
type Provider = "qrz_logbook" | "lotw";
export type CredentialReader = (
  persona: string,
  provider: Provider,
) => Promise<{ username?: string; api_key?: string; password?: string }>;
export interface ReadonlyProbeMetadata {
  qrzCredentialAvailable: boolean;
  lotwCredentialAvailable: boolean;
  qrzReadCompleted: boolean;
  qrzSampleCount: number;
  qrzIdentityFieldsPresent: boolean;
  qrzNarrativeFieldsPresent: boolean;
  qrzOwnLocationFieldsPresent: boolean;
  qrzPaginationCursorAdvances: boolean;
  lotwQueryDateAvailable: boolean;
  lotwReadCompleted: boolean;
  lotwRecordCount: number;
  lotwUnconfirmedCount: number;
  lotwConfirmedCount: number;
  lotwIdentityFieldsPresent: boolean;
  lotwOwnLocationFieldsPresent: boolean;
  qrzReadonlyRequestCount: number;
  lotwReadonlyRequestCount: number;
}
/** Even an accidental adapter mutation cannot pass this experiment's transport. */
export function readonlyVendorTransport(
  transport: typeof fetch = fetch,
  counted?: (provider: "qrz" | "lotw") => void,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (url.username || url.password || url.hash)
      throw new Error("Readonly transport blocked endpoint");
    if (
      url.origin === "https://logbook.qrz.com" &&
      url.pathname === "/api" &&
      !url.search &&
      method === "POST"
    ) {
      const body = init?.body;
      if (
        !(body instanceof URLSearchParams) ||
        body.getAll("ACTION").length !== 1 ||
        !["STATUS", "FETCH"].includes(body.get("ACTION") ?? "")
      )
        throw new Error("Readonly transport blocked QRZ mutation");
      counted?.("qrz");
    } else if (
      url.origin === "https://lotw.arrl.org" &&
      url.pathname === "/lotwuser/lotwreport.adi" &&
      method === "GET" &&
      url.searchParams.get("qso_query") === "1" &&
      url.searchParams.get("qso_qsl") === "no"
    ) {
      counted?.("lotw");
    } else throw new Error("Readonly transport blocked endpoint");
    return transport(input, { ...init, redirect: "error" });
  };
}
/** Keychain secrets are captured in subprocess memory; stderr/errors are never echoed. */
async function keychainCredentials(persona: string, provider: Provider) {
  const result = await execute(
    "mise",
    [
      "exec",
      "pipx:qso-graph-auth@0.1.1",
      "--",
      "qso-auth",
      "creds",
      "get",
      "--raw",
      persona,
      provider,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 30_000 },
  );
  const value: unknown = JSON.parse(result.stdout);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Credential unavailable");
  const object = value as {
    username?: unknown;
    api_key?: unknown;
    password?: unknown;
  };
  return {
    ...(typeof object.username === "string"
      ? { username: object.username }
      : {}),
    ...(typeof object.api_key === "string" ? { api_key: object.api_key } : {}),
    ...(typeof object.password === "string"
      ? { password: object.password }
      : {}),
  };
}
function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}
export async function vendorReadonlyProbe(
  persona: string,
  date?: string,
  dependencies: { credentials?: CredentialReader; fetcher?: typeof fetch } = {},
): Promise<ReadonlyProbeMetadata> {
  if (
    !/^[A-Za-z0-9_-]{1,80}$/.test(persona) ||
    (date !== undefined && !validDate(date))
  )
    throw new Error("A valid persona and optional ISO date are required");
  const readCredentials = dependencies.credentials ?? keychainCredentials;
  const metadata: ReadonlyProbeMetadata = {
    qrzCredentialAvailable: false,
    lotwCredentialAvailable: false,
    qrzReadCompleted: false,
    qrzSampleCount: 0,
    qrzIdentityFieldsPresent: false,
    qrzNarrativeFieldsPresent: false,
    qrzOwnLocationFieldsPresent: false,
    qrzPaginationCursorAdvances: false,
    lotwQueryDateAvailable: false,
    lotwReadCompleted: false,
    lotwRecordCount: 0,
    lotwUnconfirmedCount: 0,
    lotwConfirmedCount: 0,
    lotwIdentityFieldsPresent: false,
    lotwOwnLocationFieldsPresent: false,
    qrzReadonlyRequestCount: 0,
    lotwReadonlyRequestCount: 0,
  };
  const request = readonlyVendorTransport(dependencies.fetcher, (provider) => {
    if (provider === "qrz") metadata.qrzReadonlyRequestCount++;
    else metadata.lotwReadonlyRequestCount++;
  });
  let day = date;
  try {
    const credential = await readCredentials(persona, "qrz_logbook");
    metadata.qrzCredentialAvailable = Boolean(credential.api_key);
    if (credential.api_key) {
      const page = await new QrzClient(credential.api_key, {
        fetch: request,
      }).fetchPage({ max: 1 });
      metadata.qrzReadCompleted = true;
      metadata.qrzSampleCount = page.records.length;
      const record = page.records[0];
      if (record) {
        metadata.qrzIdentityFieldsPresent = [
          "CALL",
          "STATION_CALLSIGN",
          "QSO_DATE",
          "TIME_ON",
          "BAND",
          "MODE",
        ].every((name) => Boolean(record[name]));
        metadata.qrzNarrativeFieldsPresent = [
          "NOTES",
          "COMMENT",
          "QSLMSG",
        ].some((name) => Boolean(record[name]));
        metadata.qrzOwnLocationFieldsPresent = [
          "MY_GRIDSQUARE",
          "MY_STATE",
          "MY_CNTY",
          "MY_DXCC",
        ].some((name) => Boolean(record[name]));
        metadata.qrzPaginationCursorAdvances =
          page.nextAfterLogId !== null &&
          page.nextAfterLogId > Number(record.APP_QRZLOG_LOGID);
        if (!day && /^\d{8}$/.test(record.QSO_DATE ?? "")) {
          const value = record.QSO_DATE;
          const derived = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
          if (validDate(derived)) day = derived;
        }
      }
    }
  } catch {
    /* Fixed metadata only; vendor errors may contain URLs or secrets. */
  }
  metadata.lotwQueryDateAvailable = Boolean(day);
  try {
    const credential = await readCredentials(persona, "lotw");
    metadata.lotwCredentialAvailable = Boolean(
      credential.username && credential.password,
    );
    if (credential.username && credential.password && day) {
      const report = await new LotwClient(
        { username: credential.username, password: credential.password },
        { fetcher: request },
      ).query({ startDate: day, endDate: day });
      metadata.lotwReadCompleted = true;
      metadata.lotwRecordCount = report.records.length;
      metadata.lotwUnconfirmedCount = report.records.filter(
        (record) => record.QSL_RCVD === "N",
      ).length;
      metadata.lotwConfirmedCount = report.records.filter(
        (record) => record.QSL_RCVD === "Y",
      ).length;
      metadata.lotwIdentityFieldsPresent =
        report.records.length > 0 &&
        report.records.every(
          (record) =>
            ["CALL", "STATION_CALLSIGN", "QSO_DATE", "TIME_ON", "BAND"].every(
              (name) => Boolean(record[name]),
            ) && Boolean(record.MODE || record.APP_LOTW_MODE),
        );
      metadata.lotwOwnLocationFieldsPresent =
        report.records.length > 0 &&
        report.records.every((record) =>
          ["MY_GRIDSQUARE", "MY_STATE", "MY_CNTY", "MY_DXCC"].some((name) =>
            Boolean(record[name]),
          ),
        );
    }
  } catch {
    /* Unknown response data and key names must never reach diagnostics. */
  }
  return metadata;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await vendorReadonlyProbe(
      process.argv[2] ?? "",
      process.argv[3],
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.qrzReadCompleted || !result.lotwReadCompleted)
      process.exitCode = 1;
  } catch {
    process.stderr.write(
      "Readonly probe could not run; check persona, date and local keychain configuration.\n",
    );
    process.exitCode = 1;
  }
}
