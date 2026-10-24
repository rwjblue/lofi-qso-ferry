import assert from "node:assert/strict";
import test from "node:test";
import { type AdifRecord, serializeAdifRecord } from "../src/adif.ts";
import { measuredDatabase } from "../src/database-metrics.ts";
import {
  type HistoryInventoryInput,
  type HistoryInventoryOptions,
  type HistoryInventoryResult,
  historyCandidates,
  historyCandidatesBatch,
  historyInventoryGuard,
} from "../src/history-inventory.ts";
import { Store } from "../src/store.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";
import { applyMigration, database, seed } from "./helpers.ts";

const base: AdifRecord = {
  STATION_CALLSIGN: "N0TEST/P",
  CALL: "W1AW",
  BAND: "20m",
  MODE: "CW",
  QSO_DATE: "20261025",
  TIME_ON: "234500",
  MY_GRIDSQUARE: "FN31PR12",
};
const isoDate = (value: string) =>
  `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
function response(records: AdifRecord[]) {
  return new Response(
    `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:${String(records.length).length}>${records.length}<EOH>${records.map((record) => serializeAdifRecord({ ...record, QSL_RCVD: "N" })).join("")}<APP_LOTW_EOF>`,
  );
}
async function fixture(record = base) {
  const h = await database();
  try {
    await applyMigration(h.db, "0009_vendor_requests.sql");
    await applyMigration(h.db, "0017_history_inventory.sql");
    const key = await seed(h.store);
    await h.store
      .statement("UPDATE connections SET kind='lotw' WHERE id='destination'")
      .run();
    await h.store
      .statement(
        "DELETE FROM private_data WHERE connection='destination' AND kind='credential'",
      )
      .run();
    await (
      await h.store.putPrivate("a", "destination", "v1", "credential", {
        query: { username: "synthetic-user", password: "synthetic-password" },
      })
    ).run();
    await h.store.observe(key, "g1", "hash", 30, false);
    const input: HistoryInventoryInput = {
      source: (await h.store.connection("a", "source"))!,
      destination: (await h.store.connection("a", "destination"))!,
      qso: key.qso,
      generation: "g1",
      record,
    };
    return { ...h, key, input, now: Date.now() + 1000 };
  } catch (error) {
    await h.mf.dispose();
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function inventory(h: Fixture, records: AdifRecord[], daily = false) {
  const reads: [string, string][] = [];
  const options: HistoryInventoryOptions = {
    now: h.now,
    vendorNow: h.now,
    fetcher: async (value) => {
      const params = new URL(String(value)).searchParams;
      assert.equal(params.get("qso_owncall"), base.STATION_CALLSIGN);
      assert.equal(params.get("qso_callsign"), null);
      const start = params.get("qso_startdate")!;
      const end = params.get("qso_enddate")!;
      reads.push([start, end]);
      if (daily && start !== end)
        return new Response("x".repeat(2 * 1024 * 1024 + 1));
      return response(
        records.filter((record) => {
          const day = isoDate(record.QSO_DATE);
          return day >= start && day <= end;
        }),
      );
    },
  };
  return { options, reads };
}
async function complete(
  h: Fixture,
  options: HistoryInventoryOptions,
  batch = false,
) {
  let result: HistoryInventoryResult | undefined;
  for (let turn = 0; turn < 12; turn++) {
    const current = { ...options, vendorNow: h.now + turn * 300_000 };
    result = batch
      ? (await historyCandidatesBatch(h.store, [h.input], current))[0]
      : await historyCandidates(h.store, h.input, current);
    assert.equal(result.freshCheckComplete, false);
    if (result.state === "ready") return result;
    assert.equal(result.state, "pending", result.reason);
    assert.deepEqual(result.records, []);
    assert.equal(result.fence, undefined);
  }
  assert.fail(`inventory did not complete: ${result?.reason}`);
}
function warm(h: Fixture): HistoryInventoryOptions {
  return {
    now: h.now,
    fetcher: async () => assert.fail("warm coverage fetched history"),
  };
}
async function currentFence(h: Fixture, result: HistoryInventoryResult) {
  assert(result.fence);
  const guard = historyInventoryGuard(h.key, result.fence, h.now);
  return !!(await h.store
    .statement(`SELECT 1 n WHERE ${guard.sql}`, ...guard.params)
    .first());
}

const boundaries: [string, string, string[]][] = [
  ["20261022", "000000", ["20261021", "20261022"]], // epoch-aligned weekly boundary
  ["20260401", "0000", ["20260331", "20260401"]],
  ["20270101", "000000", ["20261231", "20270101"]],
  ["20240301", "000000", ["20240229", "20240301"]],
  ["20240228", "2359", ["20240228", "20240229"]],
  ["20230301", "000000", ["20230228", "20230301"]],
  ["20261025", "002959", ["20261024", "20261025"]],
  ["20261025", "003000", ["20261025"]],
  ["20261025", "232959", ["20261025"]],
  ["20261025", "2330", ["20261025", "20261026"]],
];
for (const [day, time, dates] of boundaries)
  test(`LoTW UTC coverage ${day}/${time} retains both interval edges with singleton/batch parity`, async () => {
    const h = await fixture({ ...base, QSO_DATE: day, TIME_ON: time });
    try {
      const rows = dates.map((QSO_DATE, index) => ({
        ...base,
        QSO_DATE,
        TIME_ON: index ? "0000" : "235959",
        BAND: index ? "40m" : "20m",
        MODE: index ? "SSB" : "CW",
      }));
      const outside = { ...base, QSO_DATE: "20261027" };
      const { options, reads } = inventory(h, [...rows, outside]);
      const result = await complete(h, options);
      assert.deepEqual(result.records.map((r) => r.QSO_DATE).sort(), dates);
      assert.deepEqual(
        result.records.map((r) => r.TIME_ON),
        rows.map((r) => r.TIME_ON),
      );
      assert(result.fence);
      assert(
        result.fence.partitions.length >= 1 &&
          result.fence.partitions.length <= 2,
      );
      assert.equal(
        new Set(result.fence.partitions.map((p) => p.id)).size,
        result.fence.partitions.length,
      );
      assert.equal(reads.length, result.fence.partitions.length);
      const batch = await historyCandidatesBatch(
        h.store,
        [h.input, h.input],
        warm(h),
      );
      for (const member of batch) {
        assert.equal(member.state, "ready");
        assert.equal(member.freshCheckComplete, false);
        assert.deepEqual(member.records, result.records);
        assert.deepEqual(member.fence, result.fence);
      }
      assert.equal(await currentFence(h, result), true);
    } finally {
      await h.mf.dispose();
    }
  });

test("both daily children of a split week complete before readiness and share each leaf across batch contacts", async () => {
  const h = await fixture();
  try {
    const rows = [base, { ...base, QSO_DATE: "20261026", TIME_ON: "0015" }];
    const { options, reads } = inventory(h, rows, true);
    const result = await complete(h, options, true);
    assert.equal(result.records.length, 2);
    assert.equal(result.fence?.partitions.length, 2);
    assert.deepEqual(
      reads.filter(([a, b]) => a === b),
      [
        ["2026-10-25", "2026-10-25"],
        ["2026-10-26", "2026-10-26"],
      ],
    );
    assert.equal(
      new Set(reads.map((range) => range.join("/"))).size,
      reads.length,
    );
    const counted = measuredDatabase(h.db);
    const batch = await historyCandidatesBatch(
      new Store(counted.database, h.store.keys),
      [h.input, h.input],
      warm(h),
    );
    assert.equal(counted.metrics.calls, 7); // initial metadata, three shared split levels, two leaves, final fence
    assert.deepEqual(batch[0].records, result.records);
    assert.deepEqual(batch[0].fence, result.fence);
    assert.deepEqual(batch[1].fence, result.fence);
    const single = await historyCandidates(h.store, h.input, warm(h));
    assert.deepEqual(single.fence, result.fence);
    assert.deepEqual(single.records, result.records);
  } finally {
    await h.mf.dispose();
  }
});

test("neighboring dates in the same split child use one retained leaf and one guard", async () => {
  const h = await fixture({ ...base, QSO_DATE: "20261023" });
  try {
    let calls = 0;
    const records = [
      h.input.record,
      { ...base, QSO_DATE: "20261024", TIME_ON: "0010" },
    ];
    const result = await complete(h, {
      now: h.now,
      fetcher: async (value) => {
        calls++;
        const query = new URL(String(value)).searchParams;
        if (query.get("qso_enddate") === "2026-10-28")
          return new Response("x".repeat(2 * 1024 * 1024 + 1));
        assert.equal(query.get("qso_startdate"), "2026-10-22");
        assert.equal(query.get("qso_enddate"), "2026-10-25");
        return response(records);
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.fence?.partitions.length, 1);
    const batch = await historyCandidatesBatch(
      h.store,
      [h.input, h.input],
      warm(h),
    );
    assert.deepEqual(batch[0].records, result.records);
    assert.deepEqual(batch[0].fence, result.fence);
    assert.equal(await currentFence(h, result), true);
  } finally {
    await h.mf.dispose();
  }
});

for (const failure of [
  "missing",
  "expired",
  "revoked-page",
  "blocked",
  "incomplete",
] as const)
  test(`a ${failure} second leaf cannot publish partial LoTW evidence`, async () => {
    const h = await fixture();
    try {
      const { options } = inventory(
        h,
        [base, { ...base, QSO_DATE: "20261026", TIME_ON: "0010" }],
        true,
      );
      const ready = await complete(h, options);
      const second = ready.fence!.partitions[1].id;
      if (failure === "missing")
        await h.store
          .statement("DELETE FROM partitions WHERE id=?", second)
          .run();
      else if (failure === "expired")
        await h.store
          .statement(
            "UPDATE partitions SET expires_at=? WHERE id=?",
            h.now,
            second,
          )
          .run();
      else if (failure === "revoked-page")
        await h.store
          .statement(
            "UPDATE private_data SET revoked_at=? WHERE id IN(SELECT payload_id FROM history_inventory_pages WHERE partition=?)",
            h.now,
            second,
          )
          .run();
      else
        await h.store
          .statement(
            "UPDATE partitions SET state='pending',evidence=json_set(evidence,'$.phase',?) WHERE id=?",
            failure === "blocked" ? "blocked" : "base",
            second,
          )
          .run();
      const [result] = await historyCandidatesBatch(h.store, [h.input], {
        ...warm(h),
        shouldContinue: () => false,
      });
      assert.notEqual(result.state, "ready");
      assert.deepEqual(result.records, []);
      assert.equal(result.fence, undefined);
      assert.equal(result.freshCheckComplete, false);
      assert.equal(await currentFence(h, ready), false);
    } finally {
      await h.mf.dispose();
    }
  });

test("a failed neighboring read preserves its fixed failure and never returns the completed first leaf", async () => {
  const h = await fixture({ ...base, QSO_DATE: "20261022", TIME_ON: "0000" });
  try {
    const first = await historyCandidates(h.store, h.input, {
      now: h.now,
      vendorNow: h.now,
      fetcher: async () => response([]),
    });
    assert.equal(first.state, "pending");
    assert.equal(first.fence, undefined);
    const deferred = new VendorDeferredError(h.now + 300_000);
    let calls = 0;
    const options = {
      now: h.now,
      vendorNow: h.now,
      fetcher: async () => {
        calls++;
        throw deferred;
      },
    };
    await assert.rejects(
      historyCandidates(h.store, h.input, options),
      (error) => error === deferred,
    );
    const [batch] = await historyCandidatesBatch(h.store, [h.input], options);
    assert.equal(batch.state, "pending");
    assert.equal(batch.failure, deferred);
    assert.deepEqual(batch.records, []);
    assert.equal(batch.fence, undefined);
    assert.equal(calls, 2);
  } finally {
    await h.mf.dispose();
  }
});

for (const mode of ["singleton", "batch"] as const)
  test(`${mode} rejects a second-leaf evidence race during the final comparison and at commit`, async () => {
    const h = await fixture();
    try {
      const { options } = inventory(
        h,
        [base, { ...base, QSO_DATE: "20261026", TIME_ON: "0010" }],
        true,
      );
      const ready = await complete(h, options);
      const second = ready.fence!.partitions[1].id;
      let batches = 0;
      const db = new Proxy(h.db, {
        get(target, property) {
          if (property === "batch")
            return async (statements: D1PreparedStatement[]) => {
              batches++;
              if (batches === (mode === "singleton" ? 3 : 4))
                await h.store
                  .statement(
                    "UPDATE partitions SET evidence=json_set(evidence,'$.epoch','replacement') WHERE id=?",
                    second,
                  )
                  .run();
              return target.batch(statements);
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const raced = new Store(db, h.store.keys);
      const result =
        mode === "singleton"
          ? await historyCandidates(raced, h.input, warm(h))
          : (await historyCandidatesBatch(raced, [h.input], warm(h)))[0];
      assert.notEqual(result.state, "ready");
      assert.deepEqual(result.records, []);
      assert.equal(result.fence, undefined);
      assert.equal(await currentFence(h, ready), false);
    } finally {
      await h.mf.dispose();
    }
  });

test("the 512 candidate cap combines both leaves and never truncates or independently approves them", async () => {
  const h = await fixture({ ...base, QSO_DATE: "20261022", TIME_ON: "0000" });
  try {
    const rows = ["20261021", "20261022"].flatMap((QSO_DATE) =>
      Array.from({ length: 257 }, (_, index) => ({
        ...base,
        QSO_DATE,
        TIME_ON: `12${String(Math.floor(index / 60)).padStart(2, "0")}${String(index % 60).padStart(2, "0")}`,
      })),
    );
    const { options } = inventory(h, rows);
    const first = await historyCandidates(h.store, h.input, options);
    assert.equal(first.state, "pending");
    const result = await historyCandidates(h.store, h.input, options);
    assert.equal(result.state, "unavailable");
    assert.match(result.reason!, /bounded comparison/);
    assert.deepEqual(result.records, []);
    assert.equal(result.fence, undefined);
    const batch = await historyCandidatesBatch(
      h.store,
      [h.input, h.input],
      warm(h),
    );
    assert(
      batch.every(
        (entry) =>
          entry.state === "unavailable" &&
          entry.records.length === 0 &&
          !entry.fence,
      ),
    );
    assert(
      batch.every((entry) => entry.reason?.includes("bounded comparison")),
    );
    assert.equal(
      (
        await h.store
          .statement("SELECT COUNT(*) n FROM attempts")
          .first<{ n: number }>()
      )?.n,
      0,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("malformed or overlapping split children fail held rather than selecting one arbitrary date path", async () => {
  const h = await fixture();
  try {
    await historyCandidates(h.store, h.input, {
      now: h.now,
      vendorNow: h.now,
      fetcher: async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    });
    await h.store
      .statement(
        "UPDATE partitions SET evidence=json_set(evidence,'$.children[1].startDate','2026-10-25')",
      )
      .run();
    const result = await historyCandidates(h.store, h.input, warm(h));
    assert.equal(result.state, "unavailable");
    assert.equal(result.fence, undefined);
    const [batch] = await historyCandidatesBatch(h.store, [h.input], warm(h));
    assert.equal(batch.state, "unavailable");
    assert.equal(batch.fence, undefined);
  } finally {
    await h.mf.dispose();
  }
});

test("both weekly split paths resolve across the Thursday boundary before returning any evidence", async () => {
  const h = await fixture({ ...base, QSO_DATE: "20261022", TIME_ON: "0000" });
  try {
    const records = [
      { ...base, QSO_DATE: "20261021", TIME_ON: "2345" },
      { ...base, QSO_DATE: "20261022", TIME_ON: "0010" },
    ];
    const { options, reads } = inventory(h, records, true);
    const result = await complete(h, options, true);
    assert.equal(result.fence?.partitions.length, 2);
    assert.deepEqual(
      reads.filter(([a, b]) => a === b),
      [
        ["2026-10-21", "2026-10-21"],
        ["2026-10-22", "2026-10-22"],
      ],
    );
    const single = await historyCandidates(h.store, h.input, warm(h));
    assert.deepEqual(single.records, result.records);
    assert.deepEqual(single.fence, result.fence);
    assert.equal(await currentFence(h, result), true);
  } finally {
    await h.mf.dispose();
  }
});

test("exactly 512 combined candidates remain intact across two complete leaves", async () => {
  const h = await fixture({ ...base, QSO_DATE: "20261022", TIME_ON: "0000" });
  try {
    const records = ["20261021", "20261022"].flatMap((QSO_DATE) =>
      Array.from({ length: 256 }, (_, index) => ({
        ...base,
        QSO_DATE,
        TIME_ON: `12${String(Math.floor(index / 60)).padStart(2, "0")}${String(index % 60).padStart(2, "0")}`,
      })),
    );
    const { options } = inventory(h, records);
    const result = await complete(h, options);
    assert.equal(result.records.length, 512);
    const [batch] = await historyCandidatesBatch(h.store, [h.input], warm(h));
    assert.equal(batch.state, "ready");
    assert.deepEqual(batch.records, result.records);
    assert.deepEqual(batch.fence, result.fence);
  } finally {
    await h.mf.dispose();
  }
});

test("invalid UTC dates and times cannot open a coverage partition or fetch vendor history", async () => {
  const h = await fixture();
  try {
    for (const record of [
      { ...base, QSO_DATE: "20230229" },
      { ...base, TIME_ON: "240000" },
      { ...base, TIME_ON: "120060" },
    ]) {
      const input = { ...h.input, record };
      await assert.rejects(
        historyCandidates(h.store, input, warm(h)),
        /Invalid ADIF date\/time/,
      );
      await assert.rejects(
        historyCandidatesBatch(h.store, [input], warm(h)),
        /Invalid ADIF date\/time/,
      );
    }
    assert.equal(
      (
        await h.store
          .statement("SELECT COUNT(*) n FROM partitions")
          .first<{ n: number }>()
      )?.n,
      0,
    );
  } finally {
    await h.mf.dispose();
  }
});
