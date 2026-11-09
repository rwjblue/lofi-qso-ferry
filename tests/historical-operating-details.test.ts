import assert from "node:assert/strict";
import test from "node:test";
import { historicalOperatingDetails } from "../src/historical-operating-details.ts";
import { matchQrzHistory } from "../src/qrz.ts";

const identity = {
  STATION_CALLSIGN: "W1AW",
  CALL: "K1ABC",
  QSO_DATE: "20261024",
  TIME_ON: "120000",
  BAND: "20M",
  MODE: "CW",
  MY_GRIDSQUARE: "FN31AA",
};

test("historical frequency differences up to 100 Hz preserve the original remote record", () => {
  for (const vendor of ["qrz", "lotw"] as const)
    for (const field of ["FREQ", "FREQ_RX"] as const)
      for (const [left, right, matched] of [
        ["14.074", "14.0741", true],
        ["14.0741", "14.074", true],
        ["014.0741000001", "14.0740000001", true],
        ["14.0741000001", "14.074", false],
        ["14.074", "14.0741000001", false],
        ["14.0739999999", "14.0741", false],
        ["14.0739999999", "14.0740999999", true],
        ["14.99995", "15.00005", true],
      ] as const) {
        const source = Object.freeze({ ...identity, [field]: left });
        const remote = Object.freeze({ ...identity, [field]: right });
        const result = historicalOperatingDetails(vendor, source, remote);
        if (matched) {
          assert.equal(result.state, "adopted_existing");
          assert.equal(result.record, remote);
        } else {
          assert.equal(result.state, "history_mismatch");
        }
        assert.equal(
          matchQrzHistory(source, [remote]).state,
          "history_mismatch",
        );
      }
});

test("a frequency tolerance cannot clear missing frequency or conflicting grids", () => {
  for (const vendor of ["qrz", "lotw"] as const) {
    const source = { ...identity, FREQ: "14.074" };
    for (const frequency of ["", "0", "14.074e0", "NaN"])
      assert.equal(
        historicalOperatingDetails(vendor, source, {
          ...identity,
          FREQ: frequency,
        }).state,
        "history_ambiguous",
      );
    assert.equal(
      historicalOperatingDetails(vendor, source, {
        ...identity,
        MY_GRIDSQUARE: "FN31BB",
        FREQ: "14.0741",
      }).state,
      "history_mismatch",
    );
  }
});
