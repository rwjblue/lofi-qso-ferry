import test from "node:test";
import assert from "node:assert/strict";
import {
  QrzClient,
  QrzError,
  parseQrzResponse,
  mergeQrzCorrection,
  matchQrzHistory,
  mayCleanOldQrzIdentity,
} from "../src/qrz.ts";
import { parseAdif, serializeAdifRecord } from "../src/adif.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";
const contact = {
  STATION_CALLSIGN: "N0TEST/P",
  CALL: "W1AW",
  QSO_DATE: "20261022",
  TIME_ON: "120001",
  BAND: "20m",
  MODE: "CW",
  MY_GRIDSQUARE: "FN31",
  COMMENT: "Original private narrative",
};
const remote = {
  ...contact,
  APP_QRZLOG_LOGID: "40",
  QSL_RCVD: "Y",
  NAME: "Operator",
  APP_OTHER_NARRATIVE: "retain application data",
  APP_QRZLOG_STATUS: "C",
  QSLMSG: "old qsl",
  NOTES: "old notes",
};
const encode = (data: Record<string, string>) =>
  new Response(new URLSearchParams(data).toString());
test("QRZ preserves typed transport deferrals for reads and uploads", async () => {
  const deferred = new VendorDeferredError(Date.now() + 300000);
  const client = new QrzClient("synthetic", {
    writesEnabled: true,
    fetch: async () => {
      throw deferred;
    },
  });
  await assert.rejects(client.status(), (error) => error === deferred);
  await assert.rejects(client.insert(contact), (error) => error === deferred);
});
test("QRZ responses decode narrative form values exactly once", () => {
  const adif = serializeAdifRecord({ COMMENT: "A & B + C = 100%" });
  assert.equal(
    parseQrzResponse(
      new URLSearchParams({ RESULT: "OK", ADIF: adif }).toString(),
    ).ADIF,
    adif,
  );
  assert.throws(() => parseQrzResponse("RESULT=OK&RESULT=FAIL"));
  assert.throws(() => parseQrzResponse("<html>error</html>"));
});
test("page completion depends on parsed records, not global COUNT", async () => {
  const requests: URLSearchParams[] = [];
  const client = new QrzClient("secret", {
    fetch: async (input, init) => {
      assert.equal(input, "https://logbook.qrz.com/api");
      assert.equal(init?.method, "POST");
      assert.match(
        new Headers(init?.headers).get("User-Agent")!,
        /^LoFiQSOFerry\//,
      );
      requests.push(new URLSearchParams(String(init?.body)));
      return encode({
        RESULT: "OK",
        COUNT: "1000",
        ADIF: serializeAdifRecord(remote),
      });
    },
  });
  const page = await client.fetchPage();
  assert.equal(page.nextAfterLogId, null);
  assert.equal(page.count, 1000);
  assert.equal(requests[0]!.get("OPTION"), "TYPE:ADIF,MAX:250,AFTERLOGID:0");
});
test("full pages resume using highest logid plus one", async () => {
  const client = new QrzClient("secret", {
    fetch: async () =>
      encode({ RESULT: "OK", COUNT: "99", ADIF: serializeAdifRecord(remote) }),
  });
  assert.equal((await client.fetchPage({ max: 1 })).nextAfterLogId, 41);
});
test("generic FAIL and authentication failure cannot authorize empty inventory", async () => {
  for (const result of ["FAIL", "AUTH"]) {
    const client = new QrzClient("secret", {
      fetch: async () => encode({ RESULT: result, REASON: "no matches" }),
    });
    await assert.rejects(client.fetchPage(), QrzError);
  }
  const empty = new QrzClient("secret", {
    fetch: async () => encode({ RESULT: "OK", COUNT: "0", ADIF: "" }),
  });
  assert.deepEqual((await empty.fetchPage()).records, []);
});
test("adoption requires exact precision and own location, leaves narrative untouched", () => {
  assert.equal(matchQrzHistory(contact, [remote]).state, "adopted_existing");
  assert.equal(
    matchQrzHistory(contact, [{ ...remote, TIME_ON: "1200" }]).state,
    "history_ambiguous",
  );
  assert.equal(
    matchQrzHistory(contact, [{ ...remote, MY_GRIDSQUARE: "FN32" }]).state,
    "history_mismatch",
  );
  assert.equal(
    matchQrzHistory(contact, [{ ...remote, MY_GRIDSQUARE: "" }]).state,
    "history_ambiguous",
  );
  assert.equal(
    matchQrzHistory(contact, [remote, remote]).state,
    "history_ambiguous",
  );
  assert.equal(matchQrzHistory(contact, []).state, "missing_current_identity");
});
test("structured correction preserves adopted narrative and remote-owned fields", () => {
  const merged = mergeQrzCorrection(
    remote,
    { ...contact, COMMENT: "new template", MY_GRIDSQUARE: "FN32" },
    "remote_preserved",
  );
  assert.equal(merged.COMMENT, remote.COMMENT);
  assert.equal(merged.QSLMSG, remote.QSLMSG);
  assert.equal(merged.NOTES, remote.NOTES);
  assert.equal(merged.NAME, "Operator");
  assert.equal(merged.APP_OTHER_NARRATIVE, "retain application data");
  assert.equal(merged.MY_GRIDSQUARE, "FN32");
  assert.equal(merged.APP_QRZLOG_LOGID, undefined);
  assert.equal(merged.QSL_RCVD, undefined);
  assert.equal(
    mergeQrzCorrection(
      remote,
      { ...contact, COMMENT: "pinned template" },
      "template_bound",
    ).COMMENT,
    "pinned template",
  );
});
test("plain INSERT never escalates duplicate responses to REPLACE", async () => {
  let calls = 0;
  const client = new QrzClient("secret", {
    writesEnabled: true,
    fetch: async (_, init) => {
      calls++;
      assert.equal(new URLSearchParams(String(init?.body)).get("OPTION"), null);
      return encode({ RESULT: "FAIL", REASON: "duplicate", COUNT: "0" });
    },
  });
  await assert.rejects(client.insert(contact), /rejected/);
  assert.equal(calls, 1);
});
test("writes default disabled and replacement requires verified contract", async () => {
  const client = new QrzClient("secret", {
    fetch: async () => {
      throw new Error("Should not request");
    },
  });
  await assert.rejects(client.insert(contact), /disabled/);
  await assert.rejects(
    client.replaceSafely("40", contact, "remote_preserved"),
    /scoped live/,
  );
});
test("lost or malformed mutation response stays uncertain", async () => {
  for (const transport of [
    async () => {
      throw new Error("connection reset");
    },
    async () => new Response("bad"),
  ]) {
    const client = new QrzClient("secret", {
      writesEnabled: true,
      fetch: transport,
    });
    await assert.rejects(
      client.insert(contact),
      (error: unknown) =>
        error instanceof QrzError && error.kind === "uncertain",
    );
  }
});
test("cleanup requires Ferry creation, durable new receipt, changed ID and fresh evidence", () => {
  const evidence = {
    oldProvenance: "ferry_created",
    newAcknowledged: true,
    oldLogId: "1",
    newLogId: "2",
    freshOldIdentityMatches: true,
  };
  assert.equal(mayCleanOldQrzIdentity(evidence), true);
  for (const altered of [
    { oldProvenance: "adopted" },
    { newAcknowledged: false },
    { newLogId: "1" },
    { freshOldIdentityMatches: false },
  ])
    assert.equal(mayCleanOldQrzIdentity({ ...evidence, ...altered }), false);
});
test("book linking requires station, book and full date-range evidence", async () => {
  const expected = {
    bookId: "7",
    stationCallsign: "N0TEST/P",
    startDate: "2020-01-01",
    endDate: "2030-01-01",
  };
  const good = new QrzClient("secret", {
    fetch: async () =>
      encode({
        RESULT: "OK",
        DATA: "BOOKID=7&CALLSIGN=N0TEST/P&STARTDATE=2020-01-01&ENDDATE=2030-01-01",
      }),
  });
  assert.deepEqual(await good.verifyBook(expected), expected);
  await assert.rejects(
    good.verifyBook({ ...expected, stationCallsign: "N0TEST" }),
    /identity/,
  );
  const incomplete = new QrzClient("secret", {
    fetch: async () => encode({ RESULT: "OK", DATA: "BOOKID=7" }),
  });
  await assert.rejects(incomplete.verifyBook(expected), /identity/);
});
test("verified replacement fetches and merges a unique current mapped record", async () => {
  const bodies: URLSearchParams[] = [];
  const client = new QrzClient("secret", {
    writesEnabled: true,
    replacementContractVerified: true,
    fetch: async (_, init) => {
      const body = new URLSearchParams(String(init?.body));
      bodies.push(body);
      if (body.get("ACTION") === "FETCH")
        return encode({
          RESULT: "OK",
          COUNT: "1",
          ADIF: serializeAdifRecord(remote),
        });
      assert.equal(body.get("OPTION"), "REPLACE");
      assert.match(body.get("ADIF")!, /Original private narrative/);
      assert.doesNotMatch(body.get("ADIF")!, /QSL_RCVD|APP_QRZLOG/);
      return encode({ RESULT: "REPLACE", COUNT: "1", LOGID: "41" });
    },
  });
  const result = await client.replaceSafely(
    "40",
    { ...contact, MY_GRIDSQUARE: "FN32" },
    "remote_preserved",
  );
  assert.equal(result.logId, "41");
  assert.equal(result.replaced, true);
  assert.equal(bodies.length, 3);
});
test("verified live STATUS field spellings link book dates without changing endpoint behavior", async () => {
  const book = {
    bookId: "7",
    stationCallsign: "N0TEST/P",
    startDate: "2020-01-01",
    endDate: "2030-01-01",
  };
  const client = new QrzClient("synthetic", {
    fetch: async () =>
      encode({
        RESULT: "OK",
        BOOKID: book.bookId,
        CALLSIGN: book.stationCallsign,
        START_DATE: book.startDate,
        END_DATE: book.endDate,
      }),
  });
  assert.deepEqual(await client.verifyBook(book), book);
});
test("live QRZ raw HTML-encoded ADIF tail preserves literal entities and plus/ampersand text", () => {
  const original = {
    ...remote,
    COMMENT: "A & B + C = 100% &lt; literal",
    NOTES: "Line 1\n<EOR> &amp; literal",
  };
  const adif = serializeAdifRecord(original);
  const encoded = adif
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
  const parsed = parseQrzResponse(`RESULT=OK&COUNT=1&ADIF=${encoded}`);
  assert.equal(parsed.ADIF, adif);
  assert.equal(Object.keys(parsed).length, 3);
  assert.equal(parseAdif(parsed.ADIF!).records[0]!.COMMENT, original.COMMENT);
  assert.equal(
    parseAdif(parsed.ADIF!).records[0]!.NOTES,
    "Line 1\r\n<EOR> &amp; literal",
  );
});
test("QRZ structured corrections exclude QRZCOM server metadata and adoption normalizes decimal frequencies", () => {
  const merged = mergeQrzCorrection(
    { ...remote, QRZCOM_QSO_UPLOAD_DATE: "server-managed" },
    contact,
    "remote_preserved",
  );
  assert.equal(merged.QRZCOM_QSO_UPLOAD_DATE, undefined);
  assert.equal(
    matchQrzHistory({ ...contact, FREQ: "14.074" }, [
      { ...remote, FREQ: "14.07400" },
    ]).state,
    "adopted_existing",
  );
  assert.equal(
    matchQrzHistory({ ...contact, FREQ: "14.074" }, [
      { ...remote, FREQ: "14.07500" },
    ]).state,
    "history_mismatch",
  );
});
