import assert from "node:assert/strict";
import test from "node:test";
import {
  type AdifRecord,
  parseAdif,
  serializeAdifRecord,
} from "../src/adif.ts";
import {
  ClubLogClient,
  ClubLogError,
  clublogIdentity,
  clublogRecord,
  clublogRemoteIdentity,
  matchClublogHistory,
} from "../src/clublog.ts";
import type { Contact } from "../src/projection.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";

const credentials = {
  email: "user@example.invalid",
  password: "private-user-password",
  callsign: "N0TEST/P",
};
const apiKey = "private-developer-key";
const record: AdifRecord = {
  STATION_CALLSIGN: credentials.callsign,
  CALL: "W1AW",
  QSO_DATE: "20261022",
  TIME_ON: "120001",
  BAND: "20M",
  MODE: "CW",
  FREQ: "14.025",
  OPERATOR: "N0TEST",
  RST_SENT: "599",
  RST_RCVD: "579",
};
const contact: Contact = {
  id: "qso1",
  operationId: "op1",
  call: "W1AW",
  stationCall: credentials.callsign,
  startAtMillis: Date.parse("2026-10-22T12:00:01Z"),
  timePrecision: "second",
  band: "20m",
  mode: "CW",
  frequencyMHz: 14.025,
  operatorCall: "N0TEST",
  rstSent: "599",
  rstReceived: "579",
  ownParks: ["US-0001"],
  workedParks: [],
  grid: "FN31",
  state: "CT",
  county: "Fairfield",
  notes: "Private note",
  deleted: false,
  context: { qso: {}, op: {} },
  generation: "g1",
};
const document = (records: AdifRecord[]) =>
  `<ADIF_VER:5>3.1.6<PROGRAMID:7>ClubLog<EOH>\n${records.map(serializeAdifRecord).join("\n")}\n`;
const outcome = (kind: ClubLogError["kind"]) => (error: unknown) =>
  error instanceof ClubLogError && error.kind === kind;

test("Club Log projection only includes retained structured fields and binds the account", () => {
  assert.deepEqual(clublogRecord(contact), record);
  assert.equal(
    clublogRecord({ ...contact, mode: "SSB", submode: "USB" }).MODE,
    "SSB",
  );
  assert.equal(
    clublogRecord({ ...contact, mode: "SSB", submode: "LSB" }).MODE,
    "SSB",
  );
  assert.deepEqual(
    clublogRecord({ ...contact, grid: "FN32", notes: "changed", ownParks: [] }),
    record,
  );
  assert.throws(
    () => clublogRecord({ ...contact, mode: "MFSK", submode: "FT4" }),
    outcome("blocked"),
  );
  assert.throws(
    () =>
      clublogRecord({ ...contact, startAtMillis: contact.startAtMillis + 1 }),
    outcome("blocked"),
  );
  assert.throws(
    () => clublogRecord({ ...contact, deleted: true }),
    outcome("blocked"),
  );
});

test("Club Log remote identity is stable and retains time precision, mode and station", async () => {
  const id = await clublogRemoteIdentity(record);
  assert.equal(
    await clublogRemoteIdentity({
      ...record,
      CALL: "w1aw",
      BAND: "20m",
      NOTES: "different",
    }),
    id,
  );
  const changes: AdifRecord[] = [
    { TIME_ON: "1200" },
    { MODE: "SSB" },
    { STATION_CALLSIGN: "N0TEST" },
  ];
  for (const change of changes)
    assert.notEqual(await clublogRemoteIdentity({ ...record, ...change }), id);
  assert.throws(
    () => clublogIdentity({ ...record, QSO_DATE: "20260230" }),
    outcome("protocol"),
  );
});

test("Club Log history adoption ignores unrelated inventory and remote-owned fields", () => {
  const observed = {
    ...record,
    FREQ: "14.025000",
    NOTES: "Remote narrative",
    QSL_RCVD: "Y",
    DXCC: "291",
  };
  assert.equal(
    matchClublogHistory(record, [{ ...record, CALL: "K1ABC" }, observed]).state,
    "adopted_existing",
  );
  assert.equal(
    matchClublogHistory(record, [{ ...record, CALL: "K1ABC" }]).state,
    "missing_current_identity",
  );
  assert.equal(
    matchClublogHistory(record, [{ ...record, QSO_DATE: "20261023" }]).state,
    "missing_current_identity",
  );
  assert.equal(
    matchClublogHistory(record, []).state,
    "missing_current_identity",
  );
});

test("Club Log history never adopts duplicate, approximate or conflicting observations", () => {
  for (const records of [
    [record, record],
    [{ ...record, TIME_ON: "1200" }],
    [{ ...record, MODE: "SSB" }],
    [{ ...record, TIME_ON: "120002" }],
    [record, { ...record, TIME_ON: "120002" }],
    [{ ...record, FREQ: "" }],
    [{ ...record, OPERATOR: "" }],
  ])
    assert.equal(
      matchClublogHistory(record, records).state,
      "history_ambiguous",
    );
  assert.equal(
    matchClublogHistory(record, [{ ...record, FREQ: "14.026" }]).state,
    "history_mismatch",
  );
  assert.equal(
    matchClublogHistory(record, [{ ...record, RST_RCVD: "599" }]).state,
    "history_mismatch",
  );
});

test("Club Log strict correction matching rejects remotely retained optional fields absent locally", () => {
  for (const field of ["FREQ", "OPERATOR", "RST_SENT", "RST_RCVD"]) {
    const local = { ...record };
    delete local[field];
    assert.equal(
      matchClublogHistory(local, [record]).state,
      "adopted_existing",
    );
    assert.equal(
      matchClublogHistory(local, [record], { strictAbsence: true }).state,
      "history_mismatch",
    );
    assert.equal(
      matchClublogHistory(local, [local], { strictAbsence: true }).state,
      "adopted_existing",
    );
  }
});

test("Club Log downloads are read-only, account-bound and do not require an application key", async () => {
  let requests = 0;
  const client = new ClubLogClient(credentials, {
    fetcher: async (input, init) => {
      requests++;
      assert.equal(input, "https://clublog.org/getadif.php");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "manual");
      assert.ok(init?.signal);
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("call"), credentials.callsign);
      assert.equal(body.get("email"), credentials.email);
      assert.equal(body.get("password"), credentials.password);
      assert.equal(body.get("api"), null);
      assert.equal(body.get("type"), null);
      assert.equal(body.get("clear"), null);
      const { STATION_CALLSIGN: _station, ...remote } = record;
      return new Response(document([remote]), {
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      });
    },
  });
  assert.deepEqual(await client.download(), [record]);
  assert.deepEqual(await client.verifyLogin(), {
    callsign: credentials.callsign,
    recordCount: 1,
  });
  assert.equal(requests, 2);
});

test("Club Log accepts framed empty inventories but not empty or truncated responses", async () => {
  assert.deepEqual(
    await new ClubLogClient(credentials, {
      fetch: async () => new Response(document([])),
    }).download(),
    [],
  );
  for (const body of [
    "",
    "Access denied",
    "<html><body>login</body></html>",
    serializeAdifRecord(record),
    document([record]).replace(/<EOR>\n$/, ""),
    `${document([record])}truncated`,
    "<ADIF_VER:5>3.1.6<EOH><CALL:99>W1AW",
  ])
    await assert.rejects(
      new ClubLogClient(credentials, {
        fetch: async () => new Response(body),
      }).download(),
      ClubLogError,
    );
});

test("Club Log downloads reject inconsistent identity, size and HTTP framing", async () => {
  const responses = [
    new Response(document([{ ...record, STATION_CALLSIGN: "N0OTHER" }])),
    new Response(document([{ ...record, TIME_ON: "996001" }])),
    new Response(document([record]), { status: 206 }),
    new Response(document([record]), { headers: { "Content-Length": "9999" } }),
    new Response("x", { headers: { "Content-Length": "2097153" } }),
    new Response("x".repeat(2 * 1024 * 1024 + 1)),
    new Response(new Uint8Array([0xc3, 0x28])),
  ];
  for (const response of responses)
    await assert.rejects(
      new ClubLogClient(credentials, {
        fetch: async () => response,
      }).download(),
      ClubLogError,
    );
});

test("Club Log enforces disabled writes, application key, authorization and account before dispatch", async () => {
  const fetcher: typeof fetch = async () => {
    throw new Error("must not dispatch");
  };
  for (const options of [
    { apiKey, fetcher },
    { writesEnabled: true, fetcher },
    { apiKey, writesEnabled: true, fetcher, beforeWrite: async () => false },
  ])
    await assert.rejects(
      new ClubLogClient(credentials, options).upload(record),
      outcome("blocked"),
    );
  const client = new ClubLogClient(credentials, {
    apiKey,
    writesEnabled: true,
    fetcher,
  });
  await assert.rejects(
    client.upload({ ...record, STATION_CALLSIGN: "N0OTHER" }),
    outcome("blocked"),
  );
  await assert.rejects(
    client.upload({ ...record, QSLCALL: "N0TEST" }),
    outcome("blocked"),
  );
  await assert.rejects(
    client.upload({ ...record, QSL_RCVD: "Y" }),
    outcome("blocked"),
  );
});

test("Club Log live upload uses the realtime API and retains duplicate as a separate result", async () => {
  for (const [receipt, expected] of [
    ["OK", "accepted"],
    ["QSO OK", "accepted"],
    ["QSO Duplicate - OK", "duplicate"],
  ]) {
    const client = new ClubLogClient(credentials, {
      apiKey,
      writesEnabled: true,
      fetch: async (input, init) => {
        assert.equal(input, "https://clublog.org/realtime.php");
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get("api"), apiKey);
        assert.equal(body.get("callsign"), credentials.callsign);
        assert.equal(body.get("clear"), null);
        const uploaded = parseAdif(body.get("adif")!).records[0];
        assert.equal(uploaded.CALL, record.CALL);
        assert.equal(uploaded.STATION_CALLSIGN, undefined);
        return new Response(receipt, {
          headers: { "Content-Type": "text/html; charset=UTF-8" },
        });
      },
    });
    assert.deepEqual(await client.upload(record), { state: expected });
  }
});

test("Club Log background upload uses merge-only multipart and only acknowledges submission", async () => {
  const client = new ClubLogClient(credentials, {
    apiKey,
    writesEnabled: true,
    fetcher: async (input, init) => {
      assert.equal(input, "https://clublog.org/putlogs.php");
      assert.ok(init?.body instanceof FormData);
      const body = init.body;
      assert.equal(body.get("clear"), null);
      assert.equal(body.get("adif"), null);
      assert.equal(body.get("api"), apiKey);
      const file = body.get("file");
      assert.ok(file instanceof Blob);
      const exported = parseAdif(await file.text());
      assert.equal(exported.records.length, 1);
      assert.equal(exported.header.PROGRAMID, "LoFiQSOFerry");
      assert.equal(new Headers(init.headers).has("Content-Type"), false);
      return new Response("OK");
    },
  });
  assert.deepEqual(await client.upload(record, "background"), {
    state: "submitted",
  });
});

test("Club Log credential and rejection failures suspend the client without exposing vendor text", async () => {
  for (const response of [
    new Response(`${credentials.password} ${apiKey}`, { status: 403 }),
    new Response(`${credentials.password} ${apiKey}`, { status: 400 }),
    new Response(`Access denied: ${credentials.password}`),
    new Response(`QSO Rejected: ${apiKey}`),
  ]) {
    let calls = 0;
    const client = new ClubLogClient(credentials, {
      apiKey,
      writesEnabled: true,
      fetch: async () => {
        calls++;
        return response;
      },
    });
    await assert.rejects(client.upload(record), (error: unknown) => {
      assert.ok(error instanceof ClubLogError);
      assert.equal(error.suspend, true);
      assert.doesNotMatch(error.message, /private-|user@example/);
      return true;
    });
    await assert.rejects(client.download(), outcome("blocked"));
    assert.equal(calls, 1);
  }
});

test("Club Log lost, redirected, oversized and unrecognized mutation receipts are uncertain, without retry", async () => {
  for (const transport of [
    async () => {
      throw new Error(credentials.password);
    },
    async () => new Response("unknown"),
    async () => new Response("Error: processing outcome unavailable"),
    async () => new Response("FAIL: receipt could not be created"),
    async () =>
      new Response("<html>OK</html>", {
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      }),
    async () => new Response("x".repeat(8193)),
    async () =>
      new Response("redirect", {
        status: 302,
        headers: { Location: "https://other.invalid" },
      }),
    async () => new Response("unavailable", { status: 503 }),
  ]) {
    let calls = 0;
    const client = new ClubLogClient(credentials, {
      apiKey,
      writesEnabled: true,
      fetch: async () => {
        calls++;
        return transport();
      },
    });
    await assert.rejects(client.upload(record), outcome("uncertain"));
    assert.equal(calls, 1);
  }
});

test("Club Log stops after every non-200 response without assuming a mutation failed", async () => {
  for (const status of [201, 206, 302, 429, 500, 503]) {
    let calls = 0;
    const client = new ClubLogClient(credentials, {
      apiKey,
      writesEnabled: true,
      fetch: async () => {
        calls++;
        return new Response("private-vendor-error", { status });
      },
    });
    await assert.rejects(client.upload(record), (error: unknown) => {
      assert.ok(error instanceof ClubLogError);
      assert.equal(error.suspend, true);
      assert.equal(error.kind, status === 429 ? "rejected" : "uncertain");
      assert.doesNotMatch(error.message, /private-/);
      return true;
    });
    await assert.rejects(client.download(), outcome("blocked"));
    assert.equal(calls, 1);
  }
});

test("Club Log preserves unsent budget deferrals and suspends after sent throttle responses", async () => {
  const deferred = new VendorDeferredError(Date.now() + 300000);
  const client = new ClubLogClient(credentials, {
    apiKey,
    writesEnabled: true,
    fetch: async () => {
      throw deferred;
    },
  });
  await assert.rejects(client.download(), (error) => error === deferred);
  await assert.rejects(client.upload(record), (error) => error === deferred);

  for (const mutating of [false, true]) {
    let calls = 0;
    const client = new ClubLogClient(credentials, {
      apiKey,
      writesEnabled: true,
      fetch: async () => {
        calls++;
        throw new VendorDeferredError(Date.now() + 300000, true);
      },
    });
    await assert.rejects(
      mutating ? client.upload(record) : client.download(),
      (error: unknown) => {
        assert.ok(error instanceof ClubLogError);
        assert.equal(error.suspend, true);
        assert.equal(error.kind, mutating ? "uncertain" : "transient");
        return true;
      },
    );
    await assert.rejects(client.download(), outcome("blocked"));
    assert.equal(calls, 1);
  }
});

test("Club Log deletes are exact single-QSO operations with no clear flag", async () => {
  for (const [receipt, deleted] of [
    ["QSO OK", true],
    ["QSO Not Deleted", false],
  ] as const) {
    const client = new ClubLogClient(credentials, {
      apiKey,
      writesEnabled: true,
      fetch: async (input, init) => {
        assert.equal(input, "https://clublog.org/delete.php");
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get("datetime"), "2026-10-22 12:00:01");
        assert.equal(body.get("dxcall"), "W1AW");
        assert.equal(body.get("bandid"), "20");
        assert.equal(body.get("clear"), null);
        return new Response(receipt);
      },
    });
    assert.deepEqual(await client.delete(clublogIdentity(record)), { deleted });
    await assert.rejects(
      client.delete({ ...clublogIdentity(record), time: "1200" }),
      outcome("blocked"),
    );
  }
});
