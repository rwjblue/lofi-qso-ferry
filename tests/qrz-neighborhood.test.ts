import assert from "node:assert/strict";
import test from "node:test";
import { type AdifRecord, serializeAdifRecord } from "../src/adif.ts";
import { QrzClient, QrzError, type QrzOptions } from "../src/qrz.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";

const contact: AdifRecord = {
  STATION_CALLSIGN: "N0TEST/P",
  CALL: "W1AW",
  BAND: "20m",
  MODE: "CW",
  QSO_DATE: "20261022",
  TIME_ON: "003030",
};
const book = {
  bookId: "synthetic-book",
  stationCallsign: "N0TEST/P",
  startDate: "2020-01-01",
  endDate: "2030-01-01",
};
const encode = (data: Record<string, string>) =>
  new Response(new URLSearchParams(data).toString());
const status = () =>
  encode({
    RESULT: "OK",
    BOOKID: book.bookId,
    CALLSIGN: book.stationCallsign,
    START_DATE: book.startDate,
    END_DATE: book.endDate,
  });
const row = (id: number, extra: AdifRecord = {}): AdifRecord => ({
  ...contact,
  APP_QRZLOG_LOGID: String(id),
  ...extra,
});
const records = (rows: AdifRecord[]) =>
  encode({
    RESULT: "OK",
    COUNT: String(rows.length),
    ADIF: rows.map(serializeAdifRecord).join(""),
  });
const ambiguous = () => new Response("RESULT=FAIL&COUNT=0");
function harness(
  replies: (() => Response | Promise<Response>)[],
  options: Partial<NonNullable<QrzOptions["neighborhoodFallback"]>> = {},
) {
  const requests: URLSearchParams[] = [];
  let current = true;
  let now = 1000;
  const client = new QrzClient("synthetic-key", {
    neighborhoodFallback: {
      book,
      selectCover: async (_record, target) => {
        assert.deepEqual(target, ["2026-10-21", "2026-10-22"]);
        return ["2026-10-01", "2026-11-04"];
      },
      isCurrent: async () => current,
      now: () => now,
      ...options,
    },
    fetch: async (_url, init) => {
      assert.equal(init?.redirect, "manual");
      assert(init?.signal instanceof AbortSignal);
      requests.push(new URLSearchParams(String(init?.body)));
      const reply = replies.shift();
      assert(reply, "Unexpected request beyond bounded fallback");
      return reply();
    },
  });
  return {
    client,
    requests,
    revoke: () => {
      current = false;
    },
    advance: () => {
      now += 60_000;
    },
  };
}

test("ambiguous targeted FETCH requires fresh book proof and a complete positive covering scan", async () => {
  const h = harness([
    ambiguous,
    status,
    () =>
      records([
        row(1, { CALL: "K1OTHER" }),
        row(2, { BAND: "40m" }),
        row(3, { QSO_DATE: "20261021", TIME_ON: "235931", MODE: "SSB" }),
        row(4, { QSO_DATE: "20261021", TIME_ON: "235930" }),
      ]),
  ]);
  assert.deepEqual(
    (await h.client.findNeighborhood(contact)).map(
      (value) => value.APP_QRZLOG_LOGID,
    ),
    ["3"],
  );
  assert.deepEqual(
    h.requests.map((value) => value.get("ACTION")),
    ["FETCH", "STATUS", "FETCH"],
  );
  assert.match(h.requests[0].get("OPTION")!, /CALL:W1AW,BAND:20m/);
  assert.match(h.requests[0].get("OPTION")!, /BETWEEN:2026-10-21\+2026-10-22/);
  assert(!h.requests[2].get("OPTION")!.includes("CALL:"));
  assert(!h.requests[2].get("OPTION")!.includes("BAND:"));
});

test("absence comes only from a complete fresh positive cover, not a rejected or empty cover", async (t) => {
  const good = harness([
    ambiguous,
    status,
    () => records([row(1, { CALL: "K1OTHER" })]),
  ]);
  assert.deepEqual(await good.client.findNeighborhood(contact), []);
  for (const reply of [ambiguous, () => records([])])
    await t.test(String(reply), async () => {
      const h = harness([ambiguous, status, reply]);
      await assert.rejects(h.client.findNeighborhood(contact), QrzError);
      assert.equal(h.requests.length, 3);
    });
});

test("fallback is restricted to the exact ambiguous rejection shape", async (t) => {
  for (const reply of [
    () => new Response("RESULT=FAIL&COUNT=0&REASON=unknown"),
    () => new Response("RESULT=FAIL&COUNT=0&ADIF="),
    () => new Response("RESULT=AUTH"),
    () => new Response("invalid framing"),
    () => {
      throw new VendorDeferredError(10000);
    },
  ])
    await t.test(String(reply), async () => {
      const h = harness([reply]);
      await assert.rejects(h.client.findNeighborhood(contact));
      assert.equal(h.requests.length, 1);
    });
});

test("book mismatch, out-of-book collision dates and changed current scope never yield coverage", async (t) => {
  await t.test("STATUS mismatch", async () => {
    const h = harness([
      ambiguous,
      () => encode({ RESULT: "OK", BOOKID: "other" }),
    ]);
    await assert.rejects(h.client.findNeighborhood(contact), /expected book/);
    assert.equal(h.requests.length, 2);
  });
  await t.test("full midnight target outside book", async () => {
    const h = harness([ambiguous], {
      book: { ...book, startDate: "2026-10-22" },
    });
    await assert.rejects(
      h.client.findNeighborhood(contact),
      /outside the verified book/,
    );
    assert.equal(h.requests.length, 1);
  });
  await t.test(
    "cover reads finish after credential scope changes",
    async () => {
      const h = harness([
        ambiguous,
        status,
        () => {
          h.revoke();
          return records([row(1, { CALL: "K1OTHER" })]);
        },
      ]);
      await assert.rejects(h.client.findNeighborhood(contact), /scope changed/);
      assert.equal(h.requests.length, 3);
    },
  );
  await t.test(
    "direct successful read also checks current scope after response",
    async () => {
      const h = harness([
        () => {
          h.revoke();
          return records([]);
        },
      ]);
      await assert.rejects(h.client.findNeighborhood(contact), /scope changed/);
      assert.equal(h.requests.length, 1);
    },
  );
});

test("cover continuation requires an unchanged anchor and never returns partial collision results", async () => {
  const page = Array.from({ length: 250 }, (_, index) => row(index + 1));
  const h = harness([
    ambiguous,
    status,
    () => records(page),
    () => records([{ ...page[249], MODE: "SSB" }]),
  ]);
  await assert.rejects(h.client.findNeighborhood(contact), /anchor changed/);
  assert.match(h.requests[3].get("OPTION")!, /AFTERLOGID:250/);
});

test("targeted partial pages are discarded and the whole operation stays within nine requests", async () => {
  const targeted = (page: number) =>
    Array.from({ length: 250 }, (_, index) => row(page * 250 + index + 1));
  const covered = (start: number) =>
    Array.from({ length: 250 }, (_, index) =>
      row(start + index, { CALL: "K1OTHER" }),
    );
  const h = harness([
    () => records(targeted(0)),
    () => records(targeted(1)),
    () => records(targeted(2)),
    ambiguous,
    status,
    () => records(covered(1)),
    () => records(covered(250)),
    () => records(covered(499)),
    () => records([row(748, { CALL: "K1OTHER" })]),
  ]);
  assert.deepEqual(await h.client.findNeighborhood(contact), []);
  assert.equal(h.requests.length, 9);
});

test("targeted scan and fallback share the same sixty-second deadline", async () => {
  const h = harness([
    ambiguous,
    () => {
      h.advance();
      return status();
    },
  ]);
  await assert.rejects(h.client.findNeighborhood(contact), /deadline reached/);
  assert.equal(h.requests.length, 2);
});
