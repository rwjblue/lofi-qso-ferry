import { lotwFirstInsertSelection } from "./lotw-first-insert.ts";
import type { LotwContact, LotwStation } from "./signing.ts";
import type { Lease, Store } from "./store.ts";
import { type VendorPriority, vendorFetch } from "./vendor-requests.ts";

const DAY_MS = 86_400_000;
const MAX_REPORTS = 3;
const ORIGIN = "https://lotw.arrl.org";

export function inventoryLotwReadFetch(
  store: Store,
  batch: string,
  lease: Lease,
  fetcher: typeof fetch,
  options: {
    priority: VendorPriority;
    expiresAt: number;
    current: () => boolean;
    authority: { kind: "send"; serial: string } | { kind: "readback" };
  },
): typeof fetch {
  const { priority, expiresAt, current, authority } = options;
  const changed = () => new Error("inventory LoTW read authority changed");
  const admitted = vendorFetch(
    store,
    "lotw",
    (input, init) => {
      if (!current()) throw changed();
      return fetcher(input, init);
    },
    {
      priority,
      admit: async (reservation) => {
        if (!current()) throw changed();
        const guard = crypto.randomUUID();
        const results = await store.db.batch<{
          window_start: number;
          cooldown_until: number;
        }>([
          store.statement(
            "INSERT INTO inventory_lotw_read_guards(id,tenant,batch_id,lease_token,lease_fence,readback) VALUES(?,?,?,?,?,?)",
            guard,
            lease.tenant,
            batch,
            lease.token,
            lease.fence,
            authority.kind === "readback" ? 1 : 0,
          ),
          reservation,
          store.statement(
            "DELETE FROM inventory_lotw_read_guards WHERE id=?",
            guard,
          ),
        ]);
        return results[1].results[0] ?? null;
      },
    },
  );
  return (input, init) => {
    const url = new URL(String(input));
    const crl =
      authority.kind === "send" &&
      url.href === `${ORIGIN}/lotw/crl?serial=${authority.serial}`;
    if (
      url.origin !== ORIGIN ||
      url.username ||
      url.password ||
      url.hash ||
      (init?.method ?? "GET") !== "GET" ||
      init?.body != null ||
      init?.redirect !== "manual" ||
      (url.pathname !== "/lotwuser/lotwreport.adi" && !crl) ||
      !current()
    )
      throw changed();
    const deadline = AbortSignal.timeout(Math.max(1, expiresAt - Date.now()));
    return admitted(input, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, deadline])
        : deadline,
    });
  };
}

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
