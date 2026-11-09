import assert from "node:assert/strict";
import test from "node:test";
import type { AdifRecord } from "../src/adif.ts";
import {
  lotwGridCorrectionObserved,
  lotwGridCorrectionRecord,
  lotwGridCorrectionTarget,
} from "../src/lotw-grid-correction.ts";

const original = Object.freeze({
  CALL: "K1ABC",
  STATION_CALLSIGN: "W1AW",
  QSO_DATE: "20261022",
  TIME_ON: "123456",
  MODE: "FM",
  BAND: "2m",
  BAND_RX: "70cm",
  FREQ: "145.95000",
  FREQ_RX: "435.15000",
  PROP_MODE: "SAT",
  SAT_NAME: "AO-91",
  MY_DXCC: "291",
  MY_GRIDSQUARE: "FN31AA",
  MY_STATE: "CT",
  MY_CNTY: "CT,Tolland",
  MY_CQ_ZONE: "5",
  MY_ITU_ZONE: "8",
  MY_IOTA: "NA-001",
  QSL_RCVD: "Y",
  APP_LOTW_RXQSO: "2026-10-23 11:00:00",
});

test("a grid correction signs the fresh remote identity and supported fields", () => {
  const stale = { ...original, MY_CNTY: "CT,Windham" };
  const target = lotwGridCorrectionTarget(stale, [original], "fn32aa");
  assert.equal(target?.original, original);
  assert.deepEqual(target.station, {
    callsign: "W1AW",
    dxcc: 291,
    grid: "FN32AA",
    state: "CT",
    county: "Tolland",
    cqZone: 5,
    ituZone: 8,
    iota: "NA-001",
  });
  assert.deepEqual(target.qso, {
    call: "K1ABC",
    band: "2M",
    bandRx: "70CM",
    mode: "FM",
    date: "2026-10-22",
    time: "12:34:56Z",
    frequencyMHz: "145.95000",
    frequencyRxMHz: "435.15000",
    propagation: "SAT",
    satellite: "AO-91",
  });
  assert.equal(original.MY_GRIDSQUARE, "FN31AA");
});

test("a correction requires the exact second and individual mode, receive band and a unique remote identity", () => {
  const mismatches: AdifRecord[] = [
    { TIME_ON: "1234" },
    { TIME_ON: "123457" },
    { MODE: "PHONE" },
    { BAND_RX: "23cm" },
    { STATION_CALLSIGN: "W1AW/P" },
  ];
  for (const difference of mismatches) {
    assert.equal(
      lotwGridCorrectionTarget(
        original,
        [{ ...original, ...difference }],
        "FN32AA",
      ),
      null,
    );
  }
  for (const other of [
    original,
    { ...original, TIME_ON: "1234" },
    { ...original, BAND_RX: "23cm" },
    { ...original, MODE: "PHONE" },
  ]) {
    assert.equal(lotwGridCorrectionRecord(original, [original, other]), null);
  }
  assert.equal(
    lotwGridCorrectionRecord(original, [
      { ...original, TIME_ON: "123457" },
      original,
    ]),
    original,
  );
});

test("unsupported provider fields and unverifiable signing precision hold a correction", () => {
  const unsupported: AdifRecord[] = [
    { FREQ: "145.950001" },
    { PROP_MODE: "INTERNET", SAT_NAME: "" },
    { MY_DXCC: "150" },
    { MY_VUCC_GRIDS: "FN31,FN32" },
    { MY_CNTY: "NY,Clinton" },
    { MY_CQ_ZONE: "0" },
    { MY_GRIDSQUARE: "INVALID" },
  ];
  for (const fields of unsupported) {
    const record = { ...original, ...fields };
    assert.equal(lotwGridCorrectionTarget(record, [record], "FN32AA"), null);
  }
  for (const grid of ["FN31", "FN31AA", "INVALID", "FN"]) {
    assert.equal(lotwGridCorrectionTarget(original, [original], grid), null);
  }
});

test("readback requires fresh exact identity, corrected grid and preserved report data", () => {
  const claimedAt = Date.parse("2026-11-09T14:30:00.500Z");
  const now = claimedAt + 30_000;
  const corrected = {
    ...original,
    MY_GRIDSQUARE: "FN32AA",
    APP_LOTW_RXQSO: "2026-11-09 14:30:00",
  };
  const observed = (fresh: AdifRecord[]) =>
    lotwGridCorrectionObserved(original, fresh, "FN32AA", claimedAt, now);
  assert.equal(observed([corrected]), true);
  assert.equal(observed([corrected, original]), false);
  const mismatches: AdifRecord[] = [
    { MY_GRIDSQUARE: "FN32" },
    { MY_GRIDSQUARE: "FN31AA" },
    { MY_CQ_ZONE: "6" },
    { FREQ_RX: "435.16000" },
    { BAND_RX: "23cm" },
    { QSL_RCVD: "N" },
    { APP_LOTW_RXQSO: original.APP_LOTW_RXQSO },
    { APP_LOTW_RXQSO: "2026-11-09 14:40:00" },
  ];
  for (const difference of mismatches) {
    assert.equal(observed([{ ...corrected, ...difference }]), false);
  }
});
