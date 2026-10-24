import assert from "node:assert/strict";
import test from "node:test";
import { type AdifRecord, serializeAdifRecord } from "../src/adif.ts";
import { measuredDatabase } from "../src/database-metrics.ts";
import {
  HISTORY_INVENTORY_TTL,
  type HistoryInventoryInput,
  type HistoryInventoryOptions,
  type HistoryInventoryResult,
  historyCandidates,
  historyCandidatesBatch,
  historyInventoryGuard,
} from "../src/history-inventory.ts";
import { canonical, sha256 } from "../src/security.ts";
import { Store } from "../src/store.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";
import { applyMigration, database, seed } from "./helpers.ts";

const DAY = 86400000;
const RADIUS = 30 * 60000 + 59000;
const date = (at: number) => new Date(at).toISOString().slice(0, 10);
const base: AdifRecord = {
  STATION_CALLSIGN: "N0TEST/P",
  CALL: "W1AW",
  BAND: "20m",
  MODE: "CW",
  QSO_DATE: "20261025",
  TIME_ON: "234500",
  APP_QRZLOG_LOGID: "1",
};
function response(records: AdifRecord[], count = records.length) {
  return new Response(
    new URLSearchParams({
      RESULT: "OK",
      COUNT: String(count),
      ADIF: records.map(serializeAdifRecord).join(""),
    }).toString(),
  );
}
async function fixture(record = base, splitDepth = 3) {
  const h = await database();
  try {
    await applyMigration(h.db, "0009_vendor_requests.sql");
    await applyMigration(h.db, "0017_history_inventory.sql");
    const key = await seed(h.store);
    await h.store
      .statement(
        "DELETE FROM private_data WHERE connection='destination' AND kind='credential'",
      )
      .run();
    await (
      await h.store.putPrivate("a", "destination", "v1", "credential", {
        apiKey: "synthetic-key",
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
    const now = Date.now() + 1000;
    // Obtain the exact runtime scope, then model retained valid split metadata.
    // QRZ's current fetcher does not create splits; both readers accept them.
    await historyCandidates(
      h.store,
      { ...input, record: { ...record, TIME_ON: "120000" } },
      {
        now,
        fetcher: async () => response([]),
      },
    );

    const scope = (await h.store
      .statement("SELECT history_scope FROM partitions LIMIT 1")
      .first<string>("history_scope"))!;
    await h.store.statement("DELETE FROM partitions").run();
    const day = `${record.QSO_DATE.slice(0, 4)}-${record.QSO_DATE.slice(4, 6)}-${record.QSO_DATE.slice(6, 8)}`;
    const time = record.TIME_ON.padEnd(6, "0");
    const at = Date.parse(
      `${day}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`,
    );
    async function split(start: number, end: number, depth: number) {
      if (start === end || depth === splitDepth) return;
      const middle = start + Math.floor((end - start) / DAY / 2) * DAY;
      const range = { startDate: date(start), endDate: date(end) };
      const evidence = {
        ...range,
        version: 1,
        epoch: "retained-split",
        destinationVersion: "v1",
        phase: "split",
        cursor: 0,
        pageCount: 0,
        recordCount: 0,
        createdAt: now,
        children: [
          { startDate: date(start), endDate: date(middle) },
          { startDate: date(middle + DAY), endDate: date(end) },
        ],
      };
      const id = `history:v1:${await sha256(canonical([scope, range]))}`;
      await h.store
        .statement(
          "INSERT INTO partitions(tenant,source,destination,id,state,evidence,expires_at,history_scope,history_accessed_at) VALUES('a','source','destination',?,'inventory_pending',?,?,?,?)",
          id,
          canonical(evidence),
          now + HISTORY_INVENTORY_TTL,
          scope,
          now,
        )
        .run();
      await split(start, middle, depth + 1);
      await split(middle + DAY, end, depth + 1);
    }
    for (const start of new Set(
      [at - RADIUS, at + RADIUS].map(
        (value) => Math.floor(value / (7 * DAY)) * 7 * DAY,
      ),
    ))
      await split(start, start + 6 * DAY, 0);
    return { ...h, key, input, now };
  } catch (error) {
    await h.mf.dispose();
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function inventory(h: Fixture, records: AdifRecord[]) {
  const reads: { start: string; end: string; catchup: boolean }[] = [];
  const options: HistoryInventoryOptions = {
    now: h.now,
    fetcher: async (_value, init) => {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("ACTION"), "FETCH");
      const filters = body.get("OPTION")!;
      const [, start, end] =
        /BETWEEN:(\d{4}-\d{2}-\d{2})\+(\d{4}-\d{2}-\d{2})/.exec(filters)!;
      const after = Number(/AFTERLOGID:(\d+)/.exec(filters)![1]);
      const catchup = filters.includes("MODSINCE:");
      reads.push({ start, end, catchup });
      if (catchup) return response([]);
      const scoped = records.filter(
        (record) =>
          record.QSO_DATE >= start.replaceAll("-", "") &&
          record.QSO_DATE <= end.replaceAll("-", ""),
      );
      return response(
        scoped
          .filter((record) => Number(record.APP_QRZLOG_LOGID) >= after)
          .slice(0, 250),
        scoped.length,
      );
    },
  };
  return { reads, options };
}
async function complete(
  h: Fixture,
  options: HistoryInventoryOptions,
  batch = false,
) {
  for (let turn = 0; turn < 12; turn++) {
    const current = { ...options, vendorNow: h.now + (turn + 1) * 300000 };
    const result = batch
      ? (await historyCandidatesBatch(h.store, [h.input], current))[0]
      : await historyCandidates(h.store, h.input, current);
    assert.equal(result.freshCheckComplete, false);
    if (result.state !== "pending") return result;
    assert.deepEqual(result.records, []);
    assert.equal(result.fence, undefined);
  }
  assert.fail("QRZ coverage did not finish within bounded fixture turns");
}
function warm(h: Fixture): HistoryInventoryOptions {
  return {
    now: h.now,
    fetcher: async () => assert.fail("warm history fetched"),
  };
}
async function fenceCurrent(h: Fixture, result: HistoryInventoryResult) {
  assert(result.fence);
  const guard = historyInventoryGuard(h.key, result.fence, h.now);
  return !!(await h.store
    .statement(`SELECT 1 WHERE ${guard.sql}`, ...guard.params)
    .first());
}

for (const mode of ["singleton", "batch"] as const)
  for (const [day, time, neighborDay, neighborTime] of [
    ["20261025", "234500", "20261026", "001500"],
    ["20261022", "000000", "20261021", "235959"],
  ])
    test(`QRZ ${mode} follows both daily paths for ${day}/${time}`, async () => {
      const h = await fixture({ ...base, QSO_DATE: day, TIME_ON: time });
      try {
        const records = [
          h.input.record,
          {
            ...base,
            APP_QRZLOG_LOGID: "2",
            QSO_DATE: neighborDay,
            TIME_ON: neighborTime,
          },
        ];
        const { options, reads } = inventory(h, records);
        const result = await complete(h, options, mode === "batch");
        assert.equal(result.state, "ready", result.reason);
        assert.deepEqual(result.records.map((r) => r.APP_QRZLOG_LOGID).sort(), [
          "1",
          "2",
        ]);
        assert.equal(result.fence?.partitions.length, 2);
        assert.equal(
          new Set(result.fence!.partitions.map((p) => p.id)).size,
          2,
        );
        assert.deepEqual(
          reads.filter((r) => !r.catchup).map((r) => [r.start, r.end]),
          [day, neighborDay].sort().map((value) => {
            const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
            return [iso, iso];
          }),
        );
        const single = await historyCandidates(h.store, h.input, warm(h));
        const batched = await historyCandidatesBatch(
          h.store,
          [h.input, h.input],
          warm(h),
        );
        for (const entry of [single, ...batched]) {
          assert.deepEqual(entry.records, result.records);
          assert.deepEqual(entry.fence, result.fence);
          assert.equal(entry.freshCheckComplete, false);
        }
        assert.equal(await fenceCurrent(h, result), true);
      } finally {
        await h.mf.dispose();
      }
    });

for (const [day, time, neighborDay, neighborTime, included] of [
  ["20260401", "0000", "20260331", "235959", true],
  ["20270101", "000000", "20261231", "235959", true],
  ["20240301", "000000", "20240229", "235959", true],
  ["20261025", "003058", "20261024", "235959", true],
  ["20261025", "003059", "20261024", "235959", false],
  ["20261025", "232901", "20261026", "000000", true],
  ["20261025", "232900", "20261026", "000000", false],
] as const)
  test(`QRZ retains its exact conservative radius at ${day}/${time}`, async () => {
    const h = await fixture({ ...base, QSO_DATE: day, TIME_ON: time });
    try {
      const { options } = inventory(h, [
        h.input.record,
        {
          ...base,
          APP_QRZLOG_LOGID: "2",
          QSO_DATE: neighborDay,
          TIME_ON: neighborTime,
        },
      ]);
      const result = await complete(h, options);
      assert.equal(result.state, "ready");
      assert.deepEqual(
        result.records.map((r) => r.APP_QRZLOG_LOGID).sort(),
        included ? ["1", "2"] : ["1"],
      );
      assert.equal(result.fence?.partitions.length, included ? 2 : 1);
      const [batch] = await historyCandidatesBatch(h.store, [h.input], warm(h));
      assert.deepEqual(batch.records, result.records);
      assert.deepEqual(batch.fence, result.fence);
    } finally {
      await h.mf.dispose();
    }
  });

test("QRZ neighboring dates sharing a split leaf fetch and guard it once across batch contacts", async () => {
  const h = await fixture({ ...base, QSO_DATE: "20261023" }, 1);
  try {
    const { options, reads } = inventory(h, [
      h.input.record,
      {
        ...base,
        APP_QRZLOG_LOGID: "2",
        QSO_DATE: "20261024",
        TIME_ON: "001500",
      },
    ]);
    const result = await complete(h, options, true);
    assert.equal(result.state, "ready");
    assert.equal(result.records.length, 2);
    assert.equal(result.fence?.partitions.length, 1);
    assert.equal(reads.length, 2); // One base read and one catch-up for the shared leaf.
    assert(
      reads.every((r) => r.start === "2026-10-22" && r.end === "2026-10-25"),
    );
    const measured = measuredDatabase(h.db);
    const batch = await historyCandidatesBatch(
      new Store(measured.database, h.store.keys),
      [h.input, h.input],
      warm(h),
    );
    assert.equal(measured.metrics.calls, 4); // Shared initial, split, leaf and final checks.
    for (const entry of batch) {
      assert.deepEqual(entry.records, result.records);
      assert.deepEqual(entry.fence, result.fence);
    }
    assert.equal(await fenceCurrent(h, result), true);
  } finally {
    await h.mf.dispose();
  }
});

for (const fault of [
  "missing",
  "expired",
  "revoked-page",
  "blocked",
  "incomplete",
] as const)
  test(`QRZ ${fault} adjacent leaf never releases partial cached evidence`, async () => {
    const h = await fixture();
    try {
      const { options } = inventory(h, [
        base,
        {
          ...base,
          APP_QRZLOG_LOGID: "2",
          QSO_DATE: "20261026",
          TIME_ON: "001000",
        },
      ]);
      const ready = await complete(h, options);
      assert.equal(ready.state, "ready");
      const second = ready.fence!.partitions[1].id;
      if (fault === "missing")
        await h.store
          .statement("DELETE FROM partitions WHERE id=?", second)
          .run();
      else if (fault === "expired")
        await h.store
          .statement(
            "UPDATE partitions SET expires_at=? WHERE id=?",
            h.now,
            second,
          )
          .run();
      else if (fault === "revoked-page")
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
            "UPDATE partitions SET state='inventory_pending',evidence=json_set(evidence,'$.phase',?) WHERE id=?",
            fault === "blocked" ? "blocked" : "base",
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
      assert.equal(await fenceCurrent(h, ready), false);
    } finally {
      await h.mf.dispose();
    }
  });

test("QRZ failed neighboring read preserves deferral and cannot expose its complete sibling", async () => {
  const h = await fixture();
  try {
    const { options } = inventory(h, [base]);
    for (let turn = 0; turn < 2; turn++) {
      const result = await historyCandidates(h.store, h.input, {
        ...options,
        vendorNow: h.now + (turn + 1) * 300000,
      });
      assert.equal(result.state, "pending");
      assert.deepEqual(result.records, []);
      assert.equal(result.fence, undefined);
    }
    const deferred = new VendorDeferredError(h.now + 1200000);
    let calls = 0;
    const failed = {
      now: h.now,
      vendorNow: h.now + 900000,
      fetcher: async () => {
        calls++;
        throw deferred;
      },
    };
    await assert.rejects(
      historyCandidates(h.store, h.input, failed),
      (error) => error === deferred,
    );
    const [batch] = await historyCandidatesBatch(h.store, [h.input], failed);
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
  test(`QRZ ${mode} rechecks both leaves before publishing and at commit`, async () => {
    const h = await fixture();
    try {
      const { options } = inventory(h, [
        base,
        {
          ...base,
          APP_QRZLOG_LOGID: "2",
          QSO_DATE: "20261026",
          TIME_ON: "001000",
        },
      ]);
      const ready = await complete(h, options);
      const second = ready.fence!.partitions[1].id;
      let batches = 0;
      const db = new Proxy(h.db, {
        get(target, property) {
          if (property === "batch")
            return async (statements: D1PreparedStatement[]) => {
              if (++batches === (mode === "singleton" ? 3 : 4))
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
      const store = new Store(db, h.store.keys);
      const result =
        mode === "singleton"
          ? await historyCandidates(store, h.input, warm(h))
          : (await historyCandidatesBatch(store, [h.input], warm(h)))[0];
      assert.notEqual(result.state, "ready");
      assert.deepEqual(result.records, []);
      assert.equal(result.fence, undefined);
      assert.equal(await fenceCurrent(h, ready), false);
    } finally {
      await h.mf.dispose();
    }
  });

for (const count of [512, 514])
  test(`QRZ ${count} indexed neighbors across two leaves apply one combined candidate bound`, async () => {
    const h = await fixture();
    try {
      const records = Array.from({ length: count }, (_, index) => ({
        ...base,
        APP_QRZLOG_LOGID: String(index + 1),
        QSO_DATE: index < count / 2 ? "20261025" : "20261026",
        TIME_ON: index < count / 2 ? "234500" : "001000",
      }));
      const { options } = inventory(h, records);
      const result = await complete(h, options);
      const batch = await historyCandidatesBatch(
        h.store,
        [h.input, h.input],
        warm(h),
      );
      for (const entry of [result, ...batch]) {
        assert.equal(entry.state, count === 512 ? "ready" : "unavailable");
        assert.equal(entry.records.length, count === 512 ? 512 : 0);
        assert.equal(
          entry.fence?.partitions.length,
          count === 512 ? 2 : undefined,
        );
        assert.equal(entry.freshCheckComplete, false);
        if (count > 512) assert.match(entry.reason!, /bounded comparison/);
      }
      assert.equal(
        await h.store
          .statement("SELECT count(*) n FROM attempts")
          .first<number>("n"),
        0,
      );
    } finally {
      await h.mf.dispose();
    }
  });
