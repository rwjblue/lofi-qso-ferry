import type { AdifRecord } from "./adif.ts";
import { adifInstant, QrzError, type QrzPage } from "./qrz.ts";
import { canonical, sha256 } from "./security.ts";

const DAY = 86_400_000;
export interface QrzCoveringProgress {
  pages: number;
  bytes: number;
  recordCount: number;
  digest: string;
  anchor: { id: number; hash: string };
}

/** Only hashes/counters from a validated page are suitable for plaintext progress. */
export async function validateQrzCoveringPage(
  page: QrzPage,
  cover: [string, string],
  stationCallsign: string,
  prior?: QrzCoveringProgress,
): Promise<{
  progress: QrzCoveringProgress;
  records: AdifRecord[];
  complete: boolean;
}> {
  const pages = (prior?.pages ?? 0) + 1;
  if (pages > 4 || !Number.isSafeInteger(page.count))
    throw new QrzError(
      "blocked",
      "QRZ covering read page or count bound reached",
    );
  if (!page.records.length || page.records.length > 250)
    throw new QrzError("protocol", "QRZ covering read has no positive anchor");
  let previousId = -1;
  for (const record of page.records) {
    const id = Number(record.APP_QRZLOG_LOGID);
    if (
      !/^\d+$/.test(record.APP_QRZLOG_LOGID ?? "") ||
      !Number.isSafeInteger(id) ||
      id <= previousId
    )
      throw new QrzError("protocol", "QRZ covering read order changed");
    previousId = id;
    adifInstant(record);
    if (
      ["CALL", "BAND", "MODE"].some(
        (field) => !/^[A-Za-z0-9/.-]+$/.test(record[field] ?? ""),
      ) ||
      record.STATION_CALLSIGN?.toUpperCase() !==
        stationCallsign.toUpperCase() ||
      record.QSO_DATE < cover[0].replaceAll("-", "") ||
      record.QSO_DATE > cover[1].replaceAll("-", "")
    )
      throw new QrzError("protocol", "QRZ covering read scope mismatch");
  }
  if (
    prior?.anchor &&
    (Number(page.records[0].APP_QRZLOG_LOGID) !== prior.anchor.id ||
      (await sha256(canonical(page.records[0]))) !== prior.anchor.hash)
  )
    throw new QrzError("protocol", "QRZ covering read anchor changed");
  const records = page.records.slice(prior?.anchor ? 1 : 0);
  const bytes = records.reduce(
    (sum, record) => sum + new TextEncoder().encode(canonical(record)).length,
    prior?.bytes ?? 0,
  );
  if (bytes > 2 * 1024 * 1024)
    throw new QrzError(
      "blocked",
      "QRZ covering read retained record bound reached",
    );
  const complete = page.records.length < 250;
  if (!complete && pages === 4)
    throw new QrzError("blocked", "QRZ covering read page limit reached");
  const last = page.records[page.records.length - 1];
  return {
    complete,
    records,
    progress: {
      pages,
      bytes,
      recordCount: (prior?.recordCount ?? 0) + records.length,
      digest: await sha256(canonical([prior?.digest ?? null, records])),
      anchor: {
        id: Number(last.APP_QRZLOG_LOGID),
        hash: await sha256(canonical(last)),
      },
    },
  };
}

function validRange(range: [string, string]) {
  return (
    range.length === 2 &&
    range.every(
      (day) =>
        /^\d{4}-\d{2}-\d{2}$/.test(day) &&
        Number.isFinite(Date.parse(day)) &&
        new Date(Date.parse(day)).toISOString().slice(0, 10) === day,
    ) &&
    range[0] <= range[1]
  );
}

/** Range hints choose a direction, never coverage or absence evidence. */
export function selectQrzCoveringRange(
  target: [string, string],
  bookRange: [string, string],
  hints: [string, string][] = [],
): [string, string] | null {
  if (
    !validRange(target) ||
    !validRange(bookRange) ||
    Date.parse(target[1]) - Date.parse(target[0]) > 6 * DAY ||
    target[0] < bookRange[0] ||
    target[1] > bookRange[1]
  )
    return null;
  const start = Date.parse(target[0]);
  const end = Date.parse(target[1]);
  const candidates = hints.filter(
    (hint) =>
      validRange(hint) && hint[0] >= bookRange[0] && hint[1] <= bookRange[1],
  );
  const distance = (hint: [string, string]) =>
    Math.max(0, start - Date.parse(hint[1]), Date.parse(hint[0]) - end);
  candidates.sort(
    (a, b) => distance(a) - distance(b) || a[0].localeCompare(b[0]),
  );
  for (const hint of candidates) {
    const union = [
      Math.min(start, Date.parse(hint[0])),
      Math.max(end, Date.parse(hint[1])),
    ].map((at) => new Date(at).toISOString().slice(0, 10)) as [string, string];
    if (
      (union[0] !== target[0] || union[1] !== target[1]) &&
      Date.parse(union[1]) - Date.parse(union[0]) <= 34 * DAY
    )
      return union;
  }
  const before = !candidates.length || candidates[0][0] <= target[0];
  const lower = Date.parse(bookRange[0]);
  const upper = Date.parse(bookRange[1]);
  let from = before ? Math.max(lower, end - 34 * DAY) : start;
  let to = before ? end : Math.min(upper, start + 34 * DAY);
  // Use the available book extent deterministically at a book boundary.
  if (to - from < 34 * DAY) {
    if (before) to = Math.min(upper, from + 34 * DAY);
    else from = Math.max(lower, to - 34 * DAY);
  }
  if (from === start && to === end) return null;
  return [from, to].map((at) => new Date(at).toISOString().slice(0, 10)) as [
    string,
    string,
  ];
}
