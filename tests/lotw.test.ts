import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { serializeAdifRecord, type AdifRecord } from "../src/adif.ts";
import {
  boundedResponse,
  LotwClient,
  observeLotwContact,
  parseLotwReport,
  parseUploadResponse,
} from "../src/lotw.ts";
import type { LotwContact, LotwStation } from "../src/signing.ts";
const vector: { station: LotwStation; contact: LotwContact } = JSON.parse(
  readFileSync(
    new URL("../fixtures/signing/vector.json", import.meta.url),
    "utf8",
  ),
);
const record = {
  CALL: "K1ABC",
  STATION_CALLSIGN: "W1AW",
  BAND: "20m",
  MODE: "FT8",
  QSO_DATE: "20261022",
  TIME_ON: "123456",
  QSL_RCVD: "N",
  MY_DXCC: "291",
  MY_GRIDSQUARE: "FN31pr",
  MY_STATE: "CT",
  MY_CNTY: "CT,Tolland",
  MY_CQ_ZONE: "5",
  MY_ITU_ZONE: "8",
  FREQ: "14.07400",
};
const report = (records: AdifRecord[] = [record]) =>
  `<PROGRAMID:4>LoTW<APP_LoTW_LASTQSORX:19>2026-10-22 13:00:00<APP_LoTW_NUMREC:${String(records.length).length}>${records.length}<EOH>${records.map(serializeAdifRecord).join("\n")}<APP_LoTW_EOF>`;

test("LoTW report inventories accepted unconfirmed QSOs with own location and server receive cursor", () => {
  const parsed = parseLotwReport(report());
  assert.equal(parsed.records[0]!.QSL_RCVD, "N");
  assert.equal(parsed.receivedThrough, "2026-10-22 13:00:00");
  assert.equal(parsed.complete, true);
  assert.equal(parseLotwReport(report([])).records.length, 0);
  assert.equal(
    observeLotwContact(vector.station, vector.contact, parsed).state,
    "observed",
  );
  assert.equal(
    observeLotwContact(vector.station, vector.contact, parsed).confirmed,
    false,
  );
  assert.equal(
    observeLotwContact(
      vector.station,
      vector.contact,
      parseLotwReport(report([{ ...record, QSL_RCVD: "Y" }])),
    ).confirmed,
    true,
  );
});
test("HTML, missing EOF, partial records, missing own callsign and inconsistent counts never establish absence", () => {
  for (const input of [
    "<html>Login failed</html>",
    report().replace("<APP_LoTW_EOF>", ""),
    report().replace("<EOR>", ""),
    report().replace("<APP_LoTW_NUMREC:1>1", "<APP_LoTW_NUMREC:1>2"),
    report().replace("<STATION_CALLSIGN:4>W1AW", ""),
  ])
    assert.throws(() => parseLotwReport(input));
});
test("LoTW observations require precise identity and supported location/frequency revision", () => {
  const parsed = parseLotwReport(report());
  assert.equal(
    observeLotwContact(
      { ...vector.station, grid: "FN32" },
      vector.contact,
      parsed,
    ).state,
    "projection_mismatch",
  );
  assert.equal(
    observeLotwContact(
      vector.station,
      { ...vector.contact, frequencyMHz: "14.075" },
      parsed,
    ).state,
    "projection_mismatch",
  );
  assert.equal(
    observeLotwContact(
      vector.station,
      { ...vector.contact, call: "K2ABC" },
      parsed,
    ).state,
    "absent",
  );
  assert.equal(
    observeLotwContact(
      vector.station,
      vector.contact,
      parseLotwReport(report([{ ...record, TIME_ON: "1234" }])),
    ).state,
    "ambiguous",
  );
  assert.equal(
    observeLotwContact(
      vector.station,
      vector.contact,
      parseLotwReport(report([record, record])),
    ).state,
    "ambiguous",
  );
  assert.equal(
    observeLotwContact(
      vector.station,
      { ...vector.contact, mode: "MFSK", submode: "FT4" },
      parseLotwReport(report([{ ...record, MODE: "MFSK", SUBMODE: "FT4" }])),
    ).state,
    "observed",
  );
});
test("query requests all accepted records, own detail and explicit replay boundary without logging credentials", async () => {
  let calls = 0;
  const client = new LotwClient(
    { username: "synthetic", password: "never-log-me" },
    {
      fetcher: async (input, init) => {
        calls++;
        const url = new URL(String(input));
        assert.equal(url.origin, "https://lotw.arrl.org");
        assert.equal(url.searchParams.get("qso_qsl"), "no");
        assert.equal(url.searchParams.get("qso_qsorxsince"), "1900-01-01");
        assert.equal(url.searchParams.get("qso_mydetail"), "yes");
        assert.equal(url.searchParams.get("qso_withown"), "yes");
        assert.equal(init?.redirect, "error");
        return new Response(report());
      },
    },
  );
  assert.equal(
    (await client.query({ startDate: "2026-10-01", endDate: "2026-10-31" }))
      .records.length,
    1,
  );
  await assert.rejects(
    client.query({ startDate: "2026-01-01", endDate: "2026-12-31" }),
    /partition/,
  );
  assert.equal(calls, 1);
  const failed = new LotwClient(
    { username: "synthetic", password: "never-log-me" },
    {
      fetcher: async (input) => {
        throw new Error(String(input));
      },
    },
  );
  await assert.rejects(
    failed.query({ startDate: "2026-10-01", endDate: "2026-10-31" }),
    (error: Error) => !error.message.includes("never-log-me"),
  );
});
test("upload acknowledges submission separately; timeouts and unknown responses remain uncertain", async () => {
  assert.deepEqual(parseUploadResponse("<!-- .UPL. accepted -->"), {
    state: "submitted",
    code: "queue_acknowledged",
  });
  assert.equal(
    parseUploadResponse("<!-- .UPL. rejected -->").state,
    "rejected",
  );
  assert.equal(
    parseUploadResponse("<!-- .UPL. accepted --><!-- .UPL. rejected -->").state,
    "uncertain",
  );
  assert.equal(parseUploadResponse("HTTP 200 OK").state, "uncertain");
  let calls = 0;
  const artifact = new Uint8Array([0x1f, 0x8b, 0x08]);
  const client = new LotwClient(null, {
    exportsEnabled: true,
    fetcher: async (input, init) => {
      calls++;
      assert.equal(input, "https://lotw.arrl.org/lotw/upload");
      assert.equal(init?.method, "POST");
      assert.ok(init.body instanceof FormData);
      const upload = init.body.get("upfile");
      assert.ok(upload instanceof File);
      assert.equal(upload.name, "lofi-qso-ferry.tq8");
      assert.deepEqual(new Uint8Array(await upload.arrayBuffer()), artifact);
      return new Response("<!-- .UPL. accepted -->");
    },
  });
  await assert.rejects(
    client.submit(artifact, { liveWriteAuthorized: false }),
    /disabled/,
  );
  assert.equal(calls, 0);
  assert.equal(
    (await client.submit(artifact, { liveWriteAuthorized: true })).state,
    "submitted",
  );
  const timeout = new LotwClient(null, {
    exportsEnabled: true,
    fetcher: async () => {
      throw new Error("timeout");
    },
  });
  assert.equal(
    (await timeout.submit(artifact, { liveWriteAuthorized: true })).state,
    "uncertain",
  );
  await assert.rejects(
    new LotwClient(null).submit(artifact, { liveWriteAuthorized: true }),
    /disabled/,
  );
});
test("certificate status errors/unknown XML are never represented as valid", async () => {
  for (const [body, status] of [
    ["<Status>Unrevoked</Status>", "unrevoked"],
    ["<Status>Superceded</Status>", "superseded"],
    ["<Status>Revoked</Status>", "revoked"],
    ["<html>error</html>", "unknown"],
    ["<Status>Unrevoked</Status><Status>Revoked</Status>", "unknown"],
  ] as const) {
    const client = new LotwClient(null, {
      fetcher: async () => new Response(body),
    });
    assert.equal(await client.certificateStatus("123"), status);
  }
});
test("large streamed reports fail with incomplete evidence rather than materializing unbounded data", async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(100));
        controller.close();
      },
    }),
  );
  await assert.rejects(boundedResponse(response, 20), /bounded partition/);
});

test("readback precision cannot falsely acknowledge a one-Hz frequency correction", () => {
  const parsed = parseLotwReport(report([{ ...record, FREQ: "14.07412" }]));
  const observation = observeLotwContact(
    vector.station,
    { ...vector.contact, frequencyMHz: "14.074123" },
    parsed,
  );
  assert.equal(observation.state, "insufficient_evidence");
  assert.deepEqual(observation.unverifiableFields, ["FREQ"]);
});
