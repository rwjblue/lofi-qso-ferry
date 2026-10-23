import { canonical, seal, sha256 } from "./security.ts";
import type { Connection, Lease, Store } from "./store.ts";
import { VendorDeferredError } from "./vendor-requests.ts";
import {
  type WavelogClient,
  WavelogError,
  type WavelogStation,
  type WavelogStationSpec,
  wavelogStationMatches,
} from "./wavelog.ts";

type StationClient = Pick<
  WavelogClient,
  "listStations" | "getStation" | "createStation" | "getLogbook" | "linkStation"
>;

export interface WavelogProvisioning {
  phase: "creating" | "created" | "linking" | "ready";
  stationId: number | null;
  logbookId: number;
  createdByFerry: boolean;
  stationUuid: string | null;
}

export class WavelogProvisioningError extends Error {
  constructor(
    readonly reason: string,
    readonly recoverable = false,
  ) {
    super(reason);
    this.name = "WavelogProvisioningError";
  }
}

export async function wavelogStationKey(
  station: WavelogStationSpec,
  logbookId: number,
): Promise<string> {
  return `wavelog-station:${await sha256(canonical({ station, logbookId }))}`;
}

/** A location with another upload policy is a conflict, not permission to duplicate it. */
export async function discoverWavelogStation(
  client: Pick<StationClient, "listStations">,
  spec: WavelogStationSpec,
): Promise<WavelogStation | null> {
  const stations = await client.listStations();
  const matchingLocation = stations.filter((station) =>
    wavelogStationMatches(
      { ...station, clublog_upload: "disabled", eqsl_qth_nickname: "" },
      spec,
    ),
  );
  if (matchingLocation.length > 1)
    throw new WavelogProvisioningError("wavelog_station_location_ambiguous");
  const station = matchingLocation[0];
  if (station && !wavelogStationMatches(station, spec))
    throw new WavelogProvisioningError(
      "wavelog_station_outbound_policy_conflict",
    );
  if (!station && stations.some((candidate) => candidate.name === spec.name))
    throw new WavelogProvisioningError("wavelog_station_name_conflict");
  return station ?? null;
}

export function readWavelogProvisioning(
  store: Store,
  connection: Connection,
  key: string,
): Promise<WavelogProvisioning | null> {
  return store.private(
    connection.tenant,
    connection.id,
    key,
    "wavelog_station",
  );
}

function definitelyNotApplied(error: unknown): boolean {
  return (
    (error instanceof WavelogError || error instanceof VendorDeferredError) &&
    (!error.requestSent ||
      (error instanceof WavelogError &&
        ["rejected", "auth", "rate"].includes(error.kind)))
  );
}

async function saveProvisioning(
  store: Store,
  connection: Connection,
  key: string,
  state: WavelogProvisioning,
  lease: Lease,
  now: number,
): Promise<void> {
  const envelope = await seal(
    state,
    {
      tenant: connection.tenant,
      connection: connection.id,
      id: key,
      kind: "wavelog_station",
      purpose: "storage",
    },
    store.keys,
  );
  const saved = await store
    .statement(
      "INSERT INTO private_data(tenant,connection,id,kind,envelope,created_at) SELECT ?,?,?,'wavelog_station',?,? WHERE EXISTS(SELECT 1 FROM leases WHERE tenant=? AND scope=? AND token=? AND fence=? AND expires_at>?) ON CONFLICT(tenant,connection,id,kind) DO UPDATE SET envelope=excluded.envelope,revoked_at=NULL",
      connection.tenant,
      connection.id,
      key,
      JSON.stringify(envelope),
      now,
      lease.tenant,
      lease.scope,
      lease.token,
      lease.fence,
      now,
    )
    .run();
  if (saved.meta.changes !== 1)
    throw new WavelogProvisioningError(
      "wavelog_provisioning_lease_changed",
      true,
    );
}

export interface WavelogProvisioningContext {
  store: Store;
  connection: Connection;
  client: StationClient;
  station: WavelogStationSpec;
  logbookId: number;
  lease: Lease;
  beforeWrite: () => Promise<boolean>;
  now: number;
}

/**
 * Every uncertain station/link request is recovered by readback. The persistent
 * intent deliberately has no expiry: losing it could duplicate a remote station.
 * Call only under the destination delivery lease, never from history or prepare.
 */
export async function ensureWavelogStation(
  ctx: WavelogProvisioningContext,
): Promise<{ stationId: number; key: string }> {
  const {
    store,
    connection,
    client,
    station: spec,
    logbookId,
    lease,
    now,
  } = ctx;
  const key = await wavelogStationKey(spec, logbookId);
  let journal = await readWavelogProvisioning(store, connection, key);
  let station = await discoverWavelogStation(client, spec);
  if (journal?.stationId) {
    if (station && station.id !== journal.stationId)
      throw new WavelogProvisioningError("wavelog_station_mapping_changed");
    const fresh = await client.getStation(journal.stationId);
    if (
      !wavelogStationMatches(fresh, spec) ||
      fresh.uuid !== journal.stationUuid
    )
      throw new WavelogProvisioningError("wavelog_station_mapping_changed");
    station = fresh;
  } else if (journal?.phase === "creating") {
    if (!station || station.name !== spec.name)
      throw new WavelogProvisioningError(
        "wavelog_station_creation_unresolved",
        true,
      );
  }

  if (!station) {
    if (!(await ctx.beforeWrite()))
      throw new WavelogProvisioningError("wavelog_write_blocked");
    journal = {
      phase: "creating",
      stationId: null,
      logbookId,
      createdByFerry: true,
      stationUuid: null,
    };
    await saveProvisioning(store, connection, key, journal, lease, now);
    // The client rechecks authorization immediately before the transport.
    try {
      station = await client.createStation(spec);
    } catch (error) {
      if (definitelyNotApplied(error))
        await store
          .statement(
            "DELETE FROM private_data WHERE tenant=? AND connection=? AND id=? AND kind='wavelog_station' AND EXISTS(SELECT 1 FROM leases WHERE tenant=? AND scope=? AND token=? AND fence=? AND expires_at>?)",
            connection.tenant,
            connection.id,
            key,
            lease.tenant,
            lease.scope,
            lease.token,
            lease.fence,
            now,
          )
          .run();
      throw error;
    }
    if (!wavelogStationMatches(station, spec) || station.name !== spec.name)
      throw new WavelogProvisioningError(
        "wavelog_created_station_unverified",
        true,
      );
  }

  if (!journal || journal.phase === "creating") {
    journal = {
      phase: "created",
      stationId: station.id,
      logbookId,
      createdByFerry: journal?.createdByFerry ?? false,
      stationUuid: station.uuid,
    };
    await saveProvisioning(store, connection, key, journal, lease, now);
  }

  let logbook = await client.getLogbook(logbookId);
  if (!logbook.station_ids.includes(station.id)) {
    if (!journal.createdByFerry)
      throw new WavelogProvisioningError(
        "wavelog_station_manual_link_required",
      );
    if (journal.phase === "linking" || journal.phase === "ready")
      throw new WavelogProvisioningError(
        "wavelog_station_link_unresolved",
        true,
      );
    if (!(await ctx.beforeWrite()))
      throw new WavelogProvisioningError("wavelog_write_blocked");
    journal = { ...journal, phase: "linking" };
    await saveProvisioning(store, connection, key, journal, lease, now);
    try {
      await client.linkStation(logbookId, station.id);
    } catch (error) {
      if (definitelyNotApplied(error))
        await saveProvisioning(
          store,
          connection,
          key,
          { ...journal, phase: "created" },
          lease,
          now,
        );
      throw error;
    }
    logbook = await client.getLogbook(logbookId);
    if (!logbook.station_ids.includes(station.id))
      throw new WavelogProvisioningError(
        "wavelog_station_link_unresolved",
        true,
      );
  }
  await saveProvisioning(
    store,
    connection,
    key,
    { ...journal, phase: "ready" },
    lease,
    now,
  );
  return { stationId: station.id, key };
}
