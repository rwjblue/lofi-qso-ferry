import assert from "node:assert/strict";
import test from "node:test";
import {
  type AdifRecord,
  parseAdif,
  serializeAdifRecord,
} from "../src/adif.ts";
import {
  type DeliveryGates,
  dispatchAttempt,
  type PreparedPayload,
  prepareDue,
  reconcileAttempt,
} from "../src/delivery.ts";
import {
  type Contact,
  projectContact,
  sourceFingerprint,
} from "../src/projection.ts";
import { adoptHistory, classifyHistory } from "../src/reconcile.ts";
import {
  WavelogClient,
  type WavelogLogbook,
  type WavelogRemoteQso,
  type WavelogStation,
  wavelogRecord,
  wavelogStation,
} from "../src/wavelog.ts";
import { ensureWavelogStation } from "../src/wavelog-stations.ts";
import { database, seed } from "./helpers.ts";
import { applyAdditionalMigrations } from "./runtime-fixtures.ts";

const at = Date.parse("2026-10-22T12:00:01Z");
const baseUrl = "https://wavelog.example.test/";
const gates: DeliveryGates = {
  exportsEnabled: true,
  liveWriteAuthorized: true,
  sourceBoundaryVerified: true,
};

async function setup() {
  const h = await database();
  await applyAdditionalMigrations(h.db);
  const sourceKey = await seed(h.store);
  const key = { ...sourceKey, destination: "wavelog" };
  await h.store
    .statement(
      "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,config,created_at) VALUES('a','wavelog','wavelog','synthetic-owner','Wavelog','active','wv1',?,0)",
      JSON.stringify({
        baseUrl,
        ownerId: 1,
        stationCallsign: "W1AW",
        logbookId: 1,
        autoCreateStations: true,
        outboundPolicy: "ferry",
      }),
    )
    .run();
  await (
    await h.store.putPrivate("a", "wavelog", "wv1", "credential", {
      baseUrl,
      token: `wl2_${"x".repeat(32)}`,
    })
  ).run();
  const item = await projectContact(
    {
      uuid: "q1",
      startAtMillis: at,
      stationCall: "W1AW",
      band: "20m",
      freq: 14060,
      mode: "CW",
      our: {
        grid: "FN31AA",
        dxccCode: 291,
        cqZone: 5,
        ituZone: 8,
        state: "CT",
        county: "Tolland",
        operatorCall: "W1AW",
        sent: "599",
      },
      their: { call: "K1ABC", sent: "579" },
      power: 5,
      notes: "Source narrative is not an upload instruction",
    },
    null,
  );
  await h.store.observe(
    key,
    item.generation,
    await sourceFingerprint(item, "wavelog"),
    30,
    false,
    at,
  );
  await h.store
    .statement(
      "UPDATE ledger SET state='missing_current_identity' WHERE destination='wavelog'",
    )
    .run();
  const stations: WavelogStation[] = [];
  const records: WavelogRemoteQso[] = [];
  const mutations: AdifRecord[] = [];
  const logbook: WavelogLogbook = {
    id: 1,
    name: "Synthetic logbook",
    active: true,
    station_ids: [],
  };
  const calls = { reads: 0, stations: 0, links: 0, qsos: 0 };
  const flags = {
    loseStation: false,
    loseLink: false,
    loseQso: false,
    hideStation: false,
    hideQso: false,
    auth: false,
    sourceEdited: false,
    sourceDeleted: false,
    credentialRenewed: false,
    sourceEditedAfterLink: false,
  };
  const jsonQso = (remote: WavelogRemoteQso) => {
    const r = remote.record;
    return {
      id: remote.id,
      station_id: remote.stationId,
      call: r.CALL,
      band: r.BAND,
      mode: r.MODE,
      submode: r.SUBMODE ?? null,
      qso_date: `${r.QSO_DATE.slice(0, 4)}-${r.QSO_DATE.slice(4, 6)}-${r.QSO_DATE.slice(6)} ${r.TIME_ON.slice(0, 2)}:${r.TIME_ON.slice(2, 4)}:${r.TIME_ON.slice(4)}`,
      freq: r.FREQ ? String(Number(r.FREQ) * 1e6) : null,
      rst_sent: r.RST_SENT ?? null,
      rst_rcvd: r.RST_RCVD ?? null,
      pota_ref: r.POTA_REF ?? "",
    };
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, new URL(baseUrl).origin);
    const path = url.pathname.replace("/index.php/api/v2/", "");
    const method = init?.method ?? "GET";
    if (method === "GET") {
      calls.reads++;
      if (flags.auth) return new Response("Forbidden", { status: 403 });
      if (flags.sourceEdited)
        await h.store
          .statement(
            "UPDATE ledger SET source_hash='new-source' WHERE destination='wavelog'",
          )
          .run();
      if (flags.sourceDeleted)
        await h.store
          .statement(
            "UPDATE ledger SET state='source_deleted' WHERE destination='wavelog'",
          )
          .run();
      if (flags.credentialRenewed)
        await h.store
          .statement(
            "UPDATE connections SET credential_version='wv2' WHERE id='wavelog'",
          )
          .run();
    }
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    if (path === "station" && method === "GET")
      return Response.json({ data: flags.hideStation ? [] : stations });
    if (path === "station" && method === "POST") {
      calls.stations++;
      const created: WavelogStation = {
        ...wavelogStation(item),
        ...body,
        id: 10,
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        active: false,
        power: null,
        sota: "",
        wwff: "",
        sig: "",
        sig_info: "",
      };
      stations.push(created);
      if (flags.loseStation) throw new Error("synthetic lost station receipt");
      return Response.json({ data: created }, { status: 201 });
    }
    if (/^station\/\d+$/.test(path) && method === "GET") {
      const station = stations.find(
        (entry) => entry.id === Number(path.split("/")[1]),
      );
      assert(station);
      return Response.json({ data: station });
    }
    if (path === "logbook/1" && method === "GET")
      return Response.json({ data: logbook });
    if (path === "logbook/1" && method === "PATCH") {
      calls.links++;
      logbook.station_ids = body.station_ids as number[];
      if (flags.sourceEditedAfterLink)
        await h.store
          .statement(
            "UPDATE ledger SET source_hash='new-source' WHERE destination='wavelog'",
          )
          .run();
      if (flags.loseLink) throw new Error("synthetic lost link receipt");
      return Response.json({ data: logbook });
    }
    if (path === "qso" && method === "POST") {
      calls.qsos++;
      assert.equal(body.import_type, "adif");
      const record = parseAdif(String(body.adif)).records[0]!;
      mutations.push(record);
      records.push({
        id: 42,
        stationId: Number(body.station_profile_id),
        record,
      });
      if (flags.loseQso) throw new Error("synthetic lost QSO receipt");
      return Response.json(
        { data: { parsed: 1, imported: 1, skipped: 0, messages: [] } },
        { status: 201 },
      );
    }
    if (path === "qso" && method === "GET") {
      assert.equal(url.searchParams.has("band"), false);
      const selected = flags.hideQso
        ? []
        : records.filter(
            (remote) =>
              remote.stationId === Number(url.searchParams.get("station_id")) &&
              remote.record.CALL === url.searchParams.get("callsign") &&
              remote.record.QSO_DATE ===
                url.searchParams.get("qso_since")?.replaceAll("-", ""),
          );
      const meta = {
        page: 1,
        per_page: 100,
        count: selected.length,
        total: selected.length,
        has_more: false,
      };
      if (url.searchParams.get("format") === "adif")
        return Response.json({
          data: {
            exported: selected.length,
            lastfetchedid: selected.at(-1)?.id ?? 0,
            adif: selected.length
              ? `<ADIF_VER:5>3.1.6<EOH>${selected.map((entry) => serializeAdifRecord(entry.record)).join("")}`
              : null,
          },
          meta,
        });
      return Response.json({ data: selected.map(jsonQso), meta });
    }
    if (/^qso\/\d+$/.test(path) && method === "GET") {
      const remote = records.find(
        (entry) => entry.id === Number(path.split("/")[1]),
      );
      assert(remote);
      return Response.json({ data: jsonQso(remote) });
    }
    throw new Error(`Unexpected synthetic Wavelog request ${method} ${path}`);
  };
  const deps = {
    now: at + 31 * 60000,
    fetcher,
    wavelogAllowedBaseUrls: [baseUrl],
  };
  const stage = async (contact = item) => {
    const result = await prepareDue(h.store, key, contact, gates, deps);
    assert.equal(result.state, "prepared", result.reason);
    assert(result.attemptId);
    return result.attemptId;
  };
  const change = async (values: Partial<Contact>) => {
    const next = { ...item, ...values };
    next.generation = await sourceFingerprint(next, "qrz");
    await h.store.observe(
      key,
      next.generation,
      await sourceFingerprint(next, "wavelog"),
      30,
      false,
      deps.now + 1,
    );
    deps.now += 31 * 60000;
    return next;
  };
  return {
    ...h,
    key,
    item,
    stations,
    records,
    logbook,
    mutations,
    calls,
    flags,
    deps,
    stage,
    change,
  };
}

for (const intentRecorded of [false, true])
  test(`Wavelog worker crash ${intentRecorded ? "after" : "before"} QSO intent ${intentRecorded ? "requires readback" : "resumes provisioning"}`, async () => {
    const h = await setup();
    try {
      const id = await h.stage();
      const payload = await h.store.private<PreparedPayload>(
        "a",
        "wavelog",
        id,
        "outbox",
      );
      assert(payload?.kind === "wavelog");
      const connection = await h.store.connection("a", "wavelog");
      assert(connection);
      const lease = await h.store.claim(
        "a",
        "delivery:wavelog",
        h.deps.now,
        120000,
      );
      assert(lease);
      assert(
        await h.store.claimAttempt(
          "a",
          id,
          lease,
          h.deps.now,
          undefined,
          payload.naturalIdentity,
        ),
      );
      const client = new WavelogClient(
        { baseUrl, token: `wl2_${"x".repeat(32)}` },
        {
          fetcher: h.deps.fetcher,
          writesEnabled: true,
          beforeWrite: async () => true,
          allowedBaseUrls: [baseUrl],
        },
      );
      const provision = () =>
        ensureWavelogStation({
          store: h.store,
          connection,
          client,
          station: payload.station,
          logbookId: payload.logbookId,
          lease,
          beforeWrite: async () => true,
          now: h.deps.now,
        });
      if (intentRecorded) {
        await provision();
        await (
          await h.store.putPrivate("a", "wavelog", id, "wavelog_qso_intent", {
            stationKey: payload.stationKey,
          })
        ).run();
      } else {
        h.flags.loseStation = true;
        await assert.rejects(provision());
      }
      // Simulate process death without the adapter's normal catch/resolution.
      await h.store.release(lease);
      await h.store.recover(h.deps.now);
      assert.equal(
        (
          await h.store
            .statement("SELECT state FROM attempt_state WHERE attempt=?", id)
            .first<{ state: string }>()
        )?.state,
        "uncertain",
      );
      const result = await reconcileAttempt(h.store, "a", id, h.deps);
      assert.equal(result.state, "unresolved");
      if (intentRecorded) {
        assert.notEqual(
          result.reason,
          "wavelog_provisioning_recovery_scheduled",
        );
        assert.equal(
          (await dispatchAttempt(h.store, "a", id, gates, h.deps)).state,
          "skipped",
        );
        assert.equal(h.calls.qsos, 0);
        assert(await h.store.private("a", "wavelog", id, "wavelog_qso_intent"));
      } else {
        assert.equal(result.reason, "wavelog_provisioning_recovery_scheduled");
        assert.equal(
          (await dispatchAttempt(h.store, "a", id, gates, h.deps)).state,
          "delivered",
        );
        assert.equal(h.calls.qsos, 1);
      }
      assert.equal(h.calls.stations, 1);
      assert.equal(h.calls.links, 1);
    } finally {
      await h.mf.dispose();
    }
  });

test("Wavelog prepares without remote writes then provisions, links and verifies the exact passive QSO", async () => {
  const h = await setup();
  try {
    const id = await h.stage();
    assert.equal(h.calls.stations + h.calls.links + h.calls.qsos, 0);
    const payload = await h.store.private<PreparedPayload>(
      "a",
      "wavelog",
      id,
      "outbox",
    );
    assert.equal(payload?.kind, "wavelog");
    assert.equal(
      (
        await dispatchAttempt(
          h.store,
          "a",
          id,
          { ...gates, exportsEnabled: false },
          h.deps,
        )
      ).state,
      "blocked",
    );
    assert.equal(h.calls.stations + h.calls.links + h.calls.qsos, 0);
    assert.equal(
      (await dispatchAttempt(h.store, "a", id, gates, h.deps)).state,
      "delivered",
    );
    assert.equal(h.calls.stations, 1);
    assert.equal(h.calls.links, 1);
    assert.equal(h.calls.qsos, 1);
    const row = await h.store.ledger(h.key);
    assert.equal(row?.remote_id, "42");
    assert.equal(row?.baseline_hash, row?.source_hash);
    assert.equal(h.mutations[0]?.OPERATOR, "W1AW");
    assert.equal(h.mutations[0]?.TX_PWR, "5");
    assert.equal(h.mutations[0]?.NOTES, undefined);
    assert.equal(await h.store.private("a", "wavelog", id, "outbox"), null);
    assert.equal(
      (await dispatchAttempt(h.store, "a", id, gates, h.deps)).state,
      "blocked",
    );
    assert.equal(h.calls.qsos, 1);
  } finally {
    await h.mf.dispose();
  }
});

for (const lost of ["loseStation", "loseLink"] as const)
  test(`Wavelog ${lost} recovery resumes one immutable attempt without duplicate provisioning`, async () => {
    const h = await setup();
    try {
      const id = await h.stage();
      const payload = await h.store.private("a", "wavelog", id, "outbox");
      h.flags[lost] = true;
      assert.equal(
        (await dispatchAttempt(h.store, "a", id, gates, h.deps)).state,
        "retry_scheduled",
      );
      assert.equal(h.calls.qsos, 0);
      assert.deepEqual(
        await h.store.private("a", "wavelog", id, "outbox"),
        payload,
      );
      h.deps.now += 61000;
      assert.equal(
        (await dispatchAttempt(h.store, "a", id, gates, h.deps)).state,
        "delivered",
      );
      assert.equal(h.calls.stations, 1);
      assert.equal(h.calls.links, 1);
      assert.equal(h.calls.qsos, 1);
    } finally {
      await h.mf.dispose();
    }
  });

test("an uncertain Wavelog insert retains its exact payload and resolves through numeric ID readback", async () => {
  const h = await setup();
  try {
    const id = await h.stage();
    h.flags.loseQso = true;
    assert.equal(
      (await dispatchAttempt(h.store, "a", id, gates, h.deps)).state,
      "uncertain",
    );
    const payload = await h.store.private("a", "wavelog", id, "outbox");
    const uuid = h.stations[0]!.uuid;
    h.stations[0]!.uuid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    assert.equal(
      (await reconcileAttempt(h.store, "a", id, h.deps)).reason,
      "wavelog_station_mapping_changed",
    );
    h.stations[0]!.uuid = uuid;
    h.flags.hideQso = true;
    assert.equal(
      (await reconcileAttempt(h.store, "a", id, h.deps)).state,
      "unresolved",
    );
    assert.equal(
      (await dispatchAttempt(h.store, "a", id, gates, h.deps)).state,
      "skipped",
    );
    assert.deepEqual(
      await h.store.private("a", "wavelog", id, "outbox"),
      payload,
    );
    const changed = await h.change({ call: "K2XYZ" });
    assert.equal(
      (await prepareDue(h.store, h.key, changed, gates, h.deps)).reason,
      "unresolved_attempt",
    );
    h.flags.hideQso = false;
    assert.equal(
      (await reconcileAttempt(h.store, "a", id, h.deps)).state,
      "observed",
    );
    const row = await h.store.ledger(h.key);
    assert.equal(row?.remote_id, "42");
    assert.equal(row?.state, "changed");
    assert.notEqual(row?.source_hash, row?.baseline_hash);
    assert.equal(h.calls.qsos, 1);
  } finally {
    await h.mf.dispose();
  }
});

for (const race of [
  "sourceEdited",
  "sourceDeleted",
  "credentialRenewed",
] as const)
  test(`Wavelog ${race} during preflight prevents all mutations`, async () => {
    const h = await setup();
    try {
      const id = await h.stage();
      h.flags[race] = true;
      assert.equal(
        (await dispatchAttempt(h.store, "a", id, gates, h.deps)).state,
        "rejected",
      );
      assert.equal(h.calls.stations + h.calls.links + h.calls.qsos, 0);
      if (race === "sourceDeleted")
        assert.equal((await h.store.ledger(h.key))?.state, "source_deleted");
    } finally {
      await h.mf.dispose();
    }
  });

test("Wavelog mapped corrections retain remote narrative and baseline without any PATCH", async () => {
  const h = await setup();
  try {
    const id = await h.stage();
    await dispatchAttempt(h.store, "a", id, gates, h.deps);
    const before = await h.store.ledger(h.key);
    h.records[0]!.record.NOTES = "Manual notes";
    h.records[0]!.record.QSL_RCVD = "Y";
    const changed = await h.change({ frequencyMHz: 14.061, grid: "FN32AA" });
    assert.equal(
      (await prepareDue(h.store, h.key, changed, gates, h.deps)).reason,
      "wavelog_correction_requires_review",
    );
    assert.equal(
      (await h.store.ledger(h.key))?.baseline_hash,
      before?.baseline_hash,
    );
    assert.equal(h.records[0]!.record.NOTES, "Manual notes");
    assert.equal(h.records[0]!.record.QSL_RCVD, "Y");
    assert.equal(h.calls.qsos, 1);
    assert.equal(h.calls.stations, 1);
  } finally {
    await h.mf.dispose();
  }
});

test("a source edit after Wavelog station provisioning still prevents the QSO upload", async () => {
  const h = await setup();
  try {
    const id = await h.stage();
    h.flags.sourceEditedAfterLink = true;
    assert.equal(
      (await dispatchAttempt(h.store, "a", id, gates, h.deps)).state,
      "rejected",
    );
    assert.equal(h.calls.stations, 1);
    assert.equal(h.calls.links, 1);
    assert.equal(h.calls.qsos, 0);
    assert.equal((await h.store.ledger(h.key))?.remote_id, null);
  } finally {
    await h.mf.dispose();
  }
});

test("a Wavelog minute collision with different seconds is held before any import", async () => {
  const h = await setup();
  try {
    h.stations.push({
      ...wavelogStation(h.item),
      id: 10,
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      active: false,
      power: null,
      sota: "",
      wwff: "",
      sig: "",
      sig_info: "",
    });
    h.logbook.station_ids.push(10);
    h.records.push({
      id: 42,
      stationId: 10,
      record: { ...wavelogRecord(h.item), TIME_ON: "120030" },
    });
    const result = await prepareDue(h.store, h.key, h.item, gates, h.deps);
    assert.equal(result.state, "blocked");
    assert.equal(result.reason, "wavelog_fresh_absence_check_found_candidate");
    assert.equal(h.calls.stations + h.calls.links + h.calls.qsos, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("Wavelog uncertainty cannot be resolved by matching identity with wrong power or nonpassive flags", async () => {
  const h = await setup();
  try {
    const id = await h.stage();
    h.flags.loseQso = true;
    await dispatchAttempt(h.store, "a", id, gates, h.deps);
    h.records[0]!.record.TX_PWR = "10";
    assert.equal(
      (await reconcileAttempt(h.store, "a", id, h.deps)).state,
      "unresolved",
    );
    h.records[0]!.record.TX_PWR = "5";
    h.records[0]!.record.POTA_REF = "US-1234";
    assert.equal(
      (await reconcileAttempt(h.store, "a", id, h.deps)).state,
      "unresolved",
    );
    delete h.records[0]!.record.POTA_REF;
    h.records[0]!.record.CLUBLOG_QSO_UPLOAD_STATUS = "M";
    assert.equal(
      (await reconcileAttempt(h.store, "a", id, h.deps)).state,
      "unresolved",
    );
    assert(await h.store.private("a", "wavelog", id, "outbox"));
    assert.equal(h.calls.qsos, 1);
  } finally {
    await h.mf.dispose();
  }
});

test("Wavelog pending natural identity blocks a rival source UUID from adopting its numeric remote ID", async () => {
  const h = await setup();
  try {
    const id = await h.stage();
    const rival = { ...h.item, id: "q2" };
    rival.generation = await sourceFingerprint(rival, "qrz");
    const key = { ...h.key, qso: rival.id };
    await h.store.observe(
      key,
      rival.generation,
      await sourceFingerprint(rival, "wavelog"),
      30,
      false,
      at,
    );
    h.flags.loseQso = true;
    await dispatchAttempt(h.store, "a", id, gates, h.deps);
    const remote = { ...h.records[0]!.record, APP_WAVELOG_ID: "42" };
    const history = classifyHistory(wavelogRecord(rival), [remote], {
      destination: "wavelog",
      capturedGeneration: rival.generation,
      currentGeneration: rival.generation,
      readAccess: true,
      inventoryComplete: true,
      catchupComplete: true,
      freshCheckComplete: true,
    });
    assert.equal(history.state, "adopted_existing");
    assert.equal(
      (await adoptHistory(h.store, key, rival.generation, history, h.deps.now))
        .applied,
      false,
    );
    assert.equal((await h.store.ledger(key))?.remote_id, null);
    assert.equal(
      (await reconcileAttempt(h.store, "a", id, h.deps)).state,
      "observed",
    );
    assert.equal(h.calls.qsos, 1);
  } finally {
    await h.mf.dispose();
  }
});
