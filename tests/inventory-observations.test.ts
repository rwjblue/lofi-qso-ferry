import assert from "node:assert/strict";
import test from "node:test";
import type { AdifRecord } from "../src/adif.ts";
import {
  InventoryObservationError,
  lofiInventoryObservations,
  lotwInventoryObservations,
  qrzInventoryObservations,
} from "../src/inventory-observations.ts";
import type { SourceRecord } from "../src/lofi.ts";
import { projectContact, sourceFingerprint } from "../src/projection.ts";
import { lotwRemoteIdentity } from "../src/reconcile.ts";
import { canonical, sha256 } from "../src/security.ts";

const at = Date.parse("2026-11-07T13:05:12.123Z");
const qso: SourceRecord = {
  uuid: "qso-1",
  operation: null,
  syncedAtMillis: 100,
  startAtMillis: at,
  freq: 14074,
  mode: "FT8",
  band: "20m",
  their: { call: "W1AW" },
  our: { call: "N1RWJ", grid: "FN31AA" },
  notes: "Original narrative",
};
const lotw: AdifRecord = {
  STATION_CALLSIGN: "N1RWJ",
  CALL: "W1AW",
  QSO_DATE: "20261107",
  TIME_ON: "130512",
  BAND: "20m",
  MODE: "FT8",
  MY_GRIDSQUARE: "FN31AA",
  QSL_RCVD: "N",
};

function fixedError(code: string) {
  return (error: unknown) =>
    error instanceof InventoryObservationError &&
    error.code === code &&
    error.message === code;
}

test("LoFi preserves raw operations, contacts, events and existing tombstone semantics", async () => {
  const operation = {
    uuid: "op-1",
    syncedAtMillis: 99,
    stationCall: "N1RWJ",
  };
  const values: SourceRecord[] = [
    qso,
    {
      uuid: "event-1",
      operation: "op-1",
      event: "segment",
      syncedAtMillis: 101,
    },
    { uuid: "event-2", operation: "op-1", band: "event", syncedAtMillis: 102 },
    {
      uuid: "deleted-1",
      status: "deleted",
      deleted: false,
      syncedAtMillis: 103,
    },
    { uuid: "deleted-2", deleted: "1", syncedAtMillis: 104 },
    { uuid: "deleted-3", purged: true, syncedAtMillis: 105 },
  ];
  const result = await lofiInventoryObservations([operation], values);
  assert.deepEqual(
    result.map(({ family, key, subtype, parentKey, status, order }) => ({
      family,
      key,
      subtype,
      parentKey,
      status,
      order,
    })),
    [
      {
        family: "operation",
        key: "op-1",
        subtype: "operation",
        parentKey: undefined,
        status: "active",
        order: 99,
      },
      {
        family: "qso",
        key: "qso-1",
        subtype: "qso",
        parentKey: undefined,
        status: "active",
        order: 100,
      },
      {
        family: "qso",
        key: "event-1",
        subtype: "event",
        parentKey: "op-1",
        status: "active",
        order: 101,
      },
      {
        family: "qso",
        key: "event-2",
        subtype: "event",
        parentKey: "op-1",
        status: "active",
        order: 102,
      },
      {
        family: "qso",
        key: "deleted-1",
        subtype: "qso",
        parentKey: undefined,
        status: "deleted",
        order: 103,
      },
      {
        family: "qso",
        key: "deleted-2",
        subtype: "qso",
        parentKey: undefined,
        status: "deleted",
        order: 104,
      },
      {
        family: "qso",
        key: "deleted-3",
        subtype: "qso",
        parentKey: undefined,
        status: "deleted",
        order: 105,
      },
    ],
  );
  assert.deepEqual(result[0].body, operation);
  assert.deepEqual(
    result.slice(1).map(({ body }) => body),
    values,
  );
  const { syncedAtMillis: _stamp, ...revision } = qso;
  assert.equal(result[1].revision, await sha256(canonical(revision)));
});

test("LoFi captures input before hashing and separates metadata from source semantics", async () => {
  const original = structuredClone(qso);
  const pending = lofiInventoryObservations([], [original]);
  (original.their as SourceRecord).call = "W2AW";
  original.notes = "Changed after call";
  const [captured] = await pending;
  assert.deepEqual(captured.body, qso);
  const changed: SourceRecord = {
    ...qso,
    syncedAtMillis: 999,
    updatedAtMillis: 555,
    createdAtMillis: 444,
  };
  const [metadata] = await lofiInventoryObservations([], [changed]);
  assert.deepEqual(captured.semantic, metadata.semantic);
  const before = await projectContact(qso, null);
  const after = await projectContact(changed, null);
  assert.equal(
    await sourceFingerprint(before, "qrz"),
    await sourceFingerprint(after, "qrz"),
  );
  const [stampOnly] = await lofiInventoryObservations(
    [],
    [{ ...qso, syncedAtMillis: 999 }],
  );
  assert.equal(captured.revision, stampOnly.revision);
});

test("operation running totals do not dirty semantic projections but contact end times and unknown source fields do", async () => {
  const base = { uuid: "op-1", syncedAtMillis: 1, stationCall: "N1RWJ" };
  const [before] = await lofiInventoryObservations([base], []);
  const [after] = await lofiInventoryObservations(
    [
      {
        ...base,
        syncedAtMillis: 2,
        qsoCount: 900,
        startAtMillisMin: 1,
        startAtMillisMax: at,
        endAt: "later",
        endAtMillis: at,
        lastQso: { uuid: "last" },
        lastQSO: "last",
      },
    ],
    [],
  );
  assert.deepEqual(before.semantic, after.semantic);
  const [contact] = await lofiInventoryObservations([], [qso]);
  for (const changed of [
    { ...qso, endAtMillis: at + 1 },
    { ...qso, futureInput: "value" },
  ]) {
    const [next] = await lofiInventoryObservations([], [changed]);
    assert.notDeepEqual(contact.semantic, next.semantic);
  }
});

test("LoFi rejects missing identity, nonnumeric stamps and invalid parent IDs without exposing values", async () => {
  for (const uuid of [undefined, "", " padded ", 7])
    await assert.rejects(
      lofiInventoryObservations([], [{ ...qso, uuid }]),
      fixedError("invalid_lofi_inventory_uuid"),
    );
  for (const syncedAtMillis of [undefined, "100", NaN, Infinity, -1, 1.5])
    await assert.rejects(
      lofiInventoryObservations([], [{ ...qso, syncedAtMillis }]),
      fixedError("invalid_lofi_inventory_server_stamp"),
    );
  for (const operation of ["", 7, {}])
    await assert.rejects(
      lofiInventoryObservations([], [{ ...qso, operation }]),
      fixedError("invalid_lofi_inventory_parent"),
    );
});

test("QRZ preserves exact LOGIDs and contradictory observations without pretending they are ordered revisions", async () => {
  const first = { ...lotw, APP_QRZLOG_LOGID: "000123" };
  const second = { ...first, MY_GRIDSQUARE: "FN42AA" };
  const result = await qrzInventoryObservations([first, second]);
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map(({ key }) => key),
    ["000123", "000123"],
  );
  assert.ok(result.every(({ order }) => order === null));
  assert.notEqual(result[0].revision, result[1].revision);
  assert.deepEqual(result[0].body, first);
  const [large] = await qrzInventoryObservations([
    { APP_QRZLOG_LOGID: "900719925474099312345" },
  ]);
  assert.equal(large.key, "900719925474099312345");
});

test("QRZ canonical hashing is stable under field order and input mutation", async () => {
  const input: AdifRecord = { ...lotw, APP_QRZLOG_LOGID: "123" };
  const pending = qrzInventoryObservations([input]);
  input.CALL = "W2AW";
  const [first] = await pending;
  const [reordered] = await qrzInventoryObservations([
    Object.fromEntries(
      Object.entries({ ...lotw, APP_QRZLOG_LOGID: "123" }).reverse(),
    ),
  ]);
  assert.equal(first.revision, reordered.revision);
  assert.equal((first.body as AdifRecord).CALL, "W1AW");
  for (const id of ["", "-1", "1.5", "123 ", "bad", "1".repeat(65)])
    await assert.rejects(
      qrzInventoryObservations([{ APP_QRZLOG_LOGID: id }]),
      fixedError("invalid_qrz_inventory_logid"),
    );
});

test("LoTW local variant keys retain exact ownership identity, time precision and conflicting detail", async () => {
  const changed = { ...lotw, MY_GRIDSQUARE: "FN42AA" };
  const result = await lotwInventoryObservations([lotw, changed]);
  const identity = await lotwRemoteIdentity(lotw);
  assert.ok(
    result.every(({ key }) => key.startsWith(`lotw-variant-v1:${identity}:`)),
  );
  assert.notEqual(result[0].key, result[1].key);
  assert.ok(result.every(({ order }) => order === null));
  assert.deepEqual(
    result.map(({ body }) => body),
    [lotw, changed],
  );
  const [minute] = await lotwInventoryObservations([
    { ...lotw, TIME_ON: "1305" },
  ]);
  assert.equal((minute.body as AdifRecord).TIME_ON, "1305");
  assert.equal(
    (minute.semantic as { identity: AdifRecord }).identity.TIME_ON,
    "1305",
  );
  assert.notEqual(minute.key, result[0].key);
});

test("LoTW receipt normalization keeps identical observations stable and never merges variants or confirmation patches", async () => {
  const reordered = Object.fromEntries(Object.entries(lotw).reverse());
  const result = await lotwInventoryObservations([lotw, reordered]);
  assert.equal(result[0].key, result[1].key);
  assert.equal(result[0].revision, result[1].revision);
  const [confirmationVariant] = await lotwInventoryObservations([
    { ...lotw, QSL_RCVD: "Y", QSLRDATE: "20261108" },
  ]);
  assert.notEqual(result[0].key, confirmationVariant.key);
  await assert.rejects(
    lotwInventoryObservations([{ QSL_RCVD: "Y", QSLRDATE: "20261108" }]),
    fixedError("invalid_lotw_inventory_identity"),
  );
});

test("LoTW holds invalid or unsupported exact identities instead of inventing aliases", async () => {
  for (const changed of [
    { ...lotw, CALL: "" },
    { ...lotw, STATION_CALLSIGN: "" },
    { ...lotw, QSO_DATE: "20260230" },
    { ...lotw, TIME_ON: "246000" },
    { ...lotw, BAND: "bad" },
    { ...lotw, MODE: "invented" },
    { ...lotw, PROP_MODE: "SAT" },
  ])
    await assert.rejects(
      lotwInventoryObservations([changed]),
      fixedError("invalid_lotw_inventory_identity"),
    );
  await assert.rejects(
    lotwInventoryObservations([{ ...lotw, MODE: "PHONE" }]),
    fixedError("unsupported_lotw_inventory_exact_identity"),
  );
});

test("both remote normalizers reject nonstring ADIF values without serializing them into an identity", async () => {
  const invalid = { ...lotw, APP_QRZLOG_LOGID: 123 } as unknown as AdifRecord;
  for (const normalize of [qrzInventoryObservations, lotwInventoryObservations])
    await assert.rejects(
      normalize([invalid]),
      fixedError("invalid_inventory_adif_field"),
    );
});
