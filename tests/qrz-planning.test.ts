import assert from "node:assert/strict";
import test from "node:test";
import {
  QrzPlanningAllowance as PlanningAllowance,
  qrzPlanningFetch,
} from "../src/qrz-planning.ts";

const FINAL_HEADROOM = 10;

import { type AdifRecord, serializeAdifRecord } from "../src/adif.ts";
import { QrzClient } from "../src/qrz.ts";
import { VendorDeferredError, vendorFetch } from "../src/vendor-requests.ts";
import { applyMigration, database } from "./helpers.ts";

const at = 1_800_000_000_000;
const contact: AdifRecord = {
  STATION_CALLSIGN: "N0TEST/P",
  CALL: "W1AW",
  BAND: "20m",
  MODE: "CW",
  QSO_DATE: "20261022",
  TIME_ON: "120000",
};
const book = {
  bookId: "synthetic-book",
  stationCallsign: "N0TEST/P",
  startDate: "2020-01-01",
  endDate: "2030-01-01",
};
const encode = (value: Record<string, string>) =>
  new Response(new URLSearchParams(value).toString());
const row = (id: number): AdifRecord => ({
  ...contact,
  TIME_ON: "000000",
  APP_QRZLOG_LOGID: String(id),
});
const page = (start: number, length: number) =>
  encode({
    RESULT: "OK",
    COUNT: String(length),
    ADIF: Array.from({ length }, (_, i) =>
      serializeAdifRecord(row(start + i)),
    ).join(""),
  });
function nineReadReplies() {
  let target = 0,
    cover = 0,
    requests = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    requests++;
    const form = new URLSearchParams(String(init?.body));
    if (form.get("ACTION") === "STATUS")
      return encode({
        RESULT: "OK",
        BOOKID: book.bookId,
        CALLSIGN: book.stationCallsign,
        START_DATE: book.startDate,
        END_DATE: book.endDate,
      });
    assert.equal(form.get("ACTION"), "FETCH");
    if (form.get("OPTION")?.includes("CALL:")) {
      target++;
      return target === 4
        ? encode({ RESULT: "FAIL", COUNT: "0" })
        : page((target - 1) * 250 + 1, 250);
    }
    cover++;
    return cover === 4 ? page(748, 1) : page((cover - 1) * 249 + 1, 250);
  };
  return { fetcher, count: () => requests };
}
function client(fetcher: typeof fetch) {
  return new QrzClient("synthetic", {
    fetch: fetcher,
    neighborhoodFallback: {
      book,
      now: () => at,
      isCurrent: async () => true,
      selectCover: async () => ["2026-10-22", "2026-10-22"],
    },
  });
}
test("the actual QRZ adapter can use all nine bounded reads for complete empty evidence", async () => {
  const reply = nineReadReplies();
  assert.deepEqual(await client(reply.fetcher).findNeighborhood(contact), []);
  assert.equal(reply.count(), 9);
  assert.equal(FINAL_HEADROOM, 10);
});
test("allowance is shared across priorities/cohorts and never refills within an invocation", () => {
  const budget = new PlanningAllowance();
  for (let i = 0; i < 14; i++) budget.admit("background", at);
  assert.throws(() => budget.admit("background", at), VendorDeferredError);
  for (let i = 0; i < 96; i++) budget.admit("live", at);
  assert.throws(() => budget.admit("live", at + 299_999), VendorDeferredError);
  assert.throws(
    () => budget.admit("background", at + 300_000),
    VendorDeferredError,
  );
  assert.throws(() => budget.admit("live", at + 600_000), VendorDeferredError);
  assert.throws(() => budget.admit("background", at), VendorDeferredError);
  new PlanningAllowance().admit("background", at + 300_000);
});
test("two nine-read planning neighborhoods leave one complete final read and INSERT under native background24", async (t) => {
  const h = await database();
  t.after(() => h.mf.dispose());
  await applyMigration(h.db, "0009_vendor_requests.sql");
  const budget = new PlanningAllowance();
  const planned = (raw: typeof fetch): typeof fetch =>
    qrzPlanningFetch(h.store, raw, "background", () => at, budget);
  const first = nineReadReplies();
  assert.deepEqual(
    await client(planned(first.fetcher)).findNeighborhood(contact),
    [],
  );
  assert.equal(first.count(), 9);
  const second = nineReadReplies();
  await assert.rejects(
    client(planned(second.fetcher)).findNeighborhood(contact),
    VendorDeferredError,
  );
  assert.equal(second.count(), 5);
  assert.equal(
    await h.store
      .statement("SELECT requests FROM vendor_requests WHERE vendor='qrz'")
      .first<number>("requests"),
    14,
    "local rejection occurs before native reservation",
  );
  const final = nineReadReplies();
  assert.deepEqual(
    await client(
      vendorFetch(h.store, "qrz", final.fetcher, {
        priority: "background",
        now: at,
      }),
    ).findNeighborhood(contact),
    [],
  );
  assert.equal(final.count(), 9);
  let inserts = 0;
  const insert = vendorFetch(
    h.store,
    "qrz",
    async (_url, init) => {
      assert.equal(
        new URLSearchParams(String(init?.body)).get("ACTION"),
        "INSERT",
      );
      inserts++;
      return encode({ RESULT: "OK", COUNT: "1", LOGID: "9000" });
    },
    { priority: "background", now: at },
  );
  const writer = new QrzClient("synthetic", {
    fetch: insert,
    writesEnabled: true,
  });
  await writer.insert(contact);
  assert.equal(inserts, 1);
  assert.equal(
    await h.store
      .statement("SELECT requests FROM vendor_requests WHERE vendor='qrz'")
      .first<number>("requests"),
    24,
  );
  assert.equal(
    await h.store
      .statement("SELECT count(*) n FROM attempts")
      .first<number>("n"),
    0,
    "prototype never calls the application's staging/delivery path",
  );
});

test("delayed native admission cannot be refunded by window rollover", async () => {
  const allowance = new PlanningAllowance();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let admissions = 0,
    raw = 0;
  const store = {
    statement: () => ({
      first: async () => {
        admissions++;
        await pending;
        return { window_start: at, cooldown_until: 0 };
      },
    }),
  };
  const send = qrzPlanningFetch(
    store as never,
    async () => {
      raw++;
      return new Response("ok");
    },
    "background",
    () => at,
    allowance,
  );
  const delayed = Array.from({ length: 14 }, () =>
    send("https://example.invalid"),
  );
  assert.equal(admissions, 14);
  await assert.rejects(
    qrzPlanningFetch(
      store as never,
      async () => new Response(),
      "background",
      () => at + 300_000,
      allowance,
    )("https://example.invalid"),
    VendorDeferredError,
  );
  assert.equal(admissions, 14);
  assert.equal(raw, 0);
  release();
  await Promise.all(delayed);
  assert.equal(raw, 14);
  assert.throws(
    () => allowance.admit("background", at + 300_000),
    VendorDeferredError,
  );
});
