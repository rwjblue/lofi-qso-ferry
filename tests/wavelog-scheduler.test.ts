import assert from "node:assert/strict";
import test from "node:test";
import { type AdifRecord, serializeAdifRecord } from "../src/adif.ts";
import { getAdminWorkload } from "../src/admin-workload.ts";
import { projectContact } from "../src/projection.ts";
import { tick } from "../src/service.ts";
import {
  type WavelogRemoteQso,
  type WavelogStation,
  wavelogRecord,
  wavelogStation,
} from "../src/wavelog.ts";
import { FIXTURE_NOW, schedulerFixture } from "./runtime-fixtures.ts";

const baseUrl = "https://logs.example.test/wavelog/";
const token = `wl2_${"x".repeat(32)}`;
const key = (destination: string) => ({
  tenant: "a",
  source: "source",
  qso: "q1",
  destination,
});

function jsonQso({ id, stationId, record }: WavelogRemoteQso) {
  const date = record.QSO_DATE;
  const time = record.TIME_ON;
  return {
    id,
    station_id: stationId,
    call: record.CALL,
    band: record.BAND,
    mode: record.MODE,
    submode: record.SUBMODE ?? null,
    qso_date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)} ${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`,
    freq: record.FREQ ? String(Number(record.FREQ) * 1e6) : null,
    rst_sent: record.RST_SENT ?? null,
    rst_rcvd: record.RST_RCVD ?? null,
    pota_ref: record.POTA_REF ?? "",
  };
}

async function fixture() {
  const h = await schedulerFixture();
  try {
    h.env.WAVELOG_ALLOWED_BASE_URLS = JSON.stringify([baseUrl]);
    h.env.CLUBLOG_API_KEY = "synthetic-clublog-application-key";
    for (const [id, config, credential] of [
      [
        "wavelog",
        {
          baseUrl,
          ownerId: 7,
          stationCallsign: "W1AW",
          logbookId: 5,
          autoCreateStations: true,
          outboundPolicy: "ferry",
          readAccess: true,
        },
        { baseUrl, token },
      ],
      [
        "clublog",
        { stationCallsign: "W1AW", readAccess: true },
        {
          email: "synthetic@example.invalid",
          password: "synthetic-password",
          callsign: "W1AW",
        },
      ],
    ] as const) {
      await h.store
        .statement(
          "INSERT INTO connections(tenant,id,kind,remote_identity,label,status,credential_version,config,created_at) VALUES('a',?,?,? ,?,'active',?,?,0)",
          id,
          id,
          `synthetic-${id}`,
          `Synthetic ${id}`,
          `fixture-${id}`,
          JSON.stringify(config),
        )
        .run();
      await (
        await h.store.putPrivate(
          "a",
          id,
          `fixture-${id}`,
          "credential",
          credential,
        )
      ).run();
    }
    const contact = await projectContact(h.qso, h.operation, [], {
      operationComplete: true,
    });
    const stations: WavelogStation[] = [
      {
        ...wavelogStation(contact),
        id: 10,
        uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        active: false,
        power: null,
        sota: "",
        wwff: "",
        sig: "",
        sig_info: "",
      },
    ];
    const records: WavelogRemoteQso[] = [
      { id: 42, stationId: 10, record: wavelogRecord(contact) },
    ];
    const clublogRecords: AdifRecord[] = [{ ...h.initial }];
    const calls = { reads: 0, writes: 0, clublogReads: 0 };
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "clublog.org") {
        assert.equal(url.pathname, "/getadif.php");
        assert.equal(init?.method, "POST");
        calls.clublogReads++;
        return new Response(
          `<ADIF_VER:5>3.1.6<PROGRAMID:7>ClubLog<EOH>\n${clublogRecords.map(serializeAdifRecord).join("\n")}\n`,
        );
      }
      if (url.hostname !== "logs.example.test") return h.fetcher(input, init);
      assert.equal(init?.redirect, "manual");
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        `Bearer ${token}`,
      );
      if ((init?.method ?? "GET") !== "GET") {
        calls.writes++;
        assert.fail("History reconciliation must not mutate Wavelog");
      }
      calls.reads++;
      const path = url.pathname.replace("/wavelog/index.php/api/v2/", "");
      if (path === "station") return Response.json({ data: stations });
      if (path === "logbook/5")
        return Response.json({
          data: {
            id: 5,
            name: "Synthetic logbook",
            active: false,
            station_ids: [10],
          },
        });
      if (path === "qso") {
        assert.equal(url.searchParams.has("band"), false);
        const selected = records.filter(
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
                ? `<ADIF_VER:5>3.1.6<EOH>${selected.map(({ record }) => serializeAdifRecord(record)).join("")}`
                : null,
            },
            meta,
          });
        return Response.json({ data: selected.map(jsonQso), meta });
      }
      assert.fail(`Unexpected synthetic Wavelog request ${path}`);
    };
    return { ...h, fetcher, stations, records, wavelogCalls: calls };
  } catch (error) {
    await h.mf.dispose();
    throw error;
  }
}

async function assertOtherProvidersAdopted(
  h: Awaited<ReturnType<typeof fixture>>,
) {
  for (const destination of ["destination", "lotw", "clublog"]) {
    const row = await h.store.ledger(key(destination));
    assert.equal(row?.state, "adopted_existing", destination);
    assert.equal(row.provenance, "adopted", destination);
    assert.equal(
      (await h.store.connection("a", destination))?.status,
      "active",
    );
  }
  assert.equal(
    h.calls.qrzWrites + h.calls.lotwUploads + h.wavelogCalls.writes,
    0,
  );
}

test("scheduler adopts Wavelog's exact numeric history ID independently and scopes its request budget to the instance", async () => {
  const h = await fixture();
  try {
    // A different self-hosted instance cannot consume this one's capacity.
    await h.store
      .statement(
        "INSERT INTO vendor_scoped_requests(vendor,scope,window_start,requests,background_requests,cooldown_until) VALUES('wavelog',?, ?,120,60,?)",
        "https://other.example.test/",
        FIXTURE_NOW,
        FIXTURE_NOW + 300_000,
      )
      .run();
    const result = await tick(h.env, h.fetcher, FIXTURE_NOW);
    assert.equal(result.errors, 0);
    assert.equal(result.contacts, 1);
    await assertOtherProvidersAdopted(h);
    const row = await h.store.ledger(key("wavelog"));
    assert.equal(row?.state, "adopted_existing");
    assert.equal(row.remote_id, "42");
    assert.equal(row.provenance, "adopted");
    assert.equal(row.source_hash, row.baseline_hash);
    assert.equal(row.sent_hash, null);
    assert.equal(h.wavelogCalls.reads, 4);
    const budget = await h.store
      .statement(
        "SELECT requests FROM vendor_scoped_requests WHERE vendor='wavelog' AND scope=?",
        baseUrl,
      )
      .first<{ requests: number }>();
    assert.equal(budget?.requests, h.wavelogCalls.reads);
    assert.equal(
      await h.store
        .statement("SELECT 1 FROM vendor_requests WHERE vendor='wavelog'")
        .first(),
      null,
    );
    assert.equal(
      (
        await h.store
          .statement("SELECT COUNT(*) n FROM attempts")
          .first<{ n: number }>()
      )?.n,
      0,
    );
  } finally {
    await h.mf.dispose();
  }
});

for (const blocked of ["frequency", "station policy"] as const)
  test(`Wavelog ${blocked} review does not block the other provider histories`, async () => {
    const h = await fixture();
    try {
      if (blocked === "frequency") delete h.qso.freq;
      else h.stations[0].clublog_upload = "live";
      const result = await tick(h.env, h.fetcher, FIXTURE_NOW);
      assert.equal(result.errors, 1);
      await assertOtherProvidersAdopted(h);
      const row = await h.store.ledger(key("wavelog"));
      assert.ok(row);
      assert.equal(row.remote_id, null);
      assert.equal(row.baseline_hash, null);
      assert.equal(
        row.reason,
        blocked === "frequency"
          ? "wavelog_projection_or_route_unsupported"
          : "wavelog_station_outbound_policy_conflict",
      );
      assert.equal(h.wavelogCalls.reads, blocked === "frequency" ? 0 : 2);
    } finally {
      await h.mf.dispose();
    }
  });

test("scheduler's default-deny Wavelog allowlist prevents network access without blocking other providers", async () => {
  const h = await fixture();
  try {
    h.env.WAVELOG_ALLOWED_BASE_URLS = "[]";
    const result = await tick(h.env, h.fetcher, FIXTURE_NOW);
    assert.equal(result.errors, 1);
    await assertOtherProvidersAdopted(h);
    assert.equal(h.wavelogCalls.reads, 0);
    const row = await h.store.ledger(key("wavelog"));
    assert.equal(row?.remote_id, null);
    assert.equal(row?.reason, "wavelog_projection_or_route_unsupported");
    assert.equal(
      await h.store
        .statement(
          "SELECT 1 FROM vendor_scoped_requests WHERE vendor='wavelog'",
        )
        .first(),
      null,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("an exhausted Wavelog instance budget defers only that destination", async () => {
  const h = await fixture();
  try {
    await h.store
      .statement(
        "INSERT INTO vendor_scoped_requests(vendor,scope,window_start,requests,background_requests,cooldown_until) VALUES('wavelog',?,?,120,60,?)",
        baseUrl,
        FIXTURE_NOW,
        FIXTURE_NOW + 300_000,
      )
      .run();
    const result = await tick(h.env, h.fetcher, FIXTURE_NOW);
    assert.equal(result.errors, 0);
    assert.equal(result.deferred, 1);
    await assertOtherProvidersAdopted(h);
    assert.equal(h.wavelogCalls.reads, 0);
    assert.equal((await h.store.ledger(key("wavelog")))?.remote_id, null);
  } finally {
    await h.mf.dispose();
  }
});

test("admin workload counts missing Wavelog history as ready after quiet time and unsupported projection as held", async () => {
  const h = await fixture();
  try {
    h.enable();
    h.records.splice(0);
    const result = await tick(h.env, h.fetcher, FIXTURE_NOW);
    assert.equal(result.errors, 0);
    await assertOtherProvidersAdopted(h);
    const row = await h.store.ledger(key("wavelog"));
    assert.equal(row?.state, "missing_current_identity");
    assert.equal(row.reason, "wavelog_qso_missing");
    assert.equal(row.remote_id, null);
    const quiet = await getAdminWorkload(h.env, FIXTURE_NOW);
    assert.equal(
      quiet.source.reduce((n, item) => n + item.ready, 0),
      0,
    );
    assert.equal(
      quiet.heldReasons.find((item) => item.reason === "quiet")?.count,
      1,
    );

    const afterQuiet = FIXTURE_NOW + 31 * 60_000;
    const ready = await getAdminWorkload(h.env, afterQuiet);
    assert.equal(
      ready.source.reduce((n, item) => n + item.ready, 0),
      1,
    );
    assert.equal(
      ready.source.reduce((n, item) => n + item.held, 0),
      0,
    );

    // A subsequent projection hold is not a normal absence result, even with
    // the same eligible ledger state and all other destinations resolved.
    await h.store
      .statement(
        "UPDATE ledger SET reason='wavelog_projection_or_route_unsupported' WHERE tenant='a' AND source='source' AND qso='q1' AND destination='wavelog'",
      )
      .run();
    const held = await getAdminWorkload(h.env, afterQuiet);
    assert.equal(
      held.source.reduce((n, item) => n + item.ready, 0),
      0,
    );
    assert.equal(
      held.source.reduce((n, item) => n + item.held, 0),
      1,
    );
    assert.equal(
      held.heldReasons.find((item) => item.reason === "delivery_review")?.count,
      1,
    );
  } finally {
    await h.mf.dispose();
  }
});
