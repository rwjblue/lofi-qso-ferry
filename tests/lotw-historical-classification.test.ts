import assert from "node:assert/strict";
import test from "node:test";
import type { AdifRecord } from "../src/adif.ts";
import { classifyLotwHistoricalAssociation } from "../src/lotw-historical-classification.ts";
import {
  classifyHistoricalAssociation,
  classifyHistory,
  lotwRemoteIdentity,
  type ReconciliationEvidence,
} from "../src/reconcile.ts";

const source: AdifRecord = {
  STATION_CALLSIGN: "W1AW/P",
  CALL: "K1ABC",
  QSO_DATE: "20261024",
  TIME_ON: "120137",
  BAND: "20M",
  MODE: "FT8",
  FREQ: "14.074",
  MY_GRIDSQUARE: "FN31AA12",
  MY_DXCC: "291",
};
const remote: AdifRecord = {
  ...source,
  TIME_ON: "1215",
  MODE: "DATA",
  APP_LOTW_MODE: "FT8",
  APP_LOTW_MODEGROUP: "DATA",
  MY_GRIDSQUARE: "FN31",
};
const evidence: ReconciliationEvidence = {
  destination: "lotw",
  capturedGeneration: "current",
  currentGeneration: "current",
  readAccess: true,
  inventoryComplete: true,
  catchupComplete: true,
  freshCheckComplete: false,
  inventoryPositiveOnly: true,
};
const classify = (local = source, records = [remote], coverage = evidence) =>
  classifyLotwHistoricalAssociation(
    local,
    records,
    coverage,
    classifyHistory(local, records, coverage),
  );

test("reconciliation uses LoTW historical policy without granting exact receipt authority", () => {
  const outcome = classifyHistoricalAssociation(source, [remote], evidence);
  assert.deepEqual(outcome, classify());
  assert.equal(outcome.state, "adopted_existing");
  assert.equal(outcome.associationOnly, true);
  assert.equal(outcome.associationProof, undefined);
  assert.equal(outcome.remote, remote);
  assert.notEqual(
    classifyHistory(source, [remote], evidence).state,
    outcome.state,
  );
});

test("LoTW historical presence retains raw minute time, mode group and coarse grid without receipt authority", async () => {
  const before = structuredClone({ source, remote });
  const outcome = classify();
  assert.equal(outcome.state, "adopted_existing");
  assert.equal(outcome.associationOnly, true);
  assert.equal(outcome.associationProof, undefined);
  assert.equal(outcome.remote, remote);
  assert.deepEqual({ source, remote }, before);
  assert.notEqual(
    await lotwRemoteIdentity(source),
    await lotwRemoteIdentity(remote),
  );
});

test("different individual DATA modes are candidates, but every competitor counts before location", () => {
  const rtty = {
    ...remote,
    MODE: "RTTY",
    APP_LOTW_MODE: "RTTY",
  };
  assert.equal(classify(source, [rtty]).state, "adopted_existing");
  const outcome = classify(source, [
    { ...source },
    { ...rtty, MY_GRIDSQUARE: "EM00" },
  ]);
  assert.equal(outcome.state, "history_ambiguous");
  assert.match(outcome.reason!, /Multiple historical candidates/);
  assert.equal(outcome.remote, undefined);
});

test("LoTW APP mode without MODE remains original evidence and never acquires a fabricated mode", () => {
  const { MODE: _mode, ...appOnly } = remote;
  const outcome = classify(source, [appOnly]);
  assert.equal(outcome.state, "adopted_existing");
  assert.equal(outcome.remote, appOnly);
  assert.equal(outcome.remote.MODE, undefined);
});

test("LoTW uses the inclusive thirty-minute window and retains uncertainty at minute edges and midnight", () => {
  const exact = { ...remote, TIME_ON: "123137" };
  assert.equal(classify(source, [exact]).state, "adopted_existing");
  assert.match(
    classify(source, [{ ...remote, TIME_ON: "1231" }]).reason!,
    /precision crosses/,
  );
  assert.notEqual(
    classify(source, [{ ...remote, TIME_ON: "123138" }]).state,
    "adopted_existing",
  );
  assert.equal(
    classify({ ...source, TIME_ON: "235959" }, [
      { ...remote, QSO_DATE: "20261025", TIME_ON: "0028" },
    ]).state,
    "adopted_existing",
  );
});

test("valid nested grids match in either precision direction while missing or conflicting details remain held", () => {
  for (const grid of ["FN", "FN31", "FN31AA", "FN31AA12"])
    assert.equal(
      classify(source, [{ ...remote, MY_GRIDSQUARE: grid }]).state,
      "adopted_existing",
    );
  assert.equal(
    classify({ ...source, MY_GRIDSQUARE: "FN" }, [
      { ...remote, MY_GRIDSQUARE: "FN31AA12" },
    ]).state,
    "adopted_existing",
  );
  assert.equal(
    classify(source, [{ ...remote, MY_GRIDSQUARE: "EM00" }]).state,
    "history_mismatch",
  );
  const { MY_GRIDSQUARE: _grid, ...missing } = remote;
  assert.equal(classify(source, [missing]).state, "history_ambiguous");
  assert.equal(
    classify(source, [{ ...remote, FREQ: "14.075" }]).state,
    "history_mismatch",
  );
  assert.match(
    classify({ ...source, FREQ: "14.074001" }).reason!,
    /transmitted precision/,
  );
});

test("unknown mode evidence and unsupported satellite evidence cannot become presence or absence", () => {
  const invalid: AdifRecord[] = [
    { MODE: "UNKNOWN" },
    { APP_LOTW_MODEGROUP: "PHONE" },
    { PROP_MODE: "SAT" },
  ];
  for (const changes of invalid) {
    const outcome = classify(source, [{ ...remote, ...changes }]);
    assert.equal(outcome.state, "history_ambiguous");
    assert.equal(outcome.remote, undefined);
  }
  assert.equal(
    classify(source, [remote, { ...remote, CALL: "K9XYZ", MODE: "UNKNOWN" }])
      .state,
    "adopted_existing",
  );
});

test("wider candidate discovery preserves all coverage holds and the exact absence outcome", () => {
  for (const change of [
    { capturedGeneration: "" },
    { currentGeneration: "changed" },
    { readAccess: false },
    { inventoryComplete: false },
    { catchupComplete: false },
    { inventoryPositiveOnly: false },
  ]) {
    const coverage = { ...evidence, ...change };
    const strict = classifyHistory(source, [remote], coverage);
    assert.equal(
      classifyLotwHistoricalAssociation(source, [remote], coverage, strict),
      strict,
    );
  }
  const coverage = { ...evidence, freshCheckComplete: true };
  const absent = classifyHistory(source, [], coverage);
  assert.equal(
    classifyLotwHistoricalAssociation(source, [], coverage, absent),
    absent,
  );
  assert.equal(absent.state, "missing_current_identity");
});
