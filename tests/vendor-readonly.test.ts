import assert from "node:assert/strict";
import test from "node:test";
import {
  readonlyVendorTransport,
  vendorReadonlyProbe,
} from "../scripts/vendor-readonly.ts";
import { serializeAdifRecord } from "../src/adif.ts";

test("read-only probe rejects mutation endpoints and alternate hosts before any request", async () => {
  let requests = 0;
  const guarded = readonlyVendorTransport(async () => {
    requests++;
    return new Response("fixture");
  });
  for (const [url, init] of [
    [
      "https://logbook.qrz.com/api",
      { method: "POST", body: new URLSearchParams({ ACTION: "INSERT" }) },
    ],
    [
      "https://logbook.qrz.com/api",
      { method: "POST", body: new URLSearchParams({ ACTION: "DELETE" }) },
    ],
    [
      "https://logbook.qrz.com/api?ACTION=INSERT",
      { method: "POST", body: new URLSearchParams({ ACTION: "FETCH" }) },
    ],
    [
      "https://logbook.qrz.com/api",
      {
        method: "POST",
        body: new URLSearchParams([
          ["ACTION", "FETCH"],
          ["ACTION", "INSERT"],
        ]),
      },
    ],
    ["https://lofi.ham2k.net/v1/client", { method: "POST" }],
    ["https://lotw.arrl.org/lotw/upload", { method: "POST" }],
    ["https://lotw.arrl.org/lotw/upload", { method: "GET" }],
    [
      "https://example.invalid/lotwuser/lotwreport.adi?qso_query=1&qso_qsl=no",
      {},
    ],
  ] as const)
    await assert.rejects(guarded(url, init));
  assert.equal(requests, 0);
  await guarded("https://logbook.qrz.com/api", {
    method: "POST",
    body: new URLSearchParams({ ACTION: "STATUS" }),
  });
  await guarded(
    "https://lotw.arrl.org/lotwuser/lotwreport.adi?qso_query=1&qso_qsl=no",
  );
  assert.equal(requests, 2);
});
test("probe derives bounded LoTW day in memory and emits only fixed boolean/count metadata", async () => {
  const qrzRecord = {
    APP_QRZLOG_LOGID: "123",
    CALL: "K1ABC",
    STATION_CALLSIGN: "W1AW",
    QSO_DATE: "20261022",
    TIME_ON: "120000",
    BAND: "20m",
    MODE: "CW",
    MY_GRIDSQUARE: "FN31",
    NOTES: "private synthetic narrative",
  };
  const lotwRecord = { ...qrzRecord, QSL_RCVD: "N", MY_DXCC: "291" };
  const result = await vendorReadonlyProbe("fixture-persona", undefined, {
    credentials: async (_persona, provider) =>
      provider === "lotw"
        ? {
            username: "private-fixture-user",
            password: "private-fixture-password",
          }
        : { username: "private-fixture-user", api_key: "private-fixture-key" },
    fetcher: async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === "https://logbook.qrz.com") {
        assert.equal((init?.body as URLSearchParams).get("ACTION"), "FETCH");
        return new Response(
          new URLSearchParams({
            RESULT: "OK",
            COUNT: "1",
            ADIF: serializeAdifRecord(qrzRecord),
          }),
        );
      }
      assert.equal(url.searchParams.get("qso_startdate"), "2026-10-22");
      assert.equal(url.searchParams.get("qso_enddate"), "2026-10-22");
      assert.equal(init?.redirect, "error");
      return new Response(
        `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:1>1<EOH>\nSynthetic outside-field annotation\n${serializeAdifRecord(lotwRecord)}<APP_LOTW_EOF>`,
      );
    },
  });
  assert.equal(result.qrzReadCompleted, true);
  assert.equal(result.lotwReadCompleted, true);
  assert.equal(result.qrzSampleCount, 1);
  assert.equal(result.lotwRecordCount, 1);
  assert.equal(result.lotwUnconfirmedCount, 1);
  assert.equal(result.qrzPaginationCursorAdvances, true);
  assert.equal(result.qrzReadonlyRequestCount, 1);
  assert.equal(result.lotwReadonlyRequestCount, 1);
  assert.ok(
    Object.values(result).every(
      (value) => typeof value === "boolean" || typeof value === "number",
    ),
  );
  const output = JSON.stringify(result);
  for (const secret of [
    "W1AW",
    "K1ABC",
    "20261022",
    "private-fixture",
    "private synthetic narrative",
    "FN31",
  ])
    assert.ok(!output.includes(secret));
});
test("credential and vendor errors cannot leak raw values, URLs, unknown fields or key names", async () => {
  const result = await vendorReadonlyProbe("fixture", "2026-10-22", {
    credentials: async () => {
      throw new Error(
        "sensitive-password=https://secret.invalid?credential=private",
      );
    },
  });
  assert.equal(result.qrzReadCompleted, false);
  assert.equal(result.lotwReadCompleted, false);
  assert.ok(
    Object.values(result).every(
      (value) => typeof value === "boolean" || typeof value === "number",
    ),
  );
  assert.ok(!JSON.stringify(result).includes("sensitive-password"));
});
