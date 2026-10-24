import assert from "node:assert/strict";
import { test } from "node:test";
import { type LotwReport, observeLotwContact } from "../src/lotw.ts";
import { normalizeLotwStationGrid } from "../src/lotw-grid.ts";
import {
  classifyHistory,
  type ReconciliationEvidence,
} from "../src/reconcile.ts";
import type { LotwContact, LotwStation } from "../src/signing.ts";

test("LoTW station grids preserve exact four, six and eight character precision", () => {
  for (const grid of ["FN31", "fn31pr", "fn31pr12", "AA00aa00", "RR99xx99"])
    assert.equal(normalizeLotwStationGrid(grid), grid.toUpperCase());
  for (const grid of [
    "",
    "FN",
    "FN3",
    "FN31P",
    "FN31PR1",
    "FN31PR12A",
    "FN31PR12AA",
    "FN31PR12AA00",
    "SN31",
    "FN31YZ",
    "FN31PRAB",
    "FN31PR12,EM00",
    " FN31PR12",
    "FN31PR12 ",
    "FN31\n",
    "ＦＮ31PR12",
    "FN31ſr12",
  ])
    assert.throws(
      () => normalizeLotwStationGrid(grid),
      /Unsupported station grid/,
    );
});

const station: LotwStation = Object.freeze({
  callsign: "W1AW",
  dxcc: 291,
  grid: "fn31pr12",
});
const contact: LotwContact = Object.freeze({
  id: "grid-precision-fixture",
  generation: "1",
  call: "K1ABC",
  band: "20m",
  mode: "CW",
  date: "2026-10-22",
  time: "12:34:56Z",
});
const source = Object.freeze({
  CALL: contact.call,
  STATION_CALLSIGN: station.callsign,
  QSO_DATE: "20261022",
  TIME_ON: "123456",
  BAND: contact.band,
  MODE: contact.mode,
  MY_DXCC: String(station.dxcc),
  MY_GRIDSQUARE: station.grid!,
});
const evidence: ReconciliationEvidence = {
  destination: "lotw",
  capturedGeneration: "1",
  currentGeneration: "1",
  readAccess: true,
  inventoryComplete: true,
  catchupComplete: true,
  freshCheckComplete: true,
};

test("eight-character LoTW readback requires all eight characters even after confirmation", () => {
  for (const grid of ["FN31", "FN31PR", "FN31PR13", "", "FN31PR12AA"])
    for (const confirmation of ["Y", "N"]) {
      const report: LotwReport = {
        records: [{ ...source, MY_GRIDSQUARE: grid, QSL_RCVD: confirmation }],
        receivedThrough: null,
        complete: true,
      };
      const result = observeLotwContact(station, contact, report);
      assert.equal(result.state, "projection_mismatch");
      assert.deepEqual(result.differingFields, ["MY_GRIDSQUARE"]);
    }
  const report: LotwReport = {
    records: [{ ...source, MY_GRIDSQUARE: "FN31PR12", QSL_RCVD: "N" }],
    receivedThrough: null,
    complete: true,
  };
  assert.equal(observeLotwContact(station, contact, report).state, "observed");
  assert.equal(station.grid, "fn31pr12");
});

test("historical nested grids associate while eight-character upload verification stays exact", () => {
  for (const grid of ["FN31", "FN31PR"]) {
    const remote = Object.freeze({ ...source, MY_GRIDSQUARE: grid });
    const result = classifyHistory(source, [remote], evidence);
    assert.equal(result.state, "adopted_existing");
    assert.equal(result.remote, remote);
    assert.equal(remote.MY_GRIDSQUARE, grid);
    assert.equal(
      observeLotwContact(station, contact, {
        records: [remote],
        receivedThrough: null,
        complete: true,
      }).state,
      "projection_mismatch",
    );
  }
  assert.equal(
    classifyHistory(
      source,
      [{ ...source, MY_GRIDSQUARE: "FN31PR12" }],
      evidence,
    ).state,
    "adopted_existing",
  );
  assert.equal(
    classifyHistory(
      source,
      [{ ...source, MY_GRIDSQUARE: "FN31PR13" }],
      evidence,
    ).state,
    "history_mismatch",
  );
  assert.equal(source.MY_GRIDSQUARE, "fn31pr12");
});
