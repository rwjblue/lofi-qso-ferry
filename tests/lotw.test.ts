import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type AdifRecord, serializeAdifRecord } from "../src/adif.ts";
import {
  boundedResponse,
  LotwClient,
  LotwLoginError,
  observeLotwContact,
  parseLotwReport,
  parseUploadResponse,
} from "../src/lotw.ts";
import type { LotwContact, LotwStation } from "../src/signing.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";

const vector: { station: LotwStation; contact: LotwContact } = JSON.parse(
  readFileSync(
    new URL("../fixtures/signing/vector.json", import.meta.url),
    "utf8",
  ),
);
const record = {
  CALL: "K1ABC",
  STATION_CALLSIGN: "W1AW",
  BAND: "20m",
  MODE: "FT8",
  QSO_DATE: "20261022",
  TIME_ON: "123456",
  QSL_RCVD: "N",
  MY_DXCC: "291",
  MY_GRIDSQUARE: "FN31pr",
  MY_STATE: "CT",
  MY_CNTY: "CT,Tolland",
  MY_CQ_ZONE: "5",
  MY_ITU_ZONE: "8",
  FREQ: "14.07400",
};
const report = (records: AdifRecord[] = [record]) =>
  `<PROGRAMID:4>LoTW<APP_LoTW_LASTQSORX:19>2026-10-22 13:00:00<APP_LoTW_NUMREC:${String(records.length).length}>${records.length}<EOH>${records.map(serializeAdifRecord).join("\n")}<APP_LoTW_EOF>`;

test("LoTW preserves typed transport deferrals for query, certificate status and upload", async () => {
  const deferred = new VendorDeferredError(Date.now() + 300000);
  const client = new LotwClient(
    { username: "synthetic", password: "synthetic" },
    {
      exportsEnabled: true,
      fetcher: async () => {
        throw deferred;
      },
    },
  );
  await assert.rejects(
    client.query({ startDate: "2026-10-22", endDate: "2026-10-22" }),
    (error) => error === deferred,
  );
  await assert.rejects(client.verifyLogin(), (error) => error === deferred);
  await assert.rejects(
    client.certificateStatus("123"),
    (error) => error === deferred,
  );
  await assert.rejects(
    client.submit(new Uint8Array([0x1f, 0x8b]), { liveWriteAuthorized: true }),
    (error) => error === deferred,
  );
});

test("LoTW login verification uses a bounded read without a certificate or upload", async () => {
  let requests = 0;
  const client = new LotwClient(
    { username: "synthetic-account", password: " synthetic-secret " },
    {
      fetcher: async (input, init) => {
        requests++;
        const url = new URL(String(input));
        assert.equal(url.pathname, "/lotwuser/lotwreport.adi");
        assert.equal(init?.method ?? "GET", "GET");
        assert.equal(init?.redirect, "manual");
        assert.equal(url.searchParams.get("login"), "synthetic-account");
        assert.equal(url.searchParams.get("password"), " synthetic-secret ");
        const today = new Date().toISOString().slice(0, 10);
        for (const field of ["qso_startdate", "qso_enddate", "qso_qsorxsince"])
          assert.equal(url.searchParams.get(field), today);
        return new Response(report([]));
      },
    },
  );
  await client.verifyLogin();
  assert.equal(requests, 1);
});

test("LoTW login verification distinguishes explicit rejection from unavailable readback", async (t) => {
  for (const [name, status, body, reason] of [
    ["unauthorized", 401, "sensitive vendor details", "credentials"],
    ["denied access", 403, "sensitive vendor details", "credentials"],
    ["HTML login failure", 200, "<html>Login failed</html>", "credentials"],
    [
      "ARRL HTML incorrect credentials",
      200,
      "<html><b>Username/password</b> incorrect</html>",
      "credentials",
    ],
    [
      "HTML invalid password",
      200,
      "<html>Invalid password</html>",
      "credentials",
    ],
    ["maintenance", 503, "sensitive vendor details", "unavailable"],
    ["unexpected HTML", 200, "<html>Try again later</html>", "unavailable"],
    ["redirect", 302, "sensitive vendor details", "unavailable"],
    [
      "truncated report",
      200,
      report([]).replace("<APP_LoTW_EOF>", ""),
      "unavailable",
    ],
    ["transport", 0, "", "unavailable"],
  ] as const) {
    await t.test(name, async () => {
      const client = new LotwClient(
        { username: "synthetic-account", password: "synthetic-secret" },
        {
          fetcher: async (input) => {
            if (!status)
              throw new Error(`sensitive transport details: ${input}`);
            return new Response(body, { status });
          },
        },
      );
      await assert.rejects(client.verifyLogin(), (error: unknown) => {
        assert(error instanceof LotwLoginError);
        assert.equal(error.reason, reason);
        assert(!/synthetic|sensitive|lotwreport/.test(error.message));
        return true;
      });
    });
  }
});

test("LoTW report inventories accepted unconfirmed QSOs with own location and server receive cursor", () => {
  const parsed = parseLotwReport(report());
  assert.equal(parsed.records[0]!.QSL_RCVD, "N");
  assert.equal(parsed.receivedThrough, "2026-10-22 13:00:00");
  assert.equal(parsed.complete, true);
  assert.equal(parseLotwReport(report([])).records.length, 0);
  assert.equal(
    observeLotwContact(vector.station, vector.contact, parsed).state,
    "observed",
  );
  assert.equal(
    observeLotwContact(vector.station, vector.contact, parsed).confirmed,
    false,
  );
  assert.equal(
    observeLotwContact(
      vector.station,
      vector.contact,
      parseLotwReport(report([{ ...record, QSL_RCVD: "Y" }])),
    ).confirmed,
    true,
  );
});
test("HTML, missing EOF, partial records, missing own callsign and inconsistent counts never establish absence", () => {
  for (const input of [
    "<html>Login failed</html>",
    report().replace("<APP_LoTW_EOF>", ""),
    report().replace("<EOR>", ""),
    report().replace("<APP_LoTW_NUMREC:1>1", "<APP_LoTW_NUMREC:1>2"),
    report().replace("<STATION_CALLSIGN:4>W1AW", ""),
  ])
    assert.throws(() => parseLotwReport(input));
});
test("LoTW observations require precise identity and supported location/frequency revision", () => {
  const parsed = parseLotwReport(report());
  assert.equal(
    observeLotwContact(
      { ...vector.station, grid: "FN32" },
      vector.contact,
      parsed,
    ).state,
    "projection_mismatch",
  );
  assert.equal(
    observeLotwContact(
      vector.station,
      { ...vector.contact, frequencyMHz: "14.075" },
      parsed,
    ).state,
    "projection_mismatch",
  );
  assert.equal(
    observeLotwContact(
      vector.station,
      { ...vector.contact, call: "K2ABC" },
      parsed,
    ).state,
    "absent",
  );
  assert.equal(
    observeLotwContact(
      vector.station,
      vector.contact,
      parseLotwReport(report([{ ...record, TIME_ON: "1234" }])),
    ).state,
    "ambiguous",
  );
  assert.equal(
    observeLotwContact(
      vector.station,
      vector.contact,
      parseLotwReport(report([record, record])),
    ).state,
    "ambiguous",
  );
  assert.equal(
    observeLotwContact(
      vector.station,
      { ...vector.contact, mode: "MFSK", submode: "FT4" },
      parseLotwReport(report([{ ...record, MODE: "MFSK", SUBMODE: "FT4" }])),
    ).state,
    "observed",
  );
});
test("query requests all accepted records, own detail and explicit replay boundary without logging credentials", async () => {
  let calls = 0;
  const client = new LotwClient(
    { username: "synthetic", password: "never-log-me" },
    {
      fetcher: async (input, init) => {
        calls++;
        const url = new URL(String(input));
        assert.equal(url.origin, "https://lotw.arrl.org");
        assert.equal(url.searchParams.get("qso_qsl"), "no");
        assert.equal(url.searchParams.get("qso_qsorxsince"), "1900-01-01");
        assert.equal(url.searchParams.get("qso_mydetail"), "yes");
        assert.equal(url.searchParams.get("qso_withown"), "yes");
        assert.equal(init?.redirect, "manual");
        return new Response(report());
      },
    },
  );
  assert.equal(
    (await client.query({ startDate: "2026-10-01", endDate: "2026-10-31" }))
      .records.length,
    1,
  );
  await assert.rejects(
    client.query({ startDate: "2026-01-01", endDate: "2026-12-31" }),
    /partition/,
  );
  assert.equal(calls, 1);
  const failed = new LotwClient(
    { username: "synthetic", password: "never-log-me" },
    {
      fetcher: async (input) => {
        throw new Error(String(input));
      },
    },
  );
  await assert.rejects(
    failed.query({ startDate: "2026-10-01", endDate: "2026-10-31" }),
    (error: Error) => !error.message.includes("never-log-me"),
  );
});

test("every LoTW query record must satisfy every requested scope filter", async (t) => {
  const query = {
    startDate: "2026-10-22",
    endDate: "2026-10-22",
    stationCallsign: "w1aw",
    workedCallsign: "k1abc",
  };
  for (const [name, change] of [
    ["before the start date", { QSO_DATE: "20261021" }],
    ["after the end date", { QSO_DATE: "20261023" }],
    ["different station", { STATION_CALLSIGN: "W2AW" }],
    ["different worked call", { CALL: "K2ABC" }],
  ] as const) {
    await t.test(name, async () => {
      const mismatched = { ...record, ...change };
      // Both an apparently empty neighborhood and a valid first row must fail.
      for (const records of [[mismatched], [record, mismatched]]) {
        const client = new LotwClient(
          { username: "synthetic", password: "never-log-me" },
          { fetcher: async () => new Response(report(records)) },
        );
        await assert.rejects(client.query(query), {
          message: "LoTW report does not match the requested scope",
        });
      }
    });
  }
});

test("LoTW scope validation preserves inclusive ranges, optional filters and original case/precision", async () => {
  const records = [
    { ...record, QSO_DATE: "20261001", TIME_ON: "0000" },
    {
      ...record,
      CALL: "k2abc/p",
      STATION_CALLSIGN: "w2aw",
      QSO_DATE: "20261031",
      TIME_ON: "235959",
      BAND: "8m",
      MODE: "HELL",
    },
  ];
  const client = new LotwClient(
    { username: "synthetic", password: "synthetic" },
    { fetcher: async () => new Response(report(records)) },
  );
  assert.deepEqual(
    (
      await client.query({ startDate: "2026-10-01", endDate: "2026-10-31" })
    ).records.map((value) => ({ ...value })),
    records,
  );
  for (const filters of [
    { stationCallsign: "w1aw" },
    { workedCallsign: "k1abc" },
    { stationCallsign: "w1aw", workedCallsign: "k1abc" },
  ]) {
    const scoped = new LotwClient(
      { username: "synthetic", password: "synthetic" },
      {
        fetcher: async () =>
          new Response(report([{ ...record, TIME_ON: "1234" }])),
      },
    );
    const result = await scoped.query({
      startDate: "2026-10-22",
      endDate: "2026-10-22",
      ...filters,
    });
    assert.equal(result.records[0].TIME_ON, "1234");
    assert.equal(
      observeLotwContact(vector.station, vector.contact, result).state,
      "ambiguous",
    );
  }
  const empty = new LotwClient(
    { username: "synthetic", password: "synthetic" },
    { fetcher: async () => new Response(report([])) },
  );
  assert.deepEqual(
    (await empty.query({ startDate: "2026-10-22", endDate: "2026-10-22" }))
      .records,
    [],
  );
});

test("LoTW validates the sent scope even if the caller changes its query during transport", async () => {
  const query = {
    startDate: "2026-10-22",
    endDate: "2026-10-22",
    stationCallsign: "W1AW",
    workedCallsign: "K1ABC",
  };
  const client = new LotwClient(
    { username: "synthetic", password: "synthetic" },
    {
      fetcher: async () => {
        Object.assign(query, {
          startDate: "2026-10-23",
          endDate: "2026-10-23",
          stationCallsign: "W2AW",
          workedCallsign: "K2ABC",
        });
        return new Response(
          report([
            {
              ...record,
              QSO_DATE: "20261023",
              STATION_CALLSIGN: "W2AW",
              CALL: "K2ABC",
            },
          ]),
        );
      },
    },
  );
  await assert.rejects(client.query(query), {
    message: "LoTW report does not match the requested scope",
  });
});

test("malformed LoTW identities cannot hide outside the matched neighborhood", async (t) => {
  for (const [field, value] of [
    ["CALL", "   "],
    ["CALL", "K1 ABC"],
    ["CALL", "K1ABC/"],
    ["CALL", "K1ABC\n"],
    ["STATION_CALLSIGN", "W1ÅW"],
    ["BAND", "20 m"],
    ["BAND", "0m"],
    ["BAND", "bogus"],
    ["BAND", "20m\n"],
    ["MODE", "   "],
    ["MODE", "FT8\u0000"],
    ["APP_LOTW_MODE", "FT 8"],
    ["SUBMODE", "FT4\n"],
    ["QSO_DATE", "20260229"],
    ["QSO_DATE", "20260431"],
    ["QSO_DATE", "20261301"],
    ["QSO_DATE", "20261022\n"],
    ["TIME_ON", "2400"],
    ["TIME_ON", "1260"],
    ["TIME_ON", "123460"],
    ["TIME_ON", "123"],
    ["TIME_ON", "123456\n"],
  ] as const) {
    await t.test(`${field} ${JSON.stringify(value)}`, async () => {
      // Build the remote payload directly: the outbound serializer correctly
      // refuses these characters and must not intercept this parser regression.
      const malformed = { ...record, CALL: "K2ABC", [field]: value };
      const body = report([record])
        .replace("<APP_LoTW_NUMREC:1>1", "<APP_LoTW_NUMREC:1>2")
        .replace(
          "<APP_LoTW_EOF>",
          `${Object.entries(malformed)
            .map(([name, input]) => `<${name}:${input.length}>${input}`)
            .join("")}<EOR><APP_LoTW_EOF>`,
        );
      const client = new LotwClient(
        { username: "synthetic", password: "never-log-me" },
        {
          fetcher: async () => new Response(body),
        },
      );
      await assert.rejects(
        client.query({ startDate: "2026-10-01", endDate: "2026-10-31" }),
        { message: "LoTW report has invalid identity/confirmation fields" },
      );
    });
  }
});

test("LoTW report parsing preserves valid leap dates and APP_LOTW_MODE fallback", () => {
  const alternate = {
    ...record,
    QSO_DATE: "20240229",
    TIME_ON: "2359",
    MODE: "",
    APP_LOTW_MODE: "ft8",
  };
  assert.deepEqual(
    parseLotwReport(report([alternate])).records.map((value) => ({ ...value })),
    [alternate],
  );
});

test("invalid LoTW callsign filters fail before transport", async () => {
  let requests = 0;
  const client = new LotwClient(
    { username: "synthetic", password: "synthetic" },
    {
      fetcher: async () => {
        requests++;
        return new Response(report([]));
      },
    },
  );
  for (const filters of [
    { stationCallsign: " " },
    { workedCallsign: "K1ABC*" },
  ])
    await assert.rejects(
      client.query({
        startDate: "2026-10-22",
        endDate: "2026-10-22",
        ...filters,
      }),
      { message: "Invalid LoTW query callsign" },
    );
  assert.equal(requests, 0);
});

test("upload acknowledges submission separately; timeouts and unknown responses remain uncertain", async () => {
  assert.deepEqual(parseUploadResponse("<!-- .UPL. accepted -->"), {
    state: "submitted",
    code: "queue_acknowledged",
  });
  assert.equal(
    parseUploadResponse("<!-- .UPL. rejected -->").state,
    "rejected",
  );
  assert.equal(
    parseUploadResponse("<!-- .UPL. accepted --><!-- .UPL. rejected -->").state,
    "uncertain",
  );
  assert.equal(parseUploadResponse("HTTP 200 OK").state, "uncertain");
  let calls = 0;
  const artifact = new Uint8Array([0x1f, 0x8b, 0x08]);
  const client = new LotwClient(null, {
    exportsEnabled: true,
    fetcher: async (input, init) => {
      calls++;
      assert.equal(input, "https://lotw.arrl.org/lotw/upload");
      assert.equal(init?.method, "POST");
      assert.ok(init.body instanceof FormData);
      const upload = init.body.get("upfile");
      assert.ok(upload instanceof File);
      assert.equal(upload.name, "lofi-qso-ferry.tq8");
      assert.deepEqual(new Uint8Array(await upload.arrayBuffer()), artifact);
      return new Response("<!-- .UPL. accepted -->");
    },
  });
  await assert.rejects(
    client.submit(artifact, { liveWriteAuthorized: false }),
    /disabled/,
  );
  assert.equal(calls, 0);
  assert.equal(
    (await client.submit(artifact, { liveWriteAuthorized: true })).state,
    "submitted",
  );
  const timeout = new LotwClient(null, {
    exportsEnabled: true,
    fetcher: async () => {
      throw new Error("timeout");
    },
  });
  assert.equal(
    (await timeout.submit(artifact, { liveWriteAuthorized: true })).state,
    "uncertain",
  );
  await assert.rejects(
    new LotwClient(null).submit(artifact, { liveWriteAuthorized: true }),
    /disabled/,
  );
});
test("certificate status errors/unknown XML are never represented as valid", async () => {
  for (const [body, status] of [
    ["<Status>Unrevoked</Status>", "unrevoked"],
    ["<Status>Superceded</Status>", "superseded"],
    ["<Status>Revoked</Status>", "revoked"],
    ["<html>error</html>", "unknown"],
    ["<Status>Unrevoked</Status><Status>Revoked</Status>", "unknown"],
  ] as const) {
    const client = new LotwClient(null, {
      fetcher: async () => new Response(body),
    });
    assert.equal(await client.certificateStatus("123"), status);
  }
});
test("large streamed reports fail with incomplete evidence rather than materializing unbounded data", async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(100));
        controller.close();
      },
    }),
  );
  await assert.rejects(boundedResponse(response, 20), /bounded partition/);
});

test("readback precision cannot falsely acknowledge a one-Hz frequency correction", () => {
  const parsed = parseLotwReport(report([{ ...record, FREQ: "14.07412" }]));
  const observation = observeLotwContact(
    vector.station,
    { ...vector.contact, frequencyMHz: "14.074123" },
    parsed,
  );
  assert.equal(observation.state, "insufficient_evidence");
  assert.deepEqual(observation.unverifiableFields, ["FREQ"]);
});
