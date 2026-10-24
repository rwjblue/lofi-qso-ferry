import assert from "node:assert/strict";
import test from "node:test";
import { type AdifRecord, serializeAdifRecord } from "../src/adif.ts";
import {
  QrzClient,
  type QrzCoveringReadOptions,
  QrzError,
} from "../src/qrz.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";

const source = {
  STATION_CALLSIGN: "N0TEST/P",
  CALL: "W1AW",
  BAND: "20m",
  MODE: "CW",
  QSO_DATE: "20261022",
  TIME_ON: "120001",
};
const options = {
  target: ["2026-10-22", "2026-10-22"] as [string, string],
  stationCallsign: source.STATION_CALLSIGN,
};
const row = (id: number, extra: AdifRecord = {}): AdifRecord => ({
  ...source,
  APP_QRZLOG_LOGID: String(id),
  ...extra,
});
const response = (rows: AdifRecord[], count = rows.length) =>
  new Response(
    new URLSearchParams({
      RESULT: "OK",
      COUNT: String(count),
      ADIF: rows.map(serializeAdifRecord).join(""),
    }).toString(),
  );
function client(pages: (() => Response)[]) {
  const requests: string[] = [];
  return {
    requests,
    client: new QrzClient("private-key", {
      fetch: async (url, init) => {
        assert.equal(url, "https://logbook.qrz.com/api");
        assert.equal(init?.method, "POST");
        assert.equal(init?.redirect, "manual");
        assert(init?.signal instanceof AbortSignal);
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get("ACTION"), "FETCH");
        requests.push(body.get("OPTION")!);
        const page = pages.shift();
        assert(page, "request cap or page completion was not enforced");
        return page();
      },
    }),
  };
}

test("successful covering read retains its exact target and independently successful expanded range", async () => {
  const retained = [row(1, { QSO_DATE: "20261020" })];
  const h = client([() => response(retained)]);
  const result = await h.client.readCoveringRange({
    ...options,
    expandDays: 7,
  });
  assert.deepEqual(result.target, options.target);
  assert.deepEqual(result.cover, ["2026-10-15", "2026-10-29"]);
  assert.deepEqual(
    result.records.map((record) => ({ ...record })),
    retained,
  );
  assert.equal(result.pages, 1);
  assert(result.completedAt >= result.startedAt);
  assert.deepEqual(h.requests, [
    "TYPE:ADIF,MAX:250,AFTERLOGID:0,BETWEEN:2026-10-15+2026-10-29",
  ]);
  assert(!("freshCheckComplete" in result));
  assert(!("absence" in result));
});

test("exactly full covering pages require a valid unchanged overlap page instead of interpreting terminal failure", async () => {
  const rows = Array.from({ length: 250 }, (_, index) => row(10 + index * 3));
  const h = client([
    () => response(rows, 250),
    () => response([rows[249]], 250),
  ]);
  const result = await h.client.readCoveringRange(options);
  assert.deepEqual(
    result.records.map((record) => ({ ...record })),
    rows,
  );
  assert.equal(result.pages, 2);
  assert.match(h.requests[1], /AFTERLOGID:757,/);
  assert.equal(h.requests.length, 2);
});

test("explicit known-positive covering reads accept 35 days while retaining the narrower target", async () => {
  const h = client([
    () =>
      response([
        row(1, { QSO_DATE: "20261001" }),
        row(2, { QSO_DATE: "20261104" }),
      ]),
  ]);
  const target: [string, string] = ["2026-10-22", "2026-10-28"];
  const cover: [string, string] = ["2026-10-01", "2026-11-04"];
  const result = await h.client.readCoveringRange({
    ...options,
    target,
    cover,
  });
  assert.deepEqual(result.target, target);
  assert.deepEqual(result.cover, cover);
  assert.equal(result.records.length, 2);
  assert.equal(
    result.records.filter(
      (record) =>
        record.QSO_DATE >= "20261022" && record.QSO_DATE <= "20261028",
    ).length,
    0,
  );
  assert.equal(result.pages, 1);
  assert.match(h.requests[0], /BETWEEN:2026-10-01\+2026-11-04$/);
  assert(!("absence" in result));
});

test("explicit covers require containment, at most 35 days and no expansion option before transport", async () => {
  const invalid: Partial<QrzCoveringReadOptions>[] = [
    { cover: ["2026-10-01", "2026-11-05"] },
    { cover: ["2026-10-28", "2026-10-22"] },
    { cover: ["2026-10-23", "2026-10-28"] },
    { cover: ["2026-10-01", "2026-10-27"] },
    { cover: ["2026-02-30", "2026-10-28"] },
    { cover: ["2026-10-01", "2026-11-04"], expandDays: 0 },
    { cover: ["2026-10-01", "2026-11-04"], expandDays: 7 },
  ];
  for (const changes of invalid) {
    const h = client([]);
    await assert.rejects(
      h.client.readCoveringRange({
        ...options,
        target: ["2026-10-22", "2026-10-28"],
        ...changes,
      }),
      QrzError,
    );
    assert.equal(h.requests.length, 0);
  }
});

test("explicit covers validate every outer record against the cover and station", async () => {
  for (const record of [
    row(1, { QSO_DATE: "20260930" }),
    row(1, { QSO_DATE: "20261105" }),
    row(1, { QSO_DATE: "20261001", STATION_CALLSIGN: "K0OTHER" }),
    row(1, { QSO_DATE: "20261001", CALL: " " }),
  ]) {
    const h = client([() => response([record])]);
    await assert.rejects(
      h.client.readCoveringRange({
        ...options,
        cover: ["2026-10-01", "2026-11-04"],
      }),
      QrzError,
    );
    assert.equal(h.requests.length, 1);
  }
});

test("covering pagination accepts globally sparse ordered IDs and removes only the exact overlap", async () => {
  const first = Array.from({ length: 250 }, (_, index) => row(1 + index * 10));
  const final = row(9999);
  const h = client([
    () => response(first, 99999),
    () => response([first[249], final], 99999),
  ]);
  const result = await h.client.readCoveringRange(options);
  assert.equal(result.records.length, 251);
  assert.deepEqual(
    result.records.map((record) => ({ ...record })),
    [...first, final],
  );
  assert.equal(
    result.pages,
    2,
    "raw short page, not global COUNT, ends the scan",
  );
});

test("missing, changed, duplicated, reordered and regressed covering anchors never release partial records", async (t) => {
  const first = Array.from({ length: 250 }, (_, index) => row(index + 1));
  for (const [name, next] of [
    ["missing", [row(251)]],
    ["changed identity", [row(250, { CALL: "K0CHANGED" }), row(251)]],
    [
      "changed narrative",
      [row(250, { COMMENT: "private changed field" }), row(251)],
    ],
    ["duplicate", [row(250), row(250)]],
    ["reordered", [row(251), row(250)]],
    ["regressed", [row(249), row(250)]],
    ["empty", []],
  ] as const)
    await t.test(name, async () => {
      const h = client([() => response(first), () => response([...next])]);
      await assert.rejects(
        h.client.readCoveringRange(options),
        (error: unknown) => {
          assert(error instanceof QrzError);
          assert.equal(error.kind, "protocol");
          assert.doesNotMatch(error.message, /private|K0CHANGED/);
          return true;
        },
      );
      assert.equal(h.requests.length, 2);
    });
});

test("covering reads fail on any malformed record or out-of-scope date/station before local filtering", async (t) => {
  for (const [name, rows] of [
    ["other book station", [row(1, { STATION_CALLSIGN: "K0OTHER" })]],
    ["earlier date", [row(1, { QSO_DATE: "20261021" })]],
    ["later date", [row(1, { QSO_DATE: "20261023" })]],
    ["invalid date", [row(1, { QSO_DATE: "20260230" })]],
    ["invalid time", [row(1, { TIME_ON: "240000" })]],
    ["missing identity", [row(1, { CALL: "" })]],
    ["missing mode", [row(1, { MODE: "" })]],
    ["whitespace call", [row(1, { CALL: " " })]],
    ["whitespace band", [row(1, { BAND: "\t" })]],
    ["whitespace mode", [row(1, { MODE: "\n" })]],
    ["call delimiter", [row(1, { CALL: "W1AW,OTHER" })]],
    ["band control", [row(1, { BAND: "20m\0" })]],
    ["mode delimiter", [row(1, { MODE: "CW:OTHER" })]],
    ["unordered first page", [row(2), row(1)]],
    ["zero positive anchors", []],
  ] as const)
    await t.test(name, async () => {
      const h = client([() => response([...rows])]);
      await assert.rejects(h.client.readCoveringRange(options), QrzError);
      assert.equal(h.requests.length, 1);
    });
});

test("FAIL zero and errors after positive pages remain failures rather than absence", async (t) => {
  for (const firstPage of [false, true])
    await t.test(firstPage ? "after positive page" : "initial", async () => {
      const pages = firstPage
        ? [
            () =>
              response(
                Array.from({ length: 250 }, (_, index) => row(index + 1)),
              ),
          ]
        : [];
      pages.push(() => new Response("RESULT=FAIL&COUNT=0"));
      const h = client(pages);
      await assert.rejects(
        h.client.readCoveringRange(options),
        (error: unknown) => {
          assert(error instanceof QrzError);
          assert.equal(error.kind, "rejected");
          assert.equal(error.detail, "ambiguous_empty_selection");
          return true;
        },
      );
      assert.equal(h.requests.length, firstPage ? 2 : 1);
    });
});

test("covering reads stop after four attempted full pages without making a fifth request", async () => {
  const h = client(
    Array.from(
      { length: 4 },
      (_, page) => () =>
        response(
          Array.from({ length: 250 }, (_, index) =>
            row(1 + page * 249 + index),
          ),
        ),
    ),
  );
  await assert.rejects(
    h.client.readCoveringRange(options),
    /page limit reached/,
  );
  assert.equal(h.requests.length, 4);
});

test("covering reads enforce existing response and aggregate retained-record byte bounds", async (t) => {
  await t.test("response", async () => {
    const h = client([() => new Response("x".repeat(2 * 1024 * 1024 + 1))]);
    await assert.rejects(h.client.readCoveringRange(options), /exceeds 2 MiB/);
    assert.equal(h.requests.length, 1);
  });
  await t.test("aggregate", async () => {
    const rows = Array.from({ length: 450 }, (_, index) =>
      row(index + 1, { COMMENT: "x".repeat(5000) }),
    );
    const h = client([
      () => response(rows.slice(0, 250)),
      () => response(rows.slice(249)),
    ]);
    await assert.rejects(
      h.client.readCoveringRange(options),
      /retained record bound/,
    );
    assert.equal(h.requests.length, 2);
  });
});

test("covering reads preserve vendor-budget deferral and yield before the next page at the caller deadline", async () => {
  const deferred = new VendorDeferredError(1000);
  let calls = 0;
  const blocked = new QrzClient("synthetic", {
    fetch: async () => {
      calls++;
      throw deferred;
    },
  });
  await assert.rejects(
    blocked.readCoveringRange(options),
    (error) => error === deferred,
  );
  assert.equal(calls, 1);
  let clock = 100;
  const deadline = new QrzClient("synthetic", {
    fetch: async () => {
      calls++;
      clock = 200;
      return response(
        Array.from({ length: 250 }, (_, index) => row(index + 1)),
      );
    },
  });
  await assert.rejects(
    deadline.readCoveringRange({
      ...options,
      now: () => clock,
      deadlineAt: 200,
    }),
    /deadline reached/,
  );
  assert.equal(calls, 2);
  const h = client([
    () => response(Array.from({ length: 250 }, (_, index) => row(index + 1))),
  ]);
  await assert.rejects(
    h.client.readCoveringRange({
      ...options,
      shouldContinue: () => h.requests.length === 0,
    }),
    /deadline reached/,
  );
  assert.equal(h.requests.length, 1);
});

test("covering reads abort an in-flight fetch at the supplied deadline", async () => {
  let signal: AbortSignal | null | undefined;
  const h = new QrzClient("synthetic", {
    fetch: async (_input, init) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        const watchdog = setTimeout(
          () => reject(new Error("covering request was not aborted")),
          1000,
        );
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(watchdog);
            reject(new Error("private aborted transport"));
          },
          { once: true },
        );
      });
    },
  });
  await assert.rejects(
    h.readCoveringRange({ ...options, now: () => 100, deadlineAt: 120 }),
    /deadline reached/,
  );
  assert.equal(signal?.aborted, true);
});

test("covering scope validates seven-day targets, fixed expansion and deadlines before transport", async () => {
  for (const changes of [
    { target: ["2026-10-22", "2026-10-29"] as [string, string] },
    { target: ["2026-10-22", "2026-10-21"] as [string, string] },
    { target: ["2026-02-30", "2026-03-01"] as [string, string] },
    { expandDays: 8 as 7 },
    { stationCallsign: "private invalid station" },
    { deadlineAt: Number.NaN },
  ]) {
    const h = client([]);
    await assert.rejects(
      h.client.readCoveringRange({ ...options, ...changes }),
      QrzError,
    );
    assert.equal(h.requests.length, 0);
  }
  const h = client([() => response([row(1)])]);
  const result = await h.client.readCoveringRange({
    ...options,
    target: ["2026-10-22", "2026-10-28"],
    expandDays: 7,
  });
  assert.deepEqual(result.cover, ["2026-10-15", "2026-11-04"]);
});
