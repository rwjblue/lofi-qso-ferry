import assert from "node:assert/strict";
import test from "node:test";
import type { SourceRecord } from "../src/lofi.ts";
import {
  effectiveOperation,
  isSourceDeleted,
  isTestCallsign,
  isTestContact,
  ProjectionError,
  projectContact,
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

test("test callsigns match HaLo's exact comma and slash component rules", () => {
  for (const call of [
    "N0CALL/T",
    "n0call/test",
    "N0CALL/P/Test",
    "N0CALL/t/P",
    "TEST/N0CALL",
    "t/N0CALL",
    "TEST",
    "t",
    " N0CALL/T ",
    "N0CALL, W1AW/TEST",
    " N0CALL/T, W1AW ",
    "/TEST",
    "N0CALL//T",
  ]) {
    assert.equal(isTestCallsign(call), true, call);
  }
  for (const call of [
    undefined,
    null,
    1,
    true,
    ["N0CALL/TEST"],
    { stationCall: "N0CALL/T" },
    "",
    "N0CALL",
    "N0CALL/P",
    "N0TEST",
    "TESTER/N0CALL",
    "N0CALL/TESTING",
    "N0CALL/T1",
    "N0CALL/TST",
    "N0CALL/ T",
    "N0CALL/TEST /P",
    "N0CALL,W1AW/P",
  ]) {
    assert.equal(isTestCallsign(call), false, String(call));
  }
});

test("base test operations suppress every contact before export validation", async () => {
  const testOperation = { ...operation, stationCall: "N0CALL/TEST" };
  for (const record of [
    qso,
    { ...qso, stationCall: "W2XYZ" },
    { ...qso, our: { stationCall: "K1ABC" } },
    { ...qso, uuid: undefined, startAtMillis: "invalid", mode: undefined },
  ]) {
    const events = [event("normal-segment", at, { stationCall: "W1AW" })];
    assert.equal(isTestContact(record, testOperation, events), true);
    await assert.rejects(projectContact(record, testOperation, events), {
      code: "test_operation_not_exported",
    });
  }
  await assert.rejects(
    project(qso, { ...operation, stationCall: "N0CALL, W1AW/t" }),
    { code: "test_operation_not_exported" },
  );
});

test("test segments suppress only their interval and cannot be overridden per QSO", async () => {
  const events = [
    event("test-segment", at, { stationCall: "N0CALL/T" }),
    event("normal-again", at + 1000, { grid: "FN32BB" }),
  ];
  const before = { ...qso, startAtMillis: at - 1000 };
  const after = { ...qso, startAtMillis: at + 1000 };
  assert.equal(isTestContact(before, operation, events), false);
  assert.equal(
    (await project(before, operation, events)).stationCall,
    "N0CALL/P",
  );
  for (const record of [qso, { ...qso, our: { stationCall: "W2XYZ" } }]) {
    assert.equal(isTestContact(record, operation, events), true);
    await assert.rejects(project(record, operation, events), {
      code: "test_operation_not_exported",
    });
  }
  assert.equal(isTestContact(after, operation, events), false);
  assert.equal(
    (await project(after, operation, events)).stationCall,
    "N0CALL/P",
  );
});

test("test classification follows explicit station aliases and general-log our.call", async () => {
  for (const operationId of [null, "op-1"]) {
    for (const fields of [
      { stationCall: "N0CALL/T" },
      { our: { stationCall: "N0CALL/TEST" } },
      { stationCall: "N0CALL", our: { stationCall: "W1AW/T" } },
    ]) {
      const record = { ...qso, operation: operationId, ...fields };
      assert.equal(isTestContact(record, operation), true);
      await assert.rejects(project(record), {
        code: "test_operation_not_exported",
      });
    }
  }
  const generalLog = { ...qso, operation: null, our: { call: "N0CALL/T" } };
  assert.equal(isTestContact(generalLog, null), true);
  await assert.rejects(projectContact(generalLog, null), {
    code: "test_operation_not_exported",
  });
  // Alias precedence is the same for classification and export.
  const overridden = {
    ...generalLog,
    stationCall: "W1AW/T",
    our: { call: "N0CALL/TEST", stationCall: "K1ABC" },
  };
  assert.equal(isTestContact(overridden, null), false);
  assert.equal((await projectContact(overridden, null)).stationCall, "K1ABC");
});

test("test classification does not infer from worked calls, operators, titles or flags", async () => {
  const record = {
    ...qso,
    their: { call: "W1AW/TEST" },
    our: { call: "N0CALL/TEST", operatorCall: "W2XYZ/T" },
    test: true,
    isTest: true,
    title: "Test operation",
  };
  const op = {
    ...operation,
    test: true,
    isTest: true,
    title: "Test operation",
  };
  assert.equal(isTestContact(record, op), false);
  const contact = await project(record, op);
  assert.equal(contact.stationCall, "N0CALL/P");
  assert.equal(contact.call, "W1AW/TEST");
  assert.equal(contact.operatorCall, "W2XYZ/T");
  assert.equal(
    isTestContact(
      { ...record, operation: null, our: { operatorCall: "N0CALL/T" } },
      null,
    ),
    false,
  );
});

test("unrelated operations, stop events and deleted segments cannot identify tests", async () => {
  const testOperation = { ...operation, stationCall: "N0CALL/T" };
  const generalLog = { ...qso, operation: null, our: { call: "W1AW" } };
  assert.equal(isTestContact(generalLog, testOperation), false);
  assert.equal(
    (await projectContact(generalLog, testOperation)).stationCall,
    "W1AW",
  );
  assert.equal(isTestContact(qso, { ...testOperation, uuid: "other" }), false);
  await assert.rejects(project(qso, { ...testOperation, uuid: "other" }), {
    code: "operation_context_incomplete",
  });
  const events = [
    { ...event("deleted", at, { stationCall: "N0CALL/T" }), deleted: true },
    {
      ...event("stop", at, { stationCall: "N0CALL/TEST" }),
      event: { event: "stop", operation: { stationCall: "N0CALL/TEST" } },
    },
  ];
  assert.equal(isTestContact(qso, operation, events), false);
  assert.equal((await project(qso, operation, events)).stationCall, "N0CALL/P");
  await assert.rejects(project(event("event", at, {}), testOperation), {
    code: "event_is_not_contact",
  });
});

test("unreliable test segment context preserves ordinary validation errors", async () => {
  const events = [
    event("test", at, { stationCall: "N0CALL/T" }),
    event("normal", at, { stationCall: "W1AW" }),
  ];
  assert.equal(isTestContact(qso, operation, events), false);
  await assert.rejects(project(qso, operation, events), {
    code: "ambiguous_segment_boundary",
  });
  const invalidTime = { ...qso, startAtMillis: "invalid" };
  assert.equal(
    isTestContact(invalidTime, operation, events.slice(0, 1)),
    false,
  );
  await assert.rejects(project(invalidTime, operation, events.slice(0, 1)), {
    code: "invalid_qso_time",
  });
});

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

test("canonical general-log our.call supplies station identity without inferring the operator", async () => {
  const record = {
    ...qso,
    operation: null,
    our: { call: " n0call/p ", grid: "FN31AA" },
  };
  const contact = await projectContact(record, null);
  assert.equal(contact.stationCall, "N0CALL/P");
  assert.equal(contact.call, "W1AW");
  assert.equal(contact.operatorCall, undefined);
  const operated = await projectContact(
    { ...record, our: { ...record.our, operatorCall: "W2XYZ" } },
    null,
  );
  assert.equal(operated.stationCall, "N0CALL/P");
  assert.equal(operated.operatorCall, "W2XYZ");
});

test("explicit QSO station fields take precedence over canonical our.call", async () => {
  const record = {
    ...qso,
    operation: null,
    stationCall: "W2XYZ",
    our: { call: "N0CALL", stationCall: "K1ABC" },
  };
  assert.equal((await projectContact(record, null)).stationCall, "K1ABC");
  assert.equal(
    (await projectContact({ ...record, our: { call: "N0CALL" } }, null))
      .stationCall,
    "W2XYZ",
  );
});

test("explicit station clears cannot fall back to canonical calls or operation context", async () => {
  for (const cleared of [null, "", " "]) {
    for (const operationId of [null, "op-1"]) {
      for (const fields of [
        { stationCall: "W2XYZ", our: { call: "N0CALL", stationCall: cleared } },
        { stationCall: cleared, our: { call: "N0CALL" } },
      ]) {
        await assert.rejects(
          project({ ...qso, operation: operationId, ...fields }),
          { code: "missing_or_ambiguous_station_call" },
        );
      }
    }
  }
});

test("operation and segment station identities remain authoritative over our.call", async () => {
  const record = { ...qso, our: { call: "W2XYZ", operatorCall: "K1ABC" } };
  assert.equal((await project(record)).stationCall, "N0CALL/P");
  assert.equal(
    (
      await project(record, operation, [
        event("segment", at, { stationCall: "K2HRC" }),
      ])
    ).stationCall,
    "K2HRC",
  );
  for (const cleared of [null, "", undefined]) {
    await assert.rejects(
      project(record, { ...operation, stationCall: cleared }),
      {
        code: "missing_or_ambiguous_station_call",
      },
    );
    await assert.rejects(
      project(record, operation, [
        event("segment", at, { stationCall: cleared }),
      ]),
      { code: "missing_or_ambiguous_station_call" },
    );
  }
});

test("general-log station compatibility validates our.call and never uses operatorCall", async () => {
  for (const call of [undefined, null, "", "N0CALL,W2XYZ", "NOCALL", "1234"]) {
    await assert.rejects(
      projectContact(
        { ...qso, operation: null, our: { call, operatorCall: "N0CALL" } },
        null,
      ),
      { code: "missing_or_ambiguous_station_call" },
    );
  }
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

test("authoritative deleted status prevents contact, operation and event resurrection", async () => {
  for (const deleted of [undefined, null, false, 0, "false", "0", "unknown"]) {
    const raw = { ...qso, deleted, status: "deleted" };
    const original = structuredClone(raw);
    assert.equal(isSourceDeleted(raw), true);
    assert.equal((await project(raw)).deleted, true);
    assert.deepEqual(raw, original, "normalization preserves the source body");
  }
  await assert.rejects(project(qso, { ...operation, status: "deleted" }), {
    code: "operation_context_incomplete",
  });
  assert.equal(
    effectiveOperation(
      operation,
      [{ ...event("retired", at, { grid: "FN42CC" }), status: "deleted" }],
      at,
    ).grid,
    operation.grid,
  );
});

test("other statuses never override positive tombstones or coerce deletion flags", () => {
  for (const status of [
    undefined,
    null,
    "live",
    "unknown",
    "Deleted",
    "deleted ",
    1,
    {},
    ["deleted"],
  ]) {
    for (const flag of [true, 1, "true", "1"]) {
      assert.equal(isSourceDeleted({ deleted: flag, status }), true);
      assert.equal(isSourceDeleted({ purged: flag, status }), true);
    }
    assert.throws(
      () => isSourceDeleted({ deleted: "maybe", status }),
      ProjectionError,
    );
    assert.equal(isSourceDeleted({ deleted: false, status }), false);
  }
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

test("a null-operation contact never inherits a supplied operation's station or location", async () => {
  await assert.rejects(
    projectContact({ ...qso, operation: null }, operation),
    ProjectionError,
  );
  const contact = await projectContact(
    { ...qso, operation: null, our: { stationCall: "N0CALL" } },
    operation,
  );
  assert.equal(contact.grid, undefined);
  assert.deepEqual(contact.ownParks, []);
});

test("LoTW dependencies match signed fields and exclude coordinates and operator-only edits", async () => {
  const before = await project();
  const after = await project(
    { ...qso, our: { ...(qso.our as SourceRecord), operatorCall: "W1AW" } },
    { ...operation, lat: 41.5, lon: -73.5 },
  );
  assert.equal(
    await sourceFingerprint(before, "lotw"),
    await sourceFingerprint(after, "lotw"),
  );
  assert.notEqual(
    await sourceFingerprint(before, "qrz"),
    await sourceFingerprint(after, "qrz"),
  );
  for (const field of ["cqZone", "ituZone"] as const) {
    const changed = await project({
      ...qso,
      our: { ...(qso.our as SourceRecord), [field]: 5 },
    });
    assert.equal(changed[field], 5);
    assert.notEqual(
      await sourceFingerprint(before, "lotw"),
      await sourceFingerprint(changed, "lotw"),
    );
  }
});

test("a contact end-time edit remains a QRZ input while operation end totals are snapshots", async () => {
  const before = await project();
  const after = await project({ ...qso, endAtMillis: at + 60_000 });
  assert.notEqual(before.generation, after.generation);
  assert.equal(
    await sourceFingerprint(before, "lotw"),
    await sourceFingerprint(after, "lotw"),
  );
});

test("internal intake bookkeeping cannot change destination fingerprints or quiet periods", async () => {
  const original = await project();
  const first = { ...original, contextGeneration: 1 };
  const second = { ...original, contextGeneration: 99 };
  assert.equal(
    await sourceFingerprint(first, "qrz"),
    await sourceFingerprint(second, "qrz"),
  );
  assert.equal(
    await sourceFingerprint(first, "qrz", true),
    await sourceFingerprint(second, "qrz", true),
  );
  assert.equal(
    await sourceFingerprint(first, "lotw"),
    await sourceFingerprint(second, "lotw"),
  );
});
