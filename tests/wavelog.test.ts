import assert from "node:assert/strict";
import test from "node:test";
import {
  type AdifRecord,
  parseAdif,
  serializeAdifRecord,
} from "../src/adif.ts";
import type { Contact } from "../src/projection.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";
import {
  WAVELOG_PASSIVE_FLAGS,
  WavelogClient,
  WavelogError,
  type WavelogStation,
  matchWavelogHistory,
  wavelogComparable,
  wavelogIdentity,
  wavelogPatch,
  wavelogRecord,
  wavelogRemoteIdentity,
  wavelogStation,
  wavelogStationMatches,
} from "../src/wavelog.ts";
import {
  assertWavelogBaseUrlAllowed,
  normalizeWavelogBaseUrl,
  parseWavelogAllowedBaseUrls,
} from "../src/wavelog-url.ts";

const credentials = {
  baseUrl: "https://logs.example.com/ham/",
  token: `wl2_${"a".repeat(40)}`,
};
const contact: Contact = {
  id: "q1",
  operationId: "op1",
  call: "W1AW",
  stationCall: "N0TEST/P",
  startAtMillis: Date.parse("2026-10-22T12:00:01Z"),
  timePrecision: "second",
  band: "20m",
  mode: "CW",
  frequencyMHz: 14.025,
  operatorCall: "N0TEST",
  rstSent: "599",
  rstReceived: "579",
  ownParks: ["US-0001"],
  workedParks: ["US-0002"],
  grid: "FN31",
  dxcc: 291,
  cqZone: 5,
  ituZone: 8,
  state: "CT",
  county: "Fairfield",
  power: 10,
  notes: "private",
  deleted: false,
  context: { qso: {}, op: {} },
  generation: "g1",
};
const record = wavelogRecord(contact);
const spec = wavelogStation(contact);
const station: WavelogStation = {
  id: 7,
  uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  ...spec,
  sota: "",
  wwff: "",
  sig: "",
  sig_info: "",
  active: false,
  power: null,
};
const jsonRow = (id = 42, overrides: Record<string, unknown> = {}) => ({
  id,
  station_id: 7,
  call: "W1AW",
  band: "20m",
  mode: "CW",
  submode: null,
  qso_date: "2026-10-22 12:00:01",
  freq: "14025000",
  rst_sent: "599",
  rst_rcvd: "579",
  pota_ref: "US-0002",
  ...overrides,
});
const document = (records: AdifRecord[]) =>
  `<ADIF_VER:5>3.1.6<PROGRAMID:7>Wavelog<EOH>\n${records.map(serializeAdifRecord).join("\n")}\n`;
const response = (data: unknown, status = 200) =>
  Response.json({ data }, { status });
const page = (data: unknown[], meta: Record<string, unknown> = {}) =>
  Response.json({
    data,
    meta: {
      page: 1,
      per_page: 100,
      count: data.length,
      total: data.length,
      total_pages: data.length ? 1 : 0,
      has_more: false,
      ...meta,
    },
  });
const adifPage = (records: AdifRecord[], meta: Record<string, unknown> = {}) =>
  Response.json({
    data: {
      exported: records.length,
      lastfetchedid: records.length ? 42 : 0,
      adif: records.length ? document(records) : null,
    },
    meta: {
      page: 1,
      per_page: 100,
      count: records.length,
      total: records.length,
      total_pages: records.length ? 1 : 0,
      has_more: false,
      ...meta,
    },
  });
const outcome =
  (kind: WavelogError["kind"], code?: string) => (error: unknown) =>
    error instanceof WavelogError &&
    error.kind === kind &&
    (!code || error.code === code);
const remote = (recordValue = record, id = 42) => ({
  id,
  stationId: 7,
  record: { ...recordValue, APP_WAVELOG_ID: String(id) },
});
function clientWith(
  replies: Response[],
  options: {
    writesEnabled?: boolean;
    beforeWrite?: () => Promise<boolean>;
  } = {},
) {
  const requests: { url: URL; init: RequestInit | undefined }[] = [];
  const client = new WavelogClient(credentials, {
    ...options,
    fetcher: async (input, init) => {
      requests.push({ url: new URL(String(input)), init });
      const next = replies.shift();
      assert.ok(next, "Unexpected extra request");
      return next;
    },
  });
  return { client, requests };
}

test("Wavelog installation URLs preserve a subdirectory and require exact operator admission", () => {
  assert.equal(
    normalizeWavelogBaseUrl("https://LOGS.example.com/ham/index.php"),
    credentials.baseUrl,
  );
  assert.equal(
    normalizeWavelogBaseUrl("https://logs.example.com/ham/index.php/api/v2/"),
    credentials.baseUrl,
  );
  assert.deepEqual(
    parseWavelogAllowedBaseUrls(
      ` ["${credentials.baseUrl}","${credentials.baseUrl}index.php"] `,
    ),
    [credentials.baseUrl],
  );
  assert.equal(
    assertWavelogBaseUrlAllowed(credentials.baseUrl, [credentials.baseUrl]),
    credentials.baseUrl,
  );
  assert.throws(() =>
    assertWavelogBaseUrlAllowed("https://logs.example.com/other/", [
      credentials.baseUrl,
    ]),
  );
  for (const url of [
    "http://logs.example.com/",
    "https://user:password@logs.example.com/",
    "https://logs.example.com/?secret=x",
    "https://logs.example.com/#x",
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://[::1]/",
    "https://private.local/",
    "https://localhost/",
    "https://logs.example.com:8443/",
    "https://logs.example.com/a/../b/",
    "https://logs.example.com/%2e%2e/",
    "https://logs.example.com\\private/",
    "https://logs.example.com//other/",
  ])
    assert.throws(() => normalizeWavelogBaseUrl(url), url);
});

test("Wavelog projection preserves exact fields and rejects inferred station data", () => {
  assert.equal(record.MY_POTA_REF, "US-0001");
  assert.equal(record.POTA_REF, "US-0002");
  assert.equal(record.MY_CNTY, "CT,Fairfield");
  assert.equal(record.OPERATOR, "N0TEST");
  assert.equal(record.TX_PWR, "10");
  assert.equal(record.NOTES, undefined);
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(WAVELOG_PASSIVE_FLAGS).map((field) => [field, record[field]]),
    ),
    WAVELOG_PASSIVE_FLAGS,
  );
  for (const change of [
    { grid: undefined },
    { dxcc: undefined },
    { cqZone: undefined },
    { ituZone: undefined },
    { frequencyMHz: undefined },
    { startAtMillis: contact.startAtMillis + 1 },
    { deleted: true },
  ])
    assert.throws(
      () => wavelogRecord({ ...contact, ...change }),
      outcome("blocked"),
    );
  assert.equal(
    wavelogRecord(
      { ...contact, dxcc: undefined, cqZone: undefined, ituZone: undefined },
      { dxcc: 291, cq: 5, itu: 8 },
    ).MY_DXCC,
    "291",
  );
  assert.equal(
    wavelogRecord({ ...contact, mode: "SSB", submode: "USB" }).SUBMODE,
    "USB",
  );
  assert.equal(
    wavelogRecord({ ...contact, mode: "MFSK", submode: "FT4" }).SUBMODE,
    "FT4",
  );
  assert.throws(
    () => wavelogPatch(record, { ...record, RST_SENT: "579" }),
    outcome("blocked", "correction_requires_manual_review"),
  );
});

test("Wavelog station reuse requires exact own location and passive configuration", () => {
  assert.ok(
    wavelogStationMatches(
      { ...station, name: "My existing park", active: true },
      spec,
    ),
  );
  for (const change of [
    { gridsquare: "FN31AA" },
    { pota: "US-0003" },
    { clublog_upload: "on" as const },
    { eqsl_qth_nickname: "Home" },
    { sota: "W1/AA-001" },
    { cq: 4 },
  ])
    assert.equal(wavelogStationMatches({ ...station, ...change }, spec), false);
  assert.deepEqual(
    wavelogStation({ ...contact, notes: "changed", power: 20 }),
    spec,
  );
});

test("Wavelog inventory tolerates unknown legacy station zones without using them for routing", async () => {
  const { client } = clientWith([
    response([
      { ...station, dxcc: null, cq: 0, itu: null },
      { ...station, id: 8, uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" },
    ]),
  ]);
  const stations = await client.listStations();
  assert.deepEqual(
    [stations[0].dxcc, stations[0].cq, stations[0].itu],
    [0, 0, 0],
  );
  assert.equal(wavelogStationMatches(stations[0], spec), false);
  assert.equal(wavelogStationMatches(stations[1], spec), true);
  await assert.rejects(
    clientWith([response([{ ...station, dxcc: "291" }])]).client.listStations(),
    outcome("protocol"),
  );
});

test("Wavelog natural identity is independent of remote ID and source metadata", async () => {
  assert.equal(
    await wavelogRemoteIdentity(record),
    await wavelogRemoteIdentity({
      ...record,
      APP_WAVELOG_ID: "50",
      BAND: "20M",
      FREQ: "14.025000",
      OPERATOR: "n0test",
    }),
  );
  assert.notEqual(
    wavelogIdentity(record),
    wavelogIdentity({ ...record, TIME_ON: "120002" }),
  );
  assert.notEqual(
    wavelogIdentity(record),
    wavelogIdentity({ ...record, MY_POTA_REF: "US-0003" }),
  );
  assert.deepEqual(
    wavelogComparable(record),
    wavelogComparable({
      ...record,
      ...Object.fromEntries(
        Object.keys(WAVELOG_PASSIVE_FLAGS).map((field) => [field, "Y"]),
      ),
      NOTES: "external note",
    }),
  );
});

test("Wavelog history requires exact seconds and distinguishes minute collision, duplicate, and foreign edits", () => {
  assert.equal(
    matchWavelogHistory(record, [remote()]).state,
    "adopted_existing",
  );
  assert.equal(
    matchWavelogHistory(record, [remote({ ...record, TIME_ON: "120002" })])
      .state,
    "history_mismatch",
  );
  assert.equal(
    matchWavelogHistory(record, [remote(), remote(record, 43)]).state,
    "history_ambiguous",
  );
  assert.equal(
    matchWavelogHistory(record, [remote({ ...record, RST_SENT: "559" })]).state,
    "history_mismatch",
  );
  assert.equal(
    matchWavelogHistory(record, [remote({ ...record, TIME_ON: "140001" })])
      .state,
    "missing_current_identity",
  );
  assert.equal(
    matchWavelogHistory(record, [remote({ ...record, LOTW_QSL_SENT: "Y" })])
      .state,
    "adopted_existing",
  );
  assert.equal(
    matchWavelogHistory(record, [remote({ ...record, LOTW_QSL_SENT: "Y" })], {
      requirePassive: true,
    }).state,
    "history_mismatch",
  );
});

test("Wavelog validates token scopes and uses header authentication without credentials in URL", async () => {
  const { client, requests } = clientWith([
    response({
      id: 1,
      user_id: 2,
      owner: "N0TEST",
      scopes: ["station:read", "qso:read", "qso:write"],
      expires_at: null,
    }),
  ]);
  assert.equal((await client.verifyLogin()).user_id, 2);
  assert.equal(
    requests[0].url.href,
    `${credentials.baseUrl}index.php/api/v2/token`,
  );
  assert.equal(
    new Headers(requests[0].init?.headers).get("Authorization"),
    `Bearer ${credentials.token}`,
  );
  assert.equal(requests[0].init?.redirect, "manual");
  const missing = clientWith([
    response({
      id: 1,
      user_id: 2,
      owner: "N0TEST",
      scopes: ["qso:read"],
      expires_at: null,
    }),
  ]);
  await assert.rejects(
    missing.client.verifyLogin(),
    outcome("auth", "required_scopes_missing"),
  );
});

test("Wavelog constructor turns removed or invalid installation admission into a held reason", () => {
  for (const baseUrl of [
    credentials.baseUrl,
    "https://secret:private@logs.example.com/",
    "http://logs.example.com/",
  ]) {
    assert.throws(
      () =>
        new WavelogClient({ ...credentials, baseUrl }, { allowedBaseUrls: [] }),
      (error: unknown) =>
        error instanceof WavelogError &&
        error.kind === "blocked" &&
        error.code === "installation_not_allowed" &&
        !error.requestSent &&
        !error.message.includes("private"),
    );
  }
});

test("Wavelog station creation is guarded and verified by fresh readback", async () => {
  let guards = 0;
  const { client, requests } = clientWith(
    [response(station, 201), response(station)],
    {
      writesEnabled: true,
      beforeWrite: async () => {
        guards++;
        return true;
      },
    },
  );
  assert.deepEqual(await client.createStation(spec), station);
  assert.equal(guards, 1);
  const body = JSON.parse(String(requests[0].init?.body));
  assert.equal(body.clublog_upload, "disabled");
  assert.equal(body.eqsl_qth_nickname, "");
  assert.equal(body.station_uuid, undefined);
  assert.equal(body.set_active, undefined);
  assert.equal(requests[1].url.pathname, "/ham/index.php/api/v2/station/7");
});

test("Wavelog disabled writes and declined authorization perform no network I/O", async () => {
  for (const options of [
    {},
    { writesEnabled: true, beforeWrite: async () => false },
  ]) {
    const { client, requests } = clientWith([], options);
    await assert.rejects(client.createStation(spec), outcome("blocked"));
    assert.equal(requests.length, 0);
  }
});

test("Wavelog lost station readback remains uncertain after a successful mutation", async () => {
  const { client } = clientWith(
    [
      response(station, 201),
      new Response("private vendor error", { status: 503 }),
    ],
    { writesEnabled: true, beforeWrite: async () => true },
  );
  await assert.rejects(
    client.createStation(spec),
    (error: unknown) =>
      error instanceof WavelogError &&
      error.kind === "uncertain" &&
      error.requestSent &&
      !error.message.includes("private"),
  );
});

test("Wavelog linking preserves current members and verifies the whole replacement without retry", async () => {
  const logbook = { id: 3, name: "All", active: true, station_ids: [2, 1] };
  const linked = { ...logbook, station_ids: [1, 2, 7] };
  const { client, requests } = clientWith(
    [response(logbook), response(linked), response(linked)],
    { writesEnabled: true, beforeWrite: async () => true },
  );
  assert.deepEqual(await client.linkStation(3, 7), linked);
  assert.deepEqual(JSON.parse(String(requests[1].init?.body)), {
    station_ids: [1, 2, 7],
  });
  assert.equal(
    requests.filter((request) => request.init?.method === "PATCH").length,
    1,
  );
});

test("Wavelog search correlates JSON IDs to full ADIF exactly and retains operator/power", async () => {
  const { client, requests } = clientWith([
    page([jsonRow()]),
    adifPage([record]),
  ]);
  assert.deepEqual(await client.findQsos(7, record), [remote()]);
  assert.equal(requests[0].url.searchParams.get("band"), null);
  assert.equal(requests[0].url.searchParams.get("qso_since"), "2026-10-22");
  assert.equal(requests[1].url.searchParams.get("format"), "adif");
});

test("Wavelog correlation refuses identical contacts with two numeric IDs", async () => {
  const { client } = clientWith([
    page([jsonRow(), jsonRow(43)]),
    adifPage([record, record]),
  ]);
  await assert.rejects(
    client.findQsos(7, record),
    outcome("protocol", "ambiguous_adif_id_correlation"),
  );
});

test("Wavelog completes both bounded pages despite different JSON and ADIF ordering", async () => {
  const rows = Array.from({ length: 101 }, (_, index) => {
    const date = new Date(contact.startAtMillis + index * 60000).toISOString();
    const data = { ...record, TIME_ON: date.slice(11, 19).replaceAll(":", "") };
    return {
      data,
      json: jsonRow(index + 1, {
        qso_date: date.slice(0, 19).replace("T", " "),
      }),
    };
  });
  const newest = [...rows].reverse();
  const { client, requests } = clientWith([
    page(
      newest.slice(0, 100).map((row) => row.json),
      { total: 101, total_pages: 2, has_more: true },
    ),
    page(
      newest.slice(100).map((row) => row.json),
      { page: 2, total: 101, total_pages: 2 },
    ),
    adifPage(
      rows.slice(0, 100).map((row) => row.data),
      { total: 101, total_pages: 2, has_more: true },
    ),
    adifPage(
      rows.slice(100).map((row) => row.data),
      { page: 2, total: 101, total_pages: 2 },
    ),
  ]);
  const result = await client.findQsos(7, record);
  assert.equal(result.length, 101);
  assert.equal(
    result.find((row) => row.id === 1)?.record.TIME_ON,
    record.TIME_ON,
  );
  assert.deepEqual(
    requests.map((request) => request.url.searchParams.get("page")),
    ["1", "2", "1", "2"],
  );
});

test("Wavelog correlation refuses cross-snapshot field changes and foreign station IDs", async () => {
  for (const row of [
    jsonRow(42, { freq: "14026000" }),
    jsonRow(42, { station_id: 8 }),
    jsonRow(42, { qso_date: "2026-10-23 12:00:01" }),
  ]) {
    const { client } = clientWith([page([row]), adifPage([record])]);
    await assert.rejects(client.findQsos(7, record), outcome("protocol"));
  }
});

test("Wavelog refuses truncated pages, dishonest counts, and inventories beyond the configured bound", async () => {
  for (const result of [
    page([jsonRow()], { total: 2, has_more: false }),
    page([jsonRow()], { total: 201, has_more: true }),
    page([jsonRow()], { total: 2, has_more: true }),
  ]) {
    const { client, requests } = clientWith([result]);
    await assert.rejects(client.findQsos(7, record), outcome("protocol"));
    assert.equal(requests.length, 1);
  }
  const malformedAdif = Response.json({
    data: {
      exported: 1,
      lastfetchedid: 42,
      adif: `${document([record])}truncated`,
    },
    meta: { page: 1, per_page: 100, count: 1, total: 1, has_more: false },
  });
  await assert.rejects(
    clientWith([page([jsonRow()]), malformedAdif]).client.findQsos(7, record),
    outcome("protocol"),
  );
});

test("Wavelog create sends one ADIF record with every passive flag and resolves only from readback", async () => {
  const { client, requests } = clientWith(
    [
      response({ parsed: 1, imported: 1, skipped: 0, messages: [] }, 201),
      page([jsonRow()]),
      adifPage([record]),
    ],
    { writesEnabled: true, beforeWrite: async () => true },
  );
  assert.deepEqual(await client.createQso(7, record), remote());
  const body = JSON.parse(String(requests[0].init?.body));
  assert.equal(body.station_profile_id, 7);
  assert.equal(body.import_type, "adif");
  const uploaded = parseAdif(body.adif).records;
  assert.equal(uploaded.length, 1);
  for (const [field, expected] of Object.entries(WAVELOG_PASSIVE_FLAGS))
    assert.equal(uploaded[0][field], expected);
  assert.equal(uploaded[0].TX_PWR, "10");
  assert.equal(uploaded[0].OPERATOR, "N0TEST");
});

test("Wavelog holds missing source power before mutation when a reused station would supply a default", async () => {
  const noPower = { ...record };
  delete noPower.TX_PWR;
  let writes = 0;
  const { client, requests } = clientWith(
    [response({ ...station, power: 100 })],
    {
      writesEnabled: true,
      beforeWrite: async () => {
        writes++;
        return true;
      },
    },
  );
  await assert.rejects(
    client.createQso(7, noPower),
    (error: unknown) =>
      outcome("blocked", "station_default_power_unowned")(error) &&
      error instanceof WavelogError &&
      !error.requestSent,
  );
  assert.equal(writes, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init?.method, "GET");
  assert.equal(requests[0].url.pathname, "/ham/index.php/api/v2/station/7");
});

test("Wavelog permits absent source power only with a neutral station default and verifies absent readback", async () => {
  const noPower = { ...record };
  delete noPower.TX_PWR;
  for (const power of [null, 0]) {
    let writes = 0;
    const { client, requests } = clientWith(
      [
        response({ ...station, power }),
        response({ imported: 1 }, 201),
        page([jsonRow()]),
        adifPage([noPower]),
      ],
      {
        writesEnabled: true,
        beforeWrite: async () => {
          writes++;
          return true;
        },
      },
    );
    assert.deepEqual(await client.createQso(7, noPower), remote(noPower));
    assert.equal(writes, 1);
    const body = JSON.parse(String(requests[1].init?.body));
    assert.equal(parseAdif(body.adif).records[0].TX_PWR, undefined);
  }
});

test("Wavelog successful upload counts without exact visible QSO do not confirm delivery", async () => {
  const { client, requests } = clientWith(
    [response({ parsed: 1, imported: 1 }, 201), page([]), adifPage([])],
    { writesEnabled: true, beforeWrite: async () => true },
  );
  await assert.rejects(
    client.createQso(7, record),
    outcome("uncertain", "qso_creation_unresolved"),
  );
  assert.equal(
    requests.filter((request) => request.init?.method === "POST").length,
    1,
  );
});

test("Wavelog readback must prove every passive flag and exact operator/power", async () => {
  for (const changed of [
    { ...record, LOTW_QSL_SENT: "N" },
    { ...record, CLUBLOG_QSO_UPLOAD_STATUS: "M" },
    { ...record, TX_PWR: "100" },
    { ...record, OPERATOR: "N1OTHER" },
  ]) {
    const { client } = clientWith(
      [response({ imported: 1 }, 201), page([jsonRow()]), adifPage([changed])],
      { writesEnabled: true, beforeWrite: async () => true },
    );
    await assert.rejects(client.createQso(7, record), outcome("uncertain"));
  }
});

test("Wavelog refuses redirects, HTML and malformed/truncated JSON without exposing bodies", async () => {
  const cases = [
    new Response("secret", {
      status: 302,
      headers: { Location: "https://elsewhere.example.com/" },
    }),
    new Response("<html>secret login</html>", {
      headers: { "Content-Type": "text/html" },
    }),
    new Response('{"data":', {
      headers: { "Content-Type": "application/json" },
    }),
    new Response('{"data":[]}', {
      headers: { "Content-Type": "application/json", "Content-Length": "500" },
    }),
    new Response("x", {
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "2097153",
      },
    }),
  ];
  for (const result of cases) {
    const { client, requests } = clientWith([result]);
    await assert.rejects(
      client.listStations(),
      (error: unknown) =>
        error instanceof WavelogError &&
        !error.message.includes("secret") &&
        error.kind === "protocol",
    );
    assert.equal(requests.length, 1);
  }
});

test("Wavelog authentication rejection suspends further client requests", async () => {
  const { client, requests } = clientWith([
    new Response("private vendor error", { status: 401 }),
  ]);
  await assert.rejects(
    client.listStations(),
    (error: unknown) =>
      error instanceof WavelogError && error.kind === "auth" && error.suspend,
  );
  await assert.rejects(
    client.listStations(),
    outcome("blocked", "connection_suspended"),
  );
  assert.equal(requests.length, 1);
});

test("Wavelog quota and definite rejects are distinguished from uncertain write failures", async () => {
  for (const [status, kind] of [
    [400, "rejected"],
    [409, "rejected"],
    [429, "rate"],
    [500, "uncertain"],
  ] as const) {
    const { client } = clientWith(
      [
        new Response("not exposed", {
          status,
          headers: { "Retry-After": "60" },
        }),
      ],
      { writesEnabled: true, beforeWrite: async () => true },
    );
    await assert.rejects(client.createStation(spec), outcome(kind));
  }
});

test("Wavelog preserves unsent budget deferrals but an after-upload read deferral remains uncertain", async () => {
  const before = new VendorDeferredError(Date.now() + 60000, false);
  const client = new WavelogClient(credentials, {
    fetcher: async () => {
      throw before;
    },
    writesEnabled: true,
    beforeWrite: async () => true,
  });
  await assert.rejects(
    client.createStation(spec),
    (error: unknown) => error === before,
  );
  let count = 0;
  const after = new WavelogClient(credentials, {
    writesEnabled: true,
    beforeWrite: async () => true,
    fetcher: async () => {
      if (count++ === 0) return response({ imported: 1 }, 201);
      throw before;
    },
  });
  await assert.rejects(
    after.createQso(7, record),
    (error: unknown) =>
      error instanceof WavelogError &&
      error.kind === "uncertain" &&
      error.requestSent &&
      error.retryAt === before.retryAt,
  );
});
