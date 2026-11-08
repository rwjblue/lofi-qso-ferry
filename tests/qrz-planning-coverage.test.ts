import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { QrzEmptyObservationScope } from "../src/delivery.ts";
import { projectContact } from "../src/projection.ts";
import { seal } from "../src/security.ts";
import { sourceExportFixture } from "./source-export-fixtures.ts";

async function fixture(t: TestContext, existingNeighbor = false) {
  const h = await sourceExportFixture(
    t,
    async (state, qsos) => {
      const destination = await state.store.connection("a", "destination");
      assert(destination);
      await state.store
        .statement(
          "UPDATE connections SET config=? WHERE tenant='a' AND id='destination'",
          JSON.stringify({
            ...JSON.parse(destination.config),
            bookId: "synthetic-book",
          }),
        )
        .run();
      state.qrzRecords.length = 0;
      state.qrzRecords.push({
        ...state.initial,
        CALL: "K9OTHER",
        APP_QRZLOG_LOGID: "500",
      });
      qsos.push({
        ...structuredClone(state.qso),
        uuid: "q2",
        their: { call: "K2NEXT" },
        syncedAtMillis: 102,
        startAtMillis: Number(state.qso.startAtMillis) + 3_600_000,
      });
      if (existingNeighbor)
        state.qrzRecords.push({
          ...state.initial,
          CALL: "K2NEXT",
          TIME_ON: "130001",
          APP_QRZLOG_LOGID: "501",
        });
    },
    40,
    "inventory_pending",
  );
  const source = await h.store.connection("a", "source");
  const destination = await h.store.connection("a", "destination");
  const credential = await h.store.private<{ apiKey: string }>(
    "a",
    "destination",
    "fixture-qrz",
    "credential",
  );
  assert(source && destination && credential);
  const inputs = await Promise.all(
    h.qsos.map(async (qso) => ({
      key: {
        tenant: "a",
        source: "source",
        qso: String(qso.uuid),
        destination: "destination",
      },
      source,
      destination,
      contact: await projectContact(qso, h.operation, [], {
        operationComplete: true,
      }),
    })),
  );
  const scope = new QrzEmptyObservationScope(h.store);
  t.after(() => scope.close());
  const counts = { target: 0, status: 0, cover: 0 };
  const fetcher: typeof fetch = async (input, init) => {
    const form = new URLSearchParams(String(init?.body));
    if (form.get("ACTION") === "STATUS") {
      counts.status++;
      return new Response(
        new URLSearchParams({
          RESULT: "OK",
          BOOKID: "synthetic-book",
          CALLSIGN: "W1AW",
          START_DATE: "2020-01-01",
          END_DATE: "2030-12-31",
        }).toString(),
      );
    }
    assert.equal(form.get("ACTION"), "FETCH");
    if (
      form
        .get("OPTION")
        ?.split(",")
        .some((field) => field.startsWith("CALL:"))
    ) {
      counts.target++;
      return new Response("RESULT=FAIL&COUNT=0");
    }
    counts.cover++;
    return h.fetcher(input, init);
  };
  return {
    ...h,
    inputs,
    credential,
    scope,
    counts,
    fetcher,
    read: (index: number, transport = fetcher) =>
      scope.read(inputs[index], credential, { fetcher: transport }),
  };
}

test("planning shares a complete cover and independently filters a later contact's neighbor", async (t) => {
  const h = await fixture(t, true);
  const first = await h.read(0);
  assert(first.observation);
  assert.equal(first.records.length, 0);
  const later = await h.read(1);
  assert.equal(later.observation, undefined);
  assert.equal(later.records.length, 1);
  assert.equal(later.records[0].CALL, "K2NEXT");
  // Caller mutation must not poison the retained full covering result.
  later.records[0].CALL = "K9MUTATED";
  assert.equal((await h.read(1)).records[0].CALL, "K2NEXT");
  assert.deepEqual(h.counts, { target: 3, status: 1, cover: 1 });
  assert.equal(h.calls.qrzWrites, 0);
});

test("reused planning coverage keeps its original expiry and is never shared across scopes", async (t) => {
  const h = await fixture(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const startedAt = now;
  assert((await h.read(0)).observation);
  now += 59_000;
  const later = await h.read(1);
  assert(later.observation);
  assert.deepEqual(h.counts, { target: 2, status: 1, cover: 1 });
  now = startedAt + 60_001;
  assert.equal(
    await QrzEmptyObservationScope.consume(
      later.observation,
      h.store,
      h.inputs[1],
      h.credential,
      Date.now,
    ),
    false,
  );
  assert((await h.read(1)).observation);
  assert.deepEqual(h.counts, { target: 3, status: 2, cover: 2 });
  const separate = new QrzEmptyObservationScope(h.store);
  t.after(() => separate.close());
  await separate.read(h.inputs[1], h.credential, { fetcher: h.fetcher });
  assert.deepEqual(h.counts, { target: 4, status: 3, cover: 3 });
});

test("planning cannot reuse a cover after credential replacement or source configuration change", async (t) => {
  const h = await fixture(t);
  assert((await h.read(0)).observation);
  const envelope = await seal(
    h.credential,
    {
      tenant: "a",
      connection: "destination",
      id: "fixture-qrz",
      kind: "credential",
      purpose: "storage",
    },
    h.store.keys,
  );
  await h.store
    .statement(
      "UPDATE private_data SET envelope=? WHERE tenant='a' AND connection='destination' AND id='fixture-qrz' AND kind='credential'",
      JSON.stringify(envelope),
    )
    .run();
  assert((await h.read(1)).observation);
  assert.deepEqual(h.counts, { target: 2, status: 2, cover: 2 });
  await h.store
    .statement(
      "UPDATE connections SET config=json_set(config,'$.scopeChanged',1) WHERE tenant='a' AND id='source'",
    )
    .run();
  const source = await h.store.connection("a", "source");
  assert(source);
  h.inputs[1].source = source;
  assert((await h.read(1)).observation);
  assert.deepEqual(h.counts, { target: 3, status: 3, cover: 3 });
});

test("a failed covering read never publishes reusable planning evidence", async (t) => {
  const h = await fixture(t);
  let failed = false;
  await assert.rejects(
    h.read(0, async (input, init) => {
      const response = await h.fetcher(input, init);
      if (h.counts.cover && !failed) {
        failed = true;
        return new Response("synthetic outage", { status: 500 });
      }
      return response;
    }),
  );
  assert((await h.read(1)).observation);
  assert.deepEqual(h.counts, { target: 2, status: 2, cover: 2 });
});
