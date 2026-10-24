import assert from "node:assert/strict";
import { test } from "node:test";
import { type AdifRecord, serializeAdifRecord } from "../src/adif.ts";
import { LotwLoginError } from "../src/lotw.ts";
import {
  checkLotwFirstInsertHistory,
  type LotwFirstInsertHistoryInput,
} from "../src/lotw-first-insert.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";

function input(): LotwFirstInsertHistoryInput {
  return {
    credentials: {
      username: "synthetic-account",
      password: "synthetic-secret",
    },
    station: { callsign: "w1aw/p" },
    contact: { call: "k1abc", date: "2026-10-24", time: "00:00:01Z" },
  };
}

const record: AdifRecord = {
  CALL: "K1ABC",
  STATION_CALLSIGN: "W1AW/P",
  QSO_DATE: "20261024",
  TIME_ON: "000001",
  BAND: "20m",
  MODE: "FT8",
  QSL_RCVD: "N",
};
function report(records: AdifRecord[] = []): string {
  return `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:${String(records.length).length}>${records.length}<EOH>${records.map(serializeAdifRecord).join("\n")}<APP_LOTW_EOF>`;
}
function fetchReport(body: string): typeof fetch {
  return async () => new Response(body);
}

test("complete empty three-day history uses one exact read and no narrowing filters", async () => {
  let calls = 0;
  const result = await checkLotwFirstInsertHistory(input(), {
    fetcher: async (request, init) => {
      calls++;
      const url = new URL(String(request));
      assert.equal(url.origin, "https://lotw.arrl.org");
      assert.equal(url.pathname, "/lotwuser/lotwreport.adi");
      assert.equal(init?.method ?? "GET", "GET");
      assert.equal(init?.redirect, "manual");
      assert(init?.signal instanceof AbortSignal);
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        login: "synthetic-account",
        password: "synthetic-secret",
        qso_query: "1",
        qso_qsl: "no",
        // The real client uses its full-history default, not a recent filter.
        qso_qsorxsince: "1900-01-01",
        qso_mydetail: "yes",
        qso_withown: "yes",
        qso_startdate: "2026-10-23",
        qso_enddate: "2026-10-25",
        qso_owncall: "W1AW/P",
        qso_callsign: "K1ABC",
      });
      return new Response(report());
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    state: "empty",
    reason: "complete_empty_three_day_report",
    recordCount: 0,
    startDate: "2026-10-23",
    endDate: "2026-10-25",
  });
});

for (const [date, time, startDate, endDate] of [
  ["2026-01-01", "00:00:00Z", "2025-12-31", "2026-01-02"],
  ["2026-12-31", "23:59:59Z", "2026-12-30", "2027-01-01"],
  ["2024-02-29", "12:34:56Z", "2024-02-28", "2024-03-01"],
  ["2024-03-01", "00:00:00Z", "2024-02-29", "2024-03-02"],
  ["2025-03-01", "00:00:00Z", "2025-02-28", "2025-03-02"],
  ["2026-03-08", "12:00:00Z", "2026-03-07", "2026-03-09"],
  ["2026-11-01", "12:00:00Z", "2026-10-31", "2026-11-02"],
])
  test(`three-day cover uses UTC calendar arithmetic for ${date} ${time}`, async () => {
    const request = input();
    Object.assign(request.contact, { date, time });
    const result = await checkLotwFirstInsertHistory(request, {
      fetcher: async (value) => {
        const url = new URL(String(value));
        assert.equal(url.searchParams.get("qso_startdate"), startDate);
        assert.equal(url.searchParams.get("qso_enddate"), endDate);
        return new Response(report());
      },
    });
    assert.equal(result.state, "empty");
    assert.equal(result.startDate, startDate);
    assert.equal(result.endDate, endDate);
  });

for (const [name, fields] of [
  [
    "previous-day midnight neighbor",
    { QSO_DATE: "20261023", TIME_ON: "235959" },
  ],
  ["following-day neighbor", { QSO_DATE: "20261025", TIME_ON: "000000" }],
  ["different mode", { MODE: "CW" }],
  ["mapped mode group", { MODE: "SSB", APP_LOTW_MODE: "PHONE" }],
  ["historical mode", { MODE: "AMTORFEC" }],
  ["different band", { BAND: "40m" }],
  ["historical band", { BAND: "2190m" }],
  ["submillimeter band", { BAND: "SUBMM" }],
  ["minute precision", { TIME_ON: "0000" }],
  ["confirmed record", { QSL_RCVD: "Y" }],
  ["lower-case returned calls", { CALL: "k1abc", STATION_CALLSIGN: "w1aw/p" }],
] as const)
  test(`${name} remains a nonempty history hold without local filtering`, async () => {
    const result = await checkLotwFirstInsertHistory(input(), {
      fetcher: fetchReport(report([{ ...record, ...fields }])),
    });
    assert.deepEqual(result, {
      state: "held",
      reason: "existing_history",
      recordCount: 1,
      startDate: "2026-10-23",
      endDate: "2026-10-25",
    });
  });

test("multiple valid records are held without choosing an identity", async () => {
  const result = await checkLotwFirstInsertHistory(input(), {
    fetcher: fetchReport(
      report([record, { ...record, MODE: "CW", TIME_ON: "2359" }]),
    ),
  });
  assert.equal(result.state, "held");
  assert.equal(result.recordCount, 2);
});

for (const [name, change] of [
  ["invalid leap day", (value) => (value.contact.date = "2025-02-29")],
  ["normalized invalid day", (value) => (value.contact.date = "2026-04-31")],
  [
    "non-UTC date syntax",
    (value) => (value.contact.date = "2026-10-24T00:00Z"),
  ],
  ["lower calendar edge", (value) => (value.contact.date = "0000-01-01")],
  ["upper calendar edge", (value) => (value.contact.date = "9999-12-31")],
  ["minute-only input", (value) => (value.contact.time = "00:00Z")],
  ["fractional input", (value) => (value.contact.time = "00:00:01.500Z")],
  ["missing UTC suffix", (value) => (value.contact.time = "00:00:01")],
  ["trailing time newline", (value) => (value.contact.time = "00:00:01Z\n")],
  ["offset input", (value) => (value.contact.time = "00:00:01+00:00")],
  ["invalid hour", (value) => (value.contact.time = "24:00:00Z")],
  ["leap second", (value) => (value.contact.time = "23:59:60Z")],
  ["space in station", (value) => (value.station.callsign = " W1AW/P")],
  [
    "trailing callsign newline",
    (value) => (value.station.callsign = "W1AW/P\n"),
  ],
  ["invalid worked call", (value) => (value.contact.call = "K1 ABC")],
  ["Unicode call folding", (value) => (value.contact.call = "K1ABſ")],
  ["empty username", (value) => (value.credentials.username = "")],
  ["empty password", (value) => (value.credentials.password = "")],
] satisfies [string, (value: LotwFirstInsertHistoryInput) => void][])
  test(`rejects ${name} before transport`, async () => {
    const value = input();
    change(value);
    let calls = 0;
    await assert.rejects(
      checkLotwFirstInsertHistory(value, {
        fetcher: async () => {
          calls++;
          return new Response(report());
        },
      }),
      /LoTW first-insert/,
    );
    assert.equal(calls, 0);
  });

for (const [name, body] of [
  ["missing EOF", report().replace("<APP_LOTW_EOF>", "")],
  ["missing EOH", report().replace("<EOH>", "")],
  ["wrong count", report().replace("NUMREC:1>0", "NUMREC:1>1")],
  ["wrong program", report().replace("LoTW", "Fake")],
  ["HTML", "<html>synthetic private failure detail</html>"],
  ["forged report JSON", JSON.stringify({ complete: true, records: [] })],
  ["partial record", report([record]).replace("<EOR>", "")],
  ["invalid record time", report([{ ...record, TIME_ON: "250000" }])],
  ["invalid record date", report([{ ...record, QSO_DATE: "20260230" }])],
  ["whitespace mode", report([{ ...record, MODE: " " }])],
  ["outside date", report([{ ...record, QSO_DATE: "20261026" }])],
  ["other station", report([{ ...record, STATION_CALLSIGN: "W2AW" }])],
  ["other worked call", report([{ ...record, CALL: "K2ABC" }])],
] as const)
  test(`${name} cannot establish empty history`, async () => {
    await assert.rejects(
      checkLotwFirstInsertHistory(input(), { fetcher: fetchReport(body) }),
    );
  });

test("a valid row followed by an invalid scope row rejects the whole report", async () => {
  await assert.rejects(
    checkLotwFirstInsertHistory(input(), {
      fetcher: fetchReport(report([record, { ...record, CALL: "K2ABC" }])),
    }),
    /requested scope/,
  );
});

test("oversized response is rejected and its stream cancelled without retry", async () => {
  let calls = 0;
  let cancelled = false;
  await assert.rejects(
    checkLotwFirstInsertHistory(input(), {
      fetcher: async () => {
        calls++;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
    }),
    /exceeds bounded partition/,
  );
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});

test("mutable input and options cannot change the sent or accepted scope", async () => {
  const value = input();
  const original = structuredClone(value);
  let calls = 0;
  const options = {
    fetcher: (async (request) => {
      calls++;
      Object.assign(value.station, { callsign: "W2AW" });
      Object.assign(value.contact, {
        call: "K2ABC",
        date: "2027-01-01",
        time: "23:59:59Z",
      });
      Object.assign(value.credentials, {
        username: "changed",
        password: "changed",
      });
      options.fetcher = async () => {
        throw new Error("Replacement transport must not run");
      };
      await Promise.resolve();
      const url = new URL(String(request));
      assert.equal(
        url.searchParams.get("login"),
        original.credentials.username,
      );
      assert.equal(
        url.searchParams.get("password"),
        original.credentials.password,
      );
      assert.equal(url.searchParams.get("qso_owncall"), "W1AW/P");
      assert.equal(url.searchParams.get("qso_callsign"), "K1ABC");
      return new Response(report([record]));
    }) satisfies typeof fetch,
  };
  const result = await checkLotwFirstInsertHistory(value, options);
  assert.equal(calls, 1);
  assert.equal(result.state, "held");
  assert.equal(result.startDate, "2026-10-23");
  assert.equal(result.endDate, "2026-10-25");
});

test("mutating the input cannot make an out-of-sent-scope response valid", async () => {
  const value = input();
  await assert.rejects(
    checkLotwFirstInsertHistory(value, {
      fetcher: async () => {
        value.station.callsign = "W2AW";
        value.contact.call = "K2ABC";
        value.contact.date = "2027-01-01";
        return new Response(
          report([
            {
              ...record,
              CALL: "K2ABC",
              STATION_CALLSIGN: "W2AW",
              QSO_DATE: "20270101",
            },
          ]),
        );
      },
    }),
    /requested scope/,
  );
});

test("vendor-budget deferrals propagate unchanged and never retry", async () => {
  for (const sent of [false, true]) {
    const error = new VendorDeferredError(123456, sent);
    let calls = 0;
    await assert.rejects(
      checkLotwFirstInsertHistory(input(), {
        fetcher: async () => {
          calls++;
          throw error;
        },
      }),
      (actual) => actual === error,
    );
    assert.equal(calls, 1);
  }
});

test("cancellation retains the client's sanitized transport failure semantics", async () => {
  await assert.rejects(
    checkLotwFirstInsertHistory(input(), {
      fetcher: async () => {
        throw new DOMException("synthetic-secret URL", "AbortError");
      },
    }),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(
        error.message,
        "LoTW query transport failed; coverage remains incomplete",
      );
      return true;
    },
  );
});

test("authentication failures retain the client's typed sanitized error", async () => {
  await assert.rejects(
    checkLotwFirstInsertHistory(input(), {
      fetcher: async () => new Response("synthetic-secret", { status: 401 }),
    }),
    (error: unknown) =>
      error instanceof LotwLoginError && error.reason === "credentials",
  );
});
