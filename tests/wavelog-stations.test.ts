import assert from "node:assert/strict";
import test from "node:test";
import {
  type WavelogClient,
  WavelogError,
  type WavelogLogbook,
  type WavelogStation,
  type WavelogStationSpec,
} from "../src/wavelog.ts";
import {
  discoverWavelogStation,
  ensureWavelogStation,
  readWavelogProvisioning,
  WavelogProvisioningError,
  wavelogStationKey,
} from "../src/wavelog-stations.ts";
import { database, seed } from "./helpers.ts";

const spec: WavelogStationSpec = {
  name: "Ferry W1AW FN31AA test",
  callsign: "W1AW",
  gridsquare: "FN31AA",
  dxcc: 291,
  cq: 5,
  itu: 8,
  state: "CT",
  cnty: "CT,Tolland",
  pota: "US-1234",
  clublog_upload: "disabled",
  eqsl_qth_nickname: "",
};
function station(id = 10): WavelogStation {
  return {
    ...spec,
    id,
    uuid: `station-${id}`,
    active: false,
    power: null,
    sota: "",
    wwff: "",
    sig: "",
    sig_info: "",
  };
}

async function setup() {
  const h = await database();
  await seed(h.store);
  const connection = await h.store.connection("a", "destination");
  assert(connection);
  const now = Date.now();
  const lease = await h.store.claim("a", "delivery:destination", now, 120000);
  assert(lease);
  const stations: WavelogStation[] = [];
  const logbook: WavelogLogbook = {
    id: 1,
    name: "Synthetic log",
    active: true,
    station_ids: [],
  };
  const flags = {
    loseCreate: false,
    loseLink: false,
    hideCreation: false,
    allow: true,
    denyCreate: false,
    denyLink: false,
    creationRejection: null as "rejected" | "auth" | "rate" | null,
  };
  const calls = { creates: 0, links: 0, authorizations: 0 };
  const client: Pick<
    WavelogClient,
    | "listStations"
    | "getStation"
    | "createStation"
    | "getLogbook"
    | "linkStation"
  > = {
    async listStations() {
      return flags.hideCreation ? [] : stations.map((value) => ({ ...value }));
    },
    async getStation(id) {
      const found = stations.find((value) => value.id === id);
      assert(found);
      return { ...found };
    },
    async createStation(value) {
      assert.deepEqual(value, spec);
      if (flags.denyCreate)
        throw new WavelogError("blocked", "authorization_changed");
      calls.creates++;
      if (flags.creationRejection)
        throw new WavelogError(flags.creationRejection, "http_rejected", {
          requestSent: true,
        });
      const created = station();
      stations.push(created);
      if (flags.loseCreate) throw new Error("synthetic lost create response");
      return created;
    },
    async getLogbook(id) {
      assert.equal(id, logbook.id);
      return { ...logbook, station_ids: [...logbook.station_ids] };
    },
    async linkStation(logbookId, stationId) {
      assert.equal(logbookId, logbook.id);
      if (flags.denyLink)
        throw new WavelogError("blocked", "authorization_changed");
      calls.links++;
      logbook.station_ids.push(stationId);
      if (flags.loseLink) throw new Error("synthetic lost link response");
      return { ...logbook, station_ids: [...logbook.station_ids] };
    },
  };
  const context = {
    store: h.store,
    connection,
    client,
    station: spec,
    logbookId: 1,
    lease,
    now,
    beforeWrite: async () => {
      calls.authorizations++;
      return flags.allow;
    },
  };
  return { ...h, context, client, stations, logbook, flags, calls };
}

test("Wavelog provisioning reuses an exact passive station and preserves logbook memberships", async () => {
  const h = await setup();
  try {
    h.stations.push({ ...station(), name: "My portable station" });
    h.logbook.station_ids.push(7, 10);
    const found = await discoverWavelogStation(h.client, spec);
    assert.equal(found?.id, 10);
    assert.deepEqual(h.calls, { creates: 0, links: 0, authorizations: 0 });
    const result = await ensureWavelogStation(h.context);
    assert.equal(result.stationId, 10);
    assert.deepEqual(h.logbook.station_ids, [7, 10]);
    assert.equal(h.calls.creates, 0);
    assert.equal(h.calls.links, 0);
    await ensureWavelogStation(h.context);
    assert.equal(h.calls.links, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("a lost Wavelog station creation response recovers one exact station without another POST", async () => {
  const h = await setup();
  try {
    h.flags.loseCreate = true;
    await assert.rejects(ensureWavelogStation(h.context));
    const key = await wavelogStationKey(spec, 1);
    assert.equal(
      (await readWavelogProvisioning(h.store, h.context.connection, key))
        ?.phase,
      "creating",
    );
    h.flags.hideCreation = true;
    await assert.rejects(ensureWavelogStation(h.context), {
      reason: "wavelog_station_creation_unresolved",
    });
    assert.equal(h.calls.creates, 1);
    assert.equal(h.calls.links, 0);
    h.flags.hideCreation = false;
    const recovered = await ensureWavelogStation(h.context);
    assert.equal(recovered.stationId, 10);
    assert.equal(h.calls.creates, 1);
    assert.equal(h.calls.links, 1);
    assert.equal(
      (await readWavelogProvisioning(h.store, h.context.connection, key))
        ?.phase,
      "ready",
    );
  } finally {
    await h.mf.dispose();
  }
});

test("a lost Wavelog link response recovers membership without repeating the PATCH", async () => {
  const h = await setup();
  try {
    h.flags.loseLink = true;
    await assert.rejects(ensureWavelogStation(h.context));
    assert.equal(h.calls.links, 1);
    // Wavelog's station inventory may omit an unlinked location; its known ID
    // remains readable and must still recover after linking finishes.
    h.flags.hideCreation = true;
    const saved = [...h.logbook.station_ids];
    h.logbook.station_ids = [];
    await assert.rejects(ensureWavelogStation(h.context), {
      reason: "wavelog_station_link_unresolved",
    });
    assert.equal(h.calls.links, 1);
    h.logbook.station_ids = saved;
    await ensureWavelogStation(h.context);
    assert.equal(h.calls.creates, 1);
    assert.equal(h.calls.links, 1);
  } finally {
    await h.mf.dispose();
  }
});

test("an exact preexisting Wavelog station outside the target logbook requires manual linking", async () => {
  const h = await setup();
  try {
    h.stations.push(station());
    await assert.rejects(ensureWavelogStation(h.context), {
      reason: "wavelog_station_manual_link_required",
    });
    assert.equal(h.calls.creates, 0);
    assert.equal(h.calls.links, 0);
    h.logbook.station_ids.push(10);
    await ensureWavelogStation(h.context);
    assert.equal(h.calls.links, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("Wavelog station conflicts and write gates prevent provisioning", async () => {
  const h = await setup();
  try {
    h.flags.allow = false;
    await assert.rejects(ensureWavelogStation(h.context), {
      reason: "wavelog_write_blocked",
    });
    assert.equal(h.calls.creates, 0);
    h.flags.allow = true;
    h.stations.push({ ...station(), clublog_upload: "live" });
    await assert.rejects(ensureWavelogStation(h.context), {
      reason: "wavelog_station_outbound_policy_conflict",
    });
    h.stations[0]!.clublog_upload = "disabled";
    h.stations.push(station(11));
    await assert.rejects(ensureWavelogStation(h.context), {
      reason: "wavelog_station_location_ambiguous",
    });
    assert.equal(h.calls.creates, 0);
    assert.equal(h.calls.links, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("Wavelog journals reject an expired delivery lease before a remote mutation", async () => {
  const h = await setup();
  try {
    await h.store.release(h.context.lease);
    await assert.rejects(ensureWavelogStation(h.context), (error: unknown) => {
      assert(error instanceof WavelogProvisioningError);
      assert.equal(error.reason, "wavelog_provisioning_lease_changed");
      return true;
    });
    assert.equal(h.calls.creates, 0);
    assert.equal(h.calls.links, 0);
  } finally {
    await h.mf.dispose();
  }
});

for (const step of ["denyCreate", "denyLink"] as const)
  test(`Wavelog ${step} before transport releases only its definitely unsent intent`, async () => {
    const h = await setup();
    try {
      h.flags[step] = true;
      await assert.rejects(ensureWavelogStation(h.context), WavelogError);
      const journal = await readWavelogProvisioning(
        h.store,
        h.context.connection,
        await wavelogStationKey(spec, 1),
      );
      assert.equal(
        journal?.phase ?? null,
        step === "denyCreate" ? null : "created",
      );
      h.flags[step] = false;
      await ensureWavelogStation(h.context);
      assert.equal(h.calls.creates, 1);
      assert.equal(h.calls.links, 1);
    } finally {
      await h.mf.dispose();
    }
  });

for (const kind of ["rejected", "auth", "rate"] as const)
  test(`a ${kind} station POST cannot establish Ferry ownership of a preexisting station`, async () => {
    const h = await setup();
    try {
      h.flags.creationRejection = kind;
      await assert.rejects(ensureWavelogStation(h.context), WavelogError);
      assert.equal(
        await readWavelogProvisioning(
          h.store,
          h.context.connection,
          await wavelogStationKey(spec, 1),
        ),
        null,
      );
      h.flags.creationRejection = null;
      h.stations.push(station());
      await assert.rejects(ensureWavelogStation(h.context), {
        reason: "wavelog_station_manual_link_required",
      });
      assert.equal(h.calls.creates, 1);
      assert.equal(h.calls.links, 0);
    } finally {
      await h.mf.dispose();
    }
  });
