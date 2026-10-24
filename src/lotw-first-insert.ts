import { LotwClient, type LotwQuery } from "./lotw.ts";
import {
  type LotwContact,
  type LotwStation,
  validCallsign,
} from "./signing.ts";

export interface LotwFirstInsertHistoryInput {
  credentials: { username: string; password: string };
  station: Pick<LotwStation, "callsign">;
  contact: Pick<LotwContact, "call" | "date" | "time">;
}

export type LotwFirstInsertHistory = {
  startDate: string;
  endDate: string;
} & (
  | {
      state: "empty";
      reason: "complete_empty_three_day_report";
      recordCount: 0;
    }
  | { state: "held"; reason: "existing_history"; recordCount: number }
);

function utcDate(value: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error("Invalid LoTW first-insert contact date");
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== value
  )
    throw new Error("Invalid LoTW first-insert contact date");
  return timestamp;
}

function callsign(value: string): string {
  if (
    typeof value !== "string" ||
    /[^A-Za-z0-9/]/.test(value) ||
    !validCallsign(value.toUpperCase())
  )
    throw new Error("Invalid LoTW first-insert callsign");
  return value.toUpperCase();
}

/**
 * Conservative, observation-only first-insert history check. A complete empty
 * report for all three UTC dates covers midnight neighbors without guessing a
 * mode/time association. Any record holds; even unrelated bands/modes are not
 * filtered into absence. This is neither a uniqueness guarantee nor permission
 * to sign/upload, and does not change submitted/uncertain-attempt readback.
 *
 * The real client owns framing, full-record scope validation and the 2 MiB/30s
 * transport bounds. Accept credentials and a transport, never a caller-supplied
 * report or query implementation that can manufacture complete empty evidence.
 * Callers must supply their normal budgeted fetcher; this helper does not reserve
 * another slot, retry, cache absence or perform certificate/signing operations.
 */
export async function checkLotwFirstInsertHistory(
  input: LotwFirstInsertHistoryInput,
  options: { fetcher?: typeof fetch } = {},
): Promise<LotwFirstInsertHistory> {
  const stationCallsign = callsign(input.station.callsign);
  const workedCallsign = callsign(input.contact.call);
  const date = utcDate(input.contact.date);
  const time = input.contact.time;
  if (
    typeof time !== "string" ||
    time.length !== 9 ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\dZ$/.test(time)
  )
    throw new Error("LoTW first-insert contact requires whole-second UTC time");
  const startDate = new Date(date - 86_400_000).toISOString().slice(0, 10);
  const endDate = new Date(date + 86_400_000).toISOString().slice(0, 10);
  // Reject unsupported calendar edges rather than silently clipping coverage.
  utcDate(startDate);
  utcDate(endDate);
  const credentials = Object.freeze({
    username: input.credentials?.username,
    password: input.credentials?.password,
  });
  if (
    typeof credentials.username !== "string" ||
    !credentials.username ||
    typeof credentials.password !== "string" ||
    !credentials.password
  )
    throw new Error("LoTW first-insert query credentials are required");
  // Capture the entire scope and transport before any asynchronous work.
  const query: Readonly<LotwQuery> = Object.freeze({
    startDate,
    endDate,
    stationCallsign,
    workedCallsign,
  });
  const client = new LotwClient(credentials, { fetcher: options.fetcher });
  const report = await client.query(query);
  if (report.records.length !== 0)
    return {
      state: "held",
      reason: "existing_history",
      recordCount: report.records.length,
      startDate,
      endDate,
    };
  return {
    state: "empty",
    reason: "complete_empty_three_day_report",
    recordCount: 0,
    startDate,
    endDate,
  };
}
