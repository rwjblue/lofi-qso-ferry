import assert from "node:assert/strict";
import test from "node:test";
import { parseAdif, serializeAdifRecord } from "../src/adif.ts";
import {
  matchQrzHistory,
  parseQrzResponse,
  QrzClient,
  QrzError,
  sameQrzIdentity,
} from "../src/qrz.ts";
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
test("QRZ neighborhood dates include the full accepted time radius across UTC midnight", async (t) => {
  for (const scenario of [
    {
      name: "preceding day",
      time: "003030",
      edgeDate: "20261021",
      edgeTime: "235931",
      outsideTime: "235930",
      between: "2026-10-21+2026-10-22",
    },
    {
      name: "following day",
      time: "232930",
      edgeDate: "20261023",
      edgeTime: "000029",
      outsideTime: "000030",
      between: "2026-10-22+2026-10-23",
    },
  ])
    await t.test(scenario.name, async () => {
      const record = { ...contact, TIME_ON: scenario.time };
      const rows = [
        { ...record, APP_QRZLOG_LOGID: "1" },
        {
          ...remote,
          QSO_DATE: scenario.edgeDate,
          TIME_ON: scenario.edgeTime,
          APP_QRZLOG_LOGID: "2",
        },
        {
          ...remote,
          QSO_DATE: scenario.edgeDate,
          TIME_ON: scenario.outsideTime,
          APP_QRZLOG_LOGID: "3",
        },
      ];
      let calls = 0;
      const client = new QrzClient("synthetic", {
        fetch: async (_url, init) => {
          calls++;
          const option = new URLSearchParams(String(init?.body)).get("OPTION");
          const range = option?.match(/BETWEEN:([^,]+)/)?.[1];
          assert.equal(range, scenario.between);
          const [start, end] = range!.replaceAll("-", "").split("+");
          const selected = rows.filter(
            (row) => row.QSO_DATE >= start && row.QSO_DATE <= end,
          );
          return encode({
            RESULT: "OK",
            COUNT: String(selected.length),
            ADIF: selected.map(serializeAdifRecord).join(""),
          });
        },
      });
      assert.deepEqual(
        (await client.findNeighborhood(record)).map(
          (row) => row.APP_QRZLOG_LOGID,
        ),
        ["1", "2"],
      );
      assert.equal(calls, 1);
    });
});
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
test("read responses preserve only fixed validation diagnostics while writes stay uncertain", async (t) => {
  const secret = "private-record-and-credential";
  const cases: [string, () => Response, string][] = [
    [
      "html",
      () => new Response(`<html>${secret}</html>`),
      "Invalid QRZ response framing",
    ],
    [
      "duplicate parameter",
      () => new Response(`RESULT=OK&result=FAIL&TOKEN=${secret}`),
      "Duplicate QRZ response parameter",
    ],
    [
      "missing result",
      () => new Response(`COUNT=0&REASON=${secret}`),
      "Missing QRZ result",
    ],
    [
      "entity encoding",
      () =>
        new Response(
          `RESULT=OK&COUNT=1&ADIF=&lt;CALL:7&gt;&#x110000;${secret}&lt;EOR&gt;`,
        ),
      "Invalid QRZ ADIF entity encoding",
    ],
    [
      "form encoding",
      () =>
        new Response(
          `RESULT=OK&COUNT=1&ADIF=%3CCALL%3A7%3E${secret}%3CEOR%3E%ZZ`,
        ),
      "Invalid QRZ form encoding",
    ],
    [
      "body limit",
      () =>
        new Response(
          secret.repeat(Math.ceil((2 * 1024 * 1024 + 1) / secret.length)),
        ),
      "QRZ response exceeds 2 MiB",
    ],
    [
      "utf8",
      () => new Response(new Uint8Array([0xff])),
      "Invalid QRZ response UTF-8",
    ],
    [
      "stream failure",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(secret, { cause: new Error(secret) }));
            },
          }),
        ),
      "QRZ response body could not be read",
    ],
  ];
  for (const [name, response, message] of cases)
    await t.test(name, async () => {
      const client = new QrzClient(secret, {
        writesEnabled: true,
        fetch: async () => response(),
      });
      for (const read of [() => client.fetchPage(), () => client.status()])
        await assert.rejects(read, (error: unknown) => {
          assert(error instanceof QrzError);
          assert.equal(error.kind, "protocol");
          assert.equal(error.message, message);
          assert.equal(error.cause, undefined);
          assert.doesNotMatch(String(error), /private|credential|record-and/);
          return true;
        });
      await assert.rejects(client.insert(contact), (error: unknown) => {
        assert(error instanceof QrzError);
        assert.equal(error.kind, "uncertain");
        assert.equal(
          error.message,
          "Invalid QRZ response; mutation outcome must be reconciled",
        );
        assert.equal(error.cause, undefined);
        assert.doesNotMatch(String(error), /private|credential|record-and/);
        return true;
      });
    });
});
test("unrecognized QRZ body failures and rejected FETCH never expose vendor reasons or imply empty history", async () => {
  const secret = "private-response-token";
  const response = new Response();
  Object.defineProperty(response, "body", {
    get() {
      throw new QrzError("protocol", secret);
    },
  });
  const unknown = new QrzClient(secret, { fetch: async () => response });
  await assert.rejects(unknown.fetchPage(), (error: unknown) => {
    assert(error instanceof QrzError);
    assert.equal(error.kind, "protocol");
    assert.equal(
      error.message,
      "Invalid QRZ response; mutation outcome must be reconciled",
    );
    assert.equal(error.cause, undefined);
    return true;
  });
  for (const body of [
    "RESULT=FAIL&COUNT=0",
    `RESULT=FAIL&COUNT=0&REASON=${secret}`,
  ]) {
    const rejected = new QrzClient(secret, {
      fetch: async () => new Response(body),
    });
    await assert.rejects(rejected.fetchPage(), (error: unknown) => {
      assert(error instanceof QrzError);
      assert.equal(error.kind, "rejected");
      assert.equal(error.message, "QRZ inventory incomplete or rejected");
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});
test("only the observed ambiguous empty FETCH framing receives a fixed detail and always remains rejected", async () => {
  for (const [body, expected] of [
    ["RESULT=FAIL&COUNT=0", "ambiguous_empty_selection"],
    ["RESULT=FAIL&COUNT=00", undefined],
    ["RESULT=FAIL&COUNT=1", undefined],
    ["RESULT=FAIL", undefined],
    ["RESULT=FAIL&COUNT=0&ADIF=", undefined],
    ["RESULT=FAIL&COUNT=0&REASON=", undefined],
    ["RESULT=FAIL&COUNT=0&REASON=private", undefined],
    ["RESULT=UNKNOWN&COUNT=0", undefined],
  ] as const) {
    const client = new QrzClient("synthetic", {
      fetch: async () => new Response(body),
    });
    await assert.rejects(client.fetchPage(), (error: unknown) => {
      assert(error instanceof QrzError);
      assert.equal(error.kind, "rejected");
      assert.equal(error.detail, expected);
      assert.doesNotMatch(String(error), /private/);
      return true;
    });
  }
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
test("a single compatible minute-only history record gets a precision review reason without matching write identity", () => {
  const expected = { ...contact, FREQ: "14.074" };
  const minuteOnly = { ...remote, TIME_ON: "1200", FREQ: "14.07400" };
  for (const time of ["120000", "120001", "120059"]) {
    const current = { ...expected, TIME_ON: time };
    assert.equal(sameQrzIdentity(current, minuteOnly), false);
    assert.deepEqual(matchQrzHistory(current, [minuteOnly]), {
      state: "history_ambiguous",
      reason:
        "Destination history has minute-only TIME_ON precision; source includes seconds and requires association review",
    });
  }
});
test("time precision review does not hide competing, invalid or otherwise conflicting history", () => {
  const expected = { ...contact, FREQ: "14.074" };
  const minuteOnly = { ...remote, TIME_ON: "1200", FREQ: "14.074" };
  for (const [current, candidates] of [
    [expected, [minuteOnly, minuteOnly]],
    [expected, [{ ...minuteOnly, TIME_ON: "1201" }]],
    [expected, [{ ...minuteOnly, TIME_ON: "120" }]],
    [expected, [{ ...minuteOnly, TIME_ON: "" }]],
    [expected, [{ ...minuteOnly, CALL: "W2AW" }]],
    [expected, [{ ...minuteOnly, MODE: "SSB" }]],
    [expected, [{ ...minuteOnly, FREQ: "14.075" }]],
    [expected, [{ ...minuteOnly, FREQ: "" }]],
    [expected, [{ ...minuteOnly, MY_GRIDSQUARE: "FN32" }]],
    [expected, [{ ...minuteOnly, MY_GRIDSQUARE: "" }]],
    [{ ...expected, TIME_ON: "120060" }, [minuteOnly]],
    [{ ...expected, TIME_ON: "240001" }, [{ ...minuteOnly, TIME_ON: "2400" }]],
    [
      { ...expected, QSO_DATE: "20260230" },
      [{ ...minuteOnly, QSO_DATE: "20260230" }],
    ],
  ] as const) {
    const match = matchQrzHistory(current, [...candidates]);
    assert.equal(match.state, "history_ambiguous");
    assert("reason" in match);
    assert.equal(
      match.reason,
      "No unique exact identity, including time precision and mode",
    );
  }
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
test("writes default disabled", async () => {
  const client = new QrzClient("secret", {
    fetch: async () => {
      throw new Error("Should not request");
    },
  });
  await assert.rejects(client.insert(contact), /disabled/);
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
test("QRZ decodes observed adjacent surrogate entities once without changing scalar Unicode", () => {
  for (const [encoded, expected] of [
    ["&#55357;&#56832;", "\u{1f600}"],
    ["&#xD83D;&#xDE00;", "\u{1f600}"],
    ["&#55357;&#xDE00;", "\u{1f600}"],
    ["&#0055357;&#0056832;", "\u{1f600}"],
    ["&#x00D800;&#x00DC00;", "\u{10000}"],
    ["&#xDBFF;&#xDFFF;", "\u{10ffff}"],
    ["&#128512;", "\u{1f600}"],
    ["&#x1F600;", "\u{1f600}"],
    ["&amp;#55357;&amp;#56832;", "&#55357;&#56832;"],
    ["&amp;amp;#55357;&amp;amp;#56832;", "&amp;#55357;&amp;#56832;"],
  ]) {
    const parsed = parseQrzResponse(
      `RESULT=OK&COUNT=1&ADIF=&lt;COMMENT:${expected.length}&gt;${encoded}&lt;EOR&gt;`,
    );
    assert.equal(parseAdif(parsed.ADIF!).records[0].COMMENT, expected);
  }
});
test("unpaired, separated, reversed and out-of-range QRZ entities remain protocol failures and writes stay uncertain", async () => {
  for (const encoded of [
    "&#55357;",
    "&#56832;",
    "&#56832;&#55357;",
    "&#55357;&#55357;",
    "&#55357; &#56832;",
    "&#55357;&amp;#56832;",
    "&#x110000;",
    "&#9999999;",
  ]) {
    const response = `RESULT=OK&COUNT=1&ADIF=&lt;COMMENT:2&gt;${encoded}&lt;EOR&gt;`;
    const client = new QrzClient("synthetic", {
      writesEnabled: true,
      fetch: async () => new Response(response),
    });
    await assert.rejects(
      client.fetchPage(),
      (error: unknown) =>
        error instanceof QrzError &&
        error.kind === "protocol" &&
        error.message === "Invalid QRZ ADIF entity encoding",
    );
    await assert.rejects(
      client.insert(contact),
      (error: unknown) =>
        error instanceof QrzError && error.kind === "uncertain",
    );
  }
});
test("full QRZ FETCH retains supplementary narrative and following exact ASCII identity fields", async () => {
  const narrative = "\u{1f600} &lt; literal &#55357;&#56832;";
  const identity: Record<string, string> = {
    ...contact,
    APP_QRZLOG_LOGID: "41",
  };
  delete identity.COMMENT;
  const raw = `<COMMENT:${narrative.length}>${narrative}${serializeAdifRecord(identity)}`;
  const encoded = raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\u{1f600}", "&#55357;&#56832;");
  const client = new QrzClient("synthetic", {
    fetch: async (_input, init) => {
      assert.equal(
        new URLSearchParams(String(init?.body)).get("ACTION"),
        "FETCH",
      );
      return new Response(`RESULT=OK&COUNT=1&ADIF=${encoded}`);
    },
  });
  const page = await client.fetchPage();
  assert.equal(page.nextAfterLogId, null);
  assert.deepEqual({ ...page.records[0] }, { ...identity, COMMENT: narrative });
  assert.equal(page.records[0].COMMENT.length, narrative.length);
  assert.equal(page.records[0].COMMENT.codePointAt(0), 0x1f600);
  assert.equal(sameQrzIdentity(contact, page.records[0]), true);
  assert.throws(
    () => serializeAdifRecord(page.records[0]),
    /Unsupported ADI encoding/,
  );
});
test("QRZ rejects declared lengths that split a supplementary character instead of accepting a partial field", async () => {
  for (const prefix of ["", "header\n"]) {
    const encoded = `${prefix}&lt;COMMENT:1&gt;&#55357;&#56832;${prefix ? "&lt;EOH&gt;" : ""}&lt;CALL:4&gt;W1AW&lt;APP_QRZLOG_LOGID:2&gt;41&lt;EOR&gt;`;
    const client = new QrzClient("synthetic", {
      fetch: async () => new Response(`RESULT=OK&COUNT=1&ADIF=${encoded}`),
    });
    await assert.rejects(
      client.fetchPage(),
      (error: unknown) =>
        error instanceof QrzError &&
        error.kind === "protocol" &&
        error.message === "QRZ ADIF field splits a Unicode character",
    );
    await assert.rejects(
      client.fetchLogId("41"),
      (error: unknown) =>
        error instanceof QrzError && error.kind === "protocol",
    );
    await assert.rejects(
      client.findNeighborhood(contact),
      (error: unknown) =>
        error instanceof QrzError && error.kind === "protocol",
    );
  }
});
test("QRZ adoption normalizes equivalent decimal frequencies", () => {
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
