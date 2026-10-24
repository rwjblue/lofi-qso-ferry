import assert from "node:assert/strict";
import test from "node:test";
import type { AdifRecord } from "../src/adif.ts";
import {
  HISTORICAL_CANDIDATE_LIMIT,
  HISTORICAL_CANDIDATE_POLICY_VERSION,
  HISTORICAL_TIME_WINDOW_MS,
  historicalCandidates,
} from "../src/historical-matching.ts";

const qso = (
  overrides: Record<string, string | undefined> = {},
): AdifRecord => ({
  STATION_CALLSIGN: "N0CALL/P",
  CALL: "W1AW",
  BAND: "20m",
  QSO_DATE: "20261024",
  TIME_ON: "120000",
  MODE: "CW",
  FREQ: "14.032123",
  MY_GRIDSQUARE: "FN31PR12",
  ...Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ),
});

test("unique discovery preserves original records and grants no adoption or absence authority", () => {
  const source = Object.freeze(qso());
  const remote = Object.freeze(
    qso({ TIME_ON: "122959", FREQ: "14.03212", MY_GRIDSQUARE: "FN31" }),
  );
  const result = historicalCandidates("lotw", source, Object.freeze([remote]));
  assert.equal(result.state, "unique");
  assert.equal(result.policyVersion, HISTORICAL_CANDIDATE_POLICY_VERSION);
  assert.equal(result.authoritative, false);
  assert.equal(result.requiresSourceUniqueness, true);
  assert.equal(result.requiresRemoteOwnership, true);
  assert.equal(result.candidates[0].source, source);
  assert.equal(result.candidates[0].record, remote);
  assert.deepEqual(result.candidates[0].differences, [
    { field: "TIME_ON", kind: "different" },
    { field: "FREQ", kind: "different" },
    { field: "MY_GRIDSQUARE", kind: "different" },
  ]);
  assert.equal(source.FREQ, "14.032123");
  const none = historicalCandidates("lotw", source, []);
  assert.equal(none.state, "none");
  assert.equal(none.authoritative, false);
});

test("published thirty-minute boundary is inclusive with exact seconds", () => {
  assert.equal(HISTORICAL_TIME_WINDOW_MS, 1_800_000);
  for (const vendor of ["qrz", "lotw"] as const) {
    for (const [clock, expected] of [
      ["113000", "unique"],
      ["123000", "unique"],
      ["112959", "none"],
      ["123001", "none"],
    ] as const) {
      const result = historicalCandidates(vendor, qso(), [
        qso({ TIME_ON: clock }),
      ]);
      assert.equal(result.state, expected);
      if (expected === "unique")
        assert.equal(
          result.candidates[0].time.entireIntervalWithinWindow,
          true,
        );
    }
  }
});

test("minute precision stays an interval and exposes possible-only boundary overlap", () => {
  const remote = qso({ TIME_ON: "1130" });
  const result = historicalCandidates("lotw", qso({ TIME_ON: "120030" }), [
    remote,
  ]);
  assert.equal(result.state, "unique");
  assert.equal(result.candidates[0].record.TIME_ON, "1130");
  assert.equal(result.candidates[0].time.remote.precision, "minute");
  assert.equal(
    result.candidates[0].time.remote.endMs -
      result.candidates[0].time.remote.startMs,
    59_999,
  );
  assert.equal(result.candidates[0].time.minimumSeparationMs, 1_770_001);
  assert.equal(result.candidates[0].time.maximumSeparationMs, 1_830_000);
  assert.equal(result.candidates[0].time.entireIntervalWithinWindow, false);
  assert.equal(
    historicalCandidates("lotw", qso({ TIME_ON: "1201" }), [remote]).state,
    "none",
  );
  const both = historicalCandidates("qrz", qso({ TIME_ON: "1200" }), [
    qso({ TIME_ON: "1230" }),
  ]);
  assert.equal(both.state, "unique");
  assert.equal(both.candidates[0].time.entireIntervalWithinWindow, false);
});

test("UTC intervals cross midnight, month, leap-day and year boundaries without local timezone", () => {
  for (const [date, clock, remoteDate, remoteClock] of [
    ["20261024", "000010", "20261023", "2345"],
    ["20261101", "000000", "20261031", "233000"],
    ["20240301", "000000", "20240229", "233000"],
    ["20260101", "000000", "20251231", "233000"],
  ])
    assert.equal(
      historicalCandidates("lotw", qso({ QSO_DATE: date, TIME_ON: clock }), [
        qso({ QSO_DATE: remoteDate, TIME_ON: remoteClock }),
      ]).state,
      "unique",
    );
});

test("invalid UTC calendar and precision are held instead of silently normalized", () => {
  for (const override of [
    { QSO_DATE: "20260229" },
    { QSO_DATE: "20260431" },
    { QSO_DATE: "00001024" },
    { QSO_DATE: "20261301" },
    { QSO_DATE: "20261024\n" },
    { QSO_DATE: "２０２６１０２４" },
    { TIME_ON: "240000" },
    { TIME_ON: "126000" },
    { TIME_ON: "125960" },
    { TIME_ON: "12000" },
    { TIME_ON: "120000\n" },
    { TIME_ON: "12:00" },
  ]) {
    const result = historicalCandidates("lotw", qso(), [qso(override)]);
    assert.equal(result.state, "ambiguous");
    assert.equal(result.issues[0].reason, "invalid_time");
    assert.equal(
      historicalCandidates("lotw", qso(override), []).state,
      "invalid",
    );
  }
});

test("exact calls and band are case-insensitive without dropping portable suffixes", () => {
  assert.equal(
    historicalCandidates("qrz", qso(), [
      qso({ STATION_CALLSIGN: "n0call/p", CALL: "w1aw", BAND: "20M" }),
    ]).state,
    "unique",
  );
  for (const override of [
    { STATION_CALLSIGN: "N0CALL" },
    { CALL: "W1AW/P" },
    { BAND: "40m" },
  ]) {
    assert.equal(
      historicalCandidates("lotw", qso(), [qso(override)]).state,
      "none",
    );
  }
  for (const override of [
    { CALL: "W1АW" },
    { STATION_CALLSIGN: "N0CALL/P\n" },
    { BAND: "20m\n" },
    { BAND: "unknown" },
  ]) {
    assert.equal(
      historicalCandidates("qrz", qso(), [qso(override)]).state,
      "ambiguous",
    );
  }
  // Valid legacy and microwave ADIF bands are not restricted to Ferry's exports.
  for (const BAND of ["560m", "2190m", "1.25m", "2.5mm", "submm"]) {
    assert.equal(
      historicalCandidates("lotw", qso({ BAND }), [qso({ BAND })]).state,
      "unique",
    );
  }
});

test("frequency and optional location are evidence differences, never identity exclusions", () => {
  const remote = qso({
    FREQ: "7.00000",
    MY_GRIDSQUARE: "JO22",
    MY_STATE: "CT",
  });
  delete remote.MY_DXCC;
  const result = historicalCandidates("lotw", qso({ MY_DXCC: "291" }), [
    remote,
  ]);
  assert.equal(result.state, "unique");
  assert.ok(result.candidates[0].differences.some((d) => d.field === "FREQ"));
  assert.ok(
    result.candidates[0].differences.some(
      (d) => d.field === "MY_STATE" && d.kind === "missing_source",
    ),
  );
  assert.ok(
    result.candidates[0].differences.some(
      (d) => d.field === "MY_DXCC" && d.kind === "missing_remote",
    ),
  );
});

test("QRZ uses verified primary modes, including USB/LSB and FT4's MFSK parent", () => {
  for (const [source, remote, basis] of [
    [{ MODE: "SSB", SUBMODE: "USB" }, { MODE: "LSB" }, "primary"],
    [
      { MODE: "MFSK", SUBMODE: "FT4" },
      { MODE: "MFSK", SUBMODE: "JS8" },
      "primary",
    ],
    [{ MODE: "FT4" }, { MODE: "MFSK", SUBMODE: "FT4" }, "exact"],
    [
      { MODE: "PSK", SUBMODE: "PSK31" },
      { MODE: "PSK", SUBMODE: "PSK63" },
      "primary",
    ],
  ] as const) {
    const result = historicalCandidates("qrz", qso(source), [qso(remote)]);
    assert.equal(result.state, "unique");
    assert.equal(result.candidates[0].modeBasis, basis);
  }
  assert.equal(
    historicalCandidates("qrz", qso({ MODE: "FT8" }), [
      qso({ MODE: "MFSK", SUBMODE: "FT4" }),
    ]).state,
    "none",
  );
  assert.equal(
    historicalCandidates("qrz", qso({ MODE: "FM" }), [qso({ MODE: "SSB" })])
      .state,
    "none",
  );
});

test("LoTW accepts exact individual modes or verified groups, not QRZ parent rules", () => {
  for (const [source, remote, basis] of [
    [
      { MODE: "MFSK", SUBMODE: "FT4" },
      { MODE: "DATA", APP_LOTW_MODE: "FT4", APP_LOTW_MODEGROUP: "DATA" },
      "exact",
    ],
    [
      { MODE: "FT8" },
      { MODE: "MFSK", SUBMODE: "FT4", APP_LOTW_MODEGROUP: "DATA" },
      "group",
    ],
    [
      { MODE: "SSB", SUBMODE: "USB" },
      { MODE: "FM", APP_LOTW_MODEGROUP: "PHONE" },
      "group",
    ],
    [{ MODE: "CW" }, { MODE: "CW", APP_LOTW_MODEGROUP: "CW" }, "exact"],
    [{ MODE: "FT8" }, { MODE: "DATA", APP_LOTW_MODEGROUP: "DATA" }, "group"],
    [{ MODE: "Q65" }, { MODE: "RTTY", APP_LOTW_MODEGROUP: "DATA" }, "group"],
  ] as const) {
    const result = historicalCandidates("lotw", qso(source), [qso(remote)]);
    assert.equal(result.state, "unique", JSON.stringify({ source, remote }));
    assert.equal(result.candidates[0].modeBasis, basis);
  }
  assert.equal(
    historicalCandidates("lotw", qso({ MODE: "CW" }), [
      qso({ MODE: "RTTY", APP_LOTW_MODEGROUP: "DATA" }),
    ]).state,
    "none",
  );
  assert.equal(
    historicalCandidates("lotw", qso({ MODE: "MFSK", SUBMODE: "FT4" }), [
      qso({ MODE: "MFSK", SUBMODE: "JS8" }),
    ]).state,
    "ambiguous",
  );
});

test("contradictory, malformed or unknown relevant mode evidence blocks uniqueness", () => {
  for (const override of [
    { MODE: "INVENTED" },
    { MODE: "CW\n" },
    { MODE: "ＦＴ８" },
    { MODE: "FT8", SUBMODE: "FT4" },
    { MODE: "MFSK", SUBMODE: "UNSUPPORTED" },
    { MODE: "CW", APP_LOTW_MODEGROUP: "DATA" },
    { MODE: "FT8", APP_LOTW_MODEGROUP: "UNVERIFIED" },
    { MODE: "DATA", APP_LOTW_MODE: "UNKNOWN", APP_LOTW_MODEGROUP: "DATA" },
    { MODE: "MFSK", SUBMODE: "FT4", APP_LOTW_MODE: "JS8" },
  ]) {
    const invalid = qso(override);
    const result = historicalCandidates("lotw", qso(), [qso(), invalid]);
    assert.equal(result.state, "ambiguous", JSON.stringify(override));
    assert.equal(result.issues[0].record, invalid);
    assert.equal(result.issues[0].reason, "invalid_mode");
    assert.equal(
      historicalCandidates("lotw", qso(), [invalid]).state,
      "ambiguous",
    );
  }
});

test("unrelated unsupported modes cannot poison a valid candidate", () => {
  for (const override of [
    { CALL: "W2AW" },
    { STATION_CALLSIGN: "N1CALL" },
    { BAND: "40m" },
    { TIME_ON: "123001" },
    { QSO_DATE: "20261025" },
  ]) {
    const result = historicalCandidates("lotw", qso(), [
      qso(),
      qso({ ...override, MODE: "UNKNOWN" }),
    ]);
    assert.equal(result.state, "unique");
    assert.deepEqual(result.issues, []);
  }
});

test("satellite association requires SAT and the same explicit satellite name", () => {
  const source = qso({ PROP_MODE: "SAT", SAT_NAME: "ISS" });
  assert.equal(
    historicalCandidates("lotw", source, [
      qso({ PROP_MODE: "sat", SAT_NAME: "iss" }),
    ]).state,
    "unique",
  );
  for (const remote of [qso(), qso({ PROP_MODE: "SAT", SAT_NAME: "AO-91" })]) {
    assert.equal(historicalCandidates("lotw", source, [remote]).state, "none");
  }
  for (const remote of [
    qso({ PROP_MODE: "SAT" }),
    qso({ SAT_NAME: "ISS" }),
    qso({ PROP_MODE: "SAT", SAT_NAME: "ISS\n" }),
    qso({ PROP_MODE: "SAT", SAT_NAME: "ＩＳＳ" }),
  ]) {
    const result = historicalCandidates("qrz", source, [remote]);
    assert.equal(result.state, "ambiguous");
    assert.equal(result.issues[0].reason, "invalid_satellite");
  }
});

test("all nearby competitors remain ambiguous, including exact plus coarse or duplicate evidence", () => {
  const exact = qso();
  for (const other of [
    qso({ TIME_ON: "1200" }),
    qso({ TIME_ON: "122959" }),
    exact,
  ]) {
    const result = historicalCandidates("lotw", qso(), [exact, other]);
    assert.equal(result.state, "ambiguous");
    assert.equal(result.candidates.length, 2);
    assert.equal(result.candidates[0].record, exact);
    assert.equal(result.candidates[1].record, other);
  }
});

test("LoTW APP-only individual modes remain usable with validated group evidence", () => {
  const remote = qso({ APP_LOTW_MODE: "FT4", APP_LOTW_MODEGROUP: "DATA" });
  delete remote.MODE;
  const result = historicalCandidates(
    "lotw",
    qso({ MODE: "MFSK", SUBMODE: "FT4" }),
    [remote],
  );
  assert.equal(result.state, "unique");
  assert.equal(result.candidates[0].modeBasis, "exact");
  assert.equal(result.candidates[0].record, remote);
  assert.equal(remote.MODE, undefined);
  assert.equal(
    historicalCandidates("lotw", qso({ MODE: "FT8" }), [remote]).state,
    "unique",
  );
  assert.equal(
    historicalCandidates("lotw", qso(), [
      { ...remote, APP_LOTW_MODEGROUP: "CW" },
    ]).state,
    "ambiguous",
  );
  assert.equal(historicalCandidates("qrz", qso(), [remote]).state, "ambiguous");
});

test("ADIF date begins at 1930 and candidate inputs are bounded without truncation", () => {
  const old = qso({ QSO_DATE: "19291231" });
  assert.equal(historicalCandidates("lotw", old, [old]).state, "invalid");
  const boundary = qso({ QSO_DATE: "19300101" });
  assert.equal(
    historicalCandidates("lotw", boundary, [boundary]).state,
    "unique",
  );
  const unrelated = qso({ CALL: "W2AW" });
  const within = Array.from(
    { length: HISTORICAL_CANDIDATE_LIMIT },
    () => unrelated,
  );
  assert.equal(historicalCandidates("lotw", qso(), within).state, "none");
  for (const rows of [
    [qso(), ...within],
    [...within, unrelated],
  ]) {
    const result = historicalCandidates("lotw", qso(), rows);
    assert.equal(result.state, "invalid");
    assert.equal(result.authoritative, false);
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.issues, [
      { side: "input", reason: "candidate_bound" },
    ]);
  }
});

test("unknown propagation evidence cannot establish terrestrial identity or satellite exclusion", () => {
  const satellite = qso({ PROP_MODE: "SAT", SAT_NAME: "ISS" });
  for (const vendor of ["qrz", "lotw"] as const) {
    for (const PROP_MODE of ["UNKNOWN", "SATELLITE", "SAT\n"]) {
      const remote = qso({ PROP_MODE });
      for (const source of [qso(), satellite]) {
        const result = historicalCandidates(vendor, source, [remote]);
        assert.equal(result.state, "ambiguous");
        assert.equal(result.issues[0].reason, "invalid_satellite");
        assert.equal(result.issues[0].record, remote);
      }
      assert.equal(
        historicalCandidates(vendor, remote, [qso()]).state,
        "invalid",
      );
    }
    for (const PROP_MODE of "AS AUE AUR BS ECH EME ES F2 FAI GWAVE INTERNET ION IRL LOS MS RPT RS TEP TR".split(
      " ",
    )) {
      const remote = qso({ PROP_MODE: PROP_MODE.toLowerCase() });
      assert.equal(
        historicalCandidates(vendor, qso(), [remote]).state,
        "unique",
      );
      assert.equal(
        historicalCandidates(vendor, satellite, [remote]).state,
        "none",
      );
    }
    // Proven unrelated records still do not poison the source's candidate set.
    assert.equal(
      historicalCandidates(vendor, qso(), [
        qso(),
        qso({ CALL: "W2AW", PROP_MODE: "UNKNOWN" }),
      ]).state,
      "unique",
    );
  }
});
