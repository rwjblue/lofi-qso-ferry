import assert from "node:assert/strict";
import test from "node:test";
import { serializeAdifRecord } from "../src/adif.ts";
import { destinationAdapter } from "../src/destination-adapters.ts";
import { projectContact, sourceFingerprint } from "../src/projection.ts";
import {
  destinationKinds,
  isDestinationKind,
  providerDefinitions,
} from "../src/providers.ts";
import { routeMatches } from "../src/service.ts";
import type { Connection } from "../src/store.ts";

const contact = () =>
  projectContact(
    {
      uuid: "q1",
      operation: "op1",
      startAtMillis: Date.parse("2026-10-22T12:00:01Z"),
      freq: 14074,
      band: "20m",
      mode: "FT8",
      their: { call: "W1AW", sent: "-10" },
      our: { sent: "-09", dxccCode: 291 },
      notes: "original narrative",
    },
    {
      uuid: "op1",
      stationCall: "N0CALL/P",
      grid: "FN31AA",
      state: "CT",
      county: "Fairfield",
    },
    [],
    { operationComplete: true },
  );

test("registered destinations preserve account routing while source and unknown kinds cannot route", async () => {
  const projected = await contact();
  assert.deepEqual(destinationKinds, ["qrz", "lotw", "clublog"]);
  for (const kind of destinationKinds) {
    assert.equal(destinationAdapter(kind).kind, kind);
    assert.equal(providerDefinitions[kind].role, "destination");
  }
  assert.equal(isDestinationKind("lofi"), false);
  assert.equal(isDestinationKind("toString"), false);
  const connection = (kind: string, config: unknown) =>
    ({ kind, config: JSON.stringify(config) }) as Connection;
  assert.equal(
    routeMatches(
      connection("clublog", { stationCallsign: "N0CALL/P" }),
      projected,
    ),
    true,
  );
  assert.equal(
    routeMatches(
      connection("clublog", { stationCallsign: "N0CALL" }),
      projected,
    ),
    false,
  );
  assert.equal(
    routeMatches(
      connection("lofi", { station: { callsign: "N0CALL/P" } }),
      projected,
    ),
    false,
  );
  assert.equal(
    routeMatches(
      connection("unknown", { station: { callsign: "N0CALL/P" } }),
      projected,
    ),
    false,
  );
  const qrz = {
    stationCallsign: "N0CALL/P",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
  };
  assert.equal(routeMatches(connection("qrz", qrz), projected), true);
  assert.equal(
    routeMatches(
      connection("qrz", { ...qrz, endDate: "2026-10-21" }),
      projected,
    ),
    false,
  );
  assert.equal(
    routeMatches(
      connection("lotw", { stations: [{ callsign: "N0CALL/P", dxcc: 291 }] }),
      projected,
    ),
    true,
  );
  assert.equal(
    routeMatches(
      connection("lotw", { stations: [{ callsign: "N0CALL/P", dxcc: 1 }] }),
      projected,
    ),
    false,
  );
});

test("existing QRZ and LoTW fingerprints remain byte-for-byte stable", async () => {
  const projected = await contact();
  // Captured from the unmodified implementation before introducing the registry.
  assert.equal(
    await sourceFingerprint(projected, "qrz"),
    "3f46a4be5aa94d7c0dc0f16cd57399a9911a3fd41253ac03e8fcf66cf54013e0",
  );
  assert.equal(
    await sourceFingerprint(projected, "qrz", true),
    "5b2d181be91ba61922c4a5e6572eb22bfd90133c1fd49c7034057dbe96031a96",
  );
  assert.equal(
    await sourceFingerprint(projected, "lotw"),
    "10b9fd241a4003856e3f6f65e75d68c0a90ca766fa8f790b55c37c86b8b24181",
  );
});

test("Club Log fingerprints react only to its supported projection and deletion", async () => {
  const projected = await contact();
  const original = await sourceFingerprint(projected, "clublog");
  assert.equal(
    await sourceFingerprint(
      { ...projected, notes: "changed", grid: "FN42", ownParks: ["US-1111"] },
      "clublog",
    ),
    original,
  );
  assert.notEqual(
    await sourceFingerprint({ ...projected, rstSent: "-05" }, "clublog"),
    original,
  );
  assert.notEqual(
    await sourceFingerprint({ ...projected, call: "K1ABC" }, "clublog"),
    original,
  );
  assert.notEqual(
    await sourceFingerprint({ ...projected, deleted: true }, "clublog"),
    original,
  );
  const fields = destinationAdapter("clublog").project(projected);
  assert.equal(
    Object.keys(fields).some((key) => key.startsWith("MY_")),
    false,
  );
});

test("Club Log adapter reads authenticated full history without enabling writes", async () => {
  const adapter = destinationAdapter("clublog");
  const projected = await contact();
  const record = adapter.project(projected);
  let reads = 0;
  const history = await adapter.readHistory(
    {
      email: "operator@example.test",
      password: "test-secret",
      callsign: projected.stationCall,
    },
    projected,
    record,
    {
      fetcher: async (input) => {
        assert.equal(new URL(String(input)).pathname, "/getadif.php");
        reads++;
        return new Response(
          `<ADIF_VER:5>3.1.6<EOH>\n${serializeAdifRecord(record)}`,
        );
      },
    },
  );
  assert.equal(reads, 1);
  assert.equal(history.readAccess, true);
  assert.equal(
    adapter.matchHistory(record, history.records).state,
    "adopted_existing",
  );
  const unavailable = await adapter.readHistory(null, projected, record, {
    fetcher: async () => {
      throw new Error("No credential must not fetch");
    },
  });
  assert.deepEqual(unavailable, { records: [], readAccess: false });
  await assert.rejects(
    adapter.readHistory(
      {
        email: "operator@example.test",
        password: "test-secret",
        callsign: "N0OTHER",
      },
      projected,
      record,
      {
        fetcher: async () => {
          throw new Error("Mismatched account must not fetch");
        },
      },
    ),
    /credential route changed/,
  );
});
