import assert from "node:assert/strict";
import test from "node:test";
import type { AdifRecord } from "../src/adif.ts";
import { matchQrzHistory, sameQrzIdentity } from "../src/qrz.ts";

const source: AdifRecord = {
  STATION_CALLSIGN: "N0TEST",
  CALL: "W1AW",
  QSO_DATE: "20261022",
  TIME_ON: "120001",
  BAND: "20m",
  MODE: "CW",
  MY_GRIDSQUARE: "FN31",
};
const remote: AdifRecord = { ...source, APP_QRZLOG_LOGID: "1" };

for (const [field, maximum] of [
  ["MY_CQ_ZONE", 40],
  ["MY_ITU_ZONE", 90],
] as const) {
  test(`${field} compares valid numeric values in both leading-zero directions`, () => {
    for (const zone of [1, 5, maximum]) {
      for (const [local, observed] of [
        [String(zone), String(zone).padStart(4, "0")],
        [String(zone).padStart(4, "0"), String(zone)],
      ]) {
        const expected = Object.freeze({ ...source, [field]: local });
        const actual = Object.freeze({ ...remote, [field]: observed });
        const result = matchQrzHistory(expected, [actual]);
        assert.equal(result.state, "adopted_existing");
        assert.equal(expected[field], local);
        assert.equal(actual[field], observed);
        if (result.state === "adopted_existing")
          assert.equal(result.record, actual);
      }
    }
  });

  test(`${field} rejects malformed and out-of-range evidence even when both strings agree`, () => {
    for (const invalid of [
      "",
      "0",
      "000",
      String(maximum + 1),
      String(maximum + 1).padStart(4, "0"),
      "-1",
      "+1",
      "1.0",
      "1e0",
      " 1",
      "1 ",
      "1\n",
      "１",
      "unknown",
      "9".repeat(256),
    ]) {
      for (const [local, observed] of [
        [invalid, invalid],
        [invalid, "1"],
        ["1", invalid],
      ]) {
        assert.deepEqual(
          matchQrzHistory({ ...source, [field]: local }, [
            { ...remote, [field]: observed },
          ]),
          {
            state: "history_ambiguous",
            reason: `Operating location ${field} is invalid or unavailable`,
          },
          `${field}: ${JSON.stringify([local, observed])}`,
        );
      }
    }
  });

  test(`${field} distinguishes missing evidence from valid unequal zones`, () => {
    assert.deepEqual(matchQrzHistory({ ...source, [field]: "1" }, [remote]), {
      state: "history_ambiguous",
      reason: `Operating location ${field} is invalid or unavailable`,
    });
    assert.deepEqual(
      matchQrzHistory({ ...source, [field]: "01" }, [
        { ...remote, [field]: String(maximum) },
      ]),
      {
        state: "history_mismatch",
        reason: `Operating location ${field} differs or is absent`,
      },
    );
    // A source that supplies no zone has no zone-equality requirement.
    assert.equal(matchQrzHistory(source, [remote]).state, "adopted_existing");
    assert.equal(
      matchQrzHistory(source, [{ ...remote, [field]: "1" }]).state,
      "adopted_existing",
    );
  });
}

test("numeric zone normalization leaves unrelated history conflicts intact", () => {
  const expected = { ...source, MY_CQ_ZONE: "5", MY_ITU_ZONE: "8" };
  const observed = { ...remote, MY_CQ_ZONE: "005", MY_ITU_ZONE: "08" };
  for (const [field, local, actual] of [
    ["MY_GRIDSQUARE", "FN31", "FN32"],
    ["MY_DXCC", "291", "0291"],
    ["MY_STATE", "CT", "MA"],
    ["MY_CNTY", "CT,Hartford", "CT,Tolland"],
    ["FREQ", "14.074", "14.075"],
  ]) {
    assert.equal(
      matchQrzHistory({ ...expected, [field]: local }, [
        { ...observed, [field]: actual },
      ]).state,
      "history_mismatch",
      field,
    );
  }
  assert.equal(
    matchQrzHistory(expected, [observed, observed]).state,
    "history_ambiguous",
  );
});

test("numeric zone normalization does not relax time or mode identity", () => {
  const expected = { ...source, MY_CQ_ZONE: "5", MY_ITU_ZONE: "8" };
  const observed = { ...remote, MY_CQ_ZONE: "05", MY_ITU_ZONE: "008" };
  const minute = { ...observed, TIME_ON: "1200" };
  assert.equal(sameQrzIdentity(expected, minute), false);
  assert.deepEqual(matchQrzHistory(expected, [minute]), {
    state: "history_ambiguous",
    reason:
      "Destination history has minute-only TIME_ON precision; source includes seconds and requires association review",
  });
  const differentMode = { ...observed, MODE: "SSB" };
  assert.equal(sameQrzIdentity(expected, differentMode), false);
  assert.equal(
    matchQrzHistory(expected, [differentMode]).state,
    "history_ambiguous",
  );
});
