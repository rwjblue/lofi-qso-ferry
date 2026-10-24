import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { type AdifRecord, serializeAdifRecord } from "../src/adif.ts";
import { createFailureDiagnostics } from "../src/failure-diagnostics.ts";
import {
  HISTORY_INVENTORY_TTL,
  HISTORY_READ_RETRY_DELAY,
  type HistoryInventoryInput,
  historyCandidates,
  historyCandidatesBatch,
} from "../src/history-inventory.ts";
import { QrzError } from "../src/qrz.ts";
import { VendorDeferredError } from "../src/vendor-requests.ts";
import { applyMigration, database, seed } from "./helpers.ts";

const record: AdifRecord = {
  STATION_CALLSIGN: "N0TEST/P",
  CALL: "W1AW",
  BAND: "20m",
  MODE: "CW",
  QSO_DATE: "20261022",
  TIME_ON: "120001",
  APP_QRZLOG_LOGID: "1",
};
async function fixture(t: TestContext, kind: "qrz" | "lotw" = "qrz") {
  const h = await database();
  t.after(() => h.mf.dispose());
  for (const migration of [
    "0009_vendor_requests.sql",
    "0017_history_inventory.sql",
  ])
    await applyMigration(h.db, migration);
  const key = await seed(h.store);
  await h.store
    .statement("UPDATE connections SET kind=? WHERE id='destination'", kind)
    .run();
  await h.store
    .statement(
      "DELETE FROM private_data WHERE connection='destination' AND kind='credential'",
    )
    .run();
  await (
    await h.store.putPrivate(
      "a",
      "destination",
      "v1",
      "credential",
      kind === "qrz"
        ? { apiKey: "synthetic-key" }
        : {
            query: {
              username: "synthetic-user",
              password: "synthetic-password",
            },
          },
    )
  ).run();
  await h.store.observe(key, "g1", "hash", 30, false);
  const input: HistoryInventoryInput = {
    source: (await h.store.connection("a", "source"))!,
    destination: (await h.store.connection("a", "destination"))!,
    qso: key.qso,
    generation: "g1",
    record,
  };
  const neighbor = async (qso: string, changes: AdifRecord = {}) => {
    await h.store.observe({ ...key, qso }, "g1", "hash", 30, false);
    return { ...input, qso, record: { ...record, ...changes } };
  };
  const partition = async () => {
    const row = await h.store
      .statement(
        "SELECT evidence,history_bytes FROM partitions ORDER BY id LIMIT 1",
      )
      .first<{ evidence: string; history_bytes: number }>();
    assert.ok(row);
    return { ...JSON.parse(row.evidence), bytes: row.history_bytes };
  };
  const noPages = async () => {
    assert.equal(
      await h.store
        .statement("SELECT COUNT(*) n FROM history_inventory_pages")
        .first("n"),
      0,
    );
    assert.equal(
      await h.store
        .statement(
          "SELECT COUNT(*) n FROM private_data WHERE kind='history_inventory'",
        )
        .first("n"),
      0,
    );
    assert.equal(
      await h.store
        .statement("SELECT COUNT(*) n FROM history_inventory_guards")
        .first("n"),
      0,
    );
  };
  return { ...h, input, neighbor, partition, noPages, now: Date.now() + 1000 };
}
function qrzResponse(records: AdifRecord[], count = records.length) {
  return new Response(
    new URLSearchParams({
      RESULT: "OK",
      COUNT: String(count),
      ADIF: records.map(serializeAdifRecord).join(""),
    }).toString(),
  );
}
function lotwResponse(records: AdifRecord[], count = records.length) {
  return new Response(
    `<PROGRAMID:4>LoTW<APP_LOTW_NUMREC:${String(count).length}>${count}<EOH>${records.map((r) => serializeAdifRecord({ ...r, QSL_RCVD: "N" })).join("")}<APP_LOTW_EOF>`,
  );
}

test("a sent invalid shared page keeps one diagnostic event and suppresses later cohorts until due", async (t) => {
  const h = await fixture(t);
  const second = await h.neighbor("q2");
  const third = await h.neighbor("q3");
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return qrzResponse([{ ...record, STATION_CALLSIGN: "K1WRONG" }]);
  };
  const first = await historyCandidatesBatch(h.store, [h.input, second], {
    now: h.now,
    vendorNow: h.now,
    fetcher,
  });
  const diagnostics = createFailureDiagnostics();
  for (const result of first) {
    assert.ok("failure" in result);
    diagnostics.record(result.failure, "history_read", "qrz");
    assert.equal(result.state, "pending");
    assert.equal(result.fence, undefined);
    assert.deepEqual(result.records, []);
  }
  assert.deepEqual(
    diagnostics.counts["history_read:qrz:history_station_mismatch"],
    { events: 1, affected: 2 },
  );
  assert.equal(calls, 1);
  const failed = await h.partition();
  assert.deepEqual(failed.readRetry, {
    code: "report_invalid",
    startedAt: h.now,
    retryAfter: h.now + HISTORY_READ_RETRY_DELAY,
  });
  assert.equal(failed.cursor, 0);
  assert.equal(failed.pageCount, 0);
  assert.equal(failed.recordCount, 0);
  assert.equal(failed.phase, "base");
  await h.noPages();
  for (const now of [h.now + 1, h.now + HISTORY_READ_RETRY_DELAY - 1]) {
    const suppressed = await historyCandidatesBatch(h.store, [third, second], {
      now,
      vendorNow: now,
      fetcher,
    });
    for (const result of suppressed) {
      assert.equal(result.state, "pending");
      assert.equal(result.fetched, false);
      assert.equal("failure" in result, false);
      assert.equal(
        result.reason,
        "Destination history read failed; bounded retry is scheduled",
      );
      assert.equal(result.fence, undefined);
      assert.equal(result.freshCheckComplete, false);
    }
  }
  assert.equal(calls, 1);
  assert.deepEqual(await h.partition(), failed);
  const now = h.now + HISTORY_READ_RETRY_DELAY;
  const valid = async () => {
    calls++;
    return qrzResponse([record]);
  };
  assert.equal(
    (
      await historyCandidates(h.store, third, {
        now,
        vendorNow: now,
        fetcher: valid,
      })
    ).state,
    "pending",
  );
  assert.equal((await h.partition()).readRetry, undefined);
  assert.equal(
    (
      await historyCandidates(h.store, third, {
        now: now + 1,
        vendorNow: now + 1,
        fetcher: valid,
      })
    ).state,
    "ready",
  );
  assert.equal(calls, 3);
});

test("a failed continuation retains only its prior valid page and never exposes partial evidence", async (t) => {
  const h = await fixture(t);
  const rows = Array.from({ length: 250 }, (_, i) => ({
    ...record,
    APP_QRZLOG_LOGID: String(i + 1),
  }));
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return calls === 1
      ? qrzResponse(rows, 252)
      : qrzResponse([{ ...record, APP_QRZLOG_LOGID: "251", TIME_ON: "" }], 252);
  };
  assert.equal(
    (
      await historyCandidates(h.store, h.input, {
        now: h.now,
        vendorNow: h.now,
        fetcher,
      })
    ).state,
    "pending",
  );
  const before = await h.partition();
  const pages = await h.store
    .statement("SELECT COUNT(*) n FROM history_inventory_pages")
    .first("n");
  await assert.rejects(
    historyCandidates(h.store, h.input, {
      now: h.now + 1,
      vendorNow: h.now + 1,
      fetcher,
    }),
    /Missing precise ADIF date\/time/,
  );
  const after = await h.partition();
  assert.deepEqual(
    { ...after, readRetry: undefined },
    { ...before, readRetry: undefined },
  );
  assert.equal(
    await h.store
      .statement("SELECT COUNT(*) n FROM history_inventory_pages")
      .first("n"),
    pages,
  );
  const held = await historyCandidates(h.store, h.input, {
    now: h.now + 2,
    vendorNow: h.now + 2,
    fetcher,
  });
  assert.equal(calls, 2);
  assert.equal(held.state, "pending");
  assert.equal(held.fence, undefined);
  assert.deepEqual(held.records, []);
});

test("an actual LoTW malformed report is shared as a pending retry without changing split semantics", async (t) => {
  const h = await fixture(t, "lotw"),
    second = await h.neighbor("q2");
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return lotwResponse([record], 2);
  };
  await assert.rejects(
    historyCandidates(h.store, h.input, {
      now: h.now,
      vendorNow: h.now,
      fetcher,
    }),
    /LoTW report count or program identity mismatch/,
  );
  assert.equal((await h.partition()).readRetry.code, "read_failed");
  const held = await historyCandidates(h.store, second, {
    now: h.now + 1,
    vendorNow: h.now + 1,
    fetcher,
  });
  assert.equal(held.state, "pending");
  assert.equal(held.fetched, false);
  assert.equal(held.fence, undefined);
  assert.equal(calls, 1);
  await h.noPages();
  const now = h.now + HISTORY_READ_RETRY_DELAY;
  const ready = await historyCandidates(h.store, second, {
    now,
    vendorNow: now,
    fetcher: async () => {
      calls++;
      return lotwResponse([record]);
    },
  });
  assert.equal(ready.state, "ready");
  assert.equal(ready.freshCheckComplete, false);
  assert.equal((await h.partition()).readRetry, undefined);
  assert.equal(calls, 2);
});

for (const cause of ["auth", "vendor_cooldown", "budget"] as const) {
  test(`${cause} retains its existing classification without a partition retry marker`, async (t) => {
    const h = await fixture(t);
    if (cause === "budget")
      await h.store
        .statement(
          "INSERT INTO vendor_requests VALUES('qrz',?,24,24,0)",
          Math.floor(h.now / 300_000) * 300_000,
        )
        .run();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return new Response("", { status: cause === "auth" ? 401 : 429 });
    };
    await assert.rejects(
      historyCandidates(h.store, h.input, {
        now: h.now,
        vendorNow: h.now,
        fetcher,
        priority: "background",
      }),
      (error: unknown) =>
        cause === "auth"
          ? error instanceof QrzError && error.kind === "auth"
          : error instanceof VendorDeferredError &&
            error.requestSent === (cause === "vendor_cooldown"),
    );
    assert.equal(calls, cause === "budget" ? 0 : 1);
    assert.equal((await h.partition()).readRetry, undefined);
    await h.noPages();
  });
}

for (const race of [
  "credential",
  "source",
  "generation",
  "epoch",
  "lease",
] as const) {
  test(`a ${race} race rejects the retry save rather than converting a failed commit into evidence`, async (t) => {
    const h = await fixture(t);
    const fetcher = async () => {
      const sql = {
        credential:
          "UPDATE connections SET credential_version='replaced' WHERE id='destination'",
        source:
          "UPDATE connections SET remote_identity='replaced' WHERE id='source'",
        generation: "UPDATE ledger SET generation='replaced'",
        epoch:
          "UPDATE partitions SET evidence=json_set(evidence,'$.epoch','replaced')",
        lease: "UPDATE leases SET fence=fence+1 WHERE scope LIKE 'history:%'",
      }[race];
      await h.store.statement(sql).run();
      return qrzResponse([{ ...record, STATION_CALLSIGN: "K1WRONG" }]);
    };
    await assert.rejects(
      historyCandidatesBatch(h.store, [h.input], {
        now: h.now,
        vendorNow: h.now,
        fetcher,
      }),
      /history (connection changed|source changed|partition changed|lease lost)/,
    );
    assert.equal((await h.partition()).readRetry, undefined);
    await h.noPages();
  });
}

test("partition retry does not delay an unrelated date scope", async (t) => {
  const h = await fixture(t);
  const other = await h.neighbor("q2", { QSO_DATE: "20260901" });
  let calls = 0;
  await assert.rejects(
    historyCandidates(h.store, h.input, {
      now: h.now,
      vendorNow: h.now,
      fetcher: async () => {
        calls++;
        return qrzResponse([{ ...record, STATION_CALLSIGN: "K1WRONG" }]);
      },
    }),
  );
  const progressing = await historyCandidates(h.store, other, {
    now: h.now + 1,
    vendorNow: h.now + 1,
    fetcher: async () => {
      calls++;
      return qrzResponse([{ ...other.record, APP_QRZLOG_LOGID: "2" }]);
    },
  });
  assert.equal(progressing.progressed, true);
  assert.equal(progressing.fetched, true);
  assert.equal(calls, 2);
});

test("retry expiry is clipped to the original partition lifetime and cannot promote expired partial history", async (t) => {
  const h = await fixture(t);
  let calls = 0;
  const first = await historyCandidates(h.store, h.input, {
    now: h.now,
    vendorNow: h.now,
    fetcher: async () => {
      calls++;
      return qrzResponse([record]);
    },
  });
  assert.equal(first.state, "pending");
  assert.equal((await h.partition()).phase, "catchup");
  const expiresAt = h.now + HISTORY_INVENTORY_TTL;
  await assert.rejects(
    historyCandidates(h.store, h.input, {
      now: expiresAt - 100,
      vendorNow: expiresAt - 100,
      fetcher: async () => {
        calls++;
        return qrzResponse([{ ...record, TIME_ON: "" }]);
      },
    }),
    /Missing precise ADIF date\/time/,
  );
  const before = await h.partition();
  assert.equal(before.readRetry.retryAfter, expiresAt);
  const held = await historyCandidates(h.store, h.input, {
    now: expiresAt - 1,
    vendorNow: expiresAt - 1,
    fetcher: async () => {
      throw new Error("retry must still be held");
    },
  });
  assert.equal(held.state, "pending");
  assert.equal(held.fence, undefined);
  const restarted = await historyCandidates(h.store, h.input, {
    now: expiresAt,
    vendorNow: expiresAt,
    fetcher: async () => {
      calls++;
      return qrzResponse([record]);
    },
  });
  assert.equal(calls, 3);
  assert.equal(restarted.state, "pending");
  assert.equal(restarted.fence, undefined);
  assert.equal(restarted.freshCheckComplete, false);
  const after = await h.partition();
  assert.notEqual(after.epoch, before.epoch);
  assert.equal(after.readRetry, undefined);
  assert.equal(after.phase, "catchup");
});
