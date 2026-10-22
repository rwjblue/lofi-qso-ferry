import assert from "node:assert/strict";
import test from "node:test";
import type { SourceRecord } from "../src/lofi.ts";
import {
  effectiveOperation,
  isSourceDeleted,
  projectContact,
  ProjectionError,
  sourceFingerprint,
} from "../src/projection.ts";

const at = 1792684800000;
const operation: SourceRecord = {
  uuid: "op-1",
  stationCall: "N0CALL/P",
  grid: "FN31AA",
  lat: 41,
  lon: -73,
  state: "CT",
  county: "Fairfield",
  refs: [{ type: "potaActivation", ref: "US-0001" }],
};
const qso: SourceRecord = {
  uuid: "qso-1",
  operation: "op-1",
  startAtMillis: at,
  freq: 14074,
  band: "20m",
  mode: "FT8",
  their: { call: "W1AW", sent: "-10" },
  our: { sent: "-09", dxccCode: 291 },
  notes: "A synthetic contact",
  refs: [{ type: "pota", ref: "US-9999" }],
};
const event = (
  uuid: string,
  time: number,
  override: SourceRecord,
): SourceRecord => ({
  uuid,
  band: "event",
  startAtMillis: time,
  event: { event: "break", operation: override },
});
const project = (record = qso, op = operation, events: SourceRecord[] = []) =>
  projectContact(record, op, events, { operationComplete: true });

test("projects callsign, frequency kHz and own versus worked parks deliberately", async () => {
  const contact = await project();
  assert.equal(contact.stationCall, "N0CALL/P");
  assert.equal(contact.call, "W1AW");
  assert.equal(contact.frequencyMHz, 14.074);
  assert.deepEqual(contact.ownParks, ["US-0001"]);
  assert.deepEqual(contact.workedParks, ["US-9999"]);
  assert.equal(contact.timePrecision, "second");
  assert.equal(contact.grid, "FN31AA");
});

test("boundary contact uses new segment and each segment resets to the base", async () => {
  const events = [
    event("second", at + 1000, { refs: [], stationCall: "N0CALL" }),
    event("first", at, {
      grid: "FN32BB",
      lat: null,
      lon: null,
      refs: [{ type: "potaActivation", ref: "US-0002" }],
    }),
  ];
  const boundary = await project(qso, operation, events);
  assert.equal(boundary.grid, "FN32BB");
  assert.equal(boundary.latitude, undefined);
  assert.deepEqual(boundary.ownParks, ["US-0002"]);
  const later = await project(
    { ...qso, startAtMillis: at + 1000 },
    operation,
    events,
  );
  assert.equal(later.grid, "FN31AA");
  assert.equal(later.stationCall, "N0CALL");
  assert.deepEqual(later.ownParks, []);
  assert.equal(later.latitude, 41);
});

test("QSO location replaces the location group without inheriting stale coordinates", async () => {
  const contact = await project({ ...qso, our: { grid: "FN42CC" } });
  assert.equal(contact.grid, "FN42CC");
  assert.equal(contact.latitude, undefined);
  assert.equal(contact.longitude, undefined);
  const cleared = await project({
    ...qso,
    our: { grid: null, lat: null, lon: null },
  });
  assert.equal(cleared.grid, undefined);
  assert.equal(cleared.latitude, undefined);
});

test("operation-only location edits change dependent generations", async () => {
  const old = await project();
  const changed = await project(qso, {
    ...operation,
    grid: "FN42CC",
    lat: null,
    lon: null,
  });
  assert.notEqual(old.generation, changed.generation);
  assert.notEqual(
    await sourceFingerprint(old, "lotw"),
    await sourceFingerprint(changed, "lotw"),
  );
});

test("later segment changes and operation running totals do not postpone stable earlier contacts", async () => {
  const old = await project(qso, operation, [
    event("later", at + 1000, { grid: "FN42CC" }),
  ]);
  const changed = await project(
    qso,
    {
      ...operation,
      qsoCount: 1000,
      endAtMillis: at + 999999,
      syncedAtMillis: at + 55,
    },
    [event("later", at + 1000, { grid: "FN43DD" })],
  );
  assert.equal(old.generation, changed.generation);
});

test("LoTW ignores notes/parks; adopted QRZ narrative stays remote-owned", async () => {
  const before = await project();
  const after = await project(
    { ...qso, notes: "Changed notes" },
    { ...operation, refs: [{ type: "potaActivation", ref: "US-0003" }] },
  );
  assert.notEqual(
    await sourceFingerprint(before, "qrz"),
    await sourceFingerprint(after, "qrz"),
  );
  assert.equal(
    await sourceFingerprint(before, "qrz", true),
    await sourceFingerprint(after, "qrz", true),
  );
  assert.equal(
    await sourceFingerprint(before, "lotw"),
    await sourceFingerprint(after, "lotw"),
  );
});

test("missing/incomplete/deleted operations do not fall back to defaults", async () => {
  await assert.rejects(projectContact(qso, null), ProjectionError);
  await assert.rejects(projectContact(qso, operation), ProjectionError);
  await assert.rejects(
    project(qso, { ...operation, purged: "1" }),
    ProjectionError,
  );
  await assert.rejects(
    project(qso, { ...operation, uuid: "other" }),
    ProjectionError,
  );
});

test("null-operation general-log contacts use their own station without defaulting", async () => {
  const contact = await projectContact(
    { ...qso, operation: null, our: { stationCall: "N0CALL", grid: "FN31AA" } },
    null,
  );
  assert.equal(contact.operationId, null);
  assert.equal(contact.stationCall, "N0CALL");
  await assert.rejects(
    projectContact({ ...qso, operation: null }, null),
    ProjectionError,
  );
});

test("event edits/deletions apply while stop rows never open segments", async () => {
  const ignored = {
    ...event("stop", at, { grid: "FN42CC" }),
    event: { event: "stop", operation: { grid: "FN42CC" } },
  };
  assert.equal(effectiveOperation(operation, [ignored], at).grid, "FN31AA");
  assert.equal(
    effectiveOperation(
      operation,
      [{ ...event("deleted", at, { grid: "FN42CC" }), deleted: "true" }],
      at,
    ).grid,
    "FN31AA",
  );
  await assert.rejects(project(event("event", at, {})), ProjectionError);
  assert.equal(isSourceDeleted({ purged: "1" }), true);
  assert.equal(isSourceDeleted({ deleted: "false" }), false);
  assert.throws(() => isSourceDeleted({ deleted: "maybe" }), ProjectionError);
});

test("ambiguous boundary, mixed station calls, unsupported mode and wrong frequency units fail visibly", async () => {
  await assert.rejects(
    project(qso, operation, [
      event("a", at, { grid: "FN31AA" }),
      event("b", at, { grid: "FN42CC" }),
    ]),
    ProjectionError,
  );
  await assert.rejects(
    project(qso, { ...operation, stationCall: "N0CALL,W1AW" }),
    ProjectionError,
  );
  await assert.rejects(project({ ...qso, mode: "GUESSED" }), ProjectionError);
  await assert.rejects(project({ ...qso, freq: 14.074 }), ProjectionError);
  await assert.rejects(project({ ...qso, freq: 14074000 }), ProjectionError);
  const fractional = await project({ ...qso, startAtMillis: at + 123 });
  assert.equal(fractional.timePrecision, "millisecond");
});
