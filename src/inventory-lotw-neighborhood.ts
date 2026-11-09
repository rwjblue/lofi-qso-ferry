import { lotwFirstInsertSelection } from "./lotw-first-insert.ts";
import type { LotwContact, LotwStation } from "./signing.ts";

const DAY_MS = 86_400_000;
const MAX_REPORTS = 3;

/** Every member keeps its exact three-day, worked-call predicate. A complete
 * station report over the union can satisfy several of those predicates. */
export function inventoryLotwReportGroups<T extends { qso: LotwContact }>(
  station: LotwStation,
  members: readonly T[],
) {
  const selections = members
    .map((member) => ({
      member,
      selection: lotwFirstInsertSelection(station, member.qso),
    }))
    .sort((a, b) => a.selection.startDate.localeCompare(b.selection.startDate));
  const groups: {
    query: { startDate: string; endDate: string; stationCallsign: string };
    selections: typeof selections;
  }[] = [];
  for (const row of selections) {
    const { startDate, endDate, stationCallsign } = row.selection;
    const current = groups.at(-1);
    if (
      current &&
      Date.parse(startDate) - Date.parse(current.query.endDate) <= DAY_MS &&
      Date.parse(endDate) - Date.parse(current.query.startDate) <= 31 * DAY_MS
    ) {
      current.query.endDate = endDate;
      current.selections.push(row);
    } else {
      groups.push({
        query: { startDate, endDate, stationCallsign },
        selections: [row],
      });
    }
  }
  return groups.length > 0 && groups.length <= MAX_REPORTS ? groups : null;
}
