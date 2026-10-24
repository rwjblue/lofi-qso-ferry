import assert from "node:assert/strict";
import test from "node:test";
import { type AdifRecord, serializeAdifRecord } from "../src/adif.ts";
import {
  HISTORY_INVENTORY_TTL,
  type HistoryInventoryInput,
  historyCandidates,
  historyCandidatesBatch,
  historyCoveringRange,
} from "../src/history-inventory.ts";
import { selectQrzCoveringRange } from "../src/qrz-covering.ts";
import { Store } from "../src/store.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";
import { applyMigration, database, seed } from "./helpers.ts";

const source: AdifRecord = {
  STATION_CALLSIGN: "N0TEST/P",
  CALL: "W1AW",
  BAND: "20m",
  MODE: "CW",
  QSO_DATE: "20261022",
  TIME_ON: "120001",
  MY_GRIDSQUARE: "FN31PR12",
};
async function fixture() {
  const h = await database();
  try {
    for (const file of [
      "0009_vendor_requests.sql",
      "0017_history_inventory.sql",
    ])
      await applyMigration(h.db, file);
    const key = await seed(h.store);
    await h.store
      .statement(
        "DELETE FROM private_data WHERE connection='destination' AND kind='credential'",
      )
      .run();
    await h.store
      .statement(
        "UPDATE connections SET config=? WHERE id='destination'",
        JSON.stringify({
          bookId: "book",
          stationCallsign: source.STATION_CALLSIGN,
          startDate: "2020-01-01",
          endDate: "2027-12-31",
          readAccess: true,
        }),
      )
      .run();
    await (
      await h.store.putPrivate("a", "destination", "v1", "credential", {
        apiKey: "synthetic",
      })
    ).run();
    await h.store.observe(key, "g1", "hash", 30, false);
    const input: HistoryInventoryInput = {
      source: (await h.store.connection("a", "source"))!,
      destination: (await h.store.connection("a", "destination"))!,
      qso: key.qso,
      generation: "g1",
      record: source,
    };
    return { ...h, input, key, now: Date.now() + 1000 };
  } catch (error) {
    await h.mf.dispose();
    throw error;
  }
}
function rows(count = 467, target = false): AdifRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    ...source,
    CALL: target && index === 99 ? source.CALL : `K${index}TEST`,
    QSO_DATE: target && index === 99 ? source.QSO_DATE : "20261020",
    APP_QRZLOG_LOGID: String(index + 1),
    COMMENT: "private outer narrative",
  }));
}
function response(records: AdifRecord[], count = records.length) {
  return new Response(
    new URLSearchParams({
      RESULT: "OK",
      COUNT: String(count),
      ADIF: records.map(serializeAdifRecord).join(""),
    }).toString(),
  );
}
async function state(store: Store) {
  const row = (await store.statement("SELECT * FROM partitions").first<{
    evidence: string;
    state: string;
    history_bytes: number;
    expires_at: number;
  }>())!;
  return { row, value: JSON.parse(row.evidence) };
}
function fixtureTransport(records: AdifRecord[]) {
  const requests: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("ACTION"), "FETCH");
    const filters = body.get("OPTION")!;
    requests.push(filters);
    if (requests.length === 1) return new Response("RESULT=FAIL&COUNT=0");
    assert(filters.includes("BETWEEN:2026-09-24+2026-10-28"));
    assert(!filters.includes("MODSINCE:"));
    const after = Number(/AFTERLOGID:(\d+)/.exec(filters)![1]);
    return response(
      records
        .filter((record) => Number(record.APP_QRZLOG_LOGID) >= after)
        .slice(0, 250),
      records.length,
    );
  };
  return { fetcher, requests };
}

test("QRZ covering history resumes one page per turn and verifies the identical 467-record cover before returning cached evidence", async (t) => {
  for (const target of [false, true])
    await t.test(`target match ${target}`, async () => {
      const h = await fixture();
      try {
        const transport = fixtureTransport(rows(467, target));
        for (let turn = 0; turn < 5; turn++) {
          const result = await historyCandidates(
            new Store(h.db, h.store.keys),
            h.input,
            {
              now: h.now + turn * 300_000,
              vendorNow: h.now + turn * 300_000,
              fetcher: transport.fetcher,
            },
          );
          assert.equal(transport.requests.length, turn + 1);
          assert.equal(result.freshCheckComplete, false);
          assert.equal(result.state, turn === 4 ? "ready" : "pending");
          if (turn < 4) {
            assert.deepEqual(result.records, []);
            assert.equal(result.fence, undefined);
          } else {
            assert.equal(result.records.length, target ? 1 : 0);
            assert.equal(result.completedPartitions.length, 1);
            assert(result.fence);
          }
          const saved = await state(h.store);
          assert.equal(saved.value.startDate, "2026-10-22");
          assert.equal(saved.value.endDate, "2026-10-28");
          assert.equal(saved.value.qrzCover.startDate, "2026-09-24");
          assert.equal(saved.row.expires_at, h.now + HISTORY_INVENTORY_TTL);
          assert(!saved.row.evidence.includes("private outer narrative"));
          if (turn === 2) {
            assert.equal(saved.value.phase, "verify");
            assert.equal(saved.value.qrzCover.base.recordCount, 467);
            assert.equal(saved.value.pageCount, 0);
            assert.equal(saved.row.history_bytes, 0);
            assert.equal(
              (await h.store
                .statement(
                  "SELECT COUNT(*) n FROM private_data WHERE kind='history_inventory'",
                )
                .first())!.n,
              0,
            );
          }
        }
        const result = await historyCandidates(h.store, h.input, {
          now: h.now + 1_500_000,
          fetcher: async () =>
            assert.fail("complete coverage must reuse cache"),
        });
        assert.equal(result.state, "ready");
        assert.equal(result.freshCheckComplete, false);
        assert.equal(
          (await h.store.statement("SELECT COUNT(*) n FROM attempts").first())!
            .n,
          0,
        );
      } finally {
        await h.mf.dispose();
      }
    });
});

test("QRZ covering history never completes changed verification, malformed outer rows or changed overlap", async (t) => {
  for (const scenario of [
    "verification",
    "outer",
    "anchor",
    "full-fourth",
  ] as const)
    await t.test(scenario, async () => {
      const h = await fixture();
      try {
        const records = rows(scenario === "full-fourth" ? 1000 : 467, true);
        const transport = fixtureTransport(records);
        let calls = 0;
        const fetcher: typeof fetch = async (url, init) => {
          calls++;
          if (scenario === "outer" && calls === 2) records[0].CALL = " ";
          if (scenario === "anchor" && calls === 3)
            records[249].COMMENT = "changed";
          if (scenario === "verification" && calls === 4)
            records[0].COMMENT = "changed outside target";
          return transport.fetcher(url, init);
        };
        const failureTurn =
          scenario === "outer" ? 1 : scenario === "anchor" ? 2 : 4;
        for (let turn = 0; turn < failureTurn; turn++)
          assert.equal(
            (await historyCandidates(h.store, h.input, { now: h.now, fetcher }))
              .state,
            "pending",
          );
        await assert.rejects(
          historyCandidates(h.store, h.input, { now: h.now, fetcher }),
        );
        assert.equal((await state(h.store)).value.phase, "blocked");
        const held = await historyCandidates(h.store, h.input, {
          now: h.now,
          fetcher: async () =>
            assert.fail("failed fixed cover must not widen or retry"),
        });
        assert.equal(held.state, "unavailable");
        assert.equal(held.freshCheckComplete, false);
        assert.deepEqual(held.records, []);
        assert.equal(held.fence, undefined);
      } finally {
        await h.mf.dispose();
      }
    });
});

test("QRZ covering progress shares a partition across contacts and yields without consuming a page", async () => {
  const h = await fixture();
  try {
    const second = { ...h.input, qso: "q2", generation: "g2" };
    await h.store.observe({ ...h.key, qso: "q2" }, "g2", "other", 30, false);
    const transport = fixtureTransport(rows());
    const inputs = [h.input, second];
    await historyCandidatesBatch(h.store, inputs, {
      now: h.now,
      fetcher: transport.fetcher,
    });
    const before = (await state(h.store)).row.evidence;
    const yielded = await historyCandidatesBatch(h.store, inputs, {
      now: h.now,
      shouldContinue: () => false,
      fetcher: async () => assert.fail("yield before vendor read"),
    });
    assert(
      yielded.every((result) => result.state === "pending" && !result.fetched),
    );
    await assert.rejects(
      historyCandidates(h.store, h.input, {
        now: h.now,
        fetcher: async () => {
          throw new VendorDeferredError(h.now + 300_000);
        },
      }),
      VendorDeferredError,
    );
    assert.equal((await state(h.store)).row.evidence, before);
    const progressing = await historyCandidatesBatch(h.store, inputs, {
      now: h.now,
      fetcher: transport.fetcher,
    });
    assert.equal(transport.requests.length, 2);
    assert.equal(progressing.filter((result) => result.fetched).length, 1);
    assert(
      progressing.every(
        (result) => result.state === "pending" && !result.freshCheckComplete,
      ),
    );
  } finally {
    await h.mf.dispose();
  }
});

test("QRZ covering saves retain generation, credential, lease and expiry guards", async (t) => {
  for (const race of ["generation", "credential", "lease", "expiry"] as const)
    await t.test(race, async () => {
      const h = await fixture();
      try {
        const transport = fixtureTransport(rows());
        await historyCandidates(h.store, h.input, {
          now: h.now,
          fetcher: transport.fetcher,
        });
        const before = (await state(h.store)).row.evidence;
        const fetcher: typeof fetch = async (url, init) => {
          if (race === "generation")
            await h.store
              .statement("UPDATE ledger SET generation='changed'")
              .run();
          if (race === "credential")
            await h.store
              .statement(
                "UPDATE connections SET credential_version='changed' WHERE id='destination'",
              )
              .run();
          if (race === "lease")
            await h.store
              .statement(
                "UPDATE leases SET token='changed' WHERE scope LIKE 'history:%'",
              )
              .run();
          if (race === "expiry")
            await h.store
              .statement("UPDATE partitions SET expires_at=?", h.now)
              .run();
          return transport.fetcher(url, init);
        };
        await assert.rejects(
          historyCandidates(h.store, h.input, { now: h.now, fetcher }),
        );
        assert.equal((await state(h.store)).row.evidence, before);
        assert.equal(
          (await h.store
            .statement("SELECT COUNT(*) n FROM history_inventory_guards")
            .first())!.n,
          0,
        );
        assert.equal(
          (await h.store
            .statement("SELECT COUNT(*) n FROM history_inventory_pages")
            .first())!.n,
          0,
        );
      } finally {
        await h.mf.dispose();
      }
    });
});

test("QRZ cover selection stays within the verified book and ignores another scope's positive hints", async () => {
  const target: [string, string] = ["2026-10-22", "2026-10-28"];
  assert.deepEqual(
    selectQrzCoveringRange(target, ["2026-10-01", "2026-12-31"]),
    ["2026-10-01", "2026-11-04"],
  );
  assert.deepEqual(
    selectQrzCoveringRange(
      target,
      ["2026-01-01", "2026-12-31"],
      [["2026-11-01", "2026-11-07"]],
    ),
    ["2026-10-22", "2026-11-07"],
  );
  assert.deepEqual(
    selectQrzCoveringRange(
      target,
      ["2026-01-01", "2026-12-31"],
      [["2026-10-15", "2026-10-21"]],
    ),
    ["2026-10-15", "2026-10-28"],
  );
  assert.deepEqual(
    selectQrzCoveringRange(
      ["2026-10-22", "2026-10-22"],
      ["2026-01-01", "2026-12-31"],
      [["2026-10-22", "2026-10-28"]],
    ),
    ["2026-10-22", "2026-10-28"],
  );
  assert.deepEqual(
    selectQrzCoveringRange(
      target,
      ["2026-01-01", "2026-12-31"],
      [["2026-09-01", "2026-09-07"]],
    ),
    ["2026-09-24", "2026-10-28"],
  );
  assert.deepEqual(
    selectQrzCoveringRange(target, ["2026-01-01", "2026-12-31"], [target]),
    ["2026-09-24", "2026-10-28"],
  );
  assert.equal(selectQrzCoveringRange(target, target), null);
  assert.equal(
    selectQrzCoveringRange(target, ["2026-10-23", "2026-11-30"]),
    null,
  );
  const h = await fixture();
  try {
    await h.store
      .statement(
        "INSERT INTO partitions(tenant,source,destination,id,state,evidence,expires_at,history_scope) VALUES('a','source','destination','other','complete',?,?,'different-scope')",
        JSON.stringify({
          version: 1,
          epoch: "x",
          destinationVersion: "v1",
          phase: "done",
          cursor: 0,
          pageCount: 1,
          recordCount: 10,
          createdAt: h.now,
          completedAt: h.now,
          startDate: "2026-11-01",
          endDate: "2026-11-07",
        }),
        h.now + HISTORY_INVENTORY_TTL,
      )
      .run();
    assert.deepEqual(
      await historyCoveringRange(h.store, h.input, target, h.now),
      ["2026-09-24", "2026-10-28"],
    );
  } finally {
    await h.mf.dispose();
  }
});

test("QRZ cover retries consume a bounded attempt count and only original expiry resets the fixed plan", async () => {
  const h = await fixture();
  try {
    let calls = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      calls++;
      const options = new URLSearchParams(String(init?.body)).get("OPTION")!;
      if (calls === 1 || calls === 6) {
        assert(options.includes("BETWEEN:2026-10-22+2026-10-28"));
        return new Response("RESULT=FAIL&COUNT=0");
      }
      return new Response("unavailable", { status: 503 });
    };
    await historyCandidates(h.store, h.input, { now: h.now, fetcher });
    for (let attempt = 0; attempt < 4; attempt++) {
      const now = h.now + attempt * 900_000;
      await assert.rejects(
        historyCandidates(h.store, h.input, { now, vendorNow: now, fetcher }),
      );
      const saved = await state(h.store);
      assert.equal(saved.value.qrzCover.attempts, attempt + 1);
      assert.equal(saved.row.expires_at, h.now + HISTORY_INVENTORY_TTL);
      const held = await historyCandidates(h.store, h.input, {
        now: now + 1,
        fetcher: async () => assert.fail("held attempts must not call QRZ"),
      });
      assert.equal(held.state, attempt === 3 ? "unavailable" : "pending");
      assert.deepEqual(held.records, []);
      assert.equal(held.fence, undefined);
    }
    assert.equal(calls, 5);
    const restartedAt = h.now + HISTORY_INVENTORY_TTL + 1;
    const restarted = await historyCandidates(
      new Store(h.db, h.store.keys),
      h.input,
      { now: restartedAt, vendorNow: restartedAt, fetcher },
    );
    assert.equal(restarted.state, "pending");
    assert.equal(restarted.freshCheckComplete, false);
    assert.equal(calls, 6);
    const saved = await state(h.store);
    assert.equal(saved.value.qrzCover.attempts, 0);
    assert.equal(saved.value.qrzCover.progress, undefined);
    assert.equal(saved.value.createdAt, restartedAt);
  } finally {
    await h.mf.dispose();
  }
});
